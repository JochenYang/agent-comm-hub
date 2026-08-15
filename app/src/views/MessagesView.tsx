// M3 综合改动：
// - T-3.1 Markdown 渲染（chat kind 走 <Markdown>）
// - T-3.3 多 peer cc（chip 多选 + 主 recipient；批量发送时 fan-out）
// - T-3.4 拖拽文件附件（5MB 上限；.txt 读为文本拼到消息前；非文本拒）
// - T-3.5 虚拟滚动（@tanstack/react-virtual 接入，measureElement 动态测量）
// - T-3.2 命令面板（在输入框以 / 触发 → 弹 CommandPalette）
// - T-3.7 键盘快捷键：Ctrl+Enter 发送、/ 唤起面板、Esc 关面板
//
// 设计风格：mono / 紧凑 / devtool；锁死 6px radius；新加元素不引入第二色板。

import { useState, useRef, useEffect, useMemo, type FormEvent, type DragEvent } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { usePeersStore } from '@/stores/peersStore'
import { useMessagesStore } from '@/stores/messagesStore'
import type { PresentedMessage } from '@/lib/tauri'
import { Markdown } from '@/lib/markdown'
import { CommandPalette, tryExecuteServerSide, COMMAND_HELP_LINES, type CommandResult } from '@/components/CommandPalette'
import { useTranslation } from '@/i18n'

const SELF_PEER_ID = 'agent-hub-cli'
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024

const KIND_BADGE: Record<PresentedMessage['kind'], string> = {
  chat: 'bg-info/15 text-info ring-info/30',
  task: 'bg-warning/15 text-warning ring-warning/30',
  ack: 'bg-success/15 text-success ring-success/30',
  notice: 'bg-muted text-muted-foreground ring-border'
}

interface Attachment {
  name: string
  size: number
  text: string
}

/** 读 .txt 文本附件（FileReader.readAsText），大文件拒绝 */
async function readTextFile(file: File): Promise<Attachment | { err: string }> {
  if (file.size > MAX_ATTACHMENT_BYTES) return { err: 'attachment_too_large' }
  if (file.type !== '' && !file.type.startsWith('text/')) return { err: 'attachment_not_text' }
  const text = await file.text()
  return { name: file.name, size: file.size, text }
}

/** 把 "/xxx" 输入解析成 CommandResult（与 CommandPalette 的 build 逻辑对齐）。
 * 非命令返回 null；未知命令 / 缺参返回 noop（调用方提示）。 */
function parseCommand(raw: string): CommandResult | null {
  const q = raw.trim()
  if (!q.startsWith('/')) return null
  const stripped = q.slice(1)
  const spaceIdx = stripped.indexOf(' ')
  const cmd = (spaceIdx === -1 ? stripped : stripped.slice(0, spaceIdx)).toLowerCase()
  const rest = spaceIdx === -1 ? '' : stripped.slice(spaceIdx + 1).trim()
  if (cmd === 'peers') return { kind: 'list_peers' }
  if (cmd === 'broadcast') return rest === '' ? { kind: 'noop' } : { kind: 'broadcast', text: rest }
  if (cmd === 'history') return { kind: 'history', limit: rest !== '' ? Number(rest) : undefined }
  if (cmd === 'clear') return { kind: 'clear' }
  if (cmd === 'help') return { kind: 'help' }
  return { kind: 'noop' }
}

/** 把多个附件拼成单条 chat 消息正文 —— 文本放最前，附件追加在末尾 */
function attachmentsToBody(text: string, atts: Attachment[]): string {
  if (atts.length === 0) return text
  const blocks = atts.map((a) => `[attachment:${a.name} (${a.size}B)]\n${a.text}`)
  return blocks.join('\n\n---\n\n') + (text === '' ? '' : `\n\n---\n\n${text}`)
}

