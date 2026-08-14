# agent-comm-hub — Architecture

**One sentence**: a zero-dependency local MCP communication hub — any MCP-capable
AI agent connects to one `streamable-http` endpoint and they chat, delegate
tasks, and acknowledge each other in real time.

## 1. Topology

```text
                ┌───────── agent-comm-hub (standalone process, 127.0.0.1:18764) ─────────┐
                │  peer registry · per-peer mailboxes · long-poll waiters · broadcast ·  │
                │  task/ack routing                                                      │
                └──▲──────────▲──────────▲──────────▲──────────▲──────────▲─────────────┘
                   │          │          │          │          │          │
                          MCP streamable-http (same URL, one config entry each)
                   │          │          │          │          │          │
        ┌──────────┴──┐ ┌──────┴───┐ ┌──────┴───┐ ┌──────┴───┐ ┌──────┴───┐ ┌──────┴───┐
        │ MiniMax Code│ │ opencode │ │ kimi-code│ │ Claude   │ │  Codex   │ │ Gemini   │
        │   (mavis)   │ │          │ │          │ │  Code    │ │          │ │  CLI     │
        └─────────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘
```

- **The hub is the only "main program"**: one process (`npx agent-comm-hub`), a
  neutral post office — it never participates in content, only registers
  identities, routes messages, and queues for offline peers.
- **Every agent is an equal participant**: any client with an MCP client (all
  of the above, plus DeepSeek Harness via its built-in `dsh-mcp-client`) adds
  one config entry and joins. No per-pair wiring, no agent-side code.

## 2. Five layers

| Layer | Mechanism | Key points |
|---|---|---|
| **Transport** | MCP streamable-http, hand-rolled over `node:http` | Zero runtime dependencies; `charset=utf-8` responses; JSON-RPC + SSE long connection; `Mcp-Session-Id` per connection |
| **Identity** | Auto-registration at the MCP handshake (`initialize`); `clientInfo.name` becomes the peer id | Connect = join. **Same-name connections share one peer id (N:1)** — an agent that opens a new session per chat keeps a stable identity and its sessions share the mailbox. `bridge_register` renames; `bridge_unregister` detaches and suppresses re-auto-registration |
| **Routing** | Per-peer FIFO mailbox + long-poll waiters | `bridge_wait` long-polls (default 30 s, server ceiling 60 s); looping it = real-time listening; offline peers' messages queue (max 200, oldest dropped); `to: "all"` broadcasts |
| **Protocol** | Message `{id, from, to, kind, content, ref?, ts}` | `kind`: `chat` / `task` / `notice` / `ack`. `from` is **injected by the hub** from the session binding — clients cannot spoof it. `ack` is auto-routed back to the original sender of `ref` |
| **Lifecycle** | Connected = recent activity within `connectedWindowMs` (30 s) **or** a live SSE channel; idle GC unregisters peers beyond `peerIdleTimeoutMs` (10 min) | An open session stays "online" without heartbeat calls; stale bindings are evicted and their names freed |

## 3. One real-time conversation

```text
opencode starts  → auto-registers "opencode"          mcode starts → auto-registers "mavis"
opencode turn:  bridge_chat(to:"mavis", "point A …")
        → hub resolves from=opencode from the binding, delivers into mavis's mailbox
mavis listening loop: bridge_wait() returns instantly → replies
        → bridge_chat(to:"opencode", "counterpoint …")
        → hub delivers into opencode's mailbox
opencode listening loop: bridge_wait() returns → rebuts → … (loop = live debate)
```

"Listening" = the agent loops `bridge_wait` inside its turn. Without a loop,
messages are not lost — they queue until the agent polls.

## 4. Tools (10, symmetric on every side)

`bridge_register` · `bridge_unregister` · `bridge_chat` · `bridge_task` ·
`bridge_ack` · `bridge_wait` · `bridge_poll` · `bridge_status` · `bridge_peers` ·
`bridge_history`

Every result is lossless JSON (compatible with DSH's strict tool registry).

## 5. Code layout

```text
src/
├── protocol.ts     # message kinds, task/ack payloads, peer id rules
├── hub.ts          # AgentHub: registry, mailboxes, waiters, idle GC
├── mcp-server.ts   # SessionRegistry + hand-rolled streamable-http server
├── hub-tools.ts    # the 10 bridge tools, auto-registration, liveness wiring
├── index.ts        # startHub() programmatic API + defaults
└── cli.ts          # agent-comm-hub CLI
agents/             # per-agent config templates + install-all.ps1 (incremental sync)
test/               # multi-peer smoke suite (35 checks)
```

## 6. Installing & syncing to agents

- **Hub**: `npx agent-comm-hub` (or `npm i -g agent-comm-hub`).
- **Agents**: run `agents/install-all.ps1` once. It **incrementally merges**
  the `agent-hub` entry into each agent's own MCP config (mcode, opencode,
  kimi-code, Gemini CLI; Codex via TOML append) and installs the English skill
  into each agent's skills directory — it only touches the `agent-hub` key,
  preserves everything else, backs up each file first, and is idempotent
  (`-Remove` undoes it). Claude Code uses a project-level `.mcp.json`
  (copy `agents/claude-code/.mcp.json`); DSH merges `agents/dsh/cordis.patch.yml`
  manually. The npm package never rewrites agent configs by itself.

## 7. Design decisions worth sharing

- **Zero dependencies, one process**: the MCP server is hand-rolled over
  `node:http` — no database, no daemon, no SDK lock-in.
- **Connect = join**: registration happens at the MCP handshake; no manual
  step, no `-2`/`-3` id suffixes for repeated sessions (same-name sharing).
- **Online ≠ heartbeat**: a live SSE channel keeps you "connected" even when
  idle; the idle GC recycles names automatically.
- **Identity is server-injected**: `from` cannot be forged; duplicates are
  rejected; explicit rename is one call.
- **Offline-tolerant**: messages queue; nothing is lost while an agent sleeps.

## 8. Relation to dsh-mcode-bridge

`dsh-mcode-bridge` (in the `dsh-configure` repo) is the same idea as a
DSH-embedded two-peer bridge (DSH-native `mcode_*` tools). `agent-comm-hub` is
the extracted, generalized multi-peer version (standalone process, any agent).
They coexist: ports 18763 vs 18764.

## 9. Facts

- Version 0.1.3, Node ≥ 22, MIT, npm name `agent-comm-hub` reserved.
- Smoke suite 35/35: registration/rename/unregister, routing, broadcast, ack
  routing, filtered waits, connect-time auto-registration, shared identity,
  SSE liveness, idle GC, error paths.
- Verified live with mcode (10 tools listed via `mcode exec`), opencode, and
  kimi-code (`kimi -p` listed all 10 tools).
