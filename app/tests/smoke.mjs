// scripts/smoke-mcp.mjs — T-1.10 集成 smoke 验证
// 启动 hub 子进程 + 等端口 + 模拟 MCP initialize + bridge_peers + bridge_chat 全链路
// 跑法：node scripts/smoke-mcp.mjs

import { spawn } from 'node:child_process'
import { setTimeout as wait } from 'node:timers/promises'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const HUB_CLI = resolve(__dirname, '..', '..', 'lib', 'cli.js')  // 主仓编译产物
const PORT = 18764
const HUB_URL = `http://127.0.0.1:${PORT}/mcp`

if (!existsSync(HUB_CLI)) {
  console.error(`✘ Hub CLI 未找到: ${HUB_CLI}`)
  console.error(`  请先在主仓跑 pnpm build 产出 lib/cli.js`)
  process.exit(1)
}

console.log('→ 启动 hub:', HUB_CLI)
const hub = spawn('node', [HUB_CLI], { stdio: ['ignore', 'pipe', 'pipe'] })
hub.stdout.on('data', (d) => process.stdout.write(`  [hub] ${d}`))
hub.stderr.on('data', (d) => process.stderr.write(`  [hub!] ${d}`))

let exitCode = 0
const cleanup = () => {
  try {
    hub.kill('SIGTERM')
  } catch (_e) {}
  setTimeout(() => process.exit(exitCode), 500)
}
process.on('SIGINT', cleanup)
process.on('SIGTERM', cleanup)

