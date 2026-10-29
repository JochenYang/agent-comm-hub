# ack 与账本完整性加固 + 多 agent ack 交互改进

- Status: active
- Plan date: 2026-10-29
- Risk: high（授权判定、数据一致性、不可逆账本状态）

## Goal

把 0.10.0 里「谁能改任务账本」「消息消失后账本怎么办」「租约/priority 跨重启是否还在」三类缺口补齐，
并让发送方能一次等到任务终态、状态跃迁可订阅、漏 ack 有提醒。
成功标准：`.devflow/ack-integrity-plan.md` 的 T1–T12 全部 PASS，且断言都提交在仓库里
（T11 依赖 W15，本轮未实现，故按「N/A + 进 Deferred」处理，见 Deferred 与 Test plan #13）。

来源：2026-10-29 的只读审查（4 个 subagent 分范围 + 主 agent 用 `.tmp/probe-{ack,f,g}.mjs` 复核）。
该审查推翻了 `docs/plans/a2a-regression-plan.md:607` 关于租约跨重启的主张（见 W18）。

## Scope

- Must-have：6 条 P1（W1 / W3 / W6 / W7 / W8 / W5 的 `input-required` 分支）+ 与之同源的 P2；
  交互三件（W13 / W14 / W15）。
- Out of scope：跨 hub 联邦、A2A 完整端点、Agent Card 对外暴露、大内容附件、任何新运行时依赖、
  把 `admin/` 或 `app/` 转 pnpm、N:1 会话按 session 隔离租约（见 Deferred）。

## Ruled out

| 方案 | 为什么排除 |
|---|---|
| 用 token 角色代替「是不是 assignee」判定 ack | ack 合法性属于账本语义；loopback 无 token 时判定仍须成立 |
| 靠 `evictOverflowTasks` 淘汰 pending 任务来止血 | 方向相反：等于让任务凭空消失，且掩盖真因 |
| 每条丢弃都给发送方发 notice | 噪音；task 对账 + `mailbox_dropped` 事件 detail 带 `messageId` 已够查 |
| 租约落独立 SQLite 表 | 并入 `mailboxes` 导出形状即可（旧版本读成普通排队邮件 = 重复投递，at-least-once 可接受），省一套 schema 与迁移 |
| 死信并入 `mailboxes` 导出 | 回滚后旧版本会把死信当普通邮件投递，语义倒退；改独立表（旧版本忽略未知表） |
| 服务端默认 SLA 自动判 `timeout` | 没有 heartbeat 会误判；先做提醒（W15），默认 SLA 进 Deferred 等裁决 |

## Work items

