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

import { randomUUID, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { TokenIdentity } from './auth.js'
import { SSE_METHOD } from './protocol.js'

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

/** SSE heartbeat cadence. A frame this often keeps proxies from reaping
 * 'idle' SSE connections (nginx defaults to a 60s read timeout), surfaces
 * half-open TCP on the next write (the failure path in notify() then drops
 * the stream so the idle GC can evict the peer), and doubles as the
 * liveness signal for client-side reconnect watchdogs. Sent as a real
 * JSON-RPC notification — not a `: ping` comment — because comment frames
 * are invisible to most SSE parsers and a watchdog needs an observable
 * event; MCP clients ignore unknown notifications per spec. */
const HEARTBEAT_MS = 20_000

/** How long a session with no live SSE stream may go unused before the registry
 *  forgets it. Deliberately generous: a client that has been silent for half an
 *  hour is not "in use", and a client that IS using the hub keeps refreshing it.
 *  `--session-ttl-ms 0` disables reaping. */
const DEFAULT_SESSION_TTL_MS = 30 * 60_000

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
    this.lastUsedAt.set(id, Date.now())
    return id
  }

  /** Has this session id ever been minted here and not terminated since?
   *  A request presenting an id the registry does not know must be answered 404
   *  (spec MUST) so the client starts a new session, instead of being adopted
   *  silently — which is how a client kept talking to a hub that had restarted
   *  and already forgotten it. */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId)
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

  /** Session → the last time a request presented it.
   *
   *  The registry is the only thing that knows a session exists, so it is also the
   *  only thing that can decide one is finished. Without this the maps below only
   *  ever grew, `hasSession` was true forever, and "this session is over" was not
   *  expressible — so the 404 path could never fire for a session the hub had
   *  genuinely finished with. */
  private readonly lastUsedAt = new Map<string, number>()

  /** Record that `sessionId` was just used (a request carried its id). */
  touch(sessionId: string | undefined): void {
    if (sessionId !== undefined && this.sessions.has(sessionId)) this.lastUsedAt.set(sessionId, Date.now())
  }

  /**
   * Forget sessions that are finished: no live SSE stream, and unused for `ttlMs`.
   * Returns the ids removed. `ttlMs <= 0` disables reaping.
   *
   * Safe because a client that gets 404 is REQUIRED by the spec to send a fresh
   * `initialize`, and the hub auto-registers it under the same peer id — it comes
   * back with its mailbox intact. A live SSE stream pins a session regardless of
   * age: that is the one signal that means "still connected", and it wins.
   */
  sweep(now: number, ttlMs: number): string[] {
    if (ttlMs <= 0) return []
    const removed: string[] = []
    for (const sessionId of [...this.sessions]) {
      if (this.liveStreams.has(sessionId)) continue
      const last = this.lastUsedAt.get(sessionId) ?? now
      if (now - last <= ttlMs) continue
      this.sessions.delete(sessionId)
      this.lastUsedAt.delete(sessionId)
      this.peerBindings.delete(sessionId)
      this.clientNames.delete(sessionId)
      this.clientVersions.delete(sessionId)
      this.sessionIps.delete(sessionId)
      this.tokenBindings.delete(sessionId)
      this.managerSessions.delete(sessionId)
      this.suppressedAuto.delete(sessionId)
      removed.push(sessionId)
    }
    return removed
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

  /** Sessions that presented the loopback manager token (`--manager-token`).
   * Distinct from a token-table identity: loopback mode has no token table, so
   * the manager secret is the only thing separating "the operator's GUI" from
   * "any other local MCP client". */
  private readonly managerSessions = new Set<string>()

  /** Remember that this session proved it holds the manager token. */
  markManagerSession(sessionId: string): void {
    this.managerSessions.add(sessionId)
  }

  /** Did this session present the manager token? */
  isManagerSession(sessionId: string | undefined): boolean {
    return sessionId !== undefined && this.managerSessions.has(sessionId)
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

/** Cross-origin policy of the MCP endpoint. */
export interface OriginPolicy {
  /** Extra origins accepted verbatim (e.g. `https://hub.example.com`), or 'all'. */
  allow?: ReadonlySet<string> | 'all'
}

/** A minimal MCP server bound to one URL path of an http.Server. */
export class McpStreamableHttpServer {
  private readonly sseStreams = new Map<string, ServerResponse>()
  private heartbeatTimer: NodeJS.Timeout | undefined
  private sessionSweepTimer: NodeJS.Timeout | undefined

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
    /** SSE heartbeat cadence override (tests); defaults to HEARTBEAT_MS. */
    private readonly heartbeatMs?: number,
    /** `Origin` policy for browser callers; see {@link originAllowed}. */
    private readonly originPolicy?: OriginPolicy,
    /** Loopback manager secret (`--manager-token`). When set, claiming a peer id
     * listed in `managerPeers` requires presenting it; see bridge_register. */
    private readonly managerToken?: string,
    /** How long a session with no live SSE stream may go unused before the
     *  registry forgets it. `0` disables reaping. See {@link SessionRegistry.sweep}. */
    private readonly sessionTtlMs: number = DEFAULT_SESSION_TTL_MS,
  ) {}

  /** Does this request carry the loopback manager token? */
  private presentedManagerToken(req: IncomingMessage): boolean {
    if (this.managerToken === undefined) return false
    const header = headerValue(req.headers.authorization)
    if (header === undefined) return false
    const match = /^Bearer\s+(.+)$/i.exec(header)
    return match !== null && secretEquals(match[1].trim(), this.managerToken)
  }

  /** Attach request handling for `path` (e.g. `/mcp`) to an http server. */
  attach(server: Server, path: string): void {
    // Heartbeat: one unref'd timer per server. Best-effort — a failed write
    // is exactly the dead-stream signal, handled inside notify().
    this.heartbeatTimer = setInterval(() => {
      if (this.sseStreams.size === 0) return
      this.notifyAll(SSE_METHOD, {
        level: 'debug',
        logger: 'bridge',
        data: { event: 'heartbeat', ts: Date.now() },
      })
    }, this.heartbeatMs ?? HEARTBEAT_MS)
    this.heartbeatTimer.unref?.()
    // Session reaper: the registry used to grow forever, and `hasSession` was true
    // for every id it had ever minted, so "this session is over" could not be
    // expressed. A live SSE stream pins a session; everything else ages out.
    if (this.sessionTtlMs > 0) {
      const interval = Math.min(60_000, Math.max(1_000, this.sessionTtlMs / 4))
      this.sessionSweepTimer = setInterval(() => {
        const removed = this.registry.sweep(Date.now(), this.sessionTtlMs)
        if (removed.length > 0) this.log(`sessions reaped: ${removed.length}`)
      }, interval)
      this.sessionSweepTimer.unref?.()
    }
    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      // MCP spec: "Servers MUST validate the Origin header on all incoming
      // connections to prevent DNS rebinding attacks." A browser sends Origin on
      // every POST; curl and MCP clients never do. Gating here covers /healthz,
      // /admin and /admin/api too, so one check protects every route.
      if (!this.originAllowed(req)) {
        // A rejection a client can hit on EVERY route, so it names the version too:
        // this is the one rejection class the header used to skip entirely.
        res.writeHead(403, { ...this.corsFor(req), 'Content-Type': 'application/json; charset=utf-8', 'Mcp-Protocol-Version': messageProtocolVersion(req) })
        res.end(JSON.stringify({ error: `origin not allowed: ${headerValue(req.headers.origin) ?? ''}` }))
        return
      }
      if (url.pathname === ADMIN_PATH && req.method === 'GET') {
        // The page itself is static and unauthenticated (no data behind it);
        // it authenticates per MCP call with the token entered in the page.
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' })
        res.end(adminPage())
        return
      }
      // Unauthenticated liveness probe for monitors/orchestrators (systemd
      // watchdog, container healthcheck, uptime probes). Exposes nothing
      // beyond "the process is up and serving HTTP" — deliberately no peer
      // count or state, so it is safe without a token.
      if (url.pathname === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...this.corsFor(req) })
        res.end(JSON.stringify({ ok: true, ts: Date.now() }))
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
        res.writeHead(204, this.corsFor(req)).end()
        return
      }
      // 405 is a rejection a client can hit while the expose list already promises
      // the browser it can read the version header — so it has to be there.
      res.writeHead(405, { ...this.corsFor(req), 'Mcp-Protocol-Version': messageProtocolVersion(req) }).end()
    })
  }

  /** Close all open SSE streams (called on server shutdown). */
  close(): void {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer)
    if (this.sessionSweepTimer !== undefined) clearInterval(this.sessionSweepTimer)
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

  /**
   * Cross-origin gate. A request is allowed when:
   *  - it carries no `Origin` (curl, MCP clients, the desktop app — never browsers), or
   *  - the origin is explicitly listed (`--allow-origins`, or 'all'), or
   *  - the origin is a loopback hostname (the bundled admin page, local tooling), or
   *  - it presents a valid bearer token AND its origin host matches the `Host`
   *    header (the admin page behind a TLS reverse proxy, where the hub cannot
   *    know its own public origin).
   *
   * The last clause is deliberately credential-gated, not identity-gated: with
   * `--allow-join` the transport mints an anonymous identity for a request that
   * carries nothing at all, so testing only `authenticate(req) !== undefined`
   * would re-open this branch to exactly the rebinding page it exists to stop.
   * A real `Authorization` header is required as well.
   */
  private originAllowed(req: IncomingMessage): boolean {
    const origin = headerValue(req.headers.origin)
    if (origin === undefined) return true
    const policy = this.originPolicy
    if (policy?.allow === 'all') return true
    if (policy?.allow?.has(origin) === true) return true
    // A duplicated `Origin` header arrives joined by the parser ("http://a, http://b").
    // Reject the join artifacts outright instead of relying on `new URL` happening
    // to throw on them — with a trailing slash in the first value it does not, and
    // the merged string would parse down to a loopback hostname.
    if (origin.includes(',') || /\s/.test(origin)) return false
    const originHost = originHostname(origin)
    if (originHost === undefined) return false
    if (isLoopbackHost(originHost)) return true
    // "Has an identity" is not "presented a credential". With `--allow-join` the
    // transport mints an ANONYMOUS identity for a request that carries nothing,
    // and it ignores the header's content — so requiring only that the header
    // exists let any page satisfy this branch with `Authorization: Bearer x` and
    // then pick its own Host/Origin pair. Demand a credential-derived identity.
    const identity = this.authenticate?.(req)
    if (identity === undefined || identity.anonymous === true) return false
    const host = headerValue(req.headers.host)
    return host !== undefined && hostHeaderName(host) === originHost
  }

  /** CORS headers for one request: echoes the origin only when it is allowed. */
  private corsFor(req?: IncomingMessage): Record<string, string> {
    if (req === undefined) return corsHeaders()
    const origin = headerValue(req.headers.origin)
    return corsHeaders(origin !== undefined && this.originAllowed(req) ? origin : undefined)
  }

  private handleGet(req: IncomingMessage, res: ServerResponse): void {
    // Remote auth: an SSE stream is as sensitive as any tool call — it receives
    // every push for the session it attaches to, INCLUDING message content. So it
    // must pass the same OWNERSHIP check a tool call does, not merely "presents
    // some valid token": binding another user's session to yourself both leaks
    // their mail to your stream and locks them out of their own session.
    let streamIdentity: TokenIdentity | undefined
    if (this.authenticate !== undefined) {
      streamIdentity = this.authenticate(req)
      if (streamIdentity === undefined) {
        res.writeHead(401, { ...this.corsFor(req), 'Content-Type': 'application/json; charset=utf-8', 'Mcp-Protocol-Version': messageProtocolVersion(req) })
        res.end(JSON.stringify({ error: 'unauthorized: missing or invalid bearer token' }))
        return
      }
      const existing = this.registry.sessionIdFor(req)
      const bound = existing === undefined ? undefined : this.registry.tokenFor(existing)
      // Same allow-join carve-out as the POST path: a walk-in's sentinel identity
      // must keep matching the session it minted.
      const bothAnonymous = bound?.anonymous === true && streamIdentity.anonymous === true
      if (bound !== undefined && !bothAnonymous && (bound.peer !== streamIdentity.peer || bound.role !== streamIdentity.role)) {
        this.unauthorized(req, res, null, 'token does not match this session')
        return
      }
    }
    // Validation ORDER, both methods: auth → protocol version → session.
    // The order decides which status code wins when more than one check fails, so
    // it has to match on both paths — otherwise the same request answers
    // differently depending on the method it arrived as.
    //
    // It is NOT an oracle fix, and the earlier version of this comment was wrong
    // to claim otherwise: a caller holding a valid token of their own can still
    // tell whether somebody else's session id exists (401 vs 400 here; 401 vs 404
    // with a usable version). That is the documented, deliberate boundary in
    // server/README.md (W54) — a status code cannot hide it while 404 has to keep
    // meaning "re-initialize".
    if (this.protocolVersionRejected(req, res)) return
    // Same 404 rule on the SSE stream: a stale id must not silently attach a
    // stream to a fresh session.
    const streamSession = this.registry.sessionIdFor(req)
    if (streamSession !== undefined && !this.registry.hasSession(streamSession)) {
      this.jsonRpcError(req, res, null, -32001, 'session not found — send a new initialize request', undefined, 404)
      return
    }
    // A request that presented a known id is what "this session is alive" means.
    this.registry.touch(streamSession)
    const sessionId = this.registry.ensureSession(streamSession)
    if (this.presentedManagerToken(req)) this.registry.markManagerSession(sessionId)
    // Reuse the identity resolved above — authenticating twice per request was a
    // second, independent reading of the same header.
    if (streamIdentity !== undefined) this.registry.bindToken(sessionId, streamIdentity)
    res.writeHead(200, {
      ...this.corsFor(req),
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      // nginx (and anything else speaking X-Accel) buffers proxied responses by
      // default, which breaks SSE completely: events sit in the proxy until its
      // buffer fills or the stream ends, so a client never sees a push. This header
      // is the in-band way to turn that off — it needs no proxy configuration, and
      // a proxy that ignores it is unaffected.
      'X-Accel-Buffering': 'no',
      // Same header the POST path sets: the client should see the version the
      // server is speaking on every 200, not only on JSON responses.
      'Mcp-Protocol-Version': messageProtocolVersion(req),
      ...(req.headers['mcp-session-id'] ? {} : { 'Mcp-Session-Id': sessionId }),
    })
    res.write(': connected\n\n')
    this.sseStreams.set(sessionId, res)
    this.registry.markSseOpen(sessionId)
    req.on('close', () => {
      // Tear down only what is still OURS. A second GET on the same session id
      // replaces the entry above; without these guards the first stream closing
      // deletes the second one's entry AND marks the session as having no live
      // stream, so the still-open stream goes silent (and `sweep()` may then
      // reap a session that is still connected).
      if (this.sseStreams.get(sessionId) === res) this.sseStreams.delete(sessionId)
      if (!this.sseStreams.has(sessionId)) this.registry.markSseClosed(sessionId)
    })
  }

  /** Reject a request without a valid token (remote auth mode). */
  private unauthorized(req: IncomingMessage, res: ServerResponse, id: number | string | null, why: string): void {
    res.writeHead(401, {
      ...this.corsFor(req),
      'Content-Type': 'application/json; charset=utf-8',
      // MCP authorization spec: a 401 MUST carry WWW-Authenticate. The hub does not
      // implement OAuth (authorization is OPTIONAL in MCP), so there is no
      // resource_metadata to advertise — the bare scheme is still required.
      'WWW-Authenticate': 'Bearer',
      // Every response names the protocol version the server is speaking, errors
      // included: a client that only sees 401s still needs to know what it is
      // talking to before it can decide whether to retry.
      'Mcp-Protocol-Version': messageProtocolVersion(req)
    })
    res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32001, message: `unauthorized: ${why}` } }))
  }

  /** Management API for the bundled admin page: issue/revoke tokens and list
   * them. Like everything else, each call is authenticated by `authenticate`
   * and must resolve to a MANAGER role — an agent token gets 403. */
  private async handleAdminApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const respond = (status: number, body: unknown): void => {
      res.writeHead(status, { ...this.corsFor(req), 'Content-Type': 'application/json; charset=utf-8' })
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
        this.unauthorized(req, res, null, 'missing or invalid bearer token')
        return
      }
      const existingSession = this.registry.sessionIdFor(req)
      const bound = existingSession === undefined ? undefined : this.registry.tokenFor(existingSession)
      // allow-join walk-ins present NO token on later requests: the sentinel
      // identity ('__join__') must keep matching the session's already-minted
      // unique anonymous peer. Only a real (non-anonymous) mismatch is fraud.
      const bothAnonymous = bound?.anonymous === true && authIdentity.anonymous === true
      if (bound !== undefined && !bothAnonymous && (bound.peer !== authIdentity.peer || bound.role !== authIdentity.role)) {
        this.unauthorized(req, res, null, 'token does not match this session')
        return
      }
      // A KNOWN session may still have no token binding yet (a session minted
      // by an earlier stream, say): re-bind it here so a request never degrades
      // to a nameless 'agent' peer.
      if (existingSession !== undefined && bound === undefined && !authIdentity.anonymous) {
        this.registry.bindToken(existingSession, authIdentity)
      }
    }
    // Spec MUST: a request presenting a session id the hub does not know is
    // answered 404, so the client starts a new session instead of carrying on
    // under an id that maps to nothing. A hub restart creates exactly this for
    // every connected client — which used to be papered over by adopting the id
    // (see the remote-auth re-bind above), leaving clients permanently adrift.
    if (this.protocolVersionRejected(req, res)) return
    const presentedSession = this.registry.sessionIdFor(req)
    if (presentedSession !== undefined && !this.registry.hasSession(presentedSession)) {
      this.jsonRpcError(req, res, null, -32001, 'session not found — send a new initialize request', undefined, 404)
      return
    }
    // Same here: the id resolved, so the session was used just now.
    this.registry.touch(presentedSession)
    let body: Buffer
    try {
      body = await readBody(req)
    } catch (error) {
      this.jsonRpcError(req, res, null, -32700, `parse error: ${(error as Error).message}`)
      return
    }
    let message: JsonRpcRequest
    try {
      message = JSON.parse(body.toString('utf8')) as JsonRpcRequest
    } catch {
      this.jsonRpcError(req, res, null, -32700, 'parse error: invalid JSON')
      return
    }
    if (typeof message !== 'object' || message === null || message.method === undefined) {
      this.jsonRpcError(req, res, message?.id ?? null, -32600, 'invalid request')
      return
    }
    const id = message.id ?? null
    const sessionId = this.registry.sessionIdFor(req)
    if (sessionId !== undefined) this.registry.sessionIps.set(sessionId, clientIp(req))
    // Loopback mode has no token table, so the manager secret is proven per request
    // and remembered on the session (bridge_register runs after initialize).
    if (sessionId !== undefined && this.presentedManagerToken(req)) this.registry.markManagerSession(sessionId)

    // Notifications carry no id: acknowledge and move on.
    if (id === null) {
      res.writeHead(202, { ...this.corsFor(req), 'Content-Length': '0' }).end()
      return
    }

    try {
      const { result, extraHeaders } = await this.dispatch(message, sessionId, authIdentity)
      res.writeHead(200, {
        ...this.corsFor(req),
        'Content-Type': 'application/json; charset=utf-8',
        'Mcp-Protocol-Version': messageProtocolVersion(req),
        ...extraHeaders,
      })
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result }))
    } catch (error) {
      const code = (error as { code?: number }).code ?? -32603
      this.jsonRpcError(req, res, id, code, (error as Error).message)
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

  /** Spec MUST: a request carrying an `MCP-Protocol-Version` this server does
   *  not implement gets 400. Absent is fine — an absent header means the client is
   *  on the newest revision this server knows, which is what responses advertise
   *  (`messageProtocolVersion` returns LATEST_VERSION) —
   *  but *present and unknown* is a client speaking a revision whose rules this
   *  server would otherwise be guessing at. Writes the response itself and
   *  reports whether it did. */
  private protocolVersionRejected(req: IncomingMessage, res: ServerResponse): boolean {
    const presented = req.headers['mcp-protocol-version']
    if (presented === undefined) return false
    if (typeof presented === 'string' && (SUPPORTED_VERSIONS as readonly string[]).includes(presented)) return false
    this.jsonRpcError(req, res, null, -32600, `unsupported MCP-Protocol-Version: ${String(presented).slice(0, 64)} (supported: ${SUPPORTED_VERSIONS.join(', ')})`, undefined, 400)
    return true
  }

  private jsonRpcError(
    req: IncomingMessage,
    res: ServerResponse,
    id: number | string | null,
    code: number,
    message: string,
    data?: unknown,
    status?: number,
  ): void {
    const code400 = code === -32700 || code === -32600
    const httpStatus = status ?? (code400 ? 400 : 200)
    res.writeHead(httpStatus, {
      ...this.corsFor(req),
      'Content-Type': 'application/json; charset=utf-8',
      'Mcp-Protocol-Version': messageProtocolVersion(req),
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
  // Advertise only a version the server actually speaks. Echoing whatever the
  // client sent put an UNSUPPORTED value into the response header, so a client
  // that presented garbage was told the server speaks garbage — and the 400 that
  // rejected that same version carried it back as if it were ours.
  const presented = req.headers['mcp-protocol-version']
  return typeof presented === 'string' && (SUPPORTED_VERSIONS as readonly string[]).includes(presented)
    ? presented
    : LATEST_VERSION
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

/** First value of a possibly-repeated request header, trimmed; undefined when absent. */
function headerValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined
}

/** Constant-time compare for secrets; a length mismatch is not itself secret. */
function secretEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

/** Hostname of an `Origin` header, lowercased; undefined when unparseable. */
function originHostname(origin: string): string | undefined {
  try {
    return new URL(origin).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

/** Hostname of a `Host` header (`host:port` / `[::1]:port`); undefined when unparseable. */
function hostHeaderName(host: string): string | undefined {
  try {
    return new URL(`http://${host}`).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

/**
 * Is this hostname (or bind address) loopback? Recognises the whole 127.0.0.0/8
 * block, `localhost` with or without a trailing dot, and IPv6 `::1`.
 *
 * The dotted-quad is validated rather than prefix-matched: a bare `127.` prefix
 * would also accept `127.evil.example`, which an attacker's DNS can point at
 * 127.0.0.1 — exactly the rebinding shape this gate exists to stop.
 */
export function isLoopbackHost(host: string): boolean {
  const name = host.trim().toLowerCase().replace(/\.$/, '')
  if (name === 'localhost' || name === '::1' || name === '[::1]') return true
  const quad = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name)
  return quad !== null && quad.slice(1).every(octet => Number(octet) <= 255)
}

/** Request headers a browser client may send to the MCP endpoint. */
const ALLOWED_REQUEST_HEADERS = 'content-type, mcp-session-id, mcp-protocol-version, authorization'

/**
 * CORS response headers. `allowOrigin` is echoed only when the caller may talk to
 * this hub; omitting the header means "no cross-origin read" — never `*`.
 *
 * `Vary: Origin` is sent unconditionally: the header set now depends on the
 * request's Origin, so every cacheable response (including the 403s) must say so.
 * `Expose-Headers` is what lets a browser read the session id back out of a
 * cross-origin response — without it `--allow-origins` would accept a browser
 * client's first call and then leave it unable to continue the session.
 */
function corsHeaders(allowOrigin?: string): Record<string, string> {
  return {
    Vary: 'Origin',
    ...(allowOrigin !== undefined ? { 'Access-Control-Allow-Origin': allowOrigin } : {}),
    'Access-Control-Allow-Headers': ALLOWED_REQUEST_HEADERS,
    // Exposed so a cross-origin browser client can actually READ the version the
    // server is speaking: without this the header is set but invisible to script.
    'Access-Control-Expose-Headers': 'Mcp-Session-Id, Mcp-Protocol-Version',
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
