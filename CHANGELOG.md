# Changelog

## 0.1.0 (2026-08-14)

- Initial release: generic multi-peer MCP hub.
- Tools: bridge_register / bridge_unregister / bridge_chat / bridge_task /
  bridge_ack / bridge_wait / bridge_poll / bridge_status / bridge_peers /
  bridge_history.
- Per-peer FIFO mailboxes with long-poll waiters, sender-filtered waits,
  broadcast (`to: "all"`), ack routing back to the original sender.
- Hand-rolled MCP streamable-http server over `node:http` — zero runtime
  dependencies; UTF-8 charset on all responses; session→peer bindings.
- CLI (`agent-comm-hub`) + programmatic `startHub()` API.
- Agent templates: MiniMax Code, Claude Code, opencode, Codex, Gemini CLI, DSH.
- Multi-peer smoke suite (23 checks).
