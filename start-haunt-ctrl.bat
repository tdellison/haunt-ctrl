@echo off
cd C:\Users\tdell\haunt-ctrl-v3

echo.
echo  ============================================
echo   HAUNT CTRL v3 — UPDATING...
echo  ============================================
git fetch origin master
git reset --hard origin/master

echo.
echo  ============================================
echo   Configuring power and display...
echo  ============================================
REM Lid close = Do Nothing (AC and battery)
powercfg /setacvalueindex SCHEME_CURRENT 4f971e89-eebd-4455-a8de-9e59040e7347 5ca83367-6e45-459f-a27b-476b1d01c936 0
powercfg /setdcvalueindex SCHEME_CURRENT 4f971e89-eebd-4455-a8de-9e59040e7347 5ca83367-6e45-459f-a27b-476b1d01c936 0
powercfg /setactive SCHEME_CURRENT

REM Extend to all displays
DisplaySwitch.exe /extend

REM Wait for displays to initialize
timeout /t 3 /nobreak >nul

echo.
echo  ============================================
echo   Launching Jamboree on Display 2...
echo  ============================================
REM Launch VLC on Display 2 (Jamboree) — fullscreen, move to second monitor
start "" "C:\Program Files\VideoLAN\VLC\vlc.exe" --fullscreen --no-video-title-show --qt-start-minimized --one-instance --no-loop "C:\Users\tdell\OneDrive\Desktop\JACKOLANTERN"

timeout /t 2 /nobreak >nul

echo  Launching Graveyard on Display 3...
REM Launch second VLC instance on Display 3 (Graveyard)
start "" "C:\Program Files\VideoLAN\VLC\vlc.exe" --fullscreen --no-video-title-show --qt-start-minimized --no-one-instance --no-loop "C:\Users\tdell\OneDrive\Desktop\LEGENDS ATMOS"

timeout /t 1 /nobreak >nul

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
