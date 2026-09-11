import { useMemo } from 'react'
import { create } from 'zustand'
import {
  tauri,
  type PresentedMessage,
  type AckContent,
  type TaskContent,
  type ChatReceipt,
  type LocalMessageRecord
} from '@/lib/tauri'
import { serializeError } from '@/lib/serializeError'
import { SELF_PEER_ID } from '@/lib/self'

/**
 * Message store — zustand global singleton (SPEC §5.2 design; the earlier hand-written hook gave each component its own
 * useState instance, so selectedId / activePeer were never shared across components: after MessagesView selected a message,
 * App/DetailView couldn't read it → the right column wouldn't render; clicking a peer to switch conversations also did nothing).
 * Polling / the bridge_wait loop / the SSE listener all start once at module level, and all components share the same state.
 */

interface MessagesState {
  /** Full recent-message pool: every source (bridge_wait loop, SSE push,
   * 3s poll, local archives) appends here with NO view filtering — views
   * filter at render time via useVisibleMessages. Deduped by id, capped at
   * POOL_CAP. (Filtering at push time was the "switch conversations and the
   * message + unread badge are gone" bug.) */
  messages: PresentedMessage[]
  loading: boolean
  error: string | null
  selectedId: string | null
  selectMessage: (id: string | null) => void
  /** The peer conversation currently viewed (PRD US-2); null = own message stream. */
  activePeer: string | null
  setActivePeer: (peerId: string | null) => void
  /** Relay-flow view (admin): when true, no filtering — shows every message on the hub
   * (zhangsan↔lisi, group broadcasts, etc.), fed by the hub's relay push + a 3s full poll. */
  relayAll: boolean
  setRelayAll: (on: boolean) => void
  refresh: () => Promise<void>
  sendChat: (to: string, message: string) => Promise<boolean>
  sendTask: (
    to: string,
    prompt: string,
    context?: string,
    deliverable?: string
  ) => Promise<boolean>
  sendAck: (
    refId: string,
    status: AckContent['status'],
    note?: string
  ) => Promise<boolean>
  markPeerRead: (peerId: string, ts: number) => void
  unreadCountFor: (peerId: string) => number
  /** Unread count for every peer (peerId → count). */
  unreadMap: Readonly<Record<string, number>>
  /** The ts at which the user last "saw" a peer's messages (peerId → ts). */
  lastReadTs: Record<string, number>
  /** Internal bridge: the module-level wait loop / SSE listener appends messages through this (dedup + pool cap). */
  pushMessageSafe: (msg: PresentedMessage) => void
  /** Pulls local archive history from SQLite and merges it in (startup restore / shared by the `/history` command). */
  restoreLocal: (limit?: number, peer?: string) => Promise<void>
}

const POLL_INTERVAL_MS = 3_000
const HISTORY_LIMIT = 100

/** Pool size cap. Matches the hub's history-ring default so the 3s poll can
 * always re-supply anything evicted. */
const POOL_CAP = 1000

/** Bound the pool, keeping the most recent messages by ts. Merge paths
 * append older history at the END of the array, so eviction must sort by ts
 * first — plain slicing would drop recent live messages instead. */
function capPool(messages: PresentedMessage[]): PresentedMessage[] {
  if (messages.length <= POOL_CAP) return messages
  return [...messages].sort((a, b) => a.ts - b.ts).slice(messages.length - POOL_CAP)
}

/** Whether a message belongs to the current view — applied at RENDER time via
 * useVisibleMessages; the pool itself is never filtered. relayAll = relay-flow view, no
 * message is filtered; otherwise the default filters: no conversation = only messages
 * involving self + broadcasts (mirroring the hub's history filtering semantics); a
 * conversation = that peer's send/receive + broadcasts. */
function belongsToView(relayAll: boolean, activePeer: string | null, msg: { from: string; to: string }): boolean {
  if (relayAll) return true
  if (activePeer === null) {
    return msg.from === SELF_PEER_ID || msg.to === SELF_PEER_ID || msg.to === 'all'
  }
  return msg.from === activePeer || msg.to === activePeer || msg.to === 'all'
}

