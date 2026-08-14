/**
 * Operational helpers for the CLI: `status` (hub health + peers) and
 * `service install/uninstall` (one-shot auto-start on Windows/Linux).
 */

import { execFileSync } from 'node:child_process'
import { request } from 'node:http'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface StatusOptions {
  host?: string
  port?: number
  path?: string
  url?: string
}

export interface StatusResult {
  running: boolean
  url: string
  version?: string
  peers: Array<{ id: string; connected: boolean }>
  error?: string
}

/** Probe the hub endpoint and list registered peers (self excluded). */
export async function runStatus(options: StatusOptions = {}): Promise<StatusResult> {
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 18764
  const path = options.path ?? '/mcp'
  const url = options.url ?? `http://${host}:${port}${path}`
  const probeName = 'agent-comm-hub-cli'
  const notRunning: StatusResult = { running: false, url, peers: [] }
  try {
    const headers: Record<string, string> = {}
    let id = 0
    // Plain node:http instead of fetch: undici's keep-alive pool can race
    // process.exit() on Windows (libuv UV_HANDLE_CLOSING assertion). Each
    // probe request gets its own socket (agent: false) and a hard timeout,
    // so the process always exits cleanly.
    const rpc = async (method: string, params?: unknown): Promise<{ result?: { content?: Array<{ text?: string }>; [k: string]: unknown }; error?: { message?: string } }> => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: ++id, method, ...(params !== undefined ? { params } : {}) })
      const res = await new Promise<{ status: number; contentType: string; text: string; sessionId: string | undefined }>((resolve, reject) => {
        const req = request(url, {
          method: 'POST',
          agent: false,
          headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Content-Length': Buffer.byteLength(body), ...headers },
        }, (response) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => chunks.push(chunk))
          response.on('end', () => resolve({
            status: response.statusCode ?? 0,
            contentType: response.headers['content-type'] ?? '',
            sessionId: typeof response.headers['mcp-session-id'] === 'string' ? response.headers['mcp-session-id'] : undefined,
            text: Buffer.concat(chunks).toString('utf8'),
          }))
        })
        req.setTimeout(5000, () => req.destroy(new Error(`probe timed out after 5s`)))
        req.on('error', reject)
        req.end(body)
      })
      if (res.sessionId) headers['Mcp-Session-Id'] = res.sessionId
      const json = res.contentType.includes('text/event-stream')
        ? JSON.parse(res.text.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5)).join(''))
        : JSON.parse(res.text)
      return json as { result?: { content?: Array<{ text?: string }> }; error?: { message?: string } }
    }
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: probeName, version: 'cli' } })
    if (init.error) return { ...notRunning, error: init.error.message }
    const version = ((init.result as { serverInfo?: { version?: string } })?.serverInfo?.version) ?? undefined
    const call = await rpc('tools/call', { name: 'bridge_peers', arguments: {} })
    const text = call.result?.content?.[0]?.text
    const parsed = text ? JSON.parse(text) as { peers?: Array<{ id: string; connected: boolean }> } : { peers: [] }
    const peers = (parsed.peers ?? []).filter(peer => peer.id !== probeName)
    await rpc('tools/call', { name: 'bridge_unregister', arguments: {} }).catch(() => undefined)
    return { running: true, url, version, peers }
  } catch (error) {
    return { ...notRunning, error: (error as Error).message }
  }
}

export interface ServiceOptions {
  action: 'install' | 'uninstall'
  host?: string
  port?: number
  path?: string
  dryRun?: boolean
}

/** Self-update: reinstall the package from the npm registry (files in place).
 * The global install path does not change, so a previously registered
 * auto-start launcher (Run key / VBS or systemd unit) keeps working. */
