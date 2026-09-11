/**
 * Wire protocol of agent-comm-hub. Peers are arbitrary strings claimed via
 * `bridge_register`; every message is routed between per-peer mailboxes.
 */

/** Message kinds exchanged between peers. */
export const KINDS = ['chat', 'task', 'notice', 'ack'] as const

/** What kind of payload a message carries. */
export type MessageKind = (typeof KINDS)[number]

/** A valid peer id: letters, digits, `._:-`, 1–64 chars. */
export const PEER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/

/** Special `to` value: deliver to every registered peer except the sender. */
export const BROADCAST = 'all'

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
  /** For `ack`: the id of the message being acknowledged. */
  ref?: string
  /** Group/channel id when the message was sent to a group (see
   * bridge_group_send); absent for direct and broadcast messages. */
  channel?: string
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
}

/** Structured payload of an `ack` message, JSON-encoded into `content`. */
export interface AckContent {
  status: 'accepted' | 'rejected' | 'done' | 'failed'
  note?: string
}

/** Lifecycle of a delegated task, as tracked by the hub ledger. */
export type TaskStatus = 'pending' | 'accepted' | 'rejected' | 'done' | 'failed'

/** Terminal statuses: further acks are still recorded but do not reopen. */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['rejected', 'done', 'failed']

/** One ack event on a task (timeline entry). */
export interface TaskAckEvent {
  from: string
  status: AckContent['status']
  note?: string
  ts: number
  /** The ack message id (for bridge_history correlation). */
  messageId: string
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
  status: TaskStatus
  acks: TaskAckEvent[]
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