export const useMessagesStore = create<MessagesState>()((set, get) => {
  /** Append a message (dedup by id, no view filter — see the messages field doc). */
  const pushMessage = (msg: PresentedMessage): void => {
    set((s) => {
      if (s.messages.some((m) => m.id === msg.id)) return s
      return { messages: capPool([...s.messages, msg]) }
    })
  }


  /** Optimistic append: render a freshly sent message right away from the receipt
   *  (the SSE relay / next poll would deliver it a beat later; merges dedup by id). */
  const appendLocal = (receipt: ChatReceipt | null | undefined, content: unknown): void => {
    if (receipt === null || receipt === undefined || receipt.ok !== true || receipt.id === '') return
    pushMessage({
      id: receipt.id,
      from: receipt.from,
      to: receipt.to,
      kind: receipt.kind as PresentedMessage['kind'],
      content: content as PresentedMessage['content'],
      ts: receipt.ts
    })
  }

  return {
    messages: [],
    loading: false,
    error: null,
    selectedId: null,
    selectMessage: (id) => set({ selectedId: id }),
    activePeer: null,
    setActivePeer: (peerId) => {
      // Clearing selection when switching conversations: the previously selected message is likely not in the new conversation's
      // list (user feedback: the right column felt "stuck").
      set({ activePeer: peerId, selectedId: null })
    },
    relayAll: false,
    setRelayAll: (on) => set({ relayAll: on }),
    lastReadTs: {},
    pushMessageSafe: (msg) => pushMessage(msg),

    restoreLocal: async (limit, peer) => {
      try {
        const res = await tauri.invoke.historyLocal(peer, limit ?? HISTORY_LIMIT)
        const records = Array.isArray(res?.messages) ? res.messages : []
        if (records.length === 0) return
        const restored = records.map(recordToMessage)
        set((s) => {
          const notInPool = restored.filter((r) => !s.messages.some((m) => m.id === r.id))
          return { messages: capPool([...s.messages, ...notInPool]) }
        })
      } catch {
        // Hub not running / no history: keep the current state
      }
    },

    refresh: async () => {
      set({ loading: true, error: null })
      try {
        // Pull peer="all" (the unfiltered ring tail) rather than only the current conversation: a single poll serves
        // two purposes at once — the pool every view filters from + SQLite archiving (the Rust side writes
        // its own stream was pulled, so other agents' inter-chats never made it into SQLite. Ring cap is 1000, pulling
        // 200 per call, which covers the delta between polls at a normal conversation density.
        const result = await tauri.invoke.bridgeHistory('all', 200)
        const base = Array.isArray(result?.messages) ? result.messages : []
        // Merge rather than replace: optimistically appended local messages aren't in history, so a full replace would wipe out what was just sent.
        set((s) => {
          const notInPool = base.filter((b) => !s.messages.some((m) => m.id === b.id))
          return { messages: capPool([...s.messages, ...notInPool]) }
        })
      } catch (e) {
        set({ error: serializeError(e) })
      } finally {
        set({ loading: false })
      }
    },

    sendChat: async (to, message) => {
      try {
        const receipt = await tauri.invoke.bridgeChat(to, message)
        appendLocal(receipt, message)
        void get().refresh()
        return true
      } catch (e) {
        set({ error: serializeError(e) })
        return false
      }
    },

    sendTask: async (to, prompt, context, deliverable) => {
      try {
        const receipt = await tauri.invoke.bridgeTask(to, prompt, context, deliverable)
        const content: TaskContent = {
          prompt,
          ...(context !== undefined && context !== '' ? { context } : {}),
          ...(deliverable !== undefined && deliverable !== '' ? { deliverable } : {})
        }
        appendLocal(receipt, content)
        void get().refresh()
        return true
      } catch (e) {
        set({ error: serializeError(e) })
        return false
      }
    },

    sendAck: async (refId, status, note) => {
      try {
        const receipt = await tauri.invoke.bridgeAck(refId, status, note)
        const content: AckContent = {
          status,
          ...(note !== undefined && note !== '' ? { note } : {})
        }
        appendLocal(receipt, content)
        void get().refresh()
        return true
      } catch (e) {
        set({ error: serializeError(e) })
        return false
      }
    },

    markPeerRead: (peerId, ts) => {
      set((s) => {
        if ((s.lastReadTs[peerId] ?? 0) >= ts) return s
        return { lastReadTs: { ...s.lastReadTs, [peerId]: ts } }
      })
    },

    unreadCountFor: (peerId) => {
      const { messages, lastReadTs } = get()
      let n = 0
      for (const m of messages) {
        if (m.from !== peerId) continue
        if (m.to !== SELF_PEER_ID && m.to !== 'all' && m.channel === undefined) continue
        if (m.ts > (lastReadTs[peerId] ?? 0)) n++
      }
      return n
    },

    unreadMap: {}
  }
})

