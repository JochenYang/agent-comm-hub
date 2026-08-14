/**
 * herdr control layer test: a simulated agent over a real MCP session calls
 * the bridge_agent_* tools against a fake herdr CLI (test/fixtures/
 * fake-herdr.mjs). Covers tool results, argv passthrough (slash commands,
 * keys, wait flags), error envelopes (agent_not_found, prompt_stalled),
 * permission gating, and the missing-CLI path.
 *
 * Run after `pnpm run build:test`:
 *   node test/herdr.mjs
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startHub } from './herdr-entry.mjs'

const PORT = 18999
const BASE = `http://127.0.0.1:${PORT}/mcp`
const FAKE = fileURLToPath(new URL('./fixtures/fake-herdr.mjs', import.meta.url))

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

function makeClient(name, base = BASE) {
  const headers = {}
  let id = 0
  return {
    name,
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
      assertLosslessJson(parsed)
      if (r.json?.result?.isError) throw new Error(`${this.name} ${tool}: ${text}`)
      return parsed
    },
    async callRaw(tool, args) {
      const r = await this.rpc('tools/call', { name: tool, arguments: args ?? {} })
      const text = r.json?.result?.content?.[0]?.text
      const parsed = JSON.parse(text ?? '{}')
      assertLosslessJson(parsed)
      return { isError: r.json?.result?.isError === true, parsed, text }
    },
    async register(peerId) {
      return this.call('bridge_register', { peerId })
    },
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'herdr-test-'))
const logFile = join(tmp, 'herdr-calls.jsonl')
process.env.FAKE_HERDR_LOG = logFile

// Fake socket transport: records pane requests and answers from a fixed
// dataset, mirroring the pane.list / pane.send_input / pane.send_keys /
// pane.read envelopes of the herdr socket API.
const socketCalls = []
const fakePanes = [
  { pane_id: 'wT:p1', tab_id: 'wT:t1', workspace_id: 'wT', terminal_id: 'term_a', terminal_title_stripped: 'shell', agent_status: 'unknown', cwd: 'C:\\proj', focused: true, revision: 1 },
  { pane_id: 'wT:p2', tab_id: 'wT:t1', workspace_id: 'wT', terminal_id: 'term_b', terminal_title_stripped: 'Minimax Code', agent_status: 'unknown', cwd: 'C:\\proj', focused: false, revision: 9 },
]
async function fakeSendRequest(method, params) {
  socketCalls.push({ method, params })
  switch (method) {
    case 'pane.list':
      return { panes: fakePanes }
    case 'pane.send_input':
    case 'pane.send_keys':
      return { type: 'ok' }
    case 'pane.read':
      return {
        read: {
          pane_id: params.pane_id,
          tab_id: 'wT:t1',
          workspace_id: 'wT',
          source: params.source ?? 'recent',
          format: 'text',
          text: `[pane output for ${params.pane_id}]\nhello from the pane\n`,
          revision: 42,
          truncated: false,
        },
      }
    default:
      throw new Error(`fake socket: unexpected method ${method}`)
  }
}

const hub = startHub(
  {
    port: PORT,
    waitTimeoutMs: 3000,
    maxQueue: 20,
    historyLimit: 50,
    herdrBin: process.execPath,
    herdrBaseArgs: [FAKE],
    herdrTimeoutMs: 5000,
    herdrSendRequest: fakeSendRequest,
  },
  { info: () => {}, warn: () => {} },
)

const calls = () => readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
const callsFor = sub => calls().filter(call => call.sub === sub)

try {
  const mavis = makeClient('mavis')
  const claude = makeClient('claude')
  await Promise.all([mavis.init(), claude.init()])
  await mavis.register('mavis')
  await claude.register('claude')

  console.log('== herdr control tools (fake CLI) ==')

  const listed = await mavis.call('bridge_agent_list')
  check(
    'bridge_agent_list returns both fixture agents',
    Array.isArray(listed.agents) && listed.agents.length === 2,
    JSON.stringify(listed),
  )
  const first = listed.agents?.[0]
  check(
    'agent shape: paneId/name/agent/status/interactiveReady present',
    first?.paneId === 'w1:p1' && first?.name === 'claude' && first?.agent === 'claude-code' && first?.status === 'idle' && first?.interactiveReady === true && first?.revision === 3,
    JSON.stringify(first),
  )

  const status = await mavis.call('bridge_agent_status', { target: 'w1:p1' })
  check('bridge_agent_status resolves one agent', status.agent?.status === 'idle' && status.agent?.cwd === 'C:\\projects\\demo', JSON.stringify(status))

  const missing = await claude.callRaw('bridge_agent_status', { target: 'w7:p9' })
  check('unknown target surfaces agent_not_found', missing.isError === true && /agent_not_found/.test(missing.text), missing.text)

  const prompted = await mavis.call('bridge_agent_prompt', { target: 'w1:p1', text: '/compact' })
  check('bridge_agent_prompt submits without waiting', prompted.submitted === true && prompted.settled === undefined, JSON.stringify(prompted))
  const promptCalls = callsFor('prompt')
  check(
    'prompt argv passes target, slash-command text verbatim',
    promptCalls.some(call => call.rest[0] === 'w1:p1' && call.rest[1] === '/compact'),
    JSON.stringify(promptCalls),
  )

  const waited = await mavis.call('bridge_agent_prompt', { target: 'w1:p1', text: 'fix the bug', wait: true, until: ['blocked', 'done'], timeoutMs: 9000 })
  check('bridge_agent_prompt with wait settles', waited.submitted === true && waited.settled?.status === 'blocked' && waited.settled?.paneId === 'w1:p1' && waited.settled?.waitedMs === 42, JSON.stringify(waited))
  check(
    'prompt wait flags pass through (--wait, --until x2, --timeout)',
    callsFor('prompt').some(call => call.rest[2] === '--wait' && call.rest[3] === '--until' && call.rest[4] === 'blocked' && call.rest[5] === '--until' && call.rest[6] === 'done' && call.rest[7] === '--timeout' && call.rest[8] === '9000'),
    JSON.stringify(callsFor('prompt')),
  )

  const stalled = await mavis.callRaw('bridge_agent_prompt', { target: 'w1:p1', text: 'STALL', wait: true })
  check('herdr agent_prompt_stalled surfaces as a tool error', stalled.isError === true && /agent_prompt_stalled/.test(stalled.text), stalled.text)

  const settled = await mavis.call('bridge_agent_wait', { target: 'w1:p2', until: ['blocked'], timeoutMs: 6000 })
  check('bridge_agent_wait returns the matched status', settled.settled?.status === 'blocked' && settled.settled?.waitedMs === 12, JSON.stringify(settled))

  const read = await mavis.call('bridge_agent_read', { target: 'w1:p1', lines: 10 })
  check('bridge_agent_read returns pane output', read.paneId === 'w1:p1' && typeof read.text === 'string' && read.text.includes('[fake output for w1:p1]') && read.truncated === false, JSON.stringify(read))

  const keys = await mavis.call('bridge_agent_keys', { target: 'w1:p1', keys: ['esc', 'Enter'] })
  check('bridge_agent_keys sends keys verbatim', keys.ok === true && keys.sent?.length === 2 && keys.sent[0] === 'esc', JSON.stringify(keys))
  check(
    'send-keys argv passes keys after target',
    callsFor('send-keys').some(call => call.rest[0] === 'w1:p1' && call.rest[1] === 'esc' && call.rest[2] === 'Enter'),
    JSON.stringify(callsFor('send-keys')),
  )

  const emptyKeys = await mavis.callRaw('bridge_agent_keys', { target: 'w1:p1', keys: [] })
  check('empty keys rejected', emptyKeys.isError === true && /at least one key/.test(emptyKeys.text), emptyKeys.text)

  console.log('== pane control tools (fake socket) ==')

  const panes = await mavis.call('bridge_pane_list')
  check(
    'bridge_pane_list returns panes incl. unrecognized agents',
    Array.isArray(panes.panes) && panes.panes.length === 2 && panes.panes[1]?.title === 'Minimax Code' && panes.panes[1]?.agentStatus === 'unknown' && panes.panes[1]?.paneId === 'wT:p2',
    JSON.stringify(panes),
  )

  const sent = await mavis.call('bridge_pane_send', { target: 'wT:p2', text: '/compact' })
  check('bridge_pane_send reports sent text', sent.ok === true && sent.target === 'wT:p2' && sent.sent === '/compact', JSON.stringify(sent))
  check(
    'pane.send_input + Enter delivered to the pane',
    socketCalls.some(call => call.method === 'pane.send_input' && call.params.pane_id === 'wT:p2' && call.params.text === '/compact') &&
      socketCalls.some(call => call.method === 'pane.send_keys' && call.params.pane_id === 'wT:p2' && call.params.keys[0] === 'Enter'),
    JSON.stringify(socketCalls),
  )

  const beforeNoEnter = socketCalls.length
  const noEnter = await mavis.call('bridge_pane_send', { target: 'wT:p2', text: 'dir', enter: false })
  const afterNoEnter = socketCalls.slice(beforeNoEnter)
  check('bridge_pane_send respects enter: false', noEnter.ok === true && afterNoEnter.some(call => call.method === 'pane.send_input') && !afterNoEnter.some(call => call.method === 'pane.send_keys'), JSON.stringify(afterNoEnter))

  const paneKeys = await mavis.call('bridge_pane_keys', { target: 'wT:p2', keys: ['ctrl-c'] })
  check('bridge_pane_keys sends keys to any pane', paneKeys.ok === true && socketCalls.some(call => call.method === 'pane.send_keys' && call.params.pane_id === 'wT:p2' && call.params.keys[0] === 'ctrl-c'), JSON.stringify(paneKeys))

  const paneRead = await mavis.call('bridge_pane_read', { target: 'wT:p2', lines: 10 })
  check('bridge_pane_read returns pane output', paneRead.paneId === 'wT:p2' && paneRead.text.includes('[pane output for wT:p2]') && paneRead.revision === 42 && paneRead.truncated === false, JSON.stringify(paneRead))

  const paneEmpty = await mavis.callRaw('bridge_pane_send', { target: 'wT:p2', text: '' })
  check('empty pane text rejected', paneEmpty.isError === true && /must not be empty/.test(paneEmpty.text), paneEmpty.text)

  console.log('== permission gating ==')
  hub.close()
  const gatedHub = startHub(
    {
      port: PORT + 1,
      waitTimeoutMs: 3000,
      maxQueue: 20,
      historyLimit: 50,
      herdrBin: process.execPath,
      herdrBaseArgs: [FAKE],
      herdrControlPeers: ['mavis'],
    },
    { info: () => {}, warn: () => {} },
  )
  try {
    const gated = makeClient('gated', `http://127.0.0.1:${PORT + 1}/mcp`)
    const mavis2 = makeClient('mavis2', `http://127.0.0.1:${PORT + 1}/mcp`)
    await Promise.all([gated.init(), mavis2.init()])
    await gated.register('gated')
    await mavis2.register('mavis')

    const denied = await gated.callRaw('bridge_agent_list')
    check('non-whitelisted peer denied', denied.isError === true && /not allowed to use bridge_agent/.test(denied.text), denied.text)
    const allowed = await mavis2.call('bridge_agent_list')
    check('whitelisted peer allowed', Array.isArray(allowed.agents) && allowed.agents.length === 2, JSON.stringify(allowed))
  } finally {
    gatedHub.close()
  }

  console.log('== missing herdr CLI ==')
  const noHerdrHub = startHub(
    { port: PORT + 2, waitTimeoutMs: 3000, maxQueue: 20, historyLimit: 50, herdrBin: join(tmp, 'does-not-exist-herdr.exe') },
    { info: () => {}, warn: () => {} },
  )
  try {
    const lone = makeClient('lone', `http://127.0.0.1:${PORT + 2}/mcp`)
    await lone.init()
    await lone.register('lone')
    const missingCli = await lone.callRaw('bridge_agent_list')
    check('missing herdr CLI reports a clear error', missingCli.isError === true && /herdr CLI not found/.test(missingCli.text), missingCli.text)
  } finally {
    noHerdrHub.close()
  }
} finally {
  hub.close()
  rmSync(tmp, { recursive: true, force: true })
}

console.log(`\nherdr control: ${checks - failures}/${checks} checks passed`)
if (failures > 0) process.exit(1)
