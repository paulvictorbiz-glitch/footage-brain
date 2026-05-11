/**
 * Timeline editor — CapCut-style rough cut builder.
 * Main track only. Drag clips, trim with I/O, split with B, preview all.
 */
import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import toast from 'react-hot-toast'
import {
  Plus, Trash2, Download, ChevronLeft, Pencil, Check, X,
  Search, Clock, Film, ChevronRight, ZoomIn, ZoomOut,
  Scissors, Play, Pause, SkipBack,
} from 'lucide-react'
import { api, TimelineClip, SearchResult } from '@/api/client'
import { cn } from '@/lib/utils'

// ─── Constants ────────────────────────────────────────────────────────────────

const SPEEDS   = [1, 2, 4, 8]
const SNAP_S   = 0.5   // snap threshold in seconds
const MIN_W_PX = 40    // minimum clip block width

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

// Resolve display positions — handle legacy clips with no timeline_start
function resolveStarts(clips: TimelineClip[]): Array<TimelineClip & { start: number }> {
  // Sort by timeline_start if set, else by position
  const sorted = [...clips].sort((a, b) => {
    if (a.timeline_start != null && b.timeline_start != null)
      return a.timeline_start - b.timeline_start
    return (a.position ?? 0) - (b.position ?? 0)
  })

  // If no clip has timeline_start, or they'd all be at 0, spread sequentially
  const anySet = sorted.some(c => c.timeline_start != null && c.timeline_start > 0)
  if (!anySet) {
    let pos = 0
    return sorted.map(c => { const s = pos; pos += clipDur(c); return { ...c, start: s } })
  }
  return sorted.map(c => ({ ...c, start: c.timeline_start ?? 0 }))
}

