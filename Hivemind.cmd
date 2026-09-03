@echo off
rem Launch Hivemind (no global Node needed - uses the bundled Electron).
rem
rem The app runs as Hivemind.exe, a hard link to the bundled electron.exe, so
rem tools that kill Electron by image name (taskkill /IM electron.exe,
rem Get-Process electron | Stop-Process) cannot take Hivemind down. The link is
rem (re)made below whenever it is missing or no longer matches electron.exe
rem (e.g. after reinstalling Electron).
cd /d "%~dp0"
set "APP=%~dp0"
set "APP=%APP:~0,-1%"
set "DIST=%~dp0node_modules\electron\dist"
set "SRC=%DIST%\electron.exe"
set "EXE=%DIST%\Hivemind.exe"
if not exist "%SRC%" (
  echo Bundled Electron not found at "%SRC%".
  echo Run: node node_modules\electron\install.js
  pause
  exit /b 1
)
call :sync
start "" "%EXE%" "%APP%" --disable-gpu
exit /b 0

:sync
if not exist "%EXE%" goto :link
for %%A in ("%SRC%") do set "SRCSIZE=%%~zA"
for %%A in ("%EXE%") do set "EXESIZE=%%~zA"
if "%SRCSIZE%"=="%EXESIZE%" exit /b 0
del /f /q "%EXE%"
:link
mklink /H "%EXE%" "%SRC%" >nul 2>&1 || copy /y "%SRC%" "%EXE%" >nul
exit /b 0
