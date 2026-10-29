@echo off
rem Stops the WtS server.
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0wts-service.ps1" -Action stop
pause
