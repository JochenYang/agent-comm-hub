//! T-1.3 — Hub subprocess management
//!
//! Responsibilities:
//! 1. spawn the `agent-comm-hub` subprocess (with all 12 --host/--port/--path/... args)
//! 2. collect stdout / stderr → ring buffer (recent 500 lines)
//! 3. port-ready probe: try a TCP connect every 100ms, 10s timeout
//! 4. auto-update state when the process dies
//! 5. stop / restart kill the process tree by pid + OS calls (Windows taskkill / Unix kill -TERM→-KILL)
//!
//! State machine: Stopped → Starting → Running ⇄ Stopping → Stopped, with Failed on the error path.
//! State changes are pushed to the frontend via the Tauri event `hub:state`; the frontend responds
//! (tray greys out / banner).

use std::collections::VecDeque;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::RwLock;
use tokio::time::sleep;

/// Ring log buffer (recent N lines).
#[derive(Debug)]
pub struct HubLogRing {
    capacity: usize,
    lines: VecDeque<LogLine>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LogLine {
    pub stream: &'static str, // "stdout" | "stderr"
    pub line: String,
    pub ts: u64,
}

impl HubLogRing {
    pub fn new(capacity: usize) -> Self {
        Self { capacity, lines: VecDeque::with_capacity(capacity) }
    }
    pub fn push(&mut self, line: LogLine) {
        if self.lines.len() >= self.capacity {
            self.lines.pop_front();
        }
        self.lines.push_back(line);
    }
    pub fn snapshot(&self) -> Vec<LogLine> {
        self.lines.iter().cloned().collect()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HubState {
    Stopped,
    Starting,
    Running,
    Stopping,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
pub struct HubStatus {
    pub state: HubState,
    pub pid: Option<u32>,
    pub url: String,
    pub host: String,
    pub port: u16,
    pub path: String,
    pub started_at: Option<u64>,
    pub last_error: Option<String>,
}

/// Hub launch config (1:1 aligned with the configurable options in src/cli.ts).
///
/// Note: `to_argv()` must emit space-separated `--flag value` form — the main repo's
/// `src/cli.ts` `parseArgs` reads values via `argv[i]` + `argv[i+1]`, and `--flag=value` gets
/// rejected by `throw new Error("unknown flag: --flag=value")` (verified).
#[derive(Debug, Clone)]
pub struct HubConfig {
    #[allow(dead_code)] // the 4-tier `which_hub_launch()` does its own PATH resolution; this field is kept for callers to specify manually.
    pub bin: PathBuf,
    pub host: String,
    pub port: u16,
    pub path: String,
    pub max_queue: u32,
    pub history_limit: u32,
    pub wait_timeout_ms: u32,
    pub default_wait_ms: u32,
    pub connected_window_ms: u32,
    pub peer_idle_timeout_ms: u32,
    pub herdr_bin: Option<String>,
    pub herdr_timeout_ms: Option<u32>,
}

impl HubConfig {
    pub fn to_argv(&self) -> Vec<String> {
        let mut argv = Vec::with_capacity(20);
        argv.push("--host".to_string());
        argv.push(self.host.clone());
        argv.push("--port".to_string());
        argv.push(self.port.to_string());
        argv.push("--path".to_string());
        argv.push(self.path.clone());
        argv.push("--max-queue".to_string());
        argv.push(self.max_queue.to_string());
        argv.push("--history-limit".to_string());
        argv.push(self.history_limit.to_string());
        argv.push("--wait-timeout-ms".to_string());
        argv.push(self.wait_timeout_ms.to_string());
        argv.push("--default-wait-ms".to_string());
        argv.push(self.default_wait_ms.to_string());
        argv.push("--connected-window-ms".to_string());
        argv.push(self.connected_window_ms.to_string());
        argv.push("--peer-idle-timeout-ms".to_string());
        argv.push(self.peer_idle_timeout_ms.to_string());
        if let Some(bin) = &self.herdr_bin {
            argv.push("--herdr-bin".to_string());
            argv.push(bin.clone());
        }
        if let Some(ms) = self.herdr_timeout_ms {
            argv.push("--herdr-timeout-ms".to_string());
            argv.push(ms.to_string());
        }
        argv
    }
}

impl Default for HubConfig {
    fn default() -> Self {
        Self {
            bin: which_hub_launch().0,
            host: "127.0.0.1".into(),
            port: 18764,
            path: "/mcp".into(),
            max_queue: 200,
            // Match the hub's own default (main repo src/index.ts DEFAULT_CONFIG = 1000): this
            // value is always passed explicitly via to_argv, so a smaller value here would
            // silently shrink the hub's ring — and the ring is the 3s poll's fallback source
            // (100 messages evict within seconds under dense agent chatter).
            history_limit: 1000,
            wait_timeout_ms: 60_000,
            default_wait_ms: 30_000,
            connected_window_ms: 30_000,
            peer_idle_timeout_ms: 600_000,
            herdr_bin: None,
            herdr_timeout_ms: None,
        }
    }
}

/// Resolve how to launch agent-comm-hub.
/// Returns (program, optional_script_path) — when spawning, if script exists, args = [script, ...hub_args].
/// Priority:
///   1. same-directory agent-comm-hub(.exe) (dev scenario: the hub cli sits next to the app exe)
///   2. agent-comm-hub on PATH (the npm-global .cmd / .exe)
///   3. node + <main repo root>/lib/cli.js (dev scenario: the hub main repo is one level above app)
///   4. fall back to npx agent-comm-hub (last resort; npx downloads it when the user hasn't installed globally)
pub(crate) fn which_hub_launch() -> (PathBuf, Option<PathBuf>) {
    let exe_name = if cfg!(windows) { "agent-comm-hub.exe" } else { "agent-comm-hub" };

    // 1. same directory
    if let Ok(exe) = std::env::current_exe() {
        let sibling = exe.with_file_name(exe_name);
        if sibling.exists() {
            return (sibling, None);
        }
        // 3. node + main repo's lib/cli.js (in a debug build <exe> is at src-tauri/target/<profile>/
        //    and going up 5 levels reaches the main repo root D:/codes/agent-comm-hub/; a release
        //    build's layout may differ, so "lib/cli.js not found" falls back to tier-2 rather than erroring).
        if let Some(node) = find_in_path(if cfg!(windows) { "node.exe" } else { "node" }) {
            for pops in 1..=6 {
                let mut p = exe.clone();
                for _ in 0..pops {
                    if !p.pop() {
                        break;
                    }
                }
                let cli = p.join("lib").join("cli.js");
                if cli.exists() {
                    return (node, Some(cli));
                }
            }
        }
    }

    // 2. agent-comm-hub on PATH
    if let Some(found) = find_in_path(exe_name) {
        return (found, None);
    }

    // 4. fall back to npx
    let npx_name = if cfg!(windows) { "npx.cmd" } else { "npx" };
    if let Some(npx) = find_in_path(npx_name) {
        return (npx, None); // prepend "agent-comm-hub" to args at spawn time
    }

    // Everything failed: return the bare name + None and let spawn error out (clear error message)
    (PathBuf::from("agent-comm-hub"), None)
}

/// Hand-rolled PATH lookup (to avoid adding a which crate dependency).
fn find_in_path(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for entry in std::env::split_paths(&path_var) {
        let candidate = entry.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
        // Windows: .cmd / .bat suffixes
        #[cfg(windows)]
        {
            for ext in [".cmd", ".bat", ".exe"] {
                let mut with_ext = entry.join(name);
                with_ext.set_extension(if ext == ".exe" { "exe" } else { &ext[1..] });
                if with_ext.is_file() {
                    return Some(with_ext);
                }
                // append the suffix directly
                let mut full = entry.join(name);
                full.push(ext);
                if full.is_file() {
                    return Some(full);
                }
            }
        }
    }
    None
}

/// Build the tokio Command for the hub CLI (handling any of the 4 launch forms from which_hub_launch).
/// `extra_args` are appended after program/script — start() passes the hub launch args, and the
/// service commands (commands.rs service_install/uninstall) pass ["service", action].
pub(crate) fn hub_cli_command(extra_args: &[&str]) -> tokio::process::Command {
    let (program, script) = which_hub_launch();
    let mut cmd = Command::new(&program);
    if let Some(s) = &script {
        cmd.arg(s);
    } else if program.file_name().and_then(|n| n.to_str())
        == Some(if cfg!(windows) { "npx.cmd" } else { "npx" })
    {
        // npx -y: skip the "Ok to proceed?" interactive confirmation — in an installed build stdin is
        // null, so the interaction would block forever and the hub would never start (user hit
        // MCP not initialized).
        cmd.arg("-y");
        cmd.arg("agent-comm-hub");
    }
    cmd.args(extra_args);
    // Installed-build users reported: spawning .cmd / node / npx all pop a console window (the
    // settings page flashes a terminal, the hub lingers in a blank terminal). CREATE_NO_WINDOW
    // suppresses it entirely; start() additionally adds CREATE_NEW_PROCESS_GROUP (0x0200) so
    // taskkill can kill the whole process tree.
    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000);
    }
    cmd
}

/// Hub process controller. M1 provides start / stop / restart / status / snapshot_logs.
/// M2 adds sqlite_store persistence on top; M3 adds the herdr_bin field exposed in the settings panel.
pub struct HubProcess {
    /// Launch config. Uses a sync RwLock instead of holding a plain value: after settings-panel
    /// saves the config can be atomically replaced before a restart (see set_config), so
    /// "save and restart" truly launches the hub with the new config.
    config: std::sync::RwLock<HubConfig>,
    log_ring: Arc<RwLock<HubLogRing>>,
    state: Arc<RwLock<(HubState, Option<String>)>>, // (state, last_error)
    pid: Arc<RwLock<Option<u32>>>,
    started_at: Arc<RwLock<Option<u64>>>,
    /// Injected by `attach_app` during Tauri setup; used to emit the `hub:state` event.
    app_handle: Arc<RwLock<Option<AppHandle>>>,
    /// Injected by setup; called on every emit_state, syncs a closure to the tray icon.
    /// Uses Option<RwLock<...>> to carry a closure.
    tray_setter: Arc<RwLock<Option<Box<dyn Fn(HubState) + Send + Sync>>>>,
    /// Under external-reuse mode, whether we've already auto-restarted after detecting the external hub went away (guards against loops).
    auto_restarted: Arc<std::sync::atomic::AtomicBool>,
}

impl HubProcess {
    pub fn new(config: HubConfig) -> Arc<Self> {
        Arc::new(Self {
            config: std::sync::RwLock::new(config),
            log_ring: Arc::new(RwLock::new(HubLogRing::new(500))),
            state: Arc::new(RwLock::new((HubState::Stopped, None))),
            pid: Arc::new(RwLock::new(None)),
            started_at: Arc::new(RwLock::new(None)),
            app_handle: Arc::new(RwLock::new(None)),
            tray_setter: Arc::new(RwLock::new(None)),
            auto_restarted: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        })
    }

