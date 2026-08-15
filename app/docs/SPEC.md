# agent-comm-hub 桌面端 — SPEC

> Multi-peer MCP hub 的桌面端管理 GUI。基于 Tauri 2 + shadcn/ui + Vite + React + Rust。
> 项目位置：`app/`（独立工作区，不混进主仓 zero-dep）。

## 1. Problem

`agent-comm-hub` 现在的所有能力都暴露在 `npx agent-comm-hub <cmd>` CLI 与 21 个 MCP `bridge_*` 工具里。Agent 用户必须在终端或自己的 agent TUI 里操作 hub 状态，无法在桌面侧：
- 一眼看到所有已注册 peer 与在线状态
- 阅读 / 回复任意两个 agent 之间的消息（不参与它们的会话也能看）
- 直接以管理员身份发消息（不打开任何 agent TUI）
- 修改 hub 配置（max-queue、history-limit、wait-timeout 等 11 项）
- 调用 11 个 herdr 控制类工具（agent list、prompt、pane send、keys 等）
- 在不开终端的情况下启动 / 停止 / 重启 hub 进程

需要把这些全部装进一个 Tauri 桌面端 GUI。

## 2. Scope

### v1 必须包含
1. **Hub 进程内嵌管理**：Tauri Rust 后端 spawn `agent-comm-hub` 子进程，UI 提供 启动 / 停止 / 重启 按钮 + 实时 stdout/stderr 日志面板（最近 N 行环形缓冲）。
2. **配置面板**：完整暴露 CLI `--port --host --path --max-queue --history-limit --wait-timeout-ms --default-wait-ms --connected-window-ms --peer-idle-timeout-ms --herdr-bin --herdr-timeout-ms` 12 项；持久化到 SQLite；启动时作为参数喂给 spawn。
3. **三栏主窗口**（Slate + Teal 暗模式默认）：
   - 左：peer 列表（头像 / 在线指示 / 未读数 / 最后消息时间）
   - 中：选中 peer 的消息流（chat / task / ack / notice 四种 kind 视觉区分，支持 Markdown + 代码高亮）
   - 右：选中消息详情（原始 JSON + task prompt/deliverable + ack 状态机时间线）
4. **作为 MCP 客户端发消息**：UI 启动时 Rust 代理层以 `agent-hub-cli` peer id 注册 MCP session，输入框人类打字 → `bridge_chat` / `bridge_task`；支持 `/` 命令面板、`/help /peers /broadcast /history`、Markdown + 代码高亮、多 peer cc、拖拽文件附件。
5. **独立"终端"标签页**：完整映射 11 个 herdr 控制工具（`bridge_agent_list/status/prompt/wait/read/keys` + `bridge_pane_list/send/keys/read/wait`）。
6. **持久化**：SQLite 存 peer 列表快照、消息历史（增量同步自 hub）、配置项、未读计数；启动恢复上下文。
7. **自启动集成**：UI 设置面板提供"安装 / 卸载开机自启"按钮，内部调 `agent-comm-hub service install|uninstall --dry-run` 打印，再按需执行（Windows Run key / Linux systemd / macOS launchd）。
8. **系统托盘**：常驻图标，动态显示 hub 运行状态 + 未读消息数；右键菜单含"打开主窗口 / 重启 hub / 退出"；关闭主窗口 = 隐藏到托盘（不退出进程）。
9. **i18n**：中英双语可切换（设置面板切换；中文默认）。
10. **三平台打包**：Windows msi + NSIS、macOS dmg + app bundle、Linux AppImage + deb；CI 矩阵三平台。
11. **包名**：npm 名 `agent-comm-hub-app`；与主包 `agent-comm-hub` 平行（主包 zero-dep 不变）。