| # | 类目 | 内容 | 状态 |
|---|------|------|------|
| W0 | P0 | 先把 T1–T7 写成**提交在仓库里**的失败断言：`test/smoke.mjs` 加非 assignee ack / 丢弃对账 / `deliveredMs` 时序 / 保留 id / `input-required` 恢复；`test/e2e.mjs` 加租约跨重启（真进程 + SQLite）。A/B 记录：修前红、修后绿 | [x] 先红后绿已记录（阶段 0/1 日志）；最终 smoke 259/259、e2e 35/35 |
| W1 | P0 | ack 授权：`src/hub.ts:741-760` 命中账本时要求 `record.assignees.some(a => a.peerId === from)`，否则抛错；`src/hub-tools.ts:662-675` 不额外加判定（保持单一来源）。chat/notice 的 `ref` 走 history 回退（`hub.ts:751-756`）必须保持放行；`ackForRunner`（`hub.ts:770-776`）不受影响 | [x] 行号为计划编写时坐标，实现已漂移（现为 `sendAck` 一处判定）；断言 `ack from a non-assignee is rejected` |
| W2 | P0 | `applied` 与状态一致性：`hub.ts:993-997` 两个分支都加 `assignee !== undefined` 前置；`assignee === undefined` 时不写 `record.status`，改 `aggregateTaskStatus`；`hub.ts:1029` 只在真正变化时推进 `updatedAt`（别让未应用 ack 污染 LRU 与列表排序） | [x] 断言 `terminal lock: late ack recorded but not applied`、`an evicted dead-letter task is settled as failed, not left pending` |
| W3 | P0 | 丢弃对账（**阶段 1 审查后修正语义**）：按「触发权」分级，不再一律写终态。① `expired` / `rate` / `overflow` / dead-letter 四类：只记一条 `system: true, applied: false` 的账本事件 + 给该任务的 sender 投一条 `from: HUB_PEER` 的 notice，**不改任何状态**——死信能被 `bridge_nack` 复活、overflow/rate 又能被第三方流量驱动，写终态会把任务永久锁死（审查发现：复活后 assignee 的 `done` 会变成 `applied:false`；攻击者约 200 条 chat 即可否决任意 pending 任务）。② `unregister`（显式离开/被踢）仍写终态 `failed`：对端已经不在，不存在「复活后还能完成」的路径。`countDrop` 增可选 message 参数，detail 带 `messageId`/`taskId` | [x] **实现即此分级语义**（代码为准）：`noteTaskDeliveryDropped` 只记 `system: true, applied: false` 事件 + 一条 notice，不写状态；`unregister`/parked-TTL 才写终态。断言 `a task dropped by overflow is recorded without closing the ledger`、`the sender is notified when its task delivery is dropped`、`a task dropped at several recipients warns its sender exactly once`、`a revived dead-lettered task can still be completed` |
| W4 | P1 | `markTaskDelivered` 时序：从 `hub.ts:2013` 移到队列路径 `insertByPriority`（`2053`）之后；waiter 分支保留在 handoff 前（handoff 必成） | [x] 断言 `a rate-limited task is not booked as delivered and stays pending`（`deliveredMs === undefined` 且账本仍 `pending`） |
| W5 | P0 | 状态清单同源：`src/protocol.ts` 导出 `ALL_TASK_STATUSES`（由 `TaskStatus` 派生）；`hub.ts:1103` 用它（修 `input-required` 被丢）、`1125` 收窄 assignee 状态、导入末尾按 `aggregateTaskStatus` 对账；`hub-tools.ts:682,692-694` 的 `bridge_tasks` 枚举改用它；`hub-tools.ts:679,711` 描述同步 | [x] 断言 `bridge_tasks accepts the input-required status filter` / `... canceled status filter`；e2e `bridge_task_status still reports input-required after a process restart` |
| W6 | P0 | 保留 id：`hub.register`（`hub.ts:460-477`）拒绝 `BROADCAST` / `HUB_PEER`；`autoRegisterPeer`（`hub-tools.ts:88-97`）消毒后撞保留名时回退到 `agent-<4 位随机>`（不抛错，否则合法客户端连不上）；`src/auth.ts:98` 一并拒绝 `hub`；`bridge_history`（`hub-tools.ts:897-910`）与 `bridge_tasks`（`696-701`）不得再用 `target !== peer` 当管理器闸门——`target === BROADCAST` 一律 `requireManager` | [x] 断言 `registering the broadcast address rejected` / `... the hub peer id rejected`、`hub.register refuses the broadcast address`、`bridge_history peer='all' needs manager rights`、`bridge_tasks peer='all' needs manager rights`；自动注册撞名回退见 `a clientInfo name colliding with a group falls back to a generated peer id` |
| W7 | P1 | `bridge_rename` 身份绑定：`hub-tools.ts:544-565` 对 `registry.tokenFor(sessionId) !== undefined` 且要改 `peerId` 的请求一律 `requireManager`；再拒「新 id 已被别的 token 占用」（`SessionRegistry` 加一个只读查询，不动 `rebindPeerId` `mcp-server.ts:298-307` 的行为） | [x] 断言 `token-bound session cannot re-key its own id via bridge_rename`、`the token peer keeps its bound id after a rename attempt`、`token-bound session cannot claim another id` |
| W8 | P1 | 租约跨重启：`exportMailboxes`（`hub.ts:1350-1356`）把**每一条**租约并进对应 peer 的队列数组（**不新增顶层键**，保证旧版本可读）；**实现比计划更进一步：不过滤 `expiresAt`**——过期判定属于消费方（`poll` / `wait` / `reapLeases`），在导出时过滤会让「已过期但从未被回收」的租约既不在队列也不在快照里，重启即永久丢失。`importMailboxes` 恢复后它们按队列消息投递。`attempts` 允许归零，已在 `AGENTS.md` 写明这是 at-least-once 的弱化 | [x] e2e `an uncommitted lease survives a process restart (same message id)`、`the redelivered lease is not a dead-letter revival`、`(precondition) the message is leased under a 250ms lease` → `it comes back as ordinary queued mail, not as a dead-letter revival`（E2E C3/C4：过期且无人回收的租约仍在快照里） |
| W9 | P1 | 容量与租约记账：租约回队（`hub.ts:1701-1706`）与 `nack`（`1764-1769`）回队后裁剪到 `maxQueue`（超出留在死信并计数）；`commit`（`1730`）只对真正 released 的 id 删 `leaseAttempts`；`unregister`（`486-509`）清理 `leases` / `deadLetters` / `leaseAttempts`，`reapLeases` 回队前校验目标仍可寻址；`deadLetters` 与 `record.acks` / `record.artifacts` 加 per-peer 上限（超限丢最旧并计数）；`idList`（`hub-tools.ts:235-240`）限制 `ids` 长度。**阶段 3 实现补充**：`assignees[].acks` 与账本时间线共用 `MAX_TASK_ACKS`（淘汰顺序先丢 `applied: false` 的普通 ack，`system: true` 的丢弃证据留到最后）；死信淘汰（超出 `MAX_DEAD_LETTERS` 200）同样计数，且对其中已被淘汰的 task 写终态 `failed`（`dead-letter-evicted`），因为复活路径已经不存在 | [x] 断言 `a nack keeps the attempt count, so the next take is attempt 2`、`the exhausted lease dead-letters instead of being handed out again`、`bridge_nack rejects an oversized ids array`、`committing a message that is not leased releases nothing`、`a requeued lease never grows the mailbox past maxQueue`、`the lease that did not fit is dead-lettered, not dropped`、`the per-assignee timeline is bounded by the same limit`、`a system drop event survives 205 ordinary acks` |
| W10 | P2 | 死信可见：新增 `bridge_dead_letters` 只读工具（列 id/kind/from/attempts/ts，不含全文）；死信存独立 SQLite 表（旧版本忽略未知表，回滚安全） | [ ] 未做：只读工具与独立表都不存在。本轮落地的是**上限 200 + 淘汰对账**（归属 W9：`a restored mailbox that exceeds maxQueue counts the eviction (mailbox_dropped names the message)`、`an evicted dead-letter task is settled as failed, not left pending`），仍然没有列出死信内容的入口 —— 见 Deferred |
| W11 | P2 | `priority` 落盘：`src/persist.ts` 的 `messages` 与 `mailboxes` 按现有 `ALTER TABLE` 循环（`persist.ts:98-106`）加 `priority INTEGER`，`messageToRow` / `rowToMessage` 各一处。**准确的理由**（Wave 0 实测修正）：重启后投递顺序目前「侥幸」保持——`mailboxes` 表按 `seq AUTOINCREMENT` 存插入序，而导出时队列已按 priority 排好；但 `priority` 字段本身没落盘，恢复后所有消息读作 p0，于是任何 re-insert 路径（租约回队、`nack`、离线期间新消息到达）都会把原本 p2 的邮件当 p0 重排，且客户端在 wire 上看不到该字段 | [x] e2e `priority 2 is still delivered before priority 0 after a process restart`、`a restored message keeps its priority field` |
| W12 | P2 | 群发成员校验：`src/hub.ts:1901-1917` 的 group 分支要求 sender 是成员（把 `sendToGroup` `1276` 的判定下移，三个工具一起受益）；`1983-1988` 的 dispatch 不变 | [x] **实现位置与计划略有偏差（代码为准）**：判定落在 `compose`（`to` 解析出 group 的那一处），`system` 内部发送方豁免，因此 `bridge_chat` / `bridge_notice` / `bridge_task` 四个入口一起受控。断言 `non-member cannot send to the group`、`non-member cannot chat into a group`、`non-member cannot notify a group`、`non-member cannot delegate a task to a group` |
| W13 | P2 | `bridge_wait` 终态过滤：加 `statuses?: AckStatus[]` 与 `terminalOnly?: boolean`，并把 `hub.ts:1658-1663 / 1805-1810 / 2006-2011` 三份谓词抽成 `matchesWaiter`；同时让 `ref` 也能匹配带同一 `ref` 的 `chat`（assignee 用 chat 回传时不再等空）；描述写明「可能先返回中间态」 | [x] 三份谓词已抽成 `matchesWaiter`；`statuses`/`terminalOnly` 只收窄 ack 一侧（chat 无状态，永不满足状态过滤；payload 无合法状态的 ack 也不满足）。断言 `terminalOnly skips the working beat and returns the terminal ack`、`the intermediate ack a terminalOnly wait skipped is still in the mailbox`、`statuses waits only for the listed ack status`、`an unknown statuses value is rejected, not silently ignored`、`a ref wait resolves on the chat reply the skill teaches (not only on acks)` |
| W14 | P2 | SSE `task_changed`：`protocol.ts:39-41` 旁加事件常量；`index.ts:484-488` 的 `onTaskChanged` 向 `task.from` + 各 assignee 推 `{taskId,status,a2aState,updatedAt}`。桌面端 `commands.rs` 是 catch-all，无需同步改动 | [x] **实现补充**：只在状态**真的**变化时推送（`lastTaskPush` 记最后推送的状态，LRU 上限 512），否则每条 `working` 都会变成一次回显。断言 `SSE pushes task_changed to the sender with status + a2aState`、`SSE pushes task_changed to the assignee too`、`task_changed is not pushed to a peer that is neither sender nor assignee` |
| W15 | P2 | 漏 ack 提醒：`markTaskDelivered` 后 arm 提醒定时器（阈值取 `leaseTtlMs` 同量级，可配），期间无该 assignee 的任何 ack 就投一条 `from: HUB_PEER` 的 notice；**不改账本状态** | [ ] 未做 —— 见 Deferred |
| W16 | P2 | wait 超时带上下文：`WaitTimeout`（`protocol.ts:388-391`）加 `ref?: {status, a2aState}`，timeout settle 时查一次 `taskLedger` | [x] 断言 `a timed-out ref wait reports the ledger state of the ref`（字段为可选，只读 `type`/`waitedMs` 的消费者不受影响） |
| W17 | P2 | 可见性对齐：`bridge_task_status` 的 assignee 行加 `readState`（`queued`/`leased`/`handed`，用现成 `queues`/`leases` Map）；`rosterFor`（`hub-tools.ts:115-157`）补 `waiting`/`inFlight`/`deadLettered`，`bridge_peers` description 写成真实字段；`receipt()`（`338-355`）加 `recipients` 数量（广播到 0 人不再「成功」返回） | [ ] 未做（`src/` 里 `readState` 与 `recipients` 都无命中）—— 见 Deferred |
| W18 | P2 | 文档批修：`agents/SKILL.md:110-117` 改为用 `bridge_ack` 的 `artifacts` 回传；`:41-42`/`hub-tools.ts:625,651` 补 `input-required`；`bridge_nack` 文案与 `hub.ts:1676-1678` 注释改「同优先级队尾」；`README.md:277`、`ARCHITECTURE.md:55` 工具数 37→39；`AGENTS.md` 的租约 at-least-once 段落回改；`docs/plans/a2a-regression-plan.md:607` 的主张加一行更正；测试计数按实际同步 | [x] 本轮完成：SKILL 的 `bridge_wait` 签名（`statuses`/`terminalOnly`）、`input-required` 枚举、用 `artifacts` 回传 + `terminalOnly` 等结论、丢弃提醒与 `from` 过滤说明；`AGENTS.md` 的 Delivery/Routing/Protocol/SSE 行、命名空间与「丢弃不写终态」两条、测试计数 314→419；`README.md` / `README.zh.md` / `ARCHITECTURE.md` §9 计数与版本 |
| W19 | OPT | CHANGELOG 条目 + 版本号：W1–W12 为修复（`0.10.0 → 0.10.1`）；含 W13–W17 时为新能力（`→ 0.11.0`）。**发布动作需用户明确授权**，本计划只准备 | [~] 版本已升 `0.11.0`（`package.json` + `SERVER_VERSION` + `CHANGELOG.md` 顶部条目），**尚未发布**：tag / GitHub release / `pnpm publish` 均未执行，等用户授权 |

