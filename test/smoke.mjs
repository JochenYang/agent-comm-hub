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

  console.log('== broadcast ==')
  await opencode.call('bridge_chat', { to: 'all', message: 'attention everyone' })
  const mavisBroadcast = await mavis.call('bridge_wait', { timeoutMs: 3000 })
  const claudeBroadcast = await claude.call('bridge_wait', { timeoutMs: 3000 })
  check('broadcast reaches mavis', mavisBroadcast.type === 'message' && mavisBroadcast.message.to === 'all' && mavisBroadcast.message.content === 'attention everyone', JSON.stringify(mavisBroadcast))
  check('broadcast reaches claude', claudeBroadcast.type === 'message' && claudeBroadcast.message.to === 'all' && claudeBroadcast.message.content === 'attention everyone', JSON.stringify(claudeBroadcast))
  const opencodeSelf = await opencode.call('bridge_poll')
  check('broadcast does not echo to sender', opencodeSelf.messages.length === 0, JSON.stringify(opencodeSelf))

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
    check('idle peer evicted by GC', !after.peers.some(p => p.id === 'gcpear'), JSON.stringify(after))
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
    check('peer evicted after SSE closes', !afterClose.peers.some(p => p.id === 'livegc'), JSON.stringify(afterClose))
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

    const rekey = await mgr.call('bridge_rename', { peer: 'ren', peerId: 'ren2' })
    check('manager re-keys a peer', rekey.ok === true && rekey.peerId === 'ren2' && rekey.previousId === 'ren', JSON.stringify(rekey))
    const roster = await peer.call('bridge_peers')
    check('roster shows only the new id', roster.peers.some(p => p.id === 'ren2') && !roster.peers.some(p => p.id === 'ren'), JSON.stringify(roster))
    check('alias follows the re-key', rekey.alias === 'Ren Prime' || roster.peers.find(p => p.id === 'ren2')?.alias === 'Ren Prime', JSON.stringify(roster))

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

    const renamed = await boss.call('bridge_rename', { peer: 'zhangsan', alias: '张三（kimi）' })
    check('manager-role token renames another peer', renamed.ok === true && renamed.alias === '张三（kimi）', JSON.stringify(renamed))
    const denied = await ls.callRaw('bridge_rename', { peer: 'zhangsan', alias: 'nope' })
    check('agent-role token rename of another peer denied', denied.error !== undefined && /manager/.test(denied.error), JSON.stringify(denied))

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
    const deniedDelete = await stranger.callRaw('bridge_group_delete', { group: 'eng' })
    check('non-creator non-manager cannot delete a group', deniedDelete.error !== undefined && /manager/.test(deniedDelete.error), JSON.stringify(deniedDelete))

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

  console.log('== persistence (sqlite db) ==')
  const dbFile = `${tmpdir()}/hub-state-test-${Date.now()}.db`
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
    check('offline mailbox restored from sqlite', bobMail.messages.length === 1 && bobMail.messages[0].content === '重启前的话', JSON.stringify(bobMail))
    const groups = await alice.call('bridge_group_list')
    check('groups restored from sqlite', groups.groups.some(g => g.id === 'ops' && g.members.includes('bob')), JSON.stringify(groups))
    check('group membership edit restored from sqlite', groups.groups.some(g => g.id === 'ops' && g.members.includes('carol')), JSON.stringify(groups))
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

  console.log(`\n${checks - failures}/${checks} checks passed`)
  if (failures > 0) process.exitCode = 1
} finally {
  hub.close()
}
