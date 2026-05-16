"""
Dashboard API package.

Routes are grouped by concern across submodules — each submodule defines its
own un-prefixed APIRouter and is wired in below under the `/dashboard` prefix
so URL paths are identical to when this was a single dashboard.py file.

Files:
  stats.py     — overview stats card data
  jobs.py      — queue, pause/resume, skip/restore-stage, create-clip-embed
  streams.py   — multimodal reconcile + rebuild
  folders.py   — folder structure + per-folder coverage tree
  analytics.py — per-phase timing analytics
  settings.py  — app settings + persistent pipeline-stage toggles
"""
from fastapi import APIRouter

from app.api.dashboard import analytics, folders, jobs, settings, stats, streams

router = APIRouter(prefix="/dashboard", tags=["dashboard"])
router.include_router(stats.router)
router.include_router(jobs.router)
router.include_router(streams.router)
router.include_router(folders.router)
router.include_router(analytics.router)
router.include_router(settings.router)
