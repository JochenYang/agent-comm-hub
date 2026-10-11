/**
 * Wire protocol of agent-comm-hub. Peers are arbitrary strings claimed via
 * `bridge_register`; every message is routed between per-peer mailboxes.
 *
 * Compatibility: every field / status added after 0.8 is optional or additive
 * so older agents (already-installed SKILL.md) keep working. Unknown ack
 * statuses are still recorded on the timeline; they just don't drive the
 * ledger state machine.
 */

/** Message kinds exchanged between peers. */
export const KINDS = ['chat', 'task', 'notice', 'ack'] as const

/** What kind of payload a message carries. */
export type MessageKind = (typeof KINDS)[number]

/** A valid peer id: letters, digits, `._:-`, 1–64 chars. */
export const PEER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/

/** Special `to` value: deliver to every registered peer except the sender. */
export const BROADCAST = 'all'

/** Reserved sender id for messages the hub itself originates — currently the
 * "your mailbox dropped N messages" notice (see `bridge_status` counters).
 *
 * The hub has no session, so it cannot go through the normal send path (which
 * requires a registered sender). It is reserved so no client can claim the id
 * and impersonate the hub: registering it is refused, exactly like
 * {@link BROADCAST}. */
export const HUB_PEER = 'hub'

/** The ONE JSON-RPC method the hub pushes on: every SSE notification is a
 *  `notifications/message` carrying `data.event` — there is no second method to
 *  keep in sync.
 *
 *  The EVENT names below are the wire contract with every consumer (the desktop's
 *  Rust `commands.rs` matches on them literally; a typo there used to be a silent
 *  no-match). Centralized so a rename breaks the build instead of the stream. */
export const SSE_METHOD = 'notifications/message'
export const SSE_EVENT_PEERS_CHANGED = 'peers_changed'
export const SSE_EVENT_MESSAGE = 'message'

/** Max depth of a **task re-delegation** chain (a task replying to a task), like
 *  MiMo session-chat's 5-hop cap. Delivered either way: the depth SATURATES at the
 *  ceiling and the `ref` is kept, because dropping it broke correlation —
 *  `bridge_wait({ ref })` matches on `message.ref` — without bounding anything,
 *  since the next message just started a fresh chain. */
export const MAX_HOP = 5

/** Max depth of a plain reply chain (chat / ack, or a task answering a non-task).
 *  Looser than {@link MAX_HOP} on purpose: a task hand-off loop is an accident
 *  worth stopping early, while a long multi-turn conversation is normal. Same
 *  over-the-ceiling behaviour: deliver, keep `ref`, saturate `hop`. */
export const MAX_REPLY_CHAIN = 50

/** One routed message. `content` is plain text for chat/notice and a JSON
 * string for task/ack (see {@link TaskContent} / {@link AckContent}). */
export interface BridgeMessage {
  /** Unique message id (UUID). */
  id: string
  /** Sender peer — derived from the calling connection, never caller-supplied. */
  from: string
  /** Receiver peer, or {@link BROADCAST} for everyone except the sender. */
  to: string
  kind: MessageKind
  content: string
  /** For `ack`: the id of the message being acknowledged. Optional on chat/task
   * as a reply-to / correlation id. */
  ref?: string
  /** Group/channel id when the message was sent to a group (see
   * bridge_group_send); absent for direct and broadcast messages. */
  channel?: string
  /** Conversation / workflow thread id — lets multi-turn A2A dialogs and
   * request–reply chains stay grouped. Optional. */
  threadId?: string
  /** Chain depth along a `ref` parent (0 = origin). Absent = 0. */
  hop?: number
  /** Delivery importance inside the recipient's mailbox: 2 beats 1 beats 0.
   *  Absent = 0, so a sender that never sets one gets plain FIFO. Priority orders
   *  the mailbox AND decides what overflow drops (see `deliver`), which is why an
   *  equal-priority mailbox behaves exactly as it did before priorities existed. */
  priority?: 0 | 1 | 2
  /** Monotonic hub-wide sequence number, assigned when the message is composed.
   * It never restarts: a hub that restores history continues from the highest
   * restored value, so a client's `since` cursor stays meaningful across a
   * restart. Absent on messages restored from a database written before this
   * column existed — those are only reachable without a cursor. */
  seq?: number
  /** Absolute epoch-ms deadline. A message that is still queued (or about to be
   * handed over) after this is dropped and counted as `droppedExpired` instead
   * of being delivered — a stale instruction is worse than none. Absent = never
   * expires. */
  expiresAt?: number
  /** Epoch milliseconds. */
  ts: number
}

