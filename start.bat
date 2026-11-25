@echo off
setlocal
title MeshSwarm Tracker
cd /d "%~dp0"
echo Starting MeshSwarm tracker...
echo.
:run
if exist "runtime\node.exe" (
  "runtime\node.exe" src\index.js
) else (
  node src\index.js
)
if %errorlevel%==42 goto run
if %errorlevel%==0 exit /b 0
echo.
echo Tracker stopped.
pause
