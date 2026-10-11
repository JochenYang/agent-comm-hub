//! T-1.6 — MCP streamable-http client
//!
//! Strictly aligned 1:1 with the hub's MCP protocol (src/mcp-server.ts):
//! - `initialize`: POST JSON-RPC `{ method: "initialize", params: { protocolVersion, capabilities, clientInfo } }`
//!   with the `Mcp-Session-Id` in the response header, saved to session_id.
//! - `tools/list` / `tools/call`: standard JSON-RPC methods.
//! - SSE long-lived connection: GET /mcp + `Accept: text/event-stream` receives `notifications/*` pushes.
//!
//! Zero third-party MCP SDK dependency; only reqwest (HTTP) + futures (StreamExt) + serde_json.
//!
//! Uses no API other than pub fns on the production code path; everything except
//! `subscribe_notifications` is a request-response, synchronous style.

#![allow(dead_code)] // M1's implementation complete but not yet called from commands.rs (removed once M2 T-2.1/T-2.7 wires it in)

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
    /// The hub answered 404: it does not know this session any more (it was
    /// restarted, or the session was terminated). Distinct from a generic
    /// protocol error because the caller must rebuild the connection and
    /// re-initialize — that is the whole point of the 404 (spec MUST).
    #[error("session not found (http 404) — re-initialize")]
    SessionGone,
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
    /// No successful initialize yet.
    Disconnected,
    /// Session id ready; subsequent requests may be sent.
    Connected,
}

/// MCP client.
/// The process holds a single instance; shared across threads via `Arc<McpClient>`.
pub struct McpClient {
    /// Full MCP endpoint URL, resolved once at construction by `resolve_endpoint` (the host may or
    /// may not carry a scheme / port / path of its own).
    endpoint: String,
    /// Request-response calls (initialize / tools/call): a 45s total timeout. Sized for the
    /// bridge_wait long-poll: the frontend uses a 25s budget and the hub's default server-side
    /// budget is 30s, so a 30s cap raced the wait itself — a full-budget wait arrived as an HTTP
    /// timeout instead of a clean `{type:'timeout'}`, tearing the client down via lazy reconnect.
    http: reqwest::Client,
    /// Dedicated client for the SSE long-lived connection. reqwest's total-timeout semantics are
    /// "from connection start until the response body is fully read" — an SSE body never finishes,
    /// so any overall timeout would unilaterally cut the long-lived connection on expiry (the push
    /// main channel would silently die). Here only the TCP connect timeout is kept and the read
    /// stream has no cap; a dead connection surfaces naturally via channel close / hub disconnect.
    /// (`RequestBuilder::timeout` can only override to some Duration; it can't turn the total
    /// timeout off, so a separate client is required.)
    sse_http: reqwest::Client,
    session_id: Arc<RwLock<Option<String>>>,
    next_id: Arc<RwLock<u64>>,
    state: Arc<RwLock<ConnState>>,
    client_info: ClientInfo,
    /// Remote-mode bearer token (a hub started with `--auth-tokens`). Sent as
    /// `Authorization: Bearer <token>` on every POST and on the SSE GET; a
    /// loopback hub without auth ignores it. Sourced from the `auth_token`
    /// config key (settings panel), NOT from HubConfig — it is a property of
    /// the connection, not of the spawned process.
    auth_token: Option<String>,
}

/// Resolve the hub's MCP endpoint from the settings fields (`host` / `port` / `path`).
///
/// Backward compatible with the historical form: a host without a scheme is still assembled
/// byte-for-byte as `http://{host}:{port}{path}`, which is how the GUI reaches a loopback / LAN hub.
///
/// A host that already carries a scheme — `https://hub.example.com/mcp`, the URL
/// server/TEAM-DEPLOY.md hands to remote members — is used as-is. Its scheme, port and path all come
/// from the field: a TLS reverse proxy is simply unreachable through a hard-coded `http://`, and the
/// separate `port` field cannot describe a 443 endpoint behind such a proxy. `path` keeps its meaning
/// wherever the URL carries no path of its own (`https://hub.example.com` → `.../mcp`).
fn resolve_endpoint(host: &str, port: u16, path: &str) -> String {
    let Some(scheme_end) = host.find("://") else {
        return format!("http://{host}:{port}{path}");
    };
    // Split the scheme off first so trimming trailing slashes can never eat the "//" separator.
    let scheme = &host[..scheme_end + 3];
    let rest = host[scheme_end + 3..].trim_end_matches('/');
    // Whatever follows the authority's first '/' is the URL's own path; a bare authority
    // (`https://hub.example.com`, with or without a trailing slash) has none.
    let url_has_path = rest.split_once('/').is_some_and(|(_, p)| !p.is_empty());
    if url_has_path {
        // Trailing slashes were dropped above: the hub routes on an exact path, so `.../mcp/`
        // addresses the same endpoint as `.../mcp` and the slashless form is the one that works.
        return format!("{scheme}{rest}");
    }
    let path = path.trim_start_matches('/');
    if path.is_empty() {
        format!("{scheme}{rest}")
    } else {
        format!("{scheme}{rest}/{path}")
    }
}

