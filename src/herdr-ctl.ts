/**
 * herdr control adapter — drives agent panes owned by the herdr terminal
 * runtime (https://herdr.dev) through its CLI, which is a thin JSON wrapper
 * over the local socket API. Unlike tmux (screen scraping + blind keystrokes),
 * herdr tracks each pane's agent state (idle/working/blocked/done), so the
 * hub can prompt an agent, wait until it genuinely settles, and read its
 * terminal output — all through one local binary.
 *
 * Zero runtime dependencies: plain `child_process.execFile` (no shell), so
 * prompts and keys travel as verbatim argv entries and can never be
 * interpreted by a shell. All results are lossless JSON (the DSH tool
 * registry contract).
 */

import { execFile } from 'node:child_process'

/** Agent lifecycle statuses herdr reports for a pane. */
export const AGENT_STATUSES = ['idle', 'working', 'blocked', 'done', 'unknown'] as const
export type AgentStatus = (typeof AGENT_STATUSES)[number]

/** One herdr agent pane (the AgentInfo shape from the herdr API schema,
 * reduced to what bridge tools need; no undefined fields). */
export interface HerdrAgent {
  paneId: string
  tabId: string
  terminalId: string
  name: string | null
  /** Detected agent kind, e.g. "claude-code" / "codex"; null when undetected. */
  agent: string | null
  displayAgent: string | null
  status: AgentStatus
  cwd: string | null
  focused: boolean
  /** True when the agent's input line is ready (safe to prompt/send-keys). */
  interactiveReady: boolean
  launchPending: boolean
  terminalTitle: string | null
  revision: number
}

/** Pane terminal output (the PaneReadResult shape). */
export interface HerdrRead {
  paneId: string
  tabId: string
  workspaceId: string | null
  source: string
  text: string
  revision: number
  truncated: boolean
}

/** Result of `agent wait` / `agent prompt --wait`: the settled status. */
export interface HerdrSettled {
  paneId: string
  status: AgentStatus
  waitedMs: number | null
}

export interface HerdrOptions {
  /** herdr CLI binary (default 'herdr', resolved via PATH). */
  bin?: string
  /** Fixed argv entries inserted after `bin` (used by tests to point at a
   * fake herdr script; empty in production). */
  baseArgs?: string[]
  /** Default cap for one herdr CLI call in ms (0 = inherit from per-call). */
  defaultTimeoutMs?: number
}

interface CliError extends Error {
  code?: string
  exitCode?: number | null
}

/**
 * Thin, synchronous-over-async facade over the herdr CLI. Every method maps
 * 1:1 to `herdr agent <subcommand>` and parses the JSON-RPC-style envelope
 * the CLI prints (`{"id":..., "result":...}` or `{"id":..., "error":...}`).
 */
export class HerdrCtl {
  private readonly bin: string
  private readonly baseArgs: string[]
  private readonly defaultTimeoutMs: number

  constructor(private readonly options: HerdrOptions = {}) {
    this.bin = options.bin ?? 'herdr'
    this.baseArgs = options.baseArgs ?? []
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000
  }

  /** `herdr agent list` — every agent pane herdr currently detects. */
  async list(): Promise<HerdrAgent[]> {
    const result = await this.run(['agent', 'list'])
    const raw = (result as { agents?: unknown }).agents
    if (!Array.isArray(raw)) throw new Error(`herdr agent list: unexpected result shape: ${JSON.stringify(result)}`)
    return raw.map(item => toAgent(item as Record<string, unknown>))
  }

  /** `herdr agent get <target>` — one agent pane (by paneId or name). */
  async get(target: string): Promise<HerdrAgent> {
    const result = await this.run(['agent', 'get', target])
    const raw = (result as { agent?: unknown }).agent
    if (raw === undefined || raw === null) throw new Error(`herdr agent get: unexpected result shape: ${JSON.stringify(result)}`)
    return toAgent(raw as Record<string, unknown>)
  }

  /** `herdr agent read <target>` — recent terminal output of the pane. */
  async read(target: string, options: { lines?: number; source?: 'visible' | 'recent' | 'recent-unwrapped' | 'detection' } = {}): Promise<HerdrRead> {
    const args = ['agent', 'read', target]
    if (options.source !== undefined) args.push('--source', options.source)
    if (options.lines !== undefined) args.push('--lines', String(options.lines))
    args.push('--format', 'text')
    const result = await this.run(args)
    const raw = (result as { read?: unknown }).read ?? result
    const read = raw as Record<string, unknown>
    return {
      paneId: String(read.pane_id ?? target),
      tabId: read.tab_id === undefined ? '' : String(read.tab_id),
      workspaceId: read.workspace_id === undefined ? null : String(read.workspace_id),
      source: String(read.source ?? options.source ?? 'recent'),
      text: String(read.text ?? ''),
      revision: Number(read.revision ?? 0),
      truncated: read.truncated === true,
    }
  }

  /** `herdr agent send-keys <target> <KEY>...` — raw key presses (Enter,
   * esc, ctrl-c, arrows; named keys are passed through to herdr). */
  async sendKeys(target: string, keys: string[]): Promise<void> {
    if (keys.length === 0) throw new Error('sendKeys: at least one key is required')
    await this.run(['agent', 'send-keys', target, ...keys])
  }

