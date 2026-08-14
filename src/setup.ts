/**
 * `agent-comm-hub setup` — one-shot incremental sync of the hub's MCP entry
 * and skill into every installed agent on this machine.
 *
 * Guarantees (same contract as agents/install-all.ps1):
 *  - only the named server key/section is touched; everything else is kept
 *  - every modified file is backed up first (`<file>.bak-<timestamp>`)
 *  - UTF-8 without BOM; idempotent (re-running with same url is a no-op)
 *  - missing agent configs are skipped, never created from scratch
 *
 * Covered: MiniMax Code, opencode, Kimi Code, Gemini CLI, Codex, zcode.
 * Skills go to the cross-agent `~/.agents/skills/` plus each agent's private
 * skills dir. Claude Code (project `.mcp.json`) and DSH (cordis.patch.yml)
 * stay manual — see agents/README.md.
 */

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface SetupOptions {
  /** Hub MCP endpoint URL. */
  url?: string
  /** Config key used in each agent's MCP config. */
  serverName?: string
  /** Uninstall instead of install. */
  remove?: boolean
  /** Fake home for tests; defaults to os.homedir(). */
  homeDir?: string
  /** SKILL.md source; defaults to the package's agents/SKILL.md. */
  skillSrc?: string
  log?: (message: string) => void
}

export interface SetupSummary {
  done: string[]
  unchanged: string[]
  skipped: string[]
  errors: string[]
}

const DEFAULT_URL = 'http://127.0.0.1:18764/mcp'
const DEFAULT_SERVER = 'agent-hub'

function defaultSkillSrc(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'agents', 'SKILL.md')
}

function stamp(): string {
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  if (!existsSync(file)) return null
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
  } catch (error) {
    throw new Error(`cannot parse JSON ${file}: ${(error as Error).message}`)
  }
}

async function writeJsonNoBom(file: string, doc: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(doc, null, 2) + '\n', 'utf8')
}

async function backup(file: string): Promise<string> {
  const bak = `${file}.bak-${stamp()}`
  await copyFile(file, bak)
  return bak
}

/** Resolve (creating when missing) a dotted section path like `mcp.servers`. */
function resolveSection(doc: Record<string, unknown>, section: string): Record<string, unknown> {
  let node = doc
  for (const part of section.split('.')) {
    let next = node[part]
    if (next === undefined || typeof next !== 'object' || Array.isArray(next)) {
      next = {}
      node[part] = next
    }
    node = next as Record<string, unknown>
  }
  return node
}

/** Merge/remove one server key inside a JSON section; returns a status word. */
async function mergeJsonServer(
  file: string,
  section: string,
  entry: Record<string, unknown>,
  opts: { serverName: string; url: string; remove: boolean },
): Promise<'changed' | 'unchanged' | 'removed' | 'absent' | 'skipped'> {
  if (!existsSync(file)) return 'skipped'
  const doc = (await readJson(file)) as Record<string, unknown> | null
  if (doc === null) return 'skipped'
  const servers = resolveSection(doc, section)
  const has = Object.prototype.hasOwnProperty.call(servers, opts.serverName)
  if (opts.remove) {
    if (!has) return 'absent'
    delete servers[opts.serverName]
    await backup(file)
    await writeJsonNoBom(file, doc)
    return 'removed'
  }
  if (has) {
    const existing = servers[opts.serverName] as { url?: unknown } | undefined
    if (existing?.url === opts.url) return 'unchanged'
  }
  servers[opts.serverName] = entry
  await backup(file)
  await writeJsonNoBom(file, doc)
  return 'changed'
}

