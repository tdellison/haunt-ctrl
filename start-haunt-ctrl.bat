@echo off
cd C:\Users\tdell\haunt-ctrl-v3
echo.
echo  ============================================
echo   HAUNT CTRL v3 — UPDATING...
echo  ============================================
git fetch origin master
git reset --hard origin/master

REM Generate skeleton + witch test voices if they don't exist yet
if not exist "C:\Users\tdell\OneDrive\Desktop\SKELETON\skeleton-left.wav" (
  echo  Generating test voices...
  powershell -ExecutionPolicy Bypass -File "%~dp0make-skeleton-voices.ps1"
)
if not exist "C:\Users\tdell\OneDrive\Desktop\WITCH\witch1-right.wav" (
  echo  Generating witch test voices...
  powershell -ExecutionPolicy Bypass -File "%~dp0make-skeleton-voices.ps1"
)
echo.
echo  ============================================
echo   HAUNT CTRL v3 — SERVER STARTING...
echo   Open on iPhone: http://192.168.1.11:3000
echo  ============================================
echo.
start http://192.168.1.11:3000
node server.js
echo.
echo  ============================================
echo   SERVER STOPPED — see error above
echo  ============================================
pause
