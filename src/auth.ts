/**
 * Remote-access authentication for agent-comm-hub.
 *
 * The hub's default trust model is "loopback only, no auth" — right for a
 * personal desktop hub, wrong for a server that agents on other machines
 * connect to. Remote mode turns a token table into the identity layer: every
 * MCP request must carry `Authorization: Bearer <token>`, and the token —
 * not the client-reported name — decides WHO the caller is (peer id) and
 * WHAT it may do (role). Two people both running "kimi-code" then get two
 * distinct peers instead of sharing one mailbox (R0 experiment: shared
 * mailboxes leaked Zhang San's message to Li Si's poll).
 *
 * Zero dependencies: the table is a small JSON file the operator manages
 * (see server/README.md in the repo for templates and rotation guidance).
 */

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { PEER_ID_PATTERN } from './protocol.js'

/** What a token is allowed to do. `manager` may rename other peers, kick,
 * and read other peers' history (mirrors managerPeers, but authenticated). */
export type TokenRole = 'agent' | 'manager'

/** The identity one token maps to. The peer id is the STABLE routing id for
 * that human/agent; the display alias is set by a manager via bridge_rename. */
export interface TokenIdentity {
  peer: string
  role: TokenRole
  /** Optional human-readable owner label, for the roster/audit (not routed). */
  owner?: string
  /** Set for `--allow-join` walk-ins: no token was presented, the hub issued
   * a temporary per-connection identity. The admin renames (claims) it or
   * issues a real token later. */
  anonymous?: true
}

/** Sentinel peer for allow-join sessions before their unique id is resolved
 * (see startHub's join handling). Never a routable id. */
export const ANON_JOIN_PEER = '__join__'

/** Bearer-token lookup used by the MCP transport. */
export interface TokenTable {
  /** The TokenIdentity for a presented token, or undefined when unknown. */
  authenticate(token: string | undefined): TokenIdentity | undefined
  /** Force a reload from disk (called right after the table file changes
   * through the management API, so freshly issued tokens work instantly). */
  reload?: () => void
}

/** Tokens must be long random strings; 16 chars of this alphabet is the
 * floor (operators should generate 32+ hex/base64url via the documented
 * one-liner). Kept as a pattern so a mistyped word fails at load, not at
 * 3am in production. */
const TOKEN_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/

/**
 * Load and validate a token table file:
 * `{ "tokens": [{ "token", "peer", "role", "owner?" }, ...] }`.
 * Fail-closed: ANY structural problem throws, so a typo never silently
 * starts an open server. Duplicate tokens or duplicate peer ids also throw
 * (two tokens sharing a peer would re-introduce the shared mailbox).
 */
export function loadTokenFile(file: string): Map<string, TokenIdentity> {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`auth token file unreadable: ${file} (${(error as Error).message})`)
  }
  const rows = (parsed as { tokens?: unknown })?.tokens
  if (!Array.isArray(rows)) throw new Error(`auth token file ${file}: expected {"tokens":[...]}`)

  const table = new Map<string, TokenIdentity>()
  const peers = new Set<string>()
  rows.forEach((row, index) => {
    const msg = (why: string): string => `auth token file ${file}: entry #${index + 1} ${why}`
    if (typeof row !== 'object' || row === null) throw new Error(msg('is not an object'))
    const { token, peer, role, owner } = row as Record<string, unknown>
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
      throw new Error(msg('has an invalid token (expect 16-128 chars of [A-Za-z0-9._:-])'))
    }
    if (typeof peer !== 'string' || !PEER_ID_PATTERN.test(peer) || peer === 'all') {
      throw new Error(msg(`has an invalid peer id '${String(peer)}'`))
    }
    if (role !== 'agent' && role !== 'manager') {
      throw new Error(msg(`has an invalid role '${String(role)}' (expected 'agent' | 'manager')`))
    }
    if (owner !== undefined && typeof owner !== 'string') throw new Error(msg('has a non-string owner'))
    if (table.has(token)) throw new Error(msg('duplicates a token'))
    if (peers.has(peer)) {
      throw new Error(msg(`maps a second token to peer '${peer}' (two tokens sharing a peer share its mailbox)`))
    }
    table.set(token, { peer, role, ...(typeof owner === 'string' && owner !== '' ? { owner } : {}) })
    peers.add(peer)
  })
  if (table.size === 0) throw new Error(`auth token file ${file}: no tokens defined`)
  return table
}

/** Wrap a validated map into the lookup the transport calls per request. */
export function tokenTable(map: Map<string, TokenIdentity>): TokenTable {
  return {
    authenticate: token => (token === undefined ? undefined : map.get(token)),
  }
}

/**
 * Token table that hot-reloads: the file is re-validated on change (mtime
 * polled by an UNREF'd timer — it must never keep the process alive) and
 * swapped atomically; an invalid edit keeps the previous table and logs, so
 * a typo never locks a running team out. Restart not required for
 * adding/rotating tokens.
 */
