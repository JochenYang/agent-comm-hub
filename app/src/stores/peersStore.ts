import { create } from 'zustand'
import { tauri, type Peer, type RosterRecord } from '@/lib/tauri'
import { serializeError } from '@/lib/serializeError'
import { SELF_PEER_ID } from '@/lib/self'
import { pushToast } from '@/stores/toastStore'

/**
 * Roster store — zustand global singleton.
 *
 * Data-source priority:
 *   1. Real-time: hub SSE `hub:peers` (peers_changed pushes the full roster) — the primary channel;
 *   2. Compensation: bridge_peers polling (10s, fallback for lost SSE events / disconnect windows);
 *   3. Restore: roster_list (all SQLite-known peers, incl. offline, restoring the list from before a restart).
 * Real-time data wins for the same id; online peers sort first, the rest by id.
 * Online-state transitions are recorded as appended PeerActivity entries; display (toast dedup/throttle) is decided by the UI.
 */

export interface PeerActivity {
  seq: number
  peerId: string
  /** true = came online, false = went offline. */
  online: boolean
  ts: number
}

interface PeersState {
  /** Merged full roster (real-time ∪ local roster, already sorted). */
  peers: Peer[]
  loading: boolean
  error: string | null
  /** Online/offline transition events (append-only, keeps the latest 20; seq is monotonic for UI dedup). */
  activity: PeerActivity[]
  refresh: () => Promise<void>
  /** Rename: at least one of alias or newId must be given. Empty alias = clear; newId = an admin
   * true rename (re-key, migrating conversation/mailbox/history), invalidating the old id's keys in this store. */
  renamePeer: (peer: string, alias?: string, newId?: string) => Promise<boolean>
  /** Kick (admin). Also returns failure when the target doesn't exist. */
  removePeer: (peer: string) => Promise<boolean>
  /** Forget an offline known peer from the local list only (the hub is untouched; roster_forget). */
  forgetPeer: (peer: string) => Promise<boolean>
}

/** Real-time snapshot poll interval — the primary channel is SSE push (hub:peers); polling is only a disconnect fallback. */
const POLL_INTERVAL_MS = 10_000
const ACTIVITY_KEEP = 20

interface StoreShape extends PeersState {
  /** The latest real-time snapshot (id → peer), real-time data takes priority over the local roster. */
  live: Record<string, Peer>
  /** SQLite roster_list-restored known peers (offline kept too). */
  rosterLocal: Record<string, Peer>
  /** Peer ids suppressed within this session after a kick/forget, preventing a snapshot from merging the "deleted"
   *  peer back in (an online auto re-registration / residual rosterLocal row would otherwise resurrect it).
   *  Exists only for this app run; after a restart, everything reloads from the hub's truth. */
  kickedSuppress: Set<string>
}

let activitySeq = 0
/** Whether a real-time snapshot has been received yet (P2-1: the first snapshot only sets a baseline, see applyLiveRoster). */
let liveBaselineSeen = false

/** Merge real-time ∪ local (real-time wins), online first, then by id.
 *  After a real-time snapshot has been received, peers that only exist in the local roster always display as offline —
 *  absent from the hub snapshot = not online; the SQLite online column only serves as a cold-start baseline (preserving
 *  the stored value for the instant before the first frame), otherwise stale rows (e.g. historical peers after a hub port
 *  change) would stay "online" forever. */
function mergePeers(
  live: Record<string, Peer>,
  rosterLocal: Record<string, Peer>,
  kickedSuppress: ReadonlySet<string>,
): Peer[] {
  const byId = new Map<string, Peer>()
  for (const p of Object.values(rosterLocal)) {
    if (kickedSuppress.has(p.id)) continue
    byId.set(p.id, liveBaselineSeen ? { ...p, connected: false } : p)
  }
  for (const p of Object.values(live)) {
    if (kickedSuppress.has(p.id)) continue
    byId.set(p.id, p)
  }
  return [...byId.values()].sort((a, b) => {
    if (a.connected !== b.connected) return a.connected ? -1 : 1
    return a.id.localeCompare(b.id)
  })
}

/** Hub incremental-field guard: absent means none (never writes undefined, keeping object shape stable). */
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

