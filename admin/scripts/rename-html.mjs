import { renameSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const assets = resolve(import.meta.dirname, '../../assets')
const from = resolve(assets, 'index.html')
const to = resolve(assets, 'admin.html')
if (!existsSync(from)) {
  console.error('build output missing:', from)
  process.exit(1)
}
renameSync(from, to)
console.log('wrote', to)
