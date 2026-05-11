@echo off
REM ────────────────────────────────────────────────────────────────────────────
REM  Footage Brain – Source Root Relinking
REM
REM  Use this when a footage drive letter changes (E: → F:) or footage moves
REM  to a different folder on a new machine.
REM
REM  What this does:
REM    - Rewrites abs_path prefixes in the database (bulk UPDATE)
REM    - Preserves all metadata, transcripts, and search embeddings
REM    - No re-ingest needed after relinking
REM
REM  Requires: backend must be running (launch-portable.bat)
REM ────────────────────────────────────────────────────────────────────────────

setlocal EnableDelayedExpansion

echo.
echo  Footage Brain – Relink Source Roots
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

REM ── List all source roots ─────────────────────────────────────────────────────

echo  Source roots registered in the database:
echo  ────────────────────────────────────────────────────────────────────────
echo.

echo $sources = Invoke-RestMethod 'http://localhost:8000/api/sources' > "%TEMP%\fb_ls.ps1"
echo if ($sources.Count -eq 0) { Write-Host '  (No source roots configured yet)'; exit 0 } >> "%TEMP%\fb_ls.ps1"
echo $i = 1 >> "%TEMP%\fb_ls.ps1"
echo foreach ($s in $sources) { >> "%TEMP%\fb_ls.ps1"
echo     $icon  = if ($s.is_online) { '[ONLINE ]' } else { '[OFFLINE]' } >> "%TEMP%\fb_ls.ps1"
echo     $fc    = if ($null -ne $s.file_count) { $s.file_count } else { 0 } >> "%TEMP%\fb_ls.ps1"
echo     $label = if ($s.label) { '  label: ' + $s.label } else { '' } >> "%TEMP%\fb_ls.ps1"
echo     Write-Host ("  " + $icon + "  " + $s.path + $label) >> "%TEMP%\fb_ls.ps1"
echo     Write-Host ("          files: " + $fc + "   id: " + $s.id) >> "%TEMP%\fb_ls.ps1"
echo     Write-Host "" >> "%TEMP%\fb_ls.ps1"
echo     $i++ >> "%TEMP%\fb_ls.ps1"
echo } >> "%TEMP%\fb_ls.ps1"

powershell -NoProfile -ExecutionPolicy Bypass -File "%TEMP%\fb_ls.ps1"
del "%TEMP%\fb_ls.ps1" 2>nul

echo  ────────────────────────────────────────────────────────────────────────
echo.

REM ── Prompt for source ID ──────────────────────────────────────────────────────

echo  Copy and paste the ID of the source root you want to relink from above.
echo  (Press Enter with no input to cancel.)
echo.
set /p ROOT_ID=  Source root ID:
if "!ROOT_ID!"=="" goto :cancelled

REM ── Prompt for new path ───────────────────────────────────────────────────────

echo.
echo  Enter the new path where this footage is now located.
echo  Examples:  F:\Footage        D:\Projects\Camera Files
echo.
set /p NEW_PATH=  New path:
if "!NEW_PATH!"=="" goto :cancelled

REM ── Set env vars for PowerShell ───────────────────────────────────────────────

set FB_ROOT_ID=!ROOT_ID!
set FB_NEW_PATH=!NEW_PATH!

REM ── Dry run ────────────────────────────────────────────────────────────────────

echo.
echo  ── Dry run preview (no changes made yet) ────────────────────────────────
echo.

echo $uri  = 'http://localhost:8000/api/sources/' + $env:FB_ROOT_ID + '/relink' > "%TEMP%\fb_dry.ps1"
echo $body = ConvertTo-Json @{ new_path = $env:FB_NEW_PATH; dry_run = $true } >> "%TEMP%\fb_dry.ps1"
echo try { >> "%TEMP%\fb_dry.ps1"
echo     $r = Invoke-RestMethod -Method POST -Uri $uri -ContentType 'application/json' -Body $body >> "%TEMP%\fb_dry.ps1"
echo     Write-Host ('  Old path            : ' + $r.old_path) >> "%TEMP%\fb_dry.ps1"
echo     Write-Host ('  New path            : ' + $r.new_path) >> "%TEMP%\fb_dry.ps1"
echo     Write-Host ('  Files to remap      : ' + $r.remapped) >> "%TEMP%\fb_dry.ps1"
echo     Write-Host ('  Unmatched (skipped) : ' + $r.unmatched) >> "%TEMP%\fb_dry.ps1"
echo     exit 0 >> "%TEMP%\fb_dry.ps1"
echo } catch { >> "%TEMP%\fb_dry.ps1"
echo     $msg = $_.Exception.Response.StatusCode.value__ >> "%TEMP%\fb_dry.ps1"
echo     Write-Host ('[ERROR] HTTP ' + $msg + ' - ' + $_.Exception.Message) >> "%TEMP%\fb_dry.ps1"
echo     exit 1 >> "%TEMP%\fb_dry.ps1"
echo } >> "%TEMP%\fb_dry.ps1"

