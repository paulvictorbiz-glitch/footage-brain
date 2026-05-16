"""
API routes for Phase A features:
- Storage stats with warnings
- CSV export
- Batch project tagging
- Search history
- Per-stage indexing speed
"""
from __future__ import annotations

import csv
import io
from datetime import datetime, timedelta, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.db.models import DuplicateGroup, SearchHistory, VideoFile
from app.db.session import get_db_session

router = APIRouter(prefix="/tools", tags=["tools"])


@router.get("/storage")
def get_storage_stats(session: Session = Depends(get_db_session)):
    import os
    import shutil
    from app.core.config import get_settings
    from app.db.models import ScanRoot

    settings = get_settings()

    def dir_size(path: str) -> int:
        total = 0
        try:
            for dirpath, _, files in os.walk(path):
                for f in files:
                    try:
                        total += os.path.getsize(os.path.join(dirpath, f))
                    except OSError:
                        pass
        except OSError:
            pass
        return total

    db_path = "./footage_brain.db"
    db_size = os.path.getsize(db_path) if os.path.exists(db_path) else 0
    thumb_size = dir_size(settings.thumbnails_dir)
    chroma_size = dir_size(settings.chroma_dir)
    keyframe_size = dir_size(settings.keyframes_dir)
    total_app_size = db_size + thumb_size + chroma_size + keyframe_size

    roots = session.query(ScanRoot).filter_by(enabled=True).all()
    drive_stats = []
    warnings = []
    seen_drives = set()

    for root in roots:
        try:
            drive = os.path.splitdrive(root.path)[0] or root.path[:2]
            if drive in seen_drives:
                continue
            seen_drives.add(drive)
            total, used, free = shutil.disk_usage(root.path)
            pct_used = (used / total * 100) if total > 0 else 0
            pct_free = 100 - pct_used
            stat = {
                "root_id": root.id,
                "label": root.label or root.path,
                "path": root.path,
                "drive": drive,
                "total_bytes": total,
                "used_bytes": used,
                "free_bytes": free,
                "pct_used": round(pct_used, 1),
                "warning": None,
            }
            if pct_free < 5:
                stat["warning"] = "critical"
                warnings.append(f"{root.label or root.path} is almost full ({pct_free:.1f}% free)")
            elif pct_free < 15:
                stat["warning"] = "low"
                warnings.append(f"{root.label or root.path} is running low ({pct_free:.1f}% free)")
            drive_stats.append(stat)
        except (OSError, TypeError):
            drive_stats.append({
                "root_id": root.id,
                "label": root.label or root.path,
                "path": root.path,
                "drive": "",
                "total_bytes": 0,
                "used_bytes": 0,
                "free_bytes": 0,
                "pct_used": 0,
                "warning": "unavailable",
            })

    return {
        "app_storage": {
            "database_bytes": db_size,
            "thumbnails_bytes": thumb_size,
            "chroma_bytes": chroma_size,
            "keyframes_bytes": keyframe_size,
            "total_bytes": total_app_size,
        },
        "drives": drive_stats,
        "warnings": warnings,
    }


@router.post("/batch-tag")
def batch_tag(
    file_ids: List[str],
    project_tag: str,
    session: Session = Depends(get_db_session),
):
    updated = 0
    for fid in file_ids:
        vf = session.get(VideoFile, fid)
        if vf:
            vf.project_tag = project_tag or None
            updated += 1
    session.flush()
    return {"updated": updated, "project_tag": project_tag}


@router.get("/project-tags")
def get_project_tags(session: Session = Depends(get_db_session)):
    rows = (
        session.query(VideoFile.project_tag)
        .filter(VideoFile.project_tag.isnot(None))
        .distinct()
        .all()
    )
    return {"tags": sorted([r[0] for r in rows if r[0]])}


