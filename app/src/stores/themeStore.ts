import { create } from 'zustand'

/**
 * 主题 store —— 三态：dark / light / system（跟随系统 prefers-color-scheme）。
 * 实际生效主题由 JS 解析（system → matchMedia），写入 <html data-theme>，
 * CSS 只有 dark/light 两组变量，避免媒体查询与 data-theme 的叠加复杂度。
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
  /** 循环切换：dark → light → system → dark（顶栏按钮用）。 */
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

// 初始化：把解析后的主题写到 <html>（App 渲染前生效，避免闪白/闪黑）
if (typeof document !== 'undefined') {
  document.documentElement.dataset.theme = resolve(initialMode)
}

// system 模式下监听系统主题变化（如白天切黑夜），自动跟随
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

/** 只写 DOM（不碰 store 状态）——供 matchMedia 回调用。 */
function setThemeDom(t: ResolvedTheme): void {
  document.documentElement.dataset.theme = t
}
