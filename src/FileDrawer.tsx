import { useState, useEffect } from 'react'
import { Dialog, IconButton } from '@radix-ui/themes'
import {
  ChevronRight, ExternalLink, File, FileCode2, FileImage, FileText,
  Folder, FolderOpen, MessageSquarePlus, RefreshCw, X
} from 'lucide-react'
import { MarkdownView } from './MarkdownView'
import { ScrollArea } from './OverlayScrollbar'
import { cleanError } from './errors'

export type FileEntry = {
  name: string
  path: string
  relPath: string
  isDir: boolean
  size: number
  ext: string
}

export type PreviewResult =
  | { kind: 'image'; name: string; path: string; size: number; dataUrl: string }
  | { kind: 'pdf'; name: string; path: string; size: number; dataUrl: string }
  | { kind: 'markdown' | 'text'; name: string; path: string; ext: string; size: number; truncated?: boolean; content: string }
  | { kind: 'binary'; name: string; path: string; size: number; note?: string }

function FileIcon({ entry }: { entry: FileEntry }) {
  if (entry.isDir) return <Folder size={14} className="ficon dir" />
  if (entry.ext === '.pdf') return <FileText size={14} className="ficon pdf" />
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.bmp'].includes(entry.ext)) {
    return <FileImage size={14} className="ficon img" />
  }
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '.go', '.rs', '.json', '.md', '.css'].includes(entry.ext)) {
    return <FileCode2 size={14} className="ficon code" />
  }
  return <File size={14} className="ficon" />
}

function formatSize(bytes: number) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

export function FileDrawer({
  roomId,
  projectName,
  onClose,
  onInsertPath
}: {
  roomId: string
  projectName: string
  onClose: () => void
  onInsertPath: (relPath: string) => void
}) {
  const [childrenMap, setChildrenMap] = useState<Record<string, FileEntry[]>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(false)
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [previewErr, setPreviewErr] = useState('')

  async function loadDir(relDir = '') {
    if (!roomId) return
    if (!relDir) setLoading(true)
    try {
      const list = await window.hive.files(roomId, relDir)
      setChildrenMap(prev => ({ ...prev, [relDir]: list }))
    } finally {
      if (!relDir) setLoading(false)
    }
  }

  useEffect(() => {
    setChildrenMap({})
    setExpanded({})
    void loadDir('')
  }, [roomId])

  async function toggleDir(entry: FileEntry) {
    const next = !expanded[entry.relPath]
    setExpanded(prev => ({ ...prev, [entry.relPath]: next }))
    if (next && !childrenMap[entry.relPath]) {
      await loadDir(entry.relPath)
    }
  }

  async function openPreview(entry: FileEntry) {
    setPreviewErr('')
    try {
      const res = await window.hive.previewFile(roomId, entry.path)
      setPreview(res)
    } catch (e) {
      setPreviewErr(cleanError(e))
    }
  }

  function renderNodes(relDir: string, depth: number) {
    const items = childrenMap[relDir] || []
    return items.map(entry => {
      const isOpen = Boolean(expanded[entry.relPath])
      return (
        <div key={entry.relPath}>
          <div
            className="file-row"
            style={{ paddingLeft: 10 + depth * 14 }}
            onClick={() => (entry.isDir ? void toggleDir(entry) : void openPreview(entry))}
            title={entry.relPath}
          >
            {entry.isDir ? (
              <>
                <ChevronRight size={12} className={'file-caret ' + (isOpen ? 'open' : '')} />
                {isOpen ? <FolderOpen size={14} className="ficon dir" /> : <Folder size={14} className="ficon dir" />}
              </>
            ) : (
              <>
                <span className="file-caret-pad" />
                <FileIcon entry={entry} />
              </>
            )}
            <span className="file-name">{entry.name}</span>
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
    <aside className="file-drawer" aria-label="项目文件目录">
      <div className="file-drawer-head">
        <span className="file-drawer-title" title={projectName}>{projectName} · 文件</span>
        <button type="button" className="icon-btn" title="刷新目录" onClick={() => void loadDir('')}>
          <RefreshCw size={13} className={loading ? 'spin' : ''} />
        </button>
        <button type="button" className="icon-btn" title="关闭文件栏" onClick={onClose}>
          <X size={14} />
        </button>
      </div>

      {previewErr && <div className="file-err">{previewErr}</div>}

      <ScrollArea className="file-tree" insetTop={4} insetBottom={4}>
        {renderNodes('', 0)}
        {!loading && !(childrenMap['']?.length) && (
          <div className="file-empty">目录为空</div>
        )}
      </ScrollArea>

      <Dialog.Root open={Boolean(preview)} onOpenChange={open => { if (!open) setPreview(null) }}>
        <Dialog.Content className="preview-dialog" maxWidth="88vw">
          {preview && (
            <>
              <div className="preview-head">
                <div className="preview-title">
                  <strong>{preview.name}</strong>
                  <span>{formatSize(preview.size)}</span>
                </div>
                <div className="preview-actions">
                  <button
                    type="button"
                    className="preview-action-btn"
                    onClick={() => void window.hive.openPath(preview.path, roomId)}
                    title="用系统默认应用打开"
                  >
                    <ExternalLink size={13} /> 打开
                  </button>
                  <Dialog.Close>
                    <IconButton variant="ghost" color="gray" aria-label="关闭预览"><X size={16} /></IconButton>
                  </Dialog.Close>
                </div>
              </div>

              <ScrollArea className="preview-body" insetTop={6} insetBottom={6}>
                {preview.kind === 'image' && (
                  <div className="preview-img-wrap">
                    <img src={preview.dataUrl} alt={preview.name} />
                  </div>
                )}
                {preview.kind === 'pdf' && (
                  <iframe className="preview-pdf" src={preview.dataUrl} title={preview.name} />
                )}
                {preview.kind === 'markdown' && (
                  <div className="preview-md">
                    <MarkdownView content={preview.content} roomId={roomId} />
                  </div>
                )}
                {preview.kind === 'text' && (
                  <pre className="preview-code"><code>{preview.content}</code></pre>
                )}
                {preview.kind === 'binary' && (
                  <div className="preview-binary">
                    <p>{preview.note || '此文件格式暂不支持内置预览，可点击右上角用系统应用打开。'}</p>
                  </div>
                )}
              </ScrollArea>
            </>
          )}
        </Dialog.Content>
      </Dialog.Root>
    </aside>
  )
}
