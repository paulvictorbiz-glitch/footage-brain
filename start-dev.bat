@echo off
REM ──────────────────────────────────────────────────────────────────────────
REM  Footage Brain – Windows Local Dev Startup
REM  Run this from the project root. Starts backend + frontend in two windows.
REM ──────────────────────────────────────────────────────────────────────────

echo.
echo  ███████╗ ██████╗  ██████╗ ████████╗ █████╗  ██████╗ ███████╗
echo  ██╔════╝██╔═══██╗██╔═══██╗╚══██╔══╝██╔══██╗██╔════╝ ██╔════╝
echo  █████╗  ██║   ██║██║   ██║   ██║   ███████║██║  ███╗█████╗
echo  ██╔══╝  ██║   ██║██║   ██║   ██║   ██╔══██║██║   ██║██╔══╝
echo  ██║     ╚██████╔╝╚██████╔╝   ██║   ██║  ██║╚██████╔╝███████╗
echo  ╚═╝      ╚═════╝  ╚═════╝    ╚═╝   ╚═╝  ╚═╝ ╚═════╝ ╚══════╝
echo                             BRAIN
echo.
echo  Starting development servers...
echo  Backend → http://localhost:8765
echo  Frontend → http://localhost:5173
echo.

REM Check Python
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python not found. Please install Python 3.11+
    pause
    exit /b 1
)

REM Check Node
node --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found. Please install Node 18+
    pause
    exit /b 1
)

REM Check ffmpeg
ffmpeg -version >nul 2>&1
if errorlevel 1 (
    echo [WARNING] ffmpeg not found in PATH.
    echo           Download from https://ffmpeg.org/download.html and add to PATH
    echo           Metadata extraction will fail without it.
    echo.
)

REM Create .env if missing
if not exist backend\.env (
    echo [INFO] Creating backend\.env from .env.example
    copy backend\.env.example backend\.env
)

REM Create virtualenv if missing
if not exist backend\venv (
    echo [INFO] Creating Python virtualenv...
    python -m venv backend\venv
)

REM Install Python deps
echo [INFO] Installing Python dependencies...
call backend\venv\Scripts\activate.bat
pip install -r backend\requirements.txt --quiet

REM Install frontend deps
if not exist frontend\node_modules (
    echo [INFO] Installing frontend dependencies...
    cd frontend
    npm install
    cd ..
)

REM Start backend in new window
echo [INFO] Starting backend...
start "Footage Brain – Backend" cmd /k "cd backend && call venv\Scripts\activate.bat && python -m uvicorn app.main:app --host 0.0.0.0 --port 8765"

REM Wait a moment for backend to initialize
timeout /t 3 /nobreak >nul

REM Start frontend in new window
echo [INFO] Starting frontend...
start "Footage Brain – Frontend" cmd /k "cd frontend && npm run dev"

echo.
echo  [OK] Both servers starting...
echo  Open http://localhost:5173 in your browser.
echo  Press Ctrl+C in each window to stop.
echo.
pause
