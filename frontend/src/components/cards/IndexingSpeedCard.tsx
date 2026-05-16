import { useQuery, useMutation, useQueryClient } from 'react-query'
import { Zap, EyeOff, Eye } from 'lucide-react'
import toast from 'react-hot-toast'
import { api } from '@/api/client'
import { cn } from '@/lib/utils'
import { stageLabel, stageColor } from '@/lib/stages'

/**
 * Format a seconds count as a compact human duration (45s, 12m, 3h20m, 2d4h).
 * Returns '' for null/undefined/zero so the consumer can render nothing.
 */
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

export function IndexingSpeedCard() {
  const { data } = useQuery('indexing-speed', () => api.getIndexingSpeed(), { refetchInterval: 10000 })
  const { data: stageStatus } = useQuery('stage-status', () => api.getStageStatus(), { refetchInterval: 10000 })
  const { data: jobData } = useQuery('job-queue', () => api.getJobQueue(), { refetchInterval: 5000 })
  const { data: toggles } = useQuery('pipeline-toggles', () => api.getPipelineToggles(), { refetchInterval: 30000 })
  const qc = useQueryClient()

  const clipEnabled = toggles?.clip_embed_enabled ?? true
  const captionEnabled = toggles?.caption_enabled ?? true
  const heavyDisabled = !clipEnabled && !captionEnabled

  const togglesMut = useMutation(
    (body: { clip_embed?: boolean; caption?: boolean }) => api.setPipelineToggles(body),
    {
      onSuccess: (res, body) => {
        const stages = Object.keys(body).join('+')
        const parts: string[] = []
        if (res.paused) parts.push(`${res.paused} job${res.paused === 1 ? '' : 's'} paused`)
        if (res.requeued) parts.push(`${res.requeued} requeued`)
        if (res.created) parts.push(`${res.created} created`)
        toast.success(`${stages}: ${parts.length ? parts.join(', ') : 'updated'}`)
        qc.invalidateQueries('pipeline-toggles')
        qc.invalidateQueries('indexing-speed')
        qc.invalidateQueries('stage-status')
        qc.invalidateQueries('job-queue')
        qc.invalidateQueries('phase-analytics')
      },
      onError: () => { toast.error('Failed to update pipeline toggles') },
    }
  )

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

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Zap size={13} className="text-accent" />
        <p className="label">Pipeline Speed</p>
        <div className="ml-auto flex items-center gap-2">
          {data.active_stage && !isPaused && (
            <span className="text-xs text-zinc-500">
              active: {stageLabel(data.active_stage)}
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
          // Skipped jobs are "settled" too — count them so a stage with
          // (e.g.) 26 done + 35 skipped shows 100% instead of 43%.
          const skippedN = s.skipped ?? 0
          const total = s.done + s.pending + (s.paused ?? 0) + skippedN
          const settled = s.done + skippedN
          const pct = total > 0 ? (settled / total) * 100 : 100
          const isActive = s.pending > 0 || s.processing > 0
          const isSkipped = stageStatus?.[s.stage]?.is_skipped
          return (
            <div key={s.stage}>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <span className={cn('text-xs', isSkipped ? 'text-zinc-600 line-through' : isActive ? 'text-zinc-300' : 'text-zinc-600')}>
                    {stageLabel(s.stage)}
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
                  {skippedN > 0 && (
                    <span
                      className="text-[10.5px] text-warn font-mono"
                      title={`${skippedN} job${skippedN === 1 ? '' : 's'} skipped (e.g. captioner found no frames)`}
                    >
                      {skippedN} skip
                    </span>
                  )}
                  <span className="text-xs text-zinc-600 font-mono">
                    {s.done.toLocaleString()}/{total.toLocaleString()}
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
                    isSkipped ? 'bg-zinc-700' : stageColor(s.stage),
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

      {/* Persistent CLIP / VLM toggles — survive restart. Disabling marks
          pending jobs as paused; in-flight jobs finish on their own.
          Enabling re-queues paused jobs and creates fresh ones for any
          transcribed file that has no job for this stage yet. */}
      <div className="pt-2 border-t border-surface-4 space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-xs text-zinc-400">
            Heavy stages (CLIP + VLM)
          </p>
          <span className="text-[10px] text-zinc-600 font-mono">
            persistent · skips after Whisper
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            className={cn(
              'text-xs px-2.5 py-1 rounded transition-colors flex items-center gap-1.5',
              clipEnabled
                ? 'bg-surface-3 text-zinc-300 hover:bg-amber-900/30 hover:text-amber-400'
                : 'bg-amber-900/40 text-amber-300 hover:bg-amber-900/60'
            )}
            disabled={togglesMut.isLoading}
            onClick={() => togglesMut.mutate({ clip_embed: !clipEnabled })}
            title={clipEnabled
              ? 'Pause CLIP frame embedding — disables Visual search until resumed'
              : 'Resume CLIP frame embedding — re-queues paused jobs and creates new ones'}
          >
            {clipEnabled ? <EyeOff size={11} /> : <Eye size={11} />}
            CLIP {clipEnabled ? 'on' : 'paused'}
          </button>
          <button
            className={cn(
              'text-xs px-2.5 py-1 rounded transition-colors flex items-center gap-1.5',
              captionEnabled
                ? 'bg-surface-3 text-zinc-300 hover:bg-amber-900/30 hover:text-amber-400'
                : 'bg-amber-900/40 text-amber-300 hover:bg-amber-900/60'
            )}
            disabled={togglesMut.isLoading}
            onClick={() => togglesMut.mutate({ caption: !captionEnabled })}
            title={captionEnabled
              ? 'Pause VLM caption generation — disables Caption search until resumed'
              : 'Resume VLM caption generation — re-queues paused jobs and creates new ones'}
          >
            {captionEnabled ? <EyeOff size={11} /> : <Eye size={11} />}
            VLM {captionEnabled ? 'on' : 'paused'}
          </button>
          {(!clipEnabled || !captionEnabled) && (
            <button
              className="text-xs px-2.5 py-1 rounded bg-green-900/30 text-green-400 hover:bg-green-900/50 transition-colors font-medium"
              disabled={togglesMut.isLoading}
              onClick={() => togglesMut.mutate({ clip_embed: true, caption: true })}
              title="Resume both CLIP and VLM — re-queues paused jobs and creates new ones for transcribed files"
            >
              ▶ Resume CLIP + VLM
            </button>
          )}
          {clipEnabled && captionEnabled && (
            <button
              className="text-xs px-2.5 py-1 rounded bg-surface-3 text-zinc-400 hover:bg-amber-900/30 hover:text-amber-400 transition-colors ml-auto"
              disabled={togglesMut.isLoading}
              onClick={() => togglesMut.mutate({ clip_embed: false, caption: false })}
              title="Pause both CLIP and VLM — pipeline stops after Whisper transcription"
            >
              ⏸ Pause CLIP + VLM
            </button>
          )}
        </div>
        {heavyDisabled && (
          <p className="text-[10px] text-amber-400/80">
            Pipeline will stop after transcription. Visual + Caption + Multimodal search unavailable for new files.
          </p>
        )}
      </div>
    </div>
  )
}
