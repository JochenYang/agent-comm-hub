import { create } from 'zustand'
import { tauri, type HubStatus, type HubState } from '@/lib/tauri'
import { serializeError } from '@/lib/serializeError'

/**
 * Hub process status store — zustand global singleton (event subscription + command proxy).
 * The hub:state event listener is started once at module level; all components (App / tray, etc.) share the same state.
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
      // Tauri invoke errors are {ok:false,error} objects; String() alone yields [object Object].
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

// Listen for hub:state at module level (once; components no longer subscribe individually)
void tauri.event.onHubState((status) => {
  useHubStore.setState({ status })
})

export type { HubState, HubStatus }
