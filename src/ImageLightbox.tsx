import React, { useEffect, useRef, useState } from 'react'
import { Check, ChevronLeft, ChevronRight, Copy, ExternalLink, FolderSearch, Image as ImageIcon, Link2, PanelRight, X, ZoomIn, ZoomOut } from 'lucide-react'
import { friendlyDir, friendlyFileName, imageMetaLine } from './filePresentation'
import { writeClipboardText } from './clipboard'

export type LightboxImageItem = {
  path: string
  name?: string
  dataUrl?: string
}

type CachedImage = {
  dataUrl: string
  path: string
  name: string
  size?: number
}

function dataUrlBytes(dataUrl: string): number | undefined {
  const i = dataUrl.indexOf(',')
  if (i < 0 || !/;base64$/i.test(dataUrl.slice(0, i))) return undefined
  const b64 = dataUrl.slice(i + 1)
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad)
}

const IMAGE_CACHE = new Map<string, CachedImage | null>()
const INFLIGHT = new Map<string, Promise<CachedImage | null>>()

export async function loadLocalImage(roomId: string | undefined, targetPath: string): Promise<CachedImage | null> {
  const key = `${roomId || ''}::${targetPath}`
  if (IMAGE_CACHE.has(key)) return IMAGE_CACHE.get(key) ?? null
  const existing = INFLIGHT.get(key)
  if (existing) return existing
  const p = (async () => {
    try {
      const res = await window.hive.previewFile(roomId || '', targetPath)
      if (res && res.kind === 'image' && res.dataUrl) {
        const entry: CachedImage = { dataUrl: res.dataUrl, path: res.path, name: res.name, size: res.size }
        if (IMAGE_CACHE.size > 200) {
          const firstKey = IMAGE_CACHE.keys().next().value
          if (firstKey !== undefined) IMAGE_CACHE.delete(firstKey)
        }
        IMAGE_CACHE.set(key, entry)
        return entry
      }
      IMAGE_CACHE.set(key, null)
      return null
    } catch {
      IMAGE_CACHE.set(key, null)
      return null
    } finally {
      INFLIGHT.delete(key)
    }
  })()
  INFLIGHT.set(key, p)
  return p
}

/** Re-encodes any browser-decodable image (svg, webp, gif, jpeg…) as PNG for the system clipboard. */
function toPngDataUrl(dataUrl: string): Promise<string> {
  if (dataUrl.startsWith('data:image/png;base64,')) return Promise.resolve(dataUrl)
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const w = img.naturalWidth || 1024
      const h = img.naturalHeight || 768
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) return reject(Error('无法复制该图片'))
      ctx.drawImage(img, 0, 0, w, h)
      resolve(canvas.toDataURL('image/png'))
    }
    img.onerror = () => reject(Error('无法复制该图片'))
    img.src = dataUrl
  })
}

/** Copies the image itself (not its path) to the system clipboard. */
export async function copyImageToClipboard(source: { path?: string; dataUrl?: string }, roomId?: string): Promise<void> {
  let dataUrl = source.dataUrl || ''
  if (!dataUrl && source.path) dataUrl = (await loadLocalImage(roomId, source.path))?.dataUrl || ''
  if (!dataUrl) throw Error('图片无法读取，可能已被移动或删除')
  await window.hive.copyImage(await toPngDataUrl(dataUrl))
}

