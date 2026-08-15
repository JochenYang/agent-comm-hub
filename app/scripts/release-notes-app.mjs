#!/usr/bin/env node
/**
 * M4 T-4.3: 给 agent-comm-hub-app 草拟 GitHub release notes。
 * 用法:
 *   node scripts/release-notes-app.mjs <prev-tag> <cur-tag>
 *   # 例如: node scripts/release-notes-app.mjs v0.9.0 v1.0.0
 *
 * 工作原理:
 *   解析 app/CHANGELOG.md,提取 [cur-tag] 区块,过滤掉内部细节
 *   (Known limitations / Internal 之类),保留 Highlights + Constraints +
 *   Verification gates,生成一份 markdown 文本到 stdout。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const changelogPath = resolve(here, '..', 'CHANGELOG.md')

function err(msg) {
  console.error(`[release-notes-app] ${msg}`)
  process.exit(2)
}

const argv = process.argv.slice(2)
if (argv.length !== 2) {
  err('usage: node scripts/release-notes-app.mjs <prev-tag> <cur-tag>')
}
const [, curTag] = argv

function extractSection(markdown, tag) {
  // 匹配 "## [<tag>]" 起到下一个 "## [" 或文件末
  const re = new RegExp(`^##\\s*\\[${escapeRegExp(tag)}\\][^\\n]*\\n([\\s\\S]*?)(?=^##\\s*\\[|\\Z)`, 'm')
  const m = markdown.match(re)
  if (!m) err(`section [${tag}] not found in CHANGELOG.md`)
  return m[1].trim()
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalize(text) {
  // 去掉 "###" 子小节里 "Internal / Internal notes"——保留可见章节即可。
  const dropHeads = ['### Internal', '### Internal notes', '### 内部']
  const lines = text.split('\n')
  const out = []
  let skip = false
  for (const line of lines) {
    if (line.startsWith('### ')) {
      skip = dropHeads.includes(line)
      if (skip) continue
      out.push(line)
      continue
    }
    if (!skip) out.push(line)
  }
  return out.join('\n').trim()
}

const md = readFileSync(changelogPath, 'utf8')
const section = normalize(extractSection(md, curTag))

console.log(`# agent-comm-hub-app ${curTag}\n`)
console.log(section)
console.log(`\n---\n_Full changelog: app/CHANGELOG.md_`)
