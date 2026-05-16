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

## 2026-05-15 — Surface skipped counts on Phase Analytics + Pipeline Speed

Cards now show how many jobs were intentionally skipped (e.g. `35 skipped`
on the VLM row) so the user can tell at a glance that "not 100% done"
doesn't mean "still working." Numbers come from the same data the
Coverage page uses.

Also fixed in the Ziflow project (separate file, logged in
[`ziflow project-final/CHANGES.md`](../../ziflow%20project-final/CHANGES.md)):

- Preview button in Footage Brain Search modal pointed to
  `localhost:5173` (Vite dev port). In production Footage Brain serves on
  `localhost:8765`. Switched to 8765.
- Music + Inspiration links are now always-visible buttons on the reel
  detail header, editable post-create. Amber when a link is attached,
  muted otherwise.

---

## 2026-05-15 — Captioner no-frames path → skipped (with reason) instead of done

**Follow-up to the reconcile bounce-loop fix.** The captioner used to mark
jobs `done` when frame extraction produced zero frames. Visually that read
as "complete," but downstream the file had zero `FrameCaption` rows and
search returned no hits. Now those jobs end as `skipped` with a clear
reason so the Coverage view can render them distinctly and the user knows
why search came back empty.

### New `StageSkip` exception (`app/ingest/pipeline.py`)

A handler can now `raise StageSkip("no_frames_extracted")` to opt the job
into `status='skipped'` with `error_message=<reason>`. Old paths
(`return False` → failed, raised exception → failed) are unchanged.

### Captioner change (`app/ingest/caption_embedder.py:87-92`)

Old:

```python
frame_infos = _extract_frames(vf.abs_path, interval, tmpdir)
if not frame_infos:
    logger.info("caption_no_frames", file=vf.filename)
    vf.captioned = True
    vf.updated_at = datetime.utcnow()
    session.flush()
    return True
```

New: raises `StageSkip("no_frames_extracted")` instead of marking
captioned=True/returning success. The job runner converts that into
`status='skipped', error_message='no_frames_extracted'`. `captioned`
flag stays False because the file isn't really captioned.

### Reconcile (`app/ingest/reconcile.py:_files_missing_captions`)

The "settled status" set now includes `skipped` alongside `done` and
`paused`. Skipped files won't be bounced back into the queue on startup.

### Coverage cell color (frontend)

Skipped cells render as a distinct muted gray with a small dot, separate
from "none done" (dark) and "fully done" (green). Tooltip surfaces the
skip reason (`"VLM: skipped — no_frames_extracted"`).

### One-off DB backfill

Already-existing caption jobs with `status='done'` but zero FrameCaption
rows are reclassified to `status='skipped',
error_message='no_frames_extracted'`. The corresponding `video_files.captioned`
flag is reset to False so coverage stats reflect reality.

---

## 2026-05-15 — Bug fix: caption reprocesses on every restart, pause-toggle lost

**Symptom:** user paused VLM via the toggle, restarted backend, and saw VLM
captions running again. DB inspection showed 31 of 61 caption jobs went from
`done` back to `paused` (after being briefly reset to `pending` and picked up
by the worker).

**Root cause (two-part):**

1. `caption_embedder.py:88` sets `vf.captioned = True` and returns `True` even
   when `_extract_frames` returns no frames. Job ends `done` but **zero**
   `FrameCaption` rows get written for that file.

2. `reconcile_streams` runs on every backend startup
   (`app/main.py:65`). Its `_files_missing_captions` predicate returns every
   file with zero FrameCaption rows — so 35 of the user's 61 files were
   re-queued on each boot. `_upsert_pending` resets the job to `pending` and
   wipes the `error_message` field, **silently destroying the
   pause-by-toggle marker** my round-1 code wrote.

**Old `reconcile.py:54-77` (`_files_missing_captions`):**

```python
def _files_missing_captions(session: Session) -> List[str]:
    settings = get_settings()
    if not settings.captioner_enabled:
        return []

    sub = (
        session.query(FrameCaption.video_file_id, func.count(FrameCaption.id).label("n"))
        .group_by(FrameCaption.video_file_id)
        .subquery()
    )
    rows = (
        session.query(VideoFile.id)
        .outerjoin(sub, VideoFile.id == sub.c.video_file_id)
        .filter(VideoFile.duration_seconds.isnot(None))
        .filter(VideoFile.duration_seconds >= 1)
        .filter((sub.c.n.is_(None)) | (sub.c.n == 0))
        .all()
    )
    return [r[0] for r in rows]
```

