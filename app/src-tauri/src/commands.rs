//! Tauri commands (frontend invoke entry points).
//!
//! All RPC for the Hub process + bridge tools + SQLite config is exposed through here.
//! The frontend calls `invoke('hub_start')` / `invoke('bridge_peers')` / `invoke('config_get')` etc.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::RwLock;

use crate::herdr_client::{HerdrAgent, HerdrCtl, HerdrPane, HerdrRead, HerdrSettled};
use crate::hub_process::{hub_cli_command, HubConfig, HubProcess, HubState, HubStatus, LogLine};
use crate::mcp_client::{ClientInfo, McpError, McpClient};
use crate::sqlite_store::{MessageRecord, PeerRecord, Store, UnreadRecord};

/// Local suppression set of kicked peers (P3-2 race defense; semantics in sync_roster_to_store).
/// The critical section is a constant-size set operation, so a std Mutex suffices — no async lock needed.
pub(crate) type KickedPeers = Arc<std::sync::Mutex<HashSet<String>>>;

/// Apply the hub settings saved in the SQLite config table onto a HubConfig (keys that are
/// missing / unparseable keep the base value). This is the only path through which settings
/// actually take effect — previously config_set only wrote to the DB while the restart still
/// used in-memory defaults, so saved settings never applied (verified by the user).
pub(crate) fn apply_saved_config(cfg: &mut HubConfig, store: &Store) {
    let saved = |key: &str| store.get_config(key).ok().flatten().map(|r| r.value);
    if let Some(v) = saved("host") {
        if !v.is_empty() {
            cfg.host = v;
        }
    }
    if let Some(v) = saved("port") {
        if let Ok(n) = v.parse::<u16>() {
            cfg.port = n;
        }
    }
    if let Some(v) = saved("path") {
        if !v.is_empty() {
            cfg.path = v;
        }
    }
    // Number keys are uniformly u32 (port is u16 and parsed separately); invalid values keep the default.
    for (key, slot) in [
        ("max_queue", &mut cfg.max_queue),
        ("history_limit", &mut cfg.history_limit),
        ("wait_timeout_ms", &mut cfg.wait_timeout_ms),
        ("default_wait_ms", &mut cfg.default_wait_ms),
        ("connected_window_ms", &mut cfg.connected_window_ms),
        ("peer_idle_timeout_ms", &mut cfg.peer_idle_timeout_ms),
    ] {
        if let Some(v) = saved(key) {
            if let Ok(n) = v.parse::<u32>() {
                *slot = n;
            }
        }
    }
    if let Some(v) = saved("herdr_bin") {
        cfg.herdr_bin = if v.is_empty() { None } else { Some(v) };
    }
    if let Some(v) = saved("herdr_timeout_ms") {
        if let Ok(n) = v.parse::<u32>() {
            cfg.herdr_timeout_ms = Some(n);
        }
    }
}

/// The peer id of this end (the desktop GUI) in the hub — the hub's default manager (managerPeers).
/// clientInfo.name equals this id (the hub auto-registers by name; same-name connections attach N:1).
/// Keep SELF_PEER_ID here in sync with src/lib/self.ts in the frontend.
pub(crate) const SELF_PEER_ID: &str = "agent-hub-cli";

/// Tauri global state: singleton HubProcess + lazily initialized McpClient + SQLite store.
pub struct AppState {
    pub hub: Arc<HubProcess>,
    pub mcp: Arc<RwLock<Option<Arc<McpClient>>>>,
    pub store: Arc<Store>,
    pub kicked: KickedPeers,
}

impl AppState {
    pub fn new(config: HubConfig, store: Arc<Store>) -> Self {
        Self {
            hub: HubProcess::new(config),
            mcp: Arc::new(RwLock::new(None)),
            store,
            kicked: Arc::new(std::sync::Mutex::new(HashSet::new())),
        }
    }
}

/// Serialize command errors (the frontend receives `{ ok: false, error: "..." }`).
#[derive(Debug, Serialize)]
pub(crate) struct CommandError {
    ok: bool,
    error: String,
}

impl From<String> for CommandError {
    fn from(error: String) -> Self {
        Self { ok: false, error }
    }
}

impl From<crate::mcp_client::McpError> for CommandError {
    fn from(error: crate::mcp_client::McpError) -> Self {
        Self { ok: false, error: error.to_string() }
    }
}

type CmdResult<T> = Result<T, CommandError>;

fn wrap<T, E: ToString>(r: Result<T, E>) -> CmdResult<T> {
    r.map_err(|e| CommandError::from(e.to_string()))
}

/// Unwrap the hub's tools/call result (MCP envelope).
///
/// The hub end (src/mcp-server.ts `tools/call`) returns `{ content: [{ type: 'text',
/// text: '<JSON>' }], isError: bool }` uniformly for **all** tools, including the
/// bridge_chat receipt — no exceptions. Passing it through verbatim leaves the frontend's
/// `result.peers` / `result.messages` / `result.ok` all undefined (this used to crash
/// PeersView: `Cannot read properties of undefined (reading 'length')`).
/// This is the single place that unwraps it:
/// - `isError: true` → Err (text is the error message; the frontend shows it via catch)
/// - otherwise extract `content[0].text` and JSON.parse (hub-end lossless JSON contract)
/// - odd shapes without content/text are passed through verbatim (backward compatible, doesn't crash the UI)
fn unwrap_tool_result(value: Value) -> CmdResult<Value> {
    if value.get("isError").and_then(Value::as_bool).unwrap_or(false) {
        // The hub error envelope's text is `{"error": "..."}` (mcp-server.ts tools/call catch branch);
        // extract .error so the frontend gets a clean error message instead of a blob of JSON.
        let text = value.pointer("/content/0/text").and_then(Value::as_str).unwrap_or("");
        let msg = serde_json::from_str::<Value>(text)
            .ok()
            .and_then(|v| v.get("error").and_then(Value::as_str).map(String::from))
            .unwrap_or_else(|| {
                if text.is_empty() {
                    "tool error".to_string()
                } else {
                    text.to_string()
                }
            });
        return Err(CommandError::from(msg));
    }
    if let Some(text) = value.pointer("/content/0/text").and_then(Value::as_str) {
        return match serde_json::from_str::<Value>(text) {
            Ok(parsed) => Ok(parsed),
            Err(_) => Ok(json!(text)), // non-JSON text: return it verbatim as a string
        };
    }
    Ok(value)
}

/// Fetch the mcp client; if uninitialized (hub not running) return a NotConnected error.
/// Lazy reconnect (PRD F-08 minimal version): when the hub is Running but the mcp client is
/// missing (an external hub already existed at app startup, or the hub crashed and was
/// restarted by an external process), try to rebuild the connection and return; still give a
/// clear error on failure.
async fn require_mcp(state: &AppState) -> CmdResult<Arc<McpClient>> {
    if let Some(client) = state.mcp.read().await.as_ref().cloned() {
        return Ok(client);
    }
    if state.hub.status().await.state == HubState::Running {
        if let Some(app) = state.hub.app_handle().await {
            ensure_mcp_initialized(&app, state, &state.hub.status().await).await;
            if let Some(client) = state.mcp.read().await.as_ref().cloned() {
                return Ok(client);
            }
        }
    }
    Err(CommandError::from("MCP not initialized — hub may not be running".to_string()))
}

