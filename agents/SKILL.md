---
name: agent-comm-hub
description:
  Real-time two-way communication with other AI agents connected to the local
  agent-comm-hub. Use when the user mentions another agent, the hub, group
  chat, sending messages or tasks to another agent, waiting for another
  agent's reply, or forwarding results between agents. Tools:
  bridge_register / bridge_chat / bridge_task / bridge_ack / bridge_wait /
  bridge_poll / bridge_status / bridge_peers / bridge_history.
---

# agent-comm-hub usage

A local hub (`agent-comm-hub` on 127.0.0.1:18764) connects this agent with
every other MCP-capable agent on this machine (MiniMax Code, opencode, Kimi
Code, Claude Code, DeepSeek Harness, …).

**You are already registered**: connecting to the hub auto-registers you at
the MCP handshake using your client name — no manual step needed. Same-name
connections share one peer id, so your identity is stable across sessions.
Optional: call `bridge_register(peerId)` to claim a readable id
(`tool:project`, e.g. `claude-code:myproject`; errors when taken).

## Tools

- `bridge_chat(to, message)` — send a chat message to a peer; `to: "all"`
  broadcasts.
- `bridge_task(to, prompt, context?, deliverable?)` — delegate a structured
  task.
- `bridge_ack(ref, status, note?)` — acknowledge a task
  (`accepted`/`rejected`/`done`/`failed`), auto-routed back to the original
  sender.
- `bridge_wait(from?, timeoutMs?)` — long-poll for the next message (default
  30 s; loop it to hold a real-time conversation).
- `bridge_poll(from?)` — non-blocking drain of every queued message.
- `bridge_status()` / `bridge_peers()` — hub health and who is online.
- `bridge_history(peer?, limit?)` — recent messages (newest first). `peer`
  defaults to you; pass another peer's id to read their conversation, or
  `"all"` for the unfiltered tail across every peer.

## When to use

1. The user mentions "another agent / the hub / over there" pointing at a
   different agent — use the bridge tools.
2. **Before messaging a specific agent, call `bridge_peers()` first and use
   its exact peerId.** If the target is not listed, it is not connected yet —
   do NOT guess a peerId or send blindly; tell the user the other agent needs
   to be running (it registers automatically on connect).
3. Receiving: try `bridge_poll()` first; if empty, loop `bridge_wait()` until
   a message arrives or you give up.
4. On receiving a `task` (content is `{prompt, context?, deliverable?}`):
   acknowledge with `bridge_ack(ref, "accepted")` when you take it on, then
   `bridge_ack(ref, "done"[, note])` when finished; use `"rejected"` to
   decline and `"failed"` when it could not be completed (always with a note).
5. Unsure whether the peer is online: check `bridge_peers()` first.

## Common workflows (plain language)

Follow the scenario directly (tool names stay as-is):

**1. Someone delegates a task to you (e.g. codex plans -> you build)**
- On receiving a task: acknowledge first — `bridge_ack(ref, "accepted")`,
  say "got it, starting".
- When done: send the result and a delivery note back to the delegator
  (`bridge_chat` / `bridge_task`), then `bridge_ack(ref, "done", note)` so it
  can review.
- If you can't do it: `bridge_ack(ref, "rejected")` with the reason.

**2. You delegate to someone else (wait vs don't-wait)**
- Wait for delivery: after `bridge_task`, loop `bridge_wait()` until the
  result arrives, then take it over.
- Don't wait: send it and move on; the peer sends the result back when done —
  collect it later with `bridge_poll()` / `bridge_wait()` /
  `bridge_history()` (messages queue while you are away).

**3. Multi-agent real-time discussion**
- After you've said your piece, stay in the conversation: loop
  `bridge_wait()` to keep listening — nothing arrived this round, wait the
  next — until a conclusion is reached or the user says "done".
- A timeout (`{type:"timeout"}`) is not a failure; keep waiting.

## Notes

- Messages travel on loopback only (127.0.0.1:18764); never put credentials
  in bridge messages.
- A timeout is not a failure: `bridge_wait` returning `{type:"timeout"}` just
  means nothing arrived — try again.
- Cadence: use 10–30 s short polls when the peer is active; check
  `bridge_peers()` when unsure.
