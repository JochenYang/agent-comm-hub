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
// fake DSH profile patch with unrelated content
mkdirSync(join(home, '.dsh', 'profiles', 'web'), { recursive: true })
writeFileSync(join(home, '.dsh', 'profiles', 'web', 'cordis.patch.yml'), '# web profile patch\n- id: web\n  config:\n    searchProvider: searxng\n')

const quiet = { log: () => {} }

const backupNames = () => new Set([join(home, '.minimax'), join(home, '.minimax', 'mcp'), join(home, '.config', 'opencode'), join(home, '.gemini'), join(home, '.codex'), join(home, '.zcode', 'cli')].flatMap(d => existsSync(d) ? readdirSync(d).filter(f => f.includes('.bak-')).map(f => `${d}/${f}`) : []))
const countBaks = () => ['mcp.json', 'opencode.json', 'settings.json', 'config.toml', 'config.json'].reduce((n, name) => {
  const dirs = [join(home, '.minimax'), join(home, '.minimax', 'mcp'), join(home, '.config', 'opencode'), join(home, '.gemini'), join(home, '.codex'), join(home, '.zcode', 'cli')]
  return n + dirs.filter(d => existsSync(d)).reduce((m, d) => m + readdirSync(d).filter(f => f.startsWith(name) && f.includes('.bak-')).length, 0)
}, 0)

