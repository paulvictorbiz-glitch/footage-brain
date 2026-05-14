@echo off
REM ────────────────────────────────────────────────────────────────────────────
REM  Footage Brain – Portable Launch
REM  Double-click this file to start Footage Brain on any Windows PC.
REM
REM  What this script does automatically:
REM    1. Checks Python 3.11+ is installed (only hard requirement)
REM    2. Auto-detects your GPU and writes the right .env settings
REM    3. Installs ffmpeg locally if not already present
REM    4. Creates the Python virtual environment (once)
REM    5. Installs Python packages (once, from internet)
REM    6. Builds the frontend UI if not already built
REM    7. Starts the app and opens your browser
REM ────────────────────────────────────────────────────────────────────────────

setlocal EnableDelayedExpansion

echo.
echo  ████████╗ ██████╗  ██████╗ ████████╗ █████╗  ██████╗ ███████╗
echo  ██╔════╝██╔═══██╗██╔═══██╗╚══██╔══╝██╔══██╗██╔════╝ ██╔════╝
echo  █████╗  ██║   ██║██║   ██║   ██║   ███████║██║  ███╗█████╗
echo  ██╔══╝  ██║   ██║██║   ██║   ██║   ██╔══██║██║   ██║██╔══╝
echo  ██║     ╚██████╔╝╚██████╔╝   ██║   ██║  ██║╚██████╔╝███████╗
echo  ╚═╝      ╚═════╝  ╚═════╝    ╚═╝   ╚═╝  ╚═╝ ╚═════╝ ╚══════╝
echo.
echo  Starting up — this may take a few minutes the first time.
echo.

REM ── Step 1: Python (required) ─────────────────────────────────────────────

python --version >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Python was not found.
    echo.
    echo  Please install Python 3.11 from https://python.org
    echo  During install, tick the box "Add Python to PATH"
    echo  Then run this script again.
    echo.
    pause & exit /b 1
)
for /f "tokens=*" %%v in ('python --version 2^>^&1') do echo  [OK] %%v

REM ── Step 2: Auto-detect GPU and write .env if missing ─────────────────────

if not exist backend\.env (
    echo.
    echo  Setting up configuration for this computer...

    set WHISPER_DEVICE=cpu
    set WHISPER_COMPUTE=int8

    nvidia-smi >nul 2>&1
    if not errorlevel 1 (
        REM GPU found — check VRAM to pick compute type
        set WHISPER_DEVICE=cuda
        set WHISPER_COMPUTE=int8_float16
        for /f "delims=" %%v in ('nvidia-smi --query-gpu^=name --format^=csv^,noheader 2^>nul') do (
            echo  [OK] NVIDIA GPU detected: %%v
            echo       Using GPU acceleration for transcription.
        )
    ) else (
        echo  [OK] No NVIDIA GPU detected — transcription will use CPU.
        echo       This is slower but works fine.
    )

    if exist backend\.env.portable.example (
        copy backend\.env.portable.example backend\.env >nul

        REM Patch WHISPER_DEVICE in the copied .env
        powershell -NoProfile -Command ^
          "(Get-Content backend\.env) -replace '^WHISPER_DEVICE=.*', 'WHISPER_DEVICE=!WHISPER_DEVICE!' -replace '^WHISPER_COMPUTE_TYPE=.*', 'WHISPER_COMPUTE_TYPE=!WHISPER_COMPUTE!' | Set-Content backend\.env"

        echo  [OK] Configuration file created (backend\.env)
    ) else (
        echo  [ERROR] Cannot find backend\.env.portable.example
        echo          The project folder may be incomplete.
        pause & exit /b 1
    )
) else (
    echo  [OK] Configuration file found (backend\.env)
)

REM ── Step 3: ffmpeg ───────────────────────────────────────────────────────

echo.
echo  Checking for ffmpeg...

set FFMPEG_OK=0

REM Check bundled location first
if exist backend\tools\ffmpeg.exe (
    echo  [OK] ffmpeg found in backend\tools\ (bundled)
    set FFMPEG_OK=1
    goto :ffmpeg_done
)

REM Check PATH
ffmpeg -version >nul 2>&1
if not errorlevel 1 (
    echo  [OK] ffmpeg found in PATH
    set FFMPEG_OK=1
    goto :ffmpeg_done
)

