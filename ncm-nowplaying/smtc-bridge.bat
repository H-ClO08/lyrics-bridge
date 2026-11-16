@echo off
chcp 65001 >nul 2>nul
cd /d "%~dp0"
title NCM NowPlaying - SMTC bridge (for BetterLyrics)

echo.
echo   Publishing phone playback as a Windows media session.
echo.
echo   BetterLyrics picks it up automatically as playback source
echo   "NCMPhoneBridge" - no configuration needed.
echo.
echo   Start start.bat first (or run Node in another window), then
echo   keep THIS window open while you listen on the phone.
echo   Press Ctrl+C to stop.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0smtc\smtc-bridge.ps1" %*

echo.
pause
