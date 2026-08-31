/**
 * Minimal Model Context Protocol streamable-http server over `node:http`,
 * zero runtime dependencies. Implements exactly the surface MCP clients
 * need: initialize (session id + protocol version negotiation),
 * notifications/initialized, tools/list, tools/call, ping, and a long-lived
 * SSE GET stream for server→client messages.
 *
 * Session-aware: every id-bearing POST carries an `Mcp-Session-Id`; the
 * {@link SessionRegistry} tracks known sessions and their peer bindings so
 * bridge tools can resolve "which peer is calling".
 *
 * Responses to id-bearing POST requests are synchronous JSON (the client
 * accepts `application/json, text/event-stream`; JSON is spec-compliant).
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { TokenIdentity } from './auth.js'

/** Fixed path of the built-in web admin page (same origin → it calls the
 * MCP endpoint directly with the manager token entered in the page). */
const ADMIN_PATH = '/admin'

/** Prefix of the management API the admin page calls (token issue/revoke). */
const ADMIN_API_PATH = '/admin/api'

/** Lazy-read the bundled admin page: `import.meta.url` is the bundle file
 * (lib/cli.js in the package, test/entry.mjs in tests) so ../assets resolves
 * to the shipped assets directory in both layouts. */
let adminPageCache: string | undefined
function adminPage(): string {
  if (adminPageCache === undefined) {
    adminPageCache = readFileSync(new URL('../assets/admin.html', import.meta.url), 'utf8')
  }
  return adminPageCache
}

/** One tool exposed to MCP clients. */
export interface McpTool {
  name: string
  description: string
  /** Plain JSON Schema (standard dialect: `required` arrays). */
  inputSchema: Record<string, unknown>
  /** Execute one call; `sessionId` is the caller's MCP session (may be undefined). */
  handler: (args: Record<string, unknown>, sessionId: string | undefined) => Promise<unknown>
}

/** Protocol versions this server can speak, newest first. */
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const
const LATEST_VERSION = SUPPORTED_VERSIONS[0]

const MAX_BODY_BYTES = 1_048_576

interface JsonRpcRequest {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  params?: unknown
}

/** Known MCP sessions and their peer bindings (shared with the hub tools). */
export class SessionRegistry {
  readonly sessions = new Set<string>()
  /** sessionId → peerId claimed via `bridge_register`. */
  readonly peerBindings = new Map<string, string>()

  /** Session id from the request header, if any. */
  sessionIdFor(req: IncomingMessage): string | undefined {
    return req.headers['mcp-session-id'] as string | undefined
  }

  /** Track `sessionId`, generating a fresh one when absent. */
  ensureSession(sessionId: string | undefined): string {
    const id = sessionId ?? randomUUID()
    this.sessions.add(id)
    return id
  }

  /** Peer bound to a session, if any. */
  peerFor(sessionId: string | undefined): string | undefined {
    if (sessionId === undefined) return undefined
    return this.peerBindings.get(sessionId)
  }

  /** Bind `peerId` to `sessionId`; rejects when the session already claimed
   * a different peer or the session id is absent. */
  bindPeer(sessionId: string | undefined, peerId: string): string {
    if (sessionId === undefined) throw new Error('no MCP session — re-initialize the connection')
    const existing = this.peerBindings.get(sessionId)
    if (existing !== undefined && existing !== peerId) {
      throw new Error(`this connection is already registered as '${existing}'`)
    }
    this.peerBindings.set(sessionId, peerId)
    this.sessions.add(sessionId)
    return sessionId
  }

  /** Drop the binding of a session (used by bridge_unregister). */
  unbindPeer(sessionId: string | undefined): void {
    if (sessionId !== undefined) this.peerBindings.delete(sessionId)
  }

  /** Client-reported name per session (from the initialize clientInfo). */
  readonly clientNames = new Map<string, string>()
  /** Client-reported version per session (undefined when not reported). */
  readonly clientVersions = new Map<string, string>()

  /** Remember the client name/version reported by a session (on initialize). */
  noteClient(sessionId: string, name: string, version?: string): void {
    this.clientNames.set(sessionId, name)
    if (version !== undefined) this.clientVersions.set(sessionId, version)
  }

  /** Client-reported name for a session, if any. */
  clientName(sessionId: string | undefined): string | undefined {
    if (sessionId === undefined) return undefined
    return this.clientNames.get(sessionId)
  }

