import { useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import {
  ChevronLeft, Film, Copy, Play, Pause, Volume2, VolumeX,
  HardDrive, Tag, RefreshCw, CheckCircle2, Clock, Loader2,
} from 'lucide-react'
import toast from 'react-hot-toast'
import { api, type TranscriptChunk } from '@/api/client'
import { PageHeader } from '@/components/PageHeader'
import {
  formatBytes, formatDuration, formatTimecode, formatDate, extensionColor, pipelineStatus, cn
} from '@/lib/utils'

function PipelineBadge({ file }: { file: Parameters<typeof pipelineStatus>[0] }) {
  const { label, color } = pipelineStatus(file)
  return <span className={cn('text-xs', color)}>{label}</span>
}

function MetaRow({ label, value }: { label: string; value?: string | number | null }) {
  if (!value && value !== 0) return null
  return (
    <div className="flex gap-3 py-1.5 border-b border-surface-4 last:border-0">
      <span className="text-xs text-zinc-500 w-28 flex-shrink-0">{label}</span>
      <span className="text-xs text-zinc-300 font-mono break-all">{String(value)}</span>
    </div>
  )
}

function TranscriptPanel({
  chunks,
  onSeek,
  activeChunkId,
}: {
  chunks: TranscriptChunk[]
  onSeek: (t: number) => void
  activeChunkId?: string
}) {
  if (chunks.length === 0)
    return <p className="text-xs text-zinc-600 p-4">No transcript available</p>

  return (
    <div className="overflow-y-auto max-h-full">
      {chunks.map((c) => (
        <button
          key={c.id}
          onClick={() => onSeek(c.start_time)}
          className={cn(
            'w-full text-left px-4 py-2.5 flex gap-3 hover:bg-surface-3 transition-colors border-b border-surface-4/50 last:border-0',
            activeChunkId === c.id && 'bg-surface-3'
          )}
        >
          <span className="text-xs font-mono text-amber-400/80 flex-shrink-0 pt-0.5 w-14">
            {formatTimecode(c.start_time)}
          </span>
          <span className="text-xs text-zinc-300 leading-relaxed">{c.text}</span>
        </button>
      ))}
    </div>
  )
}

function JobsPanel({ fileId }: { fileId: string }) {
  const { data: jobs } = useQuery(['file-jobs', fileId], () => api.getFileJobs(fileId), {
    refetchInterval: 3000,
  })
  const qc = useQueryClient()
  const reprocessMut = useMutation((stages?: string[]) => api.reprocessFile(fileId, stages), {
    onSuccess: () => {
      toast.success('Re-queued for processing')
      qc.invalidateQueries(['file-jobs', fileId])
      qc.invalidateQueries(['file', fileId])
    },
  })

  const stageOrder = ['metadata', 'hash', 'thumbnail', 'transcript', 'embed', 'clip_embed']

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <p className="label">Pipeline Stages</p>
        <button
          className="btn-ghost text-xs"
          onClick={() => reprocessMut.mutate(undefined)}
          disabled={reprocessMut.isLoading}
        >
          <RefreshCw size={11} className={cn(reprocessMut.isLoading && 'animate-spin')} />
          Reprocess
        </button>
      </div>
      <div className="space-y-1">
        {stageOrder.map((stage) => {
          const job = jobs?.find((j) => j.stage === stage)
          const status = job?.status ?? 'not queued'
          return (
            <div key={stage} className="flex items-center justify-between text-xs py-1">
              <span className="text-zinc-400 capitalize">{stage}</span>
              <span className={cn(
                'font-mono',
                status === 'done' ? 'text-green-400' :
                status === 'failed' ? 'text-red-400' :
                status === 'processing' ? 'text-amber-400 animate-pulse' :
                'text-zinc-600'
              )}>
                {status}
                {job?.attempts && job.attempts > 1 ? ` (${job.attempts}x)` : ''}
              </span>
            </div>
          )
        })}
      </div>
      {jobs?.filter(j => j.status === 'failed').map((j) => (
        j.error_message && (
          <div key={j.id} className="text-xs text-red-400/80 bg-red-900/20 rounded p-2">
            {j.stage}: {j.error_message}
          </div>
        )
      ))}
    </div>
  )
}