// ---- Derived unreadMap: recomputed when messages/unread changes ----
useMessagesStore.subscribe((s) => {
  // Count only messages ADDRESSED to me (direct / broadcast / a group channel I'm in):
  // the pool holds all relay traffic now, so counting by sender alone would badge me
  // for other people's conversations — and the relay view no longer needs a skip case.
  const out: Record<string, number> = {}
  for (const m of s.messages) {
    const peer = m.from
    if (peer === SELF_PEER_ID) continue
    if (m.to !== SELF_PEER_ID && m.to !== 'all' && m.channel === undefined) continue
    if (m.ts > (s.lastReadTs[peer] ?? 0)) out[peer] = (out[peer] ?? 0) + 1
  }
  // Only set when the value changes, to avoid an infinite loop (unreadMap isn't persisted in state, just a derived snapshot)
  const prev = useMessagesStore.getState().unreadMap
  const changed = Object.keys(out).length !== Object.keys(prev).length ||
    Object.entries(out).some(([k, v]) => prev[k] !== v)
  if (changed) useMessagesStore.setState({ unreadMap: out })
})

// ---- Module-level background tasks (started once, shared across the whole app) ----

/** SQLite record → PresentedMessage: content is the full message JSON (written via v.to_string()),
 *  from which the real content / id / from / to / kind / ref / ts are parsed. */
function recordToMessage(r: LocalMessageRecord): PresentedMessage {
  let content: unknown = r.content
  let id = r.id
  let from = r.from
  let to = r.to
  let kind = r.kind
  let ref: string | undefined = r.ref ?? undefined
  let ts = r.ts
  try {
    const full: Record<string, unknown> = JSON.parse(r.content)
    if (typeof full === 'object' && full !== null) {
      if (full.content !== undefined) content = full.content
      if (typeof full.id === 'string') id = full.id
      if (typeof full.from === 'string') from = full.from
      if (typeof full.to === 'string') to = full.to
      if (typeof full.kind === 'string') kind = full.kind
      if (typeof full.ref === 'string') ref = full.ref
      if (typeof full.ts === 'number') ts = full.ts
    }
  } catch {
    // Non-JSON content: keep it as-is
  }
  return {
    id,
    from,
    to,
    kind: kind as PresentedMessage['kind'],
    content: content as PresentedMessage['content'],
    ...(ref !== undefined ? { ref } : {}),
    ts
  }
}

// Startup restore: per the product decision (jochen), SQLite archives are not auto-loaded at startup — the message stream
// starts from the hub's current real-time/in-memory messages (clean); to see history, pull it manually with `/history [N]`
// (restoreLocal stays in the store, called by the /history command). The database still keeps being written continuously.


// Poll history every 3s (fallback; the wait loop is the primary channel)
void useMessagesStore.getState().refresh()
window.setInterval(() => {
  void useMessagesStore.getState().refresh()
}, POLL_INTERVAL_MS)

// Continuous bridge_wait long-polling: drains THIS peer's mailbox in real time (direct
// messages + group mail land here even without SSE) and keeps the peer "connected" in the
// hub's activity window. 25s budget; renew on hit or timeout.
void (async function waitLoop(): Promise<void> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const res = await tauri.invoke.bridgeWait(25_000, undefined)
      if (res?.type === 'message' && res.message?.id !== undefined) {
        useMessagesStore.getState().pushMessageSafe(res.message)
      }
    } catch {
      // Hub disconnected / lazy reconnect window: rest 2s before retrying (require_mcp rebuilds the connection)
      await new Promise((r) => setTimeout(r, 2_000))
    }
  }
})()

// SSE push listener — the PRIMARY real-time channel: hub >= 0.6 relays every routed message
// to manager sessions (this GUI is one) as it is sent; hub >= 0.7.2 adds heartbeats and the
// Rust side keeps the stream alive via a reconnect watchdog. The 3s poll is the fallback.
void tauri.event.onHubMessage((msg) => {
  useMessagesStore.getState().pushMessageSafe(msg)
})

/** View filter applied at RENDER time: relayAll shows everything; no conversation selected
 * shows messages involving self + broadcasts; a conversation shows that peer's traffic +
 * broadcasts. The pool itself keeps everything (push paths never drop by view). */
export function useVisibleMessages(): PresentedMessage[] {
  const messages = useMessagesStore((s) => s.messages)
  const activePeer = useMessagesStore((s) => s.activePeer)
  const relayAll = useMessagesStore((s) => s.relayAll)
  return useMemo(
    () => messages.filter((m) => belongsToView(relayAll, activePeer, m)),
    [messages, activePeer, relayAll]
  )
}
