@echo off
rem Runs Caddy (HTTPS front door) with the domain from deploy.env.
rem Started at logon by the "Crossword Caddy" scheduled task.
setlocal
set "HERE=%~dp0"
for /f "usebackq tokens=1,* delims==" %%A in ("%HERE%deploy.env") do (
  if "%%A"=="XWORD_DOMAIN" set "XWORD_DOMAIN=%%B"
)
set "CADDY=caddy"
if exist "%HERE%caddy.exe" set "CADDY=%HERE%caddy.exe"
if not exist "%HERE%..\logs" mkdir "%HERE%..\logs"
"%CADDY%" run --config "%HERE%Caddyfile" --adapter caddyfile >> "%HERE%..\logs\caddy.log" 2>&1