    /// Called once during Tauri setup; idempotent.
    pub async fn attach_app(self: &Arc<Self>, app: AppHandle) {
        *self.app_handle.write().await = Some(app);
    }

    /// Fetch the AppHandle for emitting events; returns None before Tauri setup completes.
    pub async fn app_handle(&self) -> Option<AppHandle> {
        self.app_handle.read().await.clone()
    }

    /// Inject a tray setter: called on emit_state to switch the tray icon.
    pub async fn attach_tray_setter<F>(self: &Arc<Self>, setter: F)
    where
        F: Fn(HubState) + Send + Sync + 'static,
    {
        *self.tray_setter.write().await = Some(Box::new(setter));
    }

    #[allow(dead_code)] // read by the M2 T-2.5 config panel
    pub fn config(&self) -> HubConfig {
        self.config.read().expect("config lock").clone()
    }

    /// Replace the launch config (called before "save and restart"); has no effect on a running subprocess.
    pub fn set_config(&self, config: HubConfig) {
        *self.config.write().expect("config lock") = config;
    }

    pub async fn status(&self) -> HubStatus {
        let (state, last_error) = {
            let g = self.state.read().await;
            (g.0, g.1.clone())
        };
        let cfg = self.config.read().expect("config lock").clone();
        HubStatus {
            state,
            pid: *self.pid.read().await,
            url: format!("http://{}:{}{}", cfg.host, cfg.port, cfg.path),
            host: cfg.host.clone(),
            port: cfg.port,
            path: cfg.path.clone(),
            started_at: *self.started_at.read().await,
            last_error,
        }
    }

