# agent-comm-hub 桌面端 — PLAN

> Implementation Plan
> 对应 SPEC.md（做什么）+ PRD.md（为什么）。本文档回答"怎么落地 / 谁先做 / 怎么测"。

## 1. 里程碑

### M1 — MVP 骨架（2 周）

**目标**：能跑起来，看到主窗口，能 spawn / 启停 hub，能在 peer 列表里看到已注册 peer。

| 任务 | 文件 | 验收 |
|---|---|---|
| T-1.1 初始化 `app/` 工作区 | `app/package.json`, `app/src-tauri/Cargo.toml`, `app/vite.config.ts`, `app/tsconfig.json` | `pnpm dev` 起 Vite + Tauri |
| T-1.2 Rust 端 hello tray | `app/src-tauri/src/main.rs`, `app/src-tauri/src/tray.rs` | 双击 → 主窗口 + 托盘同时出现 |
| T-1.3 Hub 子进程管理 | `app/src-tauri/src/hub_process.rs` | spawn / stop / restart + 端口就绪探测 |
| T-1.4 实时日志面板 | `app/src-tauri/src/hub_process.rs` + `app/src/views/LogsView.tsx` | 最近 500 行 stdout/stderr，环形缓冲 |
| T-1.5 SQLite schema + 迁移 | `app/src-tauri/src/sqlite_store.rs` | 启动自动建表；migration 编号 v1 |
| T-1.6 Rust MCP 客户端 | `app/src-tauri/src/mcp_client.rs` | `initialize` + `tools/list` + `tools/call` + SSE 监听 |
| T-1.7 前端 peer 列表 | `app/src/views/PeersView.tsx`, `app/src/stores/peersStore.ts` | `bridge_peers` 拉取 + 实时更新 |
| T-1.8 UI peer `agent-hub-cli` 自动注册 | `mcp_client.rs` 启动时 `initialize` 后 `tools/call bridge_register "agent-hub-cli"` | hub 内可见 `agent-hub-cli` peer |
| T-1.9 三栏骨架（无详情） | `app/src/App.tsx` 路由布局 | 三栏可见，peer 选中态生效 |
| T-1.10 smoke 测试 | `app/tests/m1-smoke.test.ts` | 双击 → 看到 hub 启动 + peer 列表填充 |

**M1 验收**：Jochen 本机能用 UI 启停 hub，看到 peer 列表更新。

### M2 — 功能完整（3 周）

**目标**：21 个 bridge tool 全部接通 + 配置面板 + herdr 终端页 + 托盘增强 + SQLite 持久化。

| 任务 | 文件 | 验收 |
|---|---|---|
| T-2.1 消息流 + chat/task 发送 | `MessagesView.tsx`, `messagesStore.ts`, `tauri_commands.rs` | 人类打字 → bridge_chat 发出；SSE 回执实时显示 |
| T-2.2 详情栏（task prompt / context / deliverable） | `DetailView.tsx` | 选中 task 消息看到完整结构化字段 |
| T-2.3 ack 状态机时间线 | `DetailView.tsx` | accepted → done 时间线渲染 |
| T-2.4 历史消息同步 | `mcp_client.rs` `bridge_history` 拉取 + 增量 | 启动拉到最近 100 条；新消息 SSE 推送 |
| T-2.5 配置面板（12 项） | `SettingsView.tsx`, `configStore.ts`, `hub_process.rs` | 改 port → 重启 hub → 新端口生效 |
| T-2.6 SQLite 写消息 | `sqlite_store.rs` + Tauri event `hub:message` 监听 | 收消息同步落库 |
| T-2.7 未读计数 + 标记已读 | `peersStore.ts` + `DetailView.tsx` 选中触发 | 切换 peer 未读清零 |
| T-2.8 herdr_client 移植 | `app/src-tauri/src/herdr_client.rs` | execFile herdr CLI + 套接字客户端 1:1 移植 hub-tools.ts |
| T-2.9 独立"终端"标签页 | `TerminalView.tsx` + 11 个子组件 | bridge_agent_* / bridge_pane_* 全部接通 |
| T-2.10 herdr 输出节流（200ms） | `TerminalView.tsx` | 高频输出不卡主线程 |
| T-2.11 托盘 badge + 动态图标 | `tray.rs` + `trayBadgeStore.ts` | 未读数实时；hub 死了图标变灰 |
| T-2.12 关闭主窗口 → 隐藏到托盘 | `main.rs` window event | close → hide，不退出进程 |
| T-2.13 右键托盘菜单（打开 / 重启 / 退出） | `tray.rs` | 三动作可用 |

**M2 验收**：3-5 个 alpha tester 能在三平台各自用起来，所有 P0 用户故事跑通。

