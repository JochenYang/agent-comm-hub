/**
 * Bridge tools exposed to every MCP client. All results are lossless JSON
 * (the DSH tool registry contract; kept strict here so the hub is usable
 * from DSH's native tool layer too). Sender identity comes from the
 * session→peer binding established by `bridge_register`.
 */

import type { AgentHub } from './hub.js'
import type { McpTool, SessionRegistry } from './mcp-server.js'
import { AGENT_STATUSES, type HerdrCtl } from './herdr-ctl.js'
import { decodeContent, type AckContent, type BridgeMessage, BROADCAST, PEER_ID_PATTERN, type TaskContent } from './protocol.js'
import { ANON_JOIN_PEER } from './auth.js'

/** Default wait budget when a client omits timeoutMs. */
export const DEFAULT_WAIT_MS = 30_000

/** Message presented to a model: task/ack payloads decoded to objects.
 *  Undefined `ref` is dropped — lossy JSON values are rejected by strict
 *  tool registries (e.g. DSH's lossless-JSON validation). */
export type PresentedMessage = Omit<BridgeMessage, 'content'> & { content: string | TaskContent | AckContent }

export function present(message: BridgeMessage): PresentedMessage {
  const { ref, channel, ...rest } = message
  return {
    ...rest,
    ...(ref !== undefined ? { ref } : {}),
    ...(channel !== undefined ? { channel } : {}),
    content: decodeContent(message.kind, message.content),
  }
}

/** Sanitize a client-reported name into a valid peer id base. */
export function sanitizePeerId(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return cleaned === '' ? 'agent' : cleaned
}

/** Validate a display alias: trimmed, 1–64 chars, no control characters.
 * Unlike peer ids, aliases may contain spaces / CJK — they are only shown,
 * never routed or used as a Map key. */
export function sanitizeAlias(alias: string): string {
  const cleaned = alias.trim()
  if (cleaned === '') throw new Error('alias must not be empty')
  if (cleaned.length > 64) throw new Error(`alias too long: ${cleaned.length} chars (max 64)`)
  if (/[\u0000-\u001f\u007f]/.test(cleaned)) throw new Error('alias must not contain control characters')
  return cleaned
}

/**
 * Auto-register a session. In remote auth mode the session's TOKEN decides
 * the peer id (each token maps to one identity — two people running the same
 * client stay two peers instead of sharing a mailbox); loopback mode keeps
 * deriving the id from the client-reported name. Same-id connections ATTACH
 * to the same peer (N:1, one stable identity per agent). No-op when the
 * session is already bound or explicitly unregistered. Returns the peer id.
 */
export function autoRegisterPeer(
  hub: AgentHub,
  registry: SessionRegistry,
  sessionId: string | undefined,
  clientName: string | undefined,
  clientVersion?: string,
): string | undefined {
  if (sessionId === undefined) return undefined
  const bound = registry.peerFor(sessionId)
  if (bound !== undefined) return bound
  if (registry.isSuppressed(sessionId)) return undefined
  const tokenPeer = registry.tokenFor(sessionId)?.peer
  // Sentinel = anonymous walk-in whose initialize-resolution never ran (e.g.
  // it started from an SSE stream): give it a session-unique fallback id so
  // it can never merge with another walk-in.
  const peerId = tokenPeer === ANON_JOIN_PEER
    ? `join-${sanitizePeerId(clientName ?? 'agent')}-${Math.random().toString(36).slice(2, 6)}`
    : (tokenPeer ?? sanitizePeerId(clientName ?? 'agent'))
  if (!hub.has(peerId)) {
    hub.register(peerId, {
      ...(clientName !== undefined ? { name: clientName } : {}),
      ...(clientVersion !== undefined ? { version: clientVersion } : {}),
    })
  }
  registry.bindPeer(sessionId, peerId)
  hub.touch(peerId)
  return peerId
}

/** Peers whose session has a live SSE stream (count as connected, GC-safe). */
export function livePeersFor(registry: SessionRegistry): Set<string> {
  const live = new Set<string>()
  const streams = registry.liveSessions()
  for (const [sessionId, peerId] of registry.peerBindings) {
    if (streams.has(sessionId)) live.add(peerId)
  }
  return live
}

/** Roster snapshot: live state per peer merged with its profile metadata.
 * Shared by the bridge_peers tool and the `peers_changed` SSE event so both
 * always expose the same shape. */
