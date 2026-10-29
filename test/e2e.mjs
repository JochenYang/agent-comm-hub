/**
 * End-to-end test against the REAL built CLI (lib/cli.js) spawned as a
 * subprocess — the smoke suite drives startHub() in-process; this suite
 * proves the shipping artifact works end to end:
 *
 *   spawn → /healthz → MCP sessions → SSE push TIMELINESS (the message
 *   reaches passive listeners before any poll) → heartbeat → task/ack →
 *   broadcast → groups → SQLite persistence across a real process restart →
 *   open manual leases / input-required tasks / priority order across a real
 *   process restart → remote-auth mode (token identity, 401s, healthz stays
 *   open).
 *
 * Run after `pnpm run build`:
 *   node test/e2e.mjs
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(ROOT, 'lib', 'cli.js')

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

/** Spawn the real CLI as a subprocess and wait for /healthz to answer. */
async function startHubProc(port, extraArgs = []) {
  const child = spawn(process.execPath, [CLI, '--host', '127.0.0.1', '--port', String(port), '--state-file', 'off', ...extraArgs], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', d => { stderr += d })
  const deadline = Date.now() + 15_000
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`)
      if (res.ok) return { child, stderr: () => stderr }
    } catch { /* not up yet */ }
    if (Date.now() > deadline) {
      child.kill()
      throw new Error(`hub on :${port} did not become healthy in 15s; stderr: ${stderr.slice(-500)}`)
    }
    await new Promise(r => setTimeout(r, 100))
  }
}

function stopProc(child) {
  child.kill() // hard stop is fine: persistence is asserted over the debounced flush, not the shutdown hook
}

/** One simulated agent over real HTTP (same shape as the smoke suite's client). */
function makeClient(name, base, token) {
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
    async call(tool, args) {
      const r = await this.rpc('tools/call', { name: tool, arguments: args ?? {} })
      const text = r.json?.result?.content?.[0]?.text
      const parsed = JSON.parse(text ?? '{}')
      if (r.json?.result?.isError) throw new Error(`${this.name} ${tool}: ${text}`)
      return parsed
    },
  }
}

/** Open an SSE stream for a client; returns { waitFor(substr, ms), cancel }. */
async function openSse(client, base, token) {
  const headers = { Accept: 'text/event-stream', 'Mcp-Session-Id': client.sessionId(), ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }) }
  const res = await fetch(base, { headers })
  if (!res.ok) throw new Error(`SSE open failed: ${res.status}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let closed = false
  void (async () => {
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
      }
    } catch {
      // Hub process killed mid-stream (the restart test does exactly this) —
      // the stream is simply over; do not let an unhandled rejection crash the suite.
    }
    closed = true
  })()
  return {
    isClosed: () => closed,
    async waitFor(substr, ms = 3000) {
      const deadline = Date.now() + ms
      while (!buffer.includes(substr)) {
        if (Date.now() > deadline) return false
        await new Promise(r => setTimeout(r, 25))
      }
      return true
    },
    buffer: () => buffer,
    async cancel() { try { await reader.cancel() } catch { /* stream already dead (hub killed) */ } },
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'ach-e2e-'))

