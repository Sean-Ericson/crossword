@echo off
rem ---------------------------------------------------------------------
rem daily_update.bat - what Task Scheduler runs once a day.
rem
rem Calls update.cmd, appends timestamped output to logs\update.log, and
rem exits non-zero on failure so Task Scheduler shows the error.
rem
rem Register it (run once, in a normal Command Prompt):
rem   schtasks /create /tn "Crossword daily update" /tr "\"C:\path\to\crossword-site\daily_update.bat\"" /sc daily /st 23:30 /rl limited /f
rem
rem Run it by hand any time to test:  daily_update.bat
rem ---------------------------------------------------------------------
setlocal

rem Scheduled tasks may not inherit the interactive PATH; make sure
rem git and gh are findable regardless of how this was launched.
set "PATH=%PATH%;C:\Program Files\GitHub CLI;C:\Program Files\Git\cmd;%LOCALAPPDATA%\Microsoft\WinGet\Links"

set "REPO=%~dp0"
set "LOGDIR=%REPO%logs"
set "LOG=%LOGDIR%\update.log"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"

rem Keep the log from growing forever: over ~1 MB, start a fresh one.
for %%F in ("%LOG%") do if %%~zF GTR 1000000 move /y "%LOG%" "%LOG%.old" >nul

echo. >> "%LOG%"
echo ===== %DATE% %TIME% ===== >> "%LOG%"

call "%REPO%update.cmd" >> "%LOG%" 2>&1
set "RC=%ERRORLEVEL%"

if "%RC%"=="0" (
  echo ----- finished OK >> "%LOG%"
) else (
  echo ----- FAILED with exit code %RC% >> "%LOG%"
)

exit /b %RC%
