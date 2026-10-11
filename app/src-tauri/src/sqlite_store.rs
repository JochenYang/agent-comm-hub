//! T-1.5 SQLite persistence layer (wired up in M2 T-2.6)
//!
//! Synchronous rusqlite API; the store: Arc<Store> is held in AppState and commands call the
//! CRUD operations synchronously (each CRUD is <1ms, so spawn_blocking isn't needed).
//!
//! Schema (SPEC §5.3):
//! - config(key, value, updated_at)
//! - peers(peer_id, last_seen, online, client_name, created_at) + v2 adds alias, client_version
//! - messages(id, from_peer, to_peer, kind, content, ref_id, channel, thread_id, ts, involved_me) + ts DESC index + involved_me index
//!   (channel / thread_id arrive with v3)
//! - unread(peer_id, count, last_read_ts)
//! - schema_version(version) — migration log (one row per version; current version = MAX(version),
//!   reads must not use a bare LIMIT 1 — unordered reads over multiple rows can pick an old
//!   version at random and replay migrations)
//!
//! Design notes:
//! - Synchronous rusqlite API (connection serialized via std::sync::Mutex)
//! - WAL mode + synchronous=NORMAL (a trade-off between write performance and crash safety)
//! - FK enabled (though the current schema uses no FKs, keeping the default is safe)
//! - A single migrate(): v1 = all tables; later versions append if current < N branches

// Every pub fn / struct in this module is dispatched to invoke_handler via the string-based
// `tauri::generate_handler!`, which the dead_code lint can't see through — so it's switched off
// at the crate top level to avoid repeated warnings while M3 wires peer / message writes.
#![allow(dead_code)]

use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("lock poisoned")]
    LockPoisoned,
}

impl<T> From<std::sync::PoisonError<T>> for StoreError {
    fn from(_: std::sync::PoisonError<T>) -> Self {
        StoreError::LockPoisoned
    }
}

