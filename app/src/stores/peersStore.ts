import { create } from 'zustand'
import { tauri, type Peer, type RosterRecord } from '@/lib/tauri'
import { serializeError } from '@/lib/serializeError'
import { SELF_PEER_ID } from '@/lib/self'
import { pushToast } from '@/stores/toastStore'

/**
 * 花名册 store —— zustand 全局单例。
 *
 * 数据来源优先级：
 *   1. 实时：hub SSE `hub:peers`（peers_changed 推完整花名册）——主通道；
 *   2. 补偿：bridge_peers 轮询（10s，SSE 事件丢失/断连窗口的兜底）；
 *   3. 恢复：roster_list（SQLite 全部已知 peer，含 offline，恢复重启前名单）。
 * 同一 id 实时数据优先；排序 online 在前、其余按 id。
 * online 状态迁移以 PeerActivity 追加记录，展示（toast 去重/防抖）由 UI 决定。
 */

export interface PeerActivity {
  seq: number
  peerId: string
  /** true = 上线，false = 下线。 */
  online: boolean
  ts: number
}

interface PeersState {
  /** 合并后的完整花名册（实时 ∪ 本地 roster，已排序）。 */
  peers: Peer[]
  loading: boolean
  error: string | null
  /** 上下线迁移事件（追加式，保留最近 20 条；seq 单调递增供 UI 去重）。 */
  activity: PeerActivity[]
  refresh: () => Promise<void>
  /** 重命名：alias 与 newId 至少给一个。alias 空串 = 清除；newId = 管理端
   * 真改名（re-key，迁移会话/邮箱/历史），旧 id 的键在本 store 内失效。 */
  renamePeer: (peer: string, alias?: string, newId?: string) => Promise<boolean>
  /** 踢人（管理端）。目标不存在时同样失败返回。 */
  removePeer: (peer: string) => Promise<boolean>
  /** 仅从本地名单忘掉一个 offline 已知 peer（不动 hub，roster_forget）。 */
  forgetPeer: (peer: string) => Promise<boolean>
}

/** 实时快照轮询间隔 —— 主通道是 SSE 推送（hub:peers），轮询只作断连补偿。 */
const POLL_INTERVAL_MS = 10_000
const ACTIVITY_KEEP = 20

interface StoreShape extends PeersState {
  /** 最近一次实时快照（id → peer），实时数据优先于本地 roster。 */
  live: Record<string, Peer>
  /** SQLite roster_list 恢复的已知 peer（offline 也保留）。 */
  rosterLocal: Record<string, Peer>
}

let activitySeq = 0
/** 是否已收到过实时快照（P2-1：首份快照只建基线，见 applyLiveRoster）。 */
let liveBaselineSeen = false

/** 合并实时 ∪ 本地（实时优先），online 在前、其余按 id。
 *  收到过实时快照后，仅存在于本地 roster 的 peer 一律按 offline 展示——
 *  hub 快照里没有 = 不在线；SQLite 的 online 列只作冷启动基线（首帧前的
 *  瞬间保留存储值），否则残留行（如换过 hub 端口的历史 peer）会永远"在线"。 */
function mergePeers(live: Record<string, Peer>, rosterLocal: Record<string, Peer>): Peer[] {
  const byId = new Map<string, Peer>()
  for (const p of Object.values(rosterLocal)) {
    byId.set(p.id, liveBaselineSeen ? { ...p, connected: false } : p)
  }
  for (const p of Object.values(live)) byId.set(p.id, p)
  return [...byId.values()].sort((a, b) => {
    if (a.connected !== b.connected) return a.connected ? -1 : 1
    return a.id.localeCompare(b.id)
  })
}

/** hub 增量字段防御：缺省即无（不写入 undefined，保持对象形状稳定）。 */
function sanitizePeer(raw: Peer): Peer {
  const p: Peer = { id: raw.id, connected: raw.connected === true }
  if (typeof raw.alias === 'string' && raw.alias !== '') p.alias = raw.alias
  if (typeof raw.clientName === 'string' && raw.clientName !== '') p.clientName = raw.clientName
  if (typeof raw.clientVersion === 'string' && raw.clientVersion !== '') {
    p.clientVersion = raw.clientVersion
  }
  if (typeof raw.lastSeenMs === 'number' && Number.isFinite(raw.lastSeenMs)) {
    p.lastSeenMs = raw.lastSeenMs
  }
  return p
}

/** SQLite roster 行 → Peer（roster_list 恢复用）。 */
function rosterRecordToPeer(r: RosterRecord): Peer {
  const p: Peer = { id: r.peer_id, connected: r.online }
  if (r.alias) p.alias = r.alias
  if (r.client_name) p.clientName = r.client_name
  if (r.client_version) p.clientVersion = r.client_version
  p.lastSeenMs = r.last_seen
  return p
}