  /** Client-reported version for a session, if any. */
  clientVersion(sessionId: string | undefined): string | undefined {
    if (sessionId === undefined) return undefined
    return this.clientVersions.get(sessionId)
  }

  /** Sessions whose owner explicitly unregistered; auto-registration is
   * suppressed for them until an explicit `bridge_register`. */
  private readonly suppressedAuto = new Set<string>()

  /** Suppress auto-registration for this session (on bridge_unregister). */
  suppressAuto(sessionId: string | undefined): void {
    if (sessionId !== undefined) this.suppressedAuto.add(sessionId)
  }

  /** Allow auto-registration again (on explicit bridge_register). */
  clearSuppress(sessionId: string | undefined): void {
    if (sessionId !== undefined) this.suppressedAuto.delete(sessionId)
  }

  /** Whether this session may not auto-register. */
  isSuppressed(sessionId: string | undefined): boolean {
    return sessionId !== undefined && this.suppressedAuto.has(sessionId)
  }

  /** Session → client IP (remote mode: the admin roster shows where a peer
   * connects from, so the operator can tell Zhang San's kimi-code from Li Si's). */
  readonly sessionIps = new Map<string, string>()

  /** Sessions with a live SSE stream (server→client channel). */
  private readonly liveStreams = new Set<string>()

  /** Session → token identity (remote auth mode only; see src/auth.ts).
   * The TOKEN, not the client-reported name, decides the peer id, so two
   * users running the same client get distinct peers. */
  readonly tokenBindings = new Map<string, TokenIdentity>()

  /** Bind a session to its token identity (at initialize / SSE open). */
  bindToken(sessionId: string, identity: TokenIdentity): void {
    this.tokenBindings.set(sessionId, identity)
  }

  /** Token identity bound to a session, if remote auth is in use. */
  tokenFor(sessionId: string | undefined): TokenIdentity | undefined {
    if (sessionId === undefined) return undefined
    return this.tokenBindings.get(sessionId)
  }

  /** Mark a session's SSE stream open (server→client channel alive). */
  markSseOpen(sessionId: string): void {
    this.liveStreams.add(sessionId)
  }

  /** Mark a session's SSE stream closed. */
  markSseClosed(sessionId: string): void {
    this.liveStreams.delete(sessionId)
  }

  /** Session ids with a live SSE stream. */
  liveSessions(): ReadonlySet<string> {
    return this.liveStreams
  }

  /** Drop every binding that points at `peerId` (used by the idle GC). With
   * `suppress`, the detached sessions also stop auto-re-registering — the
   * manager-kick path, so a kicked agent stays out until it explicitly
   * `bridge_register`s or reconnects with a fresh session. */
  unbindPeerId(peerId: string, options?: { suppress?: boolean }): string[] {
    const detached: string[] = []
    for (const [sessionId, bound] of this.peerBindings) {
      if (bound === peerId) {
        this.peerBindings.delete(sessionId)
        detached.push(sessionId)
        if (options?.suppress === true) this.suppressedAuto.add(sessionId)
      }
    }
    return detached
  }

  /** Session ids currently attached to `peerId` (any binding direction). */
  sessionsForPeer(peerId: string): string[] {
    const sessions: string[] = []
    for (const [sessionId, bound] of this.peerBindings) {
      if (bound === peerId) sessions.push(sessionId)
    }
    return sessions
  }

  /** Re-point every session bound to `oldId` at `newId` (true rename). */
  rebindPeerId(oldId: string, newId: string): number {
    let count = 0
    for (const [sessionId, bound] of this.peerBindings) {
      if (bound === oldId) {
        this.peerBindings.set(sessionId, newId)
        count++
      }
    }
    return count
  }

  /** How many sessions are currently attached to `peerId`. */
  attachedCount(peerId: string): number {
    let count = 0
    for (const bound of this.peerBindings.values()) {
      if (bound === peerId) count++
    }
    return count
  }
}

/** A minimal MCP server bound to one URL path of an http.Server. */
export class McpStreamableHttpServer {
  private readonly sseStreams = new Map<string, ServerResponse>()

