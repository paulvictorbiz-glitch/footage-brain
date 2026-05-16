import { useQuery, useMutation, useQueryClient } from 'react-query'
import {
  Film, HardDrive, Copy, Clock, RefreshCw, AlertTriangle,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import toast from 'react-hot-toast'
import { api } from '@/api/client'
import { PageHeader } from '@/components/PageHeader'
import { StatCard } from '@/components/StatCard'
import { VideoCard } from '@/components/VideoCard'
import { ThermalCard } from '@/components/ThermalCard'
import { PhaseAnalyticsCard } from '@/components/PhaseAnalyticsCard'
import {
  DriveHealthCard,
  StorageBar,
} from '@/components/cards/DriveHealthCard'
import { IndexingSpeedCard } from '@/components/cards/IndexingSpeedCard'
import { ProjectBreakdownCard } from '@/components/cards/ProjectBreakdownCard'
import { formatBytes, cn } from '@/lib/utils'

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

        <PhaseAnalyticsCard />

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
