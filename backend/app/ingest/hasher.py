"""
Hash stage: compute SHA256 of video file and group duplicates.

For large files we hash in chunks to avoid loading the whole file into memory.
After hashing, if another file with the same sha256 exists, we link them into
a DuplicateGroup.
"""
from __future__ import annotations

import hashlib
from datetime import datetime
from pathlib import Path
from typing import Optional

from sqlalchemy.orm import Session

from app.core.logging import get_logger
from app.db.models import DuplicateGroup, VideoFile

logger = get_logger(__name__)

CHUNK_SIZE = 8 * 1024 * 1024  # 8 MB


def compute_sha256(abs_path: str) -> Optional[str]:
    """Stream-hash a file with SHA256. Returns hex digest or None on error."""
    h = hashlib.sha256()
    try:
        with open(abs_path, "rb") as f:
            while True:
                chunk = f.read(CHUNK_SIZE)
                if not chunk:
                    break
                h.update(chunk)
        return h.hexdigest()
    except OSError as exc:
        logger.error("hash_read_error", path=abs_path, error=str(exc))
        return None


def hash_and_dedup(session: Session, vf: VideoFile) -> bool:
    """
    Compute SHA256 for vf, then:
    - Store hash on VideoFile
    - Find or create DuplicateGroup if another file shares the same hash
    Returns True on success.
    """
    if vf.hashed and vf.sha256:
        # Already hashed, skip
        logger.info("hash_skip_already_done", file=vf.filename, sha256=vf.sha256[:16])
        return True
    
    digest = compute_sha256(vf.abs_path)
    if digest is None:
        return False

    vf.sha256 = digest
    vf.hashed = True
    vf.updated_at = datetime.utcnow()
    session.flush()

    # Look for other files with the same hash
    same_hash = (
        session.query(VideoFile)
        .filter(VideoFile.sha256 == digest, VideoFile.id != vf.id)
        .all()
    )

    if not same_hash:
        # Unique hash — no group needed (may already be in a group from a prior run; keep it)
        logger.info("hash_unique", file=vf.filename, sha256=digest[:16])
        return True

    # Find existing group or create one
    group = session.query(DuplicateGroup).filter_by(sha256=digest).first()

    if group is None:
        group = DuplicateGroup(sha256=digest)
        session.add(group)
        session.flush()

        # Assign existing same-hash files to the group
        for other in same_hash:
            other.duplicate_group_id = group.id
            if other.is_canonical:
                group.canonical_file_id = other.id

    # Assign this file to the group
    vf.duplicate_group_id = group.id
    session.flush()

    # Auto-set canonical to the oldest file if none is set
    if group.canonical_file_id is None:
        all_in_group = (
            session.query(VideoFile)
            .filter_by(duplicate_group_id=group.id)
            .order_by(VideoFile.created_time)
            .all()
        )
        if all_in_group:
            all_in_group[0].is_canonical = True
            group.canonical_file_id = all_in_group[0].id

    session.flush()
    logger.info(
        "hash_deduped",
        file=vf.filename,
        sha256=digest[:16],
        group_id=group.id,
        group_size=len(same_hash) + 1,
    )
    return True
