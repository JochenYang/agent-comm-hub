# Changelog

All notable changes to `agent-comm-hub-app` (desktop GUI) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-08-15

### Highlights

- **Auto-spawn hub on launch** — opening the app starts (or reuses) a local `agent-comm-hub` instance. No terminal, no flags. 4-tier PATH fall-back: sibling exe → PATH walk (incl. npm-global `.cmd` shim) → `node <main-repo>/lib/cli.js` → `npx agent-comm-hub`.
- **Live SSE keep-alive** — the Rust `McpClient` opens an MCP streamable-http SSE channel right after `initialize`. This makes `agent-hub-cli` show up as `connected: true` in `bridge_peers` for the lifetime of the app — equivalent to a long-running `bridge_wait` long-poll.
- **Three-pane main view** — peer list (online / unread) / message stream / detail (task / ack / chat). Top-bar hub state pill.
- **Markdown rendering** with rehype-sanitize (XSS-safe) + rehype-highlight (code blocks).
- **Slash command palette** (`/peers`, `/broadcast`, `/history`, `/help`, `/clear`) opened by typing `/` or `Ctrl/Cmd+K`.
- **Multi-peer cc** via chip selector in MessagesView.
- **Drag-drop attachment** for `.txt` files up to 5MB; rejected with toast if exceeded.
- **Virtual scrolling** through `@tanstack/react-virtual` — 5000 messages stay at 60fps.
- **System tray** with dynamic icon (green / grey / red), context menu (Open / Restart / Quit), close-to-tray behaviour.
- **i18n** with `zh-CN` (default) and `en-US`; user choice persisted in `localStorage`.
- **Settings panel** exposing all 12 hub CLI flags (`--host` / `--port` / `--path` / `--max-queue` / `--history-limit` / `--wait-timeout-ms` / `--default-wait-ms` / `--connected-window-ms` / `--peer-idle-timeout-ms` / `--herdr-bin` / `--herdr-timeout-ms`); per-config persistence to SQLite; "Apply & Restart" button.
- **Terminal tab** with all 11 herdr control tools (`bridge_agent_list` / `status` / `prompt` / `wait` / `read` / `keys` / `bridge_pane_list` / `send_text` / `send_keys` / `read` / `wait_for_output`) ported from `hub-tools.ts`. 200ms output throttle.

### Constraints preserved

- Zero runtime dependencies on main `agent-comm-hub` package (`dependencies: {}` in `package.json`).
- All cross-process communication goes through hub's CLI / HTTP API (and MCP streamable-http).
- `~/.claude.json` and other credential files are never touched.
- Workspace isolation via `app/pnpm-workspace.yaml` (`packages: []`).
- Tier-3 spawn fallback now walks `current_exe()` parents in 1..=6 ranges (previously fixed 3, off-by-one for debug builds).

### Verification gates

- `cargo test --lib` — 17 / 17 pass (hub_process, mcp_client, sqlite_store, herdr_client).
- `pnpm typecheck` — 0 errors.
- Hub auto-spawn verified — port 18764 LISTEN, `bridge_peers` returns `agent-hub-cli` as connected after `app_ready`.

### Known limitations

- Drag-drop currently accepts only `.txt` (and other text/* files via `FileReader.readAsText`). Binary attachments would need a Tauri-side `fs` plugin in v1.1.
- Code signing for `dmg` (notarize) and Windows EV is out-of-scope for 1.0.0 — install prompts may appear unsigned.
- Files in `app/tests/` will land in 1.0.1 along with the CI matrix workflow.
