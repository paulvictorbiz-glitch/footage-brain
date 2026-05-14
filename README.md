# Footage Brain

A self-hosted, local-first semantic video search and archive system for large personal media libraries.

Designed for filmmakers and content creators with footage spread across local drives, external HDDs, and mounted cloud folders. No cloud upload required — all processing runs on your machine.

---

## What it does

- **Scans** multiple root folders (local drives, external drives, mounted Google Drive, etc.)
- **Extracts** technical metadata: duration, resolution, codec, fps, audio presence
- **Deduplicates** files by SHA256 across all sources
- **Transcribes** speech with timestamps using faster-whisper (local, private)
- **Indexes** transcript chunks with semantic embeddings (sentence-transformers + Chroma)
- **Searches** your library by meaning: *"sunrise drone shot mountains"*, *"person talking indoors"*, *"clips mentioning Syria"*
- **Manages** duplicate groups with canonical file selection
- **Streams** video previews directly from original file paths

---

## Quick Start (Windows – Local Dev)

### Prerequisites

1. **Python 3.11+** – https://www.python.org/downloads/
2. **Node.js 18+** – https://nodejs.org/
3. **ffmpeg** – https://ffmpeg.org/download.html  
   → Add `ffmpeg/bin` to your system PATH
4. (Optional) **CUDA** for GPU-accelerated transcription

### Setup

```bat
git clone <this-repo>
cd footage-brain

REM Copy and configure environment
copy backend\.env.example backend\.env
REM Edit backend\.env to set your preferences

REM Run the dev startup script (handles venv + npm install automatically)
start-dev.bat
```

Open **http://localhost:5173** in your browser.

### First run

1. Go to **Sources** → Add a folder path (e.g. `D:\Videos\Projects`)
2. Click **Scan** → files are discovered and queued
3. Watch the **Overview** dashboard as indexing progresses
4. Use the **Search** page once transcription + embedding completes

---

## Quick Start (Docker)

```bash
# Copy env file
cp backend/.env.example backend/.env

# Add your drive mounts to docker-compose.yml:
# volumes:
#   - "D:/Videos:/mnt/videos:ro"

docker compose up --build
```

Open **http://localhost:3000**

---

## Configuration (`.env`)

| Variable | Default | Description |
|---|---|---|
| `WHISPER_MODEL` | `base` | `tiny` / `base` / `small` / `medium` / `large-v2` |
| `WHISPER_DEVICE` | `cpu` | `cpu` or `cuda` |
| `WHISPER_COMPUTE_TYPE` | `int8` | `int8` / `float16` / `float32` |
| `EMBED_MODEL` | `all-MiniLM-L6-v2` | Any sentence-transformers model |
| `INGEST_WORKERS` | `2` | Parallel background jobs |
| `FRAME_SAMPLE_INTERVAL` | `15` | Seconds between extracted frames |
| `VIDEO_EXTENSIONS` | `.mp4,.mov,.avi,...` | Comma-separated list |

**Model recommendations by hardware:**

| Hardware | Whisper model | Speed |
|---|---|---|
| CPU only | `base` or `small` | ~5-10× real-time |
| GPU (4GB) | `medium` | ~20× real-time |
| GPU (8GB+) | `large-v3` | ~30× real-time |

---

## Architecture

