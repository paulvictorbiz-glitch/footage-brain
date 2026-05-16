# Footage Brain – Self-Contained Windows Deployment

**Goal:** Copy the project folder to another Windows PC and have it work with minimal setup.

---

## What Is Bundled (Travels With the Folder)

| Item | Location | Size | Notes |
|------|----------|------|-------|
| Application code | `backend/app/` | ~500 KB | Python source files |
| Python packages | Recreated by `launch-portable.bat` | ~2 GB | Installed into `backend/venv/` on first run |
| AI models (Whisper) | `backend/portable_data_test/models/hub/` | ~1.5 GB | faster-whisper large-v3 |
| AI models (embeddings) | `backend/portable_data_test/models/` | ~500 MB | mxbai-embed-large-v1 |
| AI models (CLIP) | `backend/portable_data_test/models/hub/` | ~1.7 GB | openai/clip-vit-large-patch14 |
| SQLite database | `backend/portable_data_test/footage_brain.db` | varies | All indexed metadata |
| Vector search index | `backend/portable_data_test/chroma/` | varies | Semantic search data |
| Thumbnails | `backend/portable_data_test/thumbnails/` | varies | One JPEG per video |
| Frontend UI | `frontend/dist/` | ~5 MB | Pre-built React app |
| Startup scripts | `*.bat` (project root) | — | Double-click launchers |
| ffmpeg (optional) | `backend/tools/ffmpeg.exe` | ~80 MB | Place here to avoid PATH install |

**Total copy size (typical):** ~6–8 GB including models and a moderate video library index.

---

## What Is NOT Bundled (Must Exist on the Destination Machine)

| Item | Why Not Bundled | How to Satisfy |
|------|----------------|----------------|
| Python 3.11+ runtime | Platform-specific installer; can't be embedded reliably with this ML stack | Install from python.org — tick "Add Python to PATH" |
| Python venv | Machine-specific binary paths baked in; must be recreated | `launch-portable.bat` creates it automatically |
| ffmpeg | Optional if placed in `backend/tools/` | `launch-portable.bat` installs via winget automatically, OR place `ffmpeg.exe` + `ffprobe.exe` in `backend/tools/` |
| NVIDIA GPU drivers | Hardware-specific; cannot be shipped | Install from nvidia.com if using GPU acceleration |
| CUDA toolkit | Comes with NVIDIA drivers on modern systems | Usually not needed separately; drivers include CUDA runtime |
| Node.js | Only needed if `frontend/dist/` is not pre-built | Pre-build before copying (see below) — then Node.js is not needed |

---

## How to Prepare the Folder for Transfer

### Step 1 — Pre-build the frontend (eliminates Node.js dependency)

Run this once on the source machine before copying:

```bat
cd frontend
npm run build
cd ..
```

After this, `frontend\dist\index.html` exists. The destination machine will use it directly — Node.js is not needed there.

### Step 2 — Checkpoint the database WAL

SQLite keeps a write-ahead log that must be merged before copying:

```bat
cd backend
venv\Scripts\activate
python -c "from app.db.session import engine; engine.execute('PRAGMA wal_checkpoint(TRUNCATE)')"
```

Or stop the backend first — a clean shutdown automatically checkpoints the WAL.

### Step 3 — Copy the folder

Copy everything **except** `backend\venv\` (it will be recreated). Copy `frontend\dist\` — it's small and saves a build step.

Recommended: copy all of these:
```
footage-brain-test/
├── backend/
│   ├── app/
│   ├── portable_data_test/    ← models + DB + thumbnails + search index
│   ├── tools/                 ← ffmpeg.exe + ffprobe.exe (if you placed them here)
│   ├── .env
│   ├── .env.portable.example
│   └── requirements.txt
├── frontend/
│   ├── dist/                  ← pre-built UI (copy this!)
│   └── src/                   ← source (optional on destination)
├── launch-portable.bat
├── relink-sources.bat
├── resume-ingest.bat
└── first-run-check.bat
```

Do NOT copy: `backend\venv\`, `frontend\node_modules\`

### Step 4 — On the destination machine

1. Install Python 3.11 from python.org (tick "Add Python to PATH")
2. Double-click `launch-portable.bat`
3. If footage drive shows offline, run `relink-sources.bat`

---

## ffmpeg: Bundled vs Global Install

### Option A — Place in `backend\tools\` (most portable)

Download the Windows "essentials" build of ffmpeg. Extract and place:
- `backend\tools\ffmpeg.exe`
- `backend\tools\ffprobe.exe`

The app checks this folder first and uses these binaries directly. No PATH changes needed on any machine.

**Advantage:** Truly self-contained. Copy the folder, it works.  
**Tradeoff:** Adds ~80 MB to the copy size.

### Option B — Install via winget (automatic)

`launch-portable.bat` calls `winget install Gyan.FFmpeg` automatically if ffmpeg is not found. Requires internet on first launch. Installs globally into PATH.

**Advantage:** Zero manual steps.  
**Tradeoff:** Internet needed on first launch; installs globally, not per-project.

---

## GPU vs CPU Mode

`launch-portable.bat` auto-detects whether an NVIDIA GPU is present and writes the correct settings to `.env` automatically. You do not need to edit `.env` manually.

| Situation | Auto-configured setting | Speed |
|-----------|------------------------|-------|
| NVIDIA GPU found | `WHISPER_DEVICE=cuda` | Fast — transcribes ~10–50× real time |
| No GPU / GPU not detected | `WHISPER_DEVICE=cpu` | Slower — transcribes ~0.5–2× real time |

To override: edit `backend\.env` and change `WHISPER_DEVICE=cpu` or `WHISPER_DEVICE=cuda`.

If GPU transcription crashes with an out-of-memory error, switch to `WHISPER_MODEL=medium` in `.env` (reduces VRAM from 1.5 GB to 500 MB).

---

## How to Refresh / Update Local Dependencies

### Update Python packages

```bat
cd backend
call venv\Scripts\activate
pip install -r requirements.txt --upgrade
```

### Update AI models

Models are pinned by name in `.env` (`WHISPER_MODEL`, `EMBED_MODEL`). To use a different model:
1. Edit `backend\.env`
2. Delete the old model folder from `portable_data_test\models\`
3. Restart — the new model downloads automatically on first use

### Rebuild the frontend

```bat
cd frontend
npm install
npm run build
```

---

## Tradeoffs of This Approach

| Decision | Benefit | Cost |
|----------|---------|------|
| Require Python 3.11 globally | Full ML stack works reliably (no PyInstaller fragility) | User installs Python once |
| Bundle AI models in project folder | No 5 GB download on new machine | Large folder to copy/store |
| Pre-build frontend | No Node.js needed on destination | Must rebuild after UI changes |
| ffmpeg in `backend/tools/` | No PATH configuration needed | +80 MB per copy |
| SQLite + Chroma as flat files | Copy = backup; no database server | WAL must be checkpointed before copy |
