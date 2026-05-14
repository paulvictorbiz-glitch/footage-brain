"""
API routes for managing scan roots (source folders).
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.api.schemas import (
    RelinkRequest,
    RelinkResult,
    ScanRootCreate,
    ScanRootOut,
    ScanRootUpdate,
)
from app.core.logging import get_logger
from app.db.models import ScanRoot, VideoFile
from app.db.session import get_db_session
from app.ingest.pipeline import get_pipeline_worker
from app.ingest.scanner import scan_root as run_scan_root

router = APIRouter(prefix="/sources", tags=["sources"])
logger = get_logger(__name__)


def _root_out(root: ScanRoot, file_count: int) -> ScanRootOut:
    """Build a ScanRootOut, adding the live is_online check."""
    out = ScanRootOut.model_validate(root)
    out.file_count = file_count
    try:
        out.is_online = Path(root.path).exists()
    except OSError:
        out.is_online = False
    return out


@router.get("", response_model=List[ScanRootOut])
def list_sources(session: Session = Depends(get_db_session)):
    roots = session.query(ScanRoot).order_by(ScanRoot.created_at).all()
    result = []
    for r in roots:
        count = session.query(VideoFile).filter_by(scan_root_id=r.id).count()
        result.append(_root_out(r, count))
    return result


@router.get("/{root_id}", response_model=ScanRootOut)
def get_source(root_id: str, session: Session = Depends(get_db_session)):
    root = session.get(ScanRoot, root_id)
    if not root:
        raise HTTPException(404, detail="Source not found")
    count = session.query(VideoFile).filter_by(scan_root_id=root.id).count()
    return _root_out(root, count)


@router.post("", response_model=ScanRootOut, status_code=201)
def add_source(body: ScanRootCreate, session: Session = Depends(get_db_session)):
    path = os.path.normpath(body.path)
    existing = session.query(ScanRoot).filter_by(path=path).first()
    if existing:
        raise HTTPException(400, detail="Source path already exists")

    root = ScanRoot(path=path, label=body.label, recursive=body.recursive)
    session.add(root)
    session.flush()
    return _root_out(root, 0)


@router.patch("/{root_id}", response_model=ScanRootOut)
def update_source(
    root_id: str,
    body: ScanRootUpdate,
    session: Session = Depends(get_db_session),
):
    root = session.get(ScanRoot, root_id)
    if not root:
        raise HTTPException(404, detail="Source not found")
    if body.label is not None:
        root.label = body.label
    if body.enabled is not None:
        root.enabled = body.enabled
    if body.recursive is not None:
        root.recursive = body.recursive
    session.flush()
    count = session.query(VideoFile).filter_by(scan_root_id=root.id).count()
    return _root_out(root, count)


@router.delete("/{root_id}", status_code=204)
def delete_source(root_id: str, session: Session = Depends(get_db_session)):
    root = session.get(ScanRoot, root_id)
    if not root:
        raise HTTPException(404, detail="Source not found")
    session.delete(root)


@router.post("/{root_id}/scan")
def trigger_scan(root_id: str, session: Session = Depends(get_db_session)):
    root = session.get(ScanRoot, root_id)
    if not root:
        raise HTTPException(404, detail="Source not found")
    summary = run_scan_root(session, root)
    get_pipeline_worker().start()
    return {"status": "ok", "summary": summary}


@router.post("/scan-all")
def trigger_scan_all(session: Session = Depends(get_db_session)):
    from app.ingest.scanner import scan_all_roots
    summaries = scan_all_roots(session)
    get_pipeline_worker().start()
    return {"status": "ok", "summaries": summaries}


@router.post("/{root_id}/relink", response_model=RelinkResult)
def relink_source(
    root_id: str,
    body: RelinkRequest,
    session: Session = Depends(get_db_session),
):
    """
    Repoint a scan root to a new directory path and bulk-update every
    video_file.abs_path that sits under the old root.

    Pipeline state (transcribed, embedded, etc.) and all metadata are
    preserved — only the path prefix is rewritten.

    Use dry_run=true to preview how many records would change without
    committing anything.
    """
    root = session.get(ScanRoot, root_id)
    if not root:
        raise HTTPException(404, detail="Source not found")

    old_prefix: str = root.path
    new_prefix: str = os.path.normpath(body.new_path)

    if old_prefix == new_prefix:
        raise HTTPException(400, detail="new_path is identical to the current path")

    if not body.dry_run and not Path(new_prefix).exists():
        raise HTTPException(
            400,
            detail=f"New path does not exist on disk: {new_prefix}",
        )

    # ── Gather files under this root ─────────────────────────────────────────
    files: list[VideoFile] = (
        session.query(VideoFile)
        .filter_by(scan_root_id=root_id)
        .all()
    )

    sep = os.sep
    path_changes: list[tuple[VideoFile, str]] = []
    unmatched: int = 0

    for vf in files:
        # A file belongs to this root if its abs_path starts with the root
        # followed by a separator (handles E:\Footage vs E:\FootageExtra).
        if vf.abs_path == old_prefix or vf.abs_path.startswith(old_prefix + sep):
            new_abs = new_prefix + vf.abs_path[len(old_prefix):]
            path_changes.append((vf, new_abs))
        else:
            unmatched += 1
            logger.warning(
                "relink_path_mismatch",
                file_id=vf.id,
                abs_path=vf.abs_path,
                expected_prefix=old_prefix,
            )

    # ── Collision check ───────────────────────────────────────────────────────
    # Guard against new paths that already exist in records from OTHER roots.
    if path_changes:
        new_paths = [new_abs for _, new_abs in path_changes]
        conflicts = (
            session.query(VideoFile.abs_path)
            .filter(
                VideoFile.abs_path.in_(new_paths),
                VideoFile.scan_root_id != root_id,
            )
            .all()
        )
        if conflicts:
            examples = [c.abs_path for c in conflicts[:5]]
            raise HTTPException(
                409,
                detail=(
                    f"{len(conflicts)} target path(s) already exist in records "
                    f"from a different scan root. Resolve conflicts before relinking. "
                    f"Examples: {examples}"
                ),
            )

    if body.dry_run:
        logger.info(
            "relink_dry_run",
            root_id=root_id,
            old=old_prefix,
            new=new_prefix,
            would_remap=len(path_changes),
            unmatched=unmatched,
        )
        return RelinkResult(
            old_path=old_prefix,
            new_path=new_prefix,
            remapped=len(path_changes),
            unmatched=unmatched,
            dry_run=True,
        )

    # ── Apply updates (single transaction via get_db_session) ─────────────────
    for vf, new_abs in path_changes:
        vf.abs_path = new_abs

    root.path = new_prefix
    session.flush()

    logger.info(
        "relink_complete",
        root_id=root_id,
        old=old_prefix,
        new=new_prefix,
        remapped=len(path_changes),
        unmatched=unmatched,
    )

    return RelinkResult(
        old_path=old_prefix,
        new_path=new_prefix,
        remapped=len(path_changes),
        unmatched=unmatched,
        dry_run=False,
    )
