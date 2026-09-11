//! End-to-end integration test: drives the app's REAL `McpClient` (the exact code
//! path the desktop GUI uses) against the REAL built hub CLI (`lib/cli.js`)
//! spawned as a subprocess.
//!
//! Proves the two things the unit tests cannot:
//!   1. Push timeliness — a message reaches the GUI's SSE receiver within
//!      milliseconds of being sent, before any `bridge_wait`/`bridge_poll`.
//!   2. Remote auth — the bearer token configured on the client actually
//!      authenticates (and its absence is rejected).
//!
//! Skips silently when `node` or the built `lib/cli.js` is unavailable
//! (e.g. a fresh checkout that only ran `cargo test`).

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use agent_comm_hub_app_lib::mcp_client::{ClientInfo, McpClient};
use serde_json::json;

/// Repo root = app/src-tauri/../.. ; the hub's built CLI lives there.
fn hub_cli() -> Option<PathBuf> {
    let cli = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("lib")
        .join("cli.js");
    if cli.exists() { Some(cli) } else { None }
}

fn spawn_hub(port: u16, extra: &[&str]) -> Option<Child> {
    let cli = hub_cli()?;
    let mut args = vec![
        cli.to_string_lossy().into_owned(),
        "--host".into(),
        "127.0.0.1".into(),
        "--port".into(),
        port.to_string(),
        "--state-file".into(),
        "off".into(),
        "--heartbeat-ms".into(),
        "100".into(),
    ];
    args.extend(extra.iter().map(|s| s.to_string()));
    let child = Command::new("node")
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    Some(child)
}

async fn wait_healthz(port: u16) -> bool {
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .expect("reqwest");
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    loop {
        if let Ok(resp) = http.get(format!("http://127.0.0.1:{port}/healthz")).send().await {
            if resp.status().is_success() {
                return true;
            }
        }
        if std::time::Instant::now() > deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Wait for an SSE notification whose data.event == `event` and whose payload
/// contains `needle` (substring of the serialized notification).
async fn wait_event(
    rx: &mut tokio::sync::mpsc::Receiver<serde_json::Value>,
    event: &str,
    needle: &str,
    budget: Duration,
) -> bool {
    let deadline = std::time::Instant::now() + budget;
    while let Ok(Some(notif)) = tokio::time::timeout(
        deadline.saturating_duration_since(std::time::Instant::now()),
        rx.recv(),
    )
    .await
    {
        let is_event = notif
            .pointer("/params/data/event")
            .and_then(|v| v.as_str())
            == Some(event);
        if is_event && notif.to_string().contains(needle) {
            return true;
        }
    }
    false
}

#[tokio::test]
async fn e2e_gui_client_push_timeliness_against_real_hub() {
    let Some(mut hub) = spawn_hub(19031, &[]) else {
        eprintln!("SKIP: node or lib/cli.js not available (run `pnpm build` in the repo root first)");
        return;
    };
    let result = async {
        assert!(wait_healthz(19031).await, "hub did not become healthy");
        let base = ("127.0.0.1", 19031u16, "/mcp");

        // The GUI's own client: same clientInfo name as the app uses.
        let gui = McpClient::new(base.0, base.1, base.2, ClientInfo::new("agent-hub-cli", "test"), None);
        gui.initialize().await.expect("gui initialize");
        gui.tools_call("bridge_register", json!({}))
            .await
            .expect("gui bridge_register");
        let mut rx = gui.subscribe_notifications().await.expect("gui subscribe");

        let bob = McpClient::new(base.0, base.1, base.2, ClientInfo::new("bob", "test"), None);
        bob.initialize().await.expect("bob initialize");

        // Core timeliness assertion: bob sends; the GUI's SSE receives the
        // message relay WITHOUT any bridge_wait/bridge_poll being issued.
        bob.tools_call("bridge_chat", json!({ "to": "agent-hub-cli", "message": "e2e rust hello" }))
            .await
            .expect("bob chat");
        assert!(
            wait_event(&mut rx, "message", "e2e rust hello", Duration::from_secs(3)).await,
            "GUI SSE did not receive the message within 3s of send"
        );

        // Heartbeat (hub started with --heartbeat-ms 100) arrives through the
        // same channel — the GUI watchdog's liveness signal.
        assert!(
            wait_event(&mut rx, "heartbeat", "\"heartbeat\"", Duration::from_secs(3)).await,
            "no heartbeat within 3s"
        );
    }
    .await;
    let _ = hub.kill();
    let _ = hub.wait();
    result
}

#[tokio::test]
async fn e2e_gui_client_bearer_token_against_auth_hub() {
    // Token table for a temporary auth hub.
    let dir = std::env::temp_dir().join(format!("ach-rust-e2e-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("tmpdir");
    let token_file = dir.join("tokens.json");
    std::fs::write(
        &token_file,
        r#"{"version":1,"tokens":[{"token":"rust-e2e-token-0123456789abcdef","peer":"gui-remote","role":"manager"}]}"#,
    )
    .expect("write tokens");

    let Some(mut hub) = spawn_hub(
        19032,
        &[
            "--auth-tokens",
            token_file.to_str().expect("utf8 path"),
            "--db",
            "off",
        ],
    ) else {
        eprintln!("SKIP: node or lib/cli.js not available");
        return;
    };
    let result = async {
        assert!(wait_healthz(19032).await, "auth hub did not become healthy");

        // Without a token the hub rejects the initialize outright (401).
        let anon = McpClient::new("127.0.0.1", 19032, "/mcp", ClientInfo::new("agent-hub-cli", "test"), None);
        let err = anon.initialize().await.expect_err("initialize without token must fail");
        assert!(err.to_string().contains("401"), "expected 401, got: {err}");

        // With the token the same client code authenticates and the peer id
        // comes from the token table, not clientInfo.name.
        let authed = McpClient::new(
            "127.0.0.1",
            19032,
            "/mcp",
            ClientInfo::new("agent-hub-cli", "test"),
            Some("rust-e2e-token-0123456789abcdef".to_string()),
        );
        authed.initialize().await.expect("authed initialize");
        let peers = authed.tools_call("bridge_peers", json!({})).await.expect("bridge_peers");
        let text = peers.to_string();
        assert!(text.contains("gui-remote"), "token-bound peer missing: {text}");

        // SSE also carries the token (the subscription itself is authenticated).
        let mut rx = authed.subscribe_notifications().await.expect("authed subscribe");
        assert!(
            wait_event(&mut rx, "heartbeat", "\"heartbeat\"", Duration::from_secs(3)).await,
            "authed SSE received no heartbeat"
        );
    }
    .await;
    let _ = hub.kill();
    let _ = hub.wait();
    let _ = std::fs::remove_dir_all(&dir);
    result
}