function snap(
  rawStart: number,
  dur: number,
  others: Array<{ start: number; dur: number }>,
  threshold: number,
): { snapped: number; line: number | null } {
  const rawEnd = rawStart + dur
  for (const o of others) {
    const oEnd = o.start + o.dur
    if (Math.abs(rawStart - oEnd)   < threshold) return { snapped: oEnd,          line: oEnd }
    if (Math.abs(rawStart - o.start) < threshold) return { snapped: o.start,       line: o.start }
    if (Math.abs(rawEnd   - o.start) < threshold) return { snapped: o.start - dur, line: o.start }
    if (Math.abs(rawEnd   - oEnd)   < threshold)  return { snapped: oEnd - dur,    line: oEnd }
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

// ─── Scrubber ─────────────────────────────────────────────────────────────────

interface ScrubberProps {
  current: number
  duration: number
  inPt: number
  outPt: number
  onSeek: (t: number) => void
}

function Scrubber({ current, duration, inPt, outPt, onSeek }: ScrubberProps) {
  const barRef   = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)

  const seekFromX = useCallback((clientX: number) => {
    if (!barRef.current || !duration) return
    const r = barRef.current.getBoundingClientRect()
    const t = Math.max(0, Math.min(duration, ((clientX - r.left) / r.width) * duration))
    onSeek(t)
  }, [duration, onSeek])

  useEffect(() => {
    const onMove = (e: MouseEvent) => { if (dragging.current) seekFromX(e.clientX) }
    const onUp   = () => { dragging.current = false }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup',   onUp)
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
  }, [seekFromX])

  if (!duration) return null
  const pct  = (v: number) => `${Math.max(0, Math.min(100, (v / duration) * 100))}%`

  return (
    <div
      ref={barRef}
      className="relative h-5 cursor-pointer select-none group"
      onMouseDown={e => { dragging.current = true; seekFromX(e.clientX) }}
    >
      {/* Track */}
      <div className="absolute top-1/2 -translate-y-1/2 inset-x-0 h-1.5 rounded-full bg-zinc-700">
        {/* Played */}
        <div className="absolute inset-y-0 left-0 bg-zinc-400 rounded-full" style={{ width: pct(current) }} />
        {/* In→Out region */}
        <div className="absolute inset-y-0 bg-amber-500/40 rounded-full"
          style={{ left: pct(inPt), right: `${100 - parseFloat(pct(outPt))}%` }} />
      </div>
      {/* In marker */}
      <div className="absolute inset-y-0 w-0.5 bg-green-400" style={{ left: pct(inPt) }} />
      {/* Out marker */}
      <div className="absolute inset-y-0 w-0.5 bg-red-400"   style={{ left: pct(outPt) }} />
      {/* Thumb */}
      <div
        className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3.5 h-3.5 rounded-full bg-white border border-zinc-400 shadow group-hover:scale-110 transition-transform"
        style={{ left: pct(current) }}
      />
    </div>
  )
}

// ─── SearchPanel ──────────────────────────────────────────────────────────────

interface SearchPanelProps {
  timelineId: string
  onDragStart: () => void
  onDragEnd: () => void
}

function SearchPanel({ timelineId, onDragStart, onDragEnd }: SearchPanelProps) {
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
        in_point:  chunk?.start_time, out_point: chunk?.end_time,
        label: r.filename,
      })
      qc.invalidateQueries(['timeline', timelineId])
      toast.success('Added to timeline')
    } catch { toast.error('Failed to add clip') }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Controls */}
      <div className="p-3 space-y-2 border-b border-surface-4 flex-shrink-0">
        <div className="relative">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500" />
          <input
            value={query} onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && doSearch()}
            placeholder="Search footage…"
            className="w-full bg-surface-3 border border-surface-4 rounded pl-8 pr-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-accent"
          />
        </div>
        <div className="flex gap-1">
          {(['semantic','keyword','hybrid'] as const).map(m => (
            <button key={m} onClick={() => setMode(m)}
              className={cn('text-[10px] px-2 py-0.5 rounded capitalize flex-1',
                mode === m ? 'bg-accent text-black font-medium' : 'bg-surface-3 text-zinc-500 hover:text-zinc-300')}>
              {m}
            </button>
          ))}
        </div>
        <button onClick={doSearch} disabled={loading || !query.trim()}
          className="w-full text-xs py-1.5 rounded bg-accent text-black font-medium hover:bg-accent/90 disabled:opacity-40">
          {loading ? 'Searching…' : 'Search'}
        </button>
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto">
        {!results.length && !loading && (
          <p className="text-[10px] text-zinc-600 text-center mt-8 px-3">
            Search and drag results onto the timeline
          </p>
        )}
        {results.map(r => {
          const chunk = r.matched_chunks?.[0]
          const payload = JSON.stringify({
            video_file_id: r.video_file_id, filename: r.filename,
            in_point:  chunk?.start_time ?? null,
            out_point: chunk?.end_time   ?? null,
          })
          return (
            <div key={r.video_file_id}
              draggable
              onDragStart={e => { e.dataTransfer.setData('fb-clip', payload); e.dataTransfer.effectAllowed = 'copy'; onDragStart() }}
              onDragEnd={onDragEnd}
              className="border-b border-surface-4 p-2 hover:bg-surface-3/50 cursor-grab active:cursor-grabbing"
            >
              <div className="flex gap-2 mb-1.5">
                <div className="w-14 h-9 bg-black rounded overflow-hidden flex-shrink-0">
                  <img src={api.thumbnailUrl(r.video_file_id)} alt=""
                    className="w-full h-full object-cover"
                    onError={e => { (e.target as HTMLImageElement).style.display='none' }} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] text-zinc-200 truncate font-medium leading-tight">{r.filename}</p>
                  <p className="text-[10px] text-zinc-500">
                    {r.duration_seconds ? fmt(r.duration_seconds) : '—'}
                    {chunk ? ` · ${fmt(chunk.start_time)}–${fmt(chunk.end_time)}` : ''}
                  </p>
                  {chunk && <p className="text-[9px] text-zinc-600 truncate italic mt-0.5">"{chunk.text.slice(0,50)}…"</p>}
                </div>
              </div>
              <button onClick={() => quickAdd(r)}
                className="w-full text-[9px] py-0.5 rounded border border-surface-4 bg-surface-2 text-zinc-500 hover:text-zinc-200 hover:border-zinc-500">
                + Add to timeline
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── VideoPreview ─────────────────────────────────────────────────────────────

interface VideoPreviewProps {
  clip:          TimelineClip | null
  videoRef:      React.RefObject<HTMLVideoElement>
  currentTime:   number
  playing:       boolean
  speed:         number
  onTogglePlay:  () => void
  onSetIn:       () => void
  onSetOut:      () => void
  onSplit:       () => void
  onSpeedCycle:  () => void
  onSeek:        (t: number) => void
}

function VideoPreview({ clip, videoRef, currentTime, playing, speed, onTogglePlay, onSetIn, onSetOut, onSplit, onSpeedCycle, onSeek }: VideoPreviewProps) {
  if (!clip) return (
    <div className="flex-1 flex items-center justify-center bg-black/30 rounded-lg">
      <div className="text-center">
        <Film size={28} className="mx-auto mb-2 text-zinc-700" />
        <p className="text-xs text-zinc-600">Click a clip or drag one onto the timeline</p>
      </div>
    </div>
  )

  const dur   = clip.video_file.duration_seconds ?? 0
  const inPt  = clip.in_point  ?? 0
  const outPt = clip.out_point ?? dur

  return (
    <div className="flex flex-col gap-2 h-full">
      {/* Video */}
      <div className="relative bg-black rounded-lg overflow-hidden flex-1 min-h-0">
        <video ref={videoRef} src={api.streamUrl(clip.video_file.id)}
          className="w-full h-full object-contain"
          onEnded={() => {}} />
        {speed > 1 && (
          <div className="absolute top-2 right-2 bg-black/70 text-amber-400 text-xs font-mono px-1.5 py-0.5 rounded">
            {speed}×
          </div>
        )}
      </div>

      {/* Scrubber */}
      <Scrubber current={currentTime} duration={dur} inPt={inPt} outPt={outPt} onSeek={onSeek} />

      {/* Timecode + controls */}
      <div className="flex items-center gap-2 flex-shrink-0">
        <button onClick={() => { if (videoRef.current) videoRef.current.currentTime = inPt }}
          className="p-1 text-zinc-500 hover:text-zinc-200" title="Jump to in">
          <SkipBack size={13} />
        </button>
        <button onClick={onTogglePlay}
          className="p-1.5 rounded-full bg-zinc-700 hover:bg-zinc-600 text-white" title="Play/Pause (Space)">
          {playing ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <span className="font-mono text-[11px] text-zinc-300">{fmt(currentTime)}</span>
        <span className="text-[10px] text-zinc-600">/ {fmt(dur)}</span>

        <div className="ml-auto flex items-center gap-1">
          <button onClick={onSpeedCycle}
            className={cn('text-[10px] font-mono px-2 py-0.5 rounded border transition-colors',
              speed > 1 ? 'bg-amber-500/20 border-amber-500/40 text-amber-300' : 'bg-surface-3 border-surface-4 text-zinc-500 hover:text-zinc-300')}
            title="Cycle speed (L)">
            {speed}×
          </button>
          <button onClick={onSetIn}
            className="text-[10px] font-mono px-2 py-0.5 rounded bg-green-500/15 border border-green-500/30 text-green-300 hover:bg-green-500/25"
            title="Set in-point (I)">
            I {fmt(inPt)}
          </button>
          <button onClick={onSetOut}
            className="text-[10px] font-mono px-2 py-0.5 rounded bg-red-500/15 border border-red-500/30 text-red-300 hover:bg-red-500/25"
            title="Set out-point (O)">
            O {fmt(outPt)}
          </button>
          <button onClick={onSplit}
            className="p-1 rounded bg-surface-3 border border-surface-4 text-zinc-400 hover:text-zinc-200"
            title="Split at playhead (B)">
            <Scissors size={12} />
          </button>
        </div>
      </div>

      {/* Filename */}
      <p className="text-[10px] text-zinc-600 truncate flex-shrink-0">{clip.video_file.filename}</p>
    </div>
  )
}

// ─── TimelineStrip ────────────────────────────────────────────────────────────

interface StripClip extends TimelineClip { start: number }

interface TimelineStripProps {
  timelineId:  string
  clips:       StripClip[]
  zoom:        number
  selectedId:  string | null
  playheadPos: number
  dragOver:    boolean
  onSelect:    (clip: StripClip) => void
  onRemove:    (clipId: string) => void
  onDragOverTrack: (e: React.DragEvent) => void
  onDropTrack:     (e: React.DragEvent) => void
  onClipMouseDown: (clip: StripClip, e: React.MouseEvent) => void
  dragDisplay: { clipId: string; start: number } | null
  snapLine:    number | null
}

function TimelineStrip({
  timelineId, clips, zoom, selectedId, playheadPos,
  dragOver, onSelect, onRemove, onDragOverTrack, onDropTrack, onClipMouseDown,
  dragDisplay, snapLine,
}: TimelineStripProps) {
  const totalEnd = clips.reduce((max, c) => Math.max(max, c.start + clipDur(c)), 0)
  const totalW   = Math.max(800, (totalEnd + 30) * zoom)

  const interval = rulerInterval(zoom)
  const marks: number[] = []
  for (let t = 0; t <= totalEnd + 30; t += interval) marks.push(t)

  return (
    <div className="relative overflow-x-auto overflow-y-hidden flex-1 min-w-0">
      <div style={{ width: `${totalW}px`, position: 'relative', minHeight: '96px' }}>

        {/* Ruler */}
        <div className="h-5 bg-surface-0 border-b border-surface-4 relative select-none">
          {marks.map(t => (
            <div key={t} className="absolute top-0 bottom-0 flex flex-col justify-end"
              style={{ left: `${t * zoom}px` }}>
              <div className="w-px bg-zinc-700 h-2" />
              <span className="text-[8px] font-mono text-zinc-600 pl-0.5 leading-none pb-0.5">
                {fmtShort(t)}
              </span>
            </div>
          ))}
        </div>

        {/* Track lane */}
        <div
          className={cn(
            'relative h-[68px] bg-surface-1 border-b border-surface-4 transition-colors',
            dragOver && 'bg-accent/5 border-accent/30',
          )}
          onDragOver={onDragOverTrack}
          onDrop={onDropTrack}
          onDragLeave={e => { e.currentTarget === e.target && void 0 }}
        >
          {/* Track label */}
          <div className="absolute left-0 top-0 bottom-0 w-12 flex items-center justify-center z-10 bg-surface-0/80 border-r border-surface-4">
            <span className="text-[8px] font-mono text-zinc-600 rotate-0 uppercase tracking-wide">Main</span>
          </div>

          {/* Empty hint */}
          {clips.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center pl-12">
              <p className="text-[10px] text-zinc-700 select-none">Drag clips here</p>
            </div>
          )}

          {/* Clip blocks */}
          {clips.map(clip => {
            const displayStart = dragDisplay?.clipId === clip.id ? dragDisplay.start : clip.start
            const w = Math.max(MIN_W_PX, clipDur(clip) * zoom)
            const selected = selectedId === clip.id

            return (
              <div
                key={clip.id}
                className={cn(
                  'absolute top-1.5 bottom-1.5 rounded border cursor-pointer group overflow-hidden select-none',
                  'bg-surface-2/80 transition-[left] duration-75',
                  selected ? 'ring-1 ring-amber-400 border-amber-500/60 z-10' : 'border-surface-4 hover:border-zinc-500',
                  dragDisplay?.clipId === clip.id && 'opacity-80',
                )}
                style={{ left: `${displayStart * zoom + 48}px`, width: `${w}px` }}
                onClick={() => onSelect(clip)}
                onMouseDown={e => onClipMouseDown(clip, e)}
              >
                {/* Thumbnail bg */}
                <img src={api.thumbnailUrl(clip.video_file.id)} alt=""
                  className="absolute inset-0 w-full h-full object-cover opacity-35 pointer-events-none"
                  onError={e => { (e.target as HTMLImageElement).style.display='none' }} />
                {/* Overlay */}
                <div className="absolute inset-0 flex flex-col justify-between p-1 bg-gradient-to-b from-black/40 to-black/70 pointer-events-none">
                  <p className="text-[8px] text-zinc-100 truncate font-medium leading-none">
                    {clip.label || clip.video_file.filename}
                  </p>
                  <p className="text-[7px] font-mono text-zinc-400">{fmt(clipDur(clip))}</p>
                </div>
                {/* Delete button */}
                <button
                  onClick={e => { e.stopPropagation(); onRemove(clip.id) }}
                  className="absolute top-0.5 right-0.5 p-0.5 text-zinc-600 hover:text-red-400 opacity-0 group-hover:opacity-100 bg-black/50 rounded pointer-events-auto z-20">
                  <X size={9} />
                </button>
              </div>
            )
          })}

          {/* Snap indicator */}
          {snapLine != null && (
            <div className="absolute top-0 bottom-0 w-0.5 bg-accent z-20 pointer-events-none"
              style={{ left: `${snapLine * zoom + 48}px` }} />
          )}
        </div>

        {/* Playhead */}
        <div className="absolute top-0 bottom-0 w-0.5 bg-amber-400 z-30 pointer-events-none"
          style={{ left: `${playheadPos * zoom + 48}px` }}>
          <div className="w-2.5 h-2.5 bg-amber-400 rounded-full -translate-x-[4px] -translate-y-px" />
        </div>
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
  const navigate  = useNavigate()
  const qc        = useQueryClient()

  // ── Player state
  const [selectedId,   setSelectedId]   = useState<string | null>(null)
  const [playing,      setPlaying]      = useState(false)
  const [speed,        setSpeed]        = useState(1)
  const [currentTime,  setCurrentTime]  = useState(0)
  const [playAllMode,  setPlayAllMode]  = useState(false)

  // ── Timeline state
  const [zoom,         setZoom]         = useState(20)
  const [dragDisplay,  setDragDisplay]  = useState<{ clipId: string; start: number } | null>(null)
  const [snapLine,     setSnapLine]     = useState<number | null>(null)
  const [dragOver,     setDragOver]     = useState(false)

  // ── Rename state
  const [editingName,  setEditingName]  = useState(false)
  const [nameInput,    setNameInput]    = useState('')

  // ── Refs to avoid stale closures
  const videoRef       = useRef<HTMLVideoElement>(null)
  const playAllIdxRef  = useRef(-1)
  const zoomRef        = useRef(zoom)
  zoomRef.current      = zoom
  const dragDisplayRef = useRef(dragDisplay)
  dragDisplayRef.current = dragDisplay

  // ── Data
  const { data: timeline, isLoading } = useQuery(
    ['timeline', id],
    () => api.getTimeline(id),
    { refetchOnWindowFocus: false }
  )

  const displayClips = useMemo(
    () => resolveStarts((timeline?.clips ?? []).filter(c => c.track === 0)),
    [timeline?.clips]
  )
  const displayClipsRef = useRef(displayClips)
  displayClipsRef.current = displayClips

  const selectedClip = displayClips.find(c => c.id === selectedId) ?? null

  // Playhead: position in timeline seconds
  const playheadPos = selectedClip
    ? (selectedClip.start) + Math.max(0, currentTime - (selectedClip.in_point ?? 0))
    : 0

  // ── Load clip into player (imperative — does not go through useEffect)
  const loadClip = useCallback((clip: TimelineClip, autoPlay = false) => {
    const v = videoRef.current
    if (!v) return
    const wasPlaying = !v.paused
    v.pause()
    setPlaying(false)
    v.src = api.streamUrl(clip.video_file.id)
    const inPt = clip.in_point ?? 0
    const onLoaded = () => {
      v.currentTime = inPt
      setCurrentTime(inPt)
      if (autoPlay) v.play().then(() => setPlaying(true)).catch(() => {})
    }
    v.addEventListener('loadedmetadata', onLoaded, { once: true })
  }, [])

  // ── Mutations
  const removeMut = useMutation(
    (clipId: string) => api.removeClip(id, clipId),
    {
      onSuccess: (_: void, clipId: string) => {
        qc.invalidateQueries(['timeline', id])
        if (selectedId === clipId) setSelectedId(null)
      },
      onError: () => { toast.error('Failed to remove clip') },
    }
  )

  const updateMut = useMutation(
    ({ clipId, updates }: { clipId: string; updates: Parameters<typeof api.updateClip>[2] }) =>
      api.updateClip(id, clipId, updates),
    { onSuccess: () => qc.invalidateQueries(['timeline', id]) }
  )

  const renameMut = useMutation(
    () => api.updateTimeline(id, { name: nameInput.trim() }),
    { onSuccess: () => { qc.invalidateQueries(['timeline', id]); setEditingName(false) } }
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
    setSpeed(next)
    v.playbackRate = next
    if (next === 1 && !v.paused) { /* keep playing */ }
    else if (v.paused) { v.play().then(() => setPlaying(true)).catch(() => {}) }
  }, [speed])

  const handleSetIn = useCallback(() => {
    const v = videoRef.current
    if (!v || !selectedId) return
    updateMut.mutate({ clipId: selectedId, updates: { in_point: v.currentTime } })
    toast.success(`In → ${fmt(v.currentTime)}`)
  }, [selectedId, updateMut])

  const handleSetOut = useCallback(() => {
    const v = videoRef.current
    if (!v || !selectedId) return
    updateMut.mutate({ clipId: selectedId, updates: { out_point: v.currentTime } })
    toast.success(`Out → ${fmt(v.currentTime)}`)
  }, [selectedId, updateMut])

  const handleSplit = useCallback(async () => {
    const v = videoRef.current
    if (!v || !selectedClip) return
    const t    = v.currentTime
    const inPt = selectedClip.in_point  ?? 0
    const outPt= selectedClip.out_point ?? (selectedClip.video_file.duration_seconds ?? 0)
    if (t <= inPt + 0.05 || t >= outPt - 0.05) { toast.error('Playhead must be inside the clip'); return }
    try {
      await api.updateClip(id, selectedClip.id, { out_point: t })
      await api.addClip(id, {
        video_file_id: selectedClip.video_file.id,
        track: 0,
        in_point:       t,
        out_point:      outPt,
        timeline_start: selectedClip.start + (t - inPt),
        label:          selectedClip.label,
      })
      qc.invalidateQueries(['timeline', id])
      toast.success(`Split at ${fmt(t)}`)
    } catch { toast.error('Split failed') }
  }, [selectedClip, id, qc])

  const handleSeek = useCallback((t: number) => {
    const v = videoRef.current
    if (!v) return
    v.currentTime = t
    setCurrentTime(t)
  }, [])

  // ── Play All
  const startPlayAll = useCallback(() => {
    const clips = displayClipsRef.current
    if (!clips.length) return
    const first = clips[0]
    playAllIdxRef.current = 0
    setPlayAllMode(true)
    setSelectedId(first.id)
    loadClip(first, true)
  }, [loadClip])

  const stopPlayAll = useCallback(() => {
    playAllIdxRef.current = -1
    setPlayAllMode(false)
    videoRef.current?.pause()
    setPlaying(false)
    setSpeed(1)
    if (videoRef.current) videoRef.current.playbackRate = 1
  }, [])

  // ── timeupdate handler
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const onUpdate = () => {
      setCurrentTime(v.currentTime)
      // Play-all advance logic
      if (playAllIdxRef.current < 0) return
      const clips = displayClipsRef.current
      const clip  = clips[playAllIdxRef.current]
      if (!clip) return
      const outPt = clip.out_point ?? (clip.video_file.duration_seconds ?? 0)
      if (v.currentTime >= outPt - 0.08) {
        const next = playAllIdxRef.current + 1
        if (next >= clips.length) { stopPlayAll(); return }
        const nextClip = clips[next]
        playAllIdxRef.current = next
        setSelectedId(nextClip.id)
        loadClip(nextClip, true)
      }
    }
    v.addEventListener('timeupdate', onUpdate)
    return () => v.removeEventListener('timeupdate', onUpdate)
  }, [loadClip, stopPlayAll])

  // ── Clip drag on timeline
  const handleClipMouseDown = useCallback((clip: StripClip, e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    const startX   = e.clientX
    const startPos = clip.start
    const dur      = clipDur(clip)
    let moved      = false

    const onMove = (ev: MouseEvent) => {
      if (Math.abs(ev.clientX - startX) < 4) return
      moved = true
      const raw     = Math.max(0, startPos + (ev.clientX - startX) / zoomRef.current)
      const others  = displayClipsRef.current
        .filter(c => c.id !== clip.id)
        .map(c => ({ start: c.start, dur: clipDur(c) }))
      const { snapped, line } = snap(raw, dur, others, SNAP_S)
      setDragDisplay({ clipId: clip.id, start: snapped })
      setSnapLine(line)
    }

    const onUp = async () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup',   onUp)
      setSnapLine(null)
      if (!moved) { setDragDisplay(null); return }
      const final = dragDisplayRef.current
      setDragDisplay(null)
      if (final && final.clipId === clip.id && Math.abs(final.start - startPos) > 0.05) {
        try {
          await api.updateClip(id, clip.id, { timeline_start: final.start })
          qc.invalidateQueries(['timeline', id])
        } catch { toast.error('Failed to move clip') }
      }
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup',   onUp)
  }, [id, qc])

  // ── Drop from search panel onto track
  const handleDropTrack = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const raw = e.dataTransfer.getData('fb-clip')
    if (!raw) return
    try {
      const p = JSON.parse(raw)
      // Calculate drop position from event X
      const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect()
      const dropT = Math.max(0, (e.clientX - rect.left - 48) / zoomRef.current)
      await api.addClip(id, {
        video_file_id: p.video_file_id, track: 0,
        in_point:       p.in_point  ?? undefined,
        out_point:      p.out_point ?? undefined,
        timeline_start: dropT,
        label:          p.filename,
      })
      qc.invalidateQueries(['timeline', id])
      toast.success('Added to timeline')
    } catch { toast.error('Failed to add clip') }
  }, [id, qc])

  // ── Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === ' ')           { e.preventDefault(); togglePlay() }
      else if (e.key === 'l' || e.key === 'L') cycleSpeed()
      else if (e.key === 'i' || e.key === 'I') handleSetIn()
      else if (e.key === 'o' || e.key === 'O') handleSetOut()
      else if (e.key === 'b' || e.key === 'B') handleSplit()
      else if (e.key === 'Delete') { if (selectedId) removeMut.mutate(selectedId) }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [togglePlay, cycleSpeed, handleSetIn, handleSetOut, handleSplit, selectedId, removeMut])

  const totalDur = displayClips.reduce((s, c) => s + clipDur(c), 0)

  if (isLoading) return <div className="p-8 text-sm text-zinc-500">Loading…</div>
  if (!timeline) return <div className="p-8 text-sm text-zinc-500">Timeline not found.</div>

  return (
    <div className="flex flex-col h-full select-none">

      {/* ── Header ── */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-surface-4 flex-shrink-0 bg-surface-2">
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
              className="bg-surface-3 border border-surface-4 rounded px-2 py-1 text-sm text-zinc-200 focus:outline-none focus:border-accent" />
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
          <span className="text-xs text-zinc-600">{displayClips.length} clips</span>
          <ExportMenu timelineId={id} name={timeline.name} />
        </div>
      </div>

      {/* ── Middle: search + preview ── */}
      <div className="flex flex-1 overflow-hidden min-h-0">

        {/* Search panel */}
        <div className="w-60 flex-shrink-0 border-r border-surface-4 flex flex-col bg-surface-1">
          <div className="px-3 py-2 border-b border-surface-4 flex-shrink-0">
            <p className="text-[10px] font-medium text-zinc-500 uppercase tracking-wide">Search & Drag</p>
          </div>
          <SearchPanel timelineId={id}
            onDragStart={() => setDragOver(true)}
            onDragEnd={() => setDragOver(false)} />
        </div>

        {/* Preview */}
        <div className="flex-1 p-3 flex flex-col bg-surface-1 min-w-0 overflow-hidden">
          <VideoPreview
            clip={selectedClip}
            videoRef={videoRef}
            currentTime={currentTime}
            playing={playing}
            speed={speed}
            onTogglePlay={togglePlay}
            onSetIn={handleSetIn}
            onSetOut={handleSetOut}
            onSplit={handleSplit}
            onSpeedCycle={cycleSpeed}
            onSeek={handleSeek}
          />
        </div>
      </div>

      {/* ── Timeline section ── */}
      <div className="flex-shrink-0 bg-surface-0 border-t border-surface-4" style={{ height: '130px' }}>
        {/* Controls bar */}
        <div className="flex items-center gap-3 px-3 py-1.5 border-b border-surface-4">
          {/* Zoom */}
          <div className="flex items-center gap-1">
            <button onClick={() => setZoom(z => Math.max(4, z - 4))} className="p-0.5 text-zinc-600 hover:text-zinc-300"><ZoomOut size={12} /></button>
            <span className="text-[9px] font-mono text-zinc-700 w-10 text-center">{zoom}px/s</span>
            <button onClick={() => setZoom(z => Math.min(100, z + 4))} className="p-0.5 text-zinc-600 hover:text-zinc-300"><ZoomIn size={12} /></button>
          </div>

          {/* Play All */}
          {playAllMode ? (
            <button onClick={stopPlayAll}
              className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded bg-amber-500/20 border border-amber-500/30 text-amber-300 hover:bg-amber-500/30">
              <Pause size={10} />Stop Preview
            </button>
          ) : (
            <button onClick={startPlayAll} disabled={!displayClips.length}
              className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded bg-surface-3 border border-surface-4 text-zinc-400 hover:text-zinc-200 disabled:opacity-30">
              <Play size={10} />Preview All
            </button>
          )}

          {/* Keyboard hints */}
          <div className="ml-auto flex items-center gap-2">
            {[['Space','play'],['L','speed'],['I','in'],['O','out'],['B','split'],['Del','remove']].map(([k,l]) => (
              <span key={k} className="flex items-center gap-0.5 text-[8px] text-zinc-700">
                <kbd className="bg-surface-3 border border-surface-5 px-0.5 rounded text-zinc-600 font-mono">{k}</kbd>{l}
              </span>
            ))}
          </div>
        </div>

        {/* Strip */}
        <div className="flex h-[88px]">
          <TimelineStrip
            timelineId={id}
            clips={displayClips}
            zoom={zoom}
            selectedId={selectedId}
            playheadPos={playheadPos}
            dragOver={dragOver}
            onSelect={clip => { setSelectedId(clip.id); if (!playAllMode) loadClip(clip) }}
            onRemove={clipId => removeMut.mutate(clipId)}
            onDragOverTrack={e => { e.preventDefault(); setDragOver(true) }}
            onDropTrack={handleDropTrack}
            onClipMouseDown={handleClipMouseDown}
            dragDisplay={dragDisplay}
            snapLine={snapLine}
          />
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
    }
  )

  const deleteMut = useMutation(
    (tlId: string) => api.deleteTimeline(tlId),
    { onSuccess: () => { qc.invalidateQueries('timelines'); toast.success('Deleted') } }
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
