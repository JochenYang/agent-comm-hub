/**
 * Multi-peer hub core: peer registry, per-peer FIFO mailboxes, long-poll
 * waiters with optional sender filters, and a shared history ring.
 * Transport-agnostic (no MCP, no HTTP) so tests drive it standalone.
 */

import { randomUUID } from 'node:crypto'
import {
  BROADCAST,
  encodeContent,
  HUB_PEER,
  KINDS,
  MAX_HOP,
  MAX_REPLY_CHAIN,
  PEER_ID_PATTERN,
  TERMINAL_TASK_STATUSES,
  aggregateTaskStatus,
  nextTaskStatus,
  type AckContent,
  type AckStatus,
  type AssigneeState,
  type BridgeMessage,
  type MessageKind,
  type PeerCard,
  type TaskAckEvent,
  type TaskContent,
  type TaskRecord,
  type TaskStatus,
  type DeliveredMessage,
  type TaskArtifact,
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
  /** Hand the message out under a manual-ack lease instead of consuming it. */
  manual?: boolean
  /** Resolve with the batch shape (`{type:'messages'}`) instead of a single
   *  message — set when the caller asked for `maxMessages > 1`. */
  batch?: boolean
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
  /** How long a parked mailbox is kept after its peer goes idle (ms).
   * Default 7 days; 0 disables expiry. See {@link AgentHub.unregister}. */
  parkedTtlMs?: number
  /** Manual-ack lease duration (ms). Default {@link DEFAULT_LEASE_TTL_MS}. */
  leaseTtlMs?: number
  /** Per-peer mailbox rate limit, in messages per minute. `0` (the default) means
   *  unlimited. A token bucket sized at one minute's worth, refilled continuously:
   *  a burst up to `ratePerMin` is absorbed instantly, then the mailbox accepts at
   *  that rate. Guards the RECIPIENT — one broadcast storm cannot fill every mailbox
   *  on the hub. Dropped messages are counted and reported per peer. */
  ratePerMin?: number
  /** Hand-outs before a message is dead-lettered instead of requeued.
   * Default {@link DEFAULT_MAX_ATTEMPTS}; 0 disables the limit. */
  maxAttempts?: number
  /** Called when a message lands in a queue with no matching waiter. `target`
   * is the peer the message was just queued for (with broadcast, the callback
   * fires once per recipient, `message.to` staying 'all'). */
  onQueued?: (message: BridgeMessage, target: string) => void
  /** Called when a **task** reached a mailbox instead of a waiter — i.e. nobody
   *  is polling for that peer right now. This is the signal a runner acts on
   *  (`src/runner.ts`): without one the task sits there until the peer happens
   *  to call bridge_wait, which for an agent that is not looping is never. */
  onTaskQueued?: (message: BridgeMessage, target: string) => void
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
  /** Called when a parked mailbox is dropped after {@link HubOptions.parkedTtlMs}.
   * `dropped` is how many messages were discarded — they are gone for good, so
   * the store must re-snapshot and the operator should be able to see it. */
  onMailboxExpired?: (peerId: string, dropped: number) => void
  /** Live-channel check: peers returning true are skipped by the idle GC. */
  isPeerLive?: (peerId: string) => boolean
}

/** One peer's live state. */
export interface PeerState {
  id: string
  /** Display name from the peer profile, when one is set. */
  alias?: string
  connected: boolean
  /** `online` = recently active or a live SSE channel; `idle` = registered but
   * quiet; `parked` = no longer registered, mailbox kept (see unregister).
   * A parked peer is still addressable — mail queues and is drained on return. */
  reachable: 'online' | 'idle' | 'parked'
  lastSeenMs: number
  queued: number
  waiting: number
  /** Messages handed out under a manual-ack lease and not yet committed. */
  inFlight?: number
  /** Messages dropped for this peer: `overflow` = pushed out of a full mailbox,
   *  `expired` = hit their `expiresAt` before delivery. Memory-only counters for
   *  the current run. */
  droppedOverflow?: number
  droppedExpired?: number
  /** `rate` = arrived faster than the peer's `ratePerMin` mailbox budget. */
  droppedRate?: number
  /** Messages that exhausted their lease attempts and are parked for a human or
   *  a `bridge_nack` to revive. */
  deadLettered?: number
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
  /** What the peer announced about itself (`bridge_announce`). Absent means it
   *  never said anything, which is not an error — it just cannot be found by
   *  `bridge_discover`. */
  card?: PeerCard
}

/** Cap for the profile map: profiles outlive registration, so an unbounded
 * map would leak on hubs that see many distinct one-shot client names. */
const MAX_PROFILES = 512

/** Cap for the task ledger. Oldest non-pending tasks are evicted first so a
 * long-running hub cannot grow the map without bound; pending tasks stay. */
const MAX_TASKS = 1024

/** Largest delay `setTimeout` honors: the delay is a signed 32-bit int, and a
 * bigger value overflows to a ~1 ms timer (Node fires it immediately and only
 * warns). Longer waits are re-armed in segments — see scheduleTaskTimeout. */
const MAX_TIMER_DELAY_MS = 2_147_483_647

/** How long a parked mailbox is kept by default: an agent that went idle keeps
 * its queued mail for a week, not until the next GC tick. */
export const DEFAULT_PARKED_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** How long a manual-ack lease lasts before the message becomes available again
 *  (see {@link AgentHub.poll} / {@link AgentHub.wait} with `manual: true`). */
export const DEFAULT_LEASE_TTL_MS = 60_000

/** How many times one message may be handed out under a lease before it is
 *  dead-lettered instead of requeued, so a poison message cannot spin forever. */
export const DEFAULT_MAX_ATTEMPTS = 5

/** How many operational events the ring keeps. Newest win; older ones are dropped
 *  and `events()` reports `truncated` for a reader that fell behind. */
export const MAX_EVENTS = 500

/** What the hub itself did — see {@link AgentHub.events}. */
export type HubEventKind =
  | 'peer_joined'
  | 'peer_left'
  | 'peer_parked'
  | 'mailbox_dropped'
  | 'task_transition'
  | 'runner_started'
  | 'runner_finished'

/** One recorded event. `seq` is monotonic within a run and never resets. */
export interface HubEvent {
  seq: number
  ts: number
  kind: HubEventKind
  /** The peer this is about, when there is one. */
  peer?: string
  /** Kind-specific detail. Always present so a reader can index it blindly. */
  detail: Record<string, unknown>
}

/** Live hub summary returned by the status tool. */
export interface HubStatus {
  server: 'agent-comm-hub'
  peers: PeerState[]
  historyLimit: number
  maxQueue: number
  /** Highest message sequence number issued so far; pass it back as
   *  `bridge_history { since }` to read only what happened after it. */
  lastSeq: number
}

/** Multi-peer mailbox core. */
export class AgentHub {
  private readonly queues = new Map<string, BridgeMessage[]>()
  /** When each parked (peer-gone-but-kept) mailbox was parked, for the TTL sweep.
   * A queue in this map has no registered peer; see {@link unregister}. */
  private readonly parkedAt = new Map<string, number>()
  /** Highest {@link BridgeMessage.seq} handed out so far. Restored history can
   * raise it (see importHistory) but nothing lowers it: a client's `since` cursor
   * has to keep meaning the same thing across a restart. */
  private seqCounter = 0

  /**
   * Record one operational event.
   *
   * Deliberately NOT the same thing as history: history is the messages that
   * flowed (what peers said to each other), this is what the HUB did — a peer
   * joined, a mailbox was dropped, a task moved. History can be read per peer and
   * is persisted; events are global, per-run, and never persisted, because they
   * describe the life of this process.
   */
  private recordEvent(kind: HubEventKind, input: { peer?: string; detail?: Record<string, unknown> } = {}): void {
    this.eventRing.push({
      seq: ++this.eventSeq,
      ts: Date.now(),
      kind,
      ...(input.peer !== undefined ? { peer: input.peer } : {}),
      detail: input.detail ?? {},
    })
    // Keep the newest MAX_EVENTS: drop from the front, the same direction the
    // history ring trims. A reader that fell behind gets `truncated: true` from
    // `events()` rather than silently missing entries.
    while (this.eventRing.length > MAX_EVENTS) this.eventRing.shift()
  }

