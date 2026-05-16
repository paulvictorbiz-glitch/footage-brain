"""Multimodal stream reconcile + rebuild endpoints."""
from __future__ import annotations

from typing import List, Optional

from fastapi import APIRouter, Body, Depends
from sqlalchemy.orm import Session

from app.db.session import get_db_session
from app.ingest.pipeline import get_pipeline_worker

router = APIRouter()


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
    streams: Optional[List[str]] = Body(None),
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
