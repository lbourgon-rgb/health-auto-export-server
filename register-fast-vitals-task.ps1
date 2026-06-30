# Registers the Velastra fast vitals rollup task.
# This intentionally stays separate from the heavier hourly sync that also
# touches Notion and Google Calendar.

param(
    [int]$EveryMinutes = 10,
    [string]$TaskName = "Velastra-Fast-Vitals-Sync",
    [switch]$DryRunTask
)

$ErrorActionPreference = "Stop"
$RepoRoot = $PSScriptRoot
$Runner = Join-Path $RepoRoot "run-fast-vitals-sync.ps1"
if (-not (Test-Path -LiteralPath $Runner)) {
    throw "Runner not found: $Runner"
}
$LauncherDir = Join-Path $RepoRoot "seed_data\task-launchers"
$Launcher = Join-Path $LauncherDir "run-fast-vitals-sync-hidden.vbs"

function Test-EnvFileValue {
    param(
        [string]$Path,
        [string]$Name
    )
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    $text = Get-Content -LiteralPath $Path -Raw
    return $text -match "(?m)^$([regex]::Escape($Name))=.+"
}

$hasHaeToken = [bool]([Environment]::GetEnvironmentVariable("HAE_READ_TOKEN", "User")) -or
    [bool]([Environment]::GetEnvironmentVariable("HAE_READ_TOKEN", "Process")) -or
    (Test-Path -LiteralPath (Join-Path $RepoRoot ".env"))
$hasApiKey = [bool]([Environment]::GetEnvironmentVariable("VELASTRAHQ_API_KEY", "User")) -or
    [bool]([Environment]::GetEnvironmentVariable("VELASTRAHQ_API_KEY", "Process")) -or
    (Test-EnvFileValue -Path (Join-Path $RepoRoot ".env.hrv.local") -Name "VELASTRAHQ_API_KEY")
if (-not $DryRunTask -and -not ($hasHaeToken -and $hasApiKey)) {
    throw "Live fast vitals task needs HAE_READ_TOKEN/READ_TOKEN and VELASTRAHQ_API_KEY available. Use -DryRunTask for a fetch-only smoke task."
}

$modeArg = if ($DryRunTask) { " -DryRun" } else { "" }
New-Item -ItemType Directory -Force -Path $LauncherDir | Out-Null
$runnerForVbs = $Runner.Replace('"', '""')
$psCommand = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""{0}""{1}' -f $runnerForVbs, $modeArg
@"
Set shell = CreateObject("WScript.Shell")
shell.Run "$psCommand", 0, False
"@ | Set-Content -LiteralPath $Launcher -Encoding ASCII

$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$Launcher`"" -WorkingDirectory $RepoRoot
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "Mirrors Health Auto Export vitals and body-battery flags to velastrahq-api every few minutes without Notion/Calendar side effects." -Force | Out-Null

Write-Host "Registered $TaskName"
Write-Host "  Interval: every $EveryMinutes minutes"
Write-Host "  Mode: $(if ($DryRunTask) { 'dry-run' } else { 'live rollup' })"
Write-Host "  Runner: $Runner"
Write-Host "  Hidden launcher: $Launcher"
Write-Host "  Disable: Disable-ScheduledTask -TaskName '$TaskName'"
