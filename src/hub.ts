/**
 * Multi-peer hub core: peer registry, per-peer FIFO mailboxes, long-poll
 * waiters with optional sender filters, and a shared history ring.
 * Transport-agnostic (no MCP, no HTTP) so tests drive it standalone.
 */

import { randomUUID } from 'node:crypto'
import { BROADCAST, KINDS, PEER_ID_PATTERN, type BridgeMessage, type MessageKind, type WaitResult } from './protocol.js'

/** One registered long-poll waiter for a peer. */
interface Waiter {
  /** Resolves with the delivered message; idempotent (first settle wins). */
  resolve: (result: WaitResult) => void
  /** Timer handle for the wait budget. */
  timer: NodeJS.Timeout
  /** Abort listener that removes this waiter from the registry. */
  onAbort: () => void
  /** Optional sender filter: only messages from this peer match. */
  from?: string
}

export interface HubOptions {
  /** Maximum queued messages per peer; overflow drops the oldest. */
  maxQueue: number
  /** Maximum history messages retained across peers. */
  historyLimit: number
  /** Long-poll ceiling enforced by {@link wait}. */
  waitTimeoutMs: number
  /** A peer counts as "active" while its last activity is this fresh (ms). */
  connectedWindowMs?: number
  /** Auto-unregister peers idle for this long (ms); 0 disables the GC. */
  peerIdleTimeoutMs?: number
  /** Called when a message lands in a queue with no matching waiter. `target`
   * is the peer the message was just queued for (with broadcast, the callback
   * fires once per recipient, `message.to` staying 'all'). */
  onQueued?: (message: BridgeMessage, target: string) => void
  /** Called once per message appended to the history ring (delivered or
   * queued) — the persistence hook for the remote-mode SQLite store. */
  onMessage?: (message: BridgeMessage) => void
  /** Called when an offline mailbox was consumed (drained) or removed —
   * the store must re-snapshot, or drained messages resurrect on restart. */
  onMailboxesChanged?: () => void
  /** Called when the visible roster changes: a peer joins/leaves, or a
   * profile field (alias) is edited — anything another peer could observe. */
  onPeersChanged?: (peers: string[]) => void
  /** Called when a group channel changes (create/delete or a membership
   * edit) — the persistence hook for the remote-mode SQLite store. */
  onGroupsChanged?: () => void
  /** Called when the idle GC evicts a peer. */
  onPeerGc?: (peerId: string) => void
  /** Live-channel check: peers returning true are skipped by the idle GC. */
  isPeerLive?: (peerId: string) => boolean
}

/** One peer's live state. */
export interface PeerState {
  id: string
  /** Display name from the peer profile, when one is set. */
  alias?: string
  connected: boolean
  lastSeenMs: number
  queued: number
  waiting: number
}

/** A named channel (group channel) routing one message to several members. Group ids
 * live in their own namespace (bridge_group_* tools reference them); a group
 * message carries `to: <groupId>` + `channel: <groupId>` and is delivered to
 * every member except the sender. */
export interface GroupState {
  id: string
  /** Display name (cosmetic, like a peer alias). */
  name?: string
  /** Member peer ids, in join order. */
  members: string[]
  createdBy: string
  createdAt: number
}

/** Identity metadata of a peer, decoupled from routing. The peer id stays the
 * immutable routing key (mailboxes, waiters, history, acks); the alias is the
 * mutable display name — editing it never moves state, so it is safe for a
 * manager to rename peers at any time. Profiles survive unregister/re-register
 * (and idle GC) so a reconnecting agent keeps its alias. */
export interface PeerProfile {
  id: string
  /** Display name; absent means "show the raw peer id". */
  alias?: string
  /** MCP client identity captured at connect (initialize clientInfo). */
  clientName?: string
  clientVersion?: string
  /** Epoch ms when this id was first seen by the hub. */
  registeredAt: number
}

/** Cap for the profile map: profiles outlive registration, so an unbounded
 * map would leak on hubs that see many distinct one-shot client names. */
const MAX_PROFILES = 512

/** Live hub summary returned by the status tool. */
export interface HubStatus {
  server: 'agent-comm-hub'
  peers: PeerState[]
  historyLimit: number
  maxQueue: number
}