const read = p => JSON.parse(readFileSync(p, 'utf8'))
const toml = p => readFileSync(p, 'utf8')
/** Every regular file under `dir`, as paths relative to it. */
function walkFiles(dir) {
  const out = []
  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else out.push(full.slice(dir.length + 1))
    }
  }
  walk(dir)
  return out
}

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
  // Kimi Code does not accept `transport: "http"` — its only documented value is
  // "sse", and HTTP is the default when a `url` is present without `transport`.
  // The old assertion pinned the invalid value, so it was asserting the bug.
  check(
    'kimi agent-hub added as an HTTP url with no transport field',
    kimi.mcpServers['agent-hub']?.url === 'http://127.0.0.1:18764/mcp' && !('transport' in (kimi.mcpServers['agent-hub'] ?? {})),
    JSON.stringify(kimi.mcpServers['agent-hub'])
  )
  check('kimi exa preserved', kimi.mcpServers.exa?.url === 'https://mcp.exa.ai/mcp')
  const gem = read(join(home, '.gemini', 'settings.json'))
  // Gemini CLI's remote field is `httpUrl`, not `type` + `url`.
  check(
    'gemini section created + entry added with httpUrl',
    gem.mcpServers['agent-hub']?.httpUrl === 'http://127.0.0.1:18764/mcp' && !('type' in (gem.mcpServers['agent-hub'] ?? {})),
    JSON.stringify(gem.mcpServers['agent-hub'])
  )
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
  check('dsh skill installed', existsSync(join(home, '.dsh', 'skills', 'agent-hub', 'SKILL.md')))
  const dshPatch = p => readFileSync(join(home, '.dsh', 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
  const dshPatchBefore = dshPatch()
  check(
    'dsh profile patch gets the hub MCP-client insert',
    dshPatchBefore.includes('- insert:') && dshPatchBefore.includes("name: '@deepseek-ai/dsh-mcp-client'") && dshPatchBefore.includes('serverName: agent-comm-hub') && dshPatchBefore.includes('url: http://127.0.0.1:18764/mcp'),
    dshPatchBefore,
  )
  check('dsh patch unrelated entries preserved', dshPatchBefore.includes('searchProvider: searxng'))
  const baksAfterInstall = countBaks()
  check('backups created for changed files', baksAfterInstall >= 5, `got ${baksAfterInstall}`)
  // Snapshot the backup NAMES, not just the count. Backup filenames carry a
  // second-resolution timestamp, so a file rewritten twice inside one second
  // OVERWRITES its own backup and the count stays put — which is exactly how a
  // non-idempotent merge hid here (Gemini's `httpUrl` entry was rewritten on every
  // run). Comparing the name set catches a rewrite the count cannot see.
  const baksBefore = backupNames()

  console.log('== setup: idempotency ==')
  const s2 = await runSetup({ homeDir: home, skillSrc, ...quiet })
  // The DECISIVE check: a re-run must report that it changed NOTHING. Backup
  // names cannot prove this — they carry a second-resolution timestamp, so a file
  // rewritten twice inside one second overwrites its own backup and every
  // backup-based count stays put. That is exactly how a non-idempotent merge hid
  // here: Gemini's entry uses `httpUrl`, the merge only compared `url`, so the
  // config was rewritten on every run while the backup count looked stable.
  check('re-run changes no files', s2.done.length === 0, `changed: ${JSON.stringify(s2.done)}`)
  check('re-run produces no new backups',
    [...backupNames()].every(name => baksBefore.has(name)) && backupNames().size === baksBefore.size,
    `new: ${JSON.stringify([...backupNames()].filter(name => !baksBefore.has(name)))}`)
  check('dsh patch unchanged on re-run', dshPatch() === dshPatchBefore)
  check('summary unchanged count > 0', s2.unchanged.length > 0, JSON.stringify(s2.unchanged.length))

  // A CHANGED url must actually land. The TOML merge used to match only the
  // section header, so a moved endpoint stayed stale in the user's Codex config
  // while `setup` reported "unchanged" — the mirror image of the JSON bug above.
  const codexBefore = readFileSync(join(home, '.codex', 'config.toml'), 'utf8')
  await runSetup({ homeDir: home, skillSrc, url: 'http://10.0.0.5:18764/mcp', force: true, ...quiet })
  const codexAfter = readFileSync(join(home, '.codex', 'config.toml'), 'utf8')
  check('a changed url is written into the codex TOML config',
    codexAfter.includes('url = "http://10.0.0.5:18764/mcp"') && !codexAfter.includes('127.0.0.1:18764'),
    JSON.stringify(codexAfter))
  check('the codex TOML keeps exactly one hub section',
    (codexAfter.match(/\[mcp_servers\.agent-hub\]/g) ?? []).length === 1, JSON.stringify(codexAfter))
  check('the codex original content survived the url change',
    codexAfter.includes('model = "x"') && codexBefore.includes('model = "x"'), JSON.stringify(codexAfter))

  console.log('== setup: uninstall ==')
  await runSetup({ homeDir: home, skillSrc, remove: true, ...quiet })
  check('mcode entry removed, dsh-bridge kept', !('agent-hub' in read(join(home, '.minimax', 'mcp.json')).mcpServers) && !!read(join(home, '.minimax', 'mcp.json')).mcpServers['dsh-bridge'])
  check('opencode entry removed, other keys kept', !('agent-hub' in read(join(home, '.config', 'opencode', 'opencode.json')).mcp) && read(join(home, '.config', 'opencode', 'opencode.json')).other === 'keep-me')
  check('codex section removed, original kept', toml(join(home, '.codex', 'config.toml')).trim() === 'model = "x"')
  check('zcode entry removed, others kept', !('agent-hub' in read(join(home, '.zcode', 'cli', 'config.json')).mcp.servers) && !!read(join(home, '.zcode', 'cli', 'config.json')).mcp.servers.context7)
  const dshPatchAfter = readFileSync(join(home, '.dsh', 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
  check('dsh insert block removed, unrelated entries kept', !dshPatchAfter.includes('dsh-mcp-client') && dshPatchAfter.includes('searchProvider: searxng'), dshPatchAfter)
  check('skills dirs removed', !existsSync(join(home, '.agents', 'skills', 'agent-hub')) && !existsSync(join(home, '.minimax', 'skills', 'agent-hub')) && !existsSync(join(home, '.zcode', 'skills', 'agent-hub')) && !existsSync(join(home, '.dsh', 'skills', 'agent-hub')))

  console.log('== setup: dsh url change + block directly after another entry ==')
  const patchPath = join(home, '.dsh', 'profiles', 'web', 'cordis.patch.yml')
  // Recreate a tight block: the hub block directly after another entry with
  // no blank line in between (the shape a previous bug corrupted).
  writeFileSync(patchPath, `- id: other
  config:
    key: 1
# ── agent-comm-hub MCP client (installed by \`agent-comm-hub setup\`; undo with \`setup --remove\`) ─
- insert:
    - id: agent-hub
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: agent-hub
        transport: streamable-http
        url: http://127.0.0.1:18764/mcp
`)
  await runSetup({ homeDir: home, skillSrc, url: 'http://127.0.0.1:18999/mcp', ...quiet })
  const afterUrlChange = readFileSync(patchPath, 'utf8')
  check(
    'url change replaces the block in place, keeps neighbors',
    afterUrlChange.includes('url: http://127.0.0.1:18999/mcp') && afterUrlChange.includes('key: 1') && !afterUrlChange.includes('url: http://127.0.0.1:18764/mcp') && !afterUrlChange.includes('key: 1- insert:'),
    afterUrlChange,
  )
  await runSetup({ homeDir: home, skillSrc, remove: true, ...quiet })
  const afterTightRemove = readFileSync(patchPath, 'utf8')
  check('remove on tight block keeps the preceding entry intact', afterTightRemove.includes('key: 1') && !afterTightRemove.includes('dsh-mcp-client'), afterTightRemove)

  console.log('== setup: dsh duplicate healing (marker lost / history double-insert) ==')
  // A file holding TWO hub entries — one with the marker (old url), one the
  // user's editor stripped the marker from (current url) — plus an unrelated
  // entry. Older setup treated the markerless one as "not configured" and
  // appended a third; DSH then loaded the plugin twice (crash loop).
  const duplicated = `- id: web
  config:
    searchProvider: searxng
# ── agent-comm-hub MCP client (installed by \`agent-comm-hub setup\`; undo with \`setup --remove\`) ─
- insert:
    - id: agent-hub
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: agent-hub
        transport: streamable-http
        url: http://127.0.0.1:18764/mcp
- insert:
    - id: agent-hub
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: agent-hub
        transport: streamable-http
        url: http://127.0.0.1:18999/mcp
`
  writeFileSync(patchPath, duplicated)
  await runSetup({ homeDir: home, skillSrc, url: 'http://127.0.0.1:18999/mcp', ...quiet })
  const healed = readFileSync(patchPath, 'utf8')
  check(
    'duplicate hub entries collapse to one with the current url',
    healed.split('dsh-mcp-client').length === 2 && healed.includes('url: http://127.0.0.1:18999/mcp') && !healed.includes('url: http://127.0.0.1:18764/mcp') && healed.includes('searchProvider: searxng'),
    healed,
  )
  await runSetup({ homeDir: home, skillSrc, url: 'http://127.0.0.1:18999/mcp', ...quiet })
  check('re-run after healing leaves the file byte-identical', readFileSync(patchPath, 'utf8') === healed, readFileSync(patchPath, 'utf8'))

  // Markerless entry + same url + current serverName must be recognized as
  // configured (no second insert, no rewrite).
  const markerless = `- id: web
  config:
    searchProvider: searxng
- insert:
    - id: agent-comm-hub
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: agent-comm-hub
        transport: streamable-http
        url: http://127.0.0.1:18999/mcp
`
  writeFileSync(patchPath, markerless)
  const beforeMarkerless = markerless
  await runSetup({ homeDir: home, skillSrc, url: 'http://127.0.0.1:18999/mcp', ...quiet })
  const afterMarkerless = readFileSync(patchPath, 'utf8')
  check(
    'markerless hub entry with same url is left alone (no duplicate)',
    afterMarkerless.split('dsh-mcp-client').length === 2 && afterMarkerless === beforeMarkerless,
    afterMarkerless,
  )
  await runSetup({ homeDir: home, skillSrc, remove: true, ...quiet })
  const markerlessRemoved = readFileSync(patchPath, 'utf8')
  check('remove also strips a markerless hub entry', !markerlessRemoved.includes('dsh-mcp-client') && markerlessRemoved.includes('searchProvider: searxng'), markerlessRemoved)

  console.log('== setup: dsh migrates off colliding serverName agent-hub ==')
  // A profile that still holds the OLD static insert (serverName: agent-hub)
  // collides with a dynamic MCP-manager mount of the same name. Re-run must
  // rewrite our block to the distinct `agent-comm-hub` key.
  writeFileSync(patchPath, `- id: web
  config:
    searchProvider: searxng
# ── agent-comm-hub MCP client (installed by \`agent-comm-hub setup\`; undo with \`setup --remove\`) ─
- insert:
    - id: agent-hub
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: agent-hub
        transport: streamable-http
        url: http://127.0.0.1:18764/mcp
`)
  await runSetup({ homeDir: home, skillSrc, ...quiet })
  const migrated = dshPatch()
  check(
    'old serverName agent-hub rewritten to agent-comm-hub',
    migrated.includes('serverName: agent-comm-hub') && !migrated.includes('serverName: agent-hub') && migrated.split('dsh-mcp-client').length === 2 && migrated.includes('searchProvider: searxng'),
    migrated,
  )
  // --- W21: nothing installed means nothing created ---
  console.log('== setup: empty machine creates nothing ==')
  const emptyHome = mkdtempSync(join(tmpdir(), 'hub-setup-empty-'))
  const emptySkill = join(emptyHome, 'SKILL.md')
  writeFileSync(emptySkill, '---\nname: agent-comm-hub\n---\n')
  const beforeFiles = walkFiles(emptyHome)
  const emptySummary = await runSetup({ homeDir: emptyHome, skillSrc: emptySkill, pathEnv: '', noNpm: true, ...quiet })
  const afterFiles = walkFiles(emptyHome)
  check(
    'an empty home with an empty PATH creates no files at all',
    afterFiles.length === beforeFiles.length && emptySummary.done.length === 0,
    JSON.stringify({ added: afterFiles.filter(f => !beforeFiles.includes(f)), done: emptySummary.done }),
  )
  check('and the cross-agent skill dir was not created either', !existsSync(join(emptyHome, '.agents')), '~/.agents exists')
  rmSync(emptyHome, { recursive: true, force: true })

  // --- W17/W21: a probePath hit is an installation, even with no config file ---
  console.log('== setup: probePaths make an agent installed ==')
  const probeHome = mkdtempSync(join(tmpdir(), 'hub-setup-probe-'))
  const probeSkill = join(probeHome, 'SKILL.md')
  writeFileSync(probeSkill, '---\nname: agent-comm-hub\n---\n')
  mkdirSync(join(probeHome, '.minimax'), { recursive: true }) // state dir only: no mcp.json
  const probeSummary = await runSetup({ homeDir: probeHome, skillSrc: probeSkill, pathEnv: '', noNpm: true, ...quiet })
  check('mcode is recognised from ~/.minimax alone', probeSummary.done.length + probeSummary.skipped.length > 0, JSON.stringify(probeSummary))
  check('its config file is NOT created (missing files stay missing)', !existsSync(join(probeHome, '.minimax', 'mcp.json')), 'mcp.json was created')
  check('but its skill is synced, because the agent is really there', existsSync(join(probeHome, '.minimax', 'skills', 'agent-hub', 'SKILL.md')), JSON.stringify(walkFiles(probeHome)))
  rmSync(probeHome, { recursive: true, force: true })

  console.log(`\n${checks - failures}/${checks} checks passed`)
  if (failures > 0) process.exitCode = 1
} finally {
  rmSync(home, { recursive: true, force: true })
}