export function rosterFor(hub: AgentHub, registry: SessionRegistry): Array<Record<string, unknown>> {
  const status = hub.status(livePeersFor(registry))
  // Realtime, per-session metadata synthesized from the registry (never
  // persisted): source IP(s) and the anonymous-join flag let the admin roster
  // tell Zhang San's kimi-code from Li Si's and spot walk-ins to claim.
  const peerIps = new Map<string, string[]>()
  const peerAnon = new Map<string, boolean>()
  for (const [session, peer] of registry.peerBindings) {
    const ip = registry.sessionIps.get(session)
    if (ip !== undefined) {
      const list = peerIps.get(peer) ?? []
      if (!list.includes(ip)) list.push(ip)
      peerIps.set(peer, list)
    }
    const identity = registry.tokenFor(session)
    if (identity?.anonymous === true) peerAnon.set(peer, true)
  }
  return status.peers.map(peer => {
    const profile = hub.profileOf(peer.id)
    const alias = profile?.alias
    const clientName = profile?.clientName
    const clientVersion = profile?.clientVersion
    const ips = peerIps.get(peer.id)
    return {
      id: peer.id,
      ...(alias !== undefined ? { alias } : {}),
      ...(clientName !== undefined ? { clientName } : {}),
      ...(clientVersion !== undefined ? { clientVersion } : {}),
      ...(peerAnon.get(peer.id) === true ? { anonymous: true } : {}),
      ...(ips !== undefined && ips.length > 0 ? { clientIps: ips } : {}),
      connected: peer.connected,
      lastSeenMs: peer.lastSeenMs,
    }
  })
}

/** Options accepted by {@link hubTools}. */
export interface HubToolsOptions {
  defaultWaitMs?: number
  waitTimeoutMs: number
  /** herdr control adapter; when omitted the bridge_agent_* tools error out
   * with "herdr control not enabled". */
  herdr?: HerdrCtl
  /** Peers allowed to use the control tools (bridge_agent_*). `'all'`
   * (default) mirrors the hub's loopback-only trust model; pass a set of
   * peer ids to restrict who may type into agent terminals. */
  herdrControlPeers?: ReadonlySet<string> | 'all'
  /** Peers allowed to manage the roster: rename other peers (bridge_rename),
   * kick peers (bridge_unregister with `peer`). `'all'` keeps the loopback
   * trust model; the default is the desktop/CLI archiver identity. */
  managerPeers?: ReadonlySet<string> | 'all'
}

