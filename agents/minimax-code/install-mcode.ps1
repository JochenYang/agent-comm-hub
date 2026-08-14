<#
.SYNOPSIS
Install the agent-comm-hub client into MiniMax Code (mcode): register the hub
MCP endpoint and install the hub skill. Run as the same user that runs mcode.

.DESCRIPTION
Writes the agent-hub MCP server into BOTH config files:
  - ~/.minimax/mcp.json          — read by the mcode CLI runtime (connections)
  - ~/.minimax/mcp/mcp.json      — the MiniMax Code desktop app config
Both are backed up before touching. Files are written as UTF-8 WITHOUT BOM
(Node's JSON.parse rejects a BOM). Idempotent. Use -Remove to uninstall.

The hub must be running first: `npx agent-comm-hub` (default port 18764).

.PARAMETER Url
Hub MCP endpoint URL. Default http://127.0.0.1:18764/mcp.

.PARAMETER ServerName
Key of the mcp.json entries. Default agent-hub.

.PARAMETER Remove
Uninstall: remove the entries and the skill directory.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File install-mcode.ps1
#>
param(
  [string]$Url = 'http://127.0.0.1:18764/mcp',
  [string]$ServerName = 'agent-hub',
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$userHome = $env:USERPROFILE
$minimaxDir = Join-Path $userHome '.minimax'
$mcpTargets = @(
  (Join-Path $minimaxDir 'mcp.json'),
  (Join-Path $minimaxDir 'mcp\mcp.json')
)
$skillDir = Join-Path $minimaxDir 'skills\agent-comm-hub'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Step($text) { Write-Host "[agent-comm-hub] $text" -ForegroundColor Cyan }

function Read-JsonFile($path) {
  if (-not (Test-Path $path)) { return $null }
  try { return [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8) | ConvertFrom-Json }
  catch { return $null }
}

function Write-JsonFile($path, $value) {
  $dir = Split-Path $path
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  [System.IO.File]::WriteAllText($path, ($value | ConvertTo-Json -Depth 20), $utf8NoBom)
}

if (-not (Test-Path $minimaxDir)) {
  throw "mcode config home not found: $minimaxDir — is mcode installed?"
}

$entry = [ordered]@{
  url         = $Url
  type        = 'streamable-http'
  enabled     = $true
  configured  = $true
  timeout     = 120000
  description = 'agent-comm-hub: talk to every other agent connected to the hub. Call bridge_register(peerId) first, then bridge_chat / bridge_task / bridge_ack / bridge_wait / bridge_poll / bridge_status / bridge_peers / bridge_history.'
}

foreach ($mcpFile in $mcpTargets) {
  $mcp = Read-JsonFile $mcpFile
  if ($null -eq $mcp -or $null -eq $mcp.mcpServers) {
    $mcp = [pscustomobject]@{ mcpServers = [ordered]@{} }
  }
  if ($Remove) {
    if ($mcp.mcpServers.PSObject.Properties.Name -contains $ServerName) {
      $mcp.mcpServers.PSObject.Properties.Remove($ServerName)
      $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
      Copy-Item $mcpFile "$mcpFile.bak-$stamp" -Force -ErrorAction SilentlyContinue
      Write-JsonFile $mcpFile $mcp
      Write-Step "removed '$ServerName' from $mcpFile (backup: $(Split-Path $mcpFile -Leaf).bak-$stamp)"
    } else {
      Write-Step "'$ServerName' not present in $mcpFile — nothing to remove"
    }
  } else {
    $changed = $true
    if ($mcp.mcpServers.PSObject.Properties.Name -contains $ServerName) {
      $existing = $mcp.mcpServers.$ServerName
      $changed = ($existing.url -ne $Url) -or (-not $existing.enabled) -or ($existing.description -ne $entry.description)
    }
    if ($changed) {
      $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
      Copy-Item $mcpFile "$mcpFile.bak-$stamp" -Force -ErrorAction SilentlyContinue
      $mcp.mcpServers | Add-Member -NotePropertyName $ServerName -NotePropertyValue $entry -Force
      Write-JsonFile $mcpFile $mcp
      Write-Step "registered '$ServerName' -> $Url in $mcpFile (backup: $(Split-Path $mcpFile -Leaf).bak-$stamp)"
    } else {
      Write-Step "'$ServerName' already registered and enabled in $mcpFile — unchanged"
    }
  }
}

$skillSrc = Join-Path $PSScriptRoot 'SKILL.md'
if ($Remove) {
  if (Test-Path $skillDir) {
    Remove-Item $skillDir -Recurse -Force
    Write-Step "removed skill $skillDir"
  } else {
    Write-Step "skill $skillDir not present — nothing to remove"
  }
} elseif (Test-Path $skillSrc) {
  New-Item -ItemType Directory -Path $skillDir -Force | Out-Null
  Copy-Item $skillSrc (Join-Path $skillDir 'SKILL.md') -Force
  Write-Step "installed skill -> $skillDir\SKILL.md"
}

if (-not $Remove) {
  Write-Step 'done. Restart your mcode session, then verify with:'
  Write-Step '  mcode exec "你有哪些 bridge 工具？先 bridge_register 注册一下"'
  Write-Step 'Make sure the hub is running: npx agent-comm-hub'
}
