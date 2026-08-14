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

/** One simulated agent: an MCP session with rpc helpers and a result parser. */
function makeClient(name, base = BASE) {
  const headers = {}
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

const hub = startHub({ port: PORT, waitTimeoutMs: 3000, maxQueue: 20, historyLimit: 50 }, { info: () => {}, warn: () => {} })

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

  console.log('== task + ack routing ==')
  await claude.call('bridge_task', { to: 'mavis', prompt: 'review the hub protocol', deliverable: 'short summary' })
  const task = await mavis.call('bridge_wait', { timeoutMs: 3000 })
  check('mavis receives task', task.type === 'message' && task.message.kind === 'task' && task.message.content.prompt === 'review the hub protocol' && task.message.content.deliverable === 'short summary', JSON.stringify(task))
  await mavis.call('bridge_ack', { ref: task.message.id, status: 'accepted', note: 'on it' })
  const ack = await claude.call('bridge_wait', { timeoutMs: 3000 })
  check('ack routed back to original sender', ack.type === 'message' && ack.message.kind === 'ack' && ack.message.to === 'claude' && ack.message.ref === task.message.id && ack.message.content.status === 'accepted', JSON.stringify(ack))

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

  console.log(`\n${checks - failures}/${checks} checks passed`)
  if (failures > 0) process.exitCode = 1
} finally {
  hub.close()
}