/** Structured payload of a `task` message, JSON-encoded into `content`. */
export interface TaskContent {
  /** What the receiving agent is asked to do. */
  prompt: string
  /** Optional background information. */
  context?: string
  /** Optional expected deliverable description. */
  deliverable?: string
  /** Soft SLA in ms from send. When it expires without a terminal ack the hub
   * marks the task `timeout` (and records a timeline event). Optional. */
  timeoutMs?: number
  /** Optional conversation / workflow thread id (mirrors BridgeMessage.threadId). */
  threadId?: string
  /** Optional delivery priority (mirrors BridgeMessage.priority). It is carried by
   *  the task MESSAGE, not by the ledger: priority is a mailbox concern. */
  priority?: 0 | 1 | 2
}

/** A2A's `TaskState` vocabulary. */
export type A2ATaskState = 'submitted' | 'working' | 'input-required' | 'completed' | 'canceled' | 'failed' | 'rejected' | 'unknown'

/** Translate our ledger status into A2A's names, so a client that already speaks
 *  A2A can read `bridge_task_status` without a lookup table. Purely additive —
 *  our own status is still returned next to it.
 *
 *  `timeout` has no A2A equivalent (A2A has no timeout state); it reports
 *  `failed`, which is what it is from the sender's side. */
export function a2aState(status: TaskStatus): A2ATaskState {
  switch (status) {
    case 'pending':
    case 'accepted':
      return 'submitted'
    case 'working':
      return 'working'
    case 'input-required':
      return 'input-required'
    case 'done':
      return 'completed'
    case 'canceled':
      return 'canceled'
    case 'failed':
    case 'timeout':
      return 'failed'
    case 'rejected':
      return 'rejected'
  }
}

/** Structured payload of an `ack` message, JSON-encoded into `content`.
 *  `working` + `progress` are additive (hub ≥ 0.9) — the classic four values
 *  remain valid and terminal. */
export interface AckContent {
  status: AckStatus
  note?: string
  /** 0–100. Only meaningful with `status: "working"`. */
  progress?: number
  /** Output attached to this ack. A `done` ack with artifacts is how a runner or
   *  an agent hands back what it produced. */
  artifacts?: TaskArtifact[]
}

/** One piece of output attached to an ack. `text` is carried inline by the hub;
 *  `url` points at something the hub does not carry. At least one of the two is
 *  expected — an artifact with neither says nothing. */
export interface TaskArtifact {
  name: string
  mimeType?: string
  text?: string
  url?: string
}

/** One thing a peer can do. `id` is the machine key `bridge_discover` matches
 *  on; `tags` are free-form labels. */
export interface PeerSkill {
  id: string
  name: string
  description?: string
  tags?: string[]
}

/** What a peer says about itself (`bridge_announce`). Everything is optional:
 *  a peer that announces nothing is still reachable, it just cannot be found by
 *  `bridge_discover`.
 *
 *  `acceptsTasks` is the opt-in for being HANDED work: `bridge_discover` only
 *  offers peers that set it to `true`, because "has a skill" is not "wants a
 *  task right now". */
export interface PeerCard {
  skills?: PeerSkill[]
  acceptsTasks?: boolean
  /** How many tasks the peer is willing to run at once (informational). */
  concurrency?: number
  inputModes?: string[]
  outputModes?: string[]
  /** How this peer gets executed when it is not polling (see `src/runner.ts`). */
  runner?: 'herdr' | 'cli' | 'http' | 'none'
  /** Where to reach it (informational; the hub does not dial it). */
  endpoint?: string
}

