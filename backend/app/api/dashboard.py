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
from app.ingest.stage_settings import (
    TOGGLEABLE_STAGES,
    get_stage_toggles,
    set_stage_toggles,
)
from pydantic import BaseModel

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


@router.post("/streams/reconcile")
def reconcile_streams_endpoint(session: Session = Depends(get_db_session)):
    """
    Detect files whose multimodal stream flags don't match the artifacts on
    disk (most commonly: captioner was turned on after files were already
    scanned) and re-queue the corresponding pipeline stages.
    """
    from app.ingest.reconcile import reconcile_streams
    counts = reconcile_streams(session)
    get_pipeline_worker().start()
    return {"requeued": counts}


@router.post("/streams/rebuild")
def rebuild_all_streams_endpoint(
    streams: List[str] = None,
    session: Session = Depends(get_db_session),
):
    """
    Force-rebuild every multimodal stream for every file. Wipes the relevant
    flags and re-queues the stages — the pipeline worker handles the rerun.
    POST with body `{"streams": ["caption"]}` to limit which streams rebuild;
    omit to rebuild all three (transcript embed, CLIP frames, VLM captions).
    """
    from app.ingest.reconcile import rebuild_all_streams
    counts = rebuild_all_streams(session, streams=streams)
    get_pipeline_worker().start()
    return {"requeued": counts}


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


# ─── Pipeline stage toggles (CLIP / VLM persistent enable) ────────────────────


class PipelineTogglesUpdate(BaseModel):
    clip_embed: bool | None = None
    caption: bool | None = None


@router.get("/pipeline-toggles")
def get_pipeline_toggles():
    return get_stage_toggles()


@router.post("/pipeline-toggles")
def update_pipeline_toggles(
    body: PipelineTogglesUpdate, session: Session = Depends(get_db_session)
):
    """
    Enable / disable the toggleable stages (clip_embed, caption).

    Disabling a stage:
      - Sets enabled=False (persisted to pipeline_settings.json).
      - Marks all currently-pending jobs for that stage as 'paused' so the
        worker stops picking them up. In-flight 'processing' jobs are NOT
        interrupted — they finish naturally.

    Enabling a stage:
      - Sets enabled=True.
      - Re-queues any 'paused' jobs for that stage back to 'pending'.
      - Creates fresh jobs for any video file where 'transcript' is done but
        no job exists yet for the now-enabled stage (covers files scanned
        while the stage was disabled).
      - Restarts the pipeline worker so it picks them up.
    """
    updates: dict[str, bool] = {}
    if body.clip_embed is not None:
        updates["clip_embed_enabled"] = body.clip_embed
    if body.caption is not None:
        updates["caption_enabled"] = body.caption
    if not updates:
        return {"toggles": get_stage_toggles(), "paused": 0, "requeued": 0, "created": 0}

    new_state = set_stage_toggles(updates)

    paused_count = 0
    requeued_count = 0
    created_count = 0

    for stage in TOGGLEABLE_STAGES:
        enabled = new_state.get(f"{stage}_enabled", True)

        if not enabled:
            # Pause pending jobs for this stage.
            pending = (
                session.query(IngestJob)
                .filter(IngestJob.stage == stage, IngestJob.status == "pending")
                .all()
            )
            for j in pending:
                j.status = "paused"
                j.error_message = f"{stage}_paused_by_user_toggle"
            paused_count += len(pending)
        else:
            # Re-queue jobs paused specifically by this toggle.
            paused = (
                session.query(IngestJob)
                .filter(
                    IngestJob.stage == stage,
                    IngestJob.status == "paused",
                    IngestJob.error_message == f"{stage}_paused_by_user_toggle",
                )
                .all()
            )
            for j in paused:
                j.status = "pending"
                j.error_message = None
                j.attempts = 0
            requeued_count += len(paused)

            # Create jobs for transcribed files that never got one (because
            # the stage was disabled during their scan).
            files_without_job = (
                session.query(VideoFile)
                .filter(VideoFile.transcribed.is_(True))
                .filter(
                    ~VideoFile.id.in_(
                        session.query(IngestJob.video_file_id).filter(
                            IngestJob.stage == stage
                        )
                    )
                )
                .all()
            )
            for vf in files_without_job:
                session.add(
                    IngestJob(video_file_id=vf.id, stage=stage, status="pending")
                )
                created_count += 1

    session.flush()

    # If anything was newly queued, make sure the worker is running.
    if requeued_count or created_count:
        get_pipeline_worker().start()

    return {
        "toggles": new_state,
        "paused": paused_count,
        "requeued": requeued_count,
        "created": created_count,
    }


