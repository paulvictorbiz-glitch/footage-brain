/**
 * Pure helpers shared by Timeline page + sub-components.
 *
 * Kept side-effect-free so they're trivially testable and don't drag React
 * into the import graph.
 */
import type { TimelineClip } from '@/api/client'
import type { StripClip } from './types'

// ─── Constants ──────────────────────────────────────────────────────────────

export const SPEEDS = [1, 2, 4, 8]
export const SNAP_THR = 0.5
export const MIN_W_PX = 20
export const LABEL_W = 48
export const MIN_DUR = 0.5

// ─── Formatting ─────────────────────────────────────────────────────────────

export function fmt(sec?: number | null): string {
  if (sec == null) return '—'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  const ds = Math.floor((sec % 1) * 10)
  return `${m}:${String(s).padStart(2, '0')}.${ds}`
}

export function fmtShort(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

// ─── Clip layout ────────────────────────────────────────────────────────────

export function clipDur(clip: TimelineClip): number {
  const i = clip.in_point ?? 0
  const o = clip.out_point ?? (clip.video_file.duration_seconds ?? 0)
  return Math.max(0, o - i)
}

/**
 * Resolve a clip's `start` on the strip. Prefers `timeline_start` when any
 * clip has one set; otherwise lays clips out sequentially in `position`
 * order. Returns clips re-sorted by start.
 */
export function resolveStarts(clips: TimelineClip[]): StripClip[] {
  const sorted = [...clips].sort((a, b) => {
    if (a.timeline_start != null && b.timeline_start != null)
      return a.timeline_start - b.timeline_start
    return (a.position ?? 0) - (b.position ?? 0)
  })
  const anySet = sorted.some(c => c.timeline_start != null && c.timeline_start > 0)
  if (!anySet) {
    let pos = 0
    return sorted.map(c => { const s = pos; pos += clipDur(c); return { ...c, start: s } })
  }
  return sorted.map(c => ({ ...c, start: c.timeline_start ?? 0 }))
}

/**
 * Snap a clip's start position to the nearest edge of any neighbor that's
 * within `threshold` seconds. Returns the snapped start plus the snap-line
 * timestamp (or null if no snap occurred) so callers can render a guide.
 */
export function snapToEdges(
  rawStart: number,
  dur: number,
  others: { start: number; dur: number }[],
  threshold: number,
): { snapped: number; line: number | null } {
  const rawEnd = rawStart + dur
  for (const o of others) {
    const oEnd = o.start + o.dur
    if (Math.abs(rawStart - oEnd) < threshold)    return { snapped: oEnd,          line: oEnd }
    if (Math.abs(rawStart - o.start) < threshold) return { snapped: o.start,       line: o.start }
    if (Math.abs(rawEnd - o.start) < threshold)   return { snapped: o.start - dur, line: o.start }
    if (Math.abs(rawEnd - oEnd) < threshold)      return { snapped: oEnd - dur,    line: oEnd }
  }
  return { snapped: rawStart, line: null }
}

/** Major-tick interval in seconds for the timeline ruler at a given zoom. */
export function rulerInterval(zoom: number): number {
  if (zoom >= 60) return 1
  if (zoom >= 30) return 2
  if (zoom >= 15) return 5
  if (zoom >= 6) return 10
  return 30
}

// ─── Visual: filmstrip / waveform ────────────────────────────────────────────

/** Stable per-clip hue from id (so each clip's filmstrip has its own colour). */
export function clipHue(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0xffff
  return h % 360
}

/** Background CSS for a clip's filmstrip — alternating darker/lighter bands. */
export function filmstripBg(hue: number, count: number): string {
  const parts: string[] = []
  for (let i = 0; i < count; i++) {
    const a = ((i / count) * 100).toFixed(1)
    const b = (((i + 0.45) / count) * 100).toFixed(1)
    parts.push(`hsl(${hue},38%,19%) ${a}%`, `hsl(${hue},38%,13%) ${b}%`)
  }
  return `linear-gradient(90deg,${parts.join(',')})`
}

/** Deterministic pseudo-random bar heights for a fake audio waveform. */
export function audioWavePts(id: string, barCount: number): number[] {
  let seed = 0
  for (let i = 0; i < id.length; i++) seed = (seed * 31 + id.charCodeAt(i)) & 0x7fffffff
  return Array.from({ length: barCount }, () => {
    seed = (seed * 1664525 + 1013904223) & 0x7fffffff
    return 3 + ((seed >>> 16) & 0xff) / 255 * 22
  })
}
