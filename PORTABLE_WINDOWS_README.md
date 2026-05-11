# Footage Brain – Portable Windows Guide

This guide covers everything you need to move Footage Brain to a new Windows PC,
relink footage drives after drive-letter changes, and get ingest running again
from where you left off.

---

## Scripts in this folder

| Script | Purpose |
|---|---|
| `launch-portable.bat` | **Start here.** Sets up and launches the app. |
| `first-run-check.bat` | Diagnose missing dependencies without changing anything. |
| `relink-sources.bat` | Remap footage paths after a drive letter changes. |
| `resume-ingest.bat` | Unpause jobs and optionally scan for new footage. |

---

## 1. First launch on a new PC

### Prerequisites

Install these before running anything:

- **Python 3.11+** — https://python.org  
  Tick **"Add Python to PATH"** during install.
- **Node.js 18+** — https://nodejs.org
- **ffmpeg** — https://ffmpeg.org/download.html  
  Extract the zip, copy the `bin\` folder somewhere permanent (e.g. `C:\tools\ffmpeg\bin\`),  
  then add that path to your system PATH variable.

To check PATH, open a new Command Prompt and run:
```
python --version
node --version
ffmpeg -version
```

All three must print version numbers with no errors before continuing.

### Step 1 — Verify the environment

Run `first-run-check.bat`. It prints a status table like this:

```
[OK]   Python ............. Python 3.11.9
[OK]   Node.js ............ v20.12.2
[OK]   ffmpeg ............. found
[WARN] NVIDIA GPU ......... not detected
[OK]   Python venv ........ backend\venv
[OK]   Python packages .... installed
```

Fix any `[FAIL]` items before continuing. `[WARN]` items are non-fatal.

### Step 2 — Run the portable launcher

Double-click **`launch-portable.bat`** (or run it from a terminal).

On first launch it will:

1. Copy `backend\.env.portable.example` → `backend\.env` (if no `.env` exists)
2. **Pause and ask you to set `WHISPER_DEVICE`** in `.env`  
   — set to `cuda` for NVIDIA GPU, `cpu` otherwise
3. Create the Python virtual environment in `backend\venv\`
4. Install Python dependencies (`pip install`)
5. Install frontend npm packages (`npm install`)
6. Build the frontend to `frontend\dist\` (`npm run build`)
7. Start the backend at `http://localhost:8000`
8. Open the browser

Subsequent launches skip steps 3–6 (already done).

> **Expected output at the end:**
> ```
>  [OK] Python dependencies ready
>  [OK] node_modules present
>  [OK] Frontend build present
>  Starting Footage Brain on http://localhost:8000 ...
>  [OK] Browser opening
> ```

### Step 3 — Open the UI

The browser opens automatically. If not, go to:  
**http://localhost:8000**

---

## 2. Relinking footage drives after a drive letter change

When Windows assigns a different letter to your footage drive (e.g. was `E:`, now `F:`),
the app shows sources as **OFFLINE** in the Sources tab. No footage data or index is lost —
only the path prefix needs to be updated.

### Check which drive is which

Open PowerShell and run:
```powershell
Get-PSDrive -PSProvider FileSystem
```

Identify the new letter of your footage drive.

### Relink step-by-step

**Prerequisites:** The backend must be running (launch it with `launch-portable.bat`).

1. **Double-click `relink-sources.bat`.**

2. The script lists all registered source roots with their status:
   ```
   [OFFLINE]  E:\Footage
              files: 3743   id: a1b2c3d4-e5f6-...

   [ONLINE ]  C:\Projects\BRoll
              files: 412    id: 9f8e7d6c-...
   ```

3. **Copy the ID** of the offline root (the `id:` line).

4. Paste it at the `Source root ID:` prompt.

5. Type the new path at the `New path:` prompt — for example:
   ```
   F:\Footage
   ```

6. The script runs a **dry run** first and shows how many records would change:
   ```
   Old path            : E:\Footage
   New path            : F:\Footage
   Files to remap      : 3743
   Unmatched (skipped) : 0
   ```
   `Unmatched` should be 0. If it isn't, the files under that root don't all share
   the expected prefix — check the backend logs before committing.

7. Type `YES` to commit.

8. The script confirms:
   ```
   [OK] Relinked 3743 file records.
   ```

9. Open **http://localhost:8000 → Sources**. The source should now show **ONLINE**.

### What relinking preserves

- All metadata (codec, resolution, duration, etc.)
- All transcripts and transcript search index
- All visual embeddings (CLIP)
- Duplicate groups
- Project tags

Nothing needs to be re-indexed after a relink. Semantic and visual search continue
working immediately.

### Relinking multiple drives

Run `relink-sources.bat` once per offline source root. Each run handles one root.

---

## 3. Starting ingest on a new machine

