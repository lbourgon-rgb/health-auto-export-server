# Registers the lightweight Axiom stability watcher.
# This intentionally stays separate from HealthAutoExport-VelastrahQ-Sync.

param(
    [int]$EveryMinutes = 15,
    [string]$TaskName = "Velastra-Axiom-Stability-Radar",
    [switch]$DryRunTask,
    [switch]$AllowMissingResonanceConfig
)

$ErrorActionPreference = "Stop"
$RepoRoot = $PSScriptRoot
$Runner = Join-Path $RepoRoot "run-stability-radar.ps1"
if (-not (Test-Path -LiteralPath $Runner)) {
    throw "Runner not found: $Runner"
}

function Test-RadarEnvFile {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    $text = Get-Content -LiteralPath $Path -Raw
    return ($text -match '(?m)^DISCORD_RESONANCE_URL=.+') -and ($text -match '(?m)^DISCORD_RESONANCE_TOKEN=.+')
}

if (-not $DryRunTask -and -not $AllowMissingResonanceConfig) {
    $hasUserEnv = [bool]([Environment]::GetEnvironmentVariable("DISCORD_RESONANCE_URL", "User")) -and [bool]([Environment]::GetEnvironmentVariable("DISCORD_RESONANCE_TOKEN", "User"))
    $hasLocalEnv = Test-RadarEnvFile (Join-Path $RepoRoot ".env.radar.local")
    if (-not ($hasUserEnv -or $hasLocalEnv)) {
        throw "Live radar task needs DISCORD_RESONANCE_URL and DISCORD_RESONANCE_TOKEN in user env or ignored .env.radar.local. Use -DryRunTask for a non-sending smoke task."
    }
}

$modeArg = if ($DryRunTask) { "" } else { " -Live" }
$arguments = "-WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File `"$Runner`"$modeArg"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments -WorkingDirectory $RepoRoot
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "Runs Velastra Stability Radar for Axiom Discord alerts without touching the hourly VelastrahQ sync." -Force | Out-Null

Write-Host "Registered $TaskName"
Write-Host "  Interval: every $EveryMinutes minutes"
Write-Host "  Mode: $(if ($DryRunTask) { 'dry-run' } else { 'live trigger enabled' })"
Write-Host "  Runner: $Runner"
Write-Host "  Disable: Disable-ScheduledTask -TaskName '$TaskName'"
