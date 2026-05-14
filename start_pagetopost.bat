@echo off
title EasyMotion — Facebook Auto Content Poster
color 0A

echo.
echo ╔══════════════════════════════════════════════╗
echo ║  ⚡ EasyMotion — Auto Content Poster         ║
echo ║  Starting servers...                         ║
echo ╚══════════════════════════════════════════════╝
echo.

cd /d "%~dp0"

:: Check Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found! Install from https://nodejs.org
    pause
    exit /b 1
)

:: Install backend dependencies if needed
if not exist "node_modules" (
    echo [SETUP] Installing backend dependencies...
    call npm install
    echo.
)

:: Install frontend dependencies if needed
if not exist "frontend\node_modules" (
    echo [SETUP] Installing frontend dependencies...
    cd frontend
    call npm install
    cd ..
    echo.
)

:: Build frontend if no dist
if not exist "frontend\dist" (
    echo [BUILD] Building frontend...
    cd frontend
    call npm run build
    cd ..
    echo.
)

:: Start backend server
echo [START] Starting EasyMotion server on port 5002...
echo.
start "EasyMotion Server" cmd /k "cd /d "%~dp0" && node server.js"

:: Wait for server to start
timeout /t 3 /nobreak >nul

:: Open browser
echo [OPEN] Opening dashboard...
start http://localhost:5002

echo.
echo ✅ EasyMotion is running!
echo    Backend:  http://localhost:5002
echo    Dashboard will open in your browser.
echo.
echo Press any key to close this window (server will keep running)...
pause >nul
