/**
 * Search diagnose — runs one query through all six search modes and shows the
 * top results side-by-side. Used to sanity-check that visual / caption /
 * multimodal actually retrieve sensible clips on real footage.
 */
import { useState } from 'react'
import { useMutation } from 'react-query'
import { Link } from 'react-router-dom'
import { Search as SearchIcon, Loader2, AlertTriangle } from 'lucide-react'
import { api } from '@/api/client'
import { PageHeader } from '@/components/PageHeader'
import { cn, formatDuration } from '@/lib/utils'
import {
  ALL_SEARCH_MODES,
  SEARCH_MODE_LABELS,
  type SearchMode,
} from '@/lib/search-modes'

const MODE_ACCENT: Record<SearchMode, string> = {
  semantic:   'border-zinc-700',
  keyword:    'border-zinc-700',
  hybrid:     'border-zinc-700',
  visual:     'border-violet-700/60',
  caption:    'border-emerald-700/60',
  multimodal: 'border-amber-700/60',
}

const EXAMPLES = [
  'sunrise drone shot mountains',
  'two people sitting at a table',
  'close-up of hands',
  'wide shot of empty diner at dusk',
  'person standing in front of a microphone',
]

export default function DiagnosePage() {
  const [q, setQ] = useState('')
  const [n, setN] = useState(3)

  const mut = useMutation(({ query, count }: { query: string; count: number }) =>
    api.searchDiagnose(query, count)
  )

  const run = (query: string) => {
    const trimmed = query.trim()
    if (!trimmed) return
    setQ(trimmed)
    mut.mutate({ query: trimmed, count: n })
  }

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Search Diagnose"
        subtitle="Run one query through every mode side-by-side"
      />

      <div className="flex-1 overflow-auto p-6 space-y-4">
        <div className="card p-4 space-y-3">
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => { e.preventDefault(); run(q) }}
          >
            <SearchIcon size={16} className="text-zinc-500 flex-shrink-0" />
            <input
              autoFocus
              className="input flex-1"
              placeholder="Type a query and press Enter — e.g. 'wide shot of empty diner at dusk'"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <select
              className="input w-20 text-sm"
              value={n}
              onChange={(e) => setN(parseInt(e.target.value, 10))}
              title="Top N results per mode"
            >
              {[1, 2, 3, 5, 10].map((v) => <option key={v} value={v}>top {v}</option>)}
            </select>
            <button type="submit" className="btn-primary" disabled={mut.isLoading || !q.trim()}>
              {mut.isLoading ? <Loader2 size={14} className="animate-spin" /> : 'Run'}
            </button>
          </form>

          <div className="flex flex-wrap gap-1.5 text-xs">
            <span className="text-zinc-500 mr-1">try:</span>
            {EXAMPLES.map((ex) => (
              <button key={ex}
                className="text-zinc-400 hover:text-zinc-200 underline-offset-2 hover:underline"
                onClick={() => { setQ(ex); run(ex) }}>
                {ex}
              </button>
            ))}
          </div>
        </div>

        {mut.isError && (
          <div className="card p-3 text-sm text-red-400 flex items-center gap-2">
            <AlertTriangle size={14} />
            Diagnose request failed: {(mut.error as Error)?.message ?? 'unknown'}
          </div>
        )}

        {mut.data && (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {ALL_SEARCH_MODES.map((mode) => {
              const rows = mut.data.results[mode] ?? []
              const hadError = rows.length === 1 && '_error' in rows[0]
              const empty = rows.length === 0
              return (
                <div key={mode} className={cn('card p-3 space-y-2 border-l-2', MODE_ACCENT[mode])}>
                  <div className="flex items-baseline justify-between">
                    <p className="label">{SEARCH_MODE_LABELS[mode]}</p>
                    <span className="text-[10px] text-zinc-600 font-mono">
                      {hadError ? 'ERROR' : `${rows.length} hit${rows.length === 1 ? '' : 's'}`}
                    </span>
                  </div>

                  {hadError && (
                    <p className="text-xs text-red-400 break-words">
                      {(rows[0] as any)._error}
                    </p>
                  )}

                  {empty && !hadError && (
                    <p className="text-xs text-zinc-600">No results for this mode.</p>
                  )}

                  {!hadError && rows.map((r, i) => (
                    <Link
                      key={`${mode}-${r.video_file_id}-${i}`}
                      to={`/files/${r.video_file_id}${r.frame_timestamp != null ? `?t=${Math.floor(r.frame_timestamp)}` : ''}`}
                      className="flex gap-2 items-start hover:bg-surface-3/40 rounded p-1.5 -mx-1.5 transition-colors"
                    >
                      <img
                        src={api.thumbnailUrl(r.video_file_id)}
                        alt={r.filename}
                        className="w-16 h-10 object-cover rounded flex-shrink-0 bg-surface-3"
                        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-zinc-200 truncate" title={r.filename}>
                          {r.filename}
                        </p>
                        <div className="flex items-center gap-2 text-[10px] text-zinc-500 font-mono mt-0.5">
                          {r.duration_seconds != null && (
                            <span>{formatDuration(r.duration_seconds)}</span>
                          )}
                          {r.frame_timestamp != null && (
                            <span className="text-amber-400">@{r.frame_timestamp.toFixed(0)}s</span>
                          )}
                          {r.best_score > 0 && (
                            <span>{(r.best_score * 100).toFixed(0)}%</span>
                          )}
                        </div>
                        {r.snippet && (
                          <p className="text-[11px] text-zinc-500 truncate mt-0.5" title={r.snippet}>
                            "{r.snippet}"
                          </p>
                        )}
                      </div>
                    </Link>
                  ))}
                </div>
              )
            })}
          </div>
        )}

        {!mut.data && !mut.isLoading && (
          <p className="text-xs text-zinc-600 px-1">
            Tip: try the same query in every mode; the results that overlap across multiple modes
            are usually the most relevant. Visual / Caption / Multimodal will attach a frame
            timestamp so you can deep-link to the matched moment.
          </p>
        )}
      </div>
    </div>
  )
}
