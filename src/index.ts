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

import { createServer, type Server } from 'node:http'
import { HerdrCtl } from './herdr-ctl.js'
import { AgentHub, type HubOptions } from './hub.js'
import { autoRegisterPeer, hubTools, livePeersFor } from './hub-tools.js'
import { McpStreamableHttpServer, SessionRegistry } from './mcp-server.js'

export { HerdrCtl, type HerdrAgent, type HerdrPane, type HerdrRead, type HerdrSettled, AGENT_STATUSES } from './herdr-ctl.js'
export { AgentHub, type HubOptions, type PeerState, type HubStatus } from './hub.js'
export { McpStreamableHttpServer, SessionRegistry, type McpTool } from './mcp-server.js'
export { hubTools, present, autoRegisterPeer, sanitizePeerId, type PresentedMessage } from './hub-tools.js'
export * from './protocol.js'

/** Default server name reported to MCP clients. */
export const SERVER_NAME = 'agent-comm-hub'

/** Current package version (kept in sync with package.json). */
export const SERVER_VERSION = '0.6.0'

/** Default bind address; keep loopback unless you know why not. */
export const DEFAULT_HOST = '127.0.0.1'

/** Default port (18764 — dsh-mcode-bridge uses 18763, avoid clashing). */
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
}

export const DEFAULT_CONFIG: HubConfig = {
  host: DEFAULT_HOST,
  port: DEFAULT_PORT,
  path: DEFAULT_PATH,
  maxQueue: 200,
  historyLimit: 100,
  waitTimeoutMs: 60_000,
  defaultWaitMs: 30_000,
  connectedWindowMs: 30_000,
  peerIdleTimeoutMs: 600_000,
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

/** Start the hub: MCP endpoint on `host:port + path`, tools wired to a fresh AgentHub. */
export function startHub(config: Partial<HubConfig> = {}, log: HubLogger = console): StartedHub {
  // Drop undefined keys so CLI defaults never clobber DEFAULT_CONFIG values.
  const overrides = Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined))
  const resolved: HubConfig = { ...DEFAULT_CONFIG, ...overrides }
  const hub = new AgentHub({
    maxQueue: resolved.maxQueue,
    historyLimit: resolved.historyLimit,
    waitTimeoutMs: resolved.waitTimeoutMs,
    connectedWindowMs: resolved.connectedWindowMs,
    peerIdleTimeoutMs: resolved.peerIdleTimeoutMs,
    onPeerGc: peerId => registry.unbindPeerId(peerId),
    // The idle GC must never evict a peer whose session has a live SSE channel.
    isPeerLive: peerId => livePeersFor(registry).has(peerId),
  })
  const registry = new SessionRegistry()
  const herdr = new HerdrCtl({
    bin: resolved.herdrBin,
    baseArgs: resolved.herdrBaseArgs,
    defaultTimeoutMs: resolved.herdrTimeoutMs,
    socketPath: resolved.herdrSocketPath,
    sendRequest: resolved.herdrSendRequest,
  })
  const mcp = new McpStreamableHttpServer(
    hubTools(hub, registry, {
      defaultWaitMs: resolved.defaultWaitMs,
      waitTimeoutMs: resolved.waitTimeoutMs,
      herdr,
      herdrControlPeers: resolved.herdrControlPeers === 'all' || resolved.herdrControlPeers === undefined ? 'all' : new Set(resolved.herdrControlPeers),
    }),
    { name: SERVER_NAME, version: SERVER_VERSION },
    registry,
    message => log.warn(message),
    (sessionId, clientName) => {
      // Eager auto-registration at MCP handshake: connecting = joining.
      try {
        const peer = autoRegisterPeer(hub, registry, sessionId, clientName)
        if (peer !== undefined) log.info(`peer joined: ${peer}`)
      } catch (error) {
        log.warn(`auto-register failed: ${(error as Error).message}`)
      }
    },
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
      server.closeAllConnections?.()
      server.close()
    },
  }
}
