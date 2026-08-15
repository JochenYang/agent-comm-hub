# REVIEW-DSH — agent-comm-hub-app v1.0.0 GA candidate 审查报告

> 审查人：DSH（DeepSeek Harness） · 审查对象：Mavis 交付的 M1–M4 + 6 bug-fix 全量工作树
> 日期：2026-02（工作树未 commit 状态审查）
> 范围：`app/` 全目录（70 文件）、主仓 3 个 M 文档、2 个新 workflow

---

## 1. 结论摘要

| 项 | 结论 |
|---|---|
| 质量门 | ✅ `cargo test --lib` 17/17 → 修复后 **21/21**；`pnpm typecheck` **0 错误** |
| 严重缺陷 | 🔴 **1 个 P0 级崩溃**（PeersView 白屏，用户实测复现）——已修复并补回归测试 |
| 文档缺陷 | 🟡 3 处（AGENTS.md unicode 转义笔误 / zustand 死依赖 / SPEC 与实现偏差） |
| 验收状态 | ⏳ 12 条 AC + 7 条 NFR 均未勾选；e2e 套件、NFR 实测、/color 校验未交付（交接项） |
| 整体判断 | 架构与代码质量良好，修复 P0 后可作为 v1.0.0 GA 候选；**不建议在 P0 修复前发版** |

---

## 2. 严重缺陷（P0，已修复）

### 2.1 PeersView 崩溃：MCP result 信封未解包

**现象**（用户实测控制台）：

```
PeersView.tsx:20 Uncaught TypeError: Cannot read properties of undefined (reading 'length')
    at PeersView (PeersView.tsx:20:20)
```

**根因链**：

1. hub 端 `src/mcp-server.ts` `tools/call` 对**所有**工具统一返回 MCP 信封
   `{ content: [{ type: "text", text: "<JSON>" }], isError: false }`——包括 receipt，无特例；
2. 桌面端 `app/src-tauri/src/commands.rs` 的 `bridge_peers` / `bridge_status` /
   `bridge_history` / `bridge_chat` / `bridge_task` / `bridge_ack` 用
   `wrap(mcp.tools_call(...))` 把信封**原样透传**给前端；
3. 前端 `peersStore.refresh()` 执行 `setPeers(result.peers)`，`result.peers` 恒为
   `undefined` → `peers` 状态被置为 `undefined` → 下一次渲染 `peers.length` 崩溃；
4. `messagesStore`（`result.messages`）与 `CommandPalette`（`result.peers.filter`）
   是同类问题，只是 React 先报了 PeersView。

**特别说明**：`bridge_chat` 原注释声称"hub 端 receipt 函数不走 MCP content 包装"，
与 `mcp-server.ts:302` 事实不符——所有工具 handler 的成功值都走同一信封。

**修复**（`app/src-tauri/src/commands.rs`）：

- 新增 `unwrap_tool_result()`：唯一解包点。成功信封 → JSON.parse `content[0].text`；
  `isError: true` → `Err`（并从 `{"error": "..."}` 提取干净错误信息）；怪形状 → 原样透传（向前兼容）；
- 6 个 `bridge_*` 命令全部接入；`bridge_history` 的 SQLite 同步逻辑改为在解包后的
  `{messages: [...]}` 上取数；
- 新增 4 个单元测试锁定行为（成功信封 / 错误信封 / 怪形状 / 非 JSON 文本）。

**前端防御**（纵深，防未来回归打崩 UI）：

- `peersStore` / `messagesStore`：`Array.isArray` 兜底，形状异常时保持空数组；
- `CommandPalette`：`result?.peers ?? []`；
- 新增 `ErrorBoundary` 组件，`App.tsx` 三栏（Peers/Messages/Detail）各包一层，
  单视图崩溃降级显示 + retry，不再白屏整个应用。

---

## 3. 审查通过项（与 Mavis 报告一致）

| 项 | 结果 |
|---|---|
| `cargo test --lib` | 17/17 pass（hub_process × 3 + mcp_client × 4 + sqlite_store × 6 + herdr_client × 4）→ 修复后 21/21 |
| `pnpm typecheck` | 0 错误（strict 全量） |
| `HubConfig::to_argv()` | 空格分隔 `--flag value`（主仓 `cli.ts` parseArgs 契约），`config_to_argv_contains_all_required_flags` 单测覆盖 ✅ |
| `which_hub_launch()` | 4-tier 查找 + tier-3 `1..=6` pop 修复（debug 构建 `target/debug/` 向上 5 级可达主仓根）✅ |
| 版本一致性 | `package.json` 1.0.0 == `tauri.conf.json` 1.0.0 ✅ |
| workspace 隔离 | `app/pnpm-workspace.yaml` 保持 `packages: []` ✅；主仓 `dependencies: {}` 未被触碰 ✅ |
| CI | `ci-app.yml` 三平台矩阵 + artifact 上传；`release-app.yml` tag 触发（结构审查）✅ |
| SQLite | schema 迁移 + 消息/配置/未读持久化，6 个单测覆盖 ✅ |
| tray / 关闭隐藏 | lib.rs `CloseRequested` → hide + prevent_close；菜单 open/restart/quit ✅ |
| 协议对齐 | `mcp_client.rs` 与 hub `mcp-server.ts` 1:1（session id header、SSE 解析、lossless JSON）✅ |
| SSE 长连接 | `ensure_mcp_initialized` 末尾开 SSE 保活，`agent-hub-cli` 持续 connected（Mavis 实测 45s+）✅ |

