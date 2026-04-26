@echo off
title Codex ImageGen Launcher
echo Starting Codex ImageGen Proxy...
cd /d "%~dp0"
set "PORT="
echo.
echo ==========================================
echo   Proxy API: http://localhost:3456
echo ==========================================

:start_app
node src/index.mjs
if %errorlevel% equ 1 goto :exit_clean
if %errorlevel% equ -1073741510 goto :exit_clean
echo Server crashed. Restarting in 2 seconds...
timeout /t 2 >nul
goto start_app

:exit_clean
echo Server stopped.