类目：P0 不做就走不通 · P1 静默失败或数据风险 · P2 清理与一致性 · OPT 可选（不做要写明理由）。

## Phases

| 阶段 | 包含条目 | Gate | 状态 |
|------|----------|------|------|
| 0 | W0 | T1–T7 先红后绿，A/B 记录进 Phase log | [x] Phase log 阶段 0 行：smoke 174/186、e2e 25/29（红项与条目一一对应）→ 阶段 1/2 转绿 |
| 1 | W1, W2, W3, W4, W5 | 账本类条目全 [x]，T1/T2/T3/T6 PASS，2 个独立 subagent 审查无阻塞 | [x] smoke 193/193（阶段 1 末）、阶段 1 复审后 215/215；审查记录 4 份见 Phase log（`review-phase1-r1/r2`）；T1/T2/T3 PASS，T6 由 e2e 覆盖 |
| 2 | W6, W7 | 身份类条目全 [x]，T4/T7 PASS，2 个独立 subagent 审查无阻塞 | [x] smoke 200/200（阶段 2 末）、`guard` 复审确认 8 种参数组合全部有闸门；`review-phase2-guard.md`、`review-namespace-guard.md` |
| 3 | W8, W9, W10, W11, W12 | 投递可靠性条目全 [x]，T5/T8 PASS，2 个独立 subagent 审查无阻塞 | [~] W10 转 Deferred，其余全 [x]。W10 只落地了上限 200 与淘汰对账，只读工具转 Deferred；T5/T8 转绿（e2e 租约跨重启、`priority` 落盘），T10 由 smoke 覆盖。最终 smoke 259/259、e2e 35/35 |
| 4 | W13, W14, W15, W16, W17 | T9/T10/T11 PASS，1 个 subagent 审查无阻塞 | [~] W15/W17 转 Deferred，其余全 [x]。W13/W14/W16 完成并被断言覆盖（smoke 268/268）；**W15（T11）与 W17 未做，已转 Deferred**，因此 T11 记 N/A；阶段 4 独立审查的 2 条 P1 + 4 条 P2 已修（`ref` 等待只能由当事方回答、超时快照按当事方收口、`terminalOnly` 与 `statuses` 取交集报错、hub 提醒绕过过滤、`task_changed` 记账时机与断言补强） |
| 5 | W18, W19 | T12 PASS，`pnpm test` 全绿，文档计数与实测一致 | [x] 文档批修完成（工具数 39、计数 259+46+11+35+33+35=419、版本 `0.11.0` 三处一致），T12 的「`pnpm typecheck` 全绿」本轮复跑通过；W19 只升版本未发布 |