  /**
   * Read recorded events, oldest first.
   *
   * `since` is exclusive ("give me what happened after seq N"), which makes it the
   * natural cursor: pass the `lastSeq` of the previous call. `truncated` says the
   * requested window is no longer in the ring, so the caller knows it missed
   * entries instead of assuming it saw everything.
   */
  events(options: { since?: number; limit?: number } = {}): { events: HubEvent[]; lastSeq: number; truncated: boolean } {
    const limit = Math.max(1, Math.min(options.limit ?? 100, MAX_EVENTS))
    const since = options.since ?? 0
    const available = this.eventRing.filter(event => event.seq > since)
    const truncated = since > 0 && available.length > 0 && available[0].seq > since + 1
    return {
      events: available.slice(-limit),
      lastSeq: this.eventSeq,
      truncated,
    }
  }

  /** The task hook, plus the event it implies.
   *
   *  Every status change in this class already reports through
   *  `options.onTaskChanged`, so recording the event HERE needs no new call sites:
   *  the hook IS the transition signal. That is also why the event can carry the
   *  aggregate status without the caller having to say what changed — it is read
   *  from the record at the moment the transition is announced. */
  private taskChanged(record: TaskRecord | undefined): void {
    if (record !== undefined) {
      this.recordEvent('task_transition', {
        peer: record.from,
        detail: { taskId: record.id, status: record.status, assignees: record.assignees.length },
      })
    }
    this.options.onTaskChanged?.(record!)
  }

