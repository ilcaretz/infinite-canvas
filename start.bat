@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 is required. Install it with: winget install OpenJS.NodeJS.LTS
  pause
  exit /b 1
)
node "%~dp0scripts\run.mjs"
if errorlevel 1 pause
