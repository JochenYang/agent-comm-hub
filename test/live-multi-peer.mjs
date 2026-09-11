/**
 * Live multi-peer exercise against a running hub (default 127.0.0.1:18764).
 * Not part of `pnpm test` — run manually after starting the hub CLI.
 */
import http from 'node:http'

const BASE = process.env.HUB_URL ?? 'http://127.0.0.1:18764'
const PATH = '/mcp'
let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  if (ok) {
    pass++
    console.log('  ok   ', name)
  } else {
    fail++
    console.log('  FAIL ', name, detail)
  }
}

function request(body, { sid, token } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(PATH, BASE)
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    }
    if (sid) headers['Mcp-Session-Id'] = sid
    if (token) headers.Authorization = `Bearer ${token}`
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers, agent: false },
      res => {
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          const newSid = res.headers['mcp-session-id']
          let json = null
          try { json = JSON.parse(text) } catch { /* SSE or empty */ }
          resolve({ status: res.statusCode, sid: newSid, json, text })
        })
      },
    )
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
}

class Peer {
  constructor(name) {
    this.name = name
    this.sid = null
  }
  async rpc(method, params) {
    const isNote = method.startsWith('notifications/')
    const body = { jsonrpc: '2.0', method, params }
    if (!isNote) body.id = Math.floor(Math.random() * 1e6)
    const res = await request(body, { sid: this.sid })
    if (res.sid) this.sid = res.sid
    if (isNote) return {}
    if (!res.json || res.json.error) throw new Error(res.json?.error?.message ?? `HTTP ${res.status}`)
    return res.json
  }
  async init() {
    await this.rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: this.name, version: 'live-1' },
    })
    await this.rpc('notifications/initialized')
  }
  async call(tool, args = {}) {
    const json = await this.rpc('tools/call', { name: tool, arguments: args })
    const parsed = JSON.parse(json.result?.content?.[0]?.text ?? '{}')
    if (json.result?.isError) throw new Error(parsed.error ?? 'tool error')
    return parsed
  }
  async callRaw(tool, args = {}) {
    const json = await this.rpc('tools/call', { name: tool, arguments: args })
    const parsed = JSON.parse(json.result?.content?.[0]?.text ?? '{}')
    return { isError: json.result?.isError === true, ...parsed }
  }
}

