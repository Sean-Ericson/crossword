@echo off
rem ---------------------------------------------------------------------
rem fetch_requests.bat - serve on-demand puzzle requests from the site.
rem
rem Runs every minute on the machine with the NYT login, so clicking an
rem un-downloaded day on the site fetches it within a couple of minutes.
rem Logs to logs\fetch.log. Silent (and cheap) when nothing is queued.
rem
rem Register it (once, in a normal Command Prompt):
rem   schtasks /create /tn "Crossword fetch requests" /tr "C:\path\to\crossword\fetch_requests.bat" /sc minute /mo 1 /f
rem ---------------------------------------------------------------------
setlocal

rem Scheduled tasks may not inherit the interactive PATH; make sure
rem git and gh are findable regardless of how this was launched.
set "PATH=%PATH%;C:\Program Files\GitHub CLI;C:\Program Files\Git\cmd;%LOCALAPPDATA%\Microsoft\WinGet\Links"

set "REPO=%~dp0"
set "LOGDIR=%REPO%logs"
set "LOG=%LOGDIR%\fetch.log"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"

for %%F in ("%LOG%") do if %%~zF GTR 1000000 move /y "%LOG%" "%LOG%.old" >nul

set "PY="
if defined XWORD_PYTHON if exist "%XWORD_PYTHON%" set "PY=%XWORD_PYTHON%"
if not defined PY if exist "%USERPROFILE%\miniconda3\python.exe" set "PY=%USERPROFILE%\miniconda3\python.exe"
if not defined PY if exist "%USERPROFILE%\anaconda3\python.exe" set "PY=%USERPROFILE%\anaconda3\python.exe"
if not defined PY where /q py.exe && set "PY=py"
if not defined PY set "PY=python"

rem Only write a log header when there is something to say, so a
rem once-a-minute task doesn't fill the log with "nothing to do".
"%PY%" "%REPO%tools\fetch_requests.py" %* > "%TEMP%\xw_fetch_out.txt" 2>&1
set "RC=%ERRORLEVEL%"

findstr /c:"No pending requests." /c:"none pending." "%TEMP%\xw_fetch_out.txt" >nul
if errorlevel 1 (
  echo. >> "%LOG%"
  echo ===== %DATE% %TIME% ===== >> "%LOG%"
  type "%TEMP%\xw_fetch_out.txt" >> "%LOG%"
  if not "%RC%"=="0" echo ----- FAILED with exit code %RC% >> "%LOG%"
)
del "%TEMP%\xw_fetch_out.txt" 2>nul

exit /b %RC%
