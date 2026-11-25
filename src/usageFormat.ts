export type ContextUsage = {
  agent: string
  usedTokens: number | null
  windowTokens: number | null
  /** used / window, one decimal; null when either side is unknown */
  percentage: number | null
  sessionBytes: number | null
  sessionFile: string
  model: string
  measuredAt: number | null
  /** Claude only: base64 images stored in the transcript, and those still in context since the last compaction */
  images?: { count: number; bytes: number; contextCount: number; contextBytes: number } | null
  /** the agent is running in this room right now */
  live: boolean
}

export type QuotaBucket = { id: string; label: string; minutes: number; usedPercent: number; resetsAt: number | null }
export type ProviderQuota = {
  provider: 'Codex' | 'Antigravity'
  state: 'ready' | 'login' | 'unavailable' | 'error'
  message?: string
  plan?: string
  account?: string
  groups: { name: string; buckets: QuotaBucket[] }[]
  resetCredits?: number
  stale?: boolean
  updatedAt: number
}

/** Past this share of the window, compaction or truncation is close. */
export const CONTEXT_WARN = 70
export const CONTEXT_CRITICAL = 90

/** `18.6k`, `981.4k`, `1M` — capital M so it never reads as minutes. */
export function formatTokens(tokens: number | null | undefined): string {
  const n = Math.max(0, Number(tokens) || 0)
  const trim = (v: string) => (v.endsWith('.0') ? v.slice(0, -2) : v)
  if (Math.round(n / 100) >= 10_000) return trim((n / 1_000_000).toFixed(1)) + 'M'
  if (n >= 1000) return trim((n / 1000).toFixed(1)) + 'k'
  return String(Math.round(n))
}

export function formatBytes(bytes: number | null | undefined): string {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10 * 1024 ? 1 : 0) + ' KB'
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(n < 100 * 1024 * 1024 ? 1 : 0) + ' MB'
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}

export function contextLevel(pct: number | null | undefined): 'ok' | 'warn' | 'critical' {
  if (pct == null) return 'ok'
  if (pct >= CONTEXT_CRITICAL) return 'critical'
  if (pct >= CONTEXT_WARN) return 'warn'
  return 'ok'
}

/** Compact reset countdown: `3天 14小时`, `33分钟`; `short` gives `3d 14h` for the status bar. */
export function formatResetIn(resetsAt: number | null | undefined, now = Date.now(), short = false): string {
  if (!resetsAt) return ''
  const mins = Math.max(0, Math.round((resetsAt - now) / 60000))
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60
  if (short) {
    if (d > 0) return `${d}d ${h}h`
    if (h > 0) return `${h}h ${m}m`
    return `${m}m`
  }
  if (d > 0) return `${d}天 ${h}小时`
  if (h > 0) return `${h}小时 ${m}分钟`
  return `${m}分钟`
}

/** Status-bar countdown with a fixed shape: `3d13h`, `4h59m`, `33m`. */
export function formatResetCompact(resetsAt: number | null | undefined, now = Date.now()): string {
  if (!resetsAt) return ''
  const mins = Math.max(0, Math.round((resetsAt - now) / 60000))
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60
  if (d > 0) return `${d}d${h}h`
  if (h > 0) return `${h}h${m}m`
  return `${m}m`
}

export function formatAgo(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return ''
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 45) return '刚刚'
  if (s < 3600) return Math.round(s / 60) + ' 分钟前'
  if (s < 86400) return Math.round(s / 3600) + ' 小时前'
  return Math.round(s / 86400) + ' 天前'
}

/** The bucket closest to running out decides what the status bar shows. */
export function tightestBucket(q: ProviderQuota): { group: string; bucket: QuotaBucket } | null {
  let best: { group: string; bucket: QuotaBucket } | null = null
  for (const g of q.groups) {
    for (const b of g.buckets) {
      if (!best || b.usedPercent > best.bucket.usedPercent ||
        (b.usedPercent === best.bucket.usedPercent && (b.resetsAt || Infinity) < (best.bucket.resetsAt || Infinity))) {
        best = { group: g.name, bucket: b }
      }
    }
  }
  return best
}

export function planLabel(plan?: string): string {
  const p = String(plan || '').trim()
  if (!p) return ''
  return p.charAt(0).toUpperCase() + p.slice(1)
}
