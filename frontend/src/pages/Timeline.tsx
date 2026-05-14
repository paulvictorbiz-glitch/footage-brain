/**
 * Timeline editor — CapCut-style rough cut builder with Select/Razor/Hand tools,
 * filmstrip clip backgrounds, trim handles, audio waveform track, and undo/redo.
 */
import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import toast from 'react-hot-toast'
import {
  Plus, Trash2, Download, ChevronLeft, Pencil, Check, X,
  Search, Clock, Film, ChevronRight, ChevronDown,
  Scissors, Play, Pause, SkipBack, MousePointer2, Hand,
  Undo2, Redo2, Magnet, Copy, ZoomIn, ZoomOut,
} from 'lucide-react'
import { api, TimelineClip, SearchResult } from '@/api/client'
import { cn } from '@/lib/utils'

// ─── Constants ────────────────────────────────────────────────────────────────
const SPEEDS   = [1, 2, 4, 8]
const SNAP_THR = 0.5
const MIN_W_PX = 20
const LABEL_W  = 48
const MIN_DUR  = 0.5

// ─── Types ────────────────────────────────────────────────────────────────────
type Tool = 'select' | 'razor' | 'hand'
interface StripClip extends TimelineClip { start: number }
interface UndoEntry { label: string; clips: StripClip[] }
interface TrimPreview { clipId: string; inPt: number; outPt: number; start: number }

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmt(sec?: number | null): string {
  if (sec == null) return '—'
  const m  = Math.floor(sec / 60)
  const s  = Math.floor(sec % 60)
  const ds = Math.floor((sec % 1) * 10)
  return `${m}:${String(s).padStart(2, '0')}.${ds}`
}

