# agent-comm-hub 桌面端 — PRD

> Product Requirements Document
> 对应 SPEC.md 的"做什么"。本文档回答"为什么做 / 给谁用 / 优先级 / 成功指标"。

## 1. 背景与机会

`agent-comm-hub` 当前 v0.4.0 已是成熟的"多 agent 通信邮递站"。它解决的是 **AI agent 之间的横向通信问题**：让 MiniMax Code、Claude Code、opencode、Codex、DSH 等通过同一协议互相对话、委派任务、回执。

但用户接触 hub 的入口仍然只有两条：
1. **CLI**（`agent-comm-hub start/status/setup/discover/service/update`）—— 终端用户友好，agent 用户无感
2. **agent 自己的 TUI** —— agent 能用 `bridge_chat` 等工具，但人类**看不见**自己的 agent 在和谁对话、说了什么

这意味着：
- **观察盲区**：用户跑 Claude Code 和 Codex 协作时，无法在 GUI 上看对话进度；只能在两个 TUI 间切来切去
- **配置门槛**：12 个 hub 启动参数全靠命令行记忆；改个 max-queue 得停 hub → 改 → 起 hub
- **管理动作缺失**：发条消息给某个 agent 得打开它的 TUI 自己打字；安装开机自启得记 service install 命令

桌面端补上这一层：把 hub 从"agent 内部协议"升级成"用户也能看、能管、能参与的协作平台"。

## 2. 目标用户

| 用户类型 | 当前痛点 | 桌面端带来 |
|---|---|---|
| **多 agent 协作的开发者**（Jochen 本人是典型） | 在 3-4 个 agent TUI 之间反复切换看对话；改 hub 参数得记命令 | 一窗口看全部 peer + 消息流；配置面板点选即生效 |
| **agent 任务协调者** | 想给某个 agent 发任务指令，但不想打开它的 TUI；也不知道 agent 现在在不在 hub 上 | 输入框直接发 `bridge_chat` / `bridge_task`；目标 agent 在线时实时送达，离线时排队 |
| **长期盯盘的"调度员"** | hub 死没死、agent 离没离线，全靠 `status` 命令轮询 | 系统托盘常驻 + 未读消息数；服务挂了图标变红 |
| **CI / 流水线维护者** | 改 hub 配置要进每台机器敲命令 | "安装开机自启"按钮一键 systemd / Run key / launchd |

**v1 不服务**：纯 LLM 玩家（v1.1 加 AI 助理面板）、远程团队协作（v1 只连本地）、定制 UI 的高级用户（v1 不开放主题切换）。

## 3. 用户故事

按优先级排列（P0 = 必须有；P1 = 应该有；P2 = 加分项）。

### P0（v1 阻塞项）

- **US-1**：作为多 agent 协作用户，我希望 **一窗口看到所有 peer 的在线状态和最后消息时间**，不需要切到 status 命令行。
- **US-2**：作为消息观察者，我希望 **点击任意 peer 就能看它和别人的对话历史**（不限于和自己相关的），用来 debug 协作流程。
- **US-3**：作为协调者，我希望 **直接以"agent-hub-cli"身份发消息给任意在线 peer**，不用打开对方的 TUI。
- **US-4**：作为管理员，我希望 **改 hub 配置（端口、邮箱上限、wait 超时等）有 GUI 表单**，不用记 CLI 参数。
- **US-5**：作为管理员，我希望 **双击桌面图标 = 自动启动 hub + 打开主窗口**，而不是手动先跑命令。
- **US-6**：作为长期盯盘用户，我希望 **关闭主窗口后 hub 还在跑、托盘还在**，随时右键恢复。
- **US-7**：作为 herdr 用户，我希望 **在 GUI 里直接驱动 agent 终端**（prompt、按键、读输出），不用单独起 herdr CLI。

### P1（强烈推荐）

- **US-8**：作为 Markdown 重度用户，我希望 **消息支持 Markdown 渲染 + 代码高亮**，阅读体验接近 GitHub / Slack。
- **US-9**：作为效率用户，我希望 **输入 `/` 弹出命令面板**，常用命令一键执行（`/peers /broadcast /history`）。
- **US-10**：作为多机协作用户，我希望 **多 peer cc 一次发送**，避免广播 spam 所有 agent。
- **US-11**：作为运维人员，我希望 **一键安装 / 卸载开机自启服务**，对应三平台不同的 daemon 机制。
- **US-12**：作为国际化需求用户，我希望 **中英双语可切换**，UI 不锁死语言。

