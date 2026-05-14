"""
Core application configuration loaded from environment / .env file.

Portable mode
─────────────
Set DATA_ROOT to a single directory and every storage path (DB, vectors,
thumbnails, keyframes, model cache, logs) will live under it automatically.
Individual path variables still override DATA_ROOT if explicitly set.

Dev mode (default)
──────────────────
Leave DATA_ROOT unset.  Paths default to ./data/* relative to the backend/
working directory, matching the original layout.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ── Application ───────────────────────────────────────────────────────────
    app_env: str = "development"
    app_host: str = "0.0.0.0"
    app_port: int = 8000
    secret_key: str = "dev-secret-key"

    # ── Portable mode root ────────────────────────────────────────────────────
    # When non-empty, all storage paths that haven't been explicitly set will
    # be derived from this directory.  Relative paths are resolved from the
    # backend/ working directory at runtime.
    data_root: str = ""

    # ── Database ──────────────────────────────────────────────────────────────
    database_url: str = "sqlite:///./footage_brain.db"

    # ── Storage paths ─────────────────────────────────────────────────────────
    thumbnails_dir: str = "./data/thumbnails"
    keyframes_dir: str = "./data/keyframes"
    chroma_dir: str = "./data/chroma"

    # ── Model cache ───────────────────────────────────────────────────────────
    # When set, overrides HF_HOME / TRANSFORMERS_CACHE so all downloaded model
    # weights land in this directory instead of %USERPROFILE%\.cache\huggingface
    model_cache_dir: str = ""

    # ── Logging ───────────────────────────────────────────────────────────────
    log_level: str = "INFO"
    # When set, a rotating log file is written here in addition to stdout.
    log_dir: str = ""

    # ── Transcription ─────────────────────────────────────────────────────────
    whisper_model: str = "base"
    whisper_device: str = "cpu"
    whisper_compute_type: str = "int8"

    # ── Embeddings ────────────────────────────────────────────────────────────
    embed_model: str = "all-MiniLM-L6-v2"

    # ── Ingest ────────────────────────────────────────────────────────────────
    ingest_workers: int = 2
    frame_sample_interval: int = 15
    transcribe_workers: int = 1

    # ── Video extensions ──────────────────────────────────────────────────────
    video_extensions: str = ".mp4,.mov,.avi,.mkv,.mxf,.r3d,.braw,.wmv,.flv,.webm,.m4v,.ts,.mts,.m2ts,.3gp,.f4v"

    # ── FFmpeg binaries ───────────────────────────────────────────────────────
    # Leave blank to auto-detect: checks ./tools/ffmpeg.exe first, then PATH.
    # Set to an absolute path to pin a specific binary.
    ffmpeg_bin: str = ""
    ffprobe_bin: str = ""

    # ── Frontend (production build) ───────────────────────────────────────────
    frontend_dist: str = "../frontend/dist"

    # ─────────────────────────────────────────────────────────────────────────
    # Portable-mode path resolution
    # ─────────────────────────────────────────────────────────────────────────

    @model_validator(mode="before")
    @classmethod
    def _apply_data_root(cls, values: dict) -> dict:
        """
        When DATA_ROOT is set, derive any storage path that was NOT explicitly
        provided by the caller.  Explicitly provided values always win.

        This runs before pydantic applies Python-level defaults, so a missing
        key in `values` means "the user did not set this variable in .env or
        the environment."
        """
        root = str(values.get("data_root") or "").strip()
        if not root:
            return values

        base = Path(root)

        if not values.get("database_url"):
            values["database_url"] = (
                "sqlite:///" + (base / "footage_brain.db").as_posix()
            )
        if not values.get("thumbnails_dir"):
            values["thumbnails_dir"] = str(base / "thumbnails")
        if not values.get("keyframes_dir"):
            values["keyframes_dir"] = str(base / "keyframes")
        if not values.get("chroma_dir"):
            values["chroma_dir"] = str(base / "chroma")
        if not values.get("model_cache_dir"):
            values["model_cache_dir"] = str(base / "models")
        if not values.get("log_dir"):
            values["log_dir"] = str(base / "logs")

        return values

    # ─────────────────────────────────────────────────────────────────────────
    # Helpers
    # ─────────────────────────────────────────────────────────────────────────

    @property
    def ffmpeg_exe(self) -> str:
        """Resolved path to ffmpeg binary. Checks ./tools/ before PATH."""
        if self.ffmpeg_bin:
            return self.ffmpeg_bin
        local = Path("tools/ffmpeg.exe")
        if local.exists():
            return str(local.resolve())
        return "ffmpeg"

    @property
    def ffprobe_exe(self) -> str:
        """Resolved path to ffprobe binary. Checks ./tools/ before PATH."""
        if self.ffprobe_bin:
            return self.ffprobe_bin
        local = Path("tools/ffprobe.exe")
        if local.exists():
            return str(local.resolve())
        return "ffprobe"

    @property
    def video_ext_set(self) -> set[str]:
        return {e.strip().lower() for e in self.video_extensions.split(",")}

    def ensure_dirs(self) -> None:
        """Create all configured storage directories if they don't exist."""
        dirs = [
            self.thumbnails_dir,
            self.keyframes_dir,
            self.chroma_dir,
        ]
        if self.model_cache_dir:
            dirs.append(self.model_cache_dir)
        if self.log_dir:
            dirs.append(self.log_dir)
        for d in dirs:
            Path(d).mkdir(parents=True, exist_ok=True)


def get_settings() -> Settings:
    return Settings()
