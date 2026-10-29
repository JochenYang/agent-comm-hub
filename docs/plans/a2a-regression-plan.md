# agent-comm-hub A2A 加固：回归开发计划

- Status: active
- Plan date: 2026-10-10

来源：`docs/A2A-ROADMAP.md`（审查与方案）。本计划是该文档的执行版本，
冲突时**以本计划为准**；已知需回改的一处见下方「与源文档的差异」。

## Goal

把 `docs/A2A-ROADMAP.md` 的目标转成可执行、可回归的工程计划：分批实施，每批有独立验收与回归面；
先关掉 MCP 规范的 MUST 偏差与那条可复现的攻击链，再补可达性与投递可靠性，最后做语义扩展与桌面端。
成功标准：每一批实施后 `pnpm typecheck` 与 `pnpm test` 全绿，且新增行为有对应用例，
既有 291 项不被静默破坏（数字变化必须同批更新文档）。

## Scope

- Must-have：批次 H 的协议层安全项（Origin/CORS/manager 凭证/host 守卫/令牌表/会话 404）、
  批次 A（可达性与正确性）、批次 B（投递可靠性）、批次 F（安装配置收敛）、
  桌面端的会话重建与显示窗口。
- Out of scope：跨 hub 联邦与去中心化目录；A2A 完整端点（`POST /a2a`）与 Agent Card 的对外暴露；
  大内容附件（一律走 `uri`）；把 `admin/` 或 `app/` 转成 pnpm；任何新的运行时依赖。

## 与源文档的差异

1. `docs/A2A-ROADMAP.md` §5 第 1 条建议用 hub 侧 `bootId` 检测重启；批次 H 的 H10
   （未知会话返回 404）是规范要求的现成机制，更好。**本计划采用 404 方案**，
   源文档 §5 第 1 条需要一行回改（本计划落盘时不改源文档）。
2. 源文档把批次 A 列为「先做」；本计划把协议层安全项提到阶段 1，理由是它们更小、独立，
   且关掉的是一条可复现的攻击链与一条规范 MUST。批次 A 顺延到阶段 2。

## Work items

类目：P0 不做就走不通 · P1 静默失败或数据风险 · P2 清理与一致性 · OPT 可选。

| # | 类目 | 内容 | 状态 |
|---|------|------|------|
| W1 | P0 | `Origin` 校验：无 Origin 放行，非法 Origin 403；白名单含 hub 自身 origin 与 `--allow-origins`；同源分支要求**确实出示凭证** | [x] |
| W2 | P1 | CORS 收窄：去掉 `Access-Control-Allow-Origin: *`，`Allow-Headers` 白名单，`Expose-Headers: Mcp-Session-Id`，无条件 `Vary: Origin` | [x] |
| W3 | P0 | manager **特权**绑定凭证：`managerToken` / `<state-file 目录>/manager.token`；门禁在 `isManagerCaller`（工具门与 SSE 中继同源） | [x] |
| W4 | P1 | `--host` 非回环且无 `--auth-tokens` 时拒绝启动，`--insecure` 放行；`isLoopbackHost` 识别 127/8 与 `localhost.`，逐段校验四段数字 | [x] |
| W5 | P1 | token 表加固：加载**与写入**两条路径都拒绝 `CHANGE-ME`；权限宽于 0600 时 warn；401 带 `WWW-Authenticate: Bearer` | [x] |
| W6 | P2 | 文档纠错：删掉「桌面 GUI 不支持 https」；补齐 manager 特权语义、GUI 逃生口、静态 token 定位 | [x] |
| W7 | P0 | 可达性： GC **parked** 而非删信箱；显式 `unregister` 仍删；`parkedTtlMs` + `onMailboxExpired`；`bridge_peers` 增 `reachable` / `queued` | [x] |
| W8 | P1 | `ref` 链分两种上限：task 再委派 5 跳（`MAX_HOP`）、普通回复 50 跳（`MAX_REPLY_CHAIN`）；超限**只饱和不再报错**；`bridge_task` 新增 `ref` 让再委派可表达。**原定的「超限丢 `ref`」已被阶段 2 审查实测推翻，改为永久保留 `ref`**（见下方审查记录） | [x] |
| W9 | P2 | `bridge_notice { to, message, level? }`：让 `notice` 从声明变为可达，载荷结构化 `{message, level}`；不建任务台账 | [x] |
| W10 | P2 | 文档与仓库卫生：README 工具表重写到 31 个工具、CLI 参考补全、版本号 0.9.1、AGENTS 安全段重写、8 个游离脚本移入 `scripts/manual/`、`0` 对两个超时生效 | [x] |
| W11 | P0 | 未知 session id 返回 404（规范 MUST），客户端据此重新 `initialize`；POST 与 SSE GET 两条路径一致。**范围限定**：“已终止”目前不存在——`sessions` 从不清理（见 W53），所以 404 只对跨重启与伪造 id 生效 | [x] |
| W12 | P1 | 非法/不支持的 `MCP-Protocol-Version` 返回 400（规范 MUST；缺省仍按 2025-03-26 处理） | [x] |
| W13 | P2 | 同一条通知不再跨同一 peer 的多个会话广播（规范 MUST NOT）；优先选有活跃 SSE 的那个会话 | [x] |
| W14 | P0 | `BridgeMessage.seq` + `bridge_history { since }` 游标 + `bridge_status.lastSeq`；SQLite schema 迁移（`messages` 与 `mailboxes` 各加一列） | [x] |
| W15 | P1 | 租约式消费：`bridge_wait` / `bridge_poll { ack: 'manual' }` + `bridge_commit` / `bridge_nack` + `leaseTtlMs` + 死信（`maxAttempts`） | [x] |
| W16 | P2 | 丢弃可观测：溢出计 `droppedOverflow` 并发 notice；`expiresAt` 过期计 `droppedExpired`（新增保留 id `hub` 作为通知发送方） | [x] |
| W17 | P0 | 注册表增 `probePaths`（存在即已安装），`discover()` 增第四路探测；同步 schema | [x] |
| W18 | P0 | 把「已安装」与「有配置文件」分开：仅配置文件命中报告 `config-only` 并跳过（需 `--force`） | [x]（见下方「一个诚实的限定」） |
| W19 | P1 | 技能同步跟随同一个已安装集合，不再无条件创建 `~/.agents/skills/agent-hub/` | [x] |
| W20 | P2 | `agents/install-all.ps1` 改为读注册表，或标记废弃并在文档里只推荐 `setup` | [x]（改为废弃壳，转发给 `setup`） |
| W21 | P2 | 补测试：空 home 零文件、config-only 跳过、probePaths 命中 | [x] |
| W22 | P1 | `Runner` 接口 + `herdrRunner`（包装现有 HerdrCtl，自动回写 ack）+ `RunnerRegistry` + `--runner` 配置 | [x] |
| W23 | P1 | `cliRunner`：`execFile` 无头一次性调用，输出回写 `done` + note（无 shell、单 argv、有超时） | [x] |
| W24 | OPT | `httpRunner`：回调 webhook，至少一次投递 + 指数退避 | [ ] **本轮不做**，理由见下方「W24 为什么不做」 |
| W25 | P2 | 文档明确 SSE 是客户端事件通道、不产生模型回合；`bridge_wait` 增 `maxMessages` | [x] |
| W26 | P1 | 任务状态机补 `input-required`（中断态）/ `canceled`（终态），`TERMINAL_TASK_STATUSES` 加 `canceled`；`auth-required` 本轮不做（无人用它） | [x] |
| W27 | P1 | `bridge_task_cancel`（双方可取消）与 `bridge_task_input`（仅发送方可应答）两个工具 | [x] |
| W28 | P2 | `AckContent.artifacts` + `TaskRecord` 汇总（仅 applied 事件计入）+ `bridge_task_status` 返回 | [x] |
| W29 | P2 | `bridge_announce { card }` + `PeerProfile.card` 持久化（stateFile 直接写 + SQLite 新增 `card` 列与 ALTER 迁移 + 导入白名单） | [x] |
| W30 | P2 | `bridge_discover { skill?, tag?, acceptsTasks?, idleOnly? }`（返回匹配 peer + 当前负载；默认只返回 `acceptsTasks: true`） | [x] |
| W31 | OPT | A2A 命名别名（`taskId`/`contextId`/`a2aState`），只增不改 | [x] |
| W32 | P0 | 桌面端：会话 404 → 丢弃客户端 → 重建会话 + 重新 `bridge_register`（已在 W11 那批完成）；本轮补上自身 peer id 自检（读注册回执的 `from` 与 `SELF_PEER_ID` 对比） | [x] |
| W33 | P1 | 桌面端：接通任务通路（派任务入口、任务面板、timeout、取消/补充输入） | [x] |
| W34 | P1 | 桌面端：显示窗口设置（`display_window_hours` / `display_max_messages`），过滤做在投影层 | [x]（`display_default_view` 未做，见下） |
| W35 | P1 | 桌面端：未读持久化 + 点击 peer 即清零 + 未读与可见窗口口径一致 | [x] |
| W36 | P2 | 桌面端线程视图。**部分完成（[~]）**：已做纯函数核心 `app/src/lib/threads.ts`（按 thread 分组、channel/hop 筛选、`filterOptions`、未成线消息单独成桶）+ 消息行展示 thread/channel chip，`.tmp/verify-threads.mjs` 29/29。**未做**：（a）`hop` 展示——hub 确实发出 `hop`，但桌面端 Rust 层只把 `channel`/`threadId` 提升为列，`hop` 被丢弃，所以展示它会是死 UI；需要先在 Rust 侧携带它（若要跨重启保留则需 schema v4）；（b）筛选控件与跨 agent 线程视图的 UI——本会话无显示器，只能拿到 typecheck 证据 | [~] |
| W37 | OPT | 桌面端：接 `bridge_group_*` 六个工具 | [ ] |
| W38 | P2 | 桌面端：工具名抽常量（✓ `lib/hubTools.ts`）+ 启动校验 `tools/list`（✓）；**SSE 事件名集中定义 ✓**：`protocol.ts` 定义 `SSE_METHOD` / `SSE_EVENT_PEERS_CHANGED` / `SSE_EVENT_MESSAGE`（生产侧 index.ts / mcp-server.ts 全部引用）；桌面端 Rust `commands.rs` 用同名 `const` 对齐（注释注明 protocol.ts 为事实源）。验证：两侧 typecheck 干净、Rust 36/36、单推/单流/SSE 重连/事件探针全过——线上事件名逐字节不变 | [x] |
| W39 | P0 | 注册表修正 5 条确凿错误：`kimi-code` 去 `transport`、`gemini-cli` 改 `httpUrl`、`claude-desktop` 补 `win32`、`dsh` 补 home 层、`qoder` 升级为自动配置 | [x] |
| W40 | P2 | 注册表补充：`qwen-code`/`pi` 的 skill（✓）；项目级位置**无法表达**（注册表只收 `~/` 开头的 home 路径，项目级路径需要先有“当前项目”概念）；`mcode` 第二条路径降级待确认 | [~] |
| W41 | P1 | 新合并策略：`yaml-array`（Continue）[x]；`crushrc` **不做**，理由见阶段 9 审查 | [~] |
| W42 | OPT | 新增候选 11 个，按证据筛选取舍：**已转注册表 6 个**（zed、amp、continue、cline、roo-code、amazon-q——路径高置信且策略现成；amazon-q 需把 `expandConfigFile` 的 glob 扩展出**文件名通配**语义，目录通配保持不变）；**不做 5 个**（goose/crush 需新策略，crush=W41 已有结论；kiro/droid 远程写法未确认；lm-studio 仅 bug-tracker 来源）。探针 `.tmp/verify-w42-agents.mjs` 18/18（含 continue 的 yaml-array 列表、amazon-q 的 glob 与同级保留）；discover 33/33、setup 46/46 | [x] |
| W43 | P1 | schema 支持 config 级 `os`（`claude-desktop` 需 darwin+win32 双路径） | [x] |
| W44 | P1 | 把「绝不写入的含凭据文件」写进 `AGENTS.md` 不变式 6，并在 `validateRegistry` 里**加载期拒绝**这五个路径 | [x] |
| W45 | OPT | 命名空间 `scope`（消息/任务/分组/线程 + 查询过滤）。**本轮决定不实现，理由**：横切协议/路由/分组/查询四层；「跨 scope 默认拒绝」会改变所有现有客户端的可见行为（是本计划里新风险最大的一类改动）；验收标准（两个 scope 的同名分组互不干扰、跨 scope 发送被拒）需要真实的多 agent 环境验证，而本会话没有。在有能力做端到端验收前动手，等于交付一个只能 typecheck 的隔离机制——隔离做错比不做更危险 | [ ] **不做**，理由如左 |
| W46a | P2 | `bridge_metrics`（每 peer `sent`/`received`/`acked`/`queued`/`inFlight`/`deadLettered`/`droppedOverflow`/`droppedExpired`/`connected` + 全局 `messagesTotal`/`waitersNow`/`tasksByStatus` 等） | [x] |
| W46b | P2 | `bridge_events { since, limit }`：事件环（上限 500，丢弃时报 `truncated`）在 peer_joined/left/parked、mailbox_dropped、task_transition、runner_started/finished 七处发射；`since` 为**排他**游标 | [x] |
| W47a | OPT | **每 peer 令牌桶**：`ratePerMin`（0 = 不限）+ `--rate-per-min`。桶容量 = 一分钟的量、连续回填；**只作用于队列路径**（等待中的 peer 自己控速，一次 wait 取一条），所以它保护的是收件人。超出计为 `droppedRate`（roster + metrics），**不排队通知**（否则每条被丢的消息带一条通知，风暴照样把信箱灌满）。探针 10/10，A/B 6 条失败 | [x] |
| W47b | OPT | `priority?: 0\|1\|2`（chat/notice/task 工具入参；缺省/越界视为未设，不上线）。信箱按 `(priority desc, seq asc)` 插入排序（`insertByPriority`，**租约归还与 nack 复活同用**），poll/wait 自动遵守；overflow 丢最不重要的那条（同优先级内丢最旧 = 旧行为在无人设优先级时完全保留）。探针 13/13；**相互作用审查发现并修复**：归还/复活原先 `unshift` 到队头，会让 priority-0 租约插到 priority-2 前面，A/B 下顺序 `\[leased work, arrived-while-out\]`，修复后倒过来。教训见阶段日志 | [x] |
| W48 | P2 | SSE 响应加 `X-Accel-Buffering: no`；`nginx.conf.example` 补 `proxy_set_header Connection "";` | [x] |
| W49 | P2 | Dockerfile 锁版本（`ARG HUB_VERSION`）+ 非 root（`USER hub`）；systemd 改 `Restart=always` 并加四项沙箱 | [x] |
| W50 | P2 | 备份指引改为 `VACUUM INTO` + `wal_checkpoint`；记录 SQLite WAL-reset 版本自查 | [x] |
| W51 | P1 | parked 邮箱过期时**对账 task 账本**：被销毁的邮件里如果有 task，对应 assignee 行置为 `failed` 并记一条 `system: true` 的事件（未新增 `expired` 状态，理由见审查） | [x] |
| W52 | P2 | `--peer-idle-timeout-ms 0`（GC 关）时 `parkedTtlMs` 失效：改为 GC 关闭时单独挂一个只跑过期的定时器（两个设置本来就应该独立） | [x] |
| W53 | P2 | `SessionRegistry` 新增 `lastUsedAt` + `sweep()`：无 SSE 流且超过 `sessionTtlMs`（默认 30 min，`--session-ttl-ms 0` 关闭）的会话被遗忘，`hasSession` 终于可以表达「已终止」 | [x] |
| W54 | P3 | allow-join 下未鉴权调用者能区分「未知 session id（404）」与「已知且属凭据用户（401）」：**本轮按计划只写进 `server/README.md` 的已知边界，不改行为** | [x] |
| W55 | P3 | 两条路径统一为「auth → 协议版本 → 会话」；`Mcp-Protocol-Version` 响应头只回服务端真支持的版本。**独立审查带回一条 HIGH：GET 只验 token 有效、不验归属**，已修并写入 `test/smoke.mjs` | [x] |
| W56 | P3 | 删掉桌面端遗留的未读计数模型：schema **v4** 迁移（重建表而非 `DROP COLUMN`，带 `column_exists` 探针）移除 `unread.count`，删掉 `bump_unread`，简化 `clear_unread`/`list_unread`/`UnreadRecord`，TS 镜像同步。新增迁移测试（先造回带数据的旧列，再断言列消失而水位存活）；A/B 只让新测试变红 | [x] |
| W57 | P3 | **已按用户裁决移除**（「没必要就移除」）。删掉 `app/package.json` 的 `lint` 脚本；`app/docs/SPEC.md` 的 **NFR-6 去掉 `lint`**、**NFR-7 去掉「TS 端 `pnpm lint` 0 错误」并写明原因与重新引入的前提**；顺手清掉 `messagesStore.ts` 里那个引用不存在 linter 的 `eslint-disable-next-line`。理由：`tsc --noEmit` strict 已在把关，仓库无 eslint 配置、CI 无此步，为一个本会话跑不起来的 GUI 引入并驯服 lint 规则不划算。验证：`app` typecheck 干净 + `pnpm build` 通过（2106 modules） | [x] |
| W58 | P2 | **独立审查（W55）发现的 F7**：同一 session id 的第二个 GET 会覆盖 `sseStreams[sessionId]`，而第一个流的 close 处理器随后删掉这个条目并 `markSseClosed`——仍然开着的第二条流从此收不到任何推送（新加的会话回收还会误判它已空闲）。已修：只拆除「仍然属于自己的」条目 | [x] |
| W59 | P2 | ~~`test/setup.mjs` 间歇性失败~~ **已查明并修复：不是测试抖动，是产品缺陷**。`mergeJsonServer` 判断「内容是否变化」时只比较 `existing.url`，而 Gemini CLI 的 registry 条目用 `httpUrl`，于是 `existing.url` 永远是 `undefined` → **每次 `setup` 都重写 Gemini 配置**，违反不变式 6（幂等），并在用户家目录里不断堆积 `.bak-` 文件。测试只在 ~17% 时失败，是因为备份名用**秒级**时间戳，同一秒内的两次写入同名覆盖。修法：比较整个条目的结构化相等（`sameJson`） | [x] |
| W60 | P1 | **W59 的同类排查**（同一缺陷类别，另一个策略）：`mergeTomlSection`（Codex）判断变化时**只看节标题** `[mcp_servers.agent-hub]` 是否存在，从不比较 URL。后果：hub 端口/地址变更后，Codex 配置永远停在旧端点，而 `setup` 报告 unchanged——静默错误，比 W59 的方向更危险。已修：比较整块并在不一致时就地重建；探针 A/B 3 条失败、提交断言 3 条 | [x] |
| W61 | P3 | 桌面端未呈现 `bridge_metrics` / `bridge_events`（`app/src/lib/hubTools.ts` 里没有）。**这不是漂移 bug**：`verify-tool-drift` 的反方向（hub 有、桌面端不调）已由 `unusedTools` 计算并作为 note 打印，**不该断言**——hub 服务 39 个工具，桌面端只调用其中一部分是正常的。这是功能缺口（健康面板尚未做，见路线图 E3） | [ ] |
| W62 | P2 | **独立审查（W55）的 F2/F4 收尾**：401 响应补上 `Mcp-Protocol-Version`；`Access-Control-Expose-Headers` 加上该头（否则头设了但浏览器脚本读不到）。**审查再次证伪了我的主张**——「每个响应都带版本头」不成立（实测 23 条路径，14 条缺），因此又补了 **405** 与 **Origin 门禁 403** 这两条客户端真会撞到的拒绝路径。仍缺 `/healthz`、`/admin`、未知路径 404、`/admin/api/*`——它们不是 MCP 协议端点（或需要 adminApi 接线），**有意不改** | [x] |

