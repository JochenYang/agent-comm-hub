// Node client probe: verify session binding + sender identity against the hub.
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
    let json = null
    try { json = JSON.parse(text) } catch {}
    return { status: res.status, json, text, sid }
  }
  async function call(tool, args) {
    const r = await rpc('tools/call', { name: tool, arguments: args ?? {} })
    const text = r.json?.result?.content?.[0]?.text
    return { isError: r.json?.result?.isError === true, parsed: JSON.parse(text ?? '{}'), text }
  }

  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'node-probe', version: '1' } })
  console.log('init sid:', init.sid)
  await rpc('notifications/initialized')

  const peers = await call('bridge_peers')
  console.log('peers:', JSON.stringify(peers.parsed))

  const reg = await call('bridge_register', { peerId: 'node-probe' })
  console.log('register node-probe:', reg.text)

  const chat = await call('bridge_chat', { to: 'agent', message: 'from 字段测试(node-probe)' })
  console.log('chat:', chat.text)
}

main().catch(err => { console.error('probe failed:', err.message); process.exit(1) })
