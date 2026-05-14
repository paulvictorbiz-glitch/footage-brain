# Footage Brain – Windows Portability Audit

**Date:** 2026-05-11  
**Scope:** Full repo audit — backend (FastAPI/Python), frontend (React/Vite), startup scripts, configuration

---

## 1. Current Runtime Requirements

### Required on every machine

| Component | Minimum version | Notes |
|-----------|----------------|-------|
| Python | 3.11+ | Tested with venv at `backend/venv/` |
| Node.js | 18+ | Tested with `frontend/node_modules/` |
| npm | 9+ | Ships with Node 18 |
| ffmpeg | Any recent | Must be on `PATH`; no installer bundled |
| ffprobe | Any recent | Ships with ffmpeg; separate binary on Windows |
| CUDA toolkit | 12.x (optional) | Only needed if `WHISPER_DEVICE=cuda` |
| nvidia-smi | Any | Thermal monitoring only; app runs fine without it |
| HWiNFO64 | Running + Shared Memory ON | Thermal monitoring only; app runs fine without it |

### Python packages (from `requirements.txt`)

Critical runtime dependencies: `fastapi`, `uvicorn[standard]`, `sqlalchemy`, `pydantic-settings`, `faster-whisper`, `sentence-transformers`, `chromadb`, `xxhash`, `structlog`

Large download-on-first-use packages (HuggingFace):
- `faster-whisper` → downloads Whisper model (~1.5 GB for `large-v3`)
- `sentence-transformers` → downloads embedding model (`mxbai-embed-large-v1` ~500 MB)
- CLIP via `transformers` → downloads `openai/clip-vit-large-patch14` (~1.7 GB)

---

## 2. Dev-Only Tooling Dependencies

### `start-dev.bat` line 73 — `--reload` flag
```bat
python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```
**Problem:** `--reload` uses watchfiles to detect Python file changes. On every reload it tears down the entire process, which kills all daemon threads — including the pipeline worker and thermal controller. The ingest queue stops mid-job. This is the startup script used in normal operation.

**Impact:** Transcription and embedding jobs silently die whenever any `.py` file is saved. Confirmed root cause of the 2 jobs/hr transcription rate observed.

### `start-dev.bat` — assumes fixed project layout
- Calls `call backend\venv\Scripts\activate.bat` (hard path from project root)
- Calls `cd backend` before launching uvicorn (backend must be CWD for import resolution)
- Calls `cd frontend` for npm (frontend must be CWD for vite)

If the project root folder is renamed or moved, these relative paths still work — but only if you run the `.bat` from the new project root.

### `vite.config.ts` — hardcoded backend address
```ts
// frontend/vite.config.ts:16
target: 'http://localhost:8000',
```
The Vite dev server proxies `/api` and `/thumbnails` to a hardcoded `localhost:8000`. This is fine for same-machine dev but breaks if backend runs on a different port or host.

### `ffmpeg-python` in `requirements.txt`
Listed as a dependency but the codebase calls ffmpeg/ffprobe directly via `subprocess` everywhere. The `ffmpeg-python` package wraps ffmpeg differently and is never imported. It installs successfully but serves no purpose; it won't break anything, but it does add ~20 MB to the install and could confuse future dependency audits.

---

## 3. Hardcoded and Absolute-Path Assumptions

### `backend/app/api/sources.py:36` — path normalization
```python
path = os.path.normpath(body.path)
```
`os.path.normpath` on Windows converts `E:/Footage` → `E:\Footage`. The normalized backslash path is stored in `scan_roots.path`. This means the stored path is always Windows-style. Not a problem on Windows, but it means the DB is not transferable to macOS/Linux.

### `backend/app/ingest/scanner.py:97` — absolute path resolution
```python
abs_path = str(entry.resolve())
```
`Path.resolve()` returns the fully-qualified OS path (`E:\Footage\Project\GX010388.MP4`). This string is stored in `video_files.abs_path` (column allows 4096 chars). Every video file record contains a Windows absolute path with a specific drive letter. This is the most significant portability problem in the entire codebase.

