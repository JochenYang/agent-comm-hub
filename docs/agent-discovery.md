# 本地 Agent 发现与自动配置 — 开发文档

> 状态：**待确认**（未实施）。本文档是实施依据，任何与文档不符的实现都视为错误。
> 目标版本：0.4.0（实施完成后 minor bump 发布）。

## 1. 目标

把 `agent-comm-hub setup` 从"固定清单扫描"升级为"**发现 + 声明式注册表**"：

1. **发现**本机装了哪些 agent（三端：Windows / macOS / Linux）
2. 按**注册表**自动配置对应的 MCP 条目 + skill（复用现有幂等/备份契约）
3. 新增 agent 支持 = **加一条注册表记录**，不改代码

明确不做（边界）：

- **不安装任何 agent**（发现 ≠ 安装）
- 不做跨机器发现（那属于 A2A/网络协议范畴；本文档仅限单机）
- 不做进程级枚举（tasklist / ps 三端语法维护成本高、收益低，见 §6）

## 2. 现状与差距

| 项 | 现状 | 差距 |
|---|---|---|
| setup 目标清单 | `src/setup.ts` 内硬编码 7 类 agent | 无发现、新增 agent 需发版 |
| merge 策略 | JSON section / TOML 追加 / DSH YAML insert（三套函数） | 可复用，需抽象成策略字段 |
| PATH 探测 | 无 | 新增（纯 Node，见 §4.2） |
| npm 全局发现 | 无 | 新增 |
| macOS 自启 | `service install` 返回 "not implemented" | **补齐 launchd** |
| CI | 仅 ubuntu-latest | **加三端 matrix** |

## 3. 架构总览

```text
setup / discover
      │
      ▼
 发现引擎 discover.ts（三源）
      │  ① PATH 探测（纯 Node）
      │  ② 注册表配置路径存在性
      │  ③ npm 全局包目录
      ▼
 agents/registry.json（声明式注册表）
      │  匹配：id → 配置模板 + merge 策略 + skill 路径
      ▼
 setup 现有 merge 引擎（mergeJsonServer / mergeTomlSection / mergeDshPatch）
      │  幂等 · 先备份 · 只动 agent-hub 键 · UTF-8 无 BOM
      ▼
 完成 + 发现清单输出
```

## 4. 详细设计

### 4.0 注册表覆盖的 agent（v0.4.0，调研截至 2026-08-14）

| id | 厂商/项目 | 配置 | 格式要点 | 接入方式 |
|---|---|---|---|---|
| mcode | MiniMax | `~/.minimax/mcp.json` + `~/.minimax/mcp/mcp.json` | `mcpServers` + `url` | setup 自动 |
| opencode | opencode | `~/.config/opencode/opencode.json` | `mcp` + `type:"remote"` | setup 自动 |
| kimi-code | Moonshot | `~/.kimi-code/mcp.json` | `mcpServers` + `transport:"http"` | setup 自动 |
| gemini-cli | Google | `~/.gemini/settings.json` | `mcpServers` + `type:"http"` | setup 自动 |
| codex | OpenAI | `~/.codex/config.toml` | `[mcp_servers.*]` TOML | setup 自动 |
| zcode | zcode | `~/.zcode/cli/config.json` | 嵌套 `mcp.servers` + `type:"remote"` | setup 自动 |
| dsh | DeepSeek Harness | `~/.dsh/profiles/*/cordis.patch.yml` | YAML insert（marker 行） | setup 自动 |
| claude | Anthropic | 项目 `.mcp.json`（manual） | 不碰 `~/.claude.json` | 手动（skill 自动） |
| claude-desktop | Anthropic | `~/Library/Application Support/Claude/claude_desktop_config.json`（macOS only） | `mcpServers` | setup 自动 |
| **qwen-code** | 阿里（QwenLM） | `~/.qwen/settings.json` | `mcpServers` + **`httpUrl`**（官方文档确认） | setup 自动 |
| **pi** | pi.dev（earendil-works，90k★） | 无配置文件（**明确不内置 MCP**，见 [mariozechner.at](https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/)） | 需 TypeScript extension 或第三方包（如 0xKobold/pi-mcp） | **手动**（extension）；但 pi 原生支持 `~/.agents/skills`，跨 agent skill 自动覆盖 |
| **cursor** | Anysphere | `~/.cursor/mcp.json`（项目 `.cursor/mcp.json`） | `mcpServers` + **`url`**（官方 GitHub 安装指南确认 Streamable HTTP） | setup 自动 |
| **qoder** | Qoder | `~/.qoder.json` | `mcpServers` 已确认；remote 键名未最终确认 | **probe-only**（检测可识别，配置待确认后补） |
| **codebuddy** | 腾讯 | `~/.codebuddy/.mcp.json` → `mcp.json` → `.codebuddy.json`（优先级链） | `mcpServers` 已确认；remote 键名未最终确认 | **probe-only** |

待验证（未加入注册表，后续按社区反馈补）：

