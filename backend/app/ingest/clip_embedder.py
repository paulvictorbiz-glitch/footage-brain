"""
CLIP visual frame embedding stage.

Extracts frames from video with ffmpeg, embeds each frame using
openai/clip-vit-large-patch14, and stores vectors in the 'frame_embeddings'
Chroma collection for visual similarity search.
"""
from __future__ import annotations

import os
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path
from typing import List, Optional, Tuple

from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.logging import get_logger
from app.db.models import VideoFile
from app.vector.store import get_frame_store

logger = get_logger(__name__)

_clip_model = None
_clip_processor = None


def _get_clip_model():
    global _clip_model, _clip_processor
    if _clip_model is None:
        import torch
        from transformers import CLIPModel, CLIPProcessor

        model_name = "openai/clip-vit-large-patch14"
        logger.info("clip_model_load", model=model_name)
        device = "cuda" if torch.cuda.is_available() else "cpu"
        _clip_model = CLIPModel.from_pretrained(model_name)
        _clip_model = _clip_model.to(device)
        _clip_model.eval()
        _clip_processor = CLIPProcessor.from_pretrained(model_name)
        logger.info("clip_model_ready", device=device)
    return _clip_model, _clip_processor


def embed_frames_clip(images) -> List[List[float]]:
    """Embed a list of PIL Images with CLIP, return normalized float vectors."""
    import torch
    model, processor = _get_clip_model()
    device = next(model.parameters()).device
    inputs = processor(images=images, return_tensors="pt", padding=True).to(device)
    with torch.no_grad():
        feats = model.get_image_features(**inputs)
        feats = feats / feats.norm(p=2, dim=-1, keepdim=True)
    return feats.cpu().tolist()


def embed_text_clip(texts: List[str]) -> List[List[float]]:
    """Embed text queries with CLIP's text encoder, return normalized vectors."""
    import torch
    model, processor = _get_clip_model()
    device = next(model.parameters()).device
    inputs = processor(
        text=texts, return_tensors="pt", padding=True, truncation=True, max_length=77
    ).to(device)
    with torch.no_grad():
        feats = model.get_text_features(**inputs)
        feats = feats / feats.norm(p=2, dim=-1, keepdim=True)
    return feats.cpu().tolist()


def _extract_frames(abs_path: str, interval: int, tmpdir: str) -> List[Tuple[str, float]]:
    """Extract frames at fixed interval into tmpdir. Returns [(path, timestamp), ...]."""
    out_pattern = os.path.join(tmpdir, "frame_%06d.jpg")
    cmd = [
        get_settings().ffmpeg_exe,
        "-i", abs_path,
        "-vf", f"fps=1/{interval},scale=512:-1",
        "-q:v", "2",
        "-frame_pts", "1",
        out_pattern,
        "-y",
    ]
    try:
        subprocess.run(cmd, capture_output=True, timeout=300, check=False)
    except (subprocess.TimeoutExpired, FileNotFoundError) as exc:
        logger.error("clip_frame_extract_error", path=abs_path, error=str(exc))
        return []

    frames = sorted(Path(tmpdir).glob("frame_*.jpg"))
    return [(str(f), float(i * interval)) for i, f in enumerate(frames)]


def clip_embed_video(session: Session, vf: VideoFile) -> bool:
    if vf.clip_embedded:
        return True

    if not vf.duration_seconds or vf.duration_seconds < 1:
        vf.clip_embedded = True
        vf.updated_at = datetime.utcnow()
        session.flush()
        return True

    settings = get_settings()
    interval = settings.frame_sample_interval

    with tempfile.TemporaryDirectory(prefix="clip_embed_") as tmpdir:
        frame_infos = _extract_frames(vf.abs_path, interval, tmpdir)

        if not frame_infos:
            logger.info("clip_embed_no_frames", file=vf.filename)
            vf.clip_embedded = True
            vf.updated_at = datetime.utcnow()
            session.flush()
            return True

        store = get_frame_store()
        ids: List[str] = []
        embeddings: List[List[float]] = []
        metadatas = []
        documents: List[str] = []

        BATCH = 8
        for batch_start in range(0, len(frame_infos), BATCH):
            batch = frame_infos[batch_start : batch_start + BATCH]
            try:
                from PIL import Image
                images = [Image.open(p).convert("RGB") for p, _ in batch]
                embs = embed_frames_clip(images)
            except Exception as exc:
                logger.error("clip_embed_batch_error", file=vf.filename, error=str(exc))
                continue

            for i, emb in enumerate(embs):
                frame_idx = batch_start + i
                _, timestamp = batch[i]
                frame_id = f"{vf.id}_f{frame_idx}"
                ids.append(frame_id)
                embeddings.append(emb)
                metadatas.append({
                    "video_file_id": str(vf.id),
                    "frame_index": int(frame_idx),
                    "timestamp": float(timestamp),
                    "filename": str(vf.filename),
                    "extension": str(vf.extension),
                    "duration": float(vf.duration_seconds or 0.0),
                    "project_tag": str(vf.project_tag or ""),
                    "is_vertical": bool(vf.is_vertical),
                    "width": int(vf.width or 0),
                    "height": int(vf.height or 0),
                })
                documents.append(f"{vf.filename} @ {timestamp:.0f}s")

        if ids:
            try:
                store.upsert(ids, embeddings, metadatas, documents)
            except Exception as exc:
                logger.error("clip_embed_upsert_error", file=vf.filename, error=str(exc))
                return False

    vf.clip_embedded = True
    vf.updated_at = datetime.utcnow()
    session.flush()
    logger.info("clip_embed_done", file=vf.filename, frames=len(ids))
    return True
