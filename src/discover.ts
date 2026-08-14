/**
 * Agent discovery + declarative registry.
 *
 * `agents/registry.json` is the single source of truth for which agents the
 * hub knows how to configure. This module loads and validates it, then
 * discovers which agents are actually installed on this machine using three
 * sources (any hit counts):
 *
 *   1. PATH probing — pure Node (parse `PATH` + `fs.accessSync`), no shell,
 *      no `which`/`where`; Windows honours `PATHEXT`.
 *   2. Registry config paths — does the (expanded) config file exist?
 *   3. npm global packages — `npm root -g` node_modules directory names
 *      (with common fallback directories when npm is unavailable).
 *
 * Everything is injectable (homeDir / pathEnv / pathext / platform /
 * npmRoot) so the test suite can exercise every platform's semantics on any
 * host. No runtime dependencies.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, accessSync, readFileSync, constants as fsConstants } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface RegistryEntry {
  id: string
  probe: string[]
  /** npm global package dir names (normalized, e.g. `cli` for
   * `@opencode-ai/cli`) matched against `npm root -g` node_modules. */
  npm?: string[]
  configs: Array<{
    file: string
    section: string | null
    strategy: 'json' | 'toml' | 'dsh'
    entry: Record<string, unknown> | null
  }>
  skill: string | null
  os: Array<'win32' | 'darwin' | 'linux'>
}

export interface Registry {
  agents: RegistryEntry[]
}

export interface DiscoverOptions {
  /** Fake home for tests; defaults to os.homedir(). */
  homeDir?: string
  /** PATH contents for tests; defaults to process.env.PATH. */
  pathEnv?: string
  /** PATHEXT contents (win32 only); defaults to the environment. */
  pathext?: string
  /** Platform semantics to emulate; defaults to process.platform. */
  platform?: NodeJS.Platform
  /** npm global root for tests; `null` disables npm probing. */
  npmRoot?: string | null
  /** Skip the npm probe entirely (fast path / tests). */
  noNpm?: boolean
}

export interface DiscoveredAgent {
  id: string
  /** Where the agent was found; 'none' when only registered but absent. */
  source: 'path' | 'config' | 'npm' | 'none'
  /** Expanded config file paths that exist (profiles wildcard expanded). */
  configFiles: string[]
  present: boolean
}

/** Path to this package's agents/registry.json. */
export function registryFile(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'agents', 'registry.json')
}

/** Replace a leading `~/` with the home directory. */
export function expandHome(file: string, home: string): string {
  return file.startsWith('~/') ? join(home, file.slice(2)) : file
}

/**
 * Expand a config file template: `~/` home substitution plus a single `*`
 * path segment — e.g. the DSH profiles pattern expands over every profile
 * directory (the glob marker is described in prose here so it can never
 * close this block comment). Returns the concrete paths, existing or not.
 */
export function expandConfigFile(file: string, home: string): string[] {
  const expanded = expandHome(file, home)
  const star = expanded.indexOf('*')
  if (star < 0) return [expanded]
  const prefix = expanded.slice(0, star)
  const suffix = expanded.slice(star + 1)
  const base = prefix.slice(0, prefix.lastIndexOf(sep))
  if (!existsSync(base)) return []
  return readdirSync(base, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => join(base, entry.name, suffix))
}

/** Validate the registry at runtime (mirrors docs/agent-registry.schema.json;
 * hand-rolled — no JSON-schema dependency). Throws on the first violation. */
export function validateRegistry(registry: Registry): void {
  if (!Array.isArray(registry.agents)) throw new Error('registry: missing "agents" array')
  const ids = new Set<string>()
  for (const agent of registry.agents) {
    if (typeof agent.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(agent.id)) {
      throw new Error(`registry: bad agent id ${JSON.stringify(agent.id)}`)
    }
    if (ids.has(agent.id)) throw new Error(`registry: duplicate agent id '${agent.id}'`)
    ids.add(agent.id)
    if (!Array.isArray(agent.probe)) throw new Error(`registry: ${agent.id}: probe must be an array`)
    if (agent.npm !== undefined && !Array.isArray(agent.npm)) throw new Error(`registry: ${agent.id}: npm must be an array`)
    if (!Array.isArray(agent.configs)) throw new Error(`registry: ${agent.id}: configs must be an array`)
    for (const config of agent.configs) {
      if (typeof config.file !== 'string' || !config.file.startsWith('~/')) {
        throw new Error(`registry: ${agent.id}: config file must be '~'-relative`)
      }
      if (config.file.split('/').includes('..')) {
        throw new Error(`registry: ${agent.id}: config file must not contain '..'`)
      }
      if (config.file.split('*').length > 2) {
        throw new Error(`registry: ${agent.id}: at most one '*' segment allowed`)
      }
      if (!['json', 'toml', 'dsh'].includes(config.strategy)) {
        throw new Error(`registry: ${agent.id}: unknown strategy '${config.strategy}'`)
      }
      if (config.strategy === 'json' && (typeof config.section !== 'string' || config.entry === null)) {
        throw new Error(`registry: ${agent.id}: json strategy needs a section and an entry`)
      }
      if (config.strategy !== 'json' && config.entry !== null) {
        throw new Error(`registry: ${agent.id}: only json strategy may carry an entry`)
      }
    }
    if (agent.skill !== null && (typeof agent.skill !== 'string' || !agent.skill.startsWith('~/'))) {
      throw new Error(`registry: ${agent.id}: skill must be '~'-relative or null`)
    }
    if (agent.os !== undefined && (!Array.isArray(agent.os) || agent.os.some(os => !['win32', 'darwin', 'linux'].includes(os)))) {
      throw new Error(`registry: ${agent.id}: invalid os list`)
    }
  }
}

