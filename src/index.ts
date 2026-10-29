/**
 * agent-comm-hub — generic multi-peer MCP hub.
 *
 * Any MCP-capable agent (MiniMax Code, Claude Code, opencode, Codex, Gemini
 * CLI, DeepSeek Harness, ...) connects to one local streamable-http endpoint,
 * claims a peer id via `bridge_register`, and then chats with, delegates
 * tasks to, and acknowledges every other connected agent in real time.
 *
 * Zero runtime dependencies: the MCP server is hand-rolled over `node:http`.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { HerdrCtl } from './herdr-ctl.js'
import { RunnerRegistry, type RunnerConfig } from './runner.js'
import { AgentHub, type HubOptions, type PeerProfile } from './hub.js'
import { DEFAULT_PARKED_TTL_MS } from './hub.js'
import { autoRegisterPeer, hubTools, isManagerCaller, livePeersFor, present, rosterFor, sanitizePeerId } from './hub-tools.js'
import { McpStreamableHttpServer, SessionRegistry, isLoopbackHost } from './mcp-server.js'
import { ANON_JOIN_PEER, bearerFromHeaders, watchTokenFile, addToken, removeToken, readTokens, type TokenIdentity, type TokenTable } from './auth.js'
import { SQLiteStateStore } from './persist.js'
import {
  SSE_METHOD,
  SSE_EVENT_PEERS_CHANGED,
  SSE_EVENT_MESSAGE,
  SSE_EVENT_TASK_CHANGED,
  a2aState,
  type BridgeMessage,
  type TaskRecord,
  type TaskStatus,
} from './protocol.js'

export { HerdrCtl, type HerdrAgent, type HerdrPane, type HerdrRead, type HerdrSettled, AGENT_STATUSES } from './herdr-ctl.js'
export { RunnerRegistry, createRunner, validateRunnerConfig, DEFAULT_RUN_TIMEOUT_MS, MAX_RUN_NOTE_CHARS, type Runner, type RunnerConfig, type RunnerDeps, type RunRequest, type RunResult } from './runner.js'
export { loadTokenFile, tokenTable, watchTokenFile, addToken, removeToken, readTokens, generateToken, type TokenIdentity, type TokenRole, type TokenTable, type TokenRowJson } from './auth.js'
export { SQLiteStateStore, type PersistedState } from './persist.js'
export { AgentHub, MAX_EVENTS, type HubEvent, type HubEventKind, type HubOptions, type PeerProfile, type PeerState, type HubStatus } from './hub.js'
export { McpStreamableHttpServer, SessionRegistry, type McpTool } from './mcp-server.js'
export { hubTools, present, autoRegisterPeer, sanitizePeerId, sanitizeAlias, type PresentedMessage } from './hub-tools.js'
export * from './protocol.js'

/** Default server name reported to MCP clients. */
export const SERVER_NAME = 'agent-comm-hub'

/** Current package version (kept in sync with package.json). */
export const SERVER_VERSION = '0.11.0'

/** Default bind address; keep loopback unless you know why not. */
export const DEFAULT_HOST = '127.0.0.1'

/** Default port. */
export const DEFAULT_PORT = 18764

/** Default URL path of the MCP endpoint. */
export const DEFAULT_PATH = '/mcp'