  /** Record an event from outside the hub.
   *
   *  The runner layer lives in `index.ts` and knows when a run starts and ends,
   *  which the hub cannot see. Deliberately narrow: a caller can ADD an event but
   *  cannot read or clear the ring through this.
   */
  noteEvent(kind: HubEventKind, input: { peer?: string; detail?: Record<string, unknown> } = {}): void {
    this.recordEvent(kind, input)
  }
  private readonly waiters = new Map<string, Waiter[]>()
  private readonly historyRing: BridgeMessage[] = []
  /** Structured operational events, newest last. A ring, not a log: the hub is a
   *  long-running process and an unbounded event list is a leak. See {@link events}. */
  private readonly eventRing: HubEvent[] = []
  private eventSeq = 0
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
    const parkedTtl = options.parkedTtlMs ?? DEFAULT_PARKED_TTL_MS
    if (idle > 0) {
      const interval = Math.min(60_000, Math.max(1_000, idle / 2))
      this.gcTimer = setInterval(() => this.gcTick(idle), interval)
      this.gcTimer.unref?.()
    } else if (parkedTtl > 0) {
      // The idle GC is off, but `parkedTtlMs` is an INDEPENDENT setting. Parked
      // mailboxes still exist without the GC: `importMailboxes` parks everything
      // it restores from SQLite. Expiry used to live only inside `gcTick`, so
      // turning the GC off silently made `--parked-ttl-ms` inert and those
      // mailboxes grew forever. That was an accident of where the call sat.
      const interval = Math.min(60_000, Math.max(1_000, parkedTtl / 2))
      this.gcTimer = setInterval(() => this.expireParkedMailboxes(Date.now()), interval)
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
        // Keep the mailbox: the peer is gone, not forgotten. Its queued mail is
        // delivered when it comes back, and expires on parkedTtlMs instead of
        // being destroyed the moment the idle timer fires (which is what used
        // to eat every message an agent received while it was not polling).
        this.unregister(peerId, { keepMailbox: true })
      }
    }
    // Reap EVERY peer's expired leases, not just whoever takes next: a peer that
    // goes quiet would otherwise hold them forever (and its mail would never be
    // offered to anyone again).
    for (const peerId of [...this.leases.keys()]) this.reapLeases(peerId, now)
    this.expireParkedMailboxes(now)
  }

  /** Drop parked mailboxes older than `parkedTtlMs` (0 disables expiry). */
  private expireParkedMailboxes(now: number): void {
    const ttl = this.options.parkedTtlMs ?? DEFAULT_PARKED_TTL_MS
    if (ttl <= 0) return
    for (const [peerId, parkedMs] of [...this.parkedAt]) {
      // A registered peer is not parked, whatever a stale record says: this is
      // the backstop for any path that forgets to move `parkedAt` with an id.
      // Deleting a live peer's mailbox here would be silent message loss.
      if (this.lastSeen.has(peerId)) {
        this.parkedAt.delete(peerId)
        continue
      }
      if (now - parkedMs <= ttl) continue
      const queue = this.queues.get(peerId) ?? []
      this.queues.delete(peerId)
      this.parkedAt.delete(peerId)
      // A dropped TASK must not leave the ledger reading `pending` forever: the
      // recipient is gone for good, and `bridge_tasks` has to be able to tell that
      // apart from "still working on it". Reconcile BEFORE reporting the drop, so
      // a reader reacting to the notice already sees the terminal state.
      for (const message of queue) {
        if (message.kind === 'task') this.failTaskForGoneAssignee(message.id, peerId, now, ttl)
      }
      const dropped = queue.length
      // Only report when something was actually lost: an empty parked mailbox is
      // just bookkeeping, and calling back with 0 made the caller log "parked
      // mailbox ... : 0 message(s) dropped" and re-snapshot the store for nothing.
      if (dropped > 0) {
        this.options.onMailboxesChanged?.()
        this.recordEvent('mailbox_dropped', { peer: peerId, detail: { reason: 'expired', dropped, ttlMs: ttl } })
        this.options.onMailboxExpired?.(peerId, dropped)
      }
    }
  }

  /** Reconcile the task ledger after `peerId`'s parked mailbox was destroyed with
   *  the task still inside it.
   *
   *  The task fails as a SYSTEM event, not as an ack: nobody acked anything, the
   *  peer simply never came back. Marking only this assignee's row keeps a
   *  broadcast task's other recipients intact, and the aggregate status is
   *  recomputed the same way every other transition does it. */
  private failTaskForGoneAssignee(taskId: string, peerId: string, now: number, ttl: number): void {
    const record = this.taskLedger.get(taskId)
    if (record === undefined) return
    if (TERMINAL_TASK_STATUSES.includes(record.status)) return
    const assignee = record.assignees.find(a => a.peerId === peerId)
    if (assignee === undefined || TERMINAL_TASK_STATUSES.includes(assignee.status)) return
    const event: TaskAckEvent = {
      from: peerId,
      status: 'failed',
      note: `recipient '${peerId}' never came back: its parked mailbox expired after ${ttl}ms and the task was dropped with it`,
      ts: now,
      messageId: `expired-${taskId}`,
      applied: true,
      system: true,
    }
    record.acks.push(event)
    assignee.status = 'failed'
    assignee.acks.push({ ...event })
    record.status = aggregateTaskStatus(record.assignees)
    record.updatedAt = now
    // The task can no longer time out: it is already terminal, and a later SLA
    // firing would append a second, contradictory system event.
    const timer = this.taskTimers.get(taskId)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.taskTimers.delete(taskId)
    }
    this.taskChanged(this.taskOf(taskId)!)
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
    // A returning peer is no longer parked: its mailbox (if any) is deliverable
    // again and must not be swept by the TTL.
    this.parkedAt.delete(peerId)
    const existing = this.profiles.get(peerId)
    this.profiles.set(peerId, {
      ...existing,
      id: peerId,
      registeredAt: existing?.registeredAt ?? Date.now(),
      ...(client?.name !== undefined ? { clientName: client.name } : existing?.clientName !== undefined ? { clientName: existing.clientName } : {}),
      ...(client?.version !== undefined ? { clientVersion: client.version } : existing?.clientVersion !== undefined ? { clientVersion: existing.clientVersion } : {}),
    })
    this.evictOverflowProfiles()
    this.recordEvent('peer_joined', { peer: peerId, detail: { clientName: client?.name } })
    this.options.onPeersChanged?.(this.peers())
  }

  /** Remove a peer; pending waiters resolve as timeouts. The profile is kept so
   * a reconnecting peer keeps its alias.
   *
   * `keepMailbox` is what the idle GC passes: the peer's queued messages stay in
   * `queues` (marked parked) so a returning agent drains what was sent while it
   * was away. An explicit `bridge_unregister` and a manager kick leave it off,
   * i.e. they still drop the mail — leaving the hub is a deliberate act. */
  unregister(peerId: string, options?: { keepMailbox?: boolean }): void {
    const queue = this.queues.get(peerId) ?? []
    // Parked = "went quiet", not "left". The idle GC parks (keeping any mail and
    // keeping the peer addressable, so a task can be handed to it now and read
    // when it wakes up); an explicit bridge_unregister or a manager kick drops
    // both the mailbox and the parked record — leaving is a deliberate act.
    const keep = options?.keepMailbox === true
    if (queue.length > 0) this.options.onMailboxesChanged?.()
    if (keep) {
      this.parkedAt.set(peerId, Date.now())
      this.recordEvent('peer_parked', { peer: peerId, detail: { queued: queue.length } })
    } else {
      this.recordEvent('peer_left', { peer: peerId, detail: { queued: queue.length } })
      this.queues.delete(peerId)
      this.parkedAt.delete(peerId)
    }
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
  /** Record what a peer says about itself. Creates the profile if the peer is
   *  new: a card is identity, and identity outlives a connection. */
  announceCard(peerId: string, card: PeerCard): PeerProfile {
    const existing = this.profiles.get(peerId)
    const profile: PeerProfile = { ...existing, id: peerId, registeredAt: existing?.registeredAt ?? Date.now(), card }
    this.profiles.set(peerId, profile)
    this.evictOverflowProfiles()
    // A card IS roster state: other peers see it in `bridge_peers`, and it has to
    // be persisted. Firing this is what marks the roster dirty and pushes the
    // SSE update — without it the card lives only in memory and dies on restart.
    this.options.onPeersChanged?.(this.peers())
    return profile
  }

  /** Every peer whose announced card matches `filter`, with the load a caller
   *  needs to pick one.
   *
   *  `acceptsTasks` defaults to TRUE — and that default is the point: discover is
   *  for finding somebody to HAND WORK TO, and "has a skill" is not "wants a
   *  task". Pass `false` to drop the requirement and list peers regardless. */
  discover(filter: { skill?: string; tag?: string; acceptsTasks?: boolean; idleOnly?: boolean } = {}): Array<{
    peerId: string
    alias?: string
    card: PeerCard
    load: { queued: number; waiting: number; running: number }
  }> {
    const requireAccept = filter.acceptsTasks !== false
    const out: Array<{ peerId: string; alias?: string; card: PeerCard; load: { queued: number; waiting: number; running: number } }> = []
    for (const profile of this.profiles.values()) {
      const card = profile.card
      if (card === undefined) continue
      if (requireAccept && card.acceptsTasks !== true) continue
      const skills = card.skills ?? []
      if (filter.skill !== undefined && !skills.some(skill => skill.id === filter.skill)) continue
      if (filter.tag !== undefined && !skills.some(skill => (skill.tags ?? []).includes(filter.tag!))) continue
      const load = {
        queued: this.queues.get(profile.id)?.length ?? 0,
        waiting: this.waiters.get(profile.id)?.length ?? 0,
        running: [...this.taskLedger.values()].filter(
          record => !TERMINAL_TASK_STATUSES.includes(record.status) && record.assignees.some(a => a.peerId === profile.id),
        ).length,
      }
      if (filter.idleOnly === true && (load.queued > 0 || load.waiting > 0 || load.running > 0)) continue
      out.push({ peerId: profile.id, ...(profile.alias !== undefined ? { alias: profile.alias } : {}), card, load })
    }
    return out
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
      // A card is part of the peer's identity and must survive a restart. This
      // whitelist is why the line has to exist at all.
      if (candidate.card !== null && typeof candidate.card === 'object') profile.card = candidate.card as PeerCard
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
    if (newId === HUB_PEER) throw new Error(`reserved peer id: ${newId}`)
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
    // `parkedAt` must not survive an id change. This method only ever moves a
    // *registered* peer (checked above), so after the rename it is live and no
    // parked record may remain — neither the old id's nor a stale one already
    // sitting on the target id. Leaving the latter was silent message loss:
    // the parked TTL then deleted the live peer's mailbox.
    this.parkedAt.delete(oldId)
    this.parkedAt.delete(newId)
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

  /** Is the peer parked — gone from the live registry through idle GC, but still
   *  holding its mailbox and still addressable? `has()` is false for it, so a
   *  guard written only as `has()` will decide there is nothing to do and leave
   *  the peer reachable. A manager kick has to cover this state explicitly. */
  isParked(peerId: string): boolean {
    return this.parkedAt.has(peerId)
  }

  /** Is the peer "active" (tool/activity within the connected window)? */
  isActive(peerId: string): boolean {
    const last = this.lastSeen.get(peerId)
    return last !== undefined && Date.now() - last < (this.options.connectedWindowMs ?? 30_000)
  }

  /** Send a chat/notice text message to `to` (or {@link BROADCAST}). */
  send(from: string, to: string, kind: 'chat' | 'notice', content: string, opts?: { ref?: string; threadId?: string; expiresAt?: number; priority?: 0 | 1 | 2 }): BridgeMessage {
    return this.route(from, to, kind, content, opts?.ref, opts?.threadId, opts?.expiresAt, false, opts?.priority)
  }

  /** Send a structured task message to `to` (peer, {@link BROADCAST}, or a
   * group id). Records a ledger entry so the sender can later query status /
   * wait for acks.
   *
   * `ref` marks the task this one answers. When the parent is itself a task the
   * new one is a **re-delegation**, and that chain is capped at {@link MAX_HOP}
   * — without a way to express the parent, the cap would be unreachable and a
   * hand-off loop unobservable. */
  sendTask(from: string, to: string, task: TaskContent, ref?: string, expiresAt?: number): BridgeMessage {
    const threadId = task.threadId
    // The ledger row must exist BEFORE delivery: deliver() books the first
    // delivery time on the assignee row and silently gives up when the task
    // is not in the ledger yet. With route()'s deliver-then-record order
    // every task that reached a waiter (or a mailbox) lost its deliveredMs.
    const message = this.compose(from, to, 'task', JSON.stringify(task), ref, threadId, expiresAt, false, task.priority)
    this.recordTask(message, task)
    this.dispatch(message)
    return message
  }

  /** Send an acknowledgement back to the sender of `ref`. Updates the task
   * ledger when `ref` is a known task (looked up in the ledger first, so acks
   * survive history-ring eviction); chat/notice refs still route via history. */
  sendAck(from: string, ref: string, ack: { status: AckStatus; note?: string; progress?: number; artifacts?: TaskArtifact[] }): BridgeMessage {
    const task = this.taskLedger.get(ref)
    let target: string
    // An ack belongs to the conversation its task belongs to: without this an
    // ack lands outside the thread, so a client waiting on `threadId` never sees
    // the outcome of the task it is tracking.
    let threadId: string | undefined
    if (task !== undefined) {
      target = task.from
      threadId = task.threadId
    } else {
      const original = this.historyRing.findLast(message => message.id === ref)
      if (!original) throw new Error(`cannot ack unknown message: ${ref}`)
      target = original.from
      threadId = original.threadId
    }
    const message = this.route(from, target, 'ack', JSON.stringify(ack), ref, threadId)
    this.applyAckToLedger(message, from, ref, ack)
    return message
  }

  /** Record an ack the hub produced ON BEHALF of a peer whose runner finished
   *  its task (see `src/runner.ts`).
   *
   *  Unlike {@link sendAck} the sender is not a live session — it may be parked,
   *  or not connected at all — so the "sender must be registered" check does not
   *  apply. This is the hub acting for a peer it is executing for, never a
   *  caller-supplied identity; nothing from a request reaches `from` here.
   *  Everything else (ledger update, routing to the task's sender) is identical. */
  ackForRunner(peer: string, ref: string, ack: { status: AckStatus; note?: string }): BridgeMessage {
    const task = this.taskLedger.get(ref)
    if (task === undefined) throw new Error(`runner cannot ack unknown task: ${ref}`)
    const message = this.route(peer, task.from, 'ack', JSON.stringify(ack), ref, undefined, undefined, true)
    this.applyAckToLedger(message, peer, ref, ack)
    return message
  }

  /** Cancel a task. EITHER side may do it — the sender stops work it no longer
   *  wants, an assignee reports it will not finish — and the cancel is both
   *  recorded on the ledger and routed to the OTHER side, so whoever did not
   *  press the button finds out. Cancelling an already-terminal task is an error
   *  rather than a silent no-op: the caller asked for something that did not
   *  happen. */
  cancelTask(from: string, ref: string, reason?: string): BridgeMessage {
    const record = this.taskLedger.get(ref)
    if (record === undefined) throw new Error(`cannot cancel unknown task: ${ref}`)
    const isSender = from === record.from
    if (!isSender && !record.assignees.some(a => a.peerId === from)) {
      throw new Error(`only the sender or an assignee can cancel task ${ref}`)
    }
    if (TERMINAL_TASK_STATUSES.includes(record.status)) {
      throw new Error(`task ${ref} is already ${record.status}`)
    }
    const ack: { status: AckStatus; note?: string } = { status: 'canceled', ...(reason !== undefined ? { note: reason } : {}) }
    if (!isSender) {
      // An assignee cancelling is an ordinary ack: it is recorded on that
      // assignee's row and routed back to the sender.
      return this.sendAck(from, ref, ack)
    }
    // The sender cancelling stops work for EVERY assignee that is still going,
    // and each of them is told. Terminal assignee rows are left as they are: a
    // finished part of a broadcast task is still finished.
    let last: BridgeMessage | undefined
    for (const assignee of record.assignees) {
      if (TERMINAL_TASK_STATUSES.includes(assignee.status)) continue
      const message = this.route(from, assignee.peerId, 'ack', JSON.stringify(ack), ref, record.threadId)
      const event: TaskAckEvent = {
        from,
        status: 'canceled',
        ...(reason !== undefined ? { note: reason } : {}),
        ts: message.ts,
        messageId: message.id,
        applied: true,
      }
      record.acks.push(event)
      assignee.status = 'canceled'
      assignee.acks.push({ ...event })
      last = message
    }
    if (last === undefined) throw new Error(`task ${ref} has no assignee left to cancel`)
    record.status = aggregateTaskStatus(record.assignees)
    record.updatedAt = last.ts
    this.taskChanged(this.taskOf(ref)!)
    return last
  }

  /** Answer an `input-required` interrupt. Only the task's SENDER can answer — it
   *  is the side the assignee asked. The answer is delivered to the waiting
   *  assignee as an `ack` carrying the task id, so a `bridge_wait { ref }` picks
   *  it up, and the task resumes (`working`). */
  taskInput(from: string, ref: string, input: string): BridgeMessage {
    const record = this.taskLedger.get(ref)
    if (record === undefined) throw new Error(`cannot answer unknown task: ${ref}`)
    if (from !== record.from) {
      throw new Error(`only the sender of task ${ref} can answer it (an assignee resumes by acking 'working')`)
    }
    if (TERMINAL_TASK_STATUSES.includes(record.status)) {
      throw new Error(`task ${ref} is already ${record.status}`)
    }
    const waiting = record.assignees.filter(a => a.status === 'input-required')
    const targets = waiting.length > 0 ? waiting : record.assignees
    const ack: { status: AckStatus; note?: string } = { status: 'working', note: input }
    let last: BridgeMessage | undefined
    for (const assignee of targets) {
      const message = this.route(from, assignee.peerId, 'ack', JSON.stringify(ack), ref, record.threadId)
      const event: TaskAckEvent = { from, status: 'working', note: input, ts: message.ts, messageId: message.id, applied: true }
      record.acks.push(event)
      if (assignee.status === 'input-required') {
        assignee.status = 'working'
        assignee.acks.push({ ...event })
      }
      last = message
    }
    if (last === undefined) throw new Error(`task ${ref} has no assignee to answer`)
    record.status = aggregateTaskStatus(record.assignees)
    record.updatedAt = last.ts
    this.taskChanged(this.taskOf(ref)!)
    return last
  }

  /** Every peer a fan-out can reach: the live registry **plus** parked peers.
   *
   *  Parked peers keep their mailbox and stay addressable (that is the point of
   *  parking, see {@link isParked}), and a group send already delivered to its
   *  parked members because it reads the member list rather than the live roster.
   *  Broadcast read the live roster, so `peer-x` showed up in `bridge_peers` as
   *  addressable yet silently missed every broadcast. Both resolve here now. */
  private audience(): string[] {
    const ids = new Set(this.lastSeen.keys())
    for (const id of this.parkedAt.keys()) ids.add(id)
    return [...ids]
  }
  /** Resolve the peer ids a task is assigned to (broadcast / group fan-out). */
  private resolveAssignees(from: string, to: string): string[] {
    if (to === BROADCAST) return this.audience().filter(peer => peer !== from)
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
    this.taskChanged(this.taskOf(record.id)!)
  }

  /** Arm the SLA timer for a task that supplied `timeoutMs`. A deadline
   * beyond {@link MAX_TIMER_DELAY_MS} cannot be expressed as one delay — the
   * timer would overflow and fire after ~1 ms — so it is re-armed in segments
   * of that size. `deadlineAt` stays the authoritative deadline and each
   * segment recomputes the remaining time, so a long SLA is honored exactly
   * (no drift); settling or evicting the task clears the pending segment, and
   * clearing the timer is what ends the chain. */
  private scheduleTaskTimeout(record: TaskRecord): void {
    if (record.deadlineAt === undefined) return
    const remaining = record.deadlineAt - Date.now()
    const timer = remaining > MAX_TIMER_DELAY_MS
      ? setTimeout(() => this.scheduleTaskTimeout(record), MAX_TIMER_DELAY_MS)
      : setTimeout(() => this.fireTaskTimeout(record.id), Math.max(0, remaining))
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
    this.taskChanged(this.taskOf(taskId)!)
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
    this.taskChanged(this.taskOf(taskId)!)
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
    ack: { status: AckStatus; note?: string; progress?: number; artifacts?: TaskArtifact[] },
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
      ...(ack.artifacts !== undefined && ack.artifacts.length > 0 ? { artifacts: ack.artifacts } : {}),
      ts: message.ts,
      messageId: message.id,
      applied,
    }
    record.acks.push(event)
    // The flat list is what a consumer reads (`bridge_task_status`); the timeline
    // keeps the per-event grouping. Only APPLIED events contribute, so a rejected
    // or post-terminal ack cannot smuggle output into the task's results.
    if (applied && event.artifacts !== undefined) {
      record.artifacts = [...(record.artifacts ?? []), ...event.artifacts]
    }

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
    this.taskChanged(this.taskOf(record.id)!)
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

  /** Highest sequence number handed out so far — a client's "start from now"
   *  cursor (`bridge_status.lastSeq`). */
  lastSeq(): number {
    return this.seqCounter
  }

  /** Recent messages involving `peer` (inbound and outbound, plus group
   * channels the peer belongs to), newest first. `since` restricts the result to
   * messages newer than that sequence number (a resume cursor); omitting it keeps
   * the original behaviour, which includes history recorded before cursors
   * existed. */
  history(peerId: string, limit: number, since?: number): BridgeMessage[] {
    const memberOf = new Set(
      [...this.groups.values()].filter(group => group.members.includes(peerId)).map(group => group.id),
    )
    const filtered = this.historyRing.filter(
      message =>
        (since === undefined || (message.seq ?? 0) > since) &&
        (message.from === peerId || message.to === peerId || message.to === BROADCAST || (message.channel !== undefined && memberOf.has(message.channel))),
    )
    return filtered.slice(-Math.max(0, limit)).reverse()
  }

  /** Recent messages of one group channel, newest first. */
  historyChannel(groupId: string, limit: number, since?: number): BridgeMessage[] {
    const filtered = this.historyRing.filter(
      message => (since === undefined || (message.seq ?? 0) > since) && (message.channel === groupId || (message.to === groupId && message.channel === undefined && this.groups.has(groupId))),
    )
    return filtered.slice(-Math.max(0, limit)).reverse()
  }

  /** Most recent messages across every peer, unfiltered (newest first).
   * Backs `bridge_history { peer: "all" }` — lets an archiver (the desktop
   * app) capture peer-to-peer traffic it is not a party of. */
  historyAll(limit: number, since?: number): BridgeMessage[] {
    const filtered = since === undefined ? this.historyRing : this.historyRing.filter(message => (message.seq ?? 0) > since)
    return filtered.slice(-Math.max(0, limit)).reverse()
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
      const hop = importHop(m.hop)
      valid.push({
        id: m.id,
        from: m.from,
        to: m.to,
        kind: m.kind as MessageKind,
        content: m.content,
        ...(typeof m.ref === 'string' ? { ref: m.ref } : {}),
        ...(typeof m.channel === 'string' ? { channel: m.channel } : {}),
        ...(typeof m.threadId === 'string' ? { threadId: m.threadId } : {}),
        ...(hop !== undefined ? { hop } : {}),
        // Absent in databases written before the column existed; such a message
        // is simply unreachable through a `since` cursor, which is the honest
        // state for history that predates the cursor.
        ...(typeof m.seq === 'number' && Number.isFinite(m.seq) && m.seq > 0 ? { seq: m.seq } : {}),
        ...(typeof m.expiresAt === 'number' && Number.isFinite(m.expiresAt) && m.expiresAt > 0 ? { expiresAt: m.expiresAt } : {}),
        ts: m.ts,
      })
    }
    // Never let the counter go backwards across a restart: a client that synced
    // to seq N before the hub stopped must not be handed N again after it starts.
    for (const message of valid) {
      if (message.seq !== undefined && message.seq > this.seqCounter) this.seqCounter = message.seq
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
        const hop = importHop(m.hop)
        restored.push({
          id: m.id,
          from: m.from,
          to: typeof m.to === 'string' ? m.to : peer,
          kind: (KINDS as readonly string[]).includes(m.kind as string) ? (m.kind as MessageKind) : 'chat',
          content: m.content,
          ...(typeof m.ref === 'string' ? { ref: m.ref } : {}),
          ...(typeof m.channel === 'string' ? { channel: m.channel } : {}),
          ...(typeof m.threadId === 'string' ? { threadId: m.threadId } : {}),
          ...(hop !== undefined ? { hop } : {}),
          // Restored mail must keep its deadline and its sequence number: the
          // deadline decides whether it is still deliverable at all, and the
          // cursor has to stay continuous across a restart.
          ...(typeof m.seq === 'number' && Number.isFinite(m.seq) && m.seq > 0 ? { seq: m.seq } : {}),
          ...(typeof m.expiresAt === 'number' && Number.isFinite(m.expiresAt) && m.expiresAt > 0 ? { expiresAt: m.expiresAt } : {}),
          ts: m.ts,
        })
      }
      if (restored.length > 0) {
        this.queues.set(peer, restored.slice(-this.options.maxQueue))
        // Restored mail belongs to a peer that is not registered yet: mark it
        // parked so the TTL sweep covers it and the roster can show it.
        if (!this.lastSeen.has(peer)) this.parkedAt.set(peer, Date.now())
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
      peers: this.rosterRows(livePeers),
      historyLimit: this.options.historyLimit,
      maxQueue: this.options.maxQueue,
      // A client that wants only what happened since it last looked reads this
      // and passes it back as `bridge_history { since }`.
      lastSeq: this.seqCounter,
    }
  }

  /** Registered peers plus parked ones (gone but still holding mail).
   * Parked rows are what lets a sender tell "queued, will be delivered when it
   * comes back" apart from "vanished" — without them the message just looks lost.
   */
  private rosterRows(livePeers?: ReadonlySet<string>): PeerState[] {
    const rows: PeerState[] = this.peers().map(peer => {
      const alias = this.profiles.get(peer)?.alias
      const connected = this.isActive(peer) || livePeers?.has(peer) === true
      return {
        id: peer,
        ...(alias !== undefined ? { alias } : {}),
        connected,
        reachable: connected ? 'online' : 'idle',
        lastSeenMs: this.lastSeen.get(peer) ?? 0,
        queued: (this.queues.get(peer) ?? []).length,
        waiting: (this.waiters.get(peer) ?? []).length,
        ...(this.leases.get(peer) !== undefined ? { inFlight: this.leases.get(peer)!.length } : {}),
        ...(this.drops.get(peer) !== undefined && this.drops.get(peer)!.overflow > 0 ? { droppedOverflow: this.drops.get(peer)!.overflow } : {}),
        ...(this.drops.get(peer) !== undefined && this.drops.get(peer)!.expired > 0 ? { droppedExpired: this.drops.get(peer)!.expired } : {}),
        ...(this.drops.get(peer) !== undefined && this.drops.get(peer)!.rate > 0 ? { droppedRate: this.drops.get(peer)!.rate } : {}),
        ...(this.deadLetters.get(peer) !== undefined ? { deadLettered: this.deadLetters.get(peer)!.length } : {}),
      }
    })
    for (const [peerId, parkedMs] of this.parkedAt) {
      if (this.lastSeen.has(peerId)) continue
      const alias = this.profiles.get(peerId)?.alias
      rows.push({
        id: peerId,
        ...(alias !== undefined ? { alias } : {}),
        connected: false,
        reachable: 'parked',
        lastSeenMs: parkedMs,
        queued: (this.queues.get(peerId) ?? []).length,
        waiting: 0,
        ...(this.leases.get(peerId) !== undefined ? { inFlight: this.leases.get(peerId)!.length } : {}),
        ...(this.deadLetters.get(peerId) !== undefined ? { deadLettered: this.deadLetters.get(peerId)!.length } : {}),
      })
    }
    return rows
  }

  // ---- manual-ack leases -----------------------------------------------------

  /** A message handed out but not yet committed, and when its lease ends. */
  private readonly leases = new Map<string, { message: BridgeMessage; expiresAt: number }[]>()
  /** Hand-out count per (peer, message). Kept OUTSIDE the message so requeueing
   *  preserves it and so it is never persisted as part of the message. */
  private readonly leaseAttempts = new Map<string, number>()
  /** Messages that ran out of attempts; `nack` revives them. */
  private readonly deadLetters = new Map<string, BridgeMessage[]>()

  // ---- drop accounting --------------------------------------------------------

  /** Per-peer drop counters, surfaced in the roster. Memory-only on purpose:
   *  these are operational counters for the current run, not durable state. */
  private readonly drops = new Map<string, { overflow: number; expired: number; rate: number }>()

  /** Per-peer token bucket for the MAILBOX. See {@link HubOptions.ratePerMin}. */
  private readonly buckets = new Map<string, { tokens: number; last: number }>()

  /** Traffic counters, per peer: how much this peer sent, was sent, and acked.
   *  Deliberately separate from the mailbox — "how much has this peer sent" is not
   *  "how much is queued", and a drained queue must not erase the history of what
   *  went through it. Memory-only, like {@link drops}: operational, not durable. */
  private readonly traffic = new Map<string, { sent: number; received: number; acked: number }>()

  private bumpTraffic(peerId: string, field: 'sent' | 'received' | 'acked'): void {
    const row = this.traffic.get(peerId) ?? { sent: 0, received: 0, acked: 0 }
    row[field]++
    this.traffic.set(peerId, row)
  }

  /**
   * Observability snapshot: per-peer and global counters.
   *
   * Everything here is either derived from live state or from a counter the hub
   * already keeps — nothing is estimated, and nothing is sampled. `messagesTotal`
   * is the history `seq` (monotonic, never resets in a run), so it is a true count
   * of composed messages rather than a rolling window.
   */
  metrics(): {
    global: {
      messagesTotal: number
      peers: number
      connectedPeers: number
      parkedPeers: number
      waitersNow: number
      queuedTotal: number
      tasksByStatus: Record<string, number>
      droppedOverflow: number
      droppedExpired: number
      droppedRate: number
      deadLettered: number
      inFlight: number
    }
    peers: Array<{
      peerId: string
      sent: number
      received: number
      acked: number
      queued: number
      inFlight: number
      deadLettered: number
      droppedOverflow: number
      droppedExpired: number
      droppedRate: number
      connected: boolean
    }>
  } {
    const tasksByStatus: Record<string, number> = {}
    for (const record of this.taskLedger.values()) {
      tasksByStatus[record.status] = (tasksByStatus[record.status] ?? 0) + 1
    }

    // Every peer the hub has heard of: live, parked, or only in the traffic
    // counters (a peer that sent and left is still worth reporting).
    const ids = new Set<string>([
      ...this.lastSeen.keys(),
      ...this.parkedAt.keys(),
      ...this.queues.keys(),
      ...this.traffic.keys(),
    ])
    const peers = [...ids].map(peerId => {
      const row = this.traffic.get(peerId) ?? { sent: 0, received: 0, acked: 0 }
      const drop = this.drops.get(peerId) ?? { overflow: 0, expired: 0, rate: 0 }
      return {
        peerId,
        sent: row.sent,
        received: row.received,
        acked: row.acked,
        queued: this.queues.get(peerId)?.length ?? 0,
        inFlight: this.leases.get(peerId)?.length ?? 0,
        deadLettered: this.deadLetters.get(peerId)?.length ?? 0,
        droppedOverflow: drop.overflow,
        droppedExpired: drop.expired,
        droppedRate: drop.rate,
        // Same definition the roster uses: recent activity OR a live SSE channel.
        connected: this.isActive(peerId) || this.options.isPeerLive?.(peerId) === true,
      }
    })

    return {
      global: {
        messagesTotal: this.seqCounter,
        peers: peers.length,
        connectedPeers: peers.filter(p => p.connected).length,
        parkedPeers: peers.filter(p => !p.connected && this.parkedAt.has(p.peerId)).length,
        waitersNow: [...this.waiters.values()].reduce((sum, list) => sum + list.length, 0),
        queuedTotal: peers.reduce((sum, p) => sum + p.queued, 0),
        tasksByStatus,
        droppedOverflow: peers.reduce((sum, p) => sum + p.droppedOverflow, 0),
        droppedExpired: peers.reduce((sum, p) => sum + p.droppedExpired, 0),
        droppedRate: peers.reduce((sum, p) => sum + p.droppedRate, 0),
        deadLettered: peers.reduce((sum, p) => sum + p.deadLettered, 0),
        inFlight: peers.reduce((sum, p) => sum + p.inFlight, 0),
      },
      peers: peers.sort((a, b) => a.peerId.localeCompare(b.peerId)),
    }
  }

  /** Count a dropped message for `peerId` and, if that peer is waiting right
   *  now, tell it. The notice is NOT queued: the mailbox is either full
   *  (overflow) or the message already expired, and queueing the notice would
   *  push yet another message out. An offline peer just sees the counters. */
  /** May this peer's mailbox accept one more message right now?
   *
   *  Applied on the QUEUE path only, never on a waiter handoff: a waiting peer
   *  already controls its own rate (it gets one message per `bridge_wait`), while a
   *  mailbox is filled by traffic the recipient never asked for. That is the whole
   *  point of the bucket.
   */
  private takeToken(peerId: string, now: number): boolean {
    const rate = this.options.ratePerMin ?? 0
    if (rate <= 0) return true
    const bucket = this.buckets.get(peerId) ?? { tokens: rate, last: now }
    // Refill continuously, so the limit does not depend on WHEN the check happens.
    const elapsed = Math.max(0, now - bucket.last)
    bucket.tokens = Math.min(rate, bucket.tokens + (elapsed * rate) / 60_000)
    bucket.last = now
    if (bucket.tokens < 1) {
      this.buckets.set(peerId, bucket)
      return false
    }
    bucket.tokens -= 1
    this.buckets.set(peerId, bucket)
    return true
  }

  private countDrop(peerId: string, kind: 'overflow' | 'expired' | 'rate', now: number): void {
    const stats = this.drops.get(peerId) ?? { overflow: 0, expired: 0, rate: 0 }
    stats[kind] += 1
    this.drops.set(peerId, stats)
    const total = stats.overflow + stats.expired + stats.rate
    this.recordEvent('mailbox_dropped', { peer: peerId, detail: { reason: kind, total } })
    const notice: BridgeMessage = {
      id: randomUUID(),
      seq: ++this.seqCounter,
      from: HUB_PEER,
      to: peerId,
      kind: 'notice',
      content: encodeContent({
        message: kind === 'overflow'
          ? `mailbox overflow: an older message was dropped before you read it (${total} dropped so far)`
          : kind === 'rate'
            ? `rate limit: messages addressed to you arrived faster than ${this.options.ratePerMin ?? 0}/min and were dropped (${total} dropped so far)`
            : `a message addressed to you expired before delivery and was dropped (${total} dropped so far)`,
        level: 'warn',
      }),
      ts: now,
    }
    // Two different situations, two different deliveries:
    //  - overflow means the mailbox is FULL, so queueing the notice would push
    //    yet another message out; only a peer that is waiting hears it.
    //  - expiry says nothing about the mailbox, so the notice can be queued and
    //    the peer will read it on its next poll. It is pushed directly rather
    //    than through deliver(), which would re-enter this overflow path.
    // A rate drop must NOT queue its notice either: the whole point of the bucket
    // is that a storm cannot grow this mailbox, and one notice per dropped message
    // would grow it exactly as fast as the storm. Only a waiting peer hears it.
    if (kind === 'expired') {
      const queue = this.queues.get(peerId) ?? []
      if (queue.length < this.options.maxQueue) {
        queue.push(notice)
        this.queues.set(peerId, queue)
        this.options.onQueued?.(notice, peerId)
        this.options.onMailboxesChanged?.()
        return
      }
    }
    this.deliverToWaiter(peerId, notice)
  }

  /** Drop counters for `peerId` (undefined when nothing was ever dropped). */
  dropsFor(peerId: string): { overflow: number; expired: number } | undefined {
    return this.drops.get(peerId)
  }

  /** Hand `message` to a matching live waiter, if there is one. Never queues —
   *  used for notices about a mailbox that must not grow. Returns whether it
   *  was handed over. */
  private deliverToWaiter(target: string, message: BridgeMessage): boolean {
    const list = this.waiters.get(target) ?? []
    const index = list.findIndex(waiter => {
      if (waiter.from !== undefined && waiter.from !== message.from) return false
      if (waiter.ref !== undefined && !(message.kind === 'ack' && message.ref === waiter.ref)) return false
      if (waiter.threadId !== undefined && message.threadId !== waiter.threadId) return false
      return true
    })
    if (index < 0) return false
    const [waiter] = list.splice(index, 1)
    this.waiters.set(target, list)
    clearTimeout(waiter.timer)
    waiter.resolve({ type: 'message', message: this.handOut(target, message, waiter.manual === true, message.ts) })
    return true
  }

  private static leaseKey(peerId: string, messageId: string): string {
    return `${peerId}\u0000${messageId}`
  }

  /** Return expired leases to the FRONT of the queue (order preserved), or
   *  dead-letter them once they have been handed out too many times. Called
   *  before every take, so expiry needs no timer of its own. */
  private reapLeases(peerId: string, now: number): void {
    const list = this.leases.get(peerId)
    if (list === undefined || list.length === 0) return
    const max = this.options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    const still: { message: BridgeMessage; expiresAt: number }[] = []
    const back: BridgeMessage[] = []
    for (const lease of list) {
      if (lease.expiresAt > now) {
        still.push(lease)
        continue
      }
      const attempts = this.leaseAttempts.get(AgentHub.leaseKey(peerId, lease.message.id)) ?? 0
      if (max > 0 && attempts >= max) {
        const dead = this.deadLetters.get(peerId) ?? []
        dead.push(lease.message)
        this.deadLetters.set(peerId, dead)
        continue
      }
      back.push(lease.message)
    }
    if (still.length > 0) this.leases.set(peerId, still)
    else this.leases.delete(peerId)
    if (back.length > 0) {
      const queue = this.queues.get(peerId) ?? []
      insertByPriority(queue, back)
      this.queues.set(peerId, queue)
      this.options.onMailboxesChanged?.()
    }
  }

  /** Hand a message to `peerId`. Without `manual` it is gone; with it the hub
   *  keeps a lease and the peer must `commit` or `nack` before it expires. */
  private handOut(peerId: string, message: BridgeMessage, manual: boolean, now: number): DeliveredMessage {
    if (!manual) return message
    const key = AgentHub.leaseKey(peerId, message.id)
    const attempts = (this.leaseAttempts.get(key) ?? 0) + 1
    this.leaseAttempts.set(key, attempts)
    const expiresAt = now + (this.options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS)
    const list = this.leases.get(peerId) ?? []
    list.push({ message, expiresAt })
    this.leases.set(peerId, list)
    return { ...message, attempts, leaseExpiresAt: expiresAt }
  }

  /** Mark leased messages as consumed; returns how many leases were released. */
  commit(peerId: string, ids: readonly string[]): number {
    const wanted = new Set(ids)
    const list = this.leases.get(peerId)
    if (list === undefined) return 0
    const still = list.filter(lease => !wanted.has(lease.message.id))
    const released = list.length - still.length
    for (const id of wanted) this.leaseAttempts.delete(AgentHub.leaseKey(peerId, id))
    if (still.length > 0) this.leases.set(peerId, still)
    else this.leases.delete(peerId)
    return released
  }

  /** Give messages back NOW — from live leases or from the dead letters. Attempts
   *  are kept, so a message that keeps failing still eventually dead-letters;
   *  reviving a dead letter resets its count, which is the point of reviving it. */
  nack(peerId: string, ids: readonly string[]): number {
    const wanted = new Set(ids)
    const back: BridgeMessage[] = []
    const list = this.leases.get(peerId)
    if (list !== undefined) {
      const still: { message: BridgeMessage; expiresAt: number }[] = []
      for (const lease of list) {
        if (wanted.has(lease.message.id)) back.push(lease.message)
        else still.push(lease)
      }
      if (still.length > 0) this.leases.set(peerId, still)
      else this.leases.delete(peerId)
    }
    const dead = this.deadLetters.get(peerId)
    if (dead !== undefined) {
      const still: BridgeMessage[] = []
      for (const message of dead) {
        if (wanted.has(message.id)) {
          back.push(message)
          this.leaseAttempts.delete(AgentHub.leaseKey(peerId, message.id))
        } else still.push(message)
      }
      if (still.length > 0) this.deadLetters.set(peerId, still)
      else this.deadLetters.delete(peerId)
    }
    if (back.length === 0) return 0
    const queue = this.queues.get(peerId) ?? []
    insertByPriority(queue, back)
    this.queues.set(peerId, queue)
    this.options.onMailboxesChanged?.()
    return back.length
  }

  /** Non-blocking drain of everything queued for `peer` (optionally from one sender). */
  poll(peerId: string, from?: string, options?: { manual?: boolean }): DeliveredMessage[] {
    const now = Date.now()
    this.reapLeases(peerId, now)
    const queue = this.queues.get(peerId) ?? []
    // Sweep the deadline BEFORE draining: an expired message must not be handed
    // out, and doing it here means the notice about it is part of this same
    // drain rather than one the caller has to know to ask for again.
    for (let i = queue.length - 1; i >= 0; i--) {
      const queued = queue[i]!
      if (queued.expiresAt !== undefined && queued.expiresAt <= now) {
        queue.splice(i, 1)
        this.countDrop(peerId, 'expired', now)
      }
    }
    const drained = from === undefined ? queue.splice(0, queue.length) : drainFrom(queue, from)
    if (drained.length > 0) this.options.onMailboxesChanged?.()
    return drained.map(message => this.handOut(peerId, message, options?.manual === true, now))
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
  wait(peerId: string, timeoutMs: number, from?: string, signal?: AbortSignal, ref?: string, threadId?: string, manual?: boolean, maxMessages = 1): Promise<WaitResult> {
    const startedAt = Date.now()
    const matches = (message: BridgeMessage): boolean => {
      if (from !== undefined && message.from !== from) return false
      if (ref !== undefined && !(message.kind === 'ack' && message.ref === ref)) return false
      if (threadId !== undefined && message.threadId !== threadId) return false
      return true
    }
    // Expired leases come back before anything is matched, so a peer that waits
    // again sees what it never committed.
    this.reapLeases(peerId, startedAt)
    const queue = this.queues.get(peerId)
    // Same deadline sweep as poll: an expired message must not match, and it
    // must not sit at the head of the queue blocking nothing but looking real.
    if (queue !== undefined) {
      for (let i = queue.length - 1; i >= 0; i--) {
        const queued = queue[i]!
        if (queued.expiresAt !== undefined && queued.expiresAt <= startedAt) {
          queue.splice(i, 1)
          this.countDrop(peerId, 'expired', startedAt)
        }
      }
    }
    if (queue !== undefined && queue.length > 0) {
      // Take up to `maxMessages` matching messages in one call: a burst (or a
      // reconnect with a full mailbox) otherwise costs one round-trip each.
      const take = Math.max(1, Math.floor(maxMessages))
      const taken: BridgeMessage[] = []
      for (let i = 0; i < queue.length && taken.length < take; ) {
        if (matches(queue[i]!)) taken.push(...queue.splice(i, 1))
        else i++
      }
      if (taken.length > 0) {
        this.options.onMailboxesChanged?.()
        const delivered = taken.map(queued => this.handOut(peerId, queued, manual === true, startedAt))
        // The SHAPE follows the request, not the count, so a caller always knows
        // which field to read (see DeliveredBatch in protocol.ts).
        return Promise.resolve(take > 1
          ? { type: 'messages', messages: delivered }
          : { type: 'message', message: delivered[0]! })
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
        ...(manual === true ? { manual } : {}),
        // A batch request keeps the batch SHAPE even when the wait ends with a
        // single message, so the caller's field access does not depend on timing.
        ...(maxMessages > 1 ? { batch: true } : {}),
      })
      this.waiters.set(peerId, list)
    })
  }

  /** Create a message from `from` addressed to `to` and deliver it. `to` may
   *  be a peer id, {@link BROADCAST}, or a group id. */
  private route(from: string, to: string, kind: MessageKind, content: string, ref?: string, threadId?: string, expiresAt?: number, system = false, priority?: 0 | 1 | 2): BridgeMessage {
    const message = this.compose(from, to, kind, content, ref, threadId, expiresAt, system, priority)
    this.dispatch(message)
    return message
  }

  /** Validate, build, and record a message from `from` to `to` (`to` may be a
   *  peer id, {@link BROADCAST}, or a group id). Composing and dispatching are
   *  separate steps because a caller may need ledger state to exist before
   *  anything reaches a recipient — {@link sendTask} books delivery times. */
  private compose(from: string, to: string, kind: MessageKind, content: string, ref?: string, threadId?: string, expiresAt?: number, system = false, priority?: 0 | 1 | 2): BridgeMessage {
    // `system` is only ever set by hub-internal senders (the drop notice and a
    // runner's ack): they act for the hub, not for a session, so they are not in
    // the registry. A caller can never reach this flag.
    if (!system && !this.lastSeen.has(from)) throw new Error(`sender not registered: ${from}`)
    const group = this.groups.get(to)
    // A recipient is addressable when it is registered OR was known before (its
    // profile outlives the session). The second half is what makes an idle agent
    // reachable: registering and being online are different things, and tying
    // routing to the first meant "you must be online right now" — an agent that
    // had gone quiet lost every message and could not even be handed a task.
    // Only a *known* profile qualifies, so this is not an open queue-injection
    // point. Delivery still goes through the mailbox and is drained on return.
    const known = this.lastSeen.has(to) || this.parkedAt.has(to)
    if (to !== BROADCAST && group === undefined && !known) {
      throw new Error(`unknown recipient: ${to} (registered peers: ${this.peers().join(', ') || 'none'})`)
    }
    // Chain depth along a `ref` parent. Two different chains ride on `ref` and
    // they need different ceilings:
    //  - a **task replying to a task** is a re-delegation (A→B→C…): kept tight
    //    at MAX_HOP so agents can't hand work around in a loop;
    //  - every other reply (chat / ack, or a task answering a non-task) is a
    //    conversation: allowed up to MAX_REPLY_CHAIN.
    // The depth SATURATES at the ceiling; the message and its `ref` are always
    // delivered. Two earlier designs were wrong: refusing the send broke a
    // legitimate sixth turn of a chat, and dropping the `ref` broke correlation —
    // a `bridge_wait({ ref })` matches on `message.ref`, so a saturated chain
    // silently stopped resolving the very reply it was waiting for (an ack for a
    // deep task chain became unattributable). Dropping the ref bounded nothing
    // either: the next message started a fresh chain.
    // The parent is read from history, so a chain that straddles a restart
    // depends on `hop` being persisted (see importHistory).
    let hop = 0
    if (ref !== undefined) {
      const parent = this.historyRing.findLast(m => m.id === ref)
      const ceiling = kind === 'task' && parent?.kind === 'task' ? MAX_HOP : MAX_REPLY_CHAIN
      hop = Math.min((parent?.hop ?? 0) + 1, ceiling)
    }
    const message: BridgeMessage = {
      id: randomUUID(),
      seq: ++this.seqCounter,
      from,
      to,
      kind,
      content,
      ...(ref !== undefined ? { ref } : {}),
      ...(threadId !== undefined ? { threadId } : {}),
      ...(group !== undefined ? { channel: group.id } : {}),
      ...(hop > 0 ? { hop } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      // Only a real priority is stored: an unset one must not appear on the wire,
      // or every reader has to distinguish 0 from "absent" for no reason.
      ...(priority !== undefined ? { priority } : {}),
      ts: Date.now(),
    }
    // A system sender is not a live peer: recording its "last seen" would put
    // the hub (or a peer id the runner acted for but which is offline) into the
    // roster as if it had just connected.
    if (!system) this.lastSeen.set(from, message.ts)
    // Traffic counters are per COMPOSED message (not per recipient): a broadcast
    // is one send, and `received` is counted per recipient inside deliver().
    this.bumpTraffic(from, 'sent')
    if (kind === 'ack') this.bumpTraffic(from, 'acked')
    // Record ONCE per message at send time (not once per recipient): broadcast
    // and group fan-out used to call remember() inside every deliver(), which
    // duplicated history rows and multi-fired onMessage/pushRelay. Recording
    // here also means manager SSE sees traffic when it is SENT — not when a
    // recipient's waiter finally drains it (the desktop "only after the other
    // agent picks it up" lag).
    this.remember(message)
    return message
  }

  /** Fan a composed message out to its recipients: broadcast, group members,
   *  or the single addressed peer. */
  private dispatch(message: BridgeMessage): void {
    if (message.to === BROADCAST) {
      for (const peer of this.audience()) {
        if (peer !== message.from) this.deliver(peer, message)
      }
      return
    }
    const group = this.groups.get(message.to)
    if (group !== undefined) {
      for (const member of group.members) {
        if (member !== message.from) this.deliver(member, message)
      }
      return
    }
    this.deliver(message.to, message)
  }

  /** Queue or hand off a message; wake the first matching waiter for its target.
   *  History / onMessage are recorded by the caller (route / sendToGroup) —
   *  exactly once per message, never per fan-out target. */
  private deliver(target: string, message: BridgeMessage): void {
    this.bumpTraffic(target, 'received')
    // A message that expired on its way here is dropped rather than delivered —
    // a stale instruction is worse than none — and counted per recipient, so a
    // broadcast that expired tells every recipient's operator.
    if (message.expiresAt !== undefined && message.expiresAt <= Date.now()) {
      this.countDrop(target, 'expired', Date.now())
      return
    }
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
      // A waiter that asked for manual acks gets a LEASE, not the message: the
      // hub must be able to hand it back if it is never committed.
      const delivered = this.handOut(target, message, waiter.manual === true, message.ts)
      waiter.resolve(waiter.batch === true ? { type: 'messages', messages: [delivered] } : { type: 'message', message: delivered })
      return
    }
    // Queue path ONLY — the bucket is checked here, after the waiter lookup, so a
    // peer that is actively waiting is always served. See {@link takeToken}.
    if (!this.takeToken(target, Date.now())) {
      this.countDrop(target, 'rate', Date.now())
      return
    }
    const queue = this.queues.get(target) ?? []
    if (queue.length >= this.options.maxQueue) {
      // Drop the LEAST IMPORTANT queued message, not simply the oldest. With
      // priorities in play, dropping by age can throw away a priority-2 instruction
      // while keeping priority-0 chatter. Among EQUAL priorities the oldest goes
      // first — which is exactly the old "oldest dropped" behaviour whenever nobody
      // sets a priority, i.e. the default.
      const lowest = priorityOf(queue[queue.length - 1]!)
      let victim = queue.length - 1
      while (victim > 0 && priorityOf(queue[victim - 1]!) === lowest) victim--
      queue.splice(victim, 1)
      // Overflow used to be silent: the message simply vanished. Count it and, if
      // the recipient is actually waiting, say so.
      this.countDrop(target, 'overflow', Date.now())
    }
    // Insert by (priority desc, seq asc). The mailbox is therefore ALWAYS in
    // delivery order, so `poll` (drains all) and `wait` (takes the first match)
    // both honour priority without either having to know about it — and equal
    // priorities keep plain FIFO, because `seq` is monotonic. Same helper the
    // lease-return / revive paths use, so a message coming BACK is ordered like
    // one arriving fresh.
    insertByPriority(queue, [message])
    this.queues.set(target, queue)
    this.options.onQueued?.(message, target)
    // It reached a MAILBOX, which means there was no waiter to hand it to. For a
    // task that is the "nobody is listening" case a runner exists for.
    if (message.kind === 'task') this.options.onTaskQueued?.(message, target)
  }

  /** Append a sent message to the history ring (and fire the persistence /
   * relay hooks). Exactly one call per message — see route() / sendToGroup(). */
  private remember(message: BridgeMessage): void {
    this.historyRing.push(message)
    if (this.historyRing.length > this.options.historyLimit) this.historyRing.splice(0, this.historyRing.length - this.options.historyLimit)
    this.options.onMessage?.(message)
  }
}

