@echo off
title Folder2Page - Auto Content Poster Setup
color 0A

echo.
echo ========================================================
echo   Folder2Page - Setup and Run
echo ========================================================
echo.

echo [1/3] Installing backend packages...
cd /d "H:\EasyMotion\Page to post"
call npm install
if %errorlevel% neq 0 (
    echo ERROR: Backend install failed!
    pause
    exit /b 1
)
echo OK - Backend packages installed!
echo.

echo [2/3] Building frontend...
cd /d "H:\EasyMotion\Page to post\frontend"
call npm run build
if %errorlevel% neq 0 (
    echo ERROR: Frontend build failed!
    pause
    exit /b 1
)
echo OK - Frontend built!
echo.

echo [3/3] Starting server...
cd /d "H:\EasyMotion\Page to post"
echo.
echo ========================================================
echo   Server starting on http://localhost:5002
echo   Proxy tab with country flags is ready!
echo ========================================================
echo.
node server.js
pause
