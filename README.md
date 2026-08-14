# agent-comm-hub

**Generic multi-peer MCP hub** — any MCP-capable agent connects to one local
endpoint and they chat, delegate tasks, and acknowledge in real time.

MiniMax Code · Claude Code · opencode · Codex · Gemini CLI · DeepSeek Harness ·
anything with an MCP client.

```text
                ┌──────────── agent-comm-hub (127.0.0.1:18764/mcp) ────────────┐
                │  peer registry (bridge_register) · per-peer mailboxes ·     │
                │  long-poll waiters · broadcast · task/ack routing           │
                └───▲──────────▲──────────▲──────────▲──────────▲─────────────┘
                    │          │          │          │          │
         mcp.json  │   .mcp.json │ opencode.json │ config.toml │ settings.json
        ┌──────────┴──┐  ┌───────┴───┐  ┌───────┴───┐  ┌──────┴───┐  ┌───────┴───┐
        │ MiniMax Code│  │ Claude Code│  │ opencode  │  │  Codex   │  │Gemini CLI │
        └─────────────┘  └───────────┘  └───────────┘  └──────────┘  └───────────┘
```

Zero runtime dependencies: the MCP streamable-http server is hand-rolled over
`node:http`.

## Quickstart

```bash
# 1. start the hub
npx agent-comm-hub                     # or: npm i -g agent-comm-hub && agent-comm-hub

# 2. connect your agents — see agents/ for per-agent config snippets
#    (mcode: agents/minimax-code/install-mcode.ps1; others: copy the fragment)

# 3. in every agent session, have the agent run once:
#    bridge_register(peerId)          # e.g. "claude-code:myproject"
```

## Tools

| Tool | Purpose |
|---|---|
| `bridge_register(peerId)` | Claim your identity (required first; unique per connection) |
| `bridge_unregister()` | Leave the hub |
| `bridge_chat(to, message)` | Send a chat message; `to: "all"` broadcasts |
| `bridge_task(to, prompt, context?, deliverable?)` | Delegate a structured task |
| `bridge_ack(ref, status, note?)` | Acknowledge a task (accepted/rejected/done/failed), routed back to the original sender |
| `bridge_wait(from?, timeoutMs?)` | Long-poll for the next message (default 30s, ceiling configurable) |
| `bridge_poll(from?)` | Non-blocking drain of queued messages |
| `bridge_status()` | Hub health: peers with connected/queued/waiting state |
| `bridge_peers()` | Who is online |
| `bridge_history(peer?, limit?)` | Recent messages (context refresh after reconnect) |

## CLI

```
agent-comm-hub [--port 18764] [--host 127.0.0.1] [--path /mcp]
              [--max-queue 200] [--history-limit 100]
              [--wait-timeout-ms 60000] [--default-wait-ms 30000]
```

Programmatic use:

```js
import { startHub } from 'agent-comm-hub'
const hub = startHub({ port: 18764 }, console)
// hub.close() to stop
```

## Protocol

Messages: `{ id, from, to, kind: chat|task|notice|ack, content, ref?, ts }`.
`task` content is `{prompt, context?, deliverable?}`; `ack` content is
`{status, note?}` — both JSON-encoded. `to: "all"` broadcasts. Sender identity
is derived from the session binding, never caller-supplied.

## Security

- Binds to `127.0.0.1` by default; no auth. Do NOT expose the port publicly
  without adding a token/proxy layer.
- Never put credentials in bridge messages (they are plaintext on loopback).
- Peer ids are validated `[A-Za-z0-9._:-]{1,64}`; duplicate ids are rejected.

## Development

```bash
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm test        # multi-peer smoke suite (23 checks: routing/broadcast/ack/errors)
pnpm run build   # esbuild → lib/{cli,index}.js (zero deps)
pnpm pack        # build + npm pack
```

## License

MIT — see [LICENSE](LICENSE).
