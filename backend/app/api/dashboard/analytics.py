"""Per-phase timing analytics."""
from __future__ import annotations

from datetime import timedelta
from typing import Any, Dict

from fastapi import APIRouter, Depends
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.db.models import IngestJob
from app.db.session import get_db_session

router = APIRouter()


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
