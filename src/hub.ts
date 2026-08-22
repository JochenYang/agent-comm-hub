/**
 * Multi-peer hub core: peer registry, per-peer FIFO mailboxes, long-poll
 * waiters with optional sender filters, and a shared history ring.
 * Transport-agnostic (no MCP, no HTTP) so tests drive it standalone.
 */

import { randomUUID } from 'node:crypto'
import { BROADCAST, type BridgeMessage, type MessageKind, type WaitResult } from './protocol.js'

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
  /** Called when a message lands in a queue with no matching waiter. */
  onQueued?: (message: BridgeMessage) => void
  /** Called when a peer is registered or unregistered. */
  onPeersChanged?: (peers: string[]) => void
  /** Called when the idle GC evicts a peer. */
  onPeerGc?: (peerId: string) => void
  /** Live-channel check: peers returning true are skipped by the idle GC. */
  isPeerLive?: (peerId: string) => boolean
}

/** One peer's live state. */
export interface PeerState {
  id: string
  connected: boolean
  lastSeenMs: number
  queued: number
  waiting: number
}

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

  /** Register a peer; throws if the id is already taken. */
  register(peerId: string): void {
    if (this.lastSeen.has(peerId)) throw new Error(`peer already registered: ${peerId}`)
    this.lastSeen.set(peerId, Date.now())
    this.options.onPeersChanged?.(this.peers())
  }

  /** Remove a peer and its queued messages; pending waiters resolve as timeouts. */
  unregister(peerId: string): void {
    this.queues.delete(peerId)
    for (const waiter of this.waiters.get(peerId) ?? []) {
      clearTimeout(waiter.timer)
      waiter.onAbort()
    }
    this.waiters.delete(peerId)
    this.lastSeen.delete(peerId)
    this.options.onPeersChanged?.(this.peers())
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

  /** Recent messages involving `peer` (inbound and outbound), newest first. */
  history(peerId: string, limit: number): BridgeMessage[] {
    const filtered = this.historyRing.filter(message => message.from === peerId || message.to === peerId || message.to === BROADCAST)
    return filtered.slice(-Math.max(0, limit)).reverse()
  }

  /** Most recent messages across every peer, unfiltered (newest first).
   * Backs `bridge_history { peer: "all" }` — lets an archiver (the desktop
   * app) capture peer-to-peer traffic it is not a party of. */
  historyAll(limit: number): BridgeMessage[] {
    return this.historyRing.slice(-Math.max(0, limit)).reverse()
  }

  /**
   * Live summary for the status tool. `livePeers` (sessions with a live SSE
   * stream) count as connected even without recent tool activity.
   */
  status(livePeers?: ReadonlySet<string>): HubStatus {
    const now = Date.now()
    return {
      server: 'agent-comm-hub',
      peers: this.peers().map(peer => ({
        id: peer,
        connected: this.isActive(peer) || livePeers?.has(peer) === true,
        lastSeenMs: this.lastSeen.get(peer) ?? 0,
        queued: (this.queues.get(peer) ?? []).length,
        waiting: (this.waiters.get(peer) ?? []).length,
      })),
      historyLimit: this.options.historyLimit,
      maxQueue: this.options.maxQueue,
    }
  }

  /** Non-blocking drain of everything queued for `peer` (optionally from one sender). */
  poll(peerId: string, from?: string): BridgeMessage[] {
    const queue = this.queues.get(peerId) ?? []
    const drained = from === undefined ? queue.splice(0, queue.length) : drainFrom(queue, from)
    for (const message of drained) this.remember(message)
    return drained
  }

  /**
   * Long-poll for the next message addressed to `peer`: resolves immediately
   * when a matching one is queued, otherwise waits up to `timeoutMs` (capped
   * by `waitTimeoutMs`) or until `signal` aborts. `from` narrows to one sender.
   */
  wait(peerId: string, timeoutMs: number, from?: string, signal?: AbortSignal): Promise<WaitResult> {
    const startedAt = Date.now()
    const queued = this.poll(peerId, from)[0]
    if (queued) return Promise.resolve({ type: 'message', message: queued })
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
    this.options.onQueued?.(message)
  }

  /** Append a delivered message to the history ring. */
  private remember(message: BridgeMessage): void {
    this.historyRing.push(message)
    if (this.historyRing.length > this.options.historyLimit) this.historyRing.splice(0, this.historyRing.length - this.options.historyLimit)
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
