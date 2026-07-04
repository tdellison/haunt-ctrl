@echo off
echo Generating skeleton test voices...
powershell -ExecutionPolicy Bypass -File "%~dp0make-skeleton-voices.ps1"
pause
