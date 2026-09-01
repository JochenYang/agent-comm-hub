# Changelog

## 0.7.1 (2026-09-01)

- Fix a misleading desktop warning: the SQLite "state open" line was logged
  at `warn` (stderr), which the desktop GUI surfaced as an `[err]` entry on
  every start even though the hub was running fine. It is now `info`
  (stdout), so the app shows it as a normal startup log. No behavior change.

## 0.7.0 (2026-08-30)

- **Remote mode (server deployment)**: `--auth-tokens <file>` turns on bearer
  authentication — every MCP request must carry `Authorization: Bearer
  <token>`, and each token maps to a fixed peer id + role (`agent` |
  `manager`). Identity comes from the token, not the client-reported name, so
  a team where everyone runs "kimi-code" gets one peer per person instead of
  one shared mailbox (which leaked messages across users — verified in a
  two-machine experiment). Managers may also be authorized via token role.
  Loopback desktop usage is unchanged: without the flag nothing is required
  and nothing changes.
- New `server/` directory: token-table template, deployment recipes for
  内网 (LAN/VPN) and 公网 VPS (Caddy TLS reverse proxy with SSE pass-through),
  and agent-side MCP config examples with the Authorization header.
- **`--allow-join` (LAN/VPN onboarding)**: agents without a token may join;
  each walk-in gets a SESSION-UNIQUE temporary peer id (`join-<name>-<hex>`,
  never mergeable with another walk-in — the same-name shared-mailbox leak
  cannot recur) plus its source IP, shown in the roster. The admin renames
  (认领) them or issues a token to 转正. Keep OFF on the public internet.
- **Token management in the web admin**: `/admin/api/tokens` (manager-gated)
  lets the operator issue/revoke/mask tokens from the page — no SSH needed;
  freshly issued tokens authenticate immediately (in-process reload, no
  2s watcher wait). `agent-comm-hub auth` remains the CLI equivalent.
- Test suite grows to 240 checks (135 smoke + 36 setup + 11 ops +
  35 herdr control + 23 discovery).
- **Group membership is now dynamic**: `bridge_group_add_member` /
  `bridge_group_remove_member` let the group creator or a manager pull peers
  in and kick them out after a channel exists (creator cannot be removed);
  membership edits persist to SQLite and survive restarts.
- Test suite grows to 196 checks (91 smoke + 36 setup + 11 ops +
  35 herdr control + 23 discovery).

## 0.6.0 (2026-08-28)

- **Peer profiles + display aliases**: the hub now keeps identity metadata per
  peer — the client name/version reported at connect, and an optional display
  alias (spaces/CJK allowed). The alias is purely cosmetic: routing, mailboxes,
  history, and acks keep using the immutable peer id, so renaming a peer never
  moves state or drops messages. Aliases survive unregister/reconnect, and are
  carried across a self id-rename. `bridge_peers` / `bridge_status` now return
  `alias` / `clientName` / `clientVersion` alongside the connection state.
- **Manager role + `bridge_rename`**: a new `managerPeers` setting (default
  `agent-hub-cli` — the desktop GUI identity) names who may manage the roster.
  The new `bridge_rename` tool sets a peer's display alias; renaming yourself
  is open to everyone, renaming another peer requires manager rights. This is
  a convention on top of the loopback trust model, not authentication.
- **Manager kick via `bridge_unregister { peer }`**: a manager can remove
  another peer — its queue is dropped and every session attached to it is
  detached and kept from auto-re-registering until it explicitly calls
  `bridge_register` (or reconnects with a fresh session).
- **SSE event push**: peer joins/leaves and alias edits now push a
  `notifications/message` event (`data.event: "peers_changed"`) with the full
  roster to every open SSE stream; a message queued for a peer pushes a
  `data.event: "message"` hint to that peer's streams only. Consumers (the
  desktop GUI) can drop periodic polling; delivery itself is still via
  `bridge_wait` / `bridge_poll`.
- **True rename (re-key)**: `bridge_rename` accepts `peerId` — a manager can
  re-key a registered peer atomically: mailbox, waiters, session bindings,
  and history attribution all move, so queued messages and ack routing stay
  continuous and no tombstone is needed. Self id-renames via
  `bridge_register` now use the same lossless path (previously they dropped
  the mailbox and broke history/acks). Renaming onto a taken or reserved id
  (`all`) is rejected.
- **`bridge_history` access gate**: reading another peer's conversation (or
  `peer: "all"`) now requires manager rights; every peer can still read its
  own history.
- **Roster persistence**: `--state-file` (default `~/.agent-comm-hub/
  roster.json`, `off` to disable) persists peer profiles — aliases and
  client info survive hub restarts.
- `agent-comm-hub status` shows a peer's alias next to its id.
- **`setup` self-heals duplicate DSH entries**: hub entries in a DSH profile
  patch are now identified by the plugin name instead of the marker comment;
  running `setup` collapses any existing duplicates (a markerless entry used
  to be treated as "not configured" and re-inserted, so DSH loaded the MCP
  client twice and crash-restarted on profile load). `setup --remove` strips
  markerless entries too.
- New CLI flag `--manager-peers <ids|all>` (default `agent-hub-cli`).
- Test suite grows to 181 checks (80 smoke + 32 setup + 11 ops +
  35 herdr control + 23 discovery).

## 0.5.0 (2026-08-22)

- **`bridge_history` accepts `peer: "all"`**: returns the unfiltered tail of
  the history ring across every peer, so an archiver (the desktop app) can
  persist peer-to-peer traffic it is not a party of — previously messages
  between two other agents never showed up in a third party's history query,
  and were gone once the ring wrapped or the hub restarted.
