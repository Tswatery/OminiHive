// Normalize LaTeX \(...\) and \[...\] math delimiters to $...$ and $$...$$
// while leaving fenced code blocks and inline code spans untouched.

const CODE_SEGMENT_RE = /(^ {0,3}(?:`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}(?:`{3,}|~{3,})[ \t]*(?:\n|$)|$)|`+[^`\n]+`+)/gm

function replaceLatexDelimiters(text: string): string {
  // Display math: \[ ... \]
  let out = text.replace(/\\\[([\s\S]+?)\\\]/g, (full, inner: string) => {
    const trimmed = inner.trim()
    if (!trimmed) return full
    return `$$${trimmed}$$`
  })
  // Inline math: \( ... \)
  out = out.replace(/\\\(([^\n]+?)\\\)/g, (full, inner: string) => {
    const trimmed = inner.trim()
    if (!trimmed) return full
    return `$${trimmed}$`
  })
  return out
}

export function preprocessMathDelimiters(md: string): string {
  if (!md || (!md.includes('\\(') && !md.includes('\\['))) return md
  let out = ''
  let last = 0
  for (const m of md.matchAll(CODE_SEGMENT_RE)) {
    const idx = m.index ?? 0
    if (idx > last) out += replaceLatexDelimiters(md.slice(last, idx))
    out += m[0]
    last = idx + m[0].length
  }
  if (last < md.length) out += replaceLatexDelimiters(md.slice(last))
  return out
}
