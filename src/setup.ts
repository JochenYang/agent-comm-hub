/**
 * `agent-comm-hub setup` — one-shot incremental sync of the hub's MCP entry
 * and skill into every installed agent on this machine.
 *
 * Which agents are supported is declared in `agents/registry.json` (the
 * single source of truth); this module discovers which of them are actually
 * installed (PATH / config paths / npm global) and merges the hub entry into
 * each one's config.
 *
 * Guarantees (same contract as agents/install-all.ps1):
 *  - only the named server key/section is touched; everything else is kept
 *  - every modified file is backed up first (`<file>.bak-<timestamp>`)
 *  - UTF-8 without BOM; idempotent (re-running with same url is a no-op)
 *  - missing agent configs are skipped, never created from scratch
 *
 * Skills go to the cross-agent `~/.agents/skills/` plus each discovered
 * agent's private skills dir. Claude Code's MCP config stays manual (project
 * `.mcp.json`) — see agents/README.md.
 */

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadRegistry, discover, expandConfigFile, expandHome, type RegistryEntry } from './discover.js'

export interface SetupOptions {
  /** Hub MCP endpoint URL. */
  url?: string
  /** Config key used in each agent's MCP config. */
  serverName?: string
  /** Uninstall instead of install. */
  remove?: boolean
  /** Only configure the given registry agent id (e.g. `--agent codex`). */
  agent?: string
  /** PATH contents for discovery (tests); defaults to process.env.PATH. */
  pathEnv?: string
  /** Skip npm-global discovery (tests / speed). */
  noNpm?: boolean
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

/** Marker comment of the DSH profile-patch block we insert (see below). */
const DSH_PATCH_MARKER = '# ── agent-comm-hub MCP client'

/** The block appended to a DSH profile `cordis.patch.yml` (top-level YAML
 * list of loader patch entries): an `insert` row that mounts the
 * `@deepseek-ai/dsh-mcp-client` plugin pointing at the hub endpoint. */
function dshPatchBlock(url: string, serverName: string): string {
  return `
${DSH_PATCH_MARKER} (installed by \`agent-comm-hub setup\`; undo with \`setup --remove\`) ─
- insert:
    - id: ${serverName}
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: ${serverName}
        transport: streamable-http
        url: ${url}
`
}

/**
 * Merge/remove the hub MCP-client block in one DSH profile patch file.
 * The patch is a YAML list; edits are line-scoped so unrelated entries are
 * never rewritten: the block (marker comment + its `- insert:` entry) is
 * appended at the end, replaced in place when the url changed, and removed
 * by its marker line. Backed up first, idempotent, missing files skipped.
 */
async function mergeDshPatch(
  file: string,
  opts: { serverName: string; url: string; remove: boolean },
): Promise<'changed' | 'unchanged' | 'removed' | 'absent' | 'skipped'> {
  if (!existsSync(file)) return 'skipped'
  const text = await readFile(file, 'utf8')

  // Locate the block by lines: the marker comment line, then the block spans
  // up to the next top-level entry (a line starting with `- ` — indented
  // `    - id:` lines inside the block never match). Leading blank lines are
  // absorbed so replacing/removing never leaves stray gaps.
  const lines = text.split('\n')
  const markerLine = lines.findIndex(line => line.includes(DSH_PATCH_MARKER))
  const hasBlock = markerLine >= 0
  const blockRange = (): { start: number; end: number } => {
    // The block owns the marker comment plus its `- insert:` entry (and the
    // entry's indented lines). Find the block's own top-level entry first,
    // then the NEXT top-level entry after it (or EOF).
    let entryStart = -1
    for (let i = markerLine + 1; i < lines.length; i++) {
      if (/^- /.test(lines[i])) {
        entryStart = i
        break
      }
    }
    let end = lines.length
    if (entryStart >= 0) {
      for (let i = entryStart + 1; i < lines.length; i++) {
        if (/^- /.test(lines[i])) {
          end = i
          break
        }
      }
    }
    let start = markerLine
    while (start > 0 && lines[start - 1].trim() === '') start--
    return { start, end }
  }
  const withoutBlock = (): string => {
    const { start, end } = blockRange()
    return lines.slice(0, start).concat(lines.slice(end)).join('\n')
  }

  if (opts.remove) {
    if (!hasBlock) return 'absent'
    const cleaned = withoutBlock()
    await backup(file)
    await writeFile(file, cleaned, 'utf8')
    return 'removed'
  }
  if (hasBlock) {
    if (lines.some(line => line.includes(`url: ${opts.url}`))) return 'unchanged'
    const replaced = withoutBlock()
    await backup(file)
    await writeFile(file, replaced.trimEnd() + dshPatchBlock(opts.url, opts.serverName), 'utf8')
    return 'changed'
  }
  await backup(file)
  await writeFile(file, text.trimEnd() + dshPatchBlock(opts.url, opts.serverName), 'utf8')
  return 'changed'
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

/** Substitute `{url}` / `{serverName}` placeholders in a registry entry. */
function substitute(entry: Record<string, unknown>, values: { url: string; serverName: string }): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(entry)) {
    if (typeof value === 'string') {
      out[key] = value.replaceAll('{url}', values.url).replaceAll('{serverName}', values.serverName)
    } else {
      out[key] = value
    }
  }
  return out
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

