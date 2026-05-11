"""
Timeline CRUD, clip management, reorder, and CSV export.
"""
from __future__ import annotations

import csv
import io
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from app.db.models import Timeline, TimelineClip, VideoFile
from app.db.session import get_db_session
from app.api.schemas import (
    TimelineCreate,
    TimelineUpdate,
    TimelineClipCreate,
    TimelineClipUpdate,
    TimelineClipOut,
    TimelineOut,
    TimelineListOut,
    ReorderClipsRequest,
)

router = APIRouter(prefix="/timelines", tags=["timelines"])

TRACK_NAMES = {0: "Video (Main)", 1: "B-Roll", 2: "Audio/Narration", 3: "Graphics"}


def _get_timeline(db: Session, timeline_id: str) -> Timeline:
    tl = db.get(Timeline, timeline_id)
    if not tl:
        raise HTTPException(status_code=404, detail="Timeline not found")
    return tl


def _get_clip(db: Session, timeline_id: str, clip_id: str) -> TimelineClip:
    clip = db.get(TimelineClip, clip_id)
    if not clip or clip.timeline_id != timeline_id:
        raise HTTPException(status_code=404, detail="Clip not found")
    return clip


# ─── Timeline CRUD ────────────────────────────────────────────────────────────

@router.get("", response_model=List[TimelineListOut])
def list_timelines(db: Session = Depends(get_db_session)):
    rows = db.execute(select(Timeline).order_by(Timeline.updated_at.desc())).scalars().all()
    out = []
    for tl in rows:
        count = db.execute(
            select(TimelineClip).where(TimelineClip.timeline_id == tl.id)
        ).scalars()
        out.append(TimelineListOut(
            id=tl.id,
            name=tl.name,
            description=tl.description,
            created_at=tl.created_at,
            updated_at=tl.updated_at,
            clip_count=len(list(count)),
        ))
    return out


@router.post("", response_model=TimelineOut, status_code=201)
def create_timeline(body: TimelineCreate, db: Session = Depends(get_db_session)):
    tl = Timeline(name=body.name, description=body.description)
    db.add(tl)
    db.commit()
    db.refresh(tl)
    return _load_timeline(db, tl.id)


@router.get("/{timeline_id}", response_model=TimelineOut)
def get_timeline(timeline_id: str, db: Session = Depends(get_db_session)):
    _get_timeline(db, timeline_id)
    return _load_timeline(db, timeline_id)


@router.patch("/{timeline_id}", response_model=TimelineOut)
def update_timeline(timeline_id: str, body: TimelineUpdate, db: Session = Depends(get_db_session)):
    tl = _get_timeline(db, timeline_id)
    if body.name is not None:
        tl.name = body.name
    if body.description is not None:
        tl.description = body.description
    db.commit()
    return _load_timeline(db, timeline_id)


@router.delete("/{timeline_id}", status_code=204)
def delete_timeline(timeline_id: str, db: Session = Depends(get_db_session)):
    tl = _get_timeline(db, timeline_id)
    db.delete(tl)
    db.commit()


# ─── Clip management ──────────────────────────────────────────────────────────

@router.post("/{timeline_id}/clips", response_model=TimelineClipOut, status_code=201)
def add_clip(timeline_id: str, body: TimelineClipCreate, db: Session = Depends(get_db_session)):
    _get_timeline(db, timeline_id)
    vf = db.get(VideoFile, body.video_file_id)
    if not vf:
        raise HTTPException(status_code=404, detail="Video file not found")

    # Auto-assign position at end of track if not specified
    existing = db.execute(
        select(TimelineClip)
        .where(TimelineClip.timeline_id == timeline_id, TimelineClip.track == body.track)
        .order_by(TimelineClip.position.desc())
    ).scalars().first()
    position = body.position if body.position != 0 else ((existing.position + 1) if existing else 0)

    # Auto-calculate timeline_start (absolute position on timeline)
    if body.timeline_start is not None:
        tl_start = body.timeline_start
    else:
        last_placed = db.execute(
            select(TimelineClip)
            .options(joinedload(TimelineClip.video_file))
            .where(
                TimelineClip.timeline_id == timeline_id,
                TimelineClip.track == body.track,
                TimelineClip.timeline_start.isnot(None),
            )
            .order_by(TimelineClip.timeline_start.desc())
        ).scalars().first()
        if last_placed is not None:
            lv = last_placed.video_file
            l_in  = last_placed.in_point  or 0.0
            l_out = last_placed.out_point or (lv.duration_seconds or 0.0)
            tl_start = (last_placed.timeline_start or 0.0) + max(0.0, l_out - l_in)
        else:
            tl_start = 0.0

    clip = TimelineClip(
        timeline_id=timeline_id,
        video_file_id=body.video_file_id,
        track=body.track,
        position=position,
        in_point=body.in_point,
        out_point=body.out_point,
        timeline_start=tl_start,
        label=body.label,
        notes=body.notes,
    )
    db.add(clip)
    db.commit()
    db.refresh(clip)
    return _load_clip(db, clip.id)


@router.patch("/{timeline_id}/clips/{clip_id}", response_model=TimelineClipOut)
def update_clip(
    timeline_id: str, clip_id: str, body: TimelineClipUpdate, db: Session = Depends(get_db_session)
):
    clip = _get_clip(db, timeline_id, clip_id)
    if body.track is not None:
        clip.track = body.track
    if body.position is not None:
        clip.position = body.position
    if body.in_point is not None:
        clip.in_point = body.in_point
    if body.out_point is not None:
        clip.out_point = body.out_point
    if body.timeline_start is not None:
        clip.timeline_start = body.timeline_start
    if body.label is not None:
        clip.label = body.label
    if body.notes is not None:
        clip.notes = body.notes
    db.commit()
    return _load_clip(db, clip.id)


