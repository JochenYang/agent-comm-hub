// Check mcode MCP reconnect status + /status slash command + message flow.
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

  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dsh-status-test', version: '1' } })
  await rpc('notifications/initialized')

  console.log('== bridge_peers (mcode MCP reconnect check) ==')
  const peers = await call('bridge_peers')
  console.log(JSON.stringify(peers.parsed))

  const target = 'wT:p2'
  console.log(`\n== bridge_pane_send(${target}, "/status") ==`)
  const c = await call('bridge_pane_send', { target, text: '/status' })
  console.log(c.text)
  await sleep(2500)
  const r = await call('bridge_pane_read', { target, lines: 15 })
  console.log('--- pane output after /status ---')
  console.log(r.parsed.text ?? r.text)
  console.log('\n== esc ==')
  await call('bridge_pane_keys', { target, keys: ['esc'] })
}

main().catch(err => { console.error('failed:', err.message); process.exit(1) })
