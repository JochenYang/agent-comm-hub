/**
 * Multi-peer hub core: peer registry, per-peer FIFO mailboxes, long-poll
 * waiters with optional sender filters, and a shared history ring.
 * Transport-agnostic (no MCP, no HTTP) so tests drive it standalone.
 */

import { randomUUID } from 'node:crypto'
import {
  BROADCAST,
  KINDS,
  MAX_HOP,
  PEER_ID_PATTERN,
  TERMINAL_TASK_STATUSES,
  aggregateTaskStatus,
  nextTaskStatus,
  type AckContent,
  type AckStatus,
  type AssigneeState,
  type BridgeMessage,
  type MessageKind,
  type TaskAckEvent,
  type TaskContent,
  type TaskRecord,
  type TaskStatus,
  type WaitResult,
} from './protocol.js'

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
  /** Optional ack-ref filter: only `ack` messages whose `ref` matches. */
  ref?: string
  /** Optional thread filter: only messages carrying this threadId match. */
  threadId?: string
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
  /** Called when a task ledger row is created/updated (ack, timeout, delivery). */
  onTaskChanged?: (task: TaskRecord) => void
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

/** Cap for the task ledger. Oldest non-pending tasks are evicted first so a
 * long-running hub cannot grow the map without bound; pending tasks stay. */
