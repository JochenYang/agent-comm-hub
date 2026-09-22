// Frontend → backend typed wrapper (thin wrapper around @tauri-apps/api).
// All future invokes go through here to avoid bare strings scattered across components.

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
  /** Optional field returned by hub bridge_peers / peers_changed (absent = none). */
  alias?: string
  clientName?: string
  clientVersion?: string
  lastSeenMs?: number
}

/** SQLite peer row returned by roster_list (includes offline known peers, used to restore the roster from before a restart). */
export interface RosterRecord {
  peer_id: string
  last_seen: number
  online: boolean
  client_name: string | null
  alias: string | null
  client_version: string | null
  created_at: number
}

/** bridge_rename result: alias is absent when cleared; previousId exists only on an id re-key. */
export interface RenameResult {
  ok: boolean
  peerId: string
  alias?: string
  previousId?: string
}

/** bridge_unregister (with peer = manager kick) result: kicked=false when the target does not exist. */
export interface UnregisterPeerResult {
  ok: boolean
  peerId: string | null
  kicked: boolean
  detachedSessions?: number
}

export interface BridgePeersResult {
  peers: Peer[]
}

/** Aligned with BridgeMessage in hub src/protocol.ts (for frontend display). */
export interface PresentedMessage {
  id: string
  from: string
  to: string
  kind: 'chat' | 'task' | 'ack' | 'notice'
  content: string | TaskContent | AckContent
  ref?: string
  /** Group channel id (present on group-routed messages; hub >= 0.6). */
  channel?: string
  /** Conversation / workflow thread id (hub >= 0.9). */
  threadId?: string
  ts: number
}

export interface TaskContent {
  prompt: string
  context?: string
  deliverable?: string
  timeoutMs?: number
  threadId?: string
}

export type AckStatus = 'accepted' | 'working' | 'rejected' | 'done' | 'failed'
export type TaskStatus = 'pending' | 'accepted' | 'working' | 'rejected' | 'done' | 'failed' | 'timeout'

export interface AckContent {
  status: AckStatus
  note?: string
  progress?: number
}

export interface TaskAckEvent {
  from: string
  status: AckStatus
  note?: string
  progress?: number
  ts: number
  messageId: string
  applied: boolean
  system?: boolean
}

export interface AssigneeState {
  peerId: string
  status: TaskStatus
  deliveredMs?: number
  acks: TaskAckEvent[]
}

export interface TaskRecord {
  id: string
  from: string
  to: string
  prompt: string
  context?: string
  deliverable?: string
  status: TaskStatus
  acks: TaskAckEvent[]
  assignees: AssigneeState[]
  timeoutMs?: number
  deadlineAt?: number
  threadId?: string
  createdAt: number
  updatedAt: number
}

export interface BridgeHistoryResult {
  messages: PresentedMessage[]
}

/** SQLite record returned by history_local (content is the full message JSON string). */
export interface LocalMessageRecord {
  id: string
  from: string
  to: string
  kind: string
  content: string
  ref: string | null
  ts: number
}

/** bridge_wait result: a matched message or a timeout. */
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
  /** Present on ack receipts (the acknowledged message id). */
  ref?: string
  /** Present on group-send receipts. */
  channel?: string
  /** Present when the send carried a thread id. */
  threadId?: string
  ts: number
}

export interface UnreadRecord {
  peer_id: string
  count: number
  last_read_ts: number | null
}

// herdr types (mirroring the Rust herdr_client)

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
  /** Remote-mode bearer token (connection-level; empty = local loopback hub). */
  auth_token: string
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
    bridgeRename: (peer: string | null, alias: string | null, newPeerId?: string | null) =>
      tauriInvoke<RenameResult>('bridge_rename', { peer: peer ?? null, alias: alias ?? null, newPeerId: newPeerId ?? null }),
    bridgeUnregisterPeer: (peer: string) =>
      tauriInvoke<UnregisterPeerResult>('bridge_unregister_peer', { peer }),
    rosterList: () => tauriInvoke<RosterRecord[]>('roster_list'),
    rosterForget: (peerId: string) =>
      tauriInvoke<void>('roster_forget', { peerId }),
    bridgeStatus: () => tauriInvoke<unknown>('bridge_status'),
    bridgeWait: (timeoutMs?: number, from?: string, ref?: string, threadId?: string) =>
      tauriInvoke<WaitResult>('bridge_wait', {
        timeoutMs: timeoutMs ?? null,
        from: from ?? null,
        ref: ref ?? null,
        threadId: threadId ?? null
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
    bridgeChat: (to: string, message: string, threadId?: string) =>
      tauriInvoke<ChatReceipt>('bridge_chat', { to, message, threadId: threadId ?? null }),
    bridgeTask: (
      to: string,
      prompt: string,
      context?: string,
      deliverable?: string,
      timeoutMs?: number,
      threadId?: string
    ) =>
      tauriInvoke<ChatReceipt>('bridge_task', {
        to,
        prompt,
        context: context ?? null,
        deliverable: deliverable ?? null,
        timeoutMs: timeoutMs ?? null,
        threadId: threadId ?? null
      }),
    bridgeAck: (refId: string, status: AckContent['status'], note?: string, progress?: number) =>
      tauriInvoke<ChatReceipt>('bridge_ack', {
        refId,
        status,
        note: note ?? null,
        progress: progress ?? null
      }),
    bridgeTasks: (role?: 'sent' | 'received' | 'all', status?: TaskStatus, limit?: number) =>
      tauriInvoke<{ tasks: TaskRecord[] }>('bridge_tasks', {
        role: role ?? null,
        status: status ?? null,
        limit: limit ?? null
      }),
    bridgeTaskStatus: (ref: string) =>
      tauriInvoke<{ task: TaskRecord }>('bridge_task_status', { refId: ref }),
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
    /** Hub SSE-pushed message (the Rust side forwards notifications/message → Tauri `hub:message`). */
    onHubMessage: (handler: (msg: PresentedMessage) => void): Promise<UnlistenFn> =>
      tauriListen<PresentedMessage>('hub:message', (e) => handler(e.payload)),
    /** Hub SSE peers_changed → Tauri `hub:peers`: payload is the full roster (Peer array). */
    onHubPeers: (handler: (peers: Peer[]) => void): Promise<UnlistenFn> =>
      tauriListen<Peer[]>('hub:peers', (e) => handler(Array.isArray(e.payload) ? e.payload : []))
  }
}