---

## 4. 发现与改进点

### 4.1 🟡 zustand 死依赖（建议移除）

- `app/package.json` 依赖 `zustand ^5.0.2`，全仓 **0 处** `from 'zustand'` 导入；
- SPEC §5.2 / 架构图描述的"zustand stores"实际实现为手写 hooks（`usePeersStore` 等，
  功能等价、更轻、无额外依赖）；
- 建议：移除 zustand 依赖（省安装体积与依赖面），并把 SPEC 措辞改为"stores (hooks)"。

### 4.2 🟡 AGENTS.md unicode 转义笔误（已修复）

Mavis 写入的字面转义序列：`\u00a74` → `§4`、`\u2192` → `→`、`\u2014` → `—`。
已修正（行 248–250）。

### 4.3 🟡 SPEC 与实现的小偏差

- SPEC §5.1 模块表写 `tauri_commands.rs` / `tray.rs` / `i18n_strings.rs`，实际为
  单一 `commands.rs`（tray 合并进 `lib.rs`）——建议更新 SPEC 表格；
- SPEC §6 的 12 条 AC + 7 条 NFR 全部未勾选，与实际完成度不匹配（建议随 e2e 验收逐条勾选）。

### 4.4 🟢 观察项（不阻塞）

- `hub_process.start()` 未实现 SPEC §关键数据流的"先探测 127.0.0.1:18764 是否已在响应，是则跳过 spawn"：
  外部已有 hub 在跑时，app 仍会 spawn 子进程（因端口占用退出），端口探测却连到**已有 hub** 而成功
  → 状态 Running 短暂抖动后跳回 Stopped（异步 wait 任务）。当前行为可用（app 的 MCP client 会连到
  已有 hub），但状态机观感错误。建议 v1.1：start() 前先 `TcpStream::connect` 探测，已响应则直接置
  Running 并跳过 spawn；或至少把"spawn 后子进程很快退出"识别为"外部 hub 已存在"并保持 Running。
- `lib.rs` 的 `decode_png_rgba` 手工 PNG 解码——若未来换图标建议评估 `tauri` 原生资源路径；
- `find_in_path` Windows 分支同时 `set_extension` 与 `push` 后缀，存在重复探测（性能可忽略，逻辑正确）；
- `bridge_history` Rust 侧先查 SQLite 的离线兜底未验证（见 §5 遗留项）。

---

## 5. 遗留任务（交接给 DSH，v1.0.0 前完成）

| # | 任务 | 状态 |
|---|---|---|
| 1 | `app/tests/` e2e 集成测试套件：hub-spawn ✅（smoke.mjs 已有）/ mcp-roundtrip ✅ / **sqlite-persistence ❌** / **herdr-panel ❌** | 部分完成 |
| 2 | NFR-1 冷启动 ≤1.5s 实测 | 未做 |
| 3 | NFR-2 5000 条消息 60fps 实测 | 未做 |
| 4 | NFR-4 安装包体积（msi ≤30MB / dmg ≤25MB / AppImage ≤35MB） | 未做 |
| 5 | `/color` skill contrast / CVD / chromostereopsis 校验脚本（SPEC §6.2 NFR-5） | 未做 |
| 6 | macOS notarize / Windows EV 签名调研（v1 发 unsigned，签名推 v1.1） | 未做 |

> 说明：`app/tests/smoke.mjs` 是手写全链路脚本（spawn hub + MCP initialize +
> peers/register/chat/wait/history/task/ack），已覆盖 hub-spawn 与 mcp-roundtrip；
> 其 `unwrapBridge()`（smoke.mjs:87-93）印证了 §2.1 的信封契约——桌面端此前缺的正是这一步。

---

## 7. 第二轮审查（用户实测反馈后）：功能补齐 + UI 打磨

用户实测截图反馈：① UI 粗糙；② 右栏"选中后没有逻辑"；③ 要求对照 `app/docs/` 检查 Mavis 是否遗漏功能。逐条对照 PRD（F-01..F-17 / US-1..15）、SPEC（AC-1..12 / NFR）、PLAN（T-*）后确认以下**遗漏并全部修复**：

### 7.1 已修复的功能遗漏