### `backend/app/ingest/metadata.py:77` — thumbnail path storage
```python
thumb_path = thumb_dir / f"{file_id}.jpg"
# ...
return str(thumb_path)
```
`thumb_dir = Path(settings.thumbnails_dir)` where `thumbnails_dir = "./data/thumbnails"`. On Python, `Path("./data/thumbnails") / "id.jpg"` resolves to a **relative** path string `data\thumbnails\id.jpg`. The returned string is stored in `video_files.thumbnail_path`. Thumbnail paths are stored relative to CWD, which means they depend on the backend's working directory staying the same. If `thumbnails_dir` is changed to an absolute path in `.env`, thumbnail paths in existing records will break.

### `backend/app/ingest/clip_embedder.py:75` — temp dir frame pattern
```python
out_pattern = os.path.join(tmpdir, "frame_%06d.jpg")
```
`os.path.join` on Windows produces `C:\Users\...\AppData\Local\Temp\clip_embed_xxx\frame_%06d.jpg`. This is passed directly to ffmpeg's `-i` argument. ffmpeg interprets `%06d` as a printf sequence. On Windows, the backslash path is safe here since `subprocess` is used with an array (not a shell string), so no shell escaping issues.

### `backend/app/thermal/sensors.py:71` — Windows shared-memory name
```python
HWINFO_SM_NAME = "Global\\HWiNFO_SENS_SM2"
```
Hardcoded Windows kernel object name. This file also imports `ctypes.windll` (line 14), which **does not exist on Linux or macOS**. The thermal subsystem is Windows-exclusive by design. However, `main.py` wraps the thermal controller start in a `try/except` (lines 43–48), so startup won't crash on non-Windows — it just logs a warning.

### `backend/app/thermal/sensors.py:283–295` — PowerShell subprocess commands
```python
_LHM_TEMP_CMD = 'powershell -NonInteractive -Command "Get-WmiObject ..."'
```
`powershell` is hardcoded. On Windows 11 this is `Windows PowerShell 5.1` (`powershell.exe`), not PowerShell 7 (`pwsh.exe`). Works fine on the current machine; will not work on any non-Windows OS.

### `backend/app/core/config.py:15-20` — `.env` loaded relative to CWD
```python
model_config = SettingsConfigDict(env_file=".env", ...)
```
Pydantic-settings looks for `.env` relative to the **current working directory** at startup, not relative to the config file's location. The `start-dev.bat` correctly `cd backend` before launching uvicorn. If you run uvicorn from anywhere else, `.env` won't load and all settings fall back to defaults (e.g., `whisper_device=cpu`, `whisper_model=base`).

---

## 4. Current Storage Locations

All paths below are defaults from `.env`. All are relative to the backend's working directory (`footage-brain/backend/`).

