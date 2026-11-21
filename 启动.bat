@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title ICBC Gold Tracker

rem Usage: double-click to start; or run: start.bat [PORT]
rem Example: start.bat 9000   (custom port)
rem Stop: press Ctrl+C in this window

set "PORT=%~1"
if "%PORT%"=="" set "PORT=8765"

echo.
echo  ============================================================
echo   ICBC Gold Tracker (MySQL edition) - Launcher
echo   URL: http://127.0.0.1:%PORT%
echo   Background collector keeps recording even if browser is closed.
echo   Keep this window OPEN to keep recording. Ctrl+C to stop.
echo  ============================================================
echo.

rem ---------- 1. Locate Python (>= 3.8) ----------
set "PY="
where py >nul 2>&1
if not errorlevel 1 (
  py -3 -c "import sys;sys.exit(0 if sys.version_info>=(3,8) else 1)" >nul 2>&1
  if not errorlevel 1 set "PY=py -3"
)
if not defined PY (
  where python >nul 2>&1
  if not errorlevel 1 (
    python -c "import sys;sys.exit(0 if sys.version_info>=(3,8) else 1)" >nul 2>&1
    if not errorlevel 1 set "PY=python"
  )
)
if not defined PY (
  where python3 >nul 2>&1
  if not errorlevel 1 (
    python3 -c "import sys;sys.exit(0 if sys.version_info>=(3,8) else 1)" >nul 2>&1
    if not errorlevel 1 set "PY=python3"
  )
)
if not defined PY goto NO_PYTHON
echo  [OK] Python: %PY%

rem ---------- 2. Check Python deps (auto-install if missing) ----------
%PY% -c "import pymysql, cryptography" >nul 2>&1
if errorlevel 1 (
  echo  [INFO] Installing pymysql + cryptography ...
  %PY% -m pip install pymysql cryptography --quiet
  %PY% -c "import pymysql, cryptography" >nul 2>&1
  if errorlevel 1 goto NO_DEPS
)
echo  [OK] Python deps: pymysql + cryptography

rem ---------- 3. Check MySQL reachable ----------
%PY% -c "import pymysql,json,os;c=json.load(open('db_config.json',encoding='utf-8')) if os.path.exists('db_config.json') else {};m=pymysql.connect(host=c.get('host','127.0.0.1'),port=int(c.get('port',3306)),user=c.get('user','root'),password=c.get('password','123456'),connect_timeout=4);m.close()" >nul 2>&1
if errorlevel 1 goto NO_MYSQL
echo  [OK] MySQL reachable

rem ---------- 4. Start ----------
netstat -ano | findstr /c:":%PORT% " | findstr /i "LISTENING" >nul 2>&1
if not errorlevel 1 echo  [WARN] Port %PORT% is in use. Try: start.bat 9000

echo  Starting server, opening browser... Press Ctrl+C to stop.
echo  ------------------------------------------------------------
start "" "http://127.0.0.1:%PORT%/"
%PY% server.py --port %PORT%
goto END

:NO_PYTHON
echo  [ERROR] Python 3.8+ not found.
echo.
echo  Install Python (any one):
echo    A. PowerShell (admin): winget install Python.Python.3.12
echo    B. Microsoft Store: search "Python 3.12"
echo    C. https://www.python.org/downloads/  (check "Add Python to PATH")
echo  Then double-click this script again.
echo.
goto END

:NO_DEPS
echo  [ERROR] Failed to install pymysql / cryptography.
echo  Run manually: %PY% -m pip install pymysql cryptography
goto END

:NO_MYSQL
echo  [ERROR] Cannot connect to MySQL.
echo  1. Make sure MySQL Server is running (port 3306).
echo  2. Check db_config.json host/port/user/password.
echo     Default: root / 123456 @ 127.0.0.1:3306
goto END

:END
echo.
pause