- **Amazon Q Developer CLI**（AWS）：`~/.aws/amazonq/mcp.json`（legacy）/ `default.json`（新），`mcpServers` + `type:"http"` 有来源但两套路径并存，remote 细节未定 → 不猜格式
- **GitHub Copilot CLI**（GitHub）：有 MCP 配置支持，具体路径/格式未最终确认
- **Windsurf**（Codeium）：`~/.codeium/windsurf/mcp_config.json` 已确认，remote 键名未确认
- **Zed**：**stdio only**（不支持 streamable-http，全景图 2026-03 确认）→ 不适用，排除
- 其他（字节 MarsCode/Trae、Aider、Amp、GLM、Kiro 等）：未调研或格式不稳定，不列入

规则：**配置格式未经官方文档确认的 agent 不加入注册表**（宁可手动，不猜格式）；格式未确认但确实存在的，以 **probe-only** 记录加入（discover 可识别，配置待确认后补）。

### 4.1 声明式注册表 `agents/registry.json`

新增文件，随 npm 包发布（`agents/` 已在 files 白名单）。**单一事实来源**：setup 不再硬编码任何 agent。

```json
{
  "$schema": "docs/agent-registry.schema.json",
  "agents": [
    {
      "id": "opencode",
      "probe": ["opencode"],
      "config": {
        "file": "~/.config/opencode/opencode.json",
        "section": "mcp",
        "strategy": "json",
        "entry": { "type": "remote", "url": "{url}", "enabled": true }
      },
      "skill": "~/.config/opencode/skills",
      "os": ["win32", "darwin", "linux"]
    },
    {
      "id": "claude-desktop",
      "probe": [],
      "config": {
        "file": "~/Library/Application Support/Claude/claude_desktop_config.json",
        "section": "mcpServers",
        "strategy": "json",
        "entry": { "url": "{url}", "type": "streamable-http" }
      },
      "skill": null,
      "os": ["darwin"]
    }
  ]
}
```

字段约定：

- `file`：一律 `~` 相对（运行时替换为 `os.homedir()`），目录用 `/` 分隔，由 `path.join` 组装（各平台分隔符自动正确）
- `os`：允许的进程平台（`win32` / `darwin` / `linux`）；缺省 = 三端都允许
- `strategy`：`json`（JSON section）/ `toml`（TOML 追加）/ `dsh`（YAML insert，走现有 `mergeDshPatch` 的 marker 逻辑）
- `entry` 中的 `{url}`、`{serverName}` 为占位符，运行时替换
- `probe`：PATH 探测用的命令名数组（任一命中即视为已安装）
- `skill`：skill 安装目录（`null` = 该 agent 不装 skill）；现有 7 类 agent 的 skill 路径不变
- 保留现有行为：mcode 双文件（`~/.minimax/mcp.json` + `~/.minimax/mcp/mcp.json`）→ 一条记录两个 `config` 条目（数组）

**新增 agent 支持流程**（写进 agents/README.md）：PR 加一条记录 + 一条测试，代码零改动。

### 4.2 发现引擎 `src/discover.ts`（新文件）

```
discover(home, env): Promise<DiscoveredAgent[]>
DiscoveredAgent = { id, source: 'path'|'config'|'npm', present: boolean, configFile?: string }
```

三源（任一命中即 present）：

**① PATH 探测（纯 Node，零 shell、零 which/where 依赖）**

- 取 `process.env.PATH`，按平台分隔符拆分：`win32` → `;`，其余 → `:`
- 对每个注册表记录的每个 `probe` 命令名：
  - `win32`：按 `PATHEXT`（默认 `.COM;.EXE;.BAT;.CMD`）补扩展名；`fs.accessSync(path, X_OK)` 检查
  - POSIX：`fs.accessSync(path, X_OK)` 直接检查（Linux 上**大小写敏感**，命令名必须精确）
- 空 PATH 段按当前目录处理（POSIX 约定）；不存在/不可读目录跳过

**② 注册表配置路径存在性**

- `file` 模板替换 `~` → home 后 `fs.existsSync`（目录/文件皆可）
- 注意 Linux 大小写敏感：路径必须与注册表完全一致

**③ npm 全局包目录（发现 `@opencode-ai/cli`、`@anthropic-ai/claude-code` 等）**

- 首选：`execFile('npm', ['root', '-g'])` 输出目录，读其 `node_modules` 下的目录名
- npm 不可用时回退常见目录（仅探测存在性）：
  - `win32`：`%APPDATA%\npm\node_modules`
  - POSIX：`/usr/local/lib/node_modules`、`/usr/lib/node_modules`、nvm 目录（`~/.nvm/versions/node/*/lib/node_modules`，用 glob 或递归一层）
- 匹配规则：目录名 `@scope/name` → 归一为 `name`，与注册表记录 `id` 或额外字段 `npm`（如 `"npm": "opencode"` 对应 `@opencode-ai/cli`）对照

### 4.3 `setup` 改造（`src/setup.ts`）

