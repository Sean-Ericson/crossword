# Point the DuckDNS name at this network's current public IP.
# install-windows.ps1 schedules this every 5 minutes.
$ErrorActionPreference = 'Stop'
$envFile = Join-Path $PSScriptRoot 'deploy.env'
$cfg = @{}
Get-Content $envFile | Where-Object { $_ -match '^\s*([A-Z_]+)=(.*)$' } | ForEach-Object {
  $cfg[$Matches[1]] = $Matches[2].Trim()
}
$url = "https://www.duckdns.org/update?domains=$($cfg.DUCKDNS_SUBDOMAIN)&token=$($cfg.DUCKDNS_TOKEN)&ip="
$result = (Invoke-WebRequest -UseBasicParsing -Uri $url).Content
if ($result -ne 'OK') { throw "duckdns update failed: $result" }
