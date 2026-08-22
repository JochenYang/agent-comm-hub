import { useEffect, useMemo, useState } from 'react'
import { useMessagesStore } from '@/stores/messagesStore'
import type { PresentedMessage, TaskContent, AckContent } from '@/lib/tauri'
import { Markdown } from '@/lib/markdown'
import { useTranslation } from '@/i18n'

const SELF_PEER_ID = 'agent-hub-cli'

interface Props {
  /** 当前 UI 的 peer id。 */
  selfPeerId?: string
}

const ACK_TONE: Record<AckContent['status'], string> = {
  accepted: 'bg-info/15 text-info ring-info/30',
  done: 'bg-success/15 text-success ring-success/30',
  rejected: 'bg-warning/15 text-warning ring-warning/30',
  failed: 'bg-destructive/15 text-destructive ring-destructive/30'
}

/** 详情栏：紧凑 mono 风格，task / ack / chat 分别渲染。 */
export function DetailView({ selfPeerId = SELF_PEER_ID }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const { messages, selectedId, selectMessage, sendAck, markPeerRead } = useMessagesStore()
  const [ackSending, setAckSending] = useState<string | null>(null)
  const [ackNote, setAckNote] = useState<string>('')
  const [showJson, setShowJson] = useState<boolean>(false)

  const selected = useMemo<PresentedMessage | null>(() => {
    if (selectedId === null) return null
    return messages.find((m) => m.id === selectedId) ?? null
  }, [messages, selectedId])

  // ack 状态机时间线：该 task 的 ref 链上所有 ack（双方发的），按时间推进。
  const ackTimeline = useMemo<PresentedMessage[]>(() => {
    if (selected === null || selected.kind !== 'task') return []
    return messages
      .filter((m) => m.kind === 'ack' && m.ref === selected.id)
      .sort((a, b) => a.ts - b.ts)
  }, [messages, selected])

  useEffect(() => {
    if (selected !== null && selected.from !== selfPeerId) {
      markPeerRead(selected.from, selected.ts)
    }
  }, [selected, selfPeerId, markPeerRead])

  if (selected === null) {
    // 空态只保留面板框架（与其他两栏一致的标题栏），内容区留白 ——
    // 不再放居中提示（用户反馈冗余），选中消息后直接填充。
    return (
      <div className="flex h-full flex-col rounded-md border border-border bg-card">
        <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-1.5">
          <h3 className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            {t('common.detail')}
          </h3>
        </div>
        <div className="min-h-0 flex-1" />
      </div>
    )
  }

  const tsLabel = new Date(selected.ts).toLocaleString()
  const isMine = selected.from === selfPeerId
  const alreadyAcked = messages.some(
    (m) => m.kind === 'ack' && m.from === selfPeerId && m.ref === selected.id
  )
  const canAck =
    selected.kind === 'task' && selected.to === selfPeerId && !isMine && !alreadyAcked

  const handleAck = async (status: AckContent['status']): Promise<void> => {
    setAckSending(status)
    try {
      await sendAck(selected.id, status, ackNote.trim() === '' ? undefined : ackNote.trim())
      setAckNote('')
    } finally {
      setAckSending(null)
    }
  }

  return (
    <div className="flex h-full flex-col rounded-md border border-border bg-card">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-1.5">
        <h3 className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          {t('common.detail')}
        </h3>
        <button
          type="button"
          onClick={() => selectMessage(null)}
          title={t('detail.close')}
          className="font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          ×
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-xs">
        <dl className="grid grid-cols-[64px_1fr] gap-x-2 gap-y-1">
          <dt className="text-muted-foreground">{t('detail.id')}</dt>
          <dd className="break-all text-foreground/80">{selected.id}</dd>
          <dt className="text-muted-foreground">{t('detail.kind')}</dt>
          <dd>
            <span
              className={`inline-block rounded px-1.5 py-px text-[10px] uppercase tracking-wider ring-1 ${
                selected.kind === 'chat'
                  ? 'bg-info/15 text-info ring-info/30'
                  : selected.kind === 'task'
                  ? 'bg-warning/15 text-warning ring-warning/30'
                  : selected.kind === 'ack'
                  ? 'bg-success/15 text-success ring-success/30'
                  : 'bg-muted text-muted-foreground ring-border'
              }`}
            >
              {selected.kind}
            </span>
          </dd>
          <dt className="text-muted-foreground">{t('detail.from')}</dt>
          <dd className={isMine ? 'text-primary' : 'text-foreground'}>{selected.from}</dd>
          <dt className="text-muted-foreground">{t('detail.to')}</dt>
          <dd className="text-foreground">{selected.to}</dd>
          <dt className="text-muted-foreground">{t('detail.ts')}</dt>
          <dd className="text-foreground/80">{tsLabel}</dd>
          {selected.ref !== undefined && (
            <>
              <dt className="text-muted-foreground">{t('detail.ref')}</dt>
              <dd className="break-all text-foreground/80">{selected.ref}</dd>
            </>
          )}
        </dl>

        <div className="mt-3">
          <ContentView msg={selected} />
        </div>

        {ackTimeline.length > 0 && (
          <div className="mt-4">
            <p className="mb-1.5 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
              {t('detail.ack_timeline', { n: ackTimeline.length })}
            </p>
            <ol className="space-y-0 border-l border-border pl-3">
              {ackTimeline.map((ack, i) => {
                const ac = ack.content as AckContent
                const fromMe = ack.from === selfPeerId
                return (
                  <li key={ack.id} className="relative pb-1.5 pl-2">
                    <span
                      className="absolute -left-[17px] top-1.5 h-1.5 w-1.5 rounded-full bg-border ring-2 ring-background"
                      aria-hidden
                    />
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`inline-block rounded px-1.5 py-px font-mono text-[10px] font-semibold uppercase tracking-wider ring-1 ${ACK_TONE[ac.status]}`}
                      >
                        {ac.status}
                      </span>
                      <span className="truncate font-mono text-[11px] text-muted-foreground">
                        {fromMe ? `${selfPeerId} (me)` : ack.from}
                      </span>
                      <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground/60">
                        {new Date(ack.ts).toLocaleTimeString('en-GB', { hour12: false })}
                      </span>
                    </div>
                    {ac.note !== undefined && ac.note !== '' && (
                      <p className="mt-0.5 whitespace-pre-wrap break-words font-mono text-[11px] text-foreground/80">
                        {ac.note}
                      </p>
                    )}
                    {i < ackTimeline.length - 1 && (
                      <span
                        className="absolute -left-px top-4 bottom-0 w-px bg-border"
                        aria-hidden
                      />
                    )}
                  </li>
                )
              })}
            </ol>
          </div>
        )}

        {canAck === true && (
          <div className="mt-4 rounded-md border border-primary/30 bg-primary/5 p-2">
            <p className="mb-1.5 font-mono text-[11px] uppercase tracking-wider text-foreground/80">
              {t('detail.send_ack_block')}
            </p>
            <input
              type="text"
              value={ackNote}
              onChange={(e) => setAckNote(e.target.value)}
              placeholder={t('detail.note_placeholder')}
              className="mb-2 w-full rounded-md border border-input bg-background px-2 py-1 font-mono text-[11px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <div className="flex flex-wrap gap-1.5">
              {(['accepted', 'rejected', 'done', 'failed'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  disabled={ackSending !== null}
                  onClick={() => void handleAck(s)}
                  className={`rounded-md px-2 py-1 font-mono text-[11px] uppercase tracking-wider ring-1 transition-colors hover:brightness-110 disabled:opacity-50 ${
                    ACK_TONE[s]
                  }`}
                >
                  {ackSending === s ? '…' : s}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* raw JSON 视图（SPEC §2：原始 JSON + 结构化字段） */}
        <div className="mt-4 border-t border-border pt-2">
          <button
            type="button"
            onClick={() => setShowJson((v) => !v)}
            className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
          >
            {showJson ? '▾' : '▸'} {t('detail.raw_json')}
          </button>
          {showJson && (
            <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-background p-2 font-mono text-[10px] leading-relaxed text-foreground/80">
              {JSON.stringify(selected, null, 2)}
            </pre>
          )}
        </div>
      </div>
    </div>
  )
}

function ContentView({ msg }: { msg: PresentedMessage }): React.JSX.Element {
  const { t } = useTranslation()
  if (msg.kind === 'task') {
    const task = msg.content as TaskContent
    return (
      <div className="space-y-2">
        <Field label="prompt" body={task.prompt} />
        {task.context !== undefined && task.context !== '' && (
          <Field label="context" body={task.context} />
        )}
        {task.deliverable !== undefined && task.deliverable !== '' && (
          <Field label="deliverable" body={task.deliverable} />
        )}
      </div>
    )
  }
  if (msg.kind === 'ack') {
    const ack = msg.content as AckContent
    return (
      <div>
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
          {t('detail.status')}
        </p>
        <p className="mt-1">
          <span
            className={`inline-block rounded-md px-2 py-0.5 font-mono text-xs font-semibold uppercase tracking-wider ring-1 ${
              ACK_TONE[ack.status]
            }`}
          >
            {ack.status}
          </span>
        </p>
        {ack.note !== undefined && ack.note !== '' && <Field label="note" body={ack.note} />}
      </div>
    )
  }
  const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
        {t('detail.body')}
      </p>
      <Markdown text={text} />
    </div>
  )
}

function Field({ label, body }: { label: string; body: string }): React.JSX.Element {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <Markdown text={body} />
    </div>
  )
}