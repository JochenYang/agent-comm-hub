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

SSE 保活：hub ≥ 0.7.2 每 20s 向每条 SSE 长连发一帧心跳（JSON-RPC 心跳通知），
反代的空闲读超时（如 nginx 默认 `proxy_read_timeout 60s`）不会再悄悄掐断推送
通道；半开连接也会在下一次心跳写入失败时被清理，对应的 peer 才能被空闲 GC
回收。若用 nginx 反代（非 Caddy），确认没有短于 20s 的空闲读超时即可。
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
  IP（两次同机/同名 kimi-code 是不同 id，互不串台、互不可读），管理台花名册
  会把这些连接标成 `walk-in 未认领` 并显示来源 IP；改名/认领目前走 CLI 或桌面
  GUI（管理台只读展示）。默认关闭。
- `peer`：路由 id，**token 与 peer 一一绑定**——这就是"多人同叫 kimi-code
  也能区分"的机制：张三/李四的 token 分别映射到 `zhangsan` / `lisi`，同名
  client 各得各的信箱。

### 多人使用同一个 agent（A + B + C 都是 kimi-code）

**身份不看 client 名，只看 token。** 每个人签发一枚专属 token，peer 固定：

| 人 | token → peer | 实际运行的 client | 信箱 |
|---|---|---|---|
| A 张三 | `tok_a` → `zhangsan` | kimi-code | 只收发给 `zhangsan` 的 |
| B 李四 | `tok_b` → `lisi` | kimi-code（同名） | 只收发给 `lisi` 的 |
| C 王五 | `tok_c` → `wangwu` | kimi-code（同名） | 只收发给 `wangwu` 的 |

因此：
- `bridge_chat(to:"lisi", …)` **只有李四收到**；张三/王五的 poll/wait 看不到。
- 全员通知用 `to:"all"`（发送者自己不收）。
- 部分人小圈子用 `bridge_group_*`（例如 `#frontend = zhangsan + lisi`）。
- 同一人开多个不同 agent：peer 用 `人.agent`（`zhangsan.kimi` / `zhangsan.opencode`），一人多枚 token。

管理台「身份与接入」面板：填归属人 + peer → 签发 → **一键复制该成员的 MCP 配置**
（含 Authorization header），直接发给对方粘贴进 agent 配置即可。CLI 等价：

```bash
agent-comm-hub auth add zhangsan --owner 张三
# 把打印的 token 填进对方 agent 的 MCP headers
```
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

常驻与运维资产（同目录）：

- `agent-comm-hub.service` —— systemd unit 示例（配合无鉴权的 `GET /healthz` 做存活探测）
- `nginx.conf.example` —— nginx 反代片段（SSE 关缓冲 + 读超时 > 心跳间隔 20s）
- `Dockerfile` / `docker-compose.yml` —— 一体化容器（内置 healthcheck，状态落 `/data` 卷）

`agent-comm-hub service install` 亦可作为本机自启起点（远程服务器建议直接用上面的 unit 改 host 与追加 flags）。
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
免 token）。它是单文件 React 页面（Tailwind + beui 组件，`npm run build:admin`
产出 `assets/admin.html`），页头显示连接状态与 `local` / `remote` 标记，并提供：

- **概览导航**：在线数 / 花名册、已签发 token、任务台账、群组、消息尾迹五项计数。
- **身份与接入**：`人/机器 → 专属 token → 独立 peer` 的映射说明；签发 token 后
  即时生成可复制的一段 MCP 配置片段（通用 HTTP `.mcp.json` + opencode + curl
  探测），用于分发给团队成员。
- **成员与令牌**：签发（peer / role / owner）、吊销、明文/打码切换（与 CLI
  `auth` 等价）。本机模式没有 token 表，该面板显示不可用。
- **花名册**：peer id 与显示别名、online/offline、客户端名/版本、来源 IP、最近
  活动；匿名连接带 `walk-in 未认领` 标记。**只读**——改名、踢人、认领匿名身份
  目前仍走 CLI 或桌面 GUI（`bridge_rename` / `bridge_unregister { peer }`）。
- **任务台账**：状态、流向（含 thread 与 SLA）、prompt、最近 ack 时间线（含
  progress 与 `(ignored)` 标记）。