async function postRpc(method, params, id, sessionId) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
  if (sessionId) headers['Mcp-Session-Id'] = sessionId
  const resp = await fetch(HUB_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? null })
  })
  const sid = resp.headers.get('mcp-session-id') ?? sessionId ?? null
  const text = await resp.text()
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${text}`)
  const json = JSON.parse(text)
  if (json.error) throw new Error(`JSON-RPC error: ${JSON.stringify(json.error)}`)
  return { result: json.result ?? null, sessionId: sid }
}

async function waitForHub(maxMs = 10_000) {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    try {
      const r = await fetch(HUB_URL, { method: 'POST', body: '{}' })
      // 任何 HTTP 响应（即使是 4xx）都说明端口在跑
      if (r.status >= 200 && r.status < 600) return
    } catch (_e) {}
    await wait(150)
  }
  throw new Error(`hub 在 ${maxMs}ms 内未在 ${HUB_URL} 响应`)
}

async function main() {
  await waitForHub()
  console.log('✓ hub 端口就绪')

  // 1. initialize（clientInfo.name 触发 hub 端 auto-register）
  const { result: init, sessionId } = await postRpc(
    'initialize',
    {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke-test', version: '0.1.0' }
    },
    1
  )
  console.log('✓ initialize:', JSON.stringify(init).slice(0, 80))
  if (!sessionId) throw new Error('initialize 响应缺少 Mcp-Session-Id header')
  console.log('  session:', sessionId.slice(0, 16) + '…')

  // bridge tool 通过 MCP tools/call 调时，返回值会被 hub 包装成
  //   { content: [{ type: "text", text: "JSON-encoded 字符串" }], isError: false }
  // 这里把 content[0].text 解码回 bridge tool 的真实返回。
  function unwrapBridge(result) {
    if (!Array.isArray(result?.content) || result.content.length === 0) {
      throw new Error(`unexpected bridge tool 返回: ${JSON.stringify(result)}`)
    }
    const txt = result.content[0].text
    return JSON.parse(txt)
  }

  // 2. bridge_peers（应至少包含 smoke-test 自己）
  const { result: peersRaw } = await postRpc('tools/call', { name: 'bridge_peers', arguments: {} }, 2, sessionId)
  const peers = unwrapBridge(peersRaw)
  console.log('✓ bridge_peers:', JSON.stringify(peers).slice(0, 200))
  if (!peers.peers || !Array.isArray(peers.peers)) throw new Error('bridge_peers 返回结构错误')
  const ids = peers.peers.map((p) => p.id)
  if (!ids.includes('smoke-test')) throw new Error(`bridge_peers 不包含 smoke-test: ${JSON.stringify(ids)}`)
  console.log(`  online peers: ${peers.peers.filter((p) => p.connected).length}/${peers.peers.length}`)

  // 3. bridge_register 改名（验证工具调用完整链路）
  const { result: regRaw } = await postRpc(
    'tools/call',
    { name: 'bridge_register', arguments: { peerId: 'smoke-test-renamed' } },
    3,
    sessionId
  )
  const reg = unwrapBridge(regRaw)
  console.log('✓ bridge_register:', JSON.stringify(reg).slice(0, 120))
  if (!reg.ok || reg.peerId !== 'smoke-test-renamed') {
    throw new Error(`bridge_register 返回不符预期: ${JSON.stringify(reg)}`)
  }

  // 4. bridge_peers 验证改名生效
  const { result: peers2Raw } = await postRpc('tools/call', { name: 'bridge_peers', arguments: {} }, 4, sessionId)
  const peers2 = unwrapBridge(peers2Raw)
  const ids2 = peers2.peers.map((p) => p.id)
  if (!ids2.includes('smoke-test-renamed')) throw new Error(`改名后 peer list 不含 smoke-test-renamed: ${JSON.stringify(ids2)}`)
  if (ids2.includes('smoke-test')) throw new Error(`改名后应不再有 smoke-test: ${JSON.stringify(ids2)}`)
  console.log('✓ rename 验证通过：smoke-test → smoke-test-renamed')

  // 5+6. bridge_chat + bridge_wait + bridge_history 联动：
  // hub 的 deliver() 只在有 waiter 命中时才 remember() 进 historyRing。
  // 所以先发起 bridge_wait（后台阻塞）→ 立即发 chat（from===to 走非广播 deliver）→
  // chat 命中 waiter → remember → history 可见。bridge_wait 同步返回消息。
  const waitPromise = postRpc(
    'tools/call',
    { name: 'bridge_wait', arguments: { timeoutMs: 5000 } },
    100,
    sessionId
  )
  // 给 100ms 让 waiter 注册
  await wait(100)

  const { result: chatRaw } = await postRpc(
    'tools/call',
    {
      name: 'bridge_chat',
      arguments: { to: 'smoke-test-renamed', message: 'hello from smoke-test' }
    },
    5,
    sessionId
  )
  const chat = unwrapBridge(chatRaw)
  console.log('✓ bridge_chat receipt:', JSON.stringify(chat))
  if (!chat.ok || !chat.id || chat.from !== 'smoke-test-renamed') {
    throw new Error(`bridge_chat receipt 不符预期: ${JSON.stringify(chat)}`)
  }

  // bridge_wait 应该被 chat 命中并立即返回
  const waitResult = await waitPromise
  const waited = unwrapBridge(waitResult.result)
  console.log('✓ bridge_wait 收到 chat:', waited?.message?.id === chat.id ? 'ID 匹配' : `ID 不匹配 (got ${waited?.message?.id})`)
  if (waited?.message?.id !== chat.id) {
    throw new Error(`bridge_wait 收到的消息 ID 与 chat receipt 不匹配`)
  }

  // 7. bridge_history：拉回自己刚发的消息（现在 historyRing 应该有它）
  const { result: histRaw } = await postRpc(
    'tools/call',
    { name: 'bridge_history', arguments: { peer: 'smoke-test-renamed', limit: 10 } },
    6,
    sessionId
  )
  const hist = unwrapBridge(histRaw)
  console.log(`✓ bridge_history: ${hist.messages.length} 条`)
  const found = hist.messages.find((m) => m.id === chat.id)
  if (!found) throw new Error(`bridge_history 未包含刚发的 chat ${chat.id}: ${JSON.stringify(hist.messages.map((m) => m.id))}`)
  if (found.content !== 'hello from smoke-test') {
    throw new Error(`chat 内容不符: ${JSON.stringify(found)}`)
  }
  console.log('✓ 消息历史验证通过')

  // 8. bridge_task：发 task 并让 waiter 先注册 → task 进 historyRing。
  // （hub deliver() 只在 waiter 命中时 remember()）
  const taskWaitPromise = postRpc(
    'tools/call',
    { name: 'bridge_wait', arguments: { timeoutMs: 5000 } },
    101,
    sessionId
  )
  await wait(100)
  const { result: taskRaw } = await postRpc(
    'tools/call',
    {
      name: 'bridge_task',
      arguments: {
        to: 'smoke-test-renamed',
        prompt: '请实现 foo()',
        context: '这是个内部调用',
        deliverable: 'PR 链接'
      }
    },
    7,
    sessionId
  )
  const task = unwrapBridge(taskRaw)
  console.log('✓ bridge_task receipt:', JSON.stringify(task))
  if (!task.ok || !task.id || task.kind !== 'task') {
    throw new Error(`bridge_task receipt 不符预期: ${JSON.stringify(task)}`)
  }
  // 消费 taskWait（命中 task 后立即返回）
  await taskWaitPromise

  // 9. bridge_ack：给刚发的 task 发 accepted ack（先启动 waiter 让 ack 进 history）
  const ackWaitPromise = postRpc(
    'tools/call',
    { name: 'bridge_wait', arguments: { timeoutMs: 5000 } },
    102,
    sessionId
  )
  await wait(100)
  const { result: ackRaw } = await postRpc(
    'tools/call',
    {
      name: 'bridge_ack',
      arguments: { ref: task.id, status: 'accepted', note: '好的我来' }
    },
    8,
    sessionId
  )
  const ack = unwrapBridge(ackRaw)
  console.log('✓ bridge_ack receipt:', JSON.stringify(ack))
  if (!ack.ok || ack.kind !== 'ack') {
    throw new Error(`bridge_ack receipt 不符预期: ${JSON.stringify(ack)}`)
  }
  await ackWaitPromise  // 消费 ack，让其进 historyRing

  // 10. bridge_history：拉回 task + ack
  const { result: hist2Raw } = await postRpc(
    'tools/call',
    { name: 'bridge_history', arguments: { peer: 'smoke-test-renamed', limit: 20 } },
    9,
    sessionId
  )
  const hist2 = unwrapBridge(hist2Raw)
  console.log(`✓ bridge_history (task+ack): ${hist2.messages.length} 条`)
  const foundTask = hist2.messages.find((m) => m.id === task.id)
  const foundAck = hist2.messages.find((m) => m.id === ack.id)
  if (!foundTask) throw new Error(`history 未包含 task ${task.id}`)
  if (!foundAck) throw new Error(`history 未包含 ack ${ack.id}`)
  if (foundAck.ref !== task.id) throw new Error(`ack.ref 应等于 task.id: ${foundAck.ref}`)
  // task content 是 JSON 字符串（hub encodeContent）
  let taskContent
  try {
    taskContent = typeof foundTask.content === 'string' ? JSON.parse(foundTask.content) : foundTask.content
  } catch (_e) {
    taskContent = foundTask.content
  }
  if (taskContent?.prompt !== '请实现 foo()') {
    throw new Error(`task.prompt 不符: ${JSON.stringify(taskContent)}`)
  }
  let ackContent
  try {
    ackContent = typeof foundAck.content === 'string' ? JSON.parse(foundAck.content) : foundAck.content
  } catch (_e) {
    ackContent = foundAck.content
  }
  if (ackContent?.status !== 'accepted' || ackContent?.note !== '好的我来') {
    throw new Error(`ack content 不符: ${JSON.stringify(ackContent)}`)
  }
  console.log('✓ task + ack 结构化内容验证通过')

  console.log('\n✓ M1 smoke 全链路通过')
}

try {
  await main()
} catch (e) {
  console.error('✘ smoke 失败:', e.message)
  exitCode = 1
} finally {
  cleanup()
}