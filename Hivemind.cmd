@echo off
rem Launch Hivemind (no global Node needed - uses the bundled Electron).
cd /d "%~dp0"
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0" --disable-gpu
