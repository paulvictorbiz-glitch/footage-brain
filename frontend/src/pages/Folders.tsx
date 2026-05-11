import { useState, useMemo } from 'react'
import { useQuery } from 'react-query'
import { Folder, FolderOpen, HardDrive, ChevronRight, ChevronDown, Search } from 'lucide-react'
import { api } from '@/api/client'
import { PageHeader } from '@/components/PageHeader'
import { VideoCard } from '@/components/VideoCard'
import { formatBytes, formatDuration, cn } from '@/lib/utils'

interface FolderEntry {
  path: string
  file_count: number
  total_bytes: number
  total_duration: number
}

interface RootEntry {
  root_id: string
  root_label: string
  root_path: string
  folders: FolderEntry[]
}

interface TreeNode {
  name: string
  fullPath: string
  children: Record<string, TreeNode>
  file_count: number
  total_bytes: number
  total_duration: number
}

function buildTree(folders: FolderEntry[]): Record<string, TreeNode> {
  const root: Record<string, TreeNode> = {}
  for (const folder of folders) {
    if (!folder.path) continue
    const parts = folder.path.split(/[\\/]/).filter(Boolean)
    let current = root
    let accumulated = ''
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      accumulated = accumulated ? accumulated + '\\' + part : part
      if (!current[part]) {
        current[part] = {
          name: part,
          fullPath: accumulated,
          children: {},
          file_count: 0,
          total_bytes: 0,
          total_duration: 0,
        }
      }
      if (i === parts.length - 1) {
        current[part].file_count += folder.file_count
        current[part].total_bytes += folder.total_bytes
        current[part].total_duration += folder.total_duration
      }
      current = current[part].children
    }
  }
  return root
}

function TreeNodeRow({
  node,
  depth,
  selectedPath,
  onSelect,
  defaultExpanded,
}: {
  node: TreeNode
  depth: number
  selectedPath: string | null
  onSelect: (path: string) => void
  defaultExpanded: boolean
}) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const hasChildren = Object.keys(node.children).length > 0
  const isSelected = selectedPath === node.fullPath

  return (
    <div>
      <button
        className={cn(
          'w-full flex items-center gap-1.5 py-1.5 pr-3 text-left text-sm transition-colors group',
          isSelected
            ? 'bg-accent/10 text-accent border-l-2 border-accent'
            : 'text-zinc-300 hover:bg-surface-3 border-l-2 border-transparent'
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => {
          onSelect(node.fullPath)
          if (hasChildren) setExpanded(!expanded)
        }}
      >
        {hasChildren ? (
          expanded ? (
            <ChevronDown size={12} className="flex-shrink-0 text-zinc-500" />
          ) : (
            <ChevronRight size={12} className="flex-shrink-0 text-zinc-500" />
          )
        ) : (
          <span className="w-3 flex-shrink-0" />
        )}
        {isSelected ? (
          <FolderOpen size={13} className="flex-shrink-0 text-accent" />
        ) : (
          <Folder size={13} className="flex-shrink-0 text-zinc-500 group-hover:text-zinc-300" />
        )}
        <span className="truncate flex-1">{node.name}</span>
        <span className="text-xs text-zinc-600 flex-shrink-0">{node.file_count}</span>
      </button>
      {expanded && hasChildren && (
        <div>
          {Object.values(node.children)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((child) => (
              <TreeNodeRow
                key={child.fullPath}
                node={child}
                depth={depth + 1}
                selectedPath={selectedPath}
                onSelect={onSelect}
                defaultExpanded={false}
              />
            ))}
        </div>
      )}
    </div>
  )
}

