# Changelog

## 0.1.11 (2026-08-14)

- **Fix `update` missing freshly published versions**: npm caches registry
  packuments (~5 min), so `@latest` right after a publish resolved to the old
  version. The self-update now passes `--prefer-online` to always fetch fresh
  metadata.

## 0.1.10 (2026-08-14)

- **SKILL gains a plain-language "典型工作流" section**: task delegation
  (accept → develop → deliver → review, with wait-vs-not-wait variants) and
  multi-agent real-time discussion (keep long-polling until the talk ends).
  Each scenario pairs colloquial instructions with the exact bridge tool
  names, so agents map everyday wording to the right calls.

## 0.1.9 (2026-08-14)

- **`agent-comm-hub update`**: self-update from the npm registry — reinstalls
  `agent-comm-hub@latest` in place (no manual global reinstall). The global
  path and any registered auto-start launcher keep working; restart the hub
  afterwards. Prints the before/after versions.

## 0.1.8 (2026-08-14)

- **zcode support**: `setup` / `install-all.ps1` now merge the `agent-hub`
  entry into `~/.zcode/cli/config.json` under the nested `mcp.servers` key
  (`type: "remote"`), and install the skill to `~/.zcode/skills/`.
- JSON merge now resolves dotted section paths (`mcp.servers`), so nested
  config layouts are supported alongside flat `mcpServers` sections.
- New template `agents/zcode/config.json`; README (EN + 中文) and
  `agents/README.md` coverage tables updated.

## 0.1.7 (2026-08-14)

- **Fix `agent-comm-hub status` crash on Windows**: the probe used `fetch`
  (undici); its keep-alive pool could race `process.exit()` and abort the
  process with a libuv `UV_HANDLE_CLOSING` assertion (exit 0xC0000409).
  The probe now uses plain `node:http` requests with per-request sockets
  (`agent: false`) and a 5 s hard timeout, so status always exits cleanly.
- CLI help now describes the actual auto-start mechanism (Windows Run key +
  hidden VBS launcher, no admin) instead of "Task Scheduler".

## 0.1.6 (2026-08-14)

- **`agent-comm-hub status`**: probe the hub endpoint and list every registered
  peer with its online state (self-cleaning probe); clear error when the hub
  is not running.
- **`agent-comm-hub service install/uninstall`**: one-shot auto-start —
  Windows uses an HKCU Run key + hidden VBS launcher (no admin; schtasks often
  needs elevation), Linux installs and enables a `systemd --user` unit.
  `--dry-run` prints the commands without touching the system.
- Ops test suite added (6 checks: status up/down, self-exclusion, cleanup).
- README (EN + 中文) documents the new enable-experience commands.
- README banners (`assets/agent-hub-banner.png` / `-cn`) with flat-style
  shields badges; `assets/` ships in the npm package.

## 0.1.5 (2026-08-14)

- **`agent-comm-hub setup`** subcommand (cross-platform Node): one-shot
  incremental sync of the MCP entry + skill into every installed agent
  (mcode, opencode, Kimi Code, Gemini CLI, Codex TOML append) — only the
  named key is touched, files are backed up, idempotent, `--remove` undoes.
  Mirrors `agents/install-all.ps1`.
- Skills now also install to the cross-agent standard **`~/.agents/skills/`**
  location (used by Kimi Code, opencode and others), in addition to each
  agent's private skills dir.
- Setup test suite added (21 checks: incremental merge, preservation,
  backups, idempotency, uninstall).
- README is now bilingual: `README.md` (English, default) with a
  `README.zh.md` (简体中文) toggle; both include the running/resource-usage
  section.

## 0.1.4 (2026-08-14)

- **Idle GC respects live channels**: peers with a live SSE stream are never
  evicted by the idle GC — an open session stays registered no matter how long
  it is silent; only peers whose channel is gone (or who never had one) are
  recycled. Smoke suite extended to 37 checks.
- `agents/install-all.ps1`: one-shot **incremental** sync of the `agent-hub`
  MCP entry + English skill into every installed agent (mcode, opencode,
  Kimi Code, Gemini CLI, Codex TOML append). Only touches the `agent-hub` key,
  backs up each file, idempotent, `-Remove` undoes. Claude Code and DSH stay
  manual (documented).
- `agents/SKILL.md` rewritten in English with verified tool semantics.
- `ARCHITECTURE.md` added.

## 0.1.3 (2026-08-14)

- **Shared identity**: connections with the same client name now ATTACH to one
  peer (N:1) instead of getting `-2`/`-3` suffixes — an agent that opens a new
  MCP session per chat keeps a single stable peer id, and its sessions share
  the peer mailbox. Rename/unregister only drop the peer when no other session
  is still attached to it.
- Smoke suite extended to 35 checks (shared peer, shared mailbox).

## 0.1.2 (2026-08-14)

- **Liveness semantics**: a peer counts as connected when it was active in the
  last `connectedWindowMs` (default 30s) OR its SSE channel is alive — an open
  agent session stays "online" without heartbeat tool calls.
- **Idle GC**: peers idle beyond `peerIdleTimeoutMs` (default 10 min, 0
  disables) are auto-unregistered, releasing their names (session bindings
  cleaned; the next tool call re-registers).
- New CLI flags: `--connected-window-ms`, `--peer-idle-timeout-ms`.
- Smoke suite extended to 34 checks (SSE liveness, GC eviction/rejoin).

## 0.1.1 (2026-08-14)

- **Auto-registration at connect**: the MCP handshake (`initialize`) registers
  the session immediately using the `clientInfo` name — no tool call needed
  (collisions get `-2`, `-3`, … suffixes).
- `bridge_register` renames an existing (auto) identity; `bridge_unregister`
  suppresses auto-registration until an explicit register.
- Smoke suite extended to 29 checks (eager register, rename, suffix, suppress).

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
