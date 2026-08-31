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
import { dirname } from 'node:path'
import { HerdrCtl } from './herdr-ctl.js'
import { AgentHub, type HubOptions, type PeerProfile } from './hub.js'
import { autoRegisterPeer, hubTools, livePeersFor, present, rosterFor, sanitizePeerId } from './hub-tools.js'
import { McpStreamableHttpServer, SessionRegistry } from './mcp-server.js'
import { ANON_JOIN_PEER, bearerFromHeaders, watchTokenFile, addToken, removeToken, readTokens, type TokenIdentity, type TokenTable } from './auth.js'
import { SQLiteStateStore } from './persist.js'
import type { BridgeMessage } from './protocol.js'

export { HerdrCtl, type HerdrAgent, type HerdrPane, type HerdrRead, type HerdrSettled, AGENT_STATUSES } from './herdr-ctl.js'
export { loadTokenFile, tokenTable, watchTokenFile, addToken, removeToken, readTokens, generateToken, type TokenIdentity, type TokenRole, type TokenTable, type TokenRowJson } from './auth.js'
export { SQLiteStateStore, type PersistedState } from './persist.js'
export { AgentHub, type HubOptions, type PeerProfile, type PeerState, type HubStatus } from './hub.js'
export { McpStreamableHttpServer, SessionRegistry, type McpTool } from './mcp-server.js'
export { hubTools, present, autoRegisterPeer, sanitizePeerId, sanitizeAlias, type PresentedMessage } from './hub-tools.js'
export * from './protocol.js'

/** Default server name reported to MCP clients. */
export const SERVER_NAME = 'agent-comm-hub'

/** Current package version (kept in sync with package.json). */
export const SERVER_VERSION = '0.7.0'

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
  /** Peers allowed to manage the roster (bridge_rename of others, manager
   * kick via bridge_unregister). `'all'` keeps the loopback trust model;
   * the default is the desktop/CLI archiver identity so the companion GUI
   * is the manager out of the box. */
  managerPeers?: 'all' | string[]
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
  // as `agent-hub-cli`; it is the natural roster manager. Agents themselves
  // are NOT managers — they keep chatting, a GUI manages.
  managerPeers: ['agent-hub-cli'],
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

/** Start the hub: MCP endpoint on `host:port + path`, tools wired to a fresh AgentHub. */
export function startHub(config: Partial<HubConfig> = {}, log: HubLogger = console): StartedHub {
  // Drop undefined keys so CLI defaults never clobber DEFAULT_CONFIG values.
  const overrides = Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined))
  const resolved: HubConfig = { ...DEFAULT_CONFIG, ...overrides }
  // Assigned right after the hub is constructed; the event callbacks below
  // only fire once requests flow, never before the assignment runs.
  let mcp: McpStreamableHttpServer
  // SQLite state store — declared `let` and referenced from the hub's
  // persistence hooks before it is constructed: a broken/missing database
  // downgrades the hub to memory-only, never fatal.
  let dbStore: SQLiteStateStore | undefined
  /** Push the full roster to every open SSE stream (roster info is public). */
  const pushRoster = (): void => {
    mcp.notifyAll('notifications/message', {
      level: 'info',
      logger: 'bridge',
      data: { event: 'peers_changed', peers: rosterFor(hub, registry) },
    })
  }
  /** Give a queued message's recipient sessions a push hint so UIs can skip
   * polling; delivery itself stays via bridge_wait / bridge_poll. */
  const pushQueued = (message: BridgeMessage, target: string): void => {
    mcp.notify(registry.sessionsForPeer(target), 'notifications/message', {
      level: 'info',
      logger: 'bridge',
      data: { event: 'message', message: present(message) },
    })
  }
  /** Manager surface for the relay view. Mirror of the requireManager gate
   * in hub-tools.ts: a manager-role token, or membership of managerPeers
   * ('all' = every registered peer). */
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
      if (registry.tokenFor(sessionId)?.role === 'manager' || managerSet === undefined || managerSet.has(peer)) {
        managers.push(sessionId)
      }
    }
    if (managers.length > 0) {
      mcp.notify(managers, 'notifications/message', {
        level: 'info',
        logger: 'bridge',
        data: { event: 'message', message: present(message) },
      })
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
        dbStore.flush({ mailboxes: hub.exportMailboxes(), profiles: hub.exportProfiles(), groups: hub.exportGroups() })
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
  const hub = new AgentHub({
    maxQueue: resolved.maxQueue,
    historyLimit: resolved.historyLimit,
    waitTimeoutMs: resolved.waitTimeoutMs,
    connectedWindowMs: resolved.connectedWindowMs,
    peerIdleTimeoutMs: resolved.peerIdleTimeoutMs,
    onPeerGc: peerId => registry.unbindPeerId(peerId),
    // Remote persistence: buffer every history append; re-snapshot when a
    // mailbox is consumed so drained messages cannot resurrect on restart.
    // Also relay every message to manager sessions (the relay stream view) —
    // best-effort; a notification failure must never break routing.
    onMessage: message => {
      if (dbStore !== undefined) {
        dbStore.appendMessage(message)
        dbDirty = true
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
      const restoredQueued = hub.importMailboxes(state.mailboxes)
      const restoredGroups = hub.importGroups(state.groups)
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
  mcp = new McpStreamableHttpServer(
    hubTools(hub, registry, {
      defaultWaitMs: resolved.defaultWaitMs,
      waitTimeoutMs: resolved.waitTimeoutMs,
      herdr,
      herdrControlPeers: resolved.herdrControlPeers === 'all' || resolved.herdrControlPeers === undefined ? 'all' : new Set(resolved.herdrControlPeers),
      managerPeers: resolved.managerPeers === 'all' ? 'all' : new Set(resolved.managerPeers ?? DEFAULT_CONFIG.managerPeers),
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
  )
  const server = createServer()
  mcp.attach(server, resolved.path)
  server.on('error', error => log.warn(`hub http server error: ${(error as Error).message}`))
  server.listen(resolved.port, resolved.host, () => {
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
          dbStore.close({ mailboxes: hub.exportMailboxes(), profiles: hub.exportProfiles(), groups: hub.exportGroups() })
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