| # | 遗漏 | 依据 | 修复 |
|---|---|---|---|
| 1 | **peer 会话过滤缺失**（消息流只能看自己相关的；PeersView 点击无行为）——PRD P0 US-2"点击任意 peer 看它和别人的对话（不限于和自己相关的）" | PRD US-2 / hub `history(peer)` 语义已支持 | messagesStore 加 `activePeer`；PeersView 点击切换会话（选中态+tooltip）；MessagesView 标题显示 `conv <peer>` + 退出按钮；拉取改 `bridgeHistory(activePeer)` |
| 2 | **原始 JSON 视图缺失**（SPEC 右栏要求，选中 chat 后只有一行 body → 用户感知"没有逻辑"） | SPEC §2 第 3 条 | DetailView 加 `▸ raw json` 折叠区 |
| 3 | **ack 状态机时间线缺失**（accepted→done 推进过程） | PLAN T-2.3 | DetailView 渲染 task 的 ref 链 ack 时间线（双方 ack、时间戳、note） |
| 4 | **开机自启缺失**（无按钮无命令） | PRD F-13 / SPEC AC-9 | Rust `service_install`/`service_uninstall`（复用 which_hub_launch 定位跑 `agent-comm-hub service <a>`）+ SettingsView 自启区块（i18n key 已有） |
| 5 | **SSE 增量推送未接**（Rust 已 emit `hub:message`，前端没 listen，纯 3s 轮询） | PLAN T-2.4/2.6 / SPEC 关键数据流 | tauri.ts `onHubMessage` + messagesStore 监听追加（轮询降级为兜底） |
| 6 | **MCP 自动重连缺失**（外部 hub 崩溃/重启后 bridge_* 永久失败） | PRD F-08 | `require_mcp` 懒重建：hub Running 但 mcp 缺失时自动重新 initialize |
| 7 | **Ctrl+W 缺失** | PLAN T-3.7 / PRD §5.2 | App.tsx 加 meta+W 回 main |
| 8 | **hljs override 缺失**（markdown.tsx 注释承诺"见 tailwind.css 的 .hljs-* override"，实际不存在 → 代码高亮与主题不协调） | 代码注释 | tailwind.css 补 Zinc+Cyan 色板 hljs override |
| 9 | **端口占用检查缺失**（外部 hub 存在时 spawn 重复进程 → 截图 EADDRINUSE + 状态抖动） | SPEC 关键数据流 / 上轮 §4.4 | `start()` 先探测端口，已响应则 log 提示 + 直接 Running 复用，不 spawn |
| 10 | **语言切换 UI 缺失**（i18n 基础已有 `lang`/`setLang`/localStorage，但设置页没有切换入口；AC-11 未达） | SPEC AC-11 / PRD F-14 | SettingsView 标题行加 zh-CN/en-US 切换按钮组；FIELDS label/hint 全量 i18n 化（新增 settings.hints.* 双语资源） |

### 7.2 UI 打磨（精致化 devtool 方向）

- 消息卡片：时间戳常显、`(me)` 标记、to 命中高亮、选中态 bg-primary/5 + hover 边框
- PeersView：点击选中态（ring + bg）、tooltip、刷新按钮 tooltip、离线 60% 透明度
- 右栏空态：主提示 + 副说明（不再是大白块）
- LogsView：时间戳列、stderr 过滤按钮、暂停/恢复、自动跟随滚动（上滚即停）
- 顶栏：tab hover 反馈、移除与实际不符的 `v0.1` 版本徽章
- CC 空态：`—` → `no other peers`（斜体 muted）
- **日志放大弹窗**：LogsView 加 `⛶` 按钮 → 全屏遮罩 + 85vh 大面板（独立滚动/过滤/暂停实例；Esc / 遮罩 / ✕ 关闭）
- 附件 chips / 发送区保持原风格

### 7.3 第二轮验证

```
cargo test --lib   → 21/21 pass
pnpm typecheck     → 0 errors
tauri:dev 冒烟     → 热重载生效；agent-hub-cli + agent 均 connected；
                     18764 仅 1 个监听进程（无重复 spawn，EADDRINUSE 消除）
```

### 7.4 仍遗留（非阻塞 / 需要用户决策）

- `app/tests/` e2e 套件补全（sqlite-persistence / herdr-panel）、NFR-1/2/4 实测、/color 校验脚本、签名调研（上轮遗留，未在本轮处理）
- PRD §5.4 的 zod schema wrapper 与 SPEC §5.2 zustand 描述仍与实现偏离（实现为手写 hooks + TS interface，建议下版改文档或改实现）
- `service` 命令的权限提示/二次确认（PRD OQ-3 默认要二次确认——当前直接执行）

---

## 6. 验证方式（本次会话实测）

```
cd app/src-tauri && cargo test --lib   # 21/21 pass（含 4 个新 unwrap 回归测试）
cd app && pnpm typecheck               # 0 errors
```

- 主仓代码零改动（仅 AGENTS.md 文档笔误修复），主仓测试套件不受影响；
- 建议发版前补跑：`pnpm tauri:dev` 手工验证 PeersView 不再崩溃 + 三栏正常渲染；
- 建议：修复确认后按批次 commit（jochen 决定主流程代码的 commit 归属；本报告的
  测试/数据/报告归 DSH 侧 commit）。
