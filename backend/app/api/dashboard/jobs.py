"""Job queue endpoints: queue stats, pause/resume, skip/restore stage, etc."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.schemas import IngestJobOut
from app.db.models import IngestJob, VideoFile
from app.db.session import get_db_session
from app.ingest.pipeline import get_pipeline_worker

router = APIRouter()


@router.get("/jobs")
def get_job_queue(session: Session = Depends(get_db_session)):
    recent_failed = (
        session.query(IngestJob)
        .filter_by(status="failed")
        .order_by(IngestJob.created_at.desc())
        .limit(20)
        .all()
    )
    recent_processing = (
        session.query(IngestJob)
        .filter_by(status="processing")
        .order_by(IngestJob.started_at.desc())
        .limit(10)
        .all()
    )

    worker_stats = get_pipeline_worker().queue_stats()

    return {
        "queue_stats": worker_stats,
        "processing": [IngestJobOut.model_validate(j) for j in recent_processing],
        "failed": [IngestJobOut.model_validate(j) for j in recent_failed],
    }


@router.post("/start-worker")
def start_worker():
    get_pipeline_worker().start()
    return {"status": "ok", "message": "Worker started"}


@router.post("/jobs/cancel")
def cancel_jobs(session: Session = Depends(get_db_session)):
    cancelled_count = session.query(IngestJob).filter(
        IngestJob.status.in_(["pending", "processing"])
    ).update({"status": "cancelled"})
    session.flush()
    return {"cancelled_jobs": cancelled_count}


@router.post("/jobs/pause")
def pause_jobs(session: Session = Depends(get_db_session)):
    paused_count = session.query(IngestJob).filter(
        IngestJob.status == "pending"
    ).update({"status": "paused"})
    session.flush()
    return {"paused_jobs": paused_count}


@router.post("/jobs/resume")
def resume_jobs(session: Session = Depends(get_db_session)):
    resumed_count = session.query(IngestJob).filter(
        IngestJob.status == "paused"
    ).update({"status": "pending"})
    session.flush()
    get_pipeline_worker().start()
    return {"resumed_jobs": resumed_count}


@router.post("/jobs/reset-failed")
def reset_failed_jobs(session: Session = Depends(get_db_session)):
    reset_count = session.query(IngestJob).filter(
        IngestJob.status == "failed"
    ).update({"status": "pending", "attempts": 0, "error_message": None})
    session.flush()
    return {"reset_jobs": reset_count}


@router.post("/jobs/skip-stage")
def skip_stage(stage: str, session: Session = Depends(get_db_session)):
    """Skip all pending jobs for a specific stage."""
    jobs = session.query(IngestJob).filter_by(stage=stage, status="pending").all()
    count = len(jobs)
    for j in jobs:
        j.status = "skipped"
        j.error_message = f"{stage}_skipped_by_user"
    session.flush()
    return {"skipped": count, "stage": stage}


@router.post("/jobs/restore-stage")
def restore_stage(stage: str, session: Session = Depends(get_db_session)):
    """Restore all skipped jobs for a specific stage back to pending."""
    jobs = session.query(IngestJob).filter(
        IngestJob.stage == stage,
        IngestJob.status == "skipped",
        IngestJob.error_message == f"{stage}_skipped_by_user"
    ).all()
    count = len(jobs)
    for j in jobs:
        j.status = "pending"
        j.attempts = 0
        j.error_message = None
    session.flush()
    get_pipeline_worker().start()
    return {"restored": count, "stage": stage}


@router.get("/jobs/stage-status")
def get_stage_status(session: Session = Depends(get_db_session)):
    """Get skipped/active status for each stage."""
    stages = ["metadata", "hash", "thumbnail", "transcript", "embed"]
    result = {}
    for stage in stages:
        skipped_by_user = session.query(IngestJob).filter(
            IngestJob.stage == stage,
            IngestJob.status == "skipped",
            IngestJob.error_message == f"{stage}_skipped_by_user"
        ).count()
        pending = session.query(IngestJob).filter_by(stage=stage, status="pending").count()
        result[stage] = {
            "skipped_by_user": skipped_by_user,
            "pending": pending,
            "is_skipped": skipped_by_user > 0 and pending == 0,
        }
    return result


@router.post("/jobs/create-clip-embed")
def create_clip_embed_jobs(session: Session = Depends(get_db_session)):
    """Create clip_embed IngestJobs for all files that don't have one yet."""
    files_without_job = (
        session.query(VideoFile)
        .filter(~VideoFile.id.in_(
            session.query(IngestJob.video_file_id).filter(IngestJob.stage == "clip_embed")
        ))
        .all()
    )
    created = 0
    for vf in files_without_job:
        job = IngestJob(video_file_id=vf.id, stage="clip_embed", status="pending")
        session.add(job)
        created += 1
    session.flush()
    get_pipeline_worker().start()
    return {"created": created}