function fmtShort(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function clipDur(clip: TimelineClip): number {
  const i = clip.in_point  ?? 0
  const o = clip.out_point ?? (clip.video_file.duration_seconds ?? 0)
  return Math.max(0, o - i)
}

function resolveStarts(clips: TimelineClip[]): StripClip[] {
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

function snapToEdges(
  rawStart: number, dur: number,
  others: { start: number; dur: number }[],
  threshold: number,
): { snapped: number; line: number | null } {
  const rawEnd = rawStart + dur
  for (const o of others) {
    const oEnd = o.start + o.dur
    if (Math.abs(rawStart - oEnd)    < threshold) return { snapped: oEnd,          line: oEnd }
    if (Math.abs(rawStart - o.start) < threshold) return { snapped: o.start,       line: o.start }
    if (Math.abs(rawEnd   - o.start) < threshold) return { snapped: o.start - dur, line: o.start }
    if (Math.abs(rawEnd   - oEnd)    < threshold) return { snapped: oEnd - dur,    line: oEnd }
  }
  return { snapped: rawStart, line: null }
}

function rulerInterval(zoom: number): number {
  if (zoom >= 60) return 1
  if (zoom >= 30) return 2
  if (zoom >= 15) return 5
  if (zoom >= 6)  return 10
  return 30
}

function clipHue(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0xffff
  return h % 360
}

function filmstripBg(hue: number, count: number): string {
  const parts: string[] = []
  for (let i = 0; i < count; i++) {
    const a = ((i / count) * 100).toFixed(1)
    const b = (((i + 0.45) / count) * 100).toFixed(1)
    parts.push(`hsl(${hue},38%,19%) ${a}%`, `hsl(${hue},38%,13%) ${b}%`)
  }
  return `linear-gradient(90deg,${parts.join(',')})`
}

function audioWavePts(id: string, barCount: number): number[] {
  let seed = 0
  for (let i = 0; i < id.length; i++) seed = (seed * 31 + id.charCodeAt(i)) & 0x7fffffff
  return Array.from({ length: barCount }, () => {
    seed = (seed * 1664525 + 1013904223) & 0x7fffffff
    return 3 + ((seed >>> 16) & 0xff) / 255 * 22
  })
}

// ─── Scrubber ─────────────────────────────────────────────────────────────────
interface ScrubberProps {
  current: number; duration: number; inPt: number; outPt: number; onSeek: (t: number) => void
}
function Scrubber({ current, duration, inPt, outPt, onSeek }: ScrubberProps) {
  const barRef   = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const seekFromX = useCallback((clientX: number) => {
    if (!barRef.current || !duration) return
    const r = barRef.current.getBoundingClientRect()
    onSeek(Math.max(0, Math.min(duration, ((clientX - r.left) / r.width) * duration)))
  }, [duration, onSeek])
  useEffect(() => {
    const onMove = (e: MouseEvent) => { if (dragging.current) seekFromX(e.clientX) }
    const onUp   = () => { dragging.current = false }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
  }, [seekFromX])
  if (!duration) return null
  const pct = (v: number) => `${Math.max(0, Math.min(100, (v / duration) * 100))}%`
  return (
    <div ref={barRef} className="relative h-5 cursor-pointer select-none group"
      onMouseDown={e => { dragging.current = true; seekFromX(e.clientX) }}>
      <div className="absolute top-1/2 -translate-y-1/2 inset-x-0 h-1.5 rounded-full bg-zinc-700">
        <div className="absolute inset-y-0 left-0 bg-zinc-400 rounded-full" style={{ width: pct(current) }} />
        <div className="absolute inset-y-0 bg-amber-500/40 rounded-full"
          style={{ left: pct(inPt), right: `${100 - parseFloat(pct(outPt))}%` }} />
      </div>
      <div className="absolute inset-y-0 w-0.5 bg-green-400" style={{ left: pct(inPt) }} />
      <div className="absolute inset-y-0 w-0.5 bg-red-400"   style={{ left: pct(outPt) }} />
      <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3.5 h-3.5 rounded-full bg-white border border-zinc-400 shadow"
        style={{ left: pct(current) }} />
    </div>
  )
}

// ─── SourceBin ────────────────────────────────────────────────────────────────
interface SourceBinProps {
  timelineId: string
  open: boolean
  onToggle: () => void
  onDragStart: () => void
  onDragEnd: () => void
}
function SourceBin({ timelineId, open, onToggle, onDragStart, onDragEnd }: SourceBinProps) {
  const [query,   setQuery]   = useState('')
  const [mode,    setMode]    = useState<'semantic'|'keyword'|'hybrid'>('semantic')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const qc = useQueryClient()

  const doSearch = useCallback(async () => {
    if (!query.trim()) return
    setLoading(true)
    try {
      const res = await api.search({ query: query.trim(), mode, n_results: 20 })
      setResults(res.results)
    } finally { setLoading(false) }
  }, [query, mode])

  const quickAdd = async (r: SearchResult) => {
    const chunk = r.matched_chunks?.[0]
    try {
      await api.addClip(timelineId, {
        video_file_id: r.video_file_id, track: 0,
        in_point: chunk?.start_time, out_point: chunk?.end_time, label: r.filename,
      })
      qc.invalidateQueries(['timeline', timelineId])
      toast.success('Added to timeline')
    } catch { toast.error('Failed to add clip') }
  }

  return (
    <div className={cn(
      'flex-shrink-0 border-r border-surface-4 flex flex-col bg-surface-1 transition-all duration-200 overflow-hidden',
      open ? 'w-56' : 'w-8',
    )}>
      <button onClick={onToggle}
        className="flex items-center gap-1.5 px-2 py-1.5 border-b border-surface-4 hover:bg-surface-3/40 w-full flex-shrink-0 min-h-[28px]">
        {open
          ? <><ChevronDown size={11} className="text-zinc-500 flex-shrink-0" /><span className="text-[10px] font-medium text-zinc-500 uppercase tracking-wide whitespace-nowrap">Source Bin</span></>
          : <Film size={11} className="text-zinc-600 mx-auto" />
        }
      </button>
      {open && (
        <>
          <div className="p-2 space-y-1.5 border-b border-surface-4 flex-shrink-0">
            <div className="relative">
              <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-zinc-500" />
              <input value={query} onChange={e => setQuery(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && doSearch()}
                placeholder="Search footage…"
                className="w-full bg-surface-3 border border-surface-4 rounded pl-6 pr-2 py-1 text-[11px] text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-accent" />
            </div>
            <div className="flex gap-0.5">
              {(['semantic','keyword','hybrid'] as const).map(m => (
                <button key={m} onClick={() => setMode(m)}
                  className={cn('text-[9px] px-1 py-0.5 rounded capitalize flex-1',
                    mode === m ? 'bg-accent text-black font-medium' : 'bg-surface-3 text-zinc-500 hover:text-zinc-300')}>
                  {m}
                </button>
              ))}
            </div>
            <button onClick={doSearch} disabled={loading || !query.trim()}
              className="w-full text-[10px] py-1 rounded bg-accent text-black font-medium hover:bg-accent/90 disabled:opacity-40">
              {loading ? 'Searching…' : 'Search'}
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {!results.length && !loading && (
              <p className="text-[10px] text-zinc-600 text-center mt-6 px-2">Search and drag clips onto the timeline</p>
            )}
            {results.map(r => {
              const chunk   = r.matched_chunks?.[0]
              const hue     = clipHue(r.video_file_id)
              const payload = JSON.stringify({
                video_file_id: r.video_file_id, filename: r.filename,
                in_point:  chunk?.start_time ?? null,
                out_point: chunk?.end_time   ?? null,
              })
              return (
                <div key={r.video_file_id} draggable
                  onDragStart={e => { e.dataTransfer.setData('fb-clip', payload); e.dataTransfer.effectAllowed = 'copy'; onDragStart() }}
                  onDragEnd={onDragEnd}
                  className="border-b border-surface-4 p-2 hover:bg-surface-3/50 cursor-grab active:cursor-grabbing">
                  <div className="relative w-full h-10 rounded overflow-hidden mb-1.5"
                    style={{ background: filmstripBg(hue, 6) }}>
                    <img src={api.thumbnailUrl(r.video_file_id)} alt=""
                      className="absolute inset-0 w-full h-full object-cover mix-blend-overlay opacity-60 pointer-events-none"
                      onError={e => { (e.target as HTMLImageElement).style.display='none' }} />
                    <div className="absolute bottom-0.5 left-1">
                      <span className="text-[8px] font-mono text-zinc-300">{r.duration_seconds ? fmt(r.duration_seconds) : '—'}</span>
                    </div>
                  </div>
                  <p className="text-[10px] text-zinc-200 truncate font-medium">{r.filename}</p>
                  {chunk && <p className="text-[9px] text-zinc-600 truncate italic mt-0.5">"{chunk.text.slice(0,40)}…"</p>}
                  <button onClick={() => quickAdd(r)}
                    className="mt-1 w-full text-[9px] py-0.5 rounded border border-surface-4 bg-surface-2 text-zinc-500 hover:text-zinc-200">
                    + Add
                  </button>
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

// ─── SourceMonitor ────────────────────────────────────────────────────────────
function SourceMonitor({ clip }: { clip: StripClip | null }) {
  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden border-r border-surface-4">
      <div className="px-2 py-1 bg-surface-2 border-b border-surface-4 flex-shrink-0">
        <span className="text-[9px] font-mono text-zinc-600 uppercase tracking-widest">Source</span>
      </div>
      {!clip ? (
        <div className="flex-1 bg-black/40 flex items-center justify-center">
          <Film size={20} className="text-zinc-800" />
        </div>
      ) : (
        <>
          <div className="relative flex-1 min-h-0" style={{ background: filmstripBg(clipHue(clip.id), 8) }}>
            <img src={api.thumbnailUrl(clip.video_file.id)} alt=""
              className="absolute inset-0 w-full h-full object-contain mix-blend-overlay opacity-70 pointer-events-none"
              onError={e => { (e.target as HTMLImageElement).style.opacity='0' }} />
            <div className="absolute bottom-0 inset-x-0 h-8 bg-gradient-to-t from-black/80 to-transparent pointer-events-none" />
            <div className="absolute bottom-1 left-2 flex items-center gap-2">
              <span className="text-[9px] font-mono text-green-400">{fmt(clip.in_point ?? 0)}</span>
              <span className="text-[9px] text-zinc-500">–</span>
              <span className="text-[9px] font-mono text-red-400">{fmt(clip.out_point ?? clip.video_file.duration_seconds)}</span>
            </div>
          </div>
          <div className="px-2 py-1 bg-surface-2 border-t border-surface-4 flex-shrink-0">
            <p className="text-[9px] text-zinc-400 truncate">{clip.label || clip.video_file.filename}</p>
            <p className="text-[9px] font-mono text-zinc-600">{fmt(clipDur(clip))}</p>
          </div>
        </>
      )}
    </div>
  )
}

// ─── ProgramMonitor ───────────────────────────────────────────────────────────
interface ProgramMonitorProps {
  clip: StripClip | null
  videoRef: React.RefObject<HTMLVideoElement>
  currentTime: number
  playing: boolean
  speed: number
  playAllMode: boolean
  onTogglePlay: () => void
  onSetIn: () => void
  onSetOut: () => void
  onSplit: () => void
  onSpeedCycle: () => void
  onSeek: (t: number) => void
  onStartPlayAll: () => void
  onStopPlayAll: () => void
}
function ProgramMonitor({
  clip, videoRef, currentTime, playing, speed, playAllMode,
  onTogglePlay, onSetIn, onSetOut, onSplit, onSpeedCycle, onSeek,
  onStartPlayAll, onStopPlayAll,
}: ProgramMonitorProps) {
  const dur   = clip?.video_file.duration_seconds ?? 0
  const inPt  = clip?.in_point  ?? 0
  const outPt = clip?.out_point ?? dur

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      <div className="px-2 py-1 bg-surface-2 border-b border-surface-4 flex-shrink-0">
        <span className="text-[9px] font-mono text-zinc-600 uppercase tracking-widest">Program</span>
      </div>
      <div className="relative flex-1 min-h-0 bg-black">
        <video ref={videoRef} className="w-full h-full object-contain" />
        {!clip && (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-xs text-zinc-700">Select a clip to preview</p>
          </div>
        )}
        {speed > 1 && (
          <div className="absolute top-1.5 right-1.5 bg-black/70 text-amber-400 text-[10px] font-mono px-1.5 py-0.5 rounded">
            {speed}×
          </div>
        )}
      </div>
      <div className="flex-shrink-0 px-2 py-1.5 bg-surface-1 border-t border-surface-4 space-y-1.5">
        {clip && <Scrubber current={currentTime} duration={dur} inPt={inPt} outPt={outPt} onSeek={onSeek} />}
        <div className="flex items-center gap-1">
          {clip && (
            <button onClick={() => { if (videoRef.current) videoRef.current.currentTime = inPt }}
              className="p-0.5 text-zinc-500 hover:text-zinc-200"><SkipBack size={12} /></button>
          )}
          <button onClick={onTogglePlay} disabled={!clip}
            className="p-1 rounded-full bg-zinc-700 hover:bg-zinc-600 text-white disabled:opacity-30">
            {playing ? <Pause size={12} /> : <Play size={12} />}
          </button>
          <span className="font-mono text-[10px] text-zinc-300">{fmt(currentTime)}</span>
          {clip && <span className="text-[9px] text-zinc-600">/ {fmt(dur)}</span>}
          <div className="ml-auto flex items-center gap-1">
            {playAllMode ? (
              <button onClick={onStopPlayAll}
                className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/20 border border-amber-500/30 text-amber-300 flex items-center gap-0.5">
                <Pause size={9} />Stop
              </button>
            ) : (
              <button onClick={onStartPlayAll} disabled={!clip}
                className="text-[9px] px-1.5 py-0.5 rounded bg-surface-3 border border-surface-4 text-zinc-500 hover:text-zinc-300 flex items-center gap-0.5 disabled:opacity-30">
                <Play size={9} />All
              </button>
            )}
            {clip && (
              <>
                <button onClick={onSpeedCycle}
                  className={cn('text-[9px] font-mono px-1.5 py-0.5 rounded border',
                    speed > 1 ? 'bg-amber-500/20 border-amber-500/40 text-amber-300' : 'bg-surface-3 border-surface-4 text-zinc-500')}>
                  {speed}×
                </button>
                <button onClick={onSetIn}
                  className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-green-500/15 border border-green-500/30 text-green-300">I</button>
                <button onClick={onSetOut}
                  className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-red-500/15 border border-red-500/30 text-red-300">O</button>
                <button onClick={onSplit}
                  className="p-0.5 rounded bg-surface-3 border border-surface-4 text-zinc-400 hover:text-zinc-200">
                  <Scissors size={11} />
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── VideoTrack ───────────────────────────────────────────────────────────────
interface VideoTrackProps {
  clips: StripClip[]
  zoom: number
  selectedId: string | null
  tool: Tool
  dragDisplay: { clipId: string; start: number } | null
  snapLine: number | null
  razorX: number | null
  trimPreview: TrimPreview | null
  totalW: number
  dragOver: boolean
  trackRef: React.RefObject<HTMLDivElement>
  onSelect: (clip: StripClip) => void
  onClipMouseDown: (clip: StripClip, e: React.MouseEvent) => void
  onHandleDown: (clip: StripClip, side: 'in' | 'out', e: React.MouseEvent) => void
  onTrackClick: (e: React.MouseEvent) => void
  onTrackMouseMove: (e: React.MouseEvent) => void
  onTrackMouseLeave: () => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
}
function VideoTrack({
  clips, zoom, selectedId, tool, dragDisplay, snapLine, razorX, trimPreview,
  totalW, dragOver, trackRef,
  onSelect, onClipMouseDown, onHandleDown, onTrackClick, onTrackMouseMove, onTrackMouseLeave,
  onDragOver, onDrop,
}: VideoTrackProps) {
  return (
    <div
      ref={trackRef}
      className={cn(
        'relative h-[68px] bg-surface-1 border-b border-surface-4',
        tool === 'razor' && 'cursor-crosshair',
        tool === 'hand'  && 'cursor-grab',
        dragOver && 'bg-accent/5',
      )}
      style={{ width: `${totalW}px` }}
      onClick={onTrackClick}
      onMouseMove={onTrackMouseMove}
      onMouseLeave={onTrackMouseLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {/* Track label */}
      <div className="absolute left-0 top-0 bottom-0 z-10 flex items-center justify-center bg-surface-0/90 border-r border-surface-4 pointer-events-none"
        style={{ width: `${LABEL_W}px` }}>
        <span className="text-[8px] font-mono text-zinc-600 uppercase tracking-wide">V1</span>
      </div>

      {clips.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center" style={{ paddingLeft: `${LABEL_W}px` }}>
          <p className="text-[10px] text-zinc-700 select-none">Drag clips here</p>
        </div>
      )}

      {clips.map(clip => {
        const displayStart = dragDisplay?.clipId === clip.id ? dragDisplay.start : clip.start
        const inPt    = trimPreview?.clipId === clip.id ? trimPreview.inPt  : (clip.in_point  ?? 0)
        const outPt   = trimPreview?.clipId === clip.id ? trimPreview.outPt : (clip.out_point ?? clip.video_file.duration_seconds ?? 0)
        const clipStart = trimPreview?.clipId === clip.id ? trimPreview.start : displayStart
        const dur     = outPt - inPt
        const w       = Math.max(MIN_W_PX, dur * zoom)
        const selected = selectedId === clip.id
        const hue     = clipHue(clip.id)
        const frames  = Math.max(2, Math.floor(w / 32))

        return (
          <div
            key={clip.id}
            className={cn(
              'absolute top-1.5 bottom-1.5 rounded overflow-hidden select-none',
              'transition-[left] duration-75',
              selected ? 'z-10' : 'z-0',
              tool === 'select' && 'cursor-pointer',
              dragDisplay?.clipId === clip.id && 'opacity-75',
            )}
            style={{
              left: `${clipStart * zoom + LABEL_W}px`,
              width: `${w}px`,
              background: filmstripBg(hue, frames),
            }}
            onClick={e => { if (tool === 'select') { e.stopPropagation(); onSelect(clip) } }}
            onMouseDown={e => { if (tool === 'select') onClipMouseDown(clip, e) }}
          >
            {/* Thumbnail mixed over filmstrip */}
            <img src={api.thumbnailUrl(clip.video_file.id)} alt=""
              className="absolute inset-0 w-full h-full object-cover mix-blend-overlay opacity-50 pointer-events-none"
              onError={e => { (e.target as HTMLImageElement).style.display='none' }} />
            {/* Label + duration */}
            <div className="absolute inset-0 flex flex-col justify-between p-1 bg-gradient-to-b from-black/30 to-black/60 pointer-events-none">
              <p className="text-[8px] text-zinc-100 truncate leading-none font-medium">
                {clip.label || clip.video_file.filename}
              </p>
              <p className="text-[7px] font-mono text-zinc-400">{fmt(dur)}</p>
            </div>
            {/* Selected amber ring */}
            {selected && <div className="absolute inset-0 ring-1 ring-amber-400 rounded pointer-events-none" />}
            {/* Trim handles — only when selected + select tool */}
            {selected && tool === 'select' && (
              <>
                <div
                  className="absolute left-0 top-0 bottom-0 w-2 cursor-col-resize bg-amber-400 hover:bg-amber-300 z-20 rounded-l flex items-center justify-center"
                  onMouseDown={e => { e.stopPropagation(); onHandleDown(clip, 'in', e) }}>
                  <div className="w-px h-4 bg-amber-900/60 rounded-full" />
                </div>
                <div
                  className="absolute right-0 top-0 bottom-0 w-2 cursor-col-resize bg-amber-400 hover:bg-amber-300 z-20 rounded-r flex items-center justify-center"
                  onMouseDown={e => { e.stopPropagation(); onHandleDown(clip, 'out', e) }}>
                  <div className="w-px h-4 bg-amber-900/60 rounded-full" />
                </div>
              </>
            )}
          </div>
        )
      })}

      {/* Snap indicator (cyan) */}
      {snapLine != null && (
        <div className="absolute top-0 bottom-0 w-0.5 bg-cyan-400 z-20 pointer-events-none"
          style={{ left: `${snapLine * zoom + LABEL_W}px` }} />
      )}
      {/* Razor cursor line */}
      {tool === 'razor' && razorX != null && (
        <div className="absolute top-0 bottom-0 w-px bg-red-400/80 z-20 pointer-events-none"
          style={{ left: `${razorX + LABEL_W}px` }} />
      )}
    </div>
  )
}

// ─── AudioTrack ───────────────────────────────────────────────────────────────
function AudioTrack({ clips, zoom, totalW }: { clips: StripClip[]; zoom: number; totalW: number }) {
  const SVG_H = 28
  return (
    <div className="relative bg-surface-0 border-b border-surface-4" style={{ width: `${totalW}px`, height: '36px' }}>
      <div className="absolute left-0 top-0 bottom-0 z-10 flex items-center justify-center bg-surface-0 border-r border-surface-4 pointer-events-none"
        style={{ width: `${LABEL_W}px` }}>
        <span className="text-[8px] font-mono text-zinc-700 uppercase tracking-wide">A1</span>
      </div>
      {clips.map(clip => {
        const dur  = clipDur(clip)
        const w    = Math.max(MIN_W_PX, dur * zoom)
        const hue  = clipHue(clip.id)
        const bars = Math.max(4, Math.floor(w / 3))
        const pts  = audioWavePts(clip.id, bars)
        const barW = w / bars
        return (
          <div key={clip.id}
            className="absolute top-1 bottom-1 rounded overflow-hidden pointer-events-none"
            style={{ left: `${clip.start * zoom + LABEL_W}px`, width: `${w}px`, background: `hsl(${hue},30%,10%)` }}>
            <svg width={w} height={SVG_H} className="absolute inset-0">
              {pts.map((h, i) => (
                <rect key={i}
                  x={i * barW}
                  y={(SVG_H - h) / 2}
                  width={Math.max(1, barW - 1)}
                  height={h}
                  fill={`hsl(${hue},60%,45%)`}
                  opacity={0.75}
                  rx={0.5}
                />
              ))}
            </svg>
          </div>
        )
      })}
    </div>
  )
}

// ─── Ruler ────────────────────────────────────────────────────────────────────
function Ruler({ totalW, zoom, playheadPos }: { totalW: number; zoom: number; playheadPos: number }) {
  const interval = rulerInterval(zoom)
  const count    = Math.ceil(totalW / zoom / interval) + 1
  const marks    = Array.from({ length: count }, (_, i) => i * interval)
  return (
    <div className="relative h-5 bg-surface-0 border-b border-surface-4 select-none flex-shrink-0"
      style={{ width: `${totalW}px` }}>
      {marks.map(t => (
        <div key={t} className="absolute top-0 bottom-0 flex flex-col justify-end"
          style={{ left: `${t * zoom + LABEL_W}px` }}>
          <div className="w-px bg-zinc-700 h-2" />
          <span className="text-[8px] font-mono text-zinc-600 pl-0.5 leading-none pb-0.5">{fmtShort(t)}</span>
        </div>
      ))}
      <div className="absolute top-0 bottom-0 w-0.5 bg-amber-400 z-20 pointer-events-none"
        style={{ left: `${playheadPos * zoom + LABEL_W}px` }}>
        <div className="w-2.5 h-2.5 bg-amber-400 rounded-sm -translate-x-[4px]" />
      </div>
    </div>
  )
}

// ─── ExportMenu ───────────────────────────────────────────────────────────────
function ExportMenu({ timelineId, name }: { timelineId: string; name: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded bg-surface-3 text-zinc-300 hover:bg-surface-2 border border-surface-4">
        <Download size={12} />Export<ChevronRight size={11} className={cn('transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-52 bg-surface-2 border border-surface-4 rounded-lg shadow-xl z-50 overflow-hidden">
          <button onClick={() => { api.exportTimelineEdl(timelineId, name).catch(() => toast.error('Export failed')); setOpen(false) }}
            className="w-full text-left px-3 py-2.5 text-xs text-zinc-300 hover:bg-surface-3 flex flex-col gap-0.5">
            <span className="font-medium">DaVinci Resolve EDL</span>
            <span className="text-[10px] text-zinc-600">CMX 3600 · Main track</span>
          </button>
          <button onClick={() => { api.exportTimelineCsv(timelineId, name).catch(() => toast.error('Export failed')); setOpen(false) }}
            className="w-full text-left px-3 py-2.5 text-xs text-zinc-300 hover:bg-surface-3 flex flex-col gap-0.5 border-t border-surface-4">
            <span className="font-medium">CapCut Reference Sheet</span>
            <span className="text-[10px] text-zinc-600">CSV · file paths + timecodes</span>
          </button>
        </div>
      )}
    </div>
  )
}

// ─── TimelineEditor ───────────────────────────────────────────────────────────
function TimelineEditor({ id }: { id: string }) {
  const navigate = useNavigate()
  const qc       = useQueryClient()

  // ── Player state
  const [selectedId,  setSelectedId]  = useState<string | null>(null)
  const [playing,     setPlaying]     = useState(false)
  const [speed,       setSpeed]       = useState(1)
  const [currentTime, setCurrentTime] = useState(0)
  const [playAllMode, setPlayAllMode] = useState(false)

  // ── Editor state
  const [tool,    setTool]    = useState<Tool>('select')
  const [snap,    setSnap]    = useState(true)
  const [zoom,    setZoom]    = useState(20)
  const [binOpen, setBinOpen] = useState(true)

  // ── Interaction state
  const [dragDisplay, setDragDisplay] = useState<{ clipId: string; start: number } | null>(null)
  const [snapLine,    setSnapLine]    = useState<number | null>(null)
  const [dragOver,    setDragOver]    = useState(false)
  const [razorX,      setRazorX]      = useState<number | null>(null)
  const [trimPreview, setTrimPreview] = useState<TrimPreview | null>(null)

  // ── Local clip state (optimistic)
  const [localClips, setLocalClips] = useState<StripClip[]>([])
  const [past,       setPast]       = useState<UndoEntry[]>([])
  const [future,     setFuture]     = useState<UndoEntry[]>([])
  const initializedRef = useRef(false)

  // ── Rename state
  const [editingName, setEditingName] = useState(false)
  const [nameInput,   setNameInput]   = useState('')

  // ── Refs (for stable callbacks)
  const videoRef        = useRef<HTMLVideoElement>(null)
  const trackRef        = useRef<HTMLDivElement>(null)
  const playAllIdxRef   = useRef(-1)
  const zoomRef         = useRef(zoom); zoomRef.current = zoom
  const snapRef         = useRef(snap); snapRef.current = snap
  const localClipsRef   = useRef(localClips); localClipsRef.current = localClips
  const dragDisplayRef  = useRef(dragDisplay); dragDisplayRef.current = dragDisplay
  const trimPreviewRef  = useRef(trimPreview); trimPreviewRef.current = trimPreview

  // ── Data
  const { data: timeline, isLoading } = useQuery(
    ['timeline', id],
    () => api.getTimeline(id),
    { refetchOnWindowFocus: false },
  )

  // Initialize local state from API (first load only)
  useEffect(() => {
    if (timeline?.clips && !initializedRef.current) {
      initializedRef.current = true
      setLocalClips(resolveStarts(timeline.clips.filter(c => c.track === 0)))
    }
  }, [timeline])

  const selectedClip = useMemo(() => localClips.find(c => c.id === selectedId) ?? null, [localClips, selectedId])
  const totalDur     = useMemo(() => localClips.reduce((s, c) => s + clipDur(c), 0), [localClips])
  const totalEnd     = useMemo(() => localClips.reduce((max, c) => Math.max(max, c.start + clipDur(c)), 0), [localClips])
  const totalW       = Math.max(800, (totalEnd + 30) * zoom)

  const playheadPos = selectedClip
    ? selectedClip.start + Math.max(0, currentTime - (selectedClip.in_point ?? 0))
    : 0

  // ── Undo/redo (read state via refs to avoid nested setState updaters)
  const pastRef   = useRef(past);   pastRef.current   = past
  const futureRef = useRef(future); futureRef.current = future

  const commit = useCallback((updater: (clips: StripClip[]) => StripClip[], label: string) => {
    const current = localClipsRef.current
    setPast(p => [...p.slice(-19), { label, clips: current }])
    setFuture([])
    setLocalClips(updater(current))
  }, [])

  const undo = useCallback(() => {
    const p = pastRef.current
    if (!p.length) return
    const entry = p[p.length - 1]
    const curr  = localClipsRef.current
    setPast(p.slice(0, -1))
    setFuture(f => [...f, { label: entry.label, clips: curr }])
    setLocalClips(entry.clips)
    toast(`↩ ${entry.label}`, { duration: 1500 })
  }, [])

  const redo = useCallback(() => {
    const f = futureRef.current
    if (!f.length) return
    const entry = f[f.length - 1]
    const curr  = localClipsRef.current
    setFuture(f.slice(0, -1))
    setPast(p => [...p, { label: entry.label, clips: curr }])
    setLocalClips(entry.clips)
    toast(`↪ ${entry.label}`, { duration: 1500 })
  }, [])

  // ── Load clip into player
  const loadClip = useCallback((clip: TimelineClip, autoPlay = false) => {
    const v = videoRef.current
    if (!v) return
    v.pause(); setPlaying(false)
    v.src = api.streamUrl(clip.video_file.id)
    const inPt = clip.in_point ?? 0
    v.addEventListener('loadedmetadata', () => {
      v.currentTime = inPt
      setCurrentTime(inPt)
      if (autoPlay) v.play().then(() => setPlaying(true)).catch(() => {})
    }, { once: true })
  }, [])

  // ── Mutations
  const removeMut = useMutation(
    (clipId: string) => api.removeClip(id, clipId),
    {
      onSuccess: (_: void, clipId: string) => {
        commit(clips => clips.filter(c => c.id !== clipId), 'Delete clip')
        if (selectedId === clipId) setSelectedId(null)
      },
      onError: () => { toast.error('Failed to remove clip') },
    },
  )

  const updateMut = useMutation(
    ({ clipId, updates }: { clipId: string; updates: Parameters<typeof api.updateClip>[2] }) =>
      api.updateClip(id, clipId, updates),
  )

  const renameMut = useMutation(
    () => api.updateTimeline(id, { name: nameInput.trim() }),
    { onSuccess: () => { qc.invalidateQueries(['timeline', id]); setEditingName(false) } },
  )

  // ── Player controls
  const togglePlay = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) { v.play().then(() => setPlaying(true)).catch(() => {}) }
    else { v.pause(); setPlaying(false); setSpeed(1); v.playbackRate = 1 }
  }, [])

  const cycleSpeed = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    const idx  = SPEEDS.indexOf(speed)
    const next = SPEEDS[(idx + 1) % SPEEDS.length]
    setSpeed(next); v.playbackRate = next
    if (v.paused) { v.play().then(() => setPlaying(true)).catch(() => {}) }
  }, [speed])

  const handleSetIn = useCallback(() => {
    const v = videoRef.current
    if (!v || !selectedId) return
    const t = v.currentTime
    updateMut.mutate({ clipId: selectedId, updates: { in_point: t } })
    commit(clips => clips.map(c => c.id === selectedId ? { ...c, in_point: t } : c), 'Set in point')
    toast.success(`In → ${fmt(t)}`)
  }, [selectedId, updateMut, commit])

  const handleSetOut = useCallback(() => {
    const v = videoRef.current
    if (!v || !selectedId) return
    const t = v.currentTime
    updateMut.mutate({ clipId: selectedId, updates: { out_point: t } })
    commit(clips => clips.map(c => c.id === selectedId ? { ...c, out_point: t } : c), 'Set out point')
    toast.success(`Out → ${fmt(t)}`)
  }, [selectedId, updateMut, commit])

  const handleSplit = useCallback(async () => {
    const v = videoRef.current
    if (!v || !selectedClip) return
    const t     = v.currentTime
    const inPt  = selectedClip.in_point  ?? 0
    const outPt = selectedClip.out_point ?? (selectedClip.video_file.duration_seconds ?? 0)
    if (t <= inPt + 0.05 || t >= outPt - 0.05) { toast.error('Playhead must be inside the clip'); return }
    try {
      await api.updateClip(id, selectedClip.id, { out_point: t })
      await api.addClip(id, {
        video_file_id: selectedClip.video_file.id, track: 0,
        in_point: t, out_point: outPt,
        timeline_start: selectedClip.start + (t - inPt),
        label: selectedClip.label,
      })
      initializedRef.current = false
      qc.invalidateQueries(['timeline', id])
      toast.success(`Split at ${fmt(t)}`)
    } catch { toast.error('Split failed') }
  }, [selectedClip, id, qc])

  const splitAtTimeline = useCallback(async (clip: StripClip, timelineT: number) => {
    const inPt  = clip.in_point  ?? 0
    const outPt = clip.out_point ?? (clip.video_file.duration_seconds ?? 0)
    const srcT  = inPt + (timelineT - clip.start)
    const clamped = Math.max(inPt + 0.05, Math.min(outPt - 0.05, srcT))
    try {
      await api.updateClip(id, clip.id, { out_point: clamped })
      await api.addClip(id, {
        video_file_id: clip.video_file.id, track: 0,
        in_point: clamped, out_point: outPt,
        timeline_start: clip.start + (clamped - inPt),
        label: clip.label,
      })
      initializedRef.current = false
      qc.invalidateQueries(['timeline', id])
      toast.success(`Split at ${fmt(clamped)}`)
    } catch { toast.error('Split failed') }
  }, [id, qc])

  const deleteSelected = useCallback(() => {
    if (!selectedId) return
    removeMut.mutate(selectedId)
  }, [selectedId, removeMut])

  const duplicateSelected = useCallback(async () => {
    if (!selectedClip) return
    try {
      await api.addClip(id, {
        video_file_id: selectedClip.video_file.id, track: 0,
        in_point:  selectedClip.in_point,
        out_point: selectedClip.out_point,
        timeline_start: selectedClip.start + clipDur(selectedClip) + 0.5,
        label: selectedClip.label,
      })
      initializedRef.current = false
      qc.invalidateQueries(['timeline', id])
      toast.success('Duplicated')
    } catch { toast.error('Duplicate failed') }
  }, [selectedClip, id, qc])

  const handleSeek = useCallback((t: number) => {
    const v = videoRef.current
    if (!v) return
    v.currentTime = t; setCurrentTime(t)
  }, [])

  // ── Play All
  const startPlayAll = useCallback(() => {
    const clips = localClipsRef.current
    if (!clips.length) return
    playAllIdxRef.current = 0
    setPlayAllMode(true)
    setSelectedId(clips[0].id)
    loadClip(clips[0], true)
  }, [loadClip])

  const stopPlayAll = useCallback(() => {
    playAllIdxRef.current = -1
    setPlayAllMode(false)
    videoRef.current?.pause()
    setPlaying(false); setSpeed(1)
    if (videoRef.current) videoRef.current.playbackRate = 1
  }, [])

  // ── timeupdate → Play All advance
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const onUpdate = () => {
      setCurrentTime(v.currentTime)
      if (playAllIdxRef.current < 0) return
      const clips = localClipsRef.current
      const clip  = clips[playAllIdxRef.current]
      if (!clip) return
      const outPt = clip.out_point ?? (clip.video_file.duration_seconds ?? 0)
      if (v.currentTime >= outPt - 0.08) {
        const next = playAllIdxRef.current + 1
        if (next >= clips.length) { stopPlayAll(); return }
        playAllIdxRef.current = next
        setSelectedId(clips[next].id)
        loadClip(clips[next], true)
      }
    }
    v.addEventListener('timeupdate', onUpdate)
    return () => v.removeEventListener('timeupdate', onUpdate)
  }, [loadClip, stopPlayAll])

  // ── Trim handle drag
  const handleHandleDown = useCallback((clip: StripClip, side: 'in' | 'out', e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation()
    const startX    = e.clientX
    const fileDur   = clip.video_file.duration_seconds ?? 0
    const origIn    = clip.in_point  ?? 0
    const origOut   = clip.out_point ?? fileDur
    const origStart = clip.start

    const onMove = (ev: MouseEvent) => {
      const dt = (ev.clientX - startX) / zoomRef.current
      if (side === 'in') {
        const newIn    = Math.max(0, Math.min(origOut - MIN_DUR, origIn + dt))
        const newStart = origStart + (newIn - origIn)
        setTrimPreview({ clipId: clip.id, inPt: newIn, outPt: origOut, start: newStart })
      } else {
        const newOut = Math.max(origIn + MIN_DUR, Math.min(fileDur, origOut + dt))
        setTrimPreview({ clipId: clip.id, inPt: origIn, outPt: newOut, start: origStart })
      }
    }

    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      const preview = trimPreviewRef.current
      if (preview && preview.clipId === clip.id) {
        commit(clips => clips.map(c =>
          c.id === clip.id ? { ...c, in_point: preview.inPt, out_point: preview.outPt, start: preview.start } : c
        ), `Trim ${side === 'in' ? 'in' : 'out'}`)
        api.updateClip(id, clip.id, { in_point: preview.inPt, out_point: preview.outPt, timeline_start: preview.start })
          .catch(() => toast.error('Trim sync failed'))
      }
      setTrimPreview(null)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [id, commit])

  // ── Clip drag (reorder)
  const handleClipMouseDown = useCallback((clip: StripClip, e: React.MouseEvent) => {
    if (e.button !== 0 || tool !== 'select') return
    e.preventDefault()
    const startX   = e.clientX
    const startPos = clip.start
    const dur      = clipDur(clip)
    let moved      = false

    const onMove = (ev: MouseEvent) => {
      if (Math.abs(ev.clientX - startX) < 4 && !moved) return
      moved = true
      const raw    = Math.max(0, startPos + (ev.clientX - startX) / zoomRef.current)
      const others = localClipsRef.current.filter(c => c.id !== clip.id).map(c => ({ start: c.start, dur: clipDur(c) }))
      const { snapped, line } = snapRef.current
        ? snapToEdges(raw, dur, others, SNAP_THR)
        : { snapped: raw, line: null }
      setDragDisplay({ clipId: clip.id, start: snapped })
      setSnapLine(line)
    }

    const onUp = async () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      setSnapLine(null)
      if (!moved) { setDragDisplay(null); return }
      const final = dragDisplayRef.current
      setDragDisplay(null)
      if (final && final.clipId === clip.id && Math.abs(final.start - startPos) > 0.05) {
        commit(clips => clips.map(c => c.id === clip.id ? { ...c, start: final.start } : c), 'Move clip')
        try { await api.updateClip(id, clip.id, { timeline_start: final.start }) }
        catch { toast.error('Failed to move clip') }
      }
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [tool, id, commit])

  // ── Track click (razor split)
  const handleTrackClick = useCallback((e: React.MouseEvent) => {
    if (tool !== 'razor' || !trackRef.current) return
    const rect = trackRef.current.getBoundingClientRect()
    const t    = Math.max(0, (e.clientX - rect.left - LABEL_W) / zoomRef.current)
    const clip = localClipsRef.current.find(c => c.start <= t && c.start + clipDur(c) > t)
    if (clip) splitAtTimeline(clip, t)
  }, [tool, splitAtTimeline])

  const handleTrackMouseMove = useCallback((e: React.MouseEvent) => {
    if (tool !== 'razor' || !trackRef.current) { setRazorX(null); return }
    const rect = trackRef.current.getBoundingClientRect()
    setRazorX(e.clientX - rect.left - LABEL_W)
  }, [tool])

  // ── Drop from bin
  const handleDropTrack = useCallback(async (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false)
    const raw = e.dataTransfer.getData('fb-clip')
    if (!raw) return
    try {
      const p    = JSON.parse(raw)
      const rect = trackRef.current?.getBoundingClientRect()
      const dropT = rect ? Math.max(0, (e.clientX - rect.left - LABEL_W) / zoomRef.current) : 0
      await api.addClip(id, {
        video_file_id: p.video_file_id, track: 0,
        in_point: p.in_point ?? undefined, out_point: p.out_point ?? undefined,
        timeline_start: dropT, label: p.filename,
      })
      initializedRef.current = false
      qc.invalidateQueries(['timeline', id])
      toast.success('Added to timeline')
    } catch { toast.error('Failed to add clip') }
  }, [id, qc])

  // ── Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === ' ')                             { e.preventDefault(); togglePlay() }
      else if (e.key === 'l' || e.key === 'L')      cycleSpeed()
      else if (e.key === 'i' || e.key === 'I')      handleSetIn()
      else if (e.key === 'o' || e.key === 'O')      handleSetOut()
      else if (e.key === 'v' || e.key === 'V')      setTool('select')
      else if (e.key === 'b' || e.key === 'B')      setTool('razor')
      else if (e.key === 'h' || e.key === 'H')      setTool('hand')
      else if (e.key === 's' || e.key === 'S')      setSnap(s => !s)
      else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected()
      else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); undo() }
      else if ((e.metaKey || e.ctrlKey) && e.shiftKey  && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); redo() }
      else if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || e.key === 'Y'))                { e.preventDefault(); redo() }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [togglePlay, cycleSpeed, handleSetIn, handleSetOut, deleteSelected, undo, redo])

  if (isLoading) return <div className="p-8 text-sm text-zinc-500">Loading…</div>
  if (!timeline) return <div className="p-8 text-sm text-zinc-500">Timeline not found.</div>

  const toolLabel = tool === 'select' ? 'Select' : tool === 'razor' ? 'Razor' : 'Hand'

  return (
    <div className="flex flex-col h-full select-none bg-surface-0">

      {/* ── Header ── */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-surface-4 flex-shrink-0 bg-surface-2 min-h-[44px]">
        <button onClick={() => navigate('/timeline')}
          className="text-zinc-500 hover:text-zinc-200 flex items-center gap-1 text-xs">
          <ChevronLeft size={14} />Timelines
        </button>
        <span className="text-zinc-700">/</span>
        {editingName ? (
          <div className="flex items-center gap-2">
            <input autoFocus value={nameInput}
              onChange={e => setNameInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && nameInput.trim()) renameMut.mutate()
                if (e.key === 'Escape') setEditingName(false)
              }}
              className="bg-surface-3 border border-surface-4 rounded px-2 py-0.5 text-sm text-zinc-200 focus:outline-none focus:border-accent" />
            <button onClick={() => nameInput.trim() && renameMut.mutate()} className="p-1 text-accent"><Check size={13} /></button>
            <button onClick={() => setEditingName(false)} className="p-1 text-zinc-500"><X size={13} /></button>
          </div>
        ) : (
          <button onClick={() => { setNameInput(timeline.name); setEditingName(true) }}
            className="flex items-center gap-1.5 text-sm font-semibold text-zinc-100 hover:text-zinc-300">
            {timeline.name}<Pencil size={11} className="text-zinc-600" />
          </button>
        )}
        <div className="ml-auto flex items-center gap-3">
          <span className="flex items-center gap-1 text-xs text-zinc-500">
            <Clock size={11} />{fmt(totalDur)}
          </span>
          <span className="text-xs text-zinc-600">{localClips.length} clips</span>
          <ExportMenu timelineId={id} name={timeline.name} />
        </div>
      </div>

      {/* ── Preview row ── */}
      <div className="flex flex-shrink-0 border-b border-surface-4" style={{ height: '240px' }}>
        <SourceBin
          timelineId={id} open={binOpen} onToggle={() => setBinOpen(o => !o)}
          onDragStart={() => setDragOver(true)} onDragEnd={() => setDragOver(false)}
        />
        <SourceMonitor clip={selectedClip} />
        <ProgramMonitor
          clip={selectedClip} videoRef={videoRef} currentTime={currentTime}
          playing={playing} speed={speed} playAllMode={playAllMode}
          onTogglePlay={togglePlay} onSetIn={handleSetIn} onSetOut={handleSetOut}
          onSplit={handleSplit} onSpeedCycle={cycleSpeed} onSeek={handleSeek}
          onStartPlayAll={startPlayAll} onStopPlayAll={stopPlayAll}
        />
      </div>

      {/* ── Toolbar ── */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-surface-4 bg-surface-2 flex-shrink-0 min-h-[38px]">
        {/* Tools */}
        <div className="flex gap-0.5 pr-2 mr-1 border-r border-surface-4">
          {([
            { t: 'select' as Tool, icon: <MousePointer2 size={13} />, title: 'Select (V)' },
            { t: 'razor'  as Tool, icon: <Scissors size={13} />,      title: 'Razor (B)' },
            { t: 'hand'   as Tool, icon: <Hand size={13} />,           title: 'Hand (H)' },
          ]).map(({ t, icon, title }) => (
            <button key={t} onClick={() => setTool(t)} title={title}
              className={cn('p-1.5 rounded',
                tool === t ? 'bg-accent text-black' : 'text-zinc-500 hover:text-zinc-200 hover:bg-surface-3')}>
              {icon}
            </button>
          ))}
        </div>
        {/* Actions */}
        <div className="flex gap-0.5 pr-2 mr-1 border-r border-surface-4">
          <button onClick={handleSplit} disabled={!selectedClip} title="Split at playhead"
            className="flex items-center gap-1 text-[10px] px-2 py-1 rounded text-zinc-400 hover:text-zinc-200 hover:bg-surface-3 disabled:opacity-30">
            <Scissors size={11} />Split
          </button>
          <button onClick={deleteSelected} disabled={!selectedClip} title="Delete (Del)"
            className="flex items-center gap-1 text-[10px] px-2 py-1 rounded text-zinc-400 hover:text-red-400 hover:bg-surface-3 disabled:opacity-30">
            <Trash2 size={11} />Delete
          </button>
          <button onClick={duplicateSelected} disabled={!selectedClip} title="Duplicate"
            className="flex items-center gap-1 text-[10px] px-2 py-1 rounded text-zinc-400 hover:text-zinc-200 hover:bg-surface-3 disabled:opacity-30">
            <Copy size={11} />Dup
          </button>
        </div>
        {/* Undo/Redo */}
        <div className="flex gap-0.5 pr-2 mr-1 border-r border-surface-4">
          <button onClick={undo} disabled={!past.length} title="Undo (Ctrl+Z)"
            className="flex items-center gap-1 text-[10px] px-2 py-1 rounded text-zinc-400 hover:text-zinc-200 hover:bg-surface-3 disabled:opacity-30">
            <Undo2 size={11} />
            {past.length > 0 && <span className="text-[9px] text-zinc-600">{past.length}</span>}
          </button>
          <button onClick={redo} disabled={!future.length} title="Redo (Ctrl+Shift+Z)"
            className="flex items-center gap-1 text-[10px] px-2 py-1 rounded text-zinc-400 hover:text-zinc-200 hover:bg-surface-3 disabled:opacity-30">
            <Redo2 size={11} />
            {future.length > 0 && <span className="text-[9px] text-zinc-600">{future.length}</span>}
          </button>
        </div>
        {/* Snap */}
        <button onClick={() => setSnap(s => !s)} title="Magnetic snap (S)"
          className={cn('flex items-center gap-1 text-[10px] px-2 py-1 rounded border border-surface-4 mr-2',
            snap ? 'bg-cyan-500/20 border-cyan-500/40 text-cyan-300' : 'text-zinc-500 hover:text-zinc-300')}>
          <Magnet size={11} />Snap
        </button>
        {/* Zoom */}
        <div className="ml-auto flex items-center gap-1">
          <button onClick={() => setZoom(z => Math.max(4, z - 4))} className="p-1 text-zinc-600 hover:text-zinc-300"><ZoomOut size={12} /></button>
          <input type="range" min={4} max={120} value={zoom} onChange={e => setZoom(Number(e.target.value))}
            className="w-20 h-1 accent-amber-500 cursor-pointer" />
          <button onClick={() => setZoom(z => Math.min(120, z + 4))} className="p-1 text-zinc-600 hover:text-zinc-300"><ZoomIn size={12} /></button>
          <span className="text-[9px] font-mono text-zinc-700 w-10">{zoom}px/s</span>
        </div>
      </div>

      {/* ── Timeline ── */}
      <div className="flex-1 overflow-auto bg-surface-0 min-h-0">
        <div style={{ width: `${totalW}px`, position: 'relative' }}>
          <Ruler totalW={totalW} zoom={zoom} playheadPos={playheadPos} />
          <VideoTrack
            clips={localClips} zoom={zoom} selectedId={selectedId} tool={tool}
            dragDisplay={dragDisplay} snapLine={snapLine} razorX={razorX}
            trimPreview={trimPreview} totalW={totalW} dragOver={dragOver}
            trackRef={trackRef}
            onSelect={clip => { setSelectedId(clip.id); if (!playAllMode) loadClip(clip) }}
            onClipMouseDown={handleClipMouseDown}
            onHandleDown={handleHandleDown}
            onTrackClick={handleTrackClick}
            onTrackMouseMove={handleTrackMouseMove}
            onTrackMouseLeave={() => setRazorX(null)}
            onDragOver={e => { e.preventDefault(); setDragOver(true) }}
            onDrop={handleDropTrack}
          />
          <AudioTrack clips={localClips} zoom={zoom} totalW={totalW} />
          {/* Playhead spanning all tracks */}
          <div className="absolute top-0 bottom-0 w-0.5 bg-amber-400/40 pointer-events-none"
            style={{ left: `${playheadPos * zoom + LABEL_W}px` }} />
        </div>
      </div>

      {/* ── Footer ── */}
      <div className="flex items-center gap-3 px-3 border-t border-surface-4 bg-surface-2 flex-shrink-0 text-[9px] text-zinc-600"
        style={{ height: '26px' }}>
        <span className="font-semibold text-zinc-500">{toolLabel}</span>
        <span className="text-zinc-700">|</span>
        {selectedClip ? (
          <>
            <span className="truncate max-w-[160px] text-zinc-500">{selectedClip.label || selectedClip.video_file.filename}</span>
            <span className="font-mono text-zinc-600">{fmt(selectedClip.in_point ?? 0)} – {fmt(selectedClip.out_point ?? selectedClip.video_file.duration_seconds)}</span>
            <span className="font-mono text-zinc-700">{fmt(clipDur(selectedClip))}</span>
          </>
        ) : (
          <span>No clip selected</span>
        )}
        <div className="ml-auto flex items-center gap-2.5">
          {([['Space','play'],['V','select'],['B','razor'],['I/O','trim'],['Del','delete'],['⌘Z','undo']] as const).map(([k,l]) => (
            <span key={k} className="flex items-center gap-0.5">
              <kbd className="bg-surface-3 border border-surface-5 px-0.5 rounded font-mono text-zinc-600">{k}</kbd>
              <span>{l}</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── TimelineList ─────────────────────────────────────────────────────────────
function TimelineList() {
  const navigate = useNavigate()
  const qc       = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [newName,  setNewName]  = useState('')

  const { data: timelines = [], isLoading } = useQuery('timelines', api.listTimelines)

  const createMut = useMutation(
    () => api.createTimeline(newName.trim()),
    {
      onSuccess: tl => {
        qc.invalidateQueries('timelines')
        setCreating(false); setNewName('')
        navigate(`/timeline/${tl.id}`)
      },
      onError: () => { toast.error('Failed to create timeline') },
    },
  )

  const deleteMut = useMutation(
    (tlId: string) => api.deleteTimeline(tlId),
    { onSuccess: () => { qc.invalidateQueries('timelines'); toast.success('Deleted') } },
  )

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-lg font-semibold text-zinc-100">Timelines</h1>
        {!creating && (
          <button onClick={() => setCreating(true)}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded bg-accent text-black font-medium hover:bg-accent/90">
            <Plus size={13} />New Timeline
          </button>
        )}
      </div>

      {creating && (
        <div className="mb-4 flex gap-2">
          <input autoFocus value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && newName.trim()) createMut.mutate()
              if (e.key === 'Escape') { setCreating(false); setNewName('') }
            }}
            placeholder="Timeline name…"
            className="flex-1 bg-surface-3 border border-surface-4 rounded px-3 py-1.5 text-sm text-zinc-200 focus:outline-none focus:border-accent" />
          <button onClick={() => newName.trim() && createMut.mutate()}
            disabled={!newName.trim() || createMut.isLoading}
            className="px-3 py-1.5 rounded bg-accent text-black text-xs font-medium disabled:opacity-40">
            <Check size={13} />
          </button>
          <button onClick={() => { setCreating(false); setNewName('') }}
            className="px-3 py-1.5 rounded bg-surface-3 text-zinc-400 text-xs">
            <X size={13} />
          </button>
        </div>
      )}

      {isLoading && <p className="text-sm text-zinc-500">Loading…</p>}
      {!isLoading && !timelines.length && (
        <div className="text-center py-16 text-zinc-600">
          <Film size={32} className="mx-auto mb-3 opacity-40" />
          <p className="text-sm">No timelines yet. Create one to start building a rough cut.</p>
        </div>
      )}

      <div className="space-y-2">
        {timelines.map(tl => (
          <div key={tl.id} onClick={() => navigate(`/timeline/${tl.id}`)}
            className="flex items-center gap-3 px-4 py-3 rounded-lg bg-surface-2 border border-surface-4 hover:border-zinc-600 cursor-pointer group">
            <Film size={16} className="text-accent flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm text-zinc-200 font-medium truncate">{tl.name}</p>
              {tl.description && <p className="text-xs text-zinc-500 truncate">{tl.description}</p>}
              <p className="text-[10px] text-zinc-600 mt-0.5">{tl.clip_count} clip{tl.clip_count !== 1 ? 's' : ''}</p>
            </div>
            <button onClick={e => { e.stopPropagation(); if (confirm(`Delete "${tl.name}"?`)) deleteMut.mutate(tl.id) }}
              className="p-1.5 text-zinc-600 hover:text-red-400 opacity-0 group-hover:opacity-100">
              <Trash2 size={14} />
            </button>
            <ChevronRight size={14} className="text-zinc-600" />
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Page router ──────────────────────────────────────────────────────────────
export default function TimelinePage() {
  const { id } = useParams<{ id?: string }>()
  if (id) return <TimelineEditor id={id} />
  return <TimelineList />
}