export const usePeersStore = create<StoreShape>()((set, get) => ({
  peers: [],
  loading: false,
  error: null,
  activity: [],
  live: {},
  rosterLocal: {},

  refresh: async () => {
    set({ loading: true, error: null })
    try {
      const result = await tauri.invoke.bridgePeers()
      // 防御：Rust 侧已解包 MCP 信封，但任何未来回归都不应把 peers 置成
      // undefined 而让 PeersView 在 `peers.length` 处崩溃（历史教训）。
      applyLiveRoster(Array.isArray(result?.peers) ? result.peers : [])
    } catch (e) {
      set({ error: serializeError(e) })
    } finally {
      set({ loading: false })
    }
  },

  renamePeer: async (peer, alias, newId) => {
    // 改自己：不传 peer（hub 语义 = 改自身别名）；改别人：管理端身份恒有权限，
    // 非管理端配置被 hub 拒绝时错误透传（toast 展示）。
    const target = peer === SELF_PEER_ID ? null : peer
    try {
      await tauri.invoke.bridgeRename(target, alias ?? null, newId)
      if (newId !== undefined && newId !== peer) {
        // id 变了：live 与本地 roster 都按旧 id 键存，旧键整体过期移除，
        // 新 id 的数据由随后的 refresh（实时快照 / SQLite 重建）补上。
        set((s) => {
          const live = { ...s.live }
          const rosterLocal = { ...s.rosterLocal }
          delete live[peer]
          delete rosterLocal[peer]
          return { live, rosterLocal, peers: mergePeers(live, rosterLocal) }
        })
      }
      void get().refresh()
      return true
    } catch (e) {
      const msg = serializeError(e)
      set({ error: msg })
      pushToast('error', msg)
      return false
    }
  },

  removePeer: async (peer) => {
    try {
      const res = await tauri.invoke.bridgeUnregisterPeer(peer)
      if (res?.kicked === false) {
        // hub 明确回答目标不存在（kicked:false, peerId:null）。
        set({ error: `bridge: peer ${peer} not found` })
        pushToast('error', `bridge: peer ${peer} not found`)
        return false
      }
      // 立即从 live 与本地 roster 同时移除（P1-2：只删 live 会被 mergePeers 从
      // rosterLocal 并回，被踢的已知 peer 本会话内永远留在 offline·known 组）。
      set((s) => {
        const live = { ...s.live }
        const rosterLocal = { ...s.rosterLocal }
        delete live[peer]
        delete rosterLocal[peer]
        return { live, rosterLocal, peers: mergePeers(live, rosterLocal) }
      })
      void get().refresh()
      return true
    } catch (e) {
      const msg = serializeError(e)
      set({ error: msg })
      pushToast('error', msg)
      return false
    }
  },

  forgetPeer: async (peer) => {
    try {
      await tauri.invoke.rosterForget(peer)
      set((s) => {
        const rosterLocal = { ...s.rosterLocal }
        delete rosterLocal[peer]
        return { rosterLocal, peers: mergePeers(s.live, rosterLocal) }
      })
      return true
    } catch (e) {
      const msg = serializeError(e)
      set({ error: msg })
      pushToast('error', msg)
      return false
    }
  }
}))

/** 应用一份实时花名册：更新 live 映射、检测 online 迁移、重算合并列表。
 *  refresh 轮询与 hub:peers SSE 监听共用（迁移检测口径一致）。 */
function applyLiveRoster(rawList: unknown): void {
  if (!Array.isArray(rawList)) return
  const live: Record<string, Peer> = {}
  for (const raw of rawList as Peer[]) {
    if (typeof raw?.id !== 'string' || raw.id === '') continue
    live[raw.id] = sanitizePeer(raw)
  }
  usePeersStore.setState((s) => {
    // P2-1：首份实时快照只建立基线、不产生上下线事件。SQLite 里 stale
    // online=true 的行会在冷启动首个快照处集体翻转成 offline，照常检测迁移
    // 会每个 peer 弹一条"已离线"。之后的快照才做迁移检测。
    if (!liveBaselineSeen) {
      liveBaselineSeen = true
      return { live, peers: mergePeers(live, s.rosterLocal) }
    }
    const prevOnline = new Map(mergePeers(s.live, s.rosterLocal).map((p) => [p.id, p.connected]))
    const now = Date.now()
    const events: PeerActivity[] = []
    for (const p of Object.values(live)) {
      const before = prevOnline.get(p.id)
      // 只有此前出现过（含本地 roster 恢复的 offline 行）且状态翻转才算迁移；
      // 首次出现的 peer 不提示（冷启动全量快照不打一轮招呼）。
      if (before !== undefined && before !== p.connected) {
        events.push({ seq: ++activitySeq, peerId: p.id, online: p.connected, ts: now })
      }
    }
    return {
      live,
      peers: mergePeers(live, s.rosterLocal),
      ...(events.length > 0
        ? { activity: [...s.activity, ...events].slice(-ACTIVITY_KEEP) }
        : {})
    }
  })
}

/** SQLite 已知 peer 并入 rosterLocal（只补缺，不覆盖已有实时数据）。 */
function applyLocalRoster(rows: unknown): void {
  if (!Array.isArray(rows)) return
  usePeersStore.setState((s) => {
    const rosterLocal = { ...s.rosterLocal }
    for (const r of rows as RosterRecord[]) {
      if (typeof r?.peer_id !== 'string' || r.peer_id === '') continue
      rosterLocal[r.peer_id] = rosterRecordToPeer(r)
    }
    return { rosterLocal, peers: mergePeers(s.live, rosterLocal) }
  })
}

// ---- 模块级后台任务（启动一次，全 app 共享）----

// 实时主通道：hub SSE peers_changed → hub:peers（payload 即完整花名册）。
void tauri.event.onHubPeers((peers) => {
  applyLiveRoster(peers)
})

// 启动恢复：SQLite 已知 peer（含 offline）先并入 —— 重启前的名单立即可见，
// 之后到达的实时快照按 id 覆盖（online 状态以 hub 为准）。
void tauri.invoke
  .rosterList()
  .then(applyLocalRoster)
  .catch(() => undefined) // hub 未起 / store 不可用：保持空名单

// 补偿轮询（10s；主通道是 SSE 推送，这里只兜底事件丢失 / SSE 断连重连窗口）。
void usePeersStore.getState().refresh()
window.setInterval(() => {
  void usePeersStore.getState().refresh()
}, POLL_INTERVAL_MS)
