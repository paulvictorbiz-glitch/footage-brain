import { Link } from 'react-router-dom'
import { Copy, Volume2, VolumeX, Eye } from 'lucide-react'
import type { SearchResult, VideoFile } from '@/api/client'
import { api } from '@/api/client'
import {
  cn,
  formatBytes,
  formatDuration,
  formatTimecode,
  extensionColor,
  scoreColor,
  pipelineStatus,
} from '@/lib/utils'

interface VideoCardProps {
  result?: SearchResult
  file?: VideoFile
  className?: string
  frameTimestamp?: number
}

export function VideoCard({ result, file: fileProp, className, frameTimestamp }: VideoCardProps) {
  // Normalise to a unified shape
  const id = result?.video_file_id ?? fileProp?.id ?? ''
  const filename = result?.filename ?? fileProp?.filename ?? ''
  const extension = result?.extension ?? fileProp?.extension ?? ''
  const duration = result?.duration_seconds ?? fileProp?.duration_seconds
  const thumbFileId = id
  const width = result?.width ?? fileProp?.width
  const height = result?.height ?? fileProp?.height
  const hasAudio = result?.has_audio ?? fileProp?.has_audio ?? false
  const isDuplicate = !!(result?.duplicate_group_id ?? fileProp?.duplicate_group_id)
  const isCanonical = result?.is_canonical ?? fileProp?.is_canonical ?? false
  const score = result?.best_score
  const topChunk = result?.matched_chunks?.[0]
  const projectTag = result?.project_tag ?? fileProp?.project_tag

  const status = fileProp ? pipelineStatus(fileProp) : null

  return (
    <Link
      to={`/files/${id}`}
      className={cn(
        'group card overflow-hidden flex flex-col hover:border-surface-5 transition-colors duration-150 animate-fade-in',
        className
      )}
    >
      {/* Thumbnail */}
      <div className="relative aspect-video bg-surface-3 overflow-hidden flex-shrink-0">
        <img
          src={api.thumbnailUrl(thumbFileId)}
          alt={filename}
          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          onError={(e) => {
            e.currentTarget.style.display = 'none'
          }}
        />
        {/* Duration badge */}
        {duration && (
          <span className="absolute bottom-1.5 right-1.5 bg-black/70 text-white text-xs px-1.5 py-0.5 rounded font-mono">
            {formatDuration(duration)}
          </span>
        )}
        {/* Resolution */}
        {width && height && (
          <span className="absolute bottom-1.5 left-1.5 bg-black/70 text-zinc-300 text-xs px-1.5 py-0.5 rounded font-mono">
            {width}×{height}
          </span>
        )}
        {/* Duplicate badge */}
        {isDuplicate && (
          <span className="absolute top-1.5 right-1.5 bg-orange-500/90 rounded p-0.5">
            <Copy size={10} className="text-white" />
          </span>
        )}
        {/* Score */}
        {score !== undefined && score > 0 && (
          <span className={cn('absolute top-1.5 left-1.5 bg-black/70 text-xs px-1.5 py-0.5 rounded font-mono', scoreColor(score))}>
            {(score * 100).toFixed(0)}%
          </span>
        )}
        {/* Visual frame match badge */}
        {frameTimestamp !== undefined && (
          <span className="absolute top-1.5 right-8 bg-violet-900/80 text-violet-300 text-xs px-1.5 py-0.5 rounded flex items-center gap-1">
            <Eye size={9} />
            {formatTimecode(frameTimestamp)}
          </span>
        )}
      </div>

      {/* Info */}
      <div className="p-2.5 flex flex-col gap-1.5 flex-1">
        <div className="flex items-start gap-1.5 min-w-0">
          <span className={cn('badge flex-shrink-0', extensionColor(extension))}>
            {extension.replace('.', '')}
          </span>
          <span className="text-xs text-zinc-200 font-medium truncate leading-tight">{filename}</span>
        </div>

        {/* Matched chunk text */}
        {topChunk && !frameTimestamp && (
          <div className="bg-surface-3 rounded p-1.5 text-xs text-zinc-400 line-clamp-2 leading-relaxed">
            <span className="text-amber-400/80 font-mono mr-1.5">{formatTimecode(topChunk.start_time)}</span>
            {topChunk.text}
          </div>
        )}
        {/* Visual frame match info */}
        {frameTimestamp !== undefined && (
          <div className="bg-violet-950/40 rounded p-1.5 text-xs text-violet-300 flex items-center gap-1.5">
            <Eye size={10} className="flex-shrink-0" />
            <span>Visual match at {formatTimecode(frameTimestamp)}</span>
          </div>
        )}

        {/* Meta row */}
        <div className="flex items-center gap-2 mt-auto">
          {hasAudio ? (
            <Volume2 size={11} className="text-zinc-500" />
          ) : (
            <VolumeX size={11} className="text-zinc-600" />
          )}
          {projectTag && (
            <span className="text-xs text-zinc-500 truncate">#{projectTag}</span>
          )}
          {status && (
            <span className={cn('text-xs ml-auto', status.color)}>{status.label}</span>
          )}
        </div>
      </div>
    </Link>
  )
}