export interface HubConfig {
  host: string
  port: number
  path: string
  maxQueue: number
  historyLimit: number
  waitTimeoutMs: number
  defaultWaitMs: number
  /** A peer counts as "active" while its last activity is this fresh (ms). */
  connectedWindowMs: number
  /** Auto-unregister peers idle for this long (ms); 0 disables the GC. */
  peerIdleTimeoutMs: number
  /** How long a parked mailbox (peer gone, mail kept) survives before it is
   * dropped (ms). Default 7 days in `AgentHub`; 0 disables expiry. */
  parkedTtlMs?: number
  /** Manual-ack lease duration (ms); see bridge_wait { ack: 'manual' }. */
  leaseTtlMs?: number
  /** Hand-outs before a leased message is dead-lettered instead of requeued;
   * 0 disables the limit. */
  maxAttempts?: number
  /** Per-peer mailbox rate limit in messages per minute; `0` (default) is unlimited.
   *  Guards the RECIPIENT against a broadcast storm — see `HubOptions.ratePerMin`. */
  ratePerMin?: number
  /** herdr CLI binary for the bridge_agent_* control tools (default 'herdr',
   * resolved via PATH). */
  herdrBin?: string
  /** Fixed argv entries after `herdrBin` (tests point at a fake herdr CLI;
   * unused in production). */
  herdrBaseArgs?: string[]
  /** Default cap for one herdr CLI call in ms (default 30000). */
  herdrTimeoutMs?: number
  /** herdr server socket path for the bridge_pane_* tools (defaults:
   * Windows `%APPDATA%\herdr\herdr.sock`, else `~/.config/herdr/herdr.sock`). */
  herdrSocketPath?: string
  /** Override the herdr socket transport (tests inject a fake). */
  herdrSendRequest?: (method: string, params: Record<string, unknown>) => Promise<unknown>
  /** Peers allowed to use bridge_agent_* tools; 'all' (default) or a list. */
  herdrControlPeers?: 'all' | string[]
  /** Executors for peers that are not polling (see `src/runner.ts`). Empty by
   *  default: nothing runs on this machine unless the operator configures it. */
  runners?: RunnerConfig[]
  /** How long a session with no live SSE stream may go unused before the registry
   *  forgets it (default 30 min; `0` disables reaping). See `SessionRegistry.sweep`. */
  sessionTtlMs?: number
  /** Peers allowed to manage the roster (bridge_rename of others, manager
   * kick via bridge_unregister). `'all'` keeps the loopback trust model;
   * the default is the desktop/CLI archiver identity so the companion GUI
   * is the manager out of the box. */
  managerPeers?: 'all' | string[]
  /** Extra browser origins allowed to call the MCP endpoint (`--allow-origins`).
   * Requests without an `Origin` header and loopback origins are always allowed;
   * everything else is rejected with 403. See `originAllowed` in mcp-server.ts. */
  allowOrigins?: string[]
  /** Loopback manager secret (`--manager-token`). When set, hub-manager
   * PRIVILEGES (roster edits, kicks, full-history reads, the SSE relay) require
   * it as `Authorization: Bearer <token>` on the request. The peer id itself is
   * NOT reserved — the shipped desktop GUI identifies itself as `agent-hub-cli`
   * at initialize and must keep connecting.
   * When unset, `<stateFileDir>/manager.token` is read if that file exists;
   * without either, manager ids stay a convention (documented in README).
   * Ignored in remote mode (`--auth-tokens`): the token table owns that header. */
  managerToken?: string
  /** Opt out of the "non-loopback bind requires a token table" guard. Only for
   * a network that is already isolated by other means (VPN, firewall, container
   * network) — the hub itself has no authentication without `--auth-tokens`. */
  insecure?: boolean
  /** JSON file the peer roster (profiles: aliases, client info) is persisted
   * to so identities survive hub restarts. Undefined (the DEFAULT_CONFIG) =
   * off — the CLI turns it on by default; tests stay hermetic. */
  stateFile?: string
  /** REMOTE MODE: bearer-token table file (see src/auth.ts). When set, every
   * MCP request must carry `Authorization: Bearer <token>`; the token maps
   * to a fixed peer id + role, so two users running the same client stay
   * two peers. Undefined keeps the loopback-only no-auth desktop model. */
  authTokens?: string
  /** REMOTE MODE: SQLite state database (node:sqlite, zero deps) persisting
   * the history ring, offline mailboxes, peer profiles, and groups across
   * restarts. Undefined = memory-only (desktop default; the CLI opts in). */
  db?: string
  /** REMOTE MODE: allow unauthenticated agents to join (default false). Each
   * walk-in gets a UNIQUE temporary peer id + its source IP is recorded, so
   * an admin can later claim (rename) it or issue it a token — but it can
   * never merge with, or read, another peer. Enable for LAN/VPN onboarding;
   * keep OFF on the public internet. */
  allowJoin?: boolean
  /** SSE heartbeat cadence in ms (default 20000; see mcp-server.ts). Keeps
   * proxies from reaping idle streams and lets clients detect half-open
   * connections. Not a CLI flag — tests inject small values. */
  heartbeatMs?: number
}

export const DEFAULT_CONFIG: HubConfig = {
  host: DEFAULT_HOST,
  port: DEFAULT_PORT,
  path: DEFAULT_PATH,
  maxQueue: 200,
  // 100 was too small to survive a long multi-agent session: the ring is the
  // only archive source until the desktop app persists it to SQLite, and a
  // night of agent-to-agent chatter evicts everything within minutes.
  historyLimit: 1000,
  waitTimeoutMs: 60_000,
  defaultWaitMs: 30_000,
  connectedWindowMs: 30_000,
  peerIdleTimeoutMs: 600_000,
  // The companion desktop app (and `agent-comm-hub status` probe) registers
  // as `agent-hub-cli`; the web admin console registers as `hub-admin`.
  // Both are roster managers. Agents themselves are NOT managers — they
  // keep chatting, a GUI manages.
  managerPeers: ['agent-hub-cli', 'hub-admin'],
}

export interface HubLogger {
  info(message: string): void
  warn(message: string): void
}

export interface StartedHub {
  hub: AgentHub
  registry: SessionRegistry
  server: Server
  mcp: McpStreamableHttpServer
  /** Stop the HTTP server and close SSE streams. */
  close(): void
}