### P2（加分项）

- **US-13**：作为日常用户，我希望 **拖拽文件附加到消息**，便捷分享脚本 / 日志。
- **US-14**：作为追求美观用户，我希望 **托盘图标动态反映 hub 状态**（绿/灰/红）。
- **US-15**：作为性能敏感用户，我希望 **消息流支持虚拟滚动**，5000 条不卡。

## 4. 功能需求

### 4.1 必须有（P0 → SPEC AC-1..7, 10）

| 编号 | 功能 | 关联用户故事 |
|---|---|---|
| F-01 | Hub 子进程内嵌（spawn / stop / restart + log） | US-5 |
| F-02 | 配置面板（12 项参数 + SQLite 持久化） | US-4 |
| F-03 | 三栏 UI（peer 列表 / 消息流 / 详情） | US-1, US-2 |
| F-04 | 作为 `agent-hub-cli` peer 发消息（bridge_chat/task） | US-3 |
| F-05 | 关闭主窗口 → 隐藏到托盘；进程不退出 | US-6 |
| F-06 | 系统托盘 + 右键菜单（打开 / 重启 / 退出）+ 动态图标 | US-6, US-14 |
| F-07 | 独立"终端"标签页（11 个 herdr 控制工具） | US-7 |
| F-08 | MCP SSE 长连接 + 自动重连 + 会话保活 | F-04 的支撑 |
| F-09 | SQLite schema（config / peers / messages / unread） | 全部功能的持久化层 |

### 4.2 应该有（P1 → SPEC AC-6, 8, 9, 11）

| 编号 | 功能 | 关联用户故事 |
|---|---|---|
| F-10 | Markdown 渲染 + 代码高亮（react-markdown + rehype-highlight） | US-8 |
| F-11 | `/` 命令面板（`/help /peers /broadcast /history /clear`） | US-9 |
| F-12 | 多 peer cc（单次发送多个目标） | US-10 |
| F-13 | "安装开机自启"按钮 → 调 `agent-comm-hub service install/uninstall` | US-11 |
| F-14 | i18n（中英双语切换；react-i18next + i18next） | US-12 |

### 4.3 加分项（P2 → SPEC AC-12）

| 编号 | 功能 | 关联用户故事 |
|---|---|---|
| F-15 | 拖拽文件附件（base64/dataURL） | US-13 |
| F-16 | 虚拟滚动消息流（@tanstack/react-virtual） | US-15 |
| F-17 | 托盘 badge 显示未读消息数 | US-14 |

### 4.4 显式不包含（v1 non-goals，参考 SPEC §2）

- 内置 LLM 助理（v1.1）
- 远程 hub 管理（v1 只连 127.0.0.1）
- 主题切换器（v1 锁死暗模式）
- 自动更新（v1.1 加 tauri-plugin-updater）
- 移动端 / Web
- 插件系统

## 5. 非功能需求

### 5.1 性能

| 指标 | 目标 | 测量方式 |
|---|---|---|
| 冷启动到首屏 | ≤ 1.5s | 三平台 CI 截图 + 计时 |
| 消息流滚动 | 60fps / 5000 条 | DevTools Performance |
| herdr 输出节流 | 200ms 刷新 | 单元测试 |
| 安装包体积 | Win msi ≤ 30MB / mac dmg ≤ 25MB / Linux AppImage ≤ 35MB | `du` / `Get-Item` |

### 5.2 可用性

- 主交互路径 ≤ 3 次点击可达（"改配置 → 应用" / "发消息 → 送达" / "装服务 → 完成"）
- 所有错误提示人类可读，不暴露 Rust panic / 堆栈
- 键盘快捷键：`Ctrl+K`（命令面板）、`Ctrl+Enter`（发送）、`Ctrl+,`（设置）、`Ctrl+W`（关闭当前 tab）
- WCAG AA：所有文本对比度 ≥ 4.5:1；UI 元素 ≥ 3:1（已用 `/color` skill 校验）

### 5.3 安全

- hub 仍绑 127.0.0.1；桌面端不引入远程访问能力
- 配置文件写入 `appDataDir/config.json` 而非 ~/.ssh / 用户主目录敏感路径
- SQLite 文件走 OS 用户权限（Unix 600 / Windows ACL）
- 不引入凭据；hub 本身无认证
- herdr CLI 调用走 `Command::new`，参数数组传，不拼接 shell 字符串