```
footage-brain/
├── backend/
│   ├── app/
│   │   ├── api/          # FastAPI routers (sources, files, search, duplicates, dashboard, media)
│   │   ├── core/         # Config (pydantic-settings), structured logging
│   │   ├── db/           # SQLAlchemy models + session management
│   │   ├── ingest/       # Pipeline stages
│   │   │   ├── scanner.py      # Walk roots, discover files, queue jobs
│   │   │   ├── metadata.py     # ffprobe extraction + thumbnail
│   │   │   ├── hasher.py       # SHA256 + duplicate group linking
│   │   │   ├── transcriber.py  # faster-whisper speech-to-text
│   │   │   ├── chunker.py      # Segment → chunk with overlap
│   │   │   ├── embedder.py     # sentence-transformers → Chroma upsert
│   │   │   ├── keyframes.py    # Frame sampling (Phase 2 visual embeddings hook)
│   │   │   └── pipeline.py     # ThreadPoolExecutor job queue
│   │   ├── search/       # Semantic + keyword + hybrid search engine
│   │   └── vector/       # VectorStore abstraction (Chroma MVP, swappable)
│   └── scripts/
│       └── seed.py       # Dev/test data seeder
└── frontend/
    └── src/
        ├── pages/        # Dashboard, Search, FileDetail, Duplicates, Sources
        ├── components/   # AppShell, VideoCard, StatCard, PageHeader
        ├── api/          # Typed API client
        └── lib/          # Utilities (formatBytes, formatDuration, etc.)
```

### Ingest Pipeline

```
scan → metadata → hash → thumbnail → transcript → embed
  ↕        ↕        ↕        ↕            ↕          ↕
 SQL      SQL      SQL     disk         SQL +       Chroma
                                        chunks      vector DB
```

Each stage is tracked as an `IngestJob` row in SQLite with status `pending / processing / done / failed`. The worker is safe to restart — incomplete jobs resume automatically. Files are only reprocessed if their `mtime` or `size` changes.

### Search

- **Semantic**: Query → sentence-transformers embedding → Chroma cosine similarity → join VideoFile metadata
- **Keyword**: SQL LIKE over transcript text + filenames
- **Hybrid**: Run both, merge by best score per file

### Vector Store

The `VectorStore` abstract class in `app/vector/store.py` wraps Chroma for Phase 1. To swap in Qdrant or Milvus for Phase 2, implement the 4-method interface and update `get_vector_store()`.

---

## API Reference

Interactive docs at **http://localhost:8000/api/docs**

Key endpoints:

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/dashboard/stats` | Overall library statistics |
| `GET` | `/api/sources` | List scan roots |
| `POST` | `/api/sources` | Add scan root |
| `POST` | `/api/sources/{id}/scan` | Trigger scan |
| `POST` | `/api/search` | Semantic / keyword / hybrid search |
| `GET` | `/api/files/{id}` | File metadata |
| `GET` | `/api/files/{id}/transcript` | Transcript chunks |
| `POST` | `/api/files/{id}/reprocess` | Re-queue pipeline stages |
| `GET` | `/api/duplicates` | List duplicate groups |
| `POST` | `/api/duplicates/{id}/set-canonical` | Set canonical file |
| `GET` | `/api/media/thumbnail/{id}` | Serve thumbnail JPEG |
| `GET` | `/api/media/stream/{id}` | HTTP range-request video stream |

---

## Safety Guarantees

- **No files are ever deleted** by this application
- **No automatic moves/copies** — archive actions are preview-only until explicitly triggered
- **No external uploads** — all transcription and embedding runs locally
- All destructive operations require explicit per-action confirmation

---

## Development

### Seed with test data

```bash
cd backend
source venv/bin/activate  # or venv\Scripts\activate on Windows

# Create tiny sample videos + scan them
python -m scripts.seed --folder ./test_videos --create-samples

# Or point at real footage
python -m scripts.seed --folder "D:/Videos/MyProject"
```

### Backend only

```bash
cd backend
uvicorn app.main:app --reload
```

### Frontend only

```bash
cd frontend
npm run dev
```

---

## Roadmap – Phase 2

See [ROADMAP.md](./ROADMAP.md) for full Phase 2 plan.

**High priority next steps:**
1. Visual embeddings via CLIP on extracted keyframes
2. Hybrid ranking: transcript score × visual score × metadata boost
3. Shot boundary detection (replace fixed-interval keyframe sampling)
4. Near-duplicate detection via perceptual hash (ImageHash)
5. Active folder watching with `watchdog`
6. Postgres support for larger libraries
7. Project auto-inference from folder names
8. CSV export of search results and duplicate reports
9. Timeline heatmap of matched segments in video detail
10. Face/person tag placeholders (Phase 3)
