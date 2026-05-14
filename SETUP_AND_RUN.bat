@echo off
title image-post - Setup and Run
color 0A

echo.
echo ========================================================
echo   image-post (Folder2Page) - Setup and Run
echo ========================================================
echo.

cd /d "%~dp0"

echo [1/3] Installing backend packages...
call npm install
if %errorlevel% neq 0 (
    echo ERROR: Backend install failed!
    pause
    exit /b 1
)
echo OK - Backend packages installed!
echo.

echo [2/3] Building frontend...
cd frontend
call npm install
if %errorlevel% neq 0 (
    echo ERROR: Frontend install failed!
    cd ..
    pause
    exit /b 1
)
call npm run build
if %errorlevel% neq 0 (
    echo ERROR: Frontend build failed!
    cd ..
    pause
    exit /b 1
)
cd ..
echo OK - Frontend built!
echo.

echo [3/3] Starting server...
echo.
echo ========================================================
echo   Server starting on http://localhost:5016
echo   (override with `set PORT=5017` to change)
echo ========================================================
echo.
node server.js
pause