export default function FoldersPage() {
  const [selectedRoot, setSelectedRoot] = useState<RootEntry | null>(null)
  const [selectedRelPath, setSelectedRelPath] = useState<string | null>(null)
  const [folderSearch, setFolderSearch] = useState('')
  const [sortBy, setSortBy] = useState<string>('date')

  const { data: roots, isLoading } = useQuery('folder-structure', () => api.getFolderStructure())

  const selectedAbsFolder = useMemo(() => {
    if (!selectedRoot) return undefined
    if (!selectedRelPath) return selectedRoot.root_path
    const sep = selectedRoot.root_path.endsWith('\\') || selectedRoot.root_path.endsWith('/')
      ? ''
      : '\\'
    return selectedRoot.root_path + sep + selectedRelPath
  }, [selectedRoot, selectedRelPath])

  const { data: files, isLoading: filesLoading } = useQuery(
    ['folder-files', selectedAbsFolder, sortBy],
    () => api.getFiles({ abs_folder: selectedAbsFolder, limit: 200, sort_by: sortBy }),
    { enabled: !!selectedAbsFolder }
  )

  const treeByRoot = useMemo(() => {
    if (!roots) return {}
    const result: Record<string, Record<string, TreeNode>> = {}
    for (const root of roots as RootEntry[]) {
      result[root.root_id] = buildTree(root.folders)
    }
    return result
  }, [roots])

  const filteredRoots = useMemo(() => {
    if (!roots) return []
    if (!folderSearch.trim()) return roots as RootEntry[]
    const q = folderSearch.toLowerCase()
    return (roots as RootEntry[]).map((root) => ({
      ...root,
      folders: root.folders.filter((f) => f.path.toLowerCase().includes(q)),
    })).filter((r) => r.folders.length > 0)
  }, [roots, folderSearch])

  const selectedFolderEntry = useMemo(() => {
    if (!selectedRoot || !selectedRelPath) return null
    return selectedRoot.folders.find((f) => f.path === selectedRelPath) ?? null
  }, [selectedRoot, selectedRelPath])

  const breadcrumb = useMemo(() => {
    if (!selectedRoot) return 'No folder selected'
    if (!selectedRelPath) return selectedRoot.root_label || selectedRoot.root_path
    return (selectedRoot.root_label || selectedRoot.root_path) + ' / ' + selectedRelPath.replace(/\\/g, ' / ')
  }, [selectedRoot, selectedRelPath])

  if (isLoading) {
    return (
      <div className="flex flex-col h-full">
        <PageHeader title="Folders" subtitle="Browse your files by folder structure" />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-zinc-500">Loading folders...</div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <PageHeader title="Folders" subtitle="Browse your files by folder structure" />

      <div className="flex flex-1 overflow-hidden">
        <div className="w-60 flex-shrink-0 border-r border-surface-4 flex flex-col overflow-hidden bg-surface-1">
          <div className="p-2 border-b border-surface-4">
            <div className="relative">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500" />
              <input
                type="text"
                placeholder="Search folders..."
                className="input w-full pl-7 text-xs py-1.5"
                value={folderSearch}
                onChange={(e) => setFolderSearch(e.target.value)}
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {filteredRoots.map((root) => {
              const tree = treeByRoot[root.root_id] ?? buildTree(root.folders)
              const totalFiles = root.folders.reduce((s, f) => s + f.file_count, 0)
              const totalBytes = root.folders.reduce((s, f) => s + f.total_bytes, 0)
              const isRootSelected = selectedRoot?.root_id === root.root_id && !selectedRelPath

              return (
                <div key={root.root_id}>
                  <div className="px-3 pt-3 pb-1">
                    <div className="flex items-center gap-1.5 text-zinc-400 mb-0.5">
                      <HardDrive size={12} className="flex-shrink-0" />
                      <span className="text-xs font-semibold truncate">{root.root_label || 'Drive'}</span>
                    </div>
                    <div className="text-xs text-zinc-600 pl-4 truncate">{root.root_path}</div>
                    <div className="text-xs text-zinc-600 pl-4">{totalFiles} files · {formatBytes(totalBytes)}</div>
                  </div>

                  <button
                    className={cn(
                      'w-full flex items-center gap-1.5 py-1.5 px-3 text-left text-sm transition-colors border-l-2',
                      isRootSelected
                        ? 'bg-accent/10 text-accent border-accent'
                        : 'text-zinc-400 hover:bg-surface-3 border-transparent'
                    )}
                    onClick={() => {
                      setSelectedRoot(root)
                      setSelectedRelPath(null)
                    }}
                  >
                    <FolderOpen size={13} className="flex-shrink-0" />
                    <span className="flex-1 text-xs">All files</span>
                    <span className="text-xs text-zinc-600">{totalFiles}</span>
                  </button>

                  {Object.values(tree)
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map((node) => (
                      <TreeNodeRow
                        key={node.fullPath}
                        node={node}
                        depth={1}
                        selectedPath={selectedRoot?.root_id === root.root_id ? selectedRelPath : null}
                        onSelect={(path) => {
                          setSelectedRoot(root)
                          setSelectedRelPath(path)
                        }}
                        defaultExpanded={true}
                      />
                    ))}
                </div>
              )
            })}

            {(!filteredRoots || filteredRoots.length === 0) && (
              <div className="text-center py-8">
                <Folder size={28} className="text-zinc-700 mx-auto mb-2" />
                <div className="text-xs text-zinc-600">No folders found</div>
              </div>
            )}
          </div>
        </div>

        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-surface-4 flex-shrink-0">
            <div className="min-w-0">
              <div className="text-sm font-medium text-zinc-200 truncate">{breadcrumb}</div>
              {selectedAbsFolder && (
                <div className="text-xs text-zinc-500 mt-0.5">
                  {filesLoading ? 'Loading...' : `${files?.length ?? 0} files`}
                  {selectedFolderEntry && ` · ${formatBytes(selectedFolderEntry.total_bytes)}`}
                  {selectedFolderEntry && selectedFolderEntry.total_duration > 0 && ` · ${formatDuration(selectedFolderEntry.total_duration)}`}
                </div>
              )}
            </div>
            <select
              className="input text-xs py-1 pl-2 pr-6 flex-shrink-0 ml-3"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
            >
              <option value="date">Date</option>
              <option value="name">Name</option>
              <option value="size">Size</option>
              <option value="duration">Duration</option>
            </select>
          </div>

          <div className="flex-1 overflow-y-auto p-4">
            {!selectedAbsFolder && (
              <div className="flex flex-col items-center justify-center h-full text-center">
                <Folder size={40} className="text-zinc-700 mb-3" />
                <p className="text-zinc-500 text-sm">Select a folder to browse files</p>
              </div>
            )}

            {selectedAbsFolder && filesLoading && (
              <div className="flex items-center justify-center h-32">
                <div className="text-zinc-500 text-sm">Loading files...</div>
              </div>
            )}

            {selectedAbsFolder && !filesLoading && files?.length === 0 && (
              <div className="flex flex-col items-center justify-center h-32 text-center">
                <Folder size={32} className="text-zinc-700 mb-2" />
                <p className="text-zinc-500 text-sm">No files in this folder</p>
              </div>
            )}

            {selectedAbsFolder && !filesLoading && files && files.length > 0 && (
              <div className="grid grid-cols-4 gap-3">
                {files.map((file) => (
                  <VideoCard key={file.id} file={file} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
