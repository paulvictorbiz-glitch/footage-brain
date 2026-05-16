"""
Transcription stage: generate word-level timestamps using faster-whisper.
Produces raw segment list that is then passed to the chunker.
"""
from __future__ import annotations

import os
from datetime import datetime
from typing import List, Optional

from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.logging import get_logger
from app.db.models import VideoFile

logger = get_logger(__name__)

# Module-level model cache (one per process)
_whisper_model = None


def _get_model():
    global _whisper_model
    if _whisper_model is None:
        from faster_whisper import WhisperModel

        settings = get_settings()
        logger.info(
            "whisper_load",
            model=settings.whisper_model,
            device=settings.whisper_device,
            compute=settings.whisper_compute_type,
        )
        _whisper_model = WhisperModel(
            settings.whisper_model,
            device=settings.whisper_device,
            compute_type=settings.whisper_compute_type,
        )
    return _whisper_model


class Segment:
    __slots__ = ("start", "end", "text")

    def __init__(self, start: float, end: float, text: str):
        self.start = start
        self.end = end
        self.text = text.strip()


def transcribe_file(abs_path: str) -> Optional[List[Segment]]:
    """
    Run faster-whisper on the file.
    Returns list of Segment objects, or None on error.
    """
    if not os.path.exists(abs_path):
        logger.error("transcribe_missing_file", path=abs_path)
        return None

    try:
        model = _get_model()
        segments_iter, info = model.transcribe(
            abs_path,
            beam_size=5,
            word_timestamps=False,  # segment-level is sufficient for search
            vad_filter=True,         # skip silence
        )
        logger.info(
            "transcribe_start",
            path=abs_path,
            language=info.language,
            probability=f"{info.language_probability:.2f}",
        )
        segments = [Segment(s.start, s.end, s.text) for s in segments_iter]
        logger.info("transcribe_done", path=abs_path, segments=len(segments))
        return segments
    except Exception as exc:
        logger.error("transcribe_error", path=abs_path, error=str(exc))
        return None


def run_transcription(session: Session, vf: VideoFile) -> bool:
    """
    Transcribe vf if it has audio. Stores raw transcript flag.
    Actual chunking happens in chunker stage.
    Returns True if transcription produced results (or file has no audio).
    """
    if vf.transcribed:
        # Already transcribed, skip
        logger.info("transcribe_skip_already_done", file=vf.filename)
        return True
    
    if not vf.has_audio:
        logger.info("transcribe_skip_no_audio", file=vf.filename)
        vf.transcribed = True
        vf.updated_at = datetime.utcnow()
        session.flush()
        return True

    # Prefer the extracted sidecar audio when present (lets a small audio
    # file be transcribed on a remote/GPU box); abs_path stays the original
    # video location for "where is this clip".
    segments = transcribe_file(vf.audio_path or vf.abs_path)
    if segments is None:
        return False

    # Pass to chunker immediately
    from app.ingest.chunker import store_chunks

    store_chunks(session, vf, segments)

    vf.transcribed = True
    vf.updated_at = datetime.utcnow()
    session.flush()
    return True
