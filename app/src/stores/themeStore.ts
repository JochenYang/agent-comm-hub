import { create } from 'zustand'

/**
 * Theme store — three modes: dark / light / system (follows system prefers-color-scheme).
 * The effective theme is resolved in JS (system → matchMedia), written to <html data-theme>,
 * CSS only carries dark/light variable sets to avoid the complexity of combining media queries with data-theme.
 */

export type ThemeMode = 'dark' | 'light' | 'system'
export type ResolvedTheme = 'dark' | 'light'

const STORAGE_KEY = 'ach-app-theme'
const MEDIA = '(prefers-color-scheme: light)'

function detectInitial(): ThemeMode {
  if (typeof window === 'undefined') return 'dark'
  const stored = window.localStorage.getItem(STORAGE_KEY)
  if (stored === 'dark' || stored === 'light' || stored === 'system') return stored
  return 'dark'
}

function resolve(mode: ThemeMode): ResolvedTheme {
  if (mode !== 'system') return mode
  return window.matchMedia(MEDIA).matches ? 'light' : 'dark'
}

interface ThemeState {
  mode: ThemeMode
  resolved: ResolvedTheme
  setMode: (next: ThemeMode) => void
  /** Cycle toggle: dark → light → system → dark (used by the top-bar button). */
  cycle: () => void
}

const initialMode = detectInitial()

export const useThemeStore = create<ThemeState>()((set, get) => ({
  mode: initialMode,
  resolved: resolve(initialMode),

  setMode: (next) => {
    window.localStorage.setItem(STORAGE_KEY, next)
    const resolved = resolve(next)
    set({ mode: next, resolved })
    document.documentElement.dataset.theme = resolved
  },

  cycle: () => {
    const order: ThemeMode[] = ['dark', 'light', 'system']
    const next = order[(order.indexOf(get().mode) + 1) % order.length]
    get().setMode(next)
  }
}))

// Init: write the resolved theme to <html> (takes effect before App renders, avoiding white/flash)
if (typeof document !== 'undefined') {
  document.documentElement.dataset.theme = resolve(initialMode)
}

// In system mode, listen for system theme changes (e.g. switching day/night) and follow automatically
if (typeof window !== 'undefined') {
  window.matchMedia(MEDIA).addEventListener('change', (e) => {
    const s = useThemeStore.getState()
    if (s.mode === 'system') {
      const resolved = e.matches ? 'light' : 'dark'
      setThemeDom(resolved)
      useThemeStore.setState({ resolved })
    }
  })
}

/** Only writes the DOM (does not touch store state) — used by the matchMedia callback. */
function setThemeDom(t: ResolvedTheme): void {
  document.documentElement.dataset.theme = t
}
