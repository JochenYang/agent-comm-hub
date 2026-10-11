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
   GUI 的 Hub 主机名字段可以直接填完整 URL（如 `https://hub.example.com/mcp`），
   URL 里的 scheme / 端口 / 路径优先于旁边两个字段；只填主机名时仍按
   `http://{host}:{port}{path}` 拼接（app ≥ 1.5.0）。
3. 重启连接后，GUI 以 `agent-hub-cli` 连入，拥有花名册/改名/踢人/全量历史/任务台账

本地模式仍默认 spawn `npx agent-comm-hub`，行为不变。

### 已知边界

- **桌面 GUI 支持 https（app ≥ 1.5.0）**：Hub 主机名填完整 URL 即可直连 TLS 反代，
  不再需要让它直连明文 http 端口。
- **反代的 `Origin` 与 `Host`**：hub 默认校验 `Origin`。管理台带 token 且 `Origin` 主机
  与 `Host` 一致，所以照常可用；如果反代改写了 `Host`，需要在 hub 上用
  `--allow-origins https://hub.example.com` 显式列出，否则浏览器侧的调用会被 403。
- **hub 非回环启动必须有 token 表**：`--host 0.0.0.0` 而不带 `--auth-tokens` 会直接
  拒绝启动（容器里请保持 Dockerfile 那样同时传两者）。
- **manager id 建议配凭证**：不配 `--manager-token` 时 `managerPeers` 里的 id 是谁先到
  谁得；公网/内网多人环境请配一个，或用 `auth add --role manager` 的 token。
- 改名/踢人/认领匿名身份在管理台是只读展示（花名册标注来源 IP 与
  `walk-in 未认领`）；这些操作走 CLI，或走桌面 GUI。

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