- **群组**与**消息尾迹**（只读，5 秒轮询）。

此外仍支持：

- **桌面 GUI**：以 `agent-hub-cli` 连入。本机场景开箱即用；远程场景在设置面板把
  Hub 监听地址/端口指向服务器，并在「访问 token（远程）」填入 manager token 即可
  （保存并重启后生效，之后所有请求与 SSE 长连都携带 Bearer）。GUI 以 host + port
  拼地址，不接受完整 URL——TLS 反代场景见第 5 节的已知边界。
- **任意 MCP 客户端**：用 manager token 连入后即拥有 `bridge_rename` /
  `bridge_unregister { peer }` / `bridge_history { peer: "all" }` 全量管理能力。

## 5. 已知边界（诚实清单）

- **桌面 GUI 支持 https（app ≥ 1.5.0）**：Hub 主机名可以填完整 URL（如
  `https://hub.example.com/mcp`），URL 里的 scheme、端口与路径优先于旁边的独立字段；
  只填主机名时仍按 `http://{host}:{port}{path}` 拼接（`app/src-tauri/src/mcp_client.rs`
  的 `endpoint_url`，含单测）。走 TLS 反代的团队可以直接把 GUI 指向域名。
- **`Origin` 校验默认开启**：没有 `Origin` 头的客户端（curl、各 agent 的 MCP 客户端、
  桌面 GUI）不受影响；浏览器页面只有在回环来源、或用 `--allow-origins <list>` 显式列出的
  来源下才能调用，其余一律 403。管理台是回环来源；远程模式下它带着 token 且 `Origin`
  主机与 `Host` 一致，因此照常可用。
- **`--host` 非回环时必须有 token 表**：否则 hub 直接拒绝启动（`--insecure` 是显式承担
  风险的逃生口）。这条以前只是文档里的建议，现在由代码强制。
- **manager 特权需要凭证**：配置 `--manager-token`（或 `<state-file 目录>/manager.token`）后，
  改名他人 / 踢人 / 读全量历史 / `peer: "all"` 任务面板 / SSE 中继全部要求请求带
  `Authorization: Bearer <manager token>`；**未配时**才回到旧约定（`managerPeers` 里的 id 谁先到谁得）。
  不配且 hub 监听非回环时，启动会打一条 warn。
- **但“抢到那个 id”仍然拿到身份与信箱**：一个未鉴权的客户端可以把自己命名成
  `agent-hub-cli`（或 `bridge_register` 抢注）——它拿不到任何 manager 特权，但会占着这个 id：
  路由给该 id 的消息会被它 `bridge_poll` 取走，它也能以 `from: agent-hub-cli` 对外发送；
  真正的 GUI 随后同名连入时会同名共享同一个信箱（N:1）。把 manager token 配起来只解决“特权”，
  不解决“身份”。要完全避开，就别把 manager 身份挂在一个可猜测的固定 id 上。
- **session id 的存在性可被探测（已记录，暂不修）**：未鉴权的调用者能区分两种响应——
  「未知 session id」得到 **404**，而「已知 session id、但属于另一个凭据用户」得到 **401**。
  两者结合可以逐个试探某个 UUID 是否存在（UUID 本身不可猜，所以实际风险很低，但差异是真实的）。
  本轮**有意不改行为**：把鉴权提到 session 校验之前，只是把一个 401 泄露换成另一种可观察差异
  （例如“所有未知 id 都回 404”会让已终止与从未存在的 id 无法区分，而那正是客户端重新 `initialize`
  所依赖的信号）。真要消除，需要先设计一个不依赖状态码差异的会话生命周期语义。
