import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from './components/motion/button/base'
import { Input } from './components/motion/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/motion/select'
import { Table, type TableColumn } from './components/motion/table/index'
import { AnimatedToastStack, useAnimatedToastStack } from './components/motion/animated-toast-stack'
import {
  ApiError,
  McpClient,
  adminApi,
  type BridgeMessage,
  type PeerRow,
  type TaskRow,
  type TokenRow,
} from './lib/mcp'
import './styles/tokens.css'
import './styles/app.css'

const ENDPOINT_KEY = 'hub-admin-endpoint'
const TOKEN_KEY = 'hub-admin-token'

type ConnState = 'off' | 'ok' | 'err'
/** `/admin/api` availability: the token table only exists in remote mode. */
type TokenApiState = 'unknown' | 'ok' | 'off' | 'err'

interface GroupRow {
  id: string
  name?: string
  members: string[]
  createdBy?: string
}

interface RefreshResult {
  ok: boolean
  error?: string
}

function defaultEndpoint(): string {
  if (typeof window === 'undefined') return '/mcp'
  if (window.location.port === '18764' || window.location.pathname.startsWith('/admin')) {
    return `${window.location.origin}/mcp`
  }
  return window.localStorage.getItem(ENDPOINT_KEY) ?? 'http://127.0.0.1:18764/mcp'
}

/** Origin the `/admin/api` calls go to: the MCP endpoint without its path. */
function endpointOrigin(endpoint: string): string {
  try {
    return new URL(endpoint, window.location.origin).origin
  } catch {
    return window.location.origin
  }
}

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text === '' ? '未知错误' : text
}

function relTime(ms: number): string {
  if (ms <= 0) return '—'
  const delta = Date.now() - ms
  if (delta < 1000) return '刚刚'
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s 前`
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m 前`
  return `${Math.floor(delta / 3_600_000)}h 前`
}

function clockTime(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** Clipboard with a fallback for non-secure origins (a LAN IP over plain http
 * is not a secure context, so navigator.clipboard is unavailable there). */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const node = document.createElement('textarea')
      node.value = text
      node.setAttribute('readonly', '')
      node.style.position = 'fixed'
      node.style.opacity = '0'
      document.body.appendChild(node)
      node.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(node)
      return ok
    } catch {
      return false
    }
  }
}

/** Panel table: renders a compact placeholder instead of an empty scroll
 * viewport — a scrollable box with one empty row is what produced stray
 * scrollbars. Heights are exact (header + rows + separators) so a short list
 * never scrolls; longer lists scroll at `max`. */
function DataTable<T>({
  rows,
  columns,
  rowId,
  rowHeight = 44,
  max = 480,
  empty,
}: {
  rows: T[]
  columns: Array<TableColumn<T>>
  rowId: (row: T) => string
  rowHeight?: number
  max?: number
  empty: React.ReactNode
}): React.JSX.Element {
  if (rows.length === 0) return <div className="empty">{empty}</div>
  return (
    <Table<T>
      data={rows}
      columns={columns}
      getRowId={rowId}
      rowHeight={rowHeight}
      height={Math.min(max, (rows.length + 1) * (rowHeight + 1) + 4)}
      className="border-0 border-t border-border bg-transparent"
    />
  )
}

/** Absolute URL members paste into their MCP config. */
function mcpUrl(endpoint: string): string {
  try {
    return new URL(endpoint, window.location.origin).toString()
  } catch {
    return endpoint
  }
}

/** Multi-shape snippet: covers the majority of MCP clients in one paste. */
function buildMcpConfig(invite: TokenRow, url: string): string {
  const headers = { Authorization: `Bearer ${invite.token}` }
  return [
    `# agent-comm-hub · peer: ${invite.peer}${invite.owner === undefined ? '' : ` (${invite.owner})`}`,
    '# 一人一枚 token；不要多人共用（共用=共享信箱）',
    '',
    '## Claude Code / generic HTTP MCP (.mcp.json)',
    JSON.stringify({ mcpServers: { 'agent-hub': { type: 'http', url, headers } } }, null, 2),
    '',
    '## opencode (opencode.json → mcp)',
    JSON.stringify({ mcp: { 'agent-hub': { type: 'remote', url, headers } } }, null, 2),
    '',
    '## curl 探测',
    `curl -sS -X POST ${url} \\`,
    "  -H 'Content-Type: application/json' \\",
    "  -H 'Accept: application/json, text/event-stream' \\",
    `  -H 'Authorization: Bearer ${invite.token}' \\`,
    '  -d \'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}\'',
  ].join('\n')
}