const MAX_TASKS = 1024

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
  /** Task ledger: task message id → record (status + ack timeline). */
  private readonly taskLedger = new Map<string, TaskRecord>()
  /** SLA timers keyed by task id (cleared when the task turns terminal). */
  private readonly taskTimers = new Map<string, NodeJS.Timeout>()
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
    for (const timer of this.taskTimers.values()) clearTimeout(timer)
    this.taskTimers.clear()
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
  send(from: string, to: string, kind: 'chat' | 'notice', content: string, opts?: { ref?: string; threadId?: string }): BridgeMessage {
    return this.route(from, to, kind, content, opts?.ref, opts?.threadId)
  }

  /** Send a structured task message to `to` (peer, {@link BROADCAST}, or a
   * group id). Records a ledger entry so the sender can later query status /
   * wait for acks. */
  sendTask(from: string, to: string, task: TaskContent): BridgeMessage {
    const threadId = task.threadId
    const message = this.route(from, to, 'task', JSON.stringify(task), undefined, threadId)
    this.recordTask(message, task)
    return message
  }

  /** Send an acknowledgement back to the sender of `ref`. Updates the task
   * ledger when `ref` is a known task (looked up in the ledger first, so acks
   * survive history-ring eviction); chat/notice refs still route via history. */
  sendAck(from: string, ref: string, ack: { status: AckStatus; note?: string; progress?: number }): BridgeMessage {
    const task = this.taskLedger.get(ref)
    let target: string
    if (task !== undefined) {
      target = task.from
    } else {
      const original = this.historyRing.findLast(message => message.id === ref)
      if (!original) throw new Error(`cannot ack unknown message: ${ref}`)
      target = original.from
    }
    const message = this.route(from, target, 'ack', JSON.stringify(ack), ref)
    this.applyAckToLedger(message, from, ref, ack)
    return message
  }

  /** Resolve the peer ids a task is assigned to (broadcast / group fan-out). */
  private resolveAssignees(from: string, to: string): string[] {
    if (to === BROADCAST) return this.peers().filter(peer => peer !== from)
    const group = this.groups.get(to)
    if (group !== undefined) return group.members.filter(member => member !== from)
    return [to]
  }

  /** Create or refresh the ledger row for a newly sent task. */
  private recordTask(message: BridgeMessage, task: TaskContent): void {
    const now = message.ts
    const assigneeIds = this.resolveAssignees(message.from, message.to)
    const assignees: AssigneeState[] = assigneeIds.map(peerId => ({ peerId, status: 'pending', acks: [] }))
    const timeoutMs = typeof task.timeoutMs === 'number' && Number.isFinite(task.timeoutMs) && task.timeoutMs > 0
      ? Math.floor(task.timeoutMs)
      : undefined
    const record: TaskRecord = {
      id: message.id,
      from: message.from,
      to: message.to,
      prompt: task.prompt,
      ...(task.context !== undefined ? { context: task.context } : {}),
      ...(task.deliverable !== undefined ? { deliverable: task.deliverable } : {}),
      status: 'pending',
      acks: [],
      assignees,
      ...(timeoutMs !== undefined ? { timeoutMs, deadlineAt: now + timeoutMs } : {}),
      ...(message.threadId !== undefined ? { threadId: message.threadId } : {}),
      createdAt: now,
      updatedAt: now,
    }
    this.taskLedger.set(message.id, record)
    this.scheduleTaskTimeout(record)
    this.evictOverflowTasks()
    this.options.onTaskChanged?.(this.taskOf(record.id)!)
  }

  /** Arm the SLA timer for a task that supplied `timeoutMs`. */
  private scheduleTaskTimeout(record: TaskRecord): void {
    if (record.deadlineAt === undefined) return
    const delay = Math.max(0, record.deadlineAt - Date.now())
    const timer = setTimeout(() => this.fireTaskTimeout(record.id), delay)
    timer.unref?.()
    this.taskTimers.set(record.id, timer)
  }

  /** Mark a non-terminal task `timeout` and leave a system timeline event. */
  private fireTaskTimeout(taskId: string): void {
    this.taskTimers.delete(taskId)
    const record = this.taskLedger.get(taskId)
    if (record === undefined) return
    if (TERMINAL_TASK_STATUSES.includes(record.status)) return
    const now = Date.now()
    const event: TaskAckEvent = {
      from: record.to,
      status: 'failed',
      note: `task timed out after ${record.timeoutMs ?? 0}ms without a terminal ack`,
      ts: now,
      messageId: `timeout-${record.id}`,
      applied: true,
      system: true,
    }
    record.acks.push(event)
    for (const assignee of record.assignees) {
      if (!TERMINAL_TASK_STATUSES.includes(assignee.status)) {
        assignee.status = 'timeout'
        assignee.acks.push({ ...event })
      }
    }
    record.status = 'timeout'
    record.updatedAt = now
    this.clearTaskTimer(taskId)
    this.options.onTaskChanged?.(this.taskOf(taskId)!)
  }

  private clearTaskTimer(taskId: string): void {
    const timer = this.taskTimers.get(taskId)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.taskTimers.delete(taskId)
    }
  }

  /** Note that `target` has taken delivery of a task (waiter handoff / queue). */
  private markTaskDelivered(taskId: string, target: string, ts: number): void {
    const record = this.taskLedger.get(taskId)
    if (record === undefined) return
    const assignee = record.assignees.find(a => a.peerId === target)
    if (assignee === undefined || assignee.deliveredMs !== undefined) return
    assignee.deliveredMs = ts
    record.updatedAt = ts
    this.options.onTaskChanged?.(this.taskOf(taskId)!)
  }

  /**
   * Fold an ack into the task's timeline and (when legal) its status.
   * - Unknown refs are a no-op (chat/notice can be acked for routing without a ledger row).
   * - Terminal tasks keep the event on the timeline with `applied: false`.
   * - Broadcast / group tasks update the acking assignee first, then re-aggregate.
   */
  private applyAckToLedger(
    message: BridgeMessage,
    from: string,
    ref: string,
    ack: { status: AckStatus; note?: string; progress?: number },
  ): void {
    const record = this.taskLedger.get(ref)
    if (record === undefined) return
    const next = nextTaskStatus(record.status, ack.status)
    // For multi-assignee tasks the transition is judged per assignee; the
    // aggregate status is recomputed afterwards. Single-target tasks use the
    // aggregate (== the one assignee) as the gate.
    const assignee = record.assignees.find(a => a.peerId === from)
    const assigneeNext = assignee === undefined ? null : nextTaskStatus(assignee.status, ack.status)
    const applied = record.assignees.length <= 1
      ? next !== null
      : assigneeNext !== null

    const event: TaskAckEvent = {
      from,
      status: ack.status,
      ...(ack.note !== undefined ? { note: ack.note } : {}),
      ...(typeof ack.progress === 'number' && Number.isFinite(ack.progress)
        ? { progress: Math.max(0, Math.min(100, ack.progress)) }
        : {}),
      ts: message.ts,
      messageId: message.id,
      applied,
    }
    record.acks.push(event)

    if (assignee !== undefined && assigneeNext !== null) {
      assignee.status = assigneeNext
      assignee.acks.push({ ...event })
    }

    if (record.assignees.length <= 1) {
      if (next !== null) record.status = next
    } else {
      record.status = aggregateTaskStatus(record.assignees)
    }
    record.updatedAt = message.ts
    if (TERMINAL_TASK_STATUSES.includes(record.status)) this.clearTaskTimer(record.id)
    this.options.onTaskChanged?.(this.taskOf(record.id)!)
  }

  /** Keep the ledger bounded: drop oldest terminal tasks first. */
  private evictOverflowTasks(): void {
    if (this.taskLedger.size <= MAX_TASKS) return
    const evictable = [...this.taskLedger.values()]
      .filter(t => TERMINAL_TASK_STATUSES.includes(t.status))
      .sort((a, b) => a.updatedAt - b.updatedAt)
    let overflow = this.taskLedger.size - MAX_TASKS
    for (const record of evictable) {
      if (overflow <= 0) break
      this.clearTaskTimer(record.id)
      this.taskLedger.delete(record.id)
      overflow--
    }
  }

  /** Deep-ish copy of one task by message id (the ack `ref`). */
  taskOf(ref: string): TaskRecord | undefined {
    const record = this.taskLedger.get(ref)
    if (record === undefined) return undefined
    return {
      ...record,
      acks: record.acks.map(a => ({ ...a })),
      assignees: record.assignees.map(a => ({ ...a, acks: a.acks.map(e => ({ ...e })) })),
    }
  }

  /**
   * Tasks involving `peer`. `role`:
   * - `sent` — tasks this peer delegated (`from`)
   * - `received` — tasks addressed to this peer, a group they are in, or broadcast
   * - `all` (default) — either side
   * Optional `status` filter matches the ledger's current status.
   */
  listTasks(peerId: string | 'all', options?: { role?: 'sent' | 'received' | 'all'; status?: TaskStatus; limit?: number }): TaskRecord[] {
    const role = options?.role ?? 'all'
    const limit = Math.max(1, options?.limit ?? 50)
    const out: TaskRecord[] = []
    for (const record of this.taskLedger.values()) {
      if (peerId !== 'all') {
        const isSent = record.from === peerId
        const isReceived = record.to === peerId
          || record.to === BROADCAST
          || record.assignees.some(a => a.peerId === peerId)
          || (this.groups.get(record.to)?.members.includes(peerId) ?? false)
        if (role === 'sent' && !isSent) continue
        if (role === 'received' && !isReceived) continue
        if (role === 'all' && !isSent && !isReceived) continue
      }
      if (options?.status !== undefined && record.status !== options.status) continue
      const copy = this.taskOf(record.id)
      if (copy !== undefined) out.push(copy)
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt)
    return out.slice(0, limit)
  }

  /** Snapshot of every task (persistence). */
  exportTasks(): TaskRecord[] {
    return [...this.taskLedger.values()].map(record => this.taskOf(record.id)!).filter(Boolean)
  }

  /** Restore the task ledger at boot (and re-arm SLA timers). */
  importTasks(tasks: unknown): number {
    if (!Array.isArray(tasks)) return 0
    let count = 0
    for (const raw of tasks) {
      if (typeof raw !== 'object' || raw === null) continue
      const t = raw as Record<string, unknown>
      if (typeof t.id !== 'string' || typeof t.from !== 'string' || typeof t.to !== 'string' || typeof t.prompt !== 'string') continue
      if (typeof t.status !== 'string' || !(TERMINAL_TASK_STATUSES as readonly string[]).includes(t.status) && t.status !== 'pending' && t.status !== 'accepted' && t.status !== 'working') continue
      const acks: TaskAckEvent[] = Array.isArray(t.acks)
        ? t.acks.flatMap(rawAck => {
            if (typeof rawAck !== 'object' || rawAck === null) return []
            const a = rawAck as Record<string, unknown>
            if (typeof a.from !== 'string' || typeof a.status !== 'string' || typeof a.ts !== 'number' || typeof a.messageId !== 'string') return []
            return [{
              from: a.from,
              status: a.status as AckStatus,
              ...(typeof a.note === 'string' ? { note: a.note } : {}),
              ...(typeof a.progress === 'number' ? { progress: a.progress } : {}),
              ts: a.ts,
              messageId: a.messageId,
              applied: a.applied !== false,
              ...(a.system === true ? { system: true as const } : {}),
            }]
          })
        : []
      const assignees: AssigneeState[] = Array.isArray(t.assignees) && t.assignees.length > 0
        ? t.assignees.flatMap(rawA => {
            if (typeof rawA !== 'object' || rawA === null) return []
            const a = rawA as Record<string, unknown>
            if (typeof a.peerId !== 'string' || typeof a.status !== 'string') return []
            return [{
              peerId: a.peerId,
              status: a.status as TaskStatus,
              ...(typeof a.deliveredMs === 'number' ? { deliveredMs: a.deliveredMs } : {}),
              acks: Array.isArray(a.acks) ? a.acks.flatMap(rawE => {
                if (typeof rawE !== 'object' || rawE === null) return []
                const e = rawE as Record<string, unknown>
                if (typeof e.from !== 'string' || typeof e.status !== 'string' || typeof e.ts !== 'number' || typeof e.messageId !== 'string') return []
                return [{
                  from: e.from,
                  status: e.status as AckStatus,
                  ...(typeof e.note === 'string' ? { note: e.note } : {}),
                  ts: e.ts,
                  messageId: e.messageId,
                  applied: e.applied !== false,
                }]
              }) : [],
            }]
          })
        : [{ peerId: t.to, status: t.status as TaskStatus, acks: [] }]
      const record: TaskRecord = {
        id: t.id,
        from: t.from,
        to: t.to,
        prompt: t.prompt,
        ...(typeof t.context === 'string' ? { context: t.context } : {}),
        ...(typeof t.deliverable === 'string' ? { deliverable: t.deliverable } : {}),
        status: t.status as TaskStatus,
        acks,
        assignees,
        ...(typeof t.timeoutMs === 'number' ? { timeoutMs: t.timeoutMs } : {}),
        ...(typeof t.deadlineAt === 'number' ? { deadlineAt: t.deadlineAt } : {}),
        ...(typeof t.threadId === 'string' ? { threadId: t.threadId } : {}),
        createdAt: typeof t.createdAt === 'number' ? t.createdAt : Date.now(),
        updatedAt: typeof t.updatedAt === 'number' ? t.updatedAt : Date.now(),
      }
      this.taskLedger.set(record.id, record)
      this.scheduleTaskTimeout(record)
      count++
    }
    this.evictOverflowTasks()
    return count
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
    return this.route(from, groupId, 'chat', content)
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
        ...(typeof m.threadId === 'string' ? { threadId: m.threadId } : {}),
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
          ...(typeof m.threadId === 'string' ? { threadId: m.threadId } : {}),
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
   * `ref` narrows to the ack of a specific task message id.
   *
   * Takes ONLY the first matching queued message. Calling poll() here would
   * drain the whole mailbox and discard every message after the first —
   * a multi-message burst (or a reconnect with a full queue) would silently
   * lose messages that never reach wait/poll again.
   */
  wait(peerId: string, timeoutMs: number, from?: string, signal?: AbortSignal, ref?: string, threadId?: string): Promise<WaitResult> {
    const startedAt = Date.now()
    const matches = (message: BridgeMessage): boolean => {
      if (from !== undefined && message.from !== from) return false
      if (ref !== undefined && !(message.kind === 'ack' && message.ref === ref)) return false
      if (threadId !== undefined && message.threadId !== threadId) return false
      return true
    }
    const queue = this.queues.get(peerId)
    if (queue !== undefined && queue.length > 0) {
      const index = queue.findIndex(matches)
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
      list.push({
        resolve: settle,
        timer,
        onAbort,
        ...(from !== undefined ? { from } : {}),
        ...(ref !== undefined ? { ref } : {}),
        ...(threadId !== undefined ? { threadId } : {}),
      })
      this.waiters.set(peerId, list)
    })
  }

  /** Create a message from `from` addressed to `to` and deliver it. `to` may
   *  be a peer id, {@link BROADCAST}, or a group id. */
  private route(from: string, to: string, kind: MessageKind, content: string, ref?: string, threadId?: string): BridgeMessage {
    if (!this.lastSeen.has(from)) throw new Error(`sender not registered: ${from}`)
    const group = this.groups.get(to)
    if (to !== BROADCAST && group === undefined && !this.lastSeen.has(to)) {
      throw new Error(`unknown recipient: ${to} (registered peers: ${this.peers().join(', ') || 'none'})`)
    }
    // Hop = chain depth along a ref parent (reply / ack / re-delegation).
    // Caps runaway A→B→C→… loops at MAX_HOP (same idea as MiMo session-chat).
    let hop = 0
    if (ref !== undefined) {
      const parent = this.historyRing.findLast(m => m.id === ref)
      hop = (parent?.hop ?? 0) + 1
      if (hop > MAX_HOP) {
        throw new Error(`hop limit exceeded (max ${MAX_HOP}): start a new task/thread instead of extending this chain`)
      }
    }
    const message: BridgeMessage = {
      id: randomUUID(),
      from,
      to,
      kind,
      content,
      ...(ref !== undefined ? { ref } : {}),
      ...(threadId !== undefined ? { threadId } : {}),
      ...(group !== undefined ? { channel: group.id } : {}),
      ...(hop > 0 ? { hop } : {}),
      ts: Date.now(),
    }
    this.lastSeen.set(from, message.ts)
    // Record ONCE per message at send time (not once per recipient): broadcast
    // and group fan-out used to call remember() inside every deliver(), which
    // duplicated history rows and multi-fired onMessage/pushRelay. Recording
    // here also means manager SSE sees traffic when it is SENT — not when a
    // recipient's waiter finally drains it (the desktop "only after the other
    // agent picks it up" lag).
    this.remember(message)
    if (to === BROADCAST) {
      for (const peer of this.peers()) {
        if (peer !== from) this.deliver(peer, message)
      }
    } else if (group !== undefined) {
      for (const member of group.members) {
        if (member !== from) this.deliver(member, message)
      }
    } else {
      this.deliver(to, message)
    }
    return message
  }

  /** Queue or hand off a message; wake the first matching waiter for its target.
   *  History / onMessage are recorded by the caller (route / sendToGroup) —
   *  exactly once per message, never per fan-out target. */
  private deliver(target: string, message: BridgeMessage): void {
    const list = this.waiters.get(target) ?? []
    const index = list.findIndex(waiter => {
      if (waiter.from !== undefined && waiter.from !== message.from) return false
      if (waiter.ref !== undefined && !(message.kind === 'ack' && message.ref === waiter.ref)) return false
      if (waiter.threadId !== undefined && message.threadId !== waiter.threadId) return false
      return true
    })
    // Task delivery bookkeeping runs for both handoff and queue paths.
    if (message.kind === 'task') this.markTaskDelivered(message.id, target, message.ts)
    if (index >= 0) {
      const [waiter] = list.splice(index, 1)
      this.waiters.set(target, list)
      // Do NOT run waiter.onAbort here — it would settle the waiter as a
      // timeout first; a later abort is a harmless no-op (settle is idempotent).
      clearTimeout(waiter.timer)
      waiter.resolve({ type: 'message', message })
      return
    }
    const queue = this.queues.get(target) ?? []
    if (queue.length >= this.options.maxQueue) queue.shift()
    queue.push(message)
    this.queues.set(target, queue)
    this.options.onQueued?.(message, target)
  }

  /** Append a sent message to the history ring (and fire the persistence /
   * relay hooks). Exactly one call per message — see route() / sendToGroup(). */
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
