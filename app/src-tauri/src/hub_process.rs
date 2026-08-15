//! T-1.3 — Hub 子进程管理
//!
//! 职责：
//! 1. spawn `agent-comm-hub` 子进程（带 --host/--port/--path/... 全部 12 项参数）
//! 2. 收集 stdout / stderr → 环形缓冲（最近 500 行）
//! 3. 端口就绪探测：每 100ms 试一次 TCP connect，10s 超时
//! 4. 进程死亡自动更新状态
//! 5. stop / restart 用 pid + 系统调用杀进程树（Windows taskkill / Unix kill -TERM→-KILL）
//!
//! 状态机：Stopped → Starting → Running ⇄ Stopping → Stopped，异常路径 Failed。
//! 状态变化通过 Tauri event `hub:state` 推前端；前端响应（托盘变灰 / banner）。

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

/// 环形日志缓冲（最近 N 行）。
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

/// Hub 启动参数（与 src/cli.ts 的可配置项 1:1 对齐）。
///
/// 注意：`to_argv()` 必须输出空格分隔的 `--flag value` 形式 —— 主仓 `src/cli.ts`
/// 的 `parseArgs` 走 `argv[i]` + `argv[i+1]` 模式读取值,`--flag=value` 会被
/// `throw new Error("unknown flag: --flag=value")` 拒掉（实测）。
#[derive(Debug, Clone)]
pub struct HubConfig {
    #[allow(dead_code)] // 4-tier `which_hub_launch()` 用自己的 PATH 解析;此字段保留给调用方手动指定。
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
            history_limit: 100,
            wait_timeout_ms: 60_000,
            default_wait_ms: 30_000,
            connected_window_ms: 30_000,
            peer_idle_timeout_ms: 600_000,
            herdr_bin: None,
            herdr_timeout_ms: None,
        }
    }
}

