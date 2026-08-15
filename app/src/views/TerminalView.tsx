import { useCallback, useEffect, useRef, useState } from 'react'
import { tauri, type HerdrAgent, type HerdrPane, type HerdrRead } from '@/lib/tauri'
import { serializeError } from '@/lib/serializeError'
import { useTranslation } from '@/i18n'

type Channel = 'agent' | 'pane'
const THROTTLE_MS = 200

/**
 * herdr 终端视图（T-2.9 / T-2.10）
 * - 顶部：herdr 可用性检测 + agent/pane tab
 * - 左栏：列表（每 3s refresh）
 * - 右栏：选中目标 + 操作按钮（prompt / read / send-keys）+ 输出区域（节流 200ms 刷新）
 */
export function TerminalView(): React.JSX.Element {
  const { t } = useTranslation()
  const [available, setAvailable] = useState<boolean | null>(null)
  const [channel, setChannel] = useState<Channel>('agent')
  const [agents, setAgents] = useState<HerdrAgent[]>([])
  const [panes, setPanes] = useState<HerdrPane[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [readOutput, setReadOutput] = useState<HerdrRead | null>(null)
  const [readError, setReadError] = useState<string | null>(null)

  const lastReadRef = useRef<{ text: string; ts: number } | null>(null)
  const throttleTimerRef = useRef<number | null>(null)

  // 启动时探测 herdr
  useEffect(() => {
    void (async () => {
      try {
        const ok = await tauri.invoke.herdrIsAvailable()
        setAvailable(ok)
      } catch (e) {
        setAvailable(false)
        setReadError(serializeError(e))
      }
    })()
  }, [])

  // 列表轮询
  useEffect(() => {
    let active = true
    const tick = async (): Promise<void> => {
      try {
        if (channel === 'agent') {
          const list = await tauri.invoke.herdrAgentList()
          if (active) setAgents(list)
        } else {
          const list = await tauri.invoke.herdrPaneList()
          if (active) setPanes(list)
        }
      } catch (e) {
        if (active) setReadError(serializeError(e))
      }
    }
    void tick()
    const id = window.setInterval(() => void tick(), 3_000)
    return () => {
      active = false
      window.clearInterval(id)
    }
  }, [channel])

  // 节流 200ms 调 read
  const throttledRead = useCallback(
    (target: string) => {
      const last = lastReadRef.current
      const now = Date.now()
      if (last && now - last.ts < THROTTLE_MS) return
      lastReadRef.current = { text: '', ts: now }
      void (async () => {
        try {
          const r =
            channel === 'agent'
              ? await tauri.invoke.herdrAgentRead(target, 50)
              : await tauri.invoke.herdrPaneRead(target, 50)
          // 节流：最后一次写 setReadOutput 赢
          if (throttleTimerRef.current !== null) {
            window.clearTimeout(throttleTimerRef.current)
          }
          throttleTimerRef.current = window.setTimeout(() => {
            setReadOutput(r)
            setReadError(null)
            throttleTimerRef.current = null
          }, 50)
        } catch (e) {
          setReadError(serializeError(e))
        }
      })()
    },
    [channel]
  )

  useEffect(() => {
    return () => {
      if (throttleTimerRef.current !== null) {
        window.clearTimeout(throttleTimerRef.current)
      }
    }
  }, [])

  // 选中时立即拉一次 read
  useEffect(() => {
    if (selectedId !== null) throttledRead(selectedId)
  }, [selectedId, throttledRead])

  const handleSendPrompt = async (text: string): Promise<void> => {
    if (selectedId === null || text === '') return
    try {
      if (channel === 'agent') {
        await tauri.invoke.herdrAgentPrompt(selectedId, text, true, undefined, 30_000)
      } else {
        await tauri.invoke.herdrPaneSendText(selectedId, text)
        await tauri.invoke.herdrPaneSendKeys(selectedId, ['Enter'])
      }
      // 操作完成后立即刷新输出
      throttledRead(selectedId)
    } catch (e) {
      setReadError(serializeError(e))
    }
  }

  const handleSendKeys = async (keys: string[]): Promise<void> => {
    if (selectedId === null || keys.length === 0) return
    try {
      if (channel === 'agent') {
        await tauri.invoke.herdrAgentKeys(selectedId, keys)
      } else {
        await tauri.invoke.herdrPaneSendKeys(selectedId, keys)
      }
      throttledRead(selectedId)
    } catch (e) {
      setReadError(serializeError(e))
    }
  }

  if (available === null) {
    return (
      <div className="rounded-md border bg-card p-4 text-xs text-muted-foreground">
        {t('terminal.checking')}
      </div>
    )
  }
  if (!available) {
    return (
      <div className="rounded-md border border-warning/40 bg-warning/10 p-4">
        <h3 className="text-sm font-semibold text-warning">{t('terminal.unavailable')}</h3>
        <p className="mt-2 text-xs text-muted-foreground">
          {t('terminal.install_hint')}
          <br />
          {t('terminal.degraded_hint')}
        </p>
        {readError !== null && (
          <p className="mt-1 text-xs text-destructive">
            {t('terminal.read_error')}
            {readError}
          </p>
        )}
      </div>
    )
  }

  const list = channel === 'agent' ? agents : panes
  const selected =
    channel === 'agent'
      ? agents.find((a) => a.paneId === selectedId) ?? null
      : panes.find((p) => p.paneId === selectedId) ?? null

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center gap-2 rounded-md border bg-card p-2">
        <button
          type="button"
          onClick={() => {
            setChannel('agent')
            setSelectedId(null)
          }}
          className={`rounded px-3 py-1 text-xs ${
            channel === 'agent'
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          Agents ({agents.length})
        </button>
        <button
          type="button"
          onClick={() => {
            setChannel('pane')
            setSelectedId(null)
          }}
          className={`rounded px-3 py-1 text-xs ${
            channel === 'pane'
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          Panes ({panes.length})
        </button>
        <span className="ml-auto text-xs text-muted-foreground">{t('terminal.refresh_note')}</span>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-12 gap-3">
        <div className="col-span-4 min-h-0 overflow-auto rounded-md border bg-card">
          {list.length === 0 ? (
            <div className="p-4 text-xs text-muted-foreground">
              {t('terminal.empty_list', { channel: t(channel === 'agent' ? 'terminal.agent_tab' : 'terminal.pane_tab') })}
            </div>
          ) : (
            <ul className="divide-y">
              {list.map((item) => (
                <li
                  key={item.paneId}
                  onClick={() => setSelectedId(item.paneId)}
                  className={`cursor-pointer p-2 text-xs hover:bg-background ${
                    selectedId === item.paneId ? 'bg-primary/10' : ''
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-block h-2 w-2 rounded-full ${
                        (channel === 'agent'
                          ? (item as HerdrAgent).status
                          : (item as HerdrPane).agentStatus) === 'idle' ||
                        (channel === 'agent'
                          ? (item as HerdrAgent).status
                          : (item as HerdrPane).agentStatus) === 'done'
                          ? 'bg-success'
                          : (channel === 'agent'
                          ? (item as HerdrAgent).status
                          : (item as HerdrPane).agentStatus) === 'working'
                          ? 'bg-warning'
                          : (channel === 'agent'
                          ? (item as HerdrAgent).status
                          : (item as HerdrPane).agentStatus) === 'blocked'
                          ? 'bg-destructive'
                          : 'bg-muted'
                      }`}
                    />
                    <span className="font-mono">{item.paneId}</span>
                  </div>
                  <div className="ml-4 text-muted-foreground">
                    {channel === 'agent' && (item as HerdrAgent).agent !== null
                      ? `${(item as HerdrAgent).agent} · `
                      : ''}
                    {channel === 'agent'
                      ? (item as HerdrAgent).status
                      : (item as HerdrPane).agentStatus}
                    {item.focused ? ' · focused' : ''}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="col-span-8 flex min-h-0 flex-col gap-2">
          {selected === null ? (
            <div className="flex flex-1 items-center justify-center rounded-md border bg-card text-xs text-muted-foreground">
              {t('terminal.select_hint', { channel: t(channel === 'agent' ? 'terminal.agent_tab' : 'terminal.pane_tab') })}
            </div>
          ) : (
            <>
              <div className="rounded-md border bg-card p-3">
                <p className="font-mono text-sm text-primary">{selected.paneId}</p>
                <p className="text-xs text-muted-foreground">
                  status:{' '}
                  {channel === 'agent'
                    ? (selected as HerdrAgent).status
                    : (selected as HerdrPane).agentStatus}{' '}
                  · cwd: {selected.cwd ?? '—'}
                </p>
              </div>
              <PromptBar onSend={handleSendPrompt} disabled={false} />
              <KeysBar onSendKeys={handleSendKeys} />
              <ReadOutput output={readOutput} error={readError} />
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function PromptBar({
  onSend,
  disabled
}: {
  onSend: (text: string) => Promise<void>
  disabled: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const [text, setText] = useState<string>('')
  return (
    <div className="flex items-center gap-2">
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            const trimmed = text.trim()
            if (trimmed !== '') {
              void onSend(trimmed)
              setText('')
            }
          }
        }}
        placeholder={t('terminal.prompt_placeholder')}
        disabled={disabled}
        className="flex-1 rounded-md border bg-background px-3 py-1 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
      />
      <button
        type="button"
        onClick={() => {
          const trimmed = text.trim()
          if (trimmed !== '') {
            void onSend(trimmed)
            setText('')
          }
        }}
        disabled={disabled || text.trim() === ''}
        className="rounded-md bg-primary px-4 py-1 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
      >
        {t('common.send')}
      </button>
    </div>
  )
}

function KeysBar({ onSendKeys }: { onSendKeys: (keys: string[]) => Promise<void> }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="mr-1 text-xs text-muted-foreground">{t('terminal.keys_label')}</span>
      {(['Enter', 'Escape', 'Tab', 'ctrl-c', 'ctrl-d', 'up', 'down', 'left', 'right']).map((k) => (
        <button
          key={k}
          type="button"
          onClick={() => void onSendKeys([k])}
          className="rounded border bg-background px-2 py-0.5 text-xs font-mono text-foreground hover:bg-secondary"
        >
          {k}
        </button>
      ))}
    </div>
  )
}

function ReadOutput({
  output,
  error
}: {
  output: HerdrRead | null
  error: string | null
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-md border bg-card p-3 font-mono text-xs">
      {error !== null ? (
        <div className="text-destructive">{error}</div>
      ) : output === null ? (
        <div className="text-muted-foreground">{t('terminal.no_output')}</div>
      ) : (
        <>
          <div className="mb-2 text-muted-foreground">
            revision {output.revision}
            {output.truncated ? ' · truncated' : ''}
          </div>
          <pre className="whitespace-pre-wrap text-foreground">{output.text}</pre>
        </>
      )}
    </div>
  )
}