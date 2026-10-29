/**
 * Multi-peer smoke test for agent-comm-hub: three simulated agents (mavis,
 * claude, opencode) each with their own MCP session, exercising registration,
 * chat routing, sender-filtered waits, task+ack routing, broadcast, status,
 * history, duplicate rejection, unregistration, and error paths.
 *
 * Run after `pnpm run build:test`:
 *   node test/smoke.mjs
 */

import { startHub } from './entry.mjs'
import { tmpdir } from 'node:os'
import { readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'

const PORT = 18998
const BASE = `http://127.0.0.1:${PORT}/mcp`

let failures = 0
let checks = 0
function check(name, ok, detail = '') {
  checks++
  if (ok) {
    console.log(`  ok    ${name}`)
  } else {
    failures++
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** Reject anything a strict tool registry (e.g. DSH) would reject as lossy JSON. */
function assertLosslessJson(value, path = 'root') {
  if (value === undefined) throw new Error(`undefined at ${path}`)
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`non-finite number at ${path}`)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertLosslessJson(item, `${path}[${index}]`))
    return
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) throw new Error(`undefined value at ${path}.${key}`)
      assertLosslessJson(item, `${path}.${key}`)
    }
    return
  }
  throw new Error(`non-JSON value of type ${typeof value} at ${path}`)
}

/** One simulated agent: an MCP session with rpc helpers and a result parser.
 * `token` enables remote-auth mode (Authorization: Bearer). */
function makeClient(name, base = BASE, token) {
  const headers = token === undefined ? {} : { Authorization: `Bearer ${token}` }
  let id = 0
  return {
    name,
    sessionId: () => headers['Mcp-Session-Id'],
    async rpc(method, params) {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, ...(params !== undefined ? { params } : {}) }),
      })
      const text = await res.text()
      const sessionHeader = res.headers.get('mcp-session-id')
      if (sessionHeader) headers['Mcp-Session-Id'] = sessionHeader
      let json = null
      try { json = JSON.parse(text) } catch { /* non-JSON */ }
      return { status: res.status, json, text }
    },
    async init() {
      const r = await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: this.name, version: '1' } })
      if (r.json?.result?.protocolVersion !== '2025-06-18') throw new Error(`${this.name} initialize failed: ${r.text}`)
      await this.rpc('notifications/initialized')
    },
    /** Call a bridge tool; returns the parsed result object, asserting lossless JSON. */
    async call(tool, args) {
      const r = await this.rpc('tools/call', { name: tool, arguments: args ?? {} })
      const text = r.json?.result?.content?.[0]?.text
      const parsed = JSON.parse(text ?? '{}')
      assertLosslessJson(parsed)
      if (r.json?.result?.isError) throw new Error(`${this.name} ${tool}: ${text}`)
      return parsed
    },
    /** Like call, but returns the parsed result even for error results. */
    async callRaw(tool, args) {
      const r = await this.rpc('tools/call', { name: tool, arguments: args ?? {} })
      const text = r.json?.result?.content?.[0]?.text
      const parsed = JSON.parse(text ?? '{}')
      assertLosslessJson(parsed)
      return parsed
    },
    async register(peerId) {
      return this.call('bridge_register', { peerId })
    },
  }
}

const hub = startHub({ port: PORT, waitTimeoutMs: 3000, maxQueue: 20, historyLimit: 50, managerPeers: ['mavis'] }, { info: () => {}, warn: () => {} })

