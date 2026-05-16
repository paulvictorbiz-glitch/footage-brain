"""
Scanner stage: walk configured root paths and find all video files.
Creates or updates VideoFile rows and queues ingest jobs.
Incremental: skips files whose (mtime, size) match the stored snapshot.
"""
from __future__ import annotations

import os
from datetime import datetime
from pathlib import Path
from typing import List, Optional

from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.logging import get_logger
from app.db.models import IngestJob, ScanRoot, VideoFile

logger = get_logger(__name__)


def _is_video(path: Path, ext_set: set[str]) -> bool:
    return path.suffix.lower() in ext_set and path.is_file()


def _get_or_create_file(session: Session, abs_path: str, scan_root_id: str) -> tuple[VideoFile, bool]:
    """Return (VideoFile, is_new)."""
    existing = session.query(VideoFile).filter_by(abs_path=abs_path).first()
    if existing:
        return existing, False

    p = Path(abs_path)
    stat = p.stat()
    vf = VideoFile(
        abs_path=abs_path,
        filename=p.name,
        extension=p.suffix.lower(),
        file_size=stat.st_size,
        mtime_snapshot=stat.st_mtime,
        created_time=datetime.fromtimestamp(stat.st_ctime),
        modified_time=datetime.fromtimestamp(stat.st_mtime),
        scan_root_id=scan_root_id,
    )
    session.add(vf)
    session.flush()  # get id assigned
    return vf, True


def _needs_reprocess(vf: VideoFile, path: Path) -> bool:
    """Return True if file has changed since last ingest."""
    try:
        stat = path.stat()
        if vf.mtime_snapshot is None:
            return True
        return abs(stat.st_mtime - vf.mtime_snapshot) > 1.0 or stat.st_size != vf.file_size
    except OSError:
        return False


def _upsert_job(session: Session, file_id: str, stage: str) -> None:
    existing = session.query(IngestJob).filter_by(video_file_id=file_id, stage=stage).first()
    if existing:
        if existing.status in ("done", "skipped"):
            return  # don't re-queue unless file changed
        return
    job = IngestJob(video_file_id=file_id, stage=stage, status="pending")
    session.add(job)


PIPELINE_STAGES = ["metadata", "hash", "thumbnail", "transcript", "embed", "clip_embed", "caption"]

# Commit the walk in batches so a long scan doesn't hold the SQLite write
# lock for its whole duration (which both starves and is starved by the
# ingest pipeline worker — surfaces as "database is locked").
SCAN_COMMIT_BATCH = 200


def scan_root(session: Session, scan_root: ScanRoot) -> dict:
    """
    Walk a ScanRoot, discover video files, and queue pipeline jobs.
    Returns summary stats.
    """
    settings = get_settings()
    ext_set = settings.video_ext_set
    root_path = Path(scan_root.path)

    if not root_path.exists():
        logger.warning("scan_root_missing", path=str(root_path))
        return {"root": str(root_path), "found": 0, "new": 0, "changed": 0, "error": "path_not_found"}

    logger.info("scan_start", root=str(root_path))

    root_id = scan_root.id  # captured: ORM attr expires after a batch commit
    found = new = changed = errors = 0

    walk_iter = root_path.rglob("*") if scan_root.recursive else root_path.iterdir()

    for entry in walk_iter:
        if not _is_video(entry, ext_set):
            continue

        found += 1
        abs_path = str(entry.resolve())

        try:
            vf, is_new = _get_or_create_file(session, abs_path, root_id)

            if is_new:
                new += 1
                for stage in PIPELINE_STAGES:
                    _upsert_job(session, vf.id, stage)
            elif _needs_reprocess(vf, entry):
                # File changed — reset pipeline state and re-queue
                changed += 1
                vf.file_size = entry.stat().st_size
                vf.mtime_snapshot = entry.stat().st_mtime
                vf.modified_time = datetime.fromtimestamp(entry.stat().st_mtime)
                vf.metadata_extracted = False
                vf.hashed = False
                vf.transcribed = False
                vf.embedded = False
                vf.clip_embedded = False
                vf.captioned = False
                # Reset jobs to pending
                for job in vf.ingest_jobs:
                    if job.stage in PIPELINE_STAGES:
                        job.status = "pending"
                        job.attempts = 0
                        job.error_message = None
                        job.started_at = None
                        job.finished_at = None

        except Exception as exc:
            errors += 1
            session.rollback()  # clear the poisoned tx so the scan continues
            logger.error("scan_file_error", path=abs_path, error=str(exc))

        if found % SCAN_COMMIT_BATCH == 0:
            try:
                session.commit()
            except Exception as exc:
                session.rollback()
                logger.warning("scan_batch_commit_failed", error=str(exc))

    scan_root.last_scanned_at = datetime.utcnow()
    session.commit()

    summary = {
        "root": str(root_path),
        "found": found,
        "new": new,
        "changed": changed,
        "errors": errors,
    }
    logger.info("scan_complete", **summary)
    return summary


def scan_all_roots(session: Session) -> List[dict]:
    """Scan all enabled ScanRoots."""
    roots = session.query(ScanRoot).filter_by(enabled=True).all()
    results = []
    for root in roots:
        results.append(scan_root(session, root))
    return results