powershell -NoProfile -ExecutionPolicy Bypass -File "%TEMP%\fb_dry.ps1"
set DRY_EXIT=%ERRORLEVEL%
del "%TEMP%\fb_dry.ps1" 2>nul

if %DRY_EXIT% neq 0 (
    echo.
    echo  Relink aborted — no changes made.
    pause & exit /b 1
)

echo.
echo  ── Confirm ──────────────────────────────────────────────────────────────
echo.
echo  Type YES (all caps) to commit the relink. Anything else cancels.
echo.
set /p CONFIRM=  Confirm:
if "!CONFIRM!" neq "YES" goto :cancelled

REM ── Commit ────────────────────────────────────────────────────────────────────

echo.
echo  ── Committing relink ────────────────────────────────────────────────────
echo.

echo $uri  = 'http://localhost:8000/api/sources/' + $env:FB_ROOT_ID + '/relink' > "%TEMP%\fb_commit.ps1"
echo $body = ConvertTo-Json @{ new_path = $env:FB_NEW_PATH; dry_run = $false } >> "%TEMP%\fb_commit.ps1"
echo try { >> "%TEMP%\fb_commit.ps1"
echo     $r = Invoke-RestMethod -Method POST -Uri $uri -ContentType 'application/json' -Body $body >> "%TEMP%\fb_commit.ps1"
echo     Write-Host ('  [OK] Relinked ' + $r.remapped + ' file records.') >> "%TEMP%\fb_commit.ps1"
echo     Write-Host ('  Old: ' + $r.old_path) >> "%TEMP%\fb_commit.ps1"
echo     Write-Host ('  New: ' + $r.new_path) >> "%TEMP%\fb_commit.ps1"
echo     if ($r.unmatched -gt 0) { >> "%TEMP%\fb_commit.ps1"
echo         Write-Host ('  [WARN] ' + $r.unmatched + ' files were not remapped (check backend logs)') >> "%TEMP%\fb_commit.ps1"
echo     } >> "%TEMP%\fb_commit.ps1"
echo     exit 0 >> "%TEMP%\fb_commit.ps1"
echo } catch { >> "%TEMP%\fb_commit.ps1"
echo     $msg = $_.Exception.Response.StatusCode.value__ >> "%TEMP%\fb_commit.ps1"
echo     Write-Host ('[ERROR] HTTP ' + $msg + ' - ' + $_.Exception.Message) >> "%TEMP%\fb_commit.ps1"
echo     exit 1 >> "%TEMP%\fb_commit.ps1"
echo } >> "%TEMP%\fb_commit.ps1"

powershell -NoProfile -ExecutionPolicy Bypass -File "%TEMP%\fb_commit.ps1"
set COMMIT_EXIT=%ERRORLEVEL%
del "%TEMP%\fb_commit.ps1" 2>nul

if %COMMIT_EXIT% neq 0 (
    echo.
    echo  Commit failed — see error above. No partial changes were made.
    pause & exit /b 1
)

echo.
echo  ── Done ─────────────────────────────────────────────────────────────────
echo.
echo  Footage paths updated. All metadata, transcripts, and search indexes
echo  are preserved — no re-ingest needed.
echo.
echo  Next steps:
echo    - Open http://localhost:8000 ^→ Sources to verify the root is ONLINE
echo    - Run resume-ingest.bat if you want to scan for new or changed files
echo.
pause
exit /b 0

:cancelled
echo.
echo  Cancelled — no changes were made.
echo.
pause
exit /b 0