/** Chain depth of a persisted message, or `undefined` for "chain origin".
 * Rows written before `hop` was persisted (and garbage values) restore as 0:
 * such a message can only be the parent of a fresh hop-1 reply, which costs
 * the remaining budget of that one chain instead of breaking the restore. */
function importHop(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** Insert every message into a priority-sorted mailbox, keeping `(priority desc,
 *  seq asc)` order. Used by `deliver` AND by the lease-return / revive paths: a
 *  message that comes BACK to a mailbox is subject to exactly the same ordering
 *  as one arriving fresh, or a returned priority-0 lease would jump ahead of the
 *  priority-2 mail that arrived while it was leased out.
 *
 *  Preserves the relative order of the batch (their own seq order), and keeps
 *  FIFO among equals — so an all-default mailbox is still plain FIFO. */
function insertByPriority(queue: BridgeMessage[], messages: readonly BridgeMessage[]): void {
  for (const message of messages) {
    let at = queue.length
    while (at > 0 && priorityOf(queue[at - 1]!) < priorityOf(message)) at--
    queue.splice(at, 0, message)
  }
}

/** Delivery importance; absent or out-of-range reads as 0 (plain FIFO). */
function priorityOf(message: BridgeMessage): number {
  const value = message.priority
  return value === 1 || value === 2 ? value : 0
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
