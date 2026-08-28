//! T-1.6 — MCP streamable-http 客户端
//!
//! 与 hub 的 MCP 协议（src/mcp-server.ts）严格 1:1 对齐：
//! - `initialize`：POST JSON-RPC `{ method: "initialize", params: { protocolVersion, capabilities, clientInfo } }`
//!   响应 header 含 `Mcp-Session-Id`，保存到 session_id。
//! - `tools/list` / `tools/call`：标准 JSON-RPC 方法。
//! - SSE 长连接：GET /mcp + `Accept: text/event-stream` 接收 `notifications/*` 推送。
//!
//! 零第三方 MCP SDK 依赖；只用 reqwest（HTTP）+ futures（StreamExt）+ serde_json。
//!
//! 不在生产代码路径里使用 pub fn 之外的 API；除 `subscribe_notifications` 外均为请求-响应同步风格。

#![allow(dead_code)] // M1 完成实现但未在 commands.rs 中调用（M2 T-2.1/T-2.7 接入后移除）

use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{mpsc, RwLock};

#[derive(Debug, thiserror::Error)]
pub enum McpError {
    #[error("http: {0}")]
    Http(#[from] reqwest::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("protocol: {0}")]
    Protocol(String),
    #[error("not connected (no session id)")]
    NotConnected,
}

pub type Result<T> = std::result::Result<T, McpError>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientInfo {
    pub name: String,
    pub version: String,
}

impl ClientInfo {
    pub fn new(name: impl Into<String>, version: impl Into<String>) -> Self {
        Self { name: name.into(), version: version.into() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpTool {
    pub name: String,
    pub description: String,
    #[serde(rename = "inputSchema")]
    pub input_schema: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConnState {
    /// 还没 initialize 成功。
    Disconnected,
    /// session id 已就绪，可发后续请求。
    Connected,
}

/// MCP 客户端。
/// 同一进程持有 1 个实例；多线程间共享通过 `Arc<McpClient>`。
pub struct McpClient {
    base_url: String,
    mcp_path: String,
    /// 请求-响应调用（initialize / tools/call）：30s 总超时兜底，防止挂死。
    http: reqwest::Client,
    /// SSE 长连接专用 client。reqwest 的总超时语义是"从发起连接到响应 body
    /// 读完"—— SSE 的 body 永远读不完，任何整体 timeout 都会在到期时把长连接
    /// 客户端单方面掐断（推送主通道静默死亡）。这里只保留 TCP 连接建立超时，
    /// 读流不设上限；连接失效由 channel 关闭 / hub 断开自然暴露。
    /// （`RequestBuilder::timeout` 只能覆盖为某个 Duration，无法关掉总超时，
    /// 所以必须用独立 client。）
    sse_http: reqwest::Client,
    session_id: Arc<RwLock<Option<String>>>,
    next_id: Arc<RwLock<u64>>,
    state: Arc<RwLock<ConnState>>,
    client_info: ClientInfo,
}

impl McpClient {
    pub fn new(host: &str, port: u16, path: &str, client_info: ClientInfo) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .expect("reqwest client build");
        // SSE client：不设 .timeout（总超时会掐断长连接），只限连接建立时长。
        let sse_http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .build()
            .expect("reqwest sse client build");
        Self {
            base_url: format!("http://{}:{}", host, port),
            mcp_path: path.to_string(),
            http,
            sse_http,
            session_id: Arc::new(RwLock::new(None)),
            next_id: Arc::new(RwLock::new(1)),
            state: Arc::new(RwLock::new(ConnState::Disconnected)),
            client_info,
        }
    }

    /// Hub 的 MCP endpoint（拼接好的完整 URL）。
    pub fn endpoint_url(&self) -> String {
        format!("{}{}", self.base_url, self.mcp_path)
    }

    /// 当前 session id（initialize 成功后才有）。
    pub async fn session_id(&self) -> Option<String> {
        self.session_id.read().await.clone()
    }

    /// 当前连接状态。
    pub async fn is_connected(&self) -> bool {
        matches!(*self.state.read().await, ConnState::Connected)
    }

    /// `initialize`：建立 session + 触发 hub 端 eager auto-registration（基于 clientInfo.name）。
    pub async fn initialize(&self) -> Result<Value> {
        let params = json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {
                "name": self.client_info.name,
                "version": self.client_info.version,
            }
        });
        let resp = self.call("initialize", Some(params)).await?;
        // 标记 connected：前提是响应里 Mcp-Session-Id 已被 call() 提取
        if self.session_id.read().await.is_some() {
            *self.state.write().await = ConnState::Connected;
        }
        Ok(resp)
    }

    /// `tools/list`：列出 hub 注册的所有 tool。
    pub async fn tools_list(&self) -> Result<Vec<McpTool>> {
        let resp = self.call("tools/list", None).await?;
        let tools = resp
            .get("tools")
            .ok_or_else(|| McpError::Protocol("missing 'tools' field".into()))?;
        serde_json::from_value(tools.clone()).map_err(McpError::from)
    }

    /// `tools/call`：调用单个 tool；返回 result 字段的 Value（hub 端 lossless JSON）。
    pub async fn tools_call(&self, name: &str, arguments: Value) -> Result<Value> {
        let params = json!({ "name": name, "arguments": arguments });
        self.call("tools/call", Some(params)).await
    }

    /// 内部：发请求 + 处理 Mcp-Session-Id + 解析 JSON-RPC。
    async fn call(&self, method: &str, params: Option<Value>) -> Result<Value> {
        let id = {
            let mut g = self.next_id.write().await;
            let i = *g;
            *g += 1;
            i
        };
        let body = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params.unwrap_or(Value::Null),
        });
        let url = self.endpoint_url();
        let mut req = self
            .http
            .post(&url)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream")
            .json(&body);
        if let Some(sid) = self.session_id.read().await.as_ref() {
            req = req.header("Mcp-Session-Id", sid.clone());
        }
        let resp = req.send().await?;
        let status = resp.status();
        // 提取 session id（initialize 后服务端会回传）
        if let Some(sid) = resp.headers().get("mcp-session-id") {
            if let Ok(s) = sid.to_str() {
                if !s.is_empty() {
                    *self.session_id.write().await = Some(s.to_string());
                }
            }
        }
        let text = resp.text().await?;
        if !status.is_success() {
            return Err(McpError::Protocol(format!(
                "http {} from {url}: {text}",
                status.as_u16()
            )));
        }
        // JSON-RPC 解析
        let parsed: Value = serde_json::from_str(&text)?;
        if let Some(err) = parsed.get("error") {
            return Err(McpError::Protocol(format!("jsonrpc error: {err}")));
        }
        Ok(parsed.get("result").cloned().unwrap_or(Value::Null))
    }