/** Multi-peer mailbox core. */
export class AgentHub {
  private readonly queues = new Map<string, BridgeMessage[]>()
  private readonly waiters = new Map<string, Waiter[]>()
  private readonly historyRing: BridgeMessage[] = []
  private readonly lastSeen = new Map<string, number>()
  /** Identity metadata keyed by peer id; outlives registration (see {@link PeerProfile}). */
  private readonly profiles = new Map<string, PeerProfile>()
  /** Named channels (group channel), keyed by group id. */
  private readonly groups = new Map<string, GroupState>()
  private readonly gcTimer: NodeJS.Timeout | undefined

  constructor(private readonly options: HubOptions) {
    // Idle GC: auto-unregister peers idle beyond peerIdleTimeoutMs (0 disables).
    const idle = options.peerIdleTimeoutMs ?? 600_000
    if (idle > 0) {
      const interval = Math.min(60_000, Math.max(1_000, idle / 2))
      this.gcTimer = setInterval(() => this.gcTick(idle), interval)
      this.gcTimer.unref?.()
    }
  }

  /** Stop the idle GC (call when the hub shuts down). */
  dispose(): void {
    if (this.gcTimer !== undefined) clearInterval(this.gcTimer)
  }

  private gcTick(idleTimeoutMs: number): void {
    const now = Date.now()
    for (const peerId of this.peers()) {
      if (now - (this.lastSeen.get(peerId) ?? 0) > idleTimeoutMs) {
        // A live channel (SSE) means the session is genuinely open — keep it.
        if (this.options.isPeerLive?.(peerId) === true) continue
        this.options.onPeerGc?.(peerId)
        this.unregister(peerId)
      }
    }
  }

  /** All registered peer ids, insertion order. */
  peers(): string[] {
    return [...this.lastSeen.keys()]
  }

  /** Register a peer; throws if the id is already taken. Client metadata
   * (when provided) refreshes the profile — with same-name sessions sharing a
   * peer, the freshest connect wins, which self-heals stale metadata. */
  register(peerId: string, client?: { name?: string; version?: string }): void {
    if (this.lastSeen.has(peerId)) throw new Error(`peer already registered: ${peerId}`)
    this.lastSeen.set(peerId, Date.now())
    const existing = this.profiles.get(peerId)
    this.profiles.set(peerId, {
      ...existing,
      id: peerId,
      registeredAt: existing?.registeredAt ?? Date.now(),
      ...(client?.name !== undefined ? { clientName: client.name } : existing?.clientName !== undefined ? { clientName: existing.clientName } : {}),
      ...(client?.version !== undefined ? { clientVersion: client.version } : existing?.clientVersion !== undefined ? { clientVersion: existing.clientVersion } : {}),
    })
    this.evictOverflowProfiles()
    this.options.onPeersChanged?.(this.peers())
  }

  /** Remove a peer and its queued messages; pending waiters resolve as
   * timeouts. The profile is kept so a reconnecting peer keeps its alias. */
  unregister(peerId: string): void {
    if ((this.queues.get(peerId) ?? []).length > 0) this.options.onMailboxesChanged?.()
    this.queues.delete(peerId)
    for (const waiter of this.waiters.get(peerId) ?? []) {
      clearTimeout(waiter.timer)
      waiter.onAbort()
    }
    this.waiters.delete(peerId)
    this.lastSeen.delete(peerId)
    this.options.onPeersChanged?.(this.peers())
  }

  /** Identity metadata for `peerId`, if the hub ever saw it. */
  profileOf(peerId: string): PeerProfile | undefined {
    return this.profiles.get(peerId)
  }

  /** Snapshot of every known profile (registered or not) for persistence. */
  exportProfiles(): PeerProfile[] {
    return [...this.profiles.values()].map(profile => ({ ...profile }))
  }