export function watchTokenFile(file: string, log: { info(message: string): void; warn(message: string): void }): TokenTable {
  let table = loadTokenFile(file)
  const reload = (): void => {
    try {
      const next = loadTokenFile(file)
      table = next
      log.info(`auth tokens reloaded: ${table.size} entr(ies)`)
    } catch (error) {
      log.warn(`auth token reload ignored, keeping previous table: ${(error as Error).message}`)
    }
  }
  log.info(`auth tokens loaded: ${table.size} entr(ies) from ${file}`)
  let mtime = statMtime(file)
  const timer = setInterval(() => {
    const current = statMtime(file)
    if (current === mtime) return
    mtime = current
    reload()
  }, 2_000)
  timer.unref?.()
  return { authenticate: token => (token === undefined ? undefined : table.get(token)), reload }
}

function statMtime(file: string): number {
  try {
    return statSync(file).mtimeMs
  } catch {
    return 0
  }
}

/** Extract `Authorization: Bearer <token>` from a request's headers. */
export function bearerFromHeaders(headers: { authorization?: string | string[] | undefined }): string | undefined {
  const raw = Array.isArray(headers.authorization) ? headers.authorization[0] : headers.authorization
  if (raw === undefined) return undefined
  const match = /^Bearer\s+(.+)$/.exec(raw.trim())
  return match === null ? undefined : match[1]
}

// ---- token management (CLI `agent-comm-hub auth`) ---------------------

/** A token-table row as stored on disk (plaintext capability store). */
export interface TokenRowJson {
  token: string
  peer: string
  role: TokenRole
  owner?: string
}

/** Generate a fresh token: 24 random bytes as base64url (32 chars) —
 * cryptographically random and fits TOKEN_PATTERN with room to spare. */
export function generateToken(): string {
  return randomBytes(24).toString('base64url')
}

/** Read the token table as rows; a missing file yields []. A file holding
 * an EMPTY table (all tokens removed) also yields [] — but the RUNNING hub
 * fail-closes on it, which is the point of removing the last token. */
export function readTokens(file: string): TokenRowJson[] {
  if (!existsSync(file)) return []
  try {
    return [...loadTokenFile(file).entries()].map(([token, id]) => ({
      token,
      peer: id.peer,
      role: id.role,
      ...(id.owner !== undefined ? { owner: id.owner } : {}),
    }))
  } catch (error) {
    // A file holding an empty table (last token removed) is valid CLI state;
    // the RUNNING hub fail-closes on it. Anything malformed still throws.
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { tokens?: unknown }
      if (Array.isArray(parsed.tokens) && parsed.tokens.length === 0) return []
    } catch {
      // fall through to the original validation error
    }
    throw error
  }
}

function writeTokenFile(file: string, rows: TokenRowJson[]): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify({ tokens: rows }, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
}

/** Append a token row (auto-generated unless `token` is given) and
 * atomically persist the table. Returns the row — the token is shown to the
 * operator ONCE here. Throws when the peer already has a token (remove it
 * first to rotate). */
export function addToken(file: string, row: { peer: string; role: TokenRole; owner?: string; token?: string }): TokenRowJson {
  const token = row.token ?? generateToken()
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error(`invalid token provided (expect 16-128 chars of [A-Za-z0-9._:-])`)
  }
  const peers = new Set(readTokens(file).map(t => t.peer))
  if (peers.has(row.peer)) {
    throw new Error(`peer '${row.peer}' already has a token — remove it first to rotate (see \`auth remove\`)`)
  }
  const owner = row.owner !== undefined && row.owner !== '' ? row.owner : undefined
  const identity: TokenRowJson = { token, peer: row.peer, role: row.role, ...(owner !== undefined ? { owner } : {}) }
  const next = [...readTokens(file), identity]
  // Fail-closed: refuse to persist a table the hub will reject at boot.
  loadTokenFileVoid(next)
  writeTokenFile(file, next)
  return identity
}

/** Remove a peer's token from the table. Returns false when absent. */
export function removeToken(file: string, peer: string): boolean {
  const tokens = readTokens(file)
  const kept = tokens.filter(t => t.peer !== peer)
  if (kept.length === tokens.length) return false
  writeTokenFile(file, kept)
  return true
}

/** Validate rows as if they came from disk (used before writing an edited
 * table). Reuses the load-time rules so the CLI can never persist a table
 * the running hub would reject. */
function loadTokenFileVoid(rows: TokenRowJson[]): void {
  const table = new Map<string, TokenIdentity>()
  const peers = new Set<string>()
  for (const { token, peer, role, owner } of rows) {
    if (!TOKEN_PATTERN.test(token)) throw new Error(`invalid token for peer '${peer}'`)
    if (!PEER_ID_PATTERN.test(peer) || peer === 'all') throw new Error(`invalid peer id '${peer}'`)
    if (role !== 'agent' && role !== 'manager') throw new Error(`invalid role '${role}'`)
    if (table.has(token)) throw new Error('duplicate token')
    if (peers.has(peer)) throw new Error(`duplicate peer '${peer}'`)
    table.set(token, { peer, role, ...(owner !== undefined && owner !== '' ? { owner } : {}) })
    peers.add(peer)
  }
}