@router.post("/export/search-csv")
def export_search_csv(
    file_ids: List[str],
    session: Session = Depends(get_db_session),
):
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "filename", "path", "extension", "duration_seconds",
        "width", "height", "fps", "video_codec", "has_audio",
        "file_size_bytes", "project_tag", "sha256",
        "is_duplicate", "is_canonical", "created_time", "modified_time"
    ])
    for fid in file_ids:
        vf = session.get(VideoFile, fid)
        if not vf:
            continue
        writer.writerow([
            vf.filename, vf.abs_path, vf.extension,
            round(vf.duration_seconds or 0, 2),
            vf.width or "", vf.height or "",
            round(vf.fps or 0, 3),
            vf.video_codec or "", vf.has_audio, vf.file_size,
            vf.project_tag or "", vf.sha256 or "",
            bool(vf.duplicate_group_id), vf.is_canonical,
            vf.created_time.isoformat() if vf.created_time else "",
            vf.modified_time.isoformat() if vf.modified_time else "",
        ])
    output.seek(0)
    filename = f"footage_export_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.csv"
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@router.get("/export/duplicates-csv")
def export_duplicates_csv(session: Session = Depends(get_db_session)):
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "group_id", "sha256", "canonical_filename", "canonical_path",
        "duplicate_filename", "duplicate_path", "file_size_bytes",
        "duration_seconds", "created_time"
    ])
    groups = session.query(DuplicateGroup).all()
    for g in groups:
        files = session.query(VideoFile).filter_by(duplicate_group_id=g.id).all()
        canonical = next((f for f in files if f.is_canonical), files[0] if files else None)
        for vf in files:
            if vf.is_canonical:
                continue
            writer.writerow([
                g.id, g.sha256[:16] + "...",
                canonical.filename if canonical else "",
                canonical.abs_path if canonical else "",
                vf.filename, vf.abs_path, vf.file_size,
                round(vf.duration_seconds or 0, 2),
                vf.created_time.isoformat() if vf.created_time else "",
            ])
    output.seek(0)
    filename = f"duplicates_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.csv"
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@router.post("/search-history")
def add_search_history(
    query: str,
    mode: str = "semantic",
    result_count: int = 0,
    session: Session = Depends(get_db_session),
):
    if not query.strip():
        return {"ok": False}
    entry = SearchHistory(query=query.strip(), mode=mode, result_count=result_count)
    session.add(entry)
    session.flush()
    return {"ok": True, "id": entry.id}


@router.get("/search-history")
def get_search_history(
    limit: int = Query(20, ge=1, le=100),
    session: Session = Depends(get_db_session),
):
    rows = (
        session.query(SearchHistory)
        .order_by(SearchHistory.created_at.desc())
        .limit(limit)
        .all()
    )
    return {
        "history": [
            {
                "id": r.id,
                "query": r.query,
                "mode": r.mode,
                "result_count": r.result_count,
                "created_at": r.created_at.isoformat(),
            }
            for r in rows
        ]
    }


@router.delete("/search-history")
def clear_search_history(session: Session = Depends(get_db_session)):
    session.query(SearchHistory).delete()
    return {"ok": True}


@router.get("/project-stats")
def get_project_stats(session: Session = Depends(get_db_session)):
    rows = (
        session.query(
            VideoFile.project_tag,
            func.count(VideoFile.id).label("file_count"),
            func.sum(VideoFile.duration_seconds).label("total_duration"),
            func.sum(VideoFile.file_size).label("total_size"),
        )
        .group_by(VideoFile.project_tag)
        .all()
    )
    return {
        "projects": [
            {
                "tag": r.project_tag or "(untagged)",
                "file_count": r.file_count,
                "total_duration_seconds": round(r.total_duration or 0, 1),
                "total_size_bytes": r.total_size or 0,
            }
            for r in sorted(rows, key=lambda x: -(x.file_count or 0))
        ]
    }


