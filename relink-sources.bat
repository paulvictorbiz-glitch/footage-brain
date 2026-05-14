@echo off
REM ────────────────────────────────────────────────────────────────────────────
REM  Footage Brain – Reconnect Footage Drive
REM
REM  Use this when your footage drive shows as OFFLINE after moving the app
REM  to a new computer or when the drive letter changed (e.g. E: became F:).
REM
REM  All your existing index, transcripts, and search data are preserved.
REM  Only the drive path is updated — no re-indexing needed.
REM
REM  BEFORE RUNNING: start the app with launch-portable.bat first.
REM ────────────────────────────────────────────────────────────────────────────

setlocal EnableDelayedExpansion

echo.
echo  Footage Brain – Reconnect Footage Drive
echo  ════════════════════════════════════════════════════════════════════════
echo.

REM ── Check backend is reachable ────────────────────────────────────────────

powershell -NoProfile -Command ^
  "try { Invoke-RestMethod 'http://localhost:8765/health' -TimeoutSec 3 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Footage Brain is not running.
    echo.
    echo  Please run launch-portable.bat first to start the app,
    echo  then run this script again.
    echo.
    pause & exit /b 1
)

REM ── Fetch and display source roots ────────────────────────────────────────

echo  Your footage folders:
echo.

REM Write the listing script
(
    echo $sources = Invoke-RestMethod 'http://localhost:8765/api/sources'
    echo if ^($sources.Count -eq 0^) {
    echo     Write-Host '  No footage folders have been added yet.'
    echo     Write-Host '  Open http://localhost:8765 and add a folder under Sources.'
    echo     exit 0
    echo }
    echo $global:sourceList = $sources
    echo $i = 1
    echo foreach ^($s in $sources^) {
    echo     $status = if ^($s.is_online^) { '[  ONLINE  ]' } else { '[ OFFLINE  ]' }
    echo     $files  = if ^($null -ne $s.file_count^) { $s.file_count } else { 0 }
    echo     $label  = if ^($s.label^) { '  (' + $s.label + ')' } else { '' }
    echo     Write-Host ^("  [$i] $status  " + $s.path + $label^)
    echo     Write-Host ^("        $files files indexed"^)
    echo     Write-Host ""
    echo     $i++
    echo }
) > "%TEMP%\fb_list.ps1"

powershell -NoProfile -ExecutionPolicy Bypass -File "%TEMP%\fb_list.ps1"
del "%TEMP%\fb_list.ps1" 2>nul

echo  ════════════════════════════════════════════════════════════════════════
echo.

REM ── Ask which source to reconnect ─────────────────────────────────────────

echo  Which source would you like to reconnect?
echo  Enter the number from the list above, or press Enter to cancel.
echo.
set /p PICK=  Your choice:
if "!PICK!"=="" goto :cancelled

REM Fetch the source ID for the chosen number
(
    echo $sources = Invoke-RestMethod 'http://localhost:8765/api/sources'
    echo $idx = [int]$env:FB_PICK - 1
    echo if ^($idx -lt 0 -or $idx -ge $sources.Count^) { Write-Host 'INVALID'; exit 1 }
    echo $s = $sources[$idx]
    echo Write-Host ^($s.id + '|' + $s.path^)
) > "%TEMP%\fb_pick.ps1"

set FB_PICK=!PICK!
for /f "delims=" %%r in ('powershell -NoProfile -ExecutionPolicy Bypass -File "%TEMP%\fb_pick.ps1" 2^>nul') do set FB_RESULT=%%r
del "%TEMP%\fb_pick.ps1" 2>nul

if "!FB_RESULT!"=="INVALID" (
    echo.
    echo  [ERROR] That number is not in the list. Please run this script again.
    pause & exit /b 1
)
if "!FB_RESULT!"=="" (
    echo.
    echo  [ERROR] Could not read the source list. Is the app running?
    pause & exit /b 1
)

REM Split result into ID and old path
for /f "tokens=1,2 delims=|" %%a in ("!FB_RESULT!") do (
    set ROOT_ID=%%a
    set OLD_PATH=%%b
)

echo.
echo  Selected: !OLD_PATH!
echo.

REM ── Show available drives ─────────────────────────────────────────────────

echo  Drives available on this computer:
echo.

powershell -NoProfile -Command ^
  "Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Root } | ForEach-Object { $free = [math]::Round($_.Free/1GB,1); $used = [math]::Round($_.Used/1GB,1); Write-Host ('    ' + $_.Root + '  ' + $used + ' GB used,  ' + $free + ' GB free') }"

echo.

