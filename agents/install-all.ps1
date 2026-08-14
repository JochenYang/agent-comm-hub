<#
.SYNOPSIS
Sync the agent-comm-hub MCP entry into every installed agent's own config —
incrementally. Only the "agent-hub" server key is added/updated; all other
content is preserved byte-for-byte semantically, each file is backed up first,
and re-running is a no-op. -Remove undoes everything.

Covered agents (auto-skipped when not installed):
  - MiniMax Code (mcode)   ~/.minimax/mcp.json + ~/.minimax/mcp/mcp.json
  - opencode               ~/.config/opencode/opencode.json
  - Kimi Code              ~/.kimi-code/mcp.json
  - Gemini CLI             ~/.gemini/settings.json
  - Codex                  ~/.codex/config.toml (appends the section if missing)
  - zcode                  ~/.zcode/cli/config.json (mcp.servers)

Not covered (manual, documented in agents/README.md):
  - Claude Code  -> project-level .mcp.json (copy agents/claude-code/.mcp.json)
                   (~/.claude.json is not touched: it carries credentials and
                   cannot be round-tripped safely)
  - DSH          -> merge agents/dsh/cordis.patch.yml into the profile patch

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
$userHome = $env:USERPROFILE
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$skillSrc = Join-Path $PSScriptRoot 'SKILL.md'

function Write-Step($text) { Write-Host "[agent-comm-hub] $text" -ForegroundColor Cyan }

function Read-Json($path) {
  if (-not (Test-Path $path)) { return $null }
  try { return [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8) | ConvertFrom-Json }
  catch { throw "cannot parse JSON: $path ($($_.Exception.Message))" }
}

function Write-JsonNoBom($path, $value) {
  $dir = Split-Path $path
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  [System.IO.File]::WriteAllText($path, ($value | ConvertTo-Json -Depth 50), $utf8NoBom)
}

function Backup($path) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  Copy-Item $path "$path.bak-$stamp" -Force -ErrorAction SilentlyContinue
  return "$(Split-Path $path -Leaf).bak-$stamp"
}

function Sync-Skill($agentName, $skillDir) {
  if ($Remove) {
    if (Test-Path $skillDir) { Remove-Item $skillDir -Recurse -Force; Write-Step "  ${agentName}: removed skill $skillDir" }
    return
  }
  if (-not (Test-Path $skillSrc)) { Write-Step "  ${agentName}: SKILL.md source missing (skipped)"; return }
  New-Item -ItemType Directory -Path $skillDir -Force | Out-Null
  Copy-Item $skillSrc (Join-Path $skillDir 'SKILL.md') -Force
  Write-Step "  ${agentName}: skill -> $skillDir\SKILL.md"
}

function Merge-JsonServer($label, $file, $sectionName, $entry) {
  if (-not (Test-Path $file)) { Write-Step "  ${label}: not installed ($file missing, skipped)"; return }
  try {
    $doc = Read-Json $file
    if ($null -eq $doc) { Write-Step "  ${label}: empty config (skipped)"; return }
    # Resolve (creating when missing) a dotted section path like 'mcp.servers'.
    $servers = $doc
    foreach ($part in $sectionName.Split('.')) {
      if ($null -eq $servers.$part) {
        $servers | Add-Member -NotePropertyName $part -NotePropertyValue ([ordered]@{}) -Force
      }
      $servers = $servers.$part
    }
    $changed = $false
    if ($servers.PSObject.Properties.Name -contains $ServerName) {
      $existing = $servers.$ServerName
      $changed = ($existing.url -ne ${Url})
    } else {
      $changed = $true
    }
    if ($Remove) {
      if ($servers.PSObject.Properties.Name -contains $ServerName) {
        $servers.PSObject.Properties.Remove($ServerName)
        $bak = Backup $file
        Write-JsonNoBom $file $doc
        Write-Step "  ${label}: removed '$ServerName' from $file (backup: $bak)"
      } else {
        Write-Step "  ${label}: '$ServerName' not present in $file"
      }
      return
    }
    if (-not $changed) { Write-Step "  ${label}: '$ServerName' already set -> ${Url} ($file unchanged)"; return }
    $bak = Backup $file
    $servers | Add-Member -NotePropertyName $ServerName -NotePropertyValue $entry -Force
    Write-JsonNoBom $file $doc
    Write-Step "  ${label}: merged '$ServerName' -> ${Url} into $file (backup: $bak)"
  } catch {
    Write-Step "  ${label}: SKIPPED — $($_.Exception.Message)"
  }
}

if ($Remove) { Write-Step 'uninstalling from all agents...' } else { Write-Step "syncing '$ServerName' -> $Url to all agents..." }

