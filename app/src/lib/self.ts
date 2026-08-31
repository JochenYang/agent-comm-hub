// This end (desktop GUI) peer id in the hub — the hub's default manager peer (managerPeers).
// Kept in sync with SELF_PEER_ID in the Rust side src-tauri/src/commands.rs (historically it
// was 'agent-comm-hub-cli', that old identity is only kept in the backend's history_local
// compatibility queries).
export const SELF_PEER_ID = 'agent-hub-cli'
