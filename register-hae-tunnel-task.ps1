# Registers the Health Auto Export Cloudflare tunnel as a hidden startup task.
# Uses wscript + a small VBS launcher so cloudflared does not open a console
# window when Windows starts or the user logs in.

param(
    [string]$TaskName = "hae-tunnel",
    [string]$CloudflaredPath = "C:\Program Files (x86)\cloudflared\cloudflared.exe",
    [string]$ConfigPath = "C:\Users\Allen\.cloudflared\hae-config.yml",
    [string]$TunnelName = "hae",
    [switch]$NoStartupTrigger
)

$ErrorActionPreference = "Stop"
$RepoRoot = $PSScriptRoot
$LauncherDir = Join-Path $RepoRoot "seed_data\task-launchers"
$LauncherPs1 = Join-Path $LauncherDir "run-hae-tunnel-hidden.ps1"
$Launcher = Join-Path $LauncherDir "run-hae-tunnel-hidden.vbs"
$StartupLauncher = Join-Path ([Environment]::GetFolderPath("Startup")) "hae-tunnel-hidden.vbs"

if (-not (Test-Path -LiteralPath $CloudflaredPath)) {
    throw "cloudflared not found: $CloudflaredPath"
}
if (-not (Test-Path -LiteralPath $ConfigPath)) {
    throw "HAE cloudflared config not found: $ConfigPath"
}

New-Item -ItemType Directory -Force -Path $LauncherDir | Out-Null

$exeForPs = $CloudflaredPath.Replace("'", "''")
$configForPs = $ConfigPath.Replace("'", "''")
$tunnelForPs = $TunnelName.Replace("'", "''")
@"
`$ErrorActionPreference = "Stop"
`$cloudflared = '$exeForPs'
`$config = '$configForPs'
`$tunnel = '$tunnelForPs'
`$needleConfig = `$config.ToLowerInvariant()
`$needleTunnel = " run `$tunnel".ToLowerInvariant()
`$existing = Get-CimInstance Win32_Process -Filter "name = 'cloudflared.exe'" -ErrorAction SilentlyContinue | Where-Object {
    `$cmd = if (`$_.CommandLine) { `$_.CommandLine.ToLowerInvariant() } else { "" }
    `$cmd.Contains(`$needleConfig) -and `$cmd.Contains(`$needleTunnel)
}
if (`$existing) { exit 0 }
Start-Process -FilePath `$cloudflared -ArgumentList @("tunnel", "--config", `$config, "run", `$tunnel) -WindowStyle Hidden
"@ | Set-Content -LiteralPath $LauncherPs1 -Encoding ASCII

$psForVbs = $LauncherPs1.Replace('"', '""')
$hiddenCommand = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""{0}""' -f $psForVbs
@"
Set shell = CreateObject("WScript.Shell")
shell.Run "$hiddenCommand", 0, False
"@ | Set-Content -LiteralPath $Launcher -Encoding ASCII

function Install-StartupLauncher {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $StartupLauncher) | Out-Null
    Copy-Item -LiteralPath $Launcher -Destination $StartupLauncher -Force
    Write-Host "Installed Startup fallback launcher"
    Write-Host "  Startup launcher: $StartupLauncher"
}

$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$Launcher`"" -WorkingDirectory $RepoRoot
$triggers = @(
    New-ScheduledTaskTrigger -AtLogOn
)
if (-not $NoStartupTrigger) {
    $triggers += New-ScheduledTaskTrigger -AtStartup
}
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Limited

try {
    Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $action `
        -Trigger $triggers `
        -Settings $settings `
        -Principal $principal `
        -Description "Runs the Health Auto Export Cloudflare tunnel invisibly at startup/logon so hae.velastrae.com can reach the mini PC." `
        -Force | Out-Null

    Start-ScheduledTask -TaskName $TaskName

    Write-Host "Registered $TaskName"
    Write-Host "  Hidden launcher: $Launcher"
    Write-Host "  Guard script: $LauncherPs1"
    Write-Host "  Cloudflared: $CloudflaredPath"
    Write-Host "  Config: $ConfigPath"
    Write-Host "  Triggers: logon$(if ($NoStartupTrigger) { '' } else { ' + startup' })"
    Write-Host "  Disable: Disable-ScheduledTask -TaskName '$TaskName'"
} catch {
    Install-StartupLauncher
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing -and $existing.State -ne "Running") {
        Start-ScheduledTask -TaskName $TaskName
    }
    Write-Warning "Could not register scheduled task '$TaskName': $($_.Exception.Message)"
    Write-Warning "Fallback installed. It will run invisibly when this Windows user logs in."
}
