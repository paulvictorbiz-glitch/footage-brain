import { cn } from '@/lib/utils'
import type { LucideIcon } from 'lucide-react'

interface StatCardProps {
  label: string
  value: string | number
  sub?: string
  icon?: LucideIcon
  accent?: boolean
  className?: string
}

export function StatCard({ label, value, sub, icon: Icon, accent, className }: StatCardProps) {
  return (
    <div className={cn('card p-4 flex flex-col gap-2', accent && 'border-accent/30', className)}>
      <div className="flex items-center justify-between">
        <span className="label">{label}</span>
        {Icon && <Icon size={14} className={cn('text-zinc-600', accent && 'text-accent/70')} />}
      </div>
      <span className={cn('font-display font-semibold text-2xl', accent ? 'text-accent' : 'text-zinc-100')}>
        {value}
      </span>
      {sub && <span className="text-xs text-zinc-500">{sub}</span>}
    </div>
  )
}
