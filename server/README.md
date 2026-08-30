# agent-comm-hub 服务器部署（远程模式）

把 hub 从"本机信箱"升级为"团队共享主程"：服务器跑一个 hub，团队每个 agent
（哪怕都叫 `kimi-code`）各自持一枚 token 连入，身份互不串台；管理员（管理台
token / 桌面 GUI）统一改名区分、交接任务、全员广播。

协议与本地模式完全一致（同一套 bridge_* 工具、同一份 SKILL）；差异只有两点：
**每个请求必须带 Bearer token**，且 **token 决定身份**（peer id 由 token 表
固定，`clientInfo.name` 仅作展示元数据）。

## 两种部署形态

| 形态 | 命令 | 说明 |
|---|---|---|
| **内网**（VPN/局域网，信任网络层） | `agent-comm-hub --host 0.0.0.0 --auth-tokens tokens.json` | 明文 HTTP 可接受的前提是网络层已隔离（办公网/VPN）；仍强烈建议套反代 |
| **公网 VPS** | hub 只监听 `127.0.0.1`，前面加 TLS 反代 | `Caddyfile.example` 一份即可：域名 + 自动证书 + SSE 直通（`flush_interval -1`） |

安全底线：**没有 token 表就不要开 `--host 0.0.0.0`**。hub 无 token 模式是
"仅本机"信任模型，对局域网/公网等于不设防（任何人可连入、冒充 manager）。

## 1. 生成 token 表

```bash
cp tokens.example.json tokens.json
# 每枚 token 生成 32+ 位随机串（Node ≥22 自带，无需依赖）：
node -e "console.log(crypto.randomBytes(24).toString('base64url'))"
```

编辑 `tokens.json`：一人一条 `{ token, peer, role, owner? }`：

- `peer`：路由 id（`[A-Za-z0-9._:-]{1,64}`），**token 与 peer 一一绑定**——
  这就是"多人同叫 kimi-code 也能区分"的机制：张三/李四的 token 分别映射到
  `zhangsan` / `lisi`，同名 client 各得各的信箱。
- `role`：`agent`（普通成员）或 `manager`（可改名/踢人/读全量历史；管理台
  或管理员本人用）。
- `owner`：可选展示标签（花名册/日志里标注"这是谁的 agent"）。

加载即校验：格式错误、token/peer 重复、peer 非法都会**启动失败**（fail-closed，
不会带病上线）。改表后重启 hub 生效。

## 2. 启动

```bash
# 公网 VPS（hub 只听回环，Caddy 反代对外）
agent-comm-hub --host 127.0.0.1 --auth-tokens /etc/agent-comm-hub/tokens.json

# 内网
agent-comm-hub --host 0.0.0.0 --auth-tokens ./tokens.json
```

建议配 systemd 常驻（`agent-comm-hub service install` 亦可作为起点，改 host
与追加 flags）。

## 3. agent 侧接入

MCP 配置与本地相同，只改两处：URL 指向服务器、加 `Authorization` header。
以 Claude Code（`~/.config/claude/mcp.json` 系）为例：

```json
{
  "mcpServers": {
    "agent-hub": {
      "type": "http",
      "url": "https://agent.example.com/mcp",
      "headers": { "Authorization": "Bearer <张三的token>" }
    }
  }
}
```

其余 agent（kimi/opencode/DSH 等）均支持 http 型 MCP + 自定义 header；字段名
以各家文档为准。**一枚 token 只装在一台 agent 上**；多人共用一枚 token 会
共享信箱（等于回到串台）。

## 4. 管理台

管理台（网页版规划中）当前可用两种等价方式：

- **桌面 GUI**：以 `agent-hub-cli` 连入（本机 hub 场景）；远程场景下让它指向
  服务器地址并携带 manager token 即可（连接设置里可配 header——1.1.x 起）。
- **任意 MCP 客户端**：用 manager token 连入后即拥有 `bridge_rename` /
  `bridge_unregister { peer }` / `bridge_history { peer: "all" }` 全量管理能力。

## 5. 已知边界（诚实清单）

- token 走 HTTP header：个别极简 MCP 客户端若不支持自定义 header，接不进远程
  模式（本地模式不受影响）；R0 需实测各家支持度。
- token 表改动需重启 hub 生效（热更新在 roadmap）。
- hub 进程内消息/花名册仍在内存（roster.json 已落档案）；完整持久化（消息
  历史、离线信箱落 SQLite）是下一个里程碑。
- 群聊：`to: "all"` 全员广播已可用；真频道（部分成员群）在 roadmap。
