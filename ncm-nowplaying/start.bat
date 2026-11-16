@echo off
chcp 65001 >nul 2>nul
cd /d "%~dp0"
title NCM NowPlaying - Phone to PC lyrics

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js not found in PATH.
  echo         Install Node.js 18+ from https://nodejs.org/ then run this again.
  echo.
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -v') do set NODEV=%%v
echo.
echo   Node %NODEV% detected. Starting...
echo.

node "%~dp0src\server.js" %*

echo.
echo [Server stopped]
pause
