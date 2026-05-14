# Footage Brain – Phase 2 Roadmap

## Status: Phase 1 complete

Phase 1 delivers: scan, metadata, dedup, transcription, semantic search, full UI.

---

## Phase 2 – Visual Intelligence

### 2.1 CLIP-based Visual Embeddings

**Goal:** Search by visual content, not just speech.

**Implementation:**
1. Load keyframes from `data/keyframes/<file_id>/`
2. Run each through `openai/clip-vit-base-patch32` (via `transformers` or `open_clip`)
3. Upsert to a new Chroma collection: `keyframe_embeddings`
4. At query time: embed query with CLIP text encoder
5. Search both `transcript_chunks` AND `keyframe_embeddings`
6. Merge/rerank: `final_score = α × transcript_score + (1-α) × visual_score`

**Files to modify:**
- `app/ingest/keyframes.py` – implement `embed_keyframes_phase2()`
- `app/vector/store.py` – add `KeyframeVectorStore` collection
- `app/search/engine.py` – add `visual_search()`, update `hybrid_search()`
- `app/ingest/pipeline.py` – add `keyframes` + `visual_embed` stages

**Estimated queries that unlock:**
- "sunrise drone shot mountains" ✓
- "person in yellow jacket" ✓
- "indoor scene with warm lighting" ✓

---

### 2.2 Shot Boundary Detection

**Goal:** Replace fixed-interval keyframe sampling with scene-aware sampling.

**Options:**
- `ffmpeg -vf "select='gt(scene,0.4)'"` (simple, no extra deps)
- `PySceneDetect` (more accurate, content-aware)

**Files:** `app/ingest/keyframes.py` – add `detect_shots()` function

---

### 2.3 Near-Duplicate Perceptual Hashing

**Goal:** Catch "same video, re-exported at different resolution" cases that SHA256 misses.

**Implementation:**
1. Extract first frame of each video
2. Compute `dhash` or `phash` using `imagehash` library
3. Compare all hashes pairwise using Hamming distance threshold (~8 bits)
4. Group near-duplicates into `NearDuplicateGroup` table

**Files to add:** `app/ingest/perceptual_hash.py`, new DB model `NearDuplicateGroup`

---

### 2.4 Active Folder Watching

**Goal:** Auto-detect new files added to watched folders.

**Implementation:** Use `watchdog` library with `FileSystemEventHandler`.
Trigger scanner on `created`/`moved` events with debounce.

**Files to add:** `app/ingest/watcher.py`, start in `lifespan()`

---

## Phase 2 – UX Improvements

### 2.5 Timeline Heatmap

In the video detail page, show a visual timeline bar with colored segments
where search matches were found. Click to jump to that timestamp.

### 2.6 CSV Export

- Export search results as CSV: filename, path, score, timestamp, transcript snippet
- Export duplicate report: group ID, canonical path, all copy paths, sizes

### 2.7 Saved Searches

The `saved_searches` table already exists in the DB. Wire up:
- POST `/api/searches/saved` to save
- GET `/api/searches/saved` to list
- Show saved searches in sidebar

### 2.8 Project Auto-Tagging

Infer project tag from folder structure heuristics:
- Parent folder name
- Date ranges from filenames
- Common naming patterns (e.g. `CLIENT_DATE_SHOOT`)

---

## Phase 3 – Scale & Operations

### 3.1 Postgres Support

Switch `DATABASE_URL` to Postgres for libraries with >100k files.
All SQLAlchemy models are already portable — only needs connection URL change.

### 3.2 Celery/RQ Task Queue

The `IngestJob` table + `PipelineWorker` abstraction is designed to swap in Celery:
- Replace `ThreadPoolExecutor` with Celery `apply_async()`
- Keep the same job status tracking in SQLite/Postgres
- Add Redis as broker

### 3.3 Vector DB Upgrade

The `VectorStore` interface in `app/vector/store.py` takes <100 lines to implement for Qdrant or Milvus.
Recommended for libraries >1M chunks.

### 3.4 Face/Person Tags (Phase 3)

- Run `face_recognition` or `InsightFace` on keyframes
- Cluster face embeddings by identity
- Allow manual labeling of clusters → auto-tag new frames
- Search: "clips featuring [Person]"

---

## Known Limitations (Phase 1)

- Whisper transcription quality depends on audio quality and model size
- Semantic search quality limited to transcript content until visual embeddings are added
- Very large files (>50GB) may be slow to hash — consider partial hashing
- SQLite WAL mode handles concurrent reads well but single writer is a bottleneck for >10 workers
