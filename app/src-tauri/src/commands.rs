//! Tauri commands（前端 invoke 的入口）。
//!
//! 所有 Hub 进程 + bridge 工具 + SQLite 配置的 RPC 都通过这里暴露。
//! 前端调用 `invoke('hub_start')` / `invoke('bridge_peers')` / `invoke('config_get')` 等。

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

/// 被踢 peer 的本地抑制集（P3-2 竞态防御，语义见 sync_roster_to_store）。
/// 临界区是常数级集合操作，用 std Mutex 即可，不需要 async 锁。
pub(crate) type KickedPeers = Arc<std::sync::Mutex<HashSet<String>>>;

/// 把 SQLite config 表里保存的 hub 设置套到一个 HubConfig 上（缺省键/无法
/// 解析的值保留 base 值）。这是设置面板真正生效的唯一通路 —— 此前 config_set
/// 只写库、重启用的还是内存默认值，保存过的设置从不生效（用户实测）。
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
    // 数值键统一 u32（port 是 u16，单独解析）；非法值保留默认。
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

/// 本端（桌面 GUI）在 hub 里的 peer id —— hub 默认管理端（managerPeers）。
/// clientInfo.name 即此 id（hub 按名字 auto-register，同名连接 N:1 attach）。
/// 前端 src/lib/self.ts 的 SELF_PEER_ID 与这里保持一致。
pub(crate) const SELF_PEER_ID: &str = "agent-hub-cli";

/// Tauri 全局状态：单例 HubProcess + 懒初始化的 McpClient + SQLite store。
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

/// 把命令错误序列化（前端拿到 `{ ok: false, error: "..." }`）。
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

/// 解包 hub 的 tools/call result（MCP 信封）。
///
/// hub 端（src/mcp-server.ts `tools/call`）对**所有**工具统一返回
/// `{ content: [{ type: 'text', text: '<JSON>' }], isError: bool }`，包括
/// bridge_chat 的 receipt —— 没有特例。原样透传会导致前端
/// `result.peers` / `result.messages` / `result.ok` 全是 undefined
/// （曾造成 PeersView 崩溃：`Cannot read properties of undefined (reading 'length')`）。
/// 这里做唯一一次解包：
/// - `isError: true` → Err（text 即错误信息，前端走 catch 显示）
/// - 否则提取 `content[0].text` 并 JSON.parse（hub 端 lossless JSON 契约）
/// - 无 content/text 的怪形状原样透传（向前兼容，不把 UI 打崩）
fn unwrap_tool_result(value: Value) -> CmdResult<Value> {
    if value.get("isError").and_then(Value::as_bool).unwrap_or(false) {
        // hub 错误信封的 text 是 `{"error": "..."}`（mcp-server.ts tools/call catch 分支），
        // 提取 .error 让前端拿到干净的错误信息而不是一坨 JSON。
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
            Err(_) => Ok(json!(text)), // 非 JSON 文本：原样作为字符串返回
        };
    }
    Ok(value)
}

/// 取出 mcp client；若未初始化（hub 没在跑）则返回 NotConnected 错误。
/// 懒重连（PRD F-08 最小版）：hub 处于 Running 但 mcp 缺失时（app 启动时外部 hub
/// 已存在、或 hub 崩溃后被外部进程重启），尝试重建连接再返回；失败仍给明确错误。
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

/// tools_call + 解包 + 连接失效自愈。
///
/// 连接类错误（Http / NotConnected）说明 hub 不可达（典型场景：外部 hub 被杀但
/// app 还持有旧 mcp client 引用 → 轮询永久报 `http: error sending request`）。
/// 此时清掉 mcp 引用，下次调用走 require_mcp 的懒重连（hub Running 时自动重建）；
/// hub 真死了则返回清晰错误，前端可见。
async fn tools_call_checked(state: &AppState, name: &str, args: Value) -> CmdResult<Value> {
    let mcp = require_mcp(state).await?;
    match mcp.tools_call(name, args).await {
        Ok(raw) => unwrap_tool_result(raw),
        Err(e) => {
            if matches!(e, McpError::Http(_) | McpError::NotConnected) {
                *state.mcp.write().await = None;
                log::warn!("bridge_{name} 连接失败，已清除 mcp 引用等待懒重连: {e}");
            }
            Err(CommandError::from(e.to_string()))
        }
    }
}

