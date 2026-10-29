/**
 * Bridge tools exposed to every MCP client. All results are lossless JSON
 * (the DSH tool registry contract; kept strict here so the hub is usable
 * from DSH's native tool layer too). Sender identity comes from the
 * session→peer binding established by `bridge_register`.
 */

import type { AgentHub } from './hub.js'
import type { McpTool, SessionRegistry } from './mcp-server.js'
import { AGENT_STATUSES, type HerdrCtl } from './herdr-ctl.js'
import { ALL_ACK_STATUSES, ALL_TASK_STATUSES, CLIENT_ACK_STATUSES, TERMINAL_TASK_STATUSES, a2aState, ackToTaskStatus, decodeContent, encodeContent, type AckContent, type AckStatus, type BridgeMessage, BROADCAST, HUB_PEER, type NoticeContent, type NoticeLevel, PEER_ID_PATTERN, type PeerCard, type TaskArtifact, type TaskContent, type TaskStatus, type WaitResult } from './protocol.js'
import { ANON_JOIN_PEER } from './auth.js'

/** Default wait budget when a client omits timeoutMs. */
export const DEFAULT_WAIT_MS = 30_000

/** Message presented to a model: task/ack payloads decoded to objects.
 *  Undefined `ref` is dropped — lossy JSON values are rejected by strict
 *  tool registries (e.g. DSH's lossless-JSON validation). */
export type PresentedMessage = Omit<BridgeMessage, 'content'> & {
  content: string | TaskContent | AckContent | NoticeContent
  /** A2A naming alias for `ref` on an ack. Additive: `ref` stays the
   *  authoritative field, this is the same value under A2A's name. */
  taskId?: string
  /** A2A naming alias for `threadId`. */
  contextId?: string
}

export function present(message: BridgeMessage): PresentedMessage {
  const { ref, channel, threadId, hop, ...rest } = message
  return {
    ...rest,
    ...(ref !== undefined ? { ref } : {}),
    ...(channel !== undefined ? { channel } : {}),
    ...(threadId !== undefined ? { threadId } : {}),
  ...(hop !== undefined ? { hop } : {}),
    // A2A speaks `taskId` / `contextId`; our names stay, these ride along.
    ...(message.kind === 'ack' && ref !== undefined ? { taskId: ref } : {}),
    ...(threadId !== undefined ? { contextId: threadId } : {}),
    content: decodeContent(message.kind, message.content),
  }
}

/** Sanitize a client-reported name into a valid peer id base. */
export function sanitizePeerId(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return cleaned === '' ? 'agent' : cleaned
}

/** Validate a display alias: trimmed, 1–64 chars, no control characters.
 * Unlike peer ids, aliases may contain spaces / CJK — they are only shown,
 * never routed or used as a Map key. */
export function sanitizeAlias(alias: string): string {
  const cleaned = alias.trim()
  if (cleaned === '') throw new Error('alias must not be empty')
  if (cleaned.length > 64) throw new Error(`alias too long: ${cleaned.length} chars (max 64)`)
  if (/[\u0000-\u001f\u007f]/.test(cleaned)) throw new Error('alias must not contain control characters')
  return cleaned
}

/**
 * Auto-register a session. In remote auth mode the session's TOKEN decides
 * the peer id (each token maps to one identity — two people running the same
 * client stay two peers instead of sharing a mailbox); loopback mode keeps
 * deriving the id from the client-reported name. Same-id connections ATTACH
 * to the same peer (N:1, one stable identity per agent). No-op when the
 * session is already bound or explicitly unregistered. Returns the peer id.
 */
export function autoRegisterPeer(
  hub: AgentHub,
  registry: SessionRegistry,
  sessionId: string | undefined,
  clientName: string | undefined,
  clientVersion?: string,
): string | undefined {
  if (sessionId === undefined) return undefined
  const bound = registry.peerFor(sessionId)
  if (bound !== undefined) return bound
  if (registry.isSuppressed(sessionId)) return undefined
  const tokenPeer = registry.tokenFor(sessionId)?.peer
  // Sentinel = anonymous walk-in whose initialize-resolution never ran (e.g.
  // it started from an SSE stream): give it a session-unique fallback id so
  // it can never merge with another walk-in.
  const derived = tokenPeer === ANON_JOIN_PEER
    ? `join-${sanitizePeerId(clientName ?? 'agent')}-${Math.random().toString(36).slice(2, 6)}`
    : (tokenPeer ?? sanitizePeerId(clientName ?? 'agent'))
  // A client whose reported name sanitizes to a reserved id (`all` / `hub`) or to
  // a group's id gets a generated one instead of an error: auto-registration runs
  // on the connect path, and throwing here would simply leave a legitimate client
  // unable to make ANY tool call for as long as that group exists — a permanent
  // lockout of a whole class of agents (every `claude-code` session, the moment
  // someone creates a group called `claude-code`). The fallback only decides what
  // it is called instead; it still cannot take such an id, so `hub.register`'s
  // namespace guards hold. Only the explicit paths (bridge_register,
  // bridge_rename) report the collision as an error: a human-chosen id deserves a
  // clear message, an auto-derived one does not.
  //
  // A PARKED id is deliberately NOT in this fallback: the connect path IS the
  // identity coming back (same client name, or the token that defines it), and
  // reclaiming its own mailbox is the whole point of parking. Diverting it to
  // `agent-xxxx` would strand that mail — and the tasks queued in it.
  const peerId = derived === BROADCAST || derived === HUB_PEER || hub.groupOf(derived) !== undefined
    ? `agent-${Math.random().toString(36).slice(2, 6)}`
    : derived
  if (!hub.has(peerId)) {
    hub.register(peerId, {
      ...(clientName !== undefined ? { name: clientName } : {}),
      ...(clientVersion !== undefined ? { version: clientVersion } : {}),
    }, { reclaim: true })
  }
  registry.bindPeer(sessionId, peerId)
  hub.touch(peerId)
  return peerId
}

/** Peers whose session has a live SSE stream (count as connected, GC-safe). */
export function livePeersFor(registry: SessionRegistry): Set<string> {
  const live = new Set<string>()
  const streams = registry.liveSessions()
  for (const [sessionId, peerId] of registry.peerBindings) {
    if (streams.has(sessionId)) live.add(peerId)
  }
  return live
}

/** Roster snapshot: live state per peer merged with its profile metadata.
 * Shared by the bridge_peers tool and the `peers_changed` SSE event so both
 * always expose the same shape. */
export function rosterFor(hub: AgentHub, registry: SessionRegistry): Array<Record<string, unknown>> {
  const status = hub.status(livePeersFor(registry))
  // Realtime, per-session metadata synthesized from the registry (never
  // persisted): source IP(s) and the anonymous-join flag let the admin roster
  // tell Zhang San's kimi-code from Li Si's and spot walk-ins to claim.
  const peerIps = new Map<string, string[]>()
  const peerAnon = new Map<string, boolean>()
  for (const [session, peer] of registry.peerBindings) {
    const ip = registry.sessionIps.get(session)
    if (ip !== undefined) {
      const list = peerIps.get(peer) ?? []
      if (!list.includes(ip)) list.push(ip)
      peerIps.set(peer, list)
    }
    const identity = registry.tokenFor(session)
    if (identity?.anonymous === true) peerAnon.set(peer, true)
  }
  return status.peers.map(peer => {
    const profile = hub.profileOf(peer.id)
    const alias = profile?.alias
    const clientName = profile?.clientName
    const clientVersion = profile?.clientVersion
    const ips = peerIps.get(peer.id)
    return {
      id: peer.id,
      ...(alias !== undefined ? { alias } : {}),
      ...(clientName !== undefined ? { clientName } : {}),
      ...(clientVersion !== undefined ? { clientVersion } : {}),
      // The announced card rides with the roster: `bridge_peers` is how an agent
      // sees who else is here, and a card nobody can read is not announced.
      ...(profile?.card !== undefined ? { card: profile.card } : {}),
      ...(peerAnon.get(peer.id) === true ? { anonymous: true } : {}),
      ...(ips !== undefined && ips.length > 0 ? { clientIps: ips } : {}),
      connected: peer.connected,
      // W7: keep the reachability verdict and the queue depth in the tool output —
      // `connected: false` alone cannot say "idle, will read it later" apart from
      // "gone, and your message is nowhere".
      reachable: peer.reachable,
      queued: peer.queued,
      lastSeenMs: peer.lastSeenMs,
    }
  })
}

/** Options accepted by {@link hubTools}. */
export interface HubToolsOptions {
  defaultWaitMs?: number
  waitTimeoutMs: number
  /** herdr control adapter; when omitted the bridge_agent_* tools error out
   * with "herdr control not enabled". */
  herdr?: HerdrCtl
  /** Peers allowed to use the control tools (bridge_agent_*). `'all'`
   * (default) mirrors the hub's loopback-only trust model; pass a set of
   * peer ids to restrict who may type into agent terminals. */
  herdrControlPeers?: ReadonlySet<string> | 'all'
  /** Peers allowed to manage the roster: rename other peers (bridge_rename),
   * kick peers (bridge_unregister with `peer`). `'all'` keeps the loopback
   * trust model; the default is the desktop/CLI archiver identity. */
  managerPeers?: ReadonlySet<string> | 'all'
  /** True when a manager credential is actually configured (`--manager-token` or
   * `<stateFileDir>/manager.token`). Only then are manager ids reserved: without
   * a credential there is nothing to check, and refusing the claim would break
   * every existing loopback setup (the desktop GUI included). */
  managerTokenRequired?: boolean
  /** Every peer id an access token is bound to, read FRESH on each call (the
   * table changes at runtime through the token admin API). Optional: when it is
   * not supplied, `bridge_rename` falls back to the registry's live bindings.
   *
   * It has to be a supplier, not a snapshot, and it has to cover tokens with NO
   * session: the live bindings only know the tokens currently connected, so an
   * operator id that was configured but had not connected yet looked unclaimed —
   * and a rename onto it made that operator's next connect ATTACH to the
   * impostor's mailbox (`autoRegisterPeer` sees `hub.has(peerId)`). */
  tokenPeers?: () => ReadonlySet<string>
}

