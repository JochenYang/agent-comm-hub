/**
 * Runners: how a task gets EXECUTED when nobody is waiting for it.
 *
 * The hub is a post office. Normally a task sits in the assignee's mailbox until
 * that agent calls `bridge_wait` — which is fine for an agent that is looping,
 * and useless for one that is not: the task waits forever and the sender's
 * `bridge_wait { ref }` never resolves. A runner is the hub's answer. For a peer
 * whose configuration declares one, a task that lands in the mailbox with no
 * live waiter is handed to that runner, and the runner's outcome is written back
 * as the peer's own ack.
 *
 * Two implementations ship here, both with zero runtime dependencies:
 *  - `cli`   — `execFile` a binary once (`codex exec '<prompt>'`, `claude -p …`)
 *  - `herdr` — type the prompt into that peer's terminal pane, wait, read back
 *
 * **Security.** A runner executes whatever its configuration says, on this
 * machine, as this user. Nothing runs unless the operator configured it
 * (`--runner` / `HubConfig.runners`), the same posture as the herdr control
 * tools. A task's `prompt` is attacker-influenced text by nature — it is passed
 * as ONE argv entry (never through a shell), so it cannot become a command.
 */
import { execFile } from 'node:child_process'
import type { HerdrCtl } from './herdr-ctl.js'

/** What a runner is asked to do. */
export interface RunRequest {
  /** Task message id — becomes the ack's `ref`. */
  taskId: string
  /** The peer the task was assigned to; the runner acts on its behalf. */
  peer: string
  prompt: string
  context?: string
  deliverable?: string
  threadId?: string
}

/** What a runner reports back. `note` becomes the ack's note (and is capped). */
export interface RunResult {
  status: 'done' | 'failed'
  note: string
}

export interface Runner {
  readonly name: string
  run(request: RunRequest): Promise<RunResult>
}

/** One peer's executor declaration. */
export interface RunnerConfig {
  /** Peer id this entry applies to (the task's assignee). */
  peer: string
  kind: 'cli' | 'herdr'
  /** `cli`: the binary to run. */
  command?: string
  /** `cli`: argv. `{prompt}`, `{context}`, `{deliverable}` and `{taskId}` are
   *  substituted; each argument is passed verbatim (no shell), so a prompt with
   *  spaces or quotes stays one argument and cannot inject a command. */
  args?: string[]
  /** `herdr`: the pane id or agent name to type into (default: the peer id). */
  target?: string
  /** Cap for one run, ms (default {@link DEFAULT_RUN_TIMEOUT_MS}). */
  timeoutMs?: number
}

export const DEFAULT_RUN_TIMEOUT_MS = 120_000

/** Cap on the text written into the ack note: an ack is a ledger entry, not a
 *  log sink, and an unbounded runner output would bloat the ledger and every
 *  `bridge_tasks` result. */
export const MAX_RUN_NOTE_CHARS = 4_000

export function validateRunnerConfig(config: RunnerConfig, index: number): void {
  const where = `runners[${index}]`
  if (typeof config.peer !== 'string' || config.peer === '') throw new Error(`${where}: peer must be a non-empty string`)
  if (config.kind !== 'cli' && config.kind !== 'herdr') throw new Error(`${where}: kind must be 'cli' or 'herdr'`)
  if (config.kind === 'cli') {
    if (typeof config.command !== 'string' || config.command === '') throw new Error(`${where}: cli needs a command`)
    if (config.args !== undefined && (!Array.isArray(config.args) || config.args.some(arg => typeof arg !== 'string'))) {
      throw new Error(`${where}: args must be an array of strings`)
    }
  }
  if (config.timeoutMs !== undefined && (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0)) {
    throw new Error(`${where}: timeoutMs must be a positive number`)
  }
}

const truncate = (text: string): string =>
  text.length > MAX_RUN_NOTE_CHARS ? `${text.slice(0, MAX_RUN_NOTE_CHARS)}… (truncated)` : text

/** Replace `{prompt}`-style placeholders in ONE argv entry. Uses a callback so
 *  a prompt containing `$&` or `$1` is inserted literally, never re-expanded. */
function substitute(arg: string, request: RunRequest): string {
  const values: Record<string, string | undefined> = {
    prompt: request.prompt,
    context: request.context,
    deliverable: request.deliverable,
    taskId: request.taskId,
    peer: request.peer,
  }
  return arg.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole)
}

/** `cli` runner: run the binary once and use its output as the result. */
function cliRunner(config: RunnerConfig): Runner {
  const command = config.command!
  const args = config.args ?? []
  const timeout = config.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS
  return {
    name: `cli:${command}`,
    run: (request) =>
      new Promise<RunResult>((resolve) => {
        execFile(
          command,
          args.map(arg => substitute(arg, request)),
          // No shell, a bounded buffer, and a hard timeout: a hung runner must
          // not hold the task open forever.
          { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
          (error, stdout, stderr) => {
            const out = stdout.trim()
            if (error !== null) {
              const detail = stderr.trim() !== '' ? stderr.trim() : (error as Error).message
              resolve({ status: 'failed', note: truncate(`runner failed: ${detail}${out !== '' ? `\n${out}` : ''}`) })
              return
            }
            resolve({ status: 'done', note: truncate(out === '' ? '(runner produced no output)' : out) })
          },
        )
      }),
  }
}

/** `herdr` runner: type the prompt into the peer's pane and read the reply. */
function herdrRunner(config: RunnerConfig, ctl: HerdrCtl): Runner {
  const target = config.target ?? config.peer
  const timeout = config.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS
  return {
    name: `herdr:${target}`,
    run: async (request) => {
      try {
        const text = [request.prompt, request.context].filter(part => part !== undefined && part !== '').join('\n\n')
        await ctl.promptSmart(target, text, { wait: true, timeoutMs: timeout })
        const read = await ctl.readSmart(target, { lines: 200 })
        return { status: 'done', note: truncate(read.text.trim() === '' ? '(no output read back)' : read.text) }
      } catch (error) {
        return { status: 'failed', note: truncate(`herdr runner failed: ${(error as Error).message}`) }
      }
    },
  }
}

export interface RunnerDeps {
  /** Required for `kind: 'herdr'`; the caller supplies an enabled HerdrCtl. */
  herdr?: HerdrCtl
}

/** Build the runner for one config entry. Throws when the entry names a runner
 *  this build cannot provide — a configuration error must be loud at startup,
 *  not silently downgrade a task to a mailbox that nobody reads. */
export function createRunner(config: RunnerConfig, deps: RunnerDeps = {}): Runner {
  if (config.kind === 'cli') return cliRunner(config)
  if (deps.herdr === undefined) throw new Error(`runner for '${config.peer}': kind 'herdr' needs herdr to be enabled`)
  return herdrRunner(config, deps.herdr)
}

/** Look up the runner for `peer`, if any. Built once at startup. */
export class RunnerRegistry {
  private readonly runners = new Map<string, Runner>()

  constructor(configs: readonly RunnerConfig[] = [], deps: RunnerDeps = {}) {
    configs.forEach((config, index) => {
      validateRunnerConfig(config, index)
      this.runners.set(config.peer, createRunner(config, deps))
    })
  }

  get(peer: string): Runner | undefined {
    return this.runners.get(peer)
  }

  /** Peer ids that have a runner (for startup logging). */
  peers(): string[] {
    return [...this.runners.keys()]
  }

  get size(): number {
    return this.runners.size
  }
}