### M3 — 打磨（2 周）

**目标**：Markdown / 命令面板 / i18n / 拖拽 / 虚拟滚动；色板校验；性能 / 体积达标。

| 任务 | 文件 | 验收 |
|---|---|---|
| T-3.1 Markdown 渲染 + 代码高亮 | `lib/markdown.tsx` + rehype-sanitize | 消息含 # / ``` / 表格 渲染正确；XSS 测试通过 |
| T-3.2 `/` 命令面板 | `components/CommandPalette.tsx` | `/peers /broadcast /history /help /clear` |
| T-3.3 多 peer cc | `MessagesView.tsx` 接收者多选 | 一次发给 3 个 peer，三个都收到 |
| T-3.4 拖拽文件附件 | `MessagesView.tsx` + base64 编码 + 5MB 上限 | .txt 拖入 → 发送成功；>5MB 拒绝 |
| T-3.5 虚拟滚动消息流 | `@tanstack/react-virtual` 接入 | 5000 条滚动 60fps |
| T-3.6 i18n（中英双语） | `i18n/{zh-CN,en-US}.json` + `react-i18next` | 切换立即生效；缺词 fallback zh-CN |
| T-3.7 键盘快捷键 | `useHotkeys` hook | Ctrl+K / Ctrl+Enter / Ctrl+, / Ctrl+W |
| T-3.8 主题色板 CSS variables + shadcn theme | `app/src/styles/theme.css` + `tailwind.config.ts` | Slate + Teal 暗模式锁定；`/color` 校验脚本通过 |
| T-3.9 启动时间优化（≤1.5s） | `tauri.conf.json` `app.windows[0].visible: false` + 加载完成再 show | 三平台基准测试通过 |
| T-3.10 安装包体积优化 | `tauri.conf.json` `bundle.active: true` 精简 | 三平台打包达标 |
| T-3.11 CHANGELOG + 文档 | `app/CHANGELOG.md`, `app/README.md`, `app/README.zh.md` | 用户能快速上手 |

**M3 验收**：GA candidate，所有 SPEC §6 AC 条目 ✅；CI 三平台绿。

### M4 — GA 发布（1 周）

| 任务 | 验收 |
|---|---|
| T-4.1 GitHub Actions 三平台矩阵 | push → CI 跑完 → 产物（msi/dmg/AppImage+deb）上传 artifact |
| T-4.2 npm 发布 `agent-comm-hub-app@1.0.0` | `pnpm publish` 通过；README 截图齐 |
| T-4.3 GitHub Release | tag `v1.0.0` + release notes（用 `scripts/release-notes.mjs` 类似工具） |
| T-4.4 主仓 README 更新 | 主 README 增加"桌面端"章节链接 |
| T-4.5 AGENTS.md 更新 | 把桌面端项目位置 / 不污染 zero-dep 约束写明 |

## 2. 依赖关系图

```
M1: T-1.1 ─→ T-1.2 ─→ T-1.3 ─→ T-1.5 ─→ T-1.6 ─→ T-1.7
                  └─→ T-1.4            └─→ T-1.8 ─→ T-1.9
                                              └─→ T-1.10

M2: T-2.1 ─┬─→ T-2.2 ─→ T-2.3 ─→ T-2.4 ─→ T-2.5
           └─→ T-2.6 ─→ T-2.7                 │
                                                ├─→ T-2.8 ─→ T-2.9 ─→ T-2.10
                                                └─→ T-2.11 ─→ T-2.12 ─→ T-2.13

M3: T-3.1 → T-3.2 → T-3.3 → T-3.4 → T-3.5 ──→ T-3.6 → T-3.7 ─→ T-3.8 → T-3.9 → T-3.10 → T-3.11

M4: T-4.1 → T-4.2 → T-4.3 → T-4.4 → T-4.5
```

M2 关键路径：`T-2.1 → T-2.4 → T-2.5`（消息收发 + 历史同步 + 配置）。
M2 并行轨道：`T-2.8 → T-2.9 → T-2.10`（herdr 终端）。
M3 可部分并行：`T-3.1 / T-3.2 / T-3.4 / T-3.6` 互不依赖；`T-3.8 / T-3.9 / T-3.10` 串行。

## 3. 测试策略

### 3.1 单元测试

| 层 | 工具 | 覆盖率目标 |
|---|---|---|
| Rust 后端 | `cargo test` 内置 | ≥ 70%（hub_process / mcp_client / sqlite_store / herdr_client 重点覆盖） |
| 前端 store | `vitest` | ≥ 60%（zustand store 状态机分支） |
| 前端组件 | `vitest` + `@testing-library/react` | 关键路径（peer 选中 / 消息发送 / 配置变更 / 命令面板） |