@router.get("/indexing-speed")
def get_indexing_speed(session: Session = Depends(get_db_session)):
    from app.db.models import IngestJob
    from app.ingest.pipeline import STAGE_HANDLERS

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    one_hour_ago = now - timedelta(hours=1)
    ten_min_ago = now - timedelta(minutes=10)

    # Drive the stage list from the live pipeline so adding a new stage to
    # STAGE_HANDLERS automatically shows up in the dashboard.
    stage_order = ["metadata", "hash", "thumbnail", "transcript", "embed", "clip_embed", "caption", "keyframes"]
    stages = [s for s in stage_order if s in STAGE_HANDLERS] + [
        s for s in STAGE_HANDLERS if s not in stage_order
    ]

    result = []
    for stage in stages:
        rate_hr = session.query(IngestJob).filter(
            IngestJob.stage == stage,
            IngestJob.status == "done",
            IngestJob.finished_at >= one_hour_ago,
        ).count()
        rate_10m = session.query(IngestJob).filter(
            IngestJob.stage == stage,
            IngestJob.status == "done",
            IngestJob.finished_at >= ten_min_ago,
        ).count()

        done = session.query(IngestJob).filter_by(stage=stage, status="done").count()
        pending = session.query(IngestJob).filter_by(stage=stage, status="pending").count()
        paused = session.query(IngestJob).filter_by(stage=stage, status="paused").count()
        processing = session.query(IngestJob).filter_by(stage=stage, status="processing").count()
        failed = session.query(IngestJob).filter_by(stage=stage, status="failed").count()
        skipped = session.query(IngestJob).filter_by(stage=stage, status="skipped").count()

        # Per-stage ETA: prefer the 10-min window when it has signal (more
        # responsive after model swaps or thermal pauses), otherwise fall back
        # to the 1-hour rate. None means "no rate yet, can't estimate".
        eta_seconds = None
        rate_per_sec_10m = rate_10m / 600.0 if rate_10m > 0 else 0
        rate_per_sec_hr = rate_hr / 3600.0 if rate_hr > 0 else 0
        eff_rate_per_sec = rate_per_sec_10m or rate_per_sec_hr
        if eff_rate_per_sec > 0 and pending > 0:
            eta_seconds = int(pending / eff_rate_per_sec)

        result.append({
            "stage": stage,
            "rate_per_hour": rate_hr,
            "rate_per_10min": rate_10m,
            "done": done,
            "pending": pending,
            "paused": paused,
            "processing": processing,
            "failed": failed,
            "skipped": skipped,
            "eta_seconds": eta_seconds,
        })

    total_pending = sum(r["pending"] for r in result)
    active_stage = next((r for r in result if r["pending"] > 0 or r["processing"] > 0), None)

    # Total ETA = sum of per-stage ETAs that have a rate. Stages with no rate
    # contribute nothing (we don't know how long they'll take yet).
    eta_seconds_total = sum(r["eta_seconds"] for r in result if r["eta_seconds"])
    eta_hours = None
    if active_stage and active_stage["eta_seconds"]:
        eta_hours = round(active_stage["eta_seconds"] / 3600.0, 1)

    return {
        "stages": result,
        "total_pending": total_pending,
        "eta_hours": eta_hours,
        "eta_seconds_total": eta_seconds_total or None,
        "active_stage": active_stage["stage"] if active_stage else None,
    }


@router.get("/search-diagnose")
def search_diagnose(
    q: str = Query(..., min_length=1, description="search query"),
    n: int = Query(3, ge=1, le=10, description="top results per mode"),
    session: Session = Depends(get_db_session),
):
    """
    Run one query through every supported search mode and return the top
    results per mode. Used by the /diagnose page to compare modes
    side-by-side — fastest way to verify that visual/caption/multimodal
    actually retrieve sensible results on real footage.
    """
    from app.search.engine import SEARCH_MODES, SearchFilters, search

    filters = SearchFilters()
    out: dict[str, list[dict]] = {}
    for mode in SEARCH_MODES:
        try:
            results = search(session, q, mode=mode, filters=filters, n_results=n)
        except Exception as exc:
            out[mode] = [{"_error": str(exc)[:200]}]
            continue
        out[mode] = [
            {
                "video_file_id": r.video_file_id,
                "filename": r.filename,
                "thumbnail_path": r.thumbnail_path,
                "duration_seconds": r.duration_seconds,
                "best_score": r.best_score,
                "snippet": (r.matched_chunks[0].text[:140] if r.matched_chunks else None),
                "frame_timestamp": (r.frame_matches[0].timestamp if r.frame_matches else None),
            }
            for r in results
        ]
    return {"query": q, "n": n, "results": out}