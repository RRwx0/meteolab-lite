@echo off
rem WtS launcher: double-click starts the server and opens the site.
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0wts-service.ps1" -Action start
if errorlevel 1 pause
