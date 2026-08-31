/**
 * SQLite persistence for remote-mode hubs (`--db <file>`), backed by the
 * Node built-in `node:sqlite` — the only way to keep the zero-dependency
 * invariant while surviving server restarts. Persists four things:
 * history ring, offline mailboxes, peer profiles (user info), and groups.
 *
 * Write strategy: message inserts are buffered and flushed on a debounce
 * (plus an explicit flush on shutdown); mailboxes/profiles/groups are
 * re-snapshotted wholesale on every flush — at team scale these are tens of
 * rows, so correctness beats incremental bookkeeping.
 */

import { DatabaseSync } from 'node:sqlite'
import type { BridgeMessage, MessageKind } from './protocol.js'
import type { GroupState, PeerProfile } from './hub.js'

const KIND_NAMES: readonly string[] = ['chat', 'task', 'notice', 'ack']

function messageToRow(message: BridgeMessage): (string | number | null)[] {
  return [message.id, message.from, message.to, message.kind, message.content, message.ref ?? null, message.channel ?? null, message.ts]
}

function rowToMessage(row: Record<string, unknown>): BridgeMessage | undefined {
  const id = row.id
  const from = row.from_peer
  const to = row.to_peer
  const kind = row.kind
  const content = row.content
  const ts = row.ts
  if (typeof id !== 'string' || typeof from !== 'string' || typeof to !== 'string' || typeof content !== 'string' || typeof ts !== 'number') return undefined
  if (!KIND_NAMES.includes(kind as string)) return undefined
  return {
    id,
    from,
    to,
    kind: kind as MessageKind,
    content,
    ...(typeof row.ref === 'string' && row.ref !== '' ? { ref: row.ref } : {}),
    ...(typeof row.channel === 'string' && row.channel !== '' ? { channel: row.channel } : {}),
    ts,
  }
}

export interface PersistedState {
  profiles: PeerProfile[]
  messages: BridgeMessage[]
  mailboxes: Record<string, BridgeMessage[]>
  groups: GroupState[]
}

/** SQLite-backed state store. All methods are synchronous — the hub core is
 * sync and team-scale volumes make async ceremony pointless here. */
export class SQLiteStateStore {
  private readonly db: DatabaseSync
  private buffer: BridgeMessage[] = []

  constructor(
    file: string,
    private readonly historyLimit: number,
    log: { warn(message: string): void },
  ) {
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY, alias TEXT, client_name TEXT, client_version TEXT, registered_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, from_peer TEXT NOT NULL,
        to_peer TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL, ref TEXT, channel TEXT, ts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mailboxes (
        peer TEXT NOT NULL, seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, from_peer TEXT NOT NULL,
        to_peer TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL, ref TEXT, channel TEXT, ts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY, name TEXT, members TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL
      );
    `)
    log.warn(`sqlite state open: ${file}`)
  }

  /** Buffer one history message (called per message via the hub hook). */
  appendMessage(message: BridgeMessage): void {
    this.buffer.push(message)
  }

  /** Insert buffered messages and re-snapshot mailboxes/profiles/groups. */
  flush(snapshot: { mailboxes: Record<string, BridgeMessage[]>; profiles: PeerProfile[]; groups: GroupState[] }): void {
    const insert = this.db.prepare(
      'INSERT INTO messages (id, from_peer, to_peer, kind, content, ref, channel, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    for (const message of this.buffer.splice(0, this.buffer.length)) {
      insert.run(...messageToRow(message))
    }
    this.db.exec('DELETE FROM mailboxes')
    const insertMail = this.db.prepare(
      'INSERT INTO mailboxes (peer, id, from_peer, to_peer, kind, content, ref, channel, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    for (const [peer, queue] of Object.entries(snapshot.mailboxes)) {
      for (const message of queue) insertMail.run(peer, ...messageToRow(message))
    }
    this.db.exec('DELETE FROM profiles')
    const insertProfile = this.db.prepare(
      'INSERT INTO profiles (id, alias, client_name, client_version, registered_at) VALUES (?, ?, ?, ?, ?)',
    )
    for (const profile of snapshot.profiles) {
      insertProfile.run(profile.id, profile.alias ?? null, profile.clientName ?? null, profile.clientVersion ?? null, profile.registeredAt)
    }
    this.db.exec('DELETE FROM groups')
    const insertGroup = this.db.prepare(
      'INSERT INTO groups (id, name, members, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    for (const group of snapshot.groups) {
      insertGroup.run(group.id, group.name ?? null, JSON.stringify(group.members), group.createdBy, group.createdAt)
    }
    // Keep the ring bounded on disk too (headroom for concurrent readers).
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number | bigint }
    const total = Number(row.n)
    if (total > this.historyLimit * 2) {
      this.db.exec(`DELETE FROM messages WHERE seq <= (SELECT MAX(seq) FROM messages) - ${this.historyLimit}`)
    }
  }

  /** Read everything persisted so far (boot restore). */
  load(): PersistedState {
    const profiles: PeerProfile[] = []
    for (const row of this.db.prepare('SELECT * FROM profiles').all() as Array<Record<string, unknown>>) {
      if (typeof row.id !== 'string') continue
      profiles.push({
        id: row.id,
        ...(typeof row.alias === 'string' && row.alias !== '' ? { alias: row.alias } : {}),
        ...(typeof row.client_name === 'string' && row.client_name !== '' ? { clientName: row.client_name } : {}),
        ...(typeof row.client_version === 'string' && row.client_version !== '' ? { clientVersion: row.client_version } : {}),
        registeredAt: typeof row.registered_at === 'number' ? row.registered_at : Date.now(),
      })
    }
    const messages: BridgeMessage[] = []
    for (const row of this.db.prepare('SELECT * FROM messages ORDER BY seq').all() as Array<Record<string, unknown>>) {
      const message = rowToMessage(row)
      if (message !== undefined) messages.push(message)
    }
    const mailboxes: Record<string, BridgeMessage[]> = {}
    for (const row of this.db.prepare('SELECT * FROM mailboxes ORDER BY seq').all() as Array<Record<string, unknown>>) {
      if (typeof row.peer !== 'string') continue
      const message = rowToMessage(row)
      if (message === undefined) continue
      ;(mailboxes[row.peer] ??= []).push(message)
    }
    const groups: GroupState[] = []
    for (const row of this.db.prepare('SELECT * FROM groups').all() as Array<Record<string, unknown>>) {
      if (typeof row.id !== 'string' || typeof row.members !== 'string') continue
      try {
        const members = JSON.parse(row.members) as unknown
        if (!Array.isArray(members) || members.length === 0) continue
        groups.push({
          id: row.id,
          members: members.filter((m): m is string => typeof m === 'string'),
          createdBy: typeof row.created_by === 'string' ? row.created_by : '',
          createdAt: typeof row.created_at === 'number' ? row.created_at : Date.now(),
          ...(typeof row.name === 'string' && row.name !== '' ? { name: row.name } : {}),
        })
      } catch {
        // corrupted row: skip
      }
    }
    return { profiles, messages, mailboxes, groups }
  }

  /** Final flush + close (hub shutdown). */
  close(snapshot: Parameters<SQLiteStateStore['flush']>[0]): void {
    this.flush(snapshot)
    this.db.close()
  }
}