/** Best-effort client IP for MCP/SSE requests (X-Forwarded-For first hop
 * behind Caddy, else the socket address; normalizes ::ffff:). Used by
 * allow-join identity derivation and the roster's clientIp display. */
function clientIpOf(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for']
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded
  if (typeof raw === 'string' && raw.trim() !== '') return raw.split(',')[0].trim()
  return (req.socket.remoteAddress ?? '?').replace(/^::ffff:/, '')
}

/** Admin API adapter: the page's token issue/revoke calls reach the auth
 * table through this. `reveal` masks tokens unless explicitly requested. */
function authTokensAdmin(
  file: string | undefined,
  reloadAuth: (() => void) | undefined,
): NonNullable<ConstructorParameters<typeof McpStreamableHttpServer>[6]> | undefined {
  if (file === undefined) return undefined
  return {
    listTokens: reveal => readTokens(file).map(r => ({
      token: reveal ? r.token : `${r.token.slice(0, 6)}…${r.token.slice(-4)}`,
      peer: r.peer, role: r.role, ...(r.owner !== undefined ? { owner: r.owner } : {}),
    })),
    addToken: input => {
      const row = addToken(file, { peer: input.peer, role: input.role as 'agent' | 'manager', owner: input.owner })
      reloadAuth?.()
      return { token: row.token, peer: row.peer, role: row.role, ...(row.owner !== undefined ? { owner: row.owner } : {}) }
    },
    removeToken: peer => {
      const ok = removeToken(file, peer)
      if (ok) reloadAuth?.()
      return ok
    },
    reloadAuth: () => reloadAuth?.(),
  }
}

/** Atomic roster write: UTF-8 without BOM, temp file + rename so a crash
 * mid-write never corrupts the previous snapshot. */
function writeRosterFile(file: string, profiles: PeerProfile[]): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify({ version: 1, savedAt: Date.now(), profiles }), 'utf8')
  renameSync(tmp, file)
}

/**
 * Read the optional loopback manager secret that sits next to the state file
 * (`<stateFileDir>/manager.token`). Absent or empty means manager ids stay a
 * convention, exactly as before this option existed.
 *
 * Only ENOENT is treated as "not configured". Any other failure (a directory in
 * its place, a permission problem) means the operator did configure a credential
 * and the hub cannot read it — silently falling back would downgrade the manager
 * gate to the peer-id convention without anyone noticing, so this throws.
 */
function readManagerTokenFile(stateFile: string | undefined): string | undefined {
  if (stateFile === undefined) return undefined
  const file = join(dirname(stateFile), 'manager.token')
  try {
    const raw = readFileSync(file, 'utf8').trim()
    return raw === '' ? undefined : raw
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(`cannot read the manager token ${file}: ${(error as Error).message}`)
  }
}

