import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Search,
  LayoutDashboard,
  Folder,
  Copy,
  FolderOpen,
  Clapperboard,
  RefreshCw,
  Film,
  ChevronRight,
  ArrowRight,
  Loader2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { api, type SearchResult } from '@/api/client'

// ─── Static command lists ─────────────────────────────────────

const NAV_COMMANDS = [
  { label: 'Overview',   to: '/',           icon: LayoutDashboard },
  { label: 'Search',     to: '/search',     icon: Search },
  { label: 'Folders',    to: '/folders',    icon: Folder },
  { label: 'Duplicates', to: '/duplicates', icon: Copy },
  { label: 'Timeline',   to: '/timeline',   icon: Clapperboard },
  { label: 'Sources',    to: '/sources',    icon: FolderOpen },
]

const ACTION_COMMANDS = [
  { label: 'Scan all sources', actionKey: 'scan-all', icon: RefreshCw },
]

// ─── Item types ───────────────────────────────────────────────

type NavItem    = { kind: 'nav';    label: string; to: string;        icon: React.ElementType }
type ActionItem = { kind: 'action'; label: string; actionKey: string; icon: React.ElementType }
type FileItem   = { kind: 'file' } & SearchResult

type AnyItem = NavItem | ActionItem | FileItem

// ─── Helpers ──────────────────────────────────────────────────