- 流程：`load registry → discover → 逐条按 strategy 调现有 merge 函数`
- 输出（新）：
  ```
  discovered: opencode (path), mcode (config), kimi-code (npm), codex (path) ...
  configured: opencode, kimi-code ...
  skipped (not installed): gemini-cli, zcode
  unknown but running: <提示不属于注册表，引导手动 --server-name>
  ```
- **契约不变**：只动 `agent-hub` 键、先备份、幂等、`--remove` 撤销、缺配置跳过
- `--agent <id>` 新参数：只配置指定 agent；`--server-name` 语义不变

### 4.4 `discover` 命令（`src/cli.ts` + `src/ops.ts`）

- `agent-comm-hub discover`：只发现不配置，输出表格（id / source / configFile / 状态）
- 内部复用 `runDiscover()`，`setup` 与 `discover` 共用同一引擎

### 4.5 macOS 自启补齐（`src/ops.ts` `runService`）

现状：`darwin` 返回 "not implemented"。补齐 launchd LaunchAgent：

- 文件：`~/Library/LaunchAgents/com.agent-comm-hub.plist`
- 内容（XML plist）：`Label`、`ProgramArguments`（`[nodeExe, cliPath, --host, --port, --path]`）、`RunAtLoad`、`KeepAlive`、`StandardOutPath`/`StandardErrorPath`（指向 `~/Library/Logs/agent-comm-hub.log`）
- 安装：`launchctl bootstrap gui/<uid> <plist>`（新 API；兼容老系统回退 `launchctl load -w`）
- 卸载：`launchctl bootout gui/<uid>/com.agent-comm-hub` + 删 plist
- `--dry-run` 打印命令，不执行（与现有行为一致）
- uid 获取：`process.getuid()`（POSIX 可用）或 `id -u` 回退

### 4.6 CI 三端 matrix（`.github/workflows/ci.yml`）

```yaml
strategy:
  matrix:
    os: [ubuntu-latest, windows-latest, macos-latest]
```
- 每端：pnpm 10 + Node 22 → install → typecheck → test → pack
- 注意：Windows runner 的 PowerShell 路径、macOS runner 的 bash；测试本身不依赖平台（fake home/fake PATH），出现平台差异即为 bug
- 产物上传保留 ubuntu 一份即可（或三端都传，同名 artifact 需合并配置）

### 4.7 测试计划

- `test/discover.mjs`（新，走 `test/discover-entry.ts`）：
  - fake PATH（临时目录树 + 假可执行文件）验证 PATH 探测：win32 分隔符/PATHEXT 逻辑（用参数注入平台，不真跑 Windows）
  - fake home 验证配置路径存在性
  - fake npm root（注入 `npmRoot` 参数）验证 npm 发现
  - 注册表 schema 校验：坏记录（缺 strategy、os 非法、路径越界 `../`）报错
  - 大小写：Linux 语义下路径精确匹配（参数注入）
- `test/setup.mjs` 扩展：注册表驱动的安装/幂等/remove 回归（现有 32 项保持通过）
- 三端 CI 跑同一套测试

## 5. 安全与边界

- PATH 探测只读文件系统，不执行任何二进制
- 注册表路径**禁止** `..` 越界（校验），`~` 只展开一次
- npm 发现只读目录名，不执行 npm install
- 配置写入仍走现有备份/幂等契约；未知 agent 绝不猜测配置格式

## 6. 明确不做（防止范围蔓延）

- 进程级枚举（tasklist / `ps -ef` / `ps aux` 三套语法 + 权限差异，维护成本高；PATH+配置+npm 已覆盖"装了哪些 agent"的 95%）
- 跨机器发现 / 网络协议（A2A 等）
- 自动安装 agent 或依赖
- 修改现有 7 类 agent 的配置格式与 skill 路径（向后兼容）

## 7. 验收标准

1. 三端 CI（ubuntu/windows/macos）typecheck + 测试全绿
2. `discover` 在本机三端语义下正确列出已装 agent（fake 环境单测 + 本机 Windows 实测）
3. `setup` 输出发现清单；配置结果与改造前**逐字节一致**（对现有 7 类 agent 回归）
4. macOS `service install/uninstall --dry-run` 输出正确的 launchctl 命令
5. 新增 agent（如 claude-desktop）只需加注册表记录 + 一条测试，代码零改动

## 8. 实施顺序（每步独立可验收）

1. `agents/registry.json` + schema 校验 + 测试（现有行为不变，setup 先读注册表）
2. `src/discover.ts` PATH/npm 发现 + 单测
3. `setup` 接入发现清单输出 + `--agent` 参数 + 回归测试
4. `discover` 命令
5. macOS launchd 自启 + `--dry-run` 单测
6. CI 三端 matrix
7. 文档同步（README / README.zh / AGENTS.md / ARCHITECTURE.md / CHANGELOG 0.4.0）
8. 版本 bump 0.4.0 → 全量测试 → **提交前需用户确认** → 发布

## 9. 版本与发布

- 实施完成 → 0.3.0 → **0.4.0**（minor：新功能；符合过 9 进位规则）
- 发布走既有流程：CHANGELOG 行为描述 → `npm publish` → `git tag v0.4.0` → `release-notes.mjs` → `gh release create`