    pub async fn snapshot_logs(&self) -> Vec<LogLine> {
        self.log_ring.read().await.snapshot()
    }

    /// Start the hub subprocess; set Running once the port is ready; any failure sets Failed and cleans up.
    pub async fn start(self: &Arc<Self>) -> Result<(), String> {
        {
            let (state, _) = *self.state.read().await;
            if matches!(state, HubState::Starting | HubState::Running) {
                return Err(format!("hub is already in {state:?} state"));
            }
        }
        {
            let mut s = self.state.write().await;
            *s = (HubState::Starting, None);
        }
        self.emit_state().await;

        // The port is already taken: an external hub (or another app instance) is running — don't spawn
        // a duplicate with the same process, reuse it directly (SPEC key data flow: "check whether
        // the port is already responding, and if so skip spawning").
        // Probe only once (300ms budget) to avoid mistaking an "unfinished previous start" for occupied.
        let cfg = self.config.read().expect("config lock").clone();
        if wait_for_port_ready(&cfg.host, cfg.port, Duration::from_millis(300)).await
        {
            self.log_ring.write().await.push(LogLine {
                stream: "stdout",
                line: format!(
                    "external hub already listening on {}:{} — reusing it (not spawning a duplicate)",
                    cfg.host, cfg.port
                ),
                ts: now_ms(),
            });
            *self.started_at.write().await = Some(now_ms());
            {
                let mut s = self.state.write().await;
                *s = (HubState::Running, None);
            }
            self.emit_state().await;

            // External hub liveness probe: a TCP connect every 5s; on failure the external hub has exited
            // (possibly killed manually / closed by its owner). Auto-restart once at that point (spawn
            // our own hub for a seamless recovery) before falling back to Stopped; the auto_restarted
            // atomic bit guards against loops.
            let host = cfg.host.clone();
            let port = cfg.port;
            let state_ref = self.state.clone();
            let started_ref = self.started_at.clone();
            let log_ring = self.log_ring.clone();
            let app_handle = self.app_handle.clone();
            let auto_restarted = self.auto_restarted.clone();
            let hub_self = self.clone();
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    if tcp_reachable(&host, port).await {
                        continue;
                    }
                    log_ring.write().await.push(LogLine {
                        stream: "stdout",
                        line: "external hub went away — attempting to spawn our own".into(),
                        ts: now_ms(),
                    });
                    // Pull it back to Stopped before auto-restarting: start() rejects the Running/Starting states
                    // (user hit "auto-restart failed: hub is already in Running state").
                    *started_ref.write().await = None;
                    *state_ref.write().await = (HubState::Stopped, None);
                    if !auto_restarted.swap(true, std::sync::atomic::Ordering::SeqCst) {
                        // start()'s future doesn't satisfy tokio::spawn's Send bound, so use a std thread +
                        // Runtime::block_on (block_on doesn't require Send).
                        let handle = tokio::runtime::Handle::current();
                        let hub = hub_self.clone();
                        std::thread::spawn(move || match handle.block_on(hub.start()) {
                            Ok(()) => {}
                            Err(e) => {
                                let ring = hub_self.log_ring.clone();
                                let text = format!("auto restart failed: {e}");
                                let ts = now_ms();
                                ring.blocking_write().push(LogLine { stream: "stdout", line: text, ts });
                            }
                        });
                        // wait 2s for start() to finish the port probe/spawn, then judge the final state
                        tokio::time::sleep(Duration::from_secs(2)).await;
                        if matches!(*state_ref.read().await, (HubState::Running, _)) {
                            break; // our own hub is up (child-wait owns the lifecycle)
                        }
                    }
                    log_ring.write().await.push(LogLine {
                        stream: "stdout",
                        line: "state reset to stopped".into(),
                        ts: now_ms(),
                    });
                    if let Some(app) = app_handle.read().await.as_ref() {
                        let _ = app.emit("hub:state", serde_json::json!({ "state": "stopped" }));
                    }
                    break;
                }
            });
            return Ok(());
        }

