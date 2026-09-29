@echo off
chcp 65001 >nul
title MiMo API Gateway
cd /d "%~dp0"

rem ============================================================
rem  MiMo API Gateway - one-click launcher
rem
rem  Usage:  double-click this file
rem          or  start-proxy.bat [port] [mode]
rem          mode = auto | standalone | engine
rem
rem  ASCII-only on purpose: cmd.exe parses .bat using the
rem  current console code page, so non-ASCII text breaks it.
rem ============================================================

set "PORT=%~1"
if "%PORT%"=="" set "PORT=8788"
set "MODE=%~2"

echo ============================================================
echo   MiMo API Gateway
echo ============================================================
echo.

rem ---- 1) locate Node ----
set "NODEEXE="
where node >nul 2>nul
if errorlevel 1 goto no_node
for /f "delims=" %%N in ('where node') do if not defined NODEEXE set "NODEEXE=%%N"
echo   [OK] Node found: %NODEEXE%

rem ---- 2) required files ----
if not exist "mimo-api-proxy.mjs" goto no_files
if not exist "dashboard.html"    goto no_files
echo   [OK] Files present

rem ---- 3) port already in use? ----
netstat -ano | findstr /C:":%PORT% " | findstr /I "LISTENING" >nul
if not errorlevel 1 (
  echo.
  echo   [WARN] Port %PORT% is already in use.
  echo          If that is an older MiMo proxy, this one will just
  echo          report "already running" and exit - which is fine.
  echo          For a different port, pass it as the 1st argument.
  echo.
)

echo ------------------------------------------------------------
echo   API       : http://127.0.0.1:%PORT%/v1
echo   Dashboard : http://127.0.0.1:%PORT%/
echo   Password  : admin   ^(change after first login^)
echo ------------------------------------------------------------
echo   Models    : xiaomi/mimo-v2.6-pro        [alias: mimo-pro]
echo               xiaomi/mimo-v2.6-flash      [alias: mimo-flash]
echo               (model catalog auto-refreshes; see dashboard)
echo ------------------------------------------------------------
echo   Standalone mode = no MiMo desktop app needed.
echo   Keep this window open.  Ctrl+C to stop.
echo ============================================================
echo.

rem ---- 4) auto-open dashboard after 4s (non-blocking) ----
start "" /min cmd /c "timeout /t 4 /nobreak >nul & start "" http://127.0.0.1:%PORT%/"

rem ---- 5) run ----
if "%MODE%"=="" (
  node mimo-api-proxy.mjs --port %PORT%
) else (
  node mimo-api-proxy.mjs --port %PORT% --mode %MODE%
)

echo.
echo [server exited]
echo.
pause
exit /b 0

:no_node
echo   [ERROR] Node.js not found in PATH.
echo.
echo   Install Node 18+ from https://nodejs.org
echo   (tick "Add to PATH" during setup), then run this again.
echo.
pause
exit /b 1

:no_files
echo   [ERROR] Required files are missing next to this script.
echo           expected: mimo-api-proxy.mjs, dashboard.html
echo.
pause
exit /b 1
