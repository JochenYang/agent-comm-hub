// Send a real task to mcode (peer "agent") through the hub, then watch for its reply.
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

  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dsh-session', version: '1' } })
  await rpc('notifications/initialized')

  const task = await call('bridge_task', {
    to: 'agent',
    prompt: '连通性测试任务:请回复我你是什么 agent、当前工作目录是什么。收到后用 bridge_chat 回复 peer dsh-session。',
    deliverable: '一条 bridge_chat 回复',
  })
  console.log('bridge_task sent:', task.text)

  // Poll for mcode's reply for up to 90s (it must run a turn inside its TUI to pick this up).
  console.log('waiting for mcode reply...')
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const poll = await call('bridge_poll', { from: 'agent' })
    if (poll.parsed.messages && poll.parsed.messages.length > 0) {
      console.log('REPLY:', JSON.stringify(poll.parsed.messages, null, 2))
      return
    }
    await new Promise(resolve => setTimeout(resolve, 3000))
  }
  console.log('no reply within 90s — mcode may need a turn inside its TUI (type anything there to trigger it).')
}

main().catch(err => { console.error('failed:', err.message); process.exit(1) })
