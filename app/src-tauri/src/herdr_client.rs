//! T-2.8 — herdr control adapter (Rust 版，对齐 src/herdr-ctl.ts 设计)
//!
//! 职责：与本地 herdr 服务通信（通过 herdr CLI + JSON envelope）。
//! 11 个工具对应 hub 的 bridge_agent_* 和 bridge_pane_*。
//!
//! 设计要点（与主仓一致）：
//! - execFile herdr CLI（args 透传，无 shell），结果解析 `{id, result}` 或 `{id, error}` envelope
//! - 默认 herdr 二进制走 PATH，可用 `--herdr-bin` 指定
//! - 默认超时 30s，可按调用覆盖
//! - M2 简化版：不实现 socket API 直连（herdr CLI 已经覆盖主路径），不实现 smart channel fallback
//!   （frontend 一次性调单个工具，避免双通道决策）
//!
//! M2 前端用法：每个 herdr tool 一个 tauri command；UI 调用具体工具。

#![allow(dead_code)] // M2 T-2.9 接入后移除

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::process::Command;
use tokio::time::timeout;

#[derive(Debug, thiserror::Error)]
pub enum HerdrError {
    #[error("herdr CLI exit {code}: {stderr}")]
    Cli { code: i32, stderr: String },
    #[error("herdr CLI spawn failed: {0}")]
    Spawn(String),
    #[error("herdr CLI timed out after {0:?}")]
    Timeout(Duration),
    #[error("herdr CLI error envelope: {code} {message}")]
    Envelope { code: i64, message: String },
    #[error("herdr CLI returned non-JSON: {0}")]
    NotJson(String),
}