## Phases

| 阶段 | 包含条目 | Gate | 状态 |
|------|----------|------|------|
| 1 安全底线（协议层） | W1–W6 | 非法 Origin 403、管理台仍可用、无凭证拿不到 manager 特权、`0.0.0.0` 无 token 起不来、独立审查的 3 个阻塞项已修并有回归用例 | [x] |
| 2 可达性与正确性 | W7–W10 | GC 后重新上线能取回排队消息；20 轮带 `ref` 对话全通；阶段级独立审查的高危项（rename 与 parkedAt）已修并有回归断言 | [x] |
| 3 会话与协议一致性 | W11–W13 | 旧 session 收到 404；坏协议版本 400；阶段级独立审查的高危项（桌面端恢复路径、W13 饿死、pushRelay、register 幽灵）已修 | [x] |
| 4 投递可靠性 | W14–W16 | 按游标续读无重无漏（W14 ✓）；租约过期可重取（W15 ✓）；丢弃可观测（W16 ✓） | [x] |
| 5 安装配置收敛 | W17–W21 | 空 home 零文件（新增用例）；`probePaths` 命中即已安装（本机 gemini/codex/claude 验证）；技能不再无条件创建 | [x] |
| 6 唤醒与执行器 | W22–W25 | 目标不在 `bridge_wait` 时任务仍能拿到终态 ack（新增用例）；执行器失败落 failed 带可读 note；无执行器时纯信箱不报错；W24（httpRunner）按 OPT 明文不做 | [x] |
| 7 任务语义与能力 | W26–W31 | `input-required` 续跑（✓）、取消生效（✓）、artifacts 可见（✓）、能力声明与发现（✓）、A2A 命名别名（✓）；`auth-required` 明文不做 | [x] |
| 8 桌面端 | W32–W38 | 会话重建（✓）、显示窗口（✓）、未读（✓）、任务通路（✓）、工具名常量与启动校验（✓）；W36 线程视图、W37 group、W38 的 SSE 事件名待做 | [~] |
| 9 注册表扩充 | W39–W44 | 修正后的 5 条能被对应 agent 读到 | [ ] |
| 10 治理 | W45–W47 | — | [ ] |
| 11 部署资产 | W48–W50 | — | [ ] |

阶段闸门：任何条目处于 `[~]` 或 `[?]` 时不得开始下一阶段。Gate 通过 = 该阶段条目的验证项全 PASS
且 review 无阻塞发现；条目从 `[~]` 转 `[x]` 前必须回答四问——主张复核、最小性、新风险、反例。

## Affected behaviors

改动会影响的既有行为，按「最容易被静默破坏」排序：

1. **W18 会切断现在能用的配置**。本机实测：`~/.config/opencode/opencode.json`、`~/.kimi-code/mcp.json`、
   `~/.gemini/settings.json`、`~/.codex/config.toml`、`~/.zcode/cli/config.json` 都存在，
   但 `gemini` / `codex` / `claude` 三个探测命令**不在 PATH 上**。若把「已安装」直接收紧为
   PATH/npm 命中，这三家会停止被配置。所以 W18 必须与 W17 同批，并为这三家补 `probePaths`
   （`~/.gemini/`、`~/.codex/`、`~/.claude/`），同时保留 `--force` 与 `--agent <id>` 的显式路径。
2. **W1 的同源陷阱**。内置管理台 `/admin` 是同源页面，它的 POST 会带
   `Origin: http://127.0.0.1:18764`。白名单必须包含 hub 自身 origin（scheme+host+port 组合），
   否则会把管理台自己挡在外面——这是本批最容易踩的回归。
3. **W3 会让桌面端失去管理员身份**。GUI 现在靠注册 `agent-hub-cli` 取得 manager 权限
   （`src/index.ts` 的 `managerPeers` 默认值）。加凭证后 GUI 必须能读到 `manager.token`，
   否则 3 秒一次的全局历史轮询与 relay 会静默停摆（见 R6b）。W3 与 W32 必须同批验收。
4. **W11 会打破现有测试**。`test/smoke.mjs` 的 idle GC 用例依赖「旧 session id 被接受后自动重新注册」，
   改成 404 后该用例会失败，必须同步改写为「旧 session 收到 404 → 重新 `initialize` → 重新注册」。
5. **W8 会打破三条既有断言**。`test/smoke.mjs` 的 `hop chain of 5 is allowed`、
   `hop limit rejects the 6th hop`、`hop depth survives a sqlite restart` 都固化了旧语义，
   必须同批改写并在 `CHANGELOG.md` 写明行为变更。
6. **W7 会改变 `bridge_unregister` 的语义边界**。现有测试断言「离开即删队列」。要明确区分：
   空闲 GC 保留信箱，显式 `bridge_unregister`（自己离开）与 manager 踢人仍删。
