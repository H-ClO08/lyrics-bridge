@echo off
chcp 65001 >nul 2>nul
cd /d "%~dp0"
title NCM NowPlaying - connect your phone

set DEST=%~dp0tools
set PT=%DEST%\platform-tools
set ADB=%PT%\adb.exe

echo.
echo ==================================================
echo   Step 1/2 : Android platform-tools (adb)
echo ==================================================
echo.

if not exist "%DEST%" mkdir "%DEST%"

if exist "%ADB%" (
  echo   adb already present, skipping download.
  goto :RUN
)

echo   Downloading platform-tools from Google ^(about 8 MB^)...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip' -OutFile '%DEST%\pt.zip'"

if not exist "%DEST%\pt.zip" (
  echo.
  echo   [FAILED] Download did not finish.
  echo            Download it manually and unzip so that adb.exe lands in:
  echo            %PT%
  echo            https://dl.google.com/android/repository/platform-tools-latest-windows.zip
  echo.
  pause
  exit /b 1
)

echo   Extracting...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; Expand-Archive -Path '%DEST%\pt.zip' -DestinationPath '%DEST%' -Force"
del /q "%DEST%\pt.zip" >nul 2>nul

if not exist "%ADB%" (
  echo   [FAILED] Extraction failed, %ADB% not found.
  pause
  exit /b 1
)
echo   OK: %ADB%

:RUN
set NODE=node
where node >nul 2>nul
if errorlevel 1 (
  if exist "%ProgramFiles%\nodejs\node.exe" set NODE=%ProgramFiles%\nodejs\node.exe
)

echo.
echo ==================================================
echo   Step 2/2 : pair, connect and verify
echo ==================================================

"%NODE%" "%~dp0tools\adb-setup.js" %*
set RC=%ERRORLEVEL%

echo.
if "%RC%"=="0" (
  echo.
  echo ==================================================
  echo   Connected. Starting the service and SMTC bridge
  echo   in two new windows...
  echo ==================================================
  echo.
  start "NCM NowPlaying - Server" "%~dp0start.bat"
  echo   [1/2] server started (new window)
  timeout /t 3 /nobreak >nul
  start "NCM NowPlaying - SMTC Bridge" "%~dp0smtc-bridge.bat"
  echo   [2/2] SMTC bridge started (new window, for BetterLyrics)
  echo.
  echo   Done. Open http://localhost:8787 or just watch BetterLyrics.
  echo   Close those windows with Ctrl+C when you are done.
) else (
  echo   Not connected yet. Re-run this file after fixing the phone side,
  echo   or check the current state with:
  echo       node tools\adb-setup.js --check
)
echo.
pause