### 3.2 集成测试

| 测试 | 内容 |
|---|---|
| `app/tests/integration/hub-spawn.test.ts` | spawn hub 子进程 → 端口就绪 → 注册 peer → 触发 UI store 更新 |
| `app/tests/integration/mcp-roundtrip.test.ts` | UI 注入 chat → hub 收到 → SSE 回执 → UI store 更新 |
| `app/tests/integration/sqlite-persistence.test.ts` | 启动写消息 → 关 app → 重启 → 消息仍在 |
| `app/tests/integration/herdr-panel.test.ts` | 启动 fake-herdr → bridge_agent_* 工具链端到端 |

### 3.3 E2E（WebDriver，Tauri 2 自带）

| 场景 | 步骤 |
|---|---|
| 启动 + 自动 spawn hub | 双击 → 主窗口 → 看到 peer 列表 |
| 发送消息 | 选中 peer → 输入文本 → Ctrl+Enter → 详情栏显示 receipt |
| 改配置 + 重启 | 设置 → 改 port → 应用 → 重启 → 新端口生效 |
| 关闭 → 托盘恢复 | 关闭主窗口 → 托盘存在 → 右键"打开" → 主窗口回来 |

### 3.4 性能 / 体积

- **冷启动时间**：CI 跑 5 次取中位数；目标 ≤ 1.5s
- **消息流滚动 fps**：DevTools Performance 录屏 + `requestAnimationFrame` 计数
- **安装包体积**：`tauri build` 产物 `ls -lh` / `Get-Item`；目标 ≤ SPEC §6.2 NFR-4

### 3.5 颜色合规

- `/color` skill 的 `scripts/check_contrast.py --audit` 对所有 CSS variables 跑批量校验
- `scripts/simulate_cvd.py` 对 success / warning / error 模拟 CVD
- 不存在 chromostereopsis 风险（脚本会自动检测红+蓝相邻）

## 4. 风险登记（与 PRD §7 同步）

| # | 风险 | 监控指标 | 触发 Plan B |
|---|---|---|---|
| R-1 | Rust MCP 客户端协议不兼容 | M1 阶段 `bridge_peers` 拉取成功率 < 100% | 用 Node 子进程跑 `test/smoke.mjs` 作为对照；定位差异 |
| R-2 | herdr 不在 PATH | M2 alpha 测试 0/N 用户启用 herdr | herdr 面板默认隐藏，设置面板提供开关 |
| R-3 | Tauri plugin 兼容性 | CI 三平台 cargo build 失败 | 锁版本 + 备用自实现（tray API 稳定） |
| R-4 | 打包签名（mac notarize / Win EV） | M4 阶段打包产物签名失败 | v1 发 unsigned dev build；签名推 v1.1 |
| R-5 | SQLite file lock | M2 阶段出现 "database is locked" | 切 WAL + 加 connection timeout |
| R-6 | 附件体积爆炸 | M3 阶段附件测试 > 5MB | 硬限制 5MB；UI 弹提示 |
| R-7 | Markdown XSS | M3 阶段 fuzz 测试失败 | rehype-sanitize 白名单 + 测试覆盖 |

## 5. 交付物清单

- `app/` 完整工作区（pnpm + Cargo + Vite + Tauri）
- `app/docs/{SPEC,PRD,PLAN}.md`（已完成）
- `app/CHANGELOG.md` + `app/README.md` + `app/README.zh.md`
- `app/src-tauri/Cargo.toml` + `app/src-tauri/tauri.conf.json`
- `app/package.json` + `app/vite.config.ts` + `app/tsconfig.json` + `app/tailwind.config.ts`
- 全部源代码（Rust + TS）
- 全部测试（unit + integration + e2e + color）
- CI 工作流 `.github/workflows/ci-app.yml`
- npm 发布配置（与主仓同名 npm org）
- v1.0 GA：npm `agent-comm-hub-app@1.0.0` + GitHub Release + 三平台安装包

## 6. 进度跟踪

每个 M 完成后更新 `app/docs/STATUS.md`（M1 结束时创建）：
- 已完成 vs 计划任务
- 任何 scope 变更（追加 / 推迟 / 删除）
- 风险登记表更新
- 下个 M 的具体行动项

## 7. References

- `app/docs/SPEC.md` — 做什么 + 验收
- `app/docs/PRD.md` — 为什么 + 优先级 + 成功指标
- `../ARCHITECTURE.md` — 主仓架构参考
- `../src/hub-tools.ts` — 21 个 bridge tool 签名（移植源）
- `../src/herdr-ctl.ts` — herdr 适配逻辑（Rust 移植源）
- `../AGENTS.md` — 不可破约束