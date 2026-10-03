@echo off
rem Exposes the backend (port 5001) on the fixed ngrok URL and restarts the tunnel if it drops.
:loop
echo [%date% %time%] starting ngrok >> "%~dp0ngrok.log"
ngrok http --url=civic-facsimile-dimly.ngrok-free.dev 5001 --log=stdout >> "%~dp0ngrok.log" 2>&1
timeout /t 10 /nobreak >nul
goto loop
