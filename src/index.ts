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
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { HerdrCtl } from './herdr-ctl.js'
import { AgentHub, type HubOptions, type PeerProfile } from './hub.js'
import { autoRegisterPeer, hubTools, livePeersFor, present, rosterFor } from './hub-tools.js'
import { McpStreamableHttpServer, SessionRegistry } from './mcp-server.js'
import { bearerFromHeaders, loadTokenFile, tokenTable, type TokenIdentity, type TokenTable } from './auth.js'
import type { BridgeMessage } from './protocol.js'

export { HerdrCtl, type HerdrAgent, type HerdrPane, type HerdrRead, type HerdrSettled, AGENT_STATUSES } from './herdr-ctl.js'
export { loadTokenFile, tokenTable, type TokenIdentity, type TokenRole, type TokenTable } from './auth.js'
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
  // Roster persistence: debounced atomic save on roster changes (stateFile
  // off by default for programmatic use — the CLI opts in).
  let saveTimer: NodeJS.Timeout | undefined
  let rosterDirty = false
  const flushRoster = (): void => {
    if (resolved.stateFile === undefined || !rosterDirty) return
    rosterDirty = false
    try {
      writeRosterFile(resolved.stateFile, hub.exportProfiles())
    } catch (error) {
      log.warn(`roster save failed: ${(error as Error).message}`)
    }
  }
  const scheduleRosterSave = (): void => {
    if (resolved.stateFile === undefined) return
    rosterDirty = true
    if (saveTimer !== undefined) return
    saveTimer = setTimeout(() => {
      saveTimer = undefined
      flushRoster()
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
      scheduleRosterSave()
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
  // Restore persisted profiles (aliases survive hub restarts). A missing
  // file is a normal first boot; anything else is reported but not fatal.
  if (resolved.stateFile !== undefined) {
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
  if (resolved.authTokens !== undefined) {
    const table: TokenTable = tokenTable(loadTokenFile(resolved.authTokens))
    auth = req => table.authenticate(bearerFromHeaders(req.headers))
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
        const peer = autoRegisterPeer(hub, registry, sessionId, clientName, clientVersion)
        if (peer !== undefined) {
          const owner = registry.tokenFor(sessionId)?.owner
          log.info(`peer joined: ${peer}${owner !== undefined ? ` (owner: ${owner})` : ''}`)
        }
      } catch (error) {
        log.warn(`auto-register failed: ${(error as Error).message}`)
      }
    },
    auth,
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
      flushRoster()
      server.closeAllConnections?.()
      server.close()
    },
  }
}