/** Start the hub: MCP endpoint on `host:port + path`, tools wired to a fresh AgentHub. */
export function startHub(config: Partial<HubConfig> = {}, log: HubLogger = console): StartedHub {
  // Drop undefined keys so CLI defaults never clobber DEFAULT_CONFIG values.
  const overrides = Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined))
  const resolved: HubConfig = { ...DEFAULT_CONFIG, ...overrides }
  const managerToken = resolved.managerToken ?? readManagerTokenFile(resolved.stateFile)
  // Binding beyond loopback without a token table means every client that can
  // reach the port is trusted. That used to be a documentation-only rule, so
  // existing deployments may rely on it; `insecure: true` is the explicit way out.
  if (!isLoopbackHost(resolved.host) && resolved.authTokens === undefined && resolved.insecure !== true) {
    throw new Error(
      `refusing to bind ${resolved.host} without --auth-tokens: the hub has no authentication, ` +
      'so every client that can reach the port would be trusted. Pass --auth-tokens <file> ' +
      '(recommended), or --insecure to accept the risk on an already-isolated network.',
    )
  }
  // Without a credential there is nothing to check against: any client that can
  // reach the port may claim a manager id. That is tolerable on loopback (the
  // same OS user could read the token file anyway), but it must be said out loud
  // once the hub is reachable from anywhere else.
  if (managerToken === undefined && resolved.managerPeers !== 'all' && !isLoopbackHost(resolved.host)) {
    log.warn(
      `manager peer ids are claimable by any client that can reach ${resolved.host}:${resolved.port} — ` +
      'set --manager-token (or run with --auth-tokens) to require a credential',
    )
  }
  // Both credentials read the same `Authorization` header, so they cannot be in
  // force at once: with a token table every request is authenticated by it, and
  // presentedManagerToken never sees the manager secret.
  if (managerToken !== undefined && resolved.authTokens !== undefined) {
    log.warn(
      'both --manager-token and --auth-tokens are set: the token table owns the Authorization header, ' +
      'so the manager token is ignored. Grant manager rights with `auth add <peer> --role manager` instead.',
    )
  }
  // Assigned right after the hub is constructed; the event callbacks below
  // only fire once requests flow, never before the assignment runs.
  let mcp: McpStreamableHttpServer
  // SQLite state store — declared `let` and referenced from the hub's
  // persistence hooks before it is constructed: a broken/missing database
  // downgrades the hub to memory-only, never fatal.
  let dbStore: SQLiteStateStore | undefined
  /** Push the full roster to every open SSE stream (roster info is public). */
  const pushRoster = (): void => {
    // Broadcast on purpose — the one place this file does. `peers_changed` carries
    // a full roster SNAPSHOT (idempotent state), not a delivery to one recipient;
    // rotating it would leave every other client's roster stale, which is worse
    // than the duplicate. Every per-recipient push below goes to exactly one
    // stream — see oneStreamPer.
    mcp.notifyAll(SSE_METHOD, {
      level: 'info',
      logger: 'bridge',
      data: { event: SSE_EVENT_PEERS_CHANGED, peers: rosterFor(hub, registry) },
    })
  }
  /** Pick exactly ONE stream from `candidates`, rotating between calls.
   *
   *  The spec (2025-06-18, Multiple Connections) requires the server to send each
   *  of its JSON-RPC messages on only one stream, and under N:1 the several
   *  sessions of one peer are several streams to the same client. Picking a fixed
   *  one (the first) deterministically starved the others: with two desktop
   *  windows sharing the default `agent-hub-cli` peer, the second never saw a
   *  push hint again. Rotating keeps "one stream per message" while sharing the
   *  load. Prefers a session that actually has a stream open, so the message is
   *  not written into the void. */
  const streamCursor = new Map<string, number>()
  const oneStreamPer = (key: string, candidates: string[]): string[] => {
    if (candidates.length === 0) return []
    const streamed = registry.liveSessions()
    const open = candidates.filter(id => streamed.has(id))
    const pool = open.length > 0 ? open : candidates
    const at = (streamCursor.get(key) ?? 0) % pool.length
    streamCursor.set(key, (at + 1) % pool.length)
    return [pool[at]!]
  }
  /** Give a queued message's recipient sessions a push hint so UIs can skip
   * polling; delivery itself stays via bridge_wait / bridge_poll. */
  const pushQueued = (message: BridgeMessage, target: string): void => {
    // Delivery is unchanged; this is only the skip-polling hint, and
    // bridge_poll / bridge_wait still work if it is missed.
    mcp.notify(oneStreamPer(`peer:${target}`, registry.sessionsForPeer(target)), SSE_METHOD, {
      level: 'info',
      logger: 'bridge',
      data: { event: SSE_EVENT_MESSAGE, message: present(message) },
    })
  }
  /** Manager surface for the relay view. MUST use the same predicate as the
   * tool gate (isManagerCaller): when the two drifted, an unauthenticated peer
   * that had claimed a manager id received every message on the hub over SSE
   * while the credential-holding session received none. */
  const managerSet: ReadonlySet<string> | undefined = resolved.managerPeers === 'all' ? undefined : new Set(resolved.managerPeers)
  /** Push EVERY message to manager sessions — the relay stream (relay) view: a
   * manager watches the whole hub's traffic live, not just messages
   * addressed to itself. Same event shape as pushQueued, so the desktop
   * app's existing `{event:'message', message}` consumer picks it up. */
  const pushRelay = (message: BridgeMessage): void => {
    const managers: string[] = []
    for (const sessionId of registry.liveSessions()) {
      const peer = registry.peerFor(sessionId)
      if (peer === undefined) continue
      if (isManagerCaller(registry, sessionId, peer, { managerPeers: managerSet, managerTokenRequired: managerToken !== undefined })) {
        managers.push(sessionId)
      }
    }
    if (managers.length > 0) {
      mcp.notify(oneStreamPer('relay', managers), SSE_METHOD, {
        level: 'info',
        logger: 'bridge',
        data: { event: SSE_EVENT_MESSAGE, message: present(message) },
      })
    }
  }
  /** How many tasks `lastTaskPush` remembers. Memory-only bookkeeping, so a
   *  bound is all it needs: it is keyed by task id and the ledger evicts old
   *  tasks, so a long-running hub would otherwise keep a row per task ever seen. */
  const MAX_TASK_PUSH_MEMORY = 512
  /** Last `task_changed` status pushed for a task (see the hook below). */
  const lastTaskPush = new Map<string, TaskStatus>()
  /** Push one task's ledger state to its SENDER and its ASSIGNEES — nobody else.
   *
   *  Deliberately not a broadcast (like `peers_changed`) and deliberately not
   *  part of the manager relay: the payload names a task id and its status, and a
   *  task is a private arrangement between two parties. A manager loses nothing —
   *  every transition is caused by an ack (relayed already) or by a hub timer
   *  (readable through bridge_tasks / bridge_events), and widening the audience
   *  is how task ids and their state leak to peers that were never a party. */
  const pushTaskChanged = (task: TaskRecord): void => {
    const data = {
      event: SSE_EVENT_TASK_CHANGED,
      taskId: task.id,
      status: task.status,
      // A2A naming, so a client that speaks A2A does not have to carry the
      // ledger's own vocabulary — same mapping bridge_task_status publishes.
      a2aState: a2aState(task.status),
      updatedAt: task.updatedAt,
    }
    const seen = new Set<string>()
    for (const peer of [task.from, ...task.assignees.map(assignee => assignee.peerId)]) {
      if (seen.has(peer)) continue
      seen.add(peer)
      const sessions = registry.sessionsForPeer(peer)
      if (sessions.length === 0) continue
      mcp.notify(oneStreamPer(`task:${peer}`, sessions), SSE_METHOD, { level: 'info', logger: 'bridge', data })
    }
  }
  // Persistence: one debounced saver covers both stores — the legacy JSON
  // roster (stateFile) and the SQLite state DB (db). Either may be absent
  // (programmatic default); the CLI opts both in by default.
  let saveTimer: NodeJS.Timeout | undefined
  let rosterDirty = false
  let dbDirty = false
  const flushSaves = (): void => {
    if (rosterDirty && resolved.stateFile !== undefined) {
      rosterDirty = false
      try {
        writeRosterFile(resolved.stateFile, hub.exportProfiles())
      } catch (error) {
        log.warn(`roster save failed: ${(error as Error).message}`)
      }
    }
    if (dbDirty && dbStore !== undefined) {
      dbDirty = false
      try {
        dbStore.flush({ mailboxes: hub.exportMailboxes(), profiles: hub.exportProfiles(), groups: hub.exportGroups(), tasks: hub.exportTasks() })
      } catch (error) {
        log.warn(`sqlite flush failed: ${(error as Error).message}`)
      }
    }
  }
  const scheduleSave = (): void => {
    if (resolved.stateFile === undefined && dbStore === undefined) return
    if (saveTimer !== undefined) return
    saveTimer = setTimeout(() => {
      saveTimer = undefined
      flushSaves()
    }, 500)
    saveTimer.unref?.()
  }
  /** Filled in once the herdr adapter exists (see below); the task hook only
   *  ever fires while the hub is already serving. */
  let runnerRegistry: RunnerRegistry | undefined
  /** One run per peer at a time: two runners sharing a terminal (or a CLI that is
   *  not reentrant) would interleave their input and corrupt both answers. */
  const runnerQueue = new Map<string, Promise<void>>()

  /** The task payload a runner needs, read back out of the message content. */
  const taskPayload = (content: string): { prompt: string; context?: string; deliverable?: string; threadId?: string } => {
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>
      return {
        prompt: typeof parsed.prompt === 'string' ? parsed.prompt : content,
        ...(typeof parsed.context === 'string' ? { context: parsed.context } : {}),
        ...(typeof parsed.deliverable === 'string' ? { deliverable: parsed.deliverable } : {}),
        ...(typeof parsed.threadId === 'string' ? { threadId: parsed.threadId } : {}),
      }
    } catch {
      // Not JSON (a task always is, but never assume): run the raw content.
      return { prompt: content }
    }
  }

  /** Hand a queued task to its peer's runner, if it has one. Absence of a runner
   *  is not an error — the mailbox delivery simply stands. */
  function runTask(message: BridgeMessage, target: string): void {
    const runner = runnerRegistry?.get(target)
    if (runner === undefined) return
    const previous = runnerQueue.get(target) ?? Promise.resolve()
    const next = previous.then(async () => {
      const payload = taskPayload(message.content)
      hub.noteEvent('runner_started', { peer: target, detail: { taskId: message.id, runner: runner.name } })
      try {
        const result = await runner.run({ taskId: message.id, peer: target, ...payload })
        hub.noteEvent('runner_finished', { peer: target, detail: { taskId: message.id, runner: runner.name, status: result.status } })
        hub.ackForRunner(target, message.id, { status: result.status, note: result.note })
        log.info(`runner ${runner.name}: task ${message.id} for '${target}' -> ${result.status}`)
      } catch (error) {
        hub.noteEvent('runner_finished', { peer: target, detail: { taskId: message.id, runner: runner.name, status: 'failed', error: (error as Error).message } })
        // A runner that throws must not leave the task pending forever: that is
        // exactly the state this feature exists to prevent.
        try {
          hub.ackForRunner(target, message.id, { status: 'failed', note: `runner error: ${(error as Error).message}` })
        } catch {
          // The task may already be terminal (acked or timed out) — fine.
        }
        log.warn(`runner ${runner.name} errored on task ${message.id}: ${(error as Error).message}`)
      }
    })
    runnerQueue.set(target, next.catch(() => {}))
  }

  const hub = new AgentHub({
    maxQueue: resolved.maxQueue,
    historyLimit: resolved.historyLimit,
    waitTimeoutMs: resolved.waitTimeoutMs,
    connectedWindowMs: resolved.connectedWindowMs,
    peerIdleTimeoutMs: resolved.peerIdleTimeoutMs,
    parkedTtlMs: resolved.parkedTtlMs,
    leaseTtlMs: resolved.leaseTtlMs,
    maxAttempts: resolved.maxAttempts,
    ratePerMin: resolved.ratePerMin,
    // A parked mailbox that expires is data loss: say so, and make the store
    // re-snapshot so the dropped rows cannot resurrect on the next restart.
    onMailboxExpired: (peerId, dropped) => {
      log.warn(`parked mailbox for '${peerId}' expired after ${resolved.parkedTtlMs ?? DEFAULT_PARKED_TTL_MS}ms: ${dropped} message(s) dropped`)
      if (dbStore !== undefined) {
        dbDirty = true
        scheduleSave()
      }
    },
    onPeerGc: peerId => registry.unbindPeerId(peerId),
    // Remote persistence: buffer every history append; re-snapshot when a
    // mailbox is consumed so drained messages cannot resurrect on restart.
    // Also relay every message to manager sessions (the relay stream view) —
    // best-effort; a notification failure must never break routing.
    onMessage: message => {
      if (dbStore !== undefined) {
        dbStore.appendMessage(message)
        dbDirty = true
        scheduleSave()
      }
      try {
        pushRelay(message)
      } catch (error) {
        log.warn(`relay notification failed: ${(error as Error).message}`)
      }
    },
    onMailboxesChanged: () => {
      if (dbStore === undefined) return
      dbDirty = true
      scheduleSave()
    },
    // Task ledger transitions (ack folding, SLA timeout, first delivery) are
    // their own persistence trigger: without it a crash between two roster
    // events loses the ledger state the admin board reads back. They are also
    // the SSE `task_changed` signal for the two parties of a task.
    onTaskChanged: task => {
      if (dbStore !== undefined) {
        dbDirty = true
        scheduleSave()
      }
      // Only a REAL status change is worth a notification. This hook also fires
      // for events that moved nothing — an `applied: false` ack on a closed task,
      // the Nth `working` beat, the first-delivery booking — and re-announcing
      // the same status would turn the stream into an ack-by-ack echo of a value
      // that did not change. A consumer that needs the detail reads the ledger.
      if (lastTaskPush.get(task.id) === task.status) return
      try {
        pushTaskChanged(task)
      } catch (error) {
        log.warn(`task_changed notification failed: ${(error as Error).message}`)
      }
      // Recorded AFTER the push, and deliberately even when the push reached no
      // live session. `pushTaskChanged` skips a party that has no open stream,
      // so recording first lost the transition for good: "working while
      // disconnected → done" was neither pushed nor remembered, and that party
      // never heard the change at all. Recording it anyway is the right trade —
      // the status being remembered is the one nobody was listening for, so
      // nothing that could have been received is lost, and replaying it after a
      // reconnect would announce a past state as news (a reconnecting consumer
      // reads the CURRENT state from bridge_task_status / bridge_tasks; this
      // stream reports transitions that happen while it is open).
      // Delete-then-set keeps the map in LRU order, so trimming below drops the
      // task that moved longest ago rather than an arbitrary one.
      lastTaskPush.delete(task.id)
      lastTaskPush.set(task.id, task.status)
      while (lastTaskPush.size > MAX_TASK_PUSH_MEMORY) {
        const oldest = lastTaskPush.keys().next().value
        if (oldest === undefined) break
        lastTaskPush.delete(oldest)
      }
    },
    onGroupsChanged: () => {
      if (dbStore === undefined) return
      dbDirty = true
      scheduleSave()
    },
    // The idle GC must never evict a peer whose session has a live SSE channel.
    isPeerLive: peerId => livePeersFor(registry).has(peerId),
    // SSE event push: roster changes and queued-mail hints. Best-effort — a
    // notification failure must never break routing, so swallow and log.
    onPeersChanged: () => {
      try {
        pushRoster()
      } catch (error) {
        log.warn(`peers_changed notification failed: ${(error as Error).message}`)
      }
      rosterDirty = true
      dbDirty = true
      scheduleSave()
    },
    onQueued: (message, target) => {
      try {
        pushQueued(message, target)
      } catch (error) {
        log.warn(`message notification failed: ${(error as Error).message}`)
      }
    },
    // A task that reached a mailbox has nobody polling for it. If this peer has
    // a runner configured, wake it — that is the whole point of a runner.
    // `runnerRegistry` is filled in below, once the herdr adapter exists; this
    // hook only ever fires after the hub is serving.
    onTaskQueued: (message, target) => {
      try {
        runTask(message, target)
      } catch (error) {
        log.warn(`runner dispatch failed for '${target}': ${(error as Error).message}`)
      }
    },
  })
  const registry = new SessionRegistry()
  // Boot restore. SQLite (when configured) is authoritative for profiles,
  // history, mailboxes, and groups; a legacy 0.6 roster.json is imported
  // once when the DB has no profiles yet, then stays as a JSON mirror.
  if (resolved.db !== undefined) {
    try {
      dbStore = new SQLiteStateStore(resolved.db, resolved.historyLimit, log)
      const state = dbStore.load()
      const importedProfiles = hub.importProfiles(state.profiles)
      if (state.profiles.length === 0 && resolved.stateFile !== undefined) {
        try {
          const legacy = JSON.parse(readFileSync(resolved.stateFile, 'utf8')) as { profiles?: unknown }
          const migrated = hub.importProfiles(legacy.profiles)
          if (migrated > 0) log.info(`roster migrated: ${migrated} profile(s) from ${resolved.stateFile} into ${resolved.db}`)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            log.warn(`legacy roster import failed: ${(error as Error).message}`)
          }
        }
      } else if (importedProfiles > 0) {
        log.info(`roster restored: ${importedProfiles} profile(s) from ${resolved.db}`)
      }
      const restoredMessages = hub.importHistory(state.messages)
      // Order matters: the ledger (tasks) has to exist before any mailbox is
      // restored, because a mailbox that has to evict on restore reconciles the
      // task it dropped — with an empty ledger it would record the loss and
      // leave the task pending forever. Groups come before tasks for the same
      // kind of reason: `importTasks` rejects a sender that is a group id, and
      // `importGroups` refuses an id a peer or profile already holds.
      const restoredGroups = hub.importGroups(state.groups)
      const restoredTasks = hub.importTasks(state.tasks)
      const restoredQueued = hub.importMailboxes(state.mailboxes)
      if (restoredMessages + restoredQueued + restoredGroups > 0) {
        log.info(`state restored from ${resolved.db}: ${restoredMessages} message(s), ${restoredQueued} queued, ${restoredGroups} group(s)`)
        dbDirty = true
      }
    } catch (error) {
      dbStore = undefined
      log.warn(`sqlite state unavailable (${(error as Error).message}); running memory-only`)
    }
  }
  if (dbStore === undefined && resolved.stateFile !== undefined) {
    try {
      const parsed = JSON.parse(readFileSync(resolved.stateFile, 'utf8')) as { profiles?: unknown }
      const imported = hub.importProfiles(parsed.profiles)
      if (imported > 0) log.info(`roster restored: ${imported} profile(s) from ${resolved.stateFile}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn(`roster load failed: ${(error as Error).message}`)
      }
    }
  }
  const herdr = new HerdrCtl({
    bin: resolved.herdrBin,
    baseArgs: resolved.herdrBaseArgs,
    defaultTimeoutMs: resolved.herdrTimeoutMs,
    socketPath: resolved.herdrSocketPath,
    sendRequest: resolved.herdrSendRequest,
  })
  // Executors: built here because a `herdr` runner needs the adapter above.
  // A bad runner config throws right now — silently downgrading a task to a
  // mailbox nobody reads is the failure mode this whole feature exists to fix.
  runnerRegistry = new RunnerRegistry(resolved.runners ?? [], { herdr })
  if (runnerRegistry.size > 0) log.info(`runners configured for: ${runnerRegistry.peers().join(', ')}`)
  // Remote auth: token file -> per-request bearer lookup. The transport
  // authenticates EVERY request; initialize additionally binds the session
  // to the token identity, which then decides auto-registration (hub-tools).
  let auth: ((req: IncomingMessage) => TokenIdentity | undefined) | undefined
  let authReload: (() => void) | undefined
  if (resolved.authTokens !== undefined) {
    // Hot-reload: token edits apply within ~2s; an invalid edit keeps the
    // previous table, so a typo never locks a running team out.
    const table: TokenTable = watchTokenFile(resolved.authTokens, {
      info: message => log.info(message),
      warn: message => log.warn(message),
    })
    authReload = table.reload
    auth = req => {
      const presented = bearerFromHeaders(req.headers)
      if (presented !== undefined) return table.authenticate(presented)
      // allow-join: anonymous walk-in gets the ANON sentinel here; the real
      // unique id is minted PER SESSION at initialize (see onInitialize) —
      // IP-keyed ids would merge two walk-ins behind one NAT/loopback.
      if (resolved.allowJoin === true) {
        return { peer: ANON_JOIN_PEER, role: 'agent', anonymous: true }
      }
      return undefined
    }
  } else if (resolved.allowJoin === true) {
    // loopback + allowJoin: same sentinel path.
    auth = req => ({ peer: ANON_JOIN_PEER, role: 'agent', anonymous: true })
  }
  // The manager gate lives in requireManager (hub-tools): it checks the PRIVILEGE,
  // not the peer id, because the shipped desktop GUI identifies itself as
  // `agent-hub-cli` at initialize and must keep connecting either way.
  mcp = new McpStreamableHttpServer(
    hubTools(hub, registry, {
      defaultWaitMs: resolved.defaultWaitMs,
      waitTimeoutMs: resolved.waitTimeoutMs,
      herdr,
      herdrControlPeers: resolved.herdrControlPeers === 'all' || resolved.herdrControlPeers === undefined ? 'all' : new Set(resolved.herdrControlPeers),
      managerPeers: resolved.managerPeers === 'all' ? 'all' : new Set(resolved.managerPeers ?? DEFAULT_CONFIG.managerPeers),
      managerTokenRequired: managerToken !== undefined,
      // Token identities are an authorization fact of the TABLE, not of the live
      // sessions: `bridge_rename` must not re-key onto a configured id whose
      // owner has not connected yet. Read from the file on every call because
      // the token admin API adds/removes rows at runtime (and `readTokens`
      // returns [] in loopback mode, where no id is reserved).
      ...(resolved.authTokens === undefined
        ? {}
        : { tokenPeers: () => new Set(readTokens(resolved.authTokens!).map(row => row.peer)) }),
    }),
    { name: SERVER_NAME, version: SERVER_VERSION },
    registry,
    message => log.warn(message),
    (sessionId, clientName, clientVersion) => {
      // Eager auto-registration at MCP handshake: connecting = joining.
      try {
        // Anonymous walk-in: mint a SESSION-UNIQUE peer id now (two kimi-code
        // walk-ins on one NAT/loopback must never share a peer — R0 cross-talk (mailbox leak).
        const identity = registry.tokenFor(sessionId)
        if (identity?.anonymous === true && identity.peer === ANON_JOIN_PEER) {
          let candidate = `join-${sanitizePeerId(clientName ?? 'agent')}-${randomBytes(2).toString('hex')}`
          while (hub.has(candidate)) {
            candidate = `join-${sanitizePeerId(clientName ?? 'agent')}-${randomBytes(2).toString('hex')}`
          }
          registry.bindToken(sessionId, { ...identity, peer: candidate })
        }
        const peer = autoRegisterPeer(hub, registry, sessionId, clientName, clientVersion)
        if (peer !== undefined) {
          const owner = registry.tokenFor(sessionId)?.owner
          const anon = registry.tokenFor(sessionId)?.anonymous === true ? ' (anonymous join)' : ''
          log.info(`peer joined: ${peer}${owner !== undefined ? ` (owner: ${owner})` : ''}${anon}`)
        }
      } catch (error) {
        log.warn(`auto-register failed: ${(error as Error).message}`)
      }
    },
    auth,
    authTokensAdmin(resolved.authTokens, authReload),
    resolved.heartbeatMs,
    resolved.allowOrigins === undefined || resolved.allowOrigins.length === 0
      ? undefined
      : { allow: new Set(resolved.allowOrigins) },
    managerToken,
    resolved.sessionTtlMs,
  )
  const server = createServer()
  mcp.attach(server, resolved.path)
  server.on('error', error => log.warn(`hub http server error: ${(error as Error).message}`))
  // Trim before binding: `isLoopbackHost` trims when it classifies the host, so a
  // value like "127.0.0.1 " passes the guard above and then fails getaddrinfo —
  // leaving a hub handle that looks alive and never listens.
  server.listen(resolved.port, resolved.host.trim(), () => {
    log.info(`agent-comm-hub listening on http://${resolved.host}:${resolved.port}${resolved.path}`)
  })
  return {
    hub,
    registry,
    server,
    mcp,
    close: () => {
      hub.dispose()
      mcp.close()
      if (saveTimer !== undefined) {
        clearTimeout(saveTimer)
        saveTimer = undefined
      }
      flushSaves()
      if (dbStore !== undefined) {
        try {
          dbStore.close({ mailboxes: hub.exportMailboxes(), profiles: hub.exportProfiles(), groups: hub.exportGroups(), tasks: hub.exportTasks() })
        } catch (error) {
          log.warn(`sqlite close failed: ${(error as Error).message}`)
        }
        dbStore = undefined
      }
      server.closeAllConnections?.()
      server.close()
    },
  }
}
