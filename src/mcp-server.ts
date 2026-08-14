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
import type { IncomingMessage, Server, ServerResponse } from 'node:http'

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

  /** Remember the client name reported by a session (on initialize). */
  noteClient(sessionId: string, name: string): void {
    this.clientNames.set(sessionId, name)
  }

  /** Client-reported name for a session, if any. */
  clientName(sessionId: string | undefined): string | undefined {
    if (sessionId === undefined) return undefined
    return this.clientNames.get(sessionId)
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

  /** Sessions with a live SSE stream (server→client channel). */
  private readonly liveStreams = new Set<string>()

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

  /** Drop every binding that points at `peerId` (used by the idle GC). */
  unbindPeerId(peerId: string): void {
    for (const [sessionId, bound] of this.peerBindings) {
      if (bound === peerId) this.peerBindings.delete(sessionId)
    }
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
    private readonly onInitialize: (sessionId: string, clientName: string | undefined) => void = () => {},
  ) {}

  /** Attach request handling for `path` (e.g. `/mcp`) to an http server. */
  attach(server: Server, path: string): void {
    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
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

  private handleGet(req: IncomingMessage, res: ServerResponse): void {
    const sessionId = this.registry.ensureSession(this.registry.sessionIdFor(req))
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

  private async handlePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
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

    // Notifications carry no id: acknowledge and move on.
    if (id === null) {
      res.writeHead(202, { ...corsHeaders(), 'Content-Length': '0' }).end()
      return
    }

    try {
      const { result, extraHeaders } = await this.dispatch(message, sessionId)
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
  ): Promise<{ result: unknown; extraHeaders?: Record<string, string> }> {
    const method = message.method ?? ''
    switch (method) {
      case 'initialize': {
        const newSessionId = this.registry.ensureSession(sessionId)
        const clientInfo = (message.params as { clientInfo?: { name?: unknown } })?.clientInfo
        const clientName = typeof clientInfo?.name === 'string' && clientInfo.name !== '' ? clientInfo.name : undefined
        if (clientName !== undefined) {
          this.registry.noteClient(newSessionId, clientName)
        }
        // Eager auto-registration: connecting the MCP is enough to join.
        this.onInitialize(newSessionId, clientName)
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
