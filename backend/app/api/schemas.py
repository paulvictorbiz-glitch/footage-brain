"""
Pydantic schemas for API request/response validation.
Separate from SQLAlchemy models to decouple DB from API layer.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


# ─────────────────────────────────────────────────────────────────────────────
# Scan Roots
# ─────────────────────────────────────────────────────────────────────────────

class ScanRootCreate(BaseModel):
    path: str
    label: Optional[str] = None
    recursive: bool = True


class ScanRootUpdate(BaseModel):
    label: Optional[str] = None
    enabled: Optional[bool] = None
    recursive: Optional[bool] = None


class ScanRootOut(BaseModel):
    id: str
    path: str
    label: Optional[str]
    enabled: bool
    recursive: bool
    created_at: datetime
    last_scanned_at: Optional[datetime]
    file_count: Optional[int] = None
    # Computed at request time — True if the directory currently exists on disk.
    is_online: bool = False

    model_config = {"from_attributes": True}


class RelinkRequest(BaseModel):
    new_path: str
    dry_run: bool = False


class RelinkResult(BaseModel):
    old_path: str
    new_path: str
    remapped: int       # file records whose abs_path was updated
    unmatched: int      # records under this root whose path didn't share the old prefix
    dry_run: bool


# ─────────────────────────────────────────────────────────────────────────────
# Video Files
# ─────────────────────────────────────────────────────────────────────────────

class VideoFileOut(BaseModel):
    id: str
    abs_path: str
    filename: str
    extension: str
    file_size: int
    created_time: Optional[datetime]
    modified_time: Optional[datetime]
    sha256: Optional[str]
    duration_seconds: Optional[float]
    fps: Optional[float]
    width: Optional[int]
    height: Optional[int]
    video_codec: Optional[str]
    audio_codec: Optional[str]
    has_audio: bool
    bit_rate: Optional[int]
    aspect_ratio: Optional[str]
    is_vertical: bool
    project_tag: Optional[str]
    thumbnail_path: Optional[str]
    metadata_extracted: bool
    hashed: bool
    transcribed: bool
    embedded: bool
    clip_embedded: bool = False
    scan_root_id: Optional[str]
    duplicate_group_id: Optional[str]
    is_canonical: bool
    archive_status: str
    created_at: datetime

    model_config = {"from_attributes": True}


class VideoFileUpdate(BaseModel):
    project_tag: Optional[str] = None
    is_canonical: Optional[bool] = None
    archive_status: Optional[str] = None


# ─────────────────────────────────────────────────────────────────────────────
# Transcript Chunks
# ─────────────────────────────────────────────────────────────────────────────

class TranscriptChunkOut(BaseModel):
    id: str
    chunk_index: int
    start_time: float
    end_time: float
    text: str
    language: Optional[str]

    model_config = {"from_attributes": True}


# ─────────────────────────────────────────────────────────────────────────────
# Ingest Jobs
# ─────────────────────────────────────────────────────────────────────────────

class IngestJobOut(BaseModel):
    id: str
    video_file_id: str
    stage: str
    status: str
    attempts: int
    error_message: Optional[str]
    created_at: datetime
    started_at: Optional[datetime]
    finished_at: Optional[datetime]

    model_config = {"from_attributes": True}


# ─────────────────────────────────────────────────────────────────────────────
# Search
# ─────────────────────────────────────────────────────────────────────────────

class SearchRequest(BaseModel):
    query: str = ""
    mode: str = "semantic"  # semantic | keyword | hybrid | visual | caption | multimodal
    n_results: int = Field(default=30, ge=1, le=200)
    offset: int = Field(default=0, ge=0)

    # Filters
    project_tag: Optional[str] = None
    source_root_id: Optional[str] = None
    min_duration: Optional[float] = None
    max_duration: Optional[float] = None
    aspect_ratio: Optional[str] = None
    is_vertical: Optional[bool] = None
    has_duplicates_only: bool = False
    unique_only: bool = False
    extension: Optional[str] = None
    date_from: Optional[datetime] = None
    date_to: Optional[datetime] = None


class ChunkMatchOut(BaseModel):
    chunk_id: str
    start_time: float
    end_time: float
    text: str
    score: float


class FrameMatchOut(BaseModel):
    frame_id: str
    timestamp: float
    score: float


class SearchResultOut(BaseModel):
    video_file_id: str
    filename: str
    abs_path: str
    extension: str
    duration_seconds: Optional[float]
    thumbnail_path: Optional[str]
    width: Optional[int]
    height: Optional[int]
    is_vertical: bool
    project_tag: Optional[str]
    scan_root_id: Optional[str]
    has_audio: bool
    sha256: Optional[str]
    duplicate_group_id: Optional[str]
    is_canonical: bool
    best_score: float
    matched_chunks: List[ChunkMatchOut]
    frame_matches: List[FrameMatchOut] = []


class SearchResponse(BaseModel):
    query: str
    mode: str
    total: int
    results: List[SearchResultOut]


# ─────────────────────────────────────────────────────────────────────────────
# Duplicates
# ─────────────────────────────────────────────────────────────────────────────

class DuplicateGroupOut(BaseModel):
    id: str
    sha256: str
    canonical_file_id: Optional[str]
    file_count: int
    files: List[VideoFileOut]

    model_config = {"from_attributes": True}


class SetCanonicalRequest(BaseModel):
    file_id: str


# ─────────────────────────────────────────────────────────────────────────────
# Dashboard / Stats
# ─────────────────────────────────────────────────────────────────────────────

class DashboardStats(BaseModel):
    total_files: int
    total_indexed: int  # metadata extracted
    total_transcribed: int
    total_embedded: int
    total_duration_hours: float
    total_size_bytes: int
    duplicate_groups: int
    duplicate_files: int
    storage_by_root: List[Dict[str, Any]]
    job_stats: Dict[str, int]
    recent_files: List[VideoFileOut]
    # New features
    storage_warnings: List[Dict[str, Any]] = []
    indexing_speed: Dict[str, Any] = {}
    project_breakdown: List[Dict[str, Any]] = []


# ─────────────────────────────────────────────────────────────────────────────
# Timelines
# ─────────────────────────────────────────────────────────────────────────────

class TimelineCreate(BaseModel):
    name: str
    description: Optional[str] = None


class TimelineUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None


class TimelineClipCreate(BaseModel):
    video_file_id: str
    track: int = 0
    position: int = 0
    in_point: Optional[float] = None
    out_point: Optional[float] = None
    timeline_start: Optional[float] = None
    label: Optional[str] = None
    notes: Optional[str] = None


class TimelineClipUpdate(BaseModel):
    track: Optional[int] = None
    position: Optional[int] = None
    in_point: Optional[float] = None
    out_point: Optional[float] = None
    timeline_start: Optional[float] = None
    label: Optional[str] = None
    notes: Optional[str] = None


class TimelineClipOut(BaseModel):
    id: str
    timeline_id: str
    track: int
    position: int
    in_point: Optional[float]
    out_point: Optional[float]
    timeline_start: Optional[float]
    label: Optional[str]
    notes: Optional[str]
    created_at: datetime
    video_file: "VideoFileOut"

    model_config = {"from_attributes": True}


class TimelineOut(BaseModel):
    id: str
    name: str
    description: Optional[str]
    created_at: datetime
    updated_at: datetime
    clips: List["TimelineClipOut"] = []

    model_config = {"from_attributes": True}


class TimelineListOut(BaseModel):
    id: str
    name: str
    description: Optional[str]
    created_at: datetime
    updated_at: datetime
    clip_count: int = 0

    model_config = {"from_attributes": True}


class ReorderClipsRequest(BaseModel):
    track: int
    clip_ids: List[str]


# ─────────────────────────────────────────────────────────────────────────────
# Settings
# ─────────────────────────────────────────────────────────────────────────────

class AppSettingsOut(BaseModel):
    whisper_model: str
    whisper_device: str
    embed_model: str
    frame_sample_interval: int
    ingest_workers: int
    video_extensions: str
    thumbnails_dir: str
    chroma_dir: str
