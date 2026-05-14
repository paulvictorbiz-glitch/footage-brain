import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { Link } from 'react-router-dom'
import { Copy, CheckCircle2, ChevronRight, HardDrive, Loader2, X, GitCompare } from 'lucide-react'
import toast from 'react-hot-toast'
import { api, type DuplicateGroup, type VideoFile } from '@/api/client'
import { PageHeader } from '@/components/PageHeader'
import { formatBytes, formatDuration, formatDate, cn } from '@/lib/utils'

function FileRow({
  file,
  isCanonical,
  onSetCanonical,
}: {
  file: VideoFile
  isCanonical: boolean
  onSetCanonical: () => void
}) {
  return (
    <div className={cn(
      'flex items-center gap-3 py-2.5 px-3 rounded hover:bg-surface-3 transition-colors',
      isCanonical && 'bg-green-900/10 border border-green-900/30'
    )}>
      <img
        src={api.thumbnailUrl(file.id)}
        alt={file.filename}
        className="w-16 h-10 object-cover rounded bg-surface-3 flex-shrink-0"
        onError={(e) => { e.currentTarget.style.display = 'none' }}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <Link
            to={`/files/${file.id}`}
            className="text-sm text-zinc-200 truncate hover:text-accent transition-colors"
          >
            {file.filename}
          </Link>
          {isCanonical && (
            <span className="flex items-center gap-1 text-xs text-green-400 flex-shrink-0">
              <CheckCircle2 size={11} /> Canonical
            </span>
          )}
        </div>
        <p className="text-xs text-zinc-500 truncate mt-0.5">{file.abs_path}</p>
        <div className="flex items-center gap-3 mt-1 text-xs text-zinc-600">
          {file.duration_seconds && <span>{formatDuration(file.duration_seconds)}</span>}
          <span>{formatBytes(file.file_size)}</span>
          {file.width && file.height && <span>{file.width}×{file.height}</span>}
          <span>{formatDate(file.created_time ?? undefined)}</span>
        </div>
      </div>
      <button
        className={cn(
          'btn text-xs flex-shrink-0 transition-colors',
          isCanonical
            ? 'bg-green-900/30 text-green-400 cursor-default'
            : 'btn-ghost hover:bg-surface-4'
        )}
        onClick={onSetCanonical}
        disabled={isCanonical}
      >
        {isCanonical ? 'Canonical' : 'Set canonical'}
      </button>
    </div>
  )
}

