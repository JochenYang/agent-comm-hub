---
name: agent-comm-hub
description:
  与连接到本机 agent-comm-hub 的其他 AI agent 实时双向通信。当用户提到另一个 agent、
  hub、群聊、给其他 agent 发消息/任务、等别的 agent 回复，或需要把结果转交给别的
  agent 时使用。工具：bridge_register / bridge_chat / bridge_task / bridge_ack /
  bridge_wait / bridge_poll / bridge_status / bridge_peers / bridge_history。
---

# agent-comm-hub 使用约定

本机运行着 agent-comm-hub（MCP 桥接枢纽），其他 AI agent（Claude Code、opencode、
DSH 等）可能也在线。每次会话**第一步**：

1. 调 `bridge_register(peerId)` 认领身份——peerId 用 `工具名:项目名` 风格，
   如 `mavis:myproject`。已占用会报错，换一个即可。
2. 调 `bridge_peers()` 看谁在线。

工具速查：

- `bridge_chat(to, message)` —— 给某个 peer 发消息；`to: "all"` 广播。
- `bridge_task(to, prompt, context?, deliverable?)` —— 派任务。
- `bridge_ack(ref, status, note?)` —— 回执（accepted/rejected/done/failed），自动回到原发送者。
- `bridge_wait(from?, timeoutMs?)` —— 长轮询等消息（默认 30s，可循环）。
- `bridge_poll(from?)` —— 非阻塞取走所有排队消息。
- `bridge_status()` / `bridge_peers()` —— 枢纽健康与在线列表。
- `bridge_history(peer?, limit?)` —— 最近往来消息。

## 何时使用

1. 用户提到"另一个 agent / hub / 那边"且指向其他 agent 时，用桥接工具沟通。
2. 收消息：先 `bridge_poll()`，没有就循环 `bridge_wait()` 直到拿到或超时。
3. 收到 `task`（content 为 `{prompt, context?, deliverable?}`）：
   先 `bridge_ack(ref, "accepted")` 接下，完成后 `bridge_ack(ref, "done"[, note])`；
   拒绝用 `rejected`，失败用 `failed`（附原因）。
4. 不确定对端在线：先 `bridge_peers()`。

## 注意

- 消息只走本机回环（默认 127.0.0.1:18764）；不要把敏感凭据写进消息。
- 超时不是失败：`bridge_wait` 返回 `{type:"timeout"}` 时可稍后再试。
- 对话节奏：对方在线时用 10–30s 短轮询；不确定时先 `bridge_peers`。
