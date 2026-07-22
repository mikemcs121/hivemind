@echo off
rem Launch the Hivemind Electron app.
rem Clear ELECTRON_RUN_AS_NODE so Electron starts its full GUI runtime
rem instead of behaving like plain Node.
set "ELECTRON_RUN_AS_NODE="
cd /d "%~dp0"
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