### v1 明确不包含（non-goals）
- 任何形式的内置 LLM 助理面板（v1.1 再做）
- 多账号 / 远程 hub 远程管理（v1 只连本地 127.0.0.1）
- 主题切换器 / 自定义主题（v1 锁死 Slate + Teal 暗模式）
- 移动端 / Web 版
- 插件系统 / 自定义 bridge 工具扩展
- 消息端到端加密（hub 当前不加密）
- 自动更新 v1 不做（v1.1 加 tauri-plugin-updater）

## 3. Constraints

| 约束 | 说明 |
|---|---|
| 主包 zero-dep | `agent-comm-hub` npm 包 `dependencies: {}` 不可变；桌面端是平行独立项目，依赖装在 `app/` |
| Rust ≥ 1.97 | 已有；`tauri-cli` 走 `cargo install tauri-cli@^2` 或 `pnpm dlx @tauri-apps/cli` |
| Node ≥ 22 | 已有 |
| 平台 | Windows 10+ / macOS 12+ / Linux (Ubuntu 22.04+ 主流发行版) |
| 协议兼容 | UI 的 MCP 客户端必须严格遵循 hub 的 streamable-http + SSE + `Mcp-Session-Id` 协议；不引入第三方 MCP SDK（保持可控 + 与 hub 零共享依赖风险） |
| shadcn token | 全部颜色用 Tailwind v3 shade 体系 + shadcn `tailwindcss-animate` + `class-variance-authority`；色板由 `/color` skill 生成的 CSS variables 驱动 |
| 性能 | 三栏 UI 启动到首屏 < 1.5s；消息流 1000 条虚拟滚动 60fps；herdr 终端输出读取节流 200ms |
| 体积 | 安装包 ≤ 30 MB（Windows msi 参考值）；不打包 Chromium（WebView2/WKWebView/WebKitGTK 走系统） |

## 4. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                  Tauri 主进程 (Rust)                          │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │ hub_process  │  │ mcp_client   │  │ herdr_client      │  │
│  │ (spawn +     │  │ (轻量自实现   │  │ (spawn herdr CLI  │  │
│  │  restart +   │  │  SSE 客户端) │  │  + socket 客户端) │  │
│  │  log ring)   │  │              │  │                   │  │
│  └──────┬───────┘  └──────┬───────┘  └─────────┬─────────┘  │
│         │                 │                    │             │
│         └─────────┬───────┴──────────┬─────────┘             │
│                   │                  │                       │
│         ┌─────────▼────────┐  ┌──────▼──────────┐            │
│         │ sqlite_store    │  │ tauri::command   │            │
│         │ (peer 快照 /   │  │ (暴露给前端的    │            │
│         │  消息历史 /    │  │  RPC + event)    │            │
│         │  配置 / 未读)  │  │                  │            │
│         └─────────────────┘  └──────────────────┘            │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ tray_icon (tauri-plugin-system-tray)                  │   │
│  └──────────────────────────────────────────────────────┘   │
└──────────────────────┬───────────────────────────────────────┘
                       │ tauri IPC (window.__TAURI__)
                       ▼
