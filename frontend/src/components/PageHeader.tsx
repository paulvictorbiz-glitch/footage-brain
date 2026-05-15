import { cn } from '@/lib/utils'

interface PageHeaderProps {
  title: string
  subtitle?: string
  actions?: React.ReactNode
  className?: string
}

export function PageHeader({ title, subtitle, actions, className }: PageHeaderProps) {
  return (
    <div className={cn('flex items-start justify-between px-6 py-5 border-b border-surface-4 bg-surface-1', className)}>
      <div>
        <h1 className="title-serif text-[26px]">{title}</h1>
        {subtitle && <p className="text-xs text-zinc-500 mt-1 font-mono tracking-wide">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}
