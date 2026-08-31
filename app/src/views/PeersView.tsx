import { useState } from 'react'
import { Pencil, UserMinus, Trash2, Check, X } from 'lucide-react'
import { usePeersStore } from '@/stores/peersStore'
import { useMessagesStore } from '@/stores/messagesStore'
import { useHubStore } from '@/stores/hubStore'
import { pushToast } from '@/stores/toastStore'
import type { Peer } from '@/lib/tauri'
import { useTranslation } from '@/i18n'

interface Props {
  /** The peer id the current UI registered (highlighted). */
  selfPeerId?: string
}

/** Peer roster management panel (compact devtool).
 *   Shows online/offline groups; clicking a peer switches the message-stream conversation (PRD US-2); in-row actions:
 *  rename (bridge_rename, empty input = cancel, plus a "clear alias") and remove (manager kick). */
export function PeersView({ selfPeerId }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const { peers, loading, error, refresh, renamePeer, removePeer, forgetPeer } = usePeersStore()
  const { unreadMap, activePeer, setActivePeer } = useMessagesStore()
  // Error bar only shows while the hub is running: a polling failure while stopped ("MCP not initialized") is normal,
  // and shouldn't hang around as a red error (users reported it popping constantly after startup).
  const hubState = useHubStore((s) => s.status?.state)
  const showError = error !== null && (hubState === 'running' || hubState === 'starting')

  // Inline edit/confirm state: at most one peer is renaming or confirming removal at a time.
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  // New routing id (optional, admin only): when non-empty and different from the current id, submit a true rename (re-key).
  const [idDraft, setIdDraft] = useState('')
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null)

  const online = peers.filter((p) => p.connected)
  const offline = peers.filter((p) => !p.connected)

  const displayName = (p: Peer): string => p.alias ?? p.id

  const submitRename = async (p: Peer): Promise<void> => {
    const draft = renameDraft.trim()
    const idT = idDraft.trim()
    setRenamingId(null)
    // No actual change to alias/new id = cancel (clearing the alias goes through the explicit entry to avoid accidental clearing).
    const aliasWanted = draft !== '' && draft !== (p.alias ?? '')
    const idWanted = idT !== '' && idT !== p.id
    if (!aliasWanted && !idWanted) return
    const name = displayName(p)
    if (await renamePeer(p.id, aliasWanted ? draft : undefined, idWanted ? idT : undefined)) {
      pushToast(
        'success',
        idWanted
          ? t('peers.rekeyed_toast', { old: name, id: idT })
          : t('peers.renamed_toast', { name, alias: draft })
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

  // Local-list-only removal (a known offline peer has no counterpart on the hub side, so the hub is untouched).
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
          // Keyboard accessibility (WCAG 2.1 AA): Enter / Space behave like a click to switch conversations;
          // during inline rename the input handles its own keys, so this doesn't intercept them.
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
          // Inline rename: Enter submits, Esc/empty input cancels; when an alias exists, a "clear alias" entry is added;
          // non-self peers additionally get a "new ID" input (admin true rename, re-keying migrates all state).
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
              className="min-w-0 flex-[2] rounded border border-border bg-background px-1.5 py-0.5 font-mono text-xs text-foreground outline-none focus:ring-1 focus:ring-primary/50"
            />
            {!isSelf && (
              <input
                value={idDraft}
                onChange={(e) => setIdDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitRename(p)
                  if (e.key === 'Escape') setRenamingId(null)
                }}
                placeholder={t('peers.rename_id_placeholder')}
                title={t('peers.rename_id_hint')}
                aria-label={t('peers.rename_id_placeholder')}
                className="min-w-0 flex-1 rounded border border-border bg-background px-1.5 py-0.5 font-mono text-xs text-foreground outline-none focus:ring-1 focus:ring-primary/50"
              />
            )}
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
              {/* When an alias exists, show the id as a small subtitle (the real peer id isn't hidden by the friendly name). */}
              {p.alias !== undefined && (
                <span className="block truncate font-mono text-[10px] text-muted-foreground/70">
                  {p.id}
                </span>
              )}
            </span>
            {/* Row actions: rename + remove/forget (made visible on hover or keyboard focus; using opacity
                instead of display:none so the buttons always stay Tab-able and accessible to assistive tech). */}
            <span className="flex shrink-0 items-center gap-0.5 opacity-0 pointer-events-none transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  setConfirmRemoveId(null)
                  setRenameDraft(p.alias ?? '')
                  setIdDraft('')
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
              {/* Offline known peer: only removed from the local list (the hub is untouched), otherwise the local roster only grows. */}
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
