import { create } from 'zustand'
import { tauri, type HubStatus, type HubState } from '@/lib/tauri'
import { serializeError } from '@/lib/serializeError'
import { missingTools } from '@/lib/hubTools'

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
  /** Hub tools this app calls that the hub does NOT advertise. Empty is the
   *  healthy state; non-empty means the two sides have drifted. */
  toolDrift: string[]
  checkTools: () => Promise<void>
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
  },

  toolDrift: [],
  // Compare the hub's advertised tool list against what this app actually calls.
  // The app mirrors the hub's names by hand (it cannot import the main repo) and
  // that hand-keeping has already drifted twice, so the check is worth the call.
  // A failure here is never fatal: the hub may be starting, and the app still works
  // until it touches the missing tool.
  checkTools: async () => {
    try {
      const advertised = await tauri.invoke.hubToolsList()
      const missing = missingTools(Array.isArray(advertised) ? advertised : [])
      if (missing.length > 0) {
        console.warn(
          `[agent-comm-hub] the hub does not advertise ${missing.length} tool(s) this app calls: ${missing.join(', ')} — `
            + 'those features will fail with "unknown tool" until the app and the hub are the same version.'
        )
      }
      useHubStore.setState({ toolDrift: missing })
    } catch {
      // Not connected yet, or an old hub without the tools/list round-trip.
    }
  }
}))

// Re-check whenever the hub reports itself running: a restart can swap in a
// different hub version, which is exactly when drift appears.
void tauri.event.onHubState((status) => {
  useHubStore.setState({ status })
  if (status.state === 'running') void useHubStore.getState().checkTools()
})

export type { HubState, HubStatus }
