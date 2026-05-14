"""
Chunker stage: group raw whisper segments into larger, overlapping chunks
suitable for embedding and search.

Strategy:
- Accumulate segments until MAX_CHUNK_WORDS words or MAX_CHUNK_SECONDS seconds
- Then emit a chunk and advance, keeping a small overlap window
"""
from __future__ import annotations

from datetime import datetime
from typing import List

from sqlalchemy.orm import Session

from app.core.logging import get_logger
from app.db.models import TranscriptChunk, VideoFile
from app.ingest.transcriber import Segment

logger = get_logger(__name__)

MAX_CHUNK_WORDS = 120
MAX_CHUNK_SECONDS = 45.0
OVERLAP_SEGMENTS = 1  # carry last N segments into next chunk


def _word_count(text: str) -> int:
    return len(text.split())


def chunk_segments(segments: List[Segment]) -> List[dict]:
    """
    Convert flat segment list into chunks with start/end timestamps.
    Returns list of dicts: {start, end, text, chunk_index}
    """
    chunks = []
    i = 0
    chunk_index = 0

    while i < len(segments):
        buffer: List[Segment] = []
        total_words = 0
        start_seg = segments[i]

        j = i
        while j < len(segments):
            seg = segments[j]
            seg_words = _word_count(seg.text)

            # Check if adding this segment exceeds limits
            span = seg.end - start_seg.start
            if buffer and (
                total_words + seg_words > MAX_CHUNK_WORDS or span > MAX_CHUNK_SECONDS
            ):
                break

            buffer.append(seg)
            total_words += seg_words
            j += 1

        if not buffer:
            # Safety: advance by 1 to avoid infinite loop
            i += 1
            continue

        combined_text = " ".join(s.text for s in buffer).strip()
        if combined_text:
            chunks.append({
                "chunk_index": chunk_index,
                "start_time": buffer[0].start,
                "end_time": buffer[-1].end,
                "text": combined_text,
            })
            chunk_index += 1

        # Advance with overlap
        i = max(i + 1, j - OVERLAP_SEGMENTS)

    return chunks


def store_chunks(session: Session, vf: VideoFile, segments: List[Segment]) -> int:
    """
    Delete existing chunks for this file, create new ones from segments.
    Returns number of chunks stored.
    """
    # Remove stale chunks
    session.query(TranscriptChunk).filter_by(video_file_id=vf.id).delete()
    session.flush()

    if not segments:
        logger.info("chunker_empty", file=vf.filename)
        return 0

    chunk_dicts = chunk_segments(segments)
    for c in chunk_dicts:
        chunk = TranscriptChunk(
            video_file_id=vf.id,
            chunk_index=c["chunk_index"],
            start_time=c["start_time"],
            end_time=c["end_time"],
            text=c["text"],
        )
        session.add(chunk)

    session.flush()
    logger.info("chunks_stored", file=vf.filename, count=len(chunk_dicts))
    return len(chunk_dicts)
