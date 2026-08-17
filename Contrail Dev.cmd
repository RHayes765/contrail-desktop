@echo off
REM Double-click launcher for the DEVELOPER loop (hot reload, DevTools).
REM Teammates should use the installed app instead — see README.
cd /d "%~dp0apps\desktop"
echo Starting Contrail (dev)...
call pnpm dev
if errorlevel 1 (
  echo.
  echo Contrail exited with an error. Common causes:
  echo   - Contrail is already running ^(the app takes a single-instance lock^)
  echo   - dependencies are stale: run "pnpm install" then "pnpm -r build"
  echo.
  pause
)
