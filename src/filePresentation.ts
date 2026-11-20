// Pure helpers that turn absolute file paths into short, human-friendly labels
// for the preview panel and image lightbox. Absolute paths stay available via
// tooltips / copy actions; these only shape what is shown by default.

const UUID_NAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[a-z0-9]+)?$/i
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|heic|tiff?|avif)$/i
const ATTACHMENT_DIR_RE = /\/OminiHive\/attachments(\/|$)/

export function formatBytes(bytes: number | undefined | null): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

function splitPath(p: string): string[] {
  return String(p || '').replace(/\\/g, '/').split('/').filter(Boolean)
}

export function baseName(p: string): string {
  const parts = splitPath(p)
  return parts[parts.length - 1] || ''
}

export function isAttachmentPath(p: string): boolean {
  return ATTACHMENT_DIR_RE.test(String(p || '').replace(/\\/g, '/'))
}

/** Display name: hides the UUID names OminiHive gives saved attachments. */
export function friendlyFileName(name: string | undefined, absPath: string): string {
  const raw = (name || '').trim() || baseName(absPath)
  if (!UUID_NAME_RE.test(raw)) return raw || '未命名文件'
  return IMAGE_EXT_RE.test(raw) ? '图片附件' : '附件'
}

/** File extension label, e.g. "PNG". */
export function fileExtLabel(name: string): string {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name || '')
  return m ? m[1].toUpperCase() : ''
}

/**
 * Short directory label for a file:
 * - inside the project → path relative to the project root ("项目根目录" at root)
 * - OminiHive attachments → "对话附件"
 * - otherwise → home folded to "~", long middles collapsed to "…"
 */
export function friendlyDir(absPath: string, projectDir?: string, maxSegments = 4): string {
  const norm = String(absPath || '').replace(/\\/g, '/')
  if (!norm) return ''
  if (isAttachmentPath(norm)) return '对话附件'
  const dirParts = splitPath(norm).slice(0, -1)
  const proj = String(projectDir || '').replace(/\\/g, '/').replace(/\/+$/, '')
  if (proj && (norm === proj || norm.startsWith(proj + '/'))) {
    const rel = splitPath(norm.slice(proj.length)).slice(0, -1)
    if (!rel.length) return '项目根目录'
    return collapse(rel, maxSegments)
  }
  let parts = dirParts
  let prefix = '/'
  if (parts[0] === 'Users' && parts.length >= 2) {
    parts = parts.slice(2)
    prefix = '~/'
  }
  if (!parts.length) return prefix === '~/' ? '~' : '/'
  return prefix + collapse(parts, maxSegments)
}

function collapse(parts: string[], maxSegments: number): string {
  if (parts.length <= maxSegments) return parts.join('/')
  const keepTail = Math.max(1, maxSegments - 2)
  return [parts[0], '…', ...parts.slice(-keepTail)].join('/')
}

/** "2048×1152 · PNG · 1.2 MB" — skips unknown parts. */
export function imageMetaLine(opts: { width?: number; height?: number; name?: string; size?: number }): string {
  const bits: string[] = []
  if (opts.width && opts.height) bits.push(`${opts.width}×${opts.height}`)
  const ext = fileExtLabel(opts.name || '')
  if (ext) bits.push(ext)
  const size = formatBytes(opts.size)
  if (size) bits.push(size)
  return bits.join(' · ')
}

/**
 * Shorten absolute paths embedded in a one-line label (e.g. a step title like
 * "Read · /Users/x/proj/src/App.tsx"): project prefix is dropped, home folds to "~".
 */
export function shortenPathsInText(text: string, projectDir?: string): string {
  let out = String(text || '')
  const proj = String(projectDir || '').replace(/\/+$/, '')
  if (proj && proj.length > 1) out = out.split(proj + '/').join('')
  return out.replace(/(^|[\s"'(=:])\/Users\/[^/\s"']+\//g, '$1~/')
}
