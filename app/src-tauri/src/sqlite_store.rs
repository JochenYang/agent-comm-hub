//! T-1.5 SQLite 持久化层（M2 T-2.6 接入）
//!
//! 同步 rusqlite API，store: Arc<Store> 在 AppState 里持有，commands 直接同步调 CRUD
//! （CRUD 单次 <1ms，spawn_blocking 不必要）。
//!
//! Schema（SPEC §5.3）：
//! - config(key, value, updated_at)
//! - peers(peer_id, last_seen, online, client_name, created_at)
//! - messages(id, from_peer, to_peer, kind, content, ref_id, ts, involved_me) + ts DESC 索引 + involved_me 索引
//! - unread(peer_id, count, last_read_ts)
//! - schema_version(version) — 单版本迁移记录
//!
//! 设计要点：
//! - 同步 rusqlite API（连接走 std::sync::Mutex 串行化）
//! - WAL 模式 + synchronous=NORMAL（写性能与崩溃安全折中）
//! - FK 启用（虽然当前 schema 没用 FK，但保持默认安全）
//! - 单一 migrate()：v1 = 全部表；后续版本追加 if current < N 分支

// 此模块所有 pub fn / struct 都通过 `tauri::generate_handler!` 字符串派发到 invoke_handler,
// Rust 的 dead_code lint 看不到宏展开 —— 顶层关掉,避免 M3 接 peer / message 写入时反复报 warning。
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
    pub ts: i64,
    pub involved_me: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnreadRecord {
    pub peer_id: String,
    pub count: i64,
    pub last_read_ts: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigRecord {
    pub key: String,
    pub value: String,
    pub updated_at: i64,
}

/// SQLite 存储（线程安全，单连接）。
/// M2 在 start_hub 路径里 open + manage；commands 走 spawn_blocking 调 CRUD。
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
        let current: Option<i64> = tx
            .query_row("SELECT version FROM schema_version LIMIT 1", [], |row| {
                row.get(0)
            })
            .optional()?;
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
                INSERT OR REPLACE INTO schema_version (version) VALUES (1);
                "#,
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    // ---- peers ----

    pub fn upsert_peer(&self, peer: &PeerRecord) -> Result<()> {
        let conn = self.conn.lock()?;
        conn.execute(
            "INSERT INTO peers (peer_id, last_seen, online, client_name, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(peer_id) DO UPDATE SET
               last_seen = excluded.last_seen,
               online = excluded.online,
               client_name = COALESCE(excluded.client_name, peers.client_name)",
            params![
                peer.peer_id,
                peer.last_seen,
                peer.online as i64,
                peer.client_name,
                peer.created_at
            ],
        )?;
        Ok(())
    }

    pub fn list_peers(&self) -> Result<Vec<PeerRecord>> {
        let conn = self.conn.lock()?;
        let mut stmt = conn.prepare(
            "SELECT peer_id, last_seen, online, client_name, created_at
             FROM peers ORDER BY last_seen DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(PeerRecord {
                peer_id: row.get(0)?,
                last_seen: row.get(1)?,
                online: row.get::<_, i64>(2)? != 0,
                client_name: row.get(3)?,
                created_at: row.get(4)?,
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
                (id, from_peer, to_peer, kind, content, ref_id, ts, involved_me)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                msg.id,
                msg.from_peer,
                msg.to_peer,
                msg.kind,
                msg.content,
                msg.ref_id,
                msg.ts,
                msg.involved_me as i64
            ],
        )?;
        Ok(())
    }

    pub fn list_messages_for_peer(&self, peer_id: &str, limit: i64) -> Result<Vec<MessageRecord>> {
        let conn = self.conn.lock()?;
        let mut stmt = conn.prepare(
            "SELECT id, from_peer, to_peer, kind, content, ref_id, ts, involved_me
             FROM messages
             WHERE from_peer = ?1 OR to_peer = ?1 OR involved_me = 1
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
                ts: row.get(6)?,
                involved_me: row.get::<_, i64>(7)? != 0,
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

    pub fn bump_unread(&self, peer_id: &str) -> Result<()> {
        let conn = self.conn.lock()?;
        conn.execute(
            "INSERT INTO unread (peer_id, count) VALUES (?1, 1)
             ON CONFLICT(peer_id) DO UPDATE SET count = count + 1",
            params![peer_id],
        )?;
        Ok(())
    }

    pub fn clear_unread(&self, peer_id: &str, last_read_ts: i64) -> Result<()> {
        let conn = self.conn.lock()?;
        conn.execute(
            "INSERT INTO unread (peer_id, count, last_read_ts) VALUES (?1, 0, ?2)
             ON CONFLICT(peer_id) DO UPDATE SET count = 0, last_read_ts = ?2",
            params![peer_id, last_read_ts],
        )?;
        Ok(())
    }

    pub fn list_unread(&self) -> Result<Vec<UnreadRecord>> {
        let conn = self.conn.lock()?;
        let mut stmt = conn.prepare(
            "SELECT peer_id, count, last_read_ts FROM unread
             WHERE count > 0 ORDER BY last_read_ts DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(UnreadRecord {
                peer_id: row.get(0)?,
                count: row.get(1)?,
                last_read_ts: row.get(2)?,
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
                created_at: 50,
            })
            .unwrap();
        store
            .upsert_peer(&PeerRecord {
                peer_id: "codex".into(),
                last_seen: 90,
                online: false,
                client_name: None,
                created_at: 40,
            })
            .unwrap();
        let peers = store.list_peers().unwrap();
        assert_eq!(peers.len(), 2);
        assert_eq!(peers[0].peer_id, "claude");
        assert!(peers[0].online);
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
                created_at: 1,
            })
            .unwrap();
        store
            .upsert_peer(&PeerRecord {
                peer_id: "x".into(),
                last_seen: 2,
                online: true,
                client_name: Some("client-x".into()),
                created_at: 1,
            })
            .unwrap();
        let peers = store.list_peers().unwrap();
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].last_seen, 2);
        assert!(peers[0].online);
        assert_eq!(peers[0].client_name.as_deref(), Some("client-x"));
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
                    ts: 1000 + i,
                    involved_me: i % 2 == 1,
                })
                .unwrap();
        }
        let msgs = store.list_messages_for_peer("alice", 10).unwrap();
        assert_eq!(msgs.len(), 5);
        // ORDER BY ts DESC，第一条 ts=1004
        assert_eq!(msgs[0].ts, 1004);
        assert_eq!(store.count_messages().unwrap(), 5);
    }

    #[test]
    fn unread_bump_and_clear() {
        let store = fresh();
        store.bump_unread("a").unwrap();
        store.bump_unread("a").unwrap();
        store.bump_unread("b").unwrap();
        let u = store.list_unread().unwrap();
        assert_eq!(u.len(), 2);
        assert_eq!(u.iter().find(|r| r.peer_id == "a").unwrap().count, 2);
        assert_eq!(u.iter().find(|r| r.peer_id == "b").unwrap().count, 1);

        // 清空 a 后，list_unread（过滤 count > 0）应不再返回 a；b 仍在。
        store.clear_unread("a", 1000).unwrap();
        let u = store.list_unread().unwrap();
        assert!(
            u.iter().find(|r| r.peer_id == "a").is_none(),
            "cleared peer should not appear in unread list"
        );
        assert_eq!(u.iter().find(|r| r.peer_id == "b").unwrap().count, 1);
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