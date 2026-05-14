"""
Metadata stage: extract technical video metadata using ffprobe.
Populates VideoFile fields: duration, fps, resolution, codec, audio, etc.
Also extracts a representative thumbnail.
"""
from __future__ import annotations

import json
import math
import os
import subprocess
from datetime import datetime
from fractions import Fraction
from pathlib import Path
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.logging import get_logger
from app.db.models import VideoFile

logger = get_logger(__name__)


def _run_ffprobe(abs_path: str) -> Optional[Dict[str, Any]]:
    """Run ffprobe and return parsed JSON, or None on error."""
    cmd = [
        get_settings().ffprobe_exe,
        "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        abs_path,
    ]
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=60
        )
        if result.returncode != 0:
            logger.warning("ffprobe_nonzero", path=abs_path, stderr=result.stderr[:300])
            return None
        return json.loads(result.stdout)
    except subprocess.TimeoutExpired:
        logger.error("ffprobe_timeout", path=abs_path)
        return None
    except (json.JSONDecodeError, FileNotFoundError) as exc:
        logger.error("ffprobe_error", path=abs_path, error=str(exc))
        return None


def _parse_fps(fps_str: str) -> Optional[float]:
    """Parse fps from string like '30000/1001' or '29.97'."""
    try:
        if "/" in fps_str:
            f = Fraction(fps_str)
            return float(f)
        return float(fps_str)
    except (ValueError, ZeroDivisionError):
        return None


def _gcd_ratio(w: int, h: int) -> str:
    g = math.gcd(w, h)
    return f"{w // g}:{h // g}"


def extract_thumbnail(abs_path: str, file_id: str, duration: Optional[float]) -> Optional[str]:
    """
    Extract a single thumbnail frame at ~10% into the video.
    Saves to THUMBNAILS_DIR/<file_id>.jpg
    Returns the thumbnail path or None.
    """
    settings = get_settings()
    thumb_dir = Path(settings.thumbnails_dir)
    thumb_dir.mkdir(parents=True, exist_ok=True)
    thumb_path = thumb_dir / f"{file_id}.jpg"

    seek_time = 0.0
    if duration and duration > 5:
        seek_time = min(duration * 0.1, 30.0)  # 10% in, max 30s

    cmd = [
        get_settings().ffmpeg_exe,
        "-ss", str(seek_time),
        "-i", abs_path,
        "-vframes", "1",
        "-vf", "scale=320:-1",
        "-q:v", "3",
        "-y",
        str(thumb_path),
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, timeout=30)
        if result.returncode == 0 and thumb_path.exists():
            return str(thumb_path)
    except (subprocess.TimeoutExpired, FileNotFoundError) as exc:
        logger.warning("thumbnail_failed", path=abs_path, error=str(exc))
    return None


def extract_metadata(session: Session, vf: VideoFile) -> bool:
    """
    Run ffprobe on vf.abs_path, populate metadata fields, extract thumbnail.
    Returns True on success.
    """
    if vf.metadata_extracted:
        # Already extracted, skip
        logger.info("metadata_skip_already_done", file=vf.filename)
        return True
    
    probe = _run_ffprobe(vf.abs_path)
    if probe is None:
        return False

    streams = probe.get("streams", [])
    fmt = probe.get("format", {})

    video_stream: Optional[Dict] = None
    audio_stream: Optional[Dict] = None

    for s in streams:
        if s.get("codec_type") == "video" and video_stream is None:
            video_stream = s
        elif s.get("codec_type") == "audio" and audio_stream is None:
            audio_stream = s

    # Duration (prefer format-level)
    duration = None
    raw_dur = fmt.get("duration") or (video_stream or {}).get("duration")
    if raw_dur:
        try:
            duration = float(raw_dur)
        except ValueError:
            pass

    vf.duration_seconds = duration

    # Bit rate
    try:
        vf.bit_rate = int(fmt.get("bit_rate", 0)) or None
    except (ValueError, TypeError):
        vf.bit_rate = None

    if video_stream:
        vf.video_codec = video_stream.get("codec_name")
        vf.width = video_stream.get("width")
        vf.height = video_stream.get("height")
        vf.color_space = video_stream.get("color_space")

        fps_str = video_stream.get("r_frame_rate") or video_stream.get("avg_frame_rate")
        if fps_str:
            vf.fps = _parse_fps(fps_str)

        if vf.width and vf.height:
            vf.aspect_ratio = _gcd_ratio(vf.width, vf.height)
            vf.is_vertical = vf.height > vf.width

    if audio_stream:
        vf.audio_codec = audio_stream.get("codec_name")
        vf.has_audio = True
    else:
        vf.has_audio = False

    vf.metadata_extracted = True
    vf.updated_at = datetime.utcnow()

    # Extract thumbnail
    thumb = extract_thumbnail(vf.abs_path, vf.id, duration)
    if thumb:
        vf.thumbnail_path = thumb

    session.flush()
    logger.info("metadata_extracted", file=vf.filename, duration=duration)
    return True