pub type Result<T> = std::result::Result<T, HerdrError>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HerdrPane {
    #[serde(rename = "paneId")]
    pub pane_id: String,
    #[serde(rename = "tabId")]
    pub tab_id: String,
    #[serde(rename = "workspaceId")]
    pub workspace_id: String,
    #[serde(rename = "terminalId")]
    pub terminal_id: String,
    pub title: Option<String>,
    #[serde(rename = "agentStatus")]
    pub agent_status: String,
    pub cwd: Option<String>,
    pub focused: bool,
    pub revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HerdrAgent {
    #[serde(rename = "paneId")]
    pub pane_id: String,
    #[serde(rename = "tabId")]
    pub tab_id: String,
    #[serde(rename = "terminalId")]
    pub terminal_id: String,
    pub name: Option<String>,
    pub agent: Option<String>,
    #[serde(rename = "displayAgent")]
    pub display_agent: Option<String>,
    pub status: String,
    pub cwd: Option<String>,
    pub focused: bool,
    #[serde(rename = "interactiveReady")]
    pub interactive_ready: bool,
    #[serde(rename = "launchPending")]
    pub launch_pending: bool,
    #[serde(rename = "terminalTitle")]
    pub terminal_title: Option<String>,
    pub revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HerdrRead {
    #[serde(rename = "paneId")]
    pub pane_id: String,
    #[serde(rename = "tabId")]
    pub tab_id: String,
    #[serde(rename = "workspaceId")]
    pub workspace_id: Option<String>,
    pub source: String,
    pub text: String,
    pub revision: u64,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HerdrSettled {
    #[serde(rename = "paneId")]
    pub pane_id: String,
    pub status: String,
    #[serde(rename = "waitedMs")]
    pub waited_ms: Option<u64>,
}

/// herdr CLI 调用器。启动时实例化一次，全局共享。
pub struct HerdrCtl {
    bin: PathBuf,
    default_timeout: Duration,
}

impl HerdrCtl {
    pub fn new(bin: impl Into<PathBuf>) -> Self {
        Self { bin: bin.into(), default_timeout: Duration::from_secs(30) }
    }

    pub fn with_default_timeout(mut self, ms: u64) -> Self {
        self.default_timeout = Duration::from_millis(ms);
        self
    }

    /// 检查 herdr 是否可用（PATH + 版本探测）。herdr 未安装时返回 false 而非抛错。
    pub async fn is_available(&self) -> bool {
        let result = self.run_raw(&["--version"], Duration::from_secs(2)).await;
        result.is_ok()
    }

    // ---- agent-level (走 herdr agent <sub>) ----

    /// `herdr agent list`
    pub async fn agent_list(&self) -> Result<Vec<HerdrAgent>> {
        let v = self.run_json(&["agent", "list"], self.default_timeout).await?;
        let raw = v.get("agents").cloned().unwrap_or(serde_json::Value::Null);
        serde_json::from_value(raw).map_err(|e| HerdrError::NotJson(format!("agents decode: {e}")))
    }

    /// `herdr agent get <target>`
    pub async fn agent_status(&self, target: &str) -> Result<HerdrAgent> {
        let v = self.run_json(&["agent", "get", target], self.default_timeout).await?;
        let raw = v.get("agent").cloned().unwrap_or(serde_json::Value::Null);
        serde_json::from_value(raw).map_err(|e| HerdrError::NotJson(format!("agent decode: {e}")))
    }

    /// `herdr agent read <target> --format text [--source ...] [--lines N]`
    pub async fn agent_read(&self, target: &str, lines: Option<u32>) -> Result<HerdrRead> {
        let mut args: Vec<String> = vec![
            "agent".into(),
            "read".into(),
            target.into(),
            "--format".into(),
            "text".into(),
            "--source".into(),
            "recent".into(),
        ];
        if let Some(l) = lines {
            args.push("--lines".into());
            args.push(l.to_string());
        }
        let argv: Vec<&str> = args.iter().map(String::as_str).collect();
        let v = self.run_json(&argv, self.default_timeout).await?;
        let raw = v.get("read").cloned().unwrap_or(v);
        serde_json::from_value(raw).map_err(|e| HerdrError::NotJson(format!("read decode: {e}")))
    }

    /// `herdr agent send-keys <target> <KEY1> <KEY2>...`
    pub async fn agent_keys(&self, target: &str, keys: &[String]) -> Result<()> {
        if keys.is_empty() {
            return Err(HerdrError::Envelope { code: -1, message: "at least one key required".into() });
        }
        let mut args: Vec<String> = vec!["agent".into(), "send-keys".into(), target.into()];
        args.extend(keys.iter().cloned());
        let argv: Vec<&str> = args.iter().map(String::as_str).collect();
        self.run_json(&argv, self.default_timeout).await?;
        Ok(())
    }

    /// `herdr agent prompt <target> <text> [--wait] [--until STATUS] [--timeout MS]`
    pub async fn agent_prompt(
        &self,
        target: &str,
        text: &str,
        wait: bool,
        until: Option<&str>,
        timeout_ms: Option<u32>,
    ) -> Result<Option<HerdrSettled>> {
        let mut args: Vec<String> = vec!["agent".into(), "prompt".into(), target.into(), text.into()];
        if wait {
            args.push("--wait".into());
        }
        if let Some(u) = until {
            args.push("--until".into());
            args.push(u.into());
        }
        if let Some(t) = timeout_ms {
            args.push("--timeout".into());
            args.push(t.to_string());
        }
        let argv: Vec<&str> = args.iter().map(String::as_str).collect();
        let budget = timeout_ms
            .map(|m| Duration::from_millis((m as u64) + 5_000))
            .unwrap_or(self.default_timeout);
        let v = self.run_json(&argv, budget).await?;
        Ok(parse_settle(&v, target))
    }

    /// `herdr agent wait <target> [--until STATUS] [--timeout MS]`
    pub async fn agent_wait(
        &self,
        target: &str,
        until: Option<&str>,
        timeout_ms: Option<u32>,
    ) -> Result<Option<HerdrSettled>> {
        let mut args: Vec<String> = vec!["agent".into(), "wait".into(), target.into()];
        if let Some(u) = until {
            args.push("--until".into());
            args.push(u.into());
        }
        if let Some(t) = timeout_ms {
            args.push("--timeout".into());
            args.push(t.to_string());
        }
        let argv: Vec<&str> = args.iter().map(String::as_str).collect();
        let budget = timeout_ms
            .map(|m| Duration::from_millis((m as u64) + 5_000))
            .unwrap_or(self.default_timeout);
        let v = self.run_json(&argv, budget).await?;
        Ok(parse_settle(&v, target))
    }

    // ---- pane-level (走 herdr pane <sub>) ----

    /// `herdr pane list`
    pub async fn pane_list(&self) -> Result<Vec<HerdrPane>> {
        let v = self.run_json(&["pane", "list"], self.default_timeout).await?;
        let raw = v.get("panes").cloned().unwrap_or(serde_json::Value::Null);
        serde_json::from_value(raw).map_err(|e| HerdrError::NotJson(format!("panes decode: {e}")))
    }

    /// `herdr pane read <target> [--source ...] [--lines N]`
    pub async fn pane_read(&self, target: &str, lines: Option<u32>) -> Result<HerdrRead> {
        let mut args: Vec<String> = vec!["pane".into(), "read".into(), target.into(), "--source".into(), "recent".into()];
        if let Some(l) = lines {
            args.push("--lines".into());
            args.push(l.to_string());
        }
        let argv: Vec<&str> = args.iter().map(String::as_str).collect();
        let v = self.run_json(&argv, self.default_timeout).await?;
        let raw = v.get("read").cloned().unwrap_or(v);
        serde_json::from_value(raw).map_err(|e| HerdrError::NotJson(format!("pane.read decode: {e}")))
    }

    /// `herdr pane send-input <target> --text "..."`
    pub async fn pane_send_text(&self, target: &str, text: &str) -> Result<()> {
        let v = self
            .run_json(&["pane", "send-input", target, "--text", text], self.default_timeout)
            .await?;
        let _ = v;
        Ok(())
    }

    /// `herdr pane send-keys <target> <KEY1> <KEY2>...`
    pub async fn pane_send_keys(&self, target: &str, keys: &[String]) -> Result<()> {
        if keys.is_empty() {
            return Err(HerdrError::Envelope { code: -1, message: "at least one key required".into() });
        }
        let mut args: Vec<String> = vec!["pane".into(), "send-keys".into(), target.into()];
        args.extend(keys.iter().cloned());
        let argv: Vec<&str> = args.iter().map(String::as_str).collect();
        self.run_json(&argv, self.default_timeout).await?;
        Ok(())
    }

    /// `herdr pane wait-for-output <target> --match type=value [--timeout MS]`
    /// 返回 Ok(None) 表示超时未匹配（herdr CLI 把 timeout 当 error envelope；本实现视超时为非错）。
    pub async fn pane_wait_for_output(
        &self,
        target: &str,
        match_type: &str,
        match_value: &str,
        timeout_ms: Option<u32>,
    ) -> Result<Option<HerdrRead>> {
        let mut args: Vec<String> = vec![
            "pane".into(),
            "wait-for-output".into(),
            target.into(),
            "--match".into(),
            format!("{match_type}={match_value}"),
        ];
        if let Some(t) = timeout_ms {
            args.push("--timeout".into());
            args.push(t.to_string());
        }
        let argv: Vec<&str> = args.iter().map(String::as_str).collect();
        let budget = timeout_ms
            .map(|m| Duration::from_millis((m as u64) + 5_000))
            .unwrap_or(self.default_timeout);
        match self.run_json(&argv, budget).await {
            Ok(v) => {
                let raw = v.get("read").cloned().unwrap_or(v);
                if raw.is_null() {
                    Ok(None)
                } else {
                    serde_json::from_value(raw)
                        .map(Some)
                        .map_err(|e| HerdrError::NotJson(format!("wait-for-output decode: {e}")))
                }
            }
            Err(HerdrError::Envelope { message, .. }) if message.to_lowercase().contains("timeout") => Ok(None),
            Err(e) => Err(e),
        }
    }

    // ---- 内部：跑 herdr CLI 并解析 envelope ----

    /// 跑 herdr CLI 拿 stdout（任意字符串）。
    async fn run_raw(&self, args: &[&str], budget: Duration) -> Result<String> {
        let mut cmd = Command::new(&self.bin);
        cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null());
        let output = timeout(budget, cmd.output())
            .await
            .map_err(|_| HerdrError::Timeout(budget))?
            .map_err(|e| HerdrError::Spawn(e.to_string()))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
            let code = output.status.code().unwrap_or(-1);
            return Err(HerdrError::Cli { code, stderr });
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    /// 跑 herdr CLI 并解析 JSON envelope `{id, result}` 或 `{id, error}`。
    async fn run_json(&self, args: &[&str], budget: Duration) -> Result<serde_json::Value> {
        let raw = self.run_raw(args, budget).await?;
        let v: serde_json::Value = serde_json::from_str(&raw)
            .map_err(|e| HerdrError::NotJson(format!("{e}: {raw}")))?;
        if let Some(err) = v.get("error") {
            let code = err.get("code").and_then(|c| c.as_i64()).unwrap_or(-1);
            let message = err.get("message").and_then(|m| m.as_str()).unwrap_or("").to_string();
            return Err(HerdrError::Envelope { code, message });
        }
        Ok(v.get("result").cloned().unwrap_or(v))
    }
}

/// 从 herdr agent prompt/wait 的 JSON 响应中解析 settle。
fn parse_settle(v: &serde_json::Value, pane_id: &str) -> Option<HerdrSettled> {
    // herdr 返回 {"settled": {paneId, status, waitedMs}} 或 null
    if let Some(settled) = v.get("settled") {
        if settled.is_null() {
            return None;
        }
        return serde_json::from_value(settled.clone()).ok();
    }
    // fallback：直接读 status
    if let Some(status) = v.get("status").and_then(|s| s.as_str()) {
        return Some(HerdrSettled {
            pane_id: pane_id.to_string(),
            status: status.to_string(),
            waited_ms: v.get("waitedMs").and_then(|n| n.as_u64()),
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_settle_handles_settled_field() {
        let v = serde_json::json!({ "settled": { "paneId": "w1:p1", "status": "idle", "waitedMs": 1200 } });
        let s = parse_settle(&v, "w1:p1").unwrap();
        assert_eq!(s.status, "idle");
        assert_eq!(s.waited_ms, Some(1200));
    }

    #[test]
    fn parse_settle_handles_null() {
        let v = serde_json::json!({ "settled": null });
        assert!(parse_settle(&v, "w1:p1").is_none());
    }

    #[test]
    fn parse_settle_fallback_to_status_field() {
        let v = serde_json::json!({ "status": "done" });
        let s = parse_settle(&v, "w1:p2").unwrap();
        assert_eq!(s.status, "done");
        assert_eq!(s.pane_id, "w1:p2");
    }

    #[test]
    fn parse_settle_missing_returns_none() {
        let v = serde_json::json!({});
        assert!(parse_settle(&v, "w1:p3").is_none());
    }
}