@echo off
cd /d "%~dp0"
node tools\start-local.mjs
if errorlevel 1 pause