# ─── Coverage tree (per-folder per-stage completion) ─────────────────────────

_COVERAGE_STAGES = ("metadata", "hash", "thumbnail", "transcript", "embed", "clip_embed", "caption")


@router.get("/coverage-tree")
def get_coverage_tree(session: Session = Depends(get_db_session)):
    """
    Per-scan-root folder tree where each folder has a per-stage completion
    breakdown. Used by the Coverage page to colour every folder by which
    phases are complete.

    For each (folder, stage):
      done    = jobs in 'done' for that stage on files under that folder
      total   = total file count for that folder

    Disabled stages are flagged via current pipeline_settings, so the UI can
    render their cells differently (dashed, "skipped" tag) instead of red.
    """
    toggles = get_stage_toggles()
    disabled_stages = [
        s for s in TOGGLEABLE_STAGES if not toggles.get(f"{s}_enabled", True)
    ]

    roots_q = session.query(ScanRoot).filter_by(enabled=True).all()
    result_roots: List[Dict[str, Any]] = []

    for root in roots_q:
        files = (
            session.query(VideoFile)
            .filter_by(scan_root_id=root.id)
            .all()
        )
        # Group files by folder relative to root.path
        folder_files: Dict[str, List[VideoFile]] = {}
        for f in files:
            try:
                rel = f.abs_path.replace(root.path, "").strip(os.sep)
            except Exception:
                rel = f.filename
            parts = rel.split(os.sep)
            folder = os.sep.join(parts[:-1]) if len(parts) > 1 else ""
            folder_files.setdefault(folder, []).append(f)

        # Get done + skipped job stage flags for the files we care about, in
        # bulk. Skipped is its own bucket so the UI can render those cells
        # distinctly ("intentionally not run" vs "still pending").
        if files:
            file_ids = [f.id for f in files]
            status_rows = (
                session.query(IngestJob.video_file_id, IngestJob.stage, IngestJob.status)
                .filter(
                    IngestJob.video_file_id.in_(file_ids),
                    IngestJob.status.in_(("done", "skipped")),
                    IngestJob.stage.in_(_COVERAGE_STAGES),
                )
                .all()
            )
        else:
            status_rows = []

        done_by_file: Dict[str, set] = {}
        skipped_by_file: Dict[str, set] = {}
        for fid, stage, status in status_rows:
            if status == "done":
                done_by_file.setdefault(fid, set()).add(stage)
            elif status == "skipped":
                skipped_by_file.setdefault(fid, set()).add(stage)

        folder_out = []
        for folder_path, group in sorted(folder_files.items()):
            stage_counts = {s: 0 for s in _COVERAGE_STAGES}
            skipped_counts = {s: 0 for s in _COVERAGE_STAGES}
            for vf in group:
                for s in done_by_file.get(vf.id, set()):
                    if s in stage_counts:
                        stage_counts[s] += 1
                for s in skipped_by_file.get(vf.id, set()):
                    if s in skipped_counts:
                        skipped_counts[s] += 1
            folder_out.append(
                {
                    "rel_path": folder_path,
                    "file_count": len(group),
                    "stage_counts": stage_counts,
                    "skipped_counts": skipped_counts,
                }
            )

        # Roll up root-level totals too.
        root_stage_counts = {s: 0 for s in _COVERAGE_STAGES}
        root_skipped_counts = {s: 0 for s in _COVERAGE_STAGES}
        for fo in folder_out:
            for s in _COVERAGE_STAGES:
                root_stage_counts[s] += fo["stage_counts"][s]
                root_skipped_counts[s] += fo["skipped_counts"][s]

        result_roots.append(
            {
                "root_id": root.id,
                "label": root.label or root.path,
                "path": root.path,
                "is_online": getattr(root, "is_online", True),
                "file_count": len(files),
                "stage_counts": root_stage_counts,
                "skipped_counts": root_skipped_counts,
                "folders": folder_out,
            }
        )

    return {
        "stages": list(_COVERAGE_STAGES),
        "disabled_stages": disabled_stages,
        "roots": result_roots,
    }


