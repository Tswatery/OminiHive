import React, { useState, useEffect, useRef } from 'react'
import { ChevronRight, GitBranch, MessageSquarePlus, RefreshCw, X } from 'lucide-react'
import { ScrollArea } from './OverlayScrollbar'
import { FileTypeIcon } from './FileTypeIcon'

export type FileEntry = {
  name: string
  path: string
  relPath: string
  isDir: boolean
  size: number
  ext: string
  gitStatus?: 'M' | 'A' | 'D' | 'R' | 'U'
}

export type GitStatusResult = {
  isRepo: boolean
  branch: string
  files: Record<string, 'M' | 'A' | 'D' | 'R' | 'U'>
  dirs: Record<string, boolean>
  changes: FileEntry[]
}

export type PreviewResult =
  | { kind: 'image'; name: string; path: string; size: number; dataUrl: string }
  | { kind: 'pdf'; name: string; path: string; size: number; dataUrl: string }
  | { kind: 'markdown' | 'text'; name: string; path: string; ext: string; size: number; truncated?: boolean; content: string }
  | { kind: 'binary'; name: string; path: string; size: number; note?: string }

function GitStatusBadge({ code }: { code?: 'M' | 'A' | 'D' | 'R' | 'U' }) {
  if (!code) return null
  const label = code === 'U' || code === 'A' ? '+' : code === 'D' ? '−' : code
  const title = code === 'U' ? '未跟踪（新增）' : code === 'A' ? '已暂存新增' : code === 'D' ? '已删除' : code === 'R' ? '已重命名' : '已修改'
  return <span className={'git-badge ' + code.toLowerCase()} title={title}>{label}</span>
}

