@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo Install Node.js 24 LTS, then run this file again.
    pause
    exit /b 1
)

where npm.cmd >nul 2>nul
if errorlevel 1 (
    echo npm.cmd was not found. Check your Node.js installation.
    pause
    exit /b 1
)

node -e "if (Number(process.versions.node.split('.')[0]) < 20) process.exit(1)"
if errorlevel 1 (
    echo Building requires Node.js 20 or newer. Node.js 24 LTS is recommended.
    pause
    exit /b 1
)

call npm.cmd ci
if errorlevel 1 goto :failed
call npm.cmd test
if errorlevel 1 goto :failed
call npm.cmd run package
if errorlevel 1 goto :failed

echo.
echo Build complete.
for %%f in (*.vsix) do echo %%f
pause
exit /b 0

:failed
echo.
echo Build failed. See the error above.
pause
exit /b 1
