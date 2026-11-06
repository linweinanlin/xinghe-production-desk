@echo off
rem Xinghe Production Desk - double click launcher for Windows.
rem Prefers the project venv, falls back to whatever pythonw is on PATH.
setlocal
cd /d "%~dp0"
if exist ".venv\Scripts\pythonw.exe" (
  start "" ".venv\Scripts\pythonw.exe" launch.py
  exit /b 0
)
where pythonw >nul 2>nul
if errorlevel 1 (
  echo [Xinghe] pythonw not found. Install Python 3.9+ and run: pip install -r requirements.txt
  echo See startup.log after you retry.
  pause
  exit /b 1
)

start "" pythonw launch.py
exit /b 0