export function MessagesView(): React.JSX.Element {
  const { peers } = usePeersStore()
  const {
    messages,
    loading,
    error,
    activePeer,
    setActivePeer,
    sendChat,
    selectedId,
    selectMessage,
    refresh,
    restoreLocal
  } = useMessagesStore()
  const { t } = useTranslation()

  const [recipient, setRecipient] = useState<string>('')
  const [ccRecipients, setCcRecipients] = useState<string[]>([])
  const [text, setText] = useState<string>('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [sending, setSending] = useState<boolean>(false)
  const [dropActive, setDropActive] = useState<boolean>(false)
  const [paletteOpen, setPaletteOpen] = useState<boolean>(false)
  const [paletteQuery, setPaletteQuery] = useState<string>('')
  /** 操作反馈条：发送结果 / 命令执行结果（此前 /peers 只写 console，用户无感知）。 */
  const [feedback, setFeedback] = useState<string | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // 监听 App 的 ach:open-palette 自定义事件（Ctrl+K 也能打开面板）
  useEffect(() => {
    const onPalette = (): void => {
      setPaletteOpen(true)
      setPaletteQuery('/')
    }
    window.addEventListener('ach:open-palette', onPalette)
    return () => window.removeEventListener('ach:open-palette', onPalette)
  }, [])

  // 默认选第一个不是自身的 peer
  useEffect(() => {
    if (recipient !== '') return
    const first = peers.find((p) => p.id !== SELF_PEER_ID)
    if (first) setRecipient(first.id)
  }, [peers, recipient])

  // 排序后的消息列表（react-virtual 需稳定引用）
  const sorted = useMemo(() => [...messages].sort((a, b) => a.ts - b.ts), [messages])

  const virtualizer = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 60,
    overscan: 12,
    measureElement: (el) => el.getBoundingClientRect().height
  })

  useEffect(() => {
    if (sorted.length === 0) return
    virtualizer.scrollToIndex(sorted.length - 1, { align: 'end' })
  }, [sorted.length, virtualizer])

  const handleSubmit = async (e?: FormEvent): Promise<void> => {
    if (e !== undefined) e.preventDefault()
    const trimmedText = text.trim()
    if (sending) return
    // 命令路径：`/` 开头的输入在提交前拦截（快速输入/直接回车时面板没弹），
    // 与面板执行走同一套 handleCommand，绝不把 `/clear` 之类当消息发出去。
    const cmd = parseCommand(trimmedText)
    if (cmd !== null) {
      if (cmd.kind === 'noop') {
        setFeedback(t('commands.command_not_found'))
        return
      }
      await handleCommand(cmd)
      return
    }
    if (recipient === '') {
      setFeedback(t('messages.pick_recipient_hint'))
      return
    }
    const allRecipients = [recipient, ...ccRecipients].filter((p) => p !== '' && p !== SELF_PEER_ID)
    if (allRecipients.length === 0) return
    if (trimmedText === '' && attachments.length === 0) {
      setFeedback(t('messages.empty_input_hint'))
      return
    }

    setSending(true)
    try {
      const body = attachmentsToBody(trimmedText, attachments)
      const results = await Promise.all(
        allRecipients.map((to) => sendChat(to, body))
      )
      if (results.every((r) => r)) {
        setText('')
        setAttachments([])
        const target = allRecipients.length === 1 ? allRecipients[0] : `${allRecipients.length} peers`
        setFeedback(t('messages.sent_ok', { target }))
      } else {
        setFeedback(t('messages.send_failed'))
      }
    } finally {
      setSending(false)
    }
  }

  /** `/` 开头的输入：当文本以 `/` 开始且只有这一个字符时,弹命令面板；带参数则自动执行 */
  const handleInputChange = (next: string): void => {
    setText(next)
    if (next === '/') {
      setPaletteQuery('/')
      setPaletteOpen(true)
    }
  }

  const handleCommand = async (result: CommandResult): Promise<void> => {
    if (result.kind === 'broadcast') {
      const online = peers.filter((p) => p.connected && p.id !== SELF_PEER_ID)
      if (online.length === 0) {
        setFeedback(t('messages.no_online_peers'))
        return
      }
      const results = await Promise.all(online.map((p) => sendChat(p.id, result.text)))
      setFeedback(
        results.every((r) => r)
          ? t('messages.broadcast_ok', { n: online.length })
          : t('messages.send_failed')
      )
    } else if (result.kind === 'history') {
      // 拉取完整历史：hub 内存（refresh）+ SQLite 存档（restoreLocal）合并。
      // hub 重启后内存历史已清空，只 refresh 拉不到存档 —— 这正是
      // `/history` 命令的职责（用户预期"拉数据库之前的历史"）。
      await refresh()
      await restoreLocal(result.limit)
      setFeedback(t('messages.history_ok'))
    } else if (result.kind === 'list_peers') {
      // 结果可见化：不再只写 console（用户此前反馈"命令无效"）
      const list = peers
      if (list.length === 0) {
        setFeedback(t('messages.no_peers_hint'))
      } else {
        setFeedback(
          list.map((p) => `${p.id}${p.connected ? '*' : ''}`).join('  ')
        )
      }
      console.info('[peers]', list.map((p) => `${p.id}${p.connected ? '*' : ''}`).join(' '))
    } else if (result.kind === 'clear') {
      setText('')
      setAttachments([])
      setFeedback(t('messages.cleared'))
    } else if (result.kind === 'help') {
      // 帮助文本显示到反馈条（此前 help 执行后无任何分支 → "无效"）
      setFeedback(COMMAND_HELP_LINES(t).join('\n'))
    }
  }

  /** `Ctrl+Enter` 强制发送; `/` 唤起面板 */
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      void handleSubmit()
    } else if (e.key === '/' && text === '') {
      e.preventDefault()
      setPaletteQuery('/')
      setPaletteOpen(true)
    }
  }

  // 拖拽文件 drop handlers
  const onDragOver = (e: DragEvent<HTMLFormElement>): void => {
    e.preventDefault()
    if (!dropActive) setDropActive(true)
  }
  const onDragLeave = (e: DragEvent<HTMLFormElement>): void => {
    e.preventDefault()
    setDropActive(false)
  }
  const onDrop = async (e: DragEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault()
    setDropActive(false)
    const files = Array.from(e.dataTransfer.files)
    const out: Attachment[] = []
    let lastErr: string | null = null
    for (const f of files) {
      const res = await readTextFile(f)
      if ('err' in res) {
        lastErr = res.err
      } else {
        out.push(res)
      }
    }
    if (out.length > 0) setAttachments((prev) => [...prev, ...out])
    if (lastErr !== null) console.warn(`[attachment] ${lastErr}`)
  }

  return (
    <div className="flex h-full flex-col rounded-md border border-border bg-card">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-1.5">
        <h3 className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          {activePeer !== null ? (
            <>
              {t('messages.conv')}{' '}
              <span className="ml-1 normal-case tracking-normal text-primary">
                {activePeer}
              </span>
            </>
          ) : (
            t('common.messages')
          )}{' '}
          <span className="ml-1 font-mono normal-case tracking-normal text-foreground/70">
            {sorted.length}
          </span>
        </h3>
        {activePeer !== null && (
          <button
            type="button"
            onClick={() => setActivePeer(null)}
            title={t('messages.back_to_mine')}
            className="font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            ✕
          </button>
        )}
        {loading && (
          <span className="font-mono text-[11px] text-muted-foreground">{t('common.syncing')}</span>
        )}
        {error !== null && (
          <span
            className="font-mono text-[11px] text-destructive"
            title={error}
          >
            error
          </span>
        )}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto px-3 py-2">
        {sorted.length === 0 ? (
          <div className="flex h-full items-center justify-center font-mono text-[11px] text-muted-foreground">
            {t('common.no_messages')}
          </div>
        ) : (
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              position: 'relative',
              width: '100%'
            }}
          >
            {virtualizer.getVirtualItems().map((vi) => {
              const m = sorted[vi.index]
              if (!m) return null
              return (
                <div
                  key={m.id}
                  data-index={vi.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${vi.start}px)`
                  }}
                >
                  <div className="pb-1.5">
                    <MessageItem
                      msg={m}
                      selected={selectedId === m.id}
                      onClick={() => selectMessage(selectedId === m.id ? null : m.id)}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* attachments preview chip */}
      {attachments.length > 0 && (
        <div className="flex shrink-0 flex-wrap gap-1 border-t border-border bg-background/40 px-3 py-1.5">
          {attachments.map((a, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-1.5 py-0.5 font-mono text-[11px] text-primary"
            >
              📎 {a.name} ({Math.round(a.size / 1024)} KB)
              <button
                type="button"
                onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                className="text-primary/60 hover:text-primary"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {/* 操作反馈条：发送结果 / 命令结果（help 等命令为多行文本） */}
      {feedback !== null && (
        <div className="flex shrink-0 items-start justify-between gap-2 border-t border-border bg-background/60 px-3 py-1">
          <span className="max-h-32 min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground/80">
            {feedback}
          </span>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            title={t('detail.close')}
            className="shrink-0 font-mono text-[10px] text-muted-foreground transition-colors hover:text-foreground"
          >
            ✕
          </button>
        </div>
      )}

      {/* cc peers chips */}
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-t border-border bg-background/40 px-3 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          to
        </span>
        <select
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          className="rounded-md border border-input bg-background px-2 py-0.5 font-mono text-[11px] text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="" disabled>
            {t('messages.recipient_placeholder')}
          </option>
          <option value="all">{t('messages.all_broadcast')}</option>
          {peers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.id}
              {p.connected ? '' : ' (offline)'}
            </option>
          ))}
        </select>
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          cc
        </span>
        <CcChips
          peers={peers.filter((p) => p.id !== SELF_PEER_ID && p.id !== recipient)}
          selected={ccRecipients}
          onChange={setCcRecipients}
        />
      </div>

      <form
        onSubmit={(e) => void handleSubmit(e)}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={(e) => void onDrop(e)}
        className={`flex shrink-0 items-center gap-1.5 border-t p-2 transition-colors ${
          dropActive ? 'border-primary bg-primary/10' : 'border-border'
        }`}
      >
        <input
          ref={inputRef}
          type="text"
          value={text}
          onChange={(e) => handleInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('messages.input_placeholder')}
          className="flex-1 rounded-md border border-input bg-background px-2 py-1 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          disabled={sending}
        />
        <button
          type="submit"
          disabled={
            (text.trim() === '' && attachments.length === 0) || sending
          }
          className="rounded-md bg-primary px-3 py-1 font-mono text-xs text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {sending ? '…' : t('common.send')}
        </button>
      </form>

      {dropActive && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-md border-2 border-dashed border-primary bg-primary/10 font-mono text-xs text-primary">
          {t('messages.drag_drop_hint')}
        </div>
      )}

      <CommandPalette
        open={paletteOpen}
        initialQuery={paletteQuery}
        peers={peers}
        onClose={() => {
          setPaletteOpen(false)
          setPaletteQuery('')
          inputRef.current?.focus()
        }}
        onExecute={(r) => void handleCommand(r)}
      />
    </div>
  )
}

function CcChips({
  peers,
  selected,
  onChange
}: {
  peers: { id: string; connected: boolean }[]
  selected: string[]
  onChange: (next: string[]) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const toggle = (id: string): void => {
    if (selected.includes(id)) onChange(selected.filter((p) => p !== id))
    else onChange([...selected, id])
  }
  if (peers.length === 0) {
    return (
      <span className="font-mono text-[11px] italic text-muted-foreground/50">
        {t('messages.no_other_peers')}
      </span>
    )
  }
  return (
    <div className="flex flex-wrap gap-1">
      {peers.map((p) => {
        const on = selected.includes(p.id)
        return (
          <button
            type="button"
            key={p.id}
            onClick={() => toggle(p.id)}
            className={`rounded-md border px-1.5 py-0.5 font-mono text-[11px] transition-colors ${
              on
                ? 'border-primary/60 bg-primary/15 text-primary'
                : 'border-border bg-background text-muted-foreground hover:text-foreground'
            }`}
            title={p.connected ? 'online' : 'offline'}
          >
            {p.id}
          </button>
        )
      })}
    </div>
  )
}

function MessageItem({
  msg,
  selected,
  onClick
}: {
  msg: PresentedMessage
  selected: boolean
  onClick: () => void
}): React.JSX.Element {
  const isMine = msg.from === SELF_PEER_ID
  const involvesMe = isMine || msg.to === SELF_PEER_ID
  const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
  const tsLabel = new Date(msg.ts).toLocaleTimeString('en-GB', { hour12: false })

  return (
    <li
      onClick={onClick}
      className={`cursor-pointer rounded-md border bg-background/50 px-2 py-1.5 transition-colors hover:border-primary/50 hover:bg-background ${
        selected
          ? 'border-primary bg-primary/5 ring-1 ring-primary/40'
          : involvesMe
          ? 'border-primary/30'
          : 'border-border'
      }`}
    >
      <div className="flex items-center gap-1.5 font-mono text-[11px]">
        <span className={`truncate ${isMine ? 'text-primary' : 'text-foreground'}`}>
          {msg.from}
          {isMine && <span className="ml-1 text-muted-foreground">(me)</span>}
        </span>
        <span className="shrink-0 text-muted-foreground/60">→</span>
        <span className={`truncate ${msg.to === SELF_PEER_ID ? 'text-primary/90' : 'text-foreground'}`}>
          {msg.to}
        </span>
        <span
          className={`ml-auto inline-block shrink-0 rounded px-1.5 py-px text-[10px] uppercase tracking-wider ring-1 ${KIND_BADGE[msg.kind]}`}
        >
          {msg.kind}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground/60">{tsLabel}</span>
      </div>
      {msg.kind === 'chat' ? (
        <Markdown text={text} />
      ) : (
        <p className="mt-1 whitespace-pre-wrap break-words text-xs text-foreground/90">{text}</p>
      )}
    </li>
  )
}

/** 让 messages body 在表单 submit 路径外可被 CmdPalette 等单独调 */
export async function handleExternalSubmit(raw: string, clear: () => void): Promise<void> {
  await tryExecuteServerSide(raw, clear)
}
