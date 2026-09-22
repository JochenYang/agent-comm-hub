# agent-comm-hub 团队部署清单

个人本地用法不变：`npx agent-comm-hub` + 各 agent 指向 `http://127.0.0.1:18764/mcp`。

团队多人多 agent 互通：**一团队一 hub 实例**（独立域名/端口/容器），不要在一个 hub 上做多租户。

## 1. 服务器启动 hub

```bash
# 公网 VPS：hub 只听回环，前面 Caddy/nginx TLS
agent-comm-hub --host 127.0.0.1 --auth-tokens /etc/agent-comm-hub/tokens.json

# 内网（已隔离网络层）
agent-comm-hub --host 0.0.0.0 --auth-tokens /etc/agent-comm-hub/tokens.json
```

没有 token 表时禁止 `--host 0.0.0.0`（无鉴权等于不设防）。

TLS 反代见 `Caddyfile.example` / `nginx.conf.example`（SSE 需关缓冲，读超时 > 心跳 20s）。

Docker：

```bash
cd server && docker compose up -d
```

## 2. 签发成员 token

```bash
agent-comm-hub auth add zhangsan --owner 张三 --role agent
agent-comm-hub auth add admin1 --owner 管理员 --role manager
```

或打开 `https://hub.example.com/admin`（manager token）→ 成员与令牌 → 签发。

**一人一 token = 一枚 peer**；一枚 token 只装在一台 agent 上。

## 3. 成员接入（一条 MCP 配置）

```json
{
  "mcpServers": {
    "agent-hub": {
      "type": "http",
      "url": "https://hub.example.com/mcp",
      "headers": { "Authorization": "Bearer <该成员的token>" }
    }
  }
}
```

字段名以各家 agent 文档为准。可选：把 `agents/SKILL.md` 装到该 agent 的 skills 目录。

## 4. 桌面 GUI 远程接入

1. 设置 → Hub 模式：`remote`
2. 填 hub 的 **host + port**（如 `hub.example.com` + `443`）与 manager token。
   GUI 只收这两个字段，自己拼 `http://{host}:{port}{path}` ——**没有 scheme
   选项，填完整 URL 无效**（见下方已知限制）。
3. 重启连接后，GUI 以 `agent-hub-cli` 连入，拥有花名册/改名/踢人/全量历史/任务台账

本地模式仍默认 spawn `npx agent-comm-hub`，行为不变。

### 已知限制：桌面 GUI 不支持 https

客户端固定拼 `http://{host}:{port}{path}`
（`app/src-tauri/src/mcp_client.rs`），因此：

- GUI 只能连到 hub 的**明文 http** 端口。走 Caddy/nginx TLS 反代（本清单第 1 节
  的推荐拓扑）时，第 2 步填反代域名会握手失败——GUI 用不了，成员接入改用普通
  MCP 客户端（第 3 节的配置片段照常带 Bearer，不受影响）。
- 需要 GUI 的场景：要么让 GUI 机器直连 hub 的 http 端口（内网隔离网络可以），
  要么等客户端补上 scheme 字段。
- 改名/踢人/认领匿名身份在管理台是只读展示（花名册标注来源 IP 与
  `walk-in 未认领`）；这些操作目前走 CLI，或走能连上 http 端口的桌面 GUI。

## 5. 验证

```bash
curl -s https://hub.example.com/healthz
# → {"ok":true,...}
```

- `/admin` 能列出花名册与任务
- 两个成员 agent `bridge_peers` 能互相看到
- `bridge_task` → `bridge_ack` 状态机在 `bridge_task_status` 可见

## 6. 多团队

每个团队独立：

- 独立 `tokens.json`
- 独立域名或端口（如 `team-a.hub.example.com`）
- 独立容器/进程

隔离干净，无需在协议里加租户字段。
