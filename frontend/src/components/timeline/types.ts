/**
 * Shared types used across the timeline editor and its sub-components.
 *
 * `StripClip` is the editor's working representation of a clip — it extends
 * the API's `TimelineClip` with a resolved `start` timestamp on the strip.
 * The API stores `timeline_start` (sometimes null for legacy clips) and
 * `position`; `resolveStarts()` in helpers.ts produces this shape.
 */
import type { TimelineClip } from '@/api/client'

export type Tool = 'select' | 'razor' | 'hand'

export interface StripClip extends TimelineClip {
  start: number
}

export interface UndoEntry {
  label: string
  clips: StripClip[]
}

export interface TrimPreview {
  clipId: string
  inPt: number
  outPt: number
  start: number
}
