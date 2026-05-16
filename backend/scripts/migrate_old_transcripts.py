"""
Migrate transcripts from an OLDER Footage Brain DB into the current app.

Match key: (filename casefold, exact file_size). That's stable across the
E:->F: copy (a file copy preserves name + byte size) and needs no hashing.
Old-side duplicates of the SAME content collapse to the richest transcript.

For each current VideoFile that matches an old TRANSCRIBED clip and is not
already transcribed:
  * copy its transcript_chunks (new ids, repointed, chroma_id cleared),
  * set transcribed=True   -> the VPS Whisper stage skips it entirely,
  * leave embedded=False   -> the cheap local `embed` stage regenerates
                              vectors from these chunks,
  * carry over old sha256 if the new row has none (free; restores dedup).

Idempotent / resumable. Always run --dry-run first to see coverage.

  cd backend
  venv\\Scripts\\python.exe scripts\\migrate_old_transcripts.py \\
      --old-db "C:\\Users\\Mi\\Downloads\\files\\footage-brain\\backend\\footage_brain.db" --dry-run
  # then drop --dry-run to apply.

Run with the SAME environment the app uses (DATA_ROOT / DATABASE_URL) so it
writes the DB the running app reads. busy_timeout + batched commits keep it
safe alongside the live pipeline.
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

# Allow running as `python scripts/migrate_old_transcripts.py` from backend/
# (not just `-m`): put backend/ on the path so `import app` resolves.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.db.models import IngestJob, TranscriptChunk, VideoFile
from app.db.session import get_session_factory, init_db


def _queue_embed(session, vf_id: str) -> None:
    """Re-queue the embed stage so the pipeline regenerates vectors from the
    copied chunks (mirrors reconcile._upsert_pending). Without this, a clip
    whose embed job was already 'done' would never become searchable."""
    job = (session.query(IngestJob)
           .filter_by(video_file_id=vf_id, stage="embed").first())
    if job is None:
        session.add(IngestJob(video_file_id=vf_id, stage="embed",
                              status="pending"))
        return
    job.status = "pending"
    job.attempts = 0
    job.error_message = None


def _load_old_index(old_db: str) -> dict:
    """key -> {"sha256": str|None, "chunks": [(idx,start,end,text,lang), ...]}.
    Only TRANSCRIBED old rows (carries the 'no speech, do not redo' verdict
    too). Duplicate keys keep the row with the most chunks."""
    # Build a proper file URI (Windows abs paths need file:///C:/...).
    uri = Path(old_db).resolve().as_uri()
    if not os.path.isfile(old_db):
        raise SystemExit(f"old DB not found: {old_db}")
    conn = sqlite3.connect(f"{uri}?mode=ro", uri=True)
    try:
        rows = conn.execute(
            "SELECT id, filename, file_size, sha256 FROM video_files "
            "WHERE transcribed=1"
        ).fetchall()
        idx: dict = {}
        for old_id, filename, file_size, sha256 in rows:
            if filename is None or file_size is None:
                continue
            chunks = conn.execute(
                "SELECT chunk_index, start_time, end_time, text, language "
                "FROM transcript_chunks WHERE video_file_id=? "
                "ORDER BY chunk_index", (old_id,)
            ).fetchall()
            key = (str(filename).casefold(), int(file_size))
            prev = idx.get(key)
            if prev is None or len(chunks) > len(prev["chunks"]):
                idx[key] = {"sha256": sha256, "chunks": chunks}
        return idx
    finally:
        conn.close()


def migrate(old_db: str, dry_run: bool = True, commit_every: int = 200,
            limit: int | None = None) -> dict:
    init_db()  # idempotent: ensures the target DB has audio_path et al.
    old = _load_old_index(old_db)
    c = {"old_transcribed_keys": len(old), "new_total": 0, "migrated": 0,
         "chunks_copied": 0, "embed_requeued": 0, "already_done": 0,
         "has_chunks_skip": 0, "no_match": 0, "sha256_filled": 0, "errors": 0}

    session = get_session_factory()()
    try:
        q = session.query(VideoFile)
        if limit:
            q = q.limit(limit)
        pending = 0
        for vf in q.yield_per(500):
            c["new_total"] += 1
            if vf.filename is None or vf.file_size is None:
                c["no_match"] += 1
                continue
            hit = old.get((vf.filename.casefold(), int(vf.file_size)))
            if hit is None:
                c["no_match"] += 1
                continue
            if vf.transcribed:
                c["already_done"] += 1
                continue
            try:
                existing = (session.query(TranscriptChunk)
                            .filter_by(video_file_id=vf.id).count())
                if existing:
                    # not flagged transcribed but already has chunks -> don't
                    # duplicate; leave for manual review.
                    c["has_chunks_skip"] += 1
                    continue
                for idx, start, end, text, lang in hit["chunks"]:
                    session.add(TranscriptChunk(
                        video_file_id=vf.id, chunk_index=idx,
                        start_time=start, end_time=end,
                        text=text, language=lang, chroma_id=None,
                    ))
                    c["chunks_copied"] += 1
                vf.transcribed = True
                vf.embedded = False
                _queue_embed(session, vf.id)
                c["embed_requeued"] += 1
                if not vf.sha256 and hit["sha256"]:
                    vf.sha256 = hit["sha256"]
                    c["sha256_filled"] += 1
                vf.updated_at = datetime.utcnow()
                c["migrated"] += 1
                pending += 1
                if not dry_run and pending >= commit_every:
                    session.commit()
                    pending = 0
            except Exception as exc:  # noqa
                c["errors"] += 1
                session.rollback()
                print(f"  ! {vf.filename}: {exc}")
        if dry_run:
            session.rollback()
        else:
            session.commit()
    finally:
        session.close()
    return c


def main() -> None:
    ap = argparse.ArgumentParser(description="Migrate transcripts from an old Footage Brain DB.")
    ap.add_argument("--old-db", required=True)
    ap.add_argument("--dry-run", action="store_true",
                    help="Report coverage without writing anything.")
    ap.add_argument("--commit-every", type=int, default=200)
    ap.add_argument("--limit", type=int, default=None)
    a = ap.parse_args()
    counts = migrate(a.old_db, a.dry_run, a.commit_every, a.limit)
    print(("DRY RUN — " if a.dry_run else "") + "transcript migration:")
    for k, v in counts.items():
        print(f"  {k:22s} {v}")
    if a.dry_run:
        print("  (no changes written — re-run without --dry-run to apply)")


if __name__ == "__main__":
    main()
