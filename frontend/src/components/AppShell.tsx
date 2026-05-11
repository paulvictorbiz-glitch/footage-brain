import { useState, useEffect, useRef } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { CommandPalette } from './CommandPalette'
import {
  LayoutDashboard,
  Search,
  Copy,
  FolderOpen,
  Folder,
  Film,
  Cpu,
  Clapperboard,
  Lightbulb,
  Layers,
  Video,
  CalendarDays,
  MapPin,
  Send,
  BarChart2,
  Users,
  Settings,
  PanelLeftClose,
  PanelLeftOpen,
  Menu,
  Bell,
  ChevronDown,
  CheckCircle2,
  AlertCircle,
  Loader2,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useQuery } from 'react-query'
import { api } from '@/api/client'

// ─── Nav structure ────────────────────────────────────────────

type NavItem = {
  to: string
  icon: React.ElementType
  label: string
  end?: boolean
  badgeKey?: string
  soon?: boolean
}

const NAV_SECTIONS: { label: string; items: NavItem[] }[] = [
  {
    label: 'Library',
    items: [
      { to: '/',           icon: LayoutDashboard, label: 'Overview',    end: true },
      { to: '/search',     icon: Search,          label: 'Search' },
      { to: '/folders',    icon: Folder,          label: 'Folders' },
      { to: '/duplicates', icon: Copy,            label: 'Duplicates', badgeKey: 'duplicates' },
    ],
  },
  {
    label: 'Production',
    items: [
      { to: '/ideas',      icon: Lightbulb,    label: 'Idea Inbox',  soon: true },
      { to: '/blueprints', icon: Layers,       label: 'Blueprints',  soon: true },
      { to: '/projects',   icon: Video,        label: 'Projects',    soon: true },
      { to: '/timeline',   icon: Clapperboard, label: 'Timeline' },
    ],
  },
  {
    label: 'Operations',
    items: [
      { to: '/calendar',   icon: CalendarDays, label: 'Calendar',   soon: true },
      { to: '/locations',  icon: MapPin,       label: 'Locations',  soon: true },
      { to: '/publishing', icon: Send,         label: 'Publishing', soon: true },
      { to: '/analytics',  icon: BarChart2,    label: 'Analytics',  soon: true },
    ],
  },
  {
    label: 'Workspace',
    items: [
      { to: '/team',     icon: Users,     label: 'Team',     soon: true },
      { to: '/sources',  icon: FolderOpen, label: 'Sources' },
      { to: '/settings', icon: Settings,  label: 'Settings', soon: true },
    ],
  },
]

// ─── Worker status pill ───────────────────────────────────────

