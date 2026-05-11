@echo off
REM ────────────────────────────────────────────────────────────────────────────
REM  Footage Brain – Resume Ingest
REM
REM  Use this to:
REM    - Restart the ingest worker after a server restart
REM    - Unpause jobs that were paused
REM    - Optionally scan source roots to pick up new or changed files
REM
REM  Safe to run at any time — idempotent, will not duplicate work.
REM  Requires: backend must be running (launch-portable.bat)
REM ────────────────────────────────────────────────────────────────────────────

setlocal EnableDelayedExpansion

echo.
echo  Footage Brain – Resume Ingest
echo  ════════════════════════════════════════════════════════════════════════
echo.

REM ── Check backend is reachable ────────────────────────────────────────────────

powershell -NoProfile -Command ^
  "try { Invoke-RestMethod 'http://localhost:8000/health' -TimeoutSec 3 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Backend is not running.
    echo          Start launch-portable.bat first, then run this script.
    echo.
    pause & exit /b 1
)
echo  [OK] Backend is running.
echo.

REM ── Unpause any paused jobs ───────────────────────────────────────────────────

echo  Unpausing jobs (if any were paused)...
powershell -NoProfile -Command ^
  "try { Invoke-RestMethod -Method POST 'http://localhost:8000/api/dashboard/jobs/resume' | Out-Null; Write-Host '  [OK] Jobs unpaused.' } catch { Write-Host ('  [INFO] ' + $_.Exception.Message) }" 2>nul

REM ── Start / wake the worker ───────────────────────────────────────────────────

echo  Waking ingest worker...
powershell -NoProfile -Command ^
  "try { Invoke-RestMethod -Method POST 'http://localhost:8000/api/dashboard/start-worker' | Out-Null; Write-Host '  [OK] Worker running.' } catch { Write-Host ('  [WARN] ' + $_.Exception.Message) }" 2>nul

echo.

REM ── Optional: scan source roots ───────────────────────────────────────────────

echo  Do you want to scan source roots for new or changed files?
echo  (Choose Y if you added footage to a drive or moved files.)
echo.
set /p DO_SCAN=  Scan all sources? (Y/N):

if /i "!DO_SCAN!"=="Y" (
    echo.
    echo  Scanning all source roots...

    echo $r = Invoke-RestMethod -Method POST 'http://localhost:8000/api/sources/scan-all' > "%TEMP%\fb_scan.ps1"
    echo Write-Host ('  [OK] Scan complete.') >> "%TEMP%\fb_scan.ps1"
    echo if ($r.summaries) { >> "%TEMP%\fb_scan.ps1"
    echo     foreach ($s in $r.summaries) { >> "%TEMP%\fb_scan.ps1"
    echo         $root   = if ($s.root_path) { $s.root_path } elseif ($s.root) { $s.root } else { '(unknown)' } >> "%TEMP%\fb_scan.ps1"
    echo         $newf   = if ($null -ne $s.new_files)   { $s.new_files }   else { 0 } >> "%TEMP%\fb_scan.ps1"
    echo         $skipf  = if ($null -ne $s.skipped)     { $s.skipped }     else { 0 } >> "%TEMP%\fb_scan.ps1"
    echo         $remf   = if ($null -ne $s.removed)     { $s.removed }     else { 0 } >> "%TEMP%\fb_scan.ps1"
    echo         Write-Host ("    " + $root) >> "%TEMP%\fb_scan.ps1"
    echo         Write-Host ("      new: " + $newf + "   skipped: " + $skipf + "   removed: " + $remf) >> "%TEMP%\fb_scan.ps1"
    echo     } >> "%TEMP%\fb_scan.ps1"
    echo } >> "%TEMP%\fb_scan.ps1"

    powershell -NoProfile -ExecutionPolicy Bypass -File "%TEMP%\fb_scan.ps1"
    del "%TEMP%\fb_scan.ps1" 2>nul
    echo.
)

