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

/**
 * 消息 store —— zustand 全局单例（SPEC §5.2 设计；此前的手写 hook 每个组件
 * 独立 useState 实例，selectedId / activePeer 跨组件完全不共享：MessagesView
 * 选中消息后 App/DetailView 读不到 → 右栏不渲染；点 peer 切会话也不生效）。
 * 轮询 / bridge_wait 循环 / SSE 监听都在模块级启动一次，所有组件共享同一份状态。
 */

interface MessagesState {
  messages: PresentedMessage[]
  loading: boolean
  error: string | null
  selectedId: string | null
  selectMessage: (id: string | null) => void
  /** 当前查看的 peer 会话（PRD US-2）；null = 自己的消息流。 */
  activePeer: string | null
  setActivePeer: (peerId: string | null) => void
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
  /** 所有 peer 的未读计数（peerId → count）。 */
  unreadMap: Readonly<Record<string, number>>
  /** 用户最后一次"看到" peer 消息的 ts（peerId → ts）。 */
  lastReadTs: Record<string, number>
  /** 内部桥接：模块级 wait 循环 / SSE 监听追加消息用（去重 + 会话过滤）。 */
  pushMessageSafe: (msg: PresentedMessage) => void
  /** 从 SQLite 拉取本地存档历史并合并（启动恢复 / `/history` 命令共用）。 */
  restoreLocal: (limit?: number) => Promise<void>
}

const POLL_INTERVAL_MS = 3_000
const HISTORY_LIMIT = 100

/** 是否属于当前视图：无会话过滤（自己的流）或涉及 activePeer。 */
function belongsToView(activePeer: string | null, msg: { from: string; to: string }): boolean {
  return activePeer === null || msg.from === activePeer || msg.to === activePeer
}

export const useMessagesStore = create<MessagesState>()((set, get) => {
  /** 追加一条消息（去重 + 会话过滤）。 */
  const pushMessage = (msg: PresentedMessage): void => {
    set((s) => {
      if (s.messages.some((m) => m.id === msg.id)) return s
      if (!belongsToView(s.activePeer, msg)) return s
      return { messages: [...s.messages, msg] }
    })
  }

  /** 乐观追加：hub 的 history ring 只在 waiter 命中时记录，刚发的消息不进 history，
   *  用 receipt 立即本地追加（后续 refresh 合并去重）。 */
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
      // 切会话同步清选中：旧选中消息大概率不在新会话列表里（用户反馈右栏"卡住"）。
      set({ activePeer: peerId, selectedId: null })
    },
    lastReadTs: {},
    pushMessageSafe: (msg) => pushMessage(msg),

    restoreLocal: async (limit) => {
      try {
        const res = await tauri.invoke.historyLocal(undefined, limit ?? HISTORY_LIMIT)
        const records = Array.isArray(res?.messages) ? res.messages : []
        if (records.length === 0) return
        const restored = records.map(recordToMessage)
        set((s) => {
          const merged = [
            ...restored,
            ...s.messages.filter((m) => !restored.some((r) => r.id === m.id))
          ]
          return { messages: merged }
        })
      } catch {
        // hub 未起 / 无历史：保持现状
      }
    },

    refresh: async () => {
      const activePeer = get().activePeer
      set({ loading: true, error: null })
      try {
        // activePeer 非空拉该 peer 的完整会话（hub history：from/to 任一命中或
        // to=broadcast）；否则拉自己的消息流。
        const result = await tauri.invoke.bridgeHistory(activePeer ?? undefined, HISTORY_LIMIT)
        const base = Array.isArray(result?.messages) ? result.messages : []
        // 合并而非替换：乐观追加的本地消息不在 history 里，全量替换会冲掉刚发的。
        set((s) => {
          const extra = s.messages.filter(
            (m) =>
              !base.some((b) => b.id === m.id) &&
              belongsToView(s.activePeer, m)
          )
          return { messages: [...extra, ...base] }
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
        if (m.from === peerId && m.ts > (lastReadTs[peerId] ?? 0)) n++
      }
      return n
    },

    unreadMap: {}
  }
})

// ---- 派生 unreadMap：消息/已读变化时重算 ----
useMessagesStore.subscribe((s) => {
  const out: Record<string, number> = {}
  for (const m of s.messages) {
    const peer = m.from
    if (peer === 'agent-hub-cli') continue
    if (m.ts > (s.lastReadTs[peer] ?? 0)) out[peer] = (out[peer] ?? 0) + 1
  }
  // 值变化才 set，避免无限循环（unreadMap 不在 state 里持久化，仅派生快照）
  const prev = useMessagesStore.getState().unreadMap
  const changed = Object.keys(out).length !== Object.keys(prev).length ||
    Object.entries(out).some(([k, v]) => prev[k] !== v)
  if (changed) useMessagesStore.setState({ unreadMap: out })
})

// ---- 模块级后台任务（启动一次，全 app 共享）----

/** SQLite 记录 → PresentedMessage：content 是完整消息 JSON（写入时 v.to_string()），
 *  解析出真实 content / id / from / to / kind / ref / ts。 */
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
    // 非 JSON content：按原样保留
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

// 启动恢复：按产品决策（jochen）启动时不自动加载 SQLite 存档 —— 消息流从
// 当前 hub 的实时/内存消息开始（清爽）；想看历史用 `/history [N]` 手动拉取
// （restoreLocal 保留在 store 里，/history 命令调用）。数据库仍持续落盘。


// 3s 轮询历史（兜底；wait 循环是主通道）
void useMessagesStore.getState().refresh()
window.setInterval(() => {
  void useMessagesStore.getState().refresh()
}, POLL_INTERVAL_MS)

// 持续 bridge_wait 长轮询：hub 不推 SSE 消息且 history 只在 waiter/poll 命中时
// 记录 —— 不 wait 就收不到其他 peer 的回复。25s 预算，命中/超时即续。
void (async function waitLoop(): Promise<void> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const res = await tauri.invoke.bridgeWait(25_000, undefined)
      if (res?.type === 'message' && res.message?.id !== undefined) {
        useMessagesStore.getState().pushMessageSafe(res.message)
      }
    } catch {
      // hub 断连 / 懒重连窗口：歇 2s 再续（require_mcp 会重建连接）
      await new Promise((r) => setTimeout(r, 2_000))
    }
  }
})()

// SSE 增量推送监听（hub 未来支持 notifications/message 时生效；当前是空转）
void tauri.event.onHubMessage((msg) => {
  useMessagesStore.getState().pushMessageSafe(msg)
})
