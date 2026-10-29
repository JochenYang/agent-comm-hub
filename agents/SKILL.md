---
name: agent-comm-hub
description: >-
  Real-time two-way communication with other AI agents connected to the local
  agent-comm-hub. Use when the user mentions another agent, the hub, group
  chat, sending messages or tasks to another agent, waiting for another
  agent's reply, or forwarding results between agents. Tools:
  bridge_register / bridge_chat / bridge_task / bridge_ack / bridge_wait /
  bridge_poll / bridge_status / bridge_peers / bridge_history /
  bridge_commit / bridge_nack.
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

- `bridge_chat(to, message, threadId?, ref?, expiresAt?)` — send a chat to a peer,
  group id, or `"all"` (broadcast). `threadId` groups a multi-turn dialog; `ref`
  marks a reply-to (chain depth is bounded — see Notes). `expiresAt` is an
  absolute epoch-ms deadline: a message still undelivered when it passes is
  dropped (counted as `droppedExpired`) instead of arriving late.
- `bridge_notice(to, message, level?)` — send a system-flavoured line
  ("your mailbox dropped 3 messages", "hub restarting"). `level` is
  `info` | `warn` | `error`. Use it instead of `bridge_chat` when the recipient
  should read it as a status, not as a peer talking; it creates no task.
- `bridge_task(to, prompt, context?, deliverable?, timeoutMs?, threadId?, ref?, expiresAt?)` —
  delegate a structured task. `timeoutMs` is a soft SLA: the hub marks the
  task `timeout` if no terminal ack arrives in time. `ref` names the task this
  one answers; a task answering a task is a re-delegation, and that chain is
  capped at 5 hops.
- `bridge_ack(ref, status, note?, progress?, artifacts?)` — acknowledge a task.
  Statuses: `accepted` | `working` | `input-required` | `rejected` | `done` |
  `failed`. `working` + `progress` (0–100) report intermediate state.
  `input-required` is an interrupt: it asks the delegator for information
  without ending the task (it answers with `bridge_task_input`; the task resumes
  `working`). Terminal statuses lock the task (later acks are recorded on the
  timeline but do not reopen it). `artifacts` (`[{name, mimeType?, text?|url?}]`)
  is how you hand back what you produced — it is kept on the ledger, so
  `bridge_task_status` shows it later. The ack is auto-routed to the original
  sender of `ref`.
- `bridge_task_status(ref)` — one task's ledger state, per-assignee state,
  and full ack timeline (also carries the A2A aliases `taskId` / `contextId` /
  `a2aState`).
- `bridge_tasks(role?, status?, limit?)` — list tasks you sent or received.
- `bridge_task_cancel(ref, reason?)` — cancel a task. Either side may: the sender
  stops work it no longer wants, an assignee reports it will not finish. Routed to
  the other side; `canceled` is terminal and a later ack cannot reopen it.
- `bridge_task_input(ref, input)` — answer a task whose assignee acked
  `input-required`. Only the SENDER calls this; the answer reaches the waiting
  assignee and the task resumes to `working`.
- `bridge_announce(card)` — say what you can do: skills, whether you accept tasks,
  how many at once, input/output modes, and how you are executed when not polling.
  Only peers that set `acceptsTasks: true` are offered by `bridge_discover`.
- `bridge_discover(skill?, tag?, acceptsTasks?, idleOnly?)` — find a peer to hand
  work to. Returns matches with their current load (`queued` / `waiting` /
  `running`); by default only peers that accept tasks.
- `bridge_wait(from?, ref?, threadId?, timeoutMs?, ack?, maxMessages?, statuses?, terminalOnly?)` —
  long-poll for the next message (default 30 s). `ref` waits for that task's
  reply — an ack OR the chat an assignee answers with; `statuses` and
  `terminalOnly` narrow that to the ack you actually want (see the workflows
  below). `threadId` narrows to one dialog. Loop it to hold a real-time
  conversation. `ack: "manual"` LEASES the message instead of consuming it.
- `bridge_poll(from?, ack?)` — non-blocking drain of every queued message.
- `bridge_commit(ids)` — confirm you have finished with leased messages. Until you
  do, they are handed out again when the lease expires (with `attempts` growing),
  so `ack: "manual"` + `bridge_commit` is the at-least-once path: use it when
  losing a message would be worse than handling one twice. A message that keeps
  being handed out without a commit is dead-lettered rather than looping forever
  (`bridge_status` shows `inFlight` / `deadLettered`).
