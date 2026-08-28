// 前端 → 后端 typed wrapper（薄封装 @tauri-apps/api）。
// 后续所有 invoke 都走这里，避免裸字符串在组件里散落。

import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { listen as tauriListen, type UnlistenFn } from '@tauri-apps/api/event'

export type HubState = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed'

export interface HubStatus {
  state: HubState
  pid: number | null
  url: string
  host: string
  port: number
  path: string
  started_at: number | null
  last_error: string | null
}

export interface LogLine {
  stream: 'stdout' | 'stderr'
  line: string
  ts: number
}

export interface Peer {
  id: string
  connected: boolean
  /** hub bridge_peers / peers_changed 回传的可选字段（缺省 = 无）。 */
  alias?: string
  clientName?: string
  clientVersion?: string
  lastSeenMs?: number
}

/** roster_list 返回的 SQLite peer 行（含 offline 已知 peer，用于恢复重启前花名册）。 */
export interface RosterRecord {
  peer_id: string
  last_seen: number
  online: boolean
  client_name: string | null
  alias: string | null
  client_version: string | null
  created_at: number
}

/** bridge_rename 结果：alias 清除时缺省。 */
export interface RenameResult {
  ok: boolean
  peerId: string
  alias?: string
}

/** bridge_unregister（带 peer = 管理端踢人）结果：目标不存在时 kicked=false。 */
export interface UnregisterPeerResult {
  ok: boolean
  peerId: string | null
  kicked: boolean
  detachedSessions?: number
}

export interface BridgePeersResult {
  peers: Peer[]
}

/** 与 hub src/protocol.ts 的 BridgeMessage 对齐（前端展示用）。 */
export interface PresentedMessage {
  id: string
  from: string
  to: string
  kind: 'chat' | 'task' | 'ack' | 'notice'
  content: string | TaskContent | AckContent
  ref?: string
  ts: number
}

export interface TaskContent {
  prompt: string
  context?: string
  deliverable?: string
}

export interface AckContent {
  status: 'accepted' | 'rejected' | 'done' | 'failed'
  note?: string
}

export interface BridgeHistoryResult {
  messages: PresentedMessage[]
}

/** history_local 返回的 SQLite 记录（content 是完整消息 JSON 字符串）。 */
export interface LocalMessageRecord {
  id: string
  from: string
  to: string
  kind: string
  content: string
  ref: string | null
  ts: number
}

/** bridge_wait 的返回：命中消息或超时。 */
export interface WaitResult {
  type: 'message' | 'timeout'
  message?: PresentedMessage
  waitedMs?: number
}

export interface ChatReceipt {
  ok: boolean
  id: string
  from: string
  to: string
  kind: string
  ts: number
}

export interface UnreadRecord {
  peer_id: string
  count: number
  last_read_ts: number | null
}

// herdr types（与 Rust herdr_client 镜像）

export type HerdrAgentStatus =
  | 'idle'
  | 'working'
  | 'blocked'
  | 'done'
  | 'unknown'

export interface HerdrAgent {
  paneId: string
  tabId: string
  terminalId: string
  name: string | null
  agent: string | null
  displayAgent: string | null
  status: HerdrAgentStatus
  cwd: string | null
  focused: boolean
  interactiveReady: boolean
  launchPending: boolean
  terminalTitle: string | null
  revision: number
}

export interface HerdrPane {
  paneId: string
  tabId: string
  workspaceId: string
  terminalId: string
  title: string | null
  agentStatus: HerdrAgentStatus
  cwd: string | null
  focused: boolean
  revision: number
}

export interface HerdrRead {
  paneId: string
  tabId: string
  workspaceId: string | null
  source: string
  text: string
  revision: number
  truncated: boolean
}

export interface HerdrSettled {
  paneId: string
  status: HerdrAgentStatus
  waitedMs: number | null
}

export interface HubConfigValues {
  host: string
  port: number
  path: string
  max_queue: number
  history_limit: number
  wait_timeout_ms: number
  default_wait_ms: number
  connected_window_ms: number
  peer_idle_timeout_ms: number
  herdr_bin: string
  herdr_timeout_ms: number
}

