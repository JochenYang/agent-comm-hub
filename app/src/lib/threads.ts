/**
 * Thread / channel / hop views over the message list (W36).
 *
 * Pure and React-free on purpose, the same way `displayWindow.ts` is: the parts of
 * a UI feature that can be ASSERTED are the parts that are not a component. The
 * hub has carried `threadId`, `channel` and `hop` since 0.9 and the desktop never
 * showed any of them — a cross-agent workflow was invisible in the GUI even though
 * the data was on the wire the whole time.
 *
 * `hop` is a reply-chain depth the hub counts but never enforces: past
 * `MAX_REPLY_CHAIN` it simply stops counting. So a view over it must present it as
 * "how deep this got", never as "a limit that was hit".
 */
import type { PresentedMessage } from './tauri'

export interface ThreadFilter {
  /** Only messages in this thread. */
  threadId?: string
  /** Only messages on this channel. */
  channel?: string
  /** Minimum hop depth. A message with no `hop` counts as 0, not as "excluded":
   *  a first message in a chain has no depth yet, and hiding it would make a
   *  depth filter look like it was dropping the start of every conversation. */
  minHop?: number
}

export interface ThreadSummary {
  threadId: string
  messageCount: number
  /** Distinct senders, in first-seen order, so the label is stable between renders. */
  participants: string[]
  firstTs: number
  lastTs: number
  maxHop: number
  channels: string[]
}

/** Depth of a message in its reply chain; a missing `hop` is depth 0. */
export function hopDepth(message: PresentedMessage): number {
  const hop = (message as { hop?: unknown }).hop
  return typeof hop === 'number' && Number.isFinite(hop) && hop > 0 ? hop : 0
}

/** Does this message pass every set field of `filter`? Unset fields pass everything. */
export function matchesFilter(message: PresentedMessage, filter: ThreadFilter): boolean {
  if (filter.threadId !== undefined && message.threadId !== filter.threadId) return false
  if (filter.channel !== undefined && message.channel !== filter.channel) return false
  if (filter.minHop !== undefined && hopDepth(message) < filter.minHop) return false
  return true
}

export function filterMessages(messages: readonly PresentedMessage[], filter: ThreadFilter): PresentedMessage[] {
  return messages.filter((message) => matchesFilter(message, filter))
}

/**
 * Messages that belong to no thread. Kept separate rather than merged under a
 * synthetic id: "no thread" is a real state (a one-off chat), and giving it a fake
 * id would make it indistinguishable from a thread genuinely named that.
 */
export function unthreaded(messages: readonly PresentedMessage[]): PresentedMessage[] {
  return messages.filter((message) => message.threadId === undefined || message.threadId === '')
}

/** One summary per `threadId`, newest activity first. */
export function threadSummaries(messages: readonly PresentedMessage[]): ThreadSummary[] {
  const byThread = new Map<string, PresentedMessage[]>()
  for (const message of messages) {
    if (message.threadId === undefined || message.threadId === '') continue
    const list = byThread.get(message.threadId)
    if (list === undefined) byThread.set(message.threadId, [message])
    else list.push(message)
  }

  const summaries: ThreadSummary[] = []
  for (const [threadId, list] of byThread) {
    const participants: string[] = []
    const channels: string[] = []
    let firstTs = Number.POSITIVE_INFINITY
    let lastTs = Number.NEGATIVE_INFINITY
    let maxHop = 0
    for (const message of list) {
      if (!participants.includes(message.from)) participants.push(message.from)
      if (message.channel !== undefined && !channels.includes(message.channel)) channels.push(message.channel)
      if (message.ts < firstTs) firstTs = message.ts
      if (message.ts > lastTs) lastTs = message.ts
      const depth = hopDepth(message)
      if (depth > maxHop) maxHop = depth
    }
    summaries.push({ threadId, messageCount: list.length, participants, firstTs, lastTs, maxHop, channels })
  }
  return summaries.sort((a, b) => b.lastTs - a.lastTs || a.threadId.localeCompare(b.threadId))
}

/**
 * Every value a filter control can offer, derived from the data rather than
 * hard-coded, so the list never offers a thread or channel that cannot occur.
 */
export function filterOptions(messages: readonly PresentedMessage[]): { threadIds: string[]; channels: string[] } {
  const threadIds = new Set<string>()
  const channels = new Set<string>()
  for (const message of messages) {
    if (message.threadId !== undefined && message.threadId !== '') threadIds.add(message.threadId)
    if (message.channel !== undefined && message.channel !== '') channels.add(message.channel)
  }
  return { threadIds: [...threadIds].sort(), channels: [...channels].sort() }
}