/** SQLite roster row → Peer (for roster_list restore). */
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
  kickedSuppress: new Set(),

  refresh: async () => {
    set({ loading: true, error: null })
    try {
      const result = await tauri.invoke.bridgePeers()
      // Guard: the Rust side already unwraps the MCP envelope, but any future regression must not set peers to
      // undefined and crash PeersView at `peers.length` (a historical lesson).
      applyLiveRoster(Array.isArray(result?.peers) ? result.peers : [])
    } catch (e) {
      set({ error: serializeError(e) })
    } finally {
      set({ loading: false })
    }
  },

  renamePeer: async (peer, alias, newId) => {
    // Editing self: don't pass a peer (hub semantics = edit own alias); editing others: the admin identity always has
    // permission, and errors pass through transparently when the hub rejects a non-admin config (shown via toast).
    const target = peer === SELF_PEER_ID ? null : peer
    try {
      await tauri.invoke.bridgeRename(target, alias ?? null, newId)
      if (newId !== undefined && newId !== peer) {
        // The id changed: both live and local roster are keyed by the old id, so the old key is removed entirely;
        // the new id's data is backfilled by the subsequent refresh (real-time snapshot / SQLite rebuild).
        set((s) => {
          const live = { ...s.live }
          const rosterLocal = { ...s.rosterLocal }
          delete live[peer]
          delete rosterLocal[peer]
          return { live, rosterLocal, peers: mergePeers(live, rosterLocal, s.kickedSuppress) }
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
        // The hub explicitly answered the target doesn't exist (kicked:false, peerId:null).
        set({ error: `bridge: peer ${peer} not found` })
        pushToast('error', `bridge: peer ${peer} not found`)
        return false
      }
      // Immediately remove from both live and local roster (P1-2: deleting only live lets mergePeers merge it back from
      // rosterLocal, so a kicked known peer would stay in the offline·known group all session).
      // Then record the id in kickedSuppress: if the kicked agent auto re-registers, a poll/SSE snapshot would merge it
      // back in ("deleted yet resurrected"); once suppressed it won't show this session, and after a restart it reloads
      // from the hub snapshot (the hub side has truly removed that peer).
      set((s) => {
        const live = { ...s.live }
        const rosterLocal = { ...s.rosterLocal }
        delete live[peer]
        delete rosterLocal[peer]
        const kickedSuppress = new Set(s.kickedSuppress)
        kickedSuppress.add(peer)
        return { live, rosterLocal, kickedSuppress, peers: mergePeers(live, rosterLocal, kickedSuppress) }
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
        // Same as kickedSuppress: a local-only forget only applies to offline known peers; if it's still online on the hub,
        // a snapshot would merge it back, so it's likewise suppressed from display this session.
        const kickedSuppress = new Set(s.kickedSuppress)
        kickedSuppress.add(peer)
        return { rosterLocal, kickedSuppress, peers: mergePeers(s.live, rosterLocal, kickedSuppress) }
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

/** Apply a real-time roster: update the live map, detect online transitions, and recompute the merged list.
 *  Shared by the refresh poll and the hub:peers SSE listener (same transition-detection semantics). */
function applyLiveRoster(rawList: unknown): void {
  if (!Array.isArray(rawList)) return
  const live: Record<string, Peer> = {}
  for (const raw of rawList as Peer[]) {
    if (typeof raw?.id !== 'string' || raw.id === '') continue
    live[raw.id] = sanitizePeer(raw)
  }
  usePeersStore.setState((s) => {
    // P2-1: the first real-time snapshot only builds a baseline and produces no online/offline events. SQLite stale
    // online=true rows all flip to offline at the first cold-start snapshot; if transitions were detected as usual,
    // every peer would toast a "went offline". Transition detection starts with the following snapshots.
    if (!liveBaselineSeen) {
      liveBaselineSeen = true
      return { live, peers: mergePeers(live, s.rosterLocal, s.kickedSuppress) }
    }
    const prevOnline = new Map(mergePeers(s.live, s.rosterLocal, s.kickedSuppress).map((p) => [p.id, p.connected]))
    const now = Date.now()
    const events: PeerActivity[] = []
    for (const p of Object.values(live)) {
      const before = prevOnline.get(p.id)
      // Only a peer that appeared before (incl. offline rows restored from the local roster) and flipped state counts as a
      // transition; a peer appearing for the first time gets no notice (a cold-start full snapshot isn't a greeting round).
      if (before !== undefined && before !== p.connected) {
        events.push({ seq: ++activitySeq, peerId: p.id, online: p.connected, ts: now })
      }
    }
    return {
      live,
      peers: mergePeers(live, s.rosterLocal, s.kickedSuppress),
      ...(events.length > 0
        ? { activity: [...s.activity, ...events].slice(-ACTIVITY_KEEP) }
        : {})
    }
  })
}

/** Merge SQLite-known peers into rosterLocal (only fills gaps, never overwrites existing real-time data). */
function applyLocalRoster(rows: unknown): void {
  if (!Array.isArray(rows)) return
  usePeersStore.setState((s) => {
    const rosterLocal = { ...s.rosterLocal }
    for (const r of rows as RosterRecord[]) {
      if (typeof r?.peer_id !== 'string' || r.peer_id === '') continue
      rosterLocal[r.peer_id] = rosterRecordToPeer(r)
    }
    return { rosterLocal, peers: mergePeers(s.live, rosterLocal, s.kickedSuppress) }
  })
}

// ---- Module-level background tasks (started once, shared across the whole app) ----

// Real-time primary channel: hub SSE peers_changed → hub:peers (payload is the full roster).
void tauri.event.onHubPeers((peers) => {
  applyLiveRoster(peers)
})

// Startup restore: merge SQLite-known peers (incl. offline) first — the list from before a restart is immediately
// visible, and later real-time snapshots override per id (online state follows the hub).
void tauri.invoke
  .rosterList()
  .then(applyLocalRoster)
  .catch(() => undefined) // hub not running / store unavailable: keep an empty list

// Compensation poll (10s; the primary channel is SSE push, this only covers lost events / SSE reconnect windows).
void usePeersStore.getState().refresh()
window.setInterval(() => {
  void usePeersStore.getState().refresh()
}, POLL_INTERVAL_MS)