  /** Load persisted profiles at boot. Invalid entries are dropped; `null`-ish
   * and non-finite fields are sanitized. Returns the imported count. Silent
   * for roster observers — this runs before the server accepts requests. */
  importProfiles(profiles: unknown): number {
    if (!Array.isArray(profiles)) return 0
    let count = 0
    for (const raw of profiles) {
      if (typeof raw !== 'object' || raw === null) continue
      const candidate = raw as Record<string, unknown>
      const id = candidate.id
      if (typeof id !== 'string' || !PEER_ID_PATTERN.test(id) || id === BROADCAST) continue
      if (this.profiles.has(id)) continue
      const profile: PeerProfile = {
        id,
        registeredAt: typeof candidate.registeredAt === 'number' && Number.isFinite(candidate.registeredAt) ? candidate.registeredAt : Date.now(),
      }
      if (typeof candidate.alias === 'string' && candidate.alias !== '') profile.alias = candidate.alias
      if (typeof candidate.clientName === 'string' && candidate.clientName !== '') profile.clientName = candidate.clientName
      if (typeof candidate.clientVersion === 'string' && candidate.clientVersion !== '') profile.clientVersion = candidate.clientVersion
      this.profiles.set(id, profile)
      count++
    }
    this.evictOverflowProfiles()
    return count
  }

  /** Set (or clear with `undefined`) the display alias of a registered peer.
   * Routing state is untouched — this only changes how the peer is shown. */
  setAlias(peerId: string, alias: string | undefined): void {
    if (!this.lastSeen.has(peerId)) throw new Error(`unknown peer: ${peerId}`)
    const profile = this.profiles.get(peerId)
    if (profile !== undefined) {
      this.profiles.set(peerId, alias === undefined ? omit(profile, 'alias') : { ...profile, alias })
    }
    // An alias edit changes the visible roster, so roster observers re-fire.
    this.options.onPeersChanged?.(this.peers())
  }

  /**
   * Atomically re-key a registered peer: mailbox, waiters, last-seen,
   * profile, session bindings (via the caller's registry), and history
   * attribution move from `oldId` to `newId` in one step, so queued
   * messages, pending waits, ack routing, and history continuity all
   * survive the rename. All validation happens before the first mutation.
   */
  renamePeer(oldId: string, newId: string): void {
    if (oldId === newId) return
    if (!this.lastSeen.has(oldId)) throw new Error(`unknown peer: ${oldId}`)
    if (newId === BROADCAST) throw new Error(`reserved peer id: ${newId}`)
    if (!PEER_ID_PATTERN.test(newId)) throw new Error(`invalid peerId: ${newId} (expected [A-Za-z0-9._:-]{1,64})`)
    if (this.lastSeen.has(newId)) throw new Error(`peer already registered: ${newId}`)
    const queue = this.queues.get(oldId)
    const waiters = this.waiters.get(oldId)
    const seen = this.lastSeen.get(oldId) ?? Date.now()
    const profile = this.profiles.get(oldId)
    // The new id may carry a stale persisted profile (roster file restored a
    // peer that later renamed itself away and back). The LIVE peer's fields
    // win; fields it lacks (typically the alias) are adopted from the stale
    // one, and first-seen time keeps the earlier of the two.
    const stale = this.profiles.get(newId)
    this.queues.delete(oldId)
    this.waiters.delete(oldId)
    this.lastSeen.delete(oldId)
    this.profiles.delete(oldId)
    if (queue !== undefined) this.queues.set(newId, queue)
    if (waiters !== undefined) this.waiters.set(newId, waiters)
    this.lastSeen.set(newId, seen)
    if (profile !== undefined) {
      const merged: PeerProfile = {
        ...stale,
        ...profile,
        id: newId,
        registeredAt: stale !== undefined && stale.registeredAt < profile.registeredAt ? stale.registeredAt : profile.registeredAt,
      }
      this.profiles.set(newId, merged)
    } else if (stale !== undefined) {
      this.profiles.set(newId, stale)
    } else {
      this.profiles.set(newId, { id: newId, registeredAt: Date.now() })
    }
    // Waiters on OTHER peers may filter by sender `from: oldId`.
    for (const list of this.waiters.values()) {
      for (const waiter of list) {
        if (waiter.from === oldId) waiter.from = newId
      }
    }
    // Rewrite attribution so history lookups and ack routing (which target
    // `original.from`) follow the new id — no tombstone needed.
    for (const message of this.historyRing) {
      if (message.from === oldId) message.from = newId
      if (message.to === oldId) message.to = newId
    }
    this.options.onPeersChanged?.(this.peers())
  }

