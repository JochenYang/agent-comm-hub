import { useEffect, useMemo, useState } from 'react'
import { useMessagesStore } from '@/stores/messagesStore'
import { tauri, type PresentedMessage, type TaskContent, type AckContent, type TaskRecord } from '@/lib/tauri'
import { SELF_PEER_ID } from '@/lib/self'
import { Markdown } from '@/lib/markdown'
import { useTranslation } from '@/i18n'

interface Props {
  /** The current UI's peer id. */
  selfPeerId?: string
}

const ACK_TONE: Record<AckContent['status'], string> = {
  accepted: 'bg-info/15 text-info ring-info/30',
  working: 'bg-info/15 text-info ring-info/30',
  // An interrupt, not a result: toned like a warning so it reads as "needs you".
  'input-required': 'bg-warning/15 text-warning ring-warning/30',
  done: 'bg-success/15 text-success ring-success/30',
  rejected: 'bg-warning/15 text-warning ring-warning/30',
  failed: 'bg-destructive/15 text-destructive ring-destructive/30',
  canceled: 'bg-muted text-muted-foreground ring-border'
}

/** The statuses the ACK row offers, in the order it offers them. `canceled` is
 *  deliberately absent: cancelling goes through its own button below, because the
 *  hub routes it to the OTHER side and updates every assignee row — an ack could
 *  not do that (see bridge_task_cancel). */
const ACK_CHOICES = ['accepted', 'working', 'input-required', 'rejected', 'done', 'failed'] as const