- **`--history-limit` default raised 100 → 1000**: 100 shared entries evicted
  within minutes during a long multi-agent session; the in-memory ring is the
  only archive source until the desktop app persists it to SQLite. The limit
  clamp on one `bridge_history` call rises to match (was 100).
- **Desktop companion 1.0.1**: message-card overlap fix, whole-title-bar
  dragging, pnpm 11 setup repair; its 3 s poll now pulls `peer: "all"` and
  mirrors everything into SQLite, and `/history` follows the active
  conversation.
- Test suite grows to 140 checks (39 smoke + 32 setup + 11 ops +
  35 herdr control + 23 discovery).

## 0.4.0 (2026-08-14)

- **Agent discovery + declarative registry**: `agent-comm-hub setup` no
  longer hard-codes its target list — supported agents are declared in
  `agents/registry.json` (the single source of truth), and setup discovers
  which are actually installed via PATH probing (pure Node, no shell),
  config-path presence, and npm global packages (scoped dirs included).
  New `agent-comm-hub discover` prints the table without touching anything;
  `setup --agent <id>` targets a single agent. Adding a new agent is now one
  registry record + one test — no code changes.
- **New registry entries**: qwen-code (Alibaba, `~/.qwen/settings.json`,
  `httpUrl` transport) and pi (pi.dev — no config file by design, but it
  reads `~/.agents/skills` natively, so the shared skill covers it; MCP
  needs a manual extension). Amazon Q CLI / Copilot CLI / Windsurf stay
  unregistered until their remote-MCP formats are officially confirmed.
- **macOS auto-start**: `agent-comm-hub service install/uninstall` now
  supports macOS via a launchd LaunchAgent (`launchctl bootstrap`, legacy
  `load -w` fallback) — previously "not implemented".
- **CI matrix**: the test suite now runs on ubuntu / windows / macos
  instead of ubuntu only.
- Test suite grows to 138 checks (37 smoke + 32 setup + 11 ops + 35 herdr control + 23 discovery).

## 0.3.0 (2026-08-14)

- **herdr control plane (optional)**: 11 new tools drive agent terminals
  inside the herdr terminal runtime (https://herdr.dev) with physical input —
  `bridge_agent_list` / `bridge_agent_status` / `bridge_agent_prompt` /
  `bridge_agent_wait` / `bridge_agent_read` / `bridge_agent_keys` (herdr CLI)
  and `bridge_pane_list` / `bridge_pane_send` / `bridge_pane_keys` /
  `bridge_pane_read` / `bridge_pane_wait` (herdr local socket). A prompt here
  is typed into the target's terminal — slash commands (`/compact`, `/clear`,
  ...) execute in its TUI — and waiting uses herdr's real agent states
  (idle/working/blocked/done) instead of screen activity. Recognized agents
  use the agent channel; unrecognized ones (e.g. MiniMax Code) automatically
  fall back to the pane channel (`via: "agent" | "pane"` in every result).
  Optional: without herdr the tools report "herdr control not enabled" and
  the message tools keep working unchanged; `herdrControlPeers` restricts
  who may type into terminals (default `'all'`, loopback trust model).
- **DSH auto-config in `setup`**: `agent-comm-hub setup` now discovers DSH
  profiles (`~/.dsh/profiles/*/cordis.patch.yml`) and inserts the
  `@deepseek-ai/dsh-mcp-client` plugin row pointing at the hub — DSH is no
  longer a manual target. Same contract as the other targets: only the
  marked block is touched, every edit is backed up, idempotent, `--remove`
  undoes; the skill installs to `~/.dsh/skills/agent-comm-hub/` too.
- Zero new runtime dependencies: herdr CLI calls use `execFile` with verbatim
  args (no shell); the socket transport uses plain `node:net` NDJSON
  (Windows named pipe / unix socket). New config: `--herdr-bin`,
  `--herdr-timeout-ms`, and programmatic `herdrBin` / `herdrBaseArgs` /
  `herdrTimeoutMs` / `herdrSocketPath` / `herdrControlPeers`.
- Test suite grows to 110 checks (37 smoke + 32 setup + 6 ops + 35 herdr
  control against fake herdr CLI/socket fixtures).

## 0.2.0 (2026-08-14)

- **Version numbering policy**: patch rolls over at 10 (`0.1.9 -> 0.2.0`).
  This release renumbers the 0.1.13 code as 0.2.0 — no code changes.

## 0.1.13 (2026-08-14)

- SKILL's plain-language workflow section is now English (it was briefly
  added in Chinese): task delegation with wait-vs-not-wait variants and
  multi-agent real-time discussion, each paired with the exact bridge tool
  names.

## 0.1.12 (2026-08-14)

- **`update` runs npm in a throwaway child process** (`node -e`, no files on
  disk): on Windows an inline install can race the CLI's own files — npm
  reifies by moving the package directory out from under the still-running
  process (observed: npm exits 0 but files stay on the old version). The
  child lives outside the package dir, so the directory swap is uncontended;
  the parent waits for it and reports before/after versions.

## 0.1.11 (2026-08-14)

- **Fix `update` missing freshly published versions**: npm caches registry
  packuments (~5 min), so `@latest` right after a publish resolved to the old
  version. The self-update now passes `--prefer-online` to always fetch fresh
  metadata.

## 0.1.10 (2026-08-14)

- **SKILL gains a plain-language "Common workflows" section**: task delegation
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
