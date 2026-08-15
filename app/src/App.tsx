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
import { useTranslation } from '@/i18n'

const SELF_PEER_ID = 'agent-hub-cli'

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
  // 无边框窗口：最大化状态图标切换（监听窗口 resize）
  const win = getCurrentWindow()
  const [maximized, setMaximized] = useState(false)

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

  useEffect(() => {
    void tauri.invoke.appReady().catch(() => undefined)
  }, [])

  // M3 T-3.7 全局快捷键：
  //   Ctrl/Cmd+K          → 命令面板（仅 main tab 触发）
  //   Ctrl/Cmd+,          → 跳到 settings tab
  //   Ctrl/Cmd+Alt+M/T/S  → 跳到 main / terminal / settings
  //   Esc                  → 返回 main tab（仅在 terminal/settings 时)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const meta = e.metaKey || e.ctrlKey
      if (meta && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        // 派一个 custom event 让 MessagesView 接收;MessagesView 自己也监听 input。
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
        // PRD §5.2: Ctrl+W 关闭当前 tab（terminal/settings → 回 main；main 忽略）
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
  // 控制按钮状态联动：Running 时禁用"启动"、启用"停止/重启"；Starting/Stopping 全部禁用。
  const isRunning = state === 'running'
  const isBusy = state === 'starting' || state === 'stopping' || hub.loading
  // macOS 无边框窗口的惯例是左上角系统红绿灯（traffic lights）：左侧留出红绿灯位、
  // 右侧不渲染自绘窗口按钮（Windows/Linux 才用右上角 — □ ×）。
  const isMac = /Mac/i.test(navigator.userAgent)

  return (
    <div className="flex h-screen w-screen flex-col bg-background text-foreground">
      {/* Top bar — 自定义标题栏（无系统边框）：左拖拽区(品牌+状态) → 控制按钮 → tabs → 主题/窗口控制 */}
      <header className="flex shrink-0 select-none items-stretch border-b border-border bg-background/80 backdrop-blur">
        {/* drag region：品牌 + 状态徽章（data-tauri-drag-region 支持双击最大化） */}
        <div
          data-tauri-drag-region
          className={`flex items-center gap-3 py-2 ${isMac ? 'pl-[78px]' : 'pl-4'}`}
        >
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

        {/* 主题切换（原"自身"位置）：dark → light → system 循环 */}
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

        {/* 窗口控制（无边框窗口自绘，dsh-desktop 风格；macOS 用系统红绿灯不渲染） */}
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
              {/* 未选中消息时右栏不渲染（用户反馈空态冗余"卡在界面上"），
                  消息区自动占满剩余宽度；选中消息才展开三栏详情。 */}
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
    </div>
  )
}