**Old `reconcile.py:103-135` (`reconcile_streams`):**

```python
def reconcile_streams(session: Session) -> Dict[str, int]:
    counts: Dict[str, int] = {"caption": 0, "embed": 0}

    for fid in _files_missing_captions(session):
        vf = session.get(VideoFile, fid)
        if vf is None:
            continue
        vf.captioned = False
        _upsert_pending(session, fid, "caption")
        counts["caption"] += 1
    ...
```

**Fixes**

- `_files_missing_captions` now additionally excludes files whose latest
  `caption` ingest job is already in `done` or `paused` status. The job
  table is the source of truth; if a job is `done`, trust it (even if zero
  caption rows were written, that's a captioner limitation, not a
  reconcile target). If a job is `paused`, the user explicitly chose that.
- `reconcile_streams` now reads the persistent pipeline_settings toggles
  and skips caption/clip_embed reconciliation when those stages are
  disabled.
- One-off DB cleanup: 31 jobs currently in `paused` for the user — they
  reflect the original `done` state confused by the bounce-loop. Manually
  reset them to `done` so the user starts from a clean baseline.

### Captioner "no_frames" behaviour (left alone for now)

The captioner returning `True` with zero captions saved is still odd, but
fixing that is a separate behaviour change (would either fail the job or
mark it skipped). For now: stop the bounce-loop and trust whatever the
captioner decided last time.

---

## 2026-05-15 — Round 2: global ziflow theme port, strip soon-only nav, Coverage page, Search/Timeline restyle

**Goal:** port ziflow's blue-cinematic dark palette + Cormorant/Inter/JetBrains
Mono typography globally. Strip the 9 placeholder nav items that route nowhere
(`soon: true`). Add a Coverage page with a per-root → per-folder tree colored
by stage completion. Apply consistent header / pill style to Search and
Timeline.

**Old tailwind palette** (`frontend/tailwind.config.js`):

```js
colors: {
  surface: {
    0: '#0a0a0b',   // deepest bg
    1: '#111113',   // main bg
    2: '#18181b',   // card bg
    3: '#1e1e22',   // hover bg
    4: '#27272b',   // border
    5: '#3f3f46',   // muted border
  },
  accent: { DEFAULT: '#f59e0b', muted: '#92400e', dim: '#451a03' },
  ok: '#22c55e', warn: '#f59e0b', err: '#ef4444', info: '#3b82f6',
},
fontFamily: {
  mono: ['"JetBrains Mono"', '"Fira Code"', 'ui-monospace', 'monospace'],
  sans: ['"DM Sans"', 'system-ui', 'sans-serif'],
  display: ['"Space Grotesk"', '"DM Sans"', 'sans-serif'],
},
```

**Old nav (working tabs only after this change):**

Library: Overview, Search, Folders, Duplicates, **+ Coverage (new)**
Production: Timeline
Workspace: Sources

