/**
 * Tests for `agent-comm-hub status`: hub health probe against a live hub
 * (with a registered peer) and against a dead port. Also covers the
 * auto-start service command's per-platform dry-run output.
 */

import { startHub } from './entry.mjs'
import { runStatus, runService } from './ops-entry.mjs'

let failures = 0
let checks = 0
function check(name, ok, detail = '') {
  checks++
  if (ok) console.log(`  ok    ${name}`)
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

const PORT = 18997
const hub = startHub({ port: PORT, waitTimeoutMs: 2000, maxQueue: 10, historyLimit: 10 }, { info: () => {}, warn: () => {} })

try {
  console.log('== status: hub up ==')
  // register a fake peer via a real MCP session
  const headers = {}
  const rpc = async (method, params) => {
    const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params !== undefined ? { params } : {}) }),
    })
    const sid = res.headers.get('mcp-session-id')
    if (sid) headers['Mcp-Session-Id'] = sid
    return res.json()
  }
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fakepeer', version: '1' } })
  await rpc('tools/call', { name: 'bridge_peers', arguments: {} })

  const up = await runStatus({ host: '127.0.0.1', port: PORT })
  check('status reports running', up.running === true, JSON.stringify(up))
  check('status reports hub version', typeof up.version === 'string' && up.version.length > 0, JSON.stringify(up))
  check('status lists the registered peer', up.peers.some(p => p.id === 'fakepeer' && p.connected === true), JSON.stringify(up))
  check('status excludes its own probe peer', !up.peers.some(p => p.id === 'agent-comm-hub-cli'), JSON.stringify(up))
  check('status cleans up after itself', !(await runStatus({ host: '127.0.0.1', port: PORT })).peers.some(p => p.id === 'agent-comm-hub-cli'))

  console.log('== status: hub down ==')
  const down = await runStatus({ host: '127.0.0.1', port: 19999 })
  check('status reports not running on dead port', down.running === false && typeof down.error === 'string', JSON.stringify(down))

  console.log('== service: dry-run per platform ==')
  const win = runService({ action: 'install', dryRun: true, platform: 'win32' })
  check('win32 install dry-run mentions Run key', win.ok && win.messages.some(m => m.includes('reg add')), JSON.stringify(win.messages))
  const winRm = runService({ action: 'uninstall', dryRun: true, platform: 'win32' })
  check('win32 uninstall dry-run mentions reg delete', winRm.ok && winRm.messages.some(m => m.includes('reg delete')), JSON.stringify(winRm.messages))
  const lin = runService({ action: 'install', dryRun: true, platform: 'linux' })
  check('linux install dry-run mentions systemctl', lin.ok && lin.messages.some(m => m.includes('systemctl --user')), JSON.stringify(lin.messages))
  const mac = runService({ action: 'install', dryRun: true, platform: 'darwin' })
  check('macos install dry-run writes plist + launchctl bootstrap', mac.ok && mac.messages.some(m => m.includes('launchctl bootstrap')) && mac.messages.some(m => m.includes('.plist')), JSON.stringify(mac.messages))
  const macRm = runService({ action: 'uninstall', dryRun: true, platform: 'darwin' })
  check('macos uninstall dry-run mentions bootout', macRm.ok && macRm.messages.some(m => m.includes('launchctl bootout')), JSON.stringify(macRm.messages))

  console.log(`\n${checks - failures}/${checks} checks passed`)
  if (failures > 0) process.exitCode = 1
} finally {
  hub.close()
}