/** Append/remove a TOML section (Codex); incremental append only. */
async function mergeTomlSection(
  file: string,
  opts: { serverName: string; url: string; remove: boolean },
): Promise<'changed' | 'unchanged' | 'removed' | 'absent' | 'skipped'> {
  if (!existsSync(file)) return 'skipped'
  const text = await readFile(file, 'utf8')
  const marker = `[mcp_servers.${opts.serverName}]`
  const markerRe = new RegExp(`^\\[mcp_servers\\.${escapeRegExp(opts.serverName)}\\]`, 'm')
  if (opts.remove) {
    if (!markerRe.test(text)) return 'absent'
    const cleaned = text.replace(new RegExp(`^\\[mcp_servers\\.${escapeRegExp(opts.serverName)}\\][^\\r\\n]*(\\r?\\n(?!\\[).*)*(\\r?\\n)?`, 'm'), '')
    await backup(file)
    await writeFile(file, cleaned, 'utf8')
    return 'removed'
  }
  if (markerRe.test(text)) return 'unchanged'
  const block = `\n${marker}\ntype = "streamable-http"\nurl = "${opts.url}"\n`
  await backup(file)
  await writeFile(file, text.trimEnd() + block, 'utf8')
  return 'changed'
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Copy the skill into a directory (idempotent; overwrites on change). */
async function syncSkill(skillDir: string, skillSrc: string, remove: boolean, log: (m: string) => void): Promise<void> {
  if (remove) {
    if (existsSync(skillDir)) {
      await mkdir(dirname(skillDir), { recursive: true })
      await rmRecursive(skillDir)
      log(`  skill removed: ${skillDir}`)
    }
    return
  }
  if (!existsSync(skillSrc)) {
    log(`  SKILL.md source missing: ${skillSrc} (skipped)`)
    return
  }
  await mkdir(skillDir, { recursive: true })
  await copyFile(skillSrc, join(skillDir, 'SKILL.md'))
  log(`  skill -> ${join(skillDir, 'SKILL.md')}`)
}

async function rmRecursive(dir: string): Promise<void> {
  const { rm } = await import('node:fs/promises')
  await rm(dir, { recursive: true, force: true })
}

/** Run the incremental sync; returns a summary. */
export async function runSetup(options: SetupOptions = {}): Promise<SetupSummary> {
  const url = options.url ?? DEFAULT_URL
  const serverName = options.serverName ?? DEFAULT_SERVER
  const home = options.homeDir ?? homedir()
  const skillSrc = options.skillSrc ?? defaultSkillSrc()
  const remove = options.remove === true
  const log = options.log ?? ((message: string): void => console.log(message))
  const summary: SetupSummary = { done: [], unchanged: [], skipped: [], errors: [] }
  const record = (status: string | undefined, label: string, file: string): void => {
    if (status === 'changed' || status === 'removed') summary.done.push(`${label}: ${file}`)
    else if (status === 'unchanged' || status === 'absent') summary.unchanged.push(`${label}: ${file}`)
    else if (status === 'skipped') summary.skipped.push(`${label}: ${file}`)
  }

  const jsonTargets: Array<{ label: string; file: string; section: string; entry: Record<string, unknown> }> = [
    { label: 'mcode', file: join(home, '.minimax', 'mcp.json'), section: 'mcpServers', entry: { url, type: 'streamable-http', enabled: true, configured: true, timeout: 120000, description: 'agent-comm-hub: talk to every other agent connected to the hub.' } },
    { label: 'mcode', file: join(home, '.minimax', 'mcp', 'mcp.json'), section: 'mcpServers', entry: { url, type: 'streamable-http', enabled: true, configured: true, timeout: 120000, description: 'agent-comm-hub: talk to every other agent connected to the hub.' } },
    { label: 'opencode', file: join(home, '.config', 'opencode', 'opencode.json'), section: 'mcp', entry: { type: 'remote', url, enabled: true } },
    { label: 'kimi-code', file: join(home, '.kimi-code', 'mcp.json'), section: 'mcpServers', entry: { transport: 'http', url, startupTimeoutMs: 30000, toolTimeoutMs: 120000 } },
    { label: 'gemini-cli', file: join(home, '.gemini', 'settings.json'), section: 'mcpServers', entry: { type: 'http', url } },
    { label: 'zcode', file: join(home, '.zcode', 'cli', 'config.json'), section: 'mcp.servers', entry: { type: 'remote', url, enabled: true } },
  ]

  for (const target of jsonTargets) {
    try {
      const status = await mergeJsonServer(target.file, target.section, target.entry, { serverName, url, remove })
      record(status, target.label, target.file)
    } catch (error) {
      summary.errors.push(`${target.label}: ${target.file} — ${(error as Error).message}`)
      log(`  ${target.label}: SKIPPED — ${(error as Error).message}`)
    }
  }

  const codexFile = join(home, '.codex', 'config.toml')
  try {
    const status = await mergeTomlSection(codexFile, { serverName, url, remove })
    record(status, 'codex', codexFile)
  } catch (error) {
    summary.errors.push(`codex: ${codexFile} — ${(error as Error).message}`)
    log(`  codex: SKIPPED — ${(error as Error).message}`)
  }

  // Skills: cross-agent standard location + each agent's private dir.
  const skillDirs = [
    join(home, '.agents', 'skills', serverName),          // cross-agent standard
    join(home, '.minimax', 'skills', serverName),
    join(home, '.config', 'opencode', 'skills', serverName),
    join(home, '.kimi-code', 'skills', serverName),
    join(home, '.gemini', 'skills', serverName),
    join(home, '.codex', 'skills', serverName),
    join(home, '.zcode', 'skills', serverName),
    join(home, '.claude', 'skills', serverName),          // config is manual; skill still useful
  ]
  for (const dir of skillDirs) {
    try {
      await syncSkill(dir, skillSrc, remove, log)
    } catch (error) {
      summary.errors.push(`skill ${dir} — ${(error as Error).message}`)
      log(`  skill ${dir}: SKIPPED — ${(error as Error).message}`)
    }
  }

  if (remove) log('done. Manual targets (see agents/README.md): Claude Code (.mcp.json), DSH (cordis.patch.yml).')
  else log('done. Manual targets (see agents/README.md): Claude Code (.mcp.json), DSH (cordis.patch.yml). Restart agent sessions to pick up the MCP server.')
  return summary
}
