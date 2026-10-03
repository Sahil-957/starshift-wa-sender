@echo off
rem Runs the licence backend and restarts it if it stops. Output goes to scripts\backend.log.
cd /d "%~dp0..\backend"
:loop
echo [%date% %time%] starting backend >> "%~dp0backend.log"
node server.js >> "%~dp0backend.log" 2>&1
timeout /t 5 /nobreak >nul
goto loop
