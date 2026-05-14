@echo off
REM ────────────────────────────────────────────────────────────────────────────
REM  Footage Brain – First-Run Diagnostic
REM
REM  Prints a status report for every requirement.
REM  Does NOT install, modify, or delete anything.
REM  Run this to diagnose issues before or after copying to a new PC.
REM ────────────────────────────────────────────────────────────────────────────

setlocal EnableDelayedExpansion

echo.
echo  Footage Brain – Environment Diagnostic
echo  ════════════════════════════════════════════════════════════════════════
echo.
echo  ── Runtime tools ────────────────────────────────────────────────────────
echo.

set PASS=0
set WARN=0
set FAIL=0

REM ── Python ────────────────────────────────────────────────────────────────────

python --version >nul 2>&1
if errorlevel 1 (
    echo  [FAIL] Python ............. NOT FOUND
    echo         Install Python 3.11+ from https://python.org
    echo         Tick "Add Python to PATH" during install.
    echo.
    set /a FAIL+=1
) else (
    for /f "tokens=*" %%v in ('python --version 2^>^&1') do (
        echo  [OK]   Python ............. %%v
    )
    set /a PASS+=1
)

REM ── Node.js (only needed if frontend\dist\ is not pre-built) ─────────────────

if exist frontend\dist\index.html (
    echo  [OK]   Node.js ............ not needed ^(frontend already built^)
    set /a PASS+=1
) else (
    node --version >nul 2>&1
    if errorlevel 1 (
        echo  [FAIL] Node.js ............ NOT FOUND
        echo         Needed to build the frontend UI (one-time^).
        echo         Install Node 18+ from https://nodejs.org
        echo         Or copy frontend\dist\ from a machine where it was built.
        set /a FAIL+=1
    ) else (
        for /f "tokens=*" %%v in ('node --version 2^>^&1') do (
            echo  [OK]   Node.js ............ %%v ^(will build frontend^)
        )
        set /a PASS+=1
    )
)

REM ── ffmpeg ────────────────────────────────────────────────────────────────────

if exist backend\tools\ffmpeg.exe (
    echo  [OK]   ffmpeg ............. backend\tools\ffmpeg.exe ^(bundled^)
    set /a PASS+=1
) else (
    ffmpeg -version >nul 2>&1
    if errorlevel 1 (
        echo  [WARN] ffmpeg ............. NOT FOUND
        echo         launch-portable.bat will install it automatically via winget.
        echo         Or place ffmpeg.exe + ffprobe.exe in backend\tools\
        set /a WARN+=1
    ) else (
        echo  [OK]   ffmpeg ............. found in PATH
        set /a PASS+=1
    )
)

REM ── NVIDIA GPU ───────────────────────────────────────────────────────────────

nvidia-smi >nul 2>&1
if errorlevel 1 (
    echo  [WARN] NVIDIA GPU ......... not detected
    echo         Transcription will run on CPU ^(slower^).
    echo         Set WHISPER_DEVICE=cpu in backend\.env if you have no GPU.
    set /a WARN+=1
) else (
    for /f "skip=1 delims=" %%v in ('nvidia-smi --query-gpu^=name --format^=csv^,noheader 2^>nul') do (
        echo  [OK]   NVIDIA GPU ......... %%v
        set /a PASS+=1
        goto :gpu_done
    )
    for /f "delims=" %%v in ('nvidia-smi --query-gpu^=name --format^=csv^,noheader 2^>nul') do (
        echo  [OK]   NVIDIA GPU ......... %%v
        set /a PASS+=1
        goto :gpu_done
    )
    :gpu_done
)

echo.
echo  ── Project files ────────────────────────────────────────────────────────
echo.

REM ── Python venv ──────────────────────────────────────────────────────────────

if exist backend\venv\Scripts\python.exe (
    echo  [OK]   Python venv ........ backend\venv
    set /a PASS+=1
) else (
    echo  [FAIL] Python venv ........ NOT FOUND at backend\venv
    echo         Run launch-portable.bat — it creates the venv automatically.
    set /a FAIL+=1
)

REM ── Key Python packages ───────────────────────────────────────────────────────

if exist backend\venv\Lib\site-packages\fastapi (
    echo  [OK]   Python packages .... installed
    set /a PASS+=1
) else (
    echo  [FAIL] Python packages .... NOT INSTALLED
    echo         Run launch-portable.bat — it runs pip install automatically.
    set /a FAIL+=1
)

REM ── Frontend node_modules ────────────────────────────────────────────────────

if exist frontend\node_modules (
    echo  [OK]   node_modules ....... frontend\node_modules
    set /a PASS+=1
) else (
    echo  [FAIL] node_modules ....... NOT FOUND
    echo         Run launch-portable.bat — it runs npm install automatically.
    set /a FAIL+=1
)