7. **工具数量变化**。W9 / W27 / W29 / W30 会新增工具，30 这个数字写在 README / README.zh /
   ARCHITECTURE / AGENTS 多处，必须同批更新；`grep -c "^      name: 'bridge_"` 是核对命令。
8. **W14 动持久化**。`persist.ts` 的 `messages` 表已有 `seq INTEGER PRIMARY KEY AUTOINCREMENT`，
   但那是行号；消息级 `seq` 需要新列与迁移，且 `importHistory` 只保留最新 N 条，
   序号语义（重启后是否继续递增）要先定清楚。`test/e2e.mjs` 断言了跨进程重启的历史恢复。
9. **W4 会让部分现有部署起不来**。文档写「禁止 `0.0.0.0` 无 token」，但 CLI 不拦，
   可能已有人在用。硬拒绝必须配 `--insecure` 逃生口并在启动日志 warn。
10. **W34 的设置不能进 `HubConfigValues`**。那个面板的语义是「保存并重启 hub」，
    显示偏好必须单独持久化，否则改一次显示范围就重启 hub。
11. **W13 会改变 SSE 通知的到达范围**。桌面端消费 `hub:message` 事件；若只发一条流，
    要确认 app 侧仍能拿到（app 每个 peer 通常只有一个会话，影响面小但要实测）。
12. **测试与文档的基线数字**。当前 291 项（165+37+11+35+23+20）。任何新增/改写都会让
    README / README.zh / ARCHITECTURE / AGENTS 的数字漂移，属发布 SOP 的同步项。
13. **身份有两个入口，别只守一个**。`bridge_register` 之外，`autoRegisterPeer` 会在 `initialize`
    时直接用 `clientInfo.name` 注册。W3 的首次实现只守了前者，被 `clientInfo.name = 'agent-hub-cli'`
    一行绕过（已复现并修正）。任何针对 peer id 的规则都要同时覆盖两个入口。
14. **桌面 GUI 自报的名字就是 `agent-hub-cli`**（`app/src-tauri/src/commands.rs` 的
    `ClientInfo::new(SELF_PEER_ID, …)`）。所以任何“保留这个 id”的做法都会让 GUI 完全连不上；
    正确做法是门禁**特权**（`requireManager`），而不是门禁名字。
15. **W7 改了花名册的语义（已声明）**。`bridge_peers` 现在会列出 **parked** peer
    （`reachable: "parked"`）并新增 `queued` 字段；`test/smoke.mjs` 里两条原本断言
    “被 GC 即从花名册消失”的用例已故意改写为“列为 parked、仍可寻址”。这是本轮**唯一**
    故意改写的既有断言，改动点见 Test plan 10d。
16. **`parkedTtlMs` 是丢消息的唯一途径**。默认 7 天；过期时 hub 打 warn（带丢弃条数）
    并让持久化重新快照。如果这个 TTL 被配得很短，表现就是“消息静静消失但有日志”，
    所以改它必须同时看日志。
17. **W8 改了 `ref` 链的失败模式，并给 `bridge_task` 加了参数（已声明）**。
   旧行为：第 6 个带 `ref` 的 chat 直接被拒（`hop limit exceeded`）。
   新行为：**永不拒绝**，超上限时投递但丢掉 `ref` 并把 `hop` 饱和在 50（普通回复）/ 5（task 再委派）；
   调用方靠回执里有没有 `ref` 判断链条是否被截断。同时 `bridge_task` 新增可选 `ref`
   （旧调用不受影响）。这两点面向 agent 的说明已同步到 `agents/SKILL.md` 与两个工具描述。

## Test plan

回归用例（必须保持绿的既有行为）与新行为用例混排，`(W..)` 标注覆盖的条目。

| # | 用例 | 输入/操作 | 预期 | 验证方式 | 结果 |
|---|------|-----------|------|----------|------|
| 1 (W1) | 非法 Origin 被拒 | 带 `Origin: https://evil.example` 的 `initialize` | 403，且不回 `Access-Control-Allow-Origin: *` | `node .tmp/verify-origin.mjs` | PASS（20/20） |
| 2 (W1) | 管理台同源仍可用 | 浏览器打开 `/admin` 并签发一枚 token | 页面正常，API 调用不被 403 | 手工：`agent-comm-hub` → `/admin` | 部分：协议层断言回环 origin 与「反代同源 + token」均放行；未在真实浏览器点击 |
| 3 (W1) | 非浏览器客户端不受影响 | 不带 `Origin` 的 `initialize` + `bridge_wait` | 与改动前一致 | `pnpm test`（smoke 全绿） | PASS（291/291） |
| 4 (W3) | 无凭证拿不到 manager 特权 | 配了 managerToken 的 hub，普通会话调 `bridge_history {peer:'all'}` | 拒绝并提示需要 manager token | `node .tmp/verify-manager-token.mjs` | PASS（14/14） |
| 5 (W3) | 桌面 GUI 仍能连上 | GUI 自报 `clientInfo.name = agent-hub-cli`（`app/src-tauri/src/commands.rs`） | 注册成功；未带 token 时失去 relay 所需的全量历史权限 | `node .tmp/verify-manager-bypass.mjs` | PASS：注册成功、特权被拒。**已知回归**：配了 manager token 且 GUI 未带 token 时 relay 视图降级，待 W32 接上凭证 |
| 6 (W4) | `0.0.0.0` 无 token 拒绝启动 | `agent-comm-hub --host 0.0.0.0` | 抛错并给出可读原因；`--insecure` 可启动 | `node .tmp/verify-bind-and-tokens.mjs` | PASS（11/11，含 W5） |
| 7 (W5) | 示例令牌表被拒 | 以 `server/tokens.example.json` 为 `--auth-tokens` | 启动失败 | `node .tmp/verify-bind-and-tokens.mjs` | PASS |
| 7b (W1/W3/W4/W5) | 对抗性探针 | 畸形 Origin（尾缀伪造、fragment、userinfo、IPv4-mapped IPv6、重复头、`null`）、五类 manager 越权调用、`--host` 十种写法、占位符令牌变体 | 全部拒绝；合法调用方不受影响 | `node .tmp/verify-adversarial.mjs` | PASS（33/33） |
| 7c (W1/W3/W5) | 独立审查发现的 4 个问题 | (1) 未鉴权客户端抢注 manager id 后开 SSE；持凭证会话同样开 SSE，另有 peer 私聊；(2) `--allow-join` + `Origin==Host` 无凭证；(3) 允许来源读 `Mcp-Session-Id`；(4) `auth add --token CHANGE-ME-…` | (1) 抢注者**收不到**中继、持凭证者**收到**；(2) 403；(3) 能读到；(4) 拒绝 | `node .tmp/verify-relay-and-origin-fixes.mjs` | PASS（10/10） |
| 8 (W7) | GC 后重新上线能取回排队消息 | 注册 A → B 发 3 条 → 触发回收 → A 重新注册 → `bridge_poll` | 取回排队消息且顺序不变 | `node .tmp/verify-reachability.mjs` | PASS（9/9） |
| 9 (W7) | 未知 peer 仍不可达 | `bridge_chat(to: '从未注册过的id')` | 仍报 `unknown recipient` | 同上 | PASS |
| 10 (W7) | 显式离开仍删队列且不再可寻址 | `bridge_unregister()` 后再给它发 | `unknown recipient` | 同上 | PASS |
| 10b (W7) | parked 仍可寻址、可被派活 | 对 parked peer 发 chat 与 task | 都成功排队 | 同上 | PASS |
| 10c (W7) | parked 过期可观测 | `parkedTtlMs: 400` | 日志 warn 带丢弃条数；花名册不再列出 | 同上 | PASS |
| 10d | 既有 smoke 的 GC 断言 | 原「被 GC 即从花名册消失」已换成「列为 `reachable: parked`」 | 两条断言改写（见 Affected behaviors 15） | `pnpm test` | PASS（166/166） |
| 11 (W8) | 20 轮带 `ref` 对话全通 | 交替 `bridge_chat` 带 `ref` 20 次 | 全部成功，`hop` 逐轮递增 | `node .tmp/verify-chains.mjs` | PASS（9/9） |
| 12 (W8) | task 再委派仍限 5 跳 | 连续 `bridge_task` 带 `ref` 6 次 | 第 6 次**投递成功**但 `ref` 被丢、`hop` 饱和在 5 | 同上 | PASS |
| 12b (W8) | 超过 50 的普通回复 | 把 chat 链推到 51 轮 | 投递成功；`ref` 被丢、`hop` 饱和在 50；后续仍饱和不可重启计数 | 同上 | PASS |
| 12c (W9) | `notice` 可达且结构化 | `bridge_notice` 单播/带 level/广播/给 parked peer/非法 level | 收件方看到 `kind=notice` 与 `{message, level}`；非法 level 报错；不建台账；广播不回显自己 | `node .tmp/verify-notice.mjs` | PASS（12/12） |
| 13 (W11) | 旧 session 收到 404 | 伪造 id、重启前 id、SSE GET 携假 id | 三种都是 404；重新 `initialize`（不带头）即恢复 | `node .tmp/verify-session-404.mjs` | PASS（15/15，含 W12） |
| 14 (W12) | 坏协议版本 400 | `MCP-Protocol-Version: 1999-01-01` / 空值 / 受支持值 / 缺省 | 前两者 400（消息里列出受支持版本）；后两者 200 | 同上 | PASS |
| 14b (W13) | 通知不跨流广播 | 同一 peer 开两条 SSE，再发两条消息 | 恰好 1 条提示/每条；**对照**：两条流都收到 `peers_changed` 证明它们真的活着 | `node .tmp/verify-notify-one-stream.mjs` | PASS（7/7） |
| 14c (W11) | 桌面端重启后能重连 | `initialize` 不再携带陈旧 id；404 映射为 `SessionGone` → 丢弃 `state.mcp` 重建；SSE 404 同样映射并采纳响应头的 id | `cd app/src-tauri && cargo test` → 34 单测 + 3 端到端全绿 | PASS |
| 15 (W14) | 按游标续读 | 记录 `lastSeq` → 断开 → `bridge_history { since }` → 再读一次；`since: 0` / `since: -1`；跨重启 | 恰好取回缺失部分（无重无漏）；再读为空；`0` = 全部；负数报错；重启后计数不回退 | `node .tmp/verify-seq-cursor.mjs` | PASS（12/12） |
| 16 (W15) | 租约过期可重取 | `ack: 'manual'` 取出后不 commit，等租约过期；`commit` 后再取；`nack` 立即归还；死信后 `nack` 复活；阻塞中的 waiter 收到消息；`ids: []` | 到期后同一条消息再次可取且 `attempts` 递增；commit 后不再回来；nack 立即回到队首；超过 `maxAttempts` 变死信且花名册可见；复活后计数归 1 | `node .tmp/verify-lease.mjs` | PASS（19/19） |
| 16b (W16) | 丢弃可观测 | 溢出（`maxQueue: 1`，连发两条）且收件人正 `bridge_wait { from: 'hub' }`；`expiresAt` 在队列里到期；过去/非数字的 `expiresAt`；注册/改名成 `hub`；截止时间跨重启 | 溢出与过期分别计数且互不污染；等待中的 peer 收到 `from: hub` 的 notice；过期消息**不**被投递且下次读取能看到通知；过去/非数字被拒；`hub` 保留；`expiresAt` 随消息恢复 | `node .tmp/verify-drops.mjs` | PASS（16/16） |
| 17 (W17) | `probePaths` 命中即已安装 | 只有 `~/.minimax/` 目录、无 `mcp.json` | mcode 被识别为已安装；配置文件**不**被创建；技能同步到 `~/.minimax/skills/` | `test/setup.mjs` 新增用例 + 本机 `agent-comm-hub discover` | PASS（本机 gemini/codex/claude 均靠 probePaths 命中） |
| 18 (W18) | 空 home 零文件 | 空 home + 空 PATH + no npm 跑 `setup` | 不创建任何文件（含 `~/.agents`） | `test/setup.mjs` 新增用例 | PASS（42/42） |
| 19 (W18) | config-only 识别与跳过 | 合成注册表：配置在 probePath 之外、无命令、无 npm | `present: false`、`source: 'config'`、`configOnly: true`；probePath 出现后转为已安装 | `test/discover.mjs` 新增用例 | PASS（26/26） |
| 20 (W18) | 本机三家的回归 | 本机跑 `agent-comm-hub discover` | `gemini` / `codex` / `claude` 仍被识别（靠 probePaths） | 手工：`node lib/cli.js discover` | PASS（三家均 `probe-path`；opencode/kimi 靠 PATH） |
| 21 (W22/W23) | 目标不在等待时任务仍完成 | 目标不调 `bridge_wait`，对端 `bridge_task`；runner 成功 / 失败 / 未配置 / 两个任务并发 | 拿到终态 ack；输出进 note；失败落 `failed` 带原因；无 runner 时任务留在信箱；同一 peer 的两次运行不交叠 | `node .tmp/verify-runner.mjs` | PASS（17/17） |
| 21b (W25) | `maxMessages` 批量取回 | 三条已入队后 `bridge_wait { maxMessages: 3 }`；再发一条用默认 | `>1` 时返回 `{type:"messages", messages:[…]}` 且一次取回三条；默认仍为 `{type:"message"}` | 同上 | PASS |
| 22 (W26/W27) | `input-required` 续跑 | 任务中途切 `input-required` → `bridge_task_input` | 回到 `working` 并可终态 | `node .tmp/verify-task-states.mjs` | PASS |
| 23 (W27) | 取消生效 | 对 `working` 任务 `bridge_task_cancel`（发送方与被派方两侧） | 账本 `canceled`，终态锁生效（后续 ack `applied:false`），另一方收到通知 | 同上 | PASS |
| 23b (W29/W30) | 能力声明与发现 | announce 一张卡片；`bridge_discover` 按 skill/tag/`idleOnly` 过滤；两张持久化路径各重启一次 | 卡片随 roster 可见；默认只返回 `acceptsTasks: true`；重启后卡片仍在 | `node .tmp/verify-announce.mjs` | PASS（22/22） |
| 23c (W31) | A2A 别名只增不改 | `bridge_task` / `bridge_task_status` / 一条 ack | `taskId`、`contextId`、`a2aState` 与旧字段同时存在 | `node .tmp/verify-task-states.mjs` | PASS |
| 24 (W32) | 杀掉 hub 后桌面端不退化 | 启动 app + hub → 杀 hub 让其重启 → 看 `bridge_peers` | 自身 id 仍是 `agent-hub-cli` | 手工 + `cargo test` | pending |
| 25 (W34/W35) | 显示窗口与未读一致 | 窗口设 1 小时；重启 app | 渲染不早于窗口；未读与可见范围一致且重启后保持 | 手工验收 | pending |
| 26 | 全量回归 | — | `pnpm test` 全绿；文档数字与实际一致 | `pnpm test` + 发布 SOP 的同步命令 | pending |
| 27 | 桌面端构建 | — | 前端与 Rust 均通过 | `cd app && pnpm typecheck`、`cd app/src-tauri && cargo test`（**`pnpm lint` 不可用**：eslint 未安装，见 W57——不要把它当作「待跑」） | pending |
| 28 | 管理台构建 | 改动 admin 时 | 重新产出单文件 | `npm run build:admin` | pending |

