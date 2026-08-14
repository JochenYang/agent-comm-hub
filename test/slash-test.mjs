// Test slash-command execution and message retrieval through the hub control tools.
const BASE = 'http://127.0.0.1:18765/mcp'

async function main() {
  const headers = {}
  let id = 0
  async function rpc(method, params) {
    const res = await fetch(BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, ...(params !== undefined ? { params } : {}) }),
    })
    const text = await res.text()
    const sid = res.headers.get('mcp-session-id')
    if (sid) headers['Mcp-Session-Id'] = sid
    return text
  }
  async function call(tool, args) {
    const text = await rpc('tools/call', { name: tool, arguments: args ?? {} })
    const json = JSON.parse(text)
    const content = json.result?.content?.[0]?.text
    return { isError: json.result?.isError === true, parsed: JSON.parse(content ?? '{}'), text: content ?? '' }
  }
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dsh-slash-test', version: '1' } })
  await rpc('notifications/initialized')

  const target = 'wT:p2'
  console.log('== 1. bridge_pane_list ==')
  const panes = await call('bridge_pane_list')
  console.log(panes.parsed.panes?.map(p => `${p.paneId} [${p.title ?? ''}] ${p.agentStatus}`).join('\n'))

  // --- slash command 1: /context (read-only session context) ---
  console.log(`\n== 2. bridge_pane_send(${target}, "/context") ==`)
  const c1 = await call('bridge_pane_send', { target, text: '/context' })
  console.log(c1.text)
  await sleep(2500)
  const r1 = await call('bridge_pane_read', { target, lines: 20 })
  console.log('--- pane output after /context ---')
  console.log(r1.parsed.text ?? r1.text)

  // back to the input line
  console.log('\n== 3. bridge_pane_keys esc to exit context view ==')
  const k1 = await call('bridge_pane_keys', { target, keys: ['esc'] })
  console.log(k1.text)
  await sleep(1200)

  // --- slash command 2: /help (command list) ---
  console.log(`\n== 4. bridge_pane_send(${target}, "/help") ==`)
  const c2 = await call('bridge_pane_send', { target, text: '/help' })
  console.log(c2.text)
  await sleep(2500)
  const r2 = await call('bridge_pane_read', { target, lines: 25 })
  console.log('--- pane output after /help ---')
  console.log(r2.parsed.text ?? r2.text)

  console.log('\n== 5. bridge_pane_keys esc ==')
  await call('bridge_pane_keys', { target, keys: ['esc'] })
  await sleep(1200)

  // --- slash command 3: /model (current model; may open a picker) ---
  console.log(`\n== 6. bridge_pane_send(${target}, "/model") ==`)
  const c3 = await call('bridge_pane_send', { target, text: '/model' })
  console.log(c3.text)
  await sleep(2000)
  const r3 = await call('bridge_pane_read', { target, lines: 20 })
  console.log('--- pane output after /model ---')
  console.log(r3.parsed.text ?? r3.text)
  console.log('\n== 7. bridge_pane_keys esc (close picker) ==')
  await call('bridge_pane_keys', { target, keys: ['esc'] })
  await sleep(1000)

  // --- message retrieval: hub mailbox history for the mcode peer ---
  console.log('\n== 8. bridge_history(peer=agent) — queued mailbox messages ==')
  const hist = await call('bridge_history', { peer: 'agent', limit: 20 })
  console.log(JSON.stringify(hist.parsed.messages ?? hist.parsed, null, 2))

  console.log('\n== 9. bridge_peers ==')
  const peers = await call('bridge_peers')
  console.log(JSON.stringify(peers.parsed))
}

main().catch(err => { console.error('failed:', err.message); process.exit(1) })