阶段拆分理由：先补测试（W0）再动高风险代码；阶段 1 与 2 都改授权/一致性但目录不同（账本 vs 身份），
分开是为了让「ack 收窄」的行为变更单独可回滚；阶段 3 依赖阶段 1 的 `failTaskForDroppedMessage`，
否则租约/死信路径的对账没有落点；阶段 4 是纯增量，回滚风险最低，放最后。

## Affected behaviors

- `src/hub.ts:741-760`（`sendAck`）：行为变更——非 assignee 的 ack 从「静默推进账本」变为报错。
  要确认桌面端与 `admin/` 没有以第三方身份 ack 的路径（`grep -rn "bridge_ack" app/ admin/`）。
- `src/hub.ts:981-1032`（`applyAckToLedger`）：`applied` 语义收窄，`bridge_task_status` 的时间线内容变化。
- `src/hub.ts:460-477`（`register`）：新增拒绝分支。要确认没有客户端 `clientInfo.name` 恰好是 `all`/`hub`
  （自动注册改为回退改名，连接不断，但 peer id 会与之前不同）。
- `src/hub-tools.ts:897-910`（`bridge_history`）：`peer: "all"` 的判定方式改变。
- `src/hub-tools.ts:544-565`（`bridge_rename`）：token 会话的自改 id 变为需 manager（桌面端 e2e 若依赖需同步）。
- `src/hub.ts:1350-1397`（`exportMailboxes`/`importMailboxes`）：导出形状不变但内容变多；旧版本可读。
- `src/persist.ts`（schema）：新增列与一张表，均为 additive。
- `src/hub.ts:1803-1887`（`wait`）：新增可选过滤参数，默认行为不变。
- SSE：新增事件名，旧消费者按 catch-all 处理。

