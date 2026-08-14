#!/usr/bin/env node
/**
 * agent-comm-hub CLI: start the multi-peer MCP hub.
 *
 *   agent-comm-hub [--port 18764] [--host 127.0.0.1] [--path /mcp]
 *                 [--max-queue 200] [--history-limit 100]
 *                 [--wait-timeout-ms 60000] [--default-wait-ms 30000]
 */

import { startHub, SERVER_VERSION } from './index.js'

interface CliArgs {
  [key: string]: number | string | boolean
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {}
  const numeric = new Set(['--port', '--max-queue', '--history-limit', '--wait-timeout-ms', '--default-wait-ms'])
  const string = new Set(['--host', '--path'])
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--help' || flag === '-h' || flag === '--version' || flag === '-V') {
      args[flag] = true
      continue
    }
    const value = argv[i + 1]
    if (numeric.has(flag)) {
      const parsed = Number(value)
      if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${flag} expects a positive number, got '${value}'`)
      args[flag] = parsed
      i++
    } else if (string.has(flag)) {
      if (value === undefined) throw new Error(`${flag} expects a value`)
      args[flag] = value
      i++
    } else {
      throw new Error(`unknown flag: ${flag}`)
    }
  }
  return args
}

function printHelp(): void {
  console.log(`agent-comm-hub v${SERVER_VERSION} — generic multi-peer MCP hub

Usage:
  agent-comm-hub [options]

Options:
  --host <addr>            Bind address (default 127.0.0.1)
  --port <n>               Listen port (default 18764)
  --path <p>               MCP endpoint path (default /mcp)
  --max-queue <n>          Queued messages per peer before dropping oldest (default 200)
  --history-limit <n>      Retained history messages (default 100)
  --wait-timeout-ms <n>    Long-poll ceiling for bridge_wait (default 60000)
  --default-wait-ms <n>    bridge_wait default budget (default 30000)
  -h, --help               Show this help
  -V, --version            Show version

Agents connect via MCP streamable-http at http://<host>:<port><path> and call
bridge_register first — see agents/ for per-agent config templates.`)
}

const log = {
  info: (message: string) => console.log(message),
  warn: (message: string) => console.warn(message),
}

try {
  const args = parseArgs(process.argv.slice(2))
  if (args['--help'] || args['-h']) {
    printHelp()
    process.exit(0)
  }
  if (args['--version'] || args['-V']) {
    console.log(SERVER_VERSION)
    process.exit(0)
  }
  const hub = startHub({
    host: args['--host'] as string | undefined,
    port: args['--port'] as number | undefined,
    path: args['--path'] as string | undefined,
    maxQueue: args['--max-queue'] as number | undefined,
    historyLimit: args['--history-limit'] as number | undefined,
    waitTimeoutMs: args['--wait-timeout-ms'] as number | undefined,
    defaultWaitMs: args['--default-wait-ms'] as number | undefined,
  }, log)
  const shutdown = (): void => {
    log.info('agent-comm-hub shutting down')
    hub.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
} catch (error) {
  console.error(`agent-comm-hub: ${(error as Error).message}`)
  process.exit(1)
}
