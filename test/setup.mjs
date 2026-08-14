/**
 * Tests for `agent-comm-hub setup`: incremental merge into fake agent configs
 * (mcode, opencode, kimi, gemini, codex) + skill sync including the standard
 * ~/.agents/skills location. Verifies: only the agent-hub key is touched,
 * original content preserved, backups created, idempotency, and -remove.
 */

import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSetup } from './setup-entry.mjs'

let failures = 0
let checks = 0
function check(name, ok, detail = '') {
  checks++
  if (ok) console.log(`  ok    ${name}`)
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

const home = mkdtempSync(join(tmpdir(), 'hub-setup-test-'))
const skillSrc = join(home, 'SKILL.md')
writeFileSync(skillSrc, '---\nname: agent-comm-hub\n---\ntest skill\n')

// --- fake agent configs with unrelated content ---
mkdirSync(join(home, '.minimax', 'mcp'), { recursive: true })
writeFileSync(join(home, '.minimax', 'mcp.json'), JSON.stringify({ mcpServers: { 'dsh-bridge': { url: 'http://127.0.0.1:18763/mcp' } } }, null, 2))
writeFileSync(join(home, '.minimax', 'mcp', 'mcp.json'), JSON.stringify({ mcpServers: {} }, null, 2))
mkdirSync(join(home, '.config', 'opencode'), { recursive: true })
writeFileSync(join(home, '.config', 'opencode', 'opencode.json'), JSON.stringify({ mcp: { context7: { type: 'local' } }, other: 'keep-me' }, null, 2))
mkdirSync(join(home, '.kimi-code'), { recursive: true })
writeFileSync(join(home, '.kimi-code', 'mcp.json'), JSON.stringify({ mcpServers: { exa: { url: 'https://mcp.exa.ai/mcp' } } }, null, 2))
mkdirSync(join(home, '.gemini'), { recursive: true })
writeFileSync(join(home, '.gemini', 'settings.json'), JSON.stringify({ general: { key: 1 } }, null, 2)) // no mcpServers yet
mkdirSync(join(home, '.codex'), { recursive: true })
writeFileSync(join(home, '.codex', 'config.toml'), 'model = "x"\n')
mkdirSync(join(home, '.zcode', 'cli'), { recursive: true })
writeFileSync(join(home, '.zcode', 'cli', 'config.json'), JSON.stringify({ mcp: { servers: { context7: { enabled: true, type: 'remote', url: 'https://mcp.exa.ai/mcp' } } }, plugins: { enabledPlugins: { guardrails: true } } }, null, 2))

const quiet = { log: () => {} }

const countBaks = () => ['mcp.json', 'opencode.json', 'settings.json', 'config.toml', 'config.json'].reduce((n, name) => {
  const dirs = [join(home, '.minimax'), join(home, '.minimax', 'mcp'), join(home, '.config', 'opencode'), join(home, '.gemini'), join(home, '.codex'), join(home, '.zcode', 'cli')]
  return n + dirs.filter(d => existsSync(d)).reduce((m, d) => m + readdirSync(d).filter(f => f.startsWith(name) && f.includes('.bak-')).length, 0)
}, 0)

const read = p => JSON.parse(readFileSync(p, 'utf8'))
const toml = p => readFileSync(p, 'utf8')

try {
  console.log('== setup: incremental install ==')
  const s1 = await runSetup({ homeDir: home, skillSrc, ...quiet })
  check('mcode runtime gets agent-hub', read(join(home, '.minimax', 'mcp.json')).mcpServers['agent-hub']?.url === 'http://127.0.0.1:18764/mcp')
  check('mcode desktop gets agent-hub', !!read(join(home, '.minimax', 'mcp', 'mcp.json')).mcpServers['agent-hub'])
  check('mcode dsh-bridge preserved', read(join(home, '.minimax', 'mcp.json')).mcpServers['dsh-bridge']?.url === 'http://127.0.0.1:18763/mcp')
  const oc = read(join(home, '.config', 'opencode', 'opencode.json'))
  check('opencode agent-hub added', oc.mcp['agent-hub']?.type === 'remote' && oc.mcp['agent-hub']?.url === 'http://127.0.0.1:18764/mcp')
  check('opencode context7 preserved', oc.mcp.context7?.type === 'local')
  check('opencode unrelated keys preserved', oc.other === 'keep-me')
  const kimi = read(join(home, '.kimi-code', 'mcp.json'))
  check('kimi agent-hub added', kimi.mcpServers['agent-hub']?.transport === 'http')
  check('kimi exa preserved', kimi.mcpServers.exa?.url === 'https://mcp.exa.ai/mcp')
  const gem = read(join(home, '.gemini', 'settings.json'))
  check('gemini section created + entry added', gem.mcpServers['agent-hub']?.type === 'http')
  check('gemini original keys preserved', gem.general?.key === 1)
  const cx = toml(join(home, '.codex', 'config.toml'))
  check('codex original line preserved', cx.startsWith('model = "x"'))
  check('codex section appended', cx.includes('[mcp_servers.agent-hub]') && cx.includes('url = "http://127.0.0.1:18764/mcp"'))
  const zc = read(join(home, '.zcode', 'cli', 'config.json'))
  check('zcode agent-hub added (nested mcp.servers)', zc.mcp.servers['agent-hub']?.type === 'remote' && zc.mcp.servers['agent-hub']?.url === 'http://127.0.0.1:18764/mcp')
  check('zcode context7 preserved', zc.mcp.servers.context7?.url === 'https://mcp.exa.ai/mcp')
  check('zcode unrelated keys preserved', zc.plugins?.enabledPlugins?.guardrails === true)
  check('cross-agent skill installed (~/.agents/skills)', existsSync(join(home, '.agents', 'skills', 'agent-hub', 'SKILL.md')))
  check('private skills installed', existsSync(join(home, '.minimax', 'skills', 'agent-hub', 'SKILL.md')) && existsSync(join(home, '.kimi-code', 'skills', 'agent-hub', 'SKILL.md')) && existsSync(join(home, '.zcode', 'skills', 'agent-hub', 'SKILL.md')))
  const baksAfterInstall = countBaks()
  check('backups created for changed files', baksAfterInstall >= 5, `got ${baksAfterInstall}`)

  console.log('== setup: idempotency ==')
  const s2 = await runSetup({ homeDir: home, skillSrc, ...quiet })
  check('re-run produces no new backups', countBaks() === baksAfterInstall, `now ${countBaks()}`)
  check('summary unchanged count > 0', s2.unchanged.length > 0, JSON.stringify(s2.unchanged.length))

  console.log('== setup: uninstall ==')
  await runSetup({ homeDir: home, skillSrc, remove: true, ...quiet })
  check('mcode entry removed, dsh-bridge kept', !('agent-hub' in read(join(home, '.minimax', 'mcp.json')).mcpServers) && !!read(join(home, '.minimax', 'mcp.json')).mcpServers['dsh-bridge'])
  check('opencode entry removed, other keys kept', !('agent-hub' in read(join(home, '.config', 'opencode', 'opencode.json')).mcp) && read(join(home, '.config', 'opencode', 'opencode.json')).other === 'keep-me')
  check('codex section removed, original kept', toml(join(home, '.codex', 'config.toml')).trim() === 'model = "x"')
  check('zcode entry removed, others kept', !('agent-hub' in read(join(home, '.zcode', 'cli', 'config.json')).mcp.servers) && !!read(join(home, '.zcode', 'cli', 'config.json')).mcp.servers.context7)
  check('skills dirs removed', !existsSync(join(home, '.agents', 'skills', 'agent-hub')) && !existsSync(join(home, '.minimax', 'skills', 'agent-hub')) && !existsSync(join(home, '.zcode', 'skills', 'agent-hub')))

  console.log(`\n${checks - failures}/${checks} checks passed`)
  if (failures > 0) process.exitCode = 1
} finally {
  rmSync(home, { recursive: true, force: true })
}
