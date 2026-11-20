import React, { useMemo, useRef, useState } from 'react'
import Markdown, { defaultUrlTransform, type Components } from 'react-markdown'
import gfm from 'remark-gfm'
import { Check, Copy, ExternalLink, FileText } from 'lucide-react'
import { LocalImageThumb, type LightboxImageItem } from './ImageLightbox'

const TOKEN_RE = /(\/\/.*$|#.*$|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:const|let|var|function|return|if|else|for|while|switch|case|break|continue|import|export|from|default|async|await|try|catch|finally|throw|new|class|extends|implements|interface|type|enum|def|elif|pass|with|as|in|not|and|or|is|None|True|False|true|false|null|undefined|pub|fn|struct|impl|use|mod|match|SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|JOIN|ON|ORDER|BY|LIMIT|PRAGMA)\b|\b\d+(?:\.\d+)?\b)/gm

function highlightCode(code: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let last = 0
  let key = 0
  for (const m of code.matchAll(TOKEN_RE)) {
    const idx = m.index ?? 0
    if (idx > last) out.push(code.slice(last, idx))
    const tok = m[0]
    let cls = 'syn-kw'
    if (tok.startsWith('//') || tok.startsWith('#') || tok.startsWith('/*')) cls = 'syn-com'
    else if (tok.startsWith('"') || tok.startsWith("'") || tok.startsWith('`')) cls = 'syn-str'
    else if (/^\d/.test(tok)) cls = 'syn-num'
    out.push(<span key={key++} className={cls}>{tok}</span>)
    last = idx + tok.length
  }
  if (last < code.length) out.push(code.slice(last))
  return out
}

const CodeBlock = React.memo(function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    void navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }
  return (
    <div className="code-block">
      <div className="code-head">
        <span>{lang || 'text'}</span>
        <button type="button" className="code-copy" onClick={copy} aria-label="复制代码">
          {copied ? <><Check size={12} /> 已复制</> : <><Copy size={12} /> 复制</>}
        </button>
      </div>
      <pre><code>{highlightCode(code)}</code></pre>
    </div>
  )
})

function looksLikePath(s: string) {
  if (!s || s.length > 260 || /\s/.test(s)) return false
  return (/^(?:\.{0,2}\/|~\/|[a-zA-Z0-9_-]+\/)/.test(s) || /\.(?:tsx?|jsx?|mjs|cjs|css|json|md|py|rs|go|sh|ya?ml|sqlite|html|png|jpe?g|webp|gif|svg|pdf|pptx?)$/i.test(s))
}