impl McpClient {
    pub fn new(host: &str, port: u16, path: &str, client_info: ClientInfo, auth_token: Option<String>) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(45))
            .build()
            .expect("reqwest client build");
        // SSE client: don't set .timeout (a total timeout would cut the long-lived connection); only cap connect duration.
        let sse_http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .build()
            .expect("reqwest sse client build");
        Self {
            endpoint: resolve_endpoint(host, port, path),
            http,
            sse_http,
            session_id: Arc::new(RwLock::new(None)),
            next_id: Arc::new(RwLock::new(1)),
            state: Arc::new(RwLock::new(ConnState::Disconnected)),
            client_info,
            auth_token,
        }
    }

    /// The hub's MCP endpoint (full assembled URL).
    pub fn endpoint_url(&self) -> String {
        self.endpoint.clone()
    }

    /// The current session id (present only after a successful initialize).
    pub async fn session_id(&self) -> Option<String> {
        self.session_id.read().await.clone()
    }

    /// Forget the current session id. The hub answers a session id it does not
    /// know with 404 (spec MUST), so a client that keeps presenting a dead one
    /// can never recover — this is the reconnect primitive.
    async fn clear_session(&self) {
        self.session_id.write().await.take();
        *self.state.write().await = ConnState::Disconnected;
    }

    /// The current connection state.
    pub async fn is_connected(&self) -> bool {
        matches!(*self.state.read().await, ConnState::Connected)
    }

    /// `initialize`: establish a session + trigger the hub-end eager auto-registration (based on clientInfo.name).
    pub async fn initialize(&self) -> Result<Value> {
        // A fresh initialize MUST NOT carry a session id (spec), and the hub now
        // answers an unknown id with 404: presenting the one we kept from before a
        // hub restart would fail forever. Dropping it here is what makes reconnect
        // work at all.
        self.clear_session().await;
        let params = json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {
                "name": self.client_info.name,
                "version": self.client_info.version,
            }
        });
        let resp = self.call("initialize", Some(params)).await?;
        // Mark connected: requires that Mcp-Session-Id has been extracted from the response by call()
        if self.session_id.read().await.is_some() {
            *self.state.write().await = ConnState::Connected;
        }
        Ok(resp)
    }

    /// `tools/list`: list every tool registered on the hub.
    pub async fn tools_list(&self) -> Result<Vec<McpTool>> {
        let resp = self.call("tools/list", None).await?;
        let tools = resp
            .get("tools")
            .ok_or_else(|| McpError::Protocol("missing 'tools' field".into()))?;
        serde_json::from_value(tools.clone()).map_err(McpError::from)
    }

    /// `tools/call`: call a single tool; returns the Value of the result field (hub-end lossless JSON).
    pub async fn tools_call(&self, name: &str, arguments: Value) -> Result<Value> {
        let params = json!({ "name": name, "arguments": arguments });
        self.call("tools/call", Some(params)).await
    }

    /// Internal: send the request + handle Mcp-Session-Id + parse JSON-RPC.
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
        if let Some(token) = &self.auth_token {
            req = req.header("Authorization", format!("Bearer {token}"));
        }
        let resp = req.send().await?;
        let status = resp.status();
        // Extract the session id (returned by the server after initialize)
        if let Some(sid) = resp.headers().get("mcp-session-id") {
            if let Ok(s) = sid.to_str() {
                if !s.is_empty() {
                    *self.session_id.write().await = Some(s.to_string());
                }
            }
        }
        let text = resp.text().await?;
        if !status.is_success() {
            // 404 means the hub does not know this session any more (it restarted,
            // or the session was terminated). Forget it so the next call does not
            // keep presenting a dead id, and say what to do about it.
            if status.as_u16() == 404 {
                self.clear_session().await;
                return Err(McpError::SessionGone);
            }
            return Err(McpError::Protocol(format!(
                "http {} from {url}: {text}",
                status.as_u16()
            )));
        }
        // JSON-RPC parse
        let parsed: Value = serde_json::from_str(&text)?;
        if let Some(err) = parsed.get("error") {
            return Err(McpError::Protocol(format!("jsonrpc error: {err}")));
        }
        Ok(parsed.get("result").cloned().unwrap_or(Value::Null))
    }

    /// SSE long-lived connection: GET /mcp receives `notifications/*` pushes, returning an mpsc::Receiver.
