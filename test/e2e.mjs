/**
 * End-to-end test against the REAL built CLI (lib/cli.js) spawned as a
 * subprocess — the smoke suite drives startHub() in-process; this suite
 * proves the shipping artifact works end to end:
 *
 *   spawn → /healthz → MCP sessions → SSE push TIMELINESS (the message
 *   reaches passive listeners before any poll) → heartbeat → task/ack →
 *   broadcast → groups → SQLite persistence across a real process restart →
 *   remote-auth mode (token identity, 401s, healthz stays open).
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
} finally {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) process.exitCode = 1
