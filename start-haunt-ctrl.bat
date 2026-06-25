@echo off
cd C:\Users\tdell\haunt-ctrl-v3
echo.
echo  ============================================
echo   HAUNT CTRL v3 — UPDATING...
echo  ============================================
git fetch origin master
git reset --hard origin/master
npm install --omit=dev
echo.
echo  ============================================
echo   HAUNT CTRL v3 — SERVER STARTING...
echo   Open on iPhone: http://192.168.1.11:3000
echo  ============================================
echo.
start http://192.168.1.11:3000
node server.js
pause