pub type Result<T> = std::result::Result<T, StoreError>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerRecord {
    pub peer_id: String,
    pub last_seen: i64,
    pub online: bool,
    pub client_name: Option<String>,
    /// alias returned by hub bridge_peers? (absent = none/unknown, keep the old value on upsert).
    pub alias: Option<String>,
    /// clientVersion returned by the hub? (kept from the old value when absent, same reason as alias).
    pub client_version: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageRecord {
    pub id: String,
    pub from_peer: String,
    pub to_peer: String,
    pub kind: String,
    pub content: String,
    pub ref_id: Option<String>,
    /// Group channel id of a group-routed message (hub >= 0.6); None for direct / broadcast traffic.
    pub channel: Option<String>,
    /// Conversation / workflow thread id (hub >= 0.9); None when the sender set none.
    pub thread_id: Option<String>,
    pub ts: i64,
    pub involved_me: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnreadRecord {
    pub peer_id: String,
    pub last_read_ts: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigRecord {
    pub key: String,
    pub value: String,
    pub updated_at: i64,
}

/// SQLite store (thread-safe, single connection).
/// M2 opens + manages it in the start_hub path; commands call CRUD via spawn_blocking.
pub struct Store {
    conn: Arc<Mutex<Connection>>,
}

impl Store {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let store = Self { conn: Arc::new(Mutex::new(conn)) };
        store.migrate()?;
        Ok(store)
    }

    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let store = Self { conn: Arc::new(Mutex::new(conn)) };
        store.migrate()?;
        Ok(store)
    }

    fn migrate(&self) -> Result<()> {
        let mut conn = self.conn.lock()?;
        let tx = conn.transaction()?;
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);",
        )?;
        // Current version = MAX(version): schema_version is a migration log (one row per version),
        // so it must not be assumed to be a single row — a bare LIMIT 1 unordered read could pick
        // an old version at random and replay migrations.
        // MAX always yields one row (NULL on an empty table); the closure explicitly reads an
        // Option rather than wrapping in .optional().
        let current: Option<i64> = tx.query_row(
            "SELECT MAX(version) FROM schema_version",
            [],
            |row| row.get::<_, Option<i64>>(0),
        )?;
        let current = current.unwrap_or(0);
        if current < 1 {
            tx.execute_batch(
                r#"
                CREATE TABLE IF NOT EXISTS config (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS peers (
                    peer_id TEXT PRIMARY KEY,
                    last_seen INTEGER NOT NULL,
                    online INTEGER NOT NULL DEFAULT 0,
                    client_name TEXT,
                    created_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS messages (
                    id TEXT PRIMARY KEY,
                    from_peer TEXT NOT NULL,
                    to_peer TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    content TEXT NOT NULL,
                    ref_id TEXT,
                    ts INTEGER NOT NULL,
                    involved_me INTEGER NOT NULL DEFAULT 0
                );
                CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts DESC);
                CREATE INDEX IF NOT EXISTS idx_messages_involved
                    ON messages(involved_me, ts DESC);
                CREATE TABLE IF NOT EXISTS unread (
                    peer_id TEXT PRIMARY KEY,
                    count INTEGER NOT NULL DEFAULT 0,
                    last_read_ts INTEGER
                );
                INSERT INTO schema_version (version) VALUES (1)
                    ON CONFLICT(version) DO UPDATE SET version = 1;
                "#,
            )?;
        }
        if current < 2 {
            // v2: add alias / client_version columns to the peers table (roster management: the hub's
            // bridge_peers / peers_changed now return alias?/clientName?/clientVersion?).
            // SQLite's ALTER TABLE ADD COLUMN has no IF NOT EXISTS — idempotence is guaranteed by
            // monotonic schema_version advancement (a freshly created v1 database also walks here in order).
            // Version rows use INSERT OR REPLACE (log semantics: one row per version, reads take MAX).
            // Note: can't use a bare INSERT — a future replay (partial-failure recovery) would hit a unique-key collision.
            tx.execute_batch(
                r#"
                ALTER TABLE peers ADD COLUMN alias TEXT;
                ALTER TABLE peers ADD COLUMN client_version TEXT;
                INSERT OR REPLACE INTO schema_version (version) VALUES (2);
                "#,
            )?;
        }
        if current < 3 {
            // v3: messages gain channel / thread_id. The GUI's message type carries both
            // (app/src/lib/tauri.ts PresentedMessage) and messagesStore counts group unread by
            // channel: without the columns a GUI restart lost which group a message was sent to
            // and broke A2A thread linking. Existing columns (incl. ref_id) are untouched.
            //
            // Each ALTER is gated on a PRAGMA table_info probe rather than on the version log
            // alone. ADD COLUMN has no IF NOT EXISTS, so a database whose log and real schema
            // disagree (a partially applied migration, or a build that added the column without
            // logging it) would abort migrate() with "duplicate column name" — the app could not
            // open its store at all. Probing makes the add idempotent by construction and lets
            // migrate() heal the log.
            for (column, ddl) in [
                ("channel", "ALTER TABLE messages ADD COLUMN channel TEXT;"),
                ("thread_id", "ALTER TABLE messages ADD COLUMN thread_id TEXT;"),
            ] {
                if !Self::column_exists(&tx, "messages", column)? {
                    tx.execute_batch(ddl)?;
                }
            }
            tx.execute_batch("INSERT OR REPLACE INTO schema_version (version) VALUES (3);")?;
        }
        if current < 4 {
            // v4: drop `unread.count`. It was written only by `bump_unread`, which no
            // production path ever called, and read by nothing — the GUI derives
            // unread from the message pool plus `last_read_ts`. A column that is never
            // written and never read is not a feature, it is a trap: the next reader
            // assumes it means something.
            //
            // Rebuild rather than `ALTER TABLE ... DROP COLUMN`: the rebuild works on
            // any SQLite version and states the surviving shape explicitly. Guarded by
            // a probe so a database that never had the column (a fresh v1 create, once
            // the column is gone from the DDL) still advances its log.
            if Self::column_exists(&tx, "unread", "count")? {
                tx.execute_batch(
                    r#"
                    CREATE TABLE unread_v4 (peer_id TEXT PRIMARY KEY, last_read_ts INTEGER);
                    INSERT INTO unread_v4 (peer_id, last_read_ts) SELECT peer_id, last_read_ts FROM unread;
                    DROP TABLE unread;
                    ALTER TABLE unread_v4 RENAME TO unread;
                    "#,
                )?;
            }
            tx.execute_batch("INSERT OR REPLACE INTO schema_version (version) VALUES (4);")?;
        }
        tx.commit()?;
        Ok(())
    }

    // ---- peers ----

    pub fn upsert_peer(&self, peer: &PeerRecord) -> Result<()> {
        let conn = self.conn.lock()?;
        conn.execute(
            "INSERT INTO peers (peer_id, last_seen, online, client_name, alias, client_version, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(peer_id) DO UPDATE SET
               last_seen = excluded.last_seen,
               online = excluded.online,
               client_name = COALESCE(excluded.client_name, peers.client_name),
               alias = COALESCE(excluded.alias, peers.alias),
               client_version = COALESCE(excluded.client_version, peers.client_version)",
            params![
                peer.peer_id,
                peer.last_seen,
                peer.online as i64,
                peer.client_name,
                peer.alias,
                peer.client_version,
                peer.created_at
            ],
        )?;
        Ok(())
    }

    /// Explicitly set/clear an alias (authoritative sync after a successful bridge_rename).
    ///
    /// Going through upsert_peer's COALESCE semantics can't clear an alias — an absent alias in a
    /// snapshot is ambiguous (truly no alias vs. older hub versions not returning it at all), so the
    /// rename result is the only authoritative source: both `Some("")` and `None` store NULL.
    pub fn set_peer_alias(&self, peer_id: &str, alias: Option<&str>) -> Result<()> {
        let conn = self.conn.lock()?;
        conn.execute(
            "UPDATE peers SET alias = ?2 WHERE peer_id = ?1",
            params![peer_id, alias.filter(|a| !a.is_empty())],
        )?;
        Ok(())
    }

    pub fn list_peers(&self) -> Result<Vec<PeerRecord>> {
        let conn = self.conn.lock()?;
        let mut stmt = conn.prepare(
            "SELECT peer_id, last_seen, online, client_name, alias, client_version, created_at
             FROM peers ORDER BY last_seen DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(PeerRecord {
                peer_id: row.get(0)?,
                last_seen: row.get(1)?,
                online: row.get::<_, i64>(2)? != 0,
                client_name: row.get(3)?,
                alias: row.get(4)?,
                client_version: row.get(5)?,
                created_at: row.get(6)?,
            })
        })?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn delete_peer(&self, peer_id: &str) -> Result<()> {
        let conn = self.conn.lock()?;
        conn.execute("DELETE FROM peers WHERE peer_id = ?1", params![peer_id])?;
        Ok(())
    }

    // ---- messages ----

    pub fn insert_message(&self, msg: &MessageRecord) -> Result<()> {
        let conn = self.conn.lock()?;
        conn.execute(
            "INSERT OR REPLACE INTO messages
                (id, from_peer, to_peer, kind, content, ref_id, channel, thread_id, ts, involved_me)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                msg.id,
                msg.from_peer,
                msg.to_peer,
                msg.kind,
                msg.content,
                msg.ref_id,
                msg.channel,
                msg.thread_id,
                msg.ts,
                msg.involved_me as i64
            ],
        )?;
        Ok(())
    }

    pub fn list_messages_for_peer(&self, peer_id: &str, limit: i64) -> Result<Vec<MessageRecord>> {
        let conn = self.conn.lock()?;
        // Only this peer's traffic + hub-wide broadcasts. The previous
        // `OR involved_me = 1` leaked every message the GUI ever sent/received
        // into every conversation's archive restore — and still missed pure
        // agent↔agent rows when /history asked for a full pull.
        let mut stmt = conn.prepare(
            "SELECT id, from_peer, to_peer, kind, content, ref_id, channel, thread_id, ts, involved_me
             FROM messages
             WHERE from_peer = ?1 OR to_peer = ?1 OR to_peer = 'all'
             ORDER BY ts DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![peer_id, limit], |row| {
            Ok(MessageRecord {
                id: row.get(0)?,
                from_peer: row.get(1)?,
                to_peer: row.get(2)?,
                kind: row.get(3)?,
                content: row.get(4)?,
                ref_id: row.get(5)?,
                channel: row.get(6)?,
                thread_id: row.get(7)?,
                ts: row.get(8)?,
                involved_me: row.get::<_, i64>(9)? != 0,
            })
        })?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    /// Tail of the full archive (no identity filter): used by the relay-stream view /history. SQLite
    /// stores all traffic (persisted as a side effect of refresh), but list_messages_for_peer only
    /// returns rows involving you — a private conversation between two other peers can't be
    /// retrieved through it.
    pub fn list_all_messages(&self, limit: i64) -> Result<Vec<MessageRecord>> {
        let conn = self.conn.lock()?;
        let mut stmt = conn.prepare(
            "SELECT id, from_peer, to_peer, kind, content, ref_id, channel, thread_id, ts, involved_me
             FROM messages
             ORDER BY ts DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit], |row| {
            Ok(MessageRecord {
                id: row.get(0)?,
                from_peer: row.get(1)?,
                to_peer: row.get(2)?,
                kind: row.get(3)?,
                content: row.get(4)?,
                ref_id: row.get(5)?,
                channel: row.get(6)?,
                thread_id: row.get(7)?,
                ts: row.get(8)?,
                involved_me: row.get::<_, i64>(9)? != 0,
            })
        })?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn count_messages(&self) -> Result<i64> {
        let conn = self.conn.lock()?;
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0))?;
        Ok(n)
    }

    // ---- unread ----


    pub fn clear_unread(&self, peer_id: &str, last_read_ts: i64) -> Result<()> {
        let conn = self.conn.lock()?;
        conn.execute(
            "INSERT INTO unread (peer_id, last_read_ts) VALUES (?1, ?2)
             ON CONFLICT(peer_id) DO UPDATE SET last_read_ts = ?2",
            params![peer_id, last_read_ts],
        )?;
        Ok(())
    }

    /// Read-state for every peer the user has ever opened.
    ///
    /// What the GUI restores at startup is the WATERMARK: it derives unread counts
    /// itself from the message pool plus `last_read_ts`, including for peers it has
    /// read to zero. So this returns every row with a watermark, not only rows with
    /// a non-zero counter — the old `WHERE count > 0` returned an empty list on
    /// every real install, because nothing ever incremented that counter.
    pub fn list_unread(&self) -> Result<Vec<UnreadRecord>> {
        let conn = self.conn.lock()?;
        let mut stmt = conn.prepare(
            "SELECT peer_id, last_read_ts FROM unread
             WHERE last_read_ts IS NOT NULL ORDER BY last_read_ts DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(UnreadRecord {
                peer_id: row.get(0)?,
                last_read_ts: row.get(1)?,
            })
        })?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    // ---- config ----

    pub fn get_config(&self, key: &str) -> Result<Option<ConfigRecord>> {
        let conn = self.conn.lock()?;
        let rec = conn
            .query_row(
                "SELECT key, value, updated_at FROM config WHERE key = ?1",
                params![key],
                |row| {
                    Ok(ConfigRecord {
                        key: row.get(0)?,
                        value: row.get(1)?,
                        updated_at: row.get(2)?,
                    })
                },
            )
            .optional()?;
        Ok(rec)
    }

    pub fn set_config(&self, key: &str, value: &str, updated_at: i64) -> Result<()> {
        let conn = self.conn.lock()?;
        conn.execute(
            "INSERT INTO config (key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET
               value = excluded.value,
               updated_at = excluded.updated_at",
            params![key, value, updated_at],
        )?;
        Ok(())
    }

    /// Whether `table` already carries a column named `column` (used to make ADD COLUMN idempotent).
    ///
    /// The table name is interpolated rather than bound: SQLite accepts no parameter in
    /// `PRAGMA table_info(...)`, and every caller passes a compile-time constant, so there is no
    /// injection surface.
    fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool> {
        let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let name: String = row.get(1)?;
            if name == column {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> Store {
        Store::open_in_memory().unwrap()
    }

    #[test]
    fn migrate_creates_all_tables() {
        let store = fresh();
        let conn = store.conn.lock().unwrap();
        let names: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .filter_map(std::result::Result::ok)
            .collect();
        assert!(names.contains(&"config".to_string()));
        assert!(names.contains(&"peers".to_string()));
        assert!(names.contains(&"messages".to_string()));
        assert!(names.contains(&"unread".to_string()));
        assert!(names.contains(&"schema_version".to_string()));
    }

    #[test]
    fn upsert_and_list_peers() {
        let store = fresh();
        store
            .upsert_peer(&PeerRecord {
                peer_id: "claude".into(),
                last_seen: 100,
                online: true,
                client_name: Some("claude-code".into()),
                alias: Some("Claude".into()),
                client_version: Some("1.2.3".into()),
                created_at: 50,
            })
            .unwrap();
        store
            .upsert_peer(&PeerRecord {
                peer_id: "codex".into(),
                last_seen: 90,
                online: false,
                client_name: None,
                alias: None,
                client_version: None,
                created_at: 40,
            })
            .unwrap();
        let peers = store.list_peers().unwrap();
        assert_eq!(peers.len(), 2);
        assert_eq!(peers[0].peer_id, "claude");
        assert!(peers[0].online);
        assert_eq!(peers[0].alias.as_deref(), Some("Claude"));
        assert_eq!(peers[0].client_version.as_deref(), Some("1.2.3"));
        assert_eq!(peers[1].peer_id, "codex");
        assert!(!peers[1].online);
    }

    #[test]
    fn upsert_peer_updates_existing() {
        let store = fresh();
        store
            .upsert_peer(&PeerRecord {
                peer_id: "x".into(),
                last_seen: 1,
                online: false,
                client_name: None,
                alias: None,
                client_version: None,
                created_at: 1,
            })
            .unwrap();
        store
            .upsert_peer(&PeerRecord {
                peer_id: "x".into(),
                last_seen: 2,
                online: true,
                client_name: Some("client-x".into()),
                alias: None,
                client_version: None,
                created_at: 1,
            })
            .unwrap();
        let peers = store.list_peers().unwrap();
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].last_seen, 2);
        assert!(peers[0].online);
        assert_eq!(peers[0].client_name.as_deref(), Some("client-x"));
    }

    /// A snapshot that lacks a field (None) doesn't wipe known alias / client_version — older hub
    /// versions don't return these fields at all, and the COALESCE semantics ensure the local
    /// roster isn't cleared by a passive snapshot.
    #[test]
    fn upsert_peer_coalesce_keeps_alias_when_absent() {
        let store = fresh();
        store
            .upsert_peer(&PeerRecord {
                peer_id: "a".into(),
                last_seen: 1,
                online: true,
                client_name: None,
                alias: Some("Alpha".into()),
                client_version: Some("9.9".into()),
                created_at: 1,
            })
            .unwrap();
        store
            .upsert_peer(&PeerRecord {
                peer_id: "a".into(),
                last_seen: 2,
                online: false,
                client_name: None,
                alias: None,
                client_version: None,
                created_at: 1,
            })
            .unwrap();
        let peers = store.list_peers().unwrap();
        assert_eq!(peers[0].alias.as_deref(), Some("Alpha"));
        assert_eq!(peers[0].client_version.as_deref(), Some("9.9"));
    }

    /// set_peer_alias is the only path that clears an alias: both None and an empty string store NULL
    /// (authoritative sync after rename).
    #[test]
    fn set_peer_alias_sets_and_clears() {
        let store = fresh();
        store
            .upsert_peer(&PeerRecord {
                peer_id: "a".into(),
                last_seen: 1,
                online: true,
                client_name: None,
                alias: Some("old".into()),
                client_version: None,
                created_at: 1,
            })
            .unwrap();
        store.set_peer_alias("a", Some("new")).unwrap();
        assert_eq!(store.list_peers().unwrap()[0].alias.as_deref(), Some("new"));
        store.set_peer_alias("a", Some("")).unwrap();
        assert_eq!(store.list_peers().unwrap()[0].alias, None);
        store.set_peer_alias("a", None).unwrap();
        assert_eq!(store.list_peers().unwrap()[0].alias, None);
    }

    /// The v2 migration applies to old databases: after rolling schema_version back to 1, re-running
    /// migrate adds the alias / client_version columns and keeps existing rows.
    #[test]
    fn migrate_v2_adds_alias_columns() {
        let store = fresh();
        store
            .upsert_peer(&PeerRecord {
                peer_id: "legacy".into(),
                last_seen: 1,
                online: true,
                client_name: Some("c".into()),
                alias: None,
                client_version: None,
                created_at: 1,
            })
            .unwrap();
        {
            let conn = store.conn.lock().unwrap();
            // Simulate a legacy v1 database: the version log only has 1 and there are no v2 columns
            // (bundled SQLite ≥ 3.35 supports DROP COLUMN).
            conn.execute("DELETE FROM schema_version", []).unwrap();
            conn.execute("INSERT INTO schema_version (version) VALUES (1)", [])
                .unwrap();
            conn.execute("ALTER TABLE peers DROP COLUMN alias", []).unwrap();
            conn.execute("ALTER TABLE peers DROP COLUMN client_version", [])
                .unwrap();
        }
        store.migrate().unwrap();
        let peers = store.list_peers().unwrap();
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].peer_id, "legacy");
        assert_eq!(peers[0].alias, None);
        assert_eq!(peers[0].client_version, None);
    }

    /// Migration is idempotent (the app-restart reopen scenario): calling migrate repeatedly doesn't
    /// replay or error. schema_version is a migration log (one row per version, v1..v3);
    /// current version = MAX(version).
    #[test]
    fn migrate_is_idempotent_on_reopen() {
        let store = fresh();
        store.migrate().unwrap();
        store.migrate().unwrap();
        let conn = store.conn.lock().unwrap();
        let (n, v): (i64, i64) = conn
            .query_row(
                "SELECT COUNT(*), MAX(version) FROM schema_version",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((n, v), (4, 4));
    }

    /// The v3 migration applies to an existing v2 database: rolling the version log back and dropping
    /// the channel / thread_id columns makes migrate() re-add them without touching the stored rows.
    #[test]
    fn migrate_v3_adds_channel_columns() {
        let store = fresh();
        store
            .insert_message(&MessageRecord {
                id: "legacy".into(),
                from_peer: "alice".into(),
                to_peer: "grp-team".into(),
                kind: "chat".into(),
                content: r#"{"text":"hi"}"#.into(),
                ref_id: Some("m0".into()),
                channel: Some("grp-team".into()),
                thread_id: Some("thr-1".into()),
                ts: 1000,
                involved_me: true,
            })
            .unwrap();
        {
            let conn = store.conn.lock().unwrap();
            // Simulate a legacy v2 database: the log stops at 2 and the v3 columns don't exist yet.
            conn.execute("DELETE FROM schema_version", []).unwrap();
            conn.execute("INSERT INTO schema_version (version) VALUES (2)", [])
                .unwrap();
            conn.execute("ALTER TABLE messages DROP COLUMN channel", []).unwrap();
            conn.execute("ALTER TABLE messages DROP COLUMN thread_id", [])
                .unwrap();
        }
        store.migrate().unwrap();
        let msgs = store.list_all_messages(10).unwrap();
        assert_eq!(msgs.len(), 1);
        // The v2 row survives; the re-added columns are NULL for it and ref_id is untouched.
        assert_eq!(msgs[0].id, "legacy");
        assert_eq!(msgs[0].ref_id.as_deref(), Some("m0"));
        assert_eq!(msgs[0].channel, None);
        assert_eq!(msgs[0].thread_id, None);
        let conn = store.conn.lock().unwrap();
        let v: i64 = conn
            .query_row("SELECT MAX(version) FROM schema_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, 4);
    }

    /// The v4 migration applies to an existing v3 database: `unread.count` is dropped
    /// and the read watermark that sat next to it survives untouched.
    #[test]
    fn migrate_v4_drops_the_unread_counter() {
        let store = fresh();
        store.clear_unread("a", 1000).unwrap();
        {
            let conn = store.conn.lock().unwrap();
            // Recreate the legacy shape: the counter column back (with data, so a
            // migration that dropped the whole table instead of the column would be
            // caught), and the log rolled to 3 so the v4 step re-runs.
            conn.execute_batch(
                "ALTER TABLE unread ADD COLUMN count INTEGER NOT NULL DEFAULT 0;
                 UPDATE unread SET count = 7;
                 DELETE FROM schema_version;
                 INSERT INTO schema_version (version) VALUES (3);",
            )
            .unwrap();
            assert!(Store::column_exists(&conn, "unread", "count").unwrap());
        }
        store.migrate().unwrap();
        {
            let conn = store.conn.lock().unwrap();
            assert!(
                !Store::column_exists(&conn, "unread", "count").unwrap(),
                "the counter column is gone"
            );
            assert!(
                Store::column_exists(&conn, "unread", "last_read_ts").unwrap(),
                "the watermark column survives"
            );
        }
        // The row itself survived, watermark intact.
        let rows = store.list_unread().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].peer_id, "a");
        assert_eq!(rows[0].last_read_ts, Some(1000));
    }

    /// A database whose version log disagrees with its real schema (a partially applied migration, or
    /// a log rolled back by hand) must still open: the v3 probe skips the ALTERs instead of aborting
    /// migrate() with "duplicate column name".
    #[test]
    fn migrate_v3_tolerates_columns_without_version_row() {
        let store = fresh();
        {
            let conn = store.conn.lock().unwrap();
            conn.execute("DELETE FROM schema_version", []).unwrap();
            conn.execute("INSERT INTO schema_version (version) VALUES (2)", [])
                .unwrap();
        }
        // channel / thread_id still exist from the migrate() in open_in_memory.
        store.migrate().unwrap();
        let conn = store.conn.lock().unwrap();
        assert!(Store::column_exists(&conn, "messages", "channel").unwrap());
        assert!(Store::column_exists(&conn, "messages", "thread_id").unwrap());
        let v: i64 = conn
            .query_row("SELECT MAX(version) FROM schema_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, 4);
    }
    /// The claim "unread is persisted" is about a REAL file: the in-memory tests
    /// above prove the query, not that the watermark survives a restart. This
    /// closes and reopens the same database file, which is what the app does on
    /// every launch.
    #[test]
    fn unread_watermark_survives_reopen() {
        let path = std::env::temp_dir().join(format!("ach-unread-{}.sqlite", std::process::id()));
        let file = path.to_string_lossy().into_owned();
        let cleanup = || {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{file}{suffix}"));
            }
        };
        cleanup();
        {
            let store = Store::open(&path).unwrap();
            store.clear_unread("alice", 1_700_000_000_000).unwrap();
            store.clear_unread("bob", 1_700_000_000_500).unwrap();
        }
        {
            let store = Store::open(&path).unwrap();
            let rows = store.list_unread().unwrap();
            assert_eq!(rows.len(), 2, "both watermarks must come back");
            assert_eq!(rows[0].peer_id, "bob", "newest watermark first");
            assert_eq!(rows[0].last_read_ts, Some(1_700_000_000_500));
            assert_eq!(rows[1].peer_id, "alice");
            assert_eq!(rows[1].last_read_ts, Some(1_700_000_000_000));
        }
        cleanup();
    }

    /// File-backed variant of the v2 → v3 upgrade: the real app path is `Store::open` on an existing
    /// database file (WAL, sidecar files, rows already on disk), which the in-memory tests don't
    /// reach. The existing database must stay usable after the upgrade.
    #[test]
    fn open_upgrades_existing_v2_database_file() {
        let path = std::env::temp_dir().join(format!("ach-store-v3-{}.sqlite", std::process::id()));
        let file = path.to_string_lossy().into_owned();
        let cleanup = || {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{file}{suffix}"));
            }
        };
        cleanup();
        {
            // A v2-shaped database holding one row.
            let store = Store::open(&path).unwrap();
            store
                .insert_message(&MessageRecord {
                    id: "legacy-file".into(),
                    from_peer: "alice".into(),
                    to_peer: "grp-team".into(),
                    kind: "chat".into(),
                    content: r#"{"text":"hi","channel":"grp-team"}"#.into(),
                    ref_id: None,
                    channel: Some("grp-team".into()),
                    thread_id: Some("thr-9".into()),
                    ts: 1000,
                    involved_me: true,
                })
                .unwrap();
            let conn = store.conn.lock().unwrap();
            conn.execute("DELETE FROM schema_version", []).unwrap();
            conn.execute("INSERT INTO schema_version (version) VALUES (2)", [])
                .unwrap();
            conn.execute("ALTER TABLE messages DROP COLUMN channel", []).unwrap();
            conn.execute("ALTER TABLE messages DROP COLUMN thread_id", [])
                .unwrap();
        }
        // Reopen: the migration adds the columns and the stored row survives.
        let store = Store::open(&path).unwrap();
        let msgs = store.list_all_messages(10).unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].id, "legacy-file");
        assert_eq!(msgs[0].channel, None);
        assert_eq!(msgs[0].thread_id, None);
        // New rows on the upgraded file carry the values again.
        store
            .insert_message(&MessageRecord {
                id: "fresh".into(),
                from_peer: "alice".into(),
                to_peer: "grp-team".into(),
                kind: "chat".into(),
                content: r#"{"text":"hi"}"#.into(),
                ref_id: None,
                channel: Some("grp-team".into()),
                thread_id: Some("thr-10".into()),
                ts: 2000,
                involved_me: true,
            })
            .unwrap();
        let msgs = store.list_all_messages(10).unwrap();
        assert_eq!(msgs[0].id, "fresh");
        assert_eq!(msgs[0].channel.as_deref(), Some("grp-team"));
        assert_eq!(msgs[0].thread_id.as_deref(), Some("thr-10"));
        drop(store);
        cleanup();
    }

    #[test]
    fn insert_and_query_messages() {
        let store = fresh();
        for i in 0..5 {
            store
                .insert_message(&MessageRecord {
                    id: format!("m{i}"),
                    from_peer: "alice".into(),
                    to_peer: if i % 2 == 0 { "bob".into() } else { "agent-hub-cli".into() },
                    kind: "chat".into(),
                    content: r#"{"text":"hi"}"#.into(),
                    ref_id: None,
                    channel: if i == 0 { Some("grp-alpha".into()) } else { None },
                    thread_id: Some(format!("thr-{i}")),
                    ts: 1000 + i,
                    involved_me: i % 2 == 1,
                })
                .unwrap();
        }
        let msgs = store.list_messages_for_peer("alice", 10).unwrap();
        assert_eq!(msgs.len(), 5);
        // ORDER BY ts DESC, the first row is ts=1004
        assert_eq!(msgs[0].ts, 1004);
        // channel / thread_id survive the write-read round trip (v3 columns).
        assert_eq!(msgs[0].channel, None);
        assert_eq!(msgs[0].thread_id.as_deref(), Some("thr-4"));
        let oldest = msgs.iter().find(|m| m.id == "m0").unwrap();
        assert_eq!(oldest.channel.as_deref(), Some("grp-alpha"));
        assert_eq!(oldest.thread_id.as_deref(), Some("thr-0"));
        // The unfiltered archive view reads the same two columns back.
        let all = store.list_all_messages(10).unwrap();
        assert_eq!(all[4].id, "m0");
        assert_eq!(all[4].channel.as_deref(), Some("grp-alpha"));
        assert_eq!(store.count_messages().unwrap(), 5);
    }

    #[test]
    fn unread_read_state_roundtrip() {
        let store = fresh();
        // A peer the user never opened has nothing to restore. (This used to be
        // proved by writing a counter-only row through `bump_unread`; that counter
        // and its writer are gone — see the v4 migration — so the invariant is now
        // the simpler one: no watermark, no row.)
        assert!(store.list_unread().unwrap().is_empty());

        // The watermark IS what the frontend restores, including after reading to
        // zero: that is the whole point of persisting it.
        store.clear_unread("a", 1000).unwrap();
        let u = store.list_unread().unwrap();
        let a = u.iter().find(|r| r.peer_id == "a").expect("a cleared peer keeps its watermark");
        assert_eq!(a.last_read_ts, Some(1000));

        // Newest watermark first, so the frontend can apply them in order.
        store.clear_unread("b", 2000).unwrap();
        let u = store.list_unread().unwrap();
        assert_eq!(u.len(), 2);
        assert_eq!(u[0].peer_id, "b");
        assert_eq!(u[1].peer_id, "a");

        // Re-reading advances the watermark rather than inserting a second row.
        store.clear_unread("a", 3000).unwrap();
        let u = store.list_unread().unwrap();
        assert_eq!(u.len(), 2);
        assert_eq!(u.iter().find(|r| r.peer_id == "a").unwrap().last_read_ts, Some(3000));
    }

    #[test]
    fn config_set_get_roundtrip() {
        let store = fresh();
        assert!(store.get_config("missing").unwrap().is_none());
        store.set_config("max-queue", "200", 100).unwrap();
        let rec = store.get_config("max-queue").unwrap().unwrap();
        assert_eq!(rec.value, "200");
        store.set_config("max-queue", "500", 200).unwrap();
        let rec = store.get_config("max-queue").unwrap().unwrap();
        assert_eq!(rec.value, "500");
        assert_eq!(rec.updated_at, 200);
    }
}