// Launch Claude Code in a herdr pane and converse with it — all through the hub.
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

  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dsh-cc-ctl', version: '1' } })
  await rpc('notifications/initialized')

  const target = 'wT:p3'
  console.log('== 1. bridge_pane_send(wT:p3, "claude") — launch Claude Code ==')
  const launch = await call('bridge_pane_send', { target, text: 'claude' })
  console.log(launch.text)

  // wait for startup, then peek
  console.log('\n== 2. waiting 10s for startup ==')
  await sleep(10_000)
  const boot = await call('bridge_pane_read', { target, lines: 25 })
  console.log('--- pane output ---')
  console.log(boot.parsed.text ?? boot.text)

  // if Claude Code asks for trust/permissions at startup, accept
  const bootText = boot.parsed.text ?? ''
  if (/trust|accept|permission|Do you want/i.test(bootText)) {
    console.log('\n== 3. startup prompt detected — sending "y" ==')
    await call('bridge_pane_send', { target, text: 'y' })
    await sleep(3000)
  }

  console.log('\n== 4. bridge_pane_send — first message ==')
  const m1 = await call('bridge_pane_send', { target, text: '你好!我是 DSH,通过 agent-comm-hub 的 pane 控制通道跟你说话。请用一句话介绍你自己,然后结束。' })
  console.log(m1.text)

  console.log('\n== 5. waiting 40s for Claude Code reply ==')
  await sleep(40_000)
  const r1 = await call('bridge_pane_read', { target, lines: 30 })
  console.log('--- Claude Code reply ---')
  console.log(r1.parsed.text ?? r1.text)

  console.log('\n== 6. second message ==')
  const m2 = await call('bridge_pane_send', { target, text: '收到。第二个问题:你觉得 agent 之间通过这种 hub 直接对话,最大的价值是什么?一句话即可。' })
  console.log(m2.text)
  await sleep(30_000)
  const r2 = await call('bridge_pane_read', { target, lines: 25 })
  console.log('--- Claude Code reply 2 ---')
  console.log(r2.parsed.text ?? r2.text)
}

main().catch(err => { console.error('failed:', err.message); process.exit(1) })