/** Semantic ack statuses. `working` is a non-terminal progress beat;
 *  `input-required` is an INTERRUPT (the assignee needs an answer before it can
 *  continue — `bridge_task_input` answers it); `canceled` is terminal and either
 *  side may send it (`bridge_task_cancel`). */
export type AckStatus = 'accepted' | 'working' | 'input-required' | 'rejected' | 'done' | 'failed' | 'canceled'

/** Every ack status a CLIENT may send through `bridge_ack`.
 *
 * `canceled` is deliberately absent: it has its own tool (`bridge_task_cancel`),
 * which also handles the sender-side direction and updates every assignee row —
 * an ack could not. Single source of truth: the tool schema and its handler both
 * read this, so the two cannot drift apart (they did once: adding a status to
 * the schema alone left the handler rejecting it). */
export const CLIENT_ACK_STATUSES = ['accepted', 'working', 'input-required', 'rejected', 'done', 'failed'] as const

/** Severity of a {@link NoticeContent}, mirroring a log level. */
export type NoticeLevel = 'info' | 'warn' | 'error'

/** Structured payload of a `notice` message, JSON-encoded into `content`.
 * A notice is a system-flavoured line ("your mailbox dropped 3 messages",
 * "hub restarting") that should read differently from a peer's chat, so it
 * carries a level rather than being plain text like `chat`.
 *
 * `notice` was declared in {@link KINDS} from the start but had no tool able to
 * send it, so no client has ever received one — making this shape free to pick. */
export interface NoticeContent {
  message: string
  level?: NoticeLevel
}

/** Lifecycle of a delegated task, as tracked by the hub ledger. */
export type TaskStatus = 'pending' | 'accepted' | 'working' | 'input-required' | 'rejected' | 'done' | 'failed' | 'timeout' | 'canceled'

/** Terminal statuses: further acks are recorded on the timeline (applied:false)
 *  but never reopen the task. */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['rejected', 'done', 'failed', 'timeout', 'canceled']

/** Map a semantic ack onto a task status. */
export function ackToTaskStatus(ack: AckStatus): TaskStatus {
  return ack
}

/**
 * Legal task-status transitions. Returns the next status, or `null` when the
 * ack must not change the ledger state (illegal / after terminal).
 *
 *   pending  → accepted | working | rejected | done | failed | timeout
 *   accepted → working | done | failed | rejected | timeout
 *   working  → working | done | failed | rejected | timeout
 *   terminal → (none — stay put)
 */
export function nextTaskStatus(current: TaskStatus, ack: AckStatus): TaskStatus | null {
  if (TERMINAL_TASK_STATUSES.includes(current)) return null
  const next = ackToTaskStatus(ack)
  switch (current) {
    case 'pending':
      return next
    case 'accepted':
      // accepted → accepted is a no-op refresh; treat as applied but same state.
      return next
    case 'working':
      // working → accepted would rewind; only allow forward / lateral progress.
      if (next === 'accepted') return 'working'
      return next
    case 'input-required':
      // An interrupt, not an end: answering it (`bridge_task_input` sends
      // `working`) resumes the task. Cancelling from here is legal too.
      if (next === 'accepted') return 'input-required'
      return next
    default:
      return null
  }
}

/** Aggregate per-assignee statuses into the task's overall status. */
export function aggregateTaskStatus(assignees: ReadonlyArray<{ status: TaskStatus }>): TaskStatus {
  if (assignees.length === 0) return 'pending'
  const statuses = assignees.map(a => a.status)
  // An unanswered interrupt comes first, even when another assignee is still
  // working: the task needs an answer, and hiding that behind "working" is how
  // it stays stuck. This is the whole reason the state exists.
  if (statuses.some(s => s === 'input-required')) return 'input-required'
  const active = statuses.filter(s => s === 'pending' || s === 'accepted' || s === 'working')
  if (active.length > 0) {
    if (active.some(s => s === 'working')) return 'working'
    if (active.some(s => s === 'accepted')) return 'accepted'
    return 'pending'
  }
  if (statuses.every(s => s === 'done')) return 'done'
  if (statuses.some(s => s === 'failed')) return 'failed'
  if (statuses.some(s => s === 'timeout')) return 'timeout'
  if (statuses.some(s => s === 'canceled')) return 'canceled'
  return 'rejected'
}

