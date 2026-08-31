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
import { addToken, removeToken, readTokens, generateToken } from './auth.js'

/** The set of string-typed flags parsed by parseArgs (the auth branch uses it to filter positionals). */
const STRING_FLAGS = new Set(['--host', '--path', '--url', '--server-name', '--agent', '--herdr-bin', '--manager-peers', '--state-file', '--auth-tokens', '--db', '--file', '--role', '--owner', '--token'])
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Default roster persistence file (the CLI opts in; programmatic use of
 * startHub stays in-memory unless stateFile is passed). */
const DEFAULT_STATE_FILE = join(homedir(), '.agent-comm-hub', 'roster.json')

/** Default SQLite state DB (history, mailboxes, profiles, groups). */
const DEFAULT_DB = join(homedir(), '.agent-comm-hub', 'state.db')

/** Default bearer-token table for remote mode. */
const DEFAULT_AUTH_FILE = join(homedir(), '.agent-comm-hub', 'tokens.json')

interface CliArgs {
  [key: string]: number | string | boolean
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {}
  const numeric = new Set(['--port', '--max-queue', '--history-limit', '--wait-timeout-ms', '--default-wait-ms', '--connected-window-ms', '--peer-idle-timeout-ms', '--herdr-timeout-ms'])
  const string = new Set(['--host', '--path', '--url', '--server-name', '--agent', '--herdr-bin', '--manager-peers', '--state-file', '--auth-tokens', '--db', '--file', '--role', '--owner', '--token'])
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--help' || flag === '-h' || flag === '--version' || flag === '-V') {
      args[flag] = true
      continue
    }
    if (flag === '--remove' || flag === '--dry-run' || flag === '--reveal' || flag === '--allow-join') {
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
  agent-comm-hub auth add <peer> [flags] manage the remote-mode token table
  agent-comm-hub auth remove <peer>      (add prints the generated token ONCE)
  agent-comm-hub auth list [--reveal]
  agent-comm-hub auth gen                print a fresh random token

Hub options:
  --host <addr>            Bind address (default 127.0.0.1)
  --port <n>               Listen port (default 18764)
  --path <p>               MCP endpoint path (default /mcp)
  --max-queue <n>          Queued messages per peer before dropping oldest (default 200)
  --history-limit <n>      Retained history messages (default 1000)
  --wait-timeout-ms <n>    Long-poll ceiling for bridge_wait (default 60000)
  --default-wait-ms <n>    bridge_wait default budget (default 30000)
  --connected-window-ms <n>  Peer counts as active within this window (default 30000)
  --peer-idle-timeout-ms <n> Auto-unregister idle peers after this; 0 disables (default 600000)
  --herdr-bin <path>         herdr CLI binary for bridge_agent_* control tools
                             (default herdr, resolved via PATH)
  --herdr-timeout-ms <n>     Default cap for one herdr call in ms (default 30000)
  --manager-peers <ids>      Comma-separated peer ids allowed to manage the
                             roster (rename others / kick), or "all".
                             (default agent-hub-cli — the desktop GUI identity)
  --state-file <path>        Persist the peer roster (aliases, client info) to
                             this JSON file so identities survive restarts
                             (default ~/.agent-comm-hub/roster.json; "off"
                             keeps everything in memory)
  --auth-tokens <file>       REMOTE MODE: require "Authorization: Bearer <token>"
                             on every MCP request; each token maps to a fixed
                             peer id + role (agent|manager). See server/README.md
                             for the token table format and deployment recipes.
  --db <path>                REMOTE MODE: SQLite state DB persisting history,
                             mailboxes, profiles and groups across restarts
                             (default ~/.agent-comm-hub/state.db; "off" = memory)

Auth options (agent-comm-hub auth <action>):
  --file <path>              Token table to manage
                             (default ~/.agent-comm-hub/tokens.json)
  --role <r>                 auth add: agent | manager (default agent)
  --owner <name>             auth add: optional owner label
  --token <t>                auth add: supply your own token instead of
                             generating one (16-128 chars [A-Za-z0-9._:-])
  --allow-join               Start the hub in allow-join mode: agents without
                             a token may connect (LAN/VPN only; keep OFF on
                             the public internet). Each gets a unique peer id
                             + source IP shown in the admin roster for you to
                             claim (rename) or issue a token to.
  --reveal                   auth list: include the plaintext tokens

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
        const label = peer.alias !== undefined && peer.alias !== peer.id ? `${peer.id} (${peer.alias})` : peer.id
        console.log(`  ${label.padEnd(32)} ${peer.connected ? 'connected' : 'offline'}`)
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

  if (command === 'auth') {
    const [action, ...authRest] = rest
    // parseArgs has no positional args: pull <peer> out first, then hand the remaining flag pairs to it.
    const splitArgs = (args: string[]): { positional: string[]; flags: string[] } => {
      const positional: string[] = []
      const flags: string[] = []
      for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith('--')) {
          flags.push(args[i])
          if (STRING_FLAGS.has(args[i]) && args[i + 1] !== undefined && !args[i + 1].startsWith('--')) flags.push(args[++i])
        } else positional.push(args[i])
      }
      return { positional, flags }
    }
    const file = (): string => {
      const { flags } = splitArgs(authRest)
      return (parseArgs(flags)['--file'] as string | undefined) ?? DEFAULT_AUTH_FILE
    }
    if (action === 'add') {
      const { positional, flags } = splitArgs(authRest)
      const args = parseArgs(flags)
      const peerId = positional[0]
      if (peerId === undefined) {
        console.error('auth add: missing <peer> — usage: agent-comm-hub auth add <peer> [--role agent|manager] [--owner name]')
        process.exit(1)
      }
      const role = (args['--role'] as string | undefined) ?? 'agent'
      if (role !== 'agent' && role !== 'manager') {
        console.error(`auth add: invalid role '${role}' (expected agent | manager)`)
        process.exit(1)
      }
      const row = addToken(file(), {
        peer: peerId,
        role,
        owner: args['--owner'] as string | undefined,
        token: args['--token'] as string | undefined,
      })
      console.log(`token created for ${peerId}${row.owner ? ` (${row.owner})` : ''} [${row.role}]`)
      console.log(`  ${row.token}`)
      console.log('The MCP config to pass to that agent (Authorization header) — not echoed here;')
      console.log(`Table written to ${file()} (hub hot-reloads; takes effect in ~2s)`)
      process.exit(0)
    }
    if (action === 'remove') {
      const peerId = splitArgs(authRest).positional[0]
      if (peerId === undefined) {
        console.error('auth remove: missing <peer>')
        process.exit(1)
      }
      console.log(removeToken(file(), peerId) ? `removed peer ${peerId}` : `peer ${peerId} not found`)
      process.exit(0)
    }
    if (action === 'list') {
      const args = parseArgs(splitArgs(authRest).flags)
      const reveal = args['--reveal'] === true
      const rows = readTokens(file())
      if (rows.length === 0) {
        console.log('token table is empty — add one with: agent-comm-hub auth add <peer>')
      }
      for (const row of rows) {
        const t = reveal ? row.token : row.token.slice(0, 6) + '…' + row.token.slice(-4)
        console.log(`${row.peer.padEnd(24)} ${row.role.padEnd(8)} ${row.owner ?? ''}  ${t}`)
      }
      process.exit(0)
    }
    if (action === 'gen') {
      console.log(generateToken())
      process.exit(0)
    }
    console.error(`auth: unknown action '${action ?? ''}' (expected add | remove | list | gen)`)
    process.exit(1)
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
    managerPeers: args['--manager-peers'] === undefined
      ? undefined
      : args['--manager-peers'] === 'all'
        ? 'all'
        : String(args['--manager-peers']).split(',').map(id => id.trim()).filter(id => id !== ''),
    stateFile: args['--state-file'] === undefined
      ? DEFAULT_STATE_FILE
      : args['--state-file'] === 'off'
        ? undefined
        : String(args['--state-file']),
    authTokens: args['--auth-tokens'] === undefined ? undefined : String(args['--auth-tokens']),
    allowJoin: args['--allow-join'] === true,
    db: args['--db'] === undefined ? DEFAULT_DB : args['--db'] === 'off' ? undefined : String(args['--db']),
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
