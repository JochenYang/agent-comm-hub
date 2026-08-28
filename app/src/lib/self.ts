// 本端（桌面 GUI）在 hub 里的 peer id —— hub 默认管理端（managerPeers）。
// 与 Rust 侧 src-tauri/src/commands.rs 的 SELF_PEER_ID 保持一致（历史上曾是
// 'agent-comm-hub-cli'，该旧身份仅在后端 history_local 的兼容查询里保留）。
export const SELF_PEER_ID = 'agent-hub-cli'
