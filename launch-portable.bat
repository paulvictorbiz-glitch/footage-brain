@echo off
REM ────────────────────────────────────────────────────────────────────────────
REM  Footage Brain – Portable Launch
REM  Entry point for a copied project folder on any Windows PC.
REM  All data lives under backend\portable_data\ (set by DATA_ROOT in .env).
REM
REM  What this script does:
REM    1. Checks Python, Node, ffmpeg are available
REM    2. Creates backend\.env from .env.portable.example if none exists
REM    3. Creates the Python venv and installs deps (once, cached after)
REM    4. Installs frontend npm packages (once, cached after)
REM    5. Builds the frontend to frontend\dist\ (once, skips if already built)
REM    6. Starts the backend server in a new window
REM    7. Opens http://localhost:8000 in your browser
REM ────────────────────────────────────────────────────────────────────────────

setlocal EnableDelayedExpansion

echo.
echo  ███████╗ ██████╗  ██████╗ ████████╗ █████╗  ██████╗ ███████╗
echo  ██╔════╝██╔═══██╗██╔═══██╗╚══██╔══╝██╔══██╗██╔════╝ ██╔════╝
echo  █████╗  ██║   ██║██║   ██║   ██║   ███████║██║  ███╗█████╗
echo  ██╔══╝  ██║   ██║██║   ██║   ██║   ██╔══██║██║   ██║██╔══╝
echo  ██║     ╚██████╔╝╚██████╔╝   ██║   ██║  ██║╚██████╔╝███████╗
echo  ╚═╝      ╚═════╝  ╚═════╝    ╚═╝   ╚═╝  ╚═╝ ╚═════╝ ╚══════╝
echo                           PORTABLE LAUNCH
echo.

set FATAL=0

REM ── Required: Python ─────────────────────────────────────────────────────────

python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python not found in PATH.
    echo         Install Python 3.11+ from https://python.org
    echo         Tick "Add Python to PATH" during install.
    echo.
    set FATAL=1
) else (
    for /f "tokens=*" %%v in ('python --version 2^>^&1') do echo  [OK] %%v
)

REM ── Required: Node.js ────────────────────────────────────────────────────────

node --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found in PATH.
    echo         Install Node 18+ from https://nodejs.org
    echo.
    set FATAL=1
) else (
    for /f "tokens=*" %%v in ('node --version 2^>^&1') do echo  [OK] Node %%v
)

if !FATAL! neq 0 (
    echo.
    echo  Fix the errors above then run this script again.
    echo  Run first-run-check.bat for a full environment report.
    pause & exit /b 1
)

REM ── Optional: ffmpeg ─────────────────────────────────────────────────────────

ffmpeg -version >nul 2>&1
if errorlevel 1 (
    echo.
    echo  [WARN] ffmpeg not found. Thumbnail and metadata extraction will fail.
    echo         Download from https://ffmpeg.org/download.html and add to PATH.
    echo         You can add it later — the rest of the app will still start.
    echo.
) else (
    echo  [OK] ffmpeg found
)

REM ── Environment file ─────────────────────────────────────────────────────────

echo.
echo  ── Setup ────────────────────────────────────────────────────────────────
echo.

if not exist backend\.env (
    if exist backend\.env.portable.example (
        echo  [INFO] No backend\.env found.
        echo         Creating from .env.portable.example (portable mode^) ...
        copy backend\.env.portable.example backend\.env >nul
        echo  [INFO] Created backend\.env
        echo.
        echo  IMPORTANT: Open backend\.env and set WHISPER_DEVICE=cpu if you
        echo             have no NVIDIA GPU, or keep cuda for GPU acceleration.
        echo.
        pause
    ) else (
        echo  [ERROR] No backend\.env and no .env.portable.example to copy from.
        pause & exit /b 1
    )
) else (
    echo  [OK] backend\.env exists
)

REM ── Python virtualenv ────────────────────────────────────────────────────────

if not exist backend\venv\Scripts\python.exe (
    echo  [INFO] Creating Python virtual environment...
    python -m venv backend\venv
    if errorlevel 1 (
        echo  [ERROR] Failed to create Python venv.
        pause & exit /b 1
    )
    echo  [OK] venv created
)

echo  [INFO] Verifying Python dependencies (this is fast if already installed)...
call backend\venv\Scripts\activate.bat
pip install -r backend\requirements.txt --quiet --disable-pip-version-check
if errorlevel 1 (
    echo.
    echo  [ERROR] pip install failed. Check your internet connection.
    echo          If offline, all packages must already be installed in the venv.
    pause & exit /b 1
)
echo  [OK] Python dependencies ready

REM ── Frontend node_modules ────────────────────────────────────────────────────

if not exist frontend\node_modules (
    echo  [INFO] Installing frontend npm packages (first time only^)...
    cd frontend
    call npm install --silent
    if errorlevel 1 (
        echo  [ERROR] npm install failed. Check your internet connection.
        cd ..
        pause & exit /b 1
    )
    cd ..
    echo  [OK] npm packages installed
) else (
    echo  [OK] node_modules present
)

REM ── Frontend production build ────────────────────────────────────────────────

if not exist frontend\dist\index.html (
    echo  [INFO] Building frontend for production (first time only^)...
    cd frontend
    call npm run build
    if errorlevel 1 (
        echo.
        echo  [ERROR] Frontend build failed. See TypeScript errors above.
        cd ..
        pause & exit /b 1
    )
    cd ..
    echo  [OK] Frontend built  ^→  frontend\dist\
) else (
    echo  [OK] Frontend build present
)

REM ── Launch backend ────────────────────────────────────────────────────────────

echo.
echo  ── Starting ─────────────────────────────────────────────────────────────
echo.
echo  Starting Footage Brain on http://localhost:8000 ...

start "Footage Brain" cmd /k "cd backend && call venv\Scripts\activate.bat && python -m uvicorn app.main:app --host 0.0.0.0 --port 8000"

echo  Waiting for server to initialize...
timeout /t 5 /nobreak >nul

start "" "http://localhost:8000"

echo.
echo  ────────────────────────────────────────────────────────────────────────
echo   Footage Brain is running.
echo   Open http://localhost:8000 in your browser.
echo.
echo   If footage drives show OFFLINE in Sources:
echo     Run relink-sources.bat to map old drive paths to new letters.
echo.
echo   To resume indexing after a move:
echo     Run resume-ingest.bat
echo  ────────────────────────────────────────────────────────────────────────
echo.
pause