export function App(): React.JSX.Element {
  const [endpoint, setEndpoint] = useState(defaultEndpoint)
  const [token, setToken] = useState(() => window.localStorage.getItem(TOKEN_KEY) ?? '')
  const [conn, setConn] = useState<ConnState>('off')
  const [peers, setPeers] = useState<PeerRow[]>([])
  const [messages, setMessages] = useState<BridgeMessage[]>([])
  const [tasks, setTasks] = useState<TaskRow[]>([])
  const [groups, setGroups] = useState<GroupRow[]>([])
  const [historyLimit, setHistoryLimit] = useState<number | null>(null)
  const [tokens, setTokens] = useState<TokenRow[]>([])
  const [tokenApi, setTokenApi] = useState<TokenApiState>('unknown')
  const [reveal, setReveal] = useState(false)
  const [busy, setBusy] = useState(false)
  const [issuing, setIssuing] = useState(false)
  const [pendingRevoke, setPendingRevoke] = useState<string | null>(null)
  const [invite, setInvite] = useState<TokenRow | null>(null)
  const [formPeer, setFormPeer] = useState('')
  const [formOwner, setFormOwner] = useState('')
  const [formRole, setFormRole] = useState('agent')
  const { toasts, showToast, updateToast, dismissToast } = useAnimatedToastStack({ defaultDuration: 4200 })

  // One MCP session per (endpoint, token): a fresh client every poll would park
  // a new session in the hub's registry on every 5s tick.
  const clientRef = useRef<{ key: string; client: McpClient } | null>(null)
  const revealRef = useRef(false)
  const clientFor = useCallback((ep: string, tk: string): McpClient => {
    const key = `${ep}\u0000${tk}`
    if (clientRef.current === null || clientRef.current.key !== key) {
      clientRef.current = { key, client: new McpClient(ep, tk) }
    }
    return clientRef.current.client
  }, [])

  const loadTokens = useCallback(
    async (revealNow: boolean): Promise<void> => {
      try {
        const rows = await adminApi.list(endpointOrigin(endpoint), token, revealNow)
        setTokens(rows)
        setTokenApi('ok')
      } catch (error) {
        // 404 = the hub runs without --auth-tokens: no table to manage here.
        if (error instanceof ApiError && error.status === 404) {
          setTokens([])
          setTokenApi('off')
          return
        }
        setTokenApi('err')
      }
    },
    [endpoint, token],
  )

  const refresh = useCallback(async (): Promise<RefreshResult> => {
    setBusy(true)
    const client = clientFor(endpoint, token)
    try {
      const [status, roster, history, ledger, channels] = await Promise.all([
        client.status(),
        client.peers(),
        client.history(40),
        client.tasks(40),
        client.groups(),
      ])
      setPeers(roster.peers ?? [])
      setHistoryLimit(typeof status.historyLimit === 'number' ? status.historyLimit : null)
      setMessages(history.messages ?? [])
      setTasks(ledger.tasks ?? [])
      setGroups(channels.groups ?? [])
      setConn('ok')
      window.localStorage.setItem(ENDPOINT_KEY, endpoint)
      window.localStorage.setItem(TOKEN_KEY, token)
      await loadTokens(revealRef.current)
      return { ok: true }
    } catch (error) {
      setConn('err')
      return { ok: false, error: messageOf(error) }
    } finally {
      setBusy(false)
    }
  }, [clientFor, endpoint, loadTokens, token])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const online = useMemo(() => peers.filter((p) => p.connected).length, [peers])

  const connect = useCallback(async (): Promise<void> => {
    const id = showToast({
      title: '正在连接 hub…',
      description: endpoint,
      status: 'loading',
      duration: 0,
    })
    const result = await refresh()
    if (result.ok) {
      updateToast(id, {
        title: '已连接 hub',
        description: `${peers.length} 个 peer · ${tasks.length} 个任务`,
        status: 'success',
        duration: 3000,
      })
      return
    }
    updateToast(id, {
      title: '连接失败',
      description: `${result.error ?? ''} · 检查 hub 是否启动、endpoint 与 token 是否正确`,
      status: 'error',
      duration: 7000,
    })
  }, [endpoint, peers.length, refresh, showToast, tasks.length, updateToast])

  const toggleReveal = useCallback((): void => {
    const next = !reveal
    setReveal(next)
    revealRef.current = next
    void loadTokens(next)
  }, [loadTokens, reveal])

  const issueToken = useCallback(async (): Promise<void> => {
    const peer = formPeer.trim()
    if (peer === '') {
      showToast({
        title: '缺少 peer id',
        description: '形如 zhangsan 或 zhangsan.kimi（人.agent 便于区分同一人的多个 agent）',
        status: 'error',
      })
      return
    }
    setIssuing(true)
    try {
      const created = await adminApi.add(endpointOrigin(endpoint), token, {
        peer,
        role: formRole,
        ...(formOwner.trim() === '' ? {} : { owner: formOwner.trim() }),
      })
      showToast({
        title: `已签发 ${created.peer ?? peer}`,
        description: `${created.role ?? formRole} · ${created.token ?? ''}`,
        status: 'success',
        duration: 10_000,
        action: {
          label: '复制 token',
          onClick: () => {
            void copyText(created.token ?? '').then((ok) => {
              if (!ok) {
                showToast({
                  title: '复制失败',
                  description: '点「明/打码」显示明文后手动复制',
                  status: 'error',
                })
              }
            })
          },
        },
      })
      setFormPeer('')
      setFormOwner('')
      setInvite(created)
      await loadTokens(revealRef.current)
    } catch (error) {
      showToast({ title: '签发失败', description: messageOf(error), status: 'error' })
    } finally {
      setIssuing(false)
    }
  }, [endpoint, formOwner, formPeer, formRole, loadTokens, showToast, token])

  const revokeToken = useCallback(
    async (peer: string): Promise<void> => {
      setPendingRevoke(null)
      try {
        const removed = await adminApi.remove(endpointOrigin(endpoint), token, peer)
        showToast({
          title: removed ? `已吊销 ${peer}` : `未找到 ${peer} 的 token`,
          description: removed ? '该成员需要新 token 才能再连接' : '列表可能已过期，刷新后重试',
          status: removed ? 'success' : 'info',
        })
        await loadTokens(revealRef.current)
      } catch (error) {
        showToast({ title: '吊销失败', description: messageOf(error), status: 'error' })
      }
    },
    [endpoint, loadTokens, showToast, token],
  )

  const copyToken = useCallback(
    (text: string): void => {
      void copyText(text).then((ok) => {
        showToast({
          title: ok ? '已复制 token' : '复制失败',
          description: ok ? '粘贴给成员即可' : '点「明/打码」显示明文后手动复制',
          status: ok ? 'success' : 'error',
          duration: 2600,
        })
      })
    },
    [showToast],
  )

  const peerColumns = useMemo<Array<TableColumn<PeerRow>>>(
    () => [
      {
        key: 'id',
        header: 'peer',
        sortable: true,
        width: '200px',
        cell: (row) => (
          <div className="cell-stack">
            <span className="cell-mono">{row.id}</span>
            {row.alias !== undefined && row.alias !== '' ? (
              <span className="cell-dim">{row.alias}</span>
            ) : null}
          </div>
        ),
      },
      {
        key: 'connected',
        header: '状态',
        width: '92px',
        sortable: true,
        sortValue: (row) => (row.connected ? 1 : 0),
        cell: (row) => (
          <span className={`pill ${row.connected ? 'done' : ''}`}>
            {row.connected ? 'online' : 'offline'}
          </span>
        ),
      },
      {
        key: 'clientName',
        header: 'client',
        cell: (row) => (
          <div className="cell-stack">
            <span>{row.clientName ?? '—'}</span>
            {row.clientVersion !== undefined ? (
              <span className="cell-dim">{row.clientVersion}</span>
            ) : null}
          </div>
        ),
      },
      {
        key: 'clientIps',
        header: '来源',
        width: '140px',
        cell: (row) => (
          <div className="cell-stack">
            <span className="cell-mono">{row.clientIps?.join(', ') ?? '—'}</span>
            {row.anonymous === true ? <span className="cell-dim">walk-in 未认领</span> : null}
          </div>
        ),
      },
      {
        key: 'lastSeenMs',
        header: '最近活动',
        width: '104px',
        sortable: true,
        cell: (row) => <span className="cell-dim">{relTime(row.lastSeenMs)}</span>,
      },
    ],
    [],
  )

  const tokenColumns = useMemo<Array<TableColumn<TokenRow>>>(
    () => [
      { key: 'peer', header: 'peer', sortable: true, width: '180px', cell: (row) => <span className="cell-mono">{row.peer}</span> },
      {
        key: 'role',
        header: '角色',
        width: '104px',
        sortable: true,
        cell: (row) => <span className={`pill ${row.role}`}>{row.role}</span>,
      },
      { key: 'owner', header: '归属人', width: '120px', cell: (row) => <span>{row.owner ?? '—'}</span> },
      {
        key: 'token',
        header: 'token',
        cell: (row) => <span className="cell-mono cell-dim">{row.token}</span>,
      },
      {
        key: 'actions',
        header: '',
        width: '196px',
        align: 'right',
        cell: (row) =>
          pendingRevoke === row.peer ? (
            <div className="cell-actions">
              <Button size="sm" variant="ghost" onClick={() => setPendingRevoke(null)}>
                取消
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void revokeToken(row.peer)}>
                确认吊销
              </Button>
            </div>
          ) : (
            <div className="cell-actions">
              <Button size="sm" variant="ghost" onClick={() => copyToken(row.token)}>
                复制
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPendingRevoke(row.peer)}>
                吊销
              </Button>
            </div>
          ),
      },
    ],
    [copyToken, pendingRevoke, revokeToken],
  )

  const taskColumns = useMemo<Array<TableColumn<TaskRow>>>(
    () => [
      {
        key: 'status',
        header: '状态',
        width: '96px',
        sortable: true,
        cell: (row) => <span className={`pill ${row.status}`}>{row.status}</span>,
      },
      {
        key: 'from',
        header: '流向',
        width: '180px',
        sortable: true,
        cell: (row) => (
          <div className="cell-stack">
            <span className="cell-mono">
              {row.from} → {row.to}
            </span>
            <span className="cell-dim">
              {row.threadId !== undefined ? `thread ${row.threadId}` : clockTime(row.createdAt)}
              {typeof row.timeoutMs === 'number' ? ` · sla ${row.timeoutMs}ms` : ''}
            </span>
          </div>
        ),
      },
      {
        key: 'prompt',
        header: '任务',
        cell: (row) => (
          <span title={row.prompt}>{row.prompt === '' ? '—' : row.prompt}</span>
        ),
      },
      {
        key: 'acks',
        header: 'ack 时间线',
        width: '280px',
        cell: (row) => {
          const acks = row.acks ?? []
          const shown = acks.slice(-3)
          return (
            <div className="cell-actions" style={{ justifyContent: 'flex-start', flexWrap: 'wrap' }}>
              {shown.length === 0 ? <span className="cell-dim">等待 ack</span> : null}
              {shown.map((ack) => (
                <span
                  className={`pill ${ack.status}`}
                  key={`${row.id}-${ack.ts}-${ack.from}`}
                  title={ack.note ?? `${ack.from} · ${clockTime(ack.ts)}`}
                >
                  {ack.from}: {ack.status}
                  {typeof ack.progress === 'number' ? ` ${ack.progress}%` : ''}
                  {ack.applied === false ? ' (ignored)' : ''}
                </span>
              ))}
              {acks.length > shown.length ? (
                <span className="cell-dim">+{acks.length - shown.length}</span>
              ) : null}
            </div>
          )
        },
      },
    ],
    [],
  )

  const groupColumns = useMemo<Array<TableColumn<GroupRow>>>(
    () => [
      { key: 'id', header: '群组', sortable: true, width: '180px', cell: (row) => <span className="cell-mono">{row.name ?? row.id}</span> },
      {
        key: 'members',
        header: '成员',
        cell: (row) => <span className="cell-mono">{row.members.join(', ')}</span>,
      },
      { key: 'createdBy', header: '创建者', width: '140px', align: 'right', cell: (row) => <span className="cell-dim">{row.createdBy ?? '—'}</span> },
    ],
    [],
  )

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="mark" aria-hidden>
            ACH
          </span>
          <span>
            <div className="name">agent-comm-hub 管理台</div>
            <div className="sub">远程运维控制台 · manager</div>
          </span>
        </div>
        <span className={`chip ${conn === 'ok' ? 'ok' : conn === 'err' ? 'err' : ''}`}>
          {conn === 'ok' ? '已连接' : conn === 'err' ? '连接异常' : '未连接'}
        </span>
        <span className="chip info">{token === '' ? 'local' : 'remote'}</span>
        <span className="spacer" />
        <div className="field">
          <label htmlFor="token">token</label>
          <Input
            id="token"
            type="password"
            placeholder="manager token"
            value={token}
            onChange={setToken}
            autoComplete="off"
            spellCheck={false}
            className="token-field"
          />
        </div>
        <div className="field">
          <label htmlFor="endpoint">endpoint</label>
          <Input
            id="endpoint"
            value={endpoint}
            onChange={setEndpoint}
            spellCheck={false}
            placeholder="http://127.0.0.1:18764/mcp"
            className="endpoint-field"
          />
        </div>
        <Button variant="primary" disabled={busy} onClick={() => void connect()}>
          {busy ? '连接中…' : '重新连接'}
        </Button>
      </header>

      <nav className="kpis" aria-label="overview">
        <a className="kpi" href="#roster">
          <span className="num">{online}</span>
          <span className="lbl">在线 / {peers.length} 花名册</span>
        </a>
        <a className="kpi" href="#tokens">
          <span className="num">{tokenApi === 'off' ? '–' : tokens.length}</span>
          <span className="lbl">已签发 token</span>
        </a>
        <a className="kpi" href="#tasks">
          <span className="num">{tasks.length}</span>
          <span className="lbl">任务台账</span>
        </a>
        <a className="kpi" href="#groups">
          <span className="num">{groups.length}</span>
          <span className="lbl">群组</span>
        </a>
        <a className="kpi" href="#feed">
          <span className="num">{messages.length}</span>
          <span className="lbl">消息尾迹</span>
        </a>
      </nav>

      <main className="workspace">
        <div className="col">
          <section className="panel" id="roster">
            <header>
              <h2>花名册</h2>
              <span className="hint">{online} 在线 / 共 {peers.length}</span>
            </header>
            <DataTable<PeerRow>
              rows={peers}
              columns={peerColumns}
              rowId={(row) => row.id}
              rowHeight={44}
              max={520}
              empty="连接 hub 后显示在线 peer"
            />
          </section>

          <section className="panel" id="tokens">
            <header>
              <h2>成员与令牌</h2>
              <span className="hint">
                {tokenApi === 'off'
                  ? '本地模式不提供 token 管理'
                  : '一人一 token = 一个 peer'}
              </span>
              <div className="tools">
                <Button size="sm" variant="ghost" disabled={tokenApi === 'off'} onClick={toggleReveal}>
                  {reveal ? '打码' : '明文'}
                </Button>
              </div>
            </header>
            {tokenApi === 'off' ? (
              <div className="empty">
                远程模式（<code>--auth-tokens</code>）下才能在此签发 token
              </div>
            ) : (
              <>
                <div className="form-row">
                  <Input
                    className="form-field"
                    placeholder="peer id（zhangsan 或 zhangsan.kimi）"
                    value={formPeer}
                    onChange={setFormPeer}
                    spellCheck={false}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void issueToken()
                    }}
                  />
                  <Select value={formRole} onValueChange={setFormRole} className="form-role">
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="agent">agent</SelectItem>
                      <SelectItem value="manager">manager</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input
                    className="form-field"
                    placeholder="归属人（可选）"
                    value={formOwner}
                    onChange={setFormOwner}
                    spellCheck={false}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void issueToken()
                    }}
                  />
                  <Button variant="primary" size="sm" disabled={issuing} onClick={() => void issueToken()}>
                    {issuing ? '签发中…' : '签发'}
                  </Button>
                </div>
                <DataTable<TokenRow>
                  rows={tokens}
                  columns={tokenColumns}
                  rowId={(row) => row.peer}
                  rowHeight={44}
                  max={360}
                  empty={
                    tokenApi === 'err'
                      ? 'token 列表读取失败 · 检查 token 是否为 manager 角色'
                      : '还没有 token · 用上方表单签发第一枚'
                  }
                />
              </>
            )}
          </section>

          <section className="panel" id="tasks">
            <header>
              <h2>任务台账</h2>
              <span className="hint">pending → accepted → working → done · 终态锁定</span>
            </header>
            <DataTable<TaskRow>
              rows={tasks}
              columns={taskColumns}
              rowId={(row) => row.id}
              rowHeight={52}
              max={560}
              empty="暂无任务 · agent 用 bridge_task 派活后出现"
            />
          </section>
        </div>

        <div className="col">
          <section className="panel" id="identity">
            <header>
              <h2>身份与接入</h2>
              <span className="hint">token 决定 peer</span>
            </header>
            <div className="flow">
              <div className="node">
                <b>人 / 机器</b>
                <span>A · B · C</span>
              </div>
              <div className="arrow" aria-hidden>
                →
              </div>
              <div className="node">
                <b>专属 token</b>
                <span>zhangsan / lisi</span>
              </div>
              <div className="arrow" aria-hidden>
                →
              </div>
              <div className="node">
                <b>独立 peer</b>
                <span>信箱隔离</span>
              </div>
            </div>
            <div className="note">
              规则：<code>token</code> 决定 peer，不是 clientInfo 名。A 发给 B 时 C 收不到；全员用{' '}
              <code>to:&quot;all&quot;</code>，小圈子用群组。本地无 token 时连{' '}
              <code>127.0.0.1</code>。
            </div>
            {invite === null ? null : (
              <>
                <div className="snippet-bar">
                  <span className="hint">把这段配置发给 {invite.peer}；token 只显示这一次</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      void copyText(buildMcpConfig(invite, mcpUrl(endpoint))).then((ok) => {
                        showToast({
                          title: ok ? `已复制 ${invite.peer} 的 MCP 配置` : '复制失败',
                          description: ok ? '粘贴给成员即可' : '手动选中下方文本复制',
                          status: ok ? 'success' : 'error',
                          duration: 2800,
                        })
                      })
                    }}
                  >
                    复制 MCP 配置
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setInvite(null)}>
                    收起
                  </Button>
                </div>
                <pre className="snippet" tabIndex={0}>
                  {buildMcpConfig(invite, mcpUrl(endpoint))}
                </pre>
              </>
            )}
          </section>

          <section className="panel" id="groups">
            <header>
              <h2>群组</h2>
              <span className="hint">频道内互发</span>
            </header>
            <DataTable<GroupRow>
              rows={groups}
              columns={groupColumns}
              rowId={(row) => row.id}
              rowHeight={44}
              max={320}
              empty="暂无群组"
            />
          </section>

          <section className="panel" id="feed">
            <header>
              <h2>消息尾迹</h2>
              <span className="hint">最近 {messages.length} 条</span>
            </header>
            <ul className="feed">
              {messages.length === 0 ? (
                <li className="empty">—</li>
              ) : (
                messages.map((m) => (
                  <li key={m.id}>
                    <div className="meta">
                      <span
                        className={`pill ${m.kind === 'task' ? 'timeout' : m.kind === 'ack' ? 'done' : ''}`}
                      >
                        {m.kind}
                      </span>
                      <span>
                        {m.from} → {m.to}
                      </span>
                      {m.threadId !== undefined ? <span>thread {m.threadId}</span> : null}
                      <span>{clockTime(m.ts)}</span>
                    </div>
                    <div className="body">
                      {typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}
                    </div>
                  </li>
                ))
              )}
            </ul>
            <footer>
              {conn === 'ok'
                ? `hub 已连接 · 5s 轮询${historyLimit === null ? '' : ` · 历史上限 ${historyLimit}`}`
                : '等待连接…'}
            </footer>
          </section>
        </div>
      </main>

      <AnimatedToastStack
        toasts={toasts}
        position="bottom-right"
        placement="fixed"
        fixed
        maxVisible={3}
        onDismiss={dismissToast}
      />
    </div>
  )
}
