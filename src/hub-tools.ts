/**
 * Bridge tools exposed to every MCP client. All results are lossless JSON
 * (the DSH tool registry contract; kept strict here so the hub is usable
 * from DSH's native tool layer too). Sender identity comes from the
 * session→peer binding established by `bridge_register`.
 */

import type { AgentHub } from './hub.js'
import type { McpTool, SessionRegistry } from './mcp-server.js'
import { decodeContent, type AckContent, type BridgeMessage, BROADCAST, type TaskContent } from './protocol.js'

/** Default wait budget when a client omits timeoutMs. */
export const DEFAULT_WAIT_MS = 30_000

/** Message presented to a model: task/ack payloads decoded to objects.
 *  Undefined `ref` is dropped — lossy JSON values are rejected by strict
 *  tool registries (e.g. DSH's lossless-JSON validation). */
export type PresentedMessage = Omit<BridgeMessage, 'content'> & { content: string | TaskContent | AckContent }

export function present(message: BridgeMessage): PresentedMessage {
  const { ref, ...rest } = message
  return {
    ...rest,
    ...(ref !== undefined ? { ref } : {}),
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

/**
 * Auto-register a session using its client-reported name (or the `agent`
 * fallback). Same-name connections ATTACH to the same peer (one stable
 * identity per agent regardless of how many sessions it opens), so there are
 * no `-2`/`-3` suffixes for identical client names. No-op when the session
 * is already bound or explicitly unregistered. Returns the peer id.
 */
export function autoRegisterPeer(
  hub: AgentHub,
  registry: SessionRegistry,
  sessionId: string | undefined,
  clientName: string | undefined,
): string | undefined {
  if (sessionId === undefined) return undefined
  const bound = registry.peerFor(sessionId)
  if (bound !== undefined) return bound
  if (registry.isSuppressed(sessionId)) return undefined
  const peerId = sanitizePeerId(clientName ?? 'agent')
  if (!hub.has(peerId)) hub.register(peerId)
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

/** Build the bridge tool set bound to one hub instance. */
export function hubTools(hub: AgentHub, registry: SessionRegistry, options: { defaultWaitMs?: number; waitTimeoutMs: number }): McpTool[] {

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
    ts: message.ts,
  })

  const presentWait = (result: { type: 'message'; message: BridgeMessage } | { type: 'timeout'; waitedMs: number }): unknown =>
    result.type === 'timeout' ? result : { type: 'message', message: present(result.message) }

  const wrap = (peerAware: boolean, handler: (args: Record<string, unknown>, peer: string, sessionId: string | undefined) => Promise<unknown>): McpTool['handler'] =>
    async (args, sessionId) => {
      const peer = peerAware ? requirePeer(sessionId) : ''
      return handler(args, peer, sessionId)
    }

  return [
    {
      name: 'bridge_register',
      description: 'Claim or rename your identity on the hub. Sessions auto-share a peer id derived from the client name; call this to switch to a readable unique peerId such as "mavis" or "opencode:myproject". Rejects when the id is claimed by another connection. Returns the current peer list.',
      inputSchema: schema({ peerId: str('Unique peer id: letters/digits/._:- , 1-64 chars.') }, ['peerId']),
      handler: async (args, sessionId) => {
        const peerId = String(args.peerId)
        if (!/^[A-Za-z0-9._:-]{1,64}$/.test(peerId)) {
          throw new Error(`invalid peerId: ${peerId} (expected [A-Za-z0-9._:-]{1,64})`)
        }
        if (hub.has(peerId) && registry.peerFor(sessionId) !== peerId) {
          throw new Error(`peer already registered by another connection: ${peerId}`)
        }
        const current = registry.peerFor(sessionId)
        if (current !== undefined && current !== peerId) {
          // Rename: detach first, then drop the old peer when no other
          // session is still attached to it (same-name sessions share it).
          registry.unbindPeer(sessionId)
          if (registry.attachedCount(current) === 0) hub.unregister(current)
        }
        registry.bindPeer(sessionId, peerId)
        if (!hub.has(peerId)) hub.register(peerId)
        registry.clearSuppress(sessionId)
        hub.touch(peerId)
        return { ok: true, peerId, peers: hub.peers() }
      },
    },
    {
      name: 'bridge_unregister',
      description: 'Leave the hub: detaches your session (and drops the peer when no other session shares it); auto-registration stays off until an explicit bridge_register. Idempotent.',
      inputSchema: schema({}),
      handler: async (_args, sessionId) => {
        const peer = registry.peerFor(sessionId)
        if (peer !== undefined) {
          registry.unbindPeer(sessionId)
          if (registry.attachedCount(peer) === 0) hub.unregister(peer)
        }
        registry.suppressAuto(sessionId)
        return { ok: true, peerId: peer ?? null }
      },
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
      description: 'List registered peers and whether each is connected (recent activity or a live SSE channel).',
      inputSchema: schema({}),
      handler: wrap(true, async () => {
        const status = hub.status(livePeersFor(registry))
        return { peers: hub.peers().map(id => ({ id, connected: status.peers.find(peer => peer.id === id)?.connected ?? false })) }
      }),
    },
    {
      name: 'bridge_history',
      description: 'Recent messages involving you (newest first); pass `peer` to inspect another peer\'s conversation. Use to refresh context after a reconnect.',
      inputSchema: schema({ peer: optStr('PeerId whose conversation to inspect; default: yourself.'), limit: int('How many messages to return (default 20).') }),
      handler: wrap(true, async (args, peer) => ({ messages: hub.history(args.peer === undefined ? peer : String(args.peer), Math.min(args.limit === undefined ? 20 : Number(args.limit), 100)).map(present) })),
    },
  ]
}
