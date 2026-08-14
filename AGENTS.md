# AGENTS.md

Guidance for AI coding agents working on **agent-comm-hub**. Read this before
editing; it explains what the project is, how it is built, and the invariants
that must not be broken. If this file conflicts with a user instruction, the
user instruction wins.

## Project overview

`agent-comm-hub` is a **generic multi-peer communication hub over MCP**: any
MCP-capable AI agent (MiniMax Code, Claude Code, opencode, Codex, Gemini CLI,
DeepSeek Harness, Kimi Code, zcode, …) connects to **one local
`streamable-http` endpoint** (`http://127.0.0.1:18764/mcp`), claims a peer id,
and then chats with, delegates tasks to, and acknowledges every other connected
agent in real time.

Key facts:

- **Zero runtime dependencies**: the MCP streamable-http server is hand-rolled
  over `node:http`. No database, no daemon, no SDK. This is the project's #1
  constraint — see [Invariants](#invariants).
- **One process**: `npx agent-comm-hub` starts the hub; it is a foreground
  process that stops on Ctrl+C (auto-start via `service install` is optional).
- **Connect = join**: the MCP handshake (`initialize`) auto-registers the
  session using the `clientInfo` name — no manual registration step.
- **Identity is server-injected**: `from` on every message comes from the
  session→peer binding, never from the caller; peers cannot impersonate each
  other. Same-name connections share one peer id (N:1) and one mailbox.
- **Offline-tolerant**: messages queue per peer (max 200, oldest dropped) and
  are delivered on the next `bridge_wait`/`bridge_poll`.
- Version `0.3.0`, Node ≥ 22, MIT license, npm name `agent-comm-hub`, package
  manager is **pnpm** (single-package repo; `pnpm-workspace.yaml` only carries
  the pnpm 10 `allowBuilds` approval for esbuild).

## Architecture

The hub is a neutral "post office": it never participates in content, only
registers identities, routes messages, and queues for offline peers. Five
layers:

| Layer | Mechanism |
|---|---|
| Transport | MCP streamable-http hand-rolled over `node:http`; JSON-RPC + SSE; `Mcp-Session-Id` per connection; `charset=utf-8` on every response; CORS `*`; 1 MB request-body cap |
| Identity | Auto-registration at `initialize`; `clientInfo.name` → peer id (sanitized, `agent` fallback); `bridge_register` renames; `bridge_unregister` detaches and suppresses re-auto-registration |
| Routing | Per-peer FIFO mailbox + long-poll waiters; `bridge_wait` (default 30 s, server ceiling 60 s); sender-filtered waits; `to: "all"` broadcast; ack routed back to the original sender of `ref` |
| Protocol | Message `{id, from, to, kind, content, ref?, ts}`; `kind` = `chat` \| `task` \| `notice` \| `ack`; task/ack payloads are JSON-encoded strings decoded by `decodeContent` |
| Lifecycle | Connected = activity within `connectedWindowMs` (30 s) **or** a live SSE channel; idle GC evicts peers idle beyond `peerIdleTimeoutMs` (10 min) — never a peer with a live SSE stream |

### Code layout

```text
src/
├── protocol.ts     # message kinds, BridgeMessage, task/ack payloads, peer id pattern
├── hub.ts          # AgentHub: registry, mailboxes, waiters, history ring, idle GC (transport-agnostic)
├── mcp-server.ts   # SessionRegistry (sessions + peer bindings) + McpStreamableHttpServer
├── hub-tools.ts    # the 16 bridge tools, auto-registration, peerId sanitizing, result presentation
├── index.ts        # startHub() programmatic API, DEFAULT_CONFIG, exports
├── cli.ts          # agent-comm-hub CLI (hub start / setup / status / service / update)
├── setup.ts        # `setup`: incremental sync of MCP entry + skill into every
│                   #   installed agent (mcode, opencode, kimi-code, gemini-cli,
│                   #   codex, zcode); nested sections via dotted paths
└── ops.ts          # `status` probe, `service install/uninstall` (Windows/Linux), `update`
agents/             # per-agent config templates (minimax-code/, claude-code/, opencode/, codex/,
                    #   gemini-cli/, kimi-code/, zcode/, dsh/) + SKILL.md (tool reference
                    #   + plain-language workflows) + install-all.ps1
test/               # smoke.mjs (multi-peer), setup.mjs (installer), ops.mjs (status)
scripts/            # release-notes.mjs (drafts GitHub release notes from CHANGELOG.md)
```

- `hub.ts` is deliberately transport-agnostic (no MCP, no HTTP imports) so the
  test suite drives it standalone.
- `herdr-ctl.ts` is the optional control adapter: it shells out to the herdr
  CLI (`execFile`, args verbatim, zero dependencies) so the hub can type into
  real agent terminals and wait on real agent state.
- `index.ts` exports everything public: `startHub`, `AgentHub`,
  `McpStreamableHttpServer`, `SessionRegistry`, `hubTools`, `HerdrCtl`, the
  bridge tool wiring, and `* from './protocol.js'`.
- The 16 tools (symmetric on every side): the 10 message tools
  (`bridge_register`, `bridge_unregister`, `bridge_chat`, `bridge_task`,
  `bridge_ack`, `bridge_wait`, `bridge_poll`, `bridge_status`, `bridge_peers`,
  `bridge_history`) plus 6 herdr control tools (`bridge_agent_list`,
  `bridge_agent_status`, `bridge_agent_prompt`, `bridge_agent_wait`,
  `bridge_agent_read`, `bridge_agent_keys`). Control tools are gated by
  `herdrControlPeers` (default `'all'`).

## Build and test commands

```bash
pnpm install          # install dev deps (typescript, esbuild, @types/node only)
pnpm typecheck        # tsc --noEmit (strict, ES2023, no emit)
pnpm test             # build:test (esbuild test entries) + node test/smoke.mjs
                      #   + test/setup.mjs + test/ops.mjs + test/herdr.mjs
                      #   → 85 checks (37+25+6+17)
pnpm run build        # esbuild → lib/{cli,index,setup}.js (zero-dependency bundle)
pnpm pack             # build + npm pack (publishing artifact)
```

- `prepublishOnly` = `pnpm test && pnpm build`; `prepare` = `pnpm build` (runs
  on install).
- CI (`.github/workflows/ci.yml`, push to `main` / PR): pnpm 10 + Node 22,
  `pnpm install --frozen-lockfile` → `typecheck` → `test` → `pack` → upload the
  tarball as an artifact.
- After any edit, run at least `pnpm typecheck` and the affected suite; before
  merging, the full `pnpm test` must stay green (verified: 37/37 + 25/25 +
  6/6 + 17/17 on Node 24 / Windows).

## Testing

- `test/smoke.mjs` (37 checks): three simulated agents over real MCP sessions
  against a live `startHub()` — registration, duplicate rejection, rename,
  chat routing, sender-filtered waits, task+ack routing back to the original
  sender, broadcast (no echo to sender), status/peers/history, unregister /
  re-register, auto-registration (first tool call, eager at connect,
  same-name sharing, unregister suppresses), SSE liveness, idle GC.
- `test/setup.mjs` (25 checks): `runSetup` against a fake home dir — only the
  `agent-hub` key is touched, unrelated config preserved, backups created,
  idempotency, `remove` uninstall.
- `test/ops.mjs` (6 checks): `runStatus` against a live hub and a dead port,
  self-exclusion and cleanup of its probe peer.
- `test/herdr.mjs` (17 checks): the bridge_agent_* control tools against a
  fake herdr CLI fixture (`test/fixtures/fake-herdr.mjs`) — results, argv
  passthrough (slash commands, keys, wait flags), error envelopes
  (agent_not_found, agent_prompt_stalled), permission gating, missing CLI.
- The `.mjs` files in `test/` are **esbuild outputs** of the `.ts` entries
  (`entry.ts`, `setup-entry.ts`, `ops-entry.ts`, `herdr-entry.ts`) and are
  gitignored — edit the `.ts` files, not the `.mjs` ones. `fake-herdr.mjs` is
  a hand-written fixture and IS committed.
- Every check uses `check(name, ok, detail)` with a behavior-description name;
  smoke tests also assert every tool result is **lossless JSON**
  (`assertLosslessJson`: no `undefined`, no non-finite numbers) — that is the
  DSH strict-tool-registry contract.

## Code style and conventions

- TypeScript **strict** (ES2023, ESM, `verbatimModuleSyntax`,
  `moduleResolution: Bundler`). Use `type` imports for types; import source
  files with the `.js` extension (`from './hub.js'`). Avoid `any`.
- Node built-ins (`node:http`, `node:crypto`, `node:fs/promises`) — no third
  party. `randomUUID()` for message ids; plain `node:http` for any HTTP client
  code in the repo.
- **Windows quirks to preserve** (both are commented at the call sites):
  - never use `fetch`/undici in process-exit paths — its keep-alive pool races
    `process.exit()` and aborts with a libuv assertion; `runStatus` uses plain
    `node:http` requests with `agent: false`;
  - `update` runs npm inside a throwaway `node -e` child — npm's reify moves
    the package directory, which races the files of the CLI running from that
    same directory (observed: npm exits 0, files stay on the old version).
- Comments explain design intent and non-obvious trade-offs (see the waiter
  settle/idempotence comment in `hub.ts` and the npm child-process comment in
  `ops.ts`); keep that density and tone. English throughout (code, README,
  ARCHITECTURE, CHANGELOG; `agents/README.md` is Chinese — do not rewrite it).
- No debug logging left behind; `log` in `startHub` is injected (`console`
  default, silenced in tests).

## Invariants (do not break)

1. **Zero runtime dependencies.** Never add a production dependency. Dev
   dependencies stay limited to what is needed to build/typecheck
   (`typescript`, `esbuild`, `@types/node`).
2. **`from` is never caller-supplied.** Message sender identity must always
   resolve from the session→peer binding (`requirePeer` / `autoRegisterPeer`).
3. **Lossless JSON everywhere.** Every tool result goes through
   `present()`/`receipt()`: drop `undefined` fields, keep numbers finite —
   DSH's strict tool registry rejects lossy values.
4. **Peer ids are validated** against `^[A-Za-z0-9._:-]{1,64}$` before any
   registration; unregistered callers get a clear error.
5. **`SERVER_VERSION` in `src/index.ts` must match `package.json` version.**
6. **`setup`/`install-all.ps1` never rewrite agent configs destructively**:
   only the named `agent-hub` key is touched, every modified file is backed up
   (`<file>.bak-<timestamp>`), written UTF-8 without BOM, idempotent, and
   missing configs are skipped (never created). `~/.claude.json` is **never**
   touched (contains credentials) — Claude Code stays manual via project
   `.mcp.json`.
7. **CHANGELOG.md is hand-written** (user-facing behavior descriptions, not
   commit logs) and feeds `scripts/release-notes.mjs`. Version bumps follow
   `package.json` + `SERVER_VERSION` + a CHANGELOG entry. Version numbering
   convention: patch rolls over at 10 (`0.1.9 → 0.2.0`).

## Security considerations

- The hub binds to `127.0.0.1` by default and has **no authentication** — do
  not expose the port publicly without adding a token/proxy layer.
- Never put credentials in bridge messages (plaintext on loopback).
- Message routing validates senders (must be registered) and recipients
  (`unknown recipient` error); acks validate `ref` against history and
  `status` against the enum.
- Request bodies are capped at 1 MB (`MAX_BODY_BYTES`).
- `setup` writes into user home agent configs and skills dirs — this is why
  backup-before-write, key-scoped edits, and idempotency are non-negotiable.

## Release / deployment notes

- Publishing happens through `pnpm publish` (npm); `prepublishOnly` gates on
  the full test suite + build. Release flow: `git tag vX.Y.Z && git push
  origin vX.Y.Z`, draft notes with `node scripts/release-notes.mjs <prevTag>
  <curTag>`, then `gh release create <tag> --notes-file -` (or `gh release
  edit` to rewrite).
- The npm package ships `lib/`, `agents/`, `assets/`, `README.md` (`files` in
  `package.json`) — the shipped `agents/SKILL.md` is the default skill source
  for `setup`.
- End users update in place via `agent-comm-hub update` (reinstalls
  `agent-comm-hub@latest` globally, keeping the auto-start launcher valid).
- Doc files (README.md / README.zh.md / ARCHITECTURE.md) mention stale check
  counts and version numbers occasionally — when you change the suite or bump
  the version, update them to match reality.