/** One ack event on a task (timeline entry). */
export interface TaskAckEvent {
  from: string
  status: AckStatus
  note?: string
  /** 0–100, present when the ack carried a progress value. */
  progress?: number
  ts: number
  /** The ack message id (for bridge_history correlation). */
  messageId: string
  /** False when the event was recorded but did NOT change the ledger state
   *  (illegal transition, or after terminal). */
  applied: boolean
  /** Artifacts this event carried, if any. */
  artifacts?: TaskArtifact[]
  /** True for hub-synthesized events (e.g. SLA timeout). */
  system?: boolean
}

/** Per-assignee slice of a task (meaningful for broadcast / group tasks). */
export interface AssigneeState {
  peerId: string
  status: TaskStatus
  /** When this assignee first received the task (waiter handoff / queue drain). */
  deliveredMs?: number
  acks: TaskAckEvent[]
}

/** Hub-side record of a delegated `task` message and its acks. */
export interface TaskRecord {
  /** Same as the task message id (the `ref` of every ack). */
  id: string
  from: string
  to: string
  prompt: string
  context?: string
  deliverable?: string
  /** Aggregate status across assignees. */
  status: TaskStatus
  /** Full ack timeline (including unapplied / system events). */
  acks: TaskAckEvent[]
  /** Everything any ack attached, in the order it arrived. The timeline keeps
   *  the per-event grouping; this is the flat list a consumer wants. */
  artifacts?: TaskArtifact[]
  /** Per-assignee state (broadcast / group fan-out). Single-target tasks have one row. */
  assignees: AssigneeState[]
  /** Soft SLA in ms from create, when the sender supplied one. */
  timeoutMs?: number
  /** Absolute epoch ms when the SLA fires. */
  deadlineAt?: number
  threadId?: string
  createdAt: number
  updatedAt: number
}

/** Encode a structured payload for `content`. */
export function encodeContent(payload: TaskContent | AckContent | NoticeContent): string {
  return JSON.stringify(payload)
}

/** Decode a structured `content`; malformed payloads fall back to text. */
export function decodeContent(kind: MessageKind, content: string): TaskContent | AckContent | NoticeContent | string {
  if (kind !== 'task' && kind !== 'ack' && kind !== 'notice') return content
  try {
    const parsed = JSON.parse(content) as TaskContent | AckContent
    if (parsed !== null && typeof parsed === 'object') return parsed
  } catch {
    // fall through
  }
  return content
}

/** A message as handed to a peer. Under a manual-ack lease it also carries
 * `attempts` and `leaseExpiresAt` — bookkeeping about this hand-out, not part of
 * the stored message (an unleased delivery has neither). */
export type DeliveredMessage = BridgeMessage & {
  attempts?: number
  leaseExpiresAt?: number
}

/** Shape returned by wait/poll tools for one delivered message. */
export interface Delivered {
  type: 'message'
  message: DeliveredMessage
}

/** Shape returned by wait when a batch was requested (`maxMessages > 1`). The
 *  shape is decided by the REQUEST, not by how many happened to be queued, so a
 *  caller always knows which field to read. */
export interface DeliveredBatch {
  type: 'messages'
  messages: DeliveredMessage[]
}

/** Shape returned by wait tools when the timeout (or abort) fired first. */
export interface WaitTimeout {
  type: 'timeout'
  waitedMs: number
}

export type WaitResult = Delivered | DeliveredBatch | WaitTimeout
