# Fast HRV mirror runner.
# Loads local/user env, runs the raw HRV mirror, and writes receipt logs under
# ignored seed_data so Task Scheduler behavior is auditable.

param(
    [switch]$DryRun,
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
        if ($name -match '^[A-Za-z_][A-Za-z0-9_]*$' -and -not [Environment]::GetEnvironmentVariable($name, "Process")) {
            [Environment]::SetEnvironmentVariable($name, $value, "Process")
        }
    }
}

Import-DotEnvFile (Join-Path $RepoRoot ".env")
Import-DotEnvFile (Join-Path $RepoRoot ".env.hrv.local")

if (-not $LogDir) {
    $LogDir = Join-Path $RepoRoot "seed_data\logs"
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logPath = Join-Path $LogDir "fast-hrv-sync-$stamp.log"

$nodeArgs = @("tools\health-backfill\hrv-fast-sync.js")
if ($DryRun) { $nodeArgs += "--dry-run" }

Write-Host "Velastra Fast HRV Sync"
Write-Host "  Mode: $(if ($DryRun) { 'dry-run' } else { 'live mirror' })"
Write-Host "  Log: $logPath"

& node @nodeArgs 2>&1 | Tee-Object -FilePath $logPath
exit $LASTEXITCODE
