import { useQuery } from 'react-query'
import { Tag } from 'lucide-react'
import { api } from '@/api/client'

export function ProjectBreakdownCard() {
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
