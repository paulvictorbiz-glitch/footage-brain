/**
 * Coverage — per-scan-root → per-folder × per-stage completion view.
 *
 * Each folder gets a 7-cell strip, one cell per stage:
 *   green  = 100% done
 *   amber  = partially done
 *   zinc   = none done
 *   dashed = stage disabled by current CLIP/VLM toggle
 */
import { useMemo, useState } from 'react'
import { useQuery } from 'react-query'
import { ChevronDown, ChevronRight, Network } from 'lucide-react'
import { api } from '@/api/client'
import { PageHeader } from '@/components/PageHeader'
import { cn, formatBytes } from '@/lib/utils'

const STAGE_LABELS: Record<string, string> = {
  metadata: 'Meta',
  hash: 'Hash',
  thumbnail: 'Thumb',
  transcript: 'Transcript',
  embed: 'Embed',
  clip_embed: 'CLIP',
  caption: 'VLM',
}

function CellRow({
  stages,
  counts,
  skipped,
  total,
  disabled,
}: {
  stages: string[]
  counts: Record<string, number>
  skipped: Record<string, number>
  total: number
  disabled: Set<string>
}) {
  return (
    <span className="inline-flex items-center">
      {stages.map((s) => {
        const done = counts[s] ?? 0
        const skip = skipped[s] ?? 0
        const isDisabled = disabled.has(s)
        const settled = done + skip
        const ratio = total > 0 ? done / total : 0
        const settledRatio = total > 0 ? settled / total : 0

        let cls: string
        if (isDisabled) cls = 'cov-disabled'
        else if (done === 0 && skip > 0) cls = 'cov-skipped'
        else if (ratio >= 1) cls = 'cov-full'
        else if (settledRatio >= 1) cls = 'cov-partial'   // mixed done+skipped fills everything
        else if (ratio > 0 || skip > 0) cls = 'cov-partial'
        else cls = 'cov-none'

        const tip = isDisabled
          ? `${STAGE_LABELS[s] || s}: disabled (CLIP/VLM paused)`
          : skip > 0
          ? `${STAGE_LABELS[s] || s}: ${done}/${total} done · ${skip} skipped (${Math.round(ratio * 100)}%)`
          : `${STAGE_LABELS[s] || s}: ${done}/${total} (${Math.round(ratio * 100)}%)`

        return <span key={s} className={cn('cov-cell', cls)} title={tip} />
      })}
    </span>
  )
}

function StageLegend({ stages, disabled }: { stages: string[]; disabled: Set<string> }) {
  return (
    <div className="flex flex-wrap items-center gap-3 text-[10px] font-mono text-zinc-500">
      <span className="flex items-center gap-1.5">
        <span className="cov-cell cov-full" /> done
      </span>
      <span className="flex items-center gap-1.5">
        <span className="cov-cell cov-partial" /> partial
      </span>
      <span className="flex items-center gap-1.5">
        <span className="cov-cell cov-none" /> not yet
      </span>
      <span className="flex items-center gap-1.5">
        <span className="cov-cell cov-skipped" /> skipped
      </span>
      <span className="flex items-center gap-1.5">
        <span className="cov-cell cov-disabled" /> stage paused
      </span>
      <span className="ml-auto flex items-center gap-2">
        {stages.map((s) => (
          <span
            key={s}
            className={cn('uppercase tracking-wider', disabled.has(s) && 'text-zinc-700 line-through')}
            title={disabled.has(s) ? `${s} — paused by toggle` : s}
          >
            {STAGE_LABELS[s] || s}
          </span>
        ))}
      </span>
    </div>
  )
}