/** Cap for one `ids` array on bridge_commit / bridge_nack. The hub releases
 *  leases synchronously and one call has no business walking an arbitrarily
 *  long list; a caller with more than this is told to split the call instead. */
const MAX_LEASE_IDS = 1000

/**
 * The single definition of "is this session a hub manager?".
 *
 * Three paths grant it:
 *  - a token with role 'manager' (remote auth mode — authenticated), or
 *  - the manager token presented on this session, when one is configured, or
 *  - membership of `managerPeers` — but ONLY while no manager token is
 *    configured; without a credential that stays a loopback convention.
 *
 * The gate is on the PRIVILEGE, not on the peer id: the shipped desktop GUI
 * calls itself `agent-hub-cli` at initialize, so reserving the id would stop it
 * from connecting at all — and would buy nothing, since an attacker that claims
 * the id gets no manager power without the credential.
 *
 * Exported because the SSE relay in `index.ts` needs the same answer. Those two
 * call sites drifted once: the tool gate was fixed and the relay was not, so an
 * unauthenticated peer that claimed a manager id received the whole hub's live
 * traffic while the credential-holding session received none.
 */
export function isManagerCaller(
  registry: SessionRegistry,
  sessionId: string | undefined,
  peer: string | undefined,
  options: Pick<HubToolsOptions, 'managerPeers' | 'managerTokenRequired'>,
): boolean {
  if (registry.tokenFor(sessionId)?.role === 'manager') return true
  if (options.managerTokenRequired === true) return registry.isManagerSession(sessionId)
  const managers = options.managerPeers ?? 'all'
  if (managers === 'all') return true
  return peer !== undefined && managers.has(peer)
}

