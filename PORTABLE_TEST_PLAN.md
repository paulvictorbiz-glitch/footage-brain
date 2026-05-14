# Footage Brain – Portable Deployment Test Plan

Run these tests in order before handing the folder to anyone else. Each test builds on the previous one. Stop and fix issues before moving to the next step.

---

## Recommended Test Dataset

Use **5–10 short video clips** (30 seconds to 5 minutes each) with the following mix:

| Type | Why |
|------|-----|
| 1–2 clips with clear speech | Tests transcription + embedding |
| 1–2 clips with no audio | Tests graceful skip of transcription |
| 1 clip > 10 minutes | Tests ingest timeout handling |
| 1 clip in a subfolder | Tests recursive scanning |
| Mix of .mp4, .mov, .mkv | Tests extension detection |

Minimum total size: ~500 MB. Enough to exercise every pipeline stage without waiting hours.

---

## Test 1 — App Starts and UI Loads

**What to verify:** The server starts, the browser opens, and the UI renders correctly.

**Steps:**
1. On a clean machine (or fresh user account), double-click `launch-portable.bat`
2. Wait for the browser to open automatically (up to 60 seconds on first run)
3. Navigate to http://localhost:8000

**Success criteria:**
- [ ] Terminal window shows "Application startup complete" with no red errors
- [ ] Browser loads the Footage Brain UI (not a blank page or 404)
- [ ] No `ModuleNotFoundError` or `ImportError` in the terminal
- [ ] `/health` endpoint returns `{"status":"ok"}` (visit http://localhost:8000/health)

**Common failures:**
- `Python not found` → Python 3.11 not installed or not on PATH
- `pip install failed` → No internet connection
- Blank page → Frontend `dist/` not built or not found

---

## Test 2 — Scan Finds Footage Files

**What to verify:** The scanner detects video files in a folder.

**Steps:**
1. In the UI, go to **Sources**
2. Click **Add Source** and select your test footage folder
3. Click **Scan**
4. Wait 10–30 seconds

**Success criteria:**
- [ ] Source shows as `ONLINE` with correct file count
- [ ] Files appear in the **Library** view with filenames visible
- [ ] No `path_not_found` errors in the terminal

**Common failures:**
- Source shows OFFLINE → Drive letter wrong; run `relink-sources.bat`
- File count is 0 → Check that `VIDEO_EXTENSIONS` in `.env` includes your file types

---

## Test 3 — Metadata Extraction Works

**What to verify:** ffmpeg/ffprobe can read video files and extract duration, resolution, etc.

**Steps:**
1. After the scan completes, click a video file in the Library
2. Check that its details panel shows: duration, resolution, fps, codec

**Success criteria:**
- [ ] Duration shows as a number (not `null` or `0`)
- [ ] Resolution shows (e.g. `1920×1080`)
- [ ] Thumbnail image appears in the file card

**Common failures:**
- All metadata null → ffmpeg/ffprobe not found; check `backend\tools\` or PATH
- Thumbnail missing → ffmpeg found but ffprobe failed; check terminal log for `ffprobe_error`

---

## Test 4 — Transcription Works

**What to verify:** Whisper can load from the local model cache and transcribe speech.

**Steps:**
1. Let the ingest pipeline run (watch the terminal for `transcriber` log lines)
2. After a clip with speech is processed, click it and open the Transcript tab

**Success criteria:**
- [ ] Transcript text appears with timestamps
- [ ] No `OutOfMemoryError` in the terminal (if GPU: reduce to `WHISPER_MODEL=medium`)
- [ ] Log shows `transcribe_done` with a duration

**Common failures:**
- `CUDAOutOfMemoryError` → Edit `.env`: `WHISPER_MODEL=medium` or `WHISPER_DEVICE=cpu`
- `Model not found` → `MODEL_CACHE_DIR` not pointing to `portable_data_test\models\`; check `.env`
- Transcription skipped entirely → Clip has no audio track (expected behavior)

---

## Test 5 — Embeddings and Search Work

**What to verify:** Semantic search returns relevant results.

**Steps:**
1. Wait for at least one clip to complete the `embed` stage (watch terminal for `embed_done`)
2. Go to the **Search** page
3. Search for a word or phrase that is spoken in one of your test clips

**Success criteria:**
- [ ] Results appear ranked by relevance
- [ ] The correct clip appears near the top of results
- [ ] Clicking a result shows the file detail page
- [ ] Timestamp link jumps to the correct position (if video playback works)

**Common failures:**
- Zero results → Embedding not complete yet; wait and retry
- Wrong results → Expected for a 5-clip test set; normal behavior

---

## Test 6 — Path Relinking When Drive Letter Changes

**What to verify:** Relinking works without corrupting the index.

**Steps (simulate a drive letter change):**
1. Note your current footage drive letter (e.g. `E:`)
2. Stop the app (close the Footage Brain terminal)
3. In Windows Disk Management, assign a new letter to the drive (e.g. `F:`)
4. Start the app again with `launch-portable.bat`
5. Verify the source shows `OFFLINE`
6. Run `relink-sources.bat`
7. Enter `1` (or the number of the offline source)
8. Enter the new drive letter (`F`)
9. Type `YES` to confirm

**Success criteria:**
- [ ] Relink reports the correct file count (e.g. "8 files reconnected")
- [ ] Source shows `ONLINE` after relinking
- [ ] Previously indexed files still appear in search results
- [ ] No re-indexing started (pipeline stays idle)

**Restore:** Change the drive letter back to `E:` and relink again.

---

## Test 7 — Move to Another Computer

**What to verify:** Copying the folder to a new machine preserves the full index.

**Steps:**
1. On the source machine: stop the app, build the frontend (`npm run build`), copy the folder
2. On the destination machine: install Python 3.11, run `launch-portable.bat`
3. If footage drive shows offline: run `relink-sources.bat`
4. Search for something that was already indexed on the source machine

**Success criteria:**
- [ ] App starts without downloading any models (bundled models load from `portable_data_test\models\`)
- [ ] Terminal shows "machine_changed" warning (expected — log it, then continue)
- [ ] Previously indexed clips appear in search with full transcripts
- [ ] Thumbnails display correctly
- [ ] Offline source reconnects correctly after relinking

**Common failures:**
- Models re-downloading → `MODEL_CACHE_DIR` not set in `.env` or `DATA_ROOT` wrong
- Database empty → Copied the wrong DB file (make sure you copied `portable_data_test\footage_brain.db`)

---

## Test 8 — Resume Interrupted Ingest

**What to verify:** The ingest pipeline can be paused and resumed without data loss.

**Steps:**
1. Start ingest on a batch of clips (add a source folder with 10+ files)
2. Wait until 2–3 files have completed (`transcribe_done` in log)
3. Kill the app abruptly (close the terminal window without clean shutdown)
4. Restart with `launch-portable.bat`
5. Run `resume-ingest.bat`

**Success criteria:**
- [ ] Already-completed files are NOT re-processed (check log for `metadata_skip_already_done`)
- [ ] In-progress files restart from the correct stage (not from scratch)
- [ ] `resume-ingest.bat` reports jobs reset and pipeline restarted
- [ ] Ingest completes successfully for remaining files

**Common failures:**
- All jobs stuck in `processing` → Normal after abrupt kill; `resume-ingest.bat` fixes this
- File re-processed from scratch → Stage flags (`transcribed`, `embedded`) were not committed before kill (expected for the one file that was mid-stage)

---

## Sign-Off Checklist

Before handing the folder to anyone:

```
[ ] Test 1 passed — app starts and UI loads
[ ] Test 2 passed — scan finds footage files
[ ] Test 3 passed — metadata + thumbnails extracted
[ ] Test 4 passed — transcription works (or gracefully skipped for silent clips)
[ ] Test 5 passed — search returns relevant results
[ ] Test 6 passed — relink works after drive letter change
[ ] Test 7 passed — index intact after copying to another machine
[ ] Test 8 passed — interrupted ingest resumes correctly
[ ] frontend\dist\ is pre-built (Node.js not needed on destination)
[ ] ffmpeg.exe is in backend\tools\ OR winget install confirmed working
[ ] .env has correct WHISPER_DEVICE for destination GPU
```