  /** `herdr agent prompt <target> <text>` — submit text to the agent's
   * input line (a slash command like `/compact` is executed by the agent's
   * TUI, not treated as chat content). With `wait`, blocks until the agent
   * settles (default idle/done/blocked, or the exact `until` states) or
   * `timeoutMs` elapses. */
  async prompt(
    target: string,
    text: string,
    options: { wait?: boolean; until?: AgentStatus[]; timeoutMs?: number } = {},
  ): Promise<HerdrSettled | null> {
    const args = ['agent', 'prompt', target, text]
    if (options.wait === true) args.push('--wait')
    for (const status of options.until ?? []) args.push('--until', status)
    if (options.timeoutMs !== undefined) args.push('--timeout', String(options.timeoutMs))
    const result = await this.run(args, options.timeoutMs)
    return settleFrom(result, target)
  }

  /** `herdr agent wait <target>` — block until the agent reaches one of the
   * requested states (default idle/done/blocked) or `timeoutMs` elapses. */
  async wait(target: string, options: { until?: AgentStatus[]; timeoutMs?: number } = {}): Promise<HerdrSettled | null> {
    const args = ['agent', 'wait', target]
    for (const status of options.until ?? []) args.push('--until', status)
    if (options.timeoutMs !== undefined) args.push('--timeout', String(options.timeoutMs))
    const result = await this.run(args, options.timeoutMs)
    return settleFrom(result, target)
  }

  /** Run one herdr CLI invocation and parse its JSON envelope. */
  private run(args: string[], timeoutMs?: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      execFile(
        this.bin,
        [...this.baseArgs, ...args],
        { timeout: timeoutMs ?? this.defaultTimeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            const err = error as CliError
            if (err.code === 'ENOENT') {
              reject(new Error(`herdr CLI not found ('${this.bin}') — install herdr (https://herdr.dev) or point --herdr-bin at it`))
              return
            }
            // herdr exits non-zero for expected failures (unknown target,
            // stalled wait) while still printing a JSON error envelope (on
            // stderr on Windows, stdout elsewhere) — surface its code and
            // message instead of a bare failure.
            const payload = (stdout || stderr || '') as string
            let envelope: { error?: { code?: string; message?: string } } | null = null
            try {
              envelope = JSON.parse(payload) as { error?: { code?: string; message?: string } }
            } catch {
              // fall through
            }
            if (envelope !== null && typeof envelope === 'object' && envelope.error !== undefined) {
              reject(new Error(`${envelope.error.code ?? 'herdr error'}: ${envelope.error.message ?? 'unknown error'}`))
              return
            }
            const hint = payload.trim() !== '' ? ` — ${payload.trim().slice(0, 200)}` : ''
            reject(new Error(`herdr ${args.slice(0, 2).join(' ')} failed${hint}`))
            return
          }
          let parsed: { result?: unknown; error?: { code?: string; message?: string } } | null = null
          try {
            parsed = JSON.parse(stdout) as { result?: unknown; error?: { code?: string; message?: string } }
          } catch {
            // fall through
          }
          if (parsed === null || typeof parsed !== 'object') {
            reject(new Error(`herdr returned non-JSON output: ${stdout.slice(0, 200)}`))
            return
          }
          if (parsed.error !== undefined) {
            reject(new Error(`${parsed.error.code ?? 'herdr error'}: ${parsed.error.message ?? 'unknown error'}`))
            return
          }
          resolve(parsed.result)
        },
      )
    })
  }
}

/** Reduce one raw AgentInfo object; unknown fields are dropped, never
 * undefined — lossless-JSON safe. */
function toAgent(raw: Record<string, unknown>): HerdrAgent {
  const status = raw.agent_status as string
  return {
    paneId: String(raw.pane_id ?? ''),
    tabId: raw.tab_id === undefined ? '' : String(raw.tab_id),
    terminalId: raw.terminal_id === undefined ? '' : String(raw.terminal_id),
    name: raw.name === undefined ? null : String(raw.name),
    agent: raw.agent === undefined ? null : String(raw.agent),
    displayAgent: raw.display_agent === undefined ? null : String(raw.display_agent),
    status: AGENT_STATUSES.includes(status as AgentStatus) ? (status as AgentStatus) : 'unknown',
    cwd: raw.cwd === undefined ? null : String(raw.cwd),
    focused: raw.focused === true,
    interactiveReady: raw.interactive_ready === true,
    launchPending: raw.launch_pending === true,
    terminalTitle: raw.terminal_title === undefined ? null : String(raw.terminal_title),
    revision: Number(raw.revision ?? 0),
  }
}

/** Extract a settled status from wait/prompt results. herdr's CLI returns
 * different envelopes depending on version; accept the shapes we know
 * (wait_matched event, agent object, or a bare status string) and fall back
 * to null — the raw result is already lossless JSON for callers that need
 * more detail. */
function settleFrom(result: unknown, target: string): HerdrSettled | null {
  if (result === null || typeof result !== 'object') return null
  const obj = result as Record<string, unknown>
  const event = obj.event as Record<string, unknown> | undefined
  const status = (event?.agent_status ?? obj.agent_status ?? obj.status) as string | undefined
  if (AGENT_STATUSES.includes(status as AgentStatus)) {
    return {
      paneId: String(event?.pane_id ?? obj.pane_id ?? target),
      status: status as AgentStatus,
      waitedMs: Number(obj.waited_ms ?? null) || null,
    }
  }
  return null
}