  /** Keep the profile map bounded: drop the oldest profiles of peers that are
   * NOT currently registered (live peers are never evicted). */
  private evictOverflowProfiles(): void {
    if (this.profiles.size <= MAX_PROFILES) return
    const evictable = [...this.profiles.values()]
      .filter(profile => !this.lastSeen.has(profile.id))
      .sort((a, b) => a.registeredAt - b.registeredAt)
    let overflow = this.profiles.size - MAX_PROFILES
    for (const profile of evictable) {
      if (overflow <= 0) break
      this.profiles.delete(profile.id)
      overflow--
    }
  }

  /** Mark activity for `peer` (called on every tool call from that peer). */
  touch(peerId: string): void {
    if (this.lastSeen.has(peerId)) this.lastSeen.set(peerId, Date.now())
  }

  /** Is the peer currently registered? */
  has(peerId: string): boolean {
    return this.lastSeen.has(peerId)
  }

  /** Is the peer "active" (tool/activity within the connected window)? */
  isActive(peerId: string): boolean {
    const last = this.lastSeen.get(peerId)
    return last !== undefined && Date.now() - last < (this.options.connectedWindowMs ?? 30_000)
  }

  /** Send a chat/notice text message to `to` (or {@link BROADCAST}). */
  send(from: string, to: string, kind: 'chat' | 'notice', content: string): BridgeMessage {
    return this.route(from, to, kind, content)
  }

  /** Send a structured task message to `to` (or {@link BROADCAST}). */
  sendTask(from: string, to: string, task: { prompt: string; context?: string; deliverable?: string }): BridgeMessage {
    return this.route(from, to, 'task', JSON.stringify(task))
  }

  /** Send an acknowledgement back to the sender of `ref`. */
  sendAck(from: string, ref: string, ack: { status: 'accepted' | 'rejected' | 'done' | 'failed'; note?: string }): BridgeMessage {
    const original = this.historyRing.findLast(message => message.id === ref)
    if (!original) throw new Error(`cannot ack unknown message: ${ref}`)
    return this.route(from, original.from, 'ack', JSON.stringify(ack), ref)
  }

  /** Recent messages involving `peer` (inbound and outbound, plus group
   * channels the peer belongs to), newest first. */
  history(peerId: string, limit: number): BridgeMessage[] {
    const memberOf = new Set(
      [...this.groups.values()].filter(group => group.members.includes(peerId)).map(group => group.id),
    )
    const filtered = this.historyRing.filter(
      message => message.from === peerId || message.to === peerId || message.to === BROADCAST || (message.channel !== undefined && memberOf.has(message.channel)),
    )
    return filtered.slice(-Math.max(0, limit)).reverse()
  }

  /** Recent messages of one group channel, newest first. */
  historyChannel(groupId: string, limit: number): BridgeMessage[] {
    const filtered = this.historyRing.filter(message => message.channel === groupId || (message.to === groupId && message.channel === undefined && this.groups.has(groupId)))
    return filtered.slice(-Math.max(0, limit)).reverse()
  }

  /** Most recent messages across every peer, unfiltered (newest first).
   * Backs `bridge_history { peer: "all" }` — lets an archiver (the desktop
   * app) capture peer-to-peer traffic it is not a party of. */
  historyAll(limit: number): BridgeMessage[] {
    return this.historyRing.slice(-Math.max(0, limit)).reverse()
  }

  // ---- groups (group channel) ------------------------------------------------

  /** Create a channel; throws when the id is taken or a member is unknown. */
  createGroup(id: string, members: string[], createdBy: string, name?: string): GroupState {
    if (this.groups.has(id)) throw new Error(`group already exists: ${id}`)
    if (!PEER_ID_PATTERN.test(id)) throw new Error(`invalid group id: ${id} (expected [A-Za-z0-9._:-]{1,64})`)
    const unique = [...new Set(members)]
    if (unique.length === 0) throw new Error('a group needs at least one member')
    for (const member of unique) {
      if (!this.lastSeen.has(member)) throw new Error(`unknown member peer: ${member}`)
    }
    if (!unique.includes(createdBy)) unique.unshift(createdBy)
    const group: GroupState = { id, members: unique, createdBy, createdAt: Date.now(), ...(name !== undefined && name !== '' ? { name } : {}) }
    this.groups.set(id, group)
    this.options.onGroupsChanged?.()
    return group
  }

  /** Remove a channel (its history rows stay — attribution is unchanged). */
  deleteGroup(id: string): boolean {
    if (!this.groups.delete(id)) return false
    this.options.onGroupsChanged?.()
    return true
  }

