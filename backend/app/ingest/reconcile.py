"""
Pipeline reconciliation.

Each VideoFile carries boolean "stream done" flags (transcribed, embedded,
clip_embedded, captioned). A flag set to True means "this stage's handler ran
and was satisfied" — but the handler is satisfied in several ways: the work
was done, the file had no audio, the captioner was disabled, etc.

When the configuration changes (captioner gets enabled, vector store gets
swapped, a model is upgraded) the flag's meaning becomes stale: the file is
marked "captioned" but the caption vectors don't exist. Without explicit
intervention the pipeline silently skips that file forever.

Reconciliation walks the DB and detects mismatches between what a flag claims
and what's actually present on disk / in the vector store, then resets the
flag and re-queues the corresponding pipeline job. The pipeline worker picks
up from there.

This is invoked on startup (cheap, indexed SQL only) and also exposed as an
API endpoint so the user can force a rebuild from the dashboard.
"""
from __future__ import annotations

from datetime import datetime
from typing import Dict, List, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.logging import get_logger
from app.db.models import FrameCaption, IngestJob, TranscriptChunk, VideoFile

logger = get_logger(__name__)


# Map: stream-flag attribute → (pipeline stage name, predicate for "needs rebuild")
# Predicates take a VideoFile and return True when the flag is stale and the
# stage should be re-queued.


def _upsert_pending(session: Session, file_id: str, stage: str) -> None:
    job = session.query(IngestJob).filter_by(video_file_id=file_id, stage=stage).first()
    if job is None:
        session.add(IngestJob(video_file_id=file_id, stage=stage, status="pending"))
        return
    job.status = "pending"
    job.attempts = 0
    job.error_message = None
    job.started_at = None
    job.finished_at = None


def _files_missing_captions(session: Session) -> List[str]:
    """
    A file is "missing captions" if the captioner is now enabled, the file has
    a real duration, and FrameCaption holds zero rows for it AND the file's
    most recent caption ingest job is not already done/paused.

    Why the extra job-status check: the captioner can legitimately end a run
    with zero saved captions (frames couldn't be extracted, frames were
    all-black, etc.) and still return success. Without this guard, reconcile
    bounces those files back to `pending` on every backend startup — an
    infinite reprocess loop. It also wipes user-paused jobs.
    """
    settings = get_settings()
    if not settings.captioner_enabled:
        return []

    sub = (
        session.query(FrameCaption.video_file_id, func.count(FrameCaption.id).label("n"))
        .group_by(FrameCaption.video_file_id)
        .subquery()
    )
    # Exclude files whose latest caption job is already done, paused, or
    # skipped — the job table is the source of truth for "should the worker
    # run this stage." Skipped means the captioner intentionally bailed
    # (e.g. no_frames_extracted); reconcile must not retry it.
    already_settled = (
        session.query(IngestJob.video_file_id)
        .filter(IngestJob.stage == "caption")
        .filter(IngestJob.status.in_(("done", "paused", "skipped")))
        .distinct()
        .subquery()
    )
    rows = (
        session.query(VideoFile.id)
        .outerjoin(sub, VideoFile.id == sub.c.video_file_id)
        .filter(VideoFile.duration_seconds.isnot(None))
        .filter(VideoFile.duration_seconds >= 1)
        .filter((sub.c.n.is_(None)) | (sub.c.n == 0))
        .filter(~VideoFile.id.in_(session.query(already_settled.c.video_file_id)))
        .all()
    )
    return [r[0] for r in rows]


def _files_missing_transcript_vectors(session: Session) -> List[str]:
    """
    Files marked embedded=True but with TranscriptChunk rows that never got a
    chroma_id assigned. Indicates the vector store was wiped or swapped after
    embedding.
    """
    has_chunks = session.query(TranscriptChunk.video_file_id).distinct().subquery()
    no_chroma = (
        session.query(TranscriptChunk.video_file_id)
        .filter(TranscriptChunk.chroma_id.is_(None))
        .distinct()
        .subquery()
    )
    rows = (
        session.query(VideoFile.id)
        .filter(VideoFile.embedded == True)  # noqa: E712
        .filter(VideoFile.id.in_(session.query(has_chunks.c.video_file_id)))
        .filter(VideoFile.id.in_(session.query(no_chroma.c.video_file_id)))
        .all()
    )
    return [r[0] for r in rows]


def reconcile_streams(session: Session) -> Dict[str, int]:
    """
    Detect and re-queue every stream whose persisted flag no longer matches
    its actual on-disk artifacts. Safe to run repeatedly — it is idempotent
    and only mutates files that are demonstrably stale.

    Skips toggleable stages (caption / clip_embed) when the user has paused
    them via the persistent pipeline-settings toggle — otherwise a startup
    reconcile would silently undo a pause and wipe the toggle marker.

    Returns a counts dict the caller can log or surface in the UI.
    """
    # Defer import to avoid an import cycle (stage_settings imports nothing
    # from app.db, but better safe at module load).
    from app.ingest.stage_settings import is_stage_enabled

    counts: Dict[str, int] = {"caption": 0, "embed": 0}

    if is_stage_enabled("caption"):
        for fid in _files_missing_captions(session):
            vf = session.get(VideoFile, fid)
            if vf is None:
                continue
            vf.captioned = False
            _upsert_pending(session, fid, "caption")
            counts["caption"] += 1

    for fid in _files_missing_transcript_vectors(session):
        vf = session.get(VideoFile, fid)
        if vf is None:
            continue
        vf.embedded = False
        _upsert_pending(session, fid, "embed")
        counts["embed"] += 1

    if any(counts.values()):
        session.flush()
        logger.info("reconcile_streams_requeued", **counts)
    else:
        logger.info("reconcile_streams_clean")

    return counts


def rebuild_all_streams(
    session: Session,
    streams: Optional[List[str]] = None,
) -> Dict[str, int]:
    """
    Force-rebuild the requested multimodal streams for every VideoFile in the
    library. Resets the relevant flag and re-queues the stage job — the
    pipeline worker handles the actual rerun.

    `streams` defaults to all three semantic streams: transcript embedding,
    CLIP frame embedding, and VLM captioning.
    """
    streams = streams or ["embed", "clip_embed", "caption"]
    flag_for = {
        "embed": "embedded",
        "clip_embed": "clip_embedded",
        "caption": "captioned",
        "transcript": "transcribed",
    }

    counts: Dict[str, int] = {s: 0 for s in streams}
    vfs: List[VideoFile] = session.query(VideoFile).all()

    for vf in vfs:
        for stage in streams:
            flag = flag_for.get(stage)
            if flag and hasattr(vf, flag):
                setattr(vf, flag, False)
            _upsert_pending(session, vf.id, stage)
            counts[stage] += 1

    if vfs:
        session.flush()
    logger.info("rebuild_all_streams", files=len(vfs), **counts)
    return counts