export function FileDrawer({
  roomId,
  projectName,
  activePreviewPath,
  onClose,
  onInsertPath,
  onPreviewFile,
  onFileContextMenu
}: {
  roomId: string
  projectName: string
  activePreviewPath?: string
  onClose: () => void
  onInsertPath: (relPath: string) => void
  onPreviewFile: (filePath: string) => void
  onFileContextMenu?: (e: React.MouseEvent, absPath: string, allowPreview?: boolean) => void
}) {
  const [childrenMap, setChildrenMap] = useState<Record<string, FileEntry[]>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(false)
  const [git, setGit] = useState<GitStatusResult>({ isRepo: false, branch: '', files: {}, dirs: {}, changes: [] })
  const [tab, setTab] = useState<'all' | 'changes'>('all')
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem('ominihive:files-width'))
    return Number.isFinite(saved) && saved >= 196 ? Math.min(460, Math.round(saved)) : 250
  })
  const [resizing, setResizing] = useState(false)
  const widthRef = useRef(width)
  widthRef.current = width

  function startResize(e: React.MouseEvent) {
    e.preventDefault()
    const startX = e.clientX
    const startW = widthRef.current
    setResizing(true)
    const prevCursor = document.body.style.cursor
    const prevSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(196, Math.min(460, Math.round(startW + (startX - ev.clientX))))
      widthRef.current = next
      setWidth(next)
    }
    const onUp = () => {
      setResizing(false)
      document.body.style.cursor = prevCursor
      document.body.style.userSelect = prevSelect
      try { localStorage.setItem('ominihive:files-width', String(widthRef.current)) } catch {}
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  function resetWidth() {
    setWidth(250)
    try { localStorage.setItem('ominihive:files-width', '250') } catch {}
  }

  const roomRef = useRef(roomId)
  roomRef.current = roomId

  async function loadDir(relDir = '') {
    if (!roomId) return
    const forRoom = roomId
    if (!relDir) setLoading(true)
    try {
      const [list, gitRes] = await Promise.all([
        window.hive.files(forRoom, relDir),
        !relDir ? window.hive.gitStatus(forRoom).catch(() => ({ isRepo: false, branch: '', files: {}, dirs: {}, changes: [] })) : Promise.resolve(null)
      ])
      // Switched to another room/project meanwhile: drop the stale listing.
      if (roomRef.current !== forRoom) return
      setChildrenMap(prev => ({ ...prev, [relDir]: list }))
      if (gitRes) setGit(gitRes)
    } catch {
      // Unreadable directory: keep the tree as is instead of an unhandled rejection.
    } finally {
      if (!relDir && roomRef.current === forRoom) setLoading(false)
    }
  }

  useEffect(() => {
    setChildrenMap({})
    setExpanded({})
    setTab('all')
    void loadDir('')
  }, [roomId])

  async function toggleDir(entry: FileEntry) {
    const next = !expanded[entry.relPath]
    setExpanded(prev => ({ ...prev, [entry.relPath]: next }))
    if (next && !childrenMap[entry.relPath]) {
      await loadDir(entry.relPath)
    }
  }

  function renderNodes(relDir: string, depth: number) {
    const items = childrenMap[relDir] || []
    return items.map(entry => {
      const isOpen = Boolean(expanded[entry.relPath])
      const relKey = entry.relPath.replace(/\\/g, '/')
      const gitCode = entry.isDir ? undefined : git.files[relKey]
      const dirHasChange = entry.isDir && Boolean(git.dirs[relKey])
      const isSelected = Boolean(activePreviewPath && activePreviewPath === entry.path)

      return (
        <div key={entry.relPath}>
          <div
            className={'file-row' + (isSelected ? ' selected' : '') + (gitCode ? ' git-' + gitCode.toLowerCase() : '')}
            style={{ paddingLeft: 10 + depth * 14 }}
            onClick={() => (entry.isDir ? void toggleDir(entry) : onPreviewFile(entry.path))}
            onContextMenu={e => { if (!entry.isDir) onFileContextMenu?.(e, entry.path, true) }}
            title={entry.path}
          >
            {entry.isDir ? (
              <>
                <ChevronRight size={12} className={'file-caret ' + (isOpen ? 'open' : '')} />
                <FileTypeIcon name={entry.name} isDir isOpen={isOpen} size={15} />
              </>
            ) : (
              <>
                <span className="file-caret-pad" />
                <FileTypeIcon name={entry.name} ext={entry.ext} size={15} />
              </>
            )}
            <span className="file-name">{entry.name}</span>
            {dirHasChange && <span className="git-dir-dot" title="目录内有 Git 变更" />}
            {gitCode && <GitStatusBadge code={gitCode} />}
            {!entry.isDir && (
              <button
                type="button"
                className="file-ref-btn"
                title="引用路径到输入框"
                onClick={e => {
                  e.stopPropagation()
                  onInsertPath(entry.relPath)
                }}
              >
                <MessageSquarePlus size={12} />
              </button>
            )}
          </div>
          {entry.isDir && isOpen && (
            <div className="file-children">
              {renderNodes(entry.relPath, depth + 1)}
            </div>
          )}
        </div>
      )
    })
  }

  return (
    <aside
      className={'file-drawer' + (resizing ? ' resizing' : '')}
      style={{ width, flexBasis: width }}
      aria-label="项目文件目录"
    >
      <div
        className="drawer-resizer"
        onMouseDown={startResize}
        onDoubleClick={resetWidth}
        title="左右拖动调整文件栏宽度（双击重置）"
        role="separator"
        aria-orientation="vertical"
      />
      <div className="file-drawer-head">
        <span className="file-drawer-title" title={projectName}>{projectName} · 文件</span>
        {git.isRepo && git.branch && (
          <span className="file-git-branch" title={'Git 分支：' + git.branch}>
            <GitBranch size={11} />
            <span>{git.branch}</span>
          </span>
        )}
        <button type="button" className="icon-btn" title="刷新目录与 Git 状态" onClick={() => void loadDir('')}>
          <RefreshCw size={13} className={loading ? 'spin' : ''} />
        </button>
        <button type="button" className="icon-btn" title="关闭文件栏" onClick={onClose}>
          <X size={14} />
        </button>
      </div>

      {git.isRepo && (
        <div className="file-drawer-tabs">
          <button type="button" className={tab === 'all' ? 'active' : ''} onClick={() => setTab('all')}>
            全部文件
          </button>
          <button type="button" className={tab === 'changes' ? 'active' : ''} onClick={() => setTab('changes')}>
            已更改{git.changes.length > 0 ? ` (${git.changes.length})` : ''}
          </button>
        </div>
      )}

      <ScrollArea className="file-tree" insetTop={4} insetBottom={4}>
        {tab === 'changes' ? (
          git.changes.length > 0 ? (
            git.changes.map(entry => {
              const isSelected = Boolean(activePreviewPath && activePreviewPath === entry.path)
              const dirLabel = entry.relPath.includes('/') ? entry.relPath.slice(0, entry.relPath.lastIndexOf('/')) : ''
              return (
                <div
                  key={entry.relPath}
                  className={'file-row' + (isSelected ? ' selected' : '') + (entry.gitStatus ? ' git-' + entry.gitStatus.toLowerCase() : '')}
                  style={{ paddingLeft: 10 }}
                  onClick={() => { if (entry.gitStatus !== 'D') onPreviewFile(entry.path) }}
                  onContextMenu={e => onFileContextMenu?.(e, entry.path, entry.gitStatus !== 'D')}
                  title={entry.path}
                >
                  <FileTypeIcon name={entry.name} ext={entry.ext} size={15} />
                  <span className="file-name">
                    {entry.name}
                    {dirLabel && <small className="file-rel-dir">{dirLabel}</small>}
                  </span>
                  <GitStatusBadge code={entry.gitStatus} />
                  <button
                    type="button"
                    className="file-ref-btn"
                    title="引用路径到输入框"
                    onClick={e => {
                      e.stopPropagation()
                      onInsertPath(entry.relPath)
                    }}
                  >
                    <MessageSquarePlus size={12} />
                  </button>
                </div>
              )
            })
          ) : (
            <div className="file-empty">工作区无未提交变更</div>
          )
        ) : (
          <>
            {renderNodes('', 0)}
            {!loading && !(childrenMap['']?.length) && (
              <div className="file-empty">目录为空</div>
            )}
          </>
        )}
      </ScrollArea>
    </aside>
  )
}
