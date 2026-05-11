@echo off
REM ──────────────────────────────────────────────────────────────────────────
REM  Footage Brain – Production Mode
REM  Builds the frontend once, then serves everything from the backend.
REM  No Vite dev server needed. Open http://localhost:8000
REM ──────────────────────────────────────────────────────────────────────────

echo.
echo  ███████╗ ██████╗  ██████╗ ████████╗ █████╗  ██████╗ ███████╗
echo  ██╔════╝██╔═══██╗██╔═══██╗╚══██╔══╝██╔══██╗██╔════╝ ██╔════╝
echo  █████╗  ██║   ██║██║   ██║   ██║   ███████║██║  ███╗█████╗
echo  ██╔══╝  ██║   ██║██║   ██║   ██║   ██╔══██║██║   ██║██╔══╝
echo  ██║     ╚██████╔╝╚██████╔╝   ██║   ██║  ██║╚██████╔╝███████╗
echo  ╚═╝      ╚═════╝  ╚═════╝    ╚═╝   ╚═╝  ╚═╝ ╚═════╝ ╚══════╝
echo                          PRODUCTION MODE
echo.

REM ── Preflight checks ──────────────────────────────────────────────────────

python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python not found. Install Python 3.11+ and add to PATH.
    pause & exit /b 1
)

node --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found. Install Node 18+ and add to PATH.
    pause & exit /b 1
)

ffmpeg -version >nul 2>&1
if errorlevel 1 (
    echo [WARNING] ffmpeg not found in PATH. Metadata extraction will fail.
    echo           Download from https://ffmpeg.org/download.html
    echo.
)

if not exist backend\venv (
    echo [ERROR] Python venv not found at backend\venv
    echo         Run start-dev.bat first, or:
    echo           cd backend
    echo           python -m venv venv
    echo           venv\Scripts\activate
    echo           pip install -r requirements.txt
    pause & exit /b 1
)

if not exist frontend\node_modules (
    echo [ERROR] node_modules not found at frontend\node_modules
    echo         Run start-dev.bat first, or: cd frontend ^&^& npm install
    pause & exit /b 1
)

if not exist backend\.env (
    echo [INFO] Creating backend\.env from .env.example ...
    copy backend\.env.example backend\.env
)

REM ── Step 1: Build frontend ─────────────────────────────────────────────────

echo [1/2] Building frontend (tsc + vite build)...
cd frontend
call npm run build
if errorlevel 1 (
    echo.
    echo [ERROR] Frontend build failed. Fix TypeScript errors above and retry.
    cd ..
    pause & exit /b 1
)
cd ..
echo [1/2] Frontend built OK  →  frontend\dist\
echo.

REM ── Step 2: Start backend (serves both API and built frontend) ─────────────

echo [2/2] Starting backend on http://localhost:8000 ...
echo       The UI will be available at http://localhost:8000
echo       Press Ctrl+C in the server window to stop.
echo.
start "Footage Brain" cmd /k "cd backend && call venv\Scripts\activate.bat && python -m uvicorn app.main:app --host 0.0.0.0 --port 8000"

REM Give the server a moment to start, then open the browser
timeout /t 3 /nobreak >nul
start "" "http://localhost:8000"

echo [OK] Server starting. Browser opening at http://localhost:8000
echo.
pause