/** Detail column: compact mono style, renders task / ack / chat separately. */
export function DetailView({ selfPeerId = SELF_PEER_ID }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const { messages, selectedId, selectMessage, sendAck, cancelTask, taskInput, markPeerRead } = useMessagesStore()
  const [ackSending, setAckSending] = useState<string | null>(null)
  const [inputDraft, setInputDraft] = useState<string>('')
  const [cancelReason, setCancelReason] = useState<string>('')
  const [taskBusy, setTaskBusy] = useState<boolean>(false)
  /** The hub's ledger for the selected task. DetailView can derive a PARTIAL
   *  status from the acks in the pool, but not the hub's own events: a `timeout`
   *  is synthesized by the hub, and artifacts live only on the ledger. */
  const [ledger, setLedger] = useState<TaskRecord | null>(null)
  const [ackNote, setAckNote] = useState<string>('')
  const [showJson, setShowJson] = useState<boolean>(false)
  // Refetch when the task changes or when another ack for it lands, so a timeout
  // or a late ack shows up without the user having to reselect the message.
  const ackCountForSelected = useMemo(
    () => (selectedId === null ? 0 : messages.filter((m) => m.kind === 'ack' && m.ref === selectedId).length),
    [messages, selectedId]
  )
  useEffect(() => {
    if (selectedId === null) {
      setLedger(null)
      return
    }
    let alive = true
    void tauri.invoke
      .bridgeTaskStatus(selectedId)
      .then((r) => {
        if (alive) setLedger(r?.task ?? null)
      })
      // Not a task, or the hub is down: the derived view still works, just without
      // the ledger-only facts. Never surface this as an error.
      .catch(() => {
        if (alive) setLedger(null)
      })
    return () => {
      alive = false
    }
  }, [selectedId, ackCountForSelected])
  const selected = useMemo<PresentedMessage | null>(() => {
    if (selectedId === null) return null
    return messages.find((m) => m.id === selectedId) ?? null
  }, [messages, selectedId])

  // Ack state-machine timeline: all acks on this task's ref chain (sent by either side), advanced by timestamp.
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
    // Empty state keeps only the panel frame (a title bar consistent with the other two columns), leaving the content area blank —
    // no centered hint (user feedback said it was redundant); content fills in once a message is selected.
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
  // Multi-step ack: accepted/working can still advance to done/failed/rejected.
  // Terminal acks (done/rejected/failed) close the button row — matching the
  // hub ledger's terminal lock (later acks are recorded but never reopen).
  const myAcks = messages
    .filter((m) => m.kind === 'ack' && m.from === selfPeerId && m.ref === selected.id)
    .sort((a, b) => a.ts - b.ts)
  const lastAck = myAcks.at(-1)
  const lastStatus: AckContent['status'] | null =
    lastAck !== undefined && typeof lastAck.content === 'object' && lastAck.content !== null && 'status' in lastAck.content
      ? (lastAck.content as AckContent).status
      : null
  const terminalAcked = lastStatus === 'done' || lastStatus === 'rejected' || lastStatus === 'failed'
  // The OTHER side's acks: for a task I sent, that is the assignee reporting back.
  // The hub routes acks to the task's sender, so they are in the pool already.
  const theirStatus: AckContent['status'] | null = (() => {
    const last = messages
      .filter((m) => m.kind === 'ack' && m.from !== selfPeerId && m.ref === selected.id)
      .sort((a, b) => a.ts - b.ts)
      .at(-1)
    if (last === undefined || typeof last.content !== 'object' || last.content === null) return null
    return 'status' in last.content ? (last.content as AckContent).status : null
  })()
  const closed = theirStatus === 'done' || theirStatus === 'failed' || theirStatus === 'rejected' || theirStatus === 'canceled'
  // Cancelling is for a task I am part of and that has not closed yet; answering
  // an interrupt is only for the SENDER (the assignee is the side that asked).
  const canCancel = selected.kind === 'task' && (isMine || selected.to === selfPeerId) && !closed
  const canAnswer = selected.kind === 'task' && isMine && theirStatus === 'input-required'

  /** Human SLA line. `null` when the task has no deadline or has already closed —
   *  a countdown on a finished task is noise. A hub-side `timeout` is called out
   *  explicitly because it is the one status the pool cannot show. */
  const deadlineLabel: string | null = (() => {
    if (ledger === null || ledger.deadlineAt === undefined) return null
    if (ledger.status === 'timeout') return t('detail.task_timed_out')
    if (ledger.status === 'done' || ledger.status === 'failed' || ledger.status === 'rejected' || ledger.status === 'canceled') {
      return null
    }
    const ms = ledger.deadlineAt - Date.now()
    if (ms <= 0) return t('detail.task_overdue')
    const minutes = Math.ceil(ms / 60_000)
    return minutes >= 60
      ? t('detail.task_due_hours', { n: Math.round(minutes / 60) })
      : t('detail.task_due_minutes', { n: minutes })
  })()

  const canAck =
    selected.kind === 'task' && (selected.to === selfPeerId || selected.to === 'all') && !isMine && !terminalAcked

  const handleAck = async (status: AckContent['status'], progress?: number): Promise<void> => {
    setAckSending(status)
    try {
      await sendAck(selected.id, status, ackNote.trim() === '' ? undefined : ackNote.trim(), progress)
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
              {ACK_CHOICES.map((s) => (
                <button
                  key={s}
                  type="button"
                  disabled={ackSending !== null}
                  onClick={() => void handleAck(s, s === 'working' ? 50 : undefined)}
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

        {/* Sender-side task controls (W33). The assignee already has the ack row
            above; these are the two things only the OTHER side can do: answer an
            interrupt, and stop the task. */}
        {canAnswer === true && (
          <div className="mt-4 rounded-md border border-warning/40 bg-warning/5 p-2">
            <p className="mb-1.5 font-mono text-[11px] uppercase tracking-wider text-foreground/80">
              {t('detail.input_required_block')}
            </p>
            <input
              type="text"
              value={inputDraft}
              onChange={(e) => setInputDraft(e.target.value)}
              placeholder={t('detail.input_placeholder')}
              className="mb-2 w-full rounded-md border border-input bg-background px-2 py-1 font-mono text-[11px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <button
              type="button"
              disabled={taskBusy || inputDraft.trim() === ''}
              onClick={() => {
                setTaskBusy(true)
                void taskInput(selected.id, inputDraft.trim()).finally(() => {
                  setTaskBusy(false)
                  setInputDraft('')
                })
              }}
              className="rounded-md bg-primary px-2 py-1 font-mono text-[11px] uppercase tracking-wider text-primary-foreground disabled:opacity-50"
            >
              {t('detail.send_input')}
            </button>
          </div>
        )}

        {canCancel === true && (
          <div className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 p-2">
            <p className="mb-1.5 font-mono text-[11px] uppercase tracking-wider text-foreground/80">
              {t('detail.cancel_block')}
            </p>
            <input
              type="text"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder={t('detail.cancel_reason_placeholder')}
              className="mb-2 w-full rounded-md border border-input bg-background px-2 py-1 font-mono text-[11px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <button
              type="button"
              disabled={taskBusy}
              onClick={() => {
                setTaskBusy(true)
                void cancelTask(selected.id, cancelReason.trim() === '' ? undefined : cancelReason.trim()).finally(() => {
                  setTaskBusy(false)
                  setCancelReason('')
                })
              }}
              className="rounded-md bg-destructive px-2 py-1 font-mono text-[11px] uppercase tracking-wider text-destructive-foreground disabled:opacity-50"
            >
              {t('detail.cancel_task')}
            </button>
          </div>
        )}

        {/* Task ledger (W33): what the hub knows and the pool cannot tell us —
            the authoritative status (including a hub-synthesized `timeout`), the
            SLA deadline, and any artifacts an ack attached. */}
        {ledger !== null && selected.kind === 'task' && (
          <div className="mt-4 rounded-md border border-border bg-background p-2">
            <p className="mb-1.5 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
              {t('detail.task_ledger')}
            </p>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 font-mono text-[11px]">
              <span>
                <span className="text-muted-foreground">{t('detail.task_status')}: </span>
                <span className="uppercase tracking-wider">{ledger.status}</span>
              </span>
              {deadlineLabel !== null && (
                <span className={ledger.status === 'timeout' ? 'text-destructive' : 'text-muted-foreground'}>
                  {deadlineLabel}
                </span>
              )}
            </div>
            {ledger.artifacts !== undefined && ledger.artifacts.length > 0 && (
              <ul className="mt-2 space-y-1.5 border-t border-border pt-2">
                {ledger.artifacts.map((artifact, i) => (
                  <li key={`${artifact.name}-${i}`} className="font-mono text-[11px]">
                    <span className="text-muted-foreground">{artifact.name}</span>
                    {artifact.text !== undefined && (
                      <pre className="mt-0.5 max-h-40 overflow-auto rounded border border-border bg-card p-1.5 text-[10px] leading-relaxed text-foreground/80">
                        {artifact.text}
                      </pre>
                    )}
                    {artifact.url !== undefined && (
                      <a
                        href={artifact.url}
                        target="_blank"
                        rel="noreferrer"
                        className="ml-1 text-info underline underline-offset-2"
                      >
                        {artifact.url}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Raw JSON view (SPEC §2: raw JSON + structured fields) */}
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