  constructor(
    private readonly tools: McpTool[],
    private readonly info: { name: string; version: string },
    private readonly registry: SessionRegistry,
    private readonly log: (message: string) => void = () => {},
    /** Called right after a session initializes (eager auto-registration hook). */
    private readonly onInitialize: (sessionId: string, clientName: string | undefined, clientVersion: string | undefined) => void = () => {},
    /** Remote auth (src/auth.ts): resolve the bearer token of a request to a
     * token identity; undefined = unauthorized. When absent (loopback mode)
     * no auth check happens — the default desktop trust model. */
    private readonly authenticate?: (req: IncomingMessage) => TokenIdentity | undefined,
    /** Management API for the built-in admin page (token issue/revoke).
     * Every call is manager-gated by the transport before it runs. */
    private readonly adminApi?: {
      listTokens(reveal: boolean): Array<{ token: string; peer: string; role: string; owner?: string }>
      addToken(input: { peer: string; role: string; owner?: string }): { token: string; peer: string; role: string; owner?: string }
      removeToken(peer: string): boolean
      reloadAuth(): void
    },
  ) {}

  /** Attach request handling for `path` (e.g. `/mcp`) to an http server. */
  attach(server: Server, path: string): void {
    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname === ADMIN_PATH && req.method === 'GET') {
        // The page itself is static and unauthenticated (no data behind it);
        // it authenticates per MCP call with the token entered in the page.
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' })
        res.end(adminPage())
        return
      }
      if (url.pathname.startsWith(ADMIN_API_PATH) && this.adminApi !== undefined) {
        void this.handleAdminApi(req, res, url)
        return
      }
      if (url.pathname !== path) {
        res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'not found' }))
        return
      }
      if (req.method === 'GET') {
        this.handleGet(req, res)
        return
      }
      if (req.method === 'POST') {
        void this.handlePost(req, res)
        return
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders()).end()
        return
      }
      res.writeHead(405, corsHeaders()).end()
    })
  }

  /** Close all open SSE streams (called on server shutdown). */
  close(): void {
    for (const stream of this.sseStreams.values()) stream.end()
    this.sseStreams.clear()
  }

  /** Push a JSON-RPC notification to every open SSE stream (roster events are
   * public — any peer could poll bridge_peers for the same information).
   * Write failures drop the dead stream silently; SSE is best-effort and
   * long-poll (bridge_wait) remains the reliable delivery path. */
  notifyAll(method: string, params: Record<string, unknown>): void {
    this.notify([...this.sseStreams.keys()], method, params)
  }

  /** Push a JSON-RPC notification to the SSE streams of specific sessions. */
  notify(sessionIds: Iterable<string>, method: string, params: Record<string, unknown>): void {
    const frame = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method, params })}\n\n`
    for (const sessionId of sessionIds) {
      const stream = this.sseStreams.get(sessionId)
      if (stream === undefined) continue
      try {
        stream.write(frame)
      } catch {
        this.sseStreams.delete(sessionId)
        this.registry.markSseClosed(sessionId)
      }
    }
  }

  private handleGet(req: IncomingMessage, res: ServerResponse): void {
    // Remote auth: an SSE stream is as sensitive as any tool call.
    if (this.authenticate !== undefined && this.authenticate(req) === undefined) {
      res.writeHead(401, { ...corsHeaders(), 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'unauthorized: missing or invalid bearer token' }))
      return
    }
    const sessionId = this.registry.ensureSession(this.registry.sessionIdFor(req))
    const identity = this.authenticate?.(req)
    if (identity !== undefined) this.registry.bindToken(sessionId, identity)
    res.writeHead(200, {
      ...corsHeaders(),
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...(req.headers['mcp-session-id'] ? {} : { 'Mcp-Session-Id': sessionId }),
    })
    res.write(': connected\n\n')
    this.sseStreams.set(sessionId, res)
    this.registry.markSseOpen(sessionId)
    req.on('close', () => {
      this.sseStreams.delete(sessionId)
      this.registry.markSseClosed(sessionId)
    })
  }

  /** Reject a request without a valid token (remote auth mode). */
  private unauthorized(res: ServerResponse, id: number | string | null, why: string): void {
    res.writeHead(401, { ...corsHeaders(), 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32001, message: `unauthorized: ${why}` } }))
  }

  /** Management API for the bundled admin page: issue/revoke tokens and list
   * them. Like everything else, each call is authenticated by `authenticate`
   * and must resolve to a MANAGER role — an agent token gets 403. */
  private async handleAdminApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const respond = (status: number, body: unknown): void => {
      res.writeHead(status, { ...corsHeaders(), 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    }
    const identity = this.authenticate?.(req)
    if (identity === undefined) {
      respond(401, { error: 'unauthorized: manager token required' })
      return
    }
    if (identity.role !== 'manager') {
      respond(403, { error: 'forbidden: this API needs a manager-role token' })
      return
    }
    const api = this.adminApi!
    const seg = url.pathname.slice(ADMIN_API_PATH.length).replace(/^\/+|\/+$/g, '').split('/')

    if (req.method === 'GET' && seg[0] === 'tokens') {
      respond(200, { tokens: api.listTokens(url.searchParams.get('reveal') === '1') })
      return
    }
    if (req.method === 'POST' && seg[0] === 'tokens' && seg[1] === 'add') {
      let input: Record<string, unknown>
      try {
        input = JSON.parse((await readBody(req)).toString('utf8'))
      } catch (error) {
        respond(400, { error: `bad json: ${(error as Error).message}` })
        return
      }
      try {
        const created = api.addToken({
          peer: String(input.peer ?? ''),
          role: String(input.role ?? 'agent'),
          owner: input.owner === undefined ? undefined : String(input.owner),
        })
        respond(200, { created })
      } catch (error) {
        respond(400, { error: (error as Error).message })
      }
      return
    }
    if (req.method === 'DELETE' && seg[0] === 'tokens' && seg[1] === 'remove' && seg[2] !== undefined) {
      respond(200, { removed: api.removeToken(decodeURIComponent(seg[2])) })
      return
    }
    respond(404, { error: 'not found' })
  }

  private async handlePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Remote auth: every request (initialize included) must present a valid
    // bearer token; an established session must keep presenting ITS token.
    let authIdentity: TokenIdentity | undefined
    if (this.authenticate !== undefined) {
      authIdentity = this.authenticate(req)
      if (authIdentity === undefined) {
        this.unauthorized(res, null, 'missing or invalid bearer token')
        return
      }
      const existingSession = this.registry.sessionIdFor(req)
      const bound = existingSession === undefined ? undefined : this.registry.tokenFor(existingSession)
      // allow-join walk-ins present NO token on later requests: the sentinel
      // identity ('__join__') must keep matching the session's already-minted
      // unique anonymous peer. Only a real (non-anonymous) mismatch is fraud.
      const bothAnonymous = bound?.anonymous === true && authIdentity.anonymous === true
      if (bound !== undefined && !bothAnonymous && (bound.peer !== authIdentity.peer || bound.role !== authIdentity.role)) {
        this.unauthorized(res, null, 'token does not match this session')
        return
      }
      // Hub restarted under the client (or client kept talking after the hub
      // forgot the session): the presented token re-binds the identity here,
      // so a request never degrades to a nameless 'agent' peer.
      if (existingSession !== undefined && bound === undefined && !authIdentity.anonymous) {
        this.registry.bindToken(existingSession, authIdentity)
      }
    }
    let body: Buffer
    try {
      body = await readBody(req)
    } catch (error) {
      this.jsonRpcError(res, null, -32700, `parse error: ${(error as Error).message}`)
      return
    }
    let message: JsonRpcRequest
    try {
      message = JSON.parse(body.toString('utf8')) as JsonRpcRequest
    } catch {
      this.jsonRpcError(res, null, -32700, 'parse error: invalid JSON')
      return
    }
    if (typeof message !== 'object' || message === null || message.method === undefined) {
      this.jsonRpcError(res, message?.id ?? null, -32600, 'invalid request')
      return
    }
    const id = message.id ?? null
    const sessionId = this.registry.sessionIdFor(req)
    if (sessionId !== undefined) this.registry.sessionIps.set(sessionId, clientIp(req))

    // Notifications carry no id: acknowledge and move on.
    if (id === null) {
      res.writeHead(202, { ...corsHeaders(), 'Content-Length': '0' }).end()
      return
    }

    try {
      const { result, extraHeaders } = await this.dispatch(message, sessionId, authIdentity)
      res.writeHead(200, {
        ...corsHeaders(),
        'Content-Type': 'application/json; charset=utf-8',
        'Mcp-Protocol-Version': messageProtocolVersion(req),
        ...extraHeaders,
      })
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result }))
    } catch (error) {
      const code = (error as { code?: number }).code ?? -32603
      this.jsonRpcError(res, id, code, (error as Error).message, undefined, messageProtocolVersion(req))
    }
  }

  private async dispatch(
    message: JsonRpcRequest,
    sessionId: string | undefined,
    authIdentity?: TokenIdentity,
  ): Promise<{ result: unknown; extraHeaders?: Record<string, string> }> {
    const method = message.method ?? ''
    switch (method) {
      case 'initialize': {
        const newSessionId = this.registry.ensureSession(sessionId)
        const clientInfo = (message.params as { clientInfo?: { name?: unknown; version?: unknown } })?.clientInfo
        const clientName = typeof clientInfo?.name === 'string' && clientInfo.name !== '' ? clientInfo.name : undefined
        const clientVersion = typeof clientInfo?.version === 'string' && clientInfo.version !== '' ? clientInfo.version : undefined
        if (clientName !== undefined) {
          this.registry.noteClient(newSessionId, clientName, clientVersion)
        }
        // Remote auth: the token identity (not the client name) owns this
        // session from now on; auto-registration resolves through it.
        if (authIdentity !== undefined) {
          this.registry.bindToken(newSessionId, authIdentity)
        }
        // Eager auto-registration: connecting the MCP is enough to join.
        this.onInitialize(newSessionId, clientName, clientVersion)
        const requested = (message.params as { protocolVersion?: unknown })?.protocolVersion
        const protocolVersion = typeof requested === 'string' && (SUPPORTED_VERSIONS as readonly string[]).includes(requested)
          ? requested
          : LATEST_VERSION
        return {
          extraHeaders: { 'Mcp-Session-Id': newSessionId },
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: this.info.name, version: this.info.version },
            instructions: 'You are already registered with the hub (auto-registered at connect). Use bridge_chat / bridge_task / bridge_wait / bridge_poll / bridge_status / bridge_peers / bridge_history / bridge_ack to talk to other agents; bridge_register(peerId) renames your identity.',
          },
        }
      }
      case 'tools/list':
        return { result: { tools: this.tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })) } }
      case 'tools/call': {
        const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown }
        if (typeof params.name !== 'string') throw rpcError(-32602, 'tools/call requires a string name')
        const tool = this.tools.find(candidate => candidate.name === params.name)
        if (!tool) throw rpcError(-32602, `unknown tool: ${params.name}`)
        const args = (params.arguments ?? {}) as Record<string, unknown>
        if (typeof args !== 'object' || args === null || Array.isArray(args)) {
          throw rpcError(-32602, 'tools/call arguments must be an object')
        }
        try {
          const value = await tool.handler(args, sessionId)
          return { result: { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false } }
        } catch (error) {
          return {
            result: {
              content: [{ type: 'text', text: JSON.stringify({ error: (error as Error).message }) }],
              isError: true,
            },
          }
        }
      }
      case 'ping':
        return { result: {} }
      default:
        throw rpcError(-32601, `method not found: ${method}`)
    }
  }

  private jsonRpcError(
    res: ServerResponse,
    id: number | string | null,
    code: number,
    message: string,
    data?: unknown,
    protocolVersion?: string,
  ): void {
    res.writeHead(code === -32700 || code === -32600 ? 400 : 200, {
      ...corsHeaders(),
      'Content-Type': 'application/json; charset=utf-8',
      ...(protocolVersion ? { 'Mcp-Protocol-Version': protocolVersion } : {}),
    })
    res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } }))
  }
}

function rpcError(code: number, message: string): Error & { code?: number } {
  const error = new Error(message) as Error & { code?: number }
  error.code = code
  return error
}

function messageProtocolVersion(req: IncomingMessage): string {
  return (req.headers['mcp-protocol-version'] as string | undefined) ?? LATEST_VERSION
}

/** Best-effort client IP: X-Forwarded-For first hop (behind Caddy) or the
 * socket remote address. `::ffff:127.0.0.1` normalizes to 127.0.0.1. */
function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for']
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded
  if (typeof raw === 'string' && raw.trim() !== '') {
    return raw.split(',')[0].trim()
  }
  return (req.socket.remoteAddress ?? '?').replace(/^::ffff:/, '')
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}
