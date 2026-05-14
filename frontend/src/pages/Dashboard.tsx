import { useQuery, useMutation, useQueryClient } from 'react-query'
import {
  Film, HardDrive, Copy, Clock, RefreshCw,
  AlertTriangle, Zap, Tag, CheckCircle2,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import toast from 'react-hot-toast'
import { api } from '@/api/client'
import { PageHeader } from '@/components/PageHeader'
import { StatCard } from '@/components/StatCard'
import { VideoCard } from '@/components/VideoCard'
import { ThermalCard } from '@/components/ThermalCard'
import { formatBytes, cn } from '@/lib/utils'

function StorageBar({ bytes, maxBytes, label }: { bytes: number; maxBytes: number; label: string }) {
  const pct = maxBytes > 0 ? Math.max(2, (bytes / maxBytes) * 100) : 0
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-zinc-400 truncate w-40 flex-shrink-0">{label}</span>
      <div className="flex-1 h-1.5 bg-surface-3 rounded-full overflow-hidden">
        <div className="h-full bg-accent/60 rounded-full" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-zinc-500 font-mono w-16 text-right flex-shrink-0">
        {formatBytes(bytes)}
      </span>
    </div>
  )
}

function DriveHealthCard() {
  const { data } = useQuery('storage-stats', () => api.getStorageStats(), { refetchInterval: 30000 })
  if (!data) return null
  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <p className="label">Drive Health</p>
        <span className="text-xs text-zinc-500">App: {formatBytes(data.app_storage.total_bytes)}</span>
      </div>
      {data.warnings?.length > 0 && (
        <div className="space-y-1">
          {data.warnings.map((w: string, i: number) => (
            <div key={i} className="flex items-center gap-2 text-xs text-amber-400 bg-amber-900/20 rounded px-2 py-1.5">
              <AlertTriangle size={11} className="flex-shrink-0" />{w}
            </div>
          ))}
        </div>
      )}
      <div className="space-y-2">
        {data.drives?.map((d: any) => (
          <div key={d.root_id}>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-zinc-400 truncate">{d.label}</span>
              <span className={cn('text-xs font-mono',
                d.warning === 'critical' ? 'text-red-400' :
                d.warning === 'low' ? 'text-amber-400' :
                d.warning === 'unavailable' ? 'text-zinc-600' : 'text-zinc-500'
              )}>
                {d.warning === 'unavailable' ? 'offline' : `${formatBytes(d.free_bytes)} free`}
              </span>
            </div>
            {d.total_bytes > 0 && (
              <div className="h-1.5 bg-surface-3 rounded-full overflow-hidden">
                <div className={cn('h-full rounded-full',
                  d.warning === 'critical' ? 'bg-red-500' :
                  d.warning === 'low' ? 'bg-amber-500' : 'bg-blue-500/60'
                )} style={{ width: `${d.pct_used}%` }} />
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="pt-2 border-t border-surface-4 space-y-1">
        <p className="text-xs text-zinc-500 mb-1.5">App storage</p>
        {[
          { label: 'Database', bytes: data.app_storage.database_bytes },
          { label: 'Thumbnails', bytes: data.app_storage.thumbnails_bytes },
          { label: 'Embeddings', bytes: data.app_storage.chroma_bytes },
          { label: 'Keyframes', bytes: data.app_storage.keyframes_bytes },
        ].map(({ label, bytes }) => (
          <div key={label} className="flex justify-between text-xs">
            <span className="text-zinc-500">{label}</span>
            <span className="text-zinc-400 font-mono">{formatBytes(bytes)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function formatEtaSeconds(s: number | null | undefined): string {
  if (!s || s <= 0) return ''
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) {
    const h = Math.floor(s / 3600)
    const m = Math.round((s % 3600) / 60)
    return m > 0 ? `${h}h${m}m` : `${h}h`
  }
  const d = Math.floor(s / 86400)
  const h = Math.round((s % 86400) / 3600)
  return h > 0 ? `${d}d${h}h` : `${d}d`
}

function IndexingSpeedCard() {
  const { data, refetch } = useQuery('indexing-speed', () => api.getIndexingSpeed(), { refetchInterval: 10000 })
  const { data: stageStatus, refetch: refetchStatus } = useQuery('stage-status', () => api.getStageStatus(), { refetchInterval: 10000 })
  const { data: jobData } = useQuery('job-queue', () => api.getJobQueue(), { refetchInterval: 5000 })
  const qc = useQueryClient()

  const isPaused = (jobData?.queue_stats?.paused ?? 0) > 0

  const pauseMut = useMutation(() => api.pauseJobs(), {
    onSuccess: (res) => {
      toast.success(`Pipeline paused — ${res.paused_jobs} jobs queued for later`)
      qc.invalidateQueries('job-queue')
      qc.invalidateQueries('indexing-speed')
    },
    onError: () => { toast.error('Failed to pause') },
  })

  const resumeMut = useMutation(() => api.resumeJobs(), {
    onSuccess: (res) => {
      toast.success(`Pipeline resumed — ${res.resumed_jobs} jobs requeued`)
      qc.invalidateQueries('job-queue')
      qc.invalidateQueries('indexing-speed')
    },
    onError: () => { toast.error('Failed to resume') },
  })

  const skipMut = useMutation((stage: string) => api.skipStage(stage), {
    onSuccess: (_, stage) => {
      toast.success(`${stage} skipped`)
      qc.invalidateQueries('indexing-speed')
      qc.invalidateQueries('stage-status')
      qc.invalidateQueries('job-queue')
    }
  })

  const restoreMut = useMutation((stage: string) => api.restoreStage(stage), {
    onSuccess: (_, stage) => {
      toast.success(`${stage} restored`)
      qc.invalidateQueries('indexing-speed')
      qc.invalidateQueries('stage-status')
      qc.invalidateQueries('job-queue')
    }
  })

  const reconcileMut = useMutation(() => api.reconcileStreams(), {
    onSuccess: (res) => {
      const total = Object.values(res.requeued || {}).reduce((a, b) => a + b, 0)
      toast.success(total
        ? `Reconciled — re-queued ${total} files across stale streams`
        : 'All streams in sync')
      qc.invalidateQueries('indexing-speed')
      qc.invalidateQueries('job-queue')
    },
    onError: () => { toast.error('Reconcile failed') },
  })

  const rebuildMut = useMutation((streams?: string[]) => api.rebuildStreams(streams), {
    onSuccess: (res) => {
      const total = Object.values(res.requeued || {}).reduce((a, b) => a + b, 0)
      toast.success(`Rebuild queued — ${total} stage-jobs across the library`)
      qc.invalidateQueries('indexing-speed')
      qc.invalidateQueries('job-queue')
    },
    onError: () => { toast.error('Rebuild failed') },
  })

  if (!data) return null

  const stageColors: Record<string, string> = {
    metadata: 'bg-blue-500',
    hash: 'bg-purple-500',
    thumbnail: 'bg-cyan-500',
    transcript: 'bg-amber-500',
    embed: 'bg-green-500',
    clip_embed: 'bg-violet-500',
    caption: 'bg-emerald-500',
  }

  const stageLabels: Record<string, string> = {
    metadata: 'Metadata',
    hash: 'Hashing',
    thumbnail: 'Thumbnails',
    transcript: 'Transcription',
    embed: 'Embedding',
    clip_embed: 'CLIP frames',
    caption: 'VLM captions',
  }

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Zap size={13} className="text-accent" />
        <p className="label">Pipeline Speed</p>
        <div className="ml-auto flex items-center gap-2">
          {data.active_stage && !isPaused && (
            <span className="text-xs text-zinc-500">
              active: {stageLabels[data.active_stage] || data.active_stage}
            </span>
          )}
          <button
            className="text-xs px-2.5 py-1 rounded bg-surface-3 text-zinc-400 hover:bg-emerald-900/30 hover:text-emerald-400 transition-colors"
            onClick={() => reconcileMut.mutate()}
            disabled={reconcileMut.isLoading}
            title="Re-queue stages whose flags don't match what's actually stored"
          >
            {reconcileMut.isLoading ? 'Reconciling…' : '↺ Reconcile'}
          </button>
          <button
            className="text-xs px-2.5 py-1 rounded bg-surface-3 text-zinc-400 hover:bg-amber-900/30 hover:text-amber-400 transition-colors"
            onClick={() => {
              if (confirm('Rebuild all three multimodal streams (transcripts, CLIP frames, VLM captions) for every file? This re-queues every stage and the pipeline worker will rerun them.')) {
                rebuildMut.mutate(undefined)
              }
            }}
            disabled={rebuildMut.isLoading}
            title="Reset all stream flags and re-run transcript + CLIP + caption embedding for every file"
          >
            {rebuildMut.isLoading ? 'Queuing…' : '↻ Rebuild All'}
          </button>
          {isPaused ? (
            <button
              className="text-xs px-2.5 py-1 rounded bg-green-900/30 text-green-400 hover:bg-green-900/50 transition-colors font-medium"
              onClick={() => resumeMut.mutate()}
              disabled={resumeMut.isLoading}
            >
              {resumeMut.isLoading ? 'Resuming…' : '▶ Resume'}
            </button>
          ) : (
            <button
              className="text-xs px-2.5 py-1 rounded bg-surface-3 text-zinc-400 hover:bg-amber-900/30 hover:text-amber-400 transition-colors"
              onClick={() => pauseMut.mutate()}
              disabled={pauseMut.isLoading || !data.total_pending}
            >
              {pauseMut.isLoading ? 'Pausing…' : '⏸ Pause'}
            </button>
          )}
        </div>
      </div>
      <div className="space-y-2">
        {data.stages?.map((s: any) => {
          const total = s.done + s.pending + (s.paused ?? 0)
          const pct = total > 0 ? (s.done / total) * 100 : 100
          const isActive = s.pending > 0 || s.processing > 0
          const isSkipped = stageStatus?.[s.stage]?.is_skipped
          return (
            <div key={s.stage}>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <span className={cn('text-xs', isSkipped ? 'text-zinc-600 line-through' : isActive ? 'text-zinc-300' : 'text-zinc-600')}>
                    {stageLabels[s.stage] || s.stage}
                  </span>
                  {isSkipped && (
                    <span className="text-xs text-zinc-600 bg-surface-3 px-1 rounded">skipped</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {(s.rate_per_10min > 0 || s.rate_per_hour > 0) && !isSkipped && (
                    <span className="text-xs text-amber-400 font-mono" title="completed in the last hour">
                      {s.rate_per_10min > 0 ? `${s.rate_per_10min * 6}/hr*` : `${s.rate_per_hour}/hr`}
                    </span>
                  )}
                  {!isSkipped && s.eta_seconds && s.pending > 0 && (
                    <span className="text-xs text-zinc-400 font-mono" title={`~${s.eta_seconds}s remaining for ${s.stage}`}>
                      ETA {formatEtaSeconds(s.eta_seconds)}
                    </span>
                  )}
                  <span className="text-xs text-zinc-600 font-mono">
                    {s.done.toLocaleString()}/{(s.done + s.pending + (s.paused ?? 0)).toLocaleString()}
                  </span>
                  {isSkipped ? (
                    <button
                      className="text-xs text-green-400 hover:text-green-300 px-1.5 py-0.5 rounded bg-green-900/20 hover:bg-green-900/40 transition-colors"
                      onClick={() => restoreMut.mutate(s.stage)}
                      disabled={restoreMut.isLoading}
                    >
                      restore
                    </button>
                  ) : (s.pending > 0) ? (
                    <button
                      className="text-xs text-zinc-500 hover:text-red-400 px-1.5 py-0.5 rounded hover:bg-red-900/20 transition-colors"
                      onClick={() => skipMut.mutate(s.stage)}
                      disabled={skipMut.isLoading}
                    >
                      skip
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="h-1 bg-surface-3 rounded-full overflow-hidden">
                <div
                  className={cn('h-full rounded-full transition-all duration-1000',
                    isSkipped ? 'bg-zinc-700' : stageColors[s.stage] || 'bg-zinc-500',
                    isActive && !isSkipped && 'opacity-80'
                  )}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          )
        })}
      </div>
      {(data.eta_seconds_total || data.eta_hours) && (
        <div className="text-xs text-zinc-500 pt-1 border-t border-surface-4 flex items-center justify-between">
          <span>
            {'Total ETA: ~'}{data.eta_seconds_total
              ? formatEtaSeconds(data.eta_seconds_total)
              : data.eta_hours < 1
                ? `${Math.round(data.eta_hours * 60)}m`
                : `${data.eta_hours}h`}
          </span>
          <span className="font-mono">{data.total_pending?.toLocaleString()} jobs pending</span>
        </div>
      )}
    </div>
  )
}

function ProjectBreakdownCard() {
  const { data } = useQuery('project-stats', () => api.getProjectStats(), { refetchInterval: 15000 })
  if (!data?.projects?.length) return null
  const maxCount = Math.max(...data.projects.map((p: any) => p.file_count))
  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Tag size={13} className="text-accent" />
        <p className="label">By Project</p>
      </div>
      <div className="space-y-2">
        {data.projects.slice(0, 8).map((p: any) => (
          <div key={p.tag} className="flex items-center gap-3">
            <span className="text-xs text-zinc-400 w-32 truncate flex-shrink-0">{p.tag}</span>
            <div className="flex-1 h-1.5 bg-surface-3 rounded-full overflow-hidden">
              <div className="h-full bg-accent/50 rounded-full"
                style={{ width: `${(p.file_count / maxCount) * 100}%` }} />
            </div>
            <span className="text-xs text-zinc-500 font-mono w-8 text-right flex-shrink-0">{p.file_count}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function DashboardPage() {
  const qc = useQueryClient()
  const { data: stats, isLoading } = useQuery('dashboard-stats', () => api.getDashboardStats(), { refetchInterval: 5000 })
  const { data: jobData } = useQuery('job-queue', () => api.getJobQueue(), { refetchInterval: 3000 })
  const scanMutation = useMutation(() => api.scanAll(), {
    onSuccess: (data) => {
      qc.invalidateQueries('dashboard-stats')
      const total = data.summaries?.reduce((s: number, r: any) => s + (r.found ?? 0), 0) ?? 0
      toast.success(`Scan complete - ${total} files found`)
    },
    onError: () => { toast.error('Scan failed') },
  })

  const maxBytes = Math.max(...(stats?.storage_by_root ?? []).map((r) => r.total_bytes), 1)
  const jobStats = jobData?.queue_stats ?? {}

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Overview"
        subtitle="Your footage library at a glance"
        actions={
          <button className="btn-primary" onClick={() => scanMutation.mutate()} disabled={scanMutation.isLoading}>
            <RefreshCw size={13} className={cn(scanMutation.isLoading && 'animate-spin')} />
            {scanMutation.isLoading ? 'Scanning...' : 'Scan All'}
          </button>
        }
      />

      <div className="flex-1 overflow-auto p-6 space-y-5">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard label="Total Files" value={isLoading ? '-' : (stats?.total_files ?? 0).toLocaleString()}
            sub={`${stats?.total_indexed ?? 0} indexed`} icon={Film} />
          <StatCard label="Total Duration" value={isLoading ? '-' : `${stats?.total_duration_hours ?? 0}h`}
            sub="of footage indexed" icon={Clock} />
          <StatCard label="Storage" value={isLoading ? '-' : formatBytes(stats?.total_size_bytes ?? 0)}
            sub="across all sources" icon={HardDrive} />
          <StatCard label="Duplicates" value={isLoading ? '-' : (stats?.duplicate_groups ?? 0).toLocaleString()}
            sub={`${stats?.duplicate_files ?? 0} duplicate files`} icon={Copy}
            accent={!!stats && stats.duplicate_groups > 0} />
        </div>

        {stats && (
          <div className="card p-4">
            <p className="label mb-3">Indexing Pipeline</p>
            <div className="space-y-2.5">
              {[
                { label: 'Metadata extracted', count: stats.total_indexed },
                { label: 'Transcribed', count: stats.total_transcribed },
                { label: 'Embedded (searchable)', count: stats.total_embedded },
              ].map(({ label, count }) => {
                const pct = stats.total_files > 0 ? (count / stats.total_files) * 100 : 0
                return (
                  <div key={label} className="flex items-center gap-3">
                    <span className="text-xs text-zinc-400 w-44 flex-shrink-0">{label}</span>
                    <div className="flex-1 h-1.5 bg-surface-3 rounded-full overflow-hidden">
                      <div className="h-full bg-accent/60 rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="text-xs text-zinc-500 font-mono w-24 text-right">
                      {count.toLocaleString()} / {stats.total_files.toLocaleString()}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <DriveHealthCard />
          <IndexingSpeedCard />
          <ProjectBreakdownCard />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <ThermalCard />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {stats && stats.storage_by_root.length > 0 && (
            <div className="card p-4">
              <p className="label mb-3">Storage by Source</p>
              <div className="space-y-2">
                {stats.storage_by_root.map((r) => (
                  <StorageBar key={r.root_id} bytes={r.total_bytes} maxBytes={maxBytes} label={r.label} />
                ))}
              </div>
            </div>
          )}
          <div className="card p-4">
            <p className="label mb-3">Job Queue</p>
            {Object.keys(jobStats).length === 0 ? <p className="text-sm text-zinc-600">No jobs</p> : (
              <div className="space-y-1.5">
                {Object.entries(jobStats).map(([status, count]) => (
                  <div key={status} className="flex items-center justify-between text-sm">
                    <span className={cn('capitalize',
                      status === 'done' ? 'text-green-400' :
                      status === 'failed' ? 'text-red-400' :
                      status === 'processing' ? 'text-amber-400' : 'text-zinc-400'
                    )}>{status}</span>
                    <span className="font-mono text-xs text-zinc-400">{(count as number).toLocaleString()}</span>
                  </div>
                ))}
              </div>
            )}
            {jobData?.failed && jobData.failed.length > 0 && (
              <div className="mt-3 pt-3 border-t border-surface-4">
                <p className="flex items-center gap-1.5 text-xs text-red-400 mb-1.5">
                  <AlertTriangle size={11} /> Recent failures
                </p>
                {jobData.failed.slice(0, 3).map((j) => (
                  <div key={j.id} className="text-xs text-zinc-500 truncate">
                    {j.stage} - {j.error_message?.slice(0, 60) ?? 'unknown error'}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {stats && stats.recent_files.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <p className="label">Recently Added</p>
              <Link to="/search" className="text-xs text-zinc-500 hover:text-zinc-300">Browse all</Link>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              {stats.recent_files.map((f) => <VideoCard key={f.id} file={f} />)}
            </div>
          </div>
        )}

        {stats?.total_files === 0 && !isLoading && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <Film size={40} className="text-zinc-700 mb-4" />
            <p className="text-zinc-400 font-medium">No footage indexed yet</p>
            <p className="text-zinc-600 text-sm mt-1 mb-4">Add a source folder and run a scan to get started.</p>
            <Link to="/sources" className="btn-primary">Add Source Folder</Link>
          </div>
        )}
      </div>
    </div>
  )
}