REM ── Frontend production build ────────────────────────────────────────────────

if exist frontend\dist\index.html (
    echo  [OK]   Frontend build ..... frontend\dist\index.html
    set /a PASS+=1
) else (
    echo  [WARN] Frontend build ..... NOT FOUND
    echo         The browser UI will not load until a build exists.
    echo         Run launch-portable.bat — it builds automatically.
    set /a WARN+=1
)

echo.
echo  ── Configuration ────────────────────────────────────────────────────────
echo.

REM ── .env ─────────────────────────────────────────────────────────────────────

if exist backend\.env (
    echo  [OK]   backend\.env ....... found
    set /a PASS+=1

    REM Check DATA_ROOT
    findstr /r /i "^DATA_ROOT=" backend\.env >nul 2>&1
    if errorlevel 1 (
        echo  [WARN] DATA_ROOT ........ not set in backend\.env
        echo         Storage will use dev defaults ^(./data/^) not portable_data.
        echo         For portable mode, copy .env.portable.example to backend\.env
        set /a WARN+=1
    ) else (
        for /f "tokens=2 delims==" %%v in ('findstr /r /i "^DATA_ROOT=" backend\.env') do (
            echo  [OK]   DATA_ROOT ........ %%v
            set /a PASS+=1
        )
    )

    REM Check WHISPER_DEVICE
    for /f "tokens=2 delims==" %%v in ('findstr /r /i "^WHISPER_DEVICE=" backend\.env 2^>nul') do (
        echo  [OK]   WHISPER_DEVICE ... %%v
    )

    REM Check WHISPER_COMPUTE_TYPE
    for /f "tokens=2 delims==" %%v in ('findstr /r /i "^WHISPER_COMPUTE_TYPE=" backend\.env 2^>nul') do (
        echo  [OK]   WHISPER_COMPUTE_TYPE %%v
    )
) else (
    echo  [FAIL] backend\.env ....... NOT FOUND
    echo         Run launch-portable.bat — it copies .env.portable.example.
    set /a FAIL+=1
)

echo.
echo  ── Data directories ─────────────────────────────────────────────────────
echo.

REM ── portable_data ────────────────────────────────────────────────────────────

for %%d in (
    "backend\portable_data"
    "backend\portable_data\thumbnails"
    "backend\portable_data\chroma"
    "backend\portable_data\models"
    "backend\portable_data\logs"
) do (
    if exist %%d (
        echo  [OK]   %%~d
    ) else (
        echo  [INFO] %%~d  ^(created automatically on first launch^)
    )
)

REM ── Database file ─────────────────────────────────────────────────────────────

echo.
set DB_FOUND=0
for %%f in (
    "backend\portable_data\footage_brain.db"
    "backend\footage_brain.db"
) do (
    if exist %%f (
        for %%s in (%%f) do (
            set DBSIZE=%%~zs
            set /a DBMB=!DBSIZE! / 1048576
        )
        echo  [OK]   %%~f  ^(!DBMB! MB^)
        set DB_FOUND=1
        set /a PASS+=1
    )
)
if !DB_FOUND! equ 0 (
    echo  [INFO] No database found yet  ^(created automatically on first launch^)
)

REM ── Model cache ───────────────────────────────────────────────────────────────

set MODELS_FOUND=0
for %%d in (
    "backend\portable_data\models\hub"
    "backend\portable_data\models\sentence-transformers"
) do (
    if exist %%d (
        echo  [OK]   %%~d
        set MODELS_FOUND=1
    )
)
if !MODELS_FOUND! equ 0 (
    echo  [INFO] Model cache not found — models will download on first ingest ^(~5 GB^)
    echo         Copy portable_data\models\ from another machine to skip the download.
)

REM ── Backend reachable? ───────────────────────────────────────────────────────

echo.
echo  ── Backend status ───────────────────────────────────────────────────────
echo.

powershell -NoProfile -Command ^
  "try { $r = Invoke-RestMethod 'http://localhost:8765/health' -TimeoutSec 2; Write-Host '  [OK]   Backend is RUNNING at http://localhost:8765' } catch { Write-Host '  [INFO] Backend is not running  (start with launch-portable.bat)' }" 2>nul

REM ── Summary ───────────────────────────────────────────────────────────────────

echo.
echo  ════════════════════════════════════════════════════════════════════════
echo   PASSED : !PASS!   WARNINGS : !WARN!   FAILED : !FAIL!
echo  ════════════════════════════════════════════════════════════════════════
echo.

if !FAIL! gtr 0 (
    echo  Action: Fix the FAIL items above, then run launch-portable.bat.
) else if !WARN! gtr 0 (
    echo  Action: Review WARN items above, then run launch-portable.bat.
) else (
    echo  Action: All checks passed. Run launch-portable.bat to start.
)

echo.
pause
