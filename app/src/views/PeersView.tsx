import { useState } from 'react'
import { Pencil, UserMinus, Trash2, Check, X } from 'lucide-react'
import { usePeersStore } from '@/stores/peersStore'
import { useMessagesStore } from '@/stores/messagesStore'
import { useHubStore } from '@/stores/hubStore'
import { pushToast } from '@/stores/toastStore'
import type { Peer } from '@/lib/tauri'
import { useTranslation } from '@/i18n'

interface Props {
  /** 当前 UI 自己注册的 peer id（高亮显示）。 */
  selfPeerId?: string
}

/** Peer 花名册管理面板（devtool 紧凑）。
 *  在线/离线两组展示；点击 peer 切换消息流会话（PRD US-2）；行内操作：
 *  重命名（bridge_rename，空输入 = 取消，另有"清除别名"）与移除（管理端踢人）。 */
export function PeersView({ selfPeerId }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const { peers, loading, error, refresh, renamePeer, removePeer, forgetPeer } = usePeersStore()
  const { unreadMap, activePeer, setActivePeer } = useMessagesStore()
  // 错误条只在 hub 运行中才显示：hub 停止时轮询失败（"MCP 未初始化"）是正常态，
  // 不应作为红色错误一直挂着（用户反馈启动后一直弹）。
  const hubState = useHubStore((s) => s.status?.state)
  const showError = error !== null && (hubState === 'running' || hubState === 'starting')

  // 行内编辑/确认状态：同一时刻最多一个 peer 处于重命名或确认移除。
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null)

  const online = peers.filter((p) => p.connected)
  const offline = peers.filter((p) => !p.connected)

  const displayName = (p: Peer): string => p.alias ?? p.id

  const submitRename = async (p: Peer): Promise<void> => {
    const draft = renameDraft.trim()
    setRenamingId(null)
    // 空输入 = 取消（清除别名走显式入口，避免误清）。
    if (draft === '' || draft === (p.alias ?? '')) return
    if (await renamePeer(p.id, draft)) {
      pushToast(
        'success',
        t('peers.renamed_toast', { name: displayName(p), alias: draft })
      )
    }
  }

  const clearAlias = async (p: Peer): Promise<void> => {
    setRenamingId(null)
    if (await renamePeer(p.id, '')) {
      pushToast('success', t('peers.alias_cleared_toast', { name: displayName(p) }))
    }
  }

  const confirmRemove = async (p: Peer): Promise<void> => {
    setConfirmRemoveId(null)
    if (await removePeer(p.id)) {
      pushToast('success', t('peers.removed_toast', { name: displayName(p) }))
    }
  }

  // 仅本地名单移除（offline 已知 peer 无 hub 侧对应物，不动 hub）。
  const doForget = async (p: Peer): Promise<void> => {
    if (await forgetPeer(p.id)) {
      pushToast('success', t('peers.forgot_toast', { name: displayName(p) }))
    }
  }

  const renderRow = (p: Peer): React.JSX.Element => {
    const unread = unreadMap[p.id] ?? 0
    const isSelf = selfPeerId === p.id
    const isActive = activePeer === p.id
    const isRenaming = renamingId === p.id
    const isConfirming = confirmRemoveId === p.id

    if (isConfirming) {
      return (
        <li
          key={p.id}
          className="flex items-center gap-2 bg-destructive/10 px-3 py-1.5 font-mono text-[11px] text-destructive"
        >
          <span className="flex-1 truncate">{t('peers.remove_confirm', { name: displayName(p) })}</span>
          <button
            type="button"
            onClick={() => void confirmRemove(p)}
            className="rounded bg-destructive px-2 py-0.5 font-mono text-[10px] text-destructive-foreground"
          >
            {t('peers.remove')}
          </button>
          <button
            type="button"
            onClick={() => setConfirmRemoveId(null)}
            className="rounded px-1 font-mono text-[10px] text-muted-foreground hover:text-foreground"
          >
            {t('common.cancel')}
          </button>
        </li>
      )
    }

    return (
      <li
        key={p.id}
        role="button"
        tabIndex={0}
        onClick={() => {
          if (!isRenaming) setActivePeer(isActive ? null : p.id)
        }}
        onKeyDown={(e) => {
          // 键盘可达性（WCAG 2.1 AA）：Enter / Space 等价点击切换会话；
          // 行内重命名时输入框自己处理按键，这里不抢。
          if (isRenaming) return
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setActivePeer(isActive ? null : p.id)
          }
        }}
        title={isActive ? t('peers.back_conv') : t('peers.view_conv', { peer: p.id })}
        aria-label={isActive ? t('peers.back_conv') : t('peers.view_conv', { peer: p.id })}
        className={`group flex cursor-pointer items-center gap-2 px-3 py-1.5 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/40 ${
          isActive
            ? 'bg-primary/10 ring-1 ring-inset ring-primary/40'
            : 'hover:bg-background'
        } ${p.connected ? '' : 'opacity-60'}`}
      >
        <span
          className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
            p.connected ? 'bg-success' : 'bg-muted-foreground'
          }`}
          aria-label={p.connected ? t('peers.on') : t('peers.off')}
        />
        {isRenaming ? (
          // 行内重命名：Enter 提交、Esc/空输入取消；有别名时附"清除别名"入口。
          <span className="flex min-w-0 flex-1 items-center gap-1" onClick={(e) => e.stopPropagation()}>
            <input
              autoFocus
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitRename(p)
                if (e.key === 'Escape') setRenamingId(null)
              }}
              placeholder={t('peers.rename_placeholder')}
              className="min-w-0 flex-1 rounded border border-border bg-background px-1.5 py-0.5 font-mono text-xs text-foreground outline-none focus:ring-1 focus:ring-primary/50"
            />
            <button
              type="button"
              onClick={() => void submitRename(p)}
              title={t('peers.ok')}
              className="rounded p-0.5 text-primary hover:bg-muted"
            >
              <Check className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => setRenamingId(null)}
              title={t('common.cancel')}
              className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
            {p.alias !== undefined && (
              <button
                type="button"
                onClick={() => void clearAlias(p)}
                className="shrink-0 rounded px-1 font-mono text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                {t('peers.clear_alias')}
              </button>
            )}
          </span>
        ) : (
          <>
            <span className="min-w-0 flex-1">
              <span className="flex items-center truncate font-mono text-xs">
                {isSelf && <span className="text-primary">▶</span>}
                <span className={`ml-1 truncate ${isActive ? 'text-primary' : ''}`}>
                  {displayName(p)}
                </span>
                {isSelf && (
                  <span className="ml-1 shrink-0 text-muted-foreground">{t('peers.self')}</span>
                )}
                {p.clientVersion !== undefined && (
                  <span className="ml-1.5 shrink-0 rounded bg-muted px-1 font-mono text-[9px] text-muted-foreground">
                    v{p.clientVersion}
                  </span>
                )}
              </span>
              {/* alias 存在时 id 作为副标题小字（真实 peer id 不被花名遮住）。 */}
              {p.alias !== undefined && (
                <span className="block truncate font-mono text-[10px] text-muted-foreground/70">
                  {p.id}
                </span>
              )}
            </span>
            {/* 行操作：重命名 + 移除（仅 online；hover/focus 显示）。 */}
            <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  setConfirmRemoveId(null)
                  setRenameDraft(p.alias ?? '')
                  setRenamingId(p.id)
                }}
                title={t('peers.rename')}
                className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <Pencil className="h-3 w-3" />
              </button>
              {!isSelf && p.connected && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    setRenamingId(null)
                    setConfirmRemoveId(p.id)
                  }}
                  title={t('peers.remove')}
                  className="rounded p-0.5 text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
                >
                  <UserMinus className="h-3 w-3" />
                </button>
              )}
              {/* offline 已知 peer：只从本地名单移除（不动 hub），否则本地花名册只增不减。 */}
              {!isSelf && !p.connected && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    void doForget(p)
                  }}
                  title={t('peers.forget')}
                  className="rounded p-0.5 text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              )}
            </span>
          </>
        )}
        {unread > 0 ? (
          <span
            className="inline-flex h-4 min-w-[1rem] shrink-0 items-center justify-center rounded bg-destructive px-1 font-mono text-[10px] font-semibold text-destructive-foreground"
            aria-label={`${unread} unread`}
          >
            {unread > 99 ? '99+' : unread}
          </span>
        ) : (
          <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/80">
            {p.connected ? t('peers.on') : t('peers.off')}
          </span>
        )}
      </li>
    )
  }

  const renderGroup = (label: string, rows: Peer[]): React.JSX.Element | null =>
    rows.length === 0 ? null : (
      <div>
        <div className="px-3 pb-0.5 pt-1.5 font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground/60">
          {label} · {rows.length}
        </div>
        <ul className="divide-y divide-border/60">{rows.map(renderRow)}</ul>
      </div>
    )

  return (
    <div className="flex h-full flex-col rounded-md border border-border bg-card">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-1.5">
        <h3 className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          {t('common.peers')}{' '}
          <span className="ml-1 font-mono text-foreground/70 normal-case tracking-normal">
            {peers.length}
          </span>
        </h3>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          title={t('peers.refresh')}
          className="rounded px-1 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
        >
          {loading ? '…' : '↻'}
        </button>
      </div>
      {showError && (
        <div className="border-b border-destructive/30 bg-destructive/10 px-3 py-1 font-mono text-[11px] text-destructive">
          {error}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {peers.length === 0 ? (
          <div className="px-3 py-6 text-center font-mono text-[11px] text-muted-foreground">
            {t('peers.no_peers')}
          </div>
        ) : (
          <>
            {renderGroup(t('peers.online_group'), online)}
            {renderGroup(t('peers.offline_group'), offline)}
          </>
        )}
      </div>
    </div>
  )
}
