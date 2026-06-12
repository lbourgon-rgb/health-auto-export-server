# Velastra Stability Radar runner.
# Loads optional local alert env, runs the lightweight radar, and writes logs under
# ignored seed_data so Task Scheduler failures are visible without touching git.

param(
    [switch]$Live,
    [switch]$ForceAlert,
    [int]$YellowCooldownHours = 8,
    [int]$RedCooldownHours = 8,
    [string]$StateFile = "",
    [string]$LogDir = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = $PSScriptRoot
Set-Location $RepoRoot

function Import-DotEnvFile {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return }

    Get-Content -LiteralPath $Path | ForEach-Object {
        $line = $_.Trim()
        if (-not $line -or $line.StartsWith("#")) { return }
        $idx = $line.IndexOf("=")
        if ($idx -lt 1) { return }
        $name = $line.Substring(0, $idx).Trim()
        $value = $line.Substring($idx + 1).Trim().Trim('"').Trim("'")
        if ($name -match '^[A-Za-z_][A-Za-z0-9_]*$') {
            [Environment]::SetEnvironmentVariable($name, $value, "Process")
        }
    }
}

Import-DotEnvFile (Join-Path $RepoRoot ".env.radar.local")

if (-not $StateFile) {
    $StateFile = Join-Path $RepoRoot "seed_data\stability-radar-state.json"
}
if (-not $LogDir) {
    $LogDir = Join-Path $RepoRoot "seed_data\logs"
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logPath = Join-Path $LogDir "stability-radar-$stamp.log"

$nodeArgs = @(
    "tools\health-backfill\stability-radar.js",
    "--state-file", $StateFile,
    "--yellow-cooldown-hours", $YellowCooldownHours,
    "--red-cooldown-hours", $RedCooldownHours
)

if ($ForceAlert) { $nodeArgs += "--force-alert" }
if ($Live) {
    $nodeArgs += @("--allow-live", "--trigger-resonance")
} else {
    $nodeArgs += "--dry-run"
}

Write-Host "Velastra Stability Radar runner"
Write-Host "  Mode: $(if ($Live) { 'live trigger enabled' } else { 'dry-run' })"
Write-Host "  State: $StateFile"
Write-Host "  Log: $logPath"

& node @nodeArgs 2>&1 | Tee-Object -FilePath $logPath
exit $LASTEXITCODE
