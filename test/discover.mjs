/**
 * Tests for the discovery engine + agent registry:
 *  - registry load/validation (bad records rejected)
 *  - ~ expansion and profiles-wildcard expansion
 *  - PATH probing (win32 PATHEXT semantics, POSIX separator semantics)
 *  - config-path discovery
 *  - npm-global discovery (fake npm root, scoped dirs normalized)
 *  - os filtering (claude-desktop is darwin-only)
 *  - config-only detection (a config file without an installed agent)
 *  - source priority: path > npm > probe-path > config
 */

import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRegistry, validateRegistry, discover, expandHome, expandConfigFile, configsForPlatform, CREDENTIAL_FILES } from './discover-entry.mjs'

let failures = 0
let checks = 0
function check(name, ok, detail = '') {
  checks++
  if (ok) console.log(`  ok    ${name}`)
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

const home = mkdtempSync(join(tmpdir(), 'hub-discover-test-'))
const bin = join(home, 'fake-bin')
mkdirSync(bin, { recursive: true })

try {
  console.log('== registry: load + validate ==')
  const registry = loadRegistry()
  check('bundled registry loads and validates', Array.isArray(registry.agents) && registry.agents.length >= 10)
  // claude-desktop used to be darwin-only with a single macOS path. It now covers
  // Windows too, which is why `configs[]` gained a per-file `os`: the two platforms
  // use different FILES, and a record-level `os` cannot express that.
  check(
    'registry has claude-desktop on darwin and win32 with one file each',
    registry.agents.some(a =>
      a.id === 'claude-desktop' && a.os?.includes('darwin') && a.os.includes('win32') && a.configs.length === 2
      && a.configs.every(c => Array.isArray(c.os) && c.os.length === 1)),
  )
  check('registry has qwen-code (httpUrl entry)', registry.agents.some(a => a.id === 'qwen-code' && a.configs[0]?.entry?.httpUrl === '{url}'))
  // pi has no MCP config of its own; it reads the cross-agent skill location.
  // The old assertion said `skill === null` while its own name said otherwise.
  check(
    'registry has pi (config-less, skill at the cross-agent location)',
    registry.agents.some(a => a.id === 'pi' && a.configs.length === 0 && a.skill === '~/.agents/skills'),
  )
  check(
    'registry gives qwen-code a skill directory',
    registry.agents.some(a => a.id === 'qwen-code' && a.skill === '~/.qwen/skills'),
  )
  check('registry has cursor (url entry)', registry.agents.some(a => a.id === 'cursor' && a.configs[0]?.entry?.url === '{url}'))
  // qoder was probe-only; its config location is now confirmed. codebuddy still is.
  check(
    'registry has qoder (configurable) + codebuddy (probe-only)',
    registry.agents.some(a => a.id === 'qoder' && a.configs.length > 0)
      && registry.agents.some(a => a.id === 'codebuddy' && a.configs.length === 0),
  )

  console.log('== registry: validation rejects bad records ==')
  const bad = {
    agents: [
      { id: 'ok-agent', probe: [], configs: [], skill: null },
      { id: 'BAD ID', probe: [], configs: [], skill: null },
    ],
  }
  let threw = false
  try { validateRegistry(bad) } catch { threw = true }
  check('bad id rejected', threw)
  threw = false
  try { validateRegistry({ agents: [{ id: 'a', probe: [], configs: [{ file: '../escape', strategy: 'json', section: 'x', entry: {} }], skill: null }] }) } catch { threw = true }
  check('path traversal rejected', threw)
  // Credential files are refused at load, not merely documented (AGENTS.md
  // invariant 6). A registry that pointed at one would have to round-trip the
  // whole file, rewriting the credential blob.
  for (const file of CREDENTIAL_FILES) {
    threw = false
    try {
      validateRegistry({ agents: [{ id: 'a', probe: [], configs: [{ file, strategy: 'json', section: 'mcpServers', entry: {} }], skill: null }] })
    } catch { threw = true }
    check(`credential file refused: ${file}`, threw)
  }
  // And the SHIPPED registry must not contain one either — the check above only
  // proves the validator works.
  const shippedFiles = registry.agents.flatMap(a => a.configs.map(c => c.file))
  check(
    'no shipped registry entry points at a credential file',
    shippedFiles.every(f => !CREDENTIAL_FILES.includes(f)),
    JSON.stringify(shippedFiles.filter(f => CREDENTIAL_FILES.includes(f))),
  )
  threw = false
  try { validateRegistry({ agents: [{ id: 'a', probe: [], configs: [{ file: '~/x.json', strategy: 'json', section: null, entry: null }], skill: null }] }) } catch { threw = true }
  check('json strategy without section/entry rejected', threw)
  threw = false
  try { validateRegistry({ agents: [{ id: 'a', probe: [], configs: [{ file: '~/x.toml', strategy: 'bogus', entry: null }], skill: null }] }) } catch { threw = true }
  check('unknown strategy rejected', threw)

  console.log('== path helpers ==')
  check('expandHome substitutes ~', expandHome('~/.minimax/mcp.json', home) === join(home, '.minimax', 'mcp.json'))
  const profiles = join(home, '.dsh', 'profiles')
  mkdirSync(join(profiles, 'web'), { recursive: true })
  mkdirSync(join(profiles, 'cli'), { recursive: true })
  writeFileSync(join(profiles, 'web', 'cordis.patch.yml'), '[]\n')
  const expanded = expandConfigFile('~/.dsh/profiles/*/cordis.patch.yml', home)
  check('profiles wildcard expands to profile dirs', expanded.length === 2 && expanded.every(f => f.endsWith('cordis.patch.yml')), JSON.stringify(expanded))
  check('non-wildcard path expands once', expandConfigFile('~/.minimax/mcp.json', home).length === 1)

  console.log('== PATH probing ==')
  // Fake executables need the x bit: Windows accessSync(X_OK) only checks
  // existence, but POSIX really checks the mode — writeFileSync defaults to
  // 0644, which would fail the probe on linux/macos CI.
  const makeExec = file => chmodSync(file, 0o755)
  writeFileSync(join(bin, 'opencode'), '#!/bin/sh\n')
  makeExec(join(bin, 'opencode'))
  writeFileSync(join(bin, 'codex'), '#!/bin/sh\n')
  makeExec(join(bin, 'codex'))
  const pathEnv = join(home, 'fake-bin') // win32 semantics: ';' separator, drive-colons harmless
  // POSIX semantics are exercised from inside `home` with a RELATIVE PATH:
  // on Windows a drive-letter path would be split at the ':' separator, which
  // is exactly what a real POSIX PATH never contains.
  const origCwd = process.cwd()
  process.chdir(home)
  const posix = discover(registry, { homeDir: home, pathEnv: 'fake-bin', platform: 'linux', noNpm: true })
  const oc = posix.find(a => a.id === 'opencode')
  check('posix PATH probe finds opencode', oc?.present === true && oc.source === 'path')
  check('posix PATH probe misses kimi-code', !posix.find(a => a.id === 'kimi-code')?.present)
  process.chdir(origCwd)
  const win = discover(registry, { homeDir: home, pathEnv, platform: 'win32', noNpm: true })
  check('win32 PATH probe also finds opencode (plain name)', win.find(a => a.id === 'opencode')?.present === true)
  // PATHEXT: a .CMD-only command resolves on win32 but not on posix.
  writeFileSync(join(bin, 'kimi.CMD'), '@echo off\r\n')
  makeExec(join(bin, 'kimi.CMD'))
  const winExt = discover(registry, { homeDir: home, pathEnv, pathext: '.CMD', platform: 'win32', noNpm: true })
  check('win32 PATHEXT resolves kimi.CMD', winExt.find(a => a.id === 'kimi-code')?.present === true)
  process.chdir(home)
  const posixExt = discover(registry, { homeDir: home, pathEnv: 'fake-bin', platform: 'linux', noNpm: true })
  process.chdir(origCwd)
  check('posix does not resolve kimi.CMD', !posixExt.find(a => a.id === 'kimi-code')?.present)

  console.log('== config-path discovery ==')
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true })
  writeFileSync(join(home, '.config', 'opencode', 'opencode.json'), '{}')
  const cfg = discover(registry, { homeDir: home, pathEnv: '/nonexistent', platform: 'linux', noNpm: true })
  const ocCfg = cfg.find(a => a.id === 'opencode')
  // The config lives inside `~/.config/opencode`, which is also opencode's
  // probePath — so this now reports the stronger signal (`probe-path`), not
  // `config`: a config file alone is not evidence of an installation.
  check('config presence discovered with configFiles', ocCfg?.present === true && ocCfg.source === 'probe-path' && ocCfg.configFiles.length === 1, JSON.stringify(ocCfg))

  console.log('== config-only: a config file is not an installation ==')
  const cfgHome = mkdtempSync(join(tmpdir(), 'hub-discover-configonly-'))
  mkdirSync(join(cfgHome, 'shared'), { recursive: true })
  writeFileSync(join(cfgHome, 'shared', 'leftover.json'), '{}')
  // The bundled registry's configs all live INSIDE their probePath, so the
  // distinction can only be exercised with an entry whose config is elsewhere
  // (a shared dotfile, an app-data path).
  const synthetic = {
    agents: [{
      id: 'ghost',
      probe: ['ghost'],
      probePaths: ['~/.ghost-install'],
      configs: [{ file: '~/shared/leftover.json', section: 'mcpServers', strategy: 'json', entry: { url: 'http://x/mcp' } }],
      skill: null,
      os: ['win32', 'darwin', 'linux'],
    }],
  }
  const ghost = discover(synthetic, { homeDir: cfgHome, pathEnv: '/nonexistent', platform: 'linux', noNpm: true })[0]
  check('a config file alone does NOT make the agent installed', ghost.present === false && ghost.source === 'config' && ghost.configOnly === true, JSON.stringify(ghost))
  check('the leftover config file is still reported', ghost.configFiles.length === 1, JSON.stringify(ghost.configFiles))
  mkdirSync(join(cfgHome, '.ghost-install'), { recursive: true })
  const ghost2 = discover(synthetic, { homeDir: cfgHome, pathEnv: '/nonexistent', platform: 'linux', noNpm: true })[0]
  check('a probePath hit makes the same entry installed', ghost2.present === true && ghost2.source === 'probe-path' && ghost2.configOnly === false, JSON.stringify(ghost2))
  rmSync(cfgHome, { recursive: true, force: true })

  console.log('== npm-global discovery ==')
  // Separate home: the config-path section above already created opencode's
  // config, which would shadow the npm source for that agent.
  const homeNpm = mkdtempSync(join(tmpdir(), 'hub-discover-npm-'))
  try {
    const npmRoot = join(homeNpm, 'npm-global')
    mkdirSync(join(npmRoot, '@opencode-ai', 'cli'), { recursive: true })
    mkdirSync(join(npmRoot, '@anthropic-ai', 'claude-code'), { recursive: true })
    const npm = discover(registry, { homeDir: homeNpm, pathEnv: '/nonexistent', platform: 'linux', npmRoot })
    check('scoped npm dir @opencode-ai/cli -> opencode', npm.find(a => a.id === 'opencode')?.present === true && npm.find(a => a.id === 'opencode')?.source === 'npm')
    check('scoped npm dir @anthropic-ai/claude-code -> claude', npm.find(a => a.id === 'claude')?.present === true)
  } finally {
    rmSync(homeNpm, { recursive: true, force: true })
  }

  console.log('== os filtering ==')
  const winOs = discover(registry, { homeDir: home, pathEnv, platform: 'win32', noNpm: true })
  // claude-desktop used to be darwin-only, so it was hidden on win32. It is not
  // hidden any more — but the platform filter still has to do its job: only the
  // win32 FILE may be considered on Windows, and only the macOS one on darwin.
  const desktopWin = winOs.find(a => a.id === 'claude-desktop')
  // Assert on the REGISTRY entry: a DiscoveredAgent only lists config files that
  // actually exist, and the fake home has neither of claude-desktop's.
  const desktopEntry = registry.agents.find(a => a.id === 'claude-desktop')
  check(
    'claude-desktop is visible on win32 and only its Windows file applies',
    desktopWin !== undefined
      && configsForPlatform(desktopEntry, 'win32').length === 1
      && configsForPlatform(desktopEntry, 'win32')[0].file.includes('AppData/Roaming/Claude')
      && configsForPlatform(desktopEntry, 'darwin')[0].file.includes('Library/Application Support/Claude'),
    JSON.stringify(configsForPlatform(desktopEntry, 'win32').map(c => c.file)),
  )
  const macOs = discover(registry, { homeDir: home, pathEnv: '/nonexistent', platform: 'darwin', noNpm: true })
  check('claude-desktop listed on darwin', macOs.some(a => a.id === 'claude-desktop' && !a.present))

  console.log(`\n${checks - failures}/${checks} checks passed`)
  if (failures > 0) process.exitCode = 1
} finally {
  rmSync(home, { recursive: true, force: true })
}