## Test plan

| # | 用例 | 输入/操作 | 预期 | 验证方式 | 结果 |
|---|------|-----------|------|----------|------|
| 1 (W1,W2) | 非 assignee 的 ack 被拒且不污染账本 | sender→assignee 单目标任务，第三方 peer 调 `bridge_ack{ref,status:'done',artifacts:[…]}` | 报错；`task.status` 仍 pending；`task.artifacts` 为空；随后 assignee 的 `done` 为 `applied:true` 且 artifacts 计入 | `pnpm build:test && node test/smoke.mjs` | PASS — `ack from a non-assignee is rejected`、`terminal lock: late ack recorded but not applied` |
| 2 (W3) | 限流丢弃提醒 sender，但不关账本 | `ratePerMin:1`，先发 chat 用掉令牌再发 task | 账本**保持** `pending`；`record.acks` 多一条 `system:true, applied:false` 事件；sender 收到 `from:"hub"` 的 notice，文案含 task id | `node test/smoke.mjs` | PASS — `a rate-limited task is not booked as delivered and stays pending`；overflow 分支见 T3 的两条断言 |
| 3 (W3) | overflow / 过期走同一规则，unregister 走终态 | 分别构造满邮箱挤出、`expiresAt` 已过、kick 带 task 的 peer | 前两者：`pending` + system 事件 + notice；kick：转 `failed` + notice | `node test/smoke.mjs` | PASS — 三条路径各有独立断言。overflow：`a task dropped by overflow is recorded without closing the ledger`、`the mailbox_dropped event names the dropped message id`、`the sender is notified when its task delivery is dropped`、`a task dropped at several recipients warns its sender exactly once`；过期（终审轮补）：`a task past its expiresAt is never delivered`、`the recipient is told its queued message expired`、`the expiry is recorded as mailbox_dropped { reason: expired, messageId }`、`the expiry is counted as droppedExpired`、`an expired delivery leaves the task open, not terminal`、`the sender gets one hub notice naming the task whose delivery expired`；kick→`failed`：`the task leased by the departed peer is closed, not left pending`、`a kicked peer gets no lease back on its next take, and the task is settled rather than vanished`（此前记的「kick 一半没有独立断言」已关闭） |
| 4 (W4) | 限流丢弃不置 `deliveredMs` | 同 T2 | `assignees[0].deliveredMs === undefined` | `node test/smoke.mjs` | PASS — `a rate-limited task is not booked as delivered and stays pending` |
| 5 (W6) | 保留 id 不可 claim | 会话以 `clientInfo.name="all"` / `"hub"` 连接；再显式 `bridge_register("all")` | 自动路径得到回退 id（不是 `all`）；显式路径报错；`bridge_history {}` 对非 manager 报错 | `node test/smoke.mjs` | PASS（显式路径 + hub API + 撞名回退）— `registering the broadcast address rejected`、`registering the hub peer id rejected`、`hub.register refuses the broadcast address`、`a clientInfo name colliding with a group falls back to a generated peer id`。**未覆盖**：`clientInfo.name` 恰为 `all`/`hub` 时的自动回退没有独立断言（只有 group 撞名版本） |
| 6 (W6) | `bridge_history {}` / `bridge_tasks {}` 需要 manager | 配 `managerTokenRequired`，普通 peer 调两者 | 都报 manager 错误 | `node test/smoke.mjs` | PASS — `bridge_history peer='all' needs manager rights`、`bridge_tasks peer='all' needs manager rights` |
| 7 (W7) | token 会话不能自改 id | token 绑定 `lisi`，调 `bridge_rename({peer:'lisi',peerId:'agent-hub-cli'})` | 报错（需 manager）；peer 仍是 `lisi` | `node test/smoke.mjs` | PASS — `token-bound session cannot re-key its own id via bridge_rename`、`the token peer keeps its bound id after a rename attempt`、`token-bound session cannot claim another id` |
| 8 (W8) | 租约跨真进程重启 | e2e：`ack:'manual'` 取一条 → 不 commit → 杀进程重启 → `bridge_wait` 再取 | 同一 message id 仍可取到；不出现「既不在队列也不在库」 | `node test/e2e.mjs` | PASS — `an uncommitted lease survives a process restart (same message id)`、`the redelivered lease is not a dead-letter revival`；过期未回收的租约另由 E2E C3/C4 覆盖（`(precondition) the message is leased under a 250ms lease` → `it comes back as ordinary queued mail, not as a dead-letter revival`） |
| 9 (W5) | `input-required` 跨重启存活 | 把任务推到 `input-required` → 重启 → `bridge_task_status` / `bridge_task_input` | 都能用，`a2aState: 'input-required'` | `node test/e2e.mjs` | PASS — `bridge_task_status still reports input-required after a process restart`、`bridge_task_input still answers the task after a process restart`、`the answered task is working again after a process restart` |
| 10 (W11) | `priority` 落盘 | priority 2 与 0 各一条 → 重启 → `poll` | 顺序仍为 2 在前 | `node test/e2e.mjs` | PASS — `priority 2 is still delivered before priority 0 after a process restart`、`a restored message keeps its priority field` |
| 11 (W13) | 终态过滤与 chat 回传 | `bridge_wait{ref,terminalOnly:true}` 期间 assignee 先 ack `working` 再 `chat` 回传再 ack `done` | 前两个都不 resolve；`done` 才 resolve | `node test/smoke.mjs` | PASS — `terminalOnly skips the working beat and returns the terminal ack`、`the intermediate ack a terminalOnly wait skipped is still in the mailbox`、`statuses waits only for the listed ack status`、`a ref wait resolves on the chat reply the skill teaches (not only on acks)` |
| 12 (W14) | `task_changed` 推送 | SSE 订阅者收到 ack 引起的跃迁 | 收到 `task_changed` 且 `status`/`a2aState` 正确；未知事件不影响旧消费者 | `node test/smoke.mjs` | PASS — `SSE pushes task_changed to the sender with status + a2aState`、`SSE pushes task_changed to the assignee too`、`task_changed is not pushed to a peer that is neither sender nor assignee` |
| 13 (W15) | 漏 ack 提醒 | task 投递后 assignee 不 ack，等待阈值 | `from:"hub"` 的 notice 到达 assignee；账本状态未变 | `node test/smoke.mjs` | N/A — W15 未实现，没有对应代码也没有断言（见 Deferred） |
| 14 (W9,W10) | 死信可见且不会被当普通邮件 | 超过 `maxAttempts` 后 | `bridge_dead_letters` 列出它；`poll` 取不到；`bridge_nack` 可复活且计数归 1 | `node test/smoke.mjs` | pending — 「`poll` 取不到 + `bridge_nack` 可复活」已 PASS（`(setup) the un-committed task dead-letters instead of coming back`、`bridge_nack revives the dead letter`、`a nack keeps the attempt count, so the next take is attempt 2`）；**`bridge_dead_letters` 不存在**（W10 转 Deferred），所以整条不算通过 |
| 15 (W12) | 非成员不能向群发消息 | 非成员调 `bridge_chat{to:<groupId>}` | 报错；群成员仍正常 | `node test/smoke.mjs` | PASS — `non-member cannot send to the group`、`non-member cannot chat into a group`、`non-member cannot notify a group`、`non-member cannot delegate a task to a group` |
| 16 (W18) | 文档一致性 | — | 工具数、测试计数、SKILL 流程与实测一致 | 手工 + `grep` | PASS — `grep -c "^      name: 'bridge_"` = 39；四处计数已改为 259+46+11+35+33+35=419；`agents/SKILL.md` 的签名/状态枚举/回传方式与实现对齐 |
| 17 | 全量回归 | — | 全绿 | `pnpm typecheck && pnpm test` | PASS — 发布前实测 419/419（259+46+11+35+33+35）；本轮文档同步只复跑 `pnpm typecheck`（0 错），未重跑 `pnpm test` |

