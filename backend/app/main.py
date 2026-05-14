"""
Footage Brain – FastAPI application entry point.
"""
from __future__ import annotations

import os
import signal
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.api import api_router
from app.core.config import get_settings
from app.core.logging import configure_logging, get_logger
from app.core.machine import check_machine_state
from app.db.session import init_db
from app.ingest.pipeline import get_pipeline_worker
from app.thermal.controller import create_thermal_controller

logger = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # ── Startup ──────────────────────────────────────────────────────────────
    configure_logging()
    settings = get_settings()
    settings.ensure_dirs()

    # Redirect HuggingFace / transformers model cache before any worker thread
    # loads a model.  All three vars must be set for full coverage across
    # faster-whisper, sentence-transformers, and transformers (CLIP).
    if settings.model_cache_dir:
        hf_base = str(Path(settings.model_cache_dir).resolve())
        os.environ.setdefault("HF_HOME", hf_base)
        os.environ.setdefault("HF_HUB_CACHE", str(Path(hf_base) / "hub"))
        os.environ.setdefault("TRANSFORMERS_CACHE", str(Path(hf_base) / "hub"))
        os.environ.setdefault("SENTENCE_TRANSFORMERS_HOME",
                              str(Path(hf_base) / "sentence-transformers"))
        logger.info("model_cache_redirected", path=hf_base)

    logger.info("startup", env=settings.app_env, db=settings.database_url)

    # Create DB tables
    init_db()

    # Detect machine/drive changes and warn about offline footage roots
    try:
        check_machine_state(settings)
    except Exception as exc:
        logger.warning("machine_check_failed", error=str(exc))

    # Reconcile multimodal stream flags vs actual artifacts. Catches files
    # marked "captioned" while the captioner was disabled, or files whose
    # transcript vectors were lost when the vector store was swapped. Cheap:
    # indexed SQL only, runs in milliseconds for libraries up to ~100k files.
    try:
        from app.db.session import get_db
        from app.ingest.reconcile import reconcile_streams
        with get_db() as session:
            reconcile_streams(session)
    except Exception as exc:
        logger.warning("reconcile_failed", error=str(exc))

    # Start background ingest worker
    worker = get_pipeline_worker()
    worker.start()

    # Start thermal controller (daemon thread — safe to fail)
    try:
        thermal = create_thermal_controller(worker)
        thermal.start()
        logger.info("thermal_controller_started")
    except Exception as exc:
        logger.warning("thermal_controller_init_failed", error=str(exc))
        thermal = None

    yield

    # ── Shutdown ─────────────────────────────────────────────────────────────
    logger.info("shutdown")
    if thermal is not None:
        try:
            thermal.stop()
        except Exception:
            pass
    worker.stop()


def create_app() -> FastAPI:
    settings = get_settings()

    app = FastAPI(
        title="Footage Brain",
        description="Local-first semantic video search and archive system",
        version="0.1.0",
        lifespan=lifespan,
        docs_url="/api/docs",
        redoc_url="/api/redoc",
        openapi_url="/api/openapi.json",
    )

    # CORS – allow local frontend dev server
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://localhost:5173",
            "http://localhost:3000",
            "http://127.0.0.1:5173",
            "http://127.0.0.1:3000",
        ],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Mount all API routes under /api
    app.include_router(api_router, prefix="/api")

    # Serve thumbnails/keyframes as static files
    thumb_dir = Path(settings.thumbnails_dir)
    thumb_dir.mkdir(parents=True, exist_ok=True)
    app.mount("/thumbnails", StaticFiles(directory=str(thumb_dir)), name="thumbnails")

    # Health check
    @app.get("/health")
    def health():
        return {"status": "ok", "service": "footage-brain"}

    # Production frontend — only active when `npm run build` has been run.
    # In dev mode the Vite dev server handles the frontend instead.
    dist_dir = Path(settings.frontend_dist)
    if dist_dir.exists() and (dist_dir / "index.html").exists():
        # Serve hashed JS/CSS/image assets with proper cache headers.
        assets_dir = dist_dir / "assets"
        if assets_dir.exists():
            app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="frontend-assets")

        @app.get("/", include_in_schema=False)
        def serve_root():
            return FileResponse(str(dist_dir / "index.html"))

        @app.get("/{full_path:path}", include_in_schema=False)
        def serve_spa(full_path: str):
            target = dist_dir / full_path
            if target.exists() and target.is_file():
                return FileResponse(str(target))
            return FileResponse(str(dist_dir / "index.html"))

    return app


app = create_app()


if __name__ == "__main__":
    import uvicorn

    settings = get_settings()
    uvicorn.run(
        "app.main:app",
        host=settings.app_host,
        port=settings.app_port,
        reload=settings.app_env == "development",
        log_level=settings.log_level.lower(),
    )
