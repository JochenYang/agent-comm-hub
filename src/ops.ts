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
  /** Platform semantics to emulate (tests); defaults to process.platform. */
  platform?: NodeJS.Platform
}

/** Self-update: reinstall the package from the npm registry (files in place).
 * The global install path does not change, so a previously registered
 * auto-start launcher (Run key / VBS or systemd unit) keeps working.
 *
 * npm runs in a THROWAWAY child process (`node -e`, no files on disk): npm
 * reifies by moving the package directory, which races this process's own
 * open files on Windows (observed: npm exits 0 but the files are left on the
 * old version). The child lives outside the package dir, so the swap is
 * uncontended, and the parent stays alive until it finishes. --prefer-online
 * forces fresh registry metadata (npm caches packuments ~5 min, which would
 * hide a just-published version). */
export function runUpdate(): { ok: boolean; messages: string[] } {
  const messages: string[] = []
  try {
    const pkgFile = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
    const before = (JSON.parse(readFileSync(pkgFile, 'utf8')) as { version?: string }).version ?? '?'
    messages.push(`current version: ${before}`)
    const script = [
      "import { execFileSync } from 'node:child_process'",
      "import { readFileSync } from 'node:fs'",
      `const pkg = ${JSON.stringify(pkgFile)}`,
      "const read = () => JSON.parse(readFileSync(pkg, 'utf8')).version",
      "const before = read()",
      "const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm'",
      "const out = execFileSync(npmBin, ['install', '-g', '--prefer-online', 'agent-comm-hub@latest'], { encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32' })",
      "const tail = out.trim().split(/\\r?\\n/).slice(-3).filter(Boolean).join(' | ')",
      "if (tail) console.log(tail)",
      "const after = read()",
      "if (after === before) console.log('already up to date (v' + after + ')')",
      "else console.log('updated: v' + before + ' -> v' + after)",
    ].join('\n')
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', windowsHide: true })
    messages.push(out.trim())
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
 * no admin; Linux systemd user unit; macOS launchd LaunchAgent). */
export function runService(options: ServiceOptions): { ok: boolean; messages: string[] } {
  const messages: string[] = []
  const port = options.port ?? 18764
  const host = options.host ?? '127.0.0.1'
  const path = options.path ?? '/mcp'
  const dryRun = options.dryRun === true
  const platform = options.platform ?? process.platform

  try {
    if (platform === 'win32') {
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

    if (platform === 'linux') {
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

    if (platform === 'darwin') {
      // macOS launchd LaunchAgent (user scope, no admin).
      const launchAgentsDir = join(homedir(), 'Library', 'LaunchAgents')
      const label = 'com.agent-comm-hub'
      const plist = join(launchAgentsDir, `${label}.plist`)
      const logFile = join(homedir(), 'Library', 'Logs', 'agent-comm-hub.log')
      const uid = typeof process.getuid === 'function' ? process.getuid() : 0
      const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeExe()}</string>
    <string>${cliPath()}</string>
    <string>--host</string><string>${host}</string>
    <string>--port</string><string>${port}</string>
    <string>--path</string><string>${path}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logFile}</string>
  <key>StandardErrorPath</key>
  <string>${logFile}</string>
</dict>
</plist>
`
      if (options.action === 'install') {
        if (dryRun) {
          messages.push(`[dry-run] write ${plist}`)
          messages.push(`[dry-run] launchctl bootstrap gui/${uid} ${plist}`)
        } else {
          mkdirSync(launchAgentsDir, { recursive: true })
          writeFileSync(plist, plistContent)
          try {
            execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plist], { encoding: 'utf8', windowsHide: true })
          } catch {
            // Older macOS: legacy load path.
            execFileSync('launchctl', ['load', '-w', plist], { encoding: 'utf8', windowsHide: true })
          }
          messages.push(`auto-start registered: launchd LaunchAgent ${plist}`)
          messages.push(`start it now with: launchctl bootstrap gui/${uid} ${plist}`)
        }
      } else {
        if (dryRun) {
          messages.push(`[dry-run] launchctl bootout gui/${uid}/${label}`)
          messages.push(`[dry-run] rm ${plist}`)
        } else {
          try {
            execFileSync('launchctl', ['bootout', `gui/${uid}/${label}`], { encoding: 'utf8', windowsHide: true })
          } catch {
            try { execFileSync('launchctl', ['unload', '-w', plist], { encoding: 'utf8', windowsHide: true }) } catch { /* not loaded */ }
          }
          rmSync(plist, { force: true })
          messages.push('auto-start removed (launchd LaunchAgent)')
        }
      }
      return { ok: true, messages }
    }

    return { ok: false, messages: [`auto-start is not implemented for ${platform} — use pm2 or your platform's supervisor`] }
  } catch (error) {
    return { ok: false, messages: [`${(error as Error).message}`] }
  }
}
