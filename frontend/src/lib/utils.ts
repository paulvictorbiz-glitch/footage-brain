import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}

export function formatDuration(seconds?: number): string {
  if (!seconds) return '--'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

export function formatTimecode(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const ms = Math.floor((seconds % 1) * 100)
  if (h > 0) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(2, '0')}`
}

export function formatDate(iso?: string): string {
  if (!iso) return '--'
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

export function pipelineStatus(file: {
  metadata_extracted: boolean
  hashed: boolean
  transcribed: boolean
  embedded: boolean
}): { label: string; color: string; pct: number } {
  const stages = [file.metadata_extracted, file.hashed, file.transcribed, file.embedded]
  const done = stages.filter(Boolean).length
  const pct = Math.round((done / stages.length) * 100)
  if (done === 0) return { label: 'Queued', color: 'text-zinc-500', pct: 0 }
  if (done < stages.length) return { label: `Indexing (${pct}%)`, color: 'text-amber-400', pct }
  return { label: 'Indexed', color: 'text-green-400', pct: 100 }
}

export function scoreColor(score: number): string {
  if (score >= 0.8) return 'text-green-400'
  if (score >= 0.6) return 'text-amber-400'
  if (score >= 0.4) return 'text-orange-400'
  return 'text-zinc-500'
}

export function extensionColor(ext: string): string {
  const map: Record<string, string> = {
    '.mp4': 'bg-blue-900/40 text-blue-300',
    '.mov': 'bg-purple-900/40 text-purple-300',
    '.mkv': 'bg-green-900/40 text-green-300',
    '.avi': 'bg-yellow-900/40 text-yellow-300',
    '.mxf': 'bg-red-900/40 text-red-300',
    '.braw': 'bg-orange-900/40 text-orange-300',
    '.r3d': 'bg-rose-900/40 text-rose-300',
    '.webm': 'bg-cyan-900/40 text-cyan-300',
  }
  return map[ext.toLowerCase()] ?? 'bg-zinc-800 text-zinc-400'
}