export function LocalImageThumb({
  path,
  roomId,
  alt,
  className = 'step-img-thumb',
  onOpen,
  onContextMenu
}: {
  path: string
  roomId?: string
  alt?: string
  className?: string
  onOpen?: (resolvedPath: string, dataUrl?: string) => void
  onContextMenu?: (e: React.MouseEvent, absPath: string) => void
}) {
  const [loaded, setLoaded] = useState<CachedImage | null>(() => IMAGE_CACHE.get(`${roomId || ''}::${path}`) ?? null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    const key = `${roomId || ''}::${path}`
    if (IMAGE_CACHE.has(key)) {
      const hit = IMAGE_CACHE.get(key) ?? null
      setLoaded(hit)
      setFailed(!hit)
      return
    }
    setFailed(false)
    void loadLocalImage(roomId, path).then(res => {
      if (!alive) return
      setLoaded(res)
      setFailed(!res)
    })
    return () => { alive = false }
  }, [roomId, path])

  const absPath = loaded?.path || path
  const label = alt || loaded?.name || path.split(/[/\\]/).pop() || '图像'

  if (failed) {
    return (
      <button
        type="button"
        className="step-img-fallback"
        title={absPath}
        onClick={() => onOpen?.(absPath)}
        onContextMenu={e => onContextMenu?.(e, absPath)}
      >
        <ImageIcon size={13} />
        <span>{label}</span>
      </button>
    )
  }

  return (
    <button
      type="button"
      className={className + (!loaded ? ' loading' : '')}
      title={absPath}
      onClick={() => onOpen?.(absPath, loaded?.dataUrl)}
      onContextMenu={e => onContextMenu?.(e, absPath)}
    >
      {loaded ? (
        <img src={loaded.dataUrl} alt={label} draggable={false} />
      ) : (
        <span className="step-img-skeleton" />
      )}
    </button>
  )
}