## Verification commands

- `pnpm typecheck`
- `pnpm build:test && node test/smoke.mjs`
- `pnpm test`
- `node test/e2e.mjs`
- `grep -c "^      name: 'bridge_" src/hub-tools.ts`（工具数，文档同步用）
- `git status --short`（确认无 `.tmp/`、`test/*-entry.mjs` 产物入库）

## Deferred

| 项 | 为什么本轮不做 | 何时该回来 |
|---|---|---|
| 服务端默认 SLA（`--task-sla-ms`）自动判 timeout | 无 heartbeat 会误判，先看 W15 提醒是否够用 | 提醒上线后仍有人漏 ack 时 |
| N:1 同名会话按 session 隔离租约 | 与「同名共享一个 peer」的既有语义冲突，需产品裁决 | 有真实多会话共用同名 peer 的场景时 |
| `bridge_events` / `bridge_metrics` 无作用域 | W1/W6 修好后危害大幅下降；加作用域要动事件模型 | 远程多租户实际启用时 |
| `clientIps` 对所有 peer 广播、XFF 未校验 | 需产品决定谁能看 | 远程部署启用 `--allow-join` 时 |
| `herdrControlPeers: 'all'` 在非 loopback 的告警 | 与 W1–W8 无关的独立加固项 | 有人把 hub 暴露到非 loopback 时 |
| `persist.flush` 仍非事务（审查遗留） | 既有缺陷：一次 flush 中途失败时，历史 / `mailboxes` / 账本可能只写了一半。本轮所有新写路径（租约导出、`priority`、账本跃迁）都能被**一次** flush 完整覆盖，所以没有放大它；改成事务要动 `persist.ts` 的全部写入点 | 出现「重启后历史与邮箱对不上」或下一次 schema 迁移时。修法是 flush 包一层 `BEGIN IMMEDIATE`，并补一条中途失败的断言 |
| `deliverToWaiter` 对 batch waiter 返回单条形状 | 触发需要「满箱 + batch waiter + 到达即过期」三重时序 | 出现 batch waiter 生产用例时 |
| `bridge_dead_letters` 只读工具 + 死信独立 SQLite 表（W10） | 本轮只做到「每 peer 上限 200 + 淘汰计数 + 淘汰时对账任务」，**没有**列出死信内容的入口：想知道「哪条消息进了死信」只能靠 `bridge_status` 的 `deadLettered` 计数和 `mailbox_dropped` 事件。独立表还要新增 schema 与迁移面，而它换来的「回滚后旧版本不把死信当普通邮件」只在上限被触及时才体现 | 有人需要排查「这条消息是进了死信还是被丢弃」时；或部署里 `deadLettered > 0` 变成常态时 |
| 漏 ack 提醒 nudge（W15） | 未做。先要定两件事：阈值多少（`leaseTtlMs` 量级只是估算），以及「该 assignee 有什么动静才算数」（任何 ack？任何消息？）——判错就是给正常的长任务刷噪音，而噪音会让真的丢弃提醒一起被忽略 | 与「服务端默认 SLA」一起裁决：两者依赖同一套「多久没动静算异常」的阈值，先做提醒再做 SLA |
| `readState` / `rosterFor` 补 `waiting`/`inFlight`/`deadLettered`，`receipt()` 加 `recipients`（W17） | 未做。纯可见性，不影响投递与账本；`bridge_metrics` / `bridge_status` 已能间接读出这些数，`bridge_peers` 的描述也还没改成真实字段 | 有人反馈「广播到 0 人却显示发送成功」或「看不清消息是排在队列里还是被租约拿走了」时 |
| `requeue` 与 `deliver` 的淘汰方向不一致（审查遗留） | `deliver` 满箱时淘汰**最低优先级里最旧**的一条（`lowestPriorityIndex`），`requeue` 用 `queue.pop()` 淘汰**最低优先级里最新**的一条。两条路径对「满箱该牺牲谁」给出不同答案；统一要动租约回队这条已经稳定的路径，本轮不值得冒险 | 下次碰 `requeue` / 死信回队时一并统一（以 `lowestPriorityIndex` 为准，`deliver` 是默认路径且行为已被既有断言固定），并为 `requeue` 超出 `maxQueue` 补一条断言 |

