#!/usr/bin/env node
/**
 * Fake herdr CLI for the test suite. Mirrors the envelope the real
 * `herdr agent <sub>` prints — `{"id":"cli:agent:<sub>","result":{...}}` or
 * `{"id":...,"error":{code,message}}` — so the HerdrCtl adapter can be
 * exercised without a herdr server.
 *
 * Fixture data and call recording come from the environment:
 *   FAKE_HERDR_AGENTS  JSON array of AgentInfo objects (defaults to two)
 *   FAKE_HERDR_LOG      JSONL path; every invocation is appended as
 *                       {"sub": "...", "rest": [...]}
 *
 * Usage: node fake-herdr.mjs agent <sub> <args...>
 */

import fs from 'node:fs'

const logPath = process.env.FAKE_HERDR_LOG
const agents = JSON.parse(process.env.FAKE_HERDR_AGENTS ?? 'null') ?? [
  {
    pane_id: 'w1:p1',
    tab_id: 'w1:t1',
    terminal_id: 'term_1',
    name: 'claude',
    agent: 'claude-code',
    display_agent: 'claude-code',
    agent_status: 'idle',
    cwd: 'C:\\projects\\demo',
    focused: false,
    interactive_ready: true,
    launch_pending: false,
    terminal_title: 'claude',
    revision: 3,
  },
  {
    pane_id: 'w1:p2',
    tab_id: 'w1:t1',
    terminal_id: 'term_2',
    name: 'codex',
    agent: 'codex',
    display_agent: 'codex',
    agent_status: 'working',
    cwd: 'C:\\projects\\demo',
    focused: true,
    interactive_ready: false,
    launch_pending: false,
    terminal_title: 'codex',
    revision: 9,
  },
]

const argv = process.argv.slice(2)
if (argv[0] !== 'agent') {
  process.stdout.write(JSON.stringify({ id: 'cli:root', error: { code: 'unknown_command', message: 'fake herdr only implements: agent <sub>' } }) + '\n')
  process.exit(1)
}
const sub = argv[1]
const rest = argv.slice(2)

function log() {
  if (logPath) fs.appendFileSync(logPath, JSON.stringify({ sub, rest }) + '\n')
}
function respond(result) {
  process.stdout.write(JSON.stringify({ id: `cli:agent:${sub}`, result }) + '\n')
  process.exit(0)
}
function fail(code, message) {
  process.stdout.write(JSON.stringify({ id: `cli:agent:${sub}`, error: { code, message } }) + '\n')
  process.exit(1)
}
function findAgent(target) {
  return agents.find(agent => agent.pane_id === target || agent.name === target)
}
function parseFlags(flags) {
  const opts = {}
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]
    if (flag === '--wait') opts.wait = true
    else if (flag === '--until') (opts.until ??= []).push(rest[++i])
    else if (flag === '--timeout') opts.timeout = Number(rest[++i])
    else if (flag === '--source') opts.source = rest[++i]
    else if (flag === '--lines') opts.lines = Number(rest[++i])
    else if (flag === '--format') i++
  }
  return opts
}

log()

switch (sub) {
  case 'list':
    respond({ type: 'agent_list', agents })
    break
  case 'get': {
    const agent = findAgent(rest[0])
    if (!agent) fail('agent_not_found', `agent target ${rest[0]} not found`)
    respond({ type: 'agent_info', agent })
    break
  }
  case 'read': {
    const target = rest[0]
    const agent = findAgent(target)
    if (!agent) fail('agent_not_found', `agent target ${target} not found`)
    const opts = parseFlags()
    respond({
      type: 'agent_read',
      read: {
        pane_id: target,
        tab_id: agent.tab_id,
        workspace_id: 'w1',
        source: opts.source ?? 'recent',
        format: 'text',
        text: `[fake output for ${target}]\nline one\nline two\n`,
        revision: agent.revision + 4,
        truncated: false,
      },
    })
    break
  }
  case 'send-keys': {
    const target = rest[0]
    const agent = findAgent(target)
    if (!agent) fail('agent_not_found', `agent target ${target} not found`)
    respond({ type: 'agent_keys_sent', ok: true, keys: rest.slice(1) })
    break
  }
  case 'prompt': {
    const target = rest[0]
    const text = rest[1]
    const agent = findAgent(target)
    if (!agent) fail('agent_not_found', `agent target ${target} not found`)
    const opts = parseFlags()
    // Special fixture behavior: a prompt of "STALL" simulates herdr's
    // agent_prompt_stalled error when --wait was requested.
    if (opts.wait && text === 'STALL') fail('agent_prompt_stalled', 'agent did not change state within 5000ms')
    if (opts.wait) {
      respond({
        type: 'wait_matched',
        event: {
          pane_id: agent.pane_id,
          agent: agent.agent,
          agent_status: opts.until?.length ? opts.until[0] : agent.agent_status,
        },
        waited_ms: 42,
      })
    } else {
      respond({ type: 'agent_prompted', agent, prompt: text })
    }
    break
  }
  case 'wait': {
    const target = rest[0]
    const agent = findAgent(target)
    if (!agent) fail('agent_not_found', `agent target ${target} not found`)
    const opts = parseFlags()
    respond({
      type: 'wait_matched',
      event: {
        pane_id: agent.pane_id,
        agent: agent.agent,
        agent_status: opts.until?.length ? opts.until[0] : agent.agent_status,
      },
      waited_ms: 12,
    })
    break
  }
  default:
    fail('unknown_subcommand', `unknown agent subcommand: ${sub}`)
}
