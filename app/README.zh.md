# agent-comm-hub-app (桌面端)

[agent-comm-hub](https://github.com/JochenWork/agent-comm-hub) 的桌面管理 GUI。Tauri 2 + React + TypeScript + Rust,主仓 `agent-comm-hub` 仍是 zero-dep CLI / MCP server,本项目是平行独立的桌面端。

## 能力

- **自动拉起 hub**:双击应用 = 启动(若 127.0.0.1:18764 没有 hub 则 4-tier fallback 启动一个)。
- **peer 列表 + 在线指示**:左栏所有已注册 peer,红/绿圆点 + 未读 badge。
- **三栏主界面**:peers(左) / messages(中) / detail(右)。顶部 hub 状态 pill。
- **以 `agent-hub-cli` 身份发 chat / task / ack**:
  - Markdown 渲染(rehype-highlight,GFM 表格,代码高亮,XSS 安全)
  - 直选 + cc 多会话方
  - 拖 `.txt`(≤5MB)当附件
- **斜杠命令面板**:`/peers /broadcast /history /help /clear`,`Ctrl/Cmd+K` 全局唤起
- **虚拟滚动**:`@tanstack/react-virtual`,5,000 条消息 60fps
- **设置面板**:12 项 hub 配置,SQLite 持久化,"应用并重启" 一键生效
- **终端 tab**:11 个 herdr 控制工具(`bridge_agent_*` / `bridge_pane_*`)
- **系统托盘**:关窗口 = 缩到托盘,绿/灰/红 icon 跟 hub 状态实时同步
- **i18n**:简体中文(默认)/ English,设置里切换,localStorage 持久化
- **键盘**:`Ctrl+K` 命令面板、`Ctrl+,` 设置、`Ctrl+Enter` 发送、`/` 唤起面板、`Esc` 回主页

## 安装与运行

```bash
pnpm install
pnpm tauri:dev      # 开发模式 (HMR)
pnpm tauri:build    # 三平台安装包 (NSIS / dmg / AppImage+deb)
```

需要 Rust ≥ 1.97、Node ≥ 22。Windows 上 Win10+ 自带 WebView2,无需额外安装。

## 自动拉起 hub 的链路

1. 前端 `useEffect` 调 `invoke('app_ready')`
2. `commands::app_ready` → `state.hub.start()` → 4-tier 兜底:
   - 同目录 `agent-comm-hub(.exe)`
   - PATH 上的 `agent-comm-hub` (Windows 上的 npm 全局 `.cmd` shim)
   - `node <主仓根>/lib/cli.js` (dev 场景 `current_exe()` 向上找主仓)
   - `npx agent-comm-hub` (兜底;首次启动会下载)
3. 端口就绪探测(10s 预算,100ms 一次)
4. `McpClient::initialize` → 自动注册 `agent-hub-cli` peer
5. `McpClient::subscribe_notifications` 开 SSE 长连接 — 这就是 hub 把 session 视为 "live" 的信号,跟 `bridge_wait` long-poll 同等地位

## 配置

12 项,持久化在 `%APPDATA%/agent-comm-hub-app/store.sqlite` 的 `config` 表:`host` / `port` / `path` / `max_queue` / `history_limit` / `wait_timeout_ms` / `default_wait_ms` / `connected_window_ms` / `peer_idle_timeout_ms` / `herdr_bin` / `herdr_timeout_ms`。

> 重要:hub CLI parser 强制空格分隔 `--flag value`,**不能用** `--flag=value` —— 后者会被 `unknown flag` 拒掉(实测踩坑)。

## 架构

```
Tauri main (Rust)
  hub_process.rs        spawn / stop / restart + 端口探测 + 500 行日志环
  mcp_client.rs         自实现 zero-dep streamable-http + SSE
  herdr_client.rs       herdr CLI + socket (11 工具)
  sqlite_store.rs       WAL / peer / message / config / unread
  commands.rs           tauri invoke_handler,22+ 个 handler
  lib.rs                托盘 + setup

Vite (React 18 + TS)
  views/PeersView       peer 列表 + 未读
  views/MessagesView    虚拟滚动 + cc + 拖拽 + 命令面板触发
  views/DetailView      task / ack / chat 分支
  views/SettingsView    12 项配置 + 重启 + 语言切换
  views/TerminalView    agent/pane tabs,200ms 节流
  views/LogsView        stdout/stderr,500ms 刷新
  components/CommandPalette   / 前缀 + Ctrl+K
  lib/markdown.tsx      GFM + hljs + sanitize
  i18n/                 zh-CN.json + en-US.json
```

## 工作区隔离

`app/` 是独立 pnpm + Cargo workspace:

- `app/pnpm-workspace.yaml` 声明 `packages: []`,pnpm 不会 hoist 到主仓
- `app/src-tauri/Cargo.toml` 4 个运行时 crate(`tauri` / `tokio` / `reqwest` / `rusqlite`)
- 所有 MCP / hub I/O 走 hub 的 CLI / HTTP API,不直接引用主仓源码

## 测试

```bash
cd src-tauri && cargo test --lib    # 17 个单元测试
cd app && pnpm typecheck            # 0 错误
cd app && pnpm tauri:build          # 三平台安装包
```

## 协议

MIT
