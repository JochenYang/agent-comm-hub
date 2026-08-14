// Full control loop over mcode via the hub: read → send → wait → read reply.
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

  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dsh-pane-ctl', version: '1' } })
  await rpc('notifications/initialized')

  const target = 'wT:p2'
  console.log(`== bridge_pane_read(${target}) — mcode current output ==`)
  const read = await call('bridge_pane_read', { target, lines: 15 })
  console.log(read.parsed.text ?? read.text)

  console.log(`\n== bridge_pane_send(${target}, second round-trip) ==`)
  const sent = await call('bridge_pane_send', {
    target,
    text: 'Mavis,第二轮控制测试:请用一句话告诉我你当前的工作目录,然后结束。',
  })
  console.log(sent.text)

  console.log('\nwaiting 30s for mcode...')
  await new Promise(resolve => setTimeout(resolve, 30_000))

  console.log('== bridge_pane_read after ==')
  const after = await call('bridge_pane_read', { target, lines: 15 })
  console.log(after.parsed.text ?? after.text)
}

main().catch(err => { console.error('failed:', err.message); process.exit(1) })
