"""
Single source of truth for pipeline-stage metadata.

Three pieces of information live here, and ONLY here:

  • STAGE_ORDER — the canonical priority order the worker drains pending
    jobs in. Earlier entries run before later ones.
  • STAGE_FLAG  — the boolean attribute on VideoFile that each stage flips
    to True when it considers itself "done." Used by reconcile and the
    reprocess endpoint to invalidate a stage's done-state so the handler
    will actually re-run.
  • STREAM_STAGES — the subset of stages that produce embedding vectors
    (transcript text, CLIP frames, VLM captions). These are the targets
    of rebuild-all-streams and the search engine's multimodal fusion.

Adding a new pipeline stage now touches one file. Previously this
information was scattered across pipeline.py, api/files.py, and reconcile.py
— with three opportunities to forget to update one of them.
"""
from __future__ import annotations

from typing import Dict, Optional, Tuple


# Priority order: the pipeline worker drains pending jobs in this sequence.
# Stages not in this list still run, but get bumped to the back of the queue.
STAGE_ORDER: Tuple[str, ...] = (
    "metadata",
    "hash",
    "thumbnail",
    "transcript",
    "embed",
    "clip_embed",
    "caption",
    "keyframes",
)


# Stage name → VideoFile flag attribute. None means "no flag" (the stage's
# idempotency is governed by a non-boolean field on VideoFile — e.g. the
# thumbnail stage checks `thumbnail_path` instead of a boolean).
STAGE_FLAG: Dict[str, Optional[str]] = {
    "metadata":   "metadata_extracted",
    "hash":       "hashed",
    "thumbnail":  None,                  # guarded by vf.thumbnail_path
    "transcript": "transcribed",
    "embed":      "embedded",
    "clip_embed": "clip_embedded",
    "caption":    "captioned",
    "keyframes":  "keyframes_extracted",
}


# The three semantic streams the search engine queries.
STREAM_STAGES: Tuple[str, ...] = ("embed", "clip_embed", "caption")


def reset_flag(vf, stage: str) -> bool:
    """
    Reset the done-flag for `stage` on a VideoFile so the next pipeline run
    will actually execute the handler. Returns True if a flag was reset.

    Centralising this means reprocess and rebuild paths can't silently drift
    out of sync with the flag mapping.
    """
    flag = STAGE_FLAG.get(stage)
    if flag is None:
        return False
    if not hasattr(vf, flag):
        return False
    setattr(vf, flag, False)
    return True
