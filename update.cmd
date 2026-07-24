@echo off
rem update.cmd — fetch new NYT puzzles, rebuild the index, commit + push.
rem Usage: update [browser] [options]   (see tools\update_puzzles.py --help)
setlocal
set "PY=%USERPROFILE%\miniconda3\python.exe"
if not exist "%PY%" set "PY=python"
"%PY%" "%~dp0tools\update_puzzles.py" %*
endlocal
