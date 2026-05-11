"""
Search engine.

Supports:
  1. Semantic search  – embed query → vector search → join SQL metadata
  2. Keyword search   – SQL LIKE over transcript chunks + filenames
  3. Metadata filters – duration, project, source, aspect ratio, date, duplicate

Results are returned as SearchResult objects with file + chunk context.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Optional

from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session

from app.core.logging import get_logger
from app.db.models import DuplicateGroup, ScanRoot, TranscriptChunk, VideoFile
from app.vector.store import get_vector_store

logger = get_logger(__name__)


@dataclass
class SearchFilters:
    project_tag: Optional[str] = None
    source_root_id: Optional[str] = None
    min_duration: Optional[float] = None
    max_duration: Optional[float] = None
    aspect_ratio: Optional[str] = None          # "16:9", "9:16", "1:1", etc.
    is_vertical: Optional[bool] = None
    has_duplicates_only: bool = False
    unique_only: bool = False
    extension: Optional[str] = None
    date_from: Optional[datetime] = None
    date_to: Optional[datetime] = None


@dataclass
class ChunkMatch:
    chunk_id: str
    start_time: float
    end_time: float
    text: str
    score: float


@dataclass
class FrameMatch:
    frame_id: str
    timestamp: float
    score: float


@dataclass
class SearchResult:
    video_file_id: str
    filename: str
    abs_path: str
    extension: str
    duration_seconds: Optional[float]
    thumbnail_path: Optional[str]
    width: Optional[int]
    height: Optional[int]
    is_vertical: bool
    project_tag: Optional[str]
    scan_root_id: Optional[str]
    has_audio: bool
    sha256: Optional[str]
    duplicate_group_id: Optional[str]
    is_canonical: bool
    best_score: float
    matched_chunks: List[ChunkMatch] = field(default_factory=list)
    frame_matches: List[FrameMatch] = field(default_factory=list)


def _apply_filters(query, filters: SearchFilters):
    """Apply SearchFilters to a SQLAlchemy query on VideoFile."""
    if filters.project_tag:
        query = query.filter(VideoFile.project_tag == filters.project_tag)
    if filters.source_root_id:
        query = query.filter(VideoFile.scan_root_id == filters.source_root_id)
    if filters.min_duration is not None:
        query = query.filter(VideoFile.duration_seconds >= filters.min_duration)
    if filters.max_duration is not None:
        query = query.filter(VideoFile.duration_seconds <= filters.max_duration)
    if filters.aspect_ratio:
        query = query.filter(VideoFile.aspect_ratio == filters.aspect_ratio)
    if filters.is_vertical is not None:
        query = query.filter(VideoFile.is_vertical == filters.is_vertical)
    if filters.has_duplicates_only:
        query = query.filter(VideoFile.duplicate_group_id.isnot(None))
    if filters.unique_only:
        query = query.filter(VideoFile.duplicate_group_id.is_(None))
    if filters.extension:
        query = query.filter(VideoFile.extension == filters.extension.lower())
    if filters.date_from:
        query = query.filter(VideoFile.created_time >= filters.date_from)
    if filters.date_to:
        query = query.filter(VideoFile.created_time <= filters.date_to)
    return query


def _vf_to_result(vf: VideoFile, score: float = 0.0, chunks: Optional[List[ChunkMatch]] = None) -> SearchResult:
    return SearchResult(
        video_file_id=vf.id,
        filename=vf.filename,
        abs_path=vf.abs_path,
        extension=vf.extension,
        duration_seconds=vf.duration_seconds,
        thumbnail_path=vf.thumbnail_path,
        width=vf.width,
        height=vf.height,
        is_vertical=vf.is_vertical,
        project_tag=vf.project_tag,
        scan_root_id=vf.scan_root_id,
        has_audio=vf.has_audio,
        sha256=vf.sha256,
        duplicate_group_id=vf.duplicate_group_id,
        is_canonical=vf.is_canonical,
        best_score=score,
        matched_chunks=chunks or [],
    )


# ─────────────────────────────────────────────────────────────────────────────
# Semantic search
# ─────────────────────────────────────────────────────────────────────────────

def semantic_search(
    session: Session,
    query: str,
    filters: SearchFilters,
    n_results: int = 30,
    min_score: float = 0.25,
) -> List[SearchResult]:
    """
    Embed the query, search Chroma, then join with SQL metadata + apply filters.
    """
    from app.ingest.embedder import embed_text

    try:
        query_emb = embed_text([query])[0]
    except Exception as exc:
        logger.error("embed_query_error", error=str(exc))
        return []

    store = get_vector_store()
    hits = store.query(query_emb, n_results=n_results * 3)  # over-fetch for post-filter

    if not hits:
        return []

    # Group hits by video_file_id, keep best score per file
    file_hits: Dict[str, list] = {}
    for h in hits:
        meta = h.get("metadata", {})
        fid = meta.get("video_file_id")
        if not fid:
            continue
        if fid not in file_hits:
            file_hits[fid] = []
        file_hits[fid].append(h)

    if not file_hits:
        return []

    # Fetch VideoFile rows for matched IDs
    vf_map: Dict[str, VideoFile] = {}
    for vf in session.query(VideoFile).filter(VideoFile.id.in_(list(file_hits.keys()))).all():
        vf_map[vf.id] = vf

    # Apply SQL filters
    filtered_ids = _apply_filters(
        session.query(VideoFile.id).filter(VideoFile.id.in_(list(file_hits.keys()))),
        filters,
    ).all()
    allowed_ids = {row[0] for row in filtered_ids}

    results = []
    for fid, file_chunks in file_hits.items():
        if fid not in allowed_ids:
            continue
        vf = vf_map.get(fid)
        if not vf:
            continue

        best_score = max(h["score"] for h in file_chunks)
        if best_score < min_score:
            continue

        # Build chunk matches
        chunk_matches = []
        for h in sorted(file_chunks, key=lambda x: -x["score"]):
            meta = h["metadata"]
            chunk_matches.append(ChunkMatch(
                chunk_id=h["chroma_id"],
                start_time=meta.get("start_time", 0),
                end_time=meta.get("end_time", 0),
                text=h.get("document", ""),
                score=h["score"],
            ))

        result = _vf_to_result(vf, best_score, chunk_matches)
        results.append(result)

    results.sort(key=lambda r: -r.best_score)
    return results[:n_results]


# ─────────────────────────────────────────────────────────────────────────────
# Keyword search
# ─────────────────────────────────────────────────────────────────────────────

def keyword_search(
    session: Session,
    query: str,
    filters: SearchFilters,
    n_results: int = 30,
) -> List[SearchResult]:
    """
    SQL LIKE search over transcript text and filenames.
    """
    terms = [t.strip() for t in query.split() if t.strip()]
    if not terms:
        return []

    # Search transcript chunks
    chunk_query = session.query(TranscriptChunk).join(
        VideoFile, TranscriptChunk.video_file_id == VideoFile.id
    )

    # Text match (all terms must appear)
    for term in terms:
        chunk_query = chunk_query.filter(
            TranscriptChunk.text.ilike(f"%{term}%")
        )

    chunk_query = _apply_filters(
        chunk_query.with_entities(
            TranscriptChunk,
            VideoFile,
        ),
        filters,
    )

    # Also search filenames
    fn_query = _apply_filters(session.query(VideoFile), filters)
    fn_conditions = [VideoFile.filename.ilike(f"%{t}%") for t in terms]
    fn_query = fn_query.filter(or_(*fn_conditions))

    file_chunks: Dict[str, List[TranscriptChunk]] = {}
    file_map: Dict[str, VideoFile] = {}

    for chunk, vf in chunk_query.limit(200).all():
        if chunk.video_file_id not in file_chunks:
            file_chunks[chunk.video_file_id] = []
            file_map[chunk.video_file_id] = vf
        file_chunks[chunk.video_file_id].append(chunk)

    # Add filename matches
    for vf in fn_query.limit(50).all():
        if vf.id not in file_map:
            file_map[vf.id] = vf

    results = []
    for fid, vf in file_map.items():
        chunks_for_file = file_chunks.get(fid, [])
        matched_chunks = [
            ChunkMatch(
                chunk_id=c.chroma_id or c.id,
                start_time=c.start_time,
                end_time=c.end_time,
                text=c.text,
                score=0.8,  # keyword match has fixed score
            )
            for c in chunks_for_file
        ]
        results.append(_vf_to_result(vf, 0.8 if matched_chunks else 0.5, matched_chunks))

    results.sort(key=lambda r: -r.best_score)
    return results[:n_results]


# ─────────────────────────────────────────────────────────────────────────────
# Visual search (CLIP frame embeddings)
# ─────────────────────────────────────────────────────────────────────────────

def visual_search(
    session: Session,
    query: str,
    filters: SearchFilters,
    n_results: int = 30,
    min_score: float = 0.20,
) -> List[SearchResult]:
    """
    Encode the text query with CLIP's text encoder, search the frame_embeddings
    Chroma collection, and return files with matched frame timestamps.
    """
    from app.ingest.clip_embedder import embed_text_clip
    from app.vector.store import get_frame_store

    try:
        query_emb = embed_text_clip([query])[0]
    except Exception as exc:
        logger.error("clip_text_query_error", error=str(exc))
        return []

    store = get_frame_store()
    if store.count() == 0:
        return []

    hits = store.query(query_emb, n_results=n_results * 10)
    if not hits:
        return []

    # Group hits by video_file_id
    file_frames: Dict[str, list] = {}
    for h in hits:
        meta = h.get("metadata", {})
        fid = meta.get("video_file_id")
        if not fid:
            continue
        if fid not in file_frames:
            file_frames[fid] = []
        file_frames[fid].append(h)

    if not file_frames:
        return []

    vf_map: Dict[str, VideoFile] = {}
    for vf in session.query(VideoFile).filter(VideoFile.id.in_(list(file_frames.keys()))).all():
        vf_map[vf.id] = vf

    filtered_ids = _apply_filters(
        session.query(VideoFile.id).filter(VideoFile.id.in_(list(file_frames.keys()))),
        filters,
    ).all()
    allowed_ids = {row[0] for row in filtered_ids}

    results = []
    for fid, frames in file_frames.items():
        if fid not in allowed_ids:
            continue
        vf = vf_map.get(fid)
        if not vf:
            continue

        best_score = max(h["score"] for h in frames)
        if best_score < min_score:
            continue

        top_frames = sorted(frames, key=lambda x: -x["score"])[:5]
        frame_matches = [
            FrameMatch(
                frame_id=h["chroma_id"],
                timestamp=h["metadata"].get("timestamp", 0.0),
                score=h["score"],
            )
            for h in top_frames
        ]

        result = _vf_to_result(vf, best_score)
        result.frame_matches = frame_matches
        results.append(result)

    results.sort(key=lambda r: -r.best_score)
    return results[:n_results]


# ─────────────────────────────────────────────────────────────────────────────
# Combined search entry point
# ─────────────────────────────────────────────────────────────────────────────

def search(
    session: Session,
    query: str,
    mode: str = "semantic",  # "semantic" | "keyword" | "hybrid" | "visual"
    filters: Optional[SearchFilters] = None,
    n_results: int = 30,
) -> List[SearchResult]:
    if filters is None:
        filters = SearchFilters()

    if not query.strip():
        # No query — return filtered browse results
        return browse(session, filters, n_results)

    if mode == "keyword":
        return keyword_search(session, query, filters, n_results)
    elif mode == "hybrid":
        sem = semantic_search(session, query, filters, n_results)
        kw = keyword_search(session, query, filters, n_results)
        # Merge: deduplicate, prefer higher score
        merged: Dict[str, SearchResult] = {}
        for r in sem + kw:
            existing = merged.get(r.video_file_id)
            if existing is None or r.best_score > existing.best_score:
                merged[r.video_file_id] = r
        combined = sorted(merged.values(), key=lambda r: -r.best_score)
        return combined[:n_results]
    elif mode == "visual":
        return visual_search(session, query, filters, n_results)
    else:
        return semantic_search(session, query, filters, n_results)


def browse(
    session: Session,
    filters: SearchFilters,
    n_results: int = 50,
    offset: int = 0,
) -> List[SearchResult]:
    """Browse without a text query — pure metadata filter + sort by date."""
    q = _apply_filters(session.query(VideoFile), filters)
    q = q.order_by(VideoFile.created_time.desc().nullslast())
    vfs = q.offset(offset).limit(n_results).all()
    return [_vf_to_result(vf, 0.0) for vf in vfs]
