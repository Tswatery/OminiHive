// Pure step-log parsing (no React) so it can be unit-tested with `node --test`.

export type StepInteractionOption = {
  id: string
  label: string
  description?: string
  danger?: boolean
  payload: Record<string, unknown>
}

export type StepInteraction = {
  provider?: string
  interactionId?: string
  cascadeId: string
  trajectoryId?: string
  stepIndex: number
  kind: string
  title: string
  target?: string
  reason?: string
  fallbackOnly?: boolean
  allowCustom?: boolean
  options: StepInteractionOption[]
}

export type StepBlock = {
  id: string
  kind: 'tool' | 'cmd' | 'thought' | 'file' | 'info'
  title: string
  /** 'stopped' is UI-only: a step that never finished because the message was stopped/interrupted. */
  status: 'running' | 'waiting' | 'done' | 'error' | 'stopped'
  detail?: string
  interaction?: StepInteraction | null
}

export type ParsedStepsResult = {
  steps: StepBlock[]
  metaTags: string[]
  /** Detail of the "上下文" meta step (which messages were carried this turn), if any. */
  contextDetail: string
}

export function formatDuration(ms: number): string {
  if (!ms || ms < 0) return '0s'
  const s = ms / 1000
  if (s < 60) return s.toFixed(1) + 's'
  const m = Math.floor(s / 60)
  const rem = Math.round(s % 60)
  return `${m}m ${rem}s`
}

const META_PREFIXES = ['模型 · ', '请求思考强度 · ', '思考强度 · ', '上下文 · ', '提供商 · ']

function isMetaStep(step: StepBlock): boolean {
  return META_PREFIXES.some(p => step.title.startsWith(p))
}

function formatMetaTag(title: string): string {
  if (title.startsWith('模型 · ')) return title.slice(5).trim()
  if (title.startsWith('请求思考强度 · ')) return title.slice(9).trim()
  if (title.startsWith('思考强度 · ')) return title.slice(7).trim()
  if (title.startsWith('上下文 · ')) return title.replace('上下文 · ', '上下文 ').trim()
  if (title.startsWith('提供商 · ')) return title.slice(6).trim()
  return title.trim()
}

function isEmptyThought(step: StepBlock): boolean {
  if (step.kind !== 'thought') return false
  if (step.status === 'running' || step.status === 'waiting') return false
  return !step.detail?.trim()
}

/** How unfinished (running / waiting) steps should be shown once the message has ended. */
export type StepEndState = 'done' | 'error' | 'stopped'

export function parseStepsWithMeta(log: string, messageEnded: boolean, endState: StepEndState = 'done'): ParsedStepsResult {
  if (!log) return { steps: [], metaTags: [], contextDetail: '' }
  const map = new Map<string, StepBlock>()
  const order: string[] = []
  let rawIdx = 0

  const upsert = (step: StepBlock) => {
    const existing = map.get(step.id)
    if (existing) {
      map.set(step.id, {
        ...existing,
        ...step,
        detail: step.detail ?? existing.detail,
        interaction: step.interaction !== undefined ? step.interaction : (step.status === 'waiting' ? existing.interaction : null)
      })
    } else {
      map.set(step.id, step)
      order.push(step.id)
    }
  }

  for (const line of log.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.startsWith('::step::')) {
      try {
        const parsed = JSON.parse(trimmed.slice(8)) as StepBlock
        if (parsed && parsed.id) {
          upsert({
            id: parsed.id,
            kind: parsed.kind || 'tool',
            title: parsed.title || '步骤',
            status: parsed.status || 'done',
            detail: parsed.detail,
            interaction: parsed.interaction
          })
          continue
        }
      } catch {}
    }

    const legacyTool = trimmed.match(/^(.+?)\s·\s(pending|in_progress|completed|failed|cancelled)$/i)
    if (legacyTool) {
      const title = legacyTool[1].trim()
      const rawSt = legacyTool[2].toLowerCase()
      const status: StepBlock['status'] = rawSt === 'completed' ? 'done' : (rawSt === 'failed' || rawSt === 'cancelled') ? 'error' : 'running'
      upsert({ id: 'legacy:' + title, kind: 'cmd', title, status })
      continue
    }

    if (META_PREFIXES.some(p => trimmed.startsWith(p))) {
      upsert({ id: 'meta:' + trimmed.split(' · ')[0], kind: 'info', title: trimmed, status: 'done' })
      continue
    }

    const prevId = order[order.length - 1]
    const prev = prevId ? map.get(prevId) : undefined
    if (prev && prev.id.startsWith('raw:')) {
      prev.detail = ((prev.detail ? prev.detail + '\n' : '') + line).slice(-1200)
    } else {
      const id = 'raw:' + (rawIdx++)
      upsert({ id, kind: 'cmd', title: trimmed.slice(0, 80), status: 'done', detail: trimmed.length > 80 ? trimmed : undefined })
    }
  }

  const metaTags: string[] = []
  const steps: StepBlock[] = []
  let contextDetail = ''
  let contextTag = ''

  for (const id of order) {
    const raw = map.get(id)!
    const item: StepBlock = (messageEnded && (raw.status === 'running' || raw.status === 'waiting'))
      ? { ...raw, status: endState, interaction: null }
      : raw

    if (isMetaStep(item)) {
      const tag = formatMetaTag(item.title)
      if (item.title.startsWith('上下文 · ')) {
        contextTag = tag
        if (item.detail?.trim()) contextDetail = item.detail
      } else if (tag && !metaTags.includes(tag)) metaTags.push(tag)
      continue
    }

    if (isEmptyThought(item)) continue

    steps.push(item)
  }

  // model / effort first, the (longer) context summary last so truncation eats it, not the model
  if (contextTag) metaTags.push(contextTag)
  return { steps, metaTags, contextDetail }
}