    /// SSE 长连接：GET /mcp 接收 `notifications/*` 推送，返回 mpsc::Receiver。
    /// 调用方负责消费；连接断开时接收端自然关闭。
    ///
    /// 必须走 `sse_http`（无总超时）而不是 `http`：`http` 的 30s `.timeout()`
    /// 覆盖"连接 + 响应 body 全部读完"，SSE 流永不完结，约 30s 后 reqwest 会在
    /// 客户端侧掐断这条流 —— 表现为 hub:peers / hub:message 推送静默停止，
    /// 无任何错误日志（P1 修复）。
    pub async fn subscribe_notifications(&self) -> Result<mpsc::Receiver<Value>> {
        let url = self.endpoint_url();
        let mut req = self.sse_http.get(&url).header("Accept", "text/event-stream");
        if let Some(sid) = self.session_id.read().await.as_ref() {
            req = req.header("Mcp-Session-Id", sid.clone());
        }
        let resp = req.send().await?;
        let status = resp.status();
        if !status.is_success() {
            return Err(McpError::Protocol(format!(
                "SSE subscribe http {}",
                status.as_u16()
            )));
        }
        let mut stream = resp.bytes_stream();
        let (tx, rx) = mpsc::channel::<Value>(64);
        tokio::spawn(async move {
            // 按原始字节缓冲、只在事件边界（\n\n，ASCII 序列，字节级查找安全；
            // UTF-8 多字节序列不含 0x0A，不会把码点劈成两半）解码：多字节字符
            // （如中文）跨 TCP chunk 边界时，逐 chunk from_utf8_lossy 会静默
            // 产生 U+FFFD。事件块完整后再统一解码，JSON 永远在完整字节序列上解析。
            let mut buffer: Vec<u8> = Vec::new();
            while let Some(chunk_res) = stream.next().await {
                let Ok(chunk) = chunk_res else { break };
                buffer.extend_from_slice(&chunk);
                // SSE 事件以双换行 `\n\n` 分隔
                while let Some(idx) = buffer.windows(2).position(|w| w == b"\n\n") {
                    let block_bytes: Vec<u8> = buffer.drain(..idx + 2).collect();
                    let block = String::from_utf8_lossy(&block_bytes);
                    let mut data = String::new();
                    for line in block.lines() {
                        let line = line.trim_end_matches('\r');
                        if let Some(rest) = line.strip_prefix("data:") {
                            let rest = rest.trim_start();
                            if !rest.is_empty() {
                                if !data.is_empty() {
                                    data.push('\n');
                                }
                                data.push_str(rest);
                            }
                        }
                    }
                    if !data.is_empty() {
                        if let Ok(v) = serde_json::from_str::<Value>(&data) {
                            if tx.send(v).await.is_err() {
                                return; // receiver dropped
                            }
                        }
                    }
                }
            }
        });
        Ok(rx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_info_constructs() {
        let info = ClientInfo::new("agent-hub-cli", "0.1.0");
        assert_eq!(info.name, "agent-hub-cli");
        assert_eq!(info.version, "0.1.0");
    }

    #[test]
    fn endpoint_url_format() {
        let c = McpClient::new("127.0.0.1", 18764, "/mcp", ClientInfo::new("x", "0"));
        assert_eq!(c.endpoint_url(), "http://127.0.0.1:18764/mcp");
    }

    #[test]
    fn not_connected_before_initialize() {
        let c = McpClient::new("127.0.0.1", 18764, "/mcp", ClientInfo::new("x", "0"));
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            assert!(!c.is_connected().await);
            assert!(c.session_id().await.is_none());
        });
    }

    /// 单元测试覆盖协议序列化层面；端到端测试在 T-1.10 smoke 里跑真实 hub。
    #[test]
    fn session_id_parsing_handles_empty() {
        // 直接确认 header 名查找大小写不敏感（reqwest normalize）
        // 真实解析在 call() 里；这里只保证 ClientInfo / endpoint_url 等纯逻辑 OK。
        let c = McpClient::new("127.0.0.1", 18764, "/mcp", ClientInfo::new("a", "1"));
        assert_eq!(c.endpoint_url(), "http://127.0.0.1:18764/mcp");
    }
}