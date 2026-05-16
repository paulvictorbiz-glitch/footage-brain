"""
Database engine, session factory, and helper utilities.
Supports SQLite (default) and Postgres via DATABASE_URL.
"""
from __future__ import annotations

from contextlib import contextmanager
from typing import Generator

from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import get_settings
from app.db.models import Base


def _get_engine():
    settings = get_settings()
    url = settings.database_url

    kwargs: dict = {}
    if url.startswith("sqlite"):
        # SQLite-specific: enable WAL mode and foreign keys
        kwargs["connect_args"] = {"check_same_thread": False}

    engine = create_engine(url, echo=False, **kwargs)

    if url.startswith("sqlite"):
        @event.listens_for(engine, "connect")
        def set_sqlite_pragma(dbapi_conn, _):
            cursor = dbapi_conn.cursor()
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.execute("PRAGMA synchronous=NORMAL")
            cursor.close()

    return engine


_engine = None
_SessionLocal = None


def get_engine():
    global _engine
    if _engine is None:
        _engine = _get_engine()
    return _engine


def get_session_factory():
    global _SessionLocal
    if _SessionLocal is None:
        _SessionLocal = sessionmaker(bind=get_engine(), autocommit=False, autoflush=False)
    return _SessionLocal


def init_db() -> None:
    """Create all tables. Called on startup."""
    Base.metadata.create_all(bind=get_engine())
    _migrate_db()


def _migrate_db() -> None:
    """Add new columns to existing tables (idempotent)."""
    from sqlalchemy import text
    new_columns = [
        ("video_files", "clip_embedded", "BOOLEAN DEFAULT 0"),
        ("video_files", "captioned", "BOOLEAN DEFAULT 0"),
        ("video_files", "audio_path", "VARCHAR(4096)"),
        ("timeline_clips", "timeline_start", "REAL"),
    ]
    with get_engine().connect() as conn:
        for table, col, definition in new_columns:
            try:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {col} {definition}"))
                conn.commit()
            except Exception:
                pass  # column already exists


@contextmanager
def get_db() -> Generator[Session, None, None]:
    """Context manager yielding a DB session with automatic commit/rollback."""
    factory = get_session_factory()
    session: Session = factory()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def get_db_session() -> Generator[Session, None, None]:
    """FastAPI dependency yielding a DB session."""
    factory = get_session_factory()
    session: Session = factory()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
