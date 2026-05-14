"""
Caption-embedding pipeline stage.

For each sampled frame of a video:
  1. Run the VLM captioner to generate a short text description.
  2. Persist the caption to the `frame_captions` SQL table.
  3. Embed the caption with the existing sentence-transformer.
  4. Upsert the embedding into the `frame_captions` Chroma collection.

This is the third semantic stream alongside transcript-text embeddings and
CLIP image embeddings — it lets editors search by visible content using
language even when speech is absent.

Default-disabled (settings.captioner_enabled). When disabled the handler
marks the file `captioned=True` without doing any work, so the stage is a
cheap no-op during bulk ingest and only does real work when the user
explicitly enables it (per-folder enrich workflow).
"""
from __future__ import annotations

import os
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path
from typing import List, Tuple

from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.logging import get_logger
from app.db.models import FrameCaption, VideoFile
from app.vector.store import get_caption_store

logger = get_logger(__name__)


def _extract_frames(abs_path: str, interval: int, tmpdir: str) -> List[Tuple[str, float]]:
    """Extract frames at fixed interval into tmpdir. Returns [(path, timestamp), ...]."""
    out_pattern = os.path.join(tmpdir, "frame_%06d.jpg")
    cmd = [
        get_settings().ffmpeg_exe,
        "-i", abs_path,
        "-vf", f"fps=1/{interval},scale=384:-1",
        "-q:v", "3",
        "-frame_pts", "1",
        out_pattern,
        "-y",
    ]
    try:
        subprocess.run(cmd, capture_output=True, timeout=300, check=False)
    except (subprocess.TimeoutExpired, FileNotFoundError) as exc:
        logger.error("caption_frame_extract_error", path=abs_path, error=str(exc))
        return []

    frames = sorted(Path(tmpdir).glob("frame_*.jpg"))
    return [(str(f), float(i * interval)) for i, f in enumerate(frames)]


def caption_video(session: Session, vf: VideoFile) -> bool:
    settings = get_settings()

    if vf.captioned:
        return True

    if not settings.captioner_enabled:
        # Mark done so we don't keep re-queuing on every pipeline tick.
        # If the user later enables captioning, they can re-queue this file
        # explicitly via the reprocess API.
        logger.info("caption_skip_disabled", file=vf.filename)
        vf.captioned = True
        vf.updated_at = datetime.utcnow()
        session.flush()
        return True

    if not vf.duration_seconds or vf.duration_seconds < 1:
        vf.captioned = True
        vf.updated_at = datetime.utcnow()
        session.flush()
        return True

    interval = settings.frame_sample_interval
    model_name = settings.captioner_model

    with tempfile.TemporaryDirectory(prefix="caption_embed_") as tmpdir:
        frame_infos = _extract_frames(vf.abs_path, interval, tmpdir)
        if not frame_infos:
            logger.info("caption_no_frames", file=vf.filename)
            vf.captioned = True
            vf.updated_at = datetime.utcnow()
            session.flush()
            return True

        # Caption all frames with the VLM
        try:
            from PIL import Image
            from app.ingest.captioner import caption_images
            images = [Image.open(p).convert("RGB") for p, _ in frame_infos]
            captions = caption_images(images)
        except Exception as exc:
            logger.error("caption_generate_error", file=vf.filename, error=str(exc))
            return False

        # Embed captions with the existing sentence-transformer so they live
        # in the same vector space as transcript chunks.
        non_empty = [(idx, c) for idx, c in enumerate(captions) if c.strip()]
        if not non_empty:
            logger.info("caption_all_empty", file=vf.filename)
            vf.captioned = True
            vf.updated_at = datetime.utcnow()
            session.flush()
            return True

        try:
            from app.ingest.embedder import embed_text
            embeddings = embed_text([c for _, c in non_empty])
        except Exception as exc:
            logger.error("caption_embed_error", file=vf.filename, error=str(exc))
            return False

        # Persist FrameCaption rows and build Chroma upsert batch.
        # Upsert semantics: unique on (video_file_id, frame_index) — if a
        # file is re-captioned we overwrite the prior caption.
        existing = {
            (fc.video_file_id, fc.frame_index): fc
            for fc in session.query(FrameCaption).filter_by(video_file_id=vf.id).all()
        }

        chroma_ids: List[str] = []
        chroma_embs: List[List[float]] = []
        chroma_metas: List[dict] = []
        chroma_docs: List[str] = []

        for (orig_idx, caption_text), emb in zip(non_empty, embeddings):
            _, timestamp = frame_infos[orig_idx]
            chroma_id = f"{vf.id}_cap{orig_idx}"

            row = existing.get((vf.id, orig_idx))
            if row is None:
                row = FrameCaption(
                    video_file_id=vf.id,
                    frame_index=orig_idx,
                    timestamp=float(timestamp),
                    caption=caption_text,
                    captioner_model=model_name,
                    chroma_id=chroma_id,
                )
                session.add(row)
            else:
                row.caption = caption_text
                row.timestamp = float(timestamp)
                row.captioner_model = model_name
                row.chroma_id = chroma_id

            chroma_ids.append(chroma_id)
            chroma_embs.append(emb)
            chroma_docs.append(caption_text)
            chroma_metas.append({
                "video_file_id": str(vf.id),
                "frame_index": int(orig_idx),
                "timestamp": float(timestamp),
                "filename": str(vf.filename),
                "extension": str(vf.extension),
                "duration": float(vf.duration_seconds or 0.0),
                "project_tag": str(vf.project_tag or ""),
                "is_vertical": bool(vf.is_vertical),
                "width": int(vf.width or 0),
                "height": int(vf.height or 0),
                "captioner_model": str(model_name),
            })

        try:
            get_caption_store().upsert(chroma_ids, chroma_embs, chroma_metas, chroma_docs)
        except Exception as exc:
            logger.error("caption_upsert_error", file=vf.filename, error=str(exc))
            return False

    vf.captioned = True
    vf.updated_at = datetime.utcnow()
    session.flush()
    logger.info("caption_done", file=vf.filename, frames=len(chroma_ids), model=model_name)
    return True
