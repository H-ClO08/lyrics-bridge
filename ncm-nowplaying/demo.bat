@echo off
chcp 65001 >nul 2>nul
cd /d "%~dp0"
title NCM NowPlaying - DEMO MODE

echo.
echo   Starting in DEMO mode (no phone needed).
echo   A virtual playlist drives the full pipeline so you can see the UI.
echo.

node "%~dp0src\server.js" --source=mock %*

pause
