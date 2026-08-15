import { useEffect, useMemo, useRef, useState } from 'react'
import { tauri, type LogLine } from '@/lib/tauri'
import { useTranslation } from '@/i18n'

interface Props {
  /** 刷新间隔（ms），默认 500。 */
  intervalMs?: number
  /** 最大可见行数（超出滚动）。 */
  maxHeight?: string
  /** 内嵌模式（放大弹窗里的实例）：隐藏放大按钮，避免嵌套弹窗。 */
  embedded?: boolean
}

function fmtTs(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 实时日志面板（devtool 终端风：等宽 + 行号 + 时间戳 + stderr 过滤 + 暂停 + 放大弹窗）。 */
export function LogsView({ intervalMs = 500, maxHeight = '16rem', embedded = false }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const [lines, setLines] = useState<LogLine[]>([])
  const [hideStderr, setHideStderr] = useState<boolean>(false)
  const [paused, setPaused] = useState<boolean>(false)
  const [autoScroll, setAutoScroll] = useState<boolean>(true)
  const [expanded, setExpanded] = useState<boolean>(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let active = true
    const tick = async (): Promise<void> => {
      if (paused) return
      try {
        const snap = await tauri.invoke.hubGetLogs()
        if (active) setLines(snap)
      } catch {
        // 静默吞掉瞬时 IPC 错误
      }
    }
    void tick()
    const id = window.setInterval(() => void tick(), intervalMs)
    return () => {
      active = false
      window.clearInterval(id)
    }
  }, [intervalMs, paused])

  // Esc 关闭放大弹窗
  useEffect(() => {
    if (!expanded) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setExpanded(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded])

  const visible = useMemo(
    () => (hideStderr ? lines.filter((l) => l.stream === 'stdout') : lines),
    [lines, hideStderr]
  )

  const onScroll = (): void => {
    const el = ref.current
    if (el === null) return
    // 用户往上滚就停自动跟随；贴底就恢复
    setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 24)
  }

  useEffect(() => {
    if (autoScroll && ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [visible, autoScroll])

  return (
    <>
      <div className="flex flex-col overflow-hidden rounded-md border border-border bg-card">
        <div className="flex shrink-0 items-center justify-between border-b border-border bg-card/80 px-3 py-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            hub log{' '}
            <span className="ml-1 normal-case tracking-normal text-foreground/60">
              {visible.length} {t('logs.lines')}
            </span>
          </span>
          <div className="flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
            <button
              type="button"
              onClick={() => setHideStderr((v) => !v)}
              className={`rounded px-1.5 py-0.5 transition-colors hover:text-foreground ${
                hideStderr ? 'bg-primary/15 text-primary' : ''
              }`}
              title={t('logs.hide_stderr')}
            >
              err
            </button>
            <button
              type="button"
              onClick={() => setPaused((v) => !v)}
              className={`rounded px-1.5 py-0.5 transition-colors hover:text-foreground ${
                paused ? 'bg-warning/15 text-warning' : ''
              }`}
              title={paused ? t('logs.resume') : t('logs.pause')}
            >
              {paused ? '▶' : '⏸'}
            </button>
            {!embedded && (
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="rounded px-1.5 py-0.5 transition-colors hover:text-foreground"
                title={t('logs.expand')}
              >
                ⛶
              </button>
            )}
          </div>
        </div>
        <div
          ref={ref}
          onScroll={onScroll}
          className="overflow-auto font-mono text-[11px] leading-relaxed"
          style={{ maxHeight }}
        >
          {visible.length === 0 ? (
            <div className="px-3 py-2 text-muted-foreground">{t('logs.waiting')}</div>
          ) : (
            <ol className="divide-y divide-border/40">
              {visible.map((l, i) => (
                <li
                  key={`${l.ts}-${i}`}
                  className={`flex gap-2 px-3 py-0.5 ${
                    l.stream === 'stderr' ? 'text-destructive/90' : 'text-foreground/80'
                  }`}
                >
                  <span className="w-12 shrink-0 text-right text-muted-foreground/50">
                    {String(i + 1).padStart(4, ' ')}
                  </span>
                  <span className="w-14 shrink-0 text-muted-foreground/50">{fmtTs(l.ts)}</span>
                  <span
                    className={`w-8 shrink-0 ${
                      l.stream === 'stderr' ? 'text-destructive/70' : 'text-muted-foreground/50'
                    }`}
                  >
                    [{l.stream === 'stderr' ? 'err' : 'out'}]
                  </span>
                  <span className="flex-1 break-all">{l.line}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>

      {/* 放大弹窗：全屏遮罩 + 大面板，内嵌一个独立 LogsView 实例（共享 log ring）。 */}
      {expanded && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
          onClick={() => setExpanded(false)}
        >
          <div
            className="flex h-[85vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
              <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                {t('logs.expanded_title')}
              </span>
              <button
                type="button"
                onClick={() => setExpanded(false)}
                title={t('detail.close') + ' (Esc)'}
                className="rounded px-1.5 py-0.5 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                ✕
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              <LogsView intervalMs={intervalMs} maxHeight="100%" embedded />
            </div>
          </div>
        </div>
      )}
    </>
  )
}