## Rollback

- 按阶段 revert：阶段 1/2 只改 `hub.ts` / `hub-tools.ts` / `auth.ts`，单提交可回滚；阶段 3 涉及 schema。
- Schema 迁移全是 `ALTER TABLE ... ADD COLUMN`（沿用 `persist.ts:98-106` 的 catch 写法），回滚后旧版本读到多出的 `priority` 列会忽略。
- 死信目前**只在内存里**（`deadLetters` 是进程内 Map，不落盘），所以回滚不涉及它的 schema；代价是重启会连同 `attempts` 一起清空，`bridge_nack` 的复活窗口只在同一进程内有效 —— 这一点已写进 `AGENTS.md`。W10 的独立表若将来落地，旧版本会忽略未知表。
- 租约并入 `mailboxes` 的队列数组、不新增顶层键：旧版本回滚后会把这些消息当普通排队邮件投递一次，属可接受的重复投递。
- 行为变更点记在 CHANGELOG：非 assignee ack 被拒、token 会话自改 id 被拒、保留 id 被拒。
- 已知坑：`test/entry.mjs` 是 gitignore 产物，不 `pnpm build:test` 就信绿灯会得到假绿；Windows 上 `pnpm test` 串行跑 6 个套件，约 60–90s。

## Phase log

| 阶段 | 日期 | 证据 | 结论 |
|------|------|------|------|
| — | 2026-10-29 | 审查：4 个 subagent 分范围 + `.tmp/probe-{ack,f,g}.mjs` | 6 条 P1 均有可执行复现，构成阶段 0–5 的输入 |
| 0 | 2026-10-29 | smoke 174/186（12 红 = 待修的 P1）；e2e 25/29（4 红）；`.tmp/probe-ack.mjs` 等三份探针 | 先红后绿的基线建立；红项与计划条目一一对应 |
| 1 | 2026-10-29 | `pnpm typecheck` 0 错；smoke 183→193；e2e 30/31；审查记录见下两行 | 四问：①主张复核 = 12 条红全部转绿，`a revived dead-lettered task can still be completed` 先红后绿；②最小性 = 每处改动可指回 W1–W5（`renamePeer` 的账本改写是 W1 的必要连带）；③新风险 = 非 assignee ack 报错、`applied` 收窄、`updatedAt` 只在真跃迁时推进，均已记入 Affected behaviors；④反例 = 非 assignee ack 负例、限流丢弃、死信复活三条负向用例 PASS |
| 2 | 2026-10-29 | smoke 200/200；e2e 30/31；`guard` 复审确认「上一轮 P1 的 8 种参数组合全部有闸门」 | 四问：①主张复核 = `bridge_rename` 自改 id 的 8 组合逐条验证 + 保留名 5 处入口；②最小性 = token 门落在 `tokenPeer !== undefined && hasPeerId` 一处；③新风险 = `register` 拒停泊 id 加了 `reclaim` 开关（否则重启后 agent 拿不回自己的邮件）；④反例 = 群命名空间劫持（见下一条）先被 guard 造出可利用链，修后加断言 |
| 1+2 复审 | 2026-10-29 | `.devflow/ack-integrity-plan/review-phase1-r1.md`、`review-phase1-r2.md`、`review-phase2-guard.md`、`review-namespace-guard.md`（4 份，逐条含 `path:line`）——**注意：这 4 份文件在当前工作树里已不存在**（`.devflow/` 只剩两份计划摘要），结论保留在本行，文件路径不能再当成可复核证据 | 阻塞项 3 条全部修完：W3 语义（丢弃不写终态）、群命名空间互斥、`renamePeer` 漏检查。变异验证：逐条停用守卫确认对应断言变红（`bridge_register {peerId:"eng"}` 成功复现 P1） |
| 3 | 2026-10-29 | smoke 215/215；e2e 30/31（唯一红 = 租约跨重启，本阶段关闭） | 四问：①主张复核 = T5/T8 转绿（e2e 租约跨重启、`priority` 落盘），最终 smoke 259/259、e2e 35/35；②最小性 = 改动集中在 `exportMailboxes`/`importMailboxes`、`requeue`/`deadLetter`、`persist` 的列与恢复白名单；③新风险 = 导出租约**不过滤** `expiresAt`（有意为之，见 W8：过期判定属消费方，导出时过滤会造出「两边都没有」的窗口）；④反例 = 死信淘汰对账、租约回填竞争 `maxQueue`、重启后死信不复活为普通邮件三条 PASS。W10 的只读工具未做，转 Deferred |
| 4 | 2026-10-29 | `pnpm build:test && node test/smoke.mjs` → smoke 259/259；新增两段：`== ref waits: terminal / status filters, chat replies, timeout snapshot (W13/W16) ==`、`== SSE task_changed event (W14) ==` | 四问：①主张复核 = T9/T10 有断言并通过（`terminalOnly skips the working beat…`、`a ref wait resolves on the chat reply the skill teaches`、`SSE pushes task_changed to the sender/assignee`）；T11（W15 提醒）**没有实现**，记 N/A，不冒充 PASS；②最小性 = 三份等待谓词抽成一个 `matchesWaiter`、一个 `onTaskChanged` 钩子、一个可选 `WaitTimeout.ref`，默认行为未变；③新风险 = `ref` 现在也能被 chat 匹配，老的 `bridge_wait { ref }` 调用可能提前返回 —— 已写进工具描述与 `agents/SKILL.md`（`terminalOnly: true`）；`task_changed` 只按真实状态变化推送，旧消费者按未知事件忽略；④反例 = 未知 `statuses` 值报错而非静默、`terminalOnly` 跳过的中间态仍在邮箱、非当事 peer 收不到 `task_changed`。W15/W17 未做，转 Deferred。审查由 subagent 在会话内完成，结论已并入本表 |
| 5 | 2026-10-29 | `pnpm typecheck`（0 错）；`grep -c "^      name: 'bridge_" src/hub-tools.ts` = 39；`grep -rInE "[0-9]+ ?(checks|项)"` 扫 `AGENTS.md` / `README.md` / `README.zh.md` / `ARCHITECTURE.md` 命中 7 处（4 份文档）全部改为实测值；版本三处（`package.json` / `SERVER_VERSION` / `CHANGELOG.md`）= `0.11.0` | 四问：①主张复核 = 文档里每条行为描述对着代码/断言逐条核对（`exportMailboxes` 不过滤过期租约、SSE `task_changed` 只到发送方与 assignee 且不进 manager relay、`ref` 也匹配 chat、群/peer 命名空间双向互斥、丢弃不写终态）；②最小性 = 只改 10 个文档/版本文件，未碰 `src/`（`SERVER_VERSION` 除外）与 `test/`；③新风险 = 无代码改动，风险面是文档与实现再次漂移，已把「数一遍」的命令留在 Verification commands；④反例 = SKILL 里「用 `bridge_chat` 回传」与「sender 循环等终态」的自相矛盾已消解（回传推荐 `artifacts`，等待用 `terminalOnly: true`）。W19 只升版本未发布，等用户授权 |