// -------- Hub 进程命令 --------

#[tauri::command]
pub async fn hub_start(state: State<'_, AppState>) -> CmdResult<HubStatus> {
    wrap(state.hub.start().await)?;
    let status = state.hub.status().await;
    // hub 端口就绪后初始化 MCP 客户端 + 注册 agent-hub-cli peer
    if let Some(app) = state.hub.app_handle().await {
        ensure_mcp_initialized(&app, &state, &status).await;
    }
    Ok(status)
}

#[tauri::command]
pub async fn hub_stop(state: State<'_, AppState>) -> CmdResult<HubStatus> {
    wrap(state.hub.stop().await)?;
    // 关闭后清掉 mcp 引用，下次 start 时重新 initialize
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

/// 前端在加载完成后调用一次：通知后端"前端已就绪"，触发 hub 自动 start + MCP 初始化。
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

/// `quit_app`：彻底退出程序（含托盘）。关闭按钮 modal 的"退出程序"选项调用；
/// 与托盘菜单"退出"（app.exit(0)）同一语义。
#[tauri::command]
pub async fn quit_app(app: AppHandle) -> CmdResult<()> {
    app.exit(0);
    Ok(())
}

/// 在 hub Running 后建一个 McpClient、initialize、显式注册 agent-hub-cli peer，
/// 然后开 SSE 长连接保持长在线 (hub 端 `bridge_peers` 把有 SSE channel 的 session
/// 视为 connected,这是 CLI 端 `bridge_wait` long-poll 之外保持活跃的另一种方式)。
///
/// 失败只 log warn,不返回错误（保证 UI 仍可用）。
async fn ensure_mcp_initialized(app: &AppHandle, state: &AppState, _status: &HubStatus) {
    if state.mcp.read().await.is_some() {
        return; // 已初始化
    }
    let cfg = state.hub.config();
    // clientInfo.name 直接就是目标 peer id：hub 对同名连接做 N:1 attach（不会
    // 重复注册、不会 "peer already registered"）。历史上用 "agent-comm-hub-cli"
    // + 显式 bridge_register("agent-hub-cli") 改名 —— 懒重连产生第二个 session
    // 时 rename 冲突失败，导致 agent-comm-hub-cli / agent-hub-cli 双 peer 并存、
    // 每次初始化都重复打 peer joined 日志。
    let client = Arc::new(McpClient::new(
        &cfg.host,
        cfg.port,
        &cfg.path,
        ClientInfo::new(SELF_PEER_ID, env!("CARGO_PKG_VERSION")),
    ));
    // 端口就绪 ≠ hub 完全 ready：initialize 可能撞上启动竞态（尤其 npx 冷下载 /
    // 端口刚释放的场景），重试 15 次 × 1s（15s 窗口）后再放弃（失败只 log，UI 仍可用）。
    let mut last_err: Option<McpError> = None;
    for attempt in 1..=15 {
        match client.initialize().await {
            Ok(_) => {
                last_err = None;
                break;
            }
            Err(e) => {
                log::warn!("MCP initialize 第 {attempt}/15 次失败，1s 后重试: {e}");
                last_err = Some(e);
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    }
    if let Some(e) = last_err {
        log::warn!("MCP initialize 重试 15 次均失败: {e}; agent-hub-cli 将不可用");
        return;
    }
    // 显式 bridge_register "agent-hub-cli"（auto-register 时 hub 已用 clientInfo.name
    // sanitize 成同名 peer；显式 register 是冗余但 idempotent,确保连接语义）。
    if let Err(e) = client
        .tools_call("bridge_register", json!({ "peerId": SELF_PEER_ID }))
        .await
    {
        log::warn!("bridge_register {SELF_PEER_ID} 失败: {e}");
    }

    // 开 SSE 长连接保活 —— 这是"CLI 一启动就一直保持长连接"在 MCP 设计里的正确玩法。
    // 单条 GET /mcp (Accept: text/event-stream) 在 hub 端 markSseOpen(sessionId),
    // 之后只要这条 SSE 不被客户端关闭, hub 的 `livePeers` 集合就一直包含
    // agent-hub-cli 这一行, `bridge_peers` 会报 connected=true,跟 `bridge_wait`
    // long-poll 是同等地位 (只不过 bridge_wait 走 POST + 队列等待)。
    //
    // hub 在这条 SSE 上推 JSON-RPC 通知 `{method:"notifications/message",
    // params:{level,logger,data}}`，data 按事件分支（hub ≥ 0.6 协议契约）：
    // - `{event:"peers_changed", peers:[完整花名册]}` → 落库 SQLite + emit `hub:peers`
    //   （前端花名册主通道，任何 peer 上下线/改名都会推）
    // - `{event:"message", message:{BridgeMessage, content 已解码}}` → emit `hub:message`
    // 解析全程防御：字段缺失只记 debug 日志，绝不 panic（通知是尽力而为的旁路）。
    match client.subscribe_notifications().await {
        Ok(mut rx) => {
            let app = app.clone();
            let store = state.store.clone();
            let kicked = state.kicked.clone();
            tokio::spawn(async move {
                while let Some(notif) = rx.recv().await {
                    let method = notif.get("method").and_then(|v| v.as_str()).unwrap_or("");
                    if method == "notifications/message" {
                        let data = notif.pointer("/params/data");
                        match data.and_then(|d| d.get("event")).and_then(Value::as_str) {
                            Some("peers_changed") => {
                                match data.and_then(|d| d.get("peers")).and_then(Value::as_array) {
                                    Some(peers) => {
                                        sync_roster_to_store(&store, &kicked, peers);
                                        let _ = app.emit("hub:peers", peers);
                                    }
                                    // 缺 peers 字段直接跳过：emit 空数组会把前端名单清空。
                                    None => {
                                        log::debug!("SSE peers_changed 缺 data.peers 字段，忽略");
                                    }
                                }
                            }
                            Some("message") => match data.and_then(|d| d.get("message")) {
                                Some(msg) => {
                                    let _ = app.emit("hub:message", msg);
                                }
                                None => {
                                    log::debug!("SSE message 通知缺 data.message 字段，忽略");
                                }
                            },
                            // 旧协议假设 params.message（hub 从未发过）已废弃；
                            // 未知形状一律走 debug，不往 UI 打扰。
                            other => {
                                log::debug!("SSE notifications/message data.event={other:?}");
                            }
                        }
                    } else if !method.is_empty() {
                        log::debug!("SSE notification: {method}");
                    }
                }
                log::info!("SSE notifications 接收端自然关闭 (channel dropped by hub)");
            });
        }
        Err(e) => {
            log::warn!("subscribe_notifications 失败: {e}; agent-hub-cli 30s 后会变 offline");
        }
    }
    *state.mcp.write().await = Some(client);
}

/// 把 hub 的 peers 快照（bridge_peers 结果 / peers_changed 事件里的数组）落库 SQLite。
///
/// id 缺失的畸形行跳过；lastSeenMs 缺省回退当前时间；alias/clientName/clientVersion
/// 缺省保留旧值（COALESCE，见 upsert_peer：旧版 hub 根本不回传这些字段，被动快照
/// 不应清空本地已知信息；显式清别名走 bridge_rename 权威同步 set_peer_alias）。
///
/// P3-2 踢人在途快照竞态：kick 早于某快照生成、delete 却先于该快照被消费时，
/// 直接 upsert 会把被踢行"复活"。kick 时把 id 加入抑制集；sync 遇到被抑制 id 的
/// 第一次出现**只解除抑制、跳过 upsert**（这次快照可能就是在途的旧数据），
/// 此后的 roster 再包含该 id（hub 持续列出 = 已重新注册）才正常落库。
fn sync_roster_to_store(store: &Store, kicked: &KickedPeers, peers: &[Value]) {
    let now = now_ms();
    for p in peers {
        let Some(id) = p.get("id").and_then(Value::as_str) else {
            continue;
        };
        {
            let mut suppress = kicked.lock().unwrap_or_else(|po| po.into_inner());
            if suppress.remove(id) {
                log::debug!("roster 跳过被抑制（刚被踢）的 peer {id}，仅解除抑制");
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

// -------- 花名册管理（rename / kick / 本地 roster） --------

/// `bridge_rename`：改别名 / 改路由 id。alias trim 后 1-64 字符、不得含控制
/// 字符（hub 校验）；空串/纯空白 = 清除别名。不传 peer = 改自己；传 peer =
/// 管理端改别人（本端 agent-hub-cli 是 hub 默认管理端，恒有权限；hub 拒绝时
/// 错误透传前端）。new_peer_id = 管理端真改名（re-key）：hub 原子迁移该 peer
/// 的邮箱、等待器、session 绑定与历史归属，必须配合显式 peer。
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
    // id re-key：previousId 存在 = 路由 id 变了，旧 id 的本地行整体作废删除；
    // 别名/元数据由下一帧 roster 快照按新 id 重建（re-key 时 profile 连同
    // alias 一起迁移，下方同步逻辑会把 alias 写到新 id 行）。
    if let Some(prev) = result.get("previousId").and_then(Value::as_str) {
        if let Err(e) = state.store.delete_peer(prev) {
            log::warn!("re-key 后删除旧 id 本地行失败 ({prev}): {e}");
        }
    }
    // rename 结果是别名的唯一权威来源（快照缺省有二义，见 set_peer_alias）：
    // 结果带 alias → 写入；缺省（已清除）→ 落 NULL。
    if let (Some(id), Some(alias_out)) = (
        result.get("peerId").and_then(Value::as_str),
        result.get("alias").and_then(Value::as_str),
    ) {
        if let Err(e) = state.store.set_peer_alias(id, Some(alias_out)) {
            log::warn!("rename 后同步本地 alias 失败 ({id}): {e}");
        }
    } else if let Some(id) = result.get("peerId").and_then(Value::as_str) {
        if let Err(e) = state.store.set_peer_alias(id, None) {
            log::warn!("rename 后清除本地 alias 失败 ({id}): {e}");
        }
    }
    Ok(result)
}

/// `bridge_unregister_peer`：管理端踢人（hub bridge_unregister 带 peer 参数）。
/// kicked=true 时目标已从 hub 移除 —— 同步删本地 roster 行，并把它加入抑制集，
/// 防止在途的旧快照把被踢行复活（见 sync_roster_to_store）。
#[tauri::command]
pub async fn bridge_unregister_peer(
    state: State<'_, AppState>,
    peer: String,
) -> CmdResult<Value> {
    let result = tools_call_checked(&state, "bridge_unregister", json!({ "peer": peer })).await?;
    if result.get("kicked").and_then(Value::as_bool).unwrap_or(false) {
        if let Err(e) = state.store.delete_peer(&peer) {
            log::warn!("踢人后删除本地 roster 行失败 ({peer}): {e}");
        }
        state
            .kicked
            .lock()
            .unwrap_or_else(|po| po.into_inner())
            .insert(peer);
    }
    Ok(result)
}

/// `roster_forget`：仅删除本地 SQLite roster 行（不动 hub）—— offline·known
/// 行没有 hub 侧对应物，没有这个入口本地花名册只增不减。
#[tauri::command]
pub async fn roster_forget(state: State<'_, AppState>, peer_id: String) -> CmdResult<()> {
    wrap(state.store.delete_peer(&peer_id))
}

/// `roster_list`：SQLite 全部 peer 行（含 offline 已知 peer），前端启动时
/// 用它恢复重启前的花名册；实时快照（bridge_peers / hub:peers）优先。
#[tauri::command]
pub async fn roster_list(state: State<'_, AppState>) -> CmdResult<Vec<PeerRecord>> {
    wrap(state.store.list_peers())
}

// -------- bridge_* 通用入口（MCP 透传） --------

/// `bridge_peers`：列出当前 hub 上的所有 peer，并把快照旁路落库 SQLite
/// （roster_list 据此恢复重启前的完整花名册，含 offline 已知 peer）。
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

/// `bridge_wait`：长轮询等下一条消息（前端消息流持续监听的核心 —— 此前遗漏，
/// 导致 UI 收不到其他 peer 的回复；hub 的 history 只在 waiter/poll 命中时记录）。
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

/// `bridge_history`：拉取某 peer（或自己）的最近消息，同时把消息同步写入 SQLite。
/// 前端默认轮询 3s 拉一次；写入 SQLite 保证重启后历史可恢复。
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

    // 把拉到的消息同步到 SQLite（M2 T-2.6 持久化）。
    // unwrap_tool_result 之后 result 已是 hub 的 `{messages: [...]}`（lossless JSON）。
    if let Some(msgs) = result.get("messages").and_then(|m| m.as_array()) {
        let now = now_ms();
        for m in msgs {
            if let Some(rec) = json_to_message_record(m, now) {
                if let Err(e) = state.store.insert_message(&rec) {
                    log::warn!("insert_message 失败: {e}");
                }
            }
        }
    }

    Ok(result)
}

/// `history_local`：从 SQLite 恢复历史消息（SPEC F-09"启动恢复上下文"）。
///
/// hub 的 historyRing 是内存环形缓冲（上限 historyLimit，且 hub 重启即清空）；
/// 每次 bridge_history 拉取时消息已旁路写入 SQLite。前端启动时调用本命令
/// 填充初始消息流，hub 侧轮询随后合并（同 id 去重，本地消息保留）。
/// content 字段是完整消息 JSON 字符串（json_to_message_record 的写入格式），
/// 前端解析还原 PresentedMessage。
#[tauri::command]
pub async fn history_local(
    state: State<'_, AppState>,
    peer: Option<String>,
    limit: Option<u32>,
) -> CmdResult<Value> {
    let limit = limit.unwrap_or(100).min(1000) as i64;
    // 兼容旧身份：改名修复前 app 以 agent-comm-hub-cli 注册（rename 冲突），
    // 那时的消息 involved_me 判定与 from/to 都不匹配 agent-hub-cli —— 两个
    // 身份都查，合并去重。
    let identities = match peer {
        Some(p) => vec![p],
        // 兼容旧身份 'agent-comm-hub-cli'：改名修复前 app 的注册身份，两个都查。
        None => vec![SELF_PEER_ID.to_string(), "agent-comm-hub-cli".to_string()],
    };
    let mut all: Vec<MessageRecord> = Vec::new();
    for id in &identities {
        match state.store.list_messages_for_peer(id, limit) {
            Ok(rs) => all.extend(rs),
            Err(e) => log::warn!("history_local 查询 {id} 失败: {e}"),
        }
    }
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

/// 把 MCP 返回的 message JSON 转成 SQLite record（content 字段保留为 JSON 字符串）。
fn json_to_message_record(v: &Value, _now: i64) -> Option<MessageRecord> {
    Some(MessageRecord {
        id: v.get("id")?.as_str()?.to_string(),
        from_peer: v.get("from")?.as_str()?.to_string(),
        to_peer: v.get("to")?.as_str()?.to_string(),
        kind: v.get("kind")?.as_str()?.to_string(),
        content: v.to_string(), // 整个 message 序列化为 JSON 字符串
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

/// `bridge_chat`：发一条 chat 给指定 peer。
/// 返回 receipt（hub 端同样走 MCP content 包装，这里统一 unwrap）。
/// 发送成功后把 receipt 消息写入 SQLite（乐观消息持久化）。
/// hub 的 history 只在 waiter/poll 命中时记录，而 bridge_history 写入 SQLite 的
/// 是"拉到"的消息 —— 发送后若无人消费，这条消息既不在 hub history 也不会被
/// 拉取写入，重启即丢。这里在发送路径直接落盘。
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
        log::warn!("persist_receipt 失败: {e}");
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

/// `bridge_task`：委派任务（参数更多）。M2 T-2.5 接入；先暴露 tauri command 占位。
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

/// `bridge_ack`：ack 一条 task（或其他消息）。status: accepted/rejected/done/failed。
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

// -------- 开机自启（PRD F-13 / SPEC AC-9） --------

/// `service_install`：调 `agent-comm-hub service install`（Windows Run key /
/// Linux systemd / macOS launchd，主仓 ops.ts 实现），返回子进程输出。
#[tauri::command]
pub async fn service_install() -> CmdResult<Value> {
    run_service_cmd("install").await
}

/// `service_uninstall`：调 `agent-comm-hub service uninstall`。
#[tauri::command]
pub async fn service_uninstall() -> CmdResult<Value> {
    run_service_cmd("uninstall").await
}

/// 用与 hub spawn 相同的 CLI 定位（which_hub_launch）跑 `agent-comm-hub service <action>`。
/// 输出回前端展示；非零退出转 CommandError。
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

// -------- Hub 工具（版本 / 检查更新 / 更新，设置面板扩展） --------

/// `hub_cli_version`：`agent-comm-hub --version` —— 本地安装的 hub CLI 版本。
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

/// `hub_cli_check_update`：`npm view agent-comm-hub version` 对比本地 CLI 版本。
/// 返回 { current, latest, outdated }。
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

/// `hub_cli_update`：`agent-comm-hub update`（内部 npm 重装全局包，耗时）。
/// 180s 超时；输出回前端展示。
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

/// `hub_cli_install`：`npm install -g agent-comm-hub`（首次安装；180s 超时）。
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

/// `hub_cli_setup`：`agent-comm-hub setup` —— 检测本地 agent（MiniMax Code /
/// Claude Code / opencode / Codex / DSH 等），安装对应的 SKILL.md 并写入
/// MCP 配置（只动 `agent-hub` 键、备份先行、幂等）。120s 超时。
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

// -------- 配置（T-2.5） --------

/// 返回所有 12 项 hub 配置（key → value 字符串）。
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
    Ok(Value::Object(out))
}

/// 保存配置到 SQLite（覆盖式）。重启 hub 后生效。
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

/// 重启 hub；重启前从 SQLite config 表重建 HubConfig（键同 config_get），
/// 让设置面板保存的值真正生效（缺省键保留默认值）。bin 保持运行时解析。
/// 注意：外部 hub（非本 app spawn）仍无法由本 app 重启 —— 该场景下用户需
/// 自行停掉外部进程；应用下次启动时会按保存值探测/拉起。
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

// -------- 未读计数（T-2.7，前端 store 主导；此处仅暴露 SQLite 持久化的辅助 RPC） --------

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

// -------- herdr 11 个工具（T-2.8 / T-2.9） --------
//
// 所有 herdr 命令直接走本地 herdr CLI（路径解析 from HubConfig.herdr_bin，默认 'herdr'）。
// herdr 未安装时返回 graceful 错误，前端 banner 提示用户。
// 注意：herdr_controlPeers gating 由前端 UI 控制（设置面板），此处不强制。

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

    /// 保存的 hub 设置必须真正被应用：SQLite config 行覆盖默认值，非法/缺失
    /// 键保留默认。回归背景：config_set 只写库，重启用的还是内存默认值，
    /// 设置面板改动永远不生效（用户实测）。
    #[test]
    fn apply_saved_config_overrides_defaults_and_tolerates_garbage() {
        let store = Store::open_in_memory().expect("store");
        let now = 1_000;
        store.set_config("port", "18801", now).unwrap();
        store.set_config("history_limit", "2000", now).unwrap();
        store.set_config("herdr_bin", "C:/tools/herdr.exe", now).unwrap();
        store.set_config("herdr_timeout_ms", "not-a-number", now).unwrap();
        store.set_config("path", "", now).unwrap(); // 空值保留默认

        let mut cfg = HubConfig::default();
        apply_saved_config(&mut cfg, &store);
        assert_eq!(cfg.port, 18801);
        assert_eq!(cfg.history_limit, 2000);
        assert_eq!(cfg.herdr_bin.as_deref(), Some("C:/tools/herdr.exe"));
        assert_eq!(cfg.herdr_timeout_ms, None); // 非法值保留默认（None → 30000 语义）
        assert_eq!(cfg.path, "/mcp");
        assert_eq!(cfg.max_queue, 200);

        // 空库 = 全默认
        let empty = Store::open_in_memory().expect("store");
        let mut cfg2 = HubConfig::default();
        apply_saved_config(&mut cfg2, &empty);
        assert_eq!(cfg2.port, 18764);
        assert_eq!(cfg2.max_queue, 200);
    }

    /// 回归测试：hub 的 tools/call 成功信封必须解包成 bridge tool 的真实返回。
    /// 此前原样透传导致前端 `result.peers` / `result.messages` 为 undefined，
    /// 触发 PeersView 崩溃（`Cannot read properties of undefined (reading 'length')`）。
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

    /// hub 错误信封（isError: true, text 为 {"error": "..."}）→ Err 且错误信息干净。
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

    /// 无 content/text 的怪形状原样透传（向前兼容，不把 UI 打崩）。
    #[test]
    fn unwrap_tool_result_passthrough_odd_shape() {
        let odd = json!({ "foo": 1 });
        let out = unwrap_tool_result(odd.clone()).expect("odd shape passes through");
        assert_eq!(out, odd);
    }

    /// 非 JSON 文本的 content 原样作为字符串返回。
    #[test]
    fn unwrap_tool_result_plain_text_content() {
        let envelope = json!({
            "content": [{ "type": "text", "text": "just a line" }],
            "isError": false
        });
        let out = unwrap_tool_result(envelope).expect("plain text unwraps");
        assert_eq!(out, json!("just a line"));
    }

    /// peers 快照落库：alias/clientVersion 有则写入、缺省保留旧值（COALESCE）、
    /// 畸形行（缺 id）跳过不 panic。
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
                json!({ "connected": true }), // 缺 id：跳过
                json!({ "id": "b", "connected": false, "alias": "B", "clientVersion": "2.0" }),
            ],
        );
        let peers = store.list_peers().unwrap();
        let a = peers.iter().find(|p| p.peer_id == "a").unwrap();
        assert!(a.online);
        assert_eq!(a.last_seen, 42);
        assert_eq!(a.alias.as_deref(), Some("keep-me")); // 缺省保留旧值
        assert_eq!(a.client_version.as_deref(), Some("1.0"));
        let b = peers.iter().find(|p| p.peer_id == "b").unwrap();
        assert_eq!(b.alias.as_deref(), Some("B"));
        assert_eq!(b.client_version.as_deref(), Some("2.0"));
    }

    /// P3-2 竞态：抑制集中的 id 不被在途快照复活 —— 第一次出现仅解除抑制，
    /// 后续 roster 再包含该 id（重新注册回来）才正常落库。
    #[test]
    fn sync_roster_suppresses_kicked_peer_until_next_roster() {
        let store = Store::open_in_memory().unwrap();
        let kicked: KickedPeers =
            Arc::new(std::sync::Mutex::new(std::iter::once("x".to_string()).collect()));
        let roster = [json!({ "id": "x", "connected": true })];
        // kick 后到达的第一份含 x 的 roster：解除抑制但不复活被踢行
        sync_roster_to_store(&store, &kicked, &roster);
        assert!(
            store.list_peers().unwrap().iter().all(|p| p.peer_id != "x"),
            "suppressed peer must not be resurrected by an in-flight snapshot"
        );
        assert!(!kicked.lock().unwrap().contains("x"), "suppression lifts on first sight");
        // 之后的 roster（x 重新注册、hub 持续列出）：正常落库
        sync_roster_to_store(&store, &kicked, &roster);
        assert!(store.list_peers().unwrap().iter().any(|p| p.peer_id == "x"));
    }

    /// SSE 通知解析的关键形状（消费循环里同款防御式取值）：
    /// peers_changed / message 各取所需；字段缺失返回空/None 而不是 panic。
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

        // 旧协议假设 params.message（hub 从未发过）：新解析取不到 data 分支
        let legacy = json!({ "method": "notifications/message", "params": { "message": {} } });
        assert!(legacy.pointer("/params/data").is_none());
    }
}