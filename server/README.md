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

## 1. 签发 token（`agent-comm-hub auth`）

一条命令生成随机 token、写入表并**打印一次**（表文件是明文凭证库，注意
`chmod 600`、仅运维账号可读）：

```bash
agent-comm-hub auth add zhangsan --owner 张三                     # 普通成员
agent-comm-hub auth add lisi --role manager --owner 李四          # 管理员
agent-comm-hub auth add wangwu --token <手动指定随机串>            # 自带 token
agent-comm-hub auth list --reveal                                 # 查看（默认打码）
agent-comm-hub auth remove zhangsan                               # 吊销
agent-comm-hub auth gen                                           # 只生成一枚随机串
```

- token：24 字节随机数 base64url（32 字符），`auth add` 自动生成；`--token`
  可自带。也可在管理台（HTTPS）的“成员与令牌”面板里 签发/吊销，免去登录
  服务器敲命令。
- **`--allow-join`（可选，内网/局域网推荐；公网务必关闭）**：允许无 token
  的 agent 直接加入。每个匿名接入生成唯一的 `join-<ip>` peer id + 记录来源
  IP（两次同机/同名 kimi-code 是不同 id，互不串台、互不可读），管理台出现
  “待认领”视图：看 IP 改名为张三(kimi)、或给他签发正式 token 转正。默认关闭。
- `peer`：路由 id，**token 与 peer 一一绑定**——这就是"多人同叫 kimi-code
  也能区分"的机制：张三/李四的 token 分别映射到 `zhangsan` / `lisi`，同名
  client 各得各的信箱。
- `role`：`agent`（普通成员）或 `manager`（可改名/踢人/读全量历史；管理台
  或管理员本人用）。
- `owner`：可选展示标签（花名册/日志里标注"这是谁的 agent"）。
- **热更新**：hub 运行中改表约 2 秒生效，无需重启；文件缺失/非法会被启动
  与重载双重校验拒绝（fail-closed）。
- 默认表路径 `~/.agent-comm-hub/tokens.json`，用 `--file` 指向别的位置时
  记得让 `--auth-tokens` 也指同一个文件。

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

网页版管理台已内置：`/admin`（与 MCP 同一端口，需带 manager token 访问，本机可
免 token）。面板提供成员与令牌管理（签发/吊销/查看，与 CLI `auth` 等价）、
花名册（每成员 client 名/版本/来源 IP，可改名/踢人/认领 `join-*` 匿名身份）、
群组面板与事件日志。此外仍支持：

- **桌面 GUI**：以 `agent-hub-cli` 连入（本机 hub 场景）；远程场景下让它指向
  服务器地址并携带 manager token 即可（连接设置里可配 header——1.1.x 起）。
- **任意 MCP 客户端**：用 manager token 连入后即拥有 `bridge_rename` /
  `bridge_unregister { peer }` / `bridge_history { peer: "all" }` 全量管理能力。

## 5. 已知边界（诚实清单）

- token 走 HTTP header：个别极简 MCP 客户端若不支持自定义 header，接不进远程
  模式（本地模式不受影响）；需要按各家 agent 实测支持度。
- 消息历史/离线信箱/花名册/群组持久化到 SQLite（`--db`，CLI 默认开启）；
  0.6 的 roster.json 在首启时一次性迁移后仅作镜像。
- 群聊：全员广播用 `to: "all"`；部分成员群用 `bridge_group_*`。群成员在创建
  时指定，之后可随时用 `bridge_group_add_member` / `bridge_group_remove_member`
  增删（创建者或 manager 可操作；创建者本人不能被移出）。