- **会话会被回收（`--session-ttl-ms`，默认 30 min）**：没有活 SSE 流且超过时限未被使用的 session 会被遗忘；客户端下次调用得到 404，按规范重新 `initialize` 即可，hub 会自动用同一 peer id 重新注册、信箱不丢。`--session-ttl-ms 0` 关闭回收。
- **每 peer 信箱限速（`--rate-per-min`，默认不限）**：超过配额的消息被丢弃并计为 `droppedRate`（roster 与 bridge_metrics 可见）——**有意不排队通知**，否则通知会以和风暴同样的速度填满信箱。等待中的 peer 不受限速（一次 wait 取一条，速率由它自己控制）。
- **消息可带 `priority`（0\|1\|2，缺省 0）**：信箱按优先级排序；信箱溢出时丢**最不重要**的那条（同优先级内丢最旧——没人设优先级时与旧的「丢最旧」完全一致）。这改变了溢出语义：低优先级消息可能被持续的高优先级流量挤掉（计数可见），这是特性而非缺陷。
- **桌面 GUI 配了 manager token 后要手动补凭证**：GUI 在本地模式默认不带 `Authorization`，
  因此配上 `--manager-token` 后它会照常连上、但失去改名/踢人/全量历史/任务台账（relay 视图降级）。
  修法：把 manager token 填进 GUI 设置里的「访问 token（远程）」字段并重启连接。（app 侧自动读取
  `<state-file 目录>/manager.token` 属后续工作。）
- **本部署是传输层的静态 bearer token 认证，不是 MCP authorization 规范的实现**：规范里
  authorization 是 OPTIONAL，但 HTTP 传输上的授权实现应当遵循 OAuth 2.1 / RFC 9728。
  本项目没有 `/.well-known/oauth-protected-resource`、没有 audience 校验、没有 token
  过期与轮换。不要对外宣称它符合 OAuth。
- **`tokens.example.json` 不能直接当令牌表用**：里面的 `CHANGE-ME-*` 占位符会被 hub
  拒绝启动（fail-closed）。用 `agent-comm-hub auth add` 生成真 token。
- token 走 HTTP header：个别极简 MCP 客户端若不支持自定义 header，接不进远程
  模式（本地模式不受影响）；需要按各家 agent 实测支持度。
- 消息历史/离线信箱/花名册/群组/任务台账持久化到 SQLite（`--db`，CLI 默认开启）；
  0.6 的 roster.json 在首启时一次性迁移后仅作镜像。
- 群聊：全员广播用 `to: "all"`；部分成员群用 `bridge_group_*`。群成员在创建
  时指定，之后可随时用 `bridge_group_add_member` / `bridge_group_remove_member`
  增删（创建者或 manager 可操作；创建者本人不能被移出）。

## 6. 备份与恢复

状态全在 `--db` 指向的 SQLite 文件里（history、信箱、花名册、群组、任务账本）。
**不要用 `cp` 拷 `.db` 文件**：WAL 模式下已提交但尚未 checkpoint 的事务在 `-wal` 里，
只拷主文件会得到一个看上去完整、实际缺最近数据的库。

在 hub 运行中也能安全做的一致性快照：

```bash
# 1) 先把 WAL 落盘（可选，但能让快照更小）
sqlite3 /var/lib/agent-comm-hub/state.db 'PRAGMA wal_checkpoint(TRUNCATE);'

# 2) 用 VACUUM INTO 生成一个自包含的副本（不加锁阻塞写，且已合并 WAL）
sqlite3 /var/lib/agent-comm-hub/state.db \
  "VACUUM INTO '/var/backups/agent-comm-hub-$(date +%F).db';"
```

恢复：停掉 hub → 用快照替换 `--db` 指向的文件（同时删掉旧的 `-wal` / `-shm`，
否则它们会被当成新库的日志）→ 启动。

令牌表（`tokens.json` / `manager.token`）**不在**这个库里，要单独备份；
它们含凭据，备份文件同样需要 `chmod 600`。

### 一个需要自查的版本区间

SQLite 在 3.7.0 – 3.7.16 之间有一个 WAL-reset 缺陷（并发读 + 写事务可能读到错误的 WAL 帧，
表现为静默数据错乱）。Node 22 自带的 SQLite 远新于此，但**若你把自己编译的 SQLite
或旧运行时塞进容器，这个区间必须自查**：

```bash
node -e "const {DatabaseSync}=require('node:sqlite');console.log(new DatabaseSync(':memory:').prepare('select sqlite_version() v').get())"
```

低于 3.7.17 就不要用 WAL（或直接升级），否则备份再完整也保护不了被写坏的数据。
