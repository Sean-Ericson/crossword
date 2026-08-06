@echo off
rem ---------------------------------------------------------------------
rem fetch_watch.bat - keep serving on-demand puzzle requests, continuously.
rem
rem This is the low-latency alternative to the once-a-minute
rem fetch_requests.bat: it stays running and polls every few seconds, so a
rem puzzle clicked on the site usually arrives in well under a minute.
rem Run ONE of the two, not both.
rem
rem Register it to start at logon (once, in a normal Command Prompt):
rem   schtasks /create /tn "Crossword fetch watcher" /tr "C:\path\to\crossword\fetch_watch.bat" /sc onlogon /f
rem
rem Then in Task Scheduler set Settings -> "If the task fails, restart every
rem 1 minute" and untick "Stop the task if it runs longer than", since this
rem one is meant to run forever.
rem ---------------------------------------------------------------------
setlocal

rem Scheduled tasks may not inherit the interactive PATH; make sure
rem git and gh are findable regardless of how this was launched.
set "PATH=%PATH%;C:\Program Files\GitHub CLI;C:\Program Files\Git\cmd;%LOCALAPPDATA%\Microsoft\WinGet\Links"

set "REPO=%~dp0"
set "LOGDIR=%REPO%logs"
set "LOG=%LOGDIR%\fetch.log"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"

for %%F in ("%LOG%") do if %%~zF GTR 5000000 move /y "%LOG%" "%LOG%.old" >nul

set "PY="
if defined XWORD_PYTHON if exist "%XWORD_PYTHON%" set "PY=%XWORD_PYTHON%"
if not defined PY if exist "%USERPROFILE%\miniconda3\python.exe" set "PY=%USERPROFILE%\miniconda3\python.exe"
if not defined PY if exist "%USERPROFILE%\anaconda3\python.exe" set "PY=%USERPROFILE%\anaconda3\python.exe"
if not defined PY where /q py.exe && set "PY=py"
if not defined PY set "PY=python"

echo. >> "%LOG%"
echo ===== watcher started %DATE% %TIME% ===== >> "%LOG%"
"%PY%" -u "%REPO%tools\fetch_requests.py" --watch %* >> "%LOG%" 2>&1
set "RC=%ERRORLEVEL%"
echo ===== watcher exited (code %RC%) %DATE% %TIME% ===== >> "%LOG%"
exit /b %RC%
