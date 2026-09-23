# install-windows.ps1 - run the crossword site on this Windows PC.
#
# Registers scheduled tasks for the current user:
#   "Crossword server"  - node server\server.mjs, at logon, restarted on failure
#   "Crossword Caddy"   - HTTPS front door (deploy\Caddyfile), at logon
#   "Crossword DuckDNS" - keeps the DuckDNS name pointed here, every 5 minutes
# and removes the GitHub-era tasks ("Crossword daily update", "Crossword
# fetch watcher"), whose jobs the server now does itself.
#
# Prerequisites (see DEPLOY.md): Node 22.13+, `npm install` done, Caddy
# (winget install CaddyServer.Caddy, or caddy.exe placed in deploy\),
# deploy\deploy.env filled in, ports 80+443 forwarded to this PC.
#
# Usage (normal PowerShell, in the site folder):
#   powershell -ExecutionPolicy Bypass -File deploy\install-windows.ps1
#   ... -Uninstall   to remove the tasks again

param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$deploy = $PSScriptRoot
$site = Split-Path $deploy -Parent
$names = 'Crossword server', 'Crossword Caddy', 'Crossword DuckDNS'

function Remove-Task($name) {
  if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
    Write-Host "removed task: $name"
  }
}

if ($Uninstall) {
  $names | ForEach-Object { Remove-Task $_ }
  return
}

if (-not (Test-Path (Join-Path $deploy 'deploy.env'))) {
  throw 'deploy\deploy.env is missing - copy deploy.env.example and fill it in first.'
}
if (-not (Test-Path (Join-Path $site 'node_modules\ws'))) {
  throw "Run 'npm install' in $site first."
}

$user = "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -StartWhenAvailable
$logon = New-ScheduledTaskTrigger -AtLogOn -User $user

function Register($name, $action, $trigger) {
  Remove-Task $name
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger `
    -Settings $settings -User $user -RunLevel Limited | Out-Null
  Write-Host "registered task: $name"
}

# cmd /c start /min keeps a console from popping up in your face
Register 'Crossword server' `
  (New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c start `"`" /min `"$deploy\run-server.cmd`"") $logon
Register 'Crossword Caddy' `
  (New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c start `"`" /min `"$deploy\run-caddy.cmd`"") $logon

$every5 = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
Register 'Crossword DuckDNS' `
  (New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$deploy\duckdns-update.ps1`"") $every5

# the GitHub-era jobs are the server's now
Remove-Task 'Crossword daily update'
Remove-Task 'Crossword fetch watcher'

Write-Host ''
Write-Host 'Starting everything now...'
$names | ForEach-Object { Start-ScheduledTask -TaskName $_ }
Write-Host 'Done. Logs: logs\server.log and logs\caddy.log.'
Write-Host 'If Windows asks whether Caddy may accept connections, allow it on private and public networks.'
