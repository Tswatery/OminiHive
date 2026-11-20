// Mention parsing shared by the composer, message bubbles and target inference.
// Must stay in lockstep with desktop/store.mjs routeTargets (tests/ui-logic.test.mjs checks parity).
// Dependency-free on purpose so node:test can import it directly.
export function buildMentionTools<A extends string>(known: readonly A[]) {
  const part = known.join('|')
  const MENTION_MATCH_RE = new RegExp(`(?:^|\\s)@(${part}|all)(?=\\s|$|[，。,.!?！？])`, 'gi')
  // Same boundary rule as routing, so "@Codex帮我" is not shown as a mention tag it will not be routed as.
  const MENTION_SPLIT_RE = new RegExp(`(@(?:${part}|all))(?=\\s|$|[，。,.!?！？])`, 'gi')
  const LEADING_MENTIONS_RE = new RegExp(`^(?:@(?:${part}|all)\\s+)+`, 'i')
  const LEADING_MENTION_STEP_RE = new RegExp(`^@(${part}|all)(?:\\s+|$)`, 'i')

  /**
   * Mirrors desktop/store.mjs routeTargets: mentions at the very start of the message decide
   * the recipients; only when there are none do mentions elsewhere in the text count. So
   * "@Codex 参考 @Claude 的方案" goes to Codex only — exactly what the backend will run.
   */
  function parseMentionedAgents(text: string, allPool: readonly A[] = known): { agents: A[]; isAll: boolean } {
    const found: A[] = []
    let isAll = false
    const names: string[] = []
    let rest = text.trimStart()
    for (let m = rest.match(LEADING_MENTION_STEP_RE); m; m = rest.match(LEADING_MENTION_STEP_RE)) {
      names.push(m[1])
      rest = rest.slice(m[0].length)
    }
    if (!names.length) for (const m of text.matchAll(MENTION_MATCH_RE)) names.push(m[1])
    for (const name of names) {
      if (name.toLowerCase() === 'all') {
        isAll = true
        for (const a of allPool) if (!found.includes(a)) found.push(a)
      } else {
        const norm = known.find(a => a.toLowerCase() === name.toLowerCase())
        if (norm && !found.includes(norm)) found.push(norm)
      }
    }
    return { agents: found, isAll }
  }

  return { MENTION_MATCH_RE, MENTION_SPLIT_RE, LEADING_MENTIONS_RE, parseMentionedAgents }
}