function CompareModal({
  group,
  onClose,
}: {
  group: DuplicateGroup
  onClose: () => void
}) {
  const qc = useQueryClient()
  const setCanonicalMut = useMutation(
    (fileId: string) => api.setCanonical(group.id, fileId),
    {
      onSuccess: () => {
        qc.invalidateQueries('duplicates')
        toast.success('Canonical file updated')
        onClose()
      },
      onError: () => { toast.error('Failed to update canonical') },
    }
  )

  const files = group.files.slice(0, 2)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80" onClick={onClose}>
      <div
        className="relative w-full max-w-5xl mx-4 bg-surface-1 border border-surface-4 rounded-lg overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-surface-4">
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-200">
            <GitCompare size={14} className="text-zinc-400" />
            Compare Duplicates
          </div>
          <button className="btn-ghost p-1" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="grid grid-cols-2 divide-x divide-surface-4 overflow-auto max-h-[80vh]">
          {files.map((file) => {
            const isCanonical = file.id === group.canonical_file_id || file.is_canonical
            return (
              <div key={file.id} className="p-5 flex flex-col gap-4">
                <div className="aspect-video bg-surface-3 rounded overflow-hidden">
                  <img
                    src={api.thumbnailUrl(file.id)}
                    alt={file.filename}
                    className="w-full h-full object-cover"
                    onError={(e) => { e.currentTarget.style.display = 'none' }}
                  />
                </div>

                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <p className="text-sm font-medium text-zinc-200 truncate">{file.filename}</p>
                    {isCanonical && (
                      <span className="flex items-center gap-1 text-xs text-green-400 flex-shrink-0">
                        <CheckCircle2 size={11} /> Canonical
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-zinc-500 break-all">{file.abs_path}</p>
                </div>

                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                  <div className="text-zinc-500">Size</div>
                  <div className="text-zinc-300 font-mono">{formatBytes(file.file_size)}</div>
                  <div className="text-zinc-500">Duration</div>
                  <div className="text-zinc-300 font-mono">{formatDuration(file.duration_seconds ?? undefined)}</div>
                  <div className="text-zinc-500">Resolution</div>
                  <div className="text-zinc-300 font-mono">
                    {file.width && file.height ? `${file.width}×${file.height}` : '--'}
                  </div>
                  <div className="text-zinc-500">Codec</div>
                  <div className="text-zinc-300 font-mono">{file.video_codec ?? '--'}</div>
                  <div className="text-zinc-500">Created</div>
                  <div className="text-zinc-300 font-mono">{formatDate(file.created_time ?? undefined)}</div>
                </div>

                <button
                  className={cn(
                    'btn text-xs w-full transition-colors',
                    isCanonical
                      ? 'bg-green-900/30 text-green-400 cursor-default'
                      : 'btn-ghost hover:bg-surface-4'
                  )}
                  onClick={() => { if (!isCanonical) setCanonicalMut.mutate(file.id) }}
                  disabled={isCanonical || setCanonicalMut.isLoading}
                >
                  {isCanonical ? 'Canonical' : 'Set as Canonical'}
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function DuplicateGroupCard({
  group,
  onCompare,
}: {
  group: DuplicateGroup
  onCompare: (group: DuplicateGroup) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const qc = useQueryClient()

  const setCanonicalMut = useMutation(
    (fileId: string) => api.setCanonical(group.id, fileId),
    {
      onSuccess: () => {
        qc.invalidateQueries('duplicates')
        toast.success('Canonical file updated')
      },
      onError: () => { toast.error('Failed to update canonical') },
    }
  )

  const nonCanonicalSize = group.files
    .filter((f) => !f.is_canonical)
    .reduce((acc, f) => acc + f.file_size, 0)

  return (
    <div className="card overflow-hidden">
      <button
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-surface-3 transition-colors text-left"
        onClick={() => setExpanded(!expanded)}
      >
        <Copy size={14} className="text-orange-400 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium text-zinc-200">
              {group.file_count} copies
            </span>
            <span className="text-xs text-zinc-500 font-mono">{group.sha256.slice(0, 16)}…</span>
          </div>
          <p className="text-xs text-zinc-500 mt-0.5">
            {formatBytes(nonCanonicalSize)} potentially recoverable
          </p>
        </div>
        {group.file_count >= 2 && (
          <button
            className="btn-ghost text-xs flex items-center gap-1 flex-shrink-0 mr-1"
            onClick={(e) => { e.stopPropagation(); onCompare(group) }}
          >
            <GitCompare size={12} />
            Compare
          </button>
        )}
        <ChevronRight
          size={14}
          className={cn('text-zinc-600 transition-transform', expanded && 'rotate-90')}
        />
      </button>

      {expanded && (
        <div className="border-t border-surface-4 p-3 space-y-1 animate-slide-up">
          {group.files.map((f) => (
            <FileRow
              key={f.id}
              file={f}
              isCanonical={f.id === group.canonical_file_id || f.is_canonical}
              onSetCanonical={() => setCanonicalMut.mutate(f.id)}
            />
          ))}
          <div className="pt-2 px-3 flex items-center gap-2 text-xs text-zinc-600">
            <HardDrive size={11} />
            <span>
              Preview-only mode · No files will be moved or deleted automatically
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

export default function DuplicatesPage() {
  const [offset, setOffset] = useState(0)
  const limit = 30
  const [compareGroup, setCompareGroup] = useState<DuplicateGroup | null>(null)

  const { data: groups, isLoading } = useQuery(
    ['duplicates', offset],
    () => api.getDuplicateGroups({ limit, offset }),
    { keepPreviousData: true }
  )

  const { data: summary } = useQuery('duplicates-summary', () => api.getDuplicatesSummary())

  return (
    <div className="flex flex-col h-full">
      {compareGroup && (
        <CompareModal group={compareGroup} onClose={() => setCompareGroup(null)} />
      )}
      <PageHeader
        title="Duplicate Manager"
        subtitle="Files grouped by identical SHA256 hash across all sources"
      />

      <div className="flex-1 overflow-auto p-6 space-y-4">
        {/* Summary */}
        {summary && (
          <div className="grid grid-cols-3 gap-3">
            <div className="card p-3 text-center">
              <p className="text-2xl font-display font-semibold text-orange-400">
                {summary.total_groups}
              </p>
              <p className="text-xs text-zinc-500 mt-1">Duplicate groups</p>
            </div>
            <div className="card p-3 text-center">
              <p className="text-2xl font-display font-semibold text-zinc-200">
                {summary.total_duplicate_files}
              </p>
              <p className="text-xs text-zinc-500 mt-1">Duplicate files</p>
            </div>
            <div className="card p-3 text-center">
              <p className="text-2xl font-display font-semibold text-zinc-200">
                {formatBytes(summary.wasted_bytes)}
              </p>
              <p className="text-xs text-zinc-500 mt-1">Potentially recoverable</p>
            </div>
          </div>
        )}

        {/* Groups list */}
        {isLoading && (
          <div className="flex items-center justify-center py-10">
            <Loader2 size={20} className="animate-spin text-zinc-600" />
          </div>
        )}

        {groups?.length === 0 && !isLoading && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Copy size={32} className="text-zinc-700 mb-3" />
            <p className="text-zinc-400">No duplicates found</p>
            <p className="text-zinc-600 text-sm mt-1">
              Run a scan and ensure hashing is complete to detect duplicates.
            </p>
          </div>
        )}

        <div className="space-y-2">
          {groups?.map((g) => (
            <DuplicateGroupCard key={g.id} group={g} onCompare={setCompareGroup} />
          ))}
        </div>

        {/* Pagination */}
        {groups && groups.length === limit && (
          <div className="flex justify-center">
            <button
              className="btn-ghost"
              onClick={() => setOffset(offset + limit)}
            >
              Load more
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
