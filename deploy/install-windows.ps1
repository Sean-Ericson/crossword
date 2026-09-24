# install-windows.ps1 - run the crossword site on this Windows PC.
#
# Registers the "Crossword server" scheduled task for the current user
# (node server\server.mjs, started at logon, restarted if it stops), and
# removes the GitHub-era tasks ("Crossword daily update", "Crossword fetch
# watcher"), whose jobs the server now does itself.
#
# Run from an *elevated* PowerShell and it also opens the server's port in
# Windows Firewall, so the Cloudflare tunnel/proxy on the LAN can reach it.
# Pass -AllowFrom <ip> to accept connections only from that machine
# (recommended: the roommate's server); the default is the local subnet.
#
# Prerequisites (see DEPLOY.md): Node 22.13+, `npm install` done,
# server\config.json with "host": "0.0.0.0" and "publicUrl".
#
# Usage (in the site folder):
#   powershell -ExecutionPolicy Bypass -File deploy\install-windows.ps1 [-AllowFrom 192.168.1.20]
#   ... -Uninstall   to remove the task and firewall rule again

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

function Remove-Task($name) {
  if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
    Write-Host "removed task: $name"
  }
}

function Remove-Rule {
  if ($isAdmin -and (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
    Remove-NetFirewallRule -DisplayName $ruleName
    Write-Host "removed firewall rule: $ruleName"
  }
}

if ($Uninstall) {
  Remove-Task $taskName
  Remove-Rule
  return
}

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

# ----- scheduled task -----
$user = "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -StartWhenAvailable
# cmd /c start /min keeps a console from popping up in your face
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c start `"`" /min `"$deploy\run-server.cmd`""
Remove-Task $taskName
Register-ScheduledTask -TaskName $taskName -Action $action `
  -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $user) `
  -Settings $settings -User $user -RunLevel Limited | Out-Null
Write-Host "registered task: $taskName"

# the GitHub-era jobs are the server's now
Remove-Task 'Crossword daily update'
Remove-Task 'Crossword fetch watcher'

# ----- firewall -----
if ($isAdmin) {
  Remove-Rule
  New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow `
    -Protocol TCP -LocalPort $port -RemoteAddress $AllowFrom | Out-Null
  Write-Host "firewall: TCP $port open to $AllowFrom"
} else {
  Write-Warning ('Not elevated, so the firewall was left alone. To let the proxy reach the server, run as administrator:' +
    "`n  New-NetFirewallRule -DisplayName '$ruleName' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port -RemoteAddress $AllowFrom")
}

Write-Host ''
Start-ScheduledTask -TaskName $taskName
Write-Host "Started. Log: logs\server.log. Check http://127.0.0.1:$port from this PC."