## Verification commands

```bash
pnpm typecheck                 # 每批必跑
pnpm test                      # 每批必跑；当前基线 292 项（166+37+11+35+23+20）
pnpm build:test                # ← .tmp/verify-*.mjs 的前置条件，见下
npm run build:admin            # 仅改动 admin/ 时
pnpm run build                 # 仅改动打包路径时
cd app && pnpm typecheck                   # 改动 app/ 前端时（`pnpm lint` 不可用，见 W57）
cd app/src-tauri && cargo test             # 改动 app/ Rust 时

# 下面这些脚本 import 的是 test/entry.mjs（gitignore 的 esbuild 产物，
# 不一定与 src/ 同步）。**每次信任它们的绿灯之前，必须先跑 pnpm build:test**，
# 否则绿灯只说明“磁盘上那个旧产物如此”，不说明 src 如此。
node .tmp/verify-origin.mjs                  # W1/W2
node .tmp/verify-manager-token.mjs           # W3
node .tmp/verify-bind-and-tokens.mjs         # W4/W5
node .tmp/verify-adversarial.mjs             # W1/W3/W4/W5 对抗性探针
node .tmp/verify-relay-and-origin-fixes.mjs  # 独立审查发现的四个修复
agent-comm-hub discover                      # W17/W18 本机回归
```

`pnpm test` 自身会先跑 build:test，所以它不受产物陈旧影响。


发布前另跑发布 SOP 的文档同步命令（版本三处、测试项数、工具数量、`managerPeers` 默认值）。

## Rollback

- 每批一个独立提交，回滚 = 回退该批提交；不要跨批合并提交。
- **W7 / W14 有数据面影响**：`parkedTtlMs` 与消息 `seq` 涉及 SQLite schema 迁移。
  迁移必须只增列（沿用现有 `ALTER TABLE ... ADD COLUMN` + 忽略已存在的写法），
  回滚代码后旧库仍可读；**不要**在迁移里做删除或重命名。
- **W11 有客户端兼容面**：若桌面端尚未完成 W32，回滚 W11 即可恢复旧行为（客户端会重新
  静默漂移），因此 W11 与 W32 建议同一个提交或紧邻两个提交。
- **W3 有锁死风险**：若 `manager.token` 读写有误，桌面端与 CLI 会同时失去 manager 权限。
  上线前先用 CLI 验证一次，并保留「无 token 时保持旧行为 + warn」的降级路径一个版本。
- 备份：改动涉及 `--db` 时，升级前先 `VACUUM INTO` 一份快照（不要 `cp`）。

## Phase log

| 阶段 | 日期 | 证据 | 结论 |
|------|------|------|------|
| 1 | 2026-10-10 | `pnpm typecheck` 干净；`pnpm test` 291/291；`.tmp/verify-{origin,manager-token,bind-and-tokens,adversarial,relay-and-origin-fixes}.mjs` = 20/14/11/33/10 全 PASS；真 CLI 与 `--help` 实测；独立审查 3 个阻塞项已修 | 放行；四问齐备（见上） |
| 2 | 2026-10-10 | `pnpm test` 292/292；`.tmp/verify-{reachability,chains,notice,phase2-edge}.mjs` 全 PASS；`cd app/src-tauri && cargo test` 全绿；阶段级独立审查的高危项（rename/parkedAt）已修 | 放行；四问齐备 |
| 3 | 2026-10-10 | `pnpm test` 292/292；`.tmp/verify-{session-404,notify-one-stream,single-push}.mjs` 全 PASS；`cargo test` 34 单测 + 3 端到端全绿；阶段级独立审查的四个高危/中危项已修 | 放行；四问齐备 |
| 4 | 2026-10-11 | `pnpm test` 292/292；`.tmp/verify-{seq-cursor,lease,drops}.mjs` = 12/19/16 全 PASS；15 套断言全绿 | 放行；四问齐备 |
| 5 | 2026-10-11 | `pnpm test` **300/300**（setup 42、discover 26）；空 home 零文件用例；`node lib/cli.js discover` 本机回归；废弃壳假 home 转发实测 | 放行；四问齐备（含一条诚实的限定） |
| 6 | 2026-10-11 | `pnpm test` 300/300；`.tmp/verify-runner.mjs` 17/17（成功/失败/未配置/串行/批量）；`pnpm typecheck` 干净 | 放行；W24 按 OPT 明文不做；四问齐备 |
| 7 | 2026-10-11 | `pnpm test` 300/300；`.tmp/verify-task-states.mjs` 26/26；`.tmp/verify-announce.mjs` 22/22；`pnpm typecheck` 干净 | 放行；四问齐备（含两个已修的新风险与 A/B 证据） |

## 审查记录

每项完成后回答四问：**主张复核**（主张为假时会失败的检查跑了吗）、**最小性**（是否多改了）、
**新风险**（引入了什么）、**反例**（什么情况下主张不成立）。

### 阶段 1：W1 / W2（Origin 校验 + CORS 收窄）

- **主张复核**：`.tmp/verify-origin.mjs` 20 项断言全通过（含 GET/SSE 路径、`Origin: null`、
  重复头、IPv6 回环、反代同源 + token）；`pnpm test` 291/291。主张成立。
- **最小性**：两处超出最小范围，已声明——(a) `unauthorized()` 里加了 `WWW-Authenticate: Bearer`，
  那属于 W5；(b) `jsonRpcError` 的签名改为从 `req` 取协议版本（因为 `corsFor` 需要 `req`）。
  两处都是加法/等价重构。
- **新风险**：`/healthz` 也受 Origin 门禁（监控工具不带 Origin，不受影响）；反代若改写 `Host`，
  同源判定失配，需 `--allow-origins` 兜底；`Allow-Headers` 不再 `*`，浏览器客户端若发列表外的头会预检失败。
- **反例**：`Origin: null`（沙箱 iframe）已测被拒；「Origin 与 Host 同为攻击者域名且无 token」已测被拒；
  未覆盖的反例是**从 localhost 其他端口提供的恶意页面**仍被放行——回环白名单的设计取舍，已在代码注释写明。

**对抗性探针（`.tmp/verify-adversarial.mjs`，33 项全通过）又修正了一处：** `isLoopbackHost` 原先只匹配字面量
`127.0.0.1`，导致两个错误——(a) `--host 127.0.0.2`（同属 127/8 回环）被当成非回环而要求 token；
(b) `--host localhost.`（带尾点的 FQDN）同样被拒。两者都是“偏严但错误”的方向。
修正为「`localhost`（允许尾点）+ 整个 127.0.0.0/8 + `::1`」，并且**逐段校验点分四段数字**——
若只做 `127.` 前缀匹配，`127.evil.example`（攻击者 DNS 可指向 127.0.0.1）会被误判为回环，
那正是这道门禁要防的 rebinding 形态；已加负面用例钉住。

### 阶段 1：W3（manager 特权凭证）—— 首版是「假完成」，已重做

自查抓到两个真问题，都已复现并修正：

1. **自动注册绕过**（首版漏了第二个入口）。`bridge_register` 守住了，但 `autoRegisterPeer` 在
   `initialize` 时直接用 `clientInfo.name` 注册。复现：把 `clientInfo.name` 设为 `agent-hub-cli`、
   不带任何凭证 → `bridge_history {peer:'all'}` 返回 `isError: false`。守卫形同虚设。
2. **GUI 身份耦合**（首版的守卫方向错了）。桌面 GUI 自报的名字就是 `agent-hub-cli`
   （`app/src-tauri/src/commands.rs` 的 `ClientInfo::new(SELF_PEER_ID, …)`），所以「保留这个 id」
   会让配了 manager token 的 GUI **完全连不上**，而不只是失去管理权。

修正后的做法：**门禁特权，而不是门禁名字**。`requireManager` 在配置了 manager token 时
要求凭证（manager 会话或 manager 角色 token），不再看 `managerPeers`；id 本身不保留，
所以 GUI 照常注册。安全性没有损失：认领了 id 的未授权客户端拿不到任何特权。

- **主张复核**：`.tmp/verify-manager-token.mjs` 14/14（含「无 token 拿不到特权」「有 token 能拿到」
  「错误 token 拿不到」「未配置时保持旧行为」「远程模式 token 身份优先」）。
- **最小性**：为了修正方向，回退了首版新增的 `isReserved` 钩子与 `managerIdBlocked` 辅助函数
  （净增行数更少）。
- **新风险**：配了 manager token 且 GUI 未带 token 时，GUI 的 relay 视图（3 秒一次的全量历史轮询）
  会降级——这是**有意**的，也正是 W32 要接上的地方；已记入 Test plan 第 5 行。
- **反例**：尚未证伪的方向——`managerPeers === 'all'` 时凭证不生效（本来人人都是 manager，无意义）。

### 阶段 1：W4 / W5 / W6

- **主张复核**：`.tmp/verify-bind-and-tokens.mjs` 11/11；真 CLI 跑 `--host 0.0.0.0` 退出码 1
  并给出可读原因；`--help` 列出三个新 flag；`--manager-token` 启动后 `/healthz` 正常。
- **最小性**：W5 的权限 warn 在 Windows 上直接跳过（无 POSIX mode bits），这是有意的。
- **新风险**：`--host` 非回环且无 token 的现有部署会起不来，必须加 `--auth-tokens` 或 `--insecure`——
  已在 `server/README.md` / `TEAM-DEPLOY.md` / `README.md` 写明。