        // Snapshots for spawn: config could be replaced by set_config during start (applying saved
        // settings before a restart); this launch keeps internally consistent with one read.
        let argv = self.config.read().expect("config lock").to_argv();
        let arg_refs: Vec<&str> = argv.iter().map(String::as_str).collect();
        let mut cmd = hub_cli_command(&arg_refs);
        cmd.stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null());
        // Windows: CREATE_NEW_PROCESS_GROUP (0x0200, so stop can taskkill /T the whole tree)
        // | CREATE_NO_WINDOW (0x08000000, already set in hub_cli_command; kept stacked here so it isn't cleared).
        // tokio::process::Command has its own creation_flags (no std::os::windows::process::CommandExt needed).
        #[cfg(windows)]
        {
            cmd.creation_flags(0x0000_0200 | 0x0800_0000);
        }
        let mut child: Child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                self.set_failed(format!("failed to spawn hub: {e}")).await;
                return Err(format!("failed to spawn hub: {e}"));
            }
        };
        let pid = child.id();
        *self.pid.write().await = pid;

        // stdout / stderr → log ring (M1 placeholder: tasukete, T-1.4 adds filtering)
        if let Some(stdout) = child.stdout.take() {
            let ring = self.log_ring.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    ring.write().await.push(LogLine {
                        stream: "stdout",
                        line,
                        ts: now_ms(),
                    });
                }
            });
        }
        if let Some(stderr) = child.stderr.take() {
            let ring = self.log_ring.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    ring.write().await.push(LogLine {
                        stream: "stderr",
                        line,
                        ts: now_ms(),
                    });
                }
            });
        }

        // Port-ready probe (10s budget, once every 100ms)
        let url = format!("http://{}:{}{}", cfg.host, cfg.port, cfg.path);
        let ready = wait_for_port_ready(&cfg.host, cfg.port, Duration::from_secs(10)).await;

        if !ready {
            // Probe failed: kill the spawned subprocess
            let _ = child.kill().await;
            let _ = child.wait().await;
            *self.pid.write().await = None;
            self.set_failed(format!("hub start timed out: {url} not responding")).await;
            return Err(format!("hub start timed out: {url} not responding"));
        }

        *self.started_at.write().await = Some(now_ms());
        {
            let mut s = self.state.write().await;
            *s = (HubState::Running, None);
        }
        // Our own hub genuinely came up: reset the auto-restart bit (the next external scenario can still auto-recover)
        self.auto_restarted.store(false, std::sync::atomic::Ordering::SeqCst);
        self.emit_state().await;

        // Wait asynchronously for the subprocess to exit, auto-restoring Stopped (no external side holds the child handle)
        let state_ref = self.state.clone();
        let pid_ref = self.pid.clone();
        let started_ref = self.started_at.clone();
        let app_handle = self.app_handle.clone();
        tokio::spawn(async move {
            let exit_status = child.wait().await;
            *started_ref.write().await = None;
            *pid_ref.write().await = None;
            match exit_status {
                Ok(_status) => {
                    *state_ref.write().await = (HubState::Stopped, None);
                }
                Err(e) => {
                    *state_ref.write().await =
                        (HubState::Failed, Some(format!("wait failed: {e}")));
                }
            }
            if let Some(app) = app_handle.read().await.as_ref() {
                let payload = serde_json::json!({ "state": "stopped" });
                let _ = app.emit("hub:state", payload);
            }
        });

        Ok(())
    }

    /// Kill the process tree by pid (Windows taskkill /F /T, Unix SIGTERM → 500ms → SIGKILL).
    pub async fn stop(&self) -> Result<(), String> {
        let pid = match *self.pid.read().await {
            Some(p) => p,
            None => {
                // Distinguish "external hub reuse mode" (Running but pid=None) from "genuinely not running",
                // giving the frontend a readable error rather than a misleading "hub is not running".
                if matches!(self.state.read().await.0, HubState::Running) {
                    return Err(
                        "hub is managed by an external process (not spawned by this app); stop the external hub process directly"
                            .into(),
                    );
                }
                return Err("hub is not running".into());
            }
        };
        {
            let mut s = self.state.write().await;
            *s = (HubState::Stopping, None);
        }
        self.emit_state().await;
        kill_process_tree(pid).await?;
        Ok(())
    }

    pub async fn restart(self: &Arc<Self>) -> Result<(), String> {
        if matches!(self.status().await.state, HubState::Running) {
            self.stop().await?;
            sleep(Duration::from_millis(300)).await;
        }
        self.start().await
    }

    async fn set_failed(&self, msg: String) {
        {
            let mut s = self.state.write().await;
            *s = (HubState::Failed, Some(msg.clone()));
        }
        self.emit_state().await;
    }

    async fn emit_state(&self) {
        let state_snapshot = self.state.read().await.0;
        if let Some(setter) = self.tray_setter.read().await.as_ref() {
            setter(state_snapshot);
        }
        if let Some(app) = self.app_handle.read().await.as_ref() {
            let status = self.status().await;
            let _ = app.emit("hub:state", &status);
        }
    }
}

