"""
Machine-state detection for portable deployments.

On startup this module:
  1. Reads a small state file (machine_id.json) written by the last successful run.
  2. Compares the current machine fingerprint (hostname) to the saved one.
  3. Logs a clear warning if the machine has changed (folder was moved/copied).
  4. Checks all scan roots — logs each offline root with a suggested fix.
  5. Updates machine_id.json so future startups have a fresh baseline.

None of this blocks startup. All failures are caught and logged as warnings.
"""
from __future__ import annotations

import json
import os
import socket
from datetime import datetime
from pathlib import Path

from app.core.logging import get_logger

logger = get_logger(__name__)

_STATE_FILE = "machine_id.json"


def _state_path(settings) -> Path:
    """machine_id.json lives in the data root so it travels with the DB."""
    base = settings.data_root or "."
    return Path(base) / _STATE_FILE


def _current_fingerprint() -> dict:
    return {
        "hostname": socket.gethostname(),
        "username": os.environ.get("USERNAME") or os.environ.get("USER") or "unknown",
        "recorded_at": datetime.utcnow().isoformat(),
    }


def _load_saved(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _save(path: Path, data: dict) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    except Exception as exc:
        logger.warning("machine_id_save_failed", error=str(exc))


def _check_offline_roots(settings) -> None:
    """Import DB session here to avoid circular imports at module load."""
    try:
        from app.db.session import get_db
        from app.db.models import ScanRoot, VideoFile

        with get_db() as session:
            roots = session.query(ScanRoot).all()
            offline = [r for r in roots if not Path(r.path).exists()]

            if not offline:
                logger.info("all_scan_roots_online", count=len(roots))
                return

            logger.warning(
                "offline_scan_roots_detected",
                count=len(offline),
                hint="Run relink-sources.bat to reconnect footage drives.",
            )
            for root in offline:
                file_count = session.query(VideoFile).filter_by(scan_root_id=root.id).count()
                logger.warning(
                    "scan_root_offline",
                    path=root.path,
                    label=root.label or "(no label)",
                    files=file_count,
                    fix="Run relink-sources.bat and pick this source to reconnect it.",
                )
    except Exception as exc:
        logger.warning("offline_root_check_failed", error=str(exc))


def check_machine_state(settings) -> None:
    """Run on every startup. Logs warnings, never raises."""
    state_file = _state_path(settings)
    current = _current_fingerprint()
    saved = _load_saved(state_file)

    if saved:
        if saved.get("hostname") != current["hostname"]:
            logger.warning(
                "machine_changed",
                previous_host=saved.get("hostname"),
                current_host=current["hostname"],
                hint=(
                    "The app folder was moved to a different computer. "
                    "If footage drives show as OFFLINE, run relink-sources.bat."
                ),
            )
        else:
            logger.info(
                "machine_unchanged",
                hostname=current["hostname"],
            )
    else:
        logger.info("machine_id_first_run", hostname=current["hostname"])

    _save(state_file, current)
    _check_offline_roots(settings)
