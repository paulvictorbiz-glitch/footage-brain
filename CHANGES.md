# Footage Brain — Change Log

Rollback log for edits made by Claude. Each entry captures the OLD version of
the affected snippets before they were replaced, so a change can be reverted
by hand if needed. Newest entries on top.

Workflow per change:
1. Log the old snippet here before editing.
2. Build the task.
3. Verify it works (syntax check, type-check, smoke test, dev server, etc.).
4. Ask the user to confirm before treating the change as committed.

---

## 2026-05-15 — Initialize git repo and push to GitHub (checkpoint)

**Goal:** snapshot the project as a recoverable checkpoint on GitHub.

**Old state**

- Project is not a git repo (no `.git/`).
- `.gitignore` excludes `venv/`, `data/`, `*.db`, `.env`, `node_modules/`, `frontend/dist/`, `*.log` — but **does NOT exclude `portable_data_test/`** (8 GB of model weights, Chroma vectors, thumbnails) or `backend/tools/` (FFmpeg binaries, ~80 MB).

**Plan**

1. Append `portable_data_test/`, `backend/tools/`, `torch_upgrade.log*`, and the stray `{backend/` typo dir to `.gitignore`.
2. `git init`, `git add .`, sanity-check staged size is <200 MB and no `.env` / model weights leaked through.
3. Local commit.
4. Ask user for remote URL + visibility before pushing (gh CLI is not installed, so I can't create the repo; need a URL).

**Status:** in progress.

---

## 2026-05-15 — Surface all 7 pipeline stages + per-stage ETAs on Dashboard

**Goal:** the Pipeline Speed card only renders 5 stages (`metadata`, `hash`,
`thumbnail`, `transcript`, `embed`) because the backend `/api/tools/indexing-speed`
hardcodes a 5-stage list. With multimodal embeddings live, the user wants to
see `clip_embed` and `caption` progress too, plus a per-stage ETA next to each
rate so they can tell how long each model has left to grind.

**Old state**

`backend/app/api/tools.py:289`

```python
stages = ["metadata", "hash", "thumbnail", "transcript", "embed"]
```

Per-stage response payload (no ETA in stage dict, only an overall `eta_hours`):

```python
result.append({
    "stage": stage,
    "rate_per_hour": rate,
    "done": done,
    "pending": pending,
    "paused": paused,
    "processing": processing,
    "failed": failed,
})
```

`frontend/src/pages/Dashboard.tsx` — already renders whatever stages the
backend returns (`data.stages?.map`) and already has `stageColors` /
`stageLabels` entries for `clip_embed` and `caption` (added earlier today),
so once the backend includes them they'll appear automatically. ETA badge
needs adding next to the per-stage rate.

**Plan**

1. `tools.py`: include `clip_embed` and `caption` in the stages list (drive from `STAGE_HANDLERS` keys so the list stays in sync if more stages are added). Add a 10-min rate window in addition to 1-hr; per-stage `eta_seconds` (pending ÷ rate, preferring 10-min if non-zero). Add a global `eta_seconds_total` (sum across stages). Keep `eta_hours` for backward compat.
2. `Dashboard.tsx`: add a small ETA badge next to each stage's rate. Update the bottom ETA line to use the new total.
3. Verify by hitting `/api/tools/indexing-speed` and confirming 7 stages with `eta_seconds` each.

**Verification (post-restart, port 8765, PID 24228):**

- `tsc --noEmit` clean.
- `GET /api/tools/indexing-speed` returns 7 stages: `metadata, hash, thumbnail, transcript, embed, clip_embed, caption`.
- `active_stage: "caption"`, `eta_seconds_total: 1984` (~33 min), `eta_hours: 0.6`.
- Caption stage: `done=18 pending=43 rate_per_hour=18 rate_per_10min=13 eta_seconds=1984`. The 10-min rate dominates (BLIP-large warmed up) — confirms the short-window override works as intended.

**Status:** ✅ committed 2026-05-15 (user sign-off).

---

## 2026-05-15 — Swap captioner model to BLIP-large; restart backend

**Goal:** unblock the VLM captioner. `Salesforce/blip-image-captioning-base`
ships only `pytorch_model.bin`; transformers refuses to load `.bin` weights
under torch < 2.6 (CVE-2025-32434), which crashes every caption job.

**Path NOT taken:** upgrading torch. cu121 wheels are capped at 2.5.1
(PyTorch dropped that channel). Switching to cu124 would risk breaking
faster-whisper / CLIP / sentence-transformers, all of which use torch.

**Path taken:** swap captioner model to `Salesforce/blip-image-captioning-large`.
Same architecture (`BlipForConditionalGeneration`), my loader's BLIP path
handles it as-is, ships with `model.safetensors`, ~1.9 GB download.

**Old state**

- `backend/.env` — `CAPTIONER_MODEL=Salesforce/blip-image-captioning-base`
- `backend/app/core/config.py` — `captioner_model: str = "Salesforce/blip-image-captioning-base"`
- Running backend (PID 14532, port 8765) — started before recent dashboard/pipeline edits, missing `/api/dashboard/streams/reconcile` route and `caption` STAGE_HANDLERS entry. Already stopped.

**Plan**

1. Edit `.env`: `CAPTIONER_MODEL=Salesforce/blip-image-captioning-large`
2. Edit `config.py` default to match.
3. Restart backend (system Python 3.12, `-m uvicorn app.main:app --host 0.0.0.0 --port 8765`).
4. Verify:
   - `/api/dashboard/streams/reconcile` POST → 200
   - log shows `captioner_model_ready` for `blip-image-captioning-large` on next caption job
5. Ask user to confirm before treating as committed.

**Verification (post-restart, port 8765, PID 15568):**

- `GET /health` → 200
- `POST /api/dashboard/streams/reconcile` → 200, response `{"requeued":{"caption":61,"embed":0}}` (was 405 on the old binary)
- `POST /api/dashboard/streams/rebuild` route registered in OpenAPI schema
- No `unknown_stage: caption` warnings after restart — pipeline.py STAGE_HANDLERS picked up the `caption` entry
- Captioner load: `captioner_model_load Salesforce/blip-image-captioning-large` at 21:44:14 → `captioner_model_ready cuda float16` at 21:48:58 (≈4.5 min download for ~1.9 GB)
- First post-restart caption job: `caption_done 20241215_184503.mp4 (1 frame)` → `job_done caption` at 21:49:07. No torch.load error.

**Status:** ✅ committed 2026-05-15 (user sign-off).

## 2026-05-15 — Multimodal embeddings build-out (retroactive log)

**Goal:** make Footage Brain's three-stream multimodal search fully operational
out of the box (Whisper transcripts + CLIP visual frames + VLM captions), with
a search UI for all modes and switchable vector backends.

This entry is retroactive — the workflow rule was set after these edits
landed. The changes are listed for traceability; old snippets were not
captured at the time.

**Files touched**

- [backend/app/core/config.py](backend/app/core/config.py) — flipped `captioner_enabled` default to `True`, added `vector_store`, `qdrant_*`, `lancedb_*` settings and `data_root` derivation for them.
- [backend/.env](backend/.env) — appended `CAPTIONER_*` and `VECTOR_STORE` keys.
- [backend/app/ingest/captioner.py](backend/app/ingest/captioner.py) — `_get_model()` auto-detects BLIP / LLaVA / Qwen2-VL / SmolVLM; `caption_images()` dispatches to chat-template prompting for conversational VLMs.
- [backend/app/vector/store.py](backend/app/vector/store.py) — added `QdrantVectorStore` and `LanceDBVectorStore`; `_build_store()` factory picks backend from `VECTOR_STORE` setting.
- [backend/requirements.txt](backend/requirements.txt) — added `qdrant-client`, `lancedb`, `pyarrow`.
- [backend/app/api/files.py](backend/app/api/files.py) — `reprocess_file()` now resets the matching stream flag on `VideoFile` before re-queuing the job (handler was short-circuiting otherwise).
- [backend/app/api/dashboard.py](backend/app/api/dashboard.py) — new `POST /streams/reconcile` and `POST /streams/rebuild`.
- [backend/app/ingest/reconcile.py](backend/app/ingest/reconcile.py) — NEW. `reconcile_streams()` detects flag-vs-artifact mismatches and re-queues only the stale streams; `rebuild_all_streams()` force-rebuilds everything.
- [backend/app/main.py](backend/app/main.py) — runs `reconcile_streams()` once at startup.
- [frontend/src/api/client.ts](frontend/src/api/client.ts) — `SearchRequest.mode` accepts `caption` and `multimodal`; new `reconcileStreams()` / `rebuildStreams()` client methods.
- [frontend/src/pages/Search.tsx](frontend/src/pages/Search.tsx) — six search-mode buttons (Semantic, Keyword, Hybrid, Visual, Caption, Multimodal) with mode-specific placeholders and result colors.
- [frontend/src/pages/Dashboard.tsx](frontend/src/pages/Dashboard.tsx) — Pipeline Speed card now shows `clip_embed` and `caption` stages, plus `↺ Reconcile` and `↻ Rebuild All` buttons.

**Verification**

- `python -c "import ast; ..."` — all backend modules parse.
- `python -c "from app.main import create_app; ..."` — app boots, new routes registered at `/api/dashboard/streams/reconcile` and `/api/dashboard/streams/rebuild`.
- `tsc --noEmit` — frontend type-checks clean.
- Dev server / UI behavior — NOT exercised end-to-end. Pending user confirmation.

**Status:** ✅ committed 2026-05-15 (user sign-off — confirmed by extended use of the resulting features).