async function main() {
  console.log(`== live hub ${BASE}${PATH} ==`)
  const health = await new Promise((resolve, reject) => {
    http.get(`${BASE}/healthz`, { agent: false }, res => {
      const c = []
      res.on('data', d => c.push(d))
      res.on('end', () => resolve(JSON.parse(Buffer.concat(c).toString('utf8'))))
    }).on('error', reject)
  })
  check('healthz ok', health.ok === true, JSON.stringify(health))

  const run = Date.now().toString(36)
  const a = new Peer('live-alice')
  const b = new Peer('live-bob')
  const c = new Peer('live-carol')
  await Promise.all([a.init(), b.init(), c.init()])

  // Distinct identities (unique per run so a leftover state.db is harmless).
  const idA = `alice-${run}`
  const idB = `bob-${run}`
  const idC = `carol-${run}`
  await a.call('bridge_register', { peerId: idA, alias: 'Alice' })
  await b.call('bridge_register', { peerId: idB })
  await c.call('bridge_register', { peerId: idC })
  const peers = await a.call('bridge_peers')
  const ids = peers.peers.map(p => p.id)
  check('three distinct peers online', [idA, idB, idC].every(id => ids.includes(id)), JSON.stringify(ids))

  // P0: multi-burst wait — three messages, three sequential waits.
  await b.call('bridge_chat', { to: idA, message: 'burst-1' })
  await c.call('bridge_chat', { to: idA, message: 'burst-2' })
  await b.call('bridge_chat', { to: idA, message: 'burst-3' })
  const w1 = await a.call('bridge_wait', { timeoutMs: 2000 })
  const w2 = await a.call('bridge_wait', { timeoutMs: 2000 })
  const w3 = await a.call('bridge_wait', { timeoutMs: 2000 })
  check(
    'P0 burst: 3 sequential waits deliver 3 messages',
    [w1, w2, w3].every(w => w.type === 'message') &&
      [w1.message.content, w2.message.content, w3.message.content].join(',') === 'burst-1,burst-2,burst-3',
    JSON.stringify([w1, w2, w3]),
  )

  // Task + ack ledger.
  const taskRes = await a.call('bridge_task', {
    to: idB,
    prompt: 'compile the live report',
    deliverable: 'one paragraph',
  })
  const taskId = taskRes.id
  check('bridge_task returns receipt id', typeof taskId === 'string' && taskId.length > 10, JSON.stringify(taskRes))
  const bobTask = await b.call('bridge_wait', { timeoutMs: 3000 })
  check('bob receives the task', bobTask.type === 'message' && bobTask.message.kind === 'task' && bobTask.message.id === taskId, JSON.stringify(bobTask))
  await b.call('bridge_ack', { ref: taskId, status: 'accepted', note: 'starting' })
  const st1 = await a.call('bridge_task_status', { ref: taskId })
  check('ledger accepted after ack', st1.task?.status === 'accepted' && st1.task?.acks?.[0]?.from === idB, JSON.stringify(st1))
  // Drain the accepted ack (still in alice's mailbox) before waiting on ref again.
  const acceptedMail = await a.call('bridge_wait', { ref: taskId, timeoutMs: 2000 })
  check('alice receives the accepted ack', acceptedMail.type === 'message' && acceptedMail.message.content.status === 'accepted', JSON.stringify(acceptedMail))
  // Noise + wait({ref}) for the terminal ack only.
  await c.call('bridge_chat', { to: idA, message: 'noise' })
  const waitRef = a.call('bridge_wait', { ref: taskId, timeoutMs: 4000 })
  await b.call('bridge_ack', { ref: taskId, status: 'done', note: 'paragraph ready' })
  const ackOnly = await waitRef
  check(
    'wait({ref}) ignores noise and returns the task ack',
    ackOnly.type === 'message' && ackOnly.message.kind === 'ack' && ackOnly.message.ref === taskId && ackOnly.message.content.status === 'done',
    JSON.stringify(ackOnly),
  )
  const noise = await a.call('bridge_poll')
  check('noise still queued (not swallowed by wait)', noise.messages.some(m => m.content === 'noise'), JSON.stringify(noise))
  const st2 = await a.call('bridge_task_status', { ref: taskId })
  check('ledger done with 2 acks', st2.task?.status === 'done' && st2.task?.acks?.length === 2, JSON.stringify(st2))
  const sent = await a.call('bridge_tasks', { role: 'sent', status: 'done' })
  check('bridge_tasks sent+done lists the task', sent.tasks?.some(t => t.id === taskId), JSON.stringify(sent))
  const recv = await b.call('bridge_tasks', { role: 'received' })
  check('bridge_tasks received lists the task for bob', recv.tasks?.some(t => t.id === taskId), JSON.stringify(recv))
  const denied = await c.callRaw('bridge_task_status', { ref: taskId })
  check('non-party cannot read task detail', denied.isError === true || denied.error !== undefined, JSON.stringify(denied))

  // Broadcast isolation: A→B does not hit C.
  await a.call('bridge_chat', { to: idB, message: 'private-for-bob' })
  const bobPriv = await b.call('bridge_wait', { from: idA, timeoutMs: 2000 })
  check('A→B private reaches only bob', bobPriv.type === 'message' && bobPriv.message.content === 'private-for-bob', JSON.stringify(bobPriv))
  const carolBox = await c.call('bridge_poll')
  check('carol does not see A→B private', !carolBox.messages.some(m => m.content === 'private-for-bob'), JSON.stringify(carolBox))

  await a.call('bridge_chat', { to: 'all', message: 'broadcast-hello' })
  const bBc = await b.call('bridge_wait', { timeoutMs: 2000 })
  const cBc = await c.call('bridge_wait', { timeoutMs: 2000 })
  check('broadcast reaches bob and carol', bBc.message?.content === 'broadcast-hello' && cBc.message?.content === 'broadcast-hello', JSON.stringify({ bBc, cBc }))

  // Group channel (unique id — state.db may already hold live-team).
  const gid = `live-${Date.now().toString(36)}`
  await a.call('bridge_group_create', { group: gid, name: 'Live Team', members: [idB, idC] })
  await a.call('bridge_group_send', { group: gid, message: 'standup in 5' })
  const bGrp = await b.call('bridge_wait', { timeoutMs: 2000 })
  const cGrp = await c.call('bridge_wait', { timeoutMs: 2000 })
  check('group message reaches both members', bGrp.message?.content === 'standup in 5' && bGrp.message?.channel === gid && cGrp.message?.content === 'standup in 5', JSON.stringify({ bGrp, cGrp }))
  const chHist = await b.call('bridge_history', { channel: gid, limit: 5 })
  check('bridge_history {channel} works via schema', chHist.messages?.some(m => m.content === 'standup in 5'), JSON.stringify(chHist))

  console.log(`\n${pass}/${pass + fail} live checks passed`)
  if (fail > 0) process.exitCode = 1
}

main().catch(err => {
  console.error('LIVE TEST CRASHED:', err)
  process.exitCode = 1
})