try {
  // ================= Scenario A: local hub, real process =================
  console.log('== E2E A: local hub (real CLI subprocess) ==')
  const dbFile = join(tmp, 'state.db')
  const PORT_A = 19021
  const BASE_A = `http://127.0.0.1:${PORT_A}/mcp`
  let hubA = await startHubProc(PORT_A, ['--db', dbFile, '--heartbeat-ms', '100'])
  try {
    const hz = await fetch(`http://127.0.0.1:${PORT_A}/healthz`)
    const hzJson = await hz.json()
    check('healthz answers on the real process', hz.status === 200 && hzJson.ok === true)

    const gui = makeClient('agent-hub-cli', BASE_A) // default manager
    const alice = makeClient('alice', BASE_A)
    const bob = makeClient('bob', BASE_A)
    await Promise.all([gui.init(), alice.init(), bob.init()])
    check('three peers registered over real MCP sessions', (await gui.call('bridge_peers')).peers.length === 3)

    const guiSse = await openSse(gui, BASE_A)
    const bobSse = await openSse(bob, BASE_A)

    // --- Timeliness: push at SEND time, before any poll/wait by the recipient ---
    await alice.call('bridge_chat', { to: 'bob', message: 'e2e hello' })
    const guiSaw = await guiSse.waitFor('e2e hello', 2000)
    check('manager SSE receives the message as it is sent (relay push, no poll)', guiSaw, guiSse.buffer().slice(-300))
    const bobSaw = await bobSse.waitFor('e2e hello', 2000)
    check('recipient SSE receives the queued-mail push (no waiter, no poll)', bobSaw, bobSse.buffer().slice(-300))

    // The push is a hint, not a consumption: the mailbox still holds the message.
    const bobPoll = await bob.call('bridge_poll')
    check('bridge_poll still delivers after the SSE hint (push is not consume)', bobPoll.messages?.some(m => m.content === 'e2e hello'), JSON.stringify(bobPoll).slice(0, 200))

    // --- Heartbeat on the real process (100ms cadence via --heartbeat-ms) ---
    check('SSE heartbeat frames arrive on the real process', await guiSse.waitFor('"event":"heartbeat"', 3000), guiSse.buffer().slice(-200))

    // --- task → ack round trip through real long-polls ---
    const task = await alice.call('bridge_task', { to: 'bob', prompt: 'do the e2e thing' })
    const bobWait = await bob.call('bridge_wait', { timeoutMs: 3000, from: 'alice' })
    check('task reaches a filtered waiter', bobWait.type === 'message' && bobWait.message?.kind === 'task', JSON.stringify(bobWait).slice(0, 200))
    await bob.call('bridge_ack', { ref: task.id, status: 'done', note: 'e2e done' })
    const aliceWait = await alice.call('bridge_wait', { timeoutMs: 3000, from: 'bob' })
    check('ack routes back to the original sender', aliceWait.type === 'message' && aliceWait.message?.kind === 'ack' && aliceWait.message?.ref === task.id, JSON.stringify(aliceWait).slice(0, 200))

    // --- broadcast: no echo to the sender, everyone else via SSE/poll ---
    await bob.call('bridge_chat', { to: 'all', message: 'e2e broadcast' })
    check('broadcast reaches the manager SSE', await guiSse.waitFor('e2e broadcast', 2000))
    const alicePoll = await alice.call('bridge_poll')
    check('broadcast reaches other peers (no echo to sender)', alicePoll.messages?.some(m => m.content === 'e2e broadcast'), JSON.stringify(alicePoll).slice(0, 200))

    // --- groups: manager creates, member sends, other member polls ---
    await gui.call('bridge_group_create', { group: 'ops', members: ['alice', 'bob'] })
    await bob.call('bridge_group_send', { group: 'ops', message: 'e2e group hi' })
    const aliceGroup = await alice.call('bridge_poll')
    check('group message delivered to members', aliceGroup.messages?.some(m => m.content === 'e2e group hi' && m.channel === 'ops'), JSON.stringify(aliceGroup).slice(0, 200))

    // --- persistence across a REAL process restart (SQLite) ---
    const carol = makeClient('carol', BASE_A)
    await carol.init() // registered, then goes idle (no SSE, no waiters)
    await alice.call('bridge_chat', { to: 'carol', message: 'e2e survive restart' })
    await new Promise(r => setTimeout(r, 1500)) // let the 500ms debounced flush hit disk
    stopProc(hubA.child)
    await new Promise(r => setTimeout(r, 500))

    console.log('== E2E A2: restart with the same --db ==')
    hubA = await startHubProc(PORT_A, ['--db', dbFile, '--heartbeat-ms', '100'])
    const carol2 = makeClient('carol', BASE_A)
    await carol2.init()
    const carolPoll = await carol2.call('bridge_poll')
    check('offline mailbox survives a process restart', carolPoll.messages?.some(m => m.content === 'e2e survive restart'), JSON.stringify(carolPoll).slice(0, 200))
    const gui2 = makeClient('agent-hub-cli', BASE_A)
    await gui2.init()
    const hist = await gui2.call('bridge_history', { peer: 'all', limit: 50 })
    check('history survives a process restart', hist.messages?.some(m => m.content === 'e2e hello') && hist.messages?.some(m => m.content === 'e2e group hi'), `count=${hist.messages?.length}`)

    await guiSse.cancel()
    await bobSse.cancel()
  } finally {
    stopProc(hubA.child)
  }

  // ================= Scenario B: remote-auth mode =================
  console.log('== E2E B: remote auth (real CLI subprocess) ==')
  const PORT_B = 19022
  const BASE_B = `http://127.0.0.1:${PORT_B}/mcp`
  const tokenFile = join(tmp, 'tokens.json')
  writeFileSync(tokenFile, JSON.stringify({ version: 1, tokens: [
    { token: 'e2e-zs-token-0123456789abcdef', peer: 'zhangsan', role: 'agent', owner: '张三' },
    { token: 'e2e-mgr-token-0123456789abcdef', peer: 'boss', role: 'manager' },
  ] }))
  const hubB = await startHubProc(PORT_B, ['--auth-tokens', tokenFile, '--db', 'off'])
  try {
    const noAuth = await fetch(BASE_B, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) })
    check('no token → 401', noAuth.status === 401, String(noAuth.status))
    const badAuth = await fetch(BASE_B, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer wrong' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) })
    check('unknown token → 401', badAuth.status === 401, String(badAuth.status))
    const hzB = await fetch(`http://127.0.0.1:${PORT_B}/healthz`)
    check('healthz stays open in auth mode', hzB.status === 200, String(hzB.status))

    // Token decides identity: the client-reported name is NOT the peer id.
    const zs = makeClient('kimi-code', BASE_B, 'e2e-zs-token-0123456789abcdef')
    await zs.init()
    const zsPeers = await zs.call('bridge_peers')
    check('token identity overrides clientInfo.name', zsPeers.peers?.some(p => p.id === 'zhangsan') && !zsPeers.peers?.some(p => p.id === 'kimi-code'), JSON.stringify(zsPeers).slice(0, 200))

    const boss = makeClient('ops', BASE_B, 'e2e-mgr-token-0123456789abcdef')
    await boss.init()
    await zs.call('bridge_chat', { to: 'boss', message: 'e2e authed hello' })
    const bossWait = await boss.call('bridge_wait', { timeoutMs: 3000, from: 'zhangsan' })
    check('authenticated peers exchange messages', bossWait.type === 'message' && bossWait.message?.content === 'e2e authed hello', JSON.stringify(bossWait).slice(0, 200))
    const all = await boss.call('bridge_history', { peer: 'all' })
    check('manager token reads full history', Array.isArray(all.messages), JSON.stringify(all).slice(0, 200))
    const zsDenied = await zs.call('bridge_history', { peer: 'all' }).then(() => null, e => e)
    check('non-manager token denied peer=all history', zsDenied !== null)
  } finally {
    stopProc(hubB.child)
  }

  // ========== Scenario C: an OPEN manual lease across a REAL restart ==========
  // A manual lease is a delivery in progress: the hub handed the message out
  // but did not forget it. Restarting the process must therefore hand the SAME
  // message back instead of losing it — that is the at-least-once half of the
  // lease contract, and the half that had no test. The message is left
  // UNCOMMITTED on purpose; the restart happens well inside the 60s default
  // lease TTL, so a real implementation has no excuse for forgetting it.
  console.log('== E2E C: open manual lease survives a real restart (SQLite) ==')
  const leaseDb = join(tmp, 'lease.db')
  const PORT_C = 19030
  const PORT_C2 = 19031
  let hubC = await startHubProc(PORT_C, ['--db', leaseDb])
  try {
    const baseC = `http://127.0.0.1:${PORT_C}/mcp`
    const leaseA = makeClient('lease-a', baseC)
    const leaseB = makeClient('lease-b', baseC)
    await Promise.all([leaseA.init(), leaseB.init()])
    await leaseA.call('bridge_chat', { to: 'lease-b', message: 'e2e leased mail' })
    const leased = await leaseB.call('bridge_wait', { timeoutMs: 2000, ack: 'manual' })
    const leasedId = leased.message?.id
    check('a manual-ack wait leases the message (precondition)', leased.type === 'message' && leased.message?.content === 'e2e leased mail', JSON.stringify(leased).slice(0, 200))
    // No bridge_commit: the lease stays open. Then give the 500ms debounced
    // snapshot time to reach disk before the process dies.
    await new Promise(r => setTimeout(r, 900))
    stopProc(hubC.child)
    await new Promise(r => setTimeout(r, 500))

    console.log('== E2E C2: restart with the same --db (the lease is still open) ==')
    hubC = await startHubProc(PORT_C2, ['--db', leaseDb])
    const baseC2 = `http://127.0.0.1:${PORT_C2}/mcp`
    const leaseB2 = makeClient('lease-b', baseC2)
    await leaseB2.init()
    // Cause isolation: prove this restart really did reload the same SQLite
    // state, so a message missing below is the lease and not a snapshot that
    // never reached disk.
    const leaseHistory = await leaseB2.call('bridge_history')
    check('the same --db is restored after the restart (history still has it)', leaseHistory.messages?.some(m => m.id === leasedId), `count=${leaseHistory.messages?.length}`)
    const redelivered = await leaseB2.call('bridge_wait', { timeoutMs: 3000 })
    check('an uncommitted lease survives a process restart (same message id)', redelivered.type === 'message' && redelivered.message?.id === leasedId, `expected id=${leasedId}, got ${JSON.stringify(redelivered).slice(0, 200)}`)
    // Guard against a wrong fix: a message that reappears out of the DEAD-LETTER
    // table would look identical to a correct redelivery, so nothing may have
    // been dead-lettered at all.
    const leaseMetrics = await leaseB2.call('bridge_metrics')
    const leaseBRow = leaseMetrics.peers?.find(row => row.peerId === 'lease-b')
    check('the redelivered lease is not a dead-letter revival', leaseMetrics.global?.deadLettered === 0 && (leaseBRow?.deadLettered ?? 0) === 0, `global=${leaseMetrics.global?.deadLettered} peer=${JSON.stringify(leaseBRow)}`)
  } finally {
    stopProc(hubC.child)
  }

  // ====== Scenario C3: an EXPIRED, un-reaped lease across a REAL restart ======
  // Scenario C leaves the lease OPEN on purpose. The other half of the contract
  // is the lease that expired but was never reaped: no take (so no reap) and no
  // GC window in between. The snapshot must still contain it — it is evidence
  // that the hub handed the message out, not a reachability verdict — because a
  // snapshot that drops it leaves the message in neither the queue nor the store
  // and a restart loses it for good. The debounce (500ms) is deliberately longer
  // than the lease TTL (250ms), so the snapshot really is written AFTER expiry.
  console.log('== E2E C3: an expired, un-reaped lease is still in the snapshot (SQLite) ==')
  const staleDb = join(tmp, 'lease-stale.db')
  const PORT_C3 = 19038
  const PORT_C4 = 19039
  let hubC3 = await startHubProc(PORT_C3, ['--db', staleDb, '--lease-ttl-ms', '250'])
  let staleId
  try {
    const staleBase = `http://127.0.0.1:${PORT_C3}/mcp`
    const staleA = makeClient('stale-a', staleBase)
    const staleB = makeClient('stale-b', staleBase)
    await Promise.all([staleA.init(), staleB.init()])
    await staleA.call('bridge_chat', { to: 'stale-b', message: 'leased, expired, never polled' })
    const staleLease = await staleB.call('bridge_wait', { timeoutMs: 2000, ack: 'manual' })
    staleId = staleLease.message?.id
    check('(precondition) the message is leased under a 250ms lease', staleLease.type === 'message' && staleId !== undefined, JSON.stringify(staleLease).slice(0, 200))
    // NO bridge_poll, NO bridge_commit: the lease expires where it is.
    await new Promise(r => setTimeout(r, 1500))
  } finally {
    stopProc(hubC3.child)
  }
  await new Promise(r => setTimeout(r, 500))

  console.log('== E2E C4: restart with the same --db (nobody ever reaped the lease) ==')
  hubC3 = await startHubProc(PORT_C4, ['--db', staleDb])
  try {
    const staleBase2 = `http://127.0.0.1:${PORT_C4}/mcp`
    const staleB2 = makeClient('stale-b', staleBase2)
    await staleB2.init()
    const staleHistory = await staleB2.call('bridge_history')
    check('the same --db is restored after the restart (history still has it)', staleHistory.messages?.some(m => m.id === staleId), `count=${staleHistory.messages?.length}`)
    const staleBack = await staleB2.call('bridge_wait', { timeoutMs: 3000 })
    check(
      'an expired, never-reaped lease survives the restart (the message is not lost)',
      staleBack.type === 'message' && staleBack.message?.id === staleId,
      `expected id=${staleId}, got ${JSON.stringify(staleBack).slice(0, 200)}`,
    )
    const staleMetrics = await staleB2.call('bridge_metrics')
    const staleRow = staleMetrics.peers?.find(row => row.peerId === 'stale-b')
    check('it comes back as ordinary queued mail, not as a dead-letter revival', (staleRow?.deadLettered ?? 0) === 0 && staleMetrics.global?.deadLettered === 0, JSON.stringify(staleRow))
  } finally {
    stopProc(hubC3.child)
  }

  // ====== Scenario D: an input-required task across a REAL restart ======
  // `input-required` is a non-terminal interrupt, not a terminal status: the
  // task is still live and the sender still owes an answer. Dropping it at
  // import makes bridge_task_status / bridge_task_input fail after a restart,
  // which strands a task that nobody can close.
  console.log('== E2E D: input-required task survives a real restart (SQLite) ==')
  const taskDb = join(tmp, 'task.db')
  const PORT_D = 19032
  const PORT_D2 = 19033
  let hubD = await startHubProc(PORT_D, ['--db', taskDb])
  try {
    const baseD = `http://127.0.0.1:${PORT_D}/mcp`
    const taskA = makeClient('task-a', baseD)
    const taskB = makeClient('task-b', baseD)
    await Promise.all([taskA.init(), taskB.init()])
    await taskA.call('bridge_task', { to: 'task-b', prompt: 'e2e task that needs input' })
    const taskDelivery = await taskB.call('bridge_wait', { timeoutMs: 3000, from: 'task-a' })
    const taskRef = taskDelivery.message?.id
    await taskB.call('bridge_ack', { ref: taskRef, status: 'input-required', note: 'which repo?' })
    const liveStatus = await taskA.call('bridge_task_status', { ref: taskRef })
    check('the task sits in input-required before the restart (precondition)', liveStatus.task?.status === 'input-required' && liveStatus.a2aState === 'input-required', JSON.stringify(liveStatus).slice(0, 200))
    await new Promise(r => setTimeout(r, 900))
    stopProc(hubD.child)
    await new Promise(r => setTimeout(r, 500))

    console.log('== E2E D2: restart with the same --db (input-required task) ==')
    hubD = await startHubProc(PORT_D2, ['--db', taskDb])
    const baseD2 = `http://127.0.0.1:${PORT_D2}/mcp`
    const taskA2 = makeClient('task-a', baseD2)
    await taskA2.init()
    const restored = await taskA2.call('bridge_task_status', { ref: taskRef }).then(r => r, e => ({ error: String(e.message) }))
    check('bridge_task_status still reports input-required after a process restart', restored.task?.status === 'input-required' && restored.a2aState === 'input-required', JSON.stringify(restored).slice(0, 200))
    // `task-b` has to RECONNECT before the answer can be delivered: a restored
    // profile alone is not an addressable peer. The hub routes to peers that are
    // registered or parked, and a restart leaves `task-b` neither — so the ack
    // would be refused as an unknown recipient. This is delivery, not the W5
    // ledger semantics asserted above (the ledger is already restored here).
    const taskB2 = makeClient('task-b', baseD2)
    await taskB2.init()
    const answered = await taskA2.call('bridge_task_input', { ref: taskRef, input: 'here is the info' }).then(r => r, e => ({ error: String(e.message) }))
    check('bridge_task_input still answers the task after a process restart', answered.ok === true && answered.ref === taskRef, JSON.stringify(answered).slice(0, 200))
    const resumed = await taskA2.call('bridge_task_status', { ref: taskRef }).then(r => r, e => ({ error: String(e.message) }))
    check('the answered task is working again after a process restart', resumed.task?.status === 'working', JSON.stringify(resumed).slice(0, 200))
    const inputAck = await taskB2.call('bridge_wait', { timeoutMs: 3000, ref: taskRef }).then(r => r, e => ({ error: String(e.message) }))
    check('the reconnected assignee receives the answer as an ack', inputAck.type === 'message' && inputAck.message?.content?.status === 'working' && inputAck.message?.content?.note === 'here is the info', JSON.stringify(inputAck).slice(0, 200))
  } finally {
    stopProc(hubD.child)
  }

  // ========== Scenario E: priority order across a REAL restart ==========
  // `priority` orders a mailbox, so it has to be part of the persisted message,
  // not just of the in-memory queue: a restored mailbox must still hand the
  // urgent message over first. Nothing polls before the restart on purpose —
  // the two messages are still queued when the process dies.
  console.log('== E2E E: priority order survives a real restart (SQLite) ==')
  const prioDb = join(tmp, 'prio.db')
  const PORT_E = 19034
  const PORT_E2 = 19035
  let hubE = await startHubProc(PORT_E, ['--db', prioDb])
  try {
    const baseE = `http://127.0.0.1:${PORT_E}/mcp`
    const prioP = makeClient('prio-p', baseE)
    const prioQ = makeClient('prio-q', baseE)
    await Promise.all([prioP.init(), prioQ.init()])
    await prioP.call('bridge_chat', { to: 'prio-q', message: 'low-priority', priority: 0 })
    await prioP.call('bridge_chat', { to: 'prio-q', message: 'high-priority', priority: 2 })
    await new Promise(r => setTimeout(r, 900))
    stopProc(hubE.child)
    await new Promise(r => setTimeout(r, 500))

    console.log('== E2E E2: restart with the same --db (both messages still queued) ==')
    hubE = await startHubProc(PORT_E2, ['--db', prioDb])
    const baseE2 = `http://127.0.0.1:${PORT_E2}/mcp`
    const prioQ2 = makeClient('prio-q', baseE2)
    await prioQ2.init()
    const prioPoll = await prioQ2.call('bridge_poll')
    const order = (prioPoll.messages ?? []).map(m => m.content)
    check('priority 2 is still delivered before priority 0 after a process restart', order[0] === 'high-priority', `order=${JSON.stringify(order)}`)
    // The order above can survive by luck (the mailbox is exported in its
    // already-ordered form), so assert the persisted FIELD too: a message that
    // comes back with no priority is a priority-0 message in everything but
    // name, and the next arrival would be ordered against that wrong value.
    const restoredHigh = (prioPoll.messages ?? []).find(m => m.content === 'high-priority')
    check('a restored message keeps its priority field', restoredHigh?.priority === 2, `restored=${JSON.stringify(restoredHigh)}`)
  } finally {
    stopProc(hubE.child)
  }
} finally {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) process.exitCode = 1
