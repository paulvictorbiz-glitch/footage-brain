import { useQuery } from 'react-query'
import { AlertTriangle } from 'lucide-react'
import { api } from '@/api/client'
import { formatBytes, cn } from '@/lib/utils'

/**
 * Compact horizontal bar used to render storage usage on the dashboard.
 * Exported so the storage-by-source card on the dashboard page can reuse it
 * without redefining the markup.
 */
export function StorageBar({
  bytes,
  maxBytes,
  label,
}: {
  bytes: number
  maxBytes: number
  label: string
}) {
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

export function DriveHealthCard() {
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
