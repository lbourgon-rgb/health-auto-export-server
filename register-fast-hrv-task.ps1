# Registers the Velastra fast HRV mirror task.
# This intentionally stays separate from HealthAutoExport-VelastrahQ-Sync.

param(
    [int]$EveryMinutes = 10,
    [string]$TaskName = "Velastra-Fast-HRV-Sync",
    [switch]$DryRunTask
)

$ErrorActionPreference = "Stop"
$RepoRoot = $PSScriptRoot
$Runner = Join-Path $RepoRoot "run-fast-hrv-sync.ps1"
if (-not (Test-Path -LiteralPath $Runner)) {
    throw "Runner not found: $Runner"
}

$hasHaeToken = [bool]([Environment]::GetEnvironmentVariable("HAE_READ_TOKEN", "User")) -or
    (Test-Path -LiteralPath (Join-Path $RepoRoot ".env"))
$hasApiKey = [bool]([Environment]::GetEnvironmentVariable("VELASTRAHQ_API_KEY", "User"))
if (-not $DryRunTask -and -not ($hasHaeToken -and $hasApiKey)) {
    throw "Live fast HRV task needs HAE_READ_TOKEN/READ_TOKEN and VELASTRAHQ_API_KEY available. Use -DryRunTask for a fetch-only smoke task."
}

$modeArg = if ($DryRunTask) { " -DryRun" } else { "" }
$arguments = "-WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File `"$Runner`"$modeArg"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments -WorkingDirectory $RepoRoot
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "Mirrors raw Health Auto Export HRV samples to velastrahq-api without touching the hourly daily rollup." -Force | Out-Null

Write-Host "Registered $TaskName"
Write-Host "  Interval: every $EveryMinutes minutes"
Write-Host "  Mode: $(if ($DryRunTask) { 'dry-run' } else { 'live mirror' })"
Write-Host "  Runner: $Runner"
Write-Host "  Disable: Disable-ScheduledTask -TaskName '$TaskName'"
