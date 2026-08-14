# 接入指南（per-agent install）

枢纽默认监听 `http://127.0.0.1:18764/mcp`（streamable-http）。先把 hub 跑起来：

```bash
npx agent-comm-hub            # 或 npm i -g agent-comm-hub && agent-comm-hub
```

然后按下面给你的 agent 配 MCP 客户端。每个 agent 接入后都要：
1. 让它**调用一次 `bridge_register(peerId)`**（peerId 如 `claude-code:myproject`）；
2. 把 `SKILL.md`（本目录下）装到该 agent 的 skills 目录，让 agent 知道何时用 bridge 工具。

| Agent | 配置文件 | 片段 | Skill 位置 |
|---|---|---|---|
| MiniMax Code (mcode) | `~/.minimax/mcp.json` + `~/.minimax/mcp/mcp.json` | `minimax-code/mcp-entry.json` | `~/.minimax/skills/agent-comm-hub/SKILL.md`（或跑 `minimax-code/install-mcode.ps1`） |
| Claude Code | 项目根 `.mcp.json`（或 `~/.claude.json` 的 mcpServers） | `claude-code/.mcp.json` | `~/.claude/skills/agent-comm-hub/SKILL.md` |
| opencode | `~/.config/opencode/opencode.json`（或项目 `opencode.json`） | `opencode/opencode.json` | `~/.config/opencode/skill/agent-comm-hub/SKILL.md` |
| Codex | `~/.codex/config.toml` | `codex/config.toml` | `~/.codex/skills/agent-comm-hub/SKILL.md` |
| Gemini CLI | `~/.gemini/settings.json` | `gemini-cli/settings.json` | `~/.gemini/skills/agent-comm-hub/SKILL.md` |
| DeepSeek Harness (DSH) | profile `cordis.patch.yml` | `dsh/cordis.patch.yml`（用 `@deepseek-ai/dsh-mcp-client`，工具名为 `mcp__agent-hub__bridge_*`） | `$DSH_HOME/skills/agent-comm-hub/SKILL.md` |

> 各 agent 对 streamable-http MCP 的支持随版本演进，模板里的字段以官方文档为准；
> 不支持的版本可退化为 stdio 包装（见下）。

## 快速验证

```text
mcode / claude / opencode 各开一个会话，问它们：
「bridge_peers 看看谁在线，然后用 bridge_chat 给 claude-code:xxx 打个招呼」
```

## 故障排查

- hub 没起 → agent 工具列表里没有 `bridge_*`（MCP 连接失败会在 agent 日志里报错）。
- 端口被占（如 dsh-mcode-bridge 用了 18763）→ `--port` 换端口，并同步各 agent 配置。
- agent 报 "not registered" → 先调 `bridge_register(peerId)`。
- 改完配置记得重启 agent 会话。
