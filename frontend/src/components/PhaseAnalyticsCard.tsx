/**
 * Per-phase processing-time breakdown.
 *
 * Replaces the old static "Indexing Pipeline" tally on the Dashboard.
 * Shows, for each stage: jobs done, active processing time, % of total.
 * Has a Latest run / All time toggle.
 */
import { useState } from 'react'
import { useQuery } from 'react-query'
import { Activity } from 'lucide-react'
import { api } from '@/api/client'
import { cn } from '@/lib/utils'

const STAGE_LABELS: Record<string, string> = {
  metadata: 'Metadata',
  hash: 'Hashing',
  thumbnail: 'Thumbnails',
  transcript: 'Transcription',
  embed: 'Embedding',
  clip_embed: 'CLIP frames',
  caption: 'VLM captions',
}

const STAGE_COLORS: Record<string, string> = {
  metadata: 'bg-blue-500',
  hash: 'bg-purple-500',
  thumbnail: 'bg-cyan-500',
  transcript: 'bg-amber-500',
  embed: 'bg-green-500',
  clip_embed: 'bg-violet-500',
  caption: 'bg-emerald-500',
}

function formatDuration(s: number): string {
  if (!s || s < 1) return '0s'
  if (s < 60) return `${s.toFixed(1)}s`
  if (s < 3600) return `${(s / 60).toFixed(1)} min`
  return `${(s / 3600).toFixed(2)} h`
}

export function PhaseAnalyticsCard() {
  const [scope, setScope] = useState<'latest' | 'all_time'>('latest')
  const { data, isLoading } = useQuery(
    ['phase-analytics', scope],
    () => api.getPhaseAnalytics(scope),
    { refetchInterval: 15000 }
  )

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Activity size={13} className="text-accent" />
        <p className="label">Phase Analytics</p>
        <div className="ml-auto flex items-center gap-1 text-xs">
          <button
            className={cn(
              'px-2 py-0.5 rounded font-mono transition-colors',
              scope === 'latest'
                ? 'bg-accent/15 text-accent border border-accent/40'
                : 'text-zinc-500 hover:text-zinc-300 border border-transparent'
            )}
            onClick={() => setScope('latest')}
          >
            latest run
          </button>
          <button
            className={cn(
              'px-2 py-0.5 rounded font-mono transition-colors',
              scope === 'all_time'
                ? 'bg-accent/15 text-accent border border-accent/40'
                : 'text-zinc-500 hover:text-zinc-300 border border-transparent'
            )}
            onClick={() => setScope('all_time')}
          >
            all time
          </button>
        </div>
      </div>

      {isLoading && !data ? (
        <p className="text-xs text-zinc-600">Loading…</p>
      ) : !data || data.phases.every((p) => p.done_count === 0 && p.skipped_count === 0) ? (
        <p className="text-xs text-zinc-600">
          No completed jobs in this window yet.
        </p>
      ) : (
        <>
          <div className="space-y-1.5">
            {data.phases
              .filter((p) => p.done_count > 0 || p.skipped_count > 0)
              .map((p) => {
                const reasonsText = Object.entries(p.skip_reasons || {})
                  .map(([k, n]) => `${k}: ${n}`)
                  .join('\n')
                return (
                  <div key={p.stage}>
                    <div className="flex items-center justify-between mb-0.5 text-xs">
                      <span className="text-zinc-300">{STAGE_LABELS[p.stage] || p.stage}</span>
                      <span className="font-mono text-zinc-500">
                        <span className="text-zinc-300">{formatDuration(p.active_seconds)}</span>
                        <span className="text-zinc-600"> · {p.pct_of_total}%</span>
                        <span className="text-zinc-600"> · {p.done_count}j</span>
                        {p.skipped_count > 0 && (
                          <span
                            className="text-warn ml-1"
                            title={reasonsText || `${p.skipped_count} skipped`}
                          >
                            · {p.skipped_count} skipped
                          </span>
                        )}
                        <span className="text-zinc-600"> · {p.mean_seconds_per_job.toFixed(1)}s avg</span>
                      </span>
                    </div>
                    <div className="h-1 bg-surface-3 rounded-full overflow-hidden">
                      <div
                        className={cn('h-full rounded-full', STAGE_COLORS[p.stage] || 'bg-zinc-500')}
                        style={{ width: `${Math.min(100, p.pct_of_total)}%` }}
                      />
                    </div>
                  </div>
                )
              })}
          </div>

          <div className="pt-2 border-t border-surface-4 flex items-center justify-between text-xs">
            <span className="text-zinc-500">
              Total active processing time
            </span>
            <span className="font-mono text-zinc-300">
              {formatDuration(data.total_active_seconds)}
            </span>
          </div>

          {scope === 'latest' && data.window_start && (
            <p className="text-[10px] text-zinc-600 font-mono">
              window: last 24h of activity
            </p>
          )}
        </>
      )}
    </div>
  )
}
