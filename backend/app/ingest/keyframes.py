"""
Keyframe extraction stage.

Phase 1: Sample frames at a fixed interval (FRAME_SAMPLE_INTERVAL seconds).
Phase 2 (TODO): Shot boundary detection using PySceneDetect or ffmpeg scene filter.

Extracted frames are saved to KEYFRAMES_DIR/<file_id>/<frame_index>.jpg
"""
from __future__ import annotations

import os
import subprocess
from datetime import datetime
from pathlib import Path
from typing import List, Optional

from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.logging import get_logger
from app.db.models import VideoFile

logger = get_logger(__name__)


def extract_keyframes(
    abs_path: str,
    file_id: str,
    duration: Optional[float],
    interval: Optional[int] = None,
) -> List[str]:
    """
    Extract frames at `interval` seconds throughout the video.
    Returns list of saved frame paths.
    """
    settings = get_settings()
    interval = interval or settings.frame_sample_interval
    out_dir = Path(settings.keyframes_dir) / file_id
    out_dir.mkdir(parents=True, exist_ok=True)

    if not duration or duration < 1:
        return []

    # Use ffmpeg's fps filter to extract at fixed rate
    fps_filter = f"fps=1/{interval}"

    cmd = [
        "ffmpeg",
        "-i", abs_path,
        "-vf", f"{fps_filter},scale=640:-1",
        "-q:v", "3",
        "-frame_pts", "1",
        str(out_dir / "frame_%06d.jpg"),
        "-y",
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, timeout=120)
        if result.returncode != 0:
            logger.warning("keyframe_extract_failed", file=abs_path, stderr=result.stderr[:200])
            return []
    except (subprocess.TimeoutExpired, FileNotFoundError) as exc:
        logger.error("keyframe_extract_error", path=abs_path, error=str(exc))
        return []

    # Collect output files
    frames = sorted(out_dir.glob("frame_*.jpg"))
    paths = [str(f) for f in frames]
    logger.info("keyframes_extracted", file=abs_path, count=len(paths))
    return paths


def run_keyframe_stage(session: Session, vf: VideoFile) -> bool:
    """
    Extract keyframes for vf if not already done.
    Phase 1: sample at interval. Phase 2 will add scene detection.
    """
    paths = extract_keyframes(vf.abs_path, vf.id, vf.duration_seconds)
    vf.keyframes_extracted = True
    vf.updated_at = datetime.utcnow()
    session.flush()

    logger.info("keyframe_stage_done", file=vf.filename, frames=len(paths))
    return True


# ─────────────────────────────────────────────────────────────────────────────
# Phase 2 placeholder: visual embeddings
# ─────────────────────────────────────────────────────────────────────────────

def embed_keyframes_phase2(file_id: str, frame_paths: List[str]) -> None:
    """
    TODO Phase 2:
    1. Load each frame with PIL
    2. Run through CLIP or similar visual embedding model
    3. Upsert into a separate Chroma collection: 'keyframe_embeddings'
    4. At query time, embed the text query with CLIP's text encoder
       and search both transcript_chunks + keyframe_embeddings collections
    5. Merge/rerank results

    This function is a placeholder that documents the intended architecture.
    """
    raise NotImplementedError("Visual embeddings are a Phase 2 feature")