  // Registry-driven discovery: which registered agents are installed?
  const registry = loadRegistry()
  const found = discover(registry, { homeDir: home, pathEnv: options.pathEnv, noNpm: options.noNpm === true })
  const only = options.agent
  let targetAgents: RegistryEntry[] = []
  if (only !== undefined) {
    const match = registry.agents.find(agent => agent.id === only)
    if (match === undefined) {
      log(`agent '${only}' is not in the registry (see agents/registry.json)`)
    } else {
      // Explicit selection configures the agent even when discovery missed it.
      targetAgents = [match]
      log(`configure only: ${only}`)
    }
  } else {
    targetAgents = found.filter(agent => agent.present).map(agent => registry.agents.find(entry => entry.id === agent.id)!)
    const present = targetAgents.map(agent => agent.id)
    log(`discovered: ${present.length > 0 ? present.join(', ') : 'none'}`)
  }

  for (const agent of targetAgents) {
    for (const config of agent.configs) {
      for (const file of expandConfigFile(config.file, home)) {
        try {
          const status = config.strategy === 'json'
            ? await mergeJsonServer(file, config.section!, substitute(config.entry!, { url, serverName }), { serverName, url, remove })
            : config.strategy === 'toml'
              ? await mergeTomlSection(file, { serverName, url, remove })
              : await mergeDshPatch(file, { serverName, url, remove })
          record(status, agent.id, file)
        } catch (error) {
          summary.errors.push(`${agent.id}: ${file} — ${(error as Error).message}`)
          log(`  ${agent.id}: SKIPPED — ${(error as Error).message}`)
        }
      }
    }
  }

  // Skills: cross-agent standard location + each discovered agent's private dir.
  const skillDirs = [join(home, '.agents', 'skills', serverName)] // cross-agent standard
  for (const agent of targetAgents) {
    if (agent.skill !== null) skillDirs.push(join(expandHome(agent.skill, home), serverName))
  }
  for (const dir of skillDirs) {
    try {
      await syncSkill(dir, skillSrc, remove, log)
    } catch (error) {
      summary.errors.push(`skill ${dir} — ${(error as Error).message}`)
      log(`  skill ${dir}: SKIPPED — ${(error as Error).message}`)
    }
  }

  if (remove) log('done. Manual target (see agents/README.md): Claude Code (.mcp.json).')
  else log('done. Manual target (see agents/README.md): Claude Code (.mcp.json). Restart agent sessions (and the dsh profile) to pick up the MCP server.')
  return summary
}