REM ── Show current job queue ────────────────────────────────────────────────────

echo  ── Job queue ────────────────────────────────────────────────────────────
echo.

echo $q = Invoke-RestMethod 'http://localhost:8000/api/dashboard/jobs' > "%TEMP%\fb_queue.ps1"
echo Write-Host '  Stage               Pending' >> "%TEMP%\fb_queue.ps1"
echo Write-Host '  ─────────────────── ───────' >> "%TEMP%\fb_queue.ps1"
echo foreach ($p in $q.queue_stats.PSObject.Properties) { >> "%TEMP%\fb_queue.ps1"
echo     Write-Host ('  ' + $p.Name.PadRight(19) + ' ' + $p.Value) >> "%TEMP%\fb_queue.ps1"
echo } >> "%TEMP%\fb_queue.ps1"
echo Write-Host '' >> "%TEMP%\fb_queue.ps1"
echo Write-Host ('  Currently processing : ' + $q.processing.Count) >> "%TEMP%\fb_queue.ps1"
echo Write-Host ('  Failed (need retry)  : ' + $q.failed.Count) >> "%TEMP%\fb_queue.ps1"
echo if ($q.failed.Count -gt 0) { >> "%TEMP%\fb_queue.ps1"
echo     Write-Host '' >> "%TEMP%\fb_queue.ps1"
echo     Write-Host '  Failed jobs (first 5):' >> "%TEMP%\fb_queue.ps1"
echo     $q.failed | Select-Object -First 5 | ForEach-Object { >> "%TEMP%\fb_queue.ps1"
echo         Write-Host ('    stage=' + $_.stage + '  file=' + $_.video_file_id) >> "%TEMP%\fb_queue.ps1"
echo         if ($_.error_message) { Write-Host ('    error: ' + $_.error_message) } >> "%TEMP%\fb_queue.ps1"
echo     } >> "%TEMP%\fb_queue.ps1"
echo } >> "%TEMP%\fb_queue.ps1"

powershell -NoProfile -ExecutionPolicy Bypass -File "%TEMP%\fb_queue.ps1"
del "%TEMP%\fb_queue.ps1" 2>nul

echo.
echo  ── Sources online status ────────────────────────────────────────────────
echo.

echo $sources = Invoke-RestMethod 'http://localhost:8000/api/sources' > "%TEMP%\fb_src.ps1"
echo foreach ($s in $sources) { >> "%TEMP%\fb_src.ps1"
echo     $icon = if ($s.is_online) { '[ONLINE ]' } else { '[OFFLINE]' } >> "%TEMP%\fb_src.ps1"
echo     $fc   = if ($null -ne $s.file_count) { $s.file_count } else { 0 } >> "%TEMP%\fb_src.ps1"
echo     Write-Host ('  ' + $icon + '  ' + $s.path + '  (' + $fc + ' files)') >> "%TEMP%\fb_src.ps1"
echo } >> "%TEMP%\fb_src.ps1"
echo if ($sources | Where-Object { -not $_.is_online }) { >> "%TEMP%\fb_src.ps1"
echo     Write-Host '' >> "%TEMP%\fb_src.ps1"
echo     Write-Host '  OFFLINE sources detected. Run relink-sources.bat to remap paths.' >> "%TEMP%\fb_src.ps1"
echo } >> "%TEMP%\fb_src.ps1"

powershell -NoProfile -ExecutionPolicy Bypass -File "%TEMP%\fb_src.ps1"
del "%TEMP%\fb_src.ps1" 2>nul

echo.
echo  ── Done ─────────────────────────────────────────────────────────────────
echo.
echo  Ingest is running.
echo  Monitor progress at http://localhost:8000 (Dashboard tab).
echo.
echo  If sources show OFFLINE:  run relink-sources.bat
echo  If jobs keep failing:     check the Logs tab in the UI or
echo                            backend\portable_data\logs\footage_brain.log
echo.
pause
