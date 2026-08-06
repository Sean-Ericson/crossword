@echo off
rem update.cmd - fetch new NYT puzzles, rebuild the index, commit + push.
rem Usage: update [browser] [options]   (see tools\update_puzzles.py --help)
rem
rem Finds Python in this order: %XWORD_PYTHON%, miniconda, Anaconda,
rem the py launcher, then whatever "python" is on PATH. Set XWORD_PYTHON
rem if your interpreter lives somewhere else.
setlocal

rem Scheduled tasks may not inherit the interactive PATH; make sure
rem git and gh are findable regardless of how this was launched.
set "PATH=%PATH%;C:\Program Files\GitHub CLI;C:\Program Files\Git\cmd;%LOCALAPPDATA%\Microsoft\WinGet\Links"

set "PY="
if defined XWORD_PYTHON if exist "%XWORD_PYTHON%" set "PY=%XWORD_PYTHON%"
if not defined PY if exist "%USERPROFILE%\miniconda3\python.exe" set "PY=%USERPROFILE%\miniconda3\python.exe"
if not defined PY if exist "%USERPROFILE%\anaconda3\python.exe" set "PY=%USERPROFILE%\anaconda3\python.exe"
if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Python313\python.exe" set "PY=%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" set "PY=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if not defined PY where /q py.exe && set "PY=py"
if not defined PY set "PY=python"

"%PY%" "%~dp0tools\update_puzzles.py" %*
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" echo update.cmd: FAILED with exit code %RC%
exit /b %RC%