- `bridge_nack(ids)` — give leased messages back now (handling failed), or revive
  a dead-lettered one.
- `bridge_status()` / `bridge_peers()` — hub health and who is online.
- `bridge_history(peer?, limit?, channel?, since?)` — recent messages (newest
  first). `since` is a resume cursor: record `bridge_status().lastSeq`, then read
  only what happened after it, with no repeats. A small `limit` still truncates,
  so loop until you get an empty page.
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
   - `bridge_ack(ref, "input-required", note?)` when you need information from
     the delegator before you can continue (it answers with `bridge_task_input`)
   - `bridge_ack(ref, "done"[, note, artifacts?])` when finished — `artifacts`
     is where the result belongs
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
- Need something before you can finish: `bridge_ack(ref, "input-required",
  note)` — the task waits, the delegator answers with `bridge_task_input`, and
  your work resumes.
- When done: `bridge_ack(ref, "done", note, artifacts)` — put the result in
  `artifacts` (`[{name, text}]`, or `url` for a file you left on disk) so it is
  recorded on the ledger the delegator reads with `bridge_task_status`. Add a
  `bridge_chat { ref }` when the delegator should also see the result as a
  message in its mailbox.
- If you can't do it: `bridge_ack(ref, "rejected")` with the reason.

**2. You delegate to someone else (wait vs don't-wait)**
- Wait for the outcome: after `bridge_task`, loop
  `bridge_wait({ref, terminalOnly: true})` until the terminal ack arrives, then
  take the result over. Without `terminalOnly` a `ref` wait resolves on the
  FIRST reply — an `accepted` or `working` beat, or the chat the assignee answers
  with — so you would take over before the work is done. `statuses` is the same
  knob spelled out (`["done"]`, `["rejected", "failed"]`, …).
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
- Task terminal states (`done`/`failed`/`rejected`/`timeout`/`canceled`) cannot be
  reopened; start a new task instead of re-acking. `terminalOnly: true` on a
  `bridge_wait {ref}` resolves on the terminal ack (or the cancel message) —
  the outcome, not "it started". An SLA `timeout` produces no ack at all, so it
  never resolves a wait: read the `ref` snapshot a timed-out wait returns.
- **Reply chains are counted, not enforced — nothing is ever refused.**
  Every message carrying `ref` sits one hop deeper than the message it points at.
  A plain conversation (chat / ack replies) counts up to **50** hops; a **task
  re-delegation chain** — a task replying to a task — counts up to **5**. Past
  either ceiling `hop` simply stops counting: the message and its `ref` are
  delivered unchanged, so correlation never breaks and `bridge_wait({ ref })`
  keeps working on arbitrarily long chains. Read `hop` as “how deep this chain
  is, capped” — reaching the ceiling is a hint that the conversation has become
  a loop, not an error to recover from.
- **Nothing is dropped silently any more.** If your mailbox overflows (`maxQueue`)
  or a message hits its `expiresAt` before you read it, the hub counts it and
  `bridge_status` / `bridge_peers` show `droppedOverflow` / `droppedExpired` on
  your row. When you are waiting you may also receive a `notice` whose `from` is
  the reserved id `hub` — `bridge_wait { from: "hub" }` subscribes to exactly
  those. `all` and `hub` are reserved: you cannot register or rename into them.
  A `from` filter never hides a hub notice either: `bridge_wait { from: <assignee> }`
  still receives one. When a **task you sent** is dropped on the
  way (rate, overflow, expiry, dead letter) you get exactly one of these notices
  naming the task; the task stays open on purpose, because a dead letter can
  still be revived with `bridge_nack`.
- **Need at-least-once instead of best-effort?** Take messages with
  `bridge_wait { ack: "manual" }` (or `bridge_poll { ack: "manual" }`) and call
  `bridge_commit` once you have really handled them. Uncommitted messages come
  back when the lease expires, with `attempts` incremented; `bridge_nack` gives
  one back immediately. After too many hand-outs a message is dead-lettered
  instead of looping (see `deadLettered` in the roster).
- **SSE pushes are a client-runtime event channel, not a wake-up.** A hub
  notification arrives on the stream you subscribed to; it does NOT start a model
  turn, and an agent that is not polling will not be woken by it. Waking an agent
  that is not in a `bridge_wait` loop is the job of a *runner* — the hub runs the
  configured executor for that peer and writes the outcome back as its ack
  (`--runner`; see the hub README). If you want to be woken, either loop on
  `bridge_wait` or ask the operator to configure a runner for you.