/** Load + validate the bundled registry. */
export function loadRegistry(file = registryFile()): Registry {
  const registry = JSON.parse(readFileSync(file, 'utf8')) as Registry
  validateRegistry(registry)
  return registry
}

/** Does the command exist somewhere on PATH (pure Node)? */
function commandOnPath(command: string, pathEnv: string, pathext: string, platform: NodeJS.Platform): boolean {
  const dirs = pathEnv.split(platform === 'win32' ? ';' : ':')
  // win32 tries the bare name first, then PATHEXT extensions (cmd.exe order).
  const extensions = platform === 'win32'
    ? ['', ...(pathext || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
    : ['']
  for (const dir of dirs) {
    const base = dir === '' ? '.' : dir
    for (const ext of extensions) {
      const candidate = join(base, command + ext)
      try {
        accessSync(candidate, fsConstants.X_OK)
        return true
      } catch {
        /* try next */
      }
    }
  }
  return false
}

/** Flatten npm global node_modules dir names, recursing into `@scope` dirs
 * (e.g. `@opencode-ai/cli` contributes `cli`). */
function readNpmNames(root: string): string[] {
  const names: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('@')) {
      const scopeDir = join(root, entry.name)
      for (const sub of readdirSync(scopeDir, { withFileTypes: true })) {
        if (sub.isDirectory()) names.push(sub.name)
      }
    } else {
      names.push(entry.name)
    }
  }
  return names
}

/** npm global root via `npm root -g`, or null when npm is unavailable. */
function npmGlobalRoot(platform: NodeJS.Platform): string | null {
  try {
    const out = execFileSync(platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g'], { encoding: 'utf8', windowsHide: true }).trim()
    return out || null
  } catch {
    return null
  }
}

/** Common fallback npm global dirs per platform (used when npm is missing). */
function npmFallbackRoots(home: string, platform: NodeJS.Platform): string[] {
  if (platform === 'win32') {
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
    return [join(appData, 'npm', 'node_modules')]
  }
  return [
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules',
    ...(existsSync(join(home, '.nvm', 'versions', 'node'))
      ? readdirSync(join(home, '.nvm', 'versions', 'node')).map(dir => join(home, '.nvm', 'versions', 'node', dir, 'lib', 'node_modules'))
      : []),
  ]
}

/** Discover which registered agents are installed on this machine. */
export function discover(registry: Registry, options: DiscoverOptions = {}): DiscoveredAgent[] {  const home = options.homeDir ?? homedir()
  const platform = options.platform ?? process.platform
  const pathEnv = options.pathEnv ?? process.env.PATH ?? ''
  const pathext = options.pathext ?? process.env.PATHEXT ?? ''

  let npmNames: string[] | null = null
  if (!options.noNpm) {
    if (options.npmRoot !== undefined && options.npmRoot !== null) {
      npmNames = existsSync(options.npmRoot) ? readNpmNames(options.npmRoot) : []
    } else if (options.npmRoot !== null) {
      const root = npmGlobalRoot(platform)
      if (root && existsSync(root)) {
        npmNames = readNpmNames(root)
      } else {
        npmNames = []
        for (const fallback of npmFallbackRoots(home, platform)) {
          if (existsSync(fallback)) {
            npmNames = readNpmNames(fallback)
            break
          }
        }
      }
    }
  }

  return registry.agents
    .filter(agent => agent.os === undefined || agent.os.includes(platform as 'win32' | 'darwin' | 'linux'))
    .map(agent => {
      let source: DiscoveredAgent['source'] = 'none'
      const configFiles: string[] = []
      for (const config of agent.configs) {
        for (const file of expandConfigFile(config.file, home)) {
          if (existsSync(file)) {
            configFiles.push(file)
            if (source === 'none') source = 'config'
          }
        }
      }
      if (source === 'none' && agent.probe.some(command => commandOnPath(command, pathEnv, pathext, platform))) {
        source = 'path'
      }
      if (source === 'none' && npmNames !== null &&
          (agent.probe.some(command => npmNames!.includes(command)) ||
           (agent.npm ?? []).some(name => npmNames!.includes(name)))) {
        source = 'npm'
      }
      return { id: agent.id, source, configFiles, present: source !== 'none' }
    })
}

/** CLI: print the discovery table (discovery only — no config changes). */
export function runDiscover(options: DiscoverOptions & { log?: (message: string) => void } = {}): DiscoveredAgent[] {
  const log = options.log ?? ((message: string): void => console.log(message))
  const found = discover(loadRegistry(), options)
  log('discovered agents:')
  for (const agent of found) {
    const status = agent.present ? agent.source : 'not installed'
    const files = agent.configFiles.length > 0 ? ` — ${agent.configFiles.join(', ')}` : ''
    log(`  ${agent.id.padEnd(16)} ${status}${files}`)
  }
  return found
}
