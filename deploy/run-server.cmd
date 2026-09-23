@echo off
rem Runs the crossword server, appending output to logs\server.log.
rem Started at logon by the "Crossword server" scheduled task
rem (install-windows.ps1); run it by hand to test.
setlocal
set "SITE=%~dp0.."
if not exist "%SITE%\logs" mkdir "%SITE%\logs"
set "LOG=%SITE%\logs\server.log"
for %%F in ("%LOG%") do if %%~zF GTR 5000000 move /y "%LOG%" "%LOG%.old" >nul
set "NODE=node"
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
cd /d "%SITE%"
"%NODE%" server\server.mjs >> "%LOG%" 2>&1