### 5.4 可维护性

- 所有 21 个 bridge tool 在前端有 typed wrapper（zod schema 校验）
- Rust 端每个 tauri_command 有单元测试
- CI 在三平台跑 `cargo test` + `pnpm test` + `pnpm build` + `tauri build` 全套
- 提交规范：Conventional Commits；CHANGELOG 自动生成（release-please 或类似）

## 6. 成功指标

### 6.1 采纳指标（v1 GA 后 30 天）

| 指标 | 目标 |
|---|---|
| 下载量（npm `agent-comm-hub-app`） | ≥ 200 周下载 |
| 三平台安装成功率 | ≥ 95%（CI 全绿 + 实机验证） |
| 启动崩溃率 | < 1%（上报到控制台 / Sentry 可选） |

### 6.2 功能指标（功能埋点，v1 GA 后观察）

| 指标 | 目标 |
|---|---|
| 用户平均在 UI 内发的 bridge_chat 数 | ≥ 3 次/会话 |
| 托盘右键菜单点击率 | ≥ 0.5 次/天 |
| 配置面板使用率 | ≥ 20% 用户改过配置 |
| herdr 面板使用率 | ≥ 30% 启用了 herdr 的用户点过 |

### 6.3 质量指标

- 三平台 CI 绿 ≥ 95% commits
- 主要 bug（导致数据丢失 / 进程僵死）= 0
- `/color` skill 自动校验每条色板规则通过

## 7. 风险与缓解

| # | 风险 | 影响 | 概率 | 缓解策略 |
|---|---|---|---|---|
| R-1 | Rust MCP 客户端实现出错（协议不一致） | 高 | 中 | 用 hub 自己的 `test/smoke.mjs` 套件作为契约测试；先在 Node.js 实现 1:1 移植 Rust，再用同一 fixture 跑 |
| R-2 | herdr 不在用户 PATH | 中 | 高 | 控制工具 graceful degrade，提示"未启用"；其余 10 个消息工具照常工作 |
| R-3 | Tauri 2 + Rust 1.97 + 某 plugin 兼容性 | 中 | 中 | 锁版本在 tauri = "2.x"、tauri-plugin-system-tray = "2.x"；CI 矩阵提前跑；备用方案：自实现 tray（API 稳定） |
| R-4 | 三平台打包签名（macOS notarization / Windows EV 证书） | 中 | 高 | v1 仅 unsigned dev build 供测试；签名发布推到 v1.1（CI secrets 接入） |
| R-5 | SQLite 跨平台 file lock（Windows / macOS / Linux 行为不一） | 低 | 低 | 用 WAL 模式 + 单进程独占（Rust 端单 sqlite::Connection） |
| R-6 | 消息体积爆炸（base64 附件） | 中 | 中 | 设置附件上限 5 MB / 单文件；超出拒绝 |
| R-7 | Markdown XSS（消息内容含恶意 HTML） | 中 | 中 | rehype-sanitize 白名单；外链加 `rel="noopener noreferrer"`；代码块高亮走 hljs（不执行 JS） |

## 8. 依赖与外部合作

- **Tauri 团队**：依赖 Tauri 2 稳定版；bug 走 GitHub Issues
- **shadcn/ui**：CLI 拉组件代码到本地，不锁运行时版本
- **hub 主包**：零运行时依赖约束；桌面端不向主包加任何依赖
- **herdr**（可选）：用户机器安装即可；桌面端不自带 herdr
- **Rust crates**：rusqlite / tokio / reqwest / serde（均为 well-maintained）

## 9. 发布 / 上线计划

| 阶段 | 触发 | 内容 |
|---|---|---|
| **M1（MVP 内部测试）** | SPEC + 主窗口骨架 + hub spawn + peer 列表 | 给 Jochen 本机用 |
| **M2（功能完整）** | + 21 工具全部接通 + 配置面板 + herdr 面板 + 托盘 | 给 3-5 个 alpha tester |
| **M3（打磨）** | + Markdown / 命令面板 / i18n / 拖拽 / 虚拟滚动 | GA candidate |
| **v1.0 发布** | 三平台打包 + CI 全绿 + `/color` 校验 + CHANGELOG | npm `agent-comm-hub-app@1.0.0` + GitHub Release |
| **v1.1（规划）** | + tauri-plugin-updater / 内置 LLM 助理 / 主题切换 | 待 v1.0 GA 后评估 |