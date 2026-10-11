<#
.SYNOPSIS
DEPRECATED shim. Use `agent-comm-hub setup` instead.

.DESCRIPTION
This script used to carry its own copy of the agent list and the merge logic.
That copy drifted: it synced the skill into eight fixed directories with no
"is this agent installed?" check, so running it on a machine with two agents
created skill folders for six agents that were not there.

`agent-comm-hub setup` is registry-driven (`agents/registry.json`), only
touches agents that are actually installed, backs every file up, and is
covered by the test suite. It is the supported path.

This file is kept so existing callers keep working: it forwards to that
command with the same three switches. It no longer contains an agent list.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File install-all.ps1
powershell -ExecutionPolicy Bypass -File install-all.ps1 -Remove
#>
param(
  [string]$Url = 'http://127.0.0.1:18764/mcp',
  [string]$ServerName = 'agent-hub',
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'

Write-Warning 'install-all.ps1 is deprecated; use `agent-comm-hub setup` (this forwards to it).'

# Prefer an installed CLI; fall back to this checkout's built bundle.
$cli = Get-Command agent-comm-hub -ErrorAction SilentlyContinue
$setupArgs = @('setup', '--url', $Url, '--server-name', $ServerName)
if ($Remove) { $setupArgs += '--remove' }

if ($cli) {
  & $cli.Source @setupArgs
  exit $LASTEXITCODE
}

$local = Join-Path (Split-Path -Parent $PSScriptRoot) 'lib/cli.js'
if (Test-Path $local) {
  & node $local @setupArgs
  exit $LASTEXITCODE
}

throw "agent-comm-hub is not installed and $local does not exist. Install it (`npm i -g agent-comm-hub`) or run `pnpm run build` in a checkout, then use `agent-comm-hub setup`."
