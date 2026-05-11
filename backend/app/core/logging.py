"""
Structured logging configuration using structlog.

When LOG_DIR is configured (portable mode or explicit setting), log output is
written to both stdout and a rotating file at LOG_DIR/footage_brain.log.
"""
from __future__ import annotations

import logging
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import IO, Optional

import structlog

from app.core.config import get_settings


class _TeeStream:
    """
    Write to multiple streams simultaneously.
    Used to mirror structlog output to both stdout and a log file without
    routing through stdlib logging (which would duplicate formatting).
    """

    def __init__(self, *streams: IO[str]) -> None:
        self._streams = streams

    def write(self, s: str) -> int:
        for stream in self._streams:
            stream.write(s)
        return len(s)

    def flush(self) -> None:
        for stream in self._streams:
            try:
                stream.flush()
            except Exception:
                pass


def configure_logging() -> None:
    settings = get_settings()
    log_level = getattr(logging, settings.log_level.upper(), logging.INFO)

    # ── Structlog output stream ───────────────────────────────────────────────
    if settings.log_dir:
        log_path = Path(settings.log_dir)
        log_path.mkdir(parents=True, exist_ok=True)
        log_file = open(log_path / "footage_brain.log", "a", encoding="utf-8")
        output_stream = _TeeStream(sys.stdout, log_file)
        logger_factory: structlog.types.WritableLogger = (
            structlog.WriteLoggerFactory(file=output_stream)  # type: ignore[arg-type]
        )
    else:
        logger_factory = structlog.PrintLoggerFactory()

    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.StackInfoRenderer(),
            structlog.dev.ConsoleRenderer()
            if settings.app_env == "development"
            else structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(log_level),
        context_class=dict,
        logger_factory=logger_factory,
        cache_logger_on_first_use=True,
    )

    # ── Stdlib logging (uvicorn, sqlalchemy, chromadb, etc.) ─────────────────
    stdlib_handlers: list[logging.Handler] = [
        logging.StreamHandler(sys.stdout)
    ]
    if settings.log_dir:
        stdlib_handlers.append(
            RotatingFileHandler(
                Path(settings.log_dir) / "footage_brain.log",
                maxBytes=10 * 1024 * 1024,   # 10 MB per file
                backupCount=5,
                encoding="utf-8",
            )
        )

    logging.basicConfig(
        format="%(message)s",
        handlers=stdlib_handlers,
        level=log_level,
        force=True,   # override any prior basicConfig call
    )


def get_logger(name: str = __name__) -> structlog.BoundLogger:
    return structlog.get_logger(name)