  groupOf(id: string): GroupState | undefined {
    return this.groups.get(id)
  }

  /** Add a registered peer to an existing channel, so they can send and read
   * it like any other member. Throws when the group is unknown, the peer is
   * not registered, or it is already inside. */
  addGroupMember(groupId: string, member: string): GroupState {
    const group = this.groups.get(groupId)
    if (group === undefined) throw new Error(`unknown group: ${groupId}`)
    if (group.members.includes(member)) throw new Error(`peer '${member}' is already a member of group '${groupId}'`)
    if (!this.lastSeen.has(member)) throw new Error(`unknown member peer: ${member}`)
    group.members.push(member)
    this.options.onGroupsChanged?.()
    return group
  }

  /** Remove a member from a channel. The creator cannot be removed (it would
   * orphan the channel's management). Throws when the group or the membership
   * is missing. */
  removeGroupMember(groupId: string, member: string): GroupState {
    const group = this.groups.get(groupId)
    if (group === undefined) throw new Error(`unknown group: ${groupId}`)
    if (member === group.createdBy) throw new Error(`cannot remove the group creator '${member}'`)
    const index = group.members.indexOf(member)
    if (index === -1) throw new Error(`peer '${member}' is not a member of group '${groupId}'`)
    group.members.splice(index, 1)
    this.options.onGroupsChanged?.()
    return group
  }

  /** All groups (snapshot copy), insertion order. */
  allGroups(): GroupState[] {
    return [...this.groups.values()].map(group => ({ ...group, members: [...group.members] }))
  }

  /** Send a chat message to every member of a group except the sender;
   * members that went offline are skipped (they read the group history).
   * The message carries `to` and `channel` = the group id. */
  sendToGroup(from: string, groupId: string, content: string): BridgeMessage {
    const group = this.groups.get(groupId)
    if (group === undefined) throw new Error(`unknown group: ${groupId}`)
    if (!group.members.includes(from)) throw new Error(`peer '${from}' is not a member of group '${groupId}'`)
    const message: BridgeMessage = {
      id: randomUUID(),
      from,
      to: groupId,
      kind: 'chat',
      content,
      channel: groupId,
      ts: Date.now(),
    }
    this.lastSeen.set(from, message.ts)
    for (const member of group.members) {
      if (member !== from && this.lastSeen.has(member)) this.deliver(member, message)
    }
    return message
  }

  /** Snapshot of every group for persistence. */
  exportGroups(): GroupState[] {
    return this.allGroups()
  }