- **反例**：未验证——真实 Caddy/nginx 反代下的行为、mac/linux 的权限 warn 路径（本机是 Windows）。

### 越界观察（本轮不改，供后续安排）

对抗性探针在搭用例时撞到一处既有不一致：**`bridge_group_create` 拒绝空的 `members` 数组**
（`hub.createGroup` 先判 `unique.length === 0` 再 `unshift(createdBy)`），而工具描述写的是
“你自动成为成员，`members` 是额外的 peerId”。也就是说“只有自己的群”建不出来。
这不在 W1–W6 范围内，**本轮不改**（不顺手重构），已记在这里供后续单列一项——
建议并入批次 D（任务/分组语义）或单独一个小项，修法是调整 `createGroup` 的判定顺序。

### 阶段 1：独立对抗审查（第二意见，审查者已返回）

审查者在**最终快照**上重跑了全部结论，给出 3 个阻塞项与若干建议项。逐条处置：

| 发现 | 严重度 | 处置 |
|---|---|---|
| `pushRelay` 仍按 peer id 判 manager，改 `requireManager` 时漏了它 | 高 | 已修：抽出导出的 `isManagerCaller`，**工具门与 SSE 中继同源**；新增回归用例证明抢注者收不到中继、持凭证者收得到 |
| `--allow-join` 让 `originAllowed` 的同源分支无凭证可过 | 中 | 已修：同源分支额外要求请求确实带 `Authorization` 头（“有身份”≠“出示了凭证”） |
| `--allow-origins` 缺 `Access-Control-Expose-Headers`，浏览器读不到 `Mcp-Session-Id` | 中 | 已修：回显 origin 时一并回 `Access-Control-Expose-Headers: Mcp-Session-Id` |
| `addToken` 与 `loadTokenFile` 规则不一致，CLI 能写出让 hub 起不来的表 | 中 | 已修：抽出 `PLACEHOLDER_TOKEN`，写入路径同样校验 |
| 桌面 GUI 配 manager token 后失去管理能力 | 中 | 按审查者给的第二个选项处置：文档写清填法与影响（`server/README.md` + `README.md`）；app 侧自动读凭证归 W32 |
| `manager.token` 读取失败静默降级为“谁先到谁得” | 低 | 已修：只把 ENOENT 当“未配置”，其它错误直接抛 |
| `--manager-token` 与 `--auth-tokens` 同时使用时前者完全失效 | 低 | 已修：组合出现时启动打 warn，说明原因与替代做法 |
| 403 响应不带 `Vary: Origin` | 低 | 已修：`Vary: Origin` 无条件发送 |
| 三处注释/文档与实现不一致 | 低 | 已修 |
| `secretEquals` 长度不等提前返回 | — | 审查者判定可接受，保留 |

审查者**未能证伪**的方向（默认回环下的 Origin 绕过、重复头/畸形 URL/IPv4 变体、响应头注入与 DoS、
`--host` 非回环绕过、占位符正则廉价绕过、调用点漏改）记在它自己的报告里，本轮不重复。

- **主张复核**：五套断言脚本（20/14/11/33/10）与 `pnpm test` 291/291 全绿，见 Test plan 7b/7c。
- **最小性**：`isManagerCaller` 是抽取而非新增逻辑；`Expose-Headers` 与 `Vary` 各一行；其余都是局部修正。
- **新风险**：`--manager-token` 下 GUI 的 relay 降级（有意，已文档化）；
  远程模式下 manager token 被忽略（已 warn）。
- **反例**：未验证——真实反代与真实浏览器；mac/linux 的权限 warn 路径（本机是 Windows）。

**四问结论：审查的 3 个阻塞项已全部修复并有回归用例锁定，阶段 1 闸门放行。**

### 阶段 2：W7（可达性）—— 自查改掉两版

首版把收件人判定放宽成「注册过 **或** 有档案」，结果被既有 smoke 用例当场拦住：
`chat to unregistered peer rejected` 挂了——显式退出的 peer 仍然被当成可寻址，
而那是一条有意为之的约定（防的是拼错 id 后静静排队）。

第二版收紧为「注册过 **或** 处于 **parked**」，区分三态：
**暂时离开**（GC，可寻址、保留待取）、**主动退出**（`bridge_unregister`/踢人，不可寻址、删信箱）、
**从未存在**（不可寻址）。

期间还修了两个自己引入的问题：一是 `unregister` 的 doc 注释丢了 `*/`，
整个方法被注释掉（typecheck 直接报 `unregister does not exist`）；
二是只给 `hub.status` 加了 `reachable` 却漏了 `hub-tools` 的 `rosterFor` 投影，
工具输出里看不到该字段（被新断言拦住）。

- **主张复核**：`.tmp/verify-reachability.mjs` 9/9（parked 保留并按序取出、parked 可 chat/task、
  从未存在仍拒、显式退出后不可寻址、TTL 过期有 warn）；`pnpm test` 292/292。
- **最小性**：核心只改了 `unregister` / `gcTick` / `compose` 三处；其余是字段透传与
  两处既有断言的改写（已在 Affected behaviors 15 声明）。
- **新风险**：花名册会积累 parked 项（上限是 `parkedTtlMs`，默认 7 天）；
  `bridge_peers` 的返回体新增了两个字段（只增不改，老客户端无影响）。
- **反例**：未覆盖——真实多机/远程模式下的 parked 与 SQLite 恢复组合；
  `parkedAt` 只是内存态，**hub 重启后 parked 记录丢失**，只有信箱本身会被 `importMailboxes` 恢复
  并重新标为 parked（已实现），但“无邮件的 parked peer”重启后不再可寻址。

W7 保持 `[~]`：本条无认证/权限面，不强制独立审查；等 W8–W10 完或一起看阶段 2 的闸门。

### 阶段 2：W8（`ref` 链语义）—— 发现 `MAX_HOP` 原本是死代码

自查时碰到一个比原计划更基本的问题：**`MAX_HOP` 从来没有可达路径**。
`bridge_task` 没有 `ref` 参数，`hub.sendTask` 也写死 `compose(..., undefined, threadId)`，
所以“task 再委派链”在公开 API 上根本建立不起来——旧代码里 hop 实际上只对 chat 递增，
而那正是它把正常对话卡死在第六轮的原因。

因此 W8 多了一处必要的**增量 API**：`bridge_task` 新增可选 `ref`（`hub.sendTask` 第 4 个参数）。
不加这一步，说“task 再委派被限在 5 跳”就是假的。

- **主张复核**：`.tmp/verify-chains.mjs` 9/9（20 轮对话全通；第 51 轮投递但丢 `ref`、饱和在 50；
  后续仍饱和不可重启计数；6 次 task 再委派后饱和在 5；task 答 chat 用宽松上限）；`pnpm test` 292/292。
- **最小性**：核心只改 `compose` 的 hop 计算（按 `kind`/父消息类型选上限）与 `protocol.ts` 新增一个常量；
  `bridge_task` 的 `ref` 是加法。三处既有断言（smoke 的两条 hop、跨重启那条）已按新语义改写。
- **新风险**：旧行为是“超限报错”，现在是“静默丢 ref”——调用方需要靠回执里有没有 `ref` 判断，
  已在 `bridge_chat` / `bridge_task` 工具描述与 `agents/SKILL.md` 里写明。
- **反例**：未覆盖——真实 agent 在长链上的行为；`hop` 饱和后 `importHistory`/SQLite 的往返
  （只验证了单进程内的饱和，未验证饱和值跨重启后的恢复）。

**待办（不属本轮）**：W8 的行为变更需要在 `CHANGELOG.md` 里写明，但 CHANGELOG 按版本号分节、
当前没有版本 bump（发布动作需用户授权），所以留到发布 SOP 第 2 步写入。
### 阶段 2：W9（`notice` 从声明变为可达）

选择「新增 `bridge_notice`」而不是「从 `KINDS` 移除 `notice`」，理由是后者有数据损失：
`importHistory` 用 `KINDS.includes(kind)` 校验，删掉后已持久化的 `notice` 行会被静静丢弃；
而且没有工具能发 `notice`，所以历史上从来没人收过一条——载荷形状可以自由选择，
于是定为结构化的 `{message, level}`（与 task/ack 一样走 `decodeContent`），而不是纯文本。

- **主张复核**：`.tmp/verify-notice.mjs` 12/12（结构化载荷、单播/广播/群组、给 parked peer 也排队、
  非法 level 报错、不建任务台账、未知收件人仍拒）；`pnpm test` 292/292。
- **最小性**：`protocol.ts` 新增一个接口与一个联合成员，`hub-tools.ts` 新增一个工具，无其他改动。
- **新风险**：工具数 30 → 31，已同步 `AGENTS.md`、`ARCHITECTURE.md` 与 `agents/SKILL.md`；
  README 的工具表本来就是旧的（只列 10 个），归 W10 一并重写。
- **反例**：未覆盖——hub 自己发通知（W16 要的「丢弃 N 条」）需要一个合成 `from`，
  而 `compose` 要求发送方已注册；这个还没决定，留给 W16。

### 第三轮独立审查（针对阶段 1 的门禁）—— 推翻了一次过早的 `[x]`

这一轮审查在**已经标记为 `[x]` 的 W1** 里找到并实测复现了一个真绕过，因此它是
对「阶段 1 已完成」这个主张的反例。记在这里而不是抹掉：

| 发现 | 严重度 | 处置 |
|---|---|---|
| **P1**：loopback + `--allow-join` 下，一个**假的** `Authorization` 头就能打穿同源分支 | 中 | 已修 |
| P2：重复 `Origin` 头的拦截依赖 `new URL()` 恰好抛错 | 低 | 已修（改为拒绝逗号/空白） |
| P3：`--host "127.0.0.1 "` 过守卫却永不监听 | 低 | 已修（绑定前 trim） |
| P4：占位符守卫是前缀锚定 | 信息 | 已改为包含匹配 |

**P1 的机理**：`originAllowed` 原来只检查 `Authorization` 头**存在**，再看 `authenticate` 是否
返回身份；而 `index.ts` 的 loopback + `allowJoin` 分支是 `req => ({peer: ANON_JOIN_PEER, …, anonymous: true})`
——**忽略头内容、恒返回匿名身份**。两个条件被一个随手写的头同时满足，
随后 `Host`/`Origin` 全由攻击者控制。规则：**凡不经凭证即可产生的身份，都不得满足门禁**。

**这是流程上的教训**：第一轮独立审查我说“3 个阻塞项已修 → 放行”，但那轮**没有覆盖 `--allow-join` 组合**。
一个没有被某轮审查扫到的分支，不能因为那一轮绿了就被当作已覆盖。

- **主张复核**：修后新增四条回归断言（假 Authorization 不放行、拼接的重复 `Origin` 被拒、
  规范形式的回环 origin 仍放行、带空白的 host 会绑定），连同原有 8 套断言全部 ALL PASS；`pnpm test` 292/292。
- **最小性**：四处改动都很小（`originAllowed` 两个条件、`listen` 加 `.trim()`、正则去锚点）。
- **新风险**：P4 收紧后，任何**包含** `CHANGE-ME` 字样的令牌不再能加载（含 `X-CHANGE-ME-…`）——
  这是有意的，已在 `.tmp/verify-adversarial.mjs` 与 `.tmp/verify-bind-and-tokens.mjs` 钉住。
- **反例**：审查者列了 10 项自己**未覆盖**的攻击面（`--allow-origins` 两条路径、admin 写接口、
  认证头解析变体、会话固定、`manager.token` 文件来源、真实反代、`Origin` 编码形式、
  `[::ffff:127.0.0.1]` 绑定写法等），本计划不声称这些已被覆盖。

### 阶段 2 独立审查 —— 又一个高危藏在扫过的分支里

审查者先自己重建了 `test/entry.mjs` 再跑 `pnpm test`（292 全绿）与 `pnpm typecheck`，
然后针对 W7–W10 写了新的探针——下面每一条都是它实测出来的，不是推理。

