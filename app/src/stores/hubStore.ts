import { create } from 'zustand'
import { tauri, type HubStatus, type HubState } from '@/lib/tauri'
import { serializeError } from '@/lib/serializeError'

/**
 * Hub 进程状态 store —— zustand 全局单例（事件订阅 + 命令代理）。
 * hub:state 事件监听在模块级启动一次；App / 托盘等所有组件共享同一状态。
 */

interface HubState_ {
  status: HubStatus | null
  loading: boolean
  error: string | null
  start: () => Promise<void>
  stop: () => Promise<void>
  restart: () => Promise<void>
}

export const useHubStore = create<HubState_>()((set) => ({
  status: null,
  loading: false,
  error: null,

  start: async () => {
    set({ loading: true, error: null })
    try {
      set({ status: await tauri.invoke.hubStart() })
    } catch (e) {
      // Tauri invoke 错误是 {ok:false,error} 对象；直接 String() 会得到 [object Object]。
      set({ error: serializeError(e) })
    } finally {
      set({ loading: false })
    }
  },

  stop: async () => {
    set({ loading: true, error: null })
    try {
      set({ status: await tauri.invoke.hubStop() })
    } catch (e) {
      set({ error: serializeError(e) })
    } finally {
      set({ loading: false })
    }
  },

  restart: async () => {
    set({ loading: true, error: null })
    try {
      set({ status: await tauri.invoke.hubRestart() })
    } catch (e) {
      set({ error: serializeError(e) })
    } finally {
      set({ loading: false })
    }
  }
}))

// 模块级监听 hub:state（一次；组件不再各自 subscribe）
void tauri.event.onHubState((status) => {
  useHubStore.setState({ status })
})

export type { HubState, HubStatus }
