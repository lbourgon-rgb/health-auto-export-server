# Fast vitals rollup runner.
# Loads local/user env, runs the vitals-only health rollup, then enriches the
# same day with the body-battery summary. Logs stay under ignored seed_data.

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
$logPath = Join-Path $LogDir "fast-vitals-sync-$stamp.log"

$vitalsArgs = @("tools\health-backfill\vitals-fast-sync.js")
$summaryArgs = @("tools\health-backfill\daily-summary.js")
if ($DryRun) {
    $vitalsArgs += "--dry-run"
    $summaryArgs += "--dry-run"
}

Write-Host "Velastra Fast Vitals Sync"
Write-Host "  Mode: $(if ($DryRun) { 'dry-run' } else { 'live rollup' })"
Write-Host "  Log: $logPath"

& node @vitalsArgs 2>&1 | Tee-Object -FilePath $logPath
$vitalsExit = $LASTEXITCODE
if ($vitalsExit -ne 0) { exit $vitalsExit }

& node @summaryArgs 2>&1 | Tee-Object -FilePath $logPath -Append
exit $LASTEXITCODE
