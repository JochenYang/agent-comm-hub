// Check herdr agent recognition of the Claude Code pane via hub tools.
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

  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dsh-agent-check', version: '1' } })
  await rpc('notifications/initialized')

  console.log('== bridge_agent_list (herdr-recognized agents) ==')
  const agents = await call('bridge_agent_list')
  console.log(JSON.stringify(agents.parsed, null, 2))

  console.log('\n== bridge_pane_list (all panes) ==')
  const panes = await call('bridge_pane_list')
  console.log(JSON.stringify(panes.parsed, null, 2))
}

main().catch(err => { console.error('failed:', err.message); process.exit(1) })
