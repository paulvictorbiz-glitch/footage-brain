import { useState, useCallback, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import {
  Search, SlidersHorizontal, X, LayoutGrid, List,
  Loader2, Download, Tag, History, Clock, CheckSquare,
  Square, Volume2, VolumeX, Copy,
} from 'lucide-react'
import toast from 'react-hot-toast'
import { api, type SearchRequest, type SearchResult } from '@/api/client'
import { PageHeader } from '@/components/PageHeader'
import { VideoCard } from '@/components/VideoCard'
import { cn, formatDuration } from '@/lib/utils'

interface Filters {
  mode: 'semantic' | 'keyword' | 'hybrid' | 'visual'
  project_tag?: string
  source_root_id?: string
  min_duration?: number
  max_duration?: number
  is_vertical?: boolean
  has_duplicates_only?: boolean
  unique_only?: boolean
  extension?: string
}

const STORAGE_KEY = 'footage-search-mode'

function getSavedMode(): Filters['mode'] {
  const v = localStorage.getItem(STORAGE_KEY)
  if (v === 'semantic' || v === 'keyword' || v === 'hybrid' || v === 'visual') return v
  return 'semantic'
}

const defaultFilters: Filters = { mode: 'semantic' }

// ─── Quick filter buttons ────────────────────────────────────────────────────
const QUICK_FILTERS: Array<{
  label: string
  icon?: any
  apply: (f: Filters) => Filters
  active: (f: Filters) => boolean
}> = [
  {
    label: 'Vertical',
    apply: (f) => ({ ...f, is_vertical: f.is_vertical === true ? undefined : true }),
    active: (f) => f.is_vertical === true,
  },
  {
    label: 'Horizontal',
    apply: (f) => ({ ...f, is_vertical: f.is_vertical === false ? undefined : false }),
    active: (f) => f.is_vertical === false,
  },
  {
    label: 'Duplicates',
    apply: (f) => ({ ...f, has_duplicates_only: !f.has_duplicates_only, unique_only: false }),
    active: (f) => !!f.has_duplicates_only,
  },
  {
    label: 'Unique only',
    apply: (f) => ({ ...f, unique_only: !f.unique_only, has_duplicates_only: false }),
    active: (f) => !!f.unique_only,
  },
  {
    label: 'Short clips',
    apply: (f) => ({ ...f, max_duration: f.max_duration === 60 ? undefined : 60 }),
    active: (f) => f.max_duration === 60,
  },
  {
    label: 'Long clips',
    apply: (f) => ({ ...f, min_duration: f.min_duration === 300 ? undefined : 300 }),
    active: (f) => f.min_duration === 300,
  },
]

function FilterSidebar({ filters, onChange }: { filters: Filters; onChange: (f: Filters) => void }) {
  const { data: sources } = useQuery('sources', () => api.getSources())
  const { data: tagData } = useQuery('project-tags', () => api.getProjectTags())

  return (
    <div className="w-52 flex-shrink-0 border-r border-surface-4 overflow-y-auto p-4 space-y-5">
      <div>
        <p className="label mb-2">Search Mode</p>
        <div className="space-y-1">
          {(['semantic', 'keyword', 'hybrid', 'visual'] as const).map((m) => (
            <button key={m}
              className={cn('w-full text-left px-2.5 py-1.5 rounded text-sm transition-colors',
                filters.mode === m
                  ? m === 'visual' ? 'bg-violet-900/40 text-violet-300' : 'bg-surface-3 text-zinc-100'
                  : 'text-zinc-400 hover:bg-surface-3 hover:text-zinc-200')}
              onClick={() => onChange({ ...filters, mode: m })}>
              {m === 'visual' ? 'Visual (CLIP)' : m.charAt(0).toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <div>
        <p className="label mb-2">Source</p>
        <select className="input w-full text-xs"
          value={filters.source_root_id ?? ''}
          onChange={(e) => onChange({ ...filters, source_root_id: e.target.value || undefined })}>
          <option value="">All sources</option>
          {sources?.map((s) => (
            <option key={s.id} value={s.id}>{s.label ?? s.path.split(/[\\/]/).pop()}</option>
          ))}
        </select>
      </div>

      {tagData?.tags && tagData.tags.length > 0 && (
        <div>
          <p className="label mb-2">Project</p>
          <select className="input w-full text-xs"
            value={filters.project_tag ?? ''}
            onChange={(e) => onChange({ ...filters, project_tag: e.target.value || undefined })}>
            <option value="">All projects</option>
            {tagData.tags.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
      )}

      <div>
        <p className="label mb-2">Duration</p>
        <div className="flex items-center gap-2">
          <input type="number" placeholder="Min s" className="input w-full text-xs"
            value={filters.min_duration ?? ''}
            onChange={(e) => onChange({ ...filters, min_duration: e.target.value ? +e.target.value : undefined })} />
          <span className="text-zinc-600">–</span>
          <input type="number" placeholder="Max s" className="input w-full text-xs"
            value={filters.max_duration ?? ''}
            onChange={(e) => onChange({ ...filters, max_duration: e.target.value ? +e.target.value : undefined })} />
        </div>
      </div>

      <div>
        <p className="label mb-2">Extension</p>
        <input type="text" placeholder=".mp4, .mov…" className="input w-full text-xs"
          value={filters.extension ?? ''}
          onChange={(e) => onChange({ ...filters, extension: e.target.value || undefined })} />
      </div>

      <button className="btn-ghost w-full text-xs" onClick={() => onChange({ mode: filters.mode })}>
        <X size={11} /> Reset filters
      </button>
    </div>
  )
}

function SearchHistoryPanel({ onSelect }: { onSelect: (q: string) => void }) {
  const { data } = useQuery('search-history', () => api.getSearchHistory())
  const qc = useQueryClient()

  if (!data?.history?.length) return (
    <div className="p-4 text-xs text-zinc-600">No search history yet</div>
  )

  return (
    <div className="p-2">
      <div className="flex items-center justify-between px-2 py-1 mb-1">
        <span className="label">Recent Searches</span>
        <button className="text-xs text-zinc-600 hover:text-zinc-400"
          onClick={() => { api.clearSearchHistory(); qc.invalidateQueries('search-history') }}>
          Clear
        </button>
      </div>
      {data.history.map((h) => (
        <button key={h.id}
          className="w-full text-left flex items-center gap-2 px-2 py-1.5 rounded hover:bg-surface-3 transition-colors"
          onClick={() => onSelect(h.query)}>
          <Clock size={11} className="text-zinc-600 flex-shrink-0" />
          <span className="text-sm text-zinc-300 truncate">{h.query}</span>
          <span className="text-xs text-zinc-600 ml-auto flex-shrink-0">{h.result_count}</span>
        </button>
      ))}
    </div>
  )
}

function BatchTagModal({ fileIds, onClose }: { fileIds: string[]; onClose: () => void }) {
  const [tag, setTag] = useState('')
  const [custom, setCustom] = useState('')
  const qc = useQueryClient()
  const { data: tagData } = useQuery('project-tags', () => api.getProjectTags())

  const applyTag = async (t: string) => {
    if (!t.trim()) return
    await api.batchTag(fileIds, t.trim())
    qc.invalidateQueries('search')
    qc.invalidateQueries('project-tags')
    qc.invalidateQueries('project-stats')
    toast.success(`Tagged ${fileIds.length} files as "${t.trim()}"`)
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="card p-5 w-80 space-y-4 animate-slide-up" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <p className="font-medium text-zinc-200">Tag {fileIds.length} files</p>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300"><X size={14} /></button>
        </div>

        {tagData?.tags && tagData.tags.length > 0 && (
          <div>
            <p className="label mb-2">Existing tags</p>
            <div className="flex flex-wrap gap-1.5">
              {tagData.tags.map((t) => (
                <button key={t}
                  className="badge bg-surface-3 text-zinc-300 hover:bg-accent/20 hover:text-accent cursor-pointer transition-colors"
                  onClick={() => applyTag(t)}>
                  {t}
                </button>
              ))}
            </div>
          </div>
        )}

        <div>
          <p className="label mb-2">New tag</p>
          <div className="flex gap-2">
            <input type="text" className="input flex-1 text-sm" placeholder="project name…"
              value={custom} onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && applyTag(custom)} autoFocus />
            <button className="btn-primary" onClick={() => applyTag(custom)}>Apply</button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function SearchPage() {
  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState('')
  const [filters, setFilters] = useState<Filters>(() => ({ mode: getSavedMode() }))

  const updateFilters = (f: Filters) => {
    if (f.mode !== filters.mode) localStorage.setItem(STORAGE_KEY, f.mode)
    setFilters(f)
  }
  const [showFilters, setShowFilters] = useState(true)
  const [showHistory, setShowHistory] = useState(false)
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [showBatchTag, setShowBatchTag] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const qc = useQueryClient()

  const searchReq: SearchRequest = {
    query: submitted,
    mode: filters.mode,
    n_results: 60,
    source_root_id: filters.source_root_id,
    min_duration: filters.min_duration,
    max_duration: filters.max_duration,
    is_vertical: filters.is_vertical,
    has_duplicates_only: filters.has_duplicates_only,
    unique_only: filters.unique_only,
    extension: filters.extension,
    project_tag: filters.project_tag,
  }

  const { data, isFetching, isError } = useQuery(
    ['search', searchReq],
    async () => {
      const result = await api.search(searchReq)
      if (submitted.trim()) {
        api.addSearchHistory(submitted, filters.mode, result.total)
          .then(() => qc.invalidateQueries('search-history'))
      }
      return result
    },
    { keepPreviousData: true, staleTime: 10_000 }
  )

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault()
    setSubmitted(query)
    setShowHistory(false)
  }, [query])

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectAll = () => {
    if (selected.size === results.length) setSelected(new Set())
    else setSelected(new Set(results.map(r => r.video_file_id)))
  }

  const results = data?.results ?? []
  const hasSelection = selected.size > 0

  return (
    <div className="flex flex-col h-full">
      {/* Search bar */}
      <div className="border-b border-surface-4 px-6 py-4">
        <form onSubmit={handleSubmit} className="flex items-center gap-3">
          <div className="relative flex-1">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none" />
            <input ref={inputRef} type="text"
              placeholder={filters.mode === 'visual' ? 'talking head shot, aerial coastline, person explaining something, drone over city…' : 'sunrise drone shot mountains, person talking indoors, clips mentioning Syria…'}
              className="input w-full pl-9 py-2"
              value={query}
              onChange={(e) => { setQuery(e.target.value); if (!e.target.value) setShowHistory(true) }}
              onFocus={() => !query && setShowHistory(true)}
              onBlur={() => setTimeout(() => setShowHistory(false), 200)} />
            {query && (
              <button type="button"
                onClick={() => { setQuery(''); setSubmitted(''); inputRef.current?.focus() }}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300">
                <X size={13} />
              </button>
            )}
          </div>
          <button type="submit" className="btn-primary">Search</button>
          <button type="button"
            className={cn('btn-ghost', showFilters && 'bg-surface-3')}
            onClick={() => setShowFilters(!showFilters)}>
            <SlidersHorizontal size={14} />
          </button>
          <div className="flex items-center gap-1 border border-surface-4 rounded">
            <button type="button"
              className={cn('p-1.5 rounded-l', view === 'grid' ? 'bg-surface-3 text-zinc-200' : 'text-zinc-500 hover:text-zinc-300')}
              onClick={() => setView('grid')}>
              <LayoutGrid size={13} />
            </button>
            <button type="button"
              className={cn('p-1.5 rounded-r', view === 'list' ? 'bg-surface-3 text-zinc-200' : 'text-zinc-500 hover:text-zinc-300')}
              onClick={() => setView('list')}>
              <List size={13} />
            </button>
          </div>
        </form>

        {/* Quick filters */}
        <div className="flex items-center gap-2 mt-2.5 flex-wrap">
          {QUICK_FILTERS.map((qf) => (
            <button key={qf.label}
              className={cn('badge cursor-pointer transition-colors',
                qf.active(filters)
                  ? 'bg-accent/20 text-accent border border-accent/40'
                  : 'bg-surface-3 text-zinc-400 hover:text-zinc-200')}
              onClick={() => updateFilters(qf.apply(filters))}>
              {qf.label}
            </button>
          ))}
          {(filters.is_vertical !== undefined || filters.has_duplicates_only ||
            filters.unique_only || filters.min_duration || filters.max_duration) && (
            <button className="text-xs text-zinc-600 hover:text-zinc-400 ml-1"
              onClick={() => updateFilters({ mode: filters.mode, source_root_id: filters.source_root_id, project_tag: filters.project_tag })}>
              clear
            </button>
          )}
        </div>

        {/* Stats + actions row */}
        <div className="flex items-center gap-4 mt-2">
          {isFetching && <Loader2 size={12} className="animate-spin text-zinc-500" />}
          {data && (
            <span className="text-xs text-zinc-500">
              {data.total.toLocaleString()} result{data.total !== 1 ? 's' : ''}
              {data.query && <> for <span className="text-zinc-400">"{data.query}"</span></>}
              {' · '}{data.mode}
            </span>
          )}
          {isError && <span className="text-xs text-red-400">Search error</span>}

          {results.length > 0 && (
            <div className="flex items-center gap-2 ml-auto">
              <button className="btn-ghost text-xs" onClick={selectAll}>
                {selected.size === results.length ? <CheckSquare size={12} /> : <Square size={12} />}
                {selected.size > 0 ? `${selected.size} selected` : 'Select all'}
              </button>
              {hasSelection && (
                <>
                  <button className="btn-ghost text-xs" onClick={() => setShowBatchTag(true)}>
                    <Tag size={12} /> Tag
                  </button>
                  <button className="btn-ghost text-xs"
                    onClick={() => api.exportSearchCsv(Array.from(selected)).then(() => toast.success('CSV exported'))}>
                    <Download size={12} /> Export CSV
                  </button>
                  <button className="btn-ghost text-xs" onClick={() => setSelected(new Set())}>
                    <X size={12} /> Clear
                  </button>
                </>
              )}
              {!hasSelection && (
                <button className="btn-ghost text-xs"
                  onClick={() => api.exportSearchCsv(results.map(r => r.video_file_id)).then(() => toast.success('CSV exported'))}>
                  <Download size={12} /> Export all
                </button>
              )}
            </div>
          )}
        </div>

        {/* Search history dropdown */}
        {showHistory && !query && (
          <div className="absolute z-20 left-6 right-6 mt-1 card shadow-xl max-h-64 overflow-y-auto"
            style={{ top: 'auto' }}>
            <SearchHistoryPanel onSelect={(q) => { setQuery(q); setSubmitted(q); setShowHistory(false) }} />
          </div>
        )}
      </div>

      <div className="flex flex-1 overflow-hidden relative">
        {showFilters && <FilterSidebar filters={filters} onChange={updateFilters} />}

        <div className="flex-1 overflow-auto p-4">
          {results.length === 0 && !isFetching && (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <Search size={32} className="text-zinc-700 mb-3" />
              <p className="text-zinc-400">
                {submitted ? 'No results found' : 'Enter a search query or browse using filters'}
              </p>
              {!submitted && (
                <button className="btn-ghost text-xs mt-3" onClick={() => setShowHistory(true)}>
                  <History size={12} /> View search history
                </button>
              )}
            </div>
          )}

          {results.length > 0 && view === 'grid' && (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
              {results.map((r) => (
                <div key={r.video_file_id} className="relative group/card">
                  {/* Selection checkbox */}
                  <button
                    className={cn(
                      'absolute top-2 left-2 z-10 rounded transition-all',
                      selected.has(r.video_file_id)
                        ? 'opacity-100'
                        : 'opacity-0 group-hover/card:opacity-100'
                    )}
                    onClick={(e) => { e.preventDefault(); toggleSelect(r.video_file_id) }}>
                    {selected.has(r.video_file_id)
                      ? <CheckSquare size={16} className="text-accent drop-shadow" />
                      : <Square size={16} className="text-white drop-shadow" />}
                  </button>
                  <VideoCard
                    result={r}
                    className={cn(selected.has(r.video_file_id) && 'ring-1 ring-accent/60')}
                    frameTimestamp={filters.mode === 'visual' ? r.frame_matches?.[0]?.timestamp : undefined}
                  />
                </div>
              ))}
            </div>
          )}

          {results.length > 0 && view === 'list' && (
            <div className="space-y-1">
              {results.map((r) => (
                <div key={r.video_file_id}
                  className={cn('card flex items-center gap-3 p-2 hover:border-surface-5 transition-colors',
                    selected.has(r.video_file_id) && 'ring-1 ring-accent/60')}>
                  <button className="flex-shrink-0 p-1"
                    onClick={() => toggleSelect(r.video_file_id)}>
                    {selected.has(r.video_file_id)
                      ? <CheckSquare size={14} className="text-accent" />
                      : <Square size={14} className="text-zinc-600" />}
                  </button>
                  <img src={api.thumbnailUrl(r.video_file_id)} alt={r.filename}
                    className="w-20 h-12 object-cover rounded flex-shrink-0 bg-surface-3"
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-zinc-200 truncate">{r.filename}</p>
                    {filters.mode === 'visual' && r.frame_matches?.[0] ? (
                      <p className="text-xs text-violet-400 truncate mt-0.5">
                        Visual match @ {r.frame_matches[0].timestamp.toFixed(0)}s
                      </p>
                    ) : r.matched_chunks[0] ? (
                      <p className="text-xs text-zinc-500 truncate mt-0.5">{r.matched_chunks[0].text}</p>
                    ) : null}
                  </div>
                  <span className="text-xs font-mono text-zinc-500 flex-shrink-0">
                    {r.duration_seconds ? `${Math.floor(r.duration_seconds)}s` : ''}
                  </span>
                  {r.best_score > 0 && (
                    <span className="text-xs font-mono text-amber-400 flex-shrink-0">
                      {(r.best_score * 100).toFixed(0)}%
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {showBatchTag && (
        <BatchTagModal
          fileIds={Array.from(selected)}
          onClose={() => { setShowBatchTag(false); setSelected(new Set()) }}
        />
      )}
    </div>
  )
}