REM ── Ask for new drive letter ───────────────────────────────────────────────

echo  What drive letter is your footage on now?
echo  Enter just the letter (example: F) then press Enter.
echo  Or press Enter with nothing to cancel.
echo.
set /p NEW_DRIVE=  Drive letter:
if "!NEW_DRIVE!"=="" goto :cancelled

REM Normalise: strip colon/backslash if provided
set NEW_DRIVE=!NEW_DRIVE:~0,1!

REM Build new path: replace the drive letter portion of the old path
REM OLD_PATH is like  E:\Footage\Camera  → strip first 2 chars (E:)
set OLD_PATH_TAIL=!OLD_PATH:~2!
set NEW_PATH=!NEW_DRIVE!:!OLD_PATH_TAIL!

echo.
echo  ── Preview ──────────────────────────────────────────────────────────────
echo.
echo    Was:  !OLD_PATH!
echo    Now:  !NEW_PATH!
echo.

REM Dry run first
set FB_ROOT_ID=!ROOT_ID!
set FB_NEW_PATH=!NEW_PATH!

(
    echo $uri  = 'http://localhost:8765/api/sources/' + $env:FB_ROOT_ID + '/relink'
    echo $body = ConvertTo-Json @{ new_path = $env:FB_NEW_PATH; dry_run = $true }
    echo try {
    echo     $r = Invoke-RestMethod -Method POST -Uri $uri -ContentType 'application/json' -Body $body
    echo     Write-Host ^('  Files that will be reconnected: ' + $r.remapped^)
    echo     if ^($r.unmatched -gt 0^) { Write-Host ^('  Files not matched (will be skipped): ' + $r.unmatched^) }
    echo     exit 0
    echo } catch {
    echo     $code = $_.Exception.Response.StatusCode.value__
    echo     $detail = $_.ErrorDetails.Message
    echo     Write-Host ^("[ERROR] " + $detail^)
    echo     exit 1
    echo }
) > "%TEMP%\fb_dry.ps1"

powershell -NoProfile -ExecutionPolicy Bypass -File "%TEMP%\fb_dry.ps1"
set DRY_EXIT=!ERRORLEVEL!
del "%TEMP%\fb_dry.ps1" 2>nul

if !DRY_EXIT! neq 0 (
    echo.
    echo  Could not preview the change. Make sure the drive letter is correct
    echo  and the new path exists on this computer.
    pause & exit /b 1
)

echo.
echo  ── Confirm ──────────────────────────────────────────────────────────────
echo.
echo  Type YES (all caps) to reconnect. Press Enter to cancel.
echo.
set /p CONFIRM=  Confirm:
if "!CONFIRM!" neq "YES" goto :cancelled

REM ── Commit ────────────────────────────────────────────────────────────────

echo.
echo  Reconnecting...
echo.

(
    echo $uri  = 'http://localhost:8765/api/sources/' + $env:FB_ROOT_ID + '/relink'
    echo $body = ConvertTo-Json @{ new_path = $env:FB_NEW_PATH; dry_run = $false }
    echo try {
    echo     $r = Invoke-RestMethod -Method POST -Uri $uri -ContentType 'application/json' -Body $body
    echo     Write-Host ^('[OK] Done! ' + $r.remapped + ' footage files reconnected.'^)
    echo     Write-Host ^('     Your search index is intact — no re-indexing needed.'^)
    echo     exit 0
    echo } catch {
    echo     $code = $_.Exception.Response.StatusCode.value__
    echo     $detail = $_.ErrorDetails.Message
    echo     Write-Host ^("[ERROR] " + $detail^)
    echo     exit 1
    echo }
) > "%TEMP%\fb_commit.ps1"

powershell -NoProfile -ExecutionPolicy Bypass -File "%TEMP%\fb_commit.ps1"
set COMMIT_EXIT=!ERRORLEVEL!
del "%TEMP%\fb_commit.ps1" 2>nul

if !COMMIT_EXIT! neq 0 (
    echo.
    echo  Something went wrong. No changes were saved.
    echo  Check that the drive letter is correct and try again.
    pause & exit /b 1
)

echo.
echo  ════════════════════════════════════════════════════════════════════════
echo.
echo  Next step: open http://localhost:8765 and go to Sources.
echo  Your footage folder should now show as ONLINE.
echo.
echo  If you have new footage to index, click Scan in the Sources panel.
echo  Or run resume-ingest.bat to pick up any paused indexing jobs.
echo.
pause
exit /b 0

:cancelled
echo.
echo  Cancelled — nothing was changed.
echo.
pause
exit /b 0