  /** Load persisted groups at boot (same validation as createGroup, minus
   * the "members must be online" rule — members reconnect later). */
  importGroups(groups: unknown): number {
    if (!Array.isArray(groups)) return 0
    let count = 0
    for (const raw of groups) {
      if (typeof raw !== 'object' || raw === null) continue
      const candidate = raw as Record<string, unknown>
      if (typeof candidate.id !== 'string' || !PEER_ID_PATTERN.test(candidate.id) || this.groups.has(candidate.id)) continue
      if (!Array.isArray(candidate.members) || candidate.members.length === 0) continue
      const members = [...new Set(candidate.members.filter((m): m is string => typeof m === 'string' && PEER_ID_PATTERN.test(m)))]
      if (members.length === 0) continue
      this.groups.set(candidate.id, {
        id: candidate.id,
        members,
        createdBy: typeof candidate.createdBy === 'string' && PEER_ID_PATTERN.test(candidate.createdBy) ? candidate.createdBy : members[0],
        createdAt: typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt) ? candidate.createdAt : Date.now(),
        ...(typeof candidate.name === 'string' && candidate.name !== '' ? { name: candidate.name } : {}),
      })
      count++
    }
    return count
  }

  // ---- persistence import/export (remote-mode SQLite store) -----------

  /** Restore the history ring at boot. Shape-invalid rows are dropped; only
   * the newest {@link HubOptions.historyLimit} survive. */
  importHistory(messages: unknown): number {
    if (!Array.isArray(messages)) return 0
    const valid: BridgeMessage[] = []
    for (const raw of messages) {
      if (typeof raw !== 'object' || raw === null) continue
      const m = raw as Record<string, unknown>
      if (typeof m.id !== 'string' || typeof m.from !== 'string' || typeof m.to !== 'string' || typeof m.content !== 'string' || typeof m.ts !== 'number') continue
      if ((KINDS as readonly string[]).includes(m.kind as string) === false) continue
      valid.push({
        id: m.id,
        from: m.from,
        to: m.to,
        kind: m.kind as MessageKind,
        content: m.content,
        ...(typeof m.ref === 'string' ? { ref: m.ref } : {}),
        ...(typeof m.channel === 'string' ? { channel: m.channel } : {}),
        ts: m.ts,
      })
    }
    for (const message of valid.slice(-this.options.historyLimit)) this.historyRing.push(message)
    return Math.min(valid.length, this.options.historyLimit)
  }

  /** Snapshot of every offline mailbox, keyed by peer (persistence). */
  exportMailboxes(): Record<string, BridgeMessage[]> {
    const out: Record<string, BridgeMessage[]> = {}
    for (const [peer, queue] of this.queues) {
      if (queue.length > 0) out[peer] = queue.map(message => ({ ...message }))
    }
    return out
  }

  /** Restore offline mailboxes at boot (peer reconnects and drains later). */
  importMailboxes(mailboxes: unknown): number {
    if (typeof mailboxes !== 'object' || mailboxes === null) return 0
    let count = 0
    for (const [peer, queue] of Object.entries(mailboxes as Record<string, unknown>)) {
      if (!Array.isArray(queue) || queue.length === 0) continue
      const restored: BridgeMessage[] = []
      for (const raw of queue) {
        if (typeof raw !== 'object' || raw === null) continue
        const m = raw as Record<string, unknown>
        if (typeof m.id !== 'string' || typeof m.from !== 'string' || typeof m.content !== 'string' || typeof m.ts !== 'number') continue
        restored.push({
          id: m.id,
          from: m.from,
          to: typeof m.to === 'string' ? m.to : peer,
          kind: (KINDS as readonly string[]).includes(m.kind as string) ? (m.kind as MessageKind) : 'chat',
          content: m.content,
          ...(typeof m.ref === 'string' ? { ref: m.ref } : {}),
          ...(typeof m.channel === 'string' ? { channel: m.channel } : {}),
          ts: m.ts,
        })
      }
      if (restored.length > 0) {
        this.queues.set(peer, restored.slice(-this.options.maxQueue))
        count += restored.length
      }
    }
    return count
  }

    /**
   * Live summary for the status tool. `livePeers` (sessions with a live SSE
   * stream) count as connected even without recent tool activity.
   */
  status(livePeers?: ReadonlySet<string>): HubStatus {
    const now = Date.now()
    return {
      server: 'agent-comm-hub',
      peers: this.peers().map(peer => {
        const alias = this.profiles.get(peer)?.alias
        return {
          id: peer,
          ...(alias !== undefined ? { alias } : {}),
          connected: this.isActive(peer) || livePeers?.has(peer) === true,
          lastSeenMs: this.lastSeen.get(peer) ?? 0,
          queued: (this.queues.get(peer) ?? []).length,
          waiting: (this.waiters.get(peer) ?? []).length,
        }
      }),
      historyLimit: this.options.historyLimit,
      maxQueue: this.options.maxQueue,
    }
  }

  /** Non-blocking drain of everything queued for `peer` (optionally from one sender). */
  poll(peerId: string, from?: string): BridgeMessage[] {
    const queue = this.queues.get(peerId) ?? []
    const drained = from === undefined ? queue.splice(0, queue.length) : drainFrom(queue, from)
    if (drained.length > 0) this.options.onMailboxesChanged?.()
    return drained
  }

  /**
   * Long-poll for the next message addressed to `peer`: resolves immediately
   * when a matching one is queued, otherwise waits up to `timeoutMs` (capped
   * by `waitTimeoutMs`) or until `signal` aborts. `from` narrows to one sender.
   *
   * Takes ONLY the first matching queued message. Calling poll() here would
   * drain the whole mailbox and discard every message after the first —
   * a multi-message burst (or a reconnect with a full queue) would silently
   * lose messages that never reach wait/poll again.
   */
  wait(peerId: string, timeoutMs: number, from?: string, signal?: AbortSignal): Promise<WaitResult> {
    const startedAt = Date.now()
    const queue = this.queues.get(peerId)
    if (queue !== undefined && queue.length > 0) {
      const index = from === undefined ? 0 : queue.findIndex(message => message.from === from)
      if (index >= 0) {
        const [queued] = queue.splice(index, 1)
        this.options.onMailboxesChanged?.()
        return Promise.resolve({ type: 'message', message: queued })
      }
    }
    const budget = Math.max(1, Math.min(Math.floor(timeoutMs), this.options.waitTimeoutMs))
    return new Promise<WaitResult>(resolve => {
      let settled = false
      const settle = (result: WaitResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve(result)
      }
      const onAbort = (): void => {
        removeFromRegistry()
        settle({ type: 'timeout', waitedMs: Date.now() - startedAt })
      }
      const removeFromRegistry = (): void => {
        const list = this.waiters.get(peerId)
        if (list) this.waiters.set(peerId, list.filter(waiter => waiter.resolve !== settle))
      }
      const timer = setTimeout(() => {
        removeFromRegistry()
        settle({ type: 'timeout', waitedMs: Date.now() - startedAt })
      }, budget)
      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      const list = this.waiters.get(peerId) ?? []
      list.push({ resolve: settle, timer, onAbort, ...(from !== undefined ? { from } : {}) })
      this.waiters.set(peerId, list)
    })
  }

  /** Create a message from `from` addressed to `to` and deliver it. */
  private route(from: string, to: string, kind: MessageKind, content: string, ref?: string): BridgeMessage {
    if (!this.lastSeen.has(from)) throw new Error(`sender not registered: ${from}`)
    if (to !== BROADCAST && !this.lastSeen.has(to)) throw new Error(`unknown recipient: ${to} (registered peers: ${this.peers().join(', ') || 'none'})`)
    const message: BridgeMessage = {
      id: randomUUID(),
      from,
      to,
      kind,
      content,
      ...(ref !== undefined ? { ref } : {}),
      ts: Date.now(),
    }
    this.lastSeen.set(from, message.ts)
    if (to === BROADCAST) {
      for (const peer of this.peers()) {
        if (peer !== from) this.deliver(peer, message)
      }
    } else {
      this.deliver(to, message)
    }
    return message
  }

  /** Queue or hand off a message; wake the first matching waiter for its target. */
  private deliver(target: string, message: BridgeMessage): void {
    const list = this.waiters.get(target) ?? []
    const index = list.findIndex(waiter => waiter.from === undefined || waiter.from === message.from)
    if (index >= 0) {
      const [waiter] = list.splice(index, 1)
      this.waiters.set(target, list)
      // Do NOT run waiter.onAbort here — it would settle the waiter as a
      // timeout first; a later abort is a harmless no-op (settle is idempotent).
      clearTimeout(waiter.timer)
      this.remember(message)
      waiter.resolve({ type: 'message', message })
      return
    }
    const queue = this.queues.get(target) ?? []
    if (queue.length >= this.options.maxQueue) queue.shift()
    queue.push(message)
    this.queues.set(target, queue)
    // Queue-path messages enter the history ring HERE, not at drain: the
    // ring is the archive of everything SENT (queued or handed to a waiter,
    // exactly once per message), which is also what makes history survive a
    // restart when the recipient never drained before shutdown.
    this.remember(message)
    this.options.onQueued?.(message, target)
  }

  /** Append a delivered message to the history ring (and fire the
   * persistence hook — one call per message, delivered or queued). */
  private remember(message: BridgeMessage): void {
    this.historyRing.push(message)
    if (this.historyRing.length > this.options.historyLimit) this.historyRing.splice(0, this.historyRing.length - this.options.historyLimit)
    this.options.onMessage?.(message)
  }
}

/** Drain only messages from one sender, preserving order. */
function drainFrom(queue: BridgeMessage[], from: string): BridgeMessage[] {
  const kept: BridgeMessage[] = []
  const drained: BridgeMessage[] = []
  for (const message of queue) {
    if (message.from === from) drained.push(message)
    else kept.push(message)
  }
  queue.splice(0, queue.length, ...kept)
  return drained
}

/** Shallow copy without one key (keeps results lossless: no `undefined` values). */
function omit<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const { [key]: _dropped, ...rest } = value
  return rest
}
