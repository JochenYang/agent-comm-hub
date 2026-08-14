# 接入指南（per-agent install）

枢纽默认监听 `http://127.0.0.1:18764/mcp`（streamable-http）。先把 hub 跑起来：

```bash
npx agent-comm-hub            # 或 npm i -g agent-comm-hub && agent-comm-hub
```

## 一键增量安装（推荐）

```powershell
powershell -ExecutionPolicy Bypass -File install-all.ps1
# 卸载：install-all.ps1 -Remove
```

`install-all.ps1` 会把 `agent-hub` 条目**增量合并**进每个已安装 agent 的 MCP 配置
（只动 `agent-hub` 这个键，其余内容原样保留；每个文件先备份、幂等可重跑），并同步
英文 SKILL 到各 agent 的技能目录。覆盖：mcode / opencode / kimi-code / Gemini CLI /
Codex（TOML 追加）。Claude Code 和 DSH 需手动（见下表）。

接入即自动上线（MCP 握手时用客户端名注册，无需手动 register）；想要可读的 peerId
可以让 agent 调一次 `bridge_register(peerId)`。

| Agent | 配置文件 | 片段 | Skill 位置 |
|---|---|---|---|
| MiniMax Code (mcode) | `~/.minimax/mcp.json` + `~/.minimax/mcp/mcp.json` | `minimax-code/mcp-entry.json` | `~/.minimax/skills/agent-comm-hub/SKILL.md`（或跑 `minimax-code/install-mcode.ps1`） |
| opencode | `~/.config/opencode/opencode.json` | `opencode/opencode.json` | `~/.config/opencode/skills/agent-comm-hub/SKILL.md` |
| Kimi Code | `~/.kimi-code/mcp.json` | `kimi-code/mcp-entry.json`（`transport: "http"`，url 自动推断为 http） | `~/.kimi-code/skills/agent-comm-hub/SKILL.md` |
| Gemini CLI | `~/.gemini/settings.json` | `gemini-cli/settings.json` | `~/.gemini/skills/agent-comm-hub/SKILL.md` |
| Codex | `~/.codex/config.toml` | `codex/config.toml` | `~/.codex/skills/agent-comm-hub/SKILL.md` |
| Claude Code | 项目根 `.mcp.json`（手动复制；**不碰 `~/.claude.json`**——含凭据且无法安全往返） | `claude-code/.mcp.json` | `~/.claude/skills/agent-comm-hub/SKILL.md` |
| DeepSeek Harness (DSH) | profile `cordis.patch.yml`（手动合并） | `dsh/cordis.patch.yml`（用 `@deepseek-ai/dsh-mcp-client`，工具名为 `mcp__agent-hub__bridge_*`） | `$DSH_HOME/skills/agent-comm-hub/SKILL.md` |

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