function fmtDur(s?: number) {
  if (!s) return ''
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${String(sec).padStart(2, '0')}`
}

// ─── Component ───────────────────────────────────────────────

interface CommandPaletteProps {
  onClose: () => void
}

export function CommandPalette({ onClose }: CommandPaletteProps) {
  const navigate = useNavigate()
  const inputRef  = useRef<HTMLInputElement>(null)

  const [query,       setQuery]       = useState('')
  const [fileResults, setFileResults] = useState<SearchResult[]>([])
  const [searching,   setSearching]   = useState(false)
  const [focusedIdx,  setFocusedIdx]  = useState(0)

  // Auto-focus input on open
  useEffect(() => { inputRef.current?.focus() }, [])

  // Debounced file search
  useEffect(() => {
    if (query.length < 2) { setFileResults([]); return }
    const t = setTimeout(async () => {
      setSearching(true)
      try {
        const res = await api.search({ query, mode: 'keyword', n_results: 6 })
        setFileResults(res.results)
      } catch {
        setFileResults([])
      } finally {
        setSearching(false)
      }
    }, 280)
    return () => clearTimeout(t)
  }, [query])

  // Reset focus whenever visible items change
  useEffect(() => { setFocusedIdx(0) }, [query])

  // Build filtered lists
  const lq = query.toLowerCase()
  const visibleNav = query
    ? NAV_COMMANDS.filter(c => c.label.toLowerCase().includes(lq))
    : NAV_COMMANDS
  const visibleActions = query
    ? ACTION_COMMANDS.filter(c => c.label.toLowerCase().includes(lq))
    : ACTION_COMMANDS

  // Flat list for keyboard nav — recalculated each render, refs keep handlers fresh
  const allItems: AnyItem[] = [
    ...visibleNav.map(c    => ({ kind: 'nav'    as const, ...c })),
    ...visibleActions.map(c => ({ kind: 'action' as const, ...c })),
    ...fileResults.map(f    => ({ kind: 'file'   as const, ...f })),
  ]

  // Refs so keyboard handler never goes stale
  const allItemsRef   = useRef(allItems)
  allItemsRef.current = allItems
  const focusedRef    = useRef(focusedIdx)
  focusedRef.current  = focusedIdx

  const execute = useCallback((item: AnyItem) => {
    if (item.kind === 'nav') {
      navigate(item.to)
    } else if (item.kind === 'action') {
      if (item.actionKey === 'scan-all') api.scanAll().catch(() => {})
    } else {
      navigate(`/files/${item.video_file_id}`)
    }
    onClose()
  }, [navigate, onClose])

  // Keyboard: arrows, enter, escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setFocusedIdx(i => Math.min(i + 1, allItemsRef.current.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setFocusedIdx(i => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        const item = allItemsRef.current[focusedRef.current]
        if (item) execute(item)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose, execute])

  const navOffset    = 0
  const actionOffset = visibleNav.length
  const fileOffset   = visibleNav.length + visibleActions.length

  const isEmpty =
    query.length >= 2 &&
    !searching &&
    fileResults.length === 0 &&
    visibleNav.length === 0 &&
    visibleActions.length === 0

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-start justify-center pt-20"
      onClick={onClose}
    >
      <div
        className="w-[560px] bg-surface-2 border border-surface-5 rounded-xl shadow-2xl overflow-hidden animate-slide-up"
        onClick={e => e.stopPropagation()}
      >

        {/* ── Input ── */}
        <div className="flex items-center gap-3 px-4 py-3.5 border-b border-surface-4">
          <Search size={16} className="text-zinc-500 flex-shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search pages, files, actions…"
            className="flex-1 bg-transparent text-[15px] text-zinc-100 placeholder-zinc-600 outline-none"
          />
          {searching && <Loader2 size={14} className="text-zinc-600 animate-spin flex-shrink-0" />}
          <kbd className="text-[10px] bg-surface-3 text-zinc-600 px-1.5 py-0.5 rounded font-mono border border-surface-4 leading-none select-none">
            ESC
          </kbd>
        </div>

        {/* ── Results ── */}
        <div className="max-h-[400px] overflow-y-auto">

          {/* Navigate */}
          {visibleNav.length > 0 && (
            <div>
              <div className="px-4 pt-3 pb-1 text-[9px] font-mono uppercase tracking-[0.1em] text-zinc-600 select-none">
                Navigate
              </div>
              {visibleNav.map((item, i) => {
                const Icon = item.icon
                const idx  = navOffset + i
                return (
                  <div
                    key={item.to}
                    onMouseEnter={() => setFocusedIdx(idx)}
                    onClick={() => execute({ kind: 'nav', ...item })}
                    className={cn(
                      'flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors text-sm',
                      focusedIdx === idx ? 'bg-surface-3 text-zinc-100' : 'text-zinc-400 hover:bg-surface-3 hover:text-zinc-200'
                    )}
                  >
                    <Icon size={14} className="flex-shrink-0" />
                    <span className="flex-1">{item.label}</span>
                    <ChevronRight size={12} className="text-zinc-600" />
                  </div>
                )
              })}
            </div>
          )}

          {/* Actions */}
          {visibleActions.length > 0 && (
            <div>
              <div className="px-4 pt-3 pb-1 text-[9px] font-mono uppercase tracking-[0.1em] text-zinc-600 select-none">
                Actions
              </div>
              {visibleActions.map((item, i) => {
                const Icon = item.icon
                const idx  = actionOffset + i
                return (
                  <div
                    key={item.label}
                    onMouseEnter={() => setFocusedIdx(idx)}
                    onClick={() => execute({ kind: 'action', ...item })}
                    className={cn(
                      'flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors text-sm',
                      focusedIdx === idx ? 'bg-surface-3 text-zinc-100' : 'text-zinc-400 hover:bg-surface-3 hover:text-zinc-200'
                    )}
                  >
                    <Icon size={14} className="flex-shrink-0" />
                    <span className="flex-1">{item.label}</span>
                    <ArrowRight size={12} className="text-zinc-600" />
                  </div>
                )
              })}
            </div>
          )}

          {/* Files */}
          {fileResults.length > 0 && (
            <div>
              <div className="px-4 pt-3 pb-1 text-[9px] font-mono uppercase tracking-[0.1em] text-zinc-600 select-none">
                Files
              </div>
              {fileResults.map((file, i) => {
                const idx = fileOffset + i
                return (
                  <div
                    key={file.video_file_id}
                    onMouseEnter={() => setFocusedIdx(idx)}
                    onClick={() => execute({ kind: 'file', ...file })}
                    className={cn(
                      'flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors text-sm',
                      focusedIdx === idx ? 'bg-surface-3 text-zinc-100' : 'text-zinc-400 hover:bg-surface-3 hover:text-zinc-200'
                    )}
                  >
                    <Film size={14} className="flex-shrink-0 text-zinc-600" />
                    <span className="flex-1 truncate font-mono text-xs">{file.filename}</span>
                    {file.duration_seconds && (
                      <span className="text-[11px] font-mono text-zinc-600 flex-shrink-0">
                        {fmtDur(file.duration_seconds)}
                      </span>
                    )}
                    <span className="text-[10px] font-mono text-zinc-700 ml-1 flex-shrink-0">
                      {file.extension}
                    </span>
                  </div>
                )
              })}
            </div>
          )}

          {/* Empty state */}
          {isEmpty && (
            <div className="px-4 py-10 text-center text-sm text-zinc-600">
              No results for "<span className="text-zinc-500">{query}</span>"
            </div>
          )}

          {/* Default empty (no query) */}
          {!query && (
            <div className="px-4 pb-3" />
          )}

        </div>

        {/* ── Footer hints ── */}
        <div className="flex items-center gap-4 px-4 py-2 border-t border-surface-4 text-[10px] font-mono text-zinc-700 select-none">
          <span>↑↓ navigate</span>
          <span>↵ select</span>
          <span>esc close</span>
          {query.length >= 2 && (
            <span className="ml-auto text-zinc-700">
              searching your {fileResults.length > 0 ? `${fileResults.length} files` : 'library'}
            </span>
          )}
        </div>

      </div>
    </div>
  )
}
