"""Dashboard overview stats."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.api.schemas import DashboardStats, VideoFileOut
from app.db.models import DuplicateGroup, IngestJob, ScanRoot, VideoFile
from app.db.session import get_db_session

router = APIRouter()


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
