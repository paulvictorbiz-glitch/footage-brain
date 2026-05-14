"""
API routes for duplicate group management.
"""
from __future__ import annotations

from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session, joinedload

from app.api.schemas import DuplicateGroupOut, SetCanonicalRequest, VideoFileOut
from app.db.models import DuplicateGroup, VideoFile
from app.db.session import get_db_session

router = APIRouter(prefix="/duplicates", tags=["duplicates"])


@router.get("", response_model=List[DuplicateGroupOut])
def list_duplicate_groups(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    session: Session = Depends(get_db_session),
):
    groups = (
        session.query(DuplicateGroup)
        .options(
            joinedload(DuplicateGroup.files)
        )
        .order_by(DuplicateGroup.created_at.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )

    result = []
    for g in groups:
        result.append(
            DuplicateGroupOut(
                id=g.id,
                sha256=g.sha256,
                canonical_file_id=g.canonical_file_id,
                file_count=len(g.files),
                files=[VideoFileOut.model_validate(f) for f in g.files],
            )
        )
    return result


@router.get("/{group_id}", response_model=DuplicateGroupOut)
def get_duplicate_group(group_id: str, session: Session = Depends(get_db_session)):
    g = (
        session.query(DuplicateGroup)
        .options(joinedload(DuplicateGroup.files))
        .filter_by(id=group_id)
        .first()
    )
    if not g:
        raise HTTPException(404, detail="Group not found")
    return DuplicateGroupOut(
        id=g.id,
        sha256=g.sha256,
        canonical_file_id=g.canonical_file_id,
        file_count=len(g.files),
        files=[VideoFileOut.model_validate(f) for f in g.files],
    )


@router.post("/{group_id}/set-canonical", response_model=DuplicateGroupOut)
def set_canonical(
    group_id: str,
    body: SetCanonicalRequest,
    session: Session = Depends(get_db_session),
):
    g = (
        session.query(DuplicateGroup)
        .options(joinedload(DuplicateGroup.files))
        .filter_by(id=group_id)
        .first()
    )
    if not g:
        raise HTTPException(404, detail="Group not found")

    # Unset all canonicals in group
    for f in g.files:
        f.is_canonical = False

    # Set the new canonical
    new_canon = session.get(VideoFile, body.file_id)
    if not new_canon or new_canon.duplicate_group_id != group_id:
        raise HTTPException(400, detail="File not in this group")

    new_canon.is_canonical = True
    g.canonical_file_id = new_canon.id
    session.flush()

    return DuplicateGroupOut(
        id=g.id,
        sha256=g.sha256,
        canonical_file_id=g.canonical_file_id,
        file_count=len(g.files),
        files=[VideoFileOut.model_validate(f) for f in g.files],
    )


@router.get("/stats/summary")
def duplicates_summary(session: Session = Depends(get_db_session)):
    total_groups = session.query(DuplicateGroup).count()
    total_dup_files = session.query(VideoFile).filter(VideoFile.duplicate_group_id.isnot(None)).count()
    from sqlalchemy import func
    wasted = (
        session.query(func.sum(VideoFile.file_size))
        .filter(VideoFile.duplicate_group_id.isnot(None), VideoFile.is_canonical == False)
        .scalar()
        or 0
    )
    return {
        "total_groups": total_groups,
        "total_duplicate_files": total_dup_files,
        "wasted_bytes": wasted,
    }