export default function CoveragePage() {
  const { data, isLoading } = useQuery('coverage-tree', () => api.getCoverageTree(), {
    refetchInterval: 15000,
  })
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [hideComplete, setHideComplete] = useState(false)

  const disabledSet = useMemo(
    () => new Set<string>(data?.disabled_stages ?? []),
    [data?.disabled_stages]
  )

  const toggleRoot = (rootId: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(rootId) ? next.delete(rootId) : next.add(rootId)
      return next
    })

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Coverage"
        subtitle="Per-folder pipeline coverage. Each cell is a stage; green means the stage is complete for every file in that folder."
        actions={
          <button
            className="dpill"
            onClick={() => setHideComplete((v) => !v)}
          >
            {hideComplete ? '○ showing all' : '● hide complete'}
          </button>
        }
      />

      <div className="flex-1 overflow-auto p-6 space-y-4">
        {isLoading && !data ? (
          <p className="text-sm text-zinc-500">Loading coverage…</p>
        ) : !data || data.roots.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <Network size={36} className="text-zinc-700 mb-3" />
            <p className="title-serif text-xl">No scannable drives configured</p>
            <p className="text-zinc-500 text-sm mt-1">Add a source under Workspace → Sources to see coverage.</p>
          </div>
        ) : (
          <>
            <div className="card p-4 space-y-3">
              <StageLegend stages={data.stages} disabled={disabledSet} />
            </div>

            {data.roots.map((root) => {
              const isOpen = expanded.has(root.root_id)
              // A folder is "complete" if every enabled stage has been
              // settled (done OR skipped) for all its files.
              const isFolderComplete = (f: typeof root.folders[number]) =>
                data.stages.every(
                  (s) =>
                    disabledSet.has(s) ||
                    ((f.stage_counts[s] ?? 0) + (f.skipped_counts[s] ?? 0)) >= f.file_count
                )
              const folders = hideComplete
                ? root.folders.filter((f) => !isFolderComplete(f))
                : root.folders

              return (
                <div key={root.root_id} className="card overflow-hidden">
                  <button
                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-surface-3/40 transition-colors"
                    onClick={() => toggleRoot(root.root_id)}
                  >
                    {isOpen ? (
                      <ChevronDown size={14} className="text-zinc-500" />
                    ) : (
                      <ChevronRight size={14} className="text-zinc-500" />
                    )}
                    <div className="flex-1 text-left min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="title-serif text-base truncate">{root.label}</span>
                        {!root.is_online && (
                          <span className="dpill is-amber !py-0">offline</span>
                        )}
                      </div>
                      <span className="font-mono text-[10.5px] text-zinc-600 truncate block">
                        {root.path}
                      </span>
                    </div>
                    <span className="font-mono text-xs text-zinc-500">
                      {root.file_count} files · {root.folders.length} folders
                    </span>
                    <CellRow
                      stages={data.stages}
                      counts={root.stage_counts}
                      skipped={root.skipped_counts}
                      total={root.file_count}
                      disabled={disabledSet}
                    />
                  </button>

                  {isOpen && (
                    <div className="border-t border-surface-4">
                      {folders.length === 0 ? (
                        <p className="px-4 py-6 text-center text-xs text-zinc-600">
                          All folders fully processed for this root.
                        </p>
                      ) : (
                        <div className="divide-y divide-surface-4">
                          {folders.map((folder) => {
                            const pendingStages = data.stages.filter(
                              (s) =>
                                !disabledSet.has(s) &&
                                ((folder.stage_counts[s] ?? 0) + (folder.skipped_counts[s] ?? 0)) <
                                  folder.file_count
                            )
                            return (
                              <div
                                key={folder.rel_path}
                                className="flex items-center gap-3 px-4 py-2 hover:bg-surface-3/30 transition-colors"
                              >
                                <span className="flex-1 min-w-0 font-mono text-xs text-zinc-300 truncate">
                                  {folder.rel_path || <span className="text-zinc-600">(root)</span>}
                                </span>
                                <span className="font-mono text-[10.5px] text-zinc-600 w-20 text-right">
                                  {folder.file_count} {folder.file_count === 1 ? 'file' : 'files'}
                                </span>
                                <span className="font-mono text-[10.5px] text-zinc-500 w-24 text-right">
                                  {pendingStages.length === 0 ? (
                                    <span className="text-ok">complete</span>
                                  ) : (
                                    <span className="text-warn">
                                      {pendingStages.length} pending
                                    </span>
                                  )}
                                </span>
                                <CellRow
                                  stages={data.stages}
                                  counts={folder.stage_counts}
                                  skipped={folder.skipped_counts}
                                  total={folder.file_count}
                                  disabled={disabledSet}
                                />
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </>
        )}
      </div>
    </div>
  )
}