export default function FileDetailPage() {
  const { fileId } = useParams<{ fileId: string }>()
  const qc = useQueryClient()
  const [seekTime, setSeekTime] = useState<number | null>(null)
  const [activePanel, setActivePanel] = useState<'transcript' | 'meta' | 'jobs' | 'dupes'>('transcript')
  const videoRef = useState<HTMLVideoElement | null>(null)
  const [currentTime, setCurrentTime] = useState<number>(0)

  const { data: file, isLoading } = useQuery(
    ['file', fileId],
    () => api.getFile(fileId!),
    { enabled: !!fileId }
  )

  const { data: transcript } = useQuery(
    ['transcript', fileId],
    () => api.getTranscript(fileId!),
    { enabled: !!fileId }
  )

  const updateMut = useMutation(
    (updates: { project_tag?: string; is_canonical?: boolean }) => api.updateFile(fileId!, updates),
    {
      onSuccess: () => {
        qc.invalidateQueries(['file', fileId])
        toast.success('Updated')
      },
    }
  )

  const [tagInput, setTagInput] = useState('')

  const handleSeek = (t: number) => {
    const v = document.getElementById('video-player') as HTMLVideoElement | null
    if (v) {
      v.currentTime = t
      v.play()
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 size={24} className="animate-spin text-zinc-600" />
      </div>
    )
  }

  if (!file) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <Film size={32} className="text-zinc-700" />
        <p className="text-zinc-400">File not found</p>
        <Link to="/search" className="btn-ghost">← Back</Link>
      </div>
    )
  }

  const panels: string[] = ['transcript', 'meta', 'jobs']
  if (file.duplicate_group_id) panels.push('dupes')

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title={file.filename}
        subtitle={file.abs_path}
        actions={
          <Link to="/search" className="btn-ghost text-xs">
            <ChevronLeft size={13} /> Back
          </Link>
        }
      />

      <div className="flex flex-1 overflow-hidden">
        {/* Video + player */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Video */}
          <div className="bg-black flex items-center justify-center" style={{ maxHeight: '55vh' }}>
            <video
              id="video-player"
              controls
              className="max-h-full max-w-full outline-none"
              src={api.streamUrl(file.id)}
              style={{ maxHeight: '55vh' }}
              onTimeUpdate={(e) => setCurrentTime((e.target as HTMLVideoElement).currentTime)}
            />
          </div>

          {/* Timeline heatmap */}
          {transcript && transcript.length > 0 && file.duration_seconds && (
            <div className="bg-surface-1 border-t border-surface-4 px-4 py-3">
              <div className="flex items-center gap-2 mb-2">
                <Clock size={12} className="text-zinc-500" />
                <span className="text-xs text-zinc-400">Transcript Timeline</span>
              </div>
              <div
                className="relative h-6 bg-surface-3 rounded overflow-hidden cursor-crosshair"
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect()
                  const pct = (e.clientX - rect.left) / rect.width
                  const t = pct * file.duration_seconds!
                  setCurrentTime(t)
                  const v = document.getElementById('video-player') as HTMLVideoElement | null
                  if (v) { v.currentTime = t }
                }}
              >
                {(() => {
                  const wordCounts = transcript.map((c) => c.text.trim().split(/\s+/).length)
                  const maxWords = Math.max(...wordCounts, 1)
                  return transcript.map((chunk, i) => {
                    const startPercent = (chunk.start_time / file.duration_seconds!) * 100
                    const duration = chunk.end_time - chunk.start_time
                    const widthPercent = (duration / file.duration_seconds!) * 100
                    const intensity = wordCounts[i] / maxWords
                    const opacity = 0.25 + intensity * 0.75
                    return (
                      <button
                        key={chunk.id}
                        onClick={(e) => { e.stopPropagation(); handleSeek(chunk.start_time) }}
                        className="absolute top-0 h-full transition-colors hover:brightness-125"
                        style={{
                          left: `${startPercent}%`,
                          width: `${Math.max(widthPercent, 0.5)}%`,
                          backgroundColor: `rgba(251, 191, 36, ${opacity})`,
                        }}
                        title={`${formatTimecode(chunk.start_time)}: ${chunk.text.slice(0, 50)}...`}
                      />
                    )
                  })
                })()}
                {file.duration_seconds > 0 && (
                  <div
                    className="absolute top-0 h-full w-0.5 bg-white/80 pointer-events-none z-10"
                    style={{ left: `${(currentTime / file.duration_seconds!) * 100}%` }}
                  />
                )}
              </div>
              <div className="flex justify-between text-xs text-zinc-600 mt-1">
                <span>0:00</span>
                <span className="text-zinc-400 font-mono">{formatTimecode(currentTime)}</span>
                <span>{formatDuration(file.duration_seconds)}</span>
              </div>
            </div>
          )}

          {/* File info strip */}
          <div className="border-t border-b border-surface-4 px-4 py-2 flex items-center gap-4 flex-wrap text-xs text-zinc-500 bg-surface-2">
            <span className={cn('badge', extensionColor(file.extension))}>{file.extension.replace('.', '')}</span>
            {file.duration_seconds && <span>{formatDuration(file.duration_seconds)}</span>}
            {file.width && file.height && <span>{file.width}×{file.height}</span>}
            {file.fps && <span>{file.fps.toFixed(2)} fps</span>}
            {file.video_codec && <span>{file.video_codec}</span>}
            <span>{formatBytes(file.file_size)}</span>
            {file.has_audio ? <Volume2 size={12} /> : <VolumeX size={12} />}
            <PipelineBadge file={file} />
            {file.duplicate_group_id && (
              <span className="flex items-center gap-1 text-orange-400">
                <Copy size={11} /> Duplicate
              </span>
            )}
            {file.is_canonical && (
              <span className="flex items-center gap-1 text-green-400">
                <CheckCircle2 size={11} /> Canonical
              </span>
            )}
          </div>

          {/* Tags */}
          <div className="px-4 py-2 border-b border-surface-4 flex items-center gap-2">
            <Tag size={12} className="text-zinc-600" />
            <input
              type="text"
              placeholder="Add project tag…"
              className="input flex-1 text-xs py-1"
              value={tagInput || file.project_tag || ''}
              onChange={(e) => setTagInput(e.target.value)}
              onBlur={() => {
                if (tagInput && tagInput !== file.project_tag) {
                  updateMut.mutate({ project_tag: tagInput })
                  setTagInput('')
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  updateMut.mutate({ project_tag: tagInput })
                  setTagInput('')
                  e.currentTarget.blur()
                }
              }}
            />
          </div>
        </div>

        {/* Right panel */}
        <div className="w-80 flex-shrink-0 flex flex-col border-l border-surface-4 bg-surface-2">
          {/* Panel tabs */}
          <div className="flex border-b border-surface-4">
            {(['transcript', 'meta', 'jobs'] as const).map((p) => (
              <button
                key={p}
                className={cn(
                  'flex-1 py-2 text-xs font-medium capitalize border-b-2 transition-colors',
                  activePanel === p
                    ? 'border-accent text-zinc-100'
                    : 'border-transparent text-zinc-500 hover:text-zinc-300'
                )}
                onClick={() => setActivePanel(p)}
              >
                {p}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-auto">
            {activePanel === 'transcript' && (
              <TranscriptPanel
                chunks={transcript ?? []}
                onSeek={handleSeek}
              />
            )}
            {activePanel === 'meta' && (
              <div className="p-4">
                <MetaRow label="Path" value={file.abs_path} />
                <MetaRow label="Size" value={formatBytes(file.file_size)} />
                <MetaRow label="Duration" value={formatDuration(file.duration_seconds ?? undefined)} />
                <MetaRow label="Resolution" value={file.width && file.height ? `${file.width}×${file.height}` : null} />
                <MetaRow label="FPS" value={file.fps?.toFixed(3)} />
                <MetaRow label="Video codec" value={file.video_codec} />
                <MetaRow label="Audio codec" value={file.audio_codec} />
                <MetaRow label="Bitrate" value={file.bit_rate ? `${Math.round(file.bit_rate / 1000)} kbps` : null} />
                <MetaRow label="Aspect ratio" value={file.aspect_ratio} />
                <MetaRow label="Orientation" value={file.is_vertical ? 'Vertical' : 'Horizontal'} />
                <MetaRow label="SHA256" value={file.sha256?.slice(0, 16) + '…'} />
                <MetaRow label="Created" value={formatDate(file.created_time ?? undefined)} />
                <MetaRow label="Modified" value={formatDate(file.modified_time ?? undefined)} />
                <MetaRow label="Archive status" value={file.archive_status} />
              </div>
            )}
            {activePanel === 'jobs' && <JobsPanel fileId={file.id} />}
          </div>
        </div>
      </div>
    </div>
  )
}