| 发现 | 严重度 | 处置 |
|---|---|---|
| **renamePeer 不维护 `parkedAt`**：把一个**在线** peer 改名到一个 parked id，它会继承那条 parked 记录，随后 TTL 到点**删掉这个在线 peer 的邮箱**（实测日志：`parked mailbox for 'peer-b' expired ... 1 message(s) dropped`）。自改名同样触发，不需要 manager 权限 | 高 | 已修（两处） |
| **广播不投递给 parked peer，直发与群发却可以**：`to:'all'` 静默漏掉一个 `bridge_peers` 刚列为可寻址的 peer | 中 | 已修（扇出统一走 `audience()`） |
| **`ref` 被丢弃时 ack 与 `bridge_wait({ref})` 失去关联**：账本已 `done`，但 waiter 永远等不到 | 中 | 已修（见下：设计反转） |
| parked 邮箱过期不与 task 账本对账 → 永远 pending 的行 | 中 | 转 W51 |
| `--peer-idle-timeout-ms 0` 时 `parkedTtlMs` 失效 | 低 | 转 W52 |
| 空邮箱 park 也回调 `onMailboxExpired(peer, 0)`，打出“0 message(s) dropped”并触发无关快照 | 低 | 已修 |
| README 声称 “31 in total” 但控制工具表只有 10 行（漏 `bridge_pane_wait`） | 低 | 已修 |

#### 设计反转：`ref` 不再被丢弃

原计划（本文件 W8）决定「超上限时投递但丢 `ref`」。审查者给出了反例：`deliver` 的等待器过滤
要求 `message.ref === waiter.ref`，所以丢 `ref` 就等于**让 `bridge_wait({ref})` 永远等不到那条回复**；
任务链深到 50 时，连 ack 都会变得无法关联。

而且丢 `ref` 并没有限制任何东西——下一条消息会开一条全新的链，计数从 1 重新计。
所以两个设计都没能做到“限制循环”，而丢 `ref` 额外破坏了关联性。

现改为：**计数饱和，`ref` 永远保留**。`hop` 变成一个只增不减的深度指示器（到顶就停），
消息与其 `ref` 始终原样送达。已加四条回归断言把它钉住，其中包括审查者的原例
（饱和链上 ack 仍带 `ref`，且 `bridge_wait({ref})` 能取到它）。

**这是本计划里第一处被实测推翻的设计决定**，原文保留在上面 W8 行里（已标注）。

#### 四问

- **主张复核**：`.tmp/verify-phase2-edge.mjs` 全绿（parked 的直发/广播/群发/踢除/过期、
  饱和链上的 ack 与 waiter、notice 的无损 JSON）；`.tmp/verify-chains.mjs` 全绿（含新增的 ack 回归）；
  `pnpm test` 292/292；`pnpm typecheck` 干净。
- **最小性**：`renamePeer` 两行 delete、`expireParkedMailboxes` 一个跳过分支、`audience()` 一个方法
  （替掉两处 `this.peers()`）、`compose` 去掉一个变量。
- **新风险**：广播现在会向 parked peer 排队，上限是 `parkedTtlMs`（7 天）与每 peer 的 `maxQueue`（200）；
  写 `hop` 的语义从“可截断的链”变成“只读深度”，已同步 SKILL.md 与两个工具描述。
- **反例**：审查者明确列了它**没有**覆盖的面——`app/`（Rust/Tauri）对新增 roster 字段
  `reachable`/`queued` 的反序列化、桌面端对 parked 行的呈现、`src/auth.ts` 与 `src/mcp-server.ts`
  （不属 W7–W10 范围）。本阶段不声称这些已被覆盖。

### 阶段 3 独立审查 —— hub 侧正确，但把自带客户端从「静默可用」改成了「永久卡死」

审查者自己用 `git archive HEAD src` 把**改动前**的 hub 打包出来做 A/B，所以下面每条都有对照。

| 发现 | 严重度 | 处置 |
|---|---|---|
| **W11 + 我的 `clear_session` = 桌面端在外部重启 hub 后永久卡死**：`require_mcp` 只在 `state.mcp` 为 None 时重建，而 404 返回的 `McpError::Protocol` 不在「丢弃引用」的名单里；`initialize` 已清掉会话、于是后续调用全部 `no MCP session`。旧 hub 是 adopt 旧 id 自愈的，W11 把这条路径删了 | 高 | 已修（见下） |
| **W13 确定性饿死第二个客户端**：两个会话共享一个 peer 时，`bound.find(...)` 永远选第一个，session2 收到的提示恒为 0；桌面端 `SELF_PEER_ID` 固定，两个 GUI 实例就是这种情况 | 中 | 已修（轮转） |
| **W13 引用的 MUST 未贯彻**：`pushRelay` 仍把字节相同的同一 JSON-RPC 消息发给每条管理流 | 中 | 已修（同样每个消息只发一条流） |
| **被拒绝的 `bridge_register` 仍然改状态**：`hub.register` 在 `bindPeer` 之前，绑失败时 peer 已进花名册、进 `profiles`（会落盘）、邮箱开始永久积压 | 中 | 已修（换序） |
| allow-join 下未鉴权方可区分「未知 id（404）」与「已知且属凭据用户（401）」，泄露 UUID 存在性 | 低 | 转 W54（文档写明） |
| POST 先验版本、GET 先验会话 → 同一请求两种状态码 | 低 | 转 W55 |
| 404 路径回显客户端给的 `Mcp-Protocol-Version` | 低 | 转 W55 |
| `SessionRegistry.sessions` 无界增长，且使「已终止的 session」不可表达 | 低 | 转 W53 |

#### 桌面端恢复路径（W32 的核心提前到这里）

`cargo` 不可用就不能声称修好，所以这条以编译结果为准：

1. `McpError` 新增 `SessionGone`（404 专用），不再用泛化的 `Protocol`。
2. `tools_call_checked` 把 `SessionGone` 与 `Http`/`NotConnected` 并列——一并丢弃 `state.mcp`，下次调用才会重建并重新 `initialize`。这正是审查者指出缺的那一环。
3. `subscribe_notifications` 同样把 404 映射为 `SessionGone`；并在自身无 session 时**采纳响应头里的 `Mcp-Session-Id`**，否则这条流会挂在一个「hub 映射不到任何 peer」的会话上：广播能收到、单播推送永远收不到。

#### 一个有意为之的例外（不是遗漏）

`peers_changed` 仍然广播给每条流。理由：它是**状态快照**（幂等），不是「给某个收件人的一次投递」；
轮转它会让除当前流以外的每个客户端花名册变脏，代价比重复更大。审查者的探针仍把这条报为
「存在」——那是预期结果。如果将来要求逐字遵守规范，正确做法是把花名册改成客户端拉取。

#### 四问

- **主张复核**：`.tmp/verify-session-404.mjs` 15/15；`.tmp/verify-notify-one-stream.mjs` 12/12（含「四条消息恰好四条提示」「两条流都被喂到」
  与消息去重）；审查者**自己的**两份探针现在反转：`adv3-register-ghost` 的 5 条 FINDING 全变 FAIL（bug 已消失），`adv3-w13` 的 pushRelay 两条 FINDING 同样变 FAIL；`pnpm test` 292/292；`pnpm typecheck` 干净。
- **最小性**：hub 侧改动是两处换序/轮转 + 一个工具函数；桌面侧是一个错误变体 + 两处 match 条件 + 一段头采纳。
- **新风险**：轮转引入了 `streamCursor`（一个无界 Map，键是 peer id／'relay'）；
  广播语义刻意保留；桌面端恢复路径**未经真机验收**（见下）。
- **反例**：审查者列了 7 项未覆盖——最关键的是**没有真的跑 Tauri**（恢复路径是按 Rust 源码逐行建模 + HTTP 层实测），
  以及未测真实第三方客户端在 `initialize` 携带陈旧 id 时的行为、hub 重启 + SQLite + remote auth 三者叠加的 token 重绑定、
  真实多进程双 GUI、长跑内存、HTTP/2 下的重复头合并。本阶段不声称这些已被覆盖。

**计划里一个预判被证伪**：风险项 4 说「W11 会打破 smoke 的 idle GC 用例」。实测 292 全绿，
原因是 `sessions` 从不清理（`hasSession` 对 GC 掉的 id 仍为真），而且仓库里**没有任何测试携带重启前的 id**。
所以「没红」既不能证明 W11 生效也不能证明它没生效——真正的证据是上面那份专用探针。

#### 跑 Rust 套件时撞到一条**早就红着**的测试（与本轮改动无关，但根因是一个真缺陷）

`cd app/src-tauri && cargo test` 编过了，但 `e2e_hub.rs::e2e_gui_client_push_timeliness_against_real_hub` 挂了：
`GUI SSE did not receive the message within 3s of send`。

我先怀疑是自己的 W13 改动，于是把同一个场景（单客户端 + 一条流 + 另一个 peer 发消息）写成
`.tmp/verify-single-push.mjs`，并用审查者从 `git archive HEAD src` 构建的**改动前 hub** 做 A/B：

| hub | 「在花名册里」 | 「bob 能发出去」 | 「流收到推送」 |
|---|---|---|---|
| HEAD（改动前） | FAIL | FAIL | FAIL |
| 本轮改动后 | FAIL | FAIL | FAIL |
| 加上下面的修复 | ok | ok | ok |

两侧完全一致，所以**不是本轮引入的**——它是一条长期红着的测试。根因：
`bridge_register` 的 handler 写的是 `const peerId = String(args.peerId)`，而 schema 没把 `peerId` 标为必填。
于是 `bridge_register {}`（app 自己的 e2e 测试就是这么调的）把 peerId 变成字面量 `"undefined"`，
又因为 `"undefined"` 与当前 id 不同，重命名路径把它当成一次改名——**把 peer 原子移到了 `"undefined"`**，
之后所有发给真实 id 的消息都变成 `unknown recipient`。

修法：缺参意为「保持我现有的 id」（可选参数的自然读法），而不是 `"undefined"`；会话没有任何绑定则报一个可读错误。

- **主张复核**：`.tmp/verify-single-push.mjs` 从 3 失败变为 5/5；`pnpm test` 292/292；`cd app/src-tauri && cargo test` **全绿**（34 单测 + 3 端到端，其中包括那条原本红着的 `e2e_gui_client_push_timeliness`）。
- **最小性**：handler 开头一处取值 + 一条守卫。
- **新风险**：以前依赖 `bridge_register {}` 会「把 id 改成 undefined」的调用方不存在（那本来就是 bug）。
- **反例**：未验证真实第三方客户端会不会不带 `peerId` 调 `bridge_register`；修后它会保持现有 id（而不是报错），
  如果某个客户端期待报错，行为会不同于预期——但比默默改名安全。

### 阶段 4：W14（消息序号与续读游标）

**先定了一个语义**（计划要求先定清楚）：`seq` **跨重启只增不减**。hub 恢复历史时把计数器抬到恢复到的最大值，
从不让它回退——客户端的游标才有意义。旧库里没有 `mseq` 的行恢复后没有 `seq`，
它们只在**不带游标**时可见；带游标时被跳过，这是对「早于游标机制的历史」最诚实的处理。

- **主张复核**：`.tmp/verify-seq-cursor.mjs` 12/12（逐渐递增；`lastSeq` 一致；`since` 恰好取回缺失部分且无重；
  再读为空；`since: 0` = 全部；负数报错；跨重启计数不回退、旧游标仍生效）；`pnpm test` 292/292。
- **最小性**：协议加一个可选字段、hub 加一个计数器与三个 `since` 参数、持久化加两列（`messages` 与 `mailboxes`，
  因为 `messageToRow` 被两张表共用）、工具加一个参数。
- **新风险**：`bridge_status` 与收据各多一个字段（只增不改）；`seq` 写入了 `messages` 与 `mailboxes` 两表，
  旧库靠既有的 `ALTER TABLE` 循环就地迁移（已实测：旧格式库能升上来）。
- **反例**：未覆盖——`bridge_history` 带游标时仍然要过 `limit` 截断，所以**游标 + 小 limit 会静默丢掉中间的消息**
  （客户端必须自己循环直到返回为空）；也没有验证超长跑下计数器是否会超出 JS 安全整数（按当前量级不现实）。

#### 本轮我自己的编辑事故（记下来，不是工作日志）

两次 `edit` 的锚点范围开得过宽，各删掉了一行：

1. 把 `rowToMessage` 里恢复 `hop` 的那一行替换掉了 → 跨重启后 `hop` 从 5 变成 1。
   是 smoke 里那条跨重启断言报出来的，根因花了三个探针才定位（先看恢复结果、再直查 SQLite 原始行）。
2. `messageToRow` 返回值多一个而 `mailboxes` 的 `INSERT` 仍只有 11 个占位符 → **整个持久化套件 5 条失败**（写入抛错，什么都没存）。