/// 定位 agent-comm-hub 启动方式。
/// 返回 (program, optional_script_path) —— spawn 时如果 script 存在，args = [script, ...hub_args]。
/// 优先级：
///   1. 同目录 agent-comm-hub(.exe)（开发场景，hub cli 跟 app exe 放一起）
///   2. PATH 上的 agent-comm-hub（npm 全局安装的 .cmd / .exe）
///   3. node + <主仓根>/lib/cli.js（开发场景，hub 主仓就在 app 上一层）
///   4. 退回 npx agent-comm-hub（保底；用户全局没装时 npx 会下载）
pub(crate) fn which_hub_launch() -> (PathBuf, Option<PathBuf>) {
    let exe_name = if cfg!(windows) { "agent-comm-hub.exe" } else { "agent-comm-hub" };

    // 1. 同目录
    if let Ok(exe) = std::env::current_exe() {
        let sibling = exe.with_file_name(exe_name);
        if sibling.exists() {
            return (sibling, None);
        }
        // 3. node + 主仓 lib/cli.js（debug 构建时 <exe> 在 src-tauri/target/<profile>/ ，
        //    向上 5 级到主仓根 D:/codes/agent-comm-hub/；release 构建层级可能不同，
        //    所以"找不到 lib/cli.js 就 fallback 到 tier-2"，不要硬报错）。
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

    // 2. PATH 上的 agent-comm-hub
    if let Some(found) = find_in_path(exe_name) {
        return (found, None);
    }

    // 4. 退回 npx
    let npx_name = if cfg!(windows) { "npx.cmd" } else { "npx" };
    if let Some(npx) = find_in_path(npx_name) {
        return (npx, None); // spawn 时把 "agent-comm-hub" 加到 args 开头
    }

    // 全部失败：返回裸名 + None，让 spawn 报错（错误信息会清楚）
    (PathBuf::from("agent-comm-hub"), None)
}

/// 手写 PATH 查找（避免加 which crate 依赖）。
fn find_in_path(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for entry in std::env::split_paths(&path_var) {
        let candidate = entry.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
        // Windows 上 .cmd / .bat 后缀
        #[cfg(windows)]
        {
            for ext in [".cmd", ".bat", ".exe"] {
                let mut with_ext = entry.join(name);
                with_ext.set_extension(if ext == ".exe" { "exe" } else { &ext[1..] });
                if with_ext.is_file() {
                    return Some(with_ext);
                }
                // 直接拼接后缀
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

/// 构造 hub CLI 的 tokio Command（含 which_hub_launch 的 4 种启动形态解析）。
/// `extra_args` 追加在 program/script 之后 —— start() 传 hub 启动参数，
/// service 命令（commands.rs service_install/uninstall）传 ["service", action]。
pub(crate) fn hub_cli_command(extra_args: &[&str]) -> tokio::process::Command {
    let (program, script) = which_hub_launch();
    let mut cmd = Command::new(&program);
    if let Some(s) = &script {
        cmd.arg(s);
    } else if program.file_name().and_then(|n| n.to_str())
        == Some(if cfg!(windows) { "npx.cmd" } else { "npx" })
    {
        // npx -y：跳过 "Ok to proceed?" 交互确认 —— 安装版环境 stdin 是 null，
        // 交互会永久卡住导致 hub 起不来（用户实测 MCP not initialized）。
        cmd.arg("-y");
        cmd.arg("agent-comm-hub");
    }
    cmd.args(extra_args);
    // 安装版用户实测：spawn .cmd / node / npx 都会弹控制台窗口（设置页闪终端、
    // hub 常驻空白终端）。CREATE_NO_WINDOW 完全抑制；start() 另外叠加
    // CREATE_NEW_PROCESS_GROUP（0x0200）用于 taskkill 杀进程树。
    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000);
    }
    cmd
}

/// Hub 进程控制器。M1 提供 start / stop / restart / status / snapshot_logs。
/// M2 在此基础上接入 sqlite_store 持久化；M3 加 herdr_bin 字段暴露设置面板。
pub struct HubProcess {
    config: HubConfig,
    log_ring: Arc<RwLock<HubLogRing>>,
    state: Arc<RwLock<(HubState, Option<String>)>>, // (state, last_error)
    pid: Arc<RwLock<Option<u32>>>,
    started_at: Arc<RwLock<Option<u64>>>,
    /// 由 `attach_app` 在 Tauri setup 阶段注入；用于 emit `hub:state` 事件。
    app_handle: Arc<RwLock<Option<AppHandle>>>,
    /// 由 setup 注入；每次 emit_state 时同步调用，传入当前 HubState。
    /// 用 Option<RwLock<...>> + 闭包同步到 tray 图标。
    tray_setter: Arc<RwLock<Option<Box<dyn Fn(HubState) + Send + Sync>>>>,
    /// external 复用模式下，探测到外部 hub 消失后是否已自动重启过（防循环）。
    auto_restarted: Arc<std::sync::atomic::AtomicBool>,
}

impl HubProcess {
    pub fn new(config: HubConfig) -> Arc<Self> {
        Arc::new(Self {
            config,
            log_ring: Arc::new(RwLock::new(HubLogRing::new(500))),
            state: Arc::new(RwLock::new((HubState::Stopped, None))),
            pid: Arc::new(RwLock::new(None)),
            started_at: Arc::new(RwLock::new(None)),
            app_handle: Arc::new(RwLock::new(None)),
            tray_setter: Arc::new(RwLock::new(None)),
            auto_restarted: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        })
    }

    /// 在 Tauri setup 阶段调用一次；idempotent。
    pub async fn attach_app(self: &Arc<Self>, app: AppHandle) {
        *self.app_handle.write().await = Some(app);
    }

    /// 取出 AppHandle 用于 emit 事件；Tauri setup 未完成时返回 None。
    pub async fn app_handle(&self) -> Option<AppHandle> {
        self.app_handle.read().await.clone()
    }

    /// 注入 tray setter：emit_state 时同步调，用于切换 tray 图标。
    pub async fn attach_tray_setter<F>(self: &Arc<Self>, setter: F)
    where
        F: Fn(HubState) + Send + Sync + 'static,
    {
        *self.tray_setter.write().await = Some(Box::new(setter));
    }

    #[allow(dead_code)] // M2 T-2.5 配置面板读取
    pub fn config(&self) -> &HubConfig {
        &self.config
    }

    pub async fn status(&self) -> HubStatus {
        let (state, last_error) = {
            let g = self.state.read().await;
            (g.0, g.1.clone())
        };
        HubStatus {
            state,
            pid: *self.pid.read().await,
            url: format!(
                "http://{}:{}{}",
                self.config.host, self.config.port, self.config.path
            ),
            host: self.config.host.clone(),
            port: self.config.port,
            path: self.config.path.clone(),
            started_at: *self.started_at.read().await,
            last_error,
        }
    }

    pub async fn snapshot_logs(&self) -> Vec<LogLine> {
        self.log_ring.read().await.snapshot()
    }

    /// 启动 hub 子进程；端口就绪后置 Running；任何失败置 Failed 并清理。
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

        // 端口已被占用：外部 hub（或另一个 app 实例）已在跑 —— 不 spawn 重复进程，
        // 直接复用（SPEC 关键数据流："检查端口是否已在响应，是则跳过 spawn"）。
        // 只探测一次（300ms 预算），避免把"上次启动未完成"误判为已占用。
        if wait_for_port_ready(&self.config.host, self.config.port, Duration::from_millis(300)).await
        {
            self.log_ring.write().await.push(LogLine {
                stream: "stdout",
                line: format!(
                    "external hub already listening on {}:{} — reusing it (not spawning a duplicate)",
                    self.config.host, self.config.port
                ),
                ts: now_ms(),
            });
            *self.started_at.write().await = Some(now_ms());
            {
                let mut s = self.state.write().await;
                *s = (HubState::Running, None);
            }
            self.emit_state().await;

            // 外部 hub 存活探测：每 5s TCP connect 一次，失败说明外部 hub 已退出
            // （可能被用户手动杀掉 / 持有方关闭）。此时先自动重启一次（spawn 自己
            // 的 hub，用户无感恢复），失败才置 Stopped；auto_restarted 原子位防循环。
            let host = self.config.host.clone();
            let port = self.config.port;
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
                    // 先拉回 Stopped 再自动重启：start() 会拒绝 Running/Starting 状态
                    // （用户实测 "auto-restart failed: hub is already in Running state"）。
                    *started_ref.write().await = None;
                    *state_ref.write().await = (HubState::Stopped, None);
                    if !auto_restarted.swap(true, std::sync::atomic::Ordering::SeqCst) {
                        // start() 的 future 不满足 tokio::spawn 的 Send 约束，改用
                        // std 线程 + Runtime::block_on（block_on 不要求 Send）。
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
                        // 等 2s 让 start() 完成端口探测/spawn，再判断最终状态
                        tokio::time::sleep(Duration::from_secs(2)).await;
                        if matches!(*state_ref.read().await, (HubState::Running, _)) {
                            break; // 自己的 hub 起来了（child-wait 管生命周期）
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

        let argv = self.config.to_argv();
        let arg_refs: Vec<&str> = argv.iter().map(String::as_str).collect();
        let mut cmd = hub_cli_command(&arg_refs);
        cmd.stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null());
        // Windows：CREATE_NEW_PROCESS_GROUP（0x0200，便于 stop 时 taskkill /T 杀整树）
        // | CREATE_NO_WINDOW（0x08000000，hub_cli_command 已设，这里保持叠加不清掉）。
        // tokio::process::Command 自带 creation_flags（无需 std::os::windows::process::CommandExt）。
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

        // stdout / stderr → log ring（M1 占位：tasukete，T-1.4 再加过滤）
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

        // 端口就绪探测（10s 预算，每 100ms 一次）
        let url = format!(
            "http://{}:{}{}",
            self.config.host, self.config.port, self.config.path
        );
        let ready = wait_for_port_ready(
            &self.config.host,
            self.config.port,
            Duration::from_secs(10),
        )
        .await;

        if !ready {
            // 探测失败：杀掉 spawn 出来的子进程
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
        // 自己的 hub 真实起来了：重置自动重启位（下次外部场景仍可自动恢复）
        self.auto_restarted.store(false, std::sync::atomic::Ordering::SeqCst);
        self.emit_state().await;

        // 异步等子进程退出，自动恢复 Stopped（外部不再持 child handle）
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

    /// 用 pid 杀进程树（Windows taskkill /F /T，Unix SIGTERM → 500ms → SIGKILL）。
    pub async fn stop(&self) -> Result<(), String> {
        let pid = match *self.pid.read().await {
            Some(p) => p,
            None => {
                // 区分"外部 hub 复用模式"（Running 但 pid=None）与"真·未在运行"，
                // 给前端可读的错误而不是误导性的"hub 未在运行"。
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

/// 单次 TCP 可达性探测（2s 内 connect 成功即 true）。tokio connect 可能挂很久，
/// 所以包一层 timeout。
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
        // 先 SIGTERM 让 hub 优雅退出
        let _ = Command::new("kill")
            .arg("-TERM")
            .arg(pid.to_string())
            .output()
            .await;
        sleep(Duration::from_millis(500)).await;
        // 兜底 SIGKILL
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
        // 空格分隔形式（与主仓 src/cli.ts 的 parseArgs 期望对齐；不能用 --flag=value）。
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
        assert_eq!(cfg.history_limit, 100);
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