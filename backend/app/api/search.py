"""
API routes for search.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.schemas import (
    ChunkMatchOut,
    FrameMatchOut,
    SearchRequest,
    SearchResponse,
    SearchResultOut,
)
from app.db.session import get_db_session
from app.search.engine import SearchFilters, search

router = APIRouter(prefix="/search", tags=["search"])


@router.post("", response_model=SearchResponse)
def run_search(body: SearchRequest, session: Session = Depends(get_db_session)):
    filters = SearchFilters(
        project_tag=body.project_tag,
        source_root_id=body.source_root_id,
        min_duration=body.min_duration,
        max_duration=body.max_duration,
        aspect_ratio=body.aspect_ratio,
        is_vertical=body.is_vertical,
        has_duplicates_only=body.has_duplicates_only,
        unique_only=body.unique_only,
        extension=body.extension,
        date_from=body.date_from,
        date_to=body.date_to,
    )

    results = search(
        session=session,
        query=body.query,
        mode=body.mode,
        filters=filters,
        n_results=body.n_results,
    )

    result_out = []
    for r in results:
        result_out.append(
            SearchResultOut(
                video_file_id=r.video_file_id,
                filename=r.filename,
                abs_path=r.abs_path,
                extension=r.extension,
                duration_seconds=r.duration_seconds,
                thumbnail_path=r.thumbnail_path,
                width=r.width,
                height=r.height,
                is_vertical=r.is_vertical,
                project_tag=r.project_tag,
                scan_root_id=r.scan_root_id,
                has_audio=r.has_audio,
                sha256=r.sha256,
                duplicate_group_id=r.duplicate_group_id,
                is_canonical=r.is_canonical,
                best_score=r.best_score,
                matched_chunks=[
                    ChunkMatchOut(
                        chunk_id=c.chunk_id,
                        start_time=c.start_time,
                        end_time=c.end_time,
                        text=c.text,
                        score=c.score,
                    )
                    for c in r.matched_chunks[:5]
                ],
                frame_matches=[
                    FrameMatchOut(
                        frame_id=f.frame_id,
                        timestamp=f.timestamp,
                        score=f.score,
                    )
                    for f in r.frame_matches[:3]
                ],
            )
        )

    return SearchResponse(
        query=body.query,
        mode=body.mode,
        total=len(result_out),
        results=result_out,
    )
