@echo off
rem Starts Swoop from this folder (double-click this file).
cd /d "%~dp0"
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
