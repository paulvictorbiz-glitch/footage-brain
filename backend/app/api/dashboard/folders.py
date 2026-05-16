"""Folder structure + per-folder per-stage coverage tree."""
from __future__ import annotations

import os
from typing import Any, Dict, List

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.db.models import IngestJob, ScanRoot, VideoFile
from app.db.session import get_db_session
from app.ingest.stage_settings import TOGGLEABLE_STAGES, get_stage_toggles

router = APIRouter()


@router.get("/folders")
def get_folder_structure(session: Session = Depends(get_db_session)):
    roots = session.query(ScanRoot).filter_by(enabled=True).all()
    result = []
    for root in roots:
        files = session.query(VideoFile).filter_by(scan_root_id=root.id).all()
        folder_tree: Dict[str, Dict[str, Any]] = {}
        for file in files:
            rel = file.abs_path.replace(root.path, '').strip(os.sep)
            parts = rel.split(os.sep)
            folder_path = os.sep.join(parts[:-1])
            if folder_path not in folder_tree:
                folder_tree[folder_path] = {
                    "path": folder_path,
                    "file_count": 0,
                    "total_bytes": 0,
                    "total_duration": 0,
                }
            folder_tree[folder_path]["file_count"] += 1
            folder_tree[folder_path]["total_bytes"] += file.file_size or 0
            folder_tree[folder_path]["total_duration"] += file.duration_seconds or 0
        result.append({
            "root_id": root.id,
            "root_label": root.label or root.path,
            "root_path": root.path,
            "folders": list(folder_tree.values()),
        })
    return result


_COVERAGE_STAGES = ("metadata", "hash", "thumbnail", "transcript", "embed", "clip_embed", "caption")


@router.get("/coverage-tree")
def get_coverage_tree(session: Session = Depends(get_db_session)):
    """
    Per-scan-root folder tree where each folder has a per-stage completion
    breakdown. Used by the Coverage page to colour every folder by which
    phases are complete.

    For each (folder, stage):
      done    = jobs in 'done' for that stage on files under that folder
      total   = total file count for that folder

    Disabled stages are flagged via current pipeline_settings, so the UI can
    render their cells differently (dashed, "skipped" tag) instead of red.
    """
    toggles = get_stage_toggles()
    disabled_stages = [
        s for s in TOGGLEABLE_STAGES if not toggles.get(f"{s}_enabled", True)
    ]

    roots_q = session.query(ScanRoot).filter_by(enabled=True).all()
    result_roots: List[Dict[str, Any]] = []

    for root in roots_q:
        files = (
            session.query(VideoFile)
            .filter_by(scan_root_id=root.id)
            .all()
        )
        # Group files by folder relative to root.path
        folder_files: Dict[str, List[VideoFile]] = {}
        for f in files:
            try:
                rel = f.abs_path.replace(root.path, "").strip(os.sep)
            except Exception:
                rel = f.filename
            parts = rel.split(os.sep)
            folder = os.sep.join(parts[:-1]) if len(parts) > 1 else ""
            folder_files.setdefault(folder, []).append(f)

        # Get done + skipped job stage flags for the files we care about, in
        # bulk. Skipped is its own bucket so the UI can render those cells
        # distinctly ("intentionally not run" vs "still pending").
        if files:
            file_ids = [f.id for f in files]
            status_rows = (
                session.query(IngestJob.video_file_id, IngestJob.stage, IngestJob.status)
                .filter(
                    IngestJob.video_file_id.in_(file_ids),
                    IngestJob.status.in_(("done", "skipped")),
                    IngestJob.stage.in_(_COVERAGE_STAGES),
                )
                .all()
            )
        else:
            status_rows = []

        done_by_file: Dict[str, set] = {}
        skipped_by_file: Dict[str, set] = {}
        for fid, stage, status in status_rows:
            if status == "done":
                done_by_file.setdefault(fid, set()).add(stage)
            elif status == "skipped":
                skipped_by_file.setdefault(fid, set()).add(stage)

        folder_out = []
        for folder_path, group in sorted(folder_files.items()):
            stage_counts = {s: 0 for s in _COVERAGE_STAGES}
            skipped_counts = {s: 0 for s in _COVERAGE_STAGES}
            for vf in group:
                for s in done_by_file.get(vf.id, set()):
                    if s in stage_counts:
                        stage_counts[s] += 1
                for s in skipped_by_file.get(vf.id, set()):
                    if s in skipped_counts:
                        skipped_counts[s] += 1
            folder_out.append(
                {
                    "rel_path": folder_path,
                    "file_count": len(group),
                    "stage_counts": stage_counts,
                    "skipped_counts": skipped_counts,
                }
            )

        # Roll up root-level totals too.
        root_stage_counts = {s: 0 for s in _COVERAGE_STAGES}
        root_skipped_counts = {s: 0 for s in _COVERAGE_STAGES}
        for fo in folder_out:
            for s in _COVERAGE_STAGES:
                root_stage_counts[s] += fo["stage_counts"][s]
                root_skipped_counts[s] += fo["skipped_counts"][s]

        result_roots.append(
            {
                "root_id": root.id,
                "label": root.label or root.path,
                "path": root.path,
                "is_online": getattr(root, "is_online", True),
                "file_count": len(files),
                "stage_counts": root_stage_counts,
                "skipped_counts": root_skipped_counts,
                "folders": folder_out,
            }
        )

    return {
        "stages": list(_COVERAGE_STAGES),
        "disabled_stages": disabled_stages,
        "roots": result_roots,
    }
