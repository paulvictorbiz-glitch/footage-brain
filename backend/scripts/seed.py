"""
Dev seed script.
Creates a sample ScanRoot pointing at a test folder and triggers ingest.

Usage:
    cd backend
    python -m scripts.seed --folder /path/to/sample/videos
    python -m scripts.seed --folder ./test_videos --create-samples
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

# Add parent to path
sys.path.insert(0, str(Path(__file__).parent.parent))


def create_sample_videos(folder: Path) -> None:
    """Create a few tiny test videos using ffmpeg."""
    folder.mkdir(parents=True, exist_ok=True)

    samples = [
        ("sample_landscape.mp4", "color=c=blue:size=1920x1080:duration=10", "This is a landscape video test clip."),
        ("sample_vertical.mp4", "color=c=red:size=1080x1920:duration=8", "Vertical format short clip for testing."),
        ("sample_duplicate.mp4", "color=c=green:size=1280x720:duration=5", "Duplicate detection test clip."),
    ]

    for name, video_filter, _ in samples:
        out = folder / name
        if out.exists():
            print(f"  Already exists: {out}")
            continue
        cmd = [
            "ffmpeg", "-f", "lavfi", "-i", video_filter,
            "-f", "lavfi", "-i", "sine=frequency=440:duration=10",
            "-c:v", "libx264", "-c:a", "aac",
            "-t", "10", "-y", str(out)
        ]
        result = subprocess.run(cmd, capture_output=True)
        if result.returncode == 0:
            print(f"  Created: {out}")
        else:
            print(f"  Failed to create {name}: {result.stderr.decode()[:200]}")

    # Create a duplicate
    dup = folder / "sample_duplicate_copy.mp4"
    src = folder / "sample_duplicate.mp4"
    if src.exists() and not dup.exists():
        import shutil
        shutil.copy2(src, dup)
        print(f"  Created duplicate: {dup}")


def seed(folder: str) -> None:
    from app.core.config import get_settings
    from app.core.logging import configure_logging
    from app.db.session import init_db, get_db
    from app.db.models import ScanRoot
    from app.ingest.scanner import scan_root
    from app.ingest.pipeline import get_pipeline_worker
    import time

    configure_logging()
    settings = get_settings()
    settings.ensure_dirs()
    init_db()

    abs_folder = str(Path(folder).resolve())
    print(f"\nSeeding with folder: {abs_folder}\n")

    with get_db() as session:
        existing = session.query(ScanRoot).filter_by(path=abs_folder).first()
        if existing:
            print(f"Source already exists: {existing.id}")
            root = existing
        else:
            root = ScanRoot(path=abs_folder, label="Dev Sample", recursive=True)
            session.add(root)
            session.flush()
            print(f"Created scan root: {root.id}")

        summary = scan_root(session, root)
        print(f"Scan summary: {summary}")

    print("\nStarting pipeline worker...")
    worker = get_pipeline_worker()
    worker.start()

    print("Processing jobs (Ctrl+C to stop)...")
    try:
        while True:
            stats = worker.queue_stats()
            pending = stats.get("pending", 0)
            processing = stats.get("processing", 0)
            done = stats.get("done", 0)
            failed = stats.get("failed", 0)
            print(f"\r  pending={pending} processing={processing} done={done} failed={failed}    ", end="", flush=True)
            if pending == 0 and processing == 0:
                break
            time.sleep(2)
    except KeyboardInterrupt:
        pass

    print("\n\nDone! Start the server to explore:")
    print("  cd backend && uvicorn app.main:app --reload")
    print("  Open http://localhost:5173")
    worker.stop()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Seed Footage Brain with test data")
    parser.add_argument("--folder", default="./test_videos", help="Path to video folder")
    parser.add_argument("--create-samples", action="store_true", help="Create sample test videos using ffmpeg")
    args = parser.parse_args()

    if args.create_samples:
        folder = Path(args.folder)
        print(f"Creating sample videos in {folder}...")
        create_sample_videos(folder)

    seed(args.folder)