# ---------- MiniMax Code (mcode): mcpServers at root of ~/.minimax/mcp.json + ~/.minimax/mcp/mcp.json
$mcodeEntry = [ordered]@{
  url = $Url; type = 'streamable-http'; enabled = $true; configured = $true; timeout = 120000
  description = 'agent-comm-hub: talk to every other agent connected to the hub (bridge_register auto, bridge_chat/task/ack/wait/poll/status/peers/history).'
}
Write-Step '- mcode'
foreach ($f in @((Join-Path $userHome '.minimax\mcp.json'), (Join-Path $userHome '.minimax\mcp\mcp.json'))) {
  Merge-JsonServer 'mcode' $f 'mcpServers' $mcodeEntry
}
Sync-Skill 'mcode' (Join-Path $userHome '.minimax\skills\agent-comm-hub')

# ---------- opencode: mcp.<name> in ~/.config/opencode/opencode.json
$opencodeEntry = [ordered]@{ type = 'remote'; url = $Url; enabled = $true }
Write-Step '- opencode'
Merge-JsonServer 'opencode' (Join-Path $userHome '.config\opencode\opencode.json') 'mcp' $opencodeEntry
Sync-Skill 'opencode' (Join-Path $userHome '.config\opencode\skills\agent-comm-hub')

# ---------- Kimi Code: mcpServers at root of ~/.kimi-code/mcp.json
$kimiEntry = [ordered]@{ transport = 'http'; url = $Url; startupTimeoutMs = 30000; toolTimeoutMs = 120000 }
Write-Step '- kimi-code'
Merge-JsonServer 'kimi-code' (Join-Path $userHome '.kimi-code\mcp.json') 'mcpServers' $kimiEntry
Sync-Skill 'kimi-code' (Join-Path $userHome '.kimi-code\skills\agent-comm-hub')

# ---------- Gemini CLI: mcpServers in ~/.gemini/settings.json
$geminiEntry = [ordered]@{ type = 'http'; url = $Url }
Write-Step '- gemini-cli'
Merge-JsonServer 'gemini-cli' (Join-Path $userHome '.gemini\settings.json') 'mcpServers' $geminiEntry
Sync-Skill 'gemini-cli' (Join-Path $userHome '.gemini\skills\agent-comm-hub')

# ---------- Codex: append [mcp_servers.<name>] to ~/.codex/config.toml (incremental append only)
$codexFile = Join-Path $userHome '.codex\config.toml'
Write-Step '- codex'
if (Test-Path $codexFile) {
  $codexText = [System.IO.File]::ReadAllText($codexFile, [System.Text.Encoding]::UTF8)
  $section = "[mcp_servers.$ServerName]"
  if ($Remove) {
    if ($codexText -match "(?m)^\[mcp_servers\.$([regex]::Escape($ServerName))\]") {
      $bak = Backup $codexFile
      $clean = [regex]::Replace($codexText, "(?m)^\[mcp_servers\.$([regex]::Escape($ServerName))\][^\r\n]*(\r?\n(?!\[).*)*(\r?\n)?", '')
      [System.IO.File]::WriteAllText($codexFile, $clean, $utf8NoBom)
      Write-Step "  codex: removed '$ServerName' section from $codexFile (backup: $bak)"
    } else {
      Write-Step "  codex: '$ServerName' section not present in $codexFile"
    }
  } elseif ($codexText -match "(?m)^\[mcp_servers\.$([regex]::Escape($ServerName))\]") {
    Write-Step "  codex: '$ServerName' section already present ($codexFile unchanged)"
  } else {
    $bak = Backup $codexFile
    $block = "`n[mcp_servers.$ServerName]`ntype = `"streamable-http`"`nurl = `"$Url`"`n"
    [System.IO.File]::WriteAllText($codexFile, $codexText.TrimEnd() + $block, $utf8NoBom)
    Write-Step "  codex: appended '$ServerName' section to $codexFile (backup: $bak)"
  }
} else {
  Write-Step "  codex: not installed ($codexFile missing, skipped)"
}

# ---------- zcode: mcp.servers in ~/.zcode/cli/config.json
$zcodeEntry = [ordered]@{ enabled = $true; type = 'remote'; url = $Url }
Write-Step '- zcode'
Merge-JsonServer 'zcode' (Join-Path $userHome '.zcode\cli\config.json') 'mcp.servers' $zcodeEntry
Sync-Skill 'zcode' (Join-Path $userHome ".zcode\skills\$ServerName")

# ---------- skills: cross-agent standard location + each agent's private dir
$skillDirs = @(
  (Join-Path $userHome ".agents\skills\$ServerName"),   # cross-agent standard
  (Join-Path $userHome ".minimax\skills\$ServerName"),
  (Join-Path $userHome ".config\opencode\skills\$ServerName"),
  (Join-Path $userHome ".kimi-code\skills\$ServerName"),
  (Join-Path $userHome ".gemini\skills\$ServerName"),
  (Join-Path $userHome ".codex\skills\$ServerName"),
  (Join-Path $userHome ".zcode\skills\$ServerName"),
  (Join-Path $userHome ".claude\skills\$ServerName")    # config is manual; skill still useful
)
foreach ($dir in $skillDirs) { Sync-Skill 'skill' $dir }

Write-Step 'done. Manual targets (see agents/README.md): Claude Code (project .mcp.json), DSH (cordis.patch.yml).'
Write-Step 'Restart agent sessions to pick up the new MCP server.'
