"""
API routes for video file operations.
"""
from __future__ import annotations

from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.api.schemas import IngestJobOut, TranscriptChunkOut, VideoFileOut, VideoFileUpdate
from app.db.models import IngestJob, ScanRoot, TranscriptChunk, VideoFile
from app.db.session import get_db_session

router = APIRouter(prefix="/files", tags=["files"])


@router.get("", response_model=List[VideoFileOut])
def list_files(
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    scan_root_id: Optional[str] = None,
    abs_folder: Optional[str] = None,
    sort_by: Optional[str] = None,
    session: Session = Depends(get_db_session),
):
    q = session.query(VideoFile)
    if scan_root_id:
        q = q.filter_by(scan_root_id=scan_root_id)
    if abs_folder:
        q = q.filter(VideoFile.abs_path.like(abs_folder + '%'))
    if sort_by == 'name':
        q = q.order_by(VideoFile.filename.asc())
    elif sort_by == 'size':
        q = q.order_by(VideoFile.file_size.desc())
    elif sort_by == 'duration':
        q = q.order_by(VideoFile.duration_seconds.desc())
    else:
        q = q.order_by(VideoFile.created_at.desc())
    return q.offset(offset).limit(limit).all()


@router.get("/{file_id}", response_model=VideoFileOut)
def get_file(file_id: str, session: Session = Depends(get_db_session)):
    vf = session.get(VideoFile, file_id)
    if not vf:
        raise HTTPException(404, detail="File not found")
    return vf


@router.patch("/{file_id}", response_model=VideoFileOut)
def update_file(
    file_id: str,
    body: VideoFileUpdate,
    session: Session = Depends(get_db_session),
):
    vf = session.get(VideoFile, file_id)
    if not vf:
        raise HTTPException(404, detail="File not found")

    if body.project_tag is not None:
        vf.project_tag = body.project_tag
    if body.is_canonical is not None:
        vf.is_canonical = body.is_canonical
    if body.archive_status is not None:
        allowed = {"none", "pending_copy", "pending_move", "archived"}
        if body.archive_status not in allowed:
            raise HTTPException(400, detail=f"Invalid archive_status. Must be one of: {allowed}")
        vf.archive_status = body.archive_status

    session.flush()
    return vf


@router.get("/{file_id}/transcript", response_model=List[TranscriptChunkOut])
def get_transcript(file_id: str, session: Session = Depends(get_db_session)):
    vf = session.get(VideoFile, file_id)
    if not vf:
        raise HTTPException(404, detail="File not found")
    chunks = (
        session.query(TranscriptChunk)
        .filter_by(video_file_id=file_id)
        .order_by(TranscriptChunk.chunk_index)
        .all()
    )
    return chunks


@router.get("/{file_id}/jobs", response_model=List[IngestJobOut])
def get_jobs(file_id: str, session: Session = Depends(get_db_session)):
    vf = session.get(VideoFile, file_id)
    if not vf:
        raise HTTPException(404, detail="File not found")
    jobs = (
        session.query(IngestJob)
        .filter_by(video_file_id=file_id)
        .order_by(IngestJob.created_at)
        .all()
    )
    return jobs


@router.post("/{file_id}/reprocess")
def reprocess_file(
    file_id: str,
    stages: Optional[List[str]] = Query(None),
    session: Session = Depends(get_db_session),
):
    """Re-queue specific pipeline stages for a file."""
    from app.ingest.pipeline import STAGE_HANDLERS, get_pipeline_worker
    from datetime import datetime

    vf = session.get(VideoFile, file_id)
    if not vf:
        raise HTTPException(404, detail="File not found")

    target_stages = stages or list(STAGE_HANDLERS.keys())
    requeued = []

    # Each pipeline stage guards on a "is this already done?" flag on VideoFile;
    # if we just re-queue the job, the handler returns immediately and the
    # stage never actually re-runs. reset_flag() centralises the mapping
    # so adding a new stage means updating one dict in app/ingest/stages.py.
    from app.ingest.stages import reset_flag

    for stage in target_stages:
        reset_flag(vf, stage)
        if stage == "thumbnail":
            vf.thumbnail_path = None

        job = session.query(IngestJob).filter_by(video_file_id=file_id, stage=stage).first()
        if job:
            job.status = "pending"
            job.attempts = 0
            job.error_message = None
            job.started_at = None
            job.finished_at = None
            requeued.append(stage)
        else:
            new_job = IngestJob(video_file_id=file_id, stage=stage, status="pending")
            session.add(new_job)
            requeued.append(stage)

    session.flush()
    get_pipeline_worker().start()
    return {"status": "ok", "requeued_stages": requeued}


@router.post("/batch-tag")
def batch_tag_files(
    file_ids: List[str],
    project_tag: str,
    session: Session = Depends(get_db_session),
):
    """Batch update project tags for multiple files."""
    updated_count = session.query(VideoFile).filter(
        VideoFile.id.in_(file_ids)
    ).update({"project_tag": project_tag})
    
    session.commit()
    return {"updated_files": updated_count}
