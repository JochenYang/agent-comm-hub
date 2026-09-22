---
name: agent-comm-hub
description: >-
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

- `bridge_chat(to, message, threadId?, ref?)` — send a chat to a peer, group
  id, or `"all"` (broadcast). `threadId` groups a multi-turn dialog; `ref`
  marks a reply-to and is capped at 5 hops per chain (see Notes).
- `bridge_task(to, prompt, context?, deliverable?, timeoutMs?, threadId?)` —
  delegate a structured task. `timeoutMs` is a soft SLA: the hub marks the
  task `timeout` if no terminal ack arrives in time.
- `bridge_ack(ref, status, note?, progress?)` — acknowledge a task.
  Statuses: `accepted` | `working` | `rejected` | `done` | `failed`.
  `working` + `progress` (0–100) report intermediate state. Terminal
  statuses lock the task (later acks are recorded on the timeline but do
  not reopen it). The ack is auto-routed to the original sender of `ref`.
- `bridge_task_status(ref)` — one task's ledger state, per-assignee state,
  and full ack timeline.
- `bridge_tasks(role?, status?, limit?)` — list tasks you sent or received.
- `bridge_wait(from?, ref?, threadId?, timeoutMs?)` — long-poll for the next
  message (default 30 s; `ref` waits for that task's ack; `threadId` narrows
  to one dialog). Loop it to hold a real-time conversation.
- `bridge_poll(from?)` — non-blocking drain of every queued message.
- `bridge_status()` / `bridge_peers()` — hub health and who is online.
- `bridge_history(peer?, limit?, channel?)` — recent messages (newest first).
- `bridge_group_create/send/list/delete` + `add_member`/`remove_member` —
  named channels for a subset of peers.

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
   - `bridge_ack(ref, "accepted")` when you take it on
   - `bridge_ack(ref, "working", note?, progress?)` for long-running work
   - `bridge_ack(ref, "done"[, note])` when finished
   - `bridge_ack(ref, "rejected")` to decline (with a reason)
   - `bridge_ack(ref, "failed")` when it could not be completed (with a note)
5. Unsure whether the peer is online: check `bridge_peers()` first.

## Common workflows (plain language)

Follow the scenario directly (tool names stay as-is):

**1. Someone delegates a task to you (e.g. codex plans -> you build)**
- On receiving a task: acknowledge first — `bridge_ack(ref, "accepted")`,
  say "got it, starting".
- For work that takes a while: `bridge_ack(ref, "working", note, progress)`
  so the delegator can see it is moving.
- When done: send the result and a delivery note back to the delegator
  (`bridge_chat` / `bridge_task`), then `bridge_ack(ref, "done", note)` so it
  can review.
- If you can't do it: `bridge_ack(ref, "rejected")` with the reason.

**2. You delegate to someone else (wait vs don't-wait)**
- Wait for delivery: after `bridge_task`, loop `bridge_wait({ref})` until the
  terminal ack arrives, then take the result over.
- Don't wait: send it and move on; the peer sends the result back when done —
  collect it later with `bridge_poll()` / `bridge_wait()` /
  `bridge_history()` (messages queue while you are away).
- Need a deadline: pass `timeoutMs` on `bridge_task`; the ledger will show
  `timeout` if the assignee never finishes.

**3. Multi-agent real-time discussion**
- After you've said your piece, stay in the conversation: loop
  `bridge_wait()` to keep listening — nothing arrived this round, wait the
  next — until a conclusion is reached or the user says "done".
- A timeout (`{type:"timeout"}`) is not a failure; keep waiting.
- Optional: put the dialog on one `threadId` so `bridge_wait({threadId})`
  only sees that conversation.

## Notes

- Messages travel on loopback only (127.0.0.1:18764) in local mode; never put
  credentials in bridge messages.
- A timeout is not a failure: `bridge_wait` returning `{type:"timeout"}` just
  means nothing arrived — try again.
- Cadence: use 10–30 s short polls when the peer is active; check
  `bridge_peers()` when unsure.
- Task terminal states (`done`/`failed`/`rejected`/`timeout`) cannot be
  reopened; start a new task instead of re-acking.
- **Reply chains are capped at 5 hops.** Every message carrying `ref` sits one
  hop deeper than the message it points at, and the hub rejects the 6th with
  `hop limit exceeded`. You only run into it when you keep replying
  (`ref`) or re-delegating along one chain instead of starting a new message —
  two agents answering each other's replies forever is exactly what the cap
  exists to stop. When it happens, stop extending that chain: send a fresh
  message with no `ref` (a new `threadId` keeps it readable as one dialog) and
  restate the context in it, or continue with `bridge_task` for new work.