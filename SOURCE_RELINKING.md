# Source Root Relinking

This document covers how Footage Brain stores footage paths, how it detects offline drives, and how to repoint a source root when drive letters change between computers or sessions.

---

## Data Model

Two tables are involved in every footage path:

### `scan_roots`

One row per configured source folder. The `path` column is the authoritative root that was registered by the user.

```
id          │ UUID
path        │ E:\Footage         ← os.path.normpath of what the user typed
label       │ "Main Drive"
enabled     │ 1
recursive   │ 1
last_scanned_at │ 2026-05-10 14:32:00
```

### `video_files`

One row per discovered video file. `abs_path` is the fully-resolved OS path, stored when the file was first scanned.

```
id           │ UUID
scan_root_id │ → scan_roots.id
abs_path     │ E:\Footage\Project\GX010388.MP4   ← Path.resolve() at scan time
filename     │ GX010388.MP4
...all metadata, transcript, embedding state...
```

**Key constraint:** `abs_path` has a `UNIQUE` constraint. Every file record maps 1-to-1 with a path on disk.

### Relationship between the two

`abs_path` is always a strict extension of the corresponding `scan_roots.path`:

```
scan_roots.path  = E:\Footage
video_files.abs_path = E:\Footage\[subdirectory\]filename.ext
                       ↑ always begins with scan_roots.path + separator
```

This invariant is what makes prefix-replacement relinking safe.

---

## Offline Detection

Every call to `GET /api/sources` and `GET /api/sources/{id}` checks whether the root directory exists at that moment using `Path(root.path).exists()`. The result is returned in the `is_online` field:

```json
{
  "id": "...",
  "path": "E:\\Footage",
  "is_online": false,
  "file_count": 3743,
  ...
}
```

`is_online: false` means:
- The drive letter is not mounted, **or**
- The path doesn't exist (was renamed or deleted), **or**
- A network share is unavailable

The record is never auto-deleted or auto-disabled — it stays in the DB with all metadata, transcripts, and embeddings intact.

---

## Relinking a Source Root

### When to relink

- Drive letter reassigned by Windows (E: → F:, G:, etc.)
- Footage moved to a different drive or folder
- Copying the project to a new machine where the footage is mounted differently

### What relinking does

1. Updates `scan_roots.path` to the new directory.
2. Rewrites the `abs_path` prefix in every `video_files` row linked to this root.
3. Leaves all metadata, transcript chunks, Chroma embeddings, and ingest state unchanged.
4. Does **not** reset or re-queue any pipeline jobs.

### What relinking does not do

- Does not verify that every individual file still exists (use a rescan for that).
- Does not move any actual files on disk.
- Does not update thumbnail paths (thumbnails use a path relative to the backend's working directory and are unaffected by footage drive changes).

---

## Relink API

### Dry run first (recommended)

Always run a dry run to preview how many records will change before committing:

```
POST /api/sources/{id}/relink
Content-Type: application/json

{
  "new_path": "F:\\Footage",
  "dry_run": true
}
```

Response:

```json
{
  "old_path": "E:\\Footage",
  "new_path": "F:\\Footage",
  "remapped": 3743,
  "unmatched": 0,
  "dry_run": true
}
```

`remapped` = files whose `abs_path` will be updated  
`unmatched` = files under this root whose `abs_path` didn't start with the old prefix (logged as warnings, left unchanged)

### Commit the relink

```
POST /api/sources/{id}/relink
Content-Type: application/json

{
  "new_path": "F:\\Footage",
  "dry_run": false
}
```

The operation is atomic — it runs inside a single SQLite transaction. If anything fails (including a collision check), the database is rolled back and no records are changed.

### Error cases

| HTTP status | Reason |
|-------------|--------|
| 400 | `new_path` is identical to the current path |
| 400 | `new_path` does not exist on disk (non-dry-run only) |
| 409 | One or more target `abs_path` values already exist in records from a **different** scan root — the new paths would collide |
| 404 | Root ID not found |

---

## Step-by-Step: Relinking After a Drive Letter Change

### Situation: footage was on E:, now Windows assigned it F:

**Step 1 — Confirm the new drive letter**

In File Explorer or PowerShell:
```powershell
Get-PSDrive -PSProvider FileSystem
```
Identify the new drive letter where your footage is now mounted.

**Step 2 — Get your source root ID**

```
GET /api/sources
```

Note the `id` of the root whose `path` starts with `E:\`.

**Step 3 — Dry run**

```
POST /api/sources/{id}/relink
{"new_path": "F:\\Footage", "dry_run": true}
```

Confirm `remapped` matches your expected file count and `unmatched` is 0 (or acceptably small).

**Step 4 — Commit**

```
POST /api/sources/{id}/relink
{"new_path": "F:\\Footage", "dry_run": false}
```

**Step 5 — Verify**

```
GET /api/sources/{id}
```

`is_online` should now be `true`. Run a scan to pick up any new or changed files:

```
POST /api/sources/{id}/scan
```

---

## Using PowerShell / curl for the Relink API

If you don't have a UI, use PowerShell:

```powershell
# Dry run
$body = '{"new_path": "F:\\Footage", "dry_run": true}'
Invoke-RestMethod -Method POST `
  -Uri "http://localhost:8000/api/sources/YOUR-ROOT-ID/relink" `
  -ContentType "application/json" `
  -Body $body

# Commit (change dry_run to false)
$body = '{"new_path": "F:\\Footage", "dry_run": false}'
Invoke-RestMethod -Method POST `
  -Uri "http://localhost:8000/api/sources/YOUR-ROOT-ID/relink" `
  -ContentType "application/json" `
  -Body $body
```

Or browse to `http://localhost:8000/api/docs` for the interactive Swagger UI.

---

## Proposed Schema Enhancement (Not Yet Implemented)

The current schema stores only the absolute path. The smallest change that would make relinking fully declarative is adding a `rel_path` column to `video_files`:

```sql
ALTER TABLE video_files ADD COLUMN rel_path TEXT;
-- Back-fill: strip the root prefix from abs_path
UPDATE video_files
SET rel_path = SUBSTR(abs_path, LENGTH(
    (SELECT path FROM scan_roots WHERE id = scan_root_id)
) + 1)
WHERE scan_root_id IS NOT NULL;
```

With `rel_path` in place:
- `abs_path` becomes a **derived** value: `scan_roots.path + rel_path`
- Relinking the root automatically "fixes" all abs_paths at query time with no UPDATE needed
- Files can be moved between roots by just changing `scan_root_id`

This change is backward-compatible: existing code that reads `abs_path` keeps working. The migration is a single `ALTER TABLE` + `UPDATE`. It has been deliberately deferred to avoid a migration on the existing 3,743-file database until the feature is validated in production.

---

## Chroma Vectors and Transcript Chunks After Relinking

Both are keyed on `video_file_id` (UUID), not on any file path. Relinking only changes `abs_path` string values in SQLite — it has no effect on:

- **Chroma collections** (`transcript_chunks`, `frame_embeddings`) — all vectors remain valid
- **`transcript_chunks` table** — all rows remain valid, keyed by `video_file_id`
- **All metadata** (duration, fps, codec, resolution, etc.) — unchanged

Semantic search, visual search, and timeline clips all continue working immediately after a relink without any re-indexing.
