"""
Pipeline orchestrator.

Runs the ingest pipeline stages in order for queued jobs:
  metadata → hash → thumbnail → transcript → embed

Uses a simple thread-pool backed by IngestJob rows in SQLite.
The job table acts as a durable queue — safe to restart at any time.

Stage execution is idempotent: if a stage is already 'done', it's skipped.
"""
from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from typing import Callable, Dict, List, Optional

from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.logging import get_logger
from app.db.models import IngestJob, VideoFile
from app.db.session import get_db
from app.ingest.clip_embedder import clip_embed_video
from app.ingest.embedder import embed_video_chunks
from app.ingest.hasher import hash_and_dedup
from app.ingest.metadata import extract_metadata
from app.ingest.transcriber import run_transcription

logger = get_logger(__name__)

def _thumbnail_stage(session: Session, vf: VideoFile) -> bool:
    if vf.thumbnail_path:
        return True
    from app.ingest.metadata import extract_thumbnail
    thumb = extract_thumbnail(vf.abs_path, vf.id, vf.duration_seconds)
    if thumb:
        vf.thumbnail_path = thumb
        session.flush()
    return True


STAGE_HANDLERS: Dict[str, Callable[[Session, VideoFile], bool]] = {
    "metadata": extract_metadata,
    "hash": hash_and_dedup,
    "thumbnail": _thumbnail_stage,
    "transcript": run_transcription,
    "embed": embed_video_chunks,
    "clip_embed": clip_embed_video,
}


def _process_job(job_id: str) -> None:
    with get_db() as session:
        job: Optional[IngestJob] = session.get(IngestJob, job_id)
        if job is None:
            return

        if job.status not in ("pending", "failed"):
            return

        if job.attempts >= job.max_attempts:
            job.status = "failed"
            job.error_message = "max_attempts_exceeded"
            return

        vf = job.video_file
        if vf is None:
            job.status = "skipped"
            return

        handler = STAGE_HANDLERS.get(job.stage)
        if handler is None:
            logger.warning("unknown_stage", stage=job.stage)
            job.status = "skipped"
            return

        job.status = "processing"
        job.attempts += 1
        job.started_at = datetime.utcnow()

        try:
            success = handler(session, vf)
            if success:
                job.status = "done"
                job.finished_at = datetime.utcnow()
                logger.info("job_done", stage=job.stage, file=vf.filename)
            else:
                job.status = "failed"
                job.error_message = "handler_returned_false"
                logger.warning("job_failed", stage=job.stage, file=vf.filename)
        except Exception as exc:
            job.status = "failed"
            job.error_message = str(exc)[:500]
            logger.error("job_exception", stage=job.stage, file=vf.filename, error=str(exc))


def _get_pending_job_ids(session: Session, limit: int = 50) -> List[str]:
    stage_order = ["metadata", "hash", "thumbnail", "transcript", "embed", "clip_embed"]
    jobs = (
        session.query(IngestJob.id, IngestJob.stage)
        .filter(IngestJob.status.in_(["pending"]))
        .all()
    )

    def priority(j):
        try:
            return stage_order.index(j.stage)
        except ValueError:
            return 99

    jobs_sorted = sorted(jobs, key=priority)
    return [j.id for j in jobs_sorted[:limit]]


class PipelineWorker:
    def __init__(self) -> None:
        settings = get_settings()
        self._workers = settings.ingest_workers
        self._executor: Optional[ThreadPoolExecutor] = None
        self._running = False
        self._thread: Optional[threading.Thread] = None
        self._inter_job_delay: float = 0.0
        self._batch_remaining: int = 0
        self._batch_exhausted: bool = False
        self._pacing_lock = threading.Lock()

    def set_pacing(self, delay_seconds: float) -> None:
        """Set inter-job delay in seconds (0 = no delay). Thread-safe."""
        with self._pacing_lock:
            self._inter_job_delay = max(0.0, delay_seconds)
        logger.debug("pipeline_pacing_set", delay_seconds=delay_seconds)

    def set_batch_limit(self, n: int) -> None:
        """Set batch limit (0 = unlimited). Thread-safe."""
        with self._pacing_lock:
            self._batch_remaining = max(0, n)
            self._batch_exhausted = False  # reset on every explicit call
        logger.debug("pipeline_batch_limit_set", n=n)

    def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._executor = ThreadPoolExecutor(max_workers=self._workers, thread_name_prefix="ingest")
        self._thread = threading.Thread(target=self._loop, daemon=True, name="pipeline-loop")
        self._thread.start()
        logger.info("pipeline_worker_started", workers=self._workers)

    def stop(self) -> None:
        self._running = False
        if self._executor:
            self._executor.shutdown(wait=True)
        logger.info("pipeline_worker_stopped")

    def _loop(self) -> None:
        while self._running:
            try:
                # Check batch limit — if budget is exhausted, pause this loop tick
                with self._pacing_lock:
                    batch_remaining = self._batch_remaining
                    inter_job_delay = self._inter_job_delay
                    batch_exhausted = self._batch_exhausted

                if batch_exhausted:
                    time.sleep(1.0)
                    continue

                with get_db() as session:
                    limit = self._workers * 4
                    if batch_remaining > 0:
                        limit = min(limit, batch_remaining)
                    job_ids = _get_pending_job_ids(session, limit=limit)

                if not job_ids:
                    time.sleep(0.5)
                    continue

                futures = {self._executor.submit(_process_job, jid): jid for jid in job_ids}
                completed_count = 0
                for fut in as_completed(futures, timeout=600):
                    jid = futures[fut]
                    try:
                        fut.result()
                        completed_count += 1
                    except Exception as exc:
                        logger.error("pipeline_future_error", job_id=jid, error=str(exc))

                # Decrement batch budget
                with self._pacing_lock:
                    if self._batch_remaining > 0:
                        self._batch_remaining = max(0, self._batch_remaining - completed_count)
                        if self._batch_remaining == 0:
                            self._batch_exhausted = True
                            logger.info("pipeline_batch_limit_reached")

                # Apply inter-job delay
                with self._pacing_lock:
                    delay = self._inter_job_delay
                if delay > 0:
                    time.sleep(delay)
                else:
                    time.sleep(0.1)

            except Exception as exc:
                logger.error("pipeline_loop_error", error=str(exc))
                time.sleep(5)

    def queue_stats(self) -> dict:
        with get_db() as session:
            from sqlalchemy import func
            rows = (
                session.query(IngestJob.status, func.count(IngestJob.id))
                .group_by(IngestJob.status)
                .all()
            )
        return {status: count for status, count in rows}


_worker: Optional[PipelineWorker] = None


def get_pipeline_worker() -> PipelineWorker:
    global _worker
    if _worker is None:
        _worker = PipelineWorker()
    return _worker