| Data | Default path (relative to `backend/`) | Absolute example |
|------|----------------------------------------|-----------------|
| SQLite database | `footage_brain.db` | `backend\footage_brain.db` |
| WAL journal | `footage_brain.db-wal` | `backend\footage_brain.db-wal` |
| Thumbnails | `data\thumbnails\` | `backend\data\thumbnails\` |
| Keyframes | `data\keyframes\` | `backend\data\keyframes\` |
| Chroma vectors | `data\chroma\` | `backend\data\chroma\` |
| Logs | stdout / stderr only (structlog, no file sink) | — |

### Model caches (not in the project folder — per-user system paths)

| Model | Cache location | Approximate size |
|-------|---------------|-----------------|
| Whisper `large-v3` (faster-whisper) | `C:\Users\{user}\.cache\huggingface\hub\Systran\faster-whisper-large-v3\` | ~3 GB |
| mxbai-embed-large-v1 (sentence-transformers) | `C:\Users\{user}\.cache\huggingface\hub\` | ~500 MB |
| CLIP `clip-vit-large-patch14` (transformers) | `C:\Users\{user}\.cache\huggingface\hub\openai\clip-vit-large-patch14\` | ~1.7 GB |

These are controlled by the `HF_HOME` and `TRANSFORMERS_CACHE` environment variables. No current code sets these, so they always land in the user-profile cache.

---

## 5. What Breaks When Moving to Another Computer

### Breaks immediately (won't start)

| Issue | Why |
|-------|-----|
| Python venv missing | `backend\venv\` must be recreated on the new machine (`python -m venv backend\venv` + `pip install -r requirements.txt`) |
| `node_modules` missing | `frontend\node_modules\` must be recreated (`npm install`) |
| ffmpeg not found | Must be installed and added to `PATH` separately |
| Models missing | First pipeline run will attempt to download ~5 GB from HuggingFace; requires internet access |

### Breaks silently (starts but produces wrong results)

| Issue | Why |
|-------|-----|
| All scan roots broken | `scan_roots.path` stores paths like `E:\Footage`. That path doesn't exist on a new machine. Scans report `path_not_found` and queue nothing. |
| All `video_files` records unresolvable | `abs_path` column holds `E:\Footage\...` paths. Every ffprobe, ffmpeg, transcription, and embedding job will fail with "file not found". |
| Thumbnails broken in UI | Thumbnail records point to relative paths resolved from the original machine's `backend\` CWD. New machine may have a different project install path. |
| Chroma vectors orphaned | Vectors in `data\chroma\` reference `video_file_id` UUIDs that still exist in the copied DB, so semantic search still returns results — but clicking a result will fail because `abs_path` points to a path that doesn't exist on the new machine. |

### Degrades but works

| Issue | Why |
|-------|-----|
| Thermal monitoring disabled | `ctypes.windll` will raise if somehow run on non-Windows; on Windows but without HWiNFO/LHM, controller starts in `SENSOR_UNAVAILABLE` state — pipeline runs at full speed, no throttling. |
| GPU acceleration lost | If new machine has no NVIDIA GPU or different CUDA version, `.env` must be updated: `WHISPER_DEVICE=cpu`, `WHISPER_COMPUTE_TYPE=int8`. |

---

## 6. What Breaks When the Footage Drive Letter Changes

This is the most common real-world disruption (E: drive reassigned to F:, or footage moved to a NAS).

### Cascade of failures

1. **`scan_roots.path`** — Stored as `E:\Footage`. The scanner's first check is `if not root_path.exists()` (scanner.py:82). With the old drive letter it immediately returns `{"error": "path_not_found"}` and queues nothing.

2. **`video_files.abs_path`** — All 3,743+ records hold `E:\...` paths. Every stage handler (`metadata.py`, `transcriber.py`, `clip_embedder.py`) checks `os.path.exists(abs_path)` before processing. All return `None` / `False`. Every job will fail.

3. **Timeline exports (EDL)** — The EDL export endpoint (`timelines.py`) uses `vf.abs_path` to write the `SOURCE FILE` field of each CMX 3600 clip entry. EDLs exported after the drive letter change will contain broken paths that DaVinci Resolve won't resolve.

4. **Thumbnail serving** — `thumbnail_path` records like `data\thumbnails\{id}.jpg` are relative and unaffected. Thumbnails continue to display correctly in the UI.

5. **Semantic search still works** — Chroma vectors and transcript chunks in SQLite are keyed on `video_file_id`, not file paths. Search queries still return ranked results. The path is only needed when the user clicks a result to play/seek the video.

### What does NOT break
- Semantic text search (transcript embeddings in Chroma)
- Visual similarity search (CLIP frame embeddings in Chroma)
- Timeline structure (clip in/out points, positions, track order)
- All metadata fields (duration, fps, codec, resolution, etc.)

### Fix when drive letter changes
Run a single SQL update (no schema change needed):

```sql
-- Replace old drive prefix with new one for scan roots
UPDATE scan_roots SET path = REPLACE(path, 'E:\', 'F:\');

-- Replace old drive prefix with new one for video files
UPDATE video_files SET abs_path = REPLACE(abs_path, 'E:\', 'F:\');
```

This is safe to run with the backend stopped. After updating, re-trigger a scan from the UI to re-verify existence of all files.

---

## 7. Minimum Changes Needed to Run Reliably on Another Windows PC

These are the smallest possible changes — no architectural rewrites, no new abstraction layers.

### 7.1 Fix `start-dev.bat` — remove `--reload` (1 line change)

**File:** `start-dev.bat:73`

```bat
# Before
start "Footage Brain – Backend" cmd /k "cd backend && call venv\Scripts\activate.bat && python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000"

# After
start "Footage Brain – Backend" cmd /k "cd backend && call venv\Scripts\activate.bat && python -m uvicorn app.main:app --host 0.0.0.0 --port 8000"
```

This alone prevents the 2 jobs/hr transcription bug and pipeline worker death.

### 7.2 Add a `path_prefix` rewrite to `sources.py` (5 lines)

Currently `add_source` normalizes the path with `os.path.normpath` and stores it. Add a `PATH_PREFIX` env var that remaps old drive prefixes at scan time without touching the DB schema:

```python
# backend/app/core/config.py — add one field
path_prefix_map: str = ""   # e.g. "E:/=F:/" — old=new pairs, comma-separated
```

```python
# backend/app/ingest/scanner.py — before root_path.exists() check
def _remap_path(p: str) -> str:
    settings = get_settings()
    for pair in settings.path_prefix_map.split(","):
        if "=" not in pair:
            continue
        old, new = pair.split("=", 1)
        if p.startswith(old):
            return new + p[len(old):]
    return p
```

This gives you a runnable escape hatch for drive letter changes without SQL edits.

### 7.3 Pin `HF_HOME` in `.env` to a folder inside the project (optional but recommended)

```env
# backend/.env — add these two lines
HF_HOME=./data/models
TRANSFORMERS_CACHE=./data/models
```

Set these before starting the backend:
```bat
set HF_HOME=%~dp0backend\data\models
set TRANSFORMERS_CACHE=%~dp0backend\data\models
```

This moves all model downloads into the project folder. On a new machine you can copy `data\models\` instead of re-downloading 5 GB.

### 7.4 Add `HF_HOME` to `config.py` `ensure_dirs()`

```python
def ensure_dirs(self) -> None:
    for d in [self.thumbnails_dir, self.keyframes_dir, self.chroma_dir]:
        Path(d).mkdir(parents=True, exist_ok=True)
    # Add:
    if os.environ.get("HF_HOME"):
        Path(os.environ["HF_HOME"]).mkdir(parents=True, exist_ok=True)
```

### 7.5 Add `VITE_API_URL` to vite proxy config (optional, 2 lines)

Only needed if backend runs on a non-standard port on the new machine:

```ts
// frontend/vite.config.ts
const backendUrl = process.env.VITE_BACKEND_URL ?? 'http://localhost:8000'
// ...
proxy: {
  '/api': { target: backendUrl, changeOrigin: true },
  '/thumbnails': { target: backendUrl, changeOrigin: true },
}
```

### 7.6 Document the setup steps (not a code change)

The minimum manual steps on a new machine:

1. Copy the project folder (include `backend\data\` and `footage_brain.db`)
2. Install Python 3.11+, Node 18+, ffmpeg (all on PATH)
3. `cd footage-brain\backend && python -m venv venv && venv\Scripts\activate && pip install -r requirements.txt`
4. `cd ..\frontend && npm install`
5. Edit `backend\.env` — update `WHISPER_DEVICE`, CUDA settings for the new GPU
6. If footage drive letter changed: SQL update on `scan_roots.path` and `video_files.abs_path`
7. Run `start-dev.bat` from project root

---

## 8. Recommended Portable Folder Structure

This structure keeps everything self-contained. The project folder can be zipped, moved, or copied and will work anywhere with a Python + Node + ffmpeg install.

```
footage-brain/
├── backend/
│   ├── app/                    ← source code (unchanged)
│   ├── data/
│   │   ├── thumbnails/         ← generated thumbnails (portable if no abs paths)
│   │   ├── keyframes/          ← extracted keyframes
│   │   ├── chroma/             ← vector DB (Chroma persistent store)
│   │   └── models/             ← HuggingFace model cache (set HF_HOME here)
│   │       ├── hub/
│   │       │   ├── Systran/    ← faster-whisper models
│   │       │   └── openai/     ← CLIP model
│   │       └── sentence-transformers/
│   ├── footage_brain.db        ← SQLite main database
│   ├── footage_brain.db-wal    ← WAL journal (checkpoint before moving)
│   ├── .env                    ← machine-specific settings (git-ignored)
│   ├── .env.example            ← template for new machines
│   ├── requirements.txt
│   └── venv/                   ← Python virtualenv (recreate on new machine)
├── frontend/
│   ├── src/
│   ├── node_modules/           ← recreate with npm install on new machine
│   ├── package.json
│   └── vite.config.ts
├── start-dev.bat               ← Windows launcher (fix --reload flag)
├── PORTABLE_PLAN.md            ← this file
└── .claude/
    └── settings.local
```

**What to copy when moving to a new machine:**
- Everything except `backend/venv/` and `frontend/node_modules/`
- If models are in `backend/data/models/`, copy that too (saves 5 GB download)
- Always checkpoint WAL before copying DB: `PRAGMA wal_checkpoint(TRUNCATE)`

**What to recreate on the new machine:**
- `backend/venv/` via `python -m venv venv && pip install -r requirements.txt`
- `frontend/node_modules/` via `npm install`

---

## 9. Recommended Execution Order (New Machine Setup)

```
1. Install prerequisites
   ├── Python 3.11+  →  https://python.org  (add to PATH)
   ├── Node 18+      →  https://nodejs.org   (add to PATH)
   └── ffmpeg        →  https://ffmpeg.org/download.html  (add to PATH)

2. Copy project folder to destination

3. Checkpoint WAL (if copying a live DB)
   └── sqlite3 footage_brain.db "PRAGMA wal_checkpoint(TRUNCATE);"

4. Create Python venv
   └── cd backend
       python -m venv venv
       venv\Scripts\activate
       pip install -r requirements.txt

5. Install frontend deps
   └── cd frontend && npm install

6. Configure .env
   └── cp backend\.env.example backend\.env
       Edit: WHISPER_DEVICE, WHISPER_COMPUTE_TYPE, WHISPER_MODEL
       Edit: HF_HOME=./data/models  (if using bundled model cache)

7. Fix drive letter in DB (if footage moved to a new drive)
   └── sqlite3 footage_brain.db
       UPDATE scan_roots SET path = REPLACE(path, 'E:\', 'F:\');
       UPDATE video_files SET abs_path = REPLACE(abs_path, 'E:\', 'F:\');

8. Start backend (from backend/ directory, NO --reload)
   └── python -m uvicorn app.main:app --host 0.0.0.0 --port 8000

9. Start frontend (from frontend/ directory)
   └── npm run dev

10. Open http://localhost:5173
    └── Verify: Settings → Sources shows your footage folder
        Trigger re-scan if needed
        Confirm pipeline worker picks up jobs (check /api/queue/stats)
```

---

## Summary Table

| Risk | Severity | Affected component | Requires code change? |
|------|----------|-------------------|----------------------|
| `--reload` kills pipeline worker | **High** | `start-dev.bat:73` | No — 1 word deletion |
| Drive letter change breaks all file ops | **High** | `scan_roots`, `video_files.abs_path` | No — SQL UPDATE |
| Models re-download on new machine (5 GB) | **Medium** | HuggingFace cache | No — copy `data/models/` or set `HF_HOME` |
| venv/node_modules must be recreated | **Medium** | Standard Python/Node pattern | No — expected |
| `.env` not loaded if CWD is wrong | **Medium** | `config.py:16` | No — run from `backend/` |
| `ctypes.windll` → ImportError on Linux/macOS | **Low** | `thermal/sensors.py` | No — already caught by `try/except` in `main.py` |
| Vite proxy hardcodes `localhost:8000` | **Low** | `vite.config.ts:16` | No — only matters for remote backend |
| `ffmpeg-python` unused dep | **Cosmetic** | `requirements.txt:11` | No |