REM Not found — try to install via winget
echo  [INFO] ffmpeg not found. Installing automatically via winget...
echo         (This is a one-time install. It may take 1-2 minutes.)
echo.
winget install --id Gyan.FFmpeg -e --silent --accept-package-agreements --accept-source-agreements >nul 2>&1
if not errorlevel 1 (
    REM winget installs to PATH but PATH refresh needs new shell — check again
    ffmpeg -version >nul 2>&1
    if not errorlevel 1 (
        echo  [OK] ffmpeg installed and ready.
        set FFMPEG_OK=1
    ) else (
        echo  [OK] ffmpeg installed. It will be active after this window closes.
        echo       If video processing fails, restart this script once.
        set FFMPEG_OK=1
    )
    goto :ffmpeg_done
)

REM winget failed — show manual instructions
echo.
echo  [WARN] Could not install ffmpeg automatically.
echo.
echo  Please install ffmpeg manually:
echo    1. Go to https://ffmpeg.org/download.html
echo    2. Download the Windows "essentials" build
echo    3. Extract it and copy ffmpeg.exe + ffprobe.exe into:
echo       %~dp0backend\tools\
echo    4. Run this script again.
echo.
echo  The app will start without ffmpeg, but video thumbnails and
echo  transcription will not work until ffmpeg is installed.
echo.
pause

:ffmpeg_done

REM ── Step 4: Python virtual environment ────────────────────────────────────

echo.
if not exist backend\venv\Scripts\python.exe (
    echo  [INFO] Setting up Python environment (first time — takes 1-3 minutes)...
    python -m venv backend\venv
    if errorlevel 1 (
        echo.
        echo  [ERROR] Failed to create Python environment.
        echo          Make sure Python 3.11+ is installed correctly.
        pause & exit /b 1
    )
    echo  [OK] Python environment created.
) else (
    echo  [OK] Python environment ready.
)

echo  [INFO] Installing Python packages (first time may take 5-10 minutes)...
call backend\venv\Scripts\activate.bat
pip install -r backend\requirements.txt --quiet --disable-pip-version-check 2>&1
if errorlevel 1 (
    echo.
    echo  [ERROR] Failed to install Python packages.
    echo          Check your internet connection and try again.
    pause & exit /b 1
)
echo  [OK] Python packages ready.

REM ── Step 5: Frontend UI ───────────────────────────────────────────────────

echo.
if exist frontend\dist\index.html (
    echo  [OK] Frontend UI ready (pre-built).
) else (
    REM Frontend not pre-built — need Node.js to build it
    node --version >nul 2>&1
    if errorlevel 1 (
        echo  [ERROR] The frontend UI has not been built yet, and Node.js
        echo          is not installed to build it automatically.
        echo.
        echo  Options:
        echo    A) Install Node.js 18+ from https://nodejs.org then run this script again.
        echo    B) Copy frontend\dist\ from a machine where it was already built.
        echo.
        pause & exit /b 1
    )

    echo  [INFO] Building frontend UI (first time — takes 1-2 minutes)...
    cd frontend
    call npm install --silent 2>&1
    if errorlevel 1 (
        echo  [ERROR] npm install failed. Check your internet connection.
        cd ..
        pause & exit /b 1
    )
    call npm run build 2>&1
    if errorlevel 1 (
        echo  [ERROR] Frontend build failed. See errors above.
        cd ..
        pause & exit /b 1
    )
    cd ..
    echo  [OK] Frontend UI built.
)

REM ── Step 6: Launch ────────────────────────────────────────────────────────

echo.
echo  ════════════════════════════════════════════════════════════════════════
echo   Starting Footage Brain...
echo  ════════════════════════════════════════════════════════════════════════
echo.

start "Footage Brain" cmd /k "cd backend && call venv\Scripts\activate.bat && python -m uvicorn app.main:app --host 0.0.0.0 --port 8000"

echo  Waiting for the server to start...
timeout /t 6 /nobreak >nul

REM Open browser
start "" "http://localhost:8000"

echo.
echo  ════════════════════════════════════════════════════════════════════════
echo   Footage Brain is running at http://localhost:8000
echo.
echo   NEXT STEPS:
echo     - Add your footage folder in the app under Sources
echo     - If footage shows as OFFLINE: run relink-sources.bat
echo     - To resume a paused index job: run resume-ingest.bat
echo.
echo   Keep the "Footage Brain" terminal window open while using the app.
echo   Close it to stop the server.
echo  ════════════════════════════════════════════════════════════════════════
echo.
pause