export function runUpdate(): { ok: boolean; messages: string[] } {
  const messages: string[] = []
  const pkgFile = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
  const readVersion = (): string => {
    try {
      return (JSON.parse(readFileSync(pkgFile, 'utf8')) as { version?: string }).version ?? '?'
    } catch {
      return '?'
    }
  }
  try {
    const before = readVersion()
    messages.push(`current version: ${before}`)
    const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const out = execFileSync(npmBin, ['install', '-g', 'agent-comm-hub@latest'], { encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32' })
    const tail = out.trim().split(/\r?\n/).slice(-3).filter(Boolean).join(' | ')
    if (tail) messages.push(tail)
    const after = readVersion()
    if (after === before) messages.push(`already up to date (v${after})`)
    else messages.push(`updated: v${before} -> v${after}`)
    messages.push('restart the hub (agent-comm-hub) to pick up the new version')
    return { ok: true, messages }
  } catch (error) {
    return { ok: false, messages: [`update failed: ${(error as Error).message}`] }
  }
}

/** Path of this package's lib/cli.js (used by the auto-start task). */
function cliPath(): string {
  return fileURLToPath(import.meta.url)
}

function nodeExe(): string {
  return process.execPath
}

function run(command: string, args: string[], dryRun: boolean): string {
  if (dryRun) return `[dry-run] ${command} ${args.join(' ')}`
  return execFileSync(command, args, { encoding: 'utf8', windowsHide: true }).trim()
}

/** One-shot auto-start registration (Windows HKCU Run + hidden VBS launcher,
 * no admin; Linux systemd user unit). */
export function runService(options: ServiceOptions): { ok: boolean; messages: string[] } {
  const messages: string[] = []
  const port = options.port ?? 18764
  const host = options.host ?? '127.0.0.1'
  const path = options.path ?? '/mcp'
  const dryRun = options.dryRun === true

  try {
    if (process.platform === 'win32') {
      // No-admin auto-start: HKCU Run key pointing at a hidden-window VBS
      // launcher (schtasks often needs elevation; this never does).
      const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
      const launcherDir = join(appData, 'agent-comm-hub')
      const vbs = join(launcherDir, 'agent-comm-hub.vbs')
      const runKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
      const valueName = 'agent-comm-hub'
      if (options.action === 'install') {
        const cmd = `"${nodeExe()}" "${cliPath()}" --host ${host} --port ${port} --path ${path}`
        const vbsContent = `CreateObject("WScript.Shell").Run "${cmd.replace(/"/g, '""')}", 0, False\n`
        if (dryRun) {
          messages.push(`[dry-run] write ${vbs}`)
          messages.push(`[dry-run] reg add "${runKey}" /v ${valueName} /t REG_SZ /d "wscript.exe \\"${vbs}\\"" /f`)
        } else {
          mkdirSync(launcherDir, { recursive: true })
          writeFileSync(vbs, vbsContent)
          execFileSync('reg', ['add', runKey, '/v', valueName, '/t', 'REG_SZ', '/d', `wscript.exe "${vbs}"`, '/f'], { encoding: 'utf8', windowsHide: true })
          messages.push(`auto-start registered: HKCU Run '${valueName}' -> hidden wscript launcher "${vbs}"`)
          messages.push(`start it now with: wscript.exe "${vbs}"`)
        }
      } else {
        if (dryRun) {
          messages.push(`[dry-run] reg delete "${runKey}" /v ${valueName} /f`)
          messages.push(`[dry-run] del ${vbs}`)
        } else {
          try { execFileSync('reg', ['delete', runKey, '/v', valueName, '/f'], { encoding: 'utf8', windowsHide: true }) } catch { /* not present */ }
          rmSync(launcherDir, { recursive: true, force: true })
          messages.push('auto-start removed (Run key + hidden launcher)')
        }
      }
      return { ok: true, messages }
    }

    if (process.platform === 'linux') {
      const unitDir = join(homedir(), '.config', 'systemd', 'user')
      const unitFile = join(unitDir, 'agent-comm-hub.service')
      if (options.action === 'install') {
        const unit = `[Unit]\nDescription=agent-comm-hub (multi-peer MCP hub)\nAfter=network.target\n\n[Service]\nExecStart=${nodeExe()} ${cliPath()} --host ${host} --port ${port} --path ${path}\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n`
        if (dryRun) {
          messages.push(`[dry-run] would write ${unitFile}`)
          messages.push(`[dry-run] systemctl --user daemon-reload && systemctl --user enable --now agent-comm-hub`)
        } else {
          mkdirSync(unitDir, { recursive: true })
          writeFileSync(unitFile, unit)
          run('systemctl', ['--user', 'daemon-reload'], false)
          const out = run('systemctl', ['--user', 'enable', '--now', 'agent-comm-hub'], false)
          messages.push(out || `systemd user unit installed and enabled: ${unitFile}`)
        }
      } else {
        if (dryRun) {
          messages.push(`[dry-run] systemctl --user disable --now agent-comm-hub && rm ${unitFile}`)
        } else {
          run('systemctl', ['--user', 'disable', '--now', 'agent-comm-hub'], false)
          rmSync(unitFile, { force: true })
          run('systemctl', ['--user', 'daemon-reload'], false)
          messages.push(`systemd user unit removed: ${unitFile}`)
        }
      }
      return { ok: true, messages }
    }

    return { ok: false, messages: [`auto-start is not implemented for ${process.platform} — use pm2 or your platform's supervisor`] }
  } catch (error) {
    return { ok: false, messages: [`${(error as Error).message}`] }
  }
}