export const tauri = {
  invoke: {
    hubStart: () => tauriInvoke<HubStatus>('hub_start'),
    hubStop: () => tauriInvoke<HubStatus>('hub_stop'),
    hubRestart: () => tauriInvoke<HubStatus>('hub_restart'),
    hubStatus: () => tauriInvoke<HubStatus>('hub_status'),
    hubGetLogs: () => tauriInvoke<LogLine[]>('hub_get_logs'),
    appReady: () => tauriInvoke<HubStatus>('app_ready'),
    quitApp: () => tauriInvoke<void>('quit_app'),
    bridgePeers: () => tauriInvoke<BridgePeersResult>('bridge_peers'),
    bridgeRename: (peer: string | null, alias: string) =>
      tauriInvoke<RenameResult>('bridge_rename', { peer: peer ?? null, alias }),
    bridgeUnregisterPeer: (peer: string) =>
      tauriInvoke<UnregisterPeerResult>('bridge_unregister_peer', { peer }),
    rosterList: () => tauriInvoke<RosterRecord[]>('roster_list'),
    rosterForget: (peerId: string) =>
      tauriInvoke<void>('roster_forget', { peerId }),
    bridgeStatus: () => tauriInvoke<unknown>('bridge_status'),
    bridgeWait: (timeoutMs?: number, from?: string) =>
      tauriInvoke<WaitResult>('bridge_wait', {
        timeoutMs: timeoutMs ?? null,
        from: from ?? null
      }),
    bridgeHistory: (peer?: string, limit?: number) =>
      tauriInvoke<BridgeHistoryResult>('bridge_history', {
        peer: peer ?? null,
        limit: limit ?? null
      }),
    historyLocal: (peer?: string, limit?: number) =>
      tauriInvoke<{ messages: LocalMessageRecord[] }>('history_local', {
        peer: peer ?? null,
        limit: limit ?? null
      }),
    bridgeChat: (to: string, message: string) =>
      tauriInvoke<ChatReceipt>('bridge_chat', { to, message }),
    bridgeTask: (
      to: string,
      prompt: string,
      context?: string,
      deliverable?: string
    ) =>
      tauriInvoke<ChatReceipt>('bridge_task', {
        to,
        prompt,
        context: context ?? null,
        deliverable: deliverable ?? null
      }),
    bridgeAck: (refId: string, status: AckContent['status'], note?: string) =>
      tauriInvoke<ChatReceipt>('bridge_ack', {
        refId,
        status,
        note: note ?? null
      }),
    configGet: () => tauriInvoke<Record<string, unknown>>('config_get'),
    configSet: (values: Record<string, unknown>) =>
      tauriInvoke<void>('config_set', { values }),
    hubRestartWithSavedConfig: () =>
      tauriInvoke<HubStatus>('hub_restart_with_saved_config'),
    serviceInstall: () =>
      tauriInvoke<{ ok: boolean; action: string; output: string }>('service_install'),
    serviceUninstall: () =>
      tauriInvoke<{ ok: boolean; action: string; output: string }>('service_uninstall'),
    hubCliVersion: () =>
      tauriInvoke<{ ok: boolean; version: string }>('hub_cli_version'),
    hubCliCheckUpdate: () =>
      tauriInvoke<{ ok: boolean; current: string; latest: string; outdated: boolean }>(
        'hub_cli_check_update'
      ),
    hubCliUpdate: () =>
      tauriInvoke<{ ok: boolean; output: string }>('hub_cli_update'),
    hubCliInstall: () =>
      tauriInvoke<{ ok: boolean; output: string }>('hub_cli_install'),
    hubCliSetup: () =>
      tauriInvoke<{ ok: boolean; output: string }>('hub_cli_setup'),
    unreadList: () => tauriInvoke<UnreadRecord[]>('unread_list'),
    unreadClear: (peerId: string) =>
      tauriInvoke<void>('unread_clear', { peerId }),
    // herdr
    herdrIsAvailable: () => tauriInvoke<boolean>('herdr_is_available'),
    herdrAgentList: () => tauriInvoke<HerdrAgent[]>('herdr_agent_list'),
    herdrAgentStatus: (target: string) =>
      tauriInvoke<HerdrAgent>('herdr_agent_status', { target }),
    herdrAgentPrompt: (
      target: string,
      text: string,
      wait: boolean,
      until?: string,
      timeoutMs?: number
    ) =>
      tauriInvoke<HerdrSettled | null>('herdr_agent_prompt', {
        target,
        text,
        wait,
        until: until ?? null,
        timeoutMs: timeoutMs ?? null
      }),
    herdrAgentWait: (target: string, until?: string, timeoutMs?: number) =>
      tauriInvoke<HerdrSettled | null>('herdr_agent_wait', {
        target,
        until: until ?? null,
        timeoutMs: timeoutMs ?? null
      }),
    herdrAgentRead: (target: string, lines?: number) =>
      tauriInvoke<HerdrRead>('herdr_agent_read', { target, lines: lines ?? null }),
    herdrAgentKeys: (target: string, keys: string[]) =>
      tauriInvoke<void>('herdr_agent_keys', { target, keys }),
    herdrPaneList: () => tauriInvoke<HerdrPane[]>('herdr_pane_list'),
    herdrPaneSendText: (target: string, text: string) =>
      tauriInvoke<void>('herdr_pane_send_text', { target, text }),
    herdrPaneSendKeys: (target: string, keys: string[]) =>
      tauriInvoke<void>('herdr_pane_send_keys', { target, keys }),
    herdrPaneRead: (target: string, lines?: number) =>
      tauriInvoke<HerdrRead>('herdr_pane_read', { target, lines: lines ?? null }),
    herdrPaneWaitForOutput: (
      target: string,
      matchType: string,
      matchValue: string,
      timeoutMs?: number
    ) =>
      tauriInvoke<HerdrRead | null>('herdr_pane_wait_for_output', {
        target,
        matchType,
        matchValue,
        timeoutMs: timeoutMs ?? null
      })
  },
  event: {
    onHubState: (handler: (status: HubStatus) => void): Promise<UnlistenFn> =>
      tauriListen<HubStatus>('hub:state', (e) => handler(e.payload)),
    /** hub SSE 推送的消息（Rust 侧转发 notifications/message → Tauri `hub:message`）。 */
    onHubMessage: (handler: (msg: PresentedMessage) => void): Promise<UnlistenFn> =>
      tauriListen<PresentedMessage>('hub:message', (e) => handler(e.payload)),
    /** hub SSE peers_changed → Tauri `hub:peers`：payload 是完整花名册（Peer 数组）。 */
    onHubPeers: (handler: (peers: Peer[]) => void): Promise<UnlistenFn> =>
      tauriListen<Peer[]>('hub:peers', (e) => handler(Array.isArray(e.payload) ? e.payload : []))
  }
}