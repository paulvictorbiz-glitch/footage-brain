"""
SQLAlchemy ORM models for Footage Brain.

Tables:
- scan_roots        – configured root paths to scan
- video_files       – one row per unique video file (by sha256 or path)
- duplicate_groups  – groups of files sharing the same sha256
- ingest_jobs       – background job tracking
- transcript_chunks – chunked transcript segments
- search_history    – saved searches (phase 2)
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import List, Optional

from sqlalchemy import (
    BigInteger,
    Boolean,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.utcnow()


class Base(DeclarativeBase):
    pass


# ─────────────────────────────────────────────────────────────────────────────
# Scan Roots
# ─────────────────────────────────────────────────────────────────────────────

class ScanRoot(Base):
    __tablename__ = "scan_roots"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    path: Mapped[str] = mapped_column(String(2048), unique=True, nullable=False)
    label: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    recursive: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    last_scanned_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    files: Mapped[List["VideoFile"]] = relationship(
        "VideoFile", back_populates="scan_root", cascade="all, delete-orphan"
    )


# ─────────────────────────────────────────────────────────────────────────────
# Duplicate Groups
# ─────────────────────────────────────────────────────────────────────────────

class DuplicateGroup(Base):
    __tablename__ = "duplicate_groups"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    sha256: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    canonical_file_id: Mapped[Optional[str]] = mapped_column(
        String(36), ForeignKey("video_files.id", use_alter=True, name="fk_canonical"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)

    files: Mapped[List["VideoFile"]] = relationship(
        "VideoFile", back_populates="duplicate_group", foreign_keys="[VideoFile.duplicate_group_id]"
    )
    canonical: Mapped[Optional["VideoFile"]] = relationship(
        "VideoFile", foreign_keys=[canonical_file_id]
    )


# ─────────────────────────────────────────────────────────────────────────────
# Video Files
# ─────────────────────────────────────────────────────────────────────────────

class VideoFile(Base):
    __tablename__ = "video_files"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)

    # File identity
    abs_path: Mapped[str] = mapped_column(String(4096), nullable=False, index=True)
    filename: Mapped[str] = mapped_column(String(1024), nullable=False)
    extension: Mapped[str] = mapped_column(String(32), nullable=False)
    file_size: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    created_time: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    modified_time: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    mtime_snapshot: Mapped[Optional[float]] = mapped_column(Float, nullable=True)  # for change detection

    # Hashes
    sha256: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, index=True)

    # Technical metadata (from ffprobe)
    duration_seconds: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    fps: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    width: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    height: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    video_codec: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    audio_codec: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    has_audio: Mapped[bool] = mapped_column(Boolean, default=False)
    bit_rate: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    color_space: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)

    # Derived
    aspect_ratio: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    is_vertical: Mapped[bool] = mapped_column(Boolean, default=False)

    # Classification / tags
    project_tag: Mapped[Optional[str]] = mapped_column(String(255), nullable=True, index=True)
    custom_tags: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # JSON array

    # Thumbnail
    thumbnail_path: Mapped[Optional[str]] = mapped_column(String(4096), nullable=True)

    # Sidecar audio for transcription. When set, the transcript stage reads
    # this instead of abs_path, so a small extracted-audio file can be sent to
    # a remote/GPU box while abs_path stays the original video location.
    audio_path: Mapped[Optional[str]] = mapped_column(String(4096), nullable=True)

    # Pipeline state
    metadata_extracted: Mapped[bool] = mapped_column(Boolean, default=False)
    hashed: Mapped[bool] = mapped_column(Boolean, default=False)
    transcribed: Mapped[bool] = mapped_column(Boolean, default=False)
    embedded: Mapped[bool] = mapped_column(Boolean, default=False)
    keyframes_extracted: Mapped[bool] = mapped_column(Boolean, default=False)
    clip_embedded: Mapped[bool] = mapped_column(Boolean, default=False)
    captioned: Mapped[bool] = mapped_column(Boolean, default=False)

    # Foreign keys
    scan_root_id: Mapped[Optional[str]] = mapped_column(
        String(36), ForeignKey("scan_roots.id", ondelete="SET NULL"), nullable=True
    )
    duplicate_group_id: Mapped[Optional[str]] = mapped_column(
        String(36),
        ForeignKey("duplicate_groups.id", ondelete="SET NULL", use_alter=True, name="fk_dup_group"),
        nullable=True,
        index=True,
    )

    # Archive workflow
    is_canonical: Mapped[bool] = mapped_column(Boolean, default=False)
    archive_status: Mapped[str] = mapped_column(String(32), default="none")
    # none | pending_copy | pending_move | archived

    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)

    # Relationships
    scan_root: Mapped[Optional[ScanRoot]] = relationship("ScanRoot", back_populates="files")
    duplicate_group: Mapped[Optional[DuplicateGroup]] = relationship(
        "DuplicateGroup", back_populates="files", foreign_keys=[duplicate_group_id]
    )
    ingest_jobs: Mapped[List["IngestJob"]] = relationship(
        "IngestJob", back_populates="video_file", cascade="all, delete-orphan"
    )
    transcript_chunks: Mapped[List["TranscriptChunk"]] = relationship(
        "TranscriptChunk", back_populates="video_file", cascade="all, delete-orphan"
    )

    __table_args__ = (UniqueConstraint("abs_path", name="uq_abs_path"),)


# ─────────────────────────────────────────────────────────────────────────────
# Ingest Jobs
# ─────────────────────────────────────────────────────────────────────────────

JOB_STAGES = ["scan", "metadata", "hash", "thumbnail", "transcript", "embed", "keyframes", "clip_embed", "caption"]
JOB_STATUSES = ["pending", "processing", "done", "failed", "skipped"]


class IngestJob(Base):
    __tablename__ = "ingest_jobs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    video_file_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("video_files.id", ondelete="CASCADE"), nullable=False, index=True
    )
    stage: Mapped[str] = mapped_column(String(32), nullable=False)
    # scan | metadata | hash | thumbnail | transcript | embed | keyframes

    status: Mapped[str] = mapped_column(String(16), default="pending", index=True)
    # pending | processing | done | failed | skipped

    attempts: Mapped[int] = mapped_column(Integer, default=0)
    max_attempts: Mapped[int] = mapped_column(Integer, default=3)
    error_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    video_file: Mapped[VideoFile] = relationship("VideoFile", back_populates="ingest_jobs")

    __table_args__ = (
        UniqueConstraint("video_file_id", "stage", name="uq_job_file_stage"),
    )


# ─────────────────────────────────────────────────────────────────────────────
# Transcript Chunks
# ─────────────────────────────────────────────────────────────────────────────

class TranscriptChunk(Base):
    __tablename__ = "transcript_chunks"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    video_file_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("video_files.id", ondelete="CASCADE"), nullable=False, index=True
    )
    chunk_index: Mapped[int] = mapped_column(Integer, nullable=False)
    start_time: Mapped[float] = mapped_column(Float, nullable=False)
    end_time: Mapped[float] = mapped_column(Float, nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    language: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    chroma_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)  # ID in Chroma collection

    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)

    video_file: Mapped[VideoFile] = relationship("VideoFile", back_populates="transcript_chunks")


# ─────────────────────────────────────────────────────────────────────────────
# Timelines (Video Blueprint / Storyboard)
# ─────────────────────────────────────────────────────────────────────────────

class Timeline(Base):
    __tablename__ = "timelines"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)

    clips: Mapped[List["TimelineClip"]] = relationship(
        "TimelineClip",
        back_populates="timeline",
        cascade="all, delete-orphan",
        order_by="[TimelineClip.track, TimelineClip.position]",
    )


class TimelineClip(Base):
    __tablename__ = "timeline_clips"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    timeline_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("timelines.id", ondelete="CASCADE"), nullable=False, index=True
    )
    video_file_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("video_files.id", ondelete="CASCADE"), nullable=False
    )
    track: Mapped[int] = mapped_column(Integer, default=0)
    # 0 = Video (Main), 1 = B-Roll, 2 = Audio/Narration, 3 = Graphics
    position: Mapped[int] = mapped_column(Integer, default=0)  # order within track
    in_point: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    out_point: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    timeline_start: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    label: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)

    timeline: Mapped["Timeline"] = relationship("Timeline", back_populates="clips")
    video_file: Mapped["VideoFile"] = relationship("VideoFile")


# ─────────────────────────────────────────────────────────────────────────────
# Frame Captions (VLM-generated descriptions per sampled frame)
# ─────────────────────────────────────────────────────────────────────────────

class FrameCaption(Base):
    __tablename__ = "frame_captions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    video_file_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("video_files.id", ondelete="CASCADE"), nullable=False, index=True
    )
    frame_index: Mapped[int] = mapped_column(Integer, nullable=False)
    timestamp: Mapped[float] = mapped_column(Float, nullable=False)
    caption: Mapped[str] = mapped_column(Text, nullable=False)
    captioner_model: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    chroma_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)

    __table_args__ = (
        UniqueConstraint("video_file_id", "frame_index", name="uq_caption_file_frame"),
    )


# ─────────────────────────────────────────────────────────────────────────────
# Search History
# ─────────────────────────────────────────────────────────────────────────────

class SearchHistory(Base):
    __tablename__ = "search_history"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    query: Mapped[str] = mapped_column(Text, nullable=False)
    mode: Mapped[str] = mapped_column(String(32), default="semantic")
    result_count: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


# ─────────────────────────────────────────────────────────────────────────────
# Saved Searches
# ─────────────────────────────────────────────────────────────────────────────

class SavedSearch(Base):
    __tablename__ = "saved_searches"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    query: Mapped[str] = mapped_column(Text, nullable=False)
    filters: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


# ─────────────────────────────────────────────────────────────────────────────
# Scan Exclusions
# ─────────────────────────────────────────────────────────────────────────────

class ScanExclusion(Base):
    """A folder path prefix to skip during scans. Files already indexed under
    it are purged when the exclusion is created (user-chosen behaviour)."""
    __tablename__ = "scan_exclusions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    path: Mapped[str] = mapped_column(String(4096), unique=True, nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
