#!/usr/bin/env node
/**
 * Draft user-facing GitHub release notes.
 *
 *   node scripts/release-notes.mjs <curTag>            # initial release
 *   node scripts/release-notes.mjs <prevTag> <curTag>  # range vPrev..vCur
 *
 * The body comes from the hand-written CHANGELOG.md entry for that version
 * (user-facing behavior descriptions, not commit messages); the script adds
 * the date, a compare link, and the contributor list. Pipe into a file and
 * pass to `gh release create <tag> --notes-file -` (or `gh release edit`).
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const REPO = 'JochenYang/agent-comm-hub'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const [a, b] = process.argv.slice(2)
const cur = b ?? a
const prev = b ? a : undefined
if (!cur) {
  console.error('usage: release-notes.mjs [prevTag] curTag')
  process.exit(1)
}

const version = cur.replace(/^v/, '')
const date = execFileSync('git', ['show', '-s', '--format=%cs', cur], { encoding: 'utf8' }).trim()

// Body: the CHANGELOG.md paragraph for this version.
const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')
const sectionRe = new RegExp(`^## ${version.replace(/\./g, '\\.')} \\([^)]*\\)([\\s\\S]*?)(?=^## |\\z)`, 'm')
const section = sectionRe.exec(changelog)?.[1]?.trim() ?? ''
if (!section) console.error(`warning: no CHANGELOG section for ${version}`)

const compare = prev
  ? `[${prev}...${cur}](https://github.com/${REPO}/compare/${prev}...${cur})`
  : `[${cur}](https://github.com/${REPO}/releases/tag/${cur})`
const contributors = [...new Set(
  execFileSync('git', ['log', `--pretty=format:%an`, prev ? `${prev}..${cur}` : cur], { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean),
)]

const out = []
out.push(`## ${cur} — ${date}`)
out.push('')
if (section) out.push(section)
out.push('')
out.push(`**Commits:** ${compare} · **Contributors:** ${contributors.join(', ')} · [CHANGELOG](https://github.com/${REPO}/blob/main/CHANGELOG.md)`)
process.stdout.write(out.join('\n'))
