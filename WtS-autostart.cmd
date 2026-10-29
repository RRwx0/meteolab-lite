@echo off
rem Toggles WtS autostart at Windows login: first run enables, second disables.
setlocal
cd /d "%~dp0"
set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\MeteoLab WtS.lnk"
if exist "%LNK%" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0wts-service.ps1" -Action autostart-off
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0wts-service.ps1" -Action autostart-on
)
pause