Removed `soon: true` entries: Idea Inbox, Blueprints, Projects, Calendar,
Locations, Publishing, Analytics, Team, Settings (Settings will come back
once it's wired — kept the Settings backend endpoint untouched).

**New backend endpoint:** `GET /api/dashboard/coverage-tree` returns

```jsonc
{
  "stages": ["metadata","hash","thumbnail","transcript","embed","clip_embed","caption"],
  "roots": [
    {
      "root_id": "...",
      "label": "D:\\Footage",
      "path": "D:\\Footage",
      "is_online": true,
      "file_count": 61,
      "folders": [
        { "rel_path": "2024-12", "file_count": 12,
          "stage_counts": { "metadata": 12, "hash": 12, ..., "caption": 0 } }
      ]
    }
  ]
}
```

Frontend renders this as a tree: root → folder. Each folder shows a 7-cell
strip, one cell per stage, colored:
  green  = 100% complete for that stage on that folder
  amber  = partially done
  zinc   = none done
  zinc/dashed = stage disabled by current CLIP/VLM toggle

**Search / Timeline restyle:** the palette swap does most of the work
globally. Targeted updates: page headers get a faint serif-italic flourish
to echo ziflow's "Workflow" cinematic title style; search-mode chip row
gets ziflow's dashed-pill look.


**Goal:** let editors disable CLIP frame embedding and VLM caption stages to
save GPU/time when transcript-based search is good enough, with a persistent
toggle that survives restart. Replace the static "Indexing Pipeline" tally
card on the Dashboard with a more useful per-phase timing analytics card.

### A. Pause/Resume CLIP+VLM (persistent)

**New file:** `backend/portable_data_test/pipeline_settings.json`
- Stores `{"clip_embed_enabled": true, "caption_enabled": true}` (or false).
- Read at worker start and on every loop tick (cheap; <1 ms).

**Backend additions** (new endpoints in `app/api/dashboard.py`):
- `GET  /api/dashboard/pipeline-toggles` — returns current enable flags.
- `POST /api/dashboard/pipeline-toggles` — body `{clip_embed?: bool, caption?: bool}`.
  - Disabling a stage: marks all its `pending` jobs as `paused` (NOT in-flight
    `processing` jobs — those finish on their own).
  - Enabling a stage: requeues `paused` rows back to `pending` AND creates
    fresh jobs for any video file where `transcript` is done but the stage's
    job is missing entirely.

**Worker change** (`app/ingest/pipeline.py`, `_get_pending_job_ids`):

Old (line 102-117):
```python
def _get_pending_job_ids(session: Session, limit: int = 50) -> List[str]:
    stage_order = ["metadata", "hash", "thumbnail", "transcript", "embed", "clip_embed", "caption"]
    jobs = (
        session.query(IngestJob.id, IngestJob.stage)
        .filter(IngestJob.status.in_(["pending"]))
        .all()
    )
    ...
```

The new version reads the settings file and filters out `clip_embed` /
`caption` when disabled. Currently-running jobs are not interrupted — they
finish naturally because the executor is already running them.

### B. Remove Indexing Pipeline mini-card from Dashboard

Old snippet (`frontend/src/pages/Dashboard.tsx` lines 389-413):

```tsx
{stats && (
  <div className="card p-4">
    <p className="label mb-3">Indexing Pipeline</p>
    <div className="space-y-2.5">
      {[
        { label: 'Metadata extracted', count: stats.total_indexed },
        { label: 'Transcribed', count: stats.total_transcribed },
        { label: 'Embedded (searchable)', count: stats.total_embedded },
      ].map(({ label, count }) => {
        const pct = stats.total_files > 0 ? (count / stats.total_files) * 100 : 0
        return (
          <div key={label} className="flex items-center gap-3">
            <span className="text-xs text-zinc-400 w-44 flex-shrink-0">{label}</span>
            <div className="flex-1 h-1.5 bg-surface-3 rounded-full overflow-hidden">
              <div className="h-full bg-accent/60 rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
            </div>
            <span className="text-xs text-zinc-500 font-mono w-24 text-right">
              {count.toLocaleString()} / {stats.total_files.toLocaleString()}
            </span>
          </div>
        )
      })}
    </div>
  </div>
)}
```

This block is removed; the same info (and more) is now exposed via the
per-phase analytics card.

### C. Per-Phase Analytics card (new)

**New backend endpoint:** `GET /api/dashboard/phase-analytics?scope=latest|all_time`

For each of the 7 stages, returns:
- `done_count`
- `active_seconds` (sum of per-job durations, capped at 600s/job to exclude
  pause-resume artifacts the way I did when answering the timing question)
- `mean_seconds_per_job`
- `pct_of_total` (computed across the 7 stages)

`scope=latest` filters to the most recent ingest run (jobs from the last
contiguous 24h window with activity).

**New frontend component:** `PhaseAnalyticsCard.tsx` rendered on Dashboard
right where the old Indexing Pipeline card was. Has a "Latest run / All time"
toggle in the card header.

### Deferred to follow-up (not in this commit)

- Theme port (ziflow palette into Tailwind config + index.css). Will be a
  global change because Tailwind is global; flagging that ahead of time.
- Coverage page (drive tree colored by phase status).
- Search and Timeline page restyling beyond inheriting the global palette.

---

## 2026-05-15 — Intro splash: "hello paul" wavy greeting on startup

**Goal:** small joy on every cold load. Full-screen splash that fades in,
renders "hello paul" with each letter bobbing in a staggered wave, then
auto-fades out after ~2.5s. Click anywhere to dismiss early. App renders
underneath the whole time so the splash is purely cosmetic.

**Plan**

1. NEW `frontend/src/components/IntroSplash.tsx` — a fixed-position overlay
   that mounts once and unmounts itself after the fade-out. Letters use a
   per-character `animationDelay` driving a shared `wave` keyframe.
2. Define the `wave` and `splash-fade` keyframes in `frontend/src/index.css`
   under `@layer utilities` (project pattern).
3. Mount `<IntroSplash />` once in `frontend/src/main.tsx` alongside
   `<AppShell>` so it appears on initial load regardless of route.

**What changed**

- NEW `frontend/src/components/IntroSplash.tsx` — 45-line state machine: `showing` → `fading` → `gone`. Each letter gets a `90 * i` ms `animationDelay` driving the shared `intro-wave` keyframe.
- `frontend/src/index.css` — added `@keyframes intro-wave / intro-fade-in / intro-fade-out` plus `.intro-splash` / `.intro-splash-text` / `.intro-splash-letter` styles. Splash uses `font-family: 'Cormorant Garamond'` (the existing `font-display` family) at cyan `#6bd6e0` (the accent colour) with a soft glow.
- `frontend/src/main.tsx` — `<IntroSplash />` mounted once at the BrowserRouter level.

**Verification**

- `tsc --noEmit` clean.

**Status:** ✅ committed 2026-05-15 (user sign-off).

---

## 2026-05-15 — Search-diagnose tool

**Goal:** a single page that runs one query through every search mode
(semantic / keyword / hybrid / visual / caption / multimodal) and shows the
top-3 results side-by-side. Lets the user sanity-check that each mode
actually retrieves sensible clips without clicking through six times in the
main Search UI.

**Plan**

1. Backend: new `GET /api/tools/search-diagnose?q=<query>&n=3` — invokes
   each mode in `SEARCH_MODES`, returns `{query, n, results: {mode: [...]}}`.
   Reuses the existing `search.engine.search()` dispatcher so any future
   mode added there is picked up automatically.
2. Frontend: new `/diagnose` page with an input + six columns rendering the
   top-3 results per mode. Reuses the existing `SearchResultOut` shape and
   thumbnail/snippet markup from the main Search page.
3. Add a nav link in `AppShell.tsx`.

**What changed**

- NEW `GET /api/tools/search-diagnose?q=<query>&n=<top-N>` in `backend/app/api/tools.py` — invokes `search()` once per mode in `SEARCH_MODES`, returns a per-mode top-N projection with thumbnail, snippet, frame timestamp, score. Per-mode failures are surfaced as `{"_error": "..."}` instead of failing the whole request.
- NEW `api.searchDiagnose(q, n)` client method in `frontend/src/api/client.ts`.
- NEW `frontend/src/pages/Diagnose.tsx` — input + top-N selector + six side-by-side mode cards. Visual / Caption / Multimodal columns get coloured left-borders (violet / emerald / amber) so the multimodal column draws the eye. Each result row links to `/files/:id?t=<seconds>` when a frame timestamp is present, so clicking deep-links to the matched moment.
- NEW `/diagnose` route in `frontend/src/main.tsx`; NEW nav entry "Diagnose" in the Library section of `AppShell.tsx` (TestTube2 icon).

**Verification**

- Backend: `create_app()` registers `/api/tools/search-diagnose` (confirmed via route enumeration).
- `tsc --noEmit` clean.
- Running server doesn't have the endpoint yet — needs a backend restart. The frontend was hot-reloaded so the nav link + page are already live, but clicking "Run" will fail until the restart completes.

**Status:** ✅ committed 2026-05-15 (user sign-off).

---

## 2026-05-15 — Tier 3 refactor: split dashboard.py + sync search modes + split Timeline.tsx

**Items in this batch:**

**#9 — Split `api/dashboard.py` (641 lines) into focused route files.**
Today the file mixes 19 endpoints across 5 concerns: stats, jobs (queue +
pause/resume), streams (reconcile + rebuild), folders/coverage, and analytics.
Splitting into `api/dashboard/` package:

```
backend/app/api/dashboard/
  __init__.py        (the APIRouter, re-exports everything)
  stats.py           (dashboard stats endpoint)
  jobs.py            (queue, cancel, pause, resume, reset-failed, skip-stage, restore, stage-status, create-clip-embed)
  streams.py         (reconcile, rebuild)
  folders.py         (folders, coverage-tree)
  analytics.py       (phase-analytics)
  settings.py        (settings, pipeline-toggles)
```

URL paths preserved exactly — only the source location changes.

**#10 — Sync-check search modes backend↔frontend.** Lighter scope than
originally proposed: instead of making the frontend fetch the mode list at
runtime (which would lose compile-time type safety), expose
`GET /api/search/modes` returning the backend's list of supported modes, and
have the frontend's app shell call it once at boot. On mismatch, emit a
console warning. Catches "I renamed `multimodal` in the backend but forgot
the frontend" silently for the next dev to fix.

**#8 — Split `Timeline.tsx` (1301 lines) into smaller files.** Surveying
shows nine inline components + 8 helper functions + 5 constants. Plan to
extract co-located primitives into `components/timeline/`:

```
frontend/src/components/timeline/
  helpers.ts          (fmt/fmtShort/clipDur/resolveStarts/snapToEdges/rulerInterval/clipHue/filmstripBg/audioWavePts + constants)
  ExportMenu.tsx
  SourceBin.tsx
  Monitors.tsx        (Scrubber + SourceMonitor + ProgramMonitor)
  Tracks.tsx          (VideoTrack + AudioTrack + Ruler)
```

`TimelineEditor` (the heavy 585-line state machine) stays in Timeline.tsx
for now — its internal state graph is tightly coupled and pulling it apart
needs a bigger contract change than this refactor batch warrants.

**Scope revision during execution:** for #8, only the helpers + types were
extracted. Component extraction (SourceBin, Monitors, Tracks, ExportMenu) was
deferred — each has a prop interface tightly coupled to TimelineEditor's
state, and pulling them apart safely needs a bigger contract change. The
`components/timeline/` directory is now in place so the future split has a
home.

**What changed**

- DELETED `backend/app/api/dashboard.py` (641 lines).
- NEW `backend/app/api/dashboard/` package: `__init__.py` (parent router), `stats.py`, `jobs.py`, `streams.py`, `folders.py`, `analytics.py`, `settings.py`. 19 dashboard routes preserved at identical URLs.
- NEW `SEARCH_MODES` constant in `backend/app/search/engine.py`.
- NEW `GET /api/search/modes` endpoint in `backend/app/api/search.py`.
- NEW `frontend/src/lib/search-modes.ts:checkSearchModesInSync()` — async startup check, warns on drift, swallows failures.
- NEW `api.getSearchModes()` client method.
- `frontend/src/main.tsx` calls the check at boot.
- NEW `frontend/src/components/timeline/helpers.ts` (120 lines) — 5 constants + 9 functions.
- NEW `frontend/src/components/timeline/types.ts` (27 lines) — `Tool`, `StripClip`, `UndoEntry`, `TrimPreview`.
- `frontend/src/pages/Timeline.tsx` — 1301 → 1210 lines; inline helpers/types/constants replaced by imports.

**Verification**

- Python: `create_app()` → 19 dashboard sub-routes preserved, `SEARCH_MODES` tuple of 6, total app routes 76 → 77.
- `tsc --noEmit` clean.
- Pre-restart server still serves old endpoints — refactor activates on next backend restart.

**Status:** ✅ committed 2026-05-15 (user sign-off).

---

## 2026-05-15 — Tier 2 refactor: docs reorg, caption merge, Dashboard split

**Goal:** continue the ziflow-style cleanup with three medium-effort items.
All low/medium risk, no behavior change.

**Items:**

7. **Move portable docs into `docs/portable/`.** 5 root-level markdown files
   (`MOVE_BETWEEN_COMPUTERS.md`, `PORTABLE_PLAN.md`, `PORTABLE_TEST_PLAN.md`,
   `PORTABLE_WINDOWS_README.md`, `SELF_CONTAINED_DEPLOYMENT.md`) all describe
   portable-mode workflows. Move them into `docs/portable/` to bring the root
   from 10 MDs down to 5. No code references — only a self-reference inside
   `PORTABLE_PLAN.md` (a tree diagram listing itself), which can stay as-is.

5. **Merge `captioner.py` + `caption_embedder.py` → `caption.py`.** Two
   tightly-coupled files today:

   - `app/ingest/captioner.py` (113 lines) — VLM model loader, exports
     `caption_images()`.
   - `app/ingest/caption_embedder.py` (183 lines) — pipeline stage handler,
     exports `caption_video()`, internally imports `caption_images` from
     `captioner`.

   Only callers of either file are: `pipeline.py` (uses `caption_video`) and
   `caption_embedder` itself (uses `caption_images`). Matches the sibling
   `clip_embedder.py` pattern which keeps model loader + stage handler in
   one file. Merging clarifies ownership and trims one intra-module import.

   `pipeline.py:26` currently: `from app.ingest.caption_embedder import caption_video`.

6. **Split `Dashboard.tsx` (579 lines) into per-card files** under
   `frontend/src/components/cards/`. Today the page contains:

   - `StorageBar` (helper, ~15 lines) — used only by DriveHealthCard
   - `DriveHealthCard` (~60 lines)
   - `formatEtaSeconds` (helper, ~12 lines) — used only by IndexingSpeedCard
   - `IndexingSpeedCard` (~310 lines, the heavy one — pause/resume/skip,
     reconcile/rebuild buttons, per-stage bars with ETAs)
   - `ProjectBreakdownCard` (~25 lines)
   - `DashboardPage` (~135 lines, the layout/grid + storage warnings)

   Target layout:
   ```
   frontend/src/components/cards/
     DriveHealthCard.tsx        (DriveHealthCard + StorageBar)
     IndexingSpeedCard.tsx      (IndexingSpeedCard + formatEtaSeconds)
     ProjectBreakdownCard.tsx
   frontend/src/pages/Dashboard.tsx  (just imports + DashboardPage)
   ```

   No external consumers of any sub-card today, so this is a self-contained move.

**What changed**

- 5 docs `git mv`d from project root into `docs/portable/`. Root MD count: 10 → 5. No code references; preserved through git rename detection so history follows.
- NEW `backend/app/ingest/caption.py` — merged content of the two old files; deletes (`git rm`) `captioner.py` (113 lines) and `caption_embedder.py` (183 lines). The intra-module `from app.ingest.captioner import caption_images` import inside the stage handler is gone (same file now). Preserves the `StageSkip` raise path and the empty-captions / no-frames branches.
- `backend/app/ingest/pipeline.py:26` — `from app.ingest.caption_embedder import caption_video` → `from app.ingest.caption import caption_video`.
- NEW `frontend/src/components/cards/DriveHealthCard.tsx` — exports both `DriveHealthCard` and `StorageBar` (StorageBar is still used by the Dashboard page directly for the storage-by-source list, so it stays co-exported).
- NEW `frontend/src/components/cards/IndexingSpeedCard.tsx` — exports `IndexingSpeedCard`; co-locates `formatEtaSeconds` (used only here).
- NEW `frontend/src/components/cards/ProjectBreakdownCard.tsx`.
- `frontend/src/pages/Dashboard.tsx` — went from 579 lines to 140; now just imports + the `DashboardPage` layout/grid + the page's job-queue card.

**Verification**

- Backend: `python -c "from app.ingest.caption import ...; from app.main import create_app; app=create_app()"` → 76 routes, all imports clean, `STAGE_HANDLERS['caption']` correctly bound to the merged module.
- Frontend: `tsc --noEmit` → clean. `wc -l` confirms split: Dashboard 140, DriveHealthCard 92, IndexingSpeedCard 332, ProjectBreakdownCard 29 (total 593, was 579 — +14 from per-file import headers).
- Running pre-refactor server still responds 200 on /health and POST /streams/reconcile (the running binary is still on the older code; backend restart needed to pick up the rename, frontend hot-reloads).

**Status:** ✅ committed 2026-05-15 (user sign-off).

---

## 2026-05-15 — Tier 1 refactor: dedup stage maps + extract frontend metadata

**Goal:** kill four duplications surfaced by the refactor survey. Mechanical
moves only — no behavior changes. Risk: very low across the board, verified
by import smoke + `tsc --noEmit`.

**Items in this batch:**

1. **Single source for stage↔flag mapping.** Three copies today:

   - `backend/app/api/files.py:124` — `stage_flag = {"metadata": "metadata_extracted", "hash": "hashed", "thumbnail": None, "transcript": "transcribed", "embed": "embedded", "clip_embed": "clip_embedded", "caption": "captioned", "keyframes": "keyframes_extracted"}`
   - `backend/app/ingest/reconcile.py:178` — `flag_for = {"embed": "embedded", "clip_embed": "clip_embedded", "caption": "captioned", "transcript": "transcribed"}`
   - `backend/app/ingest/pipeline.py:120` — `stage_order = ["metadata", "hash", "thumbnail", "transcript", "embed", "clip_embed", "caption"]`

   Move into one new module `backend/app/ingest/stages.py` exporting `STAGE_FLAG` and `STAGE_ORDER`. Consumers import from there.

2. **Frontend stage colors/labels.** Currently lives in `Dashboard.tsx:137-152` as `stageColors` / `stageLabels` dicts (added today). Hoist to `frontend/src/lib/stages.ts` so future pipeline-aware components don't re-roll their own palettes.

3. **Search-mode metadata.** Currently in `Search.tsx`: `SearchMode` type, `ALL_MODES`, `MODE_LABELS`, `MODE_PLACEHOLDERS`, `isVisualMode`. Hoist to `frontend/src/lib/search-modes.ts`.

4. **Delete stray `{backend/` directory.** Created by a typo earlier, gitignored, holds nothing meaningful. `rm -rf` cleanup.

**What changed**

- NEW `backend/app/ingest/stages.py` — exports `STAGE_ORDER` (8 entries), `STAGE_FLAG` (8 mappings, one per stage), `STREAM_STAGES` (3 entries: `embed`, `clip_embed`, `caption`), and `reset_flag(vf, stage)` helper.
- `backend/app/ingest/pipeline.py:_get_pending_job_ids` now imports `STAGE_ORDER` instead of hardcoding the list.
- `backend/app/api/files.py:reprocess_file` now calls `reset_flag(vf, stage)` — the 8-entry `stage_flag` dict is gone.
- `backend/app/ingest/reconcile.py:rebuild_all_streams` now uses `STREAM_STAGES` + `reset_flag` — the 4-entry `flag_for` dict is gone. Default `streams` arg derives from `STREAM_STAGES`.
- NEW `frontend/src/lib/stages.ts` — exports `StageKey` type, `STAGE_ORDER`, `STAGE_LABELS`, `STAGE_COLORS`, plus `stageLabel(s)` / `stageColor(s)` helpers that accept arbitrary strings and fall back gracefully.
- `frontend/src/pages/Dashboard.tsx` — local `stageColors` / `stageLabels` dicts removed, replaced with `stageLabel(...)` / `stageColor(...)` helper calls.
- NEW `frontend/src/lib/search-modes.ts` — exports `SearchMode` type, `ALL_SEARCH_MODES`, `SEARCH_MODE_LABELS`, `SEARCH_MODE_PLACEHOLDERS`, `isVisualMode`, `asSearchMode`.
- `frontend/src/pages/Search.tsx` — local mode metadata removed, imports from `@/lib/search-modes`. `getSavedMode()` now uses `asSearchMode()` for narrowing.
- `frontend/src/api/client.ts` — `SearchRequest.mode` field now references `SearchMode` from the shared module (was a duplicated inline union).
- DELETED `{backend/` stray directory at project root.

**Verification**

- `python -c "from app.ingest.stages import ...; ...; app = create_app()"` → imports OK, 8 stages, 3 streams, app builds with 76 routes.
- `tsc --noEmit` → clean (after switching from direct `stageColors[...]` indexing to the `stageColor(...)` helper, since the new strongly-typed `Record<StageKey,string>` rejects `string` indexers).
- Running server (pre-refactor binary on PID earlier in session) → still responds 200 on `/health` and `POST /api/dashboard/streams/reconcile`. Refactor changes activate at next restart.

**Status:** ✅ committed 2026-05-15 (user sign-off).

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

**Verification:**

- `git init -b main`, `git add .` → 97 files, 0.8 MB staged. No `.env`, no `*.db`, no model weights, no `venv/`, no `portable_data_test/`.
- Local commit: `d504939 — Checkpoint: multimodal embeddings end-to-end`.
- Remote: `https://github.com/paulvictorbiz-glitch/footage-brain.git` set as `origin`.
- Existing remote branches: `main` (1 commit), `footagebrain-test` (2 commits, 4496 files — older un-cleaned snapshot).
- Local history has no common ancestor with remote `footagebrain-test`. Per user choice, pushed to a NEW branch `checkpoint-2026-05-15` instead of force-overwriting.
- Push succeeded: `* [new branch] main -> checkpoint-2026-05-15`. Local `main` tracks `origin/checkpoint-2026-05-15`.

**Status:** ✅ committed 2026-05-15 (user sign-off via push-strategy answer).

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