@router.delete("/{timeline_id}/clips/{clip_id}", status_code=204)
def remove_clip(timeline_id: str, clip_id: str, db: Session = Depends(get_db_session)):
    clip = _get_clip(db, timeline_id, clip_id)
    db.delete(clip)
    db.commit()


@router.post("/{timeline_id}/reorder", status_code=204)
def reorder_clips(timeline_id: str, body: ReorderClipsRequest, db: Session = Depends(get_db_session)):
    _get_timeline(db, timeline_id)
    for pos, clip_id in enumerate(body.clip_ids):
        clip = db.get(TimelineClip, clip_id)
        if clip and clip.timeline_id == timeline_id and clip.track == body.track:
            clip.position = pos
    db.commit()


# ─── CSV Export ───────────────────────────────────────────────────────────────

@router.get("/{timeline_id}/export-csv")
def export_csv(timeline_id: str, db: Session = Depends(get_db_session)):
    tl = _get_timeline(db, timeline_id)
    clips = db.execute(
        select(TimelineClip)
        .options(joinedload(TimelineClip.video_file))
        .where(TimelineClip.timeline_id == timeline_id)
        .order_by(TimelineClip.track, TimelineClip.position)
    ).scalars().all()

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow([
        "clip_num", "track", "position", "filename", "abs_path",
        "in_point_sec", "out_point_sec", "clip_duration_sec", "file_duration_sec",
        "label", "notes",
    ])
    for i, clip in enumerate(clips, 1):
        vf = clip.video_file
        in_pt = clip.in_point if clip.in_point is not None else 0.0
        out_pt = clip.out_point if clip.out_point is not None else (vf.duration_seconds or 0.0)
        clip_dur = round(out_pt - in_pt, 3)
        writer.writerow([
            i,
            TRACK_NAMES.get(clip.track, f"Track {clip.track}"),
            clip.position,
            vf.filename,
            vf.abs_path,
            round(in_pt, 3),
            round(out_pt, 3),
            clip_dur,
            round(vf.duration_seconds or 0.0, 3),
            clip.label or "",
            clip.notes or "",
        ])

    buf.seek(0)
    filename = f"timeline_{tl.name.replace(' ', '_')}_{tl.id[:8]}.csv"
    return StreamingResponse(
        buf,
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ─── EDL Export ──────────────────────────────────────────────────────────────

def _secs_to_tc(seconds: float, fps: int = 25) -> str:
    total_frames = int(round(seconds * fps))
    frames = total_frames % fps
    total_secs = total_frames // fps
    secs = total_secs % 60
    mins = (total_secs // 60) % 60
    hours = total_secs // 3600
    return f"{hours:02d}:{mins:02d}:{secs:02d}:{frames:02d}"


@router.get("/{timeline_id}/export-edl")
def export_edl(timeline_id: str, db: Session = Depends(get_db_session)):
    tl = _get_timeline(db, timeline_id)
    # Main track clips only for EDL (primary edit sequence)
    main_clips = db.execute(
        select(TimelineClip)
        .options(joinedload(TimelineClip.video_file))
        .where(TimelineClip.timeline_id == timeline_id, TimelineClip.track == 0)
        .order_by(TimelineClip.position)
    ).scalars().all()

    fps = 25
    lines = [f"TITLE: {tl.name}", "FCM: NON-DROP FRAME", ""]
    record_time = 0.0

    for i, clip in enumerate(main_clips, 1):
        vf = clip.video_file
        in_pt = clip.in_point if clip.in_point is not None else 0.0
        out_pt = clip.out_point if clip.out_point is not None else (vf.duration_seconds or 0.0)
        clip_dur = max(0.0, out_pt - in_pt)

        src_in  = _secs_to_tc(in_pt, fps)
        src_out = _secs_to_tc(out_pt, fps)
        rec_in  = _secs_to_tc(record_time, fps)
        rec_out = _secs_to_tc(record_time + clip_dur, fps)

        lines.append(f"{i:03d}  AX       V     C        {src_in} {src_out} {rec_in} {rec_out}")
        lines.append(f"* FROM CLIP NAME: {vf.abs_path}")
        lines.append("")

        record_time += clip_dur

    content = "\n".join(lines)
    safe_name = tl.name.replace(" ", "_")
    filename = f"timeline_{safe_name}_{tl.id[:8]}.edl"
    return StreamingResponse(
        io.StringIO(content),
        media_type="text/plain",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _load_timeline(db: Session, timeline_id: str) -> TimelineOut:
    tl = db.execute(
        select(Timeline)
        .options(
            joinedload(Timeline.clips).joinedload(TimelineClip.video_file)
        )
        .where(Timeline.id == timeline_id)
    ).unique().scalar_one()
    return TimelineOut.model_validate(tl)


def _load_clip(db: Session, clip_id: str) -> TimelineClipOut:
    clip = db.execute(
        select(TimelineClip)
        .options(joinedload(TimelineClip.video_file))
        .where(TimelineClip.id == clip_id)
    ).scalar_one()
    return TimelineClipOut.model_validate(clip)
