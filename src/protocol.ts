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

/** Max A2A chain depth along a `ref` reply/redelegation chain (like MiMo
 *  session-chat's 5-hop cap). A message whose hop would exceed this is
 *  rejected at send time — stops infinite agent→agent re-delegation loops. */
export const MAX_HOP = 5

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
}

/** Structured payload of an `ack` message, JSON-encoded into `content`.
 *  `working` + `progress` are additive (hub ≥ 0.9) — the classic four values
 *  remain valid and terminal. */
export interface AckContent {
  status: AckStatus
  note?: string
  /** 0–100. Only meaningful with `status: "working"`. */
  progress?: number
}

/** Semantic ack statuses. The original four are terminal-capable; `working`
 * is a non-terminal progress beat. */
export type AckStatus = 'accepted' | 'working' | 'rejected' | 'done' | 'failed'

/** Lifecycle of a delegated task, as tracked by the hub ledger. */
export type TaskStatus = 'pending' | 'accepted' | 'working' | 'rejected' | 'done' | 'failed' | 'timeout'

/** Terminal statuses: further acks are recorded on the timeline (applied:false)
 *  but never reopen the task. */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['rejected', 'done', 'failed', 'timeout']

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
    default:
      return null
  }
}

/** Aggregate per-assignee statuses into the task's overall status. */
export function aggregateTaskStatus(assignees: ReadonlyArray<{ status: TaskStatus }>): TaskStatus {
  if (assignees.length === 0) return 'pending'
  const statuses = assignees.map(a => a.status)
  const active = statuses.filter(s => s === 'pending' || s === 'accepted' || s === 'working')
  if (active.length > 0) {
    if (active.some(s => s === 'working')) return 'working'
    if (active.some(s => s === 'accepted')) return 'accepted'
    return 'pending'
  }
  if (statuses.every(s => s === 'done')) return 'done'
  if (statuses.some(s => s === 'failed')) return 'failed'
  if (statuses.some(s => s === 'timeout')) return 'timeout'
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
export function encodeContent(payload: TaskContent | AckContent): string {
  return JSON.stringify(payload)
}

/** Decode a structured `content`; malformed payloads fall back to text. */
export function decodeContent(kind: MessageKind, content: string): TaskContent | AckContent | string {
  if (kind !== 'task' && kind !== 'ack') return content
  try {
    const parsed = JSON.parse(content) as TaskContent | AckContent
    if (parsed !== null && typeof parsed === 'object') return parsed
  } catch {
    // fall through
  }
  return content
}

/** Shape returned by wait/poll tools for one delivered message. */
export interface Delivered {
  type: 'message'
  message: BridgeMessage
}

/** Shape returned by wait tools when the timeout (or abort) fired first. */
export interface WaitTimeout {
  type: 'timeout'
  waitedMs: number
}

export type WaitResult = Delivered | WaitTimeout