两次都是「替换范围包含了我没打算动的行」。可靠的做法是把范围收缩到真正要换的行，或改成插入而非替换。
最终状态由 typecheck + 292 项测试 + 13 套断言确认。

### 阶段 4：W15（租约式消费）

`bridge_wait` / `bridge_poll` 新增 `ack: 'manual'`；新增 `bridge_commit` / `bridge_nack`；
`leaseTtlMs` 与 `maxAttempts` 两个配置（带 CLI 开关）。

**两个设计点写在这里**：一是 `attempts` 存在 hub 的独立 Map 里（键是 `peer + message id`），
**不**挂在消息对象上——否则重新入队就丢掉计数，而且会顺带被写进 SQLite；
二是租约完全在内存里，重启后消息回到普通队列（at-least-once，不会凭空消失）。

> **更正（后续迭代，本条已过时）**：租约不再"完全在内存里"——`exportMailboxes()` 现在把未提交的租约
> 跟在队列后面一起导出，重启后恢复成普通队列邮件（未提交的租约按同一 message id 再投一次）。
> 取代此段的是 `docs/plans/ack-integrity-plan.md` 的 W8（以及 `test/e2e.mjs` 里跨进程重启的租约用例）。
> 上面这句保留原文，仅作当时的记录。

- **主张复核**：`.tmp/verify-lease.mjs` 19/19（auto 仍然直接消费；manual 到期后同一条消息再来且 `attempts` 递增；
  commit 后不再回来；nack 立即回到队首且计数继续涨；超过 `maxAttempts` 变死信、花名册显示 `deadLettered`；
  nack 能复活死信并把计数归 1；阻塞中的 waiter 收到的也是租约；`ids: []` 被拒）；`pnpm test` 292/292。
- **最小性**：hub 里一个 lease 表 + 两个计数表 + 四个方法；工具层两个新工具、两个参数；
  配置多两个透传；文档同步工具数 31 → 33。
- **新风险**：**旧客户端不会用租约，行为不变**（默认是 auto）；但 `leaseTtlMs` 过短会让慢处理的 agent 反复收到同一条；
  死信目前只能通过 `bridge_nack` 复活，没有“列出死信”的入口（信息只在 `bridge_status` 的计数里）。
- **反例**：未覆盖——租约不跨重启（重启后正在处理中的消息会重新投递，对 at-least-once 是安全的，
  但没有测试钉住）；也没有验证多个会话共享同一 peer 时租约是否互相干扰（`leases` 是按 peer 而非按会话存的）。

**探针揭示的一个真缺陷**：`startHub` 把 `HubConfig` 拆成 `HubOptions` 时是**白名单式**的，
我新加的 `leaseTtlMs`/`maxAttempts` 没有透传，于是租约永远是默认的 60 秒——
探针里等了 450ms 发现消息没回来才定位到。已补透传，并给两个选项加了 CLI 开关（否则又是「死选项」）。

### 阶段 4：W16（丢弃可观测）

**先定了一个必须决定的事**：hub 自己发的通知用什么 `from`。它没有会话，走不了正常的发送路径
（那条路径要求发送方已注册）。定为保留 id `hub`：注册与改名都拒绝它（与 `all` 同级），
否则任何客户端都能冒充 hub 发通知。客户端可以 `bridge_wait { from: 'hub' }` 专门订阅这类通知。

**溢出与过期用两种不同的投递方式**，因为它们的前提不同：

- **溢出**意味着邮箱已满，把通知排进去会再挤掉一条——所以只递给**正在等待**的 peer。
- **过期**与邮箱是否满无关，通知可以直接入队，收件人下次读取就能看到。

- **主张复核**：`.tmp/verify-drops.mjs` 16/16（溢出与过期分开计数且互不污染；等待中的 peer 收到 `from: hub` 的通知；
  过期消息不被投递；过去/非数字的 `expiresAt` 在发送时就被拒；`hub` 不能注册也不能改名成它；
  截止时间跨重启仍在）；`pnpm test` 292/292；15 套断言全绿。
- **最小性**：协议加一个可选字段与一个保留常量；hub 加一个计数表与三个方法；工具层两个参数；持久化加一列。
- **新风险**：计数是**内存态**（重启归零）——它们是运维计数器，不是持久状态；
  过期通知会占用一个队列位置（已在满时回退到只递给等待者）；`hub` 作为新的保留 id 需要同步到文档与技能。
- **反例**：未覆盖——没有验证多个会话共享一个 peer 时通知递给了哪一个（`deliverToWaiter` 取第一个匹配的）；
  也没有度量“通知本身被丢弃”的情况（溢出时若无人等待，计数涨了但收件人只能从 `bridge_status` 看到）。

#### 探针抓到的第二个真缺陷（与本项同源）

`.tmp/verify-drops.mjs` 里“截止时间跨重启”那一条失败了：恢复出来的消息**没有 `expiresAt`**。
根因不在持久化写入（SQLite 里那一列是对的），而在**读取后的重建**：
`importMailboxes` 与 `importHistory` 都是逐字段重建消息对象的白名单，我加了列却忘了在这两个函数里放行。
`importMailboxes` 连 W14 的 `seq` 也没带——也就是说 **W14 的“跨重启后游标仍连续”对邮箱里的消息其实不成立**，
只是 W14 的探针没覆盖邮箱路径。两处都已补齐。

这是本轮第二次“新增字段只改了一半”的类型：第一次是 `startHub` 的白名单透传，这次是恢复时的白名单重建。
两处都是**同一份字段清单存在于多个地方**的后果。

### 阶段 5：W17–W21（安装配置收敛）

**先读的那条约束是硬约束**：本机有 gemini/codex 的配置文件，但 `gemini`/`codex` 命令不在 PATH 上。
所以 W18（把「已安装」与「有配置文件」分开）**必须**与 W17（`probePaths`）同批，否则这两家会停止被配置。
已按计划为十一家补上 `probePaths`（`~/.minimax`、`~/.config/opencode`、`~/.kimi-code`、`~/.gemini`、
`~/.codex`、`~/.zcode`、`~/.dsh`、`~/.claude`、`~/.qwen`、`~/.cursor`、claude-desktop 的 Application Support）。

本机实测（`node lib/cli.js discover`）：`gemini-cli` / `codex` / `zcode` / `dsh` / `claude` 靠 `probe-path` 命中，
`opencode` / `kimi-code` 靠 PATH，`mcode` 仍然未安装（本机没有 `~/.minimax`）——与预期一致。

- **主张复核**：`pnpm test` **300/300**（setup 42、discover 26，各 +5/+3 新增用例）；
  空 home + 空 PATH + no npm 跑 `setup` → **零文件创建**（含 `~/.agents`）；
  只有 `~/.minimax` → mcode 被识别、配置文件**不**被创建、技能同步到 `~/.minimax/skills/`；
  废弃壳在假 home 上实测转发正确（先跑 PATH 上的已安装 CLI，去掉后走本地 `lib/cli.js`，
  两次都只给检测到的 agent 建技能目录）。
- **最小性**：注册表加一个可选字段、`discover` 换掉判定顺序、`setup` 加一个 `--force` 与一段报告、
  技能目录列表加一个条件、脚本改成 40 行转发壳。
- **新风险**：`claude` 在本机由「未安装」变成「已安装」（`~/.claude` 存在）——它没有 `configs`，
  所以只会多写一个技能文件 `~/.claude/skills/agent-hub/SKILL.md`；本轮**没有**在本机跑过 `setup`，
  所以那个文件还没被创建。
- **反例**：未覆盖——`pi` / `qoder` / `codebuddy` 没有可靠的 probePath（没有配置文件也没有已知状态目录），
  它们仍然只能靠命令或 npm 命中；Windows 之外的真实平台没有验证。

#### 一个诚实的限定：`configOnly` 对**内置注册表**永远不会触发

W18 要区分「已安装」与「只是有配置文件」。但内置注册表里**每一条**的配置文件都位于它自己的 probePath 之内
（`~/.codex/config.toml` ⊂ `~/.codex`），而 probePath 一旦存在就意味着目录在——
于是「有配置文件」与「probePath 命中」是同一件事，`configOnly` 永远为假，`--force` 实际上是潜在选项。

机制本身是好的（`test/discover.mjs` 用一条合成记录——配置在 probePath 之外——验证了它确实能识别并跳过），
但**不能声称它在本项目当前支持的 agent 上生效**。真正的作用是：一个没有任何安装信号的 agent 不再因为
“某处碰巧有个同名配置文件”而被当成已安装。

### 阶段 6：W22–W25（唤醒与执行器）

**先把问题说准**：hub 是邮局，任务会静静躺在收件人信箱里直到它调 `bridge_wait`。对一个正在循环的 agent
这没问题；对一个不在循环的 agent，就是永远——发送方的 `bridge_wait { ref }` 永远不解析。执行器就是给这种情况的。

触发点落在 hub 已有的分支上：`deliver()` 只有在**没有 waiter** 时才会入队，所以新增的 `onTaskQueued` 钩子
（只对 `kind === 'task'` 触发）天然就是「没人在听」的信号。

- **主张复核**：`.tmp/verify-runner.mjs` 17/17（目标不调 `bridge_wait` 仍拿到终态 ack；runner 输出进 note；
  **失败** 落 `failed` 且 note 写明原因；**未配置** runner 的 peer 任务留在信箱、无报错；
  `maxMessages` 批量与默认单条两种形状；同一 peer 的两个任务不交叠）；`pnpm test` 300/300。
- **最小性**：新文件 `src/runner.ts`（接口 + 两个实现 + 注册表 + 校验）；hub 加一个钩子、一个 `ackForRunner`、
  一个 `system` 旁路标志；index.ts 加接线与串行队列；CLI 加一个 `--runner`。
- **新风险**：**执行器会在本机跑命令**——默认关闭，与 herdr 控制工具同一姿态；
  prompt 作为**单个 argv** 传入、不经 shell（有专门的用例验证空格/引号/`$`/反引号不会变成命令）；
  同一 peer 串行执行（两个 runner 争一个终端会交叠）。
- **反例**：未覆盖——真实 `codex`/`claude` CLI 的调用参数没有实测（用的是 `node -e` 假 runner）；
  herdr runner 只经类型检查，没有对着假 herdr CLI 跑一遍；执行器与租约/游标组合没有交叉验证。

#### W24 为什么不做

`httpRunner`（回调 webhook + 至少一次投递 + 指数退避）本轮**有意不做**，理由不是工作量大，而是：
至少一次投递要求**接收方**去重（幂等键），而 A2A 的推送语义目前在本项目里还没有一个被验证过的接收方约定；
先做一个没有幂等键的重试器，等于把一个重复执行的 bug 发出去。等 W39–W44（能力声明 / AgentCard）
把「peer 声明自己的回调地址与幂等键」定下来之后再做，才是完整的。

#### SSE 的定位（W25 的文档部分）

写进 `agents/SKILL.md`：SSE 推送是**客户端运行时的事件通道**，它不会产生模型回合——
“唤醒一个不在轮询的 agent”靠的是执行器，不是推送。把这两件事分清，才不会有人以为把流接上就等于 agent 会被叫醒。

### 阶段 7：W26–W31（任务语义与能力）

本阶段新增 4 个工具（`bridge_task_cancel`、`bridge_task_input`、`bridge_announce`、`bridge_discover`），
工具总数 33 → **37**。

- **主张复核**：`.tmp/verify-task-states.mjs` 26/26（中断态可续跑、双向取消、终态锁、权限边界、A2A 别名）；
  `.tmp/verify-announce.mjs` 22/22（卡片可见、过滤生效、非法卡片被拒且不破坏已有卡片、两条持久化路径各重启一次）；
  `pnpm test` 300/300；`pnpm typecheck` 干净。
- **最小性**：两个状态枚举加值 + `aggregateTaskStatus` 一个分支；hub 上两个新方法；`PeerCard` 一组可选字段；
  persist 加一列与一段迁移；工具层两个新工具与一个校验函数。
- **新风险（已发现并修复两个）**：
  1. **卡片会静默丢失**：`announceCard` 没有触发 `onPeersChanged`，而 roster 只在被标记为脏时才写盘。
     若上一次保存已经跑过（例如 peer 注册之后），之后再 announce 的卡片永远不落盘，重启后恢复的是旧卡片。
     已用 A/B 验证：注释掉修复后，探针里「最后一次保存之后才 announce 的卡片」用例变红，恢复后变绿。
  2. **ack 不继承 `threadId`**：`sendAck` 路由时没带线程，于是按 `threadId` 等待的客户端看不到它正在跟踪的任务的结果。
     已修（同时补上 `cancelTask` / `taskInput` 的两条路径）。