/// tools_call + unwrap + dropped-connection self-heal.
///
/// Connection class errors (Http / NotConnected) mean the hub is unreachable (typical case:
/// an external hub was killed but the app still holds a stale mcp client reference → polling
/// permanently reports `http: error sending request`). In that case clear the mcp reference so
/// the next call goes through require_mcp's lazy reconnect (rebuilt automatically while the hub
/// is Running); if the hub is truly dead, return a clear error visible to the frontend.
async fn tools_call_checked(state: &AppState, name: &str, args: Value) -> CmdResult<Value> {
    let mcp = require_mcp(state).await?;
    match mcp.tools_call(name, args).await {
        Ok(raw) => unwrap_tool_result(raw),
        Err(e) => {
            if matches!(e, McpError::Http(_) | McpError::NotConnected) {
                *state.mcp.write().await = None;
                log::warn!("bridge_{name} connect failed; dropped mcp ref, waiting for lazy reconnect: {e}");
            }
            Err(CommandError::from(e.to_string()))
        }
    }
}

// -------- Hub process commands --------

#[tauri::command]
pub async fn hub_start(state: State<'_, AppState>) -> CmdResult<HubStatus> {
    wrap(state.hub.start().await)?;
    let status = state.hub.status().await;
    // Initialize the MCP client + register the agent-hub-cli peer once the hub port is ready
    if let Some(app) = state.hub.app_handle().await {
        ensure_mcp_initialized(&app, &state, &status).await;
    }
    Ok(status)
}

#[tauri::command]
pub async fn hub_stop(state: State<'_, AppState>) -> CmdResult<HubStatus> {
    wrap(state.hub.stop().await)?;
    // Clear the mcp reference after stopping; re-initialize on the next start
    *state.mcp.write().await = None;
    Ok(state.hub.status().await)
}

#[tauri::command]
pub async fn hub_restart(state: State<'_, AppState>) -> CmdResult<HubStatus> {
    wrap(state.hub.restart().await)?;
    *state.mcp.write().await = None;
    let status = state.hub.status().await;
    if let Some(app) = state.hub.app_handle().await {
        ensure_mcp_initialized(&app, &state, &status).await;
    }
    Ok(status)
}

#[tauri::command]
pub async fn hub_status(state: State<'_, AppState>) -> CmdResult<HubStatus> {
    Ok(state.hub.status().await)
}

#[tauri::command]
pub async fn hub_get_logs(state: State<'_, AppState>) -> CmdResult<Vec<LogLine>> {
    Ok(state.hub.snapshot_logs().await)
}

/// Called once by the frontend after load: notifies the backend that "the frontend is ready",
/// triggering the hub auto-start + MCP init.
#[tauri::command]
pub async fn app_ready(app: AppHandle, state: State<'_, AppState>) -> CmdResult<HubStatus> {
    state.hub.attach_app(app.clone()).await;
    match state.hub.start().await {
        Ok(()) => {
            let status = state.hub.status().await;
            ensure_mcp_initialized(&app, &state, &status).await;
            Ok(status)
        }
        Err(_e) => {
            let status = state.hub.status().await;
            let _ = app.emit("hub:state", &status);
            Ok(status)
        }
    }
}

/// `quit_app`: completely exit the program (including the tray). Called by the "quit program"
/// option of the close-button modal; same semantics as the tray menu "Quit" (app.exit(0)).
#[tauri::command]
pub async fn quit_app(app: AppHandle) -> CmdResult<()> {
    app.exit(0);
    Ok(())
}

