# agent-comm-hub-app

Desktop GUI for [agent-comm-hub](https://github.com/JochenWork/agent-comm-hub) — a multi-peer MCP hub. Tauri 2 + React + TypeScript + Rust. Zero runtime dependencies on the main `agent-comm-hub` package (which stays a zero-dep CLI / MCP server).

## What it does

- **Auto-spawn hub**: opening the app starts (or connects to) a local `agent-comm-hub` instance. No terminal, no flags.
- **Peer list with online/offline indicator**: see every registered peer at a glance; unread badge per peer.
- **Three-pane main view**: peers (left) / messages (center) / detail (right). Status pill in the top bar.
- **Send chat / task / ack** as `agent-hub-cli`: Markdown + code highlighting (rehype-highlight).
- **Markdown rendering**: GFM tables / fenced code / lists. Sanitized via rehype-sanitize.
- **`/` slash commands**: `/peers`, `/broadcast`, `/history`, `/help`, `/clear`. `Ctrl/Cmd+K` opens the palette.
- **Multi-peer cc**: chip-select additional recipients and fan-out via `bridge_chat`.
- **Drag-drop attachment**: drop a `.txt` file (≤5MB) onto the input — content is appended as a text block.
- **Virtual scrolling**: 5,000 messages stay at 60fps via `@tanstack/react-virtual`.
- **Settings panel**: 12 hub config fields, persisted to SQLite, with one-click "Apply & Restart".
- **Terminal tab**: 11 herdr control tools (`bridge_agent_*` / `bridge_pane_*`) for driving real agent TTYs.
- **System tray**: app stays alive when the window closes; dynamic green / grey / red icon reflects hub state.
- **i18n**: 中文 (default) / English. Settings → language. Persists in localStorage.
- **Keyboard shortcuts**: `Ctrl+K` palette, `Ctrl+,` settings, `Ctrl+Enter` send, `Escape` back-to-main.

## Stack

| Layer | Choice | Notes |
|---|---|---|
| Shell | Tauri 2 | hand-rolled over `node:http`/`tao`; `tint`, `png`, `reqwest`, `tokio`, `rusqlite (bundled)`. No 3rd-party MCP SDK. |
| Frontend | Vite + React 18 + TypeScript | strict, no React Router (3-tab segmented control), zustand stores. |
| UI primitives | shadcn/ui + `class-variance-authority` + `tailwindcss-animate` | self-rolled Button/Card. |
| Theme | Tailwind v3 + custom CSS vars (Zinc + Cyan) | devtool / terminal aesthetic; 6px radius lock. |
| Markdown | react-markdown + remark-gfm + rehype-sanitize + rehype-highlight | XSS-safe. |
| Virtualization | @tanstack/react-virtual | 5000-message scroll. |
| State | zustand | one store per concern (hub, peers, messages). |
| i18n | react-i18next | bundled `zh-CN` / `en-US`. |
| Persistence | SQLite (rusqlite bundled) | `%APPDATA%/agent-comm-hub-app/store.sqlite` |
| Tray | tauri tray-icon API | 3 PNGs (green / grey / red) decoded via `png` crate. |

## Install / run

```bash
pnpm install
pnpm tauri:dev      # dev with HMR
pnpm tauri:build    # three-platform installer (NSIS / dmg / AppImage+deb)
```

Requires Rust ≥ 1.97 and Node ≥ 22. On Windows, install WebView2 once (Win10+ ships it).

## Architecture

```
Tauri main (Rust)
  hub_process.rs        spawn / stop / restart + port probe + 500-line log ring
  mcp_client.rs         zero-dep streamable-http + SSE (initialize + tools/call + notifications)
  herdr_client.rs       herdr CLI + socket (11 control tools)
  sqlite_store.rs       WAL, peer / message / config / unread tables, v1 migration
  commands.rs           tauri invoke_handler — 22 + handlers exposed to the frontend
  lib.rs                tray + app handle + setup

Vite (React 18 + TS)
  views/PeersView       online/offline dot, unread badge
  views/MessagesView    virtual list + input area (drag/drop + cc chips + palette trigger)
  views/DetailView      task / ack / chat branches (Markdown for chat)
  views/SettingsView    12 hub fields + Restart + language switcher
  views/TerminalView    agent/pane tabs, 200ms output throttle
  views/LogsView        stdout/stderr poller, 500ms
  components/CommandPalette   /-prefixed commands + Ctrl+K
  components/ui/*       self-rolled shadcn-style primitives
  stores/*              zustand stores (hubStore, peersStore, messagesStore)
  lib/tauri.ts          typed thin wrapper over @tauri-apps/api
  lib/markdown.tsx      Markdown component (GFM + hljs + sanitize)
  i18n/                 zh-CN.json + en-US.json + init
```

## Auto-spawn hub: how it works

1. Frontend `useEffect` calls `invoke('app_ready')`.
2. `commands::app_ready` → `state.hub.start()` → 4-tier PATH walk:
   - sibling `<exe>-dir/agent-comm-hub(.exe)`
   - PATH walk for `agent-comm-hub` (npm-global `.cmd` shim on Windows)
   - `node <main-repo>/lib/cli.js` (debug builds find it by walking up from `current_exe()`)
   - `npx agent-comm-hub`
3. Port-ready probe (10s, 100ms interval).
4. `McpClient::initialize` over MCP streamable-http → registers `agent-hub-cli` peer.
5. `McpClient::subscribe_notifications` opens the SSE GET stream. This is what keeps `agent-hub-cli` visible as `connected: true` in `bridge_peers` — the hub marks any session with an open SSE channel as "live".

## Configuration

12 fields, persisted under `%APPDATA%/agent-comm-hub-app/store.sqlite` in the `config` table:

`host`, `port`, `path`, `max_queue`, `history_limit`, `wait_timeout_ms`, `default_wait_ms`, `connected_window_ms`, `peer_idle_timeout_ms`, `herdr_bin`, `herdr_timeout_ms`.

"Apply" in Settings writes them; "Apply & Restart" restarts the hub child with the new argv. Hub CLI parser expects space-separated `--flag value`, never `--flag=value`.

## Keyboard

| Key | Action |
|---|---|
| `Ctrl/Cmd+K` | Open command palette |
| `Ctrl/Cmd+,` | Settings tab |
| `Ctrl/Cmd+Alt+M` | Main tab |
| `Ctrl/Cmd+Alt+T` | Terminal tab |
| `Ctrl/Cmd+Alt+S` | Settings tab |
| `Escape` | Close palette / back to main |
| `Enter` (input) | Send |
| `Ctrl/Cmd+Enter` (input) | Force send |
| `/` (empty input) | Open palette |

## Tests

```bash
# Rust unit tests
cd src-tauri && cargo test --lib    # 17 tests, hub_process + mcp_client + sqlite_store + herdr_client

# TS type-check
cd app && pnpm typecheck             # 0 errors

# Build (compiles into a real installer)
cd app && pnpm tauri:build           # NSIS + deb + AppImage + dmg
```

## Workspace isolation

`app/` is its own pnpm + Cargo workspace:

- `app/pnpm-workspace.yaml` declares `packages: []` so pnpm never hoists into the main repo.
- `app/src-tauri/Cargo.toml` lists 4 runtime crates (`tauri`, `tokio`, `reqwest`, `rusqlite`) — never reaches back to `dependencies: {}` in the main `package.json`.
- All MCP / hub I/O goes through hub's CLI / HTTP API, never via direct source imports.

## License

MIT