/** Build the bridge tool set bound to one hub instance. */
export function hubTools(hub: AgentHub, registry: SessionRegistry, options: HubToolsOptions): McpTool[] {

  const schema = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  })
  const str = (description: string): Record<string, unknown> => ({ type: 'string', description })
  const int = (description: string): Record<string, unknown> => ({ type: 'integer', description })
  const optStr = str
  /** Schema fragment for the optional 0|1|2 delivery priority (see `BridgeMessage.priority`). */
  const priorityField = (): Record<string, unknown> => ({
    type: 'integer',
    enum: [0, 1, 2],
    description: 'Delivery importance inside the recipient\'s mailbox: 2 beats 1 beats 0. Default 0 (plain FIFO). Also decides what overflow drops — the LEAST important queued message goes, not the oldest.',
  })
  /** Read the `priority` argument; anything that is not 0/1/2 is treated as unset. */
  const optPriority = (value: unknown): { priority?: 0 | 1 | 2 } =>
    value === 0 || value === 1 || value === 2 ? { priority: value } : {}
  /** Validate an `ids` argument (used by bridge_commit / bridge_nack). */
  const idList = (value: unknown, tool: string): string[] => {
    if (!Array.isArray(value)) throw new Error(`${tool} expects ids: an array of message ids`)
    if (value.length > MAX_LEASE_IDS) {
      throw new Error(`${tool} accepts at most ${MAX_LEASE_IDS} ids per call (got ${value.length}); commit or nack in batches`)
    }
    const ids = value.filter((id): id is string => typeof id === 'string' && id !== '')
    if (ids.length === 0) throw new Error(`${tool} expects at least one message id`)
    return ids
  }
  /** Validate the `statuses` filter of bridge_wait. An unknown value is a
   *  caller mistake worth reporting: silently dropping it would leave a wait
   *  that can never match, and silently keeping it would compare against a
   *  status no ack can carry — the same failure, with no clue why.
   *
   *  `terminalOnly` takes the INTERSECTION of `statuses` with the terminal acks,
   *  so `{ statuses: ['working'], terminalOnly: true }` can never match anything
   *  and would quietly burn the whole `timeoutMs`. Two filters that contradict
   *  each other are a caller mistake with a definite answer, not a wait to sit
   *  out — say so at call time, the same way an unknown status is refused. */
  const ackStatuses = (value: unknown, terminalOnly: boolean): readonly AckStatus[] | undefined => {
    if (value === undefined) return undefined
    if (!Array.isArray(value)) throw new Error('statuses must be an array of ack statuses')
    if (value.length === 0) throw new Error('statuses must not be empty — omit it to wait for any ack')
    const out: AckStatus[] = []
    for (const entry of value) {
      if (typeof entry !== 'string' || !(ALL_ACK_STATUSES as readonly string[]).includes(entry)) {
        throw new Error(`invalid statuses entry: ${JSON.stringify(entry)} (expected one of ${ALL_ACK_STATUSES.join(' | ')})`)
      }
      out.push(entry as AckStatus)
    }
    if (terminalOnly) {
      // Derived from TERMINAL_TASK_STATUSES, never re-typed: the two lists must
      // not be able to disagree about what "terminal" means.
      const terminalAcks = TERMINAL_TASK_STATUSES.filter(status => (ALL_ACK_STATUSES as readonly string[]).includes(status))
      if (!out.some(status => terminalAcks.includes(ackToTaskStatus(status)))) {
        throw new Error(`statuses and terminalOnly are combined by intersection, and ${out.join(' | ')} contains no terminal ack status (${terminalAcks.join(' | ')}) — the wait could never resolve`)
      }
    }
    return out
  }
  /** Validate an absolute epoch-ms deadline. A deadline already in the past is a
   *  caller mistake, not a message to drop silently — say so at send time. */
  const deadline = (value: unknown): number => {
    const at = Number(value)
    if (!Number.isFinite(at) || at <= 0) throw new Error(`invalid expiresAt: ${String(value)} (expected epoch milliseconds)`)
    if (at <= Date.now()) throw new Error(`expiresAt is already in the past: ${new Date(at).toISOString()}`)
    return at
  }
  /** Validate `artifacts` on an ack: a list of `{name, text?/url?}` objects. An
   *  artifact with neither text nor url carries no information, so it is refused
   *  rather than stored as a placeholder. */
  const parseArtifacts = (value: unknown): TaskArtifact[] | undefined => {
    if (value === undefined) return undefined
    if (!Array.isArray(value)) throw new Error('artifacts must be an array of {name, text?/url?} objects')
    const out: TaskArtifact[] = []
    for (const [index, entry] of value.entries()) {
      if (typeof entry !== 'object' || entry === null) throw new Error(`artifacts[${index}] must be an object`)
      const raw = entry as Record<string, unknown>
      if (typeof raw.name !== 'string' || raw.name === '') throw new Error(`artifacts[${index}].name is required`)
      const artifact: TaskArtifact = { name: raw.name }
      if (typeof raw.mimeType === 'string' && raw.mimeType !== '') artifact.mimeType = raw.mimeType
      if (typeof raw.text === 'string') artifact.text = raw.text
      if (typeof raw.url === 'string' && raw.url !== '') artifact.url = raw.url
      if (artifact.text === undefined && artifact.url === undefined) {
        throw new Error(`artifacts[${index}] needs text or url — an artifact with neither says nothing`)
      }
      out.push(artifact)
    }
    return out.length > 0 ? out : undefined
  }
  /** Validate an announced card. Everything is optional, but what IS present has
   *  to be the right shape — a card is what other agents make routing decisions
   *  on, so a half-parsed one is worse than none. */
  const parseCard = (value: unknown): PeerCard => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('card must be an object')
    const raw = value as Record<string, unknown>
    const card: PeerCard = {}
    if (raw.skills !== undefined) {
      if (!Array.isArray(raw.skills)) throw new Error('card.skills must be an array')
      card.skills = raw.skills.map((entry, index) => {
        if (typeof entry !== 'object' || entry === null) throw new Error(`card.skills[${index}] must be an object`)
        const skill = entry as Record<string, unknown>
        if (typeof skill.id !== 'string' || skill.id === '') throw new Error(`card.skills[${index}].id is required`)
        if (typeof skill.name !== 'string' || skill.name === '') throw new Error(`card.skills[${index}].name is required`)
        return {
          id: skill.id,
          name: skill.name,
          ...(typeof skill.description === 'string' ? { description: skill.description } : {}),
          ...(Array.isArray(skill.tags) ? { tags: skill.tags.filter((tag): tag is string => typeof tag === 'string') } : {}),
        }
      })
    }
    if (raw.acceptsTasks !== undefined) {
      if (typeof raw.acceptsTasks !== 'boolean') throw new Error('card.acceptsTasks must be a boolean')
      card.acceptsTasks = raw.acceptsTasks
    }
    if (raw.concurrency !== undefined) {
      if (!Number.isInteger(raw.concurrency) || (raw.concurrency as number) < 0) throw new Error('card.concurrency must be a non-negative integer')
      card.concurrency = raw.concurrency as number
    }
    for (const key of ['inputModes', 'outputModes'] as const) {
      const list = raw[key]
      if (list === undefined) continue
      if (!Array.isArray(list)) throw new Error(`card.${key} must be an array of strings`)
      card[key] = list.filter((entry): entry is string => typeof entry === 'string')
    }
    if (raw.runner !== undefined) {
      if (!['herdr', 'cli', 'http', 'none'].includes(String(raw.runner))) throw new Error("card.runner must be one of herdr | cli | http | none")
      card.runner = raw.runner as PeerCard['runner']
    }
    if (raw.endpoint !== undefined) {
      if (typeof raw.endpoint !== 'string' || raw.endpoint === '') throw new Error('card.endpoint must be a non-empty string')
      card.endpoint = raw.endpoint
    }
    return card
  }

  /**
   * Resolve the calling peer. Unregistered sessions auto-register using the
   * client-reported name (from the MCP initialize clientInfo) unless the
   * session explicitly unregistered — connecting the MCP is enough to join.
   */

  const requirePeer = (sessionId: string | undefined): string => {
    const bound = registry.peerFor(sessionId)
    if (bound !== undefined) {
      hub.touch(bound)
      return bound
    }
    const auto = autoRegisterPeer(hub, registry, sessionId, registry.clientName(sessionId))
    if (auto !== undefined) {
      hub.touch(auto)
      return auto
    }
    throw new Error('not registered — call bridge_register(peerId) first')
  }

  const receipt = (message: BridgeMessage): unknown => ({
    ok: true,
    id: message.id,
    // The sender needs this back: it is the cursor to record.
    ...(message.seq !== undefined ? { seq: message.seq } : {}),
    from: message.from,
    to: message.to,
    kind: message.kind,
    ...(message.ref !== undefined ? { ref: message.ref } : {}),
    ...(message.channel !== undefined ? { channel: message.channel } : {}),
    // A2A aliases (additive): a task receipt answers with `taskId`, and a
    // threaded message carries its `contextId`.
    ...(message.kind === 'task' ? { taskId: message.id } : {}),
    ...(message.threadId !== undefined ? { contextId: message.threadId } : {}),
    ...(message.threadId !== undefined ? { threadId: message.threadId } : {}),
    ...(message.hop !== undefined ? { hop: message.hop } : {}),
    ts: message.ts,
  })

  const presentWait = (result: WaitResult): unknown => {
    if (result.type === 'timeout') return result
    if (result.type === 'messages') return { type: 'messages', messages: result.messages.map(present) }
    return { type: 'message', message: present(result.message) }
  }

  /**
   * Gate the control tools (bridge_agent_*): they type into real terminals,
   * so they are stricter than message tools. `'all'` keeps the hub's
   * loopback-only trust model; an explicit peer set narrows who may control.
   */
  const checkControl = (peer: string): HerdrCtl => {
    const herdr = options.herdr
    if (herdr === undefined) {
      throw new Error('herdr control not enabled — start the hub with --herdr-bin or pass a herdrCtl to hubTools')
    }
    const control = options.herdrControlPeers ?? 'all'
    if (control !== 'all' && !control.has(peer)) {
      throw new Error(`peer '${peer}' is not allowed to use bridge_agent_* tools`)
    }
    return herdr
  }

  /** Manager gate for roster administration (rename others / kick / read
   * other peers' history). Delegates to {@link isManagerCaller} so the tool gate
   * and the SSE relay can never drift apart again. */
  const requireManager = (peer: string, action: string, sessionId?: string): void => {
    if (isManagerCaller(registry, sessionId, peer, options)) return
    throw new Error(
      options.managerTokenRequired === true
        ? `peer '${peer}' is not a hub manager — ${action} requires the manager token (Authorization: Bearer <token>)`
        : `peer '${peer}' is not a hub manager — ${action} requires manager rights`,
    )
  }

  /** Normalize an `until` array argument into herdr statuses (invalid
   * entries are dropped; absent/empty means herdr's default settle set). */
  const asStatuses = (value: unknown): (typeof AGENT_STATUSES)[number][] | undefined => {
    if (!Array.isArray(value)) return undefined
    const statuses = value.map(String).filter(status => (AGENT_STATUSES as readonly string[]).includes(status))
    return statuses.length > 0 ? (statuses as (typeof AGENT_STATUSES)[number][]) : undefined
  }

  /** Enforce each tool's OWN `required` list at the entry point.
   *
   *  The JSON-RPC schema declares `required`, but this hub is also served to
   *  non-DSH clients that never validate it — and `String(args.group)` then turned
   *  a MISSING argument into the literal string "undefined", which passed the peer-id
   *  pattern and was PERSISTED as a real group id on the hub. One wrapper here covers
   *  every tool; a missing required name is a clean error naming the tool and the
   *  argument, not a durable "undefined" row.
   */
  const requireArgs = (tool: McpTool, handler: NonNullable<McpTool['handler']>): NonNullable<McpTool['handler']> => {
    const required = ((tool.inputSchema as { required?: readonly string[] }).required) ?? []
    if (required.length === 0) return handler
    return async (args: Record<string, unknown>, sessionId: string | undefined) => {
      const missing = required.filter(name => args?.[name] === undefined)
      if (missing.length > 0) {
        throw new Error(`missing required argument(s) for ${tool.name}: ${missing.join(', ')}`)
      }
      return handler(args, sessionId)
    }
  }

  const wrap = (peerAware: boolean, handler: (args: Record<string, unknown>, peer: string, sessionId: string | undefined) => Promise<unknown>): McpTool['handler'] =>
    async (args, sessionId) => {
      const peer = peerAware ? requirePeer(sessionId) : ''
      return handler(args, peer, sessionId)
    }

  return [
    {
      name: 'bridge_register',
      description: 'Claim or rename your identity on the hub. Sessions auto-share a peer id derived from the client name; call this to switch to a readable unique peerId such as "mavis" or "opencode:myproject". Optionally set your display alias (shown to other agents and the desktop roster; message routing keeps using the immutable peerId). Rejects when the id is claimed by another connection. Returns the current peer list.',
      inputSchema: schema({
        peerId: str('Unique peer id: letters/digits/._:- , 1-64 chars.'),
        alias: optStr('Optional display name (1-64 chars, spaces/CJK allowed). Routing still uses peerId.'),
      }, ['peerId']),
      handler: async (args: Record<string, unknown>, sessionId: string | undefined) => {
        // A missing peerId means "keep the id I already have" — the natural
        // reading of an optional argument. `String(args.peerId)` used to turn it
        // into the literal peer id "undefined", and because the id differed from
        // the session's current one the re-key path believed it was a rename:
        // the peer was atomically moved to "undefined" and every future message to
        // the real id became "unknown recipient". app/src-tauri's own e2e test
        // calls bridge_register with no peerId, which is why that suite was red.
        const boundId = registry.peerFor(sessionId)
        const peerId = args.peerId === undefined ? boundId : String(args.peerId)
        if (peerId === undefined) {
          throw new Error('no peer to register — pass peerId (e.g. {"peerId":"mavis"}); this session is not bound to a peer yet')
        }
        if (!PEER_ID_PATTERN.test(peerId)) {
          throw new Error(`invalid peerId: ${peerId} (expected [A-Za-z0-9._:-]{1,64})`)
        }
        if (peerId === BROADCAST) {
          throw new Error(`reserved peer id: ${peerId} (it is the broadcast address)`)
        }
        if (peerId === HUB_PEER) {
          // The hub sends its own notices ("your mailbox dropped N messages")
          // from this id. Letting a client claim it would let that client
          // impersonate the hub, so it is reserved exactly like the broadcast
          // address.
          throw new Error(`reserved peer id: ${peerId} (the hub uses it for its own notices)`)
        }
        const alias = args.alias === undefined ? undefined : sanitizeAlias(String(args.alias))
        const tokenPeer = registry.tokenFor(sessionId)?.peer
        if (tokenPeer !== undefined && peerId !== tokenPeer) {
          // Remote auth: the token owns this session's identity — a self
          // id-change would break the operator's token→peer mapping. Ask a
          // manager (bridge_rename) instead.
          throw new Error(`your identity is bound to your access token ('${tokenPeer}') — ask a hub manager to rename you`)
        }
        if (hub.has(peerId) && registry.peerFor(sessionId) !== peerId) {
          throw new Error(`peer already registered by another connection: ${peerId}`)
        }
        const current = registry.peerFor(sessionId)
        // `has()` is false for a PARKED peer (idle GC takes it out of the registry
        // but keeps its mailbox and keeps it addressable), so the check above
        // missed the same takeover in its other state: claiming such an id
        // inherits the mail waiting in it, and its owner's return then hits the
        // very error above. Liveness is the wrong test — ATTACHMENT is: an id no
        // session holds (a mailbox restored from disk after a restart) is nobody
        // else's, and the caller reclaims it by its own name or token.
        if (hub.ownsMailbox(peerId) && current !== peerId && registry.attachedCount(peerId) > 0) {
          throw new Error(`peer id '${peerId}' is parked but still attached to another connection: it keeps its mailbox and is still addressable`)
        }
        if (current !== undefined && current !== peerId) {
          if (registry.attachedCount(current) === 1) {
            // Sole session on the old id: atomically re-key the peer —
            // mailbox, waiters, history attribution, and profile all move,
            // so nothing queued or acked is lost (the old unregister-based
            // path dropped the mailbox and broke acks/history).
            hub.renamePeer(current, peerId)
            registry.rebindPeerId(current, peerId)
          } else {
            // Other sessions still share the old id: legacy split — detach
            // only this session and drop the old peer when the last leaves.
            registry.unbindPeer(sessionId)
            if (registry.attachedCount(current) === 0) hub.unregister(current)
          }
        }
        // Bind the session FIRST: it is the call that can fail (no session, or
        // this connection already claimed another peer). Registering first meant a
        // rejected bridge_register still left the peer in the roster, in
        // hub.profiles (persisted when a stateFile is configured) and receiving
        // mail into a mailbox nobody would ever drain — a ghost peer.
        registry.bindPeer(sessionId, peerId)
        // `reclaim`: reaching this line means the id was either free or its
        // mailbox is unclaimed by any other connection — the parked-takeover case
        // was refused just above, so unwrapping it is the identity's return.
        if (!hub.has(peerId)) hub.register(peerId, undefined, { reclaim: true })
        registry.clearSuppress(sessionId)
        hub.touch(peerId)
        if (alias !== undefined) hub.setAlias(peerId, alias)
        const finalAlias = hub.profileOf(peerId)?.alias
        return { ok: true, peerId, ...(finalAlias !== undefined ? { alias: finalAlias } : {}), peers: hub.peers() }
      },
    },
    {
      name: 'bridge_unregister',
      description: 'Leave the hub: detaches your session (and drops the peer when no other session shares it); auto-registration stays off until an explicit bridge_register. With `peer`, a hub MANAGER can kick another peer: its queue is dropped and every session attached to it is detached and kept from auto-re-registering. Idempotent.',
      inputSchema: schema({
        peer: optStr('Kick this peer instead of yourself. Requires manager rights (hub managerPeers).'),
      }),
      handler: async (args: Record<string, unknown>, sessionId: string | undefined) => {
        if (args.peer === undefined) {
          const peer = registry.peerFor(sessionId)
          if (peer !== undefined) {
            registry.unbindPeer(sessionId)
            if (registry.attachedCount(peer) === 0) hub.unregister(peer)
          }
          registry.suppressAuto(sessionId)
          return { ok: true, peerId: peer ?? null }
        }
        // Manager kick: drop the target peer, detach ALL its sessions and
        // suppress their auto-registration, so the kick survives the target's
        // next tool call (it must explicitly bridge_register to come back).
        const caller = registry.peerFor(sessionId)
        if (caller === undefined) throw new Error('not registered — call bridge_register(peerId) first')
        const target = String(args.peer)
        requireManager(caller, `kicking '${target}'`, sessionId)
        // A parked peer still holds mail and is still addressable, so it must be
        // kickable: `has()` is false for it, and guarding on `has()` alone made
        // this report success (`kicked: false`) while the peer stayed reachable.
        if (!hub.has(target) && !hub.isParked(target)) {
          return { ok: true, peerId: null, kicked: false }
        }
        hub.unregister(target)
        const detached = registry.unbindPeerId(target, { suppress: true })
        return { ok: true, peerId: target, kicked: true, detachedSessions: detached.length }
      },
    },
    {
      name: 'bridge_rename',
      description: 'Rename on the hub, two layers: (1) `alias` sets a display name — cosmetic only, it shows up in bridge_peers / bridge_status and the desktop roster while routing, mailboxes, and history keep the immutable peer id; renaming yourself is open to everyone. (2) `peerId` truly re-keys another registered peer (manager rights required): mailbox, waiters, in-flight manual leases, dead letters, session bindings, and history attribution move atomically, so queued messages and acks stay continuous and a lease you took under the old id is still yours to commit. Renaming ANOTHER peer (either layer) requires manager rights (hub managerPeers).',
      inputSchema: schema({
        alias: optStr('New display name (1-64 chars, spaces/CJK allowed; empty string clears back to no alias).'),
        peerId: optStr('New routing id for `peer` — a true rename that moves all state (manager only). Target must be a registered peer.'),
        peer: optStr('Whose name/id to change; default yourself. Changing another peer requires manager rights.'),
      }),
      handler: wrap(true, async (args, peer, sessionId) => {
        const hasAlias = args.alias !== undefined
        const hasPeerId = args.peerId !== undefined
        if (!hasAlias && !hasPeerId) {
          throw new Error('nothing to rename: pass alias and/or peerId')
        }
        if (hasPeerId && args.peer === undefined) {
          // Kept ahead of the token gate below so the documented path stays the
          // documented answer: changing YOUR OWN id is bridge_register's job.
          throw new Error('peerId requires peer — to change your own id, call bridge_register(newId)')
        }
        const tokenPeer = registry.tokenFor(sessionId)?.peer
        if (hasPeerId && tokenPeer !== undefined) {
          // This is the OTHER door to an id change, and it used to stand wide
          // open: naming yourself in `peer` made `target === peer`, which skipped
          // the manager gate — while bridge_register refuses exactly this
          // (a token owns its session's identity). So a token session could
          // re-key itself here, which in remote mode is forging an identity.
          requireManager(peer, `re-keying '${args.peer === undefined ? peer : String(args.peer)}'`, sessionId)
        }
        let target = args.peer === undefined ? peer : String(args.peer)
        if (target !== peer) requireManager(peer, `renaming '${target}'`, sessionId)
        let previousId: string | undefined
        if (hasPeerId) {
          const newId = String(args.peerId)
          if (!PEER_ID_PATTERN.test(newId)) {
            throw new Error(`invalid peerId: ${newId} (expected [A-Za-z0-9._:-]{1,64})`)
          }
          // A token MAPPED to `newId` owns that identity. Re-keying another peer
          // onto it would hand a rename the power to take an operator's id away
          // (and, since the token decides the peer id at connect, to make two
          // identities collide).
          //
          // The authority is the TOKEN TABLE (`options.tokenPeers`), not the live
          // bindings: iterating `registry.tokenBindings` only saw tokens with a
          // session at this instant, so a configured-but-not-yet-connected
          // operator id looked free. Taking it turns that operator's connect into
          // an ATTACH (`autoRegisterPeer`: `hub.has(peerId)`), i.e. two tenants on
          // one mailbox — the cross-tenant takeover this check exists to stop.
          // The live bindings stay in the union: a session whose token was just
          // revoked still holds its identity.
          const boundPeers = new Set<string>(options.tokenPeers?.() ?? [])
          for (const identity of registry.tokenBindings.values()) boundPeers.add(identity.peer)
          if (boundPeers.has(newId) && newId !== tokenPeer) {
            throw new Error(`peerId '${newId}' is bound to an access token — a token's identity cannot be reassigned by a rename`)
          }
          previousId = target
          hub.renamePeer(target, newId)
          registry.rebindPeerId(target, newId)
          target = newId
        }
        if (hasAlias) {
          const alias = String(args.alias).trim()
          hub.setAlias(target, alias === '' ? undefined : sanitizeAlias(alias))
        }
        const applied = hub.profileOf(target)?.alias
        return { ok: true, peerId: target, ...(previousId !== undefined ? { previousId } : {}), ...(applied !== undefined ? { alias: applied } : {}) }
      }),
    },
    {
      name: 'bridge_chat',
      description: 'Send a chat message to another agent on the hub. Use bridge_wait (long-poll) or bridge_poll to receive replies. `to` is the target peerId, a group id, or "all" to broadcast. Optional `threadId` groups multi-turn dialogs; optional `ref` marks a reply-to and carries the chain depth in `hop`. Reply chains are counted, not enforced (50 hops for chat/ack, 5 for a task replying to a task): past the ceiling the message and its `ref` are delivered unchanged and only `hop` stops counting, so nothing is ever refused and no correlation is lost.',
      inputSchema: schema(
        {
          to: str('Target peerId, group id, or "all" to broadcast. A group id fans out to its members, so you must be one of them.'),
          message: str('The message text.'),
          threadId: optStr('Optional conversation / workflow thread id.'),
          priority: priorityField(),
          ref: optStr('Optional reply-to message id.'),
          expiresAt: int('Optional absolute epoch-ms deadline. A message still queued (or about to be handed over) after it is dropped and counted as droppedExpired instead of delivered — a stale instruction is worse than none.'),
        },
        ['to', 'message'],
      ),
      handler: wrap(true, async (args, peer) => receipt(hub.send(peer, String(args.to), 'chat', String(args.message), {
        ...(args.threadId !== undefined ? { threadId: String(args.threadId) } : {}),
        ...optPriority(args.priority),
        ...(args.ref !== undefined ? { ref: String(args.ref) } : {}),
        ...(args.expiresAt !== undefined ? { expiresAt: deadline(args.expiresAt) } : {}),
      }))),
    },
    {
      name: 'bridge_notice',
      description: 'Send a system-flavoured notice to another agent (peer, group id, or "all"). Use it for things the recipient should see differently from chat: "your mailbox dropped 3 messages", "hub restarting", "that task was cancelled". `level` is info | warn | error (default info). The payload is structured ({message, level}) rather than plain text, and the message is a normal routed message — it queues for a parked peer like any other. It does NOT create a task ledger row.',
      inputSchema: schema(
        {
          to: str('Target peerId, group id, or "all" to broadcast. A group id fans out to its members, so you must be one of them.'),
          message: str('The notice text.'),
          level: { type: 'string', enum: ['info', 'warn', 'error'], description: 'Severity (default info).' },
          threadId: optStr('Optional conversation / workflow thread id.'),
          priority: priorityField(),
        },
        ['to', 'message'],
      ),
      handler: wrap(true, async (args, peer) => {
        const level = args.level === undefined ? undefined : String(args.level)
        if (level !== undefined && level !== 'info' && level !== 'warn' && level !== 'error') {
          throw new Error(`invalid level: ${level} (expected info | warn | error)`)
        }
        const payload: NoticeContent = {
          message: String(args.message),
          ...(level !== undefined ? { level: level as NoticeLevel } : {}),
        }
        return receipt(hub.send(peer, String(args.to), 'notice', encodeContent(payload), {
          ...(args.threadId !== undefined ? { threadId: String(args.threadId) } : {}),
          ...optPriority(args.priority),
        }))
      }),
    },
    {
      name: 'bridge_task',
      description: 'Delegate a structured task to another agent (peer, group, or "all"). The assignee acks with accepted | working | rejected | done | failed (bridge_ack). Track with bridge_task_status(ref) / bridge_tasks; wait for the reply with bridge_wait({ ref }). A `ref` wait can resolve on an intermediate beat (`working`) or on the result chat, so pass `terminalOnly: true` when you want the outcome. Optional timeoutMs marks the task `timeout` when the SLA expires without a terminal ack; any positive duration is honored, including multi-day deadlines (the hub re-arms its timer instead of overflowing it). Optional `ref` names the task this one answers — when the parent is itself a task the new one is a re-delegation, and `hop` counts that chain depth (saturating at 5; the task is always delivered).',
      inputSchema: schema(
        {
          to: str('Target peerId, group id, or "all" to broadcast. A group id fans out to its members, so you must be one of them.'),
          prompt: str('What the receiving agent should do.'),
          context: optStr('Optional background information for the task.'),
          deliverable: optStr('Optional expected deliverable description.'),
          timeoutMs: int('Optional soft SLA in ms from now (e.g. 30000). No upper bound — a deadline past ~24.8 days is honored as well.'),
          threadId: optStr('Optional conversation / workflow thread id.'),
          priority: priorityField(),
          ref: optStr('Optional: the task message id this one answers (makes it a re-delegation when the parent is a task; that chain is capped at 5 hops).'),
          expiresAt: int('Optional absolute epoch-ms deadline for DELIVERY (distinct from timeoutMs, which is the assignee\'s SLA after it arrives). A task still undelivered at that moment is dropped and counted as droppedExpired.'),
        },
        ['to', 'prompt'],
      ),
      handler: wrap(true, async (args, peer) => receipt(hub.sendTask(peer, String(args.to), {
        prompt: String(args.prompt),
        ...(args.context !== undefined ? { context: String(args.context) } : {}),
        ...(args.deliverable !== undefined ? { deliverable: String(args.deliverable) } : {}),
        ...(args.timeoutMs !== undefined ? { timeoutMs: Number(args.timeoutMs) } : {}),
        ...(args.threadId !== undefined ? { threadId: String(args.threadId) } : {}),
        ...optPriority(args.priority),
      }, args.ref === undefined ? undefined : String(args.ref), args.expiresAt === undefined ? undefined : deadline(args.expiresAt)))),
    },
    {
      name: 'bridge_ack',
      description: 'Acknowledge a message received from another agent (usually a delegated task): accepted | working | rejected | done | failed. The ack is routed back to the original sender of `ref` and updates the hub task ledger (see bridge_task_status / bridge_tasks). `working` + `progress` (0-100) report intermediate state without finishing the task. Terminal statuses lock the task; later acks are recorded but do not reopen it.',
      inputSchema: schema(
        {
          ref: str('The id of the message being acknowledged.'),
          status: { type: 'string', enum: [...CLIENT_ACK_STATUSES], description: "acknowledgement status. `input-required` is an INTERRUPT: it asks the sender for information without ending the task — the sender answers with bridge_task_input and work resumes. To stop a task use bridge_task_cancel, not an ack." },
          note: optStr('Optional explanation for the acknowledgement.'),
          artifacts: { type: 'array', description: 'Optional output attached to this ack: [{name, mimeType?, text? | url?}]. A `done` ack with artifacts is how you hand back what you produced; they show up in bridge_task_status.', items: { type: 'object' } },
          progress: int('Optional 0-100 progress (meaningful with status=working).'),
        },
        ['ref', 'status'],
      ),
      handler: wrap(true, async (args, peer) => {
        const status = String(args.status)
        const valid: readonly AckStatus[] = CLIENT_ACK_STATUSES
        if (!valid.includes(status as AckStatus)) {
          throw new Error(`invalid ack status: ${status} (expected ${valid.join(' | ')})`)
        }
        const artifacts = parseArtifacts(args.artifacts)
        return receipt(hub.sendAck(peer, String(args.ref), {
          status: status as AckContent['status'],
          ...(args.note !== undefined ? { note: String(args.note) } : {}),
          ...(artifacts !== undefined ? { artifacts } : {}),
          ...(args.progress !== undefined ? { progress: Number(args.progress) } : {}),
        }))
      }),
    },
    {
      name: 'bridge_tasks',
      description: 'List delegated tasks involving you, newest first. role=sent = tasks you assigned; role=received = tasks assigned to you (or broadcast/group); status filters the ledger state (pending/accepted/working/input-required/rejected/done/failed/timeout/canceled). Each row carries the full ack timeline and per-assignee state.',
      inputSchema: schema({
        role: { type: 'string', enum: ['sent', 'received', 'all'], description: 'Which side of the task to list (default all).' },
        status: { type: 'string', enum: [...ALL_TASK_STATUSES], description: 'Only tasks whose current ledger status matches.' },
        peer: optStr('Manager only: "all" or another peerId for the admin board.'),
        limit: int('How many tasks to return (default 50).'),
      }),
      handler: wrap(true, async (args, peer, sessionId) => {
        const role = args.role === undefined ? undefined : String(args.role)
        if (role !== undefined && role !== 'sent' && role !== 'received' && role !== 'all') {
          throw new Error(`invalid role: ${role} (expected sent | received | all)`)
        }
        const status = args.status === undefined ? undefined : String(args.status)
        const validStatus: readonly TaskStatus[] = ALL_TASK_STATUSES
        if (status !== undefined && !(validStatus as readonly string[]).includes(status)) {
          throw new Error(`invalid status: ${status} (expected ${validStatus.join(' | ')})`)
        }
        let target: string = peer
        if (args.peer !== undefined) {
          target = String(args.peer)
          // Same reasoning as bridge_history: the broadcast address is the
          // "every peer" view, so it is manager-gated even when the caller's own
          // id happens to BE 'all'.
          if (target === BROADCAST) requireManager(peer, 'listing the full task ledger', sessionId)
          else if (target !== peer) requireManager(peer, `listing tasks of '${target}'`, sessionId)
        }
        const tasks = hub.listTasks(target === 'all' ? 'all' : target, {
          ...(role !== undefined ? { role: role as 'sent' | 'received' | 'all' } : {}),
          ...(status !== undefined ? { status: status as TaskStatus } : {}),
          ...(args.limit !== undefined ? { limit: Number(args.limit) } : {}),
        })
        return { tasks }
      }),
    },
    {
      name: 'bridge_task_status',
      description: 'Status of one delegated task: current ledger state (pending → accepted/working → done/failed/timeout, or input-required/rejected/canceled), the original prompt/context/deliverable, per-assignee state, and every ack event (who, status, note, progress, when). Use the task message id (the same id you pass as bridge_ack ref). Readable by the sender, by an assignee (a group task carries the GROUP id in `to`, so its assignees read it through their assignee row) and by a group member; everyone else needs manager rights.',
      inputSchema: schema({ ref: str('Task message id (the id returned by bridge_task, also used as ack ref).') }, ['ref']),
      handler: wrap(true, async (args, peer, sessionId) => {
        const ref = String(args.ref)
        const task = hub.taskOf(ref)
        if (task === undefined) throw new Error(`unknown task: ${ref}`)
        // Sender always sees their own task; so does an assignee — a group
        // task is addressed to the group, so its assignees (peerId !== to)
        // would otherwise be locked out of the task they were handed, even
        // though bridge_tasks lists it for them. Group membership is checked
        // live (a member added after the send sees it too, mirroring
        // listTasks) and anyone else needs manager rights (same gate as
        // reading history).
        const isAssignee = task.assignees.some(assignee => assignee.peerId === peer)
        const isGroupMember = hub.groupOf(task.to)?.members.includes(peer) ?? false
        if (task.from !== peer && task.to !== peer && task.to !== BROADCAST && !isAssignee && !isGroupMember) {
          requireManager(peer, `reading task '${ref}'`, sessionId)
        }
        return {
          task,
          // A2A naming aliases: the same task under the names an A2A client
          // already uses. `task.id` stays authoritative.
          taskId: task.id,
          ...(task.threadId !== undefined ? { contextId: task.threadId } : {}),
          a2aState: a2aState(task.status),
        }
      }),
    },
    {
      name: 'bridge_task_cancel',
      description: 'Cancel a delegated task. Either side may do it: the sender stops work it no longer wants, an assignee reports it will not finish. The cancel is recorded on the ledger (`canceled`, terminal) and routed to the OTHER side so whoever did not press the button finds out. Cancelling an already-terminal task is an error, not a silent no-op.',
      inputSchema: schema(
        {
          ref: str('Task message id (the id returned by bridge_task).'),
          reason: optStr('Optional reason, delivered with the cancel and kept on the timeline.'),
        },
        ['ref'],
      ),
      handler: wrap(true, async (args, peer) => receipt(hub.cancelTask(peer, String(args.ref), args.reason === undefined ? undefined : String(args.reason)))),
    },
    {
      name: 'bridge_task_input',
      description: 'Answer a task whose assignee acked `input-required`: only the task\'s SENDER can answer it. The answer is delivered to the waiting assignee as an ack carrying the task id (so its `bridge_wait { ref }` picks it up) and the task resumes (`working`). An assignee does not call this — it resumes by acking `working` itself.',
      inputSchema: schema(
        {
          ref: str('Task message id.'),
          input: str('The information the assignee asked for.'),
        },
        ['ref', 'input'],
      ),
      handler: wrap(true, async (args, peer) => receipt(hub.taskInput(peer, String(args.ref), String(args.input)))),
    },
    {
      name: 'bridge_announce',
      description: 'Say what you can do, so other agents can find you: skills (id + name, optional tags), whether you accept tasks, how many at once, your input/output modes, and how you are executed when not polling. Replaces your previous card. `bridge_discover` only offers peers that set acceptsTasks — announcing a skill alone does not mean you want work.',
      inputSchema: schema(
        {
          card: {
            type: 'object',
            description: 'Your card: {skills?: [{id, name, description?, tags?}], acceptsTasks?: boolean, concurrency?: number, inputModes?: string[], outputModes?: string[], runner?: "herdr"|"cli"|"http"|"none", endpoint?: string}.',
          },
        },
        ['card'],
      ),
      handler: wrap(true, async (args, peer) => {
        const profile = hub.announceCard(peer, parseCard(args.card))
        return { ok: true, peer, card: profile.card }
      }),
    },
    {
      name: 'bridge_discover',
      description: 'Find a peer to hand work to. Returns the peers whose announced card matches, each with its current load (queued mailbox depth, live waiters, non-terminal tasks assigned to it). By default only peers that announced `acceptsTasks: true` are returned — pass acceptsTasks:false to list peers regardless. Peers that never announced a card are never returned.',
      inputSchema: schema(
        {
          skill: optStr('Only peers declaring this skill id.'),
          tag: optStr('Only peers whose skills carry this tag.'),
          acceptsTasks: { type: 'boolean', description: 'Require the peer to accept tasks (default true). Pass false to drop that requirement.' },
          idleOnly: { type: 'boolean', description: 'Only peers with nothing queued, no waiter and no running task.' },
        },
        [],
      ),
      handler: wrap(true, async (args) => ({
        peers: hub.discover({
          ...(args.skill !== undefined ? { skill: String(args.skill) } : {}),
          ...(args.tag !== undefined ? { tag: String(args.tag) } : {}),
          ...(args.acceptsTasks !== undefined ? { acceptsTasks: args.acceptsTasks === true } : {}),
          ...(args.idleOnly !== undefined ? { idleOnly: args.idleOnly === true } : {}),
        }),
      })),
    },
    {
      name: 'bridge_wait',
      description: 'Wait (long-poll) for the next message addressed to you. Resolves immediately when one is queued; otherwise blocks until one arrives or the timeout fires. `from` narrows to one sender — but it never hides a notice sent by the hub itself (`from: "hub"`), so a sender waiting with `from: <assignee>` still hears "that delivery was dropped" and "the task is over". Hub notices (`from: "hub"`) are not filtered by `from`, by `ref`, or by `statuses` / `terminalOnly`, so a `ref` wait still hears that its delivery was dropped or that its assignee is gone (a `threadId` filter still narrows them, like any other message). `ref` waits for that task\'s reply: an ack OR the chat an assignee sends the result back in (a chat carrying a task id nobody but that task\'s sender or assignees sent is ignored). An ack is a STATUS BEAT, not a verdict — an assignee that acks `working` and then `done` resolves a plain `ref` wait on the FIRST one, so pass `terminalOnly: true` (or `statuses`) when you need the outcome rather than "it started"; combining the two is an intersection, and a pair that can never match is rejected rather than waited out. A wait that times out returns the task\'s current ledger status under `ref` when you passed a ref and are a party to it (only the sender and the assignees read a task\'s state that way). `threadId` narrows to one conversation thread. Loop this tool to hold a real-time conversation. With `ack: "manual"` the message is LEASED rather than consumed: it comes back (with `attempts` incremented) if you do not call bridge_commit in time, and is dead-lettered after too many hand-outs. Use it when losing a message would be worse than handling one twice.',
      inputSchema: schema({
        from: optStr('Only wait for messages from this peerId. Hub notices (from "hub") are never filtered out.'),
        ref: optStr('Only wait for a reply carrying this ref: the ack of that task id (bridge_task id), or a chat answering it. A chat carrying a task id sent by a peer that is neither that task\'s sender nor one of its assignees is ignored.'),
        statuses: {
          type: 'array',
          items: { type: 'string', enum: [...ALL_ACK_STATUSES] },
          description: 'With `ref`: only resolve on an ack carrying one of these statuses. A chat reply has no status, so it never matches a status filter. An ack whose payload carries no valid status never matches either. Combined with `terminalOnly` by intersection: a list containing no terminal status is rejected instead of waiting out the timeout.',
        },
        terminalOnly: {
          type: 'boolean',
          description: 'With `ref`: only resolve on a TERMINAL ack (rejected | done | failed | canceled) — skip the `accepted` / `working` / `input-required` beats. A chat reply is not a terminal ack and is skipped as well. Combined with `statuses` by intersection.',
        },
        threadId: optStr('Only wait for messages carrying this threadId.'),
        timeoutMs: int(`Max wait in milliseconds (default ${DEFAULT_WAIT_MS}, ceiling is server waitTimeoutMs).`),
        maxMessages: int('Take up to this many already-queued messages in one call (default 1). With > 1 the result is {type:"messages", messages:[…]} instead of {type:"message", message:{…}} — the shape follows the request, not how many happened to be queued.'),
        ack: { type: 'string', enum: ['auto', 'manual'], description: '"auto" (default) consumes the message; "manual" leases it until bridge_commit (or bridge_nack).' },
      }),
      handler: wrap(true, async (args, peer) => presentWait(await hub.wait(
        peer,
        args.timeoutMs === undefined ? options.defaultWaitMs ?? DEFAULT_WAIT_MS : Number(args.timeoutMs),
        args.from === undefined ? undefined : String(args.from),
        undefined,
        args.ref === undefined ? undefined : String(args.ref),
        args.threadId === undefined ? undefined : String(args.threadId),
        args.ack === 'manual',
        args.maxMessages === undefined ? 1 : Math.max(1, Number(args.maxMessages)),
        ackStatuses(args.statuses, args.terminalOnly === true),
        args.terminalOnly === true,
      ))),
    },
    {
      name: 'bridge_poll',
      description: 'Non-blocking: drain every message currently queued for you. Empty list when nothing is waiting. `from` narrows to one sender (a hub notice with `from: "hub"` is always included). `ack: "manual"` leases what it drains (see bridge_wait) instead of consuming it.',
      inputSchema: schema({
        from: optStr('Only drain messages from this peerId. Hub notices (from "hub") are never filtered out.'),
        ack: { type: 'string', enum: ['auto', 'manual'], description: '"auto" (default) consumes; "manual" leases until bridge_commit.' },
      }),
      handler: wrap(true, async (args, peer) => ({
        messages: hub.poll(peer, args.from === undefined ? undefined : String(args.from), { manual: args.ack === 'manual' }).map(present),
      })),
    },
    {
      name: 'bridge_commit',
      description: 'Acknowledge messages you received under a manual lease (bridge_wait / bridge_poll with ack: "manual"). Until you commit, the hub keeps them in flight and hands them out again once the lease expires — committing is what makes handling them final. Returns how many leases were released.',
      inputSchema: schema(
        { ids: { type: 'array', items: { type: 'string' }, description: 'Message ids you received and have finished handling. At most 1000 per call.' } },
        ['ids'],
      ),
      handler: wrap(true, async (args, peer) => ({ committed: hub.commit(peer, idList(args.ids, 'bridge_commit')) })),
    },
    {
      name: 'bridge_nack',
      description: 'Give leased messages back NOW instead of waiting for the lease to expire — use it when handling failed. They go back into your mailbox in normal delivery order (another session of the same peer can retry), their attempt count is kept, and a message that keeps failing ends up dead-lettered instead of looping. It also revives a dead-lettered message (resetting its attempts). Requeued mail competes for a slot like arriving mail, so if the mailbox is already full what does not fit stays dead-lettered (revive it again later). Returns how many were requeued.',
      inputSchema: schema(
        { ids: { type: 'array', items: { type: 'string' }, description: 'Message ids to give back. At most 1000 per call.' } },
        ['ids'],
      ),
      handler: wrap(true, async (args, peer) => ({ requeued: hub.nack(peer, idList(args.ids, 'bridge_nack')) })),
    },
    {
      name: 'bridge_status',
      description: 'Hub health: server info, every registered peer with connected/queued/waiting state. A peer is connected when it was active recently or its SSE channel is alive.',
      inputSchema: schema({}),
      handler: wrap(true, async () => hub.status(livePeersFor(registry))),
    },
    {
      name: 'bridge_metrics',
      description: 'Operational counters, per peer and global. Per peer: sent / received / acked (traffic counters that survive a drained queue), queued, inFlight, deadLettered, droppedOverflow, droppedExpired, connected. Global: messagesTotal (the history seq — a true count, not a rolling window), peers / connectedPeers / parkedPeers, waitersNow, queuedTotal, tasksByStatus, and the drop / lease totals. Every number is derived from live state or from a counter the hub already keeps; nothing is estimated. Counters are per run and reset on restart.',
      inputSchema: schema({}),
      handler: wrap(true, async () => hub.metrics()),
    },
    {
      name: 'bridge_events',
      description: 'Read the hub\'s own operational event stream, oldest first. These are what the HUB did, not what peers said: `peer_joined` / `peer_left` / `peer_parked` / `mailbox_dropped` / `task_transition` / `runner_started` / `runner_finished`. Each event has a monotonic `seq` (never resets in a run), a `ts`, and a kind-specific `detail`. Pass `since` (exclusive) with the `lastSeq` of your previous call to poll for new events only. `truncated: true` means the window you asked for is older than the ring still holds, so you missed entries — re-read from the start rather than assuming you saw everything. Events are per-run and in-memory; a restart starts a new sequence.',
      inputSchema: schema({
        since: { type: 'number', description: 'Return only events with a seq greater than this (exclusive).' },
        limit: { type: 'number', description: 'Maximum events to return, newest kept (default 100, max 500).' },
      }),
      handler: wrap(true, async (args: { since?: number; limit?: number }) => hub.events(args)),
    },
    {
      name: 'bridge_peers',
      description: 'List registered peers with their display identity and connection state: id (immutable routing name), optional alias (display name), client name/version reported at connect, whether connected (recent activity or a live SSE channel), and lastSeenMs.',
      inputSchema: schema({}),
      handler: wrap(true, async () => ({ peers: rosterFor(hub, registry) })),
    },
    {
      name: 'bridge_history',
      description: 'Recent messages involving you (newest first). Use to refresh context after a reconnect. Reading ANOTHER peer\'s conversation — or `peer: "all"` for the unfiltered tail — requires manager rights (hub managerPeers).',
      inputSchema: schema({
        peer: optStr('PeerId whose conversation to inspect; "all" = every peer; default: yourself. Other peers / "all" require manager rights.'),
        channel: optStr('Read a group channel history instead of a peer conversation (you must be a member, or a manager).'),
        limit: int('How many messages to return (default 20).'),
        since: int('Resume cursor: return only messages with seq greater than this. Read bridge_status.lastSeq to start from "now"; omit to include history recorded before cursors existed.'),
      }),
      handler: wrap(true, async (args, peer, sessionId) => {
        const limit = Math.min(args.limit === undefined ? 20 : Number(args.limit), 1000)
        // `since` is a cursor, not a filter: `0` is meaningful ("everything"), so it
        // is validated as a non-negative number rather than through a truthiness test.
        const sinceRaw = args.since === undefined ? undefined : Number(args.since)
        if (sinceRaw !== undefined && (!Number.isFinite(sinceRaw) || sinceRaw < 0)) {
          throw new Error(`invalid since: ${String(args.since)} (expected a non-negative sequence number)`)
        }
        const since = sinceRaw
        const target = args.peer === undefined ? peer : String(args.peer)
        // `target === BROADCAST` is gated on its own, NOT through `target !==
        // peer`: a caller whose own id literally is 'all' would otherwise make
        // that test false and read the unfiltered tail with no gate at all.
        if (target === BROADCAST) {
          requireManager(peer, 'reading the full history', sessionId)
        } else if (target !== peer) {
          requireManager(peer, `reading peer '${target}' history`, sessionId)
        }
        if (args.channel !== undefined) {
          const groupId = String(args.channel)
          const group = hub.groupOf(groupId)
          if (group === undefined) throw new Error(`unknown group: ${groupId}`)
          if (!group.members.includes(peer)) requireManager(peer, `reading group '${groupId}' history`, sessionId)
          return { messages: hub.historyChannel(groupId, limit, since).map(present) }
        }
        const messages = target === BROADCAST
          ? hub.historyAll(limit, since)
          : hub.history(target, limit, since)
        return { messages: messages.map(present) }
      }),
    },
    // ---- group tools (group channel) ---------------------------------------------
    // A group routes one message to several members; the message carries
    // channel = group id. Offline members are skipped (they read history) —
    // unlike direct sends, which fail on unknown recipients.
    {
      name: 'bridge_group_create',
      description: 'Create a group channel. You become a member automatically; `members` lists additional peerIds (each must be registered). Members exchange messages via bridge_group_send; anyone in the group reads its history with bridge_history { channel }. Use bridge_group_delete to remove (creator or manager).',
      inputSchema: schema(
        {
          group: str('Unique group id: letters/digits/._:- , 1-64 chars.'),
          name: optStr('Optional display name.'),
          members: { type: 'array', items: { type: 'string' }, description: 'Member peerIds (you are added automatically; duplicates ignored).' },
        },
        ['group'],
      ),
      handler: wrap(true, async (args, peer) => {
        const groupId = String(args.group)
        const members = Array.isArray(args.members) ? args.members.map(String) : []
        const group = hub.createGroup(groupId, members, peer, args.name === undefined ? undefined : String(args.name))
        return { ok: true, group: { id: group.id, ...(group.name !== undefined ? { name: group.name } : {}), members: group.members, createdBy: group.createdBy } }
      }),
    },
    {
      name: 'bridge_group_send',
      description: 'Send a chat message to every member of a group channel except yourself. Offline members are skipped (they catch up via bridge_history { channel }). You must be a member.',
      inputSchema: schema({ group: str('Group id from bridge_group_create / bridge_group_list.'), message: str('The message text.') }, ['group', 'message']),
      handler: wrap(true, async (args, peer) => receipt(hub.sendToGroup(peer, String(args.group), String(args.message)))),
    },
    {
      name: 'bridge_group_list',
      description: 'List every group channel with its members and creator.',
      inputSchema: schema({}),
      handler: wrap(true, async () => ({ groups: hub.allGroups() })),
    },
    {
      name: 'bridge_group_delete',
      description: 'Delete a group channel (history rows are kept). The creator or a hub manager may delete.',
      inputSchema: schema({ group: str('Group id to delete.') }, ['group']),
      handler: wrap(true, async (args, peer, sessionId) => {
        const groupId = String(args.group)
        const group = hub.groupOf(groupId)
        if (group === undefined) throw new Error(`unknown group: ${groupId}`)
        if (group.createdBy !== peer) requireManager(peer, `deleting group '${groupId}'`, sessionId)
        hub.deleteGroup(groupId)
        return { ok: true, group: groupId }
      }),
    },
    {
      name: 'bridge_group_add_member',
      description: 'Add a registered peer to a group channel; the new member can then send to it and read its history. The creator or a hub manager may add.',
      inputSchema: schema({ group: str('Group id from bridge_group_create / bridge_group_list.'), member: str('peerId of the new member.') }, ['group', 'member']),
      handler: wrap(true, async (args, peer, sessionId) => {
        const groupId = String(args.group)
        const member = String(args.member)
        const group = hub.groupOf(groupId)
        if (group === undefined) throw new Error(`unknown group: ${groupId}`)
        if (group.createdBy !== peer) requireManager(peer, `adding a member to group '${groupId}'`, sessionId)
        const updated = hub.addGroupMember(groupId, member)
        return { ok: true, group: { id: updated.id, members: updated.members } }
      }),
    },
    {
      name: 'bridge_group_remove_member',
      description: 'Remove a member from a group channel; they stop receiving its messages (history rows are kept). The creator or a hub manager may remove; the creator itself cannot be removed.',
      inputSchema: schema({ group: str('Group id from bridge_group_create / bridge_group_list.'), member: str('peerId to remove.') }, ['group', 'member']),
      handler: wrap(true, async (args, peer, sessionId) => {
        const groupId = String(args.group)
        const member = String(args.member)
        const group = hub.groupOf(groupId)
        if (group === undefined) throw new Error(`unknown group: ${groupId}`)
        if (group.createdBy !== peer) requireManager(peer, `removing a member from group '${groupId}'`, sessionId)
        const updated = hub.removeGroupMember(groupId, member)
        return { ok: true, group: { id: updated.id, members: updated.members } }
      }),
    },
    // ---- herdr control tools ------------------------------------------
    // These type into real agent terminals via the herdr runtime. They are
    // gated by checkControl and documented as physical input: unlike
    // bridge_chat (a mailbox message the model may ignore), a prompt here is
    // executed by the target's TUI — slash commands included.
    {
      name: 'bridge_agent_list',
      description: 'List agent panes detected by the herdr terminal runtime (paneId, agent kind, lifecycle status, cwd, interactive-ready). Use a paneId as the `target` of the other bridge_agent_* tools. Control tools: they type into the target terminal — use with care.',
      inputSchema: schema({}),
      handler: wrap(true, async (_args, peer) => ({ agents: await checkControl(peer).list() })),
    },
    {
      name: 'bridge_agent_status',
      description: 'Live status of a target: for agents herdr recognizes, the full lifecycle state (idle/working/blocked/done) and agent kind; for unrecognized panes, a pane-derived summary with status "unknown" and `pane` populated. `target` is a herdr paneId from bridge_pane_list / bridge_agent_list.',
      inputSchema: schema({ target: str('herdr paneId, e.g. w1:p1, from bridge_agent_list or bridge_pane_list.') }, ['target']),
      handler: wrap(true, async (args, peer) => {
        const result = await checkControl(peer).statusSmart(String(args.target))
        return { agent: result.agent, ...(result.pane !== null ? { pane: result.pane } : {}) }
      }),
    },
    {
      name: 'bridge_agent_prompt',
      description: 'Submit text directly into the target terminal. For agents herdr recognizes, uses agent.prompt — a state-machine wait (`wait: true` blocks until idle/done/blocked, exact states via `until`). For unrecognized panes (e.g. MiniMax Code), falls back to pane-level input (`pane.send_input`) and waits for the pane output to settle. Slash commands are executed by the target\'s TUI either way. Returns `via: "agent" | "pane"` so callers know which channel was used.',
      inputSchema: schema(
        {
          target: str('herdr paneId, e.g. w1:p1, from bridge_pane_list / bridge_agent_list.'),
          text: str('Text to submit (slash commands are executed, not sent as chat).'),
          wait: { type: 'boolean', description: 'Wait for the agent to settle after submission (default false).' },
          until: { type: 'array', items: { type: 'string', enum: [...AGENT_STATUSES] }, description: 'Exact states to wait for (agent channel; default: idle/done/blocked).' },
          timeoutMs: int('Wait cap in ms (default 30000).'),
        },
        ['target', 'text'],
      ),
      handler: wrap(true, async (args, peer) => {
        const ctl = checkControl(peer)
        const waiting = args.wait === true
        const result = await ctl.promptSmart(String(args.target), String(args.text), {
          wait: waiting,
          until: asStatuses(args.until),
          timeoutMs: args.timeoutMs === undefined ? undefined : Number(args.timeoutMs),
        })
        return waiting ? { submitted: true, via: result.via, settled: result.settled } : { submitted: true, via: result.via }
      }),
    },
    {
      name: 'bridge_agent_wait',
      description: 'Wait until the target settles. For agents herdr recognizes: state-machine wait (agent.wait — idle/working/blocked/done, `until` for exact states). For unrecognized panes: falls back to polling pane output until it stops changing. Returns `via: "agent" | "pane"`; a `settled: null` result means the timeout fired first.',
      inputSchema: schema(
        {
          target: str('herdr paneId, e.g. w1:p1, from bridge_pane_list / bridge_agent_list.'),
          until: { type: 'array', items: { type: 'string', enum: [...AGENT_STATUSES] }, description: 'Exact states to wait for (agent channel; default: idle/done/blocked).' },
          timeoutMs: int('Wait cap in ms (default 30000).'),
        },
        ['target'],
      ),
      handler: wrap(true, async (args, peer) => {
        const result = await checkControl(peer).waitSmart(String(args.target), {
          until: asStatuses(args.until),
          timeoutMs: args.timeoutMs === undefined ? undefined : Number(args.timeoutMs),
        })
        return { via: result.via, settled: result.settled }
      }),
    },
    {
      name: 'bridge_agent_read',
      description: 'Read the target\'s recent terminal output (plain text). Uses agent.read for recognized agents, pane.read otherwise. Use to collect the reply of an agent that is not connected to the hub (its output never enters a mailbox).',
      inputSchema: schema(
        {
          target: str('herdr paneId, e.g. w1:p1, from bridge_pane_list / bridge_agent_list.'),
          lines: int('How many lines to read (default: all recent).'),
          source: { type: 'string', enum: ['visible', 'recent', 'recent-unwrapped', 'detection'], description: 'Terminal snapshot source (default recent).' },
        },
        ['target'],
      ),
      handler: wrap(true, async (args, peer) =>
        checkControl(peer).readSmart(String(args.target), {
          lines: args.lines === undefined ? undefined : Number(args.lines),
          source: args.source === undefined ? undefined : (args.source as 'visible' | 'recent' | 'recent-unwrapped' | 'detection'),
        }),
      ),
    },
    {
      name: 'bridge_agent_keys',
      description: 'Send raw key presses to the target terminal — Enter, esc, ctrl-c, arrows, etc. Use to dismiss permission prompts or interrupt a stuck agent. Keys are passed verbatim.',
      inputSchema: schema(
        {
          target: str('herdr paneId, e.g. w1:p1, from bridge_pane_list / bridge_agent_list.'),
          keys: { type: 'array', items: { type: 'string' }, description: 'Keys to send, e.g. ["Enter"], ["esc"], ["ctrl-c", "Enter"].' },
        },
        ['target', 'keys'],
      ),
      handler: wrap(true, async (args, peer) => {
        const ctl = checkControl(peer)
        const keys = Array.isArray(args.keys) ? args.keys.map(String) : []
        if (keys.length === 0) throw new Error('keys: at least one key is required')
        await ctl.keysSmart(String(args.target), keys)
        return { ok: true, sent: keys }
      }),
    },
    // ---- pane-level control tools (socket API) -----------------------
    // Unlike the bridge_agent_* tools (which require herdr to RECOGNIZE the
    // agent), these drive any pane through the herdr local socket: physical
    // input and output for agents herdr does not know (e.g. MiniMax Code).
    {
      name: 'bridge_pane_list',
      description: 'List every herdr pane (ids, titles, agent status, cwd) via the herdr socket — including panes running agents herdr does not recognize. Use a paneId as `target` of bridge_pane_send / bridge_pane_keys / bridge_pane_read. Control tools: they type into real terminals — use with care.',
      inputSchema: schema({}),
      handler: wrap(true, async (_args, peer) => ({ panes: await checkControl(peer).paneList() })),
    },
    {
      name: 'bridge_pane_send',
      description: 'Type text into a herdr pane\'s input line (physical keystrokes via the herdr socket; works for ANY pane, no agent detection needed). This is how you drive an agent herdr does not recognize: the text lands in the target\'s terminal as if typed. Slash commands are executed by the target\'s TUI. With enter: true (default), the text is submitted with Enter.',
      inputSchema: schema(
        {
          target: str('herdr paneId, e.g. wT:p2, from bridge_pane_list.'),
          text: str('Text to type into the pane (slash commands are executed, not sent as chat).'),
          enter: { type: 'boolean', description: 'Submit with Enter after typing (default true).' },
        },
        ['target', 'text'],
      ),
      handler: wrap(true, async (args, peer) => {
        const ctl = checkControl(peer)
        const paneId = String(args.target)
        const text = String(args.text)
        await ctl.paneSendText(paneId, text)
        if (args.enter !== false) await ctl.paneSendKeys(paneId, ['Enter'])
        return { ok: true, target: paneId, sent: text }
      }),
    },
    {
      name: 'bridge_pane_keys',
      description: 'Send raw key presses to any herdr pane (Enter, esc, ctrl-c, arrows...). Use to dismiss permission prompts or interrupt a stuck program in a pane herdr does not recognize as an agent.',
      inputSchema: schema(
        {
          target: str('herdr paneId, e.g. wT:p2, from bridge_pane_list.'),
          keys: { type: 'array', items: { type: 'string' }, description: 'Keys to send, e.g. ["Enter"], ["esc"], ["ctrl-c"].' },
        },
        ['target', 'keys'],
      ),
      handler: wrap(true, async (args, peer) => {
        const ctl = checkControl(peer)
        const keys = Array.isArray(args.keys) ? args.keys.map(String) : []
        if (keys.length === 0) throw new Error('keys: at least one key is required')
        await ctl.paneSendKeys(String(args.target), keys)
        return { ok: true, sent: keys }
      }),
    },
    {
      name: 'bridge_pane_read',
      description: 'Read a herdr pane\'s recent terminal output (plain text, ANSI stripped). Use to collect the reply of an agent that is not connected to the hub or not recognized by herdr.',
      inputSchema: schema(
        {
          target: str('herdr paneId, e.g. wT:p2, from bridge_pane_list.'),
          lines: int('How many lines to read (default: all recent).'),
          source: { type: 'string', enum: ['visible', 'recent', 'recent-unwrapped', 'detection'], description: 'Terminal snapshot source (default recent).' },
        },
        ['target'],
      ),
      handler: wrap(true, async (args, peer) =>
        checkControl(peer).paneRead(String(args.target), {
          lines: args.lines === undefined ? undefined : Number(args.lines),
          source: args.source === undefined ? undefined : (args.source as 'visible' | 'recent' | 'recent-unwrapped' | 'detection'),
        }),
      ),
    },
    {
      name: 'bridge_pane_wait',
      description: 'Wait until a herdr pane\'s output matches a pattern (substring or regex) or the budget elapses — the pane-level counterpart of bridge_agent_wait for agents herdr does not recognize. Returns the matched pane output, or `matched: null` on timeout.',
      inputSchema: schema(
        {
          target: str('herdr paneId, e.g. wT:p2, from bridge_pane_list.'),
          match: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['substring', 'regex'], description: 'Match kind (default substring).' },
              value: { type: 'string', description: 'Text or regex to match in the pane output.' },
            },
            required: ['value'],
            description: 'Output pattern to wait for.',
          },
          timeoutMs: int('Wait cap in ms (default 30000).'),
        },
        ['target', 'match'],
      ),
      handler: wrap(true, async (args, peer) => {
        const ctl = checkControl(peer)
        const match = (args.match ?? {}) as { type?: string; value?: unknown }
        if (typeof match.value !== 'string' || match.value === '') throw new Error('match.value: a non-empty string is required')
        const type = match.type === 'regex' ? 'regex' : 'substring'
        const read = await ctl.paneWaitForOutput(String(args.target), { type, value: match.value }, {
          timeoutMs: args.timeoutMs === undefined ? undefined : Number(args.timeoutMs),
        })
        return read === null ? { matched: null } : { matched: read }
      }),
    },
  ].map((tool: McpTool) => ({ ...tool, handler: requireArgs(tool, tool.handler!) }))
}
