#!/usr/bin/env node
/**
 * agent-comm-hub CLI.
 *
 *   agent-comm-hub [--port 18764] [--host 127.0.0.1] [--path /mcp] ...   start the hub
 *   agent-comm-hub setup [--url <hub-url>] [--server-name agent-hub]     sync MCP entry
 *                                                          [--remove]    + skill to agents
 */

import { startHub, SERVER_VERSION } from './index.js'
import { runSetup } from './setup.js'
import { runService, runStatus, runUpdate } from './ops.js'
import { runDiscover } from './discover.js'

interface CliArgs {
  [key: string]: number | string | boolean
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {}
  const numeric = new Set(['--port', '--max-queue', '--history-limit', '--wait-timeout-ms', '--default-wait-ms', '--connected-window-ms', '--peer-idle-timeout-ms', '--herdr-timeout-ms'])
  const string = new Set(['--host', '--path', '--url', '--server-name', '--agent', '--herdr-bin'])
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--help' || flag === '-h' || flag === '--version' || flag === '-V') {
      args[flag] = true
      continue
    }
    if (flag === '--remove' || flag === '--dry-run') {
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
  agent-comm-hub [options]                 start the hub
  agent-comm-hub setup [options]           sync the MCP entry + skill into
                                           every installed agent (incremental,
                                           idempotent; --remove undoes)
  agent-comm-hub status [options]          show hub health + online peers
  agent-comm-hub discover                  list installed agents (registry-
                                           driven; no config changes)
  agent-comm-hub service install|uninstall [options]
                                           one-shot auto-start (Windows Run
                                           key + hidden VBS launcher, no admin;
                                           Linux systemd, macOS launchd;
                                           --dry-run prints)
  agent-comm-hub update                  self-update from the npm registry
                                           (files updated in place; restart
                                           the hub afterwards)

Hub options:
  --host <addr>            Bind address (default 127.0.0.1)
  --port <n>               Listen port (default 18764)
  --path <p>               MCP endpoint path (default /mcp)
  --max-queue <n>          Queued messages per peer before dropping oldest (default 200)
  --history-limit <n>      Retained history messages (default 100)
  --wait-timeout-ms <n>    Long-poll ceiling for bridge_wait (default 60000)
  --default-wait-ms <n>    bridge_wait default budget (default 30000)
  --connected-window-ms <n>  Peer counts as active within this window (default 30000)
  --peer-idle-timeout-ms <n> Auto-unregister idle peers after this; 0 disables (default 600000)
  --herdr-bin <path>         herdr CLI binary for bridge_agent_* control tools
                             (default herdr, resolved via PATH)
  --herdr-timeout-ms <n>     Default cap for one herdr call in ms (default 30000)

Setup options:
  --url <url>              Hub endpoint to register (default http://127.0.0.1:18764/mcp)
  --server-name <name>     Config key (default agent-hub)
  --agent <id>             Only configure one registry agent (e.g. codex)
  --remove                 Uninstall instead of install

  -h, --help               Show this help
  -V, --version            Show version

Agents connect via MCP streamable-http at http://<host>:<port><path> and are
auto-registered at connect (client name becomes the peer id).`)
}

const log = {
  info: (message: string) => console.log(message),
  warn: (message: string) => console.warn(message),
}

try {
  const argv = process.argv.slice(2)
  const [command, ...rest] = argv

  if (command === 'setup' || command === 'install') {
    const args = parseArgs(rest)
    if (args['--help'] || args['-h']) {
      printHelp()
      process.exit(0)
    }
    await runSetup({
      url: args['--url'] as string | undefined,
      serverName: args['--server-name'] as string | undefined,
      agent: args['--agent'] as string | undefined,
      remove: args['--remove'] === true,
      log: message => log.info(message),
    })
    process.exit(0)
  }

  if (command === 'discover') {
    runDiscover({ log: message => log.info(message) })
    process.exit(0)
  }

  if (command === 'status') {
    const args = parseArgs(rest)
    const result = await runStatus({
      host: args['--host'] as string | undefined,
      port: args['--port'] as number | undefined,
      path: args['--path'] as string | undefined,
      url: args['--url'] as string | undefined,
    })
    if (!result.running) {
      console.error(`hub is not running at ${result.url}${result.error ? ` (${result.error})` : ''}`)
      console.error('start it with: agent-comm-hub')
      process.exit(1)
    }
    console.log(`agent-comm-hub${result.version ? ` v${result.version}` : ''} at ${result.url}`)
    if (result.peers.length === 0) {
      console.log('no peers online yet — start an agent session to see it appear')
    } else {
      for (const peer of result.peers) {
        console.log(`  ${peer.id.padEnd(32)} ${peer.connected ? 'connected' : 'offline'}`)
      }
    }
    process.exit(0)
  }

  if (command === 'service') {
    const [action, ...serviceRest] = rest
    if (action !== 'install' && action !== 'uninstall') {
      console.error(`service: expected 'install' or 'uninstall', got '${action ?? ''}'`)
      process.exit(1)
    }
    const args = parseArgs(serviceRest)
    const result = runService({
      action,
      host: args['--host'] as string | undefined,
      port: args['--port'] as number | undefined,
      path: args['--path'] as string | undefined,
      dryRun: args['--dry-run'] === true,
    })
    for (const message of result.messages) log.info(message)
    if (!result.ok) {
      console.error('service: failed — see messages above')
      process.exit(1)
    }
    process.exit(0)
  }

  if (command === 'update') {
    const args = parseArgs(rest)
    if (args['--help'] || args['-h']) {
      printHelp()
      process.exit(0)
    }
    const result = runUpdate()
    for (const message of result.messages) log.info(message)
    if (!result.ok) {
      console.error('update: failed — see messages above')
      process.exit(1)
    }
    process.exit(0)
  }

  const args = parseArgs(argv)
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
    connectedWindowMs: args['--connected-window-ms'] as number | undefined,
    peerIdleTimeoutMs: args['--peer-idle-timeout-ms'] as number | undefined,
    herdrBin: args['--herdr-bin'] as string | undefined,
    herdrTimeoutMs: args['--herdr-timeout-ms'] as number | undefined,
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