try {
  const mavis = makeClient('mavis')
  const claude = makeClient('claude')
  const opencode = makeClient('opencode')
  const stranger = makeClient('stranger')
  await Promise.all([mavis.init(), claude.init(), opencode.init(), stranger.init()])

  console.log('== registration ==')
  const reg = await mavis.register('mavis')
  check('mavis registers', reg.ok === true && reg.peerId === 'mavis' && reg.peers.includes('mavis'), JSON.stringify(reg))
  await claude.register('claude')
  await opencode.register('opencode')
  const regAgain = await mavis.register('mavis')
  check('re-register same id same session is idempotent', regAgain.ok === true, JSON.stringify(regAgain))

  const dup = await stranger.rpc('tools/call', { name: 'bridge_register', arguments: { peerId: 'mavis' } })
  const dupResult = JSON.parse(dup.json?.result?.content?.[0]?.text ?? '{}')
  check('duplicate peerId from another connection rejected', dup.json?.result?.isError === true && /already registered/.test(dupResult.error ?? ''), JSON.stringify(dupResult))

  const rename = await stranger.rpc('tools/call', { name: 'bridge_register', arguments: { peerId: 'stranger2' } })
  const renameResult = JSON.parse(rename.json?.result?.content?.[0]?.text ?? '{}')
  check('session can claim a new id', rename.json?.result?.isError !== true && renameResult.ok === true, JSON.stringify(renameResult))
  await stranger.call('bridge_unregister')

  const unregistered = await stranger.callRaw('bridge_chat', { to: 'mavis', message: 'hi' })
  check('unregistered call rejected', unregistered.error !== undefined, JSON.stringify(unregistered))

  console.log('== chat routing ==')
  await mavis.call('bridge_chat', { to: 'claude', message: 'hello claude, from mavis' })
  const claudeGot = await claude.call('bridge_wait', { timeoutMs: 3000 })
  check('claude receives mavis chat', claudeGot.type === 'message' && claudeGot.message.from === 'mavis' && claudeGot.message.content === 'hello claude, from mavis', JSON.stringify(claudeGot))

  await claude.call('bridge_chat', { to: 'mavis', message: 'hi mavis' })
  const mavisGot = await mavis.call('bridge_wait', { timeoutMs: 3000 })
  check('mavis receives claude reply', mavisGot.type === 'message' && mavisGot.message.from === 'claude' && mavisGot.message.content === 'hi mavis', JSON.stringify(mavisGot))

  console.log('== sender-filtered wait ==')
  const filteredWait = mavis.call('bridge_wait', { from: 'claude', timeoutMs: 3000 }) // no claude message coming; registers waiter
  await opencode.call('bridge_chat', { to: 'mavis', message: 'opencode note' })
  const filteredResult = await filteredWait
  check('from-filter ignores other senders', filteredResult.type === 'timeout', JSON.stringify(filteredResult))
  const drained = await mavis.call('bridge_poll', { from: 'opencode' })
  check('filtered poll drains the queued message', drained.messages.length === 1 && drained.messages[0].content === 'opencode note', JSON.stringify(drained))

  // P0 regression: wait must take ONE queued message, not drain the mailbox.
  // A multi-message burst used to leave only the first message deliverable.
  console.log('== multi-message queue + sequential wait ==')
  await opencode.call('bridge_chat', { to: 'mavis', message: 'burst-1' })
  await opencode.call('bridge_chat', { to: 'mavis', message: 'burst-2' })
  await claude.call('bridge_chat', { to: 'mavis', message: 'burst-3' })
  const w1 = await mavis.call('bridge_wait', { timeoutMs: 2000 })
  const w2 = await mavis.call('bridge_wait', { timeoutMs: 2000 })
  const w3 = await mavis.call('bridge_wait', { timeoutMs: 2000 })
  const burstBodies = [w1, w2, w3].map(w => (w.type === 'message' ? w.message.content : null))
  check(
    'sequential waits deliver every queued message (no mailbox drain)',
    JSON.stringify(burstBodies) === JSON.stringify(['burst-1', 'burst-2', 'burst-3']),
    JSON.stringify(burstBodies),
  )
  // from-filtered wait must not consume other senders' leftovers either.
  await opencode.call('bridge_chat', { to: 'mavis', message: 'keep-from-opencode' })
  await claude.call('bridge_chat', { to: 'mavis', message: 'keep-from-claude' })
  const fromCl = await mavis.call('bridge_wait', { from: 'claude', timeoutMs: 2000 })
  const fromOp = await mavis.call('bridge_wait', { from: 'opencode', timeoutMs: 2000 })
  check(
    'from-filtered wait takes only that sender and leaves the rest',
    fromCl.type === 'message' && fromCl.message.content === 'keep-from-claude'
      && fromOp.type === 'message' && fromOp.message.content === 'keep-from-opencode',
    JSON.stringify({ fromCl, fromOp }),
  )

  console.log('== task + ack routing ==')
  await claude.call('bridge_task', { to: 'mavis', prompt: 'review the hub protocol', deliverable: 'short summary' })
  const task = await mavis.call('bridge_wait', { timeoutMs: 3000 })
  check('mavis receives task', task.type === 'message' && task.message.kind === 'task' && task.message.content.prompt === 'review the hub protocol' && task.message.content.deliverable === 'short summary', JSON.stringify(task))
  await mavis.call('bridge_ack', { ref: task.message.id, status: 'accepted', note: 'on it' })
  const ack = await claude.call('bridge_wait', { timeoutMs: 3000 })
  check('ack routed back to original sender', ack.type === 'message' && ack.message.kind === 'ack' && ack.message.to === 'claude' && ack.message.ref === task.message.id && ack.message.content.status === 'accepted', JSON.stringify(ack))

  // Task ledger: status is queryable without scanning history.
  const statusAfterAccept = await claude.call('bridge_task_status', { ref: task.message.id })
  check(
    'task ledger shows accepted after ack',
    statusAfterAccept.task?.id === task.message.id
      && statusAfterAccept.task?.status === 'accepted'
      && statusAfterAccept.task?.acks?.length === 1
      && statusAfterAccept.task?.acks[0]?.from === 'mavis'
      && statusAfterAccept.task?.acks[0]?.note === 'on it',
    JSON.stringify(statusAfterAccept),
  )
  const assigneeView = await mavis.call('bridge_task_status', { ref: task.message.id })
  check('assignee can read its own received task status', assigneeView.task?.status === 'accepted', JSON.stringify(assigneeView))
  await mavis.call('bridge_ack', { ref: task.message.id, status: 'done', note: 'summary ready' })
  const statusAfterDone = await claude.call('bridge_task_status', { ref: task.message.id })
  check(
    'task ledger reaches done and keeps the ack timeline',
    statusAfterDone.task?.status === 'done' && statusAfterDone.task?.acks?.length === 2,
    JSON.stringify(statusAfterDone),
  )
  const sentList = await claude.call('bridge_tasks', { role: 'sent' })
  check(
    'bridge_tasks role=sent lists the delegated task as done',
    sentList.tasks?.some(x => x.id === task.message.id && x.status === 'done'),
    JSON.stringify(sentList),
  )
  const recvList = await mavis.call('bridge_tasks', { role: 'received', status: 'done' })
  check(
    'bridge_tasks role=received+status filters the ledger',
    recvList.tasks?.length === 1 && recvList.tasks[0].id === task.message.id,
    JSON.stringify(recvList),
  )
  // wait({ref}) delivers only the matching ack, even if another chat is queued first.
  await claude.call('bridge_task', { to: 'mavis', prompt: 'second task for ref-wait' })
  const task2 = await mavis.call('bridge_wait', { timeoutMs: 3000 })
  await claude.call('bridge_chat', { to: 'mavis', message: 'noise before ack' })
  const waitAckPromise = claude.call('bridge_wait', { ref: task2.message.id, timeoutMs: 3000 })
  await mavis.call('bridge_poll') // drain noise so mavis can see task2
  await mavis.call('bridge_ack', { ref: task2.message.id, status: 'accepted' })
  const waitedAck = await waitAckPromise
  check(
    'wait({ref}) returns only the matching task ack',
    waitedAck.type === 'message' && waitedAck.message.kind === 'ack' && waitedAck.message.ref === task2.message.id,
    JSON.stringify(waitedAck),
  )
  // Drain leftovers (task2's later acks / noise) so the broadcast section
  // starts from a clean mailbox.
  await claude.call('bridge_poll')
  await mavis.call('bridge_poll')
  await opencode.call('bridge_poll')

  console.log('== task delivery bookkeeping (deliveredMs) ==')
  // The ledger row must exist BEFORE the message is routed: deliver() books
  // the first delivery time on the assignee row, and a ledger miss there left
  // deliveredMs empty for every task (waiter handoff and mailbox alike).
  const parkedWait = mavis.call('bridge_wait', { timeoutMs: 3000 }) // waiter first, message second
  await new Promise(resolve => setTimeout(resolve, 100)) // let the wait reach the hub before sending
  const handedTask = await claude.call('bridge_task', { to: 'mavis', prompt: 'handed to a live waiter' })
  const handedMsg = await parkedWait
  check('task sent to a parked waiter is handed over', handedMsg.type === 'message' && handedMsg.message.id === handedTask.id, JSON.stringify(handedMsg))
  const handedStatus = await claude.call('bridge_task_status', { ref: handedTask.id })
  const handedRow = handedStatus.task?.assignees?.find(a => a.peerId === 'mavis')
  check(
    'deliveredMs recorded for the waiter handoff',
    typeof handedRow?.deliveredMs === 'number' && handedRow.deliveredMs >= handedTask.ts,
    JSON.stringify(handedStatus.task?.assignees),
  )
  const queuedTask = await claude.call('bridge_task', { to: 'mavis', prompt: 'queued, no waiter parked' })
  const queuedStatus = await claude.call('bridge_task_status', { ref: queuedTask.id })
  const queuedRow = queuedStatus.task?.assignees?.find(a => a.peerId === 'mavis')
  check(
    'deliveredMs recorded for a task parked in the mailbox',
    typeof queuedRow?.deliveredMs === 'number' && queuedRow.deliveredMs >= queuedTask.ts,
    JSON.stringify(queuedStatus.task?.assignees),
  )
  const queuedDrained = await mavis.call('bridge_poll')
  check('the parked task is still delivered on poll', queuedDrained.messages.some(m => m.id === queuedTask.id), JSON.stringify(queuedDrained.messages.map(m => m.id)))

  console.log('== broadcast ==')
  await opencode.call('bridge_chat', { to: 'all', message: 'attention everyone' })
  const mavisBroadcast = await mavis.call('bridge_wait', { timeoutMs: 3000 })
  const claudeBroadcast = await claude.call('bridge_wait', { timeoutMs: 3000 })
  check('broadcast reaches mavis', mavisBroadcast.type === 'message' && mavisBroadcast.message.to === 'all' && mavisBroadcast.message.content === 'attention everyone', JSON.stringify(mavisBroadcast))
  check('broadcast reaches claude', claudeBroadcast.type === 'message' && claudeBroadcast.message.to === 'all' && claudeBroadcast.message.content === 'attention everyone', JSON.stringify(claudeBroadcast))
  const opencodeSelf = await opencode.call('bridge_poll')
  check('broadcast does not echo to sender', opencodeSelf.messages.length === 0, JSON.stringify(opencodeSelf))
  // Fan-out used to call remember() once per recipient — history held N copies
  // of the same id and manager SSE fired N times. Lock the once-per-message rule.
  const histAfterBc = await mavis.call('bridge_history', { peer: 'all', limit: 50 })
  const bcRows = histAfterBc.messages.filter(m => m.content === 'attention everyone')
  check('broadcast recorded exactly once in history', bcRows.length === 1, JSON.stringify(bcRows.map(m => ({ id: m.id, from: m.from }))))

  console.log('== status / peers / history ==')
  const status = await mavis.call('bridge_status')
  const peerIds = status.peers.map(p => p.id).sort()
  check('status lists 3 peers', JSON.stringify(peerIds) === JSON.stringify(['claude', 'mavis', 'opencode']), JSON.stringify(status))
  const peers = await opencode.call('bridge_peers')
  check('bridge_peers shows connected peers', peers.peers.length === 3 && peers.peers.every(p => p.connected === true), JSON.stringify(peers))
  const history = await claude.call('bridge_history', { limit: 10 })
  check('history non-empty and newest first', history.messages.length >= 4 && history.messages[0].ts >= history.messages[history.messages.length - 1].ts, JSON.stringify(history))
  // peer="all" is the unfiltered archiver view — now manager-gated: claude
  // (plain agent) is denied other-peer reads; mavis (manager on this hub
  // instance) gets the full tail including the private opencode→mavis note.
  const deniedAll = await claude.callRaw('bridge_history', { peer: 'all', limit: 20 })
  check('peer=all denied for non-manager', deniedAll.error !== undefined && /manager/.test(deniedAll.error), JSON.stringify(deniedAll))
  const deniedOther = await claude.callRaw('bridge_history', { peer: 'opencode', limit: 20 })
  check('other-peer history denied for non-manager', deniedOther.error !== undefined && /manager/.test(deniedOther.error), JSON.stringify(deniedOther))
  const historyAll = await mavis.call('bridge_history', { peer: 'all', limit: 20 })
  const othersPrivate = historyAll.messages.find(m => m.from === 'opencode' && m.to === 'mavis' && m.content === 'opencode note')
  check('peer=all returns other peers private traffic', othersPrivate !== undefined && historyAll.messages[0].ts >= historyAll.messages[historyAll.messages.length - 1].ts, JSON.stringify(historyAll))
  check('own history hides other peers private traffic', history.messages.every(m => !(m.from === 'opencode' && m.to === 'mavis')), JSON.stringify(history))

  console.log('== errors / unregister ==')
  const badTarget = await mavis.callRaw('bridge_chat', { to: 'nobody', message: 'x' })
  check('unknown recipient rejected', badTarget.error !== undefined, JSON.stringify(badTarget))
  await opencode.call('bridge_unregister')
  const gone = await mavis.callRaw('bridge_chat', { to: 'opencode', message: 'x' })
  check('chat to unregistered peer rejected', gone.error !== undefined, JSON.stringify(gone))
  const afterGone = await mavis.call('bridge_peers')
  check('peers list drops unregistered', afterGone.peers.length === 2 && !afterGone.peers.some(p => p.id === 'opencode'), JSON.stringify(afterGone))
  await opencode.register('opencode')
  const reborn = await mavis.call('bridge_peers')
  check('peer can re-register', reborn.peers.length === 3, JSON.stringify(reborn))

  const timeout = await mavis.call('bridge_wait', { timeoutMs: 200 })
  check('wait timeout shape', timeout.type === 'timeout' && typeof timeout.waitedMs === 'number', JSON.stringify(timeout))

  const badStatus = await mavis.callRaw('bridge_ack', { ref: 'does-not-exist', status: 'done' })
  check('ack of unknown ref rejected', badStatus.error !== undefined, JSON.stringify(badStatus))

  console.log('== auto-registration ==')
  const auto = makeClient('autobot')
  await auto.init()
  const autoPeers = await auto.call('bridge_peers') // first tool call auto-registers
  check('auto-register on first tool call', autoPeers.peers.some(p => p.id === 'autobot'), JSON.stringify(autoPeers))
  const renamed = await auto.register('autobot:proj')
  check('explicit register renames auto id', renamed.peers.includes('autobot:proj') && !renamed.peers.includes('autobot'), JSON.stringify(renamed))
  const dup1 = makeClient('dupname')
  const dup2 = makeClient('dupname')
  await dup1.init()
  await dup2.init()
  await dup1.call('bridge_peers')
  await dup2.call('bridge_peers')
  const dupPeers = await auto.call('bridge_peers')
  const dupIds = dupPeers.peers.map(p => p.id).filter(id => id.startsWith('dupname'))
  check('same-name sessions share one peer id', JSON.stringify(dupIds) === JSON.stringify(['dupname']), JSON.stringify(dupIds))
  // Shared mailbox: dup1 sends to its own shared peer, dup2 (same name) receives.
  await dup1.call('bridge_chat', { to: 'dupname', message: 'shared mailbox ping' })
  const shared = await dup2.call('bridge_wait', { timeoutMs: 3000 })
  check('same-name sessions share the mailbox', shared.type === 'message' && shared.message.content === 'shared mailbox ping', JSON.stringify(shared))
  const explicitLeave = makeClient('leaver')
  await explicitLeave.init()
  await explicitLeave.call('bridge_peers')
  await explicitLeave.call('bridge_unregister')
  const left = await explicitLeave.callRaw('bridge_chat', { to: 'mavis', message: 'x' })
  check('unregister suppresses re-auto-register', left.error !== undefined, JSON.stringify(left))

  console.log('== eager registration at connect ==')
  const eager = makeClient('eager') // initialize ONLY — no tool calls at all
  await eager.init()
  const eagerPeers = await mavis.call('bridge_peers')
  check('peer appears after initialize alone', eagerPeers.peers.some(p => p.id === 'eager' && p.connected === true), JSON.stringify(eagerPeers))
  const de1 = makeClient('dupeager')
  const de2 = makeClient('dupeager')
  await de1.init()
  await de2.init()
  const dePeers = await mavis.call('bridge_peers')
  const deIds = dePeers.peers.map(p => p.id).filter(id => id.startsWith('dupeager'))
  check('connect-time same-name sessions merge into one peer', JSON.stringify(deIds) === JSON.stringify(['dupeager']), JSON.stringify(deIds))

  console.log('== liveness semantics (SSE counts as connected) ==')
  const hubSse = startHub({ port: 18999, connectedWindowMs: 400, peerIdleTimeoutMs: 60_000, waitTimeoutMs: 2000, maxQueue: 10, historyLimit: 10 }, { info: () => {}, warn: () => {} })
  try {
    const sseA = makeClient('ssepeer', 'http://127.0.0.1:18999/mcp')
    const checker = makeClient('checker2', 'http://127.0.0.1:18999/mcp')
    await sseA.init()
    await checker.init()
    const sseRes = await fetch('http://127.0.0.1:18999/mcp', { headers: { Accept: 'text/event-stream', 'Mcp-Session-Id': sseA.sessionId() } })
    const sseReader = sseRes.body.getReader()
    await sseReader.read() // consume the ": connected" comment; stream stays open
    await new Promise(resolve => setTimeout(resolve, 600)) // beyond the 400ms activity window
    const alive = await checker.call('bridge_peers')
    check('SSE stream counts as connected without activity', alive.peers.find(p => p.id === 'ssepeer')?.connected === true, JSON.stringify(alive))
    await sseReader.cancel()
    await new Promise(resolve => setTimeout(resolve, 600))
    const gone = await checker.call('bridge_peers')
    check('peer shows offline after SSE closes', gone.peers.find(p => p.id === 'ssepeer')?.connected === false, JSON.stringify(gone))
  } finally {
    hubSse.close()
  }

  console.log('== idle GC evicts ghosts ==')
  const hubGc = startHub({ port: 19000, peerIdleTimeoutMs: 700, connectedWindowMs: 60_000, waitTimeoutMs: 2000, maxQueue: 10, historyLimit: 10 }, { info: () => {}, warn: () => {} })
  try {
    const ghost = makeClient('gcpear', 'http://127.0.0.1:19000/mcp')
    const checkerGc = makeClient('checker3', 'http://127.0.0.1:19000/mcp')
    await ghost.init()
    await checkerGc.init()
    const before = await checkerGc.call('bridge_peers')
    check('peer registered before GC', before.peers.some(p => p.id === 'gcpear'), JSON.stringify(before))
    await new Promise(resolve => setTimeout(resolve, 2200)) // idle 700ms + 1s GC interval
    const after = await checkerGc.call('bridge_peers')
    // W7: the idle GC parks a peer instead of forgetting it — it disappears from
    // the "connected" set but stays addressable and keeps whatever was queued.
    const parkedGc = after.peers.find(p => p.id === 'gcpear')
    check('idle peer is parked by GC (gone quiet, still listed)', parkedGc !== undefined && parkedGc.reachable === 'parked' && parkedGc.connected === false, JSON.stringify(after))
    const toParked = await checkerGc.call('bridge_chat', { to: 'gcpear', message: 'queued while you were away' })
    check('a parked peer is still addressable', toParked.ok === true, JSON.stringify(toParked))
    const rejoined = await ghost.call('bridge_peers') // next call re-auto-registers
    check('evicted session re-registers on next call', rejoined.peers.some(p => p.id === 'gcpear'), JSON.stringify(rejoined))

    // A peer with a live SSE channel must survive the idle GC (open session = online).
    const liveGc = makeClient('livegc', 'http://127.0.0.1:19000/mcp')
    await liveGc.init()
    const liveGcSse = await fetch('http://127.0.0.1:19000/mcp', { headers: { Accept: 'text/event-stream', 'Mcp-Session-Id': liveGc.sessionId() } })
    const liveGcReader = liveGcSse.body.getReader()
    await liveGcReader.read()
    await new Promise(resolve => setTimeout(resolve, 2200)) // far past the 700ms idle budget
    const during = await checkerGc.call('bridge_peers')
    check('live SSE peer survives idle GC', during.peers.some(p => p.id === 'livegc'), JSON.stringify(during))
    await liveGcReader.cancel()
    await new Promise(resolve => setTimeout(resolve, 1500)) // next GC tick evicts it
    const afterClose = await checkerGc.call('bridge_peers')
    const parkedLive = afterClose.peers.find(p => p.id === 'livegc')
    check('peer is parked after its SSE closes', parkedLive !== undefined && parkedLive.reachable === 'parked' && parkedLive.connected === false, JSON.stringify(afterClose))
  } finally {
    hubGc.close()
  }

  console.log('== profiles, aliases, and manager ops ==')
  // Fresh hub: DEFAULT_CONFIG managers default to the desktop identity
  // ('agent-hub-cli'), so the mgr client below is the manager out of the box.
  const hubMgmt = startHub({ port: 19001, waitTimeoutMs: 2000, maxQueue: 10, historyLimit: 20, connectedWindowMs: 60_000 }, { info: () => {}, warn: () => {} })
  try {
    const base = 'http://127.0.0.1:19001/mcp'
    const mgr = makeClient('agent-hub-cli', base)
    const alice = makeClient('alice', base)
    const bob = makeClient('bob', base)
    await Promise.all([mgr.init(), alice.init(), bob.init()])

    const roster0 = await mgr.call('bridge_peers')
    const aliceEntry = roster0.peers.find(p => p.id === 'alice')
    check('roster carries client name/version reported at connect', aliceEntry?.clientName === 'alice' && aliceEntry?.clientVersion === '1', JSON.stringify(aliceEntry))

    const regAlias = await alice.call('bridge_register', { peerId: 'alice', alias: 'Alice A' })
    check('register sets own display alias', regAlias.ok === true && regAlias.alias === 'Alice A', JSON.stringify(regAlias))
    const roster1 = await bob.call('bridge_peers')
    check('alias is visible to other peers', roster1.peers.find(p => p.id === 'alice')?.alias === 'Alice A', JSON.stringify(roster1))

    const renamed = await mgr.call('bridge_rename', { peer: 'alice', alias: 'Alice Renamed' })
    check('manager renames another peer', renamed.ok === true && renamed.alias === 'Alice Renamed', JSON.stringify(renamed))
    const roster2 = await bob.call('bridge_peers')
    check('manager rename is roster-wide visible', roster2.peers.find(p => p.id === 'alice')?.alias === 'Alice Renamed', JSON.stringify(roster2))

    await mgr.call('bridge_chat', { to: 'alice', message: 'still routed by id' })
    const got = await alice.call('bridge_wait', { timeoutMs: 2000 })
    check('alias rename keeps routing on the immutable id', got.type === 'message' && got.message.from === 'agent-hub-cli' && got.message.content === 'still routed by id', JSON.stringify(got))

    const denied = await bob.callRaw('bridge_rename', { peer: 'alice', alias: 'Nope' })
    check('non-manager rename of another peer rejected', denied.error !== undefined && /manager/.test(denied.error), JSON.stringify(denied))
    const cleared = await mgr.call('bridge_rename', { alias: '   ' })
    check('whitespace-only alias clears the display alias', cleared.ok === true && cleared.alias === undefined, JSON.stringify(cleared))
    const ctrlAlias = await mgr.callRaw('bridge_rename', { alias: 'bad\u0000name' })
    check('alias with control characters rejected', ctrlAlias.error !== undefined, JSON.stringify(ctrlAlias))
    const ghostAlias = await mgr.callRaw('bridge_rename', { peer: 'ghost', alias: 'Ghost' })
    check('alias of unknown peer rejected', ghostAlias.error !== undefined, JSON.stringify(ghostAlias))

    await alice.call('bridge_unregister')
    const alice2 = makeClient('alice', base)
    await alice2.init()
    const roster3 = await bob.call('bridge_peers')
    check('alias survives unregister and reconnect', roster3.peers.find(p => p.id === 'alice')?.alias === 'Alice Renamed', JSON.stringify(roster3))
    const reidentified = await alice2.call('bridge_register', { peerId: 'carol' })
    check('self id-rename carries the display alias', reidentified.ok === true && reidentified.alias === 'Alice Renamed', JSON.stringify(reidentified))
    await alice2.call('bridge_register', { peerId: 'alice' })

    const kicked = await mgr.call('bridge_unregister', { peer: 'bob' })
    check('manager kicks a peer', kicked.ok === true && kicked.kicked === true, JSON.stringify(kicked))
    const bobBlocked = await bob.callRaw('bridge_peers')
    check('kicked session cannot auto-re-register', bobBlocked.error !== undefined, JSON.stringify(bobBlocked))
    const roster4 = await mgr.call('bridge_peers')
    check('kicked peer leaves the roster', !roster4.peers.some(p => p.id === 'bob'), JSON.stringify(roster4))
    const bobBack = await bob.call('bridge_register', { peerId: 'bob' })
    check('kicked peer can explicitly re-register', bobBack.ok === true, JSON.stringify(bobBack))

    const kickUnknown = await mgr.call('bridge_unregister', { peer: 'nobody-here' })
    check('kick of unknown peer is a no-op ok', kickUnknown.ok === true && kickUnknown.kicked === false, JSON.stringify(kickUnknown))
    const kickDenied = await bob.callRaw('bridge_unregister', { peer: 'alice' })
    check('non-manager kick rejected', kickDenied.error !== undefined && /manager/.test(kickDenied.error), JSON.stringify(kickDenied))
  } finally {
    hubMgmt.close()
  }

  console.log('== SSE event push (roster + queued-mail hints) ==')
  const hubEvt = startHub({ port: 19002, connectedWindowMs: 60_000, waitTimeoutMs: 2000, maxQueue: 10, historyLimit: 10 }, { info: () => {}, warn: () => {} })
  try {
    const base = 'http://127.0.0.1:19002/mcp'
    const watcher = makeClient('watcher', base)
    await watcher.init()
    const evtRes = await fetch(base, { headers: { Accept: 'text/event-stream', 'Mcp-Session-Id': watcher.sessionId() } })
    const reader = evtRes.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const readUntil = async (pattern, timeoutMs = 3000) => {
      const deadline = Date.now() + timeoutMs
      while (!buffer.includes(pattern) && Date.now() < deadline) {
        const chunk = await reader.read()
        if (chunk.done) return false
        buffer += decoder.decode(chunk.value, { stream: true })
      }
      return buffer.includes(pattern)
    }
    await reader.read() // consume the ": connected" comment

    const joiner = makeClient('joiner', base)
    await joiner.init()
    const sawJoin = await readUntil('"event":"peers_changed"')
    check('SSE pushes peers_changed when a peer joins', sawJoin && buffer.includes('"joiner"'), buffer.slice(-400))

    await joiner.call('bridge_rename', { alias: 'Joiner Prime' })
    const sawAlias = await readUntil('Joiner Prime')
    check('SSE pushes roster update on alias edit', sawAlias, buffer.slice(-400))

    await joiner.call('bridge_chat', { to: 'watcher', message: 'ping via sse' })
    const sawMsg = await readUntil('"event":"message"')
    check('SSE pushes queued-mail hint to the recipient', sawMsg && buffer.includes('ping via sse'), buffer.slice(-400))
    await watcher.call('bridge_poll')

    // A private message to a THIRD peer must not reach watcher's stream.
    const watcher2 = makeClient('watcher2', base)
    await watcher2.init()
    await readUntil('watcher2') // consume the roster event for watcher2's join
    buffer = ''
    await joiner.call('bridge_chat', { to: 'watcher2', message: 'private ping' })
    await new Promise(resolve => setTimeout(resolve, 500))
    check('mail hint is recipient-scoped', !buffer.includes('private ping'), buffer.slice(-400))
    await watcher2.call('bridge_poll')
    await reader.cancel()
  } finally {
    hubEvt.close()
  }

  // ---- W13 / W14 / W16: the ack state a delegator can actually wait for -------
  // `ref` used to match ONLY an ack, so a plain `bridge_wait({ ref })` resolved on
  // the first `working` beat (an intermediate state read as a verdict) and the
  // `bridge_chat { ref }` result hand-back that agents/SKILL.md teaches never
  // matched at all. A third hole: a wait that ran to the ceiling could not say
  // whether the task was still open or already judged timeout/done.
  console.log('== ref waits: terminal / status filters, chat replies, timeout snapshot (W13/W16) ==')
  const hubRef = startHub({ port: 19041, connectedWindowMs: 60_000, waitTimeoutMs: 2000, maxQueue: 20, historyLimit: 20 }, { info: () => {}, warn: () => {} })
  try {
    const refBase = 'http://127.0.0.1:19041/mcp'
    const refA = makeClient('ref-a', refBase)
    const refB = makeClient('ref-b', refBase)
    const refC = makeClient('ref-c', refBase)
    await Promise.all([refA.init(), refB.init(), refC.init()])

    const termTask = await refA.call('bridge_task', { to: 'ref-b', prompt: 'terminal filter' })
    await refB.call('bridge_ack', { ref: termTask.id, status: 'working', note: 'halfway' })
    await refB.call('bridge_ack', { ref: termTask.id, status: 'done', note: 'shipped' })
    const termWait = await refA.call('bridge_wait', { ref: termTask.id, terminalOnly: true, timeoutMs: 2000 })
    check(
      'terminalOnly skips the working beat and returns the terminal ack',
      termWait.type === 'message' && termWait.message.kind === 'ack' && termWait.message.content.status === 'done',
      JSON.stringify(termWait),
    )
    // The skipped beat is not consumed: it stays in the mailbox for a later read,
    // which is what makes the filter a FILTER and not a discard.
    const skipped = await refA.call('bridge_poll')
    check(
      'the intermediate ack a terminalOnly wait skipped is still in the mailbox',
      skipped.messages.some(m => m.ref === termTask.id && m.content?.status === 'working'),
      JSON.stringify(skipped),
    )

    const statTask = await refA.call('bridge_task', { to: 'ref-b', prompt: 'status filter' })
    await refB.call('bridge_ack', { ref: statTask.id, status: 'working' })
    await refB.call('bridge_ack', { ref: statTask.id, status: 'input-required', note: 'which repo?' })
    const statWait = await refA.call('bridge_wait', { ref: statTask.id, statuses: ['input-required'], timeoutMs: 2000 })
    check(
      'statuses waits only for the listed ack status',
      statWait.type === 'message' && statWait.message.content.status === 'input-required',
      JSON.stringify(statWait),
    )
    const badStatuses = await refA.callRaw('bridge_wait', { ref: statTask.id, statuses: ['finishing'] })
    check(
      'an unknown statuses value is rejected, not silently ignored',
      badStatuses.error !== undefined && /invalid statuses/.test(badStatuses.error),
      JSON.stringify(badStatuses),
    )

    const chatTask = await refA.call('bridge_task', { to: 'ref-b', prompt: 'chat reply' })
    await refB.call('bridge_wait', { timeoutMs: 2000 }) // the assignee reads its task first
    await refB.call('bridge_chat', { to: 'ref-a', ref: chatTask.id, message: 'result: 42' })
    const chatWait = await refA.call('bridge_wait', { ref: chatTask.id, timeoutMs: 2000 })
    check(
      'a ref wait resolves on the chat reply the skill teaches (not only on acks)',
      chatWait.type === 'message' && chatWait.message.kind === 'chat'
        && chatWait.message.content === 'result: 42' && chatWait.message.ref === chatTask.id,
      JSON.stringify(chatWait),
    )

    const snapTask = await refA.call('bridge_task', { to: 'ref-b', prompt: 'timeout snapshot' })
    await refB.call('bridge_ack', { ref: snapTask.id, status: 'accepted' })
    await refA.call('bridge_poll') // drain that ack: the wait below must really time out
    const snapWait = await refA.call('bridge_wait', { ref: snapTask.id, timeoutMs: 50 })
    check(
      'a timed-out ref wait reports the ledger state of the ref',
      snapWait.type === 'timeout' && snapWait.ref?.status === 'accepted' && snapWait.ref?.a2aState === 'submitted',
      JSON.stringify(snapWait),
    )

    // `terminalOnly` and `statuses` are an INTERSECTION: a list with no terminal
    // status can never resolve, so the pair is refused instead of silently
    // burning the whole timeoutMs.
    const contradictory = await refA.callRaw('bridge_wait', { ref: statTask.id, statuses: ['working'], terminalOnly: true, timeoutMs: 50 })
    check(
      'terminalOnly combined with a statuses list holding no terminal status is rejected',
      contradictory.error !== undefined && /intersection/.test(contradictory.error),
      JSON.stringify(contradictory),
    )

    // A `ref` wait is the delegator's inbox for ONE task, so a THIRD party must
    // not be able to answer it: `chat` has no authorization gate (unlike
    // `sendAck`, which only the sender or an assignee may call), and task ids are
    // published in `bridge_events`, so the ledger is what decides.
    const impTask = await refA.call('bridge_task', { to: 'ref-b', prompt: 'impostor check' })
    await refC.call('bridge_chat', { to: 'ref-a', ref: impTask.id, message: 'impostor delivery' })
    const impWait = await refA.call('bridge_wait', { ref: impTask.id, timeoutMs: 300 })
    check(
      'a third party cannot answer a ref wait with a chat carrying that task id',
      impWait.type === 'timeout' && impWait.ref?.status === 'pending',
      JSON.stringify(impWait),
    )
    const impMail = await refA.call('bridge_poll')
    check(
      'the impostor chat is still queued, not consumed by the refused wait',
      impMail.messages.some(m => m.ref === impTask.id && m.from === 'ref-c' && m.content === 'impostor delivery'),
      JSON.stringify(impMail),
    )
    // A ref the ledger does not know is an ordinary reply chain — there is
    // nothing to check it against, so anyone may answer it.
    const chainWaitP = refA.call('bridge_wait', { ref: 'plain-chain-1', timeoutMs: 2000 })
    await new Promise(resolve => setTimeout(resolve, 200))
    await refC.call('bridge_chat', { to: 'ref-a', ref: 'plain-chain-1', message: 'chain reply' })
    const chainWait = await chainWaitP
    check(
      'a ref outside the task ledger is still an ordinary reply chain',
      chainWait.type === 'message' && chainWait.message.content === 'chain reply',
      JSON.stringify(chainWait),
    )

    // The timeout snapshot is a task-state READ, so it is party-only: without
    // that gate any peer holding a task id (they are published by
    // `bridge_events`) could probe the ledger with `timeoutMs: 1`.
    const mootWait = await refC.call('bridge_wait', { ref: impTask.id, timeoutMs: 1 })
    check(
      'a timed-out ref wait omits the ledger snapshot for a peer that is not a party',
      mootWait.type === 'timeout' && mootWait.ref === undefined,
      JSON.stringify(mootWait),
    )

    // The filter assertions above are all "queued first, then wait", which only
    // exercises the queue-scan half of the predicate. This one registers the
    // waiter FIRST and lets the acks arrive afterwards.
    const earlyTask = await refA.call('bridge_task', { to: 'ref-b', prompt: 'waiter first' })
    const earlyWaitP = refA.call('bridge_wait', { ref: earlyTask.id, terminalOnly: true, timeoutMs: 2000 })
    await new Promise(resolve => setTimeout(resolve, 300)) // let the waiter register first
    await refB.call('bridge_ack', { ref: earlyTask.id, status: 'working' })
    await refB.call('bridge_ack', { ref: earlyTask.id, status: 'done' })
    const earlyWait = await earlyWaitP
    check(
      'terminalOnly filters on the waiter-registered-first path too (skips the working beat)',
      earlyWait.type === 'message' && earlyWait.message.kind === 'ack' && earlyWait.message.content?.status === 'done',
      JSON.stringify(earlyWait),
    )

    // A hub notice carries neither a ref nor a status, so the filters used to
    // kill exactly the two warnings a delegator waiting on `ref` has to hear.
    // "Your assignee left the hub" is the one route that sends one here.
    const doomed = makeClient('ref-d', refBase)
    await doomed.init()
    const dropTask = await refA.call('bridge_task', { to: 'ref-d', prompt: 'assignee will leave' })
    const dropWaitP = refA.call('bridge_wait', { ref: dropTask.id, terminalOnly: true, timeoutMs: 2000 })
    await new Promise(resolve => setTimeout(resolve, 300))
    await doomed.call('bridge_unregister')
    const dropWait = await dropWaitP
    check(
      'a hub notice reaches a ref wait even with terminalOnly set',
      dropWait.type === 'message' && dropWait.message.kind === 'notice' && dropWait.message.from === 'hub'
        && String(dropWait.message.content?.message ?? '').includes(dropTask.id),
      JSON.stringify(dropWait),
    )

    console.log('== SSE task_changed event (W14) ==')
    const openStream = async client => {
      const res = await fetch(refBase, { headers: { Accept: 'text/event-stream', 'Mcp-Session-Id': client.sessionId() } })
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let text = ''
      await reader.read() // consume the ": connected" comment
      return {
        text: () => text,
        reset: () => { text = '' },
        readUntil: async (pattern, timeoutMs = 3000) => {
          const deadline = Date.now() + timeoutMs
          while (!text.includes(pattern) && Date.now() < deadline) {
            const chunk = await reader.read()
            if (chunk.done) return false
            text += decoder.decode(chunk.value, { stream: true })
          }
          return text.includes(pattern)
        },
        cancel: () => reader.cancel(),
      }
    }
    const senderStream = await openStream(refA) // sender of the task: must hear it
    const assigneeStream = await openStream(refB) // assignee: must hear it
    const outsiderStream = await openStream(refC) // neither side: must NOT
    try {
      // Prove the outsider stream is ALIVE before asserting it received nothing:
      // "nothing arrived on a stream that was never proven to work" passes for
      // the wrong reason. ref-c is the ASSIGNEE of this baseline task, so its own
      // `task_changed` is the proof.
      const baselineTask = await refA.call('bridge_task', { to: 'ref-c', prompt: 'outsider baseline' })
      const sawOutsiderBaseline = await outsiderStream.readUntil(`"taskId":"${baselineTask.id}"`)
      outsiderStream.reset()
      const pushTask = await refA.call('bridge_task', { to: 'ref-b', prompt: 'push my state' })
      await refB.call('bridge_wait', { timeoutMs: 2000 })
      // Wait for the CREATION push to land before resetting, so the assertion
      // below is about the ack's transition and not about the initial event.
      await senderStream.readUntil(`"taskId":"${pushTask.id}"`, 1000)
      senderStream.reset()
      await refB.call('bridge_ack', { ref: pushTask.id, status: 'working', progress: 20 })
      // `a2aState` is unique to task_changed: a queued-mail hint for the same ack
      // also contains "status":"working", so pacing on the status alone would
      // match the wrong event.
      const sawPush = await senderStream.readUntil('"a2aState":"working"')
      const senderText = senderStream.text()
      check(
        'SSE pushes task_changed to the sender with status + a2aState',
        sawPush && senderText.includes('"event":"task_changed"')
          && senderText.includes(`"taskId":"${pushTask.id}"`)
          && senderText.includes('"status":"working"'),
        senderText.slice(-400),
      )
      const sawAssignee = await assigneeStream.readUntil(`"a2aState":"working"`)
      const assigneeText = assigneeStream.text()
      check(
        'SSE pushes task_changed to the assignee too',
        sawOutsiderBaseline && sawAssignee
          && assigneeText.includes('"event":"task_changed"')
          && assigneeText.includes(`"taskId":"${pushTask.id}"`),
        assigneeText.slice(-400),
      )
      // A REAL transition still pushes: pending/working → done.
      await refB.call('bridge_ack', { ref: pushTask.id, status: 'done' })
      const sawDone = await senderStream.readUntil('"a2aState":"completed"')
      check('SSE pushes task_changed when the task reaches a terminal state', sawDone, senderStream.text().slice(-400))
      // An `applied: false` ack (the task is already terminal, so the ack is
      // recorded but moves nothing) must not re-announce the same status: that
      // would turn the stream into an ack-by-ack echo.
      senderStream.reset()
      await refB.call('bridge_ack', { ref: pushTask.id, status: 'done' })
      // A negative assertion is only worth something on a stream proven alive
      // WHILE it is being read: `reset()` leaves `text()` empty, so reading it
      // without a read() in between made "no task_changed arrived" true for the
      // wrong reason. The ack itself still reaches the sender as a queued-mail
      // hint, which is the liveness proof; the second read then waits for the
      // event that must NOT come (catching both orders).
      const sawLateHint = await senderStream.readUntil('"event":"message"')
      const sawLatePush = await senderStream.readUntil('"event":"task_changed"', 500)
      const afterLate = await refA.call('bridge_task_status', { ref: pushTask.id })
      const doneEvents = afterLate.task.acks.filter(event => event.status === 'done')
      check(
        'an applied:false terminal ack does not push a second task_changed',
        sawLateHint && !sawLatePush && doneEvents.length === 2 && doneEvents[1].applied === false,
        `hint=${sawLateHint} push=${sawLatePush} ${JSON.stringify(doneEvents.map(e => e.applied))} ${senderStream.text().slice(-300)}`,
      )
      // Same rule for the outsider: prove the stream delivers (a roster edit
      // pushes `peers_changed` to EVERY stream) and then read for the event that
      // must never arrive while two OTHER peers exchange a real transition.
      outsiderStream.reset()
      await refC.call('bridge_rename', { alias: 'ref-c-outsider' })
      const sawOutsiderAlive = await outsiderStream.readUntil('"event":"peers_changed"')
      const asideTask = await refA.call('bridge_task', { to: 'ref-b', prompt: 'between the other two' })
      await refB.call('bridge_ack', { ref: asideTask.id, status: 'working', progress: 10 })
      const sawOutsiderPush = await outsiderStream.readUntil('"event":"task_changed"', 700)
      check(
        'task_changed is not pushed to a peer that is neither sender nor assignee',
        sawOutsiderAlive && !sawOutsiderPush,
        `alive=${sawOutsiderAlive} push=${sawOutsiderPush} ${outsiderStream.text().slice(-400)}`,
      )
    } finally {
      await senderStream.cancel()
      await assigneeStream.cancel()
      await outsiderStream.cancel()
    }
  } finally {
    hubRef.close()
  }

  console.log('== healthz ==')
  const hz = await fetch(`http://127.0.0.1:${PORT}/healthz`)
  const hzJson = await hz.json()
  check('GET /healthz answers ok without a session or token', hz.status === 200 && hzJson.ok === true, `${hz.status} ${JSON.stringify(hzJson)}`)

  console.log('== SSE heartbeat ==')
  // The heartbeat keeps proxies from reaping idle streams and gives clients
  // a liveness signal; tests shrink the cadence to 50ms.
  const hubHb = startHub({ port: 19011, waitTimeoutMs: 2000, maxQueue: 10, historyLimit: 10, heartbeatMs: 50 }, { info: () => {}, warn: () => {} })
  try {
    const hbBase = 'http://127.0.0.1:19011/mcp'
    const hbClient = makeClient('hb', hbBase)
    await hbClient.init()
    const hbRes = await fetch(hbBase, { headers: { Accept: 'text/event-stream', 'Mcp-Session-Id': hbClient.sessionId() } })
    const hbReader = hbRes.body.getReader()
    const hbDecoder = new TextDecoder()
    let hbBuffer = ''
    const hbDeadline = Date.now() + 2000
    while (!hbBuffer.includes('"event":"heartbeat"') && Date.now() < hbDeadline) {
      const chunk = await hbReader.read()
      if (chunk.done) break
      hbBuffer += hbDecoder.decode(chunk.value, { stream: true })
    }
    check('SSE stream receives periodic heartbeat notifications', hbBuffer.includes('"event":"heartbeat"'), hbBuffer.slice(-200))
    await hbReader.cancel()
  } finally {
    hubHb.close()
  }

  console.log('== true rename (re-key) and history gate ==')
  const hubKey = startHub({ port: 19003, waitTimeoutMs: 2000, maxQueue: 10, historyLimit: 30, connectedWindowMs: 60_000 }, { info: () => {}, warn: () => {} })
  try {
    const base = 'http://127.0.0.1:19003/mcp'
    const mgr = makeClient('agent-hub-cli', base)
    const ren = makeClient('ren', base)
    const peer = makeClient('peer', base)
    await Promise.all([mgr.init(), ren.init(), peer.init()])

    // Traffic to reattribute: ren↔peer history + a task QUEUED for ren.
    await ren.call('bridge_chat', { to: 'peer', message: 'before rename' })
    await peer.call('bridge_wait', { timeoutMs: 2000 })
    await peer.call('bridge_task', { to: 'ren', prompt: 'queued task' })
    await ren.call('bridge_rename', { alias: 'Ren Prime' }) // self alias, no re-key

    // Group membership is identity too: a rename that leaves the old id in
    // `members` locks the peer out of a group it is supposed to still be in (the
    // new id is not a member) while the old id keeps a seat nobody holds.
    await mgr.call('bridge_group_create', { group: 'ren-group', members: ['ren'] })

    const rekey = await mgr.call('bridge_rename', { peer: 'ren', peerId: 'ren2' })
    check('manager re-keys a peer', rekey.ok === true && rekey.peerId === 'ren2' && rekey.previousId === 'ren', JSON.stringify(rekey))
    const roster = await peer.call('bridge_peers')
    check('roster shows only the new id', roster.peers.some(p => p.id === 'ren2') && !roster.peers.some(p => p.id === 'ren'), JSON.stringify(roster))
    check('alias follows the re-key', rekey.alias === 'Ren Prime' || roster.peers.find(p => p.id === 'ren2')?.alias === 'Ren Prime', JSON.stringify(roster))
    const rekeyGroups = await mgr.call('bridge_group_list')
    const rekeyGroup = rekeyGroups.groups?.find(g => g.id === 'ren-group')
    check(
      'group membership follows the re-key',
      rekeyGroup?.members.includes('ren2') === true && rekeyGroup?.members.includes('ren') === false,
      JSON.stringify(rekeyGroup),
    )
    const rekeyGroupSend = await ren.callRaw('bridge_group_send', { group: 'ren-group', message: 'after the re-key' })
    check('the renamed peer can still send to its group', rekeyGroupSend.error === undefined, JSON.stringify(rekeyGroupSend).slice(0, 200))

    // The renamed session keeps working under the new id (binding moved).
    const drained = await ren.call('bridge_poll')
    check('queued message survives the re-key', drained.messages.length === 1 && drained.messages[0].from === 'peer' && drained.messages[0].kind === 'task', JSON.stringify(drained))
    // ack after re-key routes back to the ORIGINAL sender (history rewritten).
    await ren.call('bridge_ack', { ref: drained.messages[0].id, status: 'accepted' })
    const ackBack = await peer.call('bridge_wait', { timeoutMs: 2000 })
    check('ack after re-key routed to original sender', ackBack.type === 'message' && ackBack.message.from === 'ren2' && ackBack.message.kind === 'ack', JSON.stringify(ackBack))
    // History attribution rewritten: peer's own view shows ren2, not ren.
    const peerHistory = await peer.call('bridge_history', { limit: 20 })
    check('history attribution follows the new id', peerHistory.messages.some(m => m.from === 'ren2' && m.content === 'before rename') && !peerHistory.messages.some(m => m.from === 'ren'), JSON.stringify(peerHistory.messages.map(m => m.from)))
    // Old id is free but no longer routable.
    const oldId = await peer.callRaw('bridge_chat', { to: 'ren', message: 'x' })
    check('old id unknown after re-key', oldId.error !== undefined, JSON.stringify(oldId))

    const denied = await peer.callRaw('bridge_rename', { peer: 'ren2', peerId: 'stolen' })
    check('non-manager re-key rejected', denied.error !== undefined && /manager/.test(denied.error), JSON.stringify(denied))
    const taken = await mgr.callRaw('bridge_rename', { peer: 'ren2', peerId: 'peer' })
    check('re-key onto a taken id rejected', taken.error !== undefined && /already registered/.test(taken.error), JSON.stringify(taken))
    const reserved = await mgr.callRaw('bridge_rename', { peer: 'ren2', peerId: 'all' })
    check('re-key onto the broadcast address rejected', reserved.error !== undefined && /reserved/.test(reserved.error), JSON.stringify(reserved))
    const invalid = await mgr.callRaw('bridge_rename', { peer: 'ren2', peerId: 'bad id!' })
    check('re-key onto an invalid id rejected', invalid.error !== undefined, JSON.stringify(invalid))
    const reservedReg = await peer.callRaw('bridge_register', { peerId: 'all' })
    check('registering the broadcast address rejected', reservedReg.error !== undefined && /reserved/.test(reservedReg.error), JSON.stringify(reservedReg))

    // Self id-rename via bridge_register is now lossless too.
    const carol = makeClient('carol', base)
    await carol.init()
    await carol.call('bridge_register', { peerId: 'carol', alias: 'Carol C' })
    await peer.call('bridge_chat', { to: 'carol', message: 'queued for carol' })
    const selfRenamed = await carol.call('bridge_register', { peerId: 'carol2' })
    check('self id-rename carries the alias', selfRenamed.ok === true && selfRenamed.alias === 'Carol C', JSON.stringify(selfRenamed))
    const carolDrained = await carol.call('bridge_poll')
    check('self id-rename keeps the queued mailbox', carolDrained.messages.length === 1 && carolDrained.messages[0].content === 'queued for carol', JSON.stringify(carolDrained))
  } finally {
    hubKey.close()
  }

  console.log('== roster persistence (stateFile) ==')
  const stateFile = `${tmpdir()}/hub-roster-test-${Date.now()}.json`
  const hubA = startHub({ port: 19004, waitTimeoutMs: 2000, maxQueue: 10, historyLimit: 10, stateFile }, { info: () => {}, warn: () => {} })
  try {
    const pA = makeClient('alice', 'http://127.0.0.1:19004/mcp')
    await pA.init()
    await pA.call('bridge_register', { peerId: 'alice', alias: 'Persisted Alice' })
    await pA.call('bridge_peers')
  } finally {
    hubA.close() // flushes the roster synchronously
  }
  const saved = JSON.parse(readFileSync(stateFile, 'utf8'))
  check('roster file written with profiles', saved.version === 1 && saved.profiles.some(p => p.id === 'alice' && p.alias === 'Persisted Alice'), JSON.stringify(saved))

  const hubB = startHub({ port: 19005, waitTimeoutMs: 2000, maxQueue: 10, historyLimit: 10, stateFile }, { info: () => {}, warn: () => {} })
  try {
    const pB = makeClient('alice', 'http://127.0.0.1:19005/mcp')
    await pB.init()
    await pB.call('bridge_register', { peerId: 'alice' })
    const restored = await pB.call('bridge_peers')
    check('alias restored from the roster file after restart', restored.peers.find(p => p.id === 'alice')?.alias === 'Persisted Alice', JSON.stringify(restored))
    await pB.call('bridge_unregister')
    // Stale-profile collision: a peer re-keying onto a persisted id adopts
    // that id's alias (live profile fields win, missing ones are adopted).
    const pC = makeClient('alice', 'http://127.0.0.1:19005/mcp')
    await pC.init()
    const merged = await pC.call('bridge_register', { peerId: 'alice2' })
    check('re-key onto a persisted id adopts its alias', merged.ok === true && merged.alias === 'Persisted Alice', JSON.stringify(merged))
  } finally {
    hubB.close()
  }
  rmSync(stateFile, { force: true })

  console.log('== remote auth: bearer tokens bind identity ==')
  // Token table: two clients both named kimi-code (the R0 cross-talk
  // scenario); tokens map them to DISTINCT peers, the manager token rules.
  const tokenFile = `${tmpdir()}/hub-auth-test-${Date.now()}.json`
  writeFileSync(tokenFile, JSON.stringify({ tokens: [
    { token: 'zs-token-0123456789abcdef', peer: 'zhangsan', role: 'agent', owner: '张三' },
    { token: 'ls-token-0123456789abcdef', peer: 'lisi', role: 'agent', owner: '李四' },
    { token: 'admin-token-0123456789ab', peer: 'ops-admin', role: 'manager', owner: '运维' },
    { token: 'never-connects-token-0001', peer: 'ghost-operator', role: 'agent', owner: 'configured, never connected' },
  ] }), 'utf8')
  const hubAuth = startHub({ port: 19006, waitTimeoutMs: 2000, maxQueue: 10, historyLimit: 20, connectedWindowMs: 60_000, authTokens: tokenFile }, { info: () => {}, warn: () => {} })
  try {
    const authBase = 'http://127.0.0.1:19006/mcp'
    const noAuth = await fetch(authBase, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) })
    check('request without token rejected 401', noAuth.status === 401, String(noAuth.status))
    const badAuth = await fetch(authBase, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer wrong-token-0123456789' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) })
    check('request with unknown token rejected 401', badAuth.status === 401, String(badAuth.status))
    const sseNoAuth = await fetch(authBase, { headers: { Accept: 'text/event-stream' } })
    check('SSE without token rejected 401', sseNoAuth.status === 401, String(sseNoAuth.status))
    // /healthz is the one unauthenticated route: monitors must not need a token.
    const hzAuth = await fetch('http://127.0.0.1:19006/healthz')
    check('healthz stays open in remote-auth mode', hzAuth.status === 200, String(hzAuth.status))

    const zs = makeClient('kimi-code', authBase, 'zs-token-0123456789abcdef')
    const ls = makeClient('kimi-code', authBase, 'ls-token-0123456789abcdef')
    const boss = makeClient('ops-console', authBase, 'admin-token-0123456789ab')
    await Promise.all([zs.init(), ls.init(), boss.init()])
    const rosterA = await boss.call('bridge_peers')
    const zsRow = rosterA.peers.find(p => p.id === 'zhangsan')
    check('token identity overrides the client-reported name', zsRow?.clientName === 'kimi-code', JSON.stringify(rosterA))
    check('same-name clients land on distinct token peers', rosterA.peers.some(p => p.id === 'lisi') && rosterA.peers.some(p => p.id === 'ops-admin'), JSON.stringify(rosterA))

    // The R0 leak, closed: one token user's message must NOT reach another's mailbox.
    await zs.call('bridge_chat', { to: 'zhangsan', message: '张三的交接任务' })
    const lsDrain = await ls.call('bridge_poll')
    check('no cross-user mailbox leak between same-name clients', lsDrain.messages.length === 0, JSON.stringify(lsDrain))
    const zsSelf = await zs.call('bridge_poll')
    check('token peer keeps its own mailbox', zsSelf.messages.length === 1 && zsSelf.messages[0].content === '张三的交接任务', JSON.stringify(zsSelf))

    const hijack = await zs.callRaw('bridge_register', { peerId: 'impersonated' })
    check('token-bound session cannot claim another id', hijack.error !== undefined && /bound to your access token/.test(hijack.error), JSON.stringify(hijack))

    // W7: bridge_register is not the only door to an id change. A session whose
    // identity comes from its token must not re-key itself through
    // bridge_rename either — the token→peer mapping is the operator's, not the
    // session's.
    const hijackRename = await ls.callRaw('bridge_rename', { peer: 'lisi', peerId: 'hijacked' })
    check('token-bound session cannot re-key its own id via bridge_rename', hijackRename.error !== undefined, JSON.stringify(hijackRename))
    const lsRoster = await boss.call('bridge_peers')
    const lsIds = lsRoster.peers.map(p => p.id)
    check('the token peer keeps its bound id after a rename attempt', lsIds.includes('lisi') && !lsIds.includes('hijacked'), JSON.stringify(lsIds))

    // An SSE stream is as sensitive as a tool call: it receives that session's
    // pushes WITH content. Attaching to someone else's session must be refused —
    // and must not lock the real owner out (the bug was that GET only checked the
    // token was VALID, then rebound the session to whoever asked).
    const zsInit = await fetch(authBase, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer zs-token-0123456789abcdef' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'kimi-code', version: '1' }, capabilities: {} } }),
    })
    const zsSid = zsInit.headers.get('mcp-session-id')
    check('(setup) a session id was minted for the stream test', typeof zsSid === 'string' && zsSid.length > 0, String(zsSid))
    const crossStream = await fetch(authBase, {
      headers: { Accept: 'text/event-stream', 'Mcp-Session-Id': zsSid, Authorization: 'Bearer ls-token-0123456789abcdef' },
    })
    check("another user's token cannot attach an SSE stream to this session", crossStream.status === 401, String(crossStream.status))
    await crossStream.body?.cancel()
    const ownerStillWorks = await fetch(authBase, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': zsSid, Authorization: 'Bearer zs-token-0123456789abcdef' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    })
    check('and the real owner is not locked out of their own session', ownerStillWorks.status === 200, String(ownerStillWorks.status))
    await ownerStillWorks.body?.cancel()

    const renamed = await boss.call('bridge_rename', { peer: 'zhangsan', alias: '张三（kimi）' })
    check('manager-role token renames another peer', renamed.ok === true && renamed.alias === '张三（kimi）', JSON.stringify(renamed))
    const denied = await ls.callRaw('bridge_rename', { peer: 'zhangsan', alias: 'nope' })
    check('agent-role token rename of another peer denied', denied.error !== undefined && /manager/.test(denied.error), JSON.stringify(denied))

    // The token table — not the live bindings — decides who owns an id, which is
    // why `tokenPeers` exists: an operator who has been issued a token but has
    // not connected yet still owns that id. Taking it by rename would make their
    // next connect an ATTACH (two tenants on one mailbox).
    const claimGhost = await boss.callRaw('bridge_rename', { peer: 'zhangsan', peerId: 'ghost-operator' })
    check(
      'a rename cannot claim a token peer that never connected',
      claimGhost.error !== undefined && /bound to an access token/.test(claimGhost.error),
      JSON.stringify(claimGhost),
    )
    const zsStillZhangsan = await boss.call('bridge_peers')
    check(
      '(setup) the refused rename left the target peer alone',
      zsStillZhangsan.peers.some(p => p.id === 'zhangsan'),
      JSON.stringify(zsStillZhangsan.peers.map(p => p.id)),
    )

    await zs.call('bridge_chat', { to: 'all', message: 'team broadcast' })
    const lsBc = await ls.call('bridge_wait', { timeoutMs: 2000 })
    check('broadcast reaches token peers', lsBc.type === 'message' && lsBc.message.content === 'team broadcast', JSON.stringify(lsBc))
  } finally {
    hubAuth.close()
    rmSync(tokenFile, { force: true })
  }

  console.log('== groups (group channels) ==')
  const hubGrp = startHub({ port: 19007, waitTimeoutMs: 2000, maxQueue: 10, historyLimit: 20, connectedWindowMs: 60_000 }, { info: () => {}, warn: () => {} })
  try {
    const base = 'http://127.0.0.1:19007/mcp'
    const zs = makeClient('zhangsan', base)
    const ls = makeClient('lisi', base)
    const boss = makeClient('agent-hub-cli', base) // default manager
    await Promise.all([zs.init(), ls.init(), boss.init()])
    const created = await zs.call('bridge_group_create', { group: 'eng', name: '工程群', members: ['lisi'] })
    check('group created with creator auto-joined', created.ok === true && JSON.stringify(created.group.members) === JSON.stringify(['zhangsan', 'lisi']), JSON.stringify(created))
    const dup = await ls.callRaw('bridge_group_create', { group: 'eng', members: ['lisi'] })
    check('duplicate group id rejected', dup.error !== undefined, JSON.stringify(dup))
    const ghostMember = await zs.callRaw('bridge_group_create', { group: 'x', members: ['nobody'] })
    check('unknown member rejected at create', ghostMember.error !== undefined, JSON.stringify(ghostMember))
    // A group id and a peer id share the `to` namespace, and dispatch() resolves
    // a group BEFORE a peer — so a group named after a registered peer would
    // hijack every unicast (and every task) addressed to that peer into a
    // fan-out, and its creator would take the artifacts.
    const peerIdGroup = await zs.callRaw('bridge_group_create', { group: 'lisi', members: ['zhangsan'] })
    check(
      'group id colliding with a registered peer is rejected',
      peerIdGroup.error !== undefined && /namespace/.test(peerIdGroup.error),
      JSON.stringify(peerIdGroup),
    )
    const broadcastGroup = await zs.callRaw('bridge_group_create', { group: 'all', members: ['zhangsan'] })
    check('group id "all" (the broadcast address) is rejected', broadcastGroup.error !== undefined, JSON.stringify(broadcastGroup))

    await zs.call('bridge_group_send', { group: 'eng', message: '群里交接一下' })
    const lsGot = await ls.call('bridge_wait', { timeoutMs: 2000 })
    check('group message reaches members with channel tag', lsGot.type === 'message' && lsGot.message.channel === 'eng' && lsGot.message.to === 'eng' && lsGot.message.content === '群里交接一下', JSON.stringify(lsGot))
    const bossDrain = await boss.call('bridge_poll')
    check('non-member receives no group traffic', bossDrain.messages.length === 0, JSON.stringify(bossDrain))

    const lsHistory = await ls.call('bridge_history', { limit: 10 })
    check('own history includes group channels the peer is in', lsHistory.messages.some(m => m.channel === 'eng'), JSON.stringify(lsHistory.messages.map(m => m.to)))
    const grpHistory = await ls.call('bridge_history', { channel: 'eng', limit: 10 })
    check('channel history tail works for members', grpHistory.messages.some(m => m.content === '群里交接一下'), JSON.stringify(grpHistory))
    const bossGrpHistory = await boss.call('bridge_history', { channel: 'eng', limit: 10 })
    check('channel history readable by manager (non-member)', bossGrpHistory.messages.length >= 1, JSON.stringify(bossGrpHistory))

    const outsider = await ls.callRaw('bridge_group_send', { group: 'eng', message: 'x' }) // lisi IS a member; use a fresh outsider
    void outsider
    const stranger = makeClient('stranger9', base)
    await stranger.init()
    const notMember = await stranger.callRaw('bridge_group_send', { group: 'eng', message: 'hi' })
    check('non-member cannot send to the group', notMember.error !== undefined && /not a member/.test(notMember.error), JSON.stringify(notMember))
    // Writing INTO a channel is a membership privilege whatever tool is used:
    // `to` is one namespace for peers and groups, so bridge_chat / bridge_notice /
    // bridge_task reach a group through the same field. Only the group_send
    // wording checked, so any registered peer could post into a channel it was
    // never added to and every member received it.
    const strangerChat = await stranger.callRaw('bridge_chat', { to: 'eng', message: 'write into a channel I am not in' })
    check('non-member cannot chat into a group', strangerChat.error !== undefined && /not a member/.test(strangerChat.error), JSON.stringify(strangerChat))
    const strangerNotice = await stranger.callRaw('bridge_notice', { to: 'eng', message: 'same through a notice' })
    check('non-member cannot notify a group', strangerNotice.error !== undefined && /not a member/.test(strangerNotice.error), JSON.stringify(strangerNotice))
    const strangerGroupTask = await stranger.callRaw('bridge_task', { to: 'eng', prompt: 'same through a task' })
    check('non-member cannot delegate a task to a group', strangerGroupTask.error !== undefined && /not a member/.test(strangerGroupTask.error), JSON.stringify(strangerGroupTask))
    // The member half of the same route: `to: <group>` from inside is a normal
    // fan-out, not an error.
    await zs.call('bridge_chat', { to: 'eng', message: '成员直接用 to 发群消息' })
    const lsFromChat = await ls.call('bridge_wait', { timeoutMs: 2000 })
    check(
      'a member can still address the group through bridge_chat',
      lsFromChat.type === 'message' && lsFromChat.message.channel === 'eng' && lsFromChat.message.content === '成员直接用 to 发群消息',
      JSON.stringify(lsFromChat),
    )
    const deniedDelete = await stranger.callRaw('bridge_group_delete', { group: 'eng' })
    check('non-creator non-manager cannot delete a group', deniedDelete.error !== undefined && /manager/.test(deniedDelete.error), JSON.stringify(deniedDelete))

    // A group task carries the GROUP id in `to`, so an assignee (peerId ≠
    // groupId) must read its status through the assignee row — bridge_tasks
    // already lists it for them.
    const groupTask = await zs.call('bridge_task', { to: 'eng', prompt: '群里协作一下' })
    const assigneeRead = await ls.call('bridge_task_status', { ref: groupTask.id })
    check(
      'group-task assignee can read the task status',
      assigneeRead.task?.id === groupTask.id && assigneeRead.task?.assignees?.some(a => a.peerId === 'lisi'),
      JSON.stringify(assigneeRead),
    )
    const outsiderRead = await stranger.callRaw('bridge_task_status', { ref: groupTask.id })
    check('non-assignee non-member still denied the task status', outsiderRead.error !== undefined && /manager/.test(outsiderRead.error), JSON.stringify(outsiderRead))

    // dynamic membership: add/remove members after create (0.7.x)
    const wangwu = makeClient('wangwu', base)
    await wangwu.init()
    const wangDenied = await wangwu.callRaw('bridge_group_add_member', { group: 'eng', member: 'stranger9' })
    check('non-creator non-manager cannot add members', wangDenied.error !== undefined && /manager/.test(wangDenied.error), JSON.stringify(wangDenied))
    const bossAdd = await boss.call('bridge_group_add_member', { group: 'eng', member: 'wangwu' })
    check('manager can add a member', bossAdd.ok === true && bossAdd.group.members.includes('wangwu'), JSON.stringify(bossAdd))
    await zs.call('bridge_poll') // drain the earlier outsider "x" from lisi before waiting
    await wangwu.call('bridge_group_send', { group: 'eng', message: '由 manager 拉入后发言' })
    const zsGot = await zs.call('bridge_wait', { timeoutMs: 2000 })
    check('newly added member can send to the group', zsGot.type === 'message' && zsGot.message.channel === 'eng' && zsGot.message.content === '由 manager 拉入后发言', JSON.stringify(zsGot))
    const zsAdd = await zs.call('bridge_group_add_member', { group: 'eng', member: 'stranger9' })
    check('creator can add a member', zsAdd.ok === true && zsAdd.group.members.includes('stranger9'), JSON.stringify(zsAdd))
    const dupAdd = await zs.callRaw('bridge_group_add_member', { group: 'eng', member: 'stranger9' })
    check('duplicate member rejected at add', dupAdd.error !== undefined && /already a member/.test(dupAdd.error), JSON.stringify(dupAdd))
    const ghostAdd = await zs.callRaw('bridge_group_add_member', { group: 'eng', member: 'nobody' })
    check('unknown member rejected at add', ghostAdd.error !== undefined, JSON.stringify(ghostAdd))
    const removed = await zs.call('bridge_group_remove_member', { group: 'eng', member: 'lisi' })
    check('creator can remove a member', removed.ok === true && !removed.group.members.includes('lisi'), JSON.stringify(removed))
    const kickedSend = await ls.callRaw('bridge_group_send', { group: 'eng', message: 'x' })
    check('removed member cannot send to the group', kickedSend.error !== undefined && /not a member/.test(kickedSend.error), JSON.stringify(kickedSend))
    const selfRemoval = await zs.callRaw('bridge_group_remove_member', { group: 'eng', member: 'zhangsan' })
    check('creator cannot remove itself', selfRemoval.error !== undefined && /creator/.test(selfRemoval.error), JSON.stringify(selfRemoval))
    const unknownRemoval = await zs.callRaw('bridge_group_remove_member', { group: 'eng', member: 'nobody' })
    check('unknown member rejected at remove', unknownRemoval.error !== undefined && /not a member/.test(unknownRemoval.error), JSON.stringify(unknownRemoval))

    const deleted = await zs.call('bridge_group_delete', { group: 'eng' })
    check('creator can delete the group', deleted.ok === true, JSON.stringify(deleted))
    const afterDelete = await zs.callRaw('bridge_group_send', { group: 'eng', message: 'x' })
    check('send to deleted group rejected', afterDelete.error !== undefined && /unknown group/.test(afterDelete.error), JSON.stringify(afterDelete))
  } finally {
    hubGrp.close()
  }

  console.log('== task state machine (working / terminal lock / timeout / thread) ==')
  const hubSm = startHub({ port: 19012, waitTimeoutMs: 2000, maxQueue: 200, historyLimit: 100, connectedWindowMs: 60_000 }, { info: () => {}, warn: () => {} })
  try {
    const smA = makeClient('sm-a', `http://127.0.0.1:19012/mcp`)
    const smB = makeClient('sm-b', `http://127.0.0.1:19012/mcp`)
    await smA.init()
    await smB.init()
    const liveTask = await smA.call('bridge_task', { to: 'sm-b', prompt: 'state machine', threadId: 'thread-1' })
    await smB.call('bridge_ack', { ref: liveTask.id, status: 'working', progress: 40, note: 'halfway' })
    let liveStatus = await smA.call('bridge_task_status', { ref: liveTask.id })
    check('working+progress applied', liveStatus.task.status === 'working' && liveStatus.task.acks.at(-1).progress === 40 && liveStatus.task.threadId === 'thread-1', JSON.stringify(liveStatus.task))
    await smB.call('bridge_ack', { ref: liveTask.id, status: 'done', note: 'shipped' })
    liveStatus = await smA.call('bridge_task_status', { ref: liveTask.id })
    check('done applied after working', liveStatus.task.status === 'done', JSON.stringify(liveStatus.task))
    await smB.call('bridge_ack', { ref: liveTask.id, status: 'accepted', note: 'late' })
    liveStatus = await smA.call('bridge_task_status', { ref: liveTask.id })
    const late = liveStatus.task.acks.at(-1)
    check('terminal lock: late ack recorded but not applied', liveStatus.task.status === 'done' && late.applied === false && late.status === 'accepted', JSON.stringify({ status: liveStatus.task.status, late }))

    const thrWait = smB.call('bridge_wait', { threadId: 'thread-missing', timeoutMs: 400 })
    await smA.call('bridge_chat', { to: 'sm-b', message: 'off-thread' })
    const thrRes = await thrWait
    check('threadId filter ignores other threads', thrRes.type === 'timeout', JSON.stringify(thrRes))
    await smB.call('bridge_poll')

    const timed = await smA.call('bridge_task', { to: 'sm-b', prompt: 'will time out', timeoutMs: 200 })
    await new Promise(r => setTimeout(r, 350))
    const timedStatus = await smA.call('bridge_task_status', { ref: timed.id })
    check('timeoutMs marks the task timeout', timedStatus.task.status === 'timeout' && timedStatus.task.acks.some(a => a.system === true), JSON.stringify(timedStatus.task))

    // A deadline past setTimeout's 2^31-1 ms ceiling used to overflow the SLA
    // timer and fire it after ~1 ms, timing the task out on the spot.
    const farSla = await smA.call('bridge_task', { to: 'sm-b', prompt: 'far deadline', timeoutMs: 3_000_000_000 })
    await new Promise(r => setTimeout(r, 200))
    const farStatus = await smA.call('bridge_task_status', { ref: farSla.id })
    check(
      'multi-day timeoutMs stays pending (timer not truncated to ~1ms)',
      farStatus.task.status === 'pending' && farStatus.task.deadlineAt - Date.now() > 2_000_000_000,
      JSON.stringify({ status: farStatus.task.status, deadlineAt: farStatus.task.deadlineAt, now: Date.now() }),
    )

    const floodTask = await smA.call('bridge_task', { to: 'sm-b', prompt: 'survive eviction' })
    for (let i = 0; i < 120; i++) await smA.call('bridge_chat', { to: 'sm-b', message: `flood-${i}` })
    await smB.call('bridge_poll')
    await smB.call('bridge_ack', { ref: floodTask.id, status: 'accepted' })
    const floodStatus = await smA.call('bridge_task_status', { ref: floodTask.id })
    check('ack routes via ledger after history eviction', floodStatus.task.status === 'accepted', JSON.stringify(floodStatus.task.status))

    // Reply-chain depth: a plain conversation may run far past the old 5-hop
    // wall, which used to refuse a legitimate sixth turn outright.
    let hopMsg = await smA.call('bridge_chat', { to: 'sm-b', message: 'hop-0' })
    for (let i = 1; i <= 5; i++) {
      hopMsg = await smB.call('bridge_chat', { to: 'sm-a', message: `hop-${i}`, ref: hopMsg.id })
    }
    check('reply chain of 5 carries hop 5', hopMsg.hop === 5, JSON.stringify(hopMsg))
    const hop6 = await smA.call('bridge_chat', { to: 'sm-b', message: 'hop-6', ref: hopMsg.id })
    check('the 6th reply is delivered, not rejected (hop keeps counting)', hop6.hop === 6 && hop6.ref === hopMsg.id, JSON.stringify(hop6))
  } finally {
    hubSm.close()
  }

  // ---- ack integrity (W1..W7) ---------------------------------------------------
  // Ledger writes are gated on being an assignee, a dropped task has to reach a
  // terminal state, reserved ids are not claimable, and the task list has to
  // honour every status the ledger can hold. Each check states the behaviour,
  // so it keeps its meaning once the fix lands.
  console.log('== ack integrity: only an assignee may move the ledger (W1/W2) ==')
  const hubAck = startHub({ port: 19013, waitTimeoutMs: 2000, maxQueue: 20, historyLimit: 30, connectedWindowMs: 60_000 }, { info: () => {}, warn: () => {} })
  try {
    const ackBase = 'http://127.0.0.1:19013/mcp'
    const sender = makeClient('sender', ackBase)
    const assignee = makeClient('assignee', ackBase)
    const intruder = makeClient('intruder', ackBase)
    await Promise.all([sender.init(), assignee.init(), intruder.init()])
    await Promise.all([sender.register('sender'), assignee.register('assignee'), intruder.register('intruder')])

    const t1 = await sender.call('bridge_task', { to: 'assignee', prompt: 'produce the deliverable' })
    // The intruder has no row on this task. Its ack must be refused outright and
    // must reach neither the status nor the artifact list — otherwise anyone on
    // the hub can close someone else's task and inject its output.
    const forged = await intruder.callRaw('bridge_ack', { ref: t1.id, status: 'done', note: 'forged', artifacts: [{ name: 'fake.txt', text: 'not real' }] })
    check('ack from a non-assignee is rejected', forged.error !== undefined, JSON.stringify(forged))
    const afterForged = await sender.call('bridge_task_status', { ref: t1.id })
    const forgedArtifacts = afterForged.task?.artifacts ?? []
    check(
      'a rejected third-party ack leaves the task pending with no artifacts',
      afterForged.task?.status === 'pending' && forgedArtifacts.length === 0,
      JSON.stringify({ status: afterForged.task?.status, artifacts: forgedArtifacts }),
    )
    await assignee.call('bridge_ack', { ref: t1.id, status: 'done', artifacts: [{ name: 'real.txt', text: 'real deliverable' }] })
    const afterReal = await sender.call('bridge_task_status', { ref: t1.id })
    const realLast = afterReal.task?.acks?.at(-1)
    const artifactNames = (afterReal.task?.artifacts ?? []).map(a => a.name)
    check(
      'the assignee done is applied and only its artifacts are recorded',
      afterReal.task?.status === 'done' && realLast?.applied === true && artifactNames.includes('real.txt') && !artifactNames.includes('fake.txt'),
      JSON.stringify({ status: afterReal.task?.status, applied: realLast?.applied, from: realLast?.from, artifacts: artifactNames }),
    )

    // W5: `input-required` is a real ledger state, so the task list must filter
    // by it — the ack is accepted today while bridge_tasks rejects the very
    // status it produces.
    const irTask = await sender.call('bridge_task', { to: 'assignee', prompt: 'need details before shipping' })
    await assignee.call('bridge_ack', { ref: irTask.id, status: 'input-required', note: 'need info' })
    const irList = await sender.callRaw('bridge_tasks', { role: 'sent', status: 'input-required' })
    check('bridge_tasks accepts the input-required status filter', irList.error === undefined, JSON.stringify(irList))
    const canceledList = await sender.callRaw('bridge_tasks', { role: 'sent', status: 'canceled' })
    check('bridge_tasks accepts the canceled status filter', canceledList.error === undefined, JSON.stringify(canceledList))
    check(
      'the input-required task is listed under its own status',
      irList.tasks?.length === 1 && irList.tasks[0]?.id === irTask.id && irList.tasks[0]?.status === 'input-required',
      JSON.stringify({ error: irList.error, tasks: irList.tasks?.map(t => ({ id: t.id, status: t.status })) }),
    )
    // ... and a filter that is accepted must also MATCH: an empty result would
    // have made the "accepted" assertion above true for a filter that silently
    // matched nothing.
    const cancelTask = await sender.call('bridge_task', { to: 'assignee', prompt: 'never mind, scope dropped' })
    await sender.call('bridge_task_cancel', { ref: cancelTask.id, reason: 'scope dropped' })
    const canceledListed = await sender.callRaw('bridge_tasks', { role: 'sent', status: 'canceled' })
    check(
      'a canceled task is listed under the canceled status filter',
      canceledListed.error === undefined && canceledListed.tasks?.length === 1
        && canceledListed.tasks[0]?.id === cancelTask.id && canceledListed.tasks[0]?.status === 'canceled',
      JSON.stringify({ error: canceledListed.error, tasks: canceledListed.tasks?.map(t => ({ id: t.id, status: t.status })) }),
    )
  } finally {
    hubAck.close()
  }

  console.log('== dropped task reconciliation (W3/W4) ==')
  // maxQueue 1: a chat sent right after a task squeezes the task out of the
  // mailbox. The loss has to be RECORDED, but it must not close the ledger: an
  // overflow is driven by a third party's traffic, so closing it would let any
  // peer veto a task it was not assigned, and a dead letter in the same
  // situation can still be revived with bridge_nack. The sender — the only
  // party that can act on the loss — is told about it.
  const hubDrop = startHub({ port: 19014, waitTimeoutMs: 2000, maxQueue: 1, historyLimit: 20, connectedWindowMs: 60_000 }, { info: () => {}, warn: () => {} })
  try {
    const dropBase = 'http://127.0.0.1:19014/mcp'
    const q1 = makeClient('q1', dropBase)
    const q2 = makeClient('q2', dropBase)
    await Promise.all([q1.init(), q2.init()])
    await Promise.all([q1.register('q1'), q2.register('q2')])

    const droppedTask = await q1.call('bridge_task', { to: 'q2', prompt: 'squeezed out of the mailbox' })
    await q1.call('bridge_chat', { to: 'q2', message: 'takes the only slot' })
    const dropStatus = await q1.call('bridge_task_status', { ref: droppedTask.id })
    const systemAck = dropStatus.task?.acks?.find(a => a.system === true)
    check(
      'a task dropped by overflow is recorded without closing the ledger',
      dropStatus.task?.status === 'pending' && systemAck !== undefined && systemAck.applied === false,
      JSON.stringify({ status: dropStatus.task?.status, acks: dropStatus.task?.acks?.map(a => ({ from: a.from, status: a.status, system: a.system, applied: a.applied })) }),
    )
    // The event is the operator's only trail back to what was lost, so it has to
    // name the message that went, not just count a drop.
    const dropEvents = await q1.call('bridge_events', { limit: 100 })
    const droppedEvents = dropEvents.events.filter(e => e.kind === 'mailbox_dropped')
    check(
      'the mailbox_dropped event names the dropped message id',
      droppedEvents.some(e => e.detail?.messageId === droppedTask.id),
      JSON.stringify(droppedEvents.map(e => e.detail)),
    )
    // A drop the sender never hears about is a task it waits on forever. The
    // notice comes from the hub itself and names the task it concerned.
    const dropMail = await q1.call('bridge_poll')
    const hubNotice = dropMail.messages.find(m => m.from === 'hub')
    check(
      'the sender is notified when its task delivery is dropped',
      hubNotice !== undefined && hubNotice.kind === 'notice' && typeof hubNotice.content?.message === 'string' && hubNotice.content.message.includes(droppedTask.id),
      JSON.stringify(dropMail.messages.map(m => ({ from: m.from, kind: m.kind, content: m.content }))),
    )
    // The other half of that guarantee: "delegate, then wait for the result with
    // `from: <assignee>`" is the most ordinary pattern there is, and a `from`
    // filter used to hide the hub's own warning — the sender waited out the
    // timeout and never learned its task had been dropped.
    const droppedAgain = await q1.call('bridge_task', { to: 'q2', prompt: 'squeezed out of the mailbox again' })
    await q1.call('bridge_chat', { to: 'q2', message: 'takes the only slot again' })
    const fromFiltered = await q1.call('bridge_wait', { from: 'q2', timeoutMs: 1000 })
    check(
      'a from-filtered wait still receives the hub drop notice',
      fromFiltered.type === 'message' && fromFiltered.message.from === 'hub'
        && typeof fromFiltered.message.content?.message === 'string' && fromFiltered.message.content.message.includes(droppedAgain.id),
      JSON.stringify(fromFiltered),
    )
  } finally {
    hubDrop.close()
  }

  console.log('== a rate drop never books a delivery (W4) ==')
  // ratePerMin 1: the chat uses the minute's only token, so the task behind it
  // is dropped by the bucket and never enters the mailbox. A `deliveredMs` on it
  // would claim a delivery that never happened.
  const hubRate = startHub({ port: 19017, waitTimeoutMs: 2000, maxQueue: 10, historyLimit: 20, connectedWindowMs: 60_000, ratePerMin: 1 }, { info: () => {}, warn: () => {} })
  try {
    const rateBase = 'http://127.0.0.1:19017/mcp'
    const r1 = makeClient('r1', rateBase)
    const r2 = makeClient('r2', rateBase)
    await Promise.all([r1.init(), r2.init()])
    await Promise.all([r1.register('r1'), r2.register('r2')])

    await r1.call('bridge_chat', { to: 'r2', message: 'uses up the only token of the minute' })
    const rateTask = await r1.call('bridge_task', { to: 'r2', prompt: 'dropped by the rate bucket' })
    const rateStatus = await r1.call('bridge_task_status', { ref: rateTask.id })
    const rateRow = rateStatus.task?.assignees?.[0]
    check(
      'a rate-limited task is not booked as delivered and stays pending',
      rateRow !== undefined && rateRow.deliveredMs === undefined && rateStatus.task?.status === 'pending',
      JSON.stringify({ assignee: rateRow?.peerId, deliveredMs: rateRow?.deliveredMs, status: rateStatus.task?.status }),
    )
  } finally {
    hubRate.close()
  }

  console.log('== a fan-out task warns its sender once, not once per recipient ==')
  // A broadcast task evicted at K recipients used to hand the sender K notices,
  // and those notices queue in — and push out — the sender's own mailbox.
  // maxQueue 2 on purpose: with a tighter mailbox the second notice would evict
  // the first and the assertion could not tell de-duplication from eviction.
  const hubFan = startHub({ port: 19019, waitTimeoutMs: 2000, maxQueue: 2, historyLimit: 20, connectedWindowMs: 60_000 }, { info: () => {}, warn: () => {} })
  try {
    const fanBase = 'http://127.0.0.1:19019/mcp'
    const f1 = makeClient('f1', fanBase)
    const f2 = makeClient('f2', fanBase)
    const f3 = makeClient('f3', fanBase)
    await Promise.all([f1.init(), f2.init(), f3.init()])
    await Promise.all([f1.register('f1'), f2.register('f2'), f3.register('f3')])

    const fanTask = await f1.call('bridge_task', { to: 'all', prompt: 'evicted at every recipient' })
    // Each recipient's mailbox now holds [task]; one chat fills it (2 = maxQueue)
    // and the next one evicts the OLDEST of the lowest priority — the task.
    for (const target of ['f2', 'f3']) await f1.call('bridge_chat', { to: target, message: 'fills the mailbox' })
    for (const target of ['f2', 'f3']) await f1.call('bridge_chat', { to: target, message: 'evicts the task' })
    const fanMail = await f1.call('bridge_poll')
    const fanNotices = fanMail.messages.filter(
      m => m.from === 'hub' && typeof m.content?.message === 'string' && m.content.message.includes(fanTask.id),
    )
    check(
      'a task dropped at several recipients warns its sender exactly once',
      fanNotices.length === 1,
      JSON.stringify(fanMail.messages.map(m => ({ from: m.from, content: m.content }))),
    )
    const fanStatus = await f1.call('bridge_task_status', { ref: fanTask.id })
    const fanEvents = fanStatus.task?.acks?.filter(a => a.system === true && a.applied === false) ?? []
    check(
      'the ledger still records every dropped delivery of that task',
      fanEvents.length === 2,
      JSON.stringify(fanStatus.task?.acks?.map(a => ({ from: a.from, messageId: a.messageId, applied: a.applied, system: a.system }))),
    )
    // `dropNotified` is INTERNAL (protocol.ts) — it exists so the sender is warned
    // once, and a consumer must not be able to build on it. It is at its most
    // visible exactly here, right after a drop.
    check(
      'the internal drop bookkeeping stays out of the task shape',
      fanStatus.task !== undefined && !('dropNotified' in fanStatus.task),
      JSON.stringify(Object.keys(fanStatus.task ?? {})),
    )
    const fanList = await f1.call('bridge_tasks', { role: 'sent' })
    check(
      'bridge_tasks omits it too',
      fanList.tasks.every(t => !('dropNotified' in t)),
      JSON.stringify(fanList.tasks.map(t => Object.keys(t))),
    )
  } finally {
    hubFan.close()
  }

  console.log('== a dead-lettered task stays completable after a nack (W3) ==')
  // maxAttempts 1 + a lease the assignee never commits: the second take
  // dead-letters the message. bridge_nack revives it, and the assignee must
  // still be able to close the task — a terminal write at drop time would make
  // the revival pointless (the done ack would land as applied:false).
  const hubDead = startHub({ port: 19018, waitTimeoutMs: 2000, maxQueue: 10, historyLimit: 20, connectedWindowMs: 60_000, leaseTtlMs: 100, maxAttempts: 1 }, { info: () => {}, warn: () => {} })
  try {
    const deadBase = 'http://127.0.0.1:19018/mcp'
    const dl1 = makeClient('dl1', deadBase)
    const dl2 = makeClient('dl2', deadBase)
    await Promise.all([dl1.init(), dl2.init()])
    await Promise.all([dl1.register('dl1'), dl2.register('dl2')])

    const dlTask = await dl1.call('bridge_task', { to: 'dl2', prompt: 'dead-letters, then gets revived' })
    const leased = await dl2.call('bridge_wait', { timeoutMs: 1000, ack: 'manual' })
    check('(setup) the task is leased to the assignee', leased.message?.id === dlTask.id, JSON.stringify(leased))
    await new Promise(r => setTimeout(r, 250)) // leaseTtlMs 100 → the lease has expired
    const reaped = await dl2.call('bridge_poll')
    check('(setup) the un-committed task dead-letters instead of coming back', reaped.messages.length === 0, JSON.stringify(reaped))
    const deadStatus = await dl1.call('bridge_task_status', { ref: dlTask.id })
    check(
      '(setup) a dead letter leaves the task open',
      deadStatus.task?.status === 'pending' && deadStatus.task?.acks?.some(a => a.system === true && a.applied === false),
      JSON.stringify({ status: deadStatus.task?.status, acks: deadStatus.task?.acks?.map(a => ({ status: a.status, applied: a.applied, system: a.system })) }),
    )
    const revived = await dl2.call('bridge_nack', { ids: [dlTask.id] })
    check('(setup) bridge_nack revives the dead letter', revived.requeued === 1, JSON.stringify(revived))
    // The notice the sender got has to name an action the SENDER can take. A
    // dead-lettered copy is filed under the assignee's own table, so "call
    // bridge_nack" addressed to the sender was a dead end (`requeued: 0`).
    const dlSenderMail = await dl1.call('bridge_poll')
    const dlNotice = (dlSenderMail.messages ?? []).find(m => m.from === 'hub' && String(m.content?.message ?? '').includes(dlTask.id))
    check(
      'the dead-letter notice points the sender at the peer that can actually revive it',
      dlNotice !== undefined && String(dlNotice.content?.message ?? '').includes("dead letters of 'dl2'"),
      JSON.stringify(dlNotice?.content ?? null),
    )
    const redelivered = await dl2.call('bridge_wait', { timeoutMs: 1000 })
    check('(setup) the revived task is handed out again', redelivered.message?.id === dlTask.id, JSON.stringify(redelivered))

    await dl2.call('bridge_ack', { ref: dlTask.id, status: 'done' })
    const doneStatus = await dl1.call('bridge_task_status', { ref: dlTask.id })
    const doneAck = doneStatus.task?.acks?.at(-1)
    check(
      'a revived dead-lettered task can still be completed',
      doneStatus.task?.status === 'done' && doneAck?.applied === true && doneAck?.status === 'done',
      JSON.stringify({ status: doneStatus.task?.status, acks: doneStatus.task?.acks?.map(a => ({ from: a.from, status: a.status, applied: a.applied, system: a.system })) }),
    )
  } finally {
    hubDead.close()
  }

  console.log('== lease accounting cannot be reset or outgrow the mailbox (W9) ==')
  // Three ways a lease used to escape its own bounds: `commit` wiped the attempt
  // counter of messages it had not released (so nack+commit looped forever), and
  // a requeued lease went back into a mailbox with no capacity check at all.
  const hubLeaseAcc = startHub({ port: 19021, waitTimeoutMs: 2000, maxQueue: 10, historyLimit: 20, connectedWindowMs: 60_000, leaseTtlMs: 400, maxAttempts: 2 }, { info: () => {}, warn: () => {} })
  try {
    const accBase = 'http://127.0.0.1:19021/mcp'
    const accA = makeClient('acc-a', accBase)
    const accB = makeClient('acc-b', accBase)
    await Promise.all([accA.init(), accB.init()])
    await Promise.all([accA.register('acc-a'), accB.register('acc-b')])

    // The DECOY is the point: `commit` returns early when the peer holds no lease
    // at all, so the counter could only be wiped while another lease kept the list
    // non-empty. That is the shape of the real bypass.
    await accA.call('bridge_chat', { to: 'acc-b', message: 'decoy lease, never committed' })
    await accA.call('bridge_chat', { to: 'acc-b', message: 'retried until it dead-letters' })
    const decoyTake = await accB.call('bridge_wait', { timeoutMs: 2000, ack: 'manual' })
    const firstTake = await accB.call('bridge_wait', { timeoutMs: 2000, ack: 'manual' })
    check(
      '(setup) both messages are leased at attempt 1',
      decoyTake.message?.content === 'decoy lease, never committed' && firstTake.message?.content === 'retried until it dead-letters' && firstTake.message?.attempts === 1,
      JSON.stringify({ decoy: decoyTake.message?.content, target: firstTake.message?.content, attempts: firstTake.message?.attempts }),
    )
    const gaveBack = await accB.call('bridge_nack', { ids: [firstTake.message.id] })
    check('(setup) bridge_nack puts it back in the queue', gaveBack.requeued === 1, JSON.stringify(gaveBack))
    // The bypass: the target is no longer leased, so this commit releases nothing —
    // it must therefore NOT forget the attempt the nack preserved.
    const staleCommit = await accB.call('bridge_commit', { ids: [firstTake.message.id] })
    check('(setup) committing a message that is not leased releases nothing', staleCommit.committed === 0, JSON.stringify(staleCommit))
    const secondTake = await accB.call('bridge_wait', { timeoutMs: 2000, ack: 'manual' })
    check(
      'a nack keeps the attempt count, so the next take is attempt 2',
      secondTake.message?.id === firstTake.message.id && secondTake.message?.attempts === 2,
      JSON.stringify({ id: secondTake.message?.id, attempts: secondTake.message?.attempts }),
    )
    await new Promise(r => setTimeout(r, 700)) // leaseTtlMs 400 → both leases have expired
    const afterExhaustion = await accB.call('bridge_poll')
    const accMetrics = await accB.call('bridge_metrics')
    const accRow = accMetrics.peers?.find(row => row.peerId === 'acc-b')
    check(
      'the exhausted lease dead-letters instead of being handed out again',
      afterExhaustion.messages.length === 1 && afterExhaustion.messages[0].content === 'decoy lease, never committed' && (accRow?.deadLettered ?? 0) === 1,
      JSON.stringify({ polled: afterExhaustion.messages.map(m => m.content), deadLettered: accRow?.deadLettered }),
    )
    // bridge_nack takes an `ids` array; an unbounded one would have the hub walk
    // it synchronously.
    const tooManyIds = await accB.callRaw('bridge_nack', { ids: Array.from({ length: 1001 }, (_, i) => `id-${i}`) })
    check('bridge_nack rejects an oversized ids array', tooManyIds.error !== undefined && /at most 1000/.test(tooManyIds.error), JSON.stringify(tooManyIds).slice(0, 200))
  } finally {
    hubLeaseAcc.close()
  }

  console.log('== a requeued lease competes for a mailbox slot (W9) ==')
  // The expired lease comes back while the mailbox is already full. Putting it
  // back unconditionally grew the queue past maxQueue (and pushed the mailbox
  // into a state nobody bound); what does not fit goes to the dead letters, where
  // bridge_nack can still revive it.
  const hubCap = startHub({ port: 19022, waitTimeoutMs: 2000, maxQueue: 1, historyLimit: 20, connectedWindowMs: 60_000, leaseTtlMs: 100, maxAttempts: 5 }, { info: () => {}, warn: () => {} })
  try {
    const capBase = 'http://127.0.0.1:19022/mcp'
    const capA = makeClient('cap-a', capBase)
    const capB = makeClient('cap-b', capBase)
    await Promise.all([capA.init(), capB.init()])
    await Promise.all([capA.register('cap-a'), capB.register('cap-b')])
    await capA.call('bridge_chat', { to: 'cap-b', message: 'leased first' })
    const capLeased = await capB.call('bridge_wait', { timeoutMs: 2000, ack: 'manual' })
    check('(setup) the first message is leased out', capLeased.message?.content === 'leased first', JSON.stringify(capLeased))
    await capA.call('bridge_chat', { to: 'cap-b', message: 'queued while leased' })
    await new Promise(r => setTimeout(r, 250)) // leaseTtlMs 100 → expired, mailbox is full
    const capPolled = await capB.call('bridge_poll')
    const capMetrics = await capB.call('bridge_metrics')
    const capRow = capMetrics.peers?.find(row => row.peerId === 'cap-b')
    check(
      'a requeued lease never grows the mailbox past maxQueue',
      capPolled.messages.length === 1 && capPolled.messages[0].content === 'queued while leased',
      JSON.stringify(capPolled.messages.map(m => m.content)),
    )
    check(
      'the lease that did not fit is dead-lettered, not dropped',
      (capRow?.deadLettered ?? 0) === 1,
      JSON.stringify(capRow),
    )
  } finally {
    hubCap.close()
  }

  console.log('== a restored mailbox that does not fit evicts visibly, not silently (W10) ==')
  // The snapshot now appends leases to the queue, so it can hold MORE rows than
  // maxQueue. Restoring used to `slice` the excess away — the oldest rows first,
  // with no count and no ledger reconcile — which is the one thing this hub must
  // never do to someone's mail.
  const mailboxDb = `${tmpdir()}/hub-mailbox-overflow-${Date.now()}.db`
  let fullId
  const hubOverflowA = startHub({ port: 19024, waitTimeoutMs: 2000, maxQueue: 2, historyLimit: 20, connectedWindowMs: 60_000, leaseTtlMs: 60_000, db: mailboxDb }, { info: () => {}, warn: () => {} })
  try {
    const ovBase = 'http://127.0.0.1:19024/mcp'
    const ovA = makeClient('ov-a', ovBase)
    const ovB = makeClient('ov-b', ovBase)
    await Promise.all([ovA.init(), ovB.init()])
    await Promise.all([ovA.register('ov-a'), ovB.register('ov-b')])
    const first = await ovA.call('bridge_chat', { to: 'ov-b', message: 'lease me' })
    await ovA.call('bridge_chat', { to: 'ov-b', message: 'stays queued' })
    // Lease the first one out (2 queued → 1 queued + 1 in flight), then fill the
    // mailbox again: 1 queued + 1 tenant at close, i.e. 3 rows in the snapshot.
    const leasedOv = await ovB.call('bridge_wait', { timeoutMs: 2000, ack: 'manual' })
    await ovA.call('bridge_chat', { to: 'ov-b', message: 'fills the mailbox' })
    // Read the snapshot itself: "a chat call returned an id" was true no matter
    // what the mailbox held, which proved nothing about the row count this whole
    // restore case depends on.
    const ovSnapshot = hubOverflowA.hub.exportMailboxes()
    check(
      '(setup) the snapshot will hold one row more than maxQueue',
      leasedOv.message?.id === first.id && ovSnapshot['ov-b']?.length === 3,
      JSON.stringify({ leased: leasedOv.message?.content, rows: ovSnapshot['ov-b']?.map(m => m.content) }),
    )
    fullId = leasedOv.message?.id
  } finally {
    hubOverflowA.close() // exports queue + lease: 3 rows for a maxQueue of 2
  }
  const hubOverflowB = startHub({ port: 19025, waitTimeoutMs: 2000, maxQueue: 2, historyLimit: 20, connectedWindowMs: 60_000, leaseTtlMs: 60_000, db: mailboxDb }, { info: () => {}, warn: () => {} })
  try {
    const ovBase2 = 'http://127.0.0.1:19025/mcp'
    const ovB2 = makeClient('ov-b', ovBase2)
    await ovB2.init()
    const ovEvents = await ovB2.call('bridge_events')
    const overflowEvent = ovEvents.events?.find(e => e.kind === 'mailbox_dropped' && e.peer === 'ov-b' && e.detail?.reason === 'overflow')
    check(
      'a restored mailbox that exceeds maxQueue counts the eviction (mailbox_dropped names the message)',
      overflowEvent !== undefined && overflowEvent.detail?.messageId === fullId,
      JSON.stringify(ovEvents.events?.filter(e => e.kind === 'mailbox_dropped')),
    )
    const ovPoll = await ovB2.call('bridge_poll')
    const ovContents = (ovPoll.messages ?? []).map(m => m.content)
    check(
      'a restored mailbox never exceeds maxQueue',
      ovContents.length <= 2,
      JSON.stringify(ovContents),
    )
    check(
      'the OLDEST row goes (the already-leased message), so the queued mail survives',
      ovContents.includes('stays queued') && ovContents.includes('fills the mailbox') && !ovContents.includes('lease me'),
      JSON.stringify(ovContents),
    )
  } finally {
    hubOverflowB.close()
    rmSync(mailboxDb, { force: true })
  }

  console.log('== a dead-letter eviction settles the task it destroys (W10) ==')
  // A dead letter is the LAST copy of a message the hub promised to keep, and
  // the sender was told `bridge_nack` can revive it. Once the bounded table
  // evicts it, no revival path exists — so the ledger may not keep saying
  // `pending` (or keep promising a nack) for a task that is gone.
  const hubEvicted = startHub({ port: 19026, waitTimeoutMs: 2000, maxQueue: 10, historyLimit: 20, connectedWindowMs: 60_000 }, { info: () => {}, warn: () => {} })
  try {
    const evBase = 'http://127.0.0.1:19026/mcp'
    const evA = makeClient('ev-a', evBase)
    const evB = makeClient('ev-b', evBase)
    await Promise.all([evA.init(), evB.init()])
    await Promise.all([evA.register('ev-a'), evB.register('ev-b')])
    const evTask = await evA.call('bridge_task', { to: 'ev-b', prompt: 'its last copy is evicted' })
    const evBefore = await evA.call('bridge_task_status', { ref: evTask.id })
    check('(setup) the task is still open before the eviction', evBefore.task?.status === 'pending', JSON.stringify(evBefore.task?.status))
    // MAX_DEAD_LETTERS is a module constant (200), not an option, so the prune
    // path is driven directly instead of dead-lettering 200 messages through the
    // hub. The task goes into the table FIRST and the 200 fillers arrive after:
    // that makes the task the OLDEST row, i.e. exactly the one the eviction
    // takes, with no other message in the same batch.
    const nowEv = Date.now()
    hubEvicted.hub.deadLetter('ev-b', [
      { id: evTask.id, from: 'ev-a', to: 'ev-b', kind: 'task', content: '{}', ts: nowEv },
    ], nowEv)
    const evParked = await evA.call('bridge_task_status', { ref: evTask.id })
    check(
      '(setup) a dead letter leaves the task open (the nack promise)',
      evParked.task?.status === 'pending' && (evParked.task?.acks ?? []).some(a => a.system === true && a.applied === false),
      JSON.stringify({ status: evParked.task?.status, acks: evParked.task?.acks?.map(a => ({ id: a.messageId, applied: a.applied })) }),
    )
    const fillers = Array.from({ length: 200 }, (_, i) => ({
      id: `ev-filler-${i}`, from: 'ev-a', to: 'ev-b', kind: 'chat', content: 'filler', ts: nowEv,
    }))
    hubEvicted.hub.deadLetter('ev-b', fillers, nowEv)
    const evAfter = await evA.call('bridge_task_status', { ref: evTask.id })
    const evEvicted = (evAfter.task?.acks ?? []).find(a => a.messageId === `evicted-${evTask.id}`)
    check(
      'an evicted dead-letter task is settled as failed, not left pending',
      evAfter.task?.status === 'failed' && evAfter.task?.assignees?.[0]?.status === 'failed',
      JSON.stringify({ status: evAfter.task?.status, assignees: evAfter.task?.assignees?.map(a => a.status) }),
    )
    check(
      'the eviction writes its own system event (distinct from the dead-letter one)',
      evEvicted?.applied === true && evEvicted?.system === true,
      JSON.stringify(evAfter.task?.acks?.map(a => ({ id: a.messageId, applied: a.applied, system: a.system }))),
    )
    const evNotice = await evA.call('bridge_poll')
    // The tool layer already decodes notice content into an object.
    const evNoticeText = (evNotice.messages ?? [])
      .filter(m => m.from === 'hub')
      .map(m => (typeof m.content?.message === 'string' ? m.content.message : ''))
    check(
      'the sender is told the copy is gone for good (no nack promise)',
      evNoticeText.some(text => text.includes('evicted from the dead letters') && !text.includes('bridge_nack')),
      JSON.stringify(evNoticeText),
    )
  } finally {
    hubEvicted.close()
  }

  console.log('== an ack timeline stays bounded per assignee, drops included (W10) ==')
  // `pushAckEvent` bounded the task timeline but not each assignee's own one: an
  // assignee that keeps acking `working` grew both without limit, and
  // `exportTasks` serializes the whole ledger on every flush. The eviction also
  // has to protect `system: true` rows — those ARE the drop evidence.
  const hubAcks = startHub({ port: 19027, waitTimeoutMs: 2000, maxQueue: 10, historyLimit: 20, connectedWindowMs: 60_000 }, { info: () => {}, warn: () => {} })
  try {
    const acksBase = 'http://127.0.0.1:19027/mcp'
    const acksA = makeClient('acks-a', acksBase)
    const acksB = makeClient('acks-b', acksBase)
    await Promise.all([acksA.init(), acksB.init()])
    await Promise.all([acksA.register('acks-a'), acksB.register('acks-b')])
    const acksTask = await acksA.call('bridge_task', { to: 'acks-b', prompt: 'ack forever' })
    // One system drop row FIRST, so the protection below has something to lose.
    hubAcks.hub.noteTaskDeliveryDropped(
      { id: acksTask.id, from: 'acks-a', to: 'acks-b', kind: 'task', content: '{}', ts: Date.now() },
      'acks-b', 'overflow', Date.now(),
    )
    // 205 > MAX_TASK_ACKS (200). The direct API is the same ledger path
    // `bridge_ack` uses; 205 MCP round trips would only add runtime.
    for (let i = 0; i < 205; i++) hubAcks.hub.sendAck('acks-b', acksTask.id, { status: 'working', note: `tick ${i}` })
    const acksStatus = await acksA.call('bridge_task_status', { ref: acksTask.id })
    check(
      'the per-assignee timeline is bounded by the same limit',
      (acksStatus.task?.assignees?.[0]?.acks?.length ?? 0) === 200,
      `assignee acks=${acksStatus.task?.assignees?.[0]?.acks?.length}`,
    )
    check(
      'the task timeline is bounded too',
      (acksStatus.task?.acks?.length ?? 0) === 200,
      `task acks=${acksStatus.task?.acks?.length}`,
    )
    // The plain `working` acks are applied and non-system: they are what must go
    // before the one row that says a delivery was lost.
    check(
      'a system drop event survives 205 ordinary acks',
      (acksStatus.task?.acks ?? []).some(a => a.system === true && a.applied === false && a.messageId === `dropped-${acksTask.id}`),
      JSON.stringify((acksStatus.task?.acks ?? []).slice(0, 3).map(a => ({ id: a.messageId, system: a.system, applied: a.applied }))),
    )
  } finally {
    hubAcks.close()
  }

  console.log('== a fan-out task keeps its SLA when one recipient is lost (W10) ==')
  // `failTaskForDroppedMessage` cleared the SLA timer unconditionally. For a
  // broadcast that is wrong: the aggregate stays open because another assignee is
  // still working, and nothing re-arms the timer — the task then sits
  // non-terminal forever instead of timing out.
  const hubFanSla = startHub({ port: 19028, waitTimeoutMs: 2000, maxQueue: 10, historyLimit: 20, connectedWindowMs: 60_000 }, { info: () => {}, warn: () => {} })
  try {
    const slaBase = 'http://127.0.0.1:19028/mcp'
    const slaA = makeClient('sla-a', slaBase)
    const slaB = makeClient('sla-b', slaBase)
    const slaC = makeClient('sla-c', slaBase)
    await Promise.all([slaA.init(), slaB.init(), slaC.init()])
    await Promise.all([slaA.register('sla-a'), slaB.register('sla-b'), slaC.register('sla-c')])
    const slaTask = await slaA.call('bridge_task', { to: 'all', prompt: 'one recipient leaves', timeoutMs: 700 })
    const slaBefore = await slaA.call('bridge_task_status', { ref: slaTask.id })
    check(
      '(setup) the broadcast task has two assignees',
      slaBefore.task?.assignees?.length === 2,
      JSON.stringify(slaBefore.task?.assignees?.map(a => a.peerId)),
    )
    hubFanSla.hub.unregister('sla-b') // a manager kick: the peer and its copy are gone
    const slaKicked = await slaA.call('bridge_task_status', { ref: slaTask.id })
    check(
      '(setup) one assignee failed but the task is still open',
      slaKicked.task?.assignees?.find(a => a.peerId === 'sla-b')?.status === 'failed' && slaKicked.task?.status === 'pending',
      JSON.stringify({ status: slaKicked.task?.status, assignees: slaKicked.task?.assignees?.map(a => ({ p: a.peerId, s: a.status })) }),
    )
    await new Promise(r => setTimeout(r, 1200)) // timeoutMs 700 → the SLA has fired
    const slaAfter = await slaA.call('bridge_task_status', { ref: slaTask.id })
    check(
      'a fan-out task still times out after one of its copies was dropped',
      slaAfter.task?.status === 'timeout',
      JSON.stringify({ status: slaAfter.task?.status, assignees: slaAfter.task?.assignees?.map(a => ({ p: a.peerId, s: a.status })) }),
    )
  } finally {
    hubFanSla.close()
  }

  console.log('== leaving the hub takes the leases with it (W9) ==')
  // A kicked peer kept its manual leases. The next reap pushed the message back
  // into a queue the hub had already dropped — under a peer with no `parkedAt` —
  // so neither a take nor `expireParkedMailboxes` ever closed it: the sender's
  // task stayed pending forever.
  const hubLeave = startHub({ port: 19023, waitTimeoutMs: 2000, maxQueue: 10, historyLimit: 20, connectedWindowMs: 60_000, leaseTtlMs: 60_000 }, { info: () => {}, warn: () => {} })
  try {
    const leaveBase = 'http://127.0.0.1:19023/mcp'
    const userA = makeClient('leave-a', leaveBase)
    const userB = makeClient('leave-b', leaveBase)
    await Promise.all([userA.init(), userB.init()])
    await Promise.all([userA.register('leave-a'), userB.register('leave-b')])

    const leaveTask = await userA.call('bridge_task', { to: 'leave-b', prompt: 'leased when the peer is kicked' })
    const leaveLeased = await userB.call('bridge_wait', { timeoutMs: 2000, ack: 'manual' })
    check('(setup) the task is leased to the assignee', leaveLeased.message?.id === leaveTask.id, JSON.stringify(leaveLeased))
    hubLeave.hub.unregister('leave-b') // an explicit leave / manager kick, not the idle GC
    const revivedMail = await userB.call('bridge_poll')
    // "no message came back" is also true of a message that simply VANISHED, so
    // the check pairs it with the ledger verdict: the copy is gone because it was
    // deliberately closed, not lost (the assignee row is asserted below).
    const leaveStatus = await userA.call('bridge_task_status', { ref: leaveTask.id })
    check(
      'a kicked peer gets no lease back on its next take, and the task is settled rather than vanished',
      revivedMail.messages.length === 0 && leaveStatus.task?.status === 'failed',
      JSON.stringify({ messages: revivedMail.messages.map(m => m.content), status: leaveStatus.task?.status }),
    )
    const leaveMetrics = await userB.call('bridge_metrics')
    const leaveRow = leaveMetrics.peers?.find(row => row.peerId === 'leave-b')
    check(
      'the kick clears the lease and the dead letters, not just the queue',
      (leaveRow?.inFlight ?? 0) === 0 && (leaveRow?.deadLettered ?? 0) === 0,
      JSON.stringify(leaveRow),
    )
    // ... and the ledger is settled, because the copy of the task went with the
    // peer (the same terminal rule an unregister already applied to queued mail).
    check(
      'the task leased by the departed peer is closed, not left pending',
      leaveStatus.task?.status === 'failed' && leaveStatus.task?.assignees?.[0]?.status === 'failed',
      JSON.stringify({ status: leaveStatus.task?.status, assignees: leaveStatus.task?.assignees?.map(a => ({ peerId: a.peerId, status: a.status })) }),
    )
  } finally {
    hubLeave.close()
  }

  console.log('== a rename carries the leases and the dead letters with the mailbox (W10/F1) ==')
  // `bridge_wait { ack: 'manual' }` then `bridge_register { peerId }` is the flow
  // the skill recommends, and the rename used to move the queue but leave the
  // lease, the dead letters and the attempt counters on the old id: `commit`
  // answered `committed: 0`, the next reap requeued into a mailbox with neither a
  // registration nor a `parkedAt`, and the task the ledger had just re-keyed
  // could never leave `pending`.
  const hubRenLease = startHub({ port: 19029, waitTimeoutMs: 2000, maxQueue: 10, historyLimit: 20, connectedWindowMs: 60_000, leaseTtlMs: 60_000 }, { info: () => {}, warn: () => {} })
  try {
    const renBase = 'http://127.0.0.1:19029/mcp'
    const renA = makeClient('ren-a', renBase)
    const renB = makeClient('ren-b', renBase)
    await Promise.all([renA.init(), renB.init()])
    await Promise.all([renA.register('ren-a'), renB.register('ren-b')])
    const renTask = await renA.call('bridge_task', { to: 'ren-b', prompt: 'leased, then renamed' })
    const renLeased = await renB.call('bridge_wait', { timeoutMs: 2000, ack: 'manual' })
    check('(setup) the task is leased before the rename', renLeased.message?.id === renTask.id, JSON.stringify(renLeased))
    await renB.call('bridge_register', { peerId: 'ren-b2' }) // lossless self re-key
    const renMetrics = await renB.call('bridge_metrics')
    const renOldRow = renMetrics.peers?.find(row => row.peerId === 'ren-b')
    const renNewRow = renMetrics.peers?.find(row => row.peerId === 'ren-b2')
    check(
      'the in-flight lease moves to the new id on rename',
      (renNewRow?.inFlight ?? 0) === 1 && (renOldRow?.inFlight ?? 0) === 0,
      JSON.stringify({ old: renOldRow, new: renNewRow }),
    )
    const renPoll = await renB.call('bridge_poll')
    check(
      'a renamed peer is not handed the leased message again as queued mail',
      (renPoll.messages ?? []).length === 0,
      JSON.stringify((renPoll.messages ?? []).map(m => m.content)),
    )
    const renCommit = await renB.call('bridge_commit', { ids: [renTask.id] })
    check('a renamed peer can commit the lease it took under its old id', renCommit.committed === 1, JSON.stringify(renCommit))
    // The same has to hold for the other direction — giving a lease back — and it
    // is where the per-message attempt counter matters: it is keyed by the id.
    const renTask2 = await renA.call('bridge_task', { to: 'ren-b2', prompt: 'leased again, renamed again' })
    const renLeased2 = await renB.call('bridge_wait', { timeoutMs: 2000, ack: 'manual' })
    check('(setup) the second task is leased under the current id', renLeased2.message?.id === renTask2.id, JSON.stringify(renLeased2))
    await renB.call('bridge_register', { peerId: 'ren-b3' })
    const renNack = await renB.call('bridge_nack', { ids: [renTask2.id] })
    check('a renamed peer can nack the lease it took under its previous id', renNack.requeued === 1, JSON.stringify(renNack))
    const renBack = await renB.call('bridge_poll')
    check(
      'the requeued lease comes back to the new id, not to a mailbox nobody owns',
      (renBack.messages ?? []).some(m => m.id === renTask2.id),
      JSON.stringify((renBack.messages ?? []).map(m => m.content)),
    )
    const renStatus = await renA.call('bridge_task_status', { ref: renTask2.id })
    check(
      'the re-keyed task still names the live assignee, so it is not stuck pending on a ghost',
      renStatus.task?.assignees?.length === 1 && renStatus.task?.assignees?.[0]?.peerId === 'ren-b3',
      JSON.stringify(renStatus.task?.assignees?.map(a => ({ peerId: a.peerId, status: a.status }))),
    )
  } finally {
    hubRenLease.close()
  }

  console.log('== an expired task is dropped before delivery, counted, and left open (W3 expiry) ==')
  // The fourth drop path: `expiresAt` is a DELIVERY deadline, distinct from the
  // assignee's SLA. The recipient is registered but never takes, so the task sits
  // in the mailbox until its deadline passes. It must then be dropped (never
  // delivered), counted as `droppedExpired`, recorded as a `mailbox_dropped`
  // event naming the message, left NON-terminal (the sender is the only one who
  // can re-issue it) and the sender must be told.
  const hubExp = startHub({ port: 19030, waitTimeoutMs: 2000, maxQueue: 10, historyLimit: 20, connectedWindowMs: 60_000 }, { info: () => {}, warn: () => {} })
  try {
    const expBase = 'http://127.0.0.1:19030/mcp'
    const expA = makeClient('exp-a', expBase)
    const expB = makeClient('exp-b', expBase)
    await Promise.all([expA.init(), expB.init()])
    await Promise.all([expA.register('exp-a'), expB.register('exp-b')])
    const expTask = await expA.call('bridge_task', { to: 'exp-b', prompt: 'stale instruction', expiresAt: Date.now() + 150 })
    await new Promise(r => setTimeout(r, 400)) // deadline 150ms → past due while queued
    const expPoll = await expB.call('bridge_poll')
    const expMessages = expPoll.messages ?? []
    check(
      'a task past its expiresAt is never delivered',
      !expMessages.some(m => m.id === expTask.id),
      JSON.stringify(expMessages.map(m => ({ id: m.id, content: m.content }))),
    )
    check(
      'the recipient is told its queued message expired',
      expMessages.some(m => m.from === 'hub' && m.kind === 'notice' && /expired before delivery/.test(String(m.content?.message ?? ''))),
      JSON.stringify(expMessages.map(m => ({ from: m.from, kind: m.kind, content: m.content }))),
    )
    const expEvents = await expB.call('bridge_events')
    const expDrop = expEvents.events?.find(e => e.kind === 'mailbox_dropped' && e.detail?.reason === 'expired' && e.detail?.messageId === expTask.id)
    check(
      'the expiry is recorded as mailbox_dropped { reason: expired, messageId }',
      expDrop !== undefined && expDrop.peer === 'exp-b',
      JSON.stringify(expEvents.events?.filter(e => e.kind === 'mailbox_dropped')),
    )
    const expMetrics = await expB.call('bridge_metrics')
    const expRow = expMetrics.peers?.find(row => row.peerId === 'exp-b')
    check('the expiry is counted as droppedExpired', (expRow?.droppedExpired ?? 0) === 1, JSON.stringify(expRow))
    const expStatus = await expA.call('bridge_task_status', { ref: expTask.id })
    check(
      'an expired delivery leaves the task open, not terminal',
      expStatus.task?.status === 'pending',
      JSON.stringify({ status: expStatus.task?.status, assignees: expStatus.task?.assignees?.map(a => ({ peerId: a.peerId, status: a.status })) }),
    )
    const expSenderMail = await expA.call('bridge_poll')
    const expNotice = (expSenderMail.messages ?? []).find(m => m.from === 'hub' && m.kind === 'notice' && String(m.content?.message ?? '').includes(expTask.id))
    check(
      'the sender gets one hub notice naming the task whose delivery expired',
      expNotice !== undefined,
      JSON.stringify((expSenderMail.messages ?? []).map(m => ({ from: m.from, kind: m.kind, content: m.content }))),
    )
  } finally {
    hubExp.close()
  }

  console.log('== reserved ids and identity isolation (W6) ==')
  const hubIds = startHub({ port: 19015, waitTimeoutMs: 2000, maxQueue: 10, historyLimit: 20, connectedWindowMs: 60_000 }, { info: () => {}, warn: () => {} })
  try {
    const idsBase = 'http://127.0.0.1:19015/mcp'
    const alice = makeClient('alice', idsBase)
    const bob = makeClient('bob', idsBase)
    const probe = makeClient('probe', idsBase)
    await Promise.all([alice.init(), bob.init(), probe.init()])
    await Promise.all([alice.register('alice'), bob.register('bob'), probe.register('probe')])

    const claimAll = await probe.callRaw('bridge_register', { peerId: 'all' })
    check('registering the broadcast address rejected', claimAll.error !== undefined && /reserved/.test(claimAll.error), JSON.stringify(claimAll))
    const claimHub = await probe.callRaw('bridge_register', { peerId: 'hub' })
    check('registering the hub peer id rejected', claimHub.error !== undefined && /reserved/.test(claimHub.error), JSON.stringify(claimHub))

    // What those reserved ids protect, seen through the tool layer: a peer's own
    // history tail never contains a conversation it took no part in.
    const marker = `w6-isolation-${Date.now()}`
    await alice.call('bridge_chat', { to: 'bob', message: marker })
    const probeHistory = await probe.call('bridge_history', { limit: 50 })
    check(
      'own history excludes other peers conversations',
      !probeHistory.messages.some(m => m.content === marker),
      JSON.stringify(probeHistory.messages.map(m => m.content).slice(0, 5)),
    )

    // The tool layer's reserved check is not the invariant — the hub API is.
    // There is no session-based way to build this case (bridge_register already
    // rejects `all`, which is why a peer id of `all` is unreachable from the
    // MCP side), so the assertion goes through the hub instance directly. A peer
    // named `all` would read every conversation as if it were the broadcast
    // address.
    let hubRefusedAll = false
    try { hubIds.hub.register('all') } catch { hubRefusedAll = true }
    check('hub.register refuses the broadcast address', hubRefusedAll)
  } finally {
    hubIds.close()
  }

  console.log('== manager gate on the unfiltered views (W6) ==')
  const hubGate = startHub({ port: 19016, waitTimeoutMs: 2000, maxQueue: 10, historyLimit: 20, connectedWindowMs: 60_000, managerPeers: ['mavis'] }, { info: () => {}, warn: () => {} })
  try {
    const gateBase = 'http://127.0.0.1:19016/mcp'
    const mgr = makeClient('mavis', gateBase)
    const plain = makeClient('plain', gateBase)
    await Promise.all([mgr.init(), plain.init()])
    await Promise.all([mgr.register('mavis'), plain.register('plain')])

    const gateHistory = await plain.callRaw('bridge_history', { peer: 'all', limit: 20 })
    check("bridge_history peer='all' needs manager rights", gateHistory.error !== undefined && /manager/.test(gateHistory.error), JSON.stringify(gateHistory))
    const gateTasks = await plain.callRaw('bridge_tasks', { peer: 'all' })
    check("bridge_tasks peer='all' needs manager rights", gateTasks.error !== undefined && /manager/.test(gateTasks.error), JSON.stringify(gateTasks))
  } finally {
    hubGate.close()
  }

  console.log('== persistence (sqlite db) ==')
  const dbFile = `${tmpdir()}/hub-state-test-${Date.now()}.db`
  // Last message of the reply chain built before the restart — after the
  // restart its id is used to try (and fail) to extend the chain past MAX_HOP.
  let chainMsg
  const hubDbA = startHub({ port: 19008, waitTimeoutMs: 2000, maxQueue: 10, historyLimit: 20, connectedWindowMs: 60_000, db: dbFile }, { info: () => {}, warn: () => {} })
  try {
    const base = 'http://127.0.0.1:19008/mcp'
    const alice = makeClient('alice', base)
    const bob = makeClient('bob', base)
    await Promise.all([alice.init(), bob.init()])
    await alice.call('bridge_register', { peerId: 'alice', alias: '持久化·爱丽丝' })
    await alice.call('bridge_chat', { to: 'bob', message: '重启前的话' })
    await alice.call('bridge_group_create', { group: 'ops', members: ['bob'] })
    const carol = makeClient('carol', base)
    await carol.init()
    await alice.call('bridge_group_add_member', { group: 'ops', member: 'carol' })
    await alice.call('bridge_task', { to: 'bob', prompt: '重启后还在', threadId: 'db-thread' })
    // A reply chain that straddles the restart: without a persisted `hop` the
    // depth resets to 0 and MAX_HOP is bypassed by restarting the hub.
    chainMsg = await alice.call('bridge_chat', { to: 'bob', message: 'chain-0' })
    for (let i = 1; i <= 5; i++) {
      chainMsg = await (i % 2 === 1 ? bob : alice).call('bridge_chat', {
        to: i % 2 === 1 ? 'alice' : 'bob',
        message: `chain-${i}`,
        ref: chainMsg.id,
      })
    }
    check('hop chain of 5 is built before the restart', chainMsg.hop === 5, JSON.stringify(chainMsg))
    // bob never polls → the message stays queued; close flushes everything.
  } finally {
    hubDbA.close()
  }
  check('sqlite state file exists after close', existsSync(dbFile), dbFile)

  const hubDbB = startHub({ port: 19009, waitTimeoutMs: 2000, maxQueue: 10, historyLimit: 20, connectedWindowMs: 60_000, db: dbFile }, { info: () => {}, warn: () => {} })
  try {
    const base = 'http://127.0.0.1:19009/mcp'
    const adminRoute = await fetch('http://127.0.0.1:19009/admin')
    const adminHtml = await adminRoute.text()
    check('built-in admin page served at /admin', adminRoute.status === 200 && adminRoute.headers.get('content-type')?.includes('text/html') && adminHtml.includes('管理台'), String(adminRoute.status))
    const alice = makeClient('alice', base)
    const bob = makeClient('bob', base)
    await Promise.all([alice.init(), bob.init()])
    await alice.call('bridge_register', { peerId: 'alice' })
    const roster = await alice.call('bridge_peers')
    check('alias restored from sqlite across restart', roster.peers.find(p => p.id === 'alice')?.alias === '持久化·爱丽丝', JSON.stringify(roster))
    const history = await alice.call('bridge_history', { limit: 10 })
    check('history restored from sqlite', history.messages.some(m => m.content === '重启前的话'), JSON.stringify(history.messages.map(m => m.content)))
    const bobMail = await bob.call('bridge_poll')
    check('offline mailbox restored from sqlite', bobMail.messages.some(m => m.content === '重启前的话') && bobMail.messages.every(m => m.from === 'alice'), JSON.stringify(bobMail))
    const groups = await alice.call('bridge_group_list')
    check('groups restored from sqlite', groups.groups.some(g => g.id === 'ops' && g.members.includes('bob')), JSON.stringify(groups))
    check('group membership edit restored from sqlite', groups.groups.some(g => g.id === 'ops' && g.members.includes('carol')), JSON.stringify(groups))
    const tasks = await alice.call('bridge_tasks', { role: 'sent' })
    check('task ledger restored from sqlite', tasks.tasks.some(t => t.prompt === '重启后还在' && t.status === 'pending' && t.threadId === 'db-thread'), JSON.stringify(tasks.tasks.map(t => ({ p: t.prompt, s: t.status }))))
    const chain6 = await alice.call('bridge_chat', { to: 'bob', message: 'chain-6', ref: chainMsg.id })
    check('hop depth survives a sqlite restart (continues at 6, not reset to 1)', chain6.hop === 6, JSON.stringify(chain6))
  } finally {
    hubDbB.close()
    rmSync(dbFile, { force: true })
  }

  console.log('== auth token management (cli roundtrip) ==')
  {
    const { generateToken, addToken, removeToken, readTokens } = await import('./entry.mjs')
    const tokenFile = `${tmpdir()}/hub-auth-mgmt-${Date.now()}.json`
    try {
      const row = addToken(tokenFile, { peer: 'zhangsan', role: 'agent', owner: '张三' })
      check('add generates a random token matching the hub pattern', /^[A-Za-z0-9._:-]{16,128}$/.test(row.token) && row.peer === 'zhangsan' && row.owner === '张三', JSON.stringify(row))
      addToken(tokenFile, { peer: 'lisi', role: 'manager' })
      let dupThrew = false
      try { addToken(tokenFile, { peer: 'lisi', role: 'agent' }) } catch { dupThrew = true }
      check('duplicate peer rejected (rotate via remove first)', dupThrew)
      const rows = readTokens(tokenFile)
      check('readTokens returns both identities', rows.length === 2 && rows.some(r => r.role === 'manager'), JSON.stringify(rows.map(r => r.peer)))
      check('remove drops the peer and persists', removeToken(tokenFile, 'lisi') === true && readTokens(tokenFile).length === 1)
      check('remove of unknown peer is a no-op false', removeToken(tokenFile, 'ghost') === false)
    } finally {
      rmSync(tokenFile, { force: true })
    }
  }

  console.log('== allow-join (anonymous walk-ins) ==')
  {
    const tokenFile = `${tmpdir()}/hub-join-${Date.now()}.json`
    writeFileSync(tokenFile, JSON.stringify({ tokens: [
      { token: 'mgr-join-token-0123456789ab', peer: 'ops', role: 'manager', owner: '管理台' },
    ] }), 'utf8')
    const hubJoin = startHub({ port: 19010, waitTimeoutMs: 2000, maxQueue: 10, historyLimit: 20, connectedWindowMs: 60_000, authTokens: tokenFile, allowJoin: true }, { info: () => {}, warn: () => {} })
    try {
      const base = 'http://127.0.0.1:19010/mcp'
      const anonZs = makeClient('kimi-code', base) // NO token → walk-in
      const anonLs = makeClient('kimi-code', base)
      await Promise.all([anonZs.init(), anonLs.init()])
      const anonRoster = await anonZs.call('bridge_peers')
      const anonPeers = anonRoster.peers.filter(p => p.anonymous === true)
      check('anonymous walk-ins land on distinct join peers', anonPeers.length === 2 && anonPeers.every(p => /^join-/.test(p.id)) && anonPeers[0].id !== anonPeers[1].id, JSON.stringify(anonPeers.map(p => p.id)))
      check('anonymous peers carry source ip in roster', anonPeers.every(p => Array.isArray(p.clientIps) && p.clientIps.includes('127.0.0.1')), JSON.stringify(anonPeers[0]?.clientIps))

      const mgr = makeClient('ops', base, 'mgr-join-token-0123456789ab')
      await mgr.init()
      const mixed = await mgr.call('bridge_peers')
      check('token peer and walk-in coexist', mixed.peers.some(p => p.id === 'ops') && mixed.peers.some(p => p.anonymous === true), JSON.stringify(mixed.peers.map(p => p.id)))

      const api = 'http://127.0.0.1:19010/admin/api'
      const noTok = await fetch(api + '/tokens')
      // Allow-join walk-in without a token is an anonymous agent → 403; with allow-join off it is 401.
      check('token API without token rejected', noTok.status === 401 || noTok.status === 403, String(noTok.status))
      const badTok = await fetch(api + '/tokens', { headers: { Authorization: 'Bearer nope-0123456789abcdef' } })
      check('token API with unknown token rejected 401', badTok.status === 401, String(badTok.status))
      const mgrList = await fetch(api + '/tokens?reveal=0', { headers: { Authorization: 'Bearer mgr-join-token-0123456789ab' } })
      const mgrListJson = await mgrList.json()
      check('manager lists tokens masked', mgrList.status === 200 && mgrListJson.tokens[0].token.includes('…'), JSON.stringify(mgrListJson.tokens?.[0]))

      const createdRes = await fetch(api + '/tokens/add', {
        method: 'POST',
        headers: { Authorization: 'Bearer mgr-join-token-0123456789ab', 'Content-Type': 'application/json' },
        body: JSON.stringify({ peer: 'newnan', role: 'agent', owner: '新成员' }),
      })
      const created = await createdRes.json()
      check('manager issues a new token via api', createdRes.status === 200 && created.created?.peer === 'newnan' && /^[A-Za-z0-9._:-]{16,128}$/.test(created.created?.token ?? ''), JSON.stringify(created))
      const newbie = makeClient('kimi-code', base, created.created.token)
      let newbieOk = true
      try { await newbie.init() } catch { newbieOk = false }
      check('freshly issued token authenticates immediately (reloadAuth)', newbieOk)
      const dupRes = await fetch(api + '/tokens/add', {
        method: 'POST',
        headers: { Authorization: 'Bearer mgr-join-token-0123456789ab', 'Content-Type': 'application/json' },
        body: JSON.stringify({ peer: 'newnan', role: 'agent' }),
      })
      check('duplicate peer via api rejected', dupRes.status === 400, String(dupRes.status))
      const delRes = await fetch(api + '/tokens/remove/newnan', { method: 'DELETE', headers: { Authorization: 'Bearer mgr-join-token-0123456789ab' } })
      const delJson = await delRes.json()
      check('manager revokes a token via api', delRes.status === 200 && delJson.removed === true, JSON.stringify(delJson))
    } finally {
      hubJoin.close()
      rmSync(tokenFile, { force: true })
    }
  }

  console.log('== id namespace: group names and parked mailboxes are not claimable ==')
  const hubNs = startHub({ port: 19020, waitTimeoutMs: 2000, maxQueue: 10, historyLimit: 30, connectedWindowMs: 60_000 }, { info: () => {}, warn: () => {} })
  try {
    const nsBase = 'http://127.0.0.1:19020/mcp'
    const nsZ = makeClient('zhangsan', nsBase)
    const nsL = makeClient('lisi', nsBase)
    const nsW = makeClient('wangwu', nsBase)
    await Promise.all([nsZ.init(), nsL.init(), nsW.init()])
    await Promise.all([nsZ.register('zhangsan'), nsL.register('lisi'), nsW.register('wangwu')])
    await nsZ.call('bridge_group_create', { group: 'eng', members: ['lisi'] })

    // A peer re-keyed onto a group's id would read that group's whole traffic
    // without a manager grant: bridge_history {} compares the RAW `to` against
    // the caller's own id, and `target === peer` skips the gate. This is the
    // exploit path itself — bridge_register re-keys through renamePeer when the
    // session is the sole attachment.
    const ontoGroup = await nsZ.callRaw('bridge_register', { peerId: 'eng' })
    check(
      'renaming onto a group id rejected (shared to-namespace)',
      ontoGroup.error !== undefined && /collides with a group/.test(ontoGroup.error),
      JSON.stringify(ontoGroup),
    )
    // The state "a peer whose own id is a group name" is unreachable from the MCP
    // side once renamePeer refuses it — and that is the point, so the invariant is
    // asserted where it lives, on the hub. (Same shape as the `hub.register('all')`
    // assertion above: the tool layer is not the boundary, the hub API is.)
    let hubRefusedGroup = ''
    try { hubNs.hub.renamePeer('zhangsan', 'eng') } catch (err) { hubRefusedGroup = String(err?.message ?? err) }
    check('hub.renamePeer refuses a group id', /collides with a group/.test(hubRefusedGroup), hubRefusedGroup)

    // A parked peer is out of the registry but still owns its mailbox; that is
    // the state the idle GC leaves behind (`keepMailbox` is exactly what it
    // passes), so its id is taken even though has() says otherwise.
    await nsL.call('bridge_chat', { to: 'wangwu', message: '停泊期间的消息' })
    hubNs.hub.unregister('wangwu', { keepMailbox: true })
    check(
      'parked peer keeps its queued mail (precondition)',
      hubNs.hub.isParked('wangwu') && hubNs.hub.exportMailboxes().wangwu?.length === 1,
      JSON.stringify(hubNs.hub.exportMailboxes().wangwu),
    )
    const mallory = makeClient('mallory', nsBase)
    await mallory.init()
    const stealParked = await mallory.callRaw('bridge_register', { peerId: 'wangwu' })
    check(
      'a parked id cannot be claimed by another connection',
      stealParked.error !== undefined && /parked/.test(stealParked.error),
      JSON.stringify(stealParked),
    )
    const malloryMail = await mallory.call('bridge_poll') // auto-registers mallory itself
    check("the claimant cannot read the parked peer's mail", malloryMail.messages.length === 0, JSON.stringify(malloryMail))
    check(
      'the parked mailbox is intact after the refused claim',
      hubNs.hub.exportMailboxes().wangwu?.length === 1,
      JSON.stringify(hubNs.hub.exportMailboxes()),
    )
    // The guard must not lock the owner out: its own session reclaims the id and
    // drains what arrived while it was away.
    const ownBack = await nsW.call('bridge_register', { peerId: 'wangwu' })
    const ownMail = await nsW.call('bridge_poll')
    check(
      'the parked peer reclaims its own id and mail',
      ownBack.ok === true && ownMail.messages.some(m => m.content === '停泊期间的消息'),
      JSON.stringify(ownMail),
    )

    // Re-keying onto a parked id: same rule, the other write point.
    await nsL.call('bridge_chat', { to: 'wangwu', message: '第二次停泊' })
    hubNs.hub.unregister('wangwu', { keepMailbox: true })
    // register() is the symmetric half: a plain (non-reclaiming) registration of
    // a parked id is the takeover in its simplest form.
    let hubRefusedParkedRegister = ''
    try { hubNs.hub.register('wangwu') } catch (err) { hubRefusedParkedRegister = String(err?.message ?? err) }
    check('hub.register refuses a parked id unless the caller reclaims it', /parked/.test(hubRefusedParkedRegister), hubRefusedParkedRegister)
    let hubRefusedParked = ''
    try { hubNs.hub.renamePeer('lisi', 'wangwu') } catch (err) { hubRefusedParked = String(err?.message ?? err) }
    check('hub.renamePeer refuses a parked id', /parked/.test(hubRefusedParked), hubRefusedParked)
    const mcpOntoParked = await nsL.callRaw('bridge_register', { peerId: 'wangwu' })
    check(
      'renaming onto a parked id rejected through the tool layer too',
      mcpOntoParked.error !== undefined && /parked/.test(mcpOntoParked.error),
      JSON.stringify(mcpOntoParked),
    )

    // A clientInfo name that matches a group must not brick the agent: an agent
    // called `claude-code` would otherwise fail every tool call as long as a
    // group of that name exists. The connect path falls back to a generated id.
    const namedEng = makeClient('eng', nsBase)
    let namedEngConnected = true
    try { await namedEng.init() } catch { namedEngConnected = false }
    let fallbackChat
    try {
      fallbackChat = await namedEng.call('bridge_chat', { to: 'zhangsan', message: '群名与客户端同名也能用' })
    } catch (err) {
      fallbackChat = { error: String(err?.message ?? err) }
    }
    check(
      'a clientInfo name colliding with a group falls back to a generated peer id',
      namedEngConnected && fallbackChat.ok === true && /^agent-[a-z0-9]{4}$/.test(fallbackChat.from),
      JSON.stringify(fallbackChat),
    )
    const fallbackHeard = await nsZ.call('bridge_wait', { timeoutMs: 2000, from: fallbackChat.from ?? 'nobody' })
    check(
      'the fallback peer routes normally',
      fallbackHeard.type === 'message' && fallbackHeard.message.content === '群名与客户端同名也能用',
      JSON.stringify(fallbackHeard),
    )

    // The restore path is external input (a tampered or stale state file): it
    // obeys the same namespace rules as a live registration.
    const forged = (id, to) => [{ id, from: 'zhangsan', to, kind: 'chat', content: 'forged', ts: Date.now() }]
    const imported = hubNs.hub.importMailboxes({
      hub: forged('forged-hub', 'hub'),
      all: forged('forged-all', 'all'),
      eng: forged('forged-eng', 'eng'),
      'bad id!': forged('forged-bad', 'bad id!'),
      'restored-ok': forged('restored-ok-1', 'restored-ok'),
    })
    check(
      'importMailboxes refuses reserved / group / malformed ids',
      imported === 1 && hubNs.hub.isParked('restored-ok') && !hubNs.hub.isParked('hub') && !hubNs.hub.isParked('all') && !hubNs.hub.isParked('eng'),
      JSON.stringify(hubNs.hub.exportMailboxes()),
    )
    // ... and the same namespace rule at the OTHER write point. `restored-ok` is a
    // mailbox and nothing else: not live, and no profile (a restore does not write
    // one). The old lastSeen/profiles pair let a group take exactly this id, so
    // every message addressed to that peer — the one waiting in the mailbox —
    // fanned out to the group instead, and the owner could never register its own
    // name again. The predicate now matches the one `renamePeer` uses.
    let groupTookMailboxId = ''
    try { hubNs.hub.createGroup('restored-ok', ['zhangsan'], 'zhangsan') } catch (err) { groupTookMailboxId = String(err?.message ?? err) }
    check(
      'a group cannot take an id that only still owns a restored mailbox',
      /collides with a peer/.test(groupTookMailboxId) && hubNs.hub.groupOf('restored-ok') === undefined,
      groupTookMailboxId,
    )
    // The task ledger is an authorization source too (bridge_task_status /
    // bridge_task_input compare `from` against the caller), so a restored task
    // whose SENDER is a reserved address or a group id is refused as well.
    const forgedTask = (id, from) => ({
      id, from, to: 'zhangsan', prompt: 'forged', status: 'pending', acks: [], assignees: [{ peerId: 'zhangsan', status: 'pending', acks: [] }],
    })
    const importedTasks = hubNs.hub.importTasks([
      forgedTask('forged-from-hub', 'hub'),
      forgedTask('forged-from-all', 'all'),
      forgedTask('forged-from-group', 'eng'),
      forgedTask('forged-from-bad', 'bad id!'),
      forgedTask('forged-from-ok', 'zhangsan'),
    ])
    check(
      'importTasks refuses a task whose sender is reserved, a group id or malformed',
      importedTasks === 1 && hubNs.hub.taskOf('forged-from-ok') !== undefined && hubNs.hub.taskOf('forged-from-hub') === undefined && hubNs.hub.taskOf('forged-from-all') === undefined && hubNs.hub.taskOf('forged-from-group') === undefined,
      `imported=${importedTasks}`,
    )
    // The rest of the stored timeline is external input as well, so an ack row
    // and an assignee row are validated too — and a bad row drops THAT ROW, not
    // the record (a whole timeline must not disappear because one beat is
    // garbage). The two hub-authored system markers stay: the terminal markers a
    // fan-out timeout writes are authored under the task's recipient address
    // (`eng` here, `all` for a broadcast), so refusing those ids would delete the
    // evidence that the task ever ended.
    const timelineTask = {
      id: 'forged-timeline', from: 'zhangsan', to: 'zhangsan', prompt: 'forged', status: 'pending',
      acks: [
        { from: 'zhangsan', status: 'working', ts: Date.now(), messageId: 'a1' },
        { from: 'bad id!', status: 'done', ts: Date.now(), messageId: 'a2' },
        { from: 'zhangsan', status: 'finished', ts: Date.now(), messageId: 'a3' },
        { from: 'eng', status: 'failed', ts: Date.now(), messageId: 'timeout-forged-timeline', system: true },
      ],
      assignees: [
        { peerId: 'bad id!', status: 'pending', acks: [] },
        { peerId: 'zhangsan', status: 'pending', acks: [
          { from: 'zhangsan', status: 'nope', ts: Date.now(), messageId: 'a4' },
          { from: 'zhangsan', status: 'done', ts: Date.now(), messageId: 'a5' },
        ] },
      ],
    }
    const importedTimeline = hubNs.hub.importTasks([timelineTask])
    const timeline = hubNs.hub.taskOf('forged-timeline')
    const ackIds = (timeline?.acks ?? []).map(e => e.messageId)
    const assigneeIds = (timeline?.assignees ?? []).map(a => a.peerId)
    const nestedAckIds = (timeline?.assignees?.[0]?.acks ?? []).map(e => e.messageId)
    check(
      'importTasks drops only the unusable ack/assignee rows and keeps the rest of the timeline',
      importedTimeline === 1
        && ackIds.join(',') === 'a1,timeout-forged-timeline'
        && assigneeIds.join(',') === 'zhangsan'
        && nestedAckIds.join(',') === 'a5',
      JSON.stringify({ imported: importedTimeline, ackIds, assigneeIds, nestedAckIds }),
    )
  } finally {
    hubNs.close()
  }

  console.log(`\n${checks - failures}/${checks} checks passed`)
  if (failures > 0) process.exitCode = 1
} finally {
  hub.close()
}