export function ImageLightbox({
  items,
  index,
  roomId,
  projectDir,
  onIndexChange,
  onClose,
  onOpenInSidePanel,
  onFileContextMenu,
  onToast
}: {
  items: LightboxImageItem[]
  index: number
  roomId?: string
  projectDir?: string
  onIndexChange: (nextIndex: number) => void
  onClose: () => void
  onOpenInSidePanel?: (path: string) => void
  onFileContextMenu?: (e: React.MouseEvent, absPath: string, allowPreview?: boolean, extra?: { dataUrl?: string }) => void
  onToast?: (message: string, kind?: 'ok' | 'error') => void
}) {
  const safeIndex = Math.max(0, Math.min(index, items.length - 1))
  const current = items[safeIndex]
  const [resolved, setResolved] = useState<CachedImage | null>(null)
  const [loading, setLoading] = useState(false)
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [panning, setPanning] = useState(false)
  const [copied, setCopied] = useState(false)
  const [imageCopied, setImageCopied] = useState(false)
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const scaleRef = useRef(1)
  const copyImageRef = useRef<() => Promise<void>>(async () => {})

  // Modal focus: move focus into the viewer, keep Tab inside it, restore it on close
  // (otherwise Enter/Space re-triggers the thumbnail button behind the overlay).
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialogRef.current?.focus()
    const onTab = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !dialogRef.current) return
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled])'))
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      if (e.shiftKey && (active === first || active === dialogRef.current)) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onTab)
    return () => {
      document.removeEventListener('keydown', onTab)
      previous?.focus?.()
    }
  }, [])
  scaleRef.current = scale

  function clampScale(s: number) {
    return Math.max(0.5, Math.min(6, Math.round(s * 1000) / 1000))
  }

  function applyScale(next: number) {
    const clamped = clampScale(next)
    setScale(clamped)
    if (clamped <= 1.01) setOffset({ x: 0, y: 0 })
  }

  function resetZoom() {
    setScale(1)
    setOffset({ x: 0, y: 0 })
  }

  useEffect(() => {
    resetZoom()
    setDims(null)
    if (!current) return
    if (current.dataUrl) {
      setResolved({
        dataUrl: current.dataUrl,
        path: current.path,
        name: current.name || current.path.split(/[/\\]/).pop() || '图像'
      })
      setLoading(false)
      return
    }
    let alive = true
    setLoading(true)
    void loadLocalImage(roomId, current.path).then(res => {
      if (!alive) return
      setResolved(res)
      setLoading(false)
    })
    return () => { alive = false }
  }, [current?.path, current?.dataUrl, roomId])

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      // macOS trackpad pinch-to-zoom fires wheel events with ctrlKey=true
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        const factor = Math.exp(-e.deltaY * 0.012)
        const next = clampScale(scaleRef.current * factor)
        setScale(next)
        if (next <= 1.01) setOffset({ x: 0, y: 0 })
        return
      }
      if (scaleRef.current > 1.01) {
        e.preventDefault()
        setOffset(prev => ({ x: prev.x - e.deltaX, y: prev.y - e.deltaY }))
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
      if (e.key === 'ArrowLeft' && items.length > 1) {
        e.preventDefault()
        onIndexChange((safeIndex - 1 + items.length) % items.length)
      }
      if (e.key === 'ArrowRight' && items.length > 1) {
        e.preventDefault()
        onIndexChange((safeIndex + 1) % items.length)
      }
      if (e.key === '=' || e.key === '+') { e.preventDefault(); applyScale(scaleRef.current * 1.25) }
      if (e.key === '-') { e.preventDefault(); applyScale(scaleRef.current / 1.25) }
      if (e.key === '0') { e.preventDefault(); resetZoom() }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c' && !window.getSelection()?.toString()) {
        e.preventDefault()
        void copyImageRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [items.length, safeIndex, onIndexChange, onClose])

  function startPan(e: React.MouseEvent) {
    if (e.button !== 0 || scaleRef.current <= 1.01) return
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startY = e.clientY
    const startOffset = { ...offset }
    setPanning(true)
    const onMove = (ev: MouseEvent) => {
      setOffset({
        x: startOffset.x + (ev.clientX - startX),
        y: startOffset.y + (ev.clientY - startY)
      })
    }
    const onUp = () => {
      setPanning(false)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  if (!current) return null
  const absPath = resolved?.path || current.path
  const rawName = current.name || resolved?.name || absPath.split(/[/\\]/).pop() || ''
  const displayName = friendlyFileName(rawName, absPath) || '图像'
  const extSource = /\.[a-z0-9]{1,8}$/i.test(rawName) ? rawName : (absPath.split(/[/\\]/).pop() || '')
  const sizeBytes = resolved?.size ?? (resolved?.dataUrl ? dataUrlBytes(resolved.dataUrl) : undefined)
  const metaLine = imageMetaLine({ width: dims?.w, height: dims?.h, name: extSource, size: sizeBytes })
  const dirLabel = absPath ? friendlyDir(absPath, projectDir) : ''
  const pct = Math.round(scale * 100)

  function copyPath() {
    if (!absPath) return
    void writeClipboardText(absPath)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  async function copyImage() {
    if (!resolved?.dataUrl) return
    try {
      await copyImageToClipboard({ dataUrl: resolved.dataUrl })
      setImageCopied(true)
      setTimeout(() => setImageCopied(false), 1500)
      onToast?.('已复制图片', 'ok')
    } catch (err) {
      onToast?.(err instanceof Error ? err.message : '无法复制该图片', 'error')
    }
  }
  copyImageRef.current = copyImage

  return (
    <div
      ref={dialogRef}
      className="lightbox-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={'图片预览：' + displayName}
      tabIndex={-1}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="lightbox-bar" onMouseDown={e => e.stopPropagation()}>
        <div className="lightbox-meta" title={absPath}>
          <strong>{displayName}</strong>
          {(dirLabel || metaLine) && (
            <span className="lightbox-sub">
              {dirLabel && <span className="lightbox-dir">{dirLabel}</span>}
              {dirLabel && metaLine && <span className="lightbox-sep">·</span>}
              {metaLine && <span className="lightbox-dims">{metaLine}</span>}
            </span>
          )}
          {items.length > 1 && <span className="lightbox-counter">{safeIndex + 1} / {items.length}</span>}
        </div>
        <div className="lightbox-actions">
          <div className="lightbox-zoom" role="group" aria-label="缩放">
            <button type="button" className="lightbox-btn" onClick={() => applyScale(scale / 1.25)} title="缩小（-）" aria-label="缩小">
              <ZoomOut size={15} />
            </button>
            <button type="button" className="lightbox-btn pct" onClick={resetZoom} title="重置为适应窗口（0）">
              {pct}%
            </button>
            <button type="button" className="lightbox-btn" onClick={() => applyScale(scale * 1.25)} title="放大（+）" aria-label="放大">
              <ZoomIn size={15} />
            </button>
          </div>
          <span className="lightbox-divider" />
          {resolved?.dataUrl && (
            <button type="button" className={'lightbox-btn' + (imageCopied ? ' done' : '')} onClick={() => void copyImage()} title={imageCopied ? '已复制图片' : '复制图片（⌘C）'} aria-label="复制图片">
              {imageCopied ? <Check size={15} /> : <Copy size={15} />}
            </button>
          )}
          {absPath && (
            <button type="button" className={'lightbox-btn' + (copied ? ' done' : '')} onClick={copyPath} title={copied ? '已复制绝对路径' : '复制绝对路径'} aria-label="复制绝对路径">
              {copied ? <Check size={15} /> : <Link2 size={15} />}
            </button>
          )}
          {absPath && onOpenInSidePanel && (
            <button
              type="button"
              className="lightbox-btn"
              onClick={() => { onOpenInSidePanel(absPath); onClose() }}
              title="在右侧预览栏打开"
              aria-label="在右侧预览栏打开"
            >
              <PanelRight size={15} />
            </button>
          )}
          {absPath && (
            <button
              type="button"
              className="lightbox-btn"
              onClick={() => void window.hive.revealPath(absPath, roomId)}
              title="在访达中显示"
              aria-label="在访达中显示"
            >
              <FolderSearch size={15} />
            </button>
          )}
          {absPath && (
            <button
              type="button"
              className="lightbox-btn"
              onClick={() => void window.hive.openPath(absPath, roomId)}
              title="用系统默认应用打开"
              aria-label="用系统默认应用打开"
            >
              <ExternalLink size={15} />
            </button>
          )}
          <span className="lightbox-divider" />
          <button type="button" className="lightbox-btn" onClick={onClose} title="关闭（Esc）" aria-label="关闭预览">
            <X size={16} />
          </button>
        </div>
      </div>

      <div
        ref={stageRef}
        className={'lightbox-stage' + (panning ? ' panning' : '')}
        onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}
      >
        {items.length > 1 && (
          <button
            type="button"
            className="lightbox-nav prev"
            aria-label="上一张"
            onClick={e => { e.stopPropagation(); onIndexChange((safeIndex - 1 + items.length) % items.length) }}
          >
            <ChevronLeft size={22} />
          </button>
        )}

        {loading && !resolved ? (
          <div className="lightbox-loading">正在加载高清图像…</div>
        ) : resolved?.dataUrl ? (
          <img
            src={resolved.dataUrl}
            alt={displayName}
            title="双指捏合或 ⌘ + 滚轮缩放，双击切换放大"
            draggable={false}
            onLoad={e => {
              const el = e.currentTarget
              if (el.naturalWidth && el.naturalHeight) setDims({ w: el.naturalWidth, h: el.naturalHeight })
            }}
            style={{
              transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${scale})`,
              cursor: scale > 1.01 ? (panning ? 'grabbing' : 'grab') : 'zoom-in'
            }}
            onMouseDown={startPan}
            onDoubleClick={e => {
              e.stopPropagation()
              if (scale > 1.05) resetZoom()
              else applyScale(2)
            }}
            onContextMenu={e => onFileContextMenu?.(e, absPath, Boolean(absPath), { dataUrl: resolved.dataUrl })}
          />
        ) : (
          <div className="lightbox-loading">无法加载该图片（文件可能已移动或删除）</div>
        )}

        {items.length > 1 && (
          <button
            type="button"
            className="lightbox-nav next"
            aria-label="下一张"
            onClick={e => { e.stopPropagation(); onIndexChange((safeIndex + 1) % items.length) }}
          >
            <ChevronRight size={22} />
          </button>
        )}
      </div>
    </div>
  )
}
