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
 * mailboxes leaked 张三's message to 李四's poll).
 *
 * Zero dependencies: the table is a small JSON file the operator manages
 * (see server/README.md in the repo for templates and rotation guidance).
 */

import { readFileSync } from 'node:fs'
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
}

/** Bearer-token lookup used by the MCP transport. */
export interface TokenTable {
  /** The TokenIdentity for a presented token, or undefined when unknown. */
  authenticate(token: string | undefined): TokenIdentity | undefined
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

/** Extract `Authorization: Bearer <token>` from a request's headers. */
export function bearerFromHeaders(headers: { authorization?: string | string[] | undefined }): string | undefined {
  const raw = Array.isArray(headers.authorization) ? headers.authorization[0] : headers.authorization
  if (raw === undefined) return undefined
  const match = /^Bearer\s+(.+)$/.exec(raw.trim())
  return match === null ? undefined : match[1]
}
