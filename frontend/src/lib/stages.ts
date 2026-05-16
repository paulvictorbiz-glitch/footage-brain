/**
 * Single source of truth for pipeline-stage UI metadata.
 *
 * The backend pipeline has 8 ingest stages; whenever a component renders
 * stage progress, badges, or labels it should pull from here instead of
 * re-rolling its own palette. Keeps colors/labels consistent and means
 * adding a new stage is a one-line dictionary update.
 *
 * Mirror of (and named to match) backend/app/ingest/stages.py.
 */

export type StageKey =
  | 'metadata'
  | 'hash'
  | 'thumbnail'
  | 'transcript'
  | 'embed'
  | 'clip_embed'
  | 'caption'
  | 'keyframes'

export const STAGE_ORDER: readonly StageKey[] = [
  'metadata',
  'hash',
  'thumbnail',
  'transcript',
  'embed',
  'clip_embed',
  'caption',
  'keyframes',
] as const

export const STAGE_LABELS: Record<StageKey, string> = {
  metadata:   'Metadata',
  hash:       'Hashing',
  thumbnail:  'Thumbnails',
  transcript: 'Transcription',
  embed:      'Embedding',
  clip_embed: 'CLIP frames',
  caption:    'VLM captions',
  keyframes:  'Keyframes',
}

/**
 * Tailwind background classes used for progress bars. The three semantic-stream
 * stages (embed / clip_embed / caption) share a distinct color family so they
 * read as a group in the dashboard.
 */
export const STAGE_COLORS: Record<StageKey, string> = {
  metadata:   'bg-blue-500',
  hash:       'bg-purple-500',
  thumbnail:  'bg-cyan-500',
  transcript: 'bg-amber-500',
  embed:      'bg-green-500',
  clip_embed: 'bg-violet-500',
  caption:    'bg-emerald-500',
  keyframes:  'bg-pink-500',
}

export function stageLabel(stage: string): string {
  return (STAGE_LABELS as Record<string, string>)[stage] ?? stage
}

export function stageColor(stage: string): string {
  return (STAGE_COLORS as Record<string, string>)[stage] ?? 'bg-zinc-500'
}