┌─────────────────────────────────────────────────────────────┐
│               前端 (Vite + React + TS)                       │
│                                                              │
│  ┌────────────┐  ┌──────────────┐  ┌────────────────────┐   │
│  │ views/     │  │ components/  │  │ stores/            │   │
│  │ Peers      │  │ shadcn/ui    │  │ zustand:           │   │
│  │ Messages   │  │ 自封装       │  │  peersStore        │   │
│  │ Detail     │  │              │  │  messagesStore     │   │
│  │ Terminal   │  │              │  │  configStore       │   │
│  │ Settings   │  │              │  │  trayBadgeStore    │   │
│  └────────────┘  └──────────────┘  └────────────────────┘   │
│                                                              │
│  i18n: react-i18next（zh-CN 兜底 / en-US 备选）              │
│  markdown: react-markdown + remark-gfm + rehype-highlight    │
└─────────────────────────────────────────────────────────────┘
```

### 关键数据流

**启动**：UI 启动 → Rust 端检查 127.0.0.1:18764 是否已在响应 → 否就 spawn hub 子进程 → 等端口就绪 → Rust mcp_client 建 MCP SSE 连接 + `initialize` 自动注册 `agent-hub-cli` peer → 前端订阅 store → 拉 peer 列表 + 最近 100 条消息 → UI 渲染。

**收消息**：hub SSE 推 `notifications/message` → Rust mcp_client 解析 → 写 SQLite → emit Tauri event `hub:message` → 前端 store 更新 → 消息流虚拟列表追加 → 托盘未读 +1。

**发消息**：用户在输入框打字 → 客户端校验（peer 存在 / 长度 / Markdown）→ invoke `bridge_chat` Rust command → Rust 调 mcp_client `tools/call` → hub 接收 → 同 session 间立即返回 receipt + 推 SSE 给目标 peer → 前端 store 收到 receipt 后把消息标记为 sent（optimistic）。

**herdr**：用户在终端标签页点 agent → invoke `bridge_agent_status` Rust command → Rust herdr_client execFile `herdr agent status w1:p1` → 返回 JSON → 前端渲染。`pane` 类工具走 socket（herdr-ctl.ts 已有逻辑，Rust 端 1:1 移植）。

## 5. Components

### 5.1 Rust 后端模块

| Crate | 职责 |
|---|---|
| `app/src-tauri/src/main.rs` | 入口；初始化 Tauri builder、tray、window |
| `app/src-tauri/src/hub_process.rs` | 子进程管理：spawn / stop / restart / log ring buffer / 端口就绪探测 |
| `app/src-tauri/src/mcp_client.rs` | 轻量 MCP streamable-http 客户端：`initialize` / `tools/call` / `notifications/*` SSE 解析；零依赖，参照 hub 的 mcp-server.ts 协议 |
| `app/src-tauri/src/herdr_client.rs` | herdr CLI execFile 包装 + 套接字客户端；端口从 `HerdrCtl` 移植 |
| `app/src-tauri/src/sqlite_store.rs` | rusqlite；schema 迁移；peer / message / config / unread 表 |
| `app/src-tauri/src/tauri_commands.rs` | 暴露给前端的 RPC：`start_hub` / `stop_hub` / `send_chat` / `list_peers` / `set_config` / ... |
| `app/src-tauri/src/tray.rs` | 系统托盘 + 动态图标（运行中 vs 停止 vs 未读 badge） |
| `app/src-tauri/src/i18n_strings.rs` | 错误信息 i18n 映射（前端 i18next 不覆盖的 Rust 端错误） |

依赖（Cargo.toml）：
```
tauri = { version = "2", features = ["tray-icon"] }
tauri-plugin-system-tray = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
rusqlite = { version = "0.31", features = ["bundled"] }   # bundled SQLite，零系统依赖
tokio = { version = "1", features = ["full"] }
reqwest = { version = "0.12", features = ["stream", "json"] }  # 仅用于 mcp_client 的 SSE 长连接
thiserror = "1"
log = "0.4"
```

### 5.2 前端模块

| 路径 | 职责 |
|---|---|
| `app/src/main.tsx` | React 入口 |
| `app/src/views/PeersView.tsx` | 左栏 peer 列表 |
| `app/src/views/MessagesView.tsx` | 中栏消息流（虚拟滚动） |
| `app/src/views/DetailView.tsx` | 右栏选中消息详情 |
| `app/src/views/TerminalView.tsx` | herdr 终端标签页 |
| `app/src/views/SettingsView.tsx` | 配置面板 |
| `app/src/stores/peersStore.ts` | zustand：peer 列表、在线、未读 |
| `app/src/stores/messagesStore.ts` | zustand：消息流、过滤、选中 |
| `app/src/stores/configStore.ts` | zustand：12 项 hub 配置 + 应用偏好（语言、托盘开关） |
| `app/src/lib/tauri.ts` | typed wrapper：invoke + listen |
| `app/src/lib/markdown.tsx` | react-markdown + rehype-highlight 包装 |
| `app/src/i18n/{zh-CN,en-US}.json` | 翻译资源 |

依赖（package.json）：
```
react react-dom
@tauri-apps/api @tauri-apps/cli
vite @vitejs/plugin-react
typescript @types/react @types/react-dom
tailwindcss tailwindcss-animate postcss autoprefixer
class-variance-authority clsx tailwind-merge lucide-react
shadcn/ui 组件（按需）
zustand
react-i18next i18next
react-markdown remark-gfm rehype-highlight highlight.js
@tanstack/react-virtual  # 消息流虚拟滚动
```

### 5.3 SQLite Schema

```sql
CREATE TABLE config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE peers (
  peer_id TEXT PRIMARY KEY,
  last_seen INTEGER NOT NULL,
  online INTEGER NOT NULL DEFAULT 0,
  client_name TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  from_peer TEXT NOT NULL,
  to_peer TEXT NOT NULL,
  kind TEXT NOT NULL,           -- chat / task / ack / notice
  content TEXT NOT NULL,        -- JSON 字符串
  ref TEXT,
  ts INTEGER NOT NULL,
  involved_me INTEGER NOT NULL DEFAULT 0  -- 1 表示 from/to 包含 agent-hub-cli
);
CREATE INDEX idx_messages_ts ON messages(ts DESC);
CREATE INDEX idx_messages_involved ON messages(involved_me, ts DESC);

CREATE TABLE unread (
  peer_id TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  last_read_ts INTEGER
);
```

### 5.4 主题色板（Slate + Teal）

```css
/* app/src/styles/theme.css — shadcn CSS variables */
:root {
  /* surface */
  --background: 222.2 84% 4.9%;        /* slate-950 */
  --foreground: 210 40% 98%;          /* slate-50 */
  --card: 217.2 32.6% 17.5%;          /* slate-900 */
  --card-foreground: 210 40% 98%;
  --popover: 215 27.9% 16.9%;         /* slate-850 */
  --popover-foreground: 210 40% 98%;
  --muted: 215 25% 27%;               /* slate-800 */
  --muted-foreground: 217.9 10.6% 64.9%; /* slate-400 */
  --border: 215 25% 27%;
  --input: 215 25% 27%;
  /* brand */
  --primary: 173 80% 40%;             /* teal-500 #14B8A6 */
  --primary-foreground: 222.2 47.4% 11.2%; /* slate-900 on teal */
  --ring: 173 80% 40%;
  /* semantic */
  --success: 160 84% 39%;             /* emerald-500 */
  --warning: 38 92% 50%;              /* amber-500 */
  --destructive: 351 89% 60%;         /* rose-500 */
  --destructive-foreground: 210 40% 98%;
  --info: 199 89% 48%;                /* sky-500 */
}
```

`/color` skill 验证：
- primary on background = teal-500 on slate-950 → 对比度 7.8:1（AAA）
- body text on card = slate-50 on slate-900 → 对比度 14.2:1（AAA）
- destructive on background = rose-500 on slate-950 → 对比度 5.1:1（AA）
- 红/绿语义不同时使用（CVD safe：success = emerald，error = rose，并伴随图标）
- 不存在 chromostereopsis 风险（红/蓝不放同一屏）

## 6. Acceptance Criteria

### 6.1 功能验收（每条对应可点击路径）

- [ ] **AC-1**：双击桌面图标 → 应用启动 → 主窗口显示 peer 列表（即便 hub 还没起）→ 自动 spawn hub → 端口就绪后 peer 列表开始填充。
- [ ] **AC-2**：设置面板修改 `port` → 应用 → "重启 hub" 按钮出现 → 点击 → 新端口生效 → `agent-comm-hub status --port <新>` 返回连接正常。
- [ ] **AC-3**：任意 agent 连接 hub（手工用 `bridge_register` 模拟）→ UI peer 列表 5s 内出现该 peer → 在线指示变绿。
- [ ] **AC-4**：从外部 agent 给 `agent-hub-cli` 发 chat → UI 消息流出现该消息 → 托盘图标未读 badge +1。
- [ ] **AC-5**：UI 输入框打 "你好" → 选中 peer → 发送 → 目标 agent 通过 `bridge_wait` 收到 `from: "agent-hub-cli"` 的 chat。
- [ ] **AC-6**：输入框打 `/` → 命令面板弹出 → 选 `/peers` → 列出所有在线 peer（带 id + online）。
- [ ] **AC-7**：选中一条 task 消息 → 右栏显示 prompt / context / deliverable → 可点击"发送 ack: accepted"按钮 → 状态机推进。
- [ ] **AC-8**：切换到"终端"标签页 → 点击 `bridge_agent_list` → 列出 herdr 识别的 agent；点击某 agent → `bridge_agent_prompt` 发送文本 → 等待 settle → 显示输出。
- [ ] **AC-9**：设置面板"安装开机自启"按钮 → 调 `agent-comm-hub service install` → Windows Run key / systemd / launchd 对应项出现 → 卸载按钮反之。
- [ ] **AC-10**：关闭主窗口 → 进程不退出 → 托盘仍可见 → 右键菜单"打开主窗口"恢复。
- [ ] **AC-11**：语言切换 zh ↔ en → 所有菜单 / 提示 / 错误信息切换 → 立即生效。
- [ ] **AC-12**：拖拽 .txt 文件到输入框 → 作为附件一起发 → SQLite messages.content 含附件 base64 → 目标 agent 收到。

### 6.2 非功能验收

- [ ] **NFR-1**：冷启动到首屏可交互 ≤ 1.5s（macOS M1 / Windows i5-8250U / Linux i5-8400）。
- [ ] **NFR-2**：消息流加载 5000 条 → 滚动 60fps（虚拟列表 + windowed render）。
- [ ] **NFR-3**：herdr 终端输出每 200ms 节流刷新，不卡主线程。
- [ ] **NFR-4**：安装包大小 Windows msi ≤ 30 MB / macOS dmg ≤ 25 MB / Linux AppImage ≤ 35 MB。
- [ ] **NFR-5**：所有颜色 token 通过 `/color` skill 的 contrast / CVD / chromostereopsis 校验。
- [ ] **NFR-6**：CI 在 ubuntu-latest / windows-latest / macos-latest 三平台跑通 build + lint + test。
- [ ] **NFR-7**：Rust 端代码 `cargo clippy --deny warnings` 0 警告；TS 端 `pnpm lint` 0 错误。

## 7. Open Questions

| # | 问题 | 决策时点 | 负责人 |
|---|---|---|---|
| OQ-1 | 输入增强（命令面板 / Markdown / cc / 拖拽）是否全做？ | 推荐范围默认全做；若 M3 进度紧张可推迟拖拽 | Jochen |
| OQ-2 | SQLite 是否要做端到端加密（保护消息历史）？ | v1 不做；v1.1 评估 | Jochen |
| OQ-3 | "安装开机自启"按钮是否要二次确认（避免误装服务）？ | 默认要；install 行为本身已 idempotent | 默认决策 |
| OQ-4 | v1.1 是否做 tauri-plugin-updater 自动更新？ | 推荐做；本期不实现 | Jochen |
| OQ-5 | 主题色锁死 vs 提供"切换深色 / 浅色"？ | v1 锁死暗模式；v1.1 加切换 | 默认决策 |

## 8. References

- 主仓架构：`../ARCHITECTURE.md`
- 21 个 bridge 工具签名：`../src/hub-tools.ts`
- Hub 配置默认值：`../src/index.ts` 的 `DEFAULT_CONFIG`
- Herdr 适配：`../src/herdr-ctl.ts`
- AGENTS.md 不可破约束：zero runtime deps / lossless JSON / peer id 校验 / UTF-8 no BOM / `~/.claude.json` 不动