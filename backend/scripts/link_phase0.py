"""
Link Phase 0 derived files into existing VideoFile rows.

Phase 0 (deploy/phase0_extract.ps1) mirrors the source tree into
  <out>/audio/<rel>.flac   <out>/thumbnails/<rel>.jpg   <out>/proxies/<rel>.mp4

For every VideoFile under --source-root this:
  * ffprobes the ORIGINAL video and fills the same metadata fields the
    in-app `metadata` stage would (so that stage becomes a no-op),
  * points `audio_path` at the .flac sidecar (so transcription reads it),
  * points `thumbnail_path` at the .jpg (so the `thumbnail` stage no-ops).

Run order: scan the source root in the app FIRST (creates the rows), then:
  cd backend && venv\\Scripts\\python.exe scripts\\link_phase0.py \\
      --source-root E:\\Backup --out-root D:\\fb_derived

Idempotent and resumable. `hash` is already disabled, so after this the only
remaining pipeline work is transcript + embed.
"""
from __future__ import annotations

import argparse
import os
from datetime import datetime
from pathlib import Path

from app.db.models import VideoFile
from app.db.session import get_session_factory
from app.ingest import metadata as md  # reuse the app's ffprobe + parsers


def _apply_probe(vf: VideoFile, probe: dict) -> None:
    """Mirror app.ingest.metadata.extract_metadata's field mapping (kept in
    sync with it) — minus the thumbnail decode, which Phase 0 already did."""
    streams = probe.get("streams", [])
    fmt = probe.get("format", {})
    video_stream = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio_stream = next((s for s in streams if s.get("codec_type") == "audio"), None)

    raw_dur = fmt.get("duration") or (video_stream or {}).get("duration")
    if raw_dur:
        try:
            vf.duration_seconds = float(raw_dur)
        except ValueError:
            pass
    try:
        vf.bit_rate = int(fmt.get("bit_rate", 0)) or None
    except (ValueError, TypeError):
        vf.bit_rate = None

    if video_stream:
        vf.video_codec = video_stream.get("codec_name")
        vf.width = video_stream.get("width")
        vf.height = video_stream.get("height")
        vf.color_space = video_stream.get("color_space")
        fps_str = video_stream.get("r_frame_rate") or video_stream.get("avg_frame_rate")
        if fps_str:
            vf.fps = md._parse_fps(fps_str)
        if vf.width and vf.height:
            vf.aspect_ratio = md._gcd_ratio(vf.width, vf.height)
            vf.is_vertical = vf.height > vf.width

    if audio_stream:
        vf.audio_codec = audio_stream.get("codec_name")
        vf.has_audio = True
    else:
        vf.has_audio = False

    vf.metadata_extracted = True
    vf.updated_at = datetime.utcnow()


def link(source_root: str, out_root: str, commit_every: int = 500,
         limit: int | None = None) -> dict:
    src = os.path.abspath(source_root)
    audio_root = Path(out_root) / "audio"
    thumb_root = Path(out_root) / "thumbnails"

    c = {"total": 0, "audio_set": 0, "thumb_set": 0, "probed": 0,
         "no_match": 0, "probe_fail": 0, "audio_missing": 0}

    session = get_session_factory()()
    try:
        q = session.query(VideoFile)
        if limit:
            q = q.limit(limit)
        pending = 0
        for vf in q.yield_per(500):
            c["total"] += 1
            try:
                rel = os.path.relpath(vf.abs_path, src)
            except ValueError:
                c["no_match"] += 1
                continue
            if rel.startswith("..") or os.path.isabs(rel):
                c["no_match"] += 1
                continue

            rel_p = Path(rel)
            audio_file = audio_root / rel_p.with_suffix(".flac")
            thumb_file = thumb_root / rel_p.with_suffix(".jpg")

            probe = md._run_ffprobe(vf.abs_path)
            if probe is None:
                c["probe_fail"] += 1  # leave metadata_extracted False -> retried
            else:
                _apply_probe(vf, probe)
                c["probed"] += 1

            if thumb_file.exists():
                vf.thumbnail_path = str(thumb_file)
                c["thumb_set"] += 1
            if audio_file.exists():
                vf.audio_path = str(audio_file)
                c["audio_set"] += 1
            elif vf.has_audio:
                # has audio but Phase 0 produced no sidecar -> transcription
                # would fall back to a video path the VPS won't have.
                c["audio_missing"] += 1

            pending += 1
            if pending >= commit_every:
                session.commit()
                pending = 0
        session.commit()
    finally:
        session.close()
    return c


def main() -> None:
    ap = argparse.ArgumentParser(description="Link Phase 0 outputs into VideoFile rows.")
    ap.add_argument("--source-root", required=True)
    ap.add_argument("--out-root", required=True)
    ap.add_argument("--commit-every", type=int, default=500)
    ap.add_argument("--limit", type=int, default=None)
    a = ap.parse_args()
    counts = link(a.source_root, a.out_root, a.commit_every, a.limit)
    print("Phase 0 link complete:")
    for k, v in counts.items():
        print(f"  {k:14s} {v}")
    if counts["audio_missing"]:
        print(f"  !! {counts['audio_missing']} file(s) have audio but no sidecar "
              f"-- re-run phase0_extract.ps1 for those.")


if __name__ == "__main__":
    main()