After relinking footage paths, the ingest pipeline needs to be started or resumed.

1. Make sure `launch-portable.bat` is running (backend is up).
2. Double-click **`resume-ingest.bat`**.
3. When prompted `Scan all sources? (Y/N)` — type **Y** to discover new files on disk.
4. The script shows the job queue:
   ```
   Stage               Pending
   ─────────────────── ───────
   metadata            3743
   hash                3741
   transcribe          3200
   embed               0
   ```
5. Ingest begins automatically. Monitor progress at **http://localhost:8000** (Dashboard tab).

> **Note on model downloads:** On first ingest after a move, if the `models\` folder
> was not copied, Footage Brain will download Whisper and embedding models (~5 GB).
> This only happens once. To skip it, copy `backend\portable_data\models\` from the
> old machine before running ingest.

---

## 4. Resuming interrupted ingest

If ingest was interrupted (power loss, crash, manual stop), run `resume-ingest.bat`.
The pipeline picks up exactly where it left off — jobs are stored in the database and
are not lost between restarts.

Steps:
1. Run `launch-portable.bat` to start the server.
2. Run `resume-ingest.bat`.
3. Answer `N` to the scan prompt (unless new footage was added).

The job queue will show remaining work and processing will resume automatically.

If jobs show under **Failed**, check:
- Backend log: `backend\portable_data\logs\footage_brain.log`
- Common cause: ffmpeg not in PATH (metadata stage fails)
- Common cause: CUDA out of memory — change `WHISPER_COMPUTE_TYPE` to `int8_float16`

---

## 5. Opening the search UI after moving to another PC

1. Run `launch-portable.bat` — the browser opens automatically.
2. If footage sources are offline, relink them (see Section 2).
3. Search works immediately for all already-indexed footage — no reindex needed.
4. For footage not yet indexed on the new machine, run `resume-ingest.bat`.

---

## Data layout

All app data lives under `backend\portable_data\` when using the portable `.env`:

```
backend\
├── .env                            ← active config (edit WHISPER_DEVICE here)
├── .env.portable.example           ← template for portable mode
└── portable_data\
    ├── footage_brain.db            ← SQLite database (all metadata, jobs, transcripts)
    ├── thumbnails\                 ← thumbnail JPEGs (~1 KB each)
    ├── keyframes\                  ← keyframe JPEGs for visual search
    ├── chroma\                     ← Chroma vector database (semantic search index)
    ├── models\                     ← HuggingFace model weights (~5 GB)
    │   ├── hub\                    ← Whisper + CLIP weights
    │   └── sentence-transformers\  ← text embedding model
    └── logs\
        └── footage_brain.log       ← rotating log (10 MB × 5 files)
```

To move everything to a new machine, copy:
- The entire project folder (including `backend\portable_data\`)
- ffmpeg (reinstall or copy the `bin\` folder and re-add to PATH)

Python and Node must be reinstalled — they are not in the project folder.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `python not found` | Python not in PATH | Reinstall Python with "Add to PATH" ticked |
| `ffmpeg not found` | ffmpeg not in PATH | Add ffmpeg `bin\` to system PATH |
| Backend starts then crashes | `.env` misconfiguration | Run `first-run-check.bat`; check `WHISPER_DEVICE` |
| All sources show OFFLINE | Drive letters changed | Run `relink-sources.bat` |
| Sources show ONLINE but search returns nothing | Index not built yet | Run `resume-ingest.bat` and wait |
| Transcription fails, `CUDA out of memory` | VRAM too small | Set `WHISPER_COMPUTE_TYPE=int8_float16` in `.env` |
| Transcription very slow | Running on CPU | Set `WHISPER_DEVICE=cuda` if you have NVIDIA GPU |
| `pip install` fails | No internet, or proxy | Ensure internet access; or pre-copy `venv\` from old machine |
| `npm install` fails | No internet | Ensure internet access; or pre-copy `node_modules\` from old machine |
| Port 8000 already in use | Another process on 8000 | Change `APP_PORT=8001` in `.env` and use `http://localhost:8001` |
| Browser opens to blank page | Frontend not built | Run `launch-portable.bat` — it builds automatically |
| `[ERROR] HTTP 409` in relink | New path collides with another root | Two roots would share a path; resolve in Sources before relinking |

---

## Quick reference: day-to-day use

| Task | Command |
|---|---|
| Start the app | `launch-portable.bat` |
| Diagnose problems | `first-run-check.bat` |
| Drive letter changed | `relink-sources.bat` |
| Resume stopped ingest | `resume-ingest.bat` |
| Add new footage | Add source in UI → Sources → Add, then `resume-ingest.bat` |
| Search | `http://localhost:8000` → Search tab |
| Stop the app | Close the "Footage Brain" terminal window |
