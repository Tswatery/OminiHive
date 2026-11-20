import React, { useEffect, useRef, useState } from 'react'
import { Check, Copy, ExternalLink, FolderSearch, Maximize2, X } from 'lucide-react'
import { MarkdownView } from './MarkdownView'
import { ScrollArea } from './OverlayScrollbar'
import { FileTypeIcon } from './FileTypeIcon'
import type { PreviewResult } from './FileDrawer'
import type { LightboxImageItem } from './ImageLightbox'
import { fileExtLabel, formatBytes, friendlyDir, friendlyFileName, imageMetaLine } from './filePresentation'

const DEFAULT_PREVIEW_WIDTH = 460
const PREVIEW_WIDTH_KEY = 'ominihive:preview-width'

function clampPreviewWidth(w: number) {
  const max = Math.max(320, Math.min(980, window.innerWidth - 420))
  return Math.max(260, Math.min(max, Math.round(w)))
}

export function FilePreviewPanel({
  preview,
  loading,
  error,
  roomId,
  projectDir,
  onClose,
  onPreviewFile,
  onOpenLightbox,
  onFileContextMenu
}: {
  preview: PreviewResult | null
  loading: boolean
  error: string
  roomId?: string
  projectDir?: string
  onClose: () => void
  onPreviewFile?: (targetPath: string) => void
  onOpenLightbox?: (items: LightboxImageItem[], index: number) => void
  onFileContextMenu?: (e: React.MouseEvent, absPath: string, allowPreview?: boolean) => void
}) {
  const [copied, setCopied] = useState(false)
  const [imgDims, setImgDims] = useState<{ w: number; h: number } | null>(null)
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(PREVIEW_WIDTH_KEY))
    return Number.isFinite(saved) && saved >= 260 ? clampPreviewWidth(saved) : DEFAULT_PREVIEW_WIDTH
  })
  const [resizing, setResizing] = useState(false)
  const widthRef = useRef(width)
  widthRef.current = width

  useEffect(() => {
    setImgDims(null)
  }, [preview?.path, preview?.kind === 'image' ? preview.dataUrl : ''])

  useEffect(() => {
    const onWinResize = () => setWidth(w => clampPreviewWidth(w))
    window.addEventListener('resize', onWinResize)
    return () => window.removeEventListener('resize', onWinResize)
  }, [])

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
      const next = clampPreviewWidth(startW + (startX - ev.clientX))
      widthRef.current = next
      setWidth(next)
    }
    const onUp = () => {
      setResizing(false)
      document.body.style.cursor = prevCursor
      document.body.style.userSelect = prevSelect
      try { localStorage.setItem(PREVIEW_WIDTH_KEY, String(widthRef.current)) } catch {}
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  function resetWidth() {
    const next = clampPreviewWidth(DEFAULT_PREVIEW_WIDTH)
    setWidth(next)
    try { localStorage.setItem(PREVIEW_WIDTH_KEY, String(next)) } catch {}
  }

  function copyPath(p: string) {
    if (!p) return
    void navigator.clipboard.writeText(p)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const displayName = preview ? friendlyFileName(preview.name, preview.path) : ''
  const dirLabel = preview?.path ? friendlyDir(preview.path, projectDir) : ''
  const metaLine = preview
    ? (preview.kind === 'image'
        ? imageMetaLine({ width: imgDims?.w, height: imgDims?.h, name: preview.name, size: preview.size })
        : [fileExtLabel(preview.name), formatBytes(preview.size)].filter(Boolean).join(' · '))
    : ''

  return (
    <aside
      className={'preview-drawer' + (resizing ? ' resizing' : '')}
      style={{ width, flexBasis: width }}
      aria-label="文件预览"
    >
      <div
        className="drawer-resizer"
        onMouseDown={startResize}
        onDoubleClick={resetWidth}
        title="左右拖动调整预览宽度（双击重置）"
        role="separator"
        aria-orientation="vertical"
      />
      <div className="preview-drawer-head">
        <div className="preview-drawer-title" title={preview?.path || ''}>
          {preview && <FileTypeIcon name={preview.name} size={16} />}
          <div className="preview-drawer-titletext">
            <strong>{displayName || (loading ? '加载预览中…' : '文件预览')}</strong>
            {preview && (dirLabel || metaLine) && (
              <span
                className="preview-drawer-sub"
                onContextMenu={e => onFileContextMenu?.(e, preview.path, false)}
              >
                {dirLabel && <span className="preview-drawer-dir">{dirLabel}</span>}
                {dirLabel && metaLine && <span className="preview-drawer-sep">·</span>}
                {metaLine && <span className="preview-drawer-meta">{metaLine}</span>}
              </span>
            )}
          </div>
        </div>
        <div className="preview-drawer-actions">
          {preview?.path && (
            <>
              <button
                type="button"
                className={'icon-btn' + (copied ? ' done' : '')}
                onClick={() => copyPath(preview.path)}
                title={copied ? '已复制绝对路径' : '复制绝对路径'}
                aria-label="复制绝对路径"
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </button>
              <button
                type="button"
                className="icon-btn"
                onClick={() => void window.hive.revealPath(preview.path, roomId)}
                title="在访达中显示"
                aria-label="在访达中显示"
              >
                <FolderSearch size={14} />
              </button>
              <button
                type="button"
                className="icon-btn"
                onClick={() => void window.hive.openPath(preview.path, roomId)}
                title="用系统默认应用打开"
                aria-label="用系统默认应用打开"
              >
                <ExternalLink size={14} />
              </button>
              <span className="preview-drawer-divider" />
            </>
          )}
          <button type="button" className="icon-btn" title="关闭预览" aria-label="关闭预览" onClick={onClose}>
            <X size={15} />
          </button>
        </div>
      </div>

      {error && <div className="file-err">{error}</div>}

      {loading ? (
        <div className="preview-drawer-loading">
          <span className="pulse-dot" />
          <span>正在准备预览…</span>
        </div>
      ) : preview?.kind === 'pdf' ? (
        <div className="preview-drawer-pdf-wrap">
          <iframe className="preview-drawer-pdf" src={preview.dataUrl} title={preview.name} />
        </div>
      ) : (
        <ScrollArea className="preview-drawer-body" insetTop={6} insetBottom={6}>
          {preview?.kind === 'image' && (
            <div className="preview-drawer-img-wrap">
              <button
                type="button"
                className="preview-drawer-img"
                title="点击放大查看"
                onClick={() => onOpenLightbox?.([{ path: preview.path, name: preview.name, dataUrl: preview.dataUrl }], 0)}
                onContextMenu={e => onFileContextMenu?.(e, preview.path, false)}
              >
                <img
                  src={preview.dataUrl}
                  alt={displayName}
                  draggable={false}
                  onLoad={e => {
                    const el = e.currentTarget
                    if (el.naturalWidth && el.naturalHeight) setImgDims({ w: el.naturalWidth, h: el.naturalHeight })
                  }}
                />
                <span className="preview-drawer-zoom-hint" aria-hidden="true">
                  <Maximize2 size={13} />
                  <span>点击放大</span>
                </span>
              </button>
            </div>
          )}
          {preview?.kind === 'markdown' && (
            <div className="preview-drawer-md">
              <MarkdownView
                content={preview.content}
                roomId={roomId}
                projectDir={projectDir}
                onPreviewFile={onPreviewFile}
                onOpenLightbox={onOpenLightbox}
                onFileContextMenu={onFileContextMenu}
              />
            </div>
          )}
          {preview?.kind === 'text' && (
            <pre className="preview-code"><code>{preview.content}</code></pre>
          )}
          {preview?.kind === 'binary' && (
            <div className="preview-binary">
              <p>{preview.note || '此文件格式暂不支持内置预览，可点击右上角用系统应用打开。'}</p>
            </div>
          )}
        </ScrollArea>
      )}
    </aside>
  )
}
