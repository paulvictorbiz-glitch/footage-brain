"""
Media serving routes.
- GET /media/thumbnail/{file_id}  – serve thumbnail image
- GET /media/stream/{file_id}     – range-request video streaming

These serve local files only; never upload to external services.
"""
from __future__ import annotations

import os
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy.orm import Session

from app.db.models import VideoFile
from app.db.session import get_db_session

router = APIRouter(prefix="/media", tags=["media"])

CHUNK_SIZE = 1024 * 1024  # 1 MB


@router.get("/thumbnail/{file_id}")
def serve_thumbnail(file_id: str, session: Session = Depends(get_db_session)):
    vf = session.get(VideoFile, file_id)
    if not vf:
        raise HTTPException(404, detail="File not found")
    if not vf.thumbnail_path or not Path(vf.thumbnail_path).exists():
        raise HTTPException(404, detail="Thumbnail not available")
    return FileResponse(vf.thumbnail_path, media_type="image/jpeg")


@router.get("/stream/{file_id}")
async def stream_video(
    file_id: str,
    request: Request,
    session: Session = Depends(get_db_session),
):
    """
    HTTP range-request video streaming for browser <video> tag.
    Supports seeking via Range header.
    """
    vf = session.get(VideoFile, file_id)
    if not vf:
        raise HTTPException(404, detail="File not found")

    path = Path(vf.abs_path)
    if not path.exists():
        raise HTTPException(404, detail="Video file not found on disk")

    file_size = path.stat().st_size
    range_header = request.headers.get("range")

    ext = path.suffix.lower()
    content_type_map = {
        ".mp4": "video/mp4",
        ".webm": "video/webm",
        ".mkv": "video/x-matroska",
        ".mov": "video/quicktime",
        ".avi": "video/x-msvideo",
        ".m4v": "video/mp4",
    }
    content_type = content_type_map.get(ext, "video/mp4")

    if range_header:
        # Parse Range: bytes=start-end
        range_val = range_header.replace("bytes=", "")
        parts = range_val.split("-")
        start = int(parts[0]) if parts[0] else 0
        end = int(parts[1]) if parts[1] else file_size - 1
        end = min(end, file_size - 1)
        length = end - start + 1

        def iter_file():
            with open(path, "rb") as f:
                f.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = f.read(min(CHUNK_SIZE, remaining))
                    if not chunk:
                        break
                    remaining -= len(chunk)
                    yield chunk

        headers = {
            "Content-Range": f"bytes {start}-{end}/{file_size}",
            "Accept-Ranges": "bytes",
            "Content-Length": str(length),
            "Content-Type": content_type,
        }
        return StreamingResponse(iter_file(), status_code=206, headers=headers)
    else:
        # No range — serve full file
        def iter_full():
            with open(path, "rb") as f:
                while True:
                    chunk = f.read(CHUNK_SIZE)
                    if not chunk:
                        break
                    yield chunk

        headers = {
            "Content-Length": str(file_size),
            "Accept-Ranges": "bytes",
            "Content-Type": content_type,
        }
        return StreamingResponse(iter_full(), status_code=200, headers=headers)
