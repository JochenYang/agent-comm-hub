import { create } from 'zustand'

/**
 * Lightweight stacked toast hint (bottom-right, auto-dismiss) — built minimally per
 * SPEC when the app has no existing notification system; only depends on zustand, no new packages.
 * Callers (peersStore online/offline transitions / PeersView admin actions) only call pushToast;
 * display and dismissal are handled by ToastViewport (components/ui/toast.tsx).
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
    // Auto-dismiss: only remove if the toast still exists when the timer fires (a manually closed one is not re-set).
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

/** Imperative entry point: lets non-component modules (stores / background tasks) push toasts too. */
export function pushToast(kind: ToastKind, message: string): void {
  useToastStore.getState().pushToast(kind, message)
}