export function resolveClientAbsPath(raw: string, projectDir?: string): string {
  let p = String(raw || '').trim()
  if (!p) return ''
  if (/^file:\/\//i.test(p)) {
    p = p.replace(/^file:\/\//i, '')
    if (/^localhost\//i.test(p)) p = p.slice('localhost'.length)
  }
  try {
    if (/%[0-9A-Fa-f]{2}/.test(p)) p = decodeURIComponent(p)
  } catch {}
  if (p.startsWith('/') || p.startsWith('~/') || p === '~') return p
  if (!projectDir) return p
  const base = projectDir.replace(/\/+$/, '')
  const segments = (base + '/' + p).split('/')
  const out: string[] = []
  for (const seg of segments) {
    if (!seg || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return '/' + out.join('/')
}

function isLocalFileHref(href?: string): boolean {
  if (!href) return false
  if (/^(?:https?:|mailto:|tel:|#)/i.test(href)) return false
  if (/^file:\/\//i.test(href)) return true
  if (href.startsWith('/') || href.startsWith('~/') || href.startsWith('./') || href.startsWith('../')) return true
  return /\.[a-zA-Z0-9]{1,8}(?:[#?:].*)?$/.test(href)
}

function preprocessCitations(md: string): string {
  let out = md.replace(/:codex-file-citation\{([^}]+)\}/g, (_full, attrs) => {
    const pathMatch = attrs.match(/path="([^"]+)"/) || attrs.match(/path='([^']+)'/)
    if (!pathMatch) return ''
    const filePath = pathMatch[1]
    const name = filePath.split(/[/\\]/).pop() || filePath
    return `[${name}](omini-cite://${encodeURIComponent(filePath)})`
  })
  out = out.replace(/<oai-mem-citation>([\s\S]*?)<\/oai-mem-citation>/gi, (_full, inner) => {
    const entriesMatch = inner.match(/<citation_entries>([\s\S]*?)<\/citation_entries>/i)
    const rawEntries = (entriesMatch?.[1] || '').trim()
    if (!rawEntries) return ''
    const chips: string[] = []
    const entryRe = /([^\s|:<>]+)(?::(\d+(?:-\d+)?))?(?:\|note=\[([^\]]*)\])?/g
    for (const m of rawEntries.matchAll(entryRe)) {
      const filePath = m[1]
      if (!filePath || filePath.startsWith('<')) continue
      const range = m[2] || ''
      const note = (m[3] || '').trim()
      let lineLabel = ''
      if (range) {
        const [s, e] = range.split('-')
        lineLabel = ':' + (e && s === e ? s : range)
      }
      const name = (filePath.split(/[/\\]/).pop() || filePath) + lineLabel
      const label = note ? `${name} · ${note}` : name
      const payload = JSON.stringify({ path: filePath, note })
      chips.push(`[${label.replace(/[\[\]]/g, '')}](omini-mem://${encodeURIComponent(payload)})`)
    }
    return chips.length ? '\n\n' + chips.join(' ') : ''
  })
  return out
}

const REMARK_PLUGINS = [gfm]
const urlTransform = (url: string) =>
  (url.startsWith('omini-cite://') || url.startsWith('omini-mem://') || /^file:\/\//i.test(url)) ? url : defaultUrlTransform(url)

export const MarkdownView = React.memo(function MarkdownView({
  content,
  roomId,
  projectDir,
  onPreviewFile,
  onOpenLightbox,
  onFileContextMenu
}: {
  content: string
  roomId?: string
  projectDir?: string
  onPreviewFile?: (targetPath: string) => void
  onOpenLightbox?: (items: LightboxImageItem[], index: number) => void
  onFileContextMenu?: (e: React.MouseEvent, absPath: string, allowPreview?: boolean) => void
}) {
  const processed = useMemo(() => preprocessCitations(content), [content])
  // react-markdown treats each `components` entry as an element type. Recreating them on
  // every render (i.e. every streamed delta) remounted code blocks and thumbnails, so keep
  // them stable and read the latest callbacks through a ref.
  const handlers = useRef({ onPreviewFile, onOpenLightbox, onFileContextMenu })
  handlers.current = { onPreviewFile, onOpenLightbox, onFileContextMenu }

  const components = useMemo<Components>(() => {
    const onOpenLightbox = (items: LightboxImageItem[], index: number) => handlers.current.onOpenLightbox?.(items, index)
    const onFileContextMenu = (e: React.MouseEvent, absPath: string, allowPreview?: boolean) => handlers.current.onFileContextMenu?.(e, absPath, allowPreview)
    const hasLightbox = () => Boolean(handlers.current.onOpenLightbox)
    function openOrPreview(targetPath: string) {
      if (!targetPath) return
      const preview = handlers.current.onPreviewFile
      if (preview) preview(targetPath)
      else void window.hive.openPath(targetPath, roomId)
    }
    return {
          img: ({ src, alt }) => {
            if (!src) return null
            if (isLocalFileHref(src)) {
              const absPath = resolveClientAbsPath(src, projectDir)
              return (
                <LocalImageThumb
                  path={absPath}
                  roomId={roomId}
                  alt={alt}
                  className="md-inline-img"
                  onOpen={(resolvedPath, dataUrl) => {
                    if (hasLightbox()) onOpenLightbox([{ path: resolvedPath, name: alt, dataUrl }], 0)
                    else openOrPreview(resolvedPath)
                  }}
                  onContextMenu={(e, p) => onFileContextMenu?.(e, p, true)}
                />
              )
            }
            return <span className="md-img-alt" title={src}>[图片: {alt || src}]</span>
          },
          a: ({ href, children }) => {
            if (href?.startsWith('omini-cite://')) {
              const targetPath = decodeURIComponent(href.slice('omini-cite://'.length))
              const absPath = resolveClientAbsPath(targetPath, projectDir)
              return (
                <button
                  type="button"
                  className="cite-chip"
                  title={absPath}
                  onClick={() => openOrPreview(absPath)}
                  onContextMenu={e => onFileContextMenu?.(e, absPath, true)}
                >
                  <FileText size={12} />
                  <span>{children}</span>
                </button>
              )
            }
            if (href?.startsWith('omini-mem://')) {
              let targetPath = ''
              let note = ''
              try {
                const parsed = JSON.parse(decodeURIComponent(href.slice('omini-mem://'.length)))
                targetPath = parsed.path || ''
                note = parsed.note || ''
              } catch {}
              const absPath = resolveClientAbsPath(targetPath, projectDir)
              return (
                <button
                  type="button"
                  className="cite-chip"
                  title={[absPath, note].filter(Boolean).join(' · ')}
                  onClick={() => { if (absPath) openOrPreview(absPath) }}
                  onContextMenu={e => { if (absPath) onFileContextMenu?.(e, absPath, true) }}
                >
                  <FileText size={12} />
                  <span>{children}</span>
                </button>
              )
            }
            if (isLocalFileHref(href)) {
              const absPath = resolveClientAbsPath(href || '', projectDir)
              return (
                <a
                  href={href}
                  className="md-link md-file-link"
                  title={absPath}
                  onClick={e => {
                    e.preventDefault()
                    openOrPreview(absPath)
                  }}
                  onContextMenu={e => onFileContextMenu?.(e, absPath, true)}
                >
                  {children}
                </a>
              )
            }
            return (
              <a
                href={href}
                className="md-link"
                title={href}
                onClick={e => {
                  e.preventDefault()
                  if (href && /^https?:\/\//i.test(href)) void window.hive.openExternal(href)
                }}
              >
                {children}
                {href && /^https?:\/\//i.test(href) && <ExternalLink size={11} className="md-link-icon" />}
              </a>
            )
          },
          pre: ({ children }) => <>{children}</>,
          code: ({ className, children, ...props }) => {
            const text = String(children).replace(/\n$/, '')
            const match = /language-([\w-]+)/.exec(className || '')
            const isBlock = Boolean(match) || text.includes('\n')
            if (isBlock) return <CodeBlock lang={match?.[1] || ''} code={text} />
            if (looksLikePath(text)) {
              const absPath = resolveClientAbsPath(text, projectDir)
              return (
                <code
                  {...props}
                  className="inline-path"
                  title={absPath}
                  onClick={() => openOrPreview(absPath)}
                  onContextMenu={e => onFileContextMenu?.(e, absPath, true)}
                >
                  {children}
                </code>
              )
            }
            return <code {...props}>{children}</code>
          },
          table: ({ children }) => (
            <div className="table-wrap">
              <table>{children}</table>
            </div>
          )
    }
  }, [projectDir, roomId])

  return (
    <div className="markdown">
      <Markdown
        remarkPlugins={REMARK_PLUGINS}
        urlTransform={urlTransform}
        components={components}
      >
        {processed}
      </Markdown>
    </div>
  )
})
