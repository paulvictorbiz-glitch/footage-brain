import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import {
  FolderOpen, Plus, Trash2, RefreshCw, Settings,
  CheckCircle2, XCircle, Loader2, HardDrive, Clock,
} from 'lucide-react'
import toast from 'react-hot-toast'
import { api, type ScanRoot } from '@/api/client'
import { PageHeader } from '@/components/PageHeader'
import { formatBytes, formatDate, cn } from '@/lib/utils'

function SourceCard({
  source,
  onDelete,
  onScan,
  onToggle,
}: {
  source: ScanRoot
  onDelete: () => void
  onScan: () => void
  onToggle: () => void
}) {
  return (
    <div className={cn('card p-4', !source.enabled && 'opacity-60')}>
      <div className="flex items-start gap-3">
        <HardDrive size={16} className="text-zinc-500 mt-0.5 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm text-zinc-200">
              {source.label || source.path.split(/[\\/]/).pop() || source.path}
            </span>
            {!source.enabled && (
              <span className="badge bg-zinc-800 text-zinc-500">Disabled</span>
            )}
            {source.recursive && (
              <span className="badge bg-surface-3 text-zinc-500">Recursive</span>
            )}
          </div>
          <p className="text-xs text-zinc-500 font-mono mt-0.5 break-all">{source.path}</p>
          <div className="flex items-center gap-4 mt-2 text-xs text-zinc-600">
            <span>{(source.file_count ?? 0).toLocaleString()} files</span>
            {source.last_scanned_at && (
              <span className="flex items-center gap-1">
                <Clock size={10} />
                Last scan: {formatDate(source.last_scanned_at)}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button className="btn-ghost text-xs" onClick={onScan}>
            <RefreshCw size={12} /> Scan
          </button>
          <button
            className="btn-ghost text-xs"
            onClick={onToggle}
          >
            {source.enabled ? <XCircle size={12} /> : <CheckCircle2 size={12} />}
            {source.enabled ? 'Disable' : 'Enable'}
          </button>
          <button className="btn-danger text-xs" onClick={onDelete}>
            <Trash2 size={12} />
          </button>
        </div>
      </div>
    </div>
  )
}

function AddSourceForm({ onAdd }: { onAdd: (path: string, label?: string, recursive?: boolean) => void }) {
  const [path, setPath] = useState('')
  const [label, setLabel] = useState('')
  const [recursive, setRecursive] = useState(true)
  const [show, setShow] = useState(false)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!path.trim()) return
    onAdd(path.trim(), label.trim() || undefined, recursive)
    setPath('')
    setLabel('')
    setShow(false)
  }

  if (!show) {
    return (
      <button className="btn-primary" onClick={() => setShow(true)}>
        <Plus size={13} /> Add Source
      </button>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="card p-4 space-y-3 animate-slide-up">
      <p className="text-sm font-medium text-zinc-200">Add Source Folder</p>
      <div>
        <label className="label mb-1 block">Folder Path</label>
        <input
          type="text"
          className="input w-full"
          placeholder="D:\Videos\Projects or /mnt/external/footage"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          autoFocus
        />
        <p className="text-xs text-zinc-600 mt-1">
          Absolute path to a local drive, external drive, or mounted folder.
          Google Drive, OneDrive etc. work if mounted as a drive letter (Windows) or mount point.
        </p>
      </div>
      <div>
        <label className="label mb-1 block">Label (optional)</label>
        <input
          type="text"
          className="input w-full"
          placeholder="Main Archive, External SSD…"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
      </div>
      <div className="flex items-center gap-2">
        <input
          id="recursive"
          type="checkbox"
          checked={recursive}
          onChange={(e) => setRecursive(e.target.checked)}
          className="accent-amber-500"
        />
        <label htmlFor="recursive" className="text-sm text-zinc-300">
          Scan subfolders recursively
        </label>
      </div>
      <div className="flex gap-2 pt-1">
        <button type="submit" className="btn-primary">
          <FolderOpen size={13} /> Add Source
        </button>
        <button type="button" className="btn-ghost" onClick={() => setShow(false)}>
          Cancel
        </button>
      </div>
    </form>
  )
}

function SettingsPanel() {
  const { data: settings } = useQuery('app-settings', () => api.getSettings())

  if (!settings) return null

  return (
    <div className="card p-4 space-y-3">
      <p className="label">Runtime Configuration</p>
      <p className="text-xs text-zinc-500">
        These settings are configured via <code className="font-mono bg-surface-3 px-1 py-0.5 rounded">.env</code> file.
        Restart the backend to apply changes.
      </p>
      <div className="grid grid-cols-2 gap-x-6 gap-y-2">
        {[
          ['Whisper model', settings.whisper_model],
          ['Whisper device', settings.whisper_device],
          ['Embed model', settings.embed_model],
          ['Ingest workers', settings.ingest_workers],
          ['Frame interval', `${settings.frame_sample_interval}s`],
          ['Thumbnails dir', settings.thumbnails_dir],
          ['Chroma dir', settings.chroma_dir],
        ].map(([k, v]) => (
          <div key={k} className="flex gap-2">
            <span className="text-xs text-zinc-500 w-36 flex-shrink-0">{k}</span>
            <span className="text-xs text-zinc-300 font-mono">{String(v)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function SourcesPage() {
  const qc = useQueryClient()

  const { data: sources, isLoading } = useQuery('sources', () => api.getSources())

  const addMut = useMutation(
    ({ path, label, recursive }: { path: string; label?: string; recursive?: boolean }) =>
      api.addSource(path, label, recursive),
    {
      onSuccess: () => {
        qc.invalidateQueries('sources')
        toast.success('Source added')
      },
      onError: (err: any) => {
        toast.error(err?.response?.data?.detail ?? 'Failed to add source')
      },
    }
  )

  const deleteMut = useMutation((id: string) => api.deleteSource(id), {
    onSuccess: () => {
      qc.invalidateQueries('sources')
      toast.success('Source removed')
    },
  })

  const toggleMut = useMutation(
    ({ id, enabled }: { id: string; enabled: boolean }) => api.updateSource(id, { enabled }),
    { onSuccess: () => qc.invalidateQueries('sources') }
  )

  const scanMut = useMutation((id: string) => api.scanSource(id), {
    onSuccess: (data) => {
      qc.invalidateQueries('sources')
      qc.invalidateQueries('dashboard-stats')
      toast.success(`Scan complete · ${data.summary?.found ?? 0} found, ${data.summary?.new ?? 0} new`)
    },
    onError: () => { toast.error('Scan failed') },
  })

  const scanAllMut = useMutation(() => api.scanAll(), {
    onSuccess: () => {
      qc.invalidateQueries('sources')
      qc.invalidateQueries('dashboard-stats')
      toast.success('All sources scanned')
    },
  })

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Sources"
        subtitle="Manage scan roots and configure pipeline settings"
        actions={
          <button
            className="btn-ghost text-xs"
            onClick={() => scanAllMut.mutate()}
            disabled={scanAllMut.isLoading}
          >
            <RefreshCw size={12} className={cn(scanAllMut.isLoading && 'animate-spin')} />
            Scan All
          </button>
        }
      />

      <div className="flex-1 overflow-auto p-6 space-y-4">
        <AddSourceForm
          onAdd={(path, label, recursive) => addMut.mutate({ path, label, recursive })}
        />

        {isLoading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={20} className="animate-spin text-zinc-600" />
          </div>
        )}

        {sources?.length === 0 && !isLoading && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <FolderOpen size={32} className="text-zinc-700 mb-3" />
            <p className="text-zinc-400">No source folders configured</p>
            <p className="text-zinc-600 text-sm mt-1">
              Add a folder path above to start indexing your footage.
            </p>
          </div>
        )}

        <div className="space-y-2">
          {sources?.map((s) => (
            <SourceCard
              key={s.id}
              source={s}
              onDelete={() => deleteMut.mutate(s.id)}
              onScan={() => scanMut.mutate(s.id)}
              onToggle={() => toggleMut.mutate({ id: s.id, enabled: !s.enabled })}
            />
          ))}
        </div>

        <div className="pt-2">
          <SettingsPanel />
        </div>
      </div>
    </div>
  )
}
