"""
API routes for dashboard stats, job queue status, and settings.
"""
from __future__ import annotations

import os
import shutil
from datetime import datetime, timedelta
from typing import Dict, List, Any

from fastapi import APIRouter, Depends
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.api.schemas import AppSettingsOut, DashboardStats, VideoFileOut
from app.core.config import get_settings
from app.db.models import DuplicateGroup, IngestJob, ScanRoot, VideoFile
from app.db.session import get_db_session
from app.ingest.pipeline import get_pipeline_worker

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("/stats", response_model=DashboardStats)
def get_stats(session: Session = Depends(get_db_session)):
    total_files = session.query(VideoFile).count()
    total_indexed = session.query(VideoFile).filter_by(metadata_extracted=True).count()
    total_transcribed = session.query(VideoFile).filter_by(transcribed=True).count()
    total_embedded = session.query(VideoFile).filter_by(embedded=True).count()

    dur_row = session.query(func.sum(VideoFile.duration_seconds)).scalar() or 0
    size_row = session.query(func.sum(VideoFile.file_size)).scalar() or 0

    dup_groups = session.query(DuplicateGroup).count()
    dup_files = session.query(VideoFile).filter(VideoFile.duplicate_group_id.isnot(None)).count()

    roots = session.query(ScanRoot).all()
    storage_by_root = []
    for root in roots:
        size = (
            session.query(func.sum(VideoFile.file_size))
            .filter_by(scan_root_id=root.id)
            .scalar() or 0
        )
        count = session.query(VideoFile).filter_by(scan_root_id=root.id).count()
        storage_by_root.append({
            "root_id": root.id,
            "label": root.label or root.path,
            "path": root.path,
            "file_count": count,
            "total_bytes": size,
        })

    job_rows = (
        session.query(IngestJob.status, func.count(IngestJob.id))
        .group_by(IngestJob.status)
        .all()
    )
    job_stats = {status: count for status, count in job_rows}

    recent = (
        session.query(VideoFile)
        .order_by(VideoFile.created_at.desc())
        .limit(10)
        .all()
    )

    return DashboardStats(
        total_files=total_files,
        total_indexed=total_indexed,
        total_transcribed=total_transcribed,
        total_embedded=total_embedded,
        total_duration_hours=round(dur_row / 3600, 2),
        total_size_bytes=int(size_row),
        duplicate_groups=dup_groups,
        duplicate_files=dup_files,
        storage_by_root=storage_by_root,
        job_stats=job_stats,
        recent_files=[VideoFileOut.model_validate(f) for f in recent],
    )


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

    from app.api.schemas import IngestJobOut
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


@router.get("/folders")
def get_folder_structure(session: Session = Depends(get_db_session)):
    roots = session.query(ScanRoot).filter_by(enabled=True).all()
    result = []
    for root in roots:
        files = session.query(VideoFile).filter_by(scan_root_id=root.id).all()
        folder_tree = {}
        for file in files:
            rel = file.abs_path.replace(root.path, '').strip(os.sep)
            parts = rel.split(os.sep)
            folder_path = os.sep.join(parts[:-1])
            if folder_path not in folder_tree:
                folder_tree[folder_path] = {
                    "path": folder_path,
                    "file_count": 0,
                    "total_bytes": 0,
                    "total_duration": 0,
                }
            folder_tree[folder_path]["file_count"] += 1
            folder_tree[folder_path]["total_bytes"] += file.file_size or 0
            folder_tree[folder_path]["total_duration"] += file.duration_seconds or 0
        result.append({
            "root_id": root.id,
            "root_label": root.label or root.path,
            "root_path": root.path,
            "folders": list(folder_tree.values()),
        })
    return result


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
    from app.db.models import VideoFile
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


@router.get("/settings", response_model=AppSettingsOut)
def get_app_settings():
    s = get_settings()
    return AppSettingsOut(
        whisper_model=s.whisper_model,
        whisper_device=s.whisper_device,
        embed_model=s.embed_model,
        frame_sample_interval=s.frame_sample_interval,
        ingest_workers=s.ingest_workers,
        video_extensions=s.video_extensions,
        thumbnails_dir=s.thumbnails_dir,
        chroma_dir=s.chroma_dir,
    )