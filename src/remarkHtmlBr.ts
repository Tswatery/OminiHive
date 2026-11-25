// Remark plugin that converts inline/block HTML <br> tags into mdast `break` nodes
// without enabling full raw HTML parsing (leaving code spans/blocks and other HTML untouched).

type MdastNode = {
  type: string
  value?: string
  children?: MdastNode[]
}

const ONLY_BR_RE = /^(?:\s*<br\s*\/?>\s*)+$/i
const SINGLE_BR_RE = /<br\s*\/?>/gi

function transformChildren(node: MdastNode) {
  if (!Array.isArray(node.children)) return
  const next: MdastNode[] = []
  let changed = false
  for (const child of node.children) {
    if (child.type === 'html' && typeof child.value === 'string' && ONLY_BR_RE.test(child.value)) {
      const matches = child.value.match(SINGLE_BR_RE)
      if (matches && matches.length > 0) {
        for (let i = 0; i < matches.length; i++) {
          next.push({ type: 'break' })
        }
        changed = true
        continue
      }
    }
    transformChildren(child)
    next.push(child)
  }
  if (changed) {
    node.children = next
  }
}

export function remarkHtmlBr() {
  return (tree: MdastNode) => {
    transformChildren(tree)
  }
}
