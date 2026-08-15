import { usePeersStore } from '@/stores/peersStore'
import { useMessagesStore } from '@/stores/messagesStore'
import { useTranslation } from '@/i18n'

interface Props {
  /** 当前 UI 自己注册的 peer id（高亮显示）。 */
  selfPeerId?: string
}

/** Peer 列表视图（devtool 紧凑）。点击 peer 切换消息流会话（PRD US-2）。 */
export function PeersView({ selfPeerId }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const { peers, loading, error, refresh } = usePeersStore()
  const { unreadMap, activePeer, setActivePeer } = useMessagesStore()

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
      {error !== null && (
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
          <ul className="divide-y divide-border/60">
            {peers.map((p) => {
              const unread = unreadMap[p.id] ?? 0
              const isSelf = selfPeerId === p.id
              const isActive = activePeer === p.id
              return (
                <li
                  key={p.id}
                  onClick={() => setActivePeer(isActive ? null : p.id)}
                  title={
                    isActive ? t('peers.back_conv') : t('peers.view_conv', { peer: p.id })
                  }
                  className={`group flex cursor-pointer items-center gap-2 px-3 py-1.5 transition-colors ${
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
                  <span className="flex-1 truncate font-mono text-xs">
                    {isSelf && <span className="text-primary">▶</span>}
                    <span className={`ml-1 ${isActive ? 'text-primary' : ''}`}>{p.id}</span>
                    {isSelf && <span className="ml-1 text-muted-foreground">{t('peers.self')}</span>}
                  </span>
                  {unread > 0 ? (
                    <span
                      className="inline-flex h-4 min-w-[1rem] shrink-0 items-center justify-center rounded bg-destructive px-1 font-mono text-[10px] font-semibold text-destructive-foreground"
                      aria-label={`${unread} unread`}
                    >
                      {unread > 99 ? '99+' : unread}
                    </span>
                  ) : (
                    <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/80">
                      {p.connected ? t('peers.on') : t('peers.off')}
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
