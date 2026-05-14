from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.logging import get_logger
from app.db.models import TranscriptChunk, VideoFile
from app.vector.store import get_vector_store

logger = get_logger(__name__)

_embed_model = None


def _get_embed_model():
    global _embed_model
    if _embed_model is None:
        from sentence_transformers import SentenceTransformer
        settings = get_settings()
        logger.info("embed_model_load", model=settings.embed_model)
        _embed_model = SentenceTransformer(settings.embed_model)
    return _embed_model


def embed_text(texts: List[str]) -> List[List[float]]:
    model = _get_embed_model()
    embeddings = model.encode(texts, batch_size=32, show_progress_bar=False, normalize_embeddings=True)
    return embeddings.tolist()


def embed_video_chunks(session: Session, vf: VideoFile) -> bool:
    if vf.embedded:
        # Already embedded, skip
        logger.info("embed_skip_already_done", file=vf.filename)
        return True
    
    chunks: List[TranscriptChunk] = (
        session.query(TranscriptChunk)
        .filter_by(video_file_id=vf.id)
        .order_by(TranscriptChunk.chunk_index)
        .all()
    )

    if not chunks:
        logger.info("embed_skip_no_chunks", file=vf.filename)
        vf.embedded = True
        vf.updated_at = datetime.utcnow()
        session.flush()
        return True

    texts = [c.text for c in chunks]
    chunk_ids = [c.id for c in chunks]
    chunk_indices = [c.chunk_index for c in chunks]
    chunk_starts = [c.start_time for c in chunks]
    chunk_ends = [c.end_time for c in chunks]

    try:
        embeddings = embed_text(texts)
    except Exception as exc:
        logger.error("embed_error", file=vf.filename, error=str(exc))
        return False

    store = get_vector_store()

    ids = []
    metas = []
    docs = []
    embs = []

    for idx, emb in enumerate(embeddings):
        chunk_id = f"{vf.id}_{chunk_indices[idx]}"
        ids.append(chunk_id)
        embs.append(emb)
        docs.append(texts[idx])
        metas.append({
            "video_file_id": str(vf.id),
            "chunk_index": int(chunk_indices[idx]),
            "start_time": float(chunk_starts[idx]),
            "end_time": float(chunk_ends[idx]),
            "filename": str(vf.filename),
            "extension": str(vf.extension),
            "duration": float(vf.duration_seconds or 0.0),
            "project_tag": str(vf.project_tag or ""),
            "has_audio": bool(vf.has_audio),
            "is_vertical": bool(vf.is_vertical),
            "width": int(vf.width or 0),
            "height": int(vf.height or 0),
        })

    try:
        store.upsert(ids, embs, metas, docs)
    except Exception as exc:
        logger.error("embed_upsert_error", file=vf.filename, error=str(exc))
        return False

    for idx, chunk_db_id in enumerate(chunk_ids):
        chunk = session.get(TranscriptChunk, chunk_db_id)
        if chunk:
            chunk.chroma_id = f"{vf.id}_{chunk_indices[idx]}"

    vf.embedded = True
    vf.updated_at = datetime.utcnow()
    session.flush()

    logger.info("embed_done", file=vf.filename, chunks=len(chunks))
    return True