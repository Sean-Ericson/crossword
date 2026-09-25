# install-windows.ps1 - run the crossword site on this Windows PC as a
# background service (a scheduled task).
#
# The "Crossword server" task:
#   - starts when the PC boots, whether or not anyone logs in, with no window
#   - runs node.exe directly, so Windows knows it's the task: "End"/Stop in
#     Task Scheduler stops the server, "Run" starts it
#   - restarts the server within a minute if it crashes
#   - logs to logs\server.log (rotated at ~5 MB)
# It runs as your user account but without storing your password ("S4U"),
# which means it can't use things unlocked by your Windows login, like
# `gh auth` or Chrome's cookie store - see DEPLOY.md.
#
# Also opens the server's port in Windows Firewall (so the Cloudflare
# tunnel/proxy on the LAN can reach it) and removes the GitHub-era tasks.
#
# Run from an *elevated* PowerShell, in the site folder:
#   powershell -ExecutionPolicy Bypass -File deploy\install-windows.ps1 [-AllowFrom 192.168.1.20]
#   ... -Uninstall   to remove the task and firewall rule again
#
# Restart after a `git pull` or config change:
#   Stop-ScheduledTask 'Crossword server'; Start-ScheduledTask 'Crossword server'

param(
  [switch]$Uninstall,
  [string]$AllowFrom = 'LocalSubnet'
)
$ErrorActionPreference = 'Stop'
$deploy = $PSScriptRoot
$site = Split-Path $deploy -Parent
$taskName = 'Crossword server'
$ruleName = 'Crossword server (Cloudflare proxy)'
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  throw 'Run this from an elevated PowerShell (right-click PowerShell -> Run as administrator).'
}

function Remove-Task($name) {
  if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
    Write-Host "removed task: $name"
  }
}

function Remove-Rule {
  if (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue) {
    Remove-NetFirewallRule -DisplayName $ruleName
    Write-Host "removed firewall rule: $ruleName"
  }
}

if ($Uninstall) {
  Remove-Task $taskName
  Remove-Rule
  return
}

# ----- checks -----
if (-not (Test-Path (Join-Path $site 'node_modules\ws'))) {
  throw "Run 'npm install' in $site first."
}
$configFile = Join-Path $site 'server\config.json'
if (-not (Test-Path $configFile)) {
  throw 'server\config.json is missing - copy server\config.example.json and fill it in first.'
}
$config = Get-Content $configFile -Raw | ConvertFrom-Json
$port = 8080
if ($null -ne $config.port) { $port = [int]$config.port }
if ($config.host -ne '0.0.0.0') {
  Write-Warning "config.json has host '$($config.host)' - the proxy on the LAN can only reach the server with ""host"": ""0.0.0.0""."
}
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = Join-Path $env:ProgramFiles 'nodejs\node.exe' }
if (-not (Test-Path $node)) { throw 'node.exe not found - install Node.js (winget install OpenJS.NodeJS.LTS).' }

# ----- stop whatever is running now (old-style task or a hand-started server) -----
Remove-Task $taskName
Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }

# ----- scheduled task -----
$action = New-ScheduledTaskAction -Execute $node `
  -Argument "server\server.mjs --log logs\server.log" -WorkingDirectory $site
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew -StartWhenAvailable
Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal `
  -Trigger (New-ScheduledTaskTrigger -AtStartup) -Settings $settings | Out-Null
Write-Host "registered task: $taskName (starts at boot, restarts on crash)"

# the GitHub-era jobs are the server's now
Remove-Task 'Crossword daily update'
Remove-Task 'Crossword fetch watcher'

# ----- firewall -----
Remove-Rule
New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow `
  -Protocol TCP -LocalPort $port -RemoteAddress $AllowFrom | Out-Null
Write-Host "firewall: TCP $port open to $AllowFrom"

# ----- start + check -----
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 3
$state = (Get-ScheduledTask -TaskName $taskName).State
Write-Host ''
if ($state -eq 'Running') {
  Write-Host "Running. Log: $site\logs\server.log - check http://127.0.0.1:$port"
} else {
  Write-Warning "The task is '$state', not running - see the end of logs\server.log."
}