- **反例**：未覆盖——`bridge_discover` 的 `load.running` 只在单 hub 进程内统计；卡片与 `bridge_peers` 的
  并发更新没有压测；`auth-required` 状态明文不做（无人用它）；桌面端与 admin 控制台都还没展示卡片。

#### 一个有意保留的行为：announce 会推一次全量 roster

`announceCard` 现在会触发 `onPeersChanged`（为了落盘），所以它会顺带推一次 `peers_changed` 给所有流。
这是**有意的**：卡片就是 roster 状态，订阅者读到的 roster 应该是新的。它是已有 `peers_changed` 语义的延续
（该事件本来就是幂等的全量快照），不是新引入的广播模式。

### 阶段 8（进行中）：W32 / W34 / W35

#### W32：杀掉 hub 后自身 id 不退化

重建链路在 W11 那批已经存在：404 → `McpError::SessionGone` → `tools_call_checked` 丢掉 `state.mcp`
→ 下一次调用走 `require_mcp` → `ensure_mcp_initialized`（里面同时有 `initialize` 与 `bridge_register`）。
本轮补的是**自检**：注册回执里的 `from` 是 hub 实际绑定的身份，把它与 `SELF_PEER_ID` 对比，不一致就明确告警
（`managerPeers` 默认含 `agent-hub-cli`，绑定到别的 id 就意味着 GUI 静默失去名册权限与 relay 视图）。

#### W34：显示窗口（用户最初提的那条）

新增 `app/src/lib/displayWindow.ts`：**纯函数**、无依赖。窗口语义：

- `hours = 0` / `maxMessages = 0` 都表示「不限」，是默认值——没打开过设置面板的安装行为与之前完全一致。
- 时间边界**含等号**：恰好 N 小时前的消息仍在窗口内。
- 条数上限保留**最新**的 N 条，且保持到达顺序。
- 设置里的脏值（空串、NaN、负数、小数）一律归一为「不限」，**绝不**变成「全隐藏」。

过滤做在**投影层**（`useVisibleMessages`），池子本身从不过滤——这是「切换会话后消息就没了」那个旧 bug 的教训：
窗口必须可以随时改回去并把旧消息原样带回来。设置项在 `SettingsView` 里单独成区，**立即生效、不重启 hub**。

#### W35：只做了「口径一致」

未读计数与视图现在用**同一个** `withinDisplayWindow`，不再各写一份比较。

但**条数上限故意不用于未读**：它决定「渲染最新的多少条」，不决定「有多少条未读」。
把它用到未读上会让徽标少报（20 条未读显示成「5」），丢掉的就是用户最需要的信号。
所以「一致」在这里指**时间口径一致**，不是两个数字相等。

**未完成**：`unreadList` / `unreadClear` 在 `lib/tauri.ts` 里定义了但从未被调用，未读状态只存在内存里，
重启应用即丢；`markPeerRead` 只在 `DetailView` 选中消息时调用，**点击 peer 不会清零**。两条都未做。

- **主张复核**：`.tmp/verify-display-window.mjs` 25/25（含边界、上限取最新、脏值归一、
  视图与未读时间口径逐值对比）；`app: pnpm typecheck` 退出码 0；`cargo test` 34 + 3 全绿。
- **最小性**：新增一个纯模块 + store 两个字段与一个 setter + 两处过滤 + 设置区一块 JSX + i18n 各 5 条；
  Rust 侧只多读两个配置键与一段自检。
- **新风险**：窗口是**渲染期**过滤，池子仍无限增长到 `POOL_CAP`（1000）——窗口只是不渲染，不减少内存。
  另外 `nowTick` 每 60s 才走一格，所以一条消息会在边界附近最多晚 60s 才从视图消失；窗口以小时计，这可以接受。
- **反例**：未覆盖——**没有跑真实 Tauri 应用**，设置项在界面上的读写、投影层在 React 里的实际表现都只有类型检查；
  跨重启的未读一致性无从验证（未读本就未持久化）。

#### 一条环境发现：`app` 的 `lint` 脚本从来跑不了

`app/package.json` 的 `lint` 是 `eslint . --ext ts,tsx ...`，但 `eslint` **不在** devDependencies 里，
`app/node_modules/.bin` 下也没有它。所以「`cd app && pnpm typecheck && pnpm lint`」这条文档里的验证命令
**只有前半句能跑**。本轮没有自行添加依赖（新依赖需用户确认）；先记录在此。

| 阶段 | 日期 | 证据 | 结论 |
|---|---|---|---|
| 8a | 2026-10-11 | `.tmp/verify-display-window.mjs` 25/25；`app: pnpm typecheck` 退出 0；`cargo test` 34+3；`pnpm test` 300/300 | 部分放行：W32/W34 完成，W35 只完成口径一致；**未跑真实 GUI** |

#### W35 收尾：两端都没接的未读持久化

先把现状查清楚，而不是直接改：`bump_unread` 在**生产代码里从未被调用**（只有它自己的单测），
所以 `count` 列在真实应用里恒为 0；而 `list_unread` 过滤 `count > 0`，于是它**在真实应用里永远返回空列表**。
前端那边 `unreadList` / `unreadClear` 在 `lib/tauri.ts` 里定义了但从未被调用，未读只存在内存里。
两端各自存在，从来没有接上。

改动：

1. `list_unread` 改成 `WHERE last_read_ts IS NOT NULL`——前端要恢复的是**水位线**，包括读到零的 peer。
   旧的 `count > 0` 恰好把它们全部过滤掉。同步改写了那条单测（它固化的正是旧语义）。
2. `unread_clear` 增可选 `ts` 参数。服务端必须存前端认为「已读到」的那个时刻，而不是它自己的时钟：
   否则重新打开一条旧消息会被当成「读到此刻」，把中间未读的消息静默标成已读。
3. 前端：启动时把水位线读回 `lastReadTs`（内存里的优先，因为启动期间可能已经读过）；
   `markPeerRead` 落盘；点击 peer 开会话时清零。

- **主张复核**：新增 `unread_watermark_survives_reopen`——用**真实文件**开关一次数据库再读回。
  这很重要：原有的 `fresh()` 是内存库，只能证明查询，证明不了「重启后还在」，而后者才是这条主张。
  已做 A/B：把查询改回 `count > 0` 后，新旧两条测试都失败（`both watermarks must come back`）；恢复后全绿。
  `cargo test` 35 + 3；`app: pnpm typecheck` 退出 0。
- **最小性**：一个 SQL 条件 + 一个单测改写 + 一个新增文件往返测试 + 一个可选参数 + 前端四处（类型、落盘、恢复、点击）。
- **新风险**：`count` 列与 `bump_unread` 现在是**彻底无用**的代码（生产无调用者，查询也不再读它）。
  本轮没有删它——删列要迁移，删函数要同步删单测，属于独立的小清理。已记为遗留项。
- **反例**：未覆盖——**仍未跑真实 GUI**：恢复、落盘、点击清零的 React 接线只有类型检查。
  前端与 Rust 的 `unread_clear` 参数形状（`ts: null` → `Option<i64>`）没有端到端跑过一次。

| 阶段 | 日期 | 证据 | 结论 |
|---|---|---|---|
| 8b | 2026-10-11 | `cargo test` 35+3（含文件往返与 A/B）；`app: pnpm typecheck` 退出 0；`.tmp/verify-display-window.mjs` 25/25；`pnpm test` 300/300 | W35 完成；遗留：`count` 列清理、真实 GUI 未跑 |

#### W33：桌面端任务通路

先把现状查清楚：`sendTask` 在 store 里定义得完整，**却没有任何调用者**；同时 `bridge_task_cancel` /
`bridge_task_input` 这两个 hub 工具在 Rust 侧根本没有对应命令。所以桌面端能收任务、能 ack，**从来发不出任务**，
也做不了取消与补充输入。

改动：

1. **Rust**：新增 `bridge_task_cancel`（可选 `reason`）与 `bridge_task_input` 两个命令 + `lib.rs` 注册。
2. **协议镜像**：`app/src/lib/tauri.ts` 里的 `AckStatus` / `TaskStatus` 是另一份拷贝（应用不能 import 主仓库），
   `input-required` / `canceled` 它完全不知道；`TaskRecord` 也缺 `artifacts`。已补齐并在注释里写明「这是拷贝，会漂移」。
3. **UI**：派任务入口（输入框旁的切换）；任务面板（DetailView）——账本状态、SLA 倒数/超时、artifacts；
   发送方的「回复并继续」与「取消任务」；被派方的 ack 行补上 `input-required`。

- **主张复核**：`app: pnpm typecheck` 退出码 0；`cargo test` 35 + 3。
  本次没有新增行为断言——**可验证的部分都只是「能编译」**，见下面的反例。
- **最小性**：两个命令 + 两个包装 + 两个 store 动作 + 一个切换按钮 + 一块面板 + 两个镜像类型补齐。
- **新风险（已处理）**：
  1. `ACK_CHOICES` 里**故意没有** `canceled`：取消走专用按钮，因为 hub 会把取消路由给**另一方**并更新
     所有 assignee 行，一个 ack 做不到。
  2. 账本拉取失败时 `ledger` 置 `null` 而不是报错：派生的视图仍然能用，只是少了账本独有的事实。
  3. 面板的刷新依赖「该任务的 ack 数量」：hub 自己合成的 `timeout` 事件也会进池，所以它会跟着刷新。
- **反例**：未覆盖——**仍未跑真实 GUI**；`bridge_task_cancel` / `bridge_task_input` 的参数形状
  （`refId` / `reason` → `Option<String>`）没有端到端跑过一次；派任务后账本面板的实际渲染没见过。
  **已用读代码缩小这个缺口**：Rust 传的参数名与 hub 的 schema 逐字对过——`bridge_task_cancel` 用
  `ref` + `reason`，`bridge_task_input` 用 `ref` + `input`，两侧一致；Tauri 的 `refId` ↔ `ref_id`
  与既有 `bridge_task_status` 同一约定。这是 L2（读代码），不是端到端。

| 阶段 | 日期 | 证据 | 结论 |
|---|---|---|---|
| 8c | 2026-10-11 | `app: pnpm typecheck` 退出 0；`cargo test` 35+3 | W33 完成（timeout 显示已做）；遗留：真实 GUI 未跑，参数形状未端到端验证 |

## 附：下个版本的 CHANGELOG 草稿（SOP 第 2 步的输入；版本号待授权后填）

面向用户的条目，按本计划实施的行为变更整理。发布时逐条核对、删掉未达条目、
按「decimal carry」规则定版本号后移入 CHANGELOG.md 顶部。

- Session lifecycle: an unused session (no live SSE stream) is forgotten after
  --session-ttl-ms (default 30 min; 0 = off). Clients get 404 and re-initialize;
  the hub re-registers them under the same peer id with the mailbox intact.
- Per-peer mailbox rate limit: --rate-per-min caps how fast one peer's mailbox
  accepts mail (0 = unlimited). Excess is counted as droppedRate; a waiting peer
  is never throttled.
- Message priority: bridge_chat / bridge_notice / bridge_task accept priority
  (0|1|2). A mailbox delivers high priority first; overflow drops the LEAST
  important message (oldest within a priority — unchanged when no priority is set).
- Parked-mailbox expiry now reconciles the task ledger: a task whose mailbox was
  destroyed fails with a system event naming the peer, instead of staying pending.
- --parked-ttl-ms works even with the idle GC disabled (--peer-idle-timeout-ms 0).
- bridge_metrics: per-peer and global operational counters.
- bridge_events: the hub's own event stream with a monotonic seq cursor.
- Remote auth: an SSE stream now requires the SAME session's token (a foreign
  token can no longer attach to another user's session and read their mail).
- setup: six more agents (zed, amp, continue, cline, roo-code, amazon-q);
  filename globs (cli-agents/*.json) are supported; the JSON merge compares the
  whole entry (Gemini's httpUrl entry is no longer rewritten on every run), and
  a TOML url change is actually written.
- app: the broken lint script (eslint was never installed) is removed; NFR-6/7
  updated to match.
