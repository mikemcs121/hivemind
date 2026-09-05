@echo off
rem Launch Hivemind as a first-time user would see it - empty profile, no boards,
rem no settings - without touching the live instance's %APPDATA%\hivemind.
rem
rem Runs scripts\fresh-run.js under the bundled Electron in Node mode, so no
rem global Node is needed. Extra arguments are forwarded (--keep, --sample-project,
rem --debug, ...); run with --help to see them all. The console window stays open
rem while the app runs; pass --detach to launch and close it.
cd /d "%~dp0"
set "NODEEXE=%~dp0node_modules\electron\dist\electron.exe"
if not exist "%NODEEXE%" (
  echo Bundled Electron not found at "%NODEEXE%".
  echo Run: node node_modules\electron\install.js
  pause
  exit /b 1
)
set "ELECTRON_RUN_AS_NODE=1"
"%NODEEXE%" "%~dp0scripts\fresh-run.js" %*
if errorlevel 1 pause
exit /b 0
