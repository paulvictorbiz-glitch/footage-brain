"""
VLM caption stage — third multimodal stream alongside Whisper transcripts and
CLIP frame embeddings.

For each sampled frame of a video:
  1. Run the configured VLM (BLIP / LLaVA / Qwen2-VL / SmolVLM) to generate
     a short natural-language description.
  2. Persist the caption to the `frame_captions` SQL table.
  3. Embed the caption text with the project's sentence-transformer so it
     lives in the same vector space as transcript chunks.
  4. Upsert the embedding into the `frame_captions` Chroma collection.

Adding this stream lets editors search by visible content using language even
when speech is absent — the kind of compositional prose ("two people arguing
in a kitchen") that CLIP's image embeddings struggle with.

Architecture and ownership notes:
  • Model loader (`_get_model`, `caption_images`) is lazy and laptop-aware:
    weights only fault in on first call, auto-detects CUDA/MPS/CPU, batched
    generation, model architecture inferred from CAPTIONER_MODEL id.
  • Stage handler (`caption_video`) is the entry point invoked by the
    pipeline worker. Idempotent — guards on vf.captioned. Returns False on
    hard errors, raises pipeline.StageSkip when frames can't be extracted
    (a "this file genuinely can't be captioned" signal that's distinct from
    "the captioner crashed").
  • When CAPTIONER_ENABLED=false the handler marks `captioned=True` and
    bails out cleanly — flip the env var on later and re-queue via the
    Dashboard's Rebuild button.

Earlier this file was split as `captioner.py` (loader) + `caption_embedder.py`
(stage handler); merged because the only caller of `caption_images` was
the stage handler living next to it. Sibling `clip_embedder.py` follows the
same one-file pattern.
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
from app.db.models import FrameCaption, VideoFile
from app.vector.store import get_caption_store

logger = get_logger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Model loader (lazy, process-singleton)
# ─────────────────────────────────────────────────────────────────────────────

_model = None
_processor = None
_device: Optional[str] = None
_kind: Optional[str] = None
_loaded_model_name: Optional[str] = None


def _resolve_device(preference: str) -> str:
    import torch
    pref = (preference or "auto").lower()
    if pref == "cpu":
        return "cpu"
    if pref == "cuda":
        return "cuda" if torch.cuda.is_available() else "cpu"
    if pref == "mps":
        return "mps" if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available() else "cpu"
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def _infer_kind(model_id: str) -> str:
    name = (model_id or "").lower()
    if "qwen2-vl" in name or "qwen2vl" in name:
        return "qwen2vl"
    if "llava" in name:
        return "llava"
    if "smolvlm" in name:
        return "smolvlm"
    return "blip"


def _get_model():
    global _model, _processor, _device, _kind, _loaded_model_name

    settings = get_settings()
    model_name = settings.captioner_model

    if _model is not None and _loaded_model_name == model_name:
        return _model, _processor, _device, _kind

    import torch
    from transformers import AutoProcessor

    _device = _resolve_device(settings.captioner_device)
    _kind = _infer_kind(model_name)
    logger.info("captioner_model_load", model=model_name, kind=_kind, device=_device)

    dtype = torch.float16 if _device in ("cuda", "mps") else torch.float32

    if _kind == "qwen2vl":
        from transformers import Qwen2VLForConditionalGeneration
        _model = Qwen2VLForConditionalGeneration.from_pretrained(model_name, torch_dtype=dtype)
    elif _kind == "llava":
        from transformers import LlavaForConditionalGeneration
        _model = LlavaForConditionalGeneration.from_pretrained(model_name, torch_dtype=dtype)
    elif _kind == "smolvlm":
        from transformers import AutoModelForVision2Seq
        _model = AutoModelForVision2Seq.from_pretrained(model_name, torch_dtype=dtype)
    else:
        from transformers import BlipForConditionalGeneration
        _model = BlipForConditionalGeneration.from_pretrained(model_name, torch_dtype=dtype)

    _processor = AutoProcessor.from_pretrained(model_name)
    _model = _model.to(_device)
    _model.eval()
    _loaded_model_name = model_name
    logger.info("captioner_model_ready", model=model_name, kind=_kind, device=_device, dtype=str(dtype))
    return _model, _processor, _device, _kind


def caption_images(images: List) -> List[str]:
    """
    Caption a batch of PIL Images. Returns one caption string per image.
    Returns empty strings on per-image failure rather than raising.
    """
    if not images:
        return []
    import torch

    settings = get_settings()
    model, processor, device, kind = _get_model()

    captions: List[str] = []
    batch_size = max(1, int(settings.captioner_batch_size))
    max_new_tokens = max(8, int(settings.captioner_max_new_tokens))

    for start in range(0, len(images), batch_size):
        batch = images[start : start + batch_size]
        try:
            if kind in ("qwen2vl", "llava", "smolvlm"):
                prompt = "Describe this video frame in one short sentence."
                messages_batch = [
                    [{"role": "user", "content": [{"type": "image"}, {"type": "text", "text": prompt}]}]
                    for _ in batch
                ]
                try:
                    chat_texts = [
                        processor.apply_chat_template(m, add_generation_prompt=True)
                        for m in messages_batch
                    ]
                except Exception:
                    chat_texts = [prompt] * len(batch)
                inputs = processor(text=chat_texts, images=list(batch), return_tensors="pt", padding=True)
                inputs = {k: v.to(device) for k, v in inputs.items()}
                with torch.no_grad():
                    out = model.generate(**inputs, max_new_tokens=max_new_tokens, do_sample=False)
                input_lens = inputs["input_ids"].shape[1]
                decoded = processor.batch_decode(out[:, input_lens:], skip_special_tokens=True)
            else:
                inputs = processor(images=batch, return_tensors="pt")
                inputs = {k: v.to(device) for k, v in inputs.items()}
                with torch.no_grad():
                    out = model.generate(
                        **inputs,
                        max_new_tokens=max_new_tokens,
                        num_beams=1,
                        do_sample=False,
                    )
                decoded = processor.batch_decode(out, skip_special_tokens=True)
            captions.extend(c.strip() for c in decoded)
        except Exception as exc:
            logger.error("captioner_batch_error", error=str(exc), batch_size=len(batch))
            captions.extend([""] * len(batch))

    return captions


# ─────────────────────────────────────────────────────────────────────────────
# Pipeline stage handler
# ─────────────────────────────────────────────────────────────────────────────


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
            # Tell the job runner this isn't a "done" — it's a skip. The
            # file genuinely had no extractable frames (very short clip,
            # codec issue, all-black, etc). Marking it 'done' would hide
            # that fact and the file would just silently never appear in
            # Visual/Caption search results.
            from app.ingest.pipeline import StageSkip
            logger.info("caption_no_frames", file=vf.filename)
            raise StageSkip("no_frames_extracted")

        # Caption all frames with the VLM
        try:
            from PIL import Image
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
