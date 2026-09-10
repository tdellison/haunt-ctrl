@echo off
cd C:\Users\tdell\haunt-ctrl-v3
echo.
echo  ============================================
echo   HAUNT CTRL v3 - UPDATING...
echo  ============================================

REM ---------------------------------------------------------------------------
REM The update below used to be an unconditional "git reset --hard", which
REM DELETED any local work that had not been pushed yet - uncommitted edits and
REM local commits both. It cost a full evening once. Now the reset only happens
REM when there is genuinely nothing local to lose.
REM ---------------------------------------------------------------------------

set SAFE=1

REM Uncommitted changes in the working tree?
git diff --quiet HEAD 2>nul
if errorlevel 1 (
  set SAFE=0
  echo  [SKIP] Uncommitted changes present - not resetting.
)

REM Commits here that are not on the remote?
for /f %%i in ('git rev-list --count origin/master..HEAD 2^>nul') do set AHEAD=%%i
if not "%AHEAD%"=="0" (
  set SAFE=0
  echo  [SKIP] %AHEAD% local commit^(s^) not pushed - not resetting.
)

if "%SAFE%"=="1" (
  git fetch origin master
  git reset --hard origin/master
  echo  Updated to latest origin/master.
) else (
  echo.
  echo  Local work is NOT on GitHub. Starting with the files as they are.
  echo  Push when you can:  git push -u origin master
  echo.
)

REM Generate skeleton + witch test voices if they don't exist yet
if not exist "C:\Users\tdell\OneDrive\Desktop\SKELETON\skeleton-left.wav" (
  echo  Generating test voices...
  powershell -ExecutionPolicy Bypass -File "%~dp0make-skeleton-voices.ps1"
)
if not exist "C:\Users\tdell\OneDrive\Desktop\WITCH\witch-main-left.wav" (
  echo  Generating witch test voices...
  powershell -ExecutionPolicy Bypass -File "%~dp0make-skeleton-voices.ps1"
)
echo.
echo  ============================================
echo   HAUNT CTRL v3 - SERVER STARTING...
echo   Open on iPhone: http://192.168.1.168:3000
echo  ============================================
echo.
start http://192.168.1.168:3000
node server.js
echo.
echo  ============================================
echo   SERVER STOPPED - see error above
echo  ============================================
pause
