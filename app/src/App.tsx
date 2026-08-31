import { useEffect, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Moon, Monitor, Sun, Minus, Square, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { LogsView } from '@/views/LogsView'
import { PeersView } from '@/views/PeersView'
import { MessagesView } from '@/views/MessagesView'
import { DetailView } from '@/views/DetailView'
import { SettingsView } from '@/views/SettingsView'
import { TerminalView } from '@/views/TerminalView'
import { useHubStore } from '@/stores/hubStore'
import { useMessagesStore } from '@/stores/messagesStore'
import { useThemeStore } from '@/stores/themeStore'
import { tauri } from '@/lib/tauri'
import { SELF_PEER_ID } from '@/lib/self'
import { PeerActivityToasts } from '@/components/PeerActivityToasts'
import { useTranslation } from '@/i18n'

type Tab = 'main' | 'terminal' | 'settings'

const STATUS_TONE: Record<string, string> = {
  running: 'bg-success/15 text-success ring-1 ring-success/30',
  starting: 'bg-info/15 text-info ring-1 ring-info/30',
  stopping: 'bg-warning/15 text-warning ring-1 ring-warning/30',
  stopped: 'bg-muted text-muted-foreground ring-1 ring-border',
  failed: 'bg-destructive/15 text-destructive ring-1 ring-destructive/30'
}

export default function App(): React.JSX.Element {
  const hub = useHubStore()
  const { selectedId } = useMessagesStore()
  const theme = useThemeStore()
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>('main')
  // Frameless window: toggle the maximize icon (listen to window resize)
  const win = getCurrentWindow()
  const [maximized, setMaximized] = useState(false)
  // Close-confirm modal: minimize to tray / quit app / cancel
  const [showCloseModal, setShowCloseModal] = useState(false)

  useEffect(() => {
    void win.isMaximized().then(setMaximized)
    let unlisten: (() => void) | undefined
    void win.onResized(() => {
      void win.isMaximized().then(setMaximized)
    }).then((fn) => {
      unlisten = fn
    })
    return () => {
      unlisten?.()
    }
  }, [win])

  // Close-request interception: whether clicking the drawn ✕ or Alt+F4, always pop the three-choice modal (never close the window directly).
  useEffect(() => {
    let unlisten: (() => void) | undefined
    void win
      .onCloseRequested((event) => {
        event.preventDefault()
        setShowCloseModal(true)
      })
      .then((fn) => {
        unlisten = fn
      })
    return () => {
      unlisten?.()
    }
  }, [win])

  useEffect(() => {
    void tauri.invoke.appReady().catch(() => undefined)
  }, [])

  // Global shortcuts:
  //   Ctrl/Cmd+K          → command palette (main tab only)
  //   Ctrl/Cmd+,          → jump to settings tab
  //   Ctrl/Cmd+Alt+M/T/S  → jump to main / terminal / settings
  //   Esc                  → return to main tab (only when on terminal/settings)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const meta = e.metaKey || e.ctrlKey
      if (meta && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        // Dispatch a custom event for MessagesView to receive; MessagesView also listens on its own input.
        window.dispatchEvent(new CustomEvent('ach:open-palette'))
        setTab('main')
      } else if (meta && e.key === ',') {
        e.preventDefault()
        setTab('settings')
      } else if (meta && e.altKey && e.key.toLowerCase() === 'm') {
        e.preventDefault()
        setTab('main')
      } else if (meta && e.altKey && e.key.toLowerCase() === 't') {
        e.preventDefault()
        setTab('terminal')
      } else if (meta && e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        setTab('settings')
      } else if (meta && e.key.toLowerCase() === 'w') {
        // PRD §5.2: Ctrl+W closes the current tab (terminal/settings → back to main; main ignored)
        e.preventDefault()
        if (tab !== 'main') setTab('main')
      } else if (e.key === 'Escape' && tab !== 'main') {
        setTab('main')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tab])

  const state = hub.status?.state ?? 'stopped'
  const tone = STATUS_TONE[state] ?? STATUS_TONE.stopped
  // Control-button state linkage: disable "start" when Running, enable "stop/restart"; all disabled during Starting/Stopping.
  const isRunning = state === 'running'
  const isBusy = state === 'starting' || state === 'stopping' || hub.loading
  // macOS frameless-window convention is system traffic lights in the top-left: reserve that space on the left,
  // and don't render the drawn window buttons on the right (Windows/Linux use top-right — □ ×).
  const isMac = /Mac/i.test(navigator.userAgent)

  return (
    <div className="flex h-screen w-screen flex-col bg-background text-foreground">
      {/* Top bar — custom title bar (no system frame): left drag area (brand + status) → control buttons → tabs → theme/window controls */}
      {/* Frameless-window title bar: drag-region uses the "deep" value — pressing anywhere in the subtree drags the window;
          Tauri core automatically shields interactive elements like button/a/input (a bare attribute only applies to the element
          itself, letting child elements swallow mousedown so the whole title bar barely drags). Double-click on a non-interactive
          area toggles maximize. */}
      <header
        data-tauri-drag-region="deep"
        className="flex shrink-0 select-none items-stretch border-b border-border bg-background/80 backdrop-blur"
      >
        {/* Brand + status badge (draggable; handled uniformly by the header drag region) */}
        <div className={`flex items-center gap-3 py-2 ${isMac ? 'pl-[78px]' : 'pl-4'}`}>
          <img
            src="/logo.png"
            alt="agent-comm-hub"
            draggable={false}
            className="h-5 w-5 rounded-sm"
          />
          <span className="font-semibold tracking-tight">agent-comm-hub</span>

          {/* status pill */}
          <span
            className={`ml-2 inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider ${tone}`}
          >
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                state === 'running' || state === 'starting' ? 'animate-pulse' : ''
              } ${
                state === 'running'
                  ? 'bg-success'
                  : state === 'starting'
                  ? 'bg-info'
                  : state === 'stopping'
                  ? 'bg-warning'
                  : state === 'failed'
                  ? 'bg-destructive'
                  : 'bg-muted-foreground'
              }`}
            />
            {t(`status.${state}`)}
            {hub.status?.pid !== undefined && hub.status.pid !== null && (
              <span className="ml-1 opacity-70">pid {hub.status.pid}</span>
            )}
          </span>
        </div>

        {/* controls */}
        <div className="ml-2 flex items-center gap-1">
          <Button
            size="sm"
            variant="default"
            disabled={isRunning || isBusy}
            title={isRunning ? t('status.running') : t('actions.start')}
            onClick={() => void hub.start()}
          >
            {t('actions.start')}
          </Button>
          <Button
            size="sm"
            variant={isRunning ? 'destructive' : 'outline'}
            disabled={!isRunning || isBusy}
            title={t('actions.stop')}
            onClick={() => void hub.stop()}
          >
            {t('actions.stop')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!isRunning || isBusy}
            title={t('actions.restart_hub')}
            onClick={() => void hub.restart()}
          >
            {t('actions.restart_hub')}
          </Button>
        </div>

        {/* tabs */}
        <div className="ml-auto flex items-center px-2">
          <div className="flex overflow-hidden rounded-md border border-border bg-card p-0.5">
            {(['main', 'terminal', 'settings'] as const).map((tkey) => (
              <button
                key={tkey}
                type="button"
                onClick={() => setTab(tkey)}
                className={`px-3 py-1 font-mono text-[11px] uppercase tracking-wider transition-colors ${
                  tab === tkey
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
              >
                {t(tkey === 'main' ? 'common.main' : tkey === 'terminal' ? 'common.terminal' : 'common.settings')}
              </button>
            ))}
          </div>
        </div>

        {/* Theme toggle (the former "self" position): dark → light → system cycle */}
        <div className="flex items-center border-l border-border px-2">
          <button
            type="button"
            onClick={() => theme.cycle()}
            title={`${t('themes.switch')}: ${t(`themes.${theme.mode}`)}`}
            className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {theme.mode === 'dark' ? (
              <Moon className="h-3.5 w-3.5" />
            ) : theme.mode === 'light' ? (
              <Sun className="h-3.5 w-3.5" />
            ) : (
              <Monitor className="h-3.5 w-3.5" />
            )}
          </button>
        </div>

        {/* Window controls (self-drawn frameless window, dsh-desktop style; macOS uses system traffic lights so none are rendered) */}
        {!isMac && (
          <div className="flex items-stretch">
            <button
              type="button"
              onClick={() => void win.minimize()}
              title={t('window.minimize')}
              className="flex w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Minus className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => void win.toggleMaximize()}
              title={maximized ? t('window.restore') : t('window.maximize')}
              className="flex w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Square className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => void win.close()}
              title={t('window.close')}
              className="flex w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-destructive hover:text-destructive-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </header>

      {/* errors */}
      {(hub.status?.last_error !== undefined && hub.status.last_error !== null) ||
      hub.error !== null ? (
        <div className="shrink-0 border-b border-destructive/30 bg-destructive/10 px-4 py-1.5 font-mono text-[11px] text-destructive">
          {hub.status?.last_error ?? hub.error}
        </div>
      ) : null}

      {/* body */}
      <main className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-3">
        {tab === 'main' ? (
          <>
            <div className="grid min-h-0 flex-1 grid-cols-12 gap-3">
              <div className="col-span-3 min-h-0">
                <ErrorBoundary label="peers crashed">
                  <PeersView selfPeerId={SELF_PEER_ID} />
                </ErrorBoundary>
              </div>
              {/* Right column is not rendered when no message is selected (user feedback: the empty state felt redundant and
                  "stuck on screen"); the message area automatically fills the remaining width. Only when a message is selected
                  does the three-column detail expand. */}
              <div className={`min-h-0 ${selectedId !== null ? 'col-span-5' : 'col-span-9'}`}>
                <ErrorBoundary label="messages crashed">
                  <MessagesView />
                </ErrorBoundary>
              </div>
              {selectedId !== null && (
                <div className="col-span-4 min-h-0">
                  <ErrorBoundary label="detail crashed">
                    <DetailView selfPeerId={SELF_PEER_ID} />
                  </ErrorBoundary>
                </div>
              )}
            </div>
            <LogsView maxHeight="14rem" />
          </>
        ) : tab === 'terminal' ? (
          <TerminalView />
        ) : (
          <SettingsView />
        )}
      </main>

      {/* Toast viewport + online/offline hints (global, bottom-right, auto-dismiss) */}
      <PeerActivityToasts />

      {/* Close-confirm modal: minimize to tray / quit app / cancel */}
      {showCloseModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={() => setShowCloseModal(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-sm rounded-lg border border-border bg-card p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-sm font-semibold text-foreground">
              {t('window.close_confirm_title')}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('window.close_confirm_desc')}
            </p>
            <div className="mt-4 flex flex-col gap-2">
              <Button
                size="sm"
                variant="default"
                onClick={() => {
                  setShowCloseModal(false)
                  void win.hide()
                }}
              >
                {t('window.minimize_to_tray')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setShowCloseModal(false)
                  void win.hide().finally(() => void tauri.invoke.quitApp())
                }}
              >
                {t('window.quit_app')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowCloseModal(false)}>
                {t('window.cancel')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}