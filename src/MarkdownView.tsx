import React, { useState } from 'react'
import Markdown, { defaultUrlTransform } from 'react-markdown'
import gfm from 'remark-gfm'
import { Check, Copy, ExternalLink, FileText } from 'lucide-react'

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
  if (!s || s.length > 180 || /\s/.test(s)) return false
  return (/^(?:\.{0,2}\/|~\/|[a-zA-Z0-9_-]+\/)/.test(s) || /\.(?:tsx?|jsx?|mjs|cjs|css|json|md|py|rs|go|sh|ya?ml|sqlite|html)$/i.test(s))
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

export const MarkdownView = React.memo(function MarkdownView({ content, roomId }: { content: string; roomId?: string }) {
  const processed = preprocessCitations(content)
  return (
    <div className="markdown">
      <Markdown
        remarkPlugins={[gfm]}
        urlTransform={url => (url.startsWith('omini-cite://') || url.startsWith('omini-mem://')) ? url : defaultUrlTransform(url)}
        components={{
          img: ({ src, alt }) => src ? <span className="md-img-alt">[图片: {alt || src}]</span> : null,
          a: ({ href, children }) => {
            if (href?.startsWith('omini-cite://')) {
              const targetPath = decodeURIComponent(href.slice('omini-cite://'.length))
              return (
                <button
                  type="button"
                  className="cite-chip"
                  title={targetPath + ' · 点击在 Finder 中定位'}
                  onClick={() => void window.hive.openPath(targetPath, roomId)}
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
              return (
                <button
                  type="button"
                  className="cite-chip"
                  title={[targetPath, note].filter(Boolean).join(' · ')}
                  onClick={() => { if (targetPath) void window.hive.openPath(targetPath, roomId) }}
                >
                  <FileText size={12} />
                  <span>{children}</span>
                </button>
              )
            }
            return (
              <a
                href={href}
                className="md-link"
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
              return (
                <code
                  {...props}
                  className="inline-path"
                  title="点击在 Finder 中定位"
                  onClick={() => void window.hive.openPath(text, roomId)}
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
        }}
      >
        {processed}
      </Markdown>
    </div>
  )
})
