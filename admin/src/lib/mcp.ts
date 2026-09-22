/** Minimal MCP streamable-http client for the admin console (hub /mcp) plus the
 * manager-only `/admin/api` token calls the page needs. */

export interface BridgeMessage {
  id: string
  from: string
  to: string
  kind: 'chat' | 'task' | 'ack' | 'notice'
  content: unknown
  ref?: string
  channel?: string
  threadId?: string
  hop?: number
  ts: number
}

/** One row of `bridge_peers` (richer than `bridge_status`: it also carries the
 * display identity, the source IP(s) and the anonymous-join flag). */
export interface PeerRow {
  id: string
  alias?: string
  clientName?: string
  clientVersion?: string
  anonymous?: boolean
  clientIps?: string[]
  connected: boolean
  lastSeenMs: number
}

export interface TaskAckRow {
  from: string
  status: string
  note?: string
  progress?: number
  ts: number
  applied?: boolean
  system?: boolean
}

export interface TaskRow {
  id: string
  from: string
  to: string
  prompt: string
  status: string
  threadId?: string
  timeoutMs?: number
  deadlineAt?: number
  acks: TaskAckRow[]
  assignees?: Array<{ peerId: string; status: string; deliveredMs?: number }>
  createdAt: number
  updatedAt: number
}

export interface TokenRow {
  token: string
  peer: string
  role: 'agent' | 'manager'
  owner?: string
}

export interface HubStatus {
  server?: string
  historyLimit?: number
  maxQueue?: number
}

/** HTTP failure from `/admin/api`, carrying the status so callers can tell
 * "no token table in local mode" (404) from a real error. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export class McpClient {
  private sid: string | null = null
  private id = 0
  private ready = false

  constructor(
    private readonly endpoint: string,
    private readonly token: string,
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    }
    if (this.token !== '') h.Authorization = `Bearer ${this.token}`
    if (this.sid !== null) h['Mcp-Session-Id'] = this.sid
    return h
  }

  private async rpc(method: string, params?: unknown): Promise<Record<string, unknown>> {
    const body = {
      jsonrpc: '2.0',
      id: ++this.id,
      method,
      ...(params !== undefined ? { params } : {}),
    }
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    })
    const sid = res.headers.get('mcp-session-id')
    if (sid) this.sid = sid
    if (res.status === 401) throw new ApiError('unauthorized：请检查 manager token', 401)
    // The hub forgot the session (restart): forget it too, so the next refresh
    // re-initializes instead of retrying a dead id forever.
    if (res.status === 404) {
      this.ready = false
      this.sid = null
      throw new ApiError('session expired：正在重新连接', 404)
    }
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
    if (!json || json.error) {
      const err = json?.error as { message?: string } | undefined
      throw new ApiError(err?.message ?? `HTTP ${res.status}`, res.status)
    }
    return json
  }

  /** Idempotent: one MCP session per client instance, reused by every poll. */
  async connect(): Promise<void> {
    if (this.ready) return
    await this.rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'hub-admin', version: '1.0' },
    })
    await fetch(this.endpoint, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    })
    this.ready = true
  }

  async call<T = Record<string, unknown>>(tool: string, args?: Record<string, unknown>): Promise<T> {
    await this.connect()
    const json = await this.rpc('tools/call', { name: tool, arguments: args ?? {} })
    const result = json.result as
      | { content?: Array<{ text?: string }>; isError?: boolean }
      | undefined
    const text = result?.content?.[0]?.text ?? '{}'
    const parsed = JSON.parse(text) as T & { error?: string }
    if (result?.isError === true) throw new ApiError(parsed.error ?? `${tool} failed`, 200)
    return parsed
  }

  status(): Promise<HubStatus & { peers?: Array<{ id: string; connected: boolean }> }> {
    return this.call('bridge_status')
  }

  peers(): Promise<{ peers: PeerRow[] }> {
    return this.call('bridge_peers')
  }

  history(limit = 30): Promise<{ messages: BridgeMessage[] }> {
    return this.call('bridge_history', { peer: 'all', limit })
  }

  groups(): Promise<{ groups: Array<{ id: string; name?: string; members: string[]; createdBy: string }> }> {
    return this.call('bridge_group_list')
  }

  tasks(limit = 50): Promise<{ tasks: TaskRow[] }> {
    return this.call('bridge_tasks', { peer: 'all', limit })
  }
}

async function request(
  origin: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const res = await fetch(origin + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token !== '' ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
  const failure = json === null || typeof json.error === 'string' ? json?.error : undefined
  if (json === null || typeof failure === 'string') {
    throw new ApiError(typeof failure === 'string' ? failure : `HTTP ${res.status}`, res.status)
  }
  return json
}

/** Manager-only token table behind `/admin/api` (absent in local mode). */
export const adminApi = {
  async list(origin: string, token: string, reveal: boolean): Promise<TokenRow[]> {
    const json = await request(origin, token, 'GET', `/admin/api/tokens${reveal ? '?reveal=1' : ''}`)
    return (json.tokens ?? []) as TokenRow[]
  },
  async add(
    origin: string,
    token: string,
    input: { peer: string; role: string; owner?: string },
  ): Promise<TokenRow> {
    const json = await request(origin, token, 'POST', '/admin/api/tokens/add', input)
    return (json.created ?? {}) as TokenRow
  },
  async remove(origin: string, token: string, peer: string): Promise<boolean> {
    const json = await request(origin, token, 'DELETE', `/admin/api/tokens/remove/${encodeURIComponent(peer)}`)
    return json.removed === true
  },
}