async fn wait_for_port_ready(host: &str, port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if tcp_reachable(host, port).await {
            return true;
        }
        sleep(Duration::from_millis(100)).await;
    }
    false
}

/// Single TCP reachability probe (connect succeeding within 2s → true). tokio connect can block
/// for a long time, so wrap it in a timeout.
async fn tcp_reachable(host: &str, port: u16) -> bool {
    tokio::time::timeout(
        Duration::from_secs(2),
        tokio::net::TcpStream::connect(format!("{host}:{port}")),
    )
    .await
    .map(|r| r.is_ok())
    .unwrap_or(false)
}

async fn kill_process_tree(pid: u32) -> Result<(), String> {
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .output()
            .await
            .map_err(|e| format!("taskkill failed: {e}"))?;
    }
    #[cfg(unix)]
    {
        // First SIGTERM for a graceful hub exit
        let _ = Command::new("kill")
            .arg("-TERM")
            .arg(pid.to_string())
            .output()
            .await;
        sleep(Duration::from_millis(500)).await;
        // fall back to SIGKILL
        let _ = Command::new("kill")
            .arg("-KILL")
            .arg(pid.to_string())
            .output()
            .await;
    }
    Ok(())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_to_argv_contains_all_required_flags() {
        let cfg = HubConfig {
            bin: PathBuf::from("agent-comm-hub"),
            host: "127.0.0.1".into(),
            port: 18764,
            path: "/mcp".into(),
            max_queue: 200,
            history_limit: 100,
            wait_timeout_ms: 60_000,
            default_wait_ms: 30_000,
            connected_window_ms: 30_000,
            peer_idle_timeout_ms: 600_000,
            herdr_bin: Some("herdr".into()),
            herdr_timeout_ms: Some(30_000),
        };
        let argv = cfg.to_argv();
        let joined = argv.join(" ");
        // Space-separated form (aligned with what the main repo's src/cli.ts parseArgs expects; --flag=value must not be used).
        assert!(joined.contains("--host 127.0.0.1"));
        assert!(joined.contains("--port 18764"));
        assert!(joined.contains("--path /mcp"));
        assert!(joined.contains("--max-queue 200"));
        assert!(joined.contains("--history-limit 100"));
        assert!(joined.contains("--wait-timeout-ms 60000"));
        assert!(joined.contains("--default-wait-ms 30000"));
        assert!(joined.contains("--connected-window-ms 30000"));
        assert!(joined.contains("--peer-idle-timeout-ms 600000"));
        assert!(joined.contains("--herdr-bin herdr"));
        assert!(joined.contains("--herdr-timeout-ms 30000"));
    }

    #[test]
    fn default_config_matches_main_repo() {
        let cfg = HubConfig::default();
        assert_eq!(cfg.host, "127.0.0.1");
        assert_eq!(cfg.port, 18764);
        assert_eq!(cfg.path, "/mcp");
        assert_eq!(cfg.max_queue, 200);
        assert_eq!(cfg.history_limit, 1000);
        assert_eq!(cfg.wait_timeout_ms, 60_000);
        assert_eq!(cfg.default_wait_ms, 30_000);
        assert_eq!(cfg.connected_window_ms, 30_000);
        assert_eq!(cfg.peer_idle_timeout_ms, 600_000);
    }

    #[tokio::test]
    async fn log_ring_evicts_oldest() {
        let mut ring = HubLogRing::new(3);
        for i in 0..5 {
            ring.push(LogLine {
                stream: "stdout",
                line: format!("line {i}"),
                ts: i as u64,
            });
        }
        let snap = ring.snapshot();
        assert_eq!(snap.len(), 3);
        assert_eq!(snap[0].line, "line 2");
        assert_eq!(snap[1].line, "line 3");
        assert_eq!(snap[2].line, "line 4");
    }
}