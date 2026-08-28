import { create } from 'zustand'

/**
 * 轻量 toast 堆叠提示（右下角，自动消失）—— app 内没有现成通知系统时按
 * SPEC 的最小方案自建；只依赖 zustand，不引新包。
 * 调用方（peersStore 的上下线迁移 / PeersView 的管理动作）只管 pushToast，
 * 展示与消失由 ToastViewport（components/ui/toast.tsx）负责。
 */

export type ToastKind = 'info' | 'success' | 'error'

export interface Toast {
  id: number
  kind: ToastKind
  message: string
}

interface ToastState {
  toasts: Toast[]
  pushToast: (kind: ToastKind, message: string) => void
  dismiss: (id: number) => void
}

const AUTO_DISMISS_MS = 4_500
const MAX_TOASTS = 5

let nextId = 1

export const useToastStore = create<ToastState>()((set) => ({
  toasts: [],

  pushToast: (kind, message) => {
    const id = nextId++
    set((s) => ({ toasts: [...s.toasts, { id, kind, message }].slice(-MAX_TOASTS) }))
    // 自动消失：到点后仅在 toast 仍存在时移除（手动关掉的不重复 set）。
    window.setTimeout(() => {
      useToastStore.setState((s) =>
        s.toasts.some((t) => t.id === id)
          ? { toasts: s.toasts.filter((t) => t.id !== id) }
          : s
      )
    }, AUTO_DISMISS_MS)
  },

  dismiss: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}))

/** 命令式入口：非组件模块（store / 后台任务）也能推 toast。 */
export function pushToast(kind: ToastKind, message: string): void {
  useToastStore.getState().pushToast(kind, message)
}