function WorkerStatus({ collapsed }: { collapsed: boolean }) {
  const { data } = useQuery('job-queue', () => api.getJobQueue(), {
    refetchInterval: 3000,
    staleTime: 2000,
  })

  const pending    = data?.queue_stats?.pending    ?? 0
  const processing = data?.queue_stats?.processing ?? 0
  const active     = pending + processing

  if (collapsed) {
    return (
      <div className="flex justify-center py-2 px-2">
        <Cpu size={13} className={cn(active > 0 ? 'text-amber-400 animate-pulse' : 'text-zinc-600')} />
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2 mx-2 px-2.5 py-2 rounded bg-surface-3 text-xs font-mono text-zinc-400 overflow-hidden">
      <Cpu size={12} className={cn('flex-shrink-0', active > 0 ? 'text-amber-400 animate-pulse' : 'text-zinc-600')} />
      <span className="truncate">
        {active > 0
          ? <>{processing} processing · {pending} pending</>
          : <span className="text-zinc-600">Idle</span>}
      </span>
    </div>
  )
}

// ─── Notifications panel ──────────────────────────────────────

function NotifPanel({ onClose }: { onClose: () => void }) {
  const { data } = useQuery('job-queue', () => api.getJobQueue(), {
    staleTime: 5000,
  })

  const failed     = data?.failed     ?? []
  const processing = data?.processing ?? []
  const pending    = data?.queue_stats?.pending    ?? 0
  const proc       = data?.queue_stats?.processing ?? 0
  const failCount  = data?.queue_stats?.failed     ?? 0

  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  return (
    <div
      ref={ref}
      className="absolute top-[calc(100%+6px)] right-0 w-72 bg-surface-2 border border-surface-4 rounded-lg shadow-2xl z-50 overflow-hidden animate-slide-up"
    >
      <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-surface-4">
        <span className="text-xs font-semibold text-zinc-200">Pipeline status</span>
        <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 transition-colors">
          <X size={13} />
        </button>
      </div>

      {/* Live counts */}
      <div className="grid grid-cols-3 divide-x divide-surface-4 border-b border-surface-4">
        {[
          { label: 'Processing', value: proc,      color: 'text-amber-400' },
          { label: 'Pending',    value: pending,   color: 'text-zinc-400' },
          { label: 'Failed',     value: failCount, color: failCount > 0 ? 'text-red-400' : 'text-zinc-600' },
        ].map(({ label, value, color }) => (
          <div key={label} className="px-3 py-2.5 text-center">
            <div className={cn('text-base font-display font-semibold', color)}>{value}</div>
            <div className="text-[10px] text-zinc-600 mt-0.5">{label}</div>
          </div>
        ))}
      </div>

      {/* Recent items */}
      <div className="max-h-52 overflow-y-auto">
        {processing.slice(0, 2).map(job => (
          <div key={job.id} className="flex items-start gap-2.5 px-3.5 py-2.5 border-b border-surface-4">
            <Loader2 size={13} className="text-amber-400 animate-spin mt-0.5 flex-shrink-0" />
            <div className="min-w-0">
              <p className="text-xs text-zinc-300 truncate">{job.stage} — processing</p>
              <p className="text-[10px] text-zinc-600 mt-0.5 font-mono truncate">{job.video_file_id.slice(0, 8)}…</p>
            </div>
          </div>
        ))}

        {failed.slice(0, 3).map(job => (
          <div key={job.id} className="flex items-start gap-2.5 px-3.5 py-2.5 border-b border-surface-4">
            <AlertCircle size={13} className="text-red-400 mt-0.5 flex-shrink-0" />
            <div className="min-w-0">
              <p className="text-xs text-zinc-300 truncate">{job.stage} failed</p>
              {job.error_message && (
                <p className="text-[10px] text-zinc-600 mt-0.5 truncate">{job.error_message}</p>
              )}
            </div>
          </div>
        ))}

        {processing.length === 0 && failed.length === 0 && (
          <div className="flex items-center gap-2.5 px-3.5 py-3">
            <CheckCircle2 size={13} className="text-green-500 flex-shrink-0" />
            <span className="text-xs text-zinc-400">No active issues</span>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Top bar ──────────────────────────────────────────────────

function TopBar({ onToggle, onOpenCmd }: { onToggle: () => void; onOpenCmd: () => void }) {
  const [showNotifs, setShowNotifs] = useState(false)

  const { data: jobQueue } = useQuery('job-queue', () => api.getJobQueue(), {
    refetchInterval: 10_000,
    staleTime: 5_000,
  })

  const failCount = jobQueue?.queue_stats?.failed ?? 0
  const hasAlert  = failCount > 0

  // Ctrl+K / Cmd+K → open command palette
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault()
        onOpenCmd()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onOpenCmd])

  return (
    <div className="h-11 flex-shrink-0 flex items-center gap-3 px-4 bg-surface-1 border-b border-surface-4">

      {/* Sidebar toggle */}
      <button
        onClick={onToggle}
        className="flex items-center justify-center w-6 h-6 rounded text-zinc-500 hover:bg-surface-3 hover:text-zinc-300 transition-colors flex-shrink-0"
        title="Toggle sidebar"
      >
        <Menu size={14} />
      </button>

      {/* Search shortcut bar */}
      <div
        onClick={onOpenCmd}
        className="flex items-center gap-2 flex-1 max-w-xs bg-surface-2 border border-surface-4 rounded px-3 py-1.5 cursor-pointer hover:border-surface-5 transition-colors"
      >
        <Search size={12} className="text-zinc-500 flex-shrink-0" />
        <span className="text-xs text-zinc-500 flex-1 select-none">Search everything…</span>
        <kbd className="text-[10px] bg-surface-3 text-zinc-600 px-1.5 py-0.5 rounded font-mono border border-surface-4 leading-none select-none">
          Ctrl K
        </kbd>
      </div>

      <div className="ml-auto flex items-center gap-1.5">

        {/* Project switcher — placeholder, wired up when Projects feature ships */}
        <div className="flex items-center gap-1.5 bg-surface-2 border border-surface-4 rounded px-2.5 py-1.5 text-xs text-zinc-400 cursor-pointer hover:bg-surface-3 transition-colors select-none">
          <span className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" />
          <span>All footage</span>
          <ChevronDown size={11} className="text-zinc-600" />
        </div>

        {/* Notifications */}
        <div className="relative">
          <button
            onClick={() => setShowNotifs(v => !v)}
            className="flex items-center justify-center w-7 h-7 rounded text-zinc-500 hover:bg-surface-3 hover:text-zinc-300 transition-colors relative"
            title="Notifications"
          >
            <Bell size={14} />
            {hasAlert && (
              <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-red-500 border border-surface-1" />
            )}
          </button>
          {showNotifs && <NotifPanel onClose={() => setShowNotifs(false)} />}
        </div>

        {/* Avatar */}
        <div className="w-7 h-7 rounded-full bg-accent flex items-center justify-center text-[11px] font-bold font-display text-black cursor-pointer flex-shrink-0 ml-1">
          P
        </div>

      </div>
    </div>
  )
}

// ─── Sidebar ──────────────────────────────────────────────────

function Sidebar({
  collapsed,
  badges,
}: {
  collapsed: boolean
  badges: Record<string, string | undefined>
}) {
  return (
    <aside className={cn(
      'flex-shrink-0 flex flex-col bg-surface-1 border-r border-surface-4 transition-all duration-200 overflow-hidden',
      collapsed ? 'w-11' : 'w-52'
    )}>

      {/* Logo */}
      <div className={cn(
        'h-11 flex items-center border-b border-surface-4 flex-shrink-0',
        collapsed ? 'justify-center px-0' : 'gap-2 px-3'
      )}>
        <div className="w-[22px] h-[22px] rounded-[5px] bg-accent flex items-center justify-center flex-shrink-0">
          <Film size={12} color="#000" />
        </div>
        {!collapsed && (
          <span className="font-display font-bold text-sm text-zinc-100 whitespace-nowrap overflow-hidden">
            Footage<span className="text-accent">Brain</span>
          </span>
        )}
      </div>

      {/* Nav sections */}
      <nav className="flex-1 overflow-y-auto overflow-x-hidden py-2 space-y-3 px-1.5">
        {NAV_SECTIONS.map(section => (
          <div key={section.label}>
            {!collapsed && (
              <div className="px-2 pt-1 pb-0.5 text-[9px] font-mono uppercase tracking-[0.1em] text-zinc-600 select-none">
                {section.label}
              </div>
            )}

            {section.items.map(item => {
              const Icon  = item.icon
              const badge = badges[item.badgeKey ?? '']

              if (item.soon) {
                return (
                  <div
                    key={item.to}
                    title={collapsed ? `${item.label} — coming soon` : 'Coming soon'}
                    className={cn(
                      'flex items-center gap-2 px-2 py-1.5 rounded text-xs text-zinc-700 cursor-default select-none',
                      collapsed && 'justify-center'
                    )}
                  >
                    <Icon size={14} className="flex-shrink-0" />
                    {!collapsed && <span>{item.label}</span>}
                  </div>
                )
              }

              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  title={collapsed ? item.label : undefined}
                  className={({ isActive }) => cn(
                    'flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors duration-100 relative',
                    collapsed && 'justify-center',
                    isActive
                      ? 'bg-surface-3 text-zinc-100 font-medium'
                      : 'text-zinc-400 hover:bg-surface-3 hover:text-zinc-200'
                  )}
                >
                  {({ isActive }) => (
                    <>
                      {isActive && !collapsed && (
                        <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-4 bg-accent rounded-r" />
                      )}
                      <Icon size={14} className={cn('flex-shrink-0', isActive && 'text-accent')} />
                      {!collapsed && (
                        <>
                          <span className="flex-1">{item.label}</span>
                          {badge && (
                            <span className="font-mono text-[10px] bg-accent-dim text-accent px-1.5 py-0.5 rounded leading-none">
                              {badge}
                            </span>
                          )}
                        </>
                      )}
                      {collapsed && badge && (
                        <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-accent" />
                      )}
                    </>
                  )}
                </NavLink>
              )
            })}
          </div>
        ))}
      </nav>

      {/* Worker status */}
      <div className="flex-shrink-0 pb-3 pt-2 border-t border-surface-4">
        <WorkerStatus collapsed={collapsed} />
      </div>
    </aside>
  )
}

// ─── App shell ────────────────────────────────────────────────

export function AppShell({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(() =>
    localStorage.getItem('fb-sidebar-collapsed') === 'true'
  )
  const [showCmd, setShowCmd] = useState(false)

  const toggle = () => {
    setCollapsed(v => {
      const next = !v
      localStorage.setItem('fb-sidebar-collapsed', String(next))
      return next
    })
  }

  const { data: stats } = useQuery('dashboard-stats', () => api.getDashboardStats(), {
    staleTime: 30_000,
    refetchInterval: 60_000,
  })

  const badges: Record<string, string | undefined> = {
    duplicates: stats?.duplicate_groups ? String(stats.duplicate_groups) : undefined,
  }

  return (
    <div className="flex h-screen overflow-hidden bg-surface-0">

      <Sidebar collapsed={collapsed} badges={badges} />

      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        <TopBar onToggle={toggle} onOpenCmd={() => setShowCmd(true)} />
        <main className="flex-1 overflow-auto bg-surface-1">
          {children}
        </main>
      </div>

      {showCmd && <CommandPalette onClose={() => setShowCmd(false)} />}

    </div>
  )
}