/// After the hub is Running, create an McpClient, initialize, explicitly register the
/// agent-hub-cli peer, then open an SSE long-lived connection to stay online (on the hub end
/// `bridge_peers` treats a session with an SSE channel as connected — another way to stay
/// active besides the CLI-side `bridge_wait` long-poll).
///
/// Failure only logs a warning, it does not return an error (keeps the UI usable).
async fn ensure_mcp_initialized(app: &AppHandle, state: &AppState, _status: &HubStatus) {
    if state.mcp.read().await.is_some() {
        return; // already initialized
    }
    let cfg = state.hub.config();
    // Remote-mode bearer token (hub started with --auth-tokens). This is a
    // CONNECTION property, not a spawn argument, so it lives outside
    // apply_saved_config and is read straight from the store here. Empty
    // string = no token (local loopback hub).
    let auth_token = state
        .store
        .get_config("auth_token")
        .ok()
        .flatten()
        .map(|r| r.value)
        .filter(|v| !v.is_empty());
    // clientInfo.name is directly the target peer id: the hub attaches same-name connections
    // N:1 (no duplicate registration, no "peer already registered"). Historically it used
    // "agent-comm-hub-cli" + an explicit bridge_register("agent-hub-cli") rename — a lazy
    // reconnect created a second session whose rename failed, leaving both agent-comm-hub-cli
    // and agent-hub-cli peers alive and logging duplicate "peer joined" on every init.
    let client = Arc::new(McpClient::new(
        &cfg.host,
        cfg.port,
        &cfg.path,
        ClientInfo::new(SELF_PEER_ID, env!("CARGO_PKG_VERSION")),
        auth_token,
    ));
    // Port ready ≠ hub fully ready: initialize may race startup (especially with a cold npx
    // download / freshly freed port); retry 15 times × 1s (15s window) before giving up
    // (failure only logs, the UI still works).
    let mut last_err: Option<McpError> = None;
    for attempt in 1..=15 {
        match client.initialize().await {
            Ok(_) => {
                last_err = None;
                break;
            }
            Err(e) => {
                log::warn!("MCP initialize attempt {attempt}/15 failed, retrying in 1s: {e}");
                last_err = Some(e);
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    }
    if let Some(e) = last_err {
        log::warn!("MCP initialize failed after 15 attempts: {e}; agent-hub-cli will be unavailable");
        return;
    }
    // Explicit bridge_register "agent-hub-cli" (auto-register already sanitizes clientInfo.name
    // into a same-name peer; the explicit register is redundant but idempotent, ensuring the connection semantics).
    if let Err(e) = client
        .tools_call("bridge_register", json!({ "peerId": SELF_PEER_ID }))
        .await
    {
        log::warn!("bridge_register {SELF_PEER_ID} failed: {e}");
    }

    // Publish the client BEFORE spawning the SSE watchdog: every watchdog
    // iteration checks that its client is still the active one (Arc::ptr_eq)
    // and exits when a lazy reconnect replaced it — reconnects never stack up
    // duplicate SSE streams.
    *state.mcp.write().await = Some(client.clone());

    // SSE long-lived connection + reconnect watchdog. The stream serves two
    // purposes: staying "connected" on the hub (a live SSE channel counts, on
    // equal footing with the bridge_wait long-poll) and receiving real-time
    // pushes. The hub pushes JSON-RPC notifications
    // `{method:"notifications/message", params:{level,logger,data}}`; data is
    // branched by event:
    // - `{event:"peers_changed", peers:[full roster]}` → persist to SQLite + emit `hub:peers`
    // - `{event:"message", message:{BridgeMessage, content decoded}}` → emit `hub:message`
    // - `{event:"heartbeat", ts}` → liveness only (hub ≥ 0.7.2, every ~20s)
    // The watchdog treats a closed channel (hub restart) or >70s of silence
    // (three missed heartbeats — a half-open TCP looks alive otherwise) as
    // fatal and resubscribes with capped exponential backoff. Previously the
    // subscription was attempted exactly once: one dead stream silently
    // downgraded the UI to the 3s history poll (the "messages only appear
    // after the peer picks them up" symptom).
    // Parsing is defensive throughout: missing fields only log at debug level
    // and never panic (notifications are a best-effort side channel).
    {
        let mcp_slot = state.mcp.clone();
        let app = app.clone();
        let store = state.store.clone();
        let kicked = state.kicked.clone();
        tokio::spawn(async move {
            let mut backoff = Duration::from_secs(1);
            loop {
                {
                    let current = mcp_slot.read().await;
                    if !matches!(current.as_ref(), Some(active) if Arc::ptr_eq(active, &client)) {
                        log::info!("SSE watchdog: mcp client superseded, stopping");
                        break;
                    }
                }
                match client.subscribe_notifications().await {
                    Ok(mut rx) => {
                        backoff = Duration::from_secs(1);
                        loop {
                            match tokio::time::timeout(Duration::from_secs(70), rx.recv()).await {
                                Ok(Some(notif)) => {
                                    let method =
                                        notif.get("method").and_then(|v| v.as_str()).unwrap_or("");
                                    if method == "notifications/message" {
                                        let data = notif.pointer("/params/data");
                                        match data.and_then(|d| d.get("event")).and_then(Value::as_str) {
                                            Some("peers_changed") => {
                                                match data.and_then(|d| d.get("peers")).and_then(Value::as_array) {
                                                    Some(peers) => {
                                                        sync_roster_to_store(&store, &kicked, peers);
                                                        let _ = app.emit("hub:peers", peers);
                                                    }
                                                    // Missing peers field: skip entirely; emitting an empty array would clear the frontend roster.
                                                    None => {
                                                        log::debug!("SSE peers_changed has no data.peers field, ignoring");
                                                    }
                                                }
                                            }
                                            Some("message") => match data.and_then(|d| d.get("message")) {
                                                Some(msg) => {
                                                    let _ = app.emit("hub:message", msg);
                                                }
                                                None => {
                                                    log::debug!("SSE message notification has no data.message field, ignoring");
                                                }
                                            },
                                            // Liveness beat: receiving it is enough (the timeout above resets).
                                            Some("heartbeat") => {}
                                            // The legacy assumption of params.message (the hub never sent it) is obsolete;
                                            // any unknown shape goes to debug, not to the UI.
                                            other => {
                                                log::debug!("SSE notifications/message data.event={other:?}");
                                            }
                                        }
                                    } else if !method.is_empty() {
                                        log::debug!("SSE notification: {method}");
                                    }
                                }
                                Ok(None) => {
                                    log::info!("SSE channel closed by hub; resubscribing");
                                    break;
                                }
                                Err(_) => {
                                    log::warn!("SSE silent >70s (heartbeats missed); resubscribing");
                                    break;
                                }
                            }
                        }
                    }
                    Err(e) => {
                        log::warn!("subscribe_notifications failed: {e}; retrying in {backoff:?}");
                    }
                }
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(Duration::from_secs(30));
            }
        });
    }
}

/// Persist the hub's peers snapshot (from bridge_peers results / the peers_changed array) to SQLite.
///
/// Malformed rows missing id are skipped; lastSeenMs defaults to the current time; missing
/// alias/clientName/clientVersion keep their old values (COALESCE, see upsert_peer: older hub
/// versions don't return these fields at all, and a passive snapshot shouldn't clear locally
/// known info; explicit alias clearing goes through the authoritative bridge_rename → set_peer_alias).
///
/// P3-2 kick/in-flight-snapshot race: when a kick precedes a snapshot and the delete is
/// consumed before that snapshot, a direct upsert would "resurrect" the kicked row. Add the id
/// to the suppression set at kick time; on the first sight of a suppressed id, sync only lifts
/// the suppression and skips the upsert (this snapshot may be the stale in-flight data); only a
/// later roster still containing that id (the hub keeps listing it = re-registered) is persisted.
fn sync_roster_to_store(store: &Store, kicked: &KickedPeers, peers: &[Value]) {
    let now = now_ms();
    for p in peers {
        let Some(id) = p.get("id").and_then(Value::as_str) else {
            continue;
        };
        {
            let mut suppress = kicked.lock().unwrap_or_else(|po| po.into_inner());
            if suppress.remove(id) {
                log::debug!("roster skipping suppressed (just kicked) peer {id}, only lifting suppression");
                continue;
            }
        }
        let rec = PeerRecord {
            peer_id: id.to_string(),
            last_seen: p.get("lastSeenMs").and_then(Value::as_i64).unwrap_or(now),
            online: p.get("connected").and_then(Value::as_bool).unwrap_or(false),
            client_name: p.get("clientName").and_then(Value::as_str).map(String::from),
            alias: p.get("alias").and_then(Value::as_str).map(String::from),
            client_version: p.get("clientVersion").and_then(Value::as_str).map(String::from),
            created_at: now,
        };
        if let Err(e) = store.upsert_peer(&rec) {
            log::warn!("roster upsert_peer({id}) 失败: {e}");
        }
    }
}

// -------- Roster management (rename / kick / local roster) --------

/// `bridge_rename`: change alias / change routing id. alias is trimmed to 1-64 chars, must not
/// contain control characters (validated by the hub); empty/whitespace-only = clear the alias.
/// No peer passed = rename yourself; peer passed = a manager renames another (this end
/// agent-hub-cli is the hub's default manager and always has permission; if the hub refuses,
/// the error is passed through to the frontend). new_peer_id = a manager true re-key rename
/// (the hub atomically migrates that peer's mailbox, waiters, session bindings and history
/// ownership; requires an explicit peer).
#[tauri::command]
pub async fn bridge_rename(
    state: State<'_, AppState>,
    peer: Option<String>,
    alias: Option<String>,
    new_peer_id: Option<String>,
) -> CmdResult<Value> {
    let mut args = serde_json::Map::new();
    if let Some(a) = alias {
        args.insert("alias".into(), json!(a));
    }
    if let Some(p) = peer {
        args.insert("peer".into(), json!(p));
    }
    if let Some(id) = new_peer_id {
        args.insert("peerId".into(), json!(id));
    }
    let result = tools_call_checked(&state, "bridge_rename", Value::Object(args)).await?;
    // id re-key: if previousId is present the routing id changed, so the old id's local row is
    // deleted entirely; the alias/metadata are rebuilt under the new id by the next roster
    // snapshot (on re-key the profile—including the alias—migrates together, and the sync
    // logic below writes the alias to the new id's row).
    if let Some(prev) = result.get("previousId").and_then(Value::as_str) {
        if let Err(e) = state.store.delete_peer(prev) {
            log::warn!("failed to delete local row for old id after re-key ({prev}): {e}");
        }
    }
    // The rename result is the only authoritative source of the alias (snapshot default is
    // ambiguous, see set_peer_alias): if the result carries an alias → write it; absent
    // (cleared) → store NULL.
    if let (Some(id), Some(alias_out)) = (
        result.get("peerId").and_then(Value::as_str),
        result.get("alias").and_then(Value::as_str),
    ) {
        if let Err(e) = state.store.set_peer_alias(id, Some(alias_out)) {
            log::warn!("failed to sync local alias after rename ({id}): {e}");
        }
    } else if let Some(id) = result.get("peerId").and_then(Value::as_str) {
        if let Err(e) = state.store.set_peer_alias(id, None) {
            log::warn!("failed to clear local alias after rename ({id}): {e}");
        }
    }
    Ok(result)
}

/// `bridge_unregister_peer`: a manager kicks a peer (hub bridge_unregister with a peer arg).
/// When kicked=true the target has been removed from the hub — delete its local roster row and
/// add it to the suppression set to prevent in-flight stale snapshots from resurrecting the
/// kicked row (see sync_roster_to_store).
#[tauri::command]
pub async fn bridge_unregister_peer(
    state: State<'_, AppState>,
    peer: String,
) -> CmdResult<Value> {
    let result = tools_call_checked(&state, "bridge_unregister", json!({ "peer": peer })).await?;
    if result.get("kicked").and_then(Value::as_bool).unwrap_or(false) {
        if let Err(e) = state.store.delete_peer(&peer) {
            log::warn!("failed to delete local roster row after kick ({peer}): {e}");
        }
        state
            .kicked
            .lock()
            .unwrap_or_else(|po| po.into_inner())
            .insert(peer);
    }
    Ok(result)
}

/// `roster_forget`: only delete the local SQLite roster row (doesn't touch the hub) — offline·
/// known rows have no hub-side counterpart; without this entry the local roster only ever grows.
#[tauri::command]
pub async fn roster_forget(state: State<'_, AppState>, peer_id: String) -> CmdResult<()> {
    wrap(state.store.delete_peer(&peer_id))
}

/// `roster_list`: all SQLite peer rows (including offline known peers); the frontend restores the
/// pre-restart roster from it at startup; live snapshots (bridge_peers / hub:peers) take priority.
#[tauri::command]
pub async fn roster_list(state: State<'_, AppState>) -> CmdResult<Vec<PeerRecord>> {
    wrap(state.store.list_peers())
}

// -------- Generic bridge_* entry points (MCP passthrough) --------

/// `bridge_peers`: list every peer currently on the hub and persist the snapshot to SQLite as a
/// side effect (roster_list restores the full pre-restart roster from it, including offline known peers).
#[tauri::command]
pub async fn bridge_peers(state: State<'_, AppState>) -> CmdResult<Value> {
    let result = tools_call_checked(&state, "bridge_peers", json!({})).await?;
    if let Some(peers) = result.get("peers").and_then(Value::as_array) {
        sync_roster_to_store(&state.store, &state.kicked, peers);
    }
    Ok(result)
}

#[tauri::command]
pub async fn bridge_status(state: State<'_, AppState>) -> CmdResult<Value> {
    tools_call_checked(&state, "bridge_status", json!({})).await
}

/// `bridge_wait`: long-poll for the next message (the core of the frontend message stream's
/// continuous listening — this was previously missing, so the UI never received replies from
/// other peers; the hub's history is only recorded when a waiter/poll hits).
#[tauri::command]
pub async fn bridge_wait(
    state: State<'_, AppState>,
    timeout_ms: Option<u32>,
    from: Option<String>,
) -> CmdResult<Value> {
    let mut args = serde_json::Map::new();
    if let Some(t) = timeout_ms {
        args.insert("timeoutMs".into(), json!(t));
    }
    if let Some(f) = from {
        args.insert("from".into(), json!(f));
    }
    tools_call_checked(&state, "bridge_wait", Value::Object(args)).await
}

/// `bridge_history`: fetch the recent messages of a peer (or self), while also writing the
/// messages into SQLite. The frontend polls every 3s by default; writing to SQLite guarantees
/// history can be restored after a restart.
#[tauri::command]
pub async fn bridge_history(
    state: State<'_, AppState>,
    peer: Option<String>,
    limit: Option<u32>,
) -> CmdResult<Value> {
    let mut args = serde_json::Map::new();
    if let Some(p) = peer {
        args.insert("peer".into(), json!(p));
    }
    if let Some(l) = limit {
        args.insert("limit".into(), json!(l));
    }
    let result = tools_call_checked(&state, "bridge_history", Value::Object(args)).await?;

    // Sync the fetched messages into SQLite (M2 T-2.6 persistence).
    // After unwrap_tool_result, result is already the hub's `{messages: [...]}` (lossless JSON).
    if let Some(msgs) = result.get("messages").and_then(|m| m.as_array()) {
        let now = now_ms();
        for m in msgs {
            if let Some(rec) = json_to_message_record(m, now) {
                if let Err(e) = state.store.insert_message(&rec) {
                    log::warn!("insert_message failed: {e}");
                }
            }
        }
    }

    Ok(result)
}

/// `history_local`: restore history messages from SQLite (SPEC F-09 "restore context on startup").
///
/// The hub's historyRing is an in-memory ring buffer (cap historyLimit and cleared on hub
/// restart); messages are already written to SQLite as a side effect on each bridge_history
/// fetch. The frontend calls this command at startup to fill the initial message stream, then
/// the hub-side polling merges in (dedup by id, local messages kept).
/// The content field is the full message JSON string (the json_to_message_record write format);
/// the frontend parses it back into a PresentedMessage.
/// When peer is `Some("all")` (the broadcast address; the hub refuses registration under it,
/// so it's a safe sentinel) it returns the tail of the full archive — the relay-stream view
/// pulls in history between any peers (including private conversations between other peers).
#[tauri::command]
pub async fn history_local(
    state: State<'_, AppState>,
    peer: Option<String>,
    limit: Option<u32>,
) -> CmdResult<Value> {
    let limit = limit.unwrap_or(100).min(1000) as i64;
    let records = match peer.as_deref() {
        Some("all") => state.store.list_all_messages(limit),
        Some(p) => state.store.list_messages_for_peer(p, limit),
        // Backward-compatible with the old identity 'agent-comm-hub-cli': the identity the app
        // registered under before the rename fix; query both.
        None => state
            .store
            .list_messages_for_peer(SELF_PEER_ID, limit)
            .and_then(|mut rows| {
                state.store
                    .list_messages_for_peer("agent-comm-hub-cli", limit)
                    .map(|older| {
                        rows.extend(older);
                        rows
                    })
            }),
    };
    let mut all = records.unwrap_or_else(|e| {
        log::warn!("history_local query failed: {e}");
        Vec::new()
    });
    all.sort_by_key(|r| r.ts);
    all.dedup_by_key(|r| r.id.clone());
    let messages: Vec<Value> = all
        .into_iter()
        .rev()
        .take(limit as usize)
        .map(|r| {
            json!({
                "id": r.id,
                "from": r.from_peer,
                "to": r.to_peer,
                "kind": r.kind,
                "content": r.content,
                "ref": r.ref_id,
                "ts": r.ts,
            })
        })
        .collect();
    Ok(json!({ "messages": messages }))
}

/// Convert a message JSON returned by MCP into a SQLite record (content field is kept as a JSON string).
fn json_to_message_record(v: &Value, _now: i64) -> Option<MessageRecord> {
    Some(MessageRecord {
        id: v.get("id")?.as_str()?.to_string(),
        from_peer: v.get("from")?.as_str()?.to_string(),
        to_peer: v.get("to")?.as_str()?.to_string(),
        kind: v.get("kind")?.as_str()?.to_string(),
        content: v.to_string(), // serialize the whole message as a JSON string
        ref_id: v.get("ref").and_then(|r| r.as_str()).map(|s| s.to_string()),
        ts: v.get("ts")?.as_i64()?,
        involved_me: v.get("from")?.as_str() == Some(SELF_PEER_ID)
            || v.get("to")?.as_str() == Some(SELF_PEER_ID),
    })
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// `bridge_chat`: send a chat to a given peer.
/// Returns a receipt (the hub end also wraps it in the MCP content envelope; unwrapped here uniformly).
/// Persist the receipt message into SQLite on success (optimistic message persistence).
/// The hub's history is only recorded when a waiter/poll hits, while what bridge_history
/// writes into SQLite is the "pulled" messages — if nobody consumes a sent message, it's
/// neither in the hub history nor pulled, and is lost on restart. So we persist on the send path.
fn persist_receipt(state: &AppState, receipt: &Value, body: Value, ref_id: Option<String>) {
    let Some(id) = receipt.get("id").and_then(Value::as_str) else { return };
    let Some(from) = receipt.get("from").and_then(Value::as_str) else { return };
    let Some(to) = receipt.get("to").and_then(Value::as_str) else { return };
    let Some(kind) = receipt.get("kind").and_then(Value::as_str) else { return };
    let ts = receipt.get("ts").and_then(Value::as_i64).unwrap_or_else(now_ms);
    let message = json!({ "id": id, "from": from, "to": to, "kind": kind, "content": body, "ts": ts });
    let rec = MessageRecord {
        id: id.to_string(),
        from_peer: from.to_string(),
        to_peer: to.to_string(),
        kind: kind.to_string(),
        content: message.to_string(),
        ref_id,
        ts,
        involved_me: from == SELF_PEER_ID || to == SELF_PEER_ID,
    };
    if let Err(e) = state.store.insert_message(&rec) {
        log::warn!("persist_receipt failed: {e}");
    }
}

#[tauri::command]
pub async fn bridge_chat(
    state: State<'_, AppState>,
    to: String,
    message: String,
) -> CmdResult<Value> {
    let result = tools_call_checked(
        &state,
        "bridge_chat",
        json!({ "to": to, "message": message }),
    )
    .await?;
    persist_receipt(&state, &result, json!(message), None);
    Ok(result)
}

/// `bridge_task`: delegate a task (more args). Wired in at M2 T-2.5; first exposed as a tauri command placeholder.
#[tauri::command]
pub async fn bridge_task(
    state: State<'_, AppState>,
    to: String,
    prompt: String,
    context: Option<String>,
    deliverable: Option<String>,
) -> CmdResult<Value> {
    let mut args = serde_json::Map::new();
    args.insert("to".into(), json!(to.clone()));
    args.insert("prompt".into(), json!(prompt.clone()));
    if let Some(c) = &context {
        args.insert("context".into(), json!(c));
    }
    if let Some(d) = &deliverable {
        args.insert("deliverable".into(), json!(d));
    }
    let result = tools_call_checked(&state, "bridge_task", Value::Object(args)).await?;
    let mut body = serde_json::Map::new();
    body.insert("prompt".into(), json!(prompt));
    if let Some(c) = context {
        body.insert("context".into(), json!(c));
    }
    if let Some(d) = deliverable {
        body.insert("deliverable".into(), json!(d));
    }
    persist_receipt(&state, &result, Value::Object(body), None);
    Ok(result)
}

/// `bridge_ack`: ack a task (or other message). status: accepted/rejected/done/failed.
#[tauri::command]
pub async fn bridge_ack(
    state: State<'_, AppState>,
    ref_id: String,
    status: String,
    note: Option<String>,
) -> CmdResult<Value> {
    let mut args = serde_json::Map::new();
    args.insert("ref".into(), json!(ref_id.clone()));
    args.insert("status".into(), json!(status.clone()));
    if let Some(n) = &note {
        args.insert("note".into(), json!(n));
    }
    let result = tools_call_checked(&state, "bridge_ack", Value::Object(args)).await?;
    let mut body = serde_json::Map::new();
    body.insert("status".into(), json!(status));
    if let Some(n) = note {
        body.insert("note".into(), json!(n));
    }
    persist_receipt(&state, &result, Value::Object(body), Some(ref_id));
    Ok(result)
}

// -------- Auto-start on login (PRD F-13 / SPEC AC-9) --------

/// `service_install`: run `agent-comm-hub service install` (Windows Run key / Linux systemd /
/// macOS launchd, implemented in the main repo's ops.ts) and return the subprocess output.
#[tauri::command]
pub async fn service_install() -> CmdResult<Value> {
    run_service_cmd("install").await
}

/// `service_uninstall`: run `agent-comm-hub service uninstall`.
#[tauri::command]
pub async fn service_uninstall() -> CmdResult<Value> {
    run_service_cmd("uninstall").await
}

/// Run `agent-comm-hub service <action>` using the same CLI resolution as the hub spawn (which_hub_launch).
/// The output is shown back to the frontend; a non-zero exit turns into a CommandError.
async fn run_service_cmd(action: &str) -> CmdResult<Value> {
    let mut cmd = hub_cli_command(&["service", action]);
    let out = cmd
        .output()
        .await
        .map_err(|e| CommandError::from(format!("failed to invoke service {action}: {e}")))?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if !out.status.success() {
        let detail = if !stderr.is_empty() { stderr } else { stdout };
        return Err(CommandError::from(format!(
            "service {action} failed (exit {}): {detail}",
            out.status.code().unwrap_or(-1)
        )));
    }
    let output = if !stdout.is_empty() { stdout } else { stderr };
    Ok(json!({ "ok": true, "action": action, "output": output }))
}

// -------- Hub tools (version / check update / update, settings panel extensions) --------

/// `hub_cli_version`: `agent-comm-hub --version` — the locally installed hub CLI version.
#[tauri::command]
pub async fn hub_cli_version() -> CmdResult<Value> {
    let mut cmd = hub_cli_command(&["--version"]);
    let out = cmd
        .output()
        .await
        .map_err(|e| CommandError::from(format!("failed to invoke hub CLI version: {e}")))?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if !out.status.success() {
        return Err(CommandError::from(format!(
            "hub CLI unavailable (exit {}): {}",
            out.status.code().unwrap_or(-1),
            if !stderr.is_empty() { stderr } else { stdout }
        )));
    }
    Ok(json!({ "ok": true, "version": stdout }))
}

/// `hub_cli_check_update`: `npm view agent-comm-hub version` vs the local CLI version.
/// Returns { current, latest, outdated }.
#[tauri::command]
pub async fn hub_cli_check_update() -> CmdResult<Value> {
    let npm = if cfg!(windows) { "npm.cmd" } else { "npm" };
    let out = tokio::process::Command::new(npm)
        .args(["view", "agent-comm-hub", "version"])
        .output()
        .await
        .map_err(|e| CommandError::from(format!("npm view failed: {e}")))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let msg = if stderr.is_empty() {
            "network or npm issue".to_string()
        } else {
            stderr
        };
        return Err(CommandError::from(format!(
            "check update failed (exit {}): {}",
            out.status.code().unwrap_or(-1),
            msg
        )));
    }
    let latest = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let mut current = String::new();
    let mut cmd = hub_cli_command(&["--version"]);
    if let Ok(out) = cmd.output().await {
        if out.status.success() {
            current = String::from_utf8_lossy(&out.stdout).trim().to_string();
        }
    }
    let outdated = !current.is_empty() && !latest.is_empty() && current != latest;
    Ok(json!({
        "ok": true,
        "current": current,
        "latest": latest,
        "outdated": outdated,
    }))
}

/// `hub_cli_update`: `agent-comm-hub update` (internally reinstalls the global npm package; slow).
/// 180s timeout; the output is shown back to the frontend.
#[tauri::command]
pub async fn hub_cli_update() -> CmdResult<Value> {
    let mut cmd = hub_cli_command(&["update"]);
    let out = tokio::time::timeout(Duration::from_secs(180), cmd.output())
        .await
        .map_err(|_| CommandError::from("hub update timed out (180s)".to_string()))?
        .map_err(|e| CommandError::from(format!("failed to invoke hub update: {e}")))?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if !out.status.success() {
        return Err(CommandError::from(format!(
            "hub update failed (exit {}): {}",
            out.status.code().unwrap_or(-1),
            if !stderr.is_empty() { stderr } else { stdout }
        )));
    }
    let output = if !stdout.is_empty() { stdout } else { stderr };
    Ok(json!({ "ok": true, "output": output }))
}

/// `hub_cli_install`: `npm install -g agent-comm-hub` (first install; 180s timeout).
#[tauri::command]
pub async fn hub_cli_install() -> CmdResult<Value> {
    let npm = if cfg!(windows) { "npm.cmd" } else { "npm" };
    let out = tokio::time::timeout(
        Duration::from_secs(180),
        tokio::process::Command::new(npm)
            .args(["install", "-g", "agent-comm-hub"])
            .output(),
    )
    .await
    .map_err(|_| CommandError::from("hub install timed out (180s)".to_string()))?
    .map_err(|e| CommandError::from(format!("failed to invoke npm install: {e}")))?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if !out.status.success() {
        return Err(CommandError::from(format!(
            "hub install failed (exit {}): {}",
            out.status.code().unwrap_or(-1),
            if !stderr.is_empty() { stderr } else { stdout }
        )));
    }
    let output = if !stdout.is_empty() { stdout } else { stderr };
    Ok(json!({ "ok": true, "output": output }))
}

/// `hub_cli_setup`: `agent-comm-hub setup` — detects the local agents (MiniMax Code / Claude
/// Code / opencode / Codex / DSH etc.), installs the matching SKILL.md and writes the MCP config
/// (only touches the `agent-hub` key, backups first, idempotent). 120s timeout.
#[tauri::command]
pub async fn hub_cli_setup() -> CmdResult<Value> {
    let mut cmd = hub_cli_command(&["setup"]);
    let out = tokio::time::timeout(Duration::from_secs(120), cmd.output())
        .await
        .map_err(|_| CommandError::from("setup timed out (120s)".to_string()))?
        .map_err(|e| CommandError::from(format!("failed to invoke setup: {e}")))?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if !out.status.success() {
        return Err(CommandError::from(format!(
            "setup failed (exit {}): {}",
            out.status.code().unwrap_or(-1),
            if !stderr.is_empty() { stderr } else { stdout }
        )));
    }
    let output = if !stdout.is_empty() { stdout } else { stderr };
    Ok(json!({ "ok": true, "output": output }))
}

// -------- Config (T-2.5) --------

/// Returns the 12 hub spawn config items + the connection-level `auth_token`
/// (read back from SQLite; never part of HubConfig).
#[tauri::command]
pub async fn config_get(state: State<'_, AppState>) -> CmdResult<Value> {
    let cfg = state.hub.config();
    let mut out = serde_json::Map::new();
    out.insert("host".into(), json!(cfg.host));
    out.insert("port".into(), json!(cfg.port));
    out.insert("path".into(), json!(cfg.path));
    out.insert("max_queue".into(), json!(cfg.max_queue));
    out.insert("history_limit".into(), json!(cfg.history_limit));
    out.insert("wait_timeout_ms".into(), json!(cfg.wait_timeout_ms));
    out.insert("default_wait_ms".into(), json!(cfg.default_wait_ms));
    out.insert("connected_window_ms".into(), json!(cfg.connected_window_ms));
    out.insert("peer_idle_timeout_ms".into(), json!(cfg.peer_idle_timeout_ms));
    out.insert(
        "herdr_bin".into(),
        json!(cfg.herdr_bin.clone().unwrap_or_default()),
    );
    out.insert(
        "herdr_timeout_ms".into(),
        json!(cfg.herdr_timeout_ms.unwrap_or(30_000)),
    );
    // auth_token is connection-level (see ensure_mcp_initialized): read it back
    // from SQLite rather than HubConfig so the settings panel round-trips it.
    let auth_token = state
        .store
        .get_config("auth_token")
        .ok()
        .flatten()
        .map(|r| r.value)
        .unwrap_or_default();
    out.insert("auth_token".into(), json!(auth_token));
    Ok(Value::Object(out))
}

/// Save config to SQLite (overwrite). Takes effect after the hub restarts.
#[tauri::command]
pub async fn config_set(
    state: State<'_, AppState>,
    values: Value,
) -> CmdResult<()> {
    let obj = values
        .as_object()
        .ok_or_else(|| CommandError::from("values must be an object".to_string()))?;
    let now = now_ms();
    for (k, v) in obj {
        let val = match v {
            Value::String(s) => s.clone(),
            Value::Number(n) => n.to_string(),
            Value::Bool(b) => b.to_string(),
            Value::Null => String::new(),
            _ => v.to_string(),
        };
        if let Err(e) = state.store.set_config(k, &val, now) {
            return Err(CommandError::from(format!("set_config({k}) failed: {e}")));
        }
    }
    Ok(())
}

/// Restart the hub; rebuild the HubConfig from the SQLite config table before restarting
/// (keys same as config_get), so the values saved in the settings panel take effect
/// (missing keys keep defaults). bin stays runtime-resolved.
/// Note: an external hub (not spawned by this app) still can't be restarted by this app — in
/// that case the user must stop the external process themselves; on the next app startup the
/// saved values are used to probe/launch it.
#[tauri::command]
pub async fn hub_restart_with_saved_config(
    state: State<'_, AppState>,
) -> CmdResult<HubStatus> {
    let mut cfg = HubConfig::default();
    apply_saved_config(&mut cfg, &state.store);
    state.hub.set_config(cfg);
    wrap(state.hub.restart().await)?;
    *state.mcp.write().await = None;
    let status = state.hub.status().await;
    if let Some(app) = state.hub.app_handle().await {
        ensure_mcp_initialized(&app, &state, &status).await;
    }
    Ok(status)
}

// -------- Unread counts (T-2.7, frontend store-driven; here only expose the SQLite-persistence helper RPC) --------

#[tauri::command]
pub async fn unread_list(state: State<'_, AppState>) -> CmdResult<Vec<UnreadRecord>> {
    wrap(state.store.list_unread())
}

#[tauri::command]
pub async fn unread_clear(
    state: State<'_, AppState>,
    peer_id: String,
) -> CmdResult<()> {
    wrap(state.store.clear_unread(&peer_id, now_ms()))
}

// -------- herdr's 11 tools (T-2.8 / T-2.9) --------
//
// Every herdr command goes directly through the local herdr CLI (path resolved from HubConfig.herdr_bin, default 'herdr').
// When herdr isn't installed, return a graceful error and the frontend banner prompts the user.
// Note: the herdr_controlPeers gating is controlled by the frontend UI (settings panel); not enforced here.

async fn make_herdr(config: &HubConfig) -> HerdrCtl {
    let mut c = HerdrCtl::new(config.herdr_bin.clone().unwrap_or_else(|| "herdr".into()));
    if let Some(ms) = config.herdr_timeout_ms {
        c = c.with_default_timeout(ms as u64);
    }
    c
}

fn herdr_error_to_command_error(e: crate::herdr_client::HerdrError) -> CommandError {
    CommandError::from(e.to_string())
}

#[tauri::command]
pub async fn herdr_is_available(state: State<'_, AppState>) -> CmdResult<bool> {
    let h = make_herdr(&state.hub.config()).await;
    Ok(h.is_available().await)
}

#[tauri::command]
pub async fn herdr_agent_list(state: State<'_, AppState>) -> CmdResult<Vec<HerdrAgent>> {
    let h = make_herdr(&state.hub.config()).await;
    h.agent_list().await.map_err(herdr_error_to_command_error)
}

#[tauri::command]
pub async fn herdr_agent_status(
    state: State<'_, AppState>,
    target: String,
) -> CmdResult<HerdrAgent> {
    let h = make_herdr(&state.hub.config()).await;
    h.agent_status(&target).await.map_err(herdr_error_to_command_error)
}

#[tauri::command]
pub async fn herdr_agent_prompt(
    state: State<'_, AppState>,
    target: String,
    text: String,
    wait: bool,
    until: Option<String>,
    timeout_ms: Option<u32>,
) -> CmdResult<Option<HerdrSettled>> {
    let h = make_herdr(&state.hub.config()).await;
    h.agent_prompt(&target, &text, wait, until.as_deref(), timeout_ms)
        .await
        .map_err(herdr_error_to_command_error)
}

#[tauri::command]
pub async fn herdr_agent_wait(
    state: State<'_, AppState>,
    target: String,
    until: Option<String>,
    timeout_ms: Option<u32>,
) -> CmdResult<Option<HerdrSettled>> {
    let h = make_herdr(&state.hub.config()).await;
    h.agent_wait(&target, until.as_deref(), timeout_ms)
        .await
        .map_err(herdr_error_to_command_error)
}

#[tauri::command]
pub async fn herdr_agent_read(
    state: State<'_, AppState>,
    target: String,
    lines: Option<u32>,
) -> CmdResult<HerdrRead> {
    let h = make_herdr(&state.hub.config()).await;
    h.agent_read(&target, lines).await.map_err(herdr_error_to_command_error)
}

#[tauri::command]
pub async fn herdr_agent_keys(
    state: State<'_, AppState>,
    target: String,
    keys: Vec<String>,
) -> CmdResult<()> {
    let h = make_herdr(&state.hub.config()).await;
    h.agent_keys(&target, &keys).await.map_err(herdr_error_to_command_error)
}

#[tauri::command]
pub async fn herdr_pane_list(state: State<'_, AppState>) -> CmdResult<Vec<HerdrPane>> {
    let h = make_herdr(&state.hub.config()).await;
    h.pane_list().await.map_err(herdr_error_to_command_error)
}

#[tauri::command]
pub async fn herdr_pane_send_text(
    state: State<'_, AppState>,
    target: String,
    text: String,
) -> CmdResult<()> {
    let h = make_herdr(&state.hub.config()).await;
    h.pane_send_text(&target, &text)
        .await
        .map_err(herdr_error_to_command_error)
}

#[tauri::command]
pub async fn herdr_pane_send_keys(
    state: State<'_, AppState>,
    target: String,
    keys: Vec<String>,
) -> CmdResult<()> {
    let h = make_herdr(&state.hub.config()).await;
    h.pane_send_keys(&target, &keys)
        .await
        .map_err(herdr_error_to_command_error)
}

#[tauri::command]
pub async fn herdr_pane_read(
    state: State<'_, AppState>,
    target: String,
    lines: Option<u32>,
) -> CmdResult<HerdrRead> {
    let h = make_herdr(&state.hub.config()).await;
    h.pane_read(&target, lines).await.map_err(herdr_error_to_command_error)
}

#[tauri::command]
pub async fn herdr_pane_wait_for_output(
    state: State<'_, AppState>,
    target: String,
    match_type: String,
    match_value: String,
    timeout_ms: Option<u32>,
) -> CmdResult<Option<HerdrRead>> {
    let h = make_herdr(&state.hub.config()).await;
    h.pane_wait_for_output(&target, &match_type, &match_value, timeout_ms)
        .await
        .map_err(herdr_error_to_command_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Saved hub settings must really be applied: SQLite config rows override defaults, invalid
    /// / missing keys keep defaults. Regression background: config_set only wrote to the DB while
    /// the restart still used in-memory defaults, so settings-panel changes never took effect
    /// (verified by the user).
    #[test]
    fn apply_saved_config_overrides_defaults_and_tolerates_garbage() {
        let store = Store::open_in_memory().expect("store");
        let now = 1_000;
        store.set_config("port", "18801", now).unwrap();
        store.set_config("history_limit", "2000", now).unwrap();
        store.set_config("herdr_bin", "C:/tools/herdr.exe", now).unwrap();
        store.set_config("herdr_timeout_ms", "not-a-number", now).unwrap();
        store.set_config("path", "", now).unwrap(); // empty value keeps the default

        let mut cfg = HubConfig::default();
        apply_saved_config(&mut cfg, &store);
        assert_eq!(cfg.port, 18801);
        assert_eq!(cfg.history_limit, 2000);
        assert_eq!(cfg.herdr_bin.as_deref(), Some("C:/tools/herdr.exe"));
        assert_eq!(cfg.herdr_timeout_ms, None); // invalid value keeps the default (None → 30000 semantics)
        assert_eq!(cfg.path, "/mcp");
        assert_eq!(cfg.max_queue, 200);

        // empty DB = all defaults
        let empty = Store::open_in_memory().expect("store");
        let mut cfg2 = HubConfig::default();
        apply_saved_config(&mut cfg2, &empty);
        assert_eq!(cfg2.port, 18764);
        assert_eq!(cfg2.max_queue, 200);
    }

    /// Regression test: the hub's tools/call success envelope must unwrap into the bridge tool's
    /// real return. Previously passing it through verbatim left `result.peers` / `result.messages`
    /// undefined, crashing PeersView (`Cannot read properties of undefined (reading 'length')`).
    #[test]
    fn unwrap_tool_result_extracts_content_json() {
        let envelope = json!({
            "content": [{ "type": "text", "text": "{\"peers\":[{\"id\":\"agent\",\"connected\":true}]}" }],
            "isError": false
        });
        let parsed = unwrap_tool_result(envelope).expect("success envelope unwraps");
        assert_eq!(parsed["peers"][0]["id"], "agent");
        assert_eq!(parsed["peers"][0]["connected"], true);
    }

    /// Hub error envelope (isError: true, text is {"error": "..."}) → Err with a clean message.
    #[test]
    fn unwrap_tool_result_error_envelope_becomes_err() {
        let envelope = json!({
            "content": [{ "type": "text", "text": "{\"error\":\"not registered\"}" }],
            "isError": true
        });
        let err = unwrap_tool_result(envelope).expect_err("error envelope is Err");
        assert!(err.error.contains("not registered"), "got: {}", err.error);
        assert!(!err.error.contains('{'), "error should be plain text: {}", err.error);
    }

    /// An odd shape without content/text passes through verbatim (backward compatible, doesn't crash the UI).
    #[test]
    fn unwrap_tool_result_passthrough_odd_shape() {
        let odd = json!({ "foo": 1 });
        let out = unwrap_tool_result(odd.clone()).expect("odd shape passes through");
        assert_eq!(out, odd);
    }

    /// Non-JSON text content is returned verbatim as a string.
    #[test]
    fn unwrap_tool_result_plain_text_content() {
        let envelope = json!({
            "content": [{ "type": "text", "text": "just a line" }],
            "isError": false
        });
        let out = unwrap_tool_result(envelope).expect("plain text unwraps");
        assert_eq!(out, json!("just a line"));
    }

    /// Peers snapshot persisted: alias/clientVersion written when present, old values kept when
    /// absent (COALESCE), malformed rows (missing id) skipped without panicking.
    #[test]
    fn sync_roster_to_store_upserts_and_tolerates_malformed_rows() {
        let store = Store::open_in_memory().unwrap();
        let kicked: KickedPeers = Arc::new(std::sync::Mutex::new(HashSet::new()));
        store
            .upsert_peer(&PeerRecord {
                peer_id: "a".into(),
                last_seen: 1,
                online: false,
                client_name: None,
                alias: Some("keep-me".into()),
                client_version: Some("1.0".into()),
                created_at: 1,
            })
            .unwrap();
        sync_roster_to_store(
            &store,
            &kicked,
            &[
                json!({ "id": "a", "connected": true, "lastSeenMs": 42 }),
                json!({ "connected": true }), // missing id: skip
                json!({ "id": "b", "connected": false, "alias": "B", "clientVersion": "2.0" }),
            ],
        );
        let peers = store.list_peers().unwrap();
        let a = peers.iter().find(|p| p.peer_id == "a").unwrap();
        assert!(a.online);
        assert_eq!(a.last_seen, 42);
        assert_eq!(a.alias.as_deref(), Some("keep-me")); // default keeps the old value
        assert_eq!(a.client_version.as_deref(), Some("1.0"));
        let b = peers.iter().find(|p| p.peer_id == "b").unwrap();
        assert_eq!(b.alias.as_deref(), Some("B"));
        assert_eq!(b.client_version.as_deref(), Some("2.0"));
    }

    /// P3-2 race: an id in the suppression set isn't resurrected by an in-flight snapshot — the
    /// first sight only lifts the suppression; only a later roster still containing that id
    /// (re-registered) is persisted.
    #[test]
    fn sync_roster_suppresses_kicked_peer_until_next_roster() {
        let store = Store::open_in_memory().unwrap();
        let kicked: KickedPeers =
            Arc::new(std::sync::Mutex::new(std::iter::once("x".to_string()).collect()));
        let roster = [json!({ "id": "x", "connected": true })];
        // First roster containing x to arrive after a kick: lift the suppression but don't resurrect the kicked row
        sync_roster_to_store(&store, &kicked, &roster);
        assert!(
            store.list_peers().unwrap().iter().all(|p| p.peer_id != "x"),
            "suppressed peer must not be resurrected by an in-flight snapshot"
        );
        assert!(!kicked.lock().unwrap().contains("x"), "suppression lifts on first sight");
        // Later roster (x re-registered, still listed by the hub): persists normally
        sync_roster_to_store(&store, &kicked, &roster);
        assert!(store.list_peers().unwrap().iter().any(|p| p.peer_id == "x"));
    }

    /// Key shapes of SSE notification parsing (the same defensive accessors as in the consume loop):
    /// peers_changed / message each read what they need; missing fields return empty/None rather than panic.
    #[test]
    fn notification_data_shape_extraction() {
        let peers_changed = json!({
            "method": "notifications/message",
            "params": { "level": "info", "logger": "bridge",
                        "data": { "event": "peers_changed", "peers": [{ "id": "x" }] } }
        });
        let data = peers_changed.pointer("/params/data").unwrap();
        assert_eq!(data["event"], "peers_changed");
        assert_eq!(data["peers"].as_array().unwrap().len(), 1);

        let message = json!({
            "method": "notifications/message",
            "params": { "data": { "event": "message", "message": { "id": "m1" } } }
        });
        assert_eq!(message.pointer("/params/data/message/id").unwrap(), "m1");

        // Legacy assumption of params.message (the hub never sent it): the new parsing can't find the data branch
        let legacy = json!({ "method": "notifications/message", "params": { "message": {} } });
        assert!(legacy.pointer("/params/data").is_none());
    }
}