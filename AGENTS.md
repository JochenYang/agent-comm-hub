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
- Version `0.11.0`, Node ≥ 22, MIT license, npm name `agent-comm-hub`, package
  manager is **pnpm** (single-package repo; `pnpm-workspace.yaml` only carries
  the pnpm 10 `allowBuilds` approval for esbuild). The one exception is the
  `admin/` web-console workspace, which uses **npm** (its own
  `package-lock.json`) and is driven from here by `npm --prefix admin run
  build`.

## Architecture

The hub is a neutral "post office": it never participates in content, only
registers identities, routes messages, and queues for offline peers. Five
layers:

| Layer | Mechanism |
|---|---|
| Transport | MCP streamable-http hand-rolled over `node:http`; JSON-RPC + SSE; `Mcp-Session-Id` per connection; `charset=utf-8` on every response; **`Origin` gate** (no Origin / loopback / `--allow-origins` / same-host **with a bearer token**; anything else 403) and CORS that echoes an allowed origin instead of `*`; 1 MB request-body cap |
| Identity | Auto-registration at `initialize`; `clientInfo.name` → peer id (sanitized, `agent` fallback); `bridge_register` renames; `bridge_unregister` detaches and suppresses re-auto-registration |
| Routing | Per-peer FIFO mailbox + long-poll waiters; `bridge_wait` (default 30 s, server ceiling 60 s); sender-filtered waits (`from: "hub"` always passes — a hub notice bypasses `from`, `ref`, `statuses` and `terminalOnly`; a `threadId` wait does still narrow it, like any other message); `ref`-filtered waits that match an `ack` **or** the `chat` an assignee hands its result back in (a `chat` whose `ref` is a known task is only accepted from that task's sender or one of its assignees — task ids leak through `bridge_events`, so the ledger is what keeps a third party from answering the wait), optionally narrowed by `statuses` / `terminalOnly` (both filter the ack half only: a chat has no status, so it never satisfies them; the two narrow each other, and an always-empty combination is refused at the tool boundary rather than silently waiting out the timeout); a `bridge_wait` timeout carries the ledger snapshot of its `ref` only when the caller is that task's sender or one of its assignees; `to: "all"` broadcast; ack routed back to the original sender of `ref` |
| Protocol | Message `{id, seq, from, to, kind, content, ref?, channel?, threadId?, hop?, priority?, expiresAt?, ts}`; `priority` (0\|1\|2, absent = 0) orders the recipient's mailbox and decides what overflow drops (the LEAST important message, oldest first within a priority — unchanged from "oldest dropped" when nobody sets one); `kind` = `chat` \| `task` \| `notice` \| `ack`; the SSE push contract (`SSE_METHOD` / `SSE_EVENT_PEERS_CHANGED` / `SSE_EVENT_MESSAGE` / `SSE_EVENT_TASK_CHANGED`) lives in `src/protocol.ts`, and the desktop's Rust side mirrors the two it consumes (`peers_changed` / `message`) while `task_changed` reaches it as an unknown event its catch-all dispatcher ignores; task/ack/notice payloads are JSON-encoded strings decoded by `decodeContent`; every message carries a monotonic `seq` (never restarts — see `bridge_history { since }`) and may carry an absolute `expiresAt` (dropped and counted as `droppedExpired` instead of delivered late); `bridge_task` records a task ledger (status + ack timeline) with per-assignee delivery times; `ref` chains carry a `hop` depth that persists with the message (a restart cannot reset a chain) and is **counted, not enforced** — two ceilings, `MAX_HOP` (5) for a task re-delegation and `MAX_REPLY_CHAIN` (50) for a plain reply, past which `hop` simply stops counting; the message and its `ref` are always delivered |
| Delivery | Per-peer mailbox with `maxQueue`; overflow is **counted** (`droppedOverflow`) rather than silent, and a waiting peer gets a `notice` from the reserved id `hub`. An optional per-peer token bucket (`ratePerMin`, 0 = off) limits how fast a mailbox ACCUMULATES — it guards the recipient against a broadcast storm and counts excess as `droppedRate` (no notice is queued for a rate drop, or the notices would fill the mailbox just as fast). Manual-ack leases (`ack: "manual"` + `bridge_commit`/`bridge_nack`, `leaseTtlMs`, `maxAttempts`) give at-least-once handling: an uncommitted lease is exported with the mailbox (inside the peer's queue array — no extra top-level key, so an older hub reads it as ordinary queued mail and redelivers it once) and comes back after a restart. **EVERY lease is exported, expired or not**: the snapshot records what the hub handed out, and expiry is decided by the consumer (`poll`/`wait`/`reapLeases`), because filtering on `expiresAt` here left an un-reaped expired lease in neither the queue nor the snapshot. **`attempts` does NOT survive a restart** (the counter is memory-only), so `maxAttempts` bounds a message per PROCESS, not per lifetime, and a message that was requeued competes for a mailbox slot like arriving mail — whatever does not fit is dead-lettered rather than dropped; dead letters are one bounded list per peer (`MAX_DEAD_LETTERS` 200, oldest evicted **and counted**); `attempts`/`inFlight`/`deadLettered`/`droppedOverflow`/`droppedExpired`/`droppedRate` are visible in the roster |
| Lifecycle | Connected = activity within `connectedWindowMs` (30 s) **or** a live SSE channel; idle GC **parks** peers idle beyond `peerIdleTimeoutMs` (10 min) — the peer leaves the connected set as `reachable: "parked"` but keeps its mailbox and stays addressable; parked mail drops only after `parkedTtlMs` (7 days). An explicit `bridge_unregister` or a manager kick drops both the mailbox and the addressability |

### Code layout

```text
src/
├── protocol.ts     # message kinds, BridgeMessage, task/ack payloads, peer id pattern
├── hub.ts          # AgentHub: registry, mailboxes, waiters, history ring, task ledger, idle GC (transport-agnostic)
├── mcp-server.ts   # SessionRegistry (sessions + peer bindings) + McpStreamableHttpServer
├── hub-tools.ts    # the 39 bridge tools, auto-registration, peerId/alias sanitizing, profiles, result presentation
├── auth.ts         # remote-mode bearer-token table (load/validate/lookup)
├── persist.ts      # SQLite state store (node:sqlite): history ring, offline
│                   #   mailboxes, profiles, groups, task ledger (remote mode)
├── index.ts        # startHub() programmatic API, DEFAULT_CONFIG, exports
├── cli.ts          # agent-comm-hub CLI (hub start / setup / discover / status / service / update)
├── setup.ts        # `setup`: registry-driven incremental sync of MCP entry +
│                   #   skill into every discovered agent (strategies: json /
│                   #   toml / dsh; nested sections via dotted paths)
├── discover.ts     # agent discovery + registry load/validation (PATH probing,
│                   #   config paths, npm global; platform-injectable)
├── herdr-ctl.ts    # optional herdr control adapter (agent CLI + pane socket)
├── runner.ts       # executors for peers that are NOT polling: `cli` (execFile)
                    #   and `herdr` (type into a pane); outcome -> the peer's ack
└── ops.ts          # `status` probe, `service install/uninstall` (Windows /
                    #   Linux / macOS launchd), `update`
agents/             # per-agent config templates + registry.json + SKILL.md
                    #   (declarative agent support — the single
                    #   source of truth for setup/discover)
admin/              # web console workspace (Vite + React + Tailwind + beui
                    #   components). Built with npm, not pnpm, by
                    #   `npm run build:admin` → the single-file assets/admin.html
                    #   that src/mcp-server.ts serves at /admin
server/             # remote-deployment assets: token-table template, LAN/VPS
                    #   recipes, Caddy TLS example (see server/README.md)
test/               # smoke.mjs (multi-peer), setup.mjs (installer),
                    #   ops.mjs (status + service), herdr.mjs (control),
                    #   discover.mjs (discovery engine), e2e.mjs (built CLI)
scripts/            # release-notes.mjs (drafts GitHub release notes from CHANGELOG.md)
                    #   manual/ = one-off probes and herdr driver scripts, NOT run by
                    #   CI and NOT covered by assertions (see manual/README.md)
```

- `hub.ts` is deliberately transport-agnostic (no MCP, no HTTP imports) so the
  test suite drives it standalone.
- `herdr-ctl.ts` is the optional control adapter: it shells out to the herdr
  CLI (`execFile`, args verbatim, zero dependencies) so the hub can type into
  real agent terminals and wait on real agent state.
- `discover.ts` never executes anything found on PATH — it only probes
  existence (`fs.accessSync`) and reads directory names; all platform
  semantics (PATH separator, PATHEXT, npm roots) are injectable for tests.
- `index.ts` exports everything public: `startHub`, `AgentHub`,
  `McpStreamableHttpServer`, `SessionRegistry`, `hubTools`, `HerdrCtl`, the
  bridge tool wiring, and `* from './protocol.js'`.
- Task SLA timers (`hub.ts`) are re-armed in segments of at most 2^31−1 ms:
  `setTimeout` saturates at that delay, and a bigger one fires after ~1 ms
  instead (marking a fresh task `timeout` on the spot). `deadlineAt` stays the
  authoritative deadline, so a multi-day `timeoutMs` is honored exactly; the
  `bridge_task` tool description states the same contract (no upper bound).
- The 39 tools (symmetric on every side): the 22 message + observability tools
  (`bridge_register`, `bridge_unregister`, `bridge_rename`, `bridge_chat`,
  `bridge_notice`, `bridge_task`, `bridge_ack`, `bridge_wait`, `bridge_poll`,
  `bridge_commit`, `bridge_nack`, `bridge_status`, `bridge_peers`,
  `bridge_history`, `bridge_tasks`, `bridge_task_status`, `bridge_task_cancel`,
  `bridge_task_input`, `bridge_announce`, `bridge_discover`,
  `bridge_metrics`, `bridge_events`),
  6 group tools (`bridge_group_create`, `bridge_group_send`,
  `bridge_group_list`, `bridge_group_delete`, `bridge_group_add_member`,
  `bridge_group_remove_member`),
  6 herdr agent tools (`bridge_agent_list`,
  `bridge_agent_status`, `bridge_agent_prompt`, `bridge_agent_wait`,
  `bridge_agent_read`, `bridge_agent_keys`) and 5 herdr pane tools
  (`bridge_pane_list`, `bridge_pane_send`, `bridge_pane_keys`,
  `bridge_pane_read`, `bridge_pane_wait`). Control tools are gated by
  `herdrControlPeers` (default `'all'`) and error out when herdr is not
  enabled — the message tools keep working regardless. Roster management
  (bridge_rename of others, manager kick) is gated by `managerPeers`
  (default `['agent-hub-cli', 'hub-admin']` — desktop GUI + web admin);
  the peer id stays
  the immutable routing key while the alias is a mutable display name held in
  `AgentHub.profiles` (survives unregister/GC). `bridge_rename { peerId }`
- `bridge_rename { peerId }` true-renames a registered peer (atomic re-key incl. history rewrite, in-flight manual leases and dead letters);
  `bridge_register` self-rename uses the same lossless path when its session
  is the only one attached. Other-peer history reads and
  `bridge_tasks { peer }` are manager-gated. `bridge_task_status` is open to
  the sender and to the task's assignees — a group task carries the group id
  in `to`, so its assignees read it through their assignee row (or as current
  group members) exactly as `bridge_tasks` lists it for them. Hub
  pushes SSE notifications:
  `peers_changed` (full roster) to all streams, `message` (queued-mail hint)
  to the recipient's streams only, and `task_changed`
  (`{taskId, status, a2aState, updatedAt}`) to the task's sender plus its
  assignees — deliberately neither a broadcast nor part of the manager relay: a
  task is a private arrangement, and a manager loses nothing because every
  transition is caused by an ack (relayed) or a hub timer (readable through
  `bridge_tasks`/`bridge_events`). It fires only on a REAL status change, so the
  stream is not an echo of every `working` beat.
- **Peer ids and group ids share one `to` namespace, mutually exclusive.** A
  group is resolved before a peer, so a group wearing a peer's id would turn
  every unicast to that peer into a fan-out (and every task into a group task).
  `register`/`renamePeer` refuse an id a group owns (and refuse parked ids
  unless the caller reclaims them), `createGroup` refuses a live or profiled
  peer's id, and `importMailboxes` applies the same rule to a restored state
  file (external input). `all` and `hub` are reserved on both sides; a client
  whose `clientInfo.name` sanitizes into one of them falls back to
  `agent-<random>` instead of failing to connect.
- **A dropped message does NOT write a terminal ledger state.** Per-drop
  reconciliation records a `system: true, applied: false` event naming the
  message/task and sends the task's sender a `from: "hub"` notice, and the task
  stays as it was. The reason is that neither path is final: a dead letter can be
  revived by `bridge_nack` (a terminal write made the revived assignee's `done`
  land as `applied: false`), and overflow/rate can be driven by a third party
  (≈200 chat messages could otherwise veto any pending task). Only a peer that
  cannot come back — `unregister`/kick, or a parked mailbox reaching
  `parkedTtlMs` — settles a task as terminal, because no completion path remains.

## Build and test commands

```bash
pnpm install          # install dev deps (typescript, esbuild, @types/node only)
pnpm typecheck        # tsc --noEmit (strict, ES2023, no emit)
pnpm test             # build + build:test (esbuild), then node test/smoke.mjs
                      #   + test/setup.mjs + test/ops.mjs + test/herdr.mjs
                      #   + test/discover.mjs + test/e2e.mjs → 446 checks
                      #   (286+46+11+35+33+35)
npm run build:admin   # admin/ (npm, not pnpm) → the single-file assets/admin.html
pnpm run build        # esbuild → lib/{cli,index,setup}.js (zero-dependency bundle)
pnpm pack             # build + npm pack (publishing artifact)
```

- `prepublishOnly` = `npm run build:admin && pnpm test && pnpm build`;
  `prepare` = `pnpm build` (runs on install). The admin console is a **separate
  npm workspace** under `admin/` with its own `package-lock.json` — never
  convert it to pnpm, and never let `admin/` leak into this package's
  `dependencies` (invariant 1). `assets/admin.html` is a committed build
  artifact, so `build:admin` must run before packaging or the tarball ships a
  stale console.
- CI (`.github/workflows/ci.yml`, push to `main` / PR): pnpm 10 + Node 22 on
  an **ubuntu / windows / macos matrix**, `pnpm install --frozen-lockfile` →
  `typecheck` → `test` → `pack` → upload the tarball as an artifact.
- After any edit, run at least `pnpm typecheck` and the affected suite; before
  merging, the full `pnpm test` must stay green (verified: 286/286 + 46/46 +
  11/11 + 35/35 + 33/33 + 35/35 on Node 24 / Windows).

## Testing

- `test/smoke.mjs` (286 checks): three simulated agents over real MCP sessions
  against a live `startHub()` — registration, duplicate rejection, rename,
  chat routing, sender-filtered waits, task+ack routing back to the original
  sender, task delivery bookkeeping (`deliveredMs` for both the waiter handoff
  and the mailbox path), broadcast (no echo to sender, recorded exactly once in history),
  status/peers/history incl. the
  `peer: "all"` unfiltered archiver view, unregister /
  re-register, auto-registration (first tool call, eager at connect,
  same-name sharing, unregister suppresses), SSE liveness, idle GC,
  profiles/aliases/manager ops (roster metadata, manager rename + kick,
  non-manager denial, alias persistence/routing), SSE event push
  (peers_changed on join/alias edit, recipient-scoped mail hint), true
  rename (manager re-key: queued mail / ack / history continuity, old id
  unroutable, taken/reserved rejection; lossless self id-rename via
  bridge_register), history access gate (non-manager denied other-peer and
  peer="all" reads), group-task assignee reads of `bridge_task_status`
  (non-assignee still manager-gated), the task state machine (`working` +
  progress, terminal lock with `applied: false`, `timeoutMs` → `timeout`,
  multi-day `timeoutMs` staying pending, ack routing after
  history eviction, reply-chain depth incl. survival across a SQLite
  restart, `threadId` waits), roster
  persistence (stateFile write + restore), remote auth (401 without/unknown
  token, token identity overrides the
  client name, same-name users land on distinct peers with no mailbox
  leak, token-bound rename rejection, manager-role token ops), and the
  ack/ledger integrity block: only an assignee may move a task ledger
  (non-assignee ack rejected, a broadcast task's other recipients keep their
  own state), every drop path (rate / overflow / expiry / dead letter) recorded
  as a `system` event that leaves the task open plus one `from: "hub"` notice to
  the sender (a fan-out warns once, not once per recipient), unregister and
  parked-TTL settling as `failed`, `deliveredMs` never booked on a drop, a
  dead-lettered task still completable after `bridge_nack`, lease accounting
  that cannot be reset or outgrow `maxQueue`, a requeued lease competing for a
  slot, dead-letter eviction settling the task it destroys, the per-assignee
  ack-timeline cap keeping the drop evidence, reserved ids (`all` / `hub`) on
  every entry point, the shared id namespace (a group's id or a parked mailbox
  is not claimable by a peer, and a peer's id is not claimable by a group),
  `bridge_tasks` filtering on the full status list,
  `bridge_wait { terminalOnly / statuses }` (a chat reply never satisfies a
  status filter, an unknown status is rejected) with the skipped intermediate
  ack still in the
  mailbox, the `task_changed` push reaching the sender and the assignee but not
  a third party, and the timeout snapshot carrying the task's ledger status.
- `test/setup.mjs` (46 checks): `runSetup` against a fake home dir — only the
  `agent-hub` key is touched, unrelated config preserved, backups created,
  idempotency (a re-run must report it changed NO file — backup-name counting
  cannot prove this, see the comment there), `remove` uninstall, DSH patch block
  insert/url-change/remove,
  duplicate-entry healing (markerless hub entries collapse to one).
- `test/ops.mjs` (11 checks): `runStatus` against a live hub and a dead port,
  self-exclusion and cleanup of its probe peer, plus per-platform service
  `--dry-run` output (win32 / linux / darwin).
- `test/herdr.mjs` (35 checks): the bridge_agent_* and bridge_pane_* control
  tools against a fake herdr CLI + fake socket fixture
  (`test/fixtures/fake-herdr.mjs`) — results, argv passthrough, error
  envelopes, smart fallback (agent vs pane channel), permission gating,
  missing CLI.
- `test/discover.mjs` (33 checks): registry load/validation (bad records
  rejected), `~`/wildcard expansion, PATH probing (win32 PATHEXT vs POSIX
  semantics), config-path discovery, npm-global discovery incl. scoped dirs,
  os filtering, source priority.
- `test/e2e.mjs` (35 checks): end-to-end against the REAL built CLI
  (`lib/cli.js`) spawned as a subprocess — /healthz, MCP sessions, SSE push
  timeliness (message reaches passive listeners before any poll), heartbeat
  via `--heartbeat-ms`, task/ack, broadcast, groups, SQLite persistence
  across a real process restart, and remote-auth mode (401s, token identity,
  manager gating). The restart cases now cover the durability half of the
  ledger and mailbox: an uncommitted manual lease is handed out again with the
  same message id (and is not a dead-letter revival), an expired lease nobody
  ever reaped still comes back as ordinary queued mail, an `input-required`
  task is still answerable after a restart, and `priority` order survives one.
  Hand-written and committed like the other suites.
- Only the `test/*-entry.mjs` files are **esbuild outputs** of the `.ts`
  entries (`entry.ts`, `setup-entry.ts`, `ops-entry.ts`, `herdr-entry.ts`,
  `discover-entry.ts`) and are gitignored — edit the `.ts` files, not the
  `.mjs` ones. The suite files themselves (`smoke.mjs`, `setup.mjs`,
  `ops.mjs`, `herdr.mjs`, `discover.mjs`) and `fake-herdr.mjs` are
  hand-written and committed.
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
6. **`setup` never rewrites agent configs destructively** (the deprecated
   `agents/install-all.ps1` shim forwards to it, so the same contract applies):
   only the named `agent-hub` key is touched, every modified file is backed up
   (`<file>.bak-<timestamp>`), written UTF-8 without BOM, idempotent, and
   missing configs are skipped (never created).
   **Files that hold credentials are never written to**, not even key-scoped:
   `~/.claude.json`, `~/.dsh/.credentials.yaml`, `~/.dsh/settings.yaml`,
   `~/.codex/auth.json`, `~/.qwen/mcp-oauth-tokens.json`. A merge into one of
   these would have to round-trip the whole file (rewriting the credential blob)
   and every read of it lands the secret in the process's memory and in any
   backup we make. Where an agent's MCP config lives only in such a file, that
   agent stays MANUAL: the registry points at a separate, non-credential file
   (`~/.claude.json` → project `.mcp.json`), or the agent has no config entry at
   all. Adding one of these paths to `agents/registry.json` is a bug.
7. **Agent support lives in `agents/registry.json`**, not in code: adding an
   agent is a registry record + a test. The registry is validated at load
   time; config paths are `~`-relative and must not contain `..`; the
   discovery engine never executes anything it finds.
8. **CHANGELOG.md is hand-written** (user-facing behavior descriptions, not
   commit logs) and feeds `scripts/release-notes.mjs`. Version bumps follow
   `package.json` + `SERVER_VERSION` + a CHANGELOG entry. Version numbering
   convention: **decimal carry, one digit per segment — a segment that would
   reach 10 carries instead** (`0.1.9 → 0.2.0`, `0.8.9 → 0.9.0`,
   `0.9.9 → 1.0.0`). Within a segment: a patch/fix is `+1`
   (`0.9.0 → 0.9.1`), a new capability or protocol extension carries one
   segment (`0.8.x → 0.9.0`).

## Security considerations

- The hub binds to `127.0.0.1` by default. Loopback is **not** an authentication
  boundary: without `--auth-tokens` any local client is trusted (that is the
  desktop trust model) and any browser page used to be able to talk to it —
  now blocked by the `Origin` gate, but the gate is a guard, not credentials.
  Do not expose the port beyond the host without a token table.
- **`--host` beyond loopback is refused unless `--auth-tokens` is set** (or
  `--insecure` is passed deliberately). The guard is enforced in `startHub`,
  not just documented.
- **Manager privileges need a credential once one is configured**: with
  `--manager-token` (or `<stateFileDir>/manager.token`), roster edits, kicks,
  `peer: "all"` history and the SSE relay require it. The peer id itself is
  never reserved (the desktop GUI identifies as `agent-hub-cli`), so claiming
  a manager id still takes the identity and mailbox — only the power is gated.
- **`Origin` gate**: a request carrying an `Origin` other than a loopback one
  or an `--allow-origins` entry is rejected with 403, unless it also presents a
  bearer token and its origin host matches `Host`. The MCP spec makes validating
  `Origin` a MUST (DNS rebinding).
- **Tokens are plaintext on disk**: `tokens.json` and `manager.token` are
  credentials — `chmod 600` them, never commit them, and note that the bundled
  `server/tokens.example.json` placeholders are rejected at load on purpose.
- Never put credentials in bridge messages (plaintext on loopback).
- Message routing validates senders (must be registered) and recipients
  (`unknown recipient` error); acks validate `ref` against history and
  `status` against the enum.
- Request bodies are capped at 1 MB (`MAX_BODY_BYTES`).
- `setup` writes into user home agent configs and skills dirs — this is why
  backup-before-write, key-scoped edits, and idempotency are non-negotiable.

## Release / deployment notes

### Version numbering

Decimal carry, one digit per segment — a segment that would reach 10 carries
instead: `0.1.9 → 0.2.0`, `0.8.9 → 0.9.0`, `0.9.9 → 1.0.0`. Within a segment,
a patch/fix is `+1` (`0.9.0 → 0.9.1`); a new capability or protocol extension
carries one segment (`0.8.x → 0.9.0`).

### Release SOP (run in order)

1. **Pre-flight — all four must be clean before anything else:**
   - `pnpm typecheck` — no errors.
   - `pnpm test` — every suite green; record the real per-suite counts.
   - `npm run build:admin` — the `admin/` workspace (Vite + React) must
     rebuild `assets/admin.html` **before** any packaging build, otherwise the
     tarball ships the previous console.
   - `pnpm pack` — inspect the tarball contents (`tar -tzf
     agent-comm-hub-<version>.tgz`) for `lib/`, `agents/`, `assets/admin.html`,
     `package.json`, `README.md`.
2. **Bump the version in three places, in sync:**
   - `package.json` `version`
   - `SERVER_VERSION` in `src/index.ts` (invariant 5). Nothing enforces this
     pairing automatically — the suites only exercise `/healthz` and MCP
     handshakes — so compare the two by hand before tagging:
     `grep -n '"version"' package.json && grep -n 'SERVER_VERSION = ' src/index.ts`
     (both must print the same `X.Y.Z`);
   - a new `CHANGELOG.md` entry at the top: `## X.Y.Z (YYYY-MM-DD)`, English,
     user-facing, one bullet per change — never edit `app/CHANGELOG.md`, the
     desktop app version is independent.
3. **Sync the docs to reality** (these drift every release):
   - test check counts and the total — `grep -rInE "[0-9]+(-check| checks|
     项|/[0-9]+)" README.md README.zh.md ARCHITECTURE.md AGENTS.md`
     (README.md ×2, README.zh.md, ARCHITECTURE.md §9, AGENTS.md ×6)
   - the bridge tool count — `grep -c "^      name: 'bridge_" src/hub-tools.ts`
     (also stated in `ARCHITECTURE.md` §4 and the AGENTS.md code-layout note)
   - the `managerPeers` default — `grep -rIn "managerPeers\|manager-peers"
     src/index.ts src/cli.ts README.md README.zh.md ARCHITECTURE.md`
     (the `--help` text in `src/cli.ts` prints the same
     `agent-hub-cli,hub-admin` default as `DEFAULT_CONFIG.managerPeers` — keep
     both in sync whenever the default changes)
   - every version occurrence — `grep -rn "<old version>" --include='*.md'
     --include='*.json' --include='*.ts' .` (`package.json`, `src/index.ts`,
     `CHANGELOG.md`, `README*.md`, `ARCHITECTURE.md`); ignore `test/*-entry.mjs`
     and `app/**/target/**`, which are generated.
4. **Tag and publish** (each command below is an explicit, authorized release
   action — see the rule at the end of this section):
   - `git tag vX.Y.Z && git push origin vX.Y.Z`
   - `node scripts/release-notes.mjs <prevTag> <curTag>` to draft the notes
     from the new CHANGELOG section, then
     `gh release create <tag> --notes-file -`, or `gh release edit` to rewrite
     an existing release.
   - `pnpm publish` — `prepublishOnly` already chains
     `npm run build:admin && pnpm test && pnpm build`, so it cannot publish a
     stale console, a red suite, or an unbuilt bundle.

### Notes

- **Release actions require explicit user authorization.** Committing, pushing,
  tagging, creating/editing a GitHub release, and `pnpm publish` are never done
  on the agent's own initiative — prepare and verify, then stop and ask.
- The npm package ships `lib/`, `agents/`, `assets/`, `README.md` (`files` in
  `package.json`) — the shipped `agents/SKILL.md` is the default skill source
  for `setup`.
- End users update in place via `agent-comm-hub update` (reinstalls
  `agent-comm-hub@latest` globally, keeping the auto-start launcher valid).
- Doc files (README.md / README.zh.md / ARCHITECTURE.md) mention stale check
  counts and version numbers occasionally — when you change the suite or bump
  the version, update them to match reality.

---

## Companion desktop GUI (`app/`)

`agent-comm-hub-app` lives in `app/` and is **a separate workspace**, not a layer
of this repo. Rule of thumb when editing either side:

- The companion app **must not** relax `dependencies: {}` in this package, **must
  not** import from `src/` directly (TS or Rust), and **must not** rewrite
  `~/.claude.json`. Workspace isolation is enforced via
  `app/pnpm-workspace.yaml` (`packages: []`) — keep that file as-is.
- Communication goes through hub's CLI / HTTP API only: `agent-comm-hub status`,
  `bridge_*` tools over MCP streamable-http / SSE, and `herdr` for terminal
  control. The desktop GUI has its own `app/src-tauri/src/{hub_process.rs,
  mcp_client.rs, herdr_client.rs, sqlite_store.rs, commands.rs}` mirroring the
  protocol — they are independent implementations, not forks.
- When changing the hub CLI's flag format (e.g. `--flag=value` vs `--flag value`),
  update **both** the desktop GUI's `HubConfig::to_argv()` in
  `app/src-tauri/src/hub_process.rs` and any external `bridge_*` payload shape.
  See SPEC.md §4 and the inline protocol note in `hub_process.rs`.
- Bumping the package version here (e.g. `0.4.0 → 0.5.0`) does **not** require
  bumping the desktop app version — they have independent CHANGELOG entries.
