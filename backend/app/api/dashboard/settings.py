"""App settings + persistent pipeline-stage toggles (CLIP / VLM)."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.schemas import AppSettingsOut
from app.core.config import get_settings
from app.db.models import IngestJob, VideoFile
from app.db.session import get_db_session
from app.ingest.pipeline import get_pipeline_worker
from app.ingest.stage_settings import (
    TOGGLEABLE_STAGES,
    get_stage_toggles,
    set_stage_toggles,
)

router = APIRouter()


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
