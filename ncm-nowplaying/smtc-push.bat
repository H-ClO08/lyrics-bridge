@echo off
chcp 65001 >nul 2>nul
cd /d "%~dp0"
title NCM NowPlaying - PC to service push (for tablet)

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js not found in PATH.
  echo         Install Node.js 18+ from https://nodejs.org/ then run this again.
  echo.
  pause
  exit /b 1
)

echo.
echo   Publishing THIS PC's playback to the ncm-nowplaying service.
echo.
echo   Whatever plays on this PC (Netease / QQ Music / Spotify / ...)
echo   becomes visible on the tablet by opening the service URL.
echo.
echo   Run start.bat first, then keep THIS window open while you listen.
echo   Press Ctrl+C to stop.
echo.

node "%~dp0tools\smtc-push.js" %*

echo.
pause
