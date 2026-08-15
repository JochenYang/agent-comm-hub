import { create } from 'zustand'
import { tauri, type Peer } from '@/lib/tauri'
import { serializeError } from '@/lib/serializeError'

/**
 * Peer 列表 store —— zustand 全局单例（与 messagesStore 同批修复：手写 hook
 * 的独立实例让 PeersView / MessagesView / CommandPalette 各持一份不共享的状态）。
 * 轮询在模块级启动一次；peers 变化时消息 store 据此联动（未读等由消息侧派生）。
 */

interface PeersState {
  peers: Peer[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

const POLL_INTERVAL_MS = 2_000

export const usePeersStore = create<PeersState>()((set) => ({
  peers: [],
  loading: false,
  error: null,

  refresh: async () => {
    set({ loading: true, error: null })
    try {
      const result = await tauri.invoke.bridgePeers()
      // 防御：Rust 侧已解包 MCP 信封，但任何未来回归都不应把 peers 置成
      // undefined 而让 PeersView 在 `peers.length` 处崩溃（历史教训）。
      set({ peers: Array.isArray(result?.peers) ? result.peers : [] })
    } catch (e) {
      set({ error: serializeError(e) })
    } finally {
      set({ loading: false })
    }
  }
}))

// 模块级轮询（启动一次，所有组件共享）
void usePeersStore.getState().refresh()
window.setInterval(() => {
  void usePeersStore.getState().refresh()
}, POLL_INTERVAL_MS)
