# Moving Footage Brain Between Computers

This guide covers the exact steps to index footage on one Windows PC and continue using the search UI on another — without rebuilding the index from scratch.

---

## What Survives the Move

| Data | Survives? | Notes |
|------|-----------|-------|
| All video metadata (duration, codec, resolution) | Yes | Stored in SQLite |
| Transcript text + timestamps | Yes | Stored in SQLite |
| Semantic search index | Yes | Stored in Chroma vector DB |
| Thumbnail images | Yes | Stored as JPEG files |
| Ingest job progress | Yes | Pending jobs resume automatically |
| Footage drive paths | Needs update | Drive letters change between machines — run `relink-sources.bat` |

---

## Step-by-Step: Move to Another Computer

### On the Source Computer (where you indexed)

**1. Stop the app cleanly**

Close the Footage Brain terminal window. A clean shutdown checkpoints the SQLite WAL automatically.

If you need to stop it from the command line:
```bat
REM Press Ctrl+C in the Footage Brain terminal window
```

**2. Pre-build the frontend (skip if already done)**

```bat
cd frontend
npm run build
cd ..
```

This creates `frontend\dist\` so Node.js is not needed on the destination.

**3. Copy the folder**

Copy the entire project folder to the destination machine (USB drive, network share, cloud sync). Exclude `backend\venv\` and `frontend\node_modules\` — they are machine-specific and must be recreated.

Minimum required to copy:
```
footage-brain-test\
├── backend\
│   ├── app\
│   ├── portable_data_test\        ← DO copy (DB + models + thumbnails + index)
│   ├── tools\                     ← copy if ffmpeg.exe is here
│   ├── .env
│   ├── .env.portable.example
│   └── requirements.txt
├── frontend\
│   └── dist\                      ← DO copy (pre-built UI)
├── launch-portable.bat
├── relink-sources.bat
└── resume-ingest.bat
```

**4. Move your footage drive to the destination machine**

Plug in the external drive or reconnect the NAS share on the new machine. Note the drive letter it gets assigned (it may change — e.g. E: → F:).

---

### On the Destination Computer

**5. Install Python 3.11**

Download from python.org. During install, tick **"Add Python to PATH"**.

This is the only software you need to install manually. The startup script handles everything else.

**6. Double-click `launch-portable.bat`**

The script will:
- Auto-detect your GPU and configure transcription mode
- Install ffmpeg if not present
- Set up the Python environment (~5–10 minutes on first run)
- Start the app and open your browser

**7. Check Sources for offline footage roots**

Open http://localhost:8000 and click **Sources** in the navigation.

If your footage folder shows `OFFLINE`:
- The drive letter changed between machines
- Run `relink-sources.bat` (see next section)

If it shows `ONLINE`: you're done. Search works immediately.

---

## Reconnecting a Footage Drive (Drive Letter Changed)

This is the most common issue when moving between machines. The app remembers paths like `E:\Footage` but the drive is now `F:\Footage`.

### Option A — Use relink-sources.bat (recommended for non-technical users)

1. Make sure the app is running (`launch-portable.bat`)
2. Double-click `relink-sources.bat`
3. The script shows your footage folders with ONLINE/OFFLINE status
4. Enter the number of the offline folder
5. Enter the new drive letter (just the letter, e.g. `F`)
6. Type `YES` to confirm
7. Done — no re-indexing needed

### Option B — Manual SQL (advanced)

If you prefer direct database access:

```sql
-- Open a terminal in the project root, then:
cd backend
venv\Scripts\activate
python -c "
from app.db.session import engine
with engine.connect() as conn:
    conn.execute(\"UPDATE scan_roots SET path = REPLACE(path, 'E:\\\\', 'F:\\\\')\")
    conn.execute(\"UPDATE video_files SET abs_path = REPLACE(abs_path, 'E:\\\\', 'F:\\\\')\")
    conn.commit()
"
```

Replace `E:` with the old letter and `F:` with the new letter.

---

## Resuming Interrupted Ingest

If ingest was running when you copied the folder, some jobs may be in `processing` state (stuck). Run:

```bat
resume-ingest.bat
```

This resets stuck jobs and restarts the pipeline. Already-completed stages (metadata, transcription, embedding) are skipped — only the unfinished stages run again.

---

## What Gets Detected Automatically

On every startup, Footage Brain logs:

- Whether the machine hostname has changed since last run
- Which source roots are currently offline
- How many files are in each offline root

Check the log at `backend\portable_data_test\logs\footage_brain.log` or the terminal window for these messages.

Example log output after moving to a new machine:
```
[WARNING] machine_changed   previous_host=DESKTOP-SL6OOKO  current_host=DESKTOP-GU603ZM
[WARNING] offline_scan_roots_detected  count=1  hint="Run relink-sources.bat..."
[WARNING] scan_root_offline  path=E:\Footage  files=1234  fix="Run relink-sources.bat..."
```

---

## What Happens to Search While Offline

Even with footage roots offline (drive not connected):

- **Search still works** — all transcripts and visual embeddings are in the local database
- **Results still appear** — clicking a result to play video will fail (file not found), but search and browse work
- **Thumbnails still display** — stored locally in `portable_data_test\thumbnails\`
- **New ingest is paused** — pipeline skips files it cannot read

Reconnect the drive and run `relink-sources.bat` to restore full playback.

---

## Checklist Summary

```
Source machine:
  [ ] Stop app cleanly (close the Footage Brain terminal)
  [ ] Run: cd frontend && npm run build
  [ ] Copy project folder (exclude venv\ and node_modules\)
  [ ] Bring footage drive

Destination machine:
  [ ] Install Python 3.11 (python.org — tick "Add Python to PATH")
  [ ] Double-click launch-portable.bat
  [ ] Wait for browser to open (first run: 5–10 min for pip install)
  [ ] If Sources shows OFFLINE: run relink-sources.bat
  [ ] Search for something to verify the index is intact
  [ ] Run resume-ingest.bat if ingest was in progress
```
