"""
Run this any time to see pipeline status:
  venv/Scripts/python.exe status.py
"""
import time
from datetime import datetime
from app.db.session import get_db
from app.db.models import IngestJob, VideoFile

def hr(): print("-" * 55)

with get_db() as s:
    total = s.query(VideoFile).count()
    transcribed = s.query(VideoFile).filter_by(transcribed=True).count()
    embedded = s.query(VideoFile).filter_by(embedded=True).count()

    hr()
    print(f"  Footage Brain — {datetime.now().strftime('%H:%M:%S')}")
    hr()
    print(f"  Total files   : {total}")
    print(f"  Transcribed   : {transcribed}  ({transcribed/total*100:.1f}%)")
    print(f"  Embedded      : {embedded}  ({embedded/total*100:.1f}%)")
    hr()

    for stage in ['metadata', 'hash', 'thumbnail', 'transcript', 'embed']:
        row = {}
        for status in ['pending', 'processing', 'done', 'failed', 'skipped']:
            n = s.query(IngestJob).filter_by(stage=stage, status=status).count()
            if n:
                row[status] = n
        total_jobs = sum(row.values())
        done = row.get('done', 0) + row.get('skipped', 0)
        pct = f"{done/total_jobs*100:.0f}%" if total_jobs else "—"
        flags = "  ** ACTIVE **" if row.get('processing') else ""
        flags += "  !! FAILED !!" if row.get('failed') else ""
        print(f"  {stage:<12}: {pct:>4}  {row}{flags}")
    hr()

    # Recently completed (last 5)
    recent = (
        s.query(IngestJob)
        .filter_by(stage='transcript', status='done')
        .order_by(IngestJob.finished_at.desc())
        .limit(5)
        .all()
    )
    if recent:
        print("  Last completed transcripts:")
        for j in recent:
            vf = s.get(VideoFile, j.video_file_id)
            name = vf.filename[:45] if vf else j.video_file_id[:8]
            ts = j.finished_at.strftime('%H:%M:%S') if j.finished_at else '?'
            print(f"    {ts}  {name}")
    hr()

    # Any failures
    fails = s.query(IngestJob).filter_by(stage='transcript', status='failed').all()
    if fails:
        print(f"  Failed jobs: {len(fails)}")
        for j in fails[:3]:
            vf = s.get(VideoFile, j.video_file_id)
            name = vf.filename[:40] if vf else j.video_file_id[:8]
            print(f"    {name}: {j.error_message}")
        hr()