/** Build the bridge tool set bound to one hub instance. */
export function hubTools(hub: AgentHub, registry: SessionRegistry, options: HubToolsOptions): McpTool[] {

  const schema = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  })
  const str = (description: string): Record<string, unknown> => ({ type: 'string', description })
  const int = (description: string): Record<string, unknown> => ({ type: 'integer', description })
  const optStr = str

  /**
   * Resolve the calling peer. Unregistered sessions auto-register using the
   * client-reported name (from the MCP initialize clientInfo) unless the
   * session explicitly unregistered — connecting the MCP is enough to join.
   */
  const requirePeer = (sessionId: string | undefined): string => {
    const bound = registry.peerFor(sessionId)
    if (bound !== undefined) {
      hub.touch(bound)
      return bound
    }
    const auto = autoRegisterPeer(hub, registry, sessionId, registry.clientName(sessionId))
    if (auto !== undefined) {
      hub.touch(auto)
      return auto
    }
    throw new Error('not registered — call bridge_register(peerId) first')
  }

  const receipt = (message: BridgeMessage): unknown => ({
    ok: true,
    id: message.id,
    from: message.from,
    to: message.to,
    kind: message.kind,
    ...(message.channel !== undefined ? { channel: message.channel } : {}),
    ts: message.ts,
  })

  const presentWait = (result: { type: 'message'; message: BridgeMessage } | { type: 'timeout'; waitedMs: number }): unknown =>
    result.type === 'timeout' ? result : { type: 'message', message: present(result.message) }

  /**
   * Gate the control tools (bridge_agent_*): they type into real terminals,
   * so they are stricter than message tools. `'all'` keeps the hub's
   * loopback-only trust model; an explicit peer set narrows who may control.
   */
  const checkControl = (peer: string): HerdrCtl => {
    const herdr = options.herdr
    if (herdr === undefined) {
      throw new Error('herdr control not enabled — start the hub with --herdr-bin or pass a herdrCtl to hubTools')
    }
    const control = options.herdrControlPeers ?? 'all'
    if (control !== 'all' && !control.has(peer)) {
      throw new Error(`peer '${peer}' is not allowed to use bridge_agent_* tools`)
    }
    return herdr
  }

  /** Manager gate for roster administration (rename others / kick / read
   * other peers' history). Two paths grant it: a token with role 'manager'
   * (remote auth mode — authenticated), or membership of `managerPeers`
   * (loopback convention). Without remote auth this stays a convention,
   * not authentication. */
  const requireManager = (peer: string, action: string, sessionId?: string): void => {
    if (registry.tokenFor(sessionId)?.role === 'manager') return
    const managers = options.managerPeers ?? 'all'
    if (managers !== 'all' && !managers.has(peer)) {
      throw new Error(`peer '${peer}' is not a hub manager — ${action} requires manager rights`)
    }
  }

  /** Normalize an `until` array argument into herdr statuses (invalid
   * entries are dropped; absent/empty means herdr's default settle set). */
  const asStatuses = (value: unknown): (typeof AGENT_STATUSES)[number][] | undefined => {
    if (!Array.isArray(value)) return undefined
    const statuses = value.map(String).filter(status => (AGENT_STATUSES as readonly string[]).includes(status))
    return statuses.length > 0 ? (statuses as (typeof AGENT_STATUSES)[number][]) : undefined
  }

  const wrap = (peerAware: boolean, handler: (args: Record<string, unknown>, peer: string, sessionId: string | undefined) => Promise<unknown>): McpTool['handler'] =>
    async (args, sessionId) => {
      const peer = peerAware ? requirePeer(sessionId) : ''
      return handler(args, peer, sessionId)
    }

  return [
    {
      name: 'bridge_register',
      description: 'Claim or rename your identity on the hub. Sessions auto-share a peer id derived from the client name; call this to switch to a readable unique peerId such as "mavis" or "opencode:myproject". Optionally set your display alias (shown to other agents and the desktop roster; message routing keeps using the immutable peerId). Rejects when the id is claimed by another connection. Returns the current peer list.',
      inputSchema: schema({
        peerId: str('Unique peer id: letters/digits/._:- , 1-64 chars.'),
        alias: optStr('Optional display name (1-64 chars, spaces/CJK allowed). Routing still uses peerId.'),
      }, ['peerId']),
      handler: async (args, sessionId) => {
        const peerId = String(args.peerId)
        if (!PEER_ID_PATTERN.test(peerId)) {
          throw new Error(`invalid peerId: ${peerId} (expected [A-Za-z0-9._:-]{1,64})`)
        }
        if (peerId === BROADCAST) {
          throw new Error(`reserved peer id: ${peerId} (it is the broadcast address)`)
        }
        const alias = args.alias === undefined ? undefined : sanitizeAlias(String(args.alias))
        const tokenPeer = registry.tokenFor(sessionId)?.peer
        if (tokenPeer !== undefined && peerId !== tokenPeer) {
          // Remote auth: the token owns this session's identity — a self
          // id-change would break the operator's token→peer mapping. Ask a
          // manager (bridge_rename) instead.
          throw new Error(`your identity is bound to your access token ('${tokenPeer}') — ask a hub manager to rename you`)
        }
        if (hub.has(peerId) && registry.peerFor(sessionId) !== peerId) {
          throw new Error(`peer already registered by another connection: ${peerId}`)
        }
        const current = registry.peerFor(sessionId)
        if (current !== undefined && current !== peerId) {
          if (registry.attachedCount(current) === 1) {
            // Sole session on the old id: atomically re-key the peer —
            // mailbox, waiters, history attribution, and profile all move,
            // so nothing queued or acked is lost (the old unregister-based
            // path dropped the mailbox and broke acks/history).
            hub.renamePeer(current, peerId)
            registry.rebindPeerId(current, peerId)
          } else {
            // Other sessions still share the old id: legacy split — detach
            // only this session and drop the old peer when the last leaves.
            registry.unbindPeer(sessionId)
            if (registry.attachedCount(current) === 0) hub.unregister(current)
          }
        }
        if (!hub.has(peerId)) hub.register(peerId)
        registry.bindPeer(sessionId, peerId)
        registry.clearSuppress(sessionId)
        hub.touch(peerId)
        if (alias !== undefined) hub.setAlias(peerId, alias)
        const finalAlias = hub.profileOf(peerId)?.alias
        return { ok: true, peerId, ...(finalAlias !== undefined ? { alias: finalAlias } : {}), peers: hub.peers() }
      },
    },
    {
      name: 'bridge_unregister',
      description: 'Leave the hub: detaches your session (and drops the peer when no other session shares it); auto-registration stays off until an explicit bridge_register. With `peer`, a hub MANAGER can kick another peer: its queue is dropped and every session attached to it is detached and kept from auto-re-registering. Idempotent.',
      inputSchema: schema({
        peer: optStr('Kick this peer instead of yourself. Requires manager rights (hub managerPeers).'),
      }),
      handler: async (args, sessionId) => {
        if (args.peer === undefined) {
          const peer = registry.peerFor(sessionId)
          if (peer !== undefined) {
            registry.unbindPeer(sessionId)
            if (registry.attachedCount(peer) === 0) hub.unregister(peer)
          }
          registry.suppressAuto(sessionId)
          return { ok: true, peerId: peer ?? null }
        }
        // Manager kick: drop the target peer, detach ALL its sessions and
        // suppress their auto-registration, so the kick survives the target's
        // next tool call (it must explicitly bridge_register to come back).
        const caller = registry.peerFor(sessionId)
        if (caller === undefined) throw new Error('not registered — call bridge_register(peerId) first')
        const target = String(args.peer)
        requireManager(caller, `kicking '${target}'`, sessionId)
        if (!hub.has(target)) {
          return { ok: true, peerId: null, kicked: false }
        }
        hub.unregister(target)
        const detached = registry.unbindPeerId(target, { suppress: true })
        return { ok: true, peerId: target, kicked: true, detachedSessions: detached.length }
      },
    },
    {
      name: 'bridge_rename',
      description: 'Rename on the hub, two layers: (1) `alias` sets a display name — cosmetic only, it shows up in bridge_peers / bridge_status and the desktop roster while routing, mailboxes, and history keep the immutable peer id; renaming yourself is open to everyone. (2) `peerId` truly re-keys another registered peer (manager rights required): mailbox, waiters, session bindings, and history attribution move atomically, so queued messages and acks stay continuous. Renaming ANOTHER peer (either layer) requires manager rights (hub managerPeers).',
      inputSchema: schema({
        alias: optStr('New display name (1-64 chars, spaces/CJK allowed; empty string clears back to no alias).'),
        peerId: optStr('New routing id for `peer` — a true rename that moves all state (manager only). Target must be a registered peer.'),
        peer: optStr('Whose name/id to change; default yourself. Changing another peer requires manager rights.'),
      }),
      handler: wrap(true, async (args, peer, sessionId) => {
        const hasAlias = args.alias !== undefined
        const hasPeerId = args.peerId !== undefined
        if (!hasAlias && !hasPeerId) {
          throw new Error('nothing to rename: pass alias and/or peerId')
        }
        let target = args.peer === undefined ? peer : String(args.peer)
        if (target !== peer) requireManager(peer, `renaming '${target}'`, sessionId)
        let previousId: string | undefined
        if (hasPeerId) {
          if (args.peer === undefined) {
            throw new Error('peerId requires peer — to change your own id, call bridge_register(newId)')
          }
          const newId = String(args.peerId)
          if (!PEER_ID_PATTERN.test(newId)) {
            throw new Error(`invalid peerId: ${newId} (expected [A-Za-z0-9._:-]{1,64})`)
          }
          previousId = target
          hub.renamePeer(target, newId)
          registry.rebindPeerId(target, newId)
          target = newId
        }
        if (hasAlias) {
          const alias = String(args.alias).trim()
          hub.setAlias(target, alias === '' ? undefined : sanitizeAlias(alias))
        }
        const applied = hub.profileOf(target)?.alias
        return { ok: true, peerId: target, ...(previousId !== undefined ? { previousId } : {}), ...(applied !== undefined ? { alias: applied } : {}) }
      }),
    },
    {
      name: 'bridge_chat',
      description: 'Send a chat message to another agent on the hub. Use bridge_wait (long-poll) or bridge_poll to receive replies. `to` is the target peerId, or "all" to broadcast.',
      inputSchema: schema(
        { to: str('Target peerId, or "all" to broadcast.'), message: str('The message text.') },
        ['to', 'message'],
      ),
      handler: wrap(true, async (args, peer) => receipt(hub.send(peer, String(args.to), 'chat', String(args.message)))),
    },
    {
      name: 'bridge_task',
      description: 'Delegate a structured task to another agent. The receiving agent decides whether to accept; expect an ack (accepted/rejected/done/failed) via bridge_wait / bridge_poll.',
      inputSchema: schema(
        {
          to: str('Target peerId, or "all" to broadcast.'),
          prompt: str('What the receiving agent should do.'),
          context: optStr('Optional background information for the task.'),
          deliverable: optStr('Optional expected deliverable description.'),
        },
        ['to', 'prompt'],
      ),
      handler: wrap(true, async (args, peer) => receipt(hub.sendTask(peer, String(args.to), {
        prompt: String(args.prompt),
        ...(args.context !== undefined ? { context: String(args.context) } : {}),
        ...(args.deliverable !== undefined ? { deliverable: String(args.deliverable) } : {}),
      }))),
    },
    {
      name: 'bridge_ack',
      description: 'Acknowledge a message received from another agent (usually a delegated task): accepted | rejected | done | failed. The ack is routed back to the original sender of `ref`.',
      inputSchema: schema(
        {
          ref: str('The id of the message being acknowledged.'),
          status: { type: 'string', enum: ['accepted', 'rejected', 'done', 'failed'], description: 'acknowledgement status.' },
          note: optStr('Optional explanation for the acknowledgement.'),
        },
        ['ref', 'status'],
      ),
      handler: wrap(true, async (args, peer) => {
        const status = String(args.status)
        const valid: AckContent['status'][] = ['accepted', 'rejected', 'done', 'failed']
        if (!valid.includes(status as AckContent['status'])) {
          throw new Error(`invalid ack status: ${status} (expected ${valid.join(' | ')})`)
        }
        return receipt(hub.sendAck(peer, String(args.ref), { status: status as AckContent['status'], ...(args.note !== undefined ? { note: String(args.note) } : {}) }))
      }),
    },
    {
      name: 'bridge_wait',
      description: 'Wait (long-poll) for the next message addressed to you. Resolves immediately when one is queued; otherwise blocks until one arrives or the timeout fires. `from` narrows to one sender. Loop this tool to hold a real-time conversation.',
      inputSchema: schema({
        from: optStr('Only wait for messages from this peerId.'),
        timeoutMs: int(`Max wait in milliseconds (default ${DEFAULT_WAIT_MS}, ceiling is server waitTimeoutMs).`),
      }),
      handler: wrap(true, async (args, peer) => presentWait(await hub.wait(peer, args.timeoutMs === undefined ? options.defaultWaitMs ?? DEFAULT_WAIT_MS : Number(args.timeoutMs), args.from === undefined ? undefined : String(args.from)))),
    },
    {
      name: 'bridge_poll',
      description: 'Non-blocking: drain every message currently queued for you. Empty list when nothing is waiting. `from` narrows to one sender.',
      inputSchema: schema({ from: optStr('Only drain messages from this peerId.') }),
      handler: wrap(true, async (args, peer) => ({ messages: hub.poll(peer, args.from === undefined ? undefined : String(args.from)).map(present) })),
    },
    {
      name: 'bridge_status',
      description: 'Hub health: server info, every registered peer with connected/queued/waiting state. A peer is connected when it was active recently or its SSE channel is alive.',
      inputSchema: schema({}),
      handler: wrap(true, async () => hub.status(livePeersFor(registry))),
    },
    {
      name: 'bridge_peers',
      description: 'List registered peers with their display identity and connection state: id (immutable routing name), optional alias (display name), client name/version reported at connect, whether connected (recent activity or a live SSE channel), and lastSeenMs.',
      inputSchema: schema({}),
      handler: wrap(true, async () => ({ peers: rosterFor(hub, registry) })),
    },
    {
      name: 'bridge_history',
      description: 'Recent messages involving you (newest first). Use to refresh context after a reconnect. Reading ANOTHER peer\'s conversation — or `peer: "all"` for the unfiltered tail — requires manager rights (hub managerPeers).',
      inputSchema: schema({
        peer: optStr('PeerId whose conversation to inspect; "all" = every peer; default: yourself. Other peers / "all" require manager rights.'),
        channel: optStr('Read a group channel history instead of a peer conversation (you must be a member, or a manager).'),
        limit: int('How many messages to return (default 20).'),
      }),
      handler: wrap(true, async (args, peer, sessionId) => {
        const limit = Math.min(args.limit === undefined ? 20 : Number(args.limit), 1000)
        const target = args.peer === undefined ? peer : String(args.peer)
        if (target !== peer) {
          requireManager(peer, `reading ${target === BROADCAST ? 'the full history' : `peer '${target}' history`}`, sessionId)
        }
        if (args.channel !== undefined) {
          const groupId = String(args.channel)
          const group = hub.groupOf(groupId)
          if (group === undefined) throw new Error(`unknown group: ${groupId}`)
          if (!group.members.includes(peer)) requireManager(peer, `reading group '${groupId}' history`, sessionId)
          return { messages: hub.historyChannel(groupId, limit).map(present) }
        }
        const messages = target === BROADCAST
          ? hub.historyAll(limit)
          : hub.history(target, limit)
        return { messages: messages.map(present) }
      }),
    },
    // ---- group tools (group channel) ---------------------------------------------
    // A group routes one message to several members; the message carries
    // channel = group id. Offline members are skipped (they read history) —
    // unlike direct sends, which fail on unknown recipients.
    {
      name: 'bridge_group_create',
      description: 'Create a group channel. You become a member automatically; `members` lists additional peerIds (each must be registered). Members exchange messages via bridge_group_send; anyone in the group reads its history with bridge_history { channel }. Use bridge_group_delete to remove (creator or manager).',
      inputSchema: schema(
        {
          group: str('Unique group id: letters/digits/._:- , 1-64 chars.'),
          name: optStr('Optional display name.'),
          members: { type: 'array', items: { type: 'string' }, description: 'Member peerIds (you are added automatically; duplicates ignored).' },
        },
        ['group'],
      ),
      handler: wrap(true, async (args, peer) => {
        const groupId = String(args.group)
        const members = Array.isArray(args.members) ? args.members.map(String) : []
        const group = hub.createGroup(groupId, members, peer, args.name === undefined ? undefined : String(args.name))
        return { ok: true, group: { id: group.id, ...(group.name !== undefined ? { name: group.name } : {}), members: group.members, createdBy: group.createdBy } }
      }),
    },
    {
      name: 'bridge_group_send',
      description: 'Send a chat message to every member of a group channel except yourself. Offline members are skipped (they catch up via bridge_history { channel }). You must be a member.',
      inputSchema: schema({ group: str('Group id from bridge_group_create / bridge_group_list.'), message: str('The message text.') }, ['group', 'message']),
      handler: wrap(true, async (args, peer) => receipt(hub.sendToGroup(peer, String(args.group), String(args.message)))),
    },
    {
      name: 'bridge_group_list',
      description: 'List every group channel with its members and creator.',
      inputSchema: schema({}),
      handler: wrap(true, async () => ({ groups: hub.allGroups() })),
    },
    {
      name: 'bridge_group_delete',
      description: 'Delete a group channel (history rows are kept). The creator or a hub manager may delete.',
      inputSchema: schema({ group: str('Group id to delete.') }, ['group']),
      handler: wrap(true, async (args, peer, sessionId) => {
        const groupId = String(args.group)
        const group = hub.groupOf(groupId)
        if (group === undefined) throw new Error(`unknown group: ${groupId}`)
        if (group.createdBy !== peer) requireManager(peer, `deleting group '${groupId}'`, sessionId)
        hub.deleteGroup(groupId)
        return { ok: true, group: groupId }
      }),
    },
    {
      name: 'bridge_group_add_member',
      description: 'Add a registered peer to a group channel; the new member can then send to it and read its history. The creator or a hub manager may add.',
      inputSchema: schema({ group: str('Group id from bridge_group_create / bridge_group_list.'), member: str('peerId of the new member.') }, ['group', 'member']),
      handler: wrap(true, async (args, peer, sessionId) => {
        const groupId = String(args.group)
        const member = String(args.member)
        const group = hub.groupOf(groupId)
        if (group === undefined) throw new Error(`unknown group: ${groupId}`)
        if (group.createdBy !== peer) requireManager(peer, `adding a member to group '${groupId}'`, sessionId)
        const updated = hub.addGroupMember(groupId, member)
        return { ok: true, group: { id: updated.id, members: updated.members } }
      }),
    },
    {
      name: 'bridge_group_remove_member',
      description: 'Remove a member from a group channel; they stop receiving its messages (history rows are kept). The creator or a hub manager may remove; the creator itself cannot be removed.',
      inputSchema: schema({ group: str('Group id from bridge_group_create / bridge_group_list.'), member: str('peerId to remove.') }, ['group', 'member']),
      handler: wrap(true, async (args, peer, sessionId) => {
        const groupId = String(args.group)
        const member = String(args.member)
        const group = hub.groupOf(groupId)
        if (group === undefined) throw new Error(`unknown group: ${groupId}`)
        if (group.createdBy !== peer) requireManager(peer, `removing a member from group '${groupId}'`, sessionId)
        const updated = hub.removeGroupMember(groupId, member)
        return { ok: true, group: { id: updated.id, members: updated.members } }
      }),
    },
    // ---- herdr control tools ------------------------------------------
    // These type into real agent terminals via the herdr runtime. They are
    // gated by checkControl and documented as physical input: unlike
    // bridge_chat (a mailbox message the model may ignore), a prompt here is
    // executed by the target's TUI — slash commands included.
    {
      name: 'bridge_agent_list',
      description: 'List agent panes detected by the herdr terminal runtime (paneId, agent kind, lifecycle status, cwd, interactive-ready). Use a paneId as the `target` of the other bridge_agent_* tools. Control tools: they type into the target terminal — use with care.',
      inputSchema: schema({}),
      handler: wrap(true, async (_args, peer) => ({ agents: await checkControl(peer).list() })),
    },
    {
      name: 'bridge_agent_status',
      description: 'Live status of a target: for agents herdr recognizes, the full lifecycle state (idle/working/blocked/done) and agent kind; for unrecognized panes, a pane-derived summary with status "unknown" and `pane` populated. `target` is a herdr paneId from bridge_pane_list / bridge_agent_list.',
      inputSchema: schema({ target: str('herdr paneId, e.g. w1:p1, from bridge_agent_list or bridge_pane_list.') }, ['target']),
      handler: wrap(true, async (args, peer) => {
        const result = await checkControl(peer).statusSmart(String(args.target))
        return { agent: result.agent, ...(result.pane !== null ? { pane: result.pane } : {}) }
      }),
    },
    {
      name: 'bridge_agent_prompt',
      description: 'Submit text directly into the target terminal. For agents herdr recognizes, uses agent.prompt — a state-machine wait (`wait: true` blocks until idle/done/blocked, exact states via `until`). For unrecognized panes (e.g. MiniMax Code), falls back to pane-level input (`pane.send_input`) and waits for the pane output to settle. Slash commands are executed by the target\'s TUI either way. Returns `via: "agent" | "pane"` so callers know which channel was used.',
      inputSchema: schema(
        {
          target: str('herdr paneId, e.g. w1:p1, from bridge_pane_list / bridge_agent_list.'),
          text: str('Text to submit (slash commands are executed, not sent as chat).'),
          wait: { type: 'boolean', description: 'Wait for the agent to settle after submission (default false).' },
          until: { type: 'array', items: { type: 'string', enum: [...AGENT_STATUSES] }, description: 'Exact states to wait for (agent channel; default: idle/done/blocked).' },
          timeoutMs: int('Wait cap in ms (default 30000).'),
        },
        ['target', 'text'],
      ),
      handler: wrap(true, async (args, peer) => {
        const ctl = checkControl(peer)
        const waiting = args.wait === true
        const result = await ctl.promptSmart(String(args.target), String(args.text), {
          wait: waiting,
          until: asStatuses(args.until),
          timeoutMs: args.timeoutMs === undefined ? undefined : Number(args.timeoutMs),
        })
        return waiting ? { submitted: true, via: result.via, settled: result.settled } : { submitted: true, via: result.via }
      }),
    },
    {
      name: 'bridge_agent_wait',
      description: 'Wait until the target settles. For agents herdr recognizes: state-machine wait (agent.wait — idle/working/blocked/done, `until` for exact states). For unrecognized panes: falls back to polling pane output until it stops changing. Returns `via: "agent" | "pane"`; a `settled: null` result means the timeout fired first.',
      inputSchema: schema(
        {
          target: str('herdr paneId, e.g. w1:p1, from bridge_pane_list / bridge_agent_list.'),
          until: { type: 'array', items: { type: 'string', enum: [...AGENT_STATUSES] }, description: 'Exact states to wait for (agent channel; default: idle/done/blocked).' },
          timeoutMs: int('Wait cap in ms (default 30000).'),
        },
        ['target'],
      ),
      handler: wrap(true, async (args, peer) => {
        const result = await checkControl(peer).waitSmart(String(args.target), {
          until: asStatuses(args.until),
          timeoutMs: args.timeoutMs === undefined ? undefined : Number(args.timeoutMs),
        })
        return { via: result.via, settled: result.settled }
      }),
    },
    {
      name: 'bridge_agent_read',
      description: 'Read the target\'s recent terminal output (plain text). Uses agent.read for recognized agents, pane.read otherwise. Use to collect the reply of an agent that is not connected to the hub (its output never enters a mailbox).',
      inputSchema: schema(
        {
          target: str('herdr paneId, e.g. w1:p1, from bridge_pane_list / bridge_agent_list.'),
          lines: int('How many lines to read (default: all recent).'),
          source: { type: 'string', enum: ['visible', 'recent', 'recent-unwrapped', 'detection'], description: 'Terminal snapshot source (default recent).' },
        },
        ['target'],
      ),
      handler: wrap(true, async (args, peer) =>
        checkControl(peer).readSmart(String(args.target), {
          lines: args.lines === undefined ? undefined : Number(args.lines),
          source: args.source === undefined ? undefined : (args.source as 'visible' | 'recent' | 'recent-unwrapped' | 'detection'),
        }),
      ),
    },
    {
      name: 'bridge_agent_keys',
      description: 'Send raw key presses to the target terminal — Enter, esc, ctrl-c, arrows, etc. Use to dismiss permission prompts or interrupt a stuck agent. Keys are passed verbatim.',
      inputSchema: schema(
        {
          target: str('herdr paneId, e.g. w1:p1, from bridge_pane_list / bridge_agent_list.'),
          keys: { type: 'array', items: { type: 'string' }, description: 'Keys to send, e.g. ["Enter"], ["esc"], ["ctrl-c", "Enter"].' },
        },
        ['target', 'keys'],
      ),
      handler: wrap(true, async (args, peer) => {
        const ctl = checkControl(peer)
        const keys = Array.isArray(args.keys) ? args.keys.map(String) : []
        if (keys.length === 0) throw new Error('keys: at least one key is required')
        await ctl.keysSmart(String(args.target), keys)
        return { ok: true, sent: keys }
      }),
    },
    // ---- pane-level control tools (socket API) -----------------------
    // Unlike the bridge_agent_* tools (which require herdr to RECOGNIZE the
    // agent), these drive any pane through the herdr local socket: physical
    // input and output for agents herdr does not know (e.g. MiniMax Code).
    {
      name: 'bridge_pane_list',
      description: 'List every herdr pane (ids, titles, agent status, cwd) via the herdr socket — including panes running agents herdr does not recognize. Use a paneId as `target` of bridge_pane_send / bridge_pane_keys / bridge_pane_read. Control tools: they type into real terminals — use with care.',
      inputSchema: schema({}),
      handler: wrap(true, async (_args, peer) => ({ panes: await checkControl(peer).paneList() })),
    },
    {
      name: 'bridge_pane_send',
      description: 'Type text into a herdr pane\'s input line (physical keystrokes via the herdr socket; works for ANY pane, no agent detection needed). This is how you drive an agent herdr does not recognize: the text lands in the target\'s terminal as if typed. Slash commands are executed by the target\'s TUI. With enter: true (default), the text is submitted with Enter.',
      inputSchema: schema(
        {
          target: str('herdr paneId, e.g. wT:p2, from bridge_pane_list.'),
          text: str('Text to type into the pane (slash commands are executed, not sent as chat).'),
          enter: { type: 'boolean', description: 'Submit with Enter after typing (default true).' },
        },
        ['target', 'text'],
      ),
      handler: wrap(true, async (args, peer) => {
        const ctl = checkControl(peer)
        const paneId = String(args.target)
        const text = String(args.text)
        await ctl.paneSendText(paneId, text)
        if (args.enter !== false) await ctl.paneSendKeys(paneId, ['Enter'])
        return { ok: true, target: paneId, sent: text }
      }),
    },
    {
      name: 'bridge_pane_keys',
      description: 'Send raw key presses to any herdr pane (Enter, esc, ctrl-c, arrows...). Use to dismiss permission prompts or interrupt a stuck program in a pane herdr does not recognize as an agent.',
      inputSchema: schema(
        {
          target: str('herdr paneId, e.g. wT:p2, from bridge_pane_list.'),
          keys: { type: 'array', items: { type: 'string' }, description: 'Keys to send, e.g. ["Enter"], ["esc"], ["ctrl-c"].' },
        },
        ['target', 'keys'],
      ),
      handler: wrap(true, async (args, peer) => {
        const ctl = checkControl(peer)
        const keys = Array.isArray(args.keys) ? args.keys.map(String) : []
        if (keys.length === 0) throw new Error('keys: at least one key is required')
        await ctl.paneSendKeys(String(args.target), keys)
        return { ok: true, sent: keys }
      }),
    },
    {
      name: 'bridge_pane_read',
      description: 'Read a herdr pane\'s recent terminal output (plain text, ANSI stripped). Use to collect the reply of an agent that is not connected to the hub or not recognized by herdr.',
      inputSchema: schema(
        {
          target: str('herdr paneId, e.g. wT:p2, from bridge_pane_list.'),
          lines: int('How many lines to read (default: all recent).'),
          source: { type: 'string', enum: ['visible', 'recent', 'recent-unwrapped', 'detection'], description: 'Terminal snapshot source (default recent).' },
        },
        ['target'],
      ),
      handler: wrap(true, async (args, peer) =>
        checkControl(peer).paneRead(String(args.target), {
          lines: args.lines === undefined ? undefined : Number(args.lines),
          source: args.source === undefined ? undefined : (args.source as 'visible' | 'recent' | 'recent-unwrapped' | 'detection'),
        }),
      ),
    },
    {
      name: 'bridge_pane_wait',
      description: 'Wait until a herdr pane\'s output matches a pattern (substring or regex) or the budget elapses — the pane-level counterpart of bridge_agent_wait for agents herdr does not recognize. Returns the matched pane output, or `matched: null` on timeout.',
      inputSchema: schema(
        {
          target: str('herdr paneId, e.g. wT:p2, from bridge_pane_list.'),
          match: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['substring', 'regex'], description: 'Match kind (default substring).' },
              value: { type: 'string', description: 'Text or regex to match in the pane output.' },
            },
            required: ['value'],
            description: 'Output pattern to wait for.',
          },
          timeoutMs: int('Wait cap in ms (default 30000).'),
        },
        ['target', 'match'],
      ),
      handler: wrap(true, async (args, peer) => {
        const ctl = checkControl(peer)
        const match = (args.match ?? {}) as { type?: string; value?: unknown }
        if (typeof match.value !== 'string' || match.value === '') throw new Error('match.value: a non-empty string is required')
        const type = match.type === 'regex' ? 'regex' : 'substring'
        const read = await ctl.paneWaitForOutput(String(args.target), { type, value: match.value }, {
          timeoutMs: args.timeoutMs === undefined ? undefined : Number(args.timeoutMs),
        })
        return read === null ? { matched: null } : { matched: read }
      }),
    },
  ]
}
