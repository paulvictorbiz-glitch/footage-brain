"""
Persistent enable/disable flags for the heavier pipeline stages
(`clip_embed` and `caption`).

Settings live in a small JSON file under the data root so they survive across
restarts. The worker reads them once per loop tick; the dashboard endpoints
read + write them.
"""
from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Dict

from app.core.config import get_settings
from app.core.logging import get_logger

logger = get_logger(__name__)

# Stages we let the user disable. Other stages always run.
TOGGLEABLE_STAGES = ("clip_embed", "caption")

_DEFAULTS: Dict[str, bool] = {f"{s}_enabled": True for s in TOGGLEABLE_STAGES}
_LOCK = threading.Lock()
_CACHE: Dict[str, bool] | None = None


def _settings_path() -> Path:
    s = get_settings()
    root = (s.data_root or "").strip()
    base = Path(root) if root else Path.cwd()
    base.mkdir(parents=True, exist_ok=True)
    return base / "pipeline_settings.json"


def _read_disk() -> Dict[str, bool]:
    p = _settings_path()
    if not p.exists():
        return dict(_DEFAULTS)
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        merged = dict(_DEFAULTS)
        for k in _DEFAULTS:
            if isinstance(data.get(k), bool):
                merged[k] = data[k]
        return merged
    except Exception as exc:
        logger.warning("pipeline_settings_read_failed", path=str(p), error=str(exc))
        return dict(_DEFAULTS)


def _write_disk(values: Dict[str, bool]) -> None:
    p = _settings_path()
    try:
        p.write_text(json.dumps(values, indent=2), encoding="utf-8")
    except Exception as exc:
        logger.error("pipeline_settings_write_failed", path=str(p), error=str(exc))


def get_stage_toggles() -> Dict[str, bool]:
    """Cheap accessor (cached in-memory, refreshed on update)."""
    global _CACHE
    with _LOCK:
        if _CACHE is None:
            _CACHE = _read_disk()
        return dict(_CACHE)


def is_stage_enabled(stage: str) -> bool:
    return get_stage_toggles().get(f"{stage}_enabled", True)


def set_stage_toggles(updates: Dict[str, bool]) -> Dict[str, bool]:
    """Update one or more `<stage>_enabled` flags; returns the new full state."""
    global _CACHE
    with _LOCK:
        current = _read_disk()
        for k, v in updates.items():
            if k in _DEFAULTS and isinstance(v, bool):
                current[k] = v
        _write_disk(current)
        _CACHE = dict(current)
        return dict(current)