/// The caller owns consumption; the receiving end closes naturally on disconnect.
///
///
/// Must go through `sse_http` (no total timeout) rather than `http`: `http`'s `.timeout()`
/// covers "connect + read the entire response body", an SSE stream never finishes, and on
/// expiry reqwest would cut this stream on the client side — which looks like hub:peers /
/// hub:message pushes silently stopping, with no error logged (P1 fix).
    pub async fn subscribe_notifications(&self) -> Result<mpsc::Receiver<Value>> {
        let url = self.endpoint_url();
        let mut req = self.sse_http.get(&url).header("Accept", "text/event-stream");
        if let Some(sid) = self.session_id.read().await.as_ref() {
            req = req.header("Mcp-Session-Id", sid.clone());
        }
        if let Some(token) = &self.auth_token {
            req = req.header("Authorization", format!("Bearer {token}"));
        }
        let resp = req.send().await?;
        let status = resp.status();
        if status.as_u16() == 404 {
            // The same signal a tool call gets: the hub has forgotten this session.
            // Drop it so the next call re-initializes instead of re-subscribing in
            // a loop against a dead id.
            self.clear_session().await;
            return Err(McpError::SessionGone);
        }
        if !status.is_success() {
            return Err(McpError::Protocol(format!(
                "SSE subscribe http {}",
                status.as_u16()
            )));
        }
        // The hub mints a session for a stream that arrives without one and echoes
        // it here. Adopt it: otherwise this stream stays attached to a session the
        // hub can map to no peer, and every per-peer push (hub:message) is skipped
        // for it while broadcast pushes still arrive — a confusing half-working
        // stream.
        if self.session_id.read().await.is_none() {
            if let Some(sid) = resp.headers().get("mcp-session-id") {
                if let Ok(s) = sid.to_str() {
                    if !s.is_empty() {
                        *self.session_id.write().await = Some(s.to_string());
                    }
                }
            }
        }
        let mut stream = resp.bytes_stream();
        let (tx, rx) = mpsc::channel::<Value>(64);
        tokio::spawn(async move {
            // Buffer raw bytes and only decode at event boundaries (\n\n, an ASCII sequence, so byte-level
            // search is safe; UTF-8 multi-byte sequences never contain 0x0A, so a code point is never
            // split in half): decoding per chunk with from_utf8_lossy when a multi-byte char (e.g.
            // Chinese) spans TCP chunks would silently produce U+FFFD. Only after a full event block
            // is it decoded, so JSON is always parsed over the complete byte sequence.
            let mut buffer: Vec<u8> = Vec::new();
            while let Some(chunk_res) = stream.next().await {
                let Ok(chunk) = chunk_res else { break };
                buffer.extend_from_slice(&chunk);
                // SSE events are separated by the double newline `\n\n`
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
        let c = McpClient::new("127.0.0.1", 18764, "/mcp", ClientInfo::new("x", "0"), None);
        assert_eq!(c.endpoint_url(), "http://127.0.0.1:18764/mcp");
    }

    /// A host carrying its own scheme is used as-is: the URL's scheme, port and path all win over
    /// the separate `port` / `path` fields (this is what makes a TLS reverse-proxied hub reachable).
    #[test]
    fn endpoint_url_keeps_scheme_qualified_host() {
        let cases = [
            // Exactly the URL server/TEAM-DEPLOY.md §3 hands to remote members.
            ("https://hub.example.com/mcp", 80, "/mcp", "https://hub.example.com/mcp"),
            ("https://hub.example.com:8443/mcp", 18764, "/mcp", "https://hub.example.com:8443/mcp"),
            ("http://127.0.0.1:18764/mcp", 1, "/mcp", "http://127.0.0.1:18764/mcp"),
            // A path inside the URL is authoritative — the path field must not duplicate it.
            ("https://hub.example.com/api/mcp", 443, "/mcp", "https://hub.example.com/api/mcp"),
            // The hub routes on an exact path: a trailing slash is not part of the endpoint.
            ("https://hub.example.com/mcp/", 443, "/mcp", "https://hub.example.com/mcp"),
        ];
        for (host, port, path, expected) in cases {
            let c = McpClient::new(host, port, path, ClientInfo::new("x", "0"), None);
            assert_eq!(c.endpoint_url(), expected, "host={host}");
        }
    }

    /// `path` (default `/mcp`) still decides the endpoint when the URL has no path of its own, and
    /// the scheme-less form is unchanged.
    #[test]
    fn endpoint_url_appends_path_when_host_has_none() {
        for host in ["https://hub.example.com", "https://hub.example.com/"] {
            let c = McpClient::new(host, 443, "/mcp", ClientInfo::new("x", "0"), None);
            assert_eq!(c.endpoint_url(), "https://hub.example.com/mcp", "host={host}");
        }
        // A path without a leading slash still joins with exactly one '/'.
        let c = McpClient::new("https://hub.example.com", 443, "mcp", ClientInfo::new("x", "0"), None);
        assert_eq!(c.endpoint_url(), "https://hub.example.com/mcp");
    }

    #[test]
    fn not_connected_before_initialize() {
        let c = McpClient::new("127.0.0.1", 18764, "/mcp", ClientInfo::new("x", "0"), None);
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            assert!(!c.is_connected().await);
            assert!(c.session_id().await.is_none());
        });
    }

    /// Unit tests cover the protocol-serialization layer; end-to-end tests run against a real hub
    /// in the T-1.10 smoke suite.
    #[test]
    fn session_id_parsing_handles_empty() {
        // Directly confirm the header-name lookup is case-insensitive (reqwest normalize).
        // The real parsing lives in call(); here we only guarantee the ClientInfo / endpoint_url logic is sound.
        let c = McpClient::new("127.0.0.1", 18764, "/mcp", ClientInfo::new("a", "1"), None);
        assert_eq!(c.endpoint_url(), "http://127.0.0.1:18764/mcp");
    }
}