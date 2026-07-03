@echo off
title dreamDEX bot 24/7
cd /d "%~dp0"
:loop
echo.
echo [%date% %time%] Starting bot...
call npm start
echo [%date% %time%] Bot exited (code %errorlevel%). Restarting in 5 sec... Press Ctrl+C to stop.
timeout /t 5 /nobreak >nul
goto loop