# ─── Per-phase analytics (timing breakdown) ───────────────────────────────────


_PHASE_STAGES = ("metadata", "hash", "thumbnail", "transcript", "embed", "clip_embed", "caption")
_ACTIVE_CAP_SECONDS = 600.0  # cap per-job durations to ignore pause/resume gaps


@router.get("/phase-analytics")
def get_phase_analytics(
    scope: str = "latest", session: Session = Depends(get_db_session)
):
    """
    Per-stage timing summary.

    scope="latest": only the most recent contiguous run window (defined as
    jobs whose finished_at is within 24h of the most recent finish).
    scope="all_time": every 'done' job ever recorded.
    """
    base = session.query(IngestJob).filter(
        IngestJob.status == "done",
        IngestJob.started_at.isnot(None),
        IngestJob.finished_at.isnot(None),
    )
    skipped_base = session.query(IngestJob).filter(IngestJob.status == "skipped")

    window_start = None
    window_end = None
    if scope == "latest":
        last_finish = (
            session.query(func.max(IngestJob.finished_at))
            .filter(IngestJob.status == "done")
            .scalar()
        )
        if last_finish:
            window_end = last_finish
            window_start = last_finish - timedelta(hours=24)
            base = base.filter(IngestJob.finished_at >= window_start)
            # For skipped, use whichever timestamp exists (finished_at or
            # started_at), or just include if neither (back-fills don't have
            # them).
            skipped_base = skipped_base.filter(
                (IngestJob.finished_at.is_(None))
                | (IngestJob.finished_at >= window_start)
            )

    rows = base.with_entities(
        IngestJob.stage, IngestJob.started_at, IngestJob.finished_at
    ).all()
    skipped_rows = skipped_base.with_entities(
        IngestJob.stage, IngestJob.error_message
    ).all()

    per_stage: Dict[str, Dict[str, Any]] = {
        s: {
            "done_count": 0,
            "active_seconds": 0.0,
            "skipped_count": 0,
            "skip_reasons": {},
        }
        for s in _PHASE_STAGES
    }
    total_active = 0.0
    for stage, s_at, f_at in rows:
        if stage not in per_stage:
            continue
        d = (f_at - s_at).total_seconds()
        if d < 0:
            continue
        capped = min(d, _ACTIVE_CAP_SECONDS)
        per_stage[stage]["done_count"] += 1
        per_stage[stage]["active_seconds"] += capped
        total_active += capped

    for stage, reason in skipped_rows:
        if stage not in per_stage:
            continue
        per_stage[stage]["skipped_count"] += 1
        key = (reason or "unspecified")[:80]
        per_stage[stage]["skip_reasons"][key] = (
            per_stage[stage]["skip_reasons"].get(key, 0) + 1
        )

    phases = []
    for s in _PHASE_STAGES:
        info = per_stage[s]
        n = info["done_count"]
        active = info["active_seconds"]
        mean = (active / n) if n else 0.0
        pct = (100.0 * active / total_active) if total_active else 0.0
        phases.append(
            {
                "stage": s,
                "done_count": n,
                "active_seconds": round(active, 2),
                "mean_seconds_per_job": round(mean, 2),
                "pct_of_total": round(pct, 1),
                "skipped_count": info["skipped_count"],
                "skip_reasons": info["skip_reasons"],
            }
        )

    return {
        "scope": scope,
        "window_start": window_start.isoformat() if window_start else None,
        "window_end": window_end.isoformat() if window_end else None,
        "total_active_seconds": round(total_active, 2),
        "phases": phases,
    }