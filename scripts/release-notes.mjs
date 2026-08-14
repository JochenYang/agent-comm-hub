#!/usr/bin/env node
/**
 * Draft GitHub release notes from conventional commits between two tags.
 *
 *   node scripts/release-notes.mjs <prevTag> <curTag>   # range vPrev..vCur
 *   node scripts/release-notes.mjs <curTag>             # full history (first release)
 *
 * Groups commits by type (feat/fix/docs/refactor/...) with links and author
 * handles, and appends a contributor thank-you list — the same shape GitHub
 * auto-notes would produce for a PR-based workflow. Pipe into a file and
 * pass to `gh release create <tag> --notes-file -`:
 *
 *   node scripts/release-notes.mjs v0.1.9 v0.1.10 | gh release create v0.1.10 --notes-file -
 */

import { execFileSync } from 'node:child_process'

const REPO = 'JochenYang/agent-comm-hub'
const TYPES = [
  { type: 'feat', title: 'Features' },
  { type: 'fix', title: 'Bugfixes' },
  { type: 'perf', title: 'Performance' },
  { type: 'refactor', title: 'Refactors' },
  { type: 'docs', title: 'Documentation' },
  { type: 'test', title: 'Tests' },
  { type: 'chore', title: 'Chores' },
  { type: 'ci', title: 'CI' },
  { type: 'build', title: 'Build' },
  { type: 'revert', title: 'Reverts' },
]

const [a, b] = process.argv.slice(2)
const cur = b ?? a
const prev = b ? a : undefined
if (!cur) {
  console.error('usage: release-notes.mjs [prevTag] curTag')
  process.exit(1)
}
const range = prev ? `${prev}..${cur}` : cur
const fmt = '%h|%s|%an'
const raw = execFileSync('git', ['log', `--pretty=format:${fmt}`, range], { encoding: 'utf8' })
const commits = raw.trim().split('\n').filter(Boolean).map(line => {
  const [hash, subject, author] = line.split('|')
  return { hash, subject, author }
})

const link = hash => `[${hash}](https://github.com/${REPO}/commit/${hash})`
const grouped = new Map(TYPES.map(t => [t.type, []]))
const misc = []
for (const c of commits) {
  const match = /^(\w+)(?:\([^)]*\))?:/.exec(c.subject)
  const type = match ? match[1] : null
  if (type && grouped.has(type)) grouped.get(type).push(c)
  else misc.push(c)
}

const out = []
for (const { type, title } of TYPES) {
  const items = grouped.get(type)
  if (items.length === 0) continue
  out.push(`### ${title}`)
  for (const c of items) {
    const subject = c.subject.replace(/^(\w+)(\([^)]*\))?:\s*/, '')
    out.push(`- ${subject} (${link(c.hash)})`)
  }
  out.push('')
}
if (misc.length > 0) {
  out.push('### Other')
  for (const c of misc) out.push(`- ${c.subject} (${link(c.hash)})`)
  out.push('')
}

const contributors = [...new Set(commits.map(c => c.author))]
out.push(`**Contributors:** ${contributors.join(', ')}`)
process.stdout.write(out.join('\n'))
