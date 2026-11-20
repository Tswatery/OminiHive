export const EFFORT_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

const DEFAULT_FALLBACK_EFFORTS = ['low', 'medium', 'high']

export const REASONING_PROFILES = {
  Codex: {
    flag: null,
    protocol: 'rpc',
    defaultEfforts: ['low', 'medium', 'high', 'xhigh']
  },
  Claude: {
    flag: '--effort',
    defaultEfforts: ['low', 'medium', 'high', 'max']
  },
  Antigravity: {
    flag: null,
    protocol: 'desktop',
    defaultEfforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  },
  WorkBuddy: {
    flag: '--effort',
    defaultEfforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  },
  OhMyPi: {
    flag: '--thinking',
    defaultEfforts: ['off', 'low', 'medium', 'high', 'xhigh', 'max']
  },
  Pi: {
    flag: '--thinking',
    defaultEfforts: ['off', 'low', 'medium', 'high', 'xhigh', 'max']
  },
  OpenCode: {
    flag: '--variant',
    defaultEfforts: ['low', 'medium', 'high', 'max']
  },
  Gemini: {
    flag: null,
    envKey: 'GEMINI_THINKING_LEVEL',
    defaultEfforts: ['off', 'low', 'medium', 'high']
  },
  Kimi: {
    flag: null,
    envKey: 'KIMI_REASONING_EFFORT',
    defaultEfforts: ['low', 'medium', 'high']
  },
  Qwen: {
    flag: null,
    envKey: 'QWEN_REASONING_EFFORT',
    defaultEfforts: ['low', 'medium', 'high']
  },
  DeepSeek: {
    flag: null,
    envKey: 'DEEPSEEK_REASONING_EFFORT',
    defaultEfforts: ['low', 'medium', 'high', 'max']
  },
  Grok: {
    flag: null,
    envKey: 'GROK_REASONING_EFFORT',
    defaultEfforts: ['low', 'medium', 'high']
  },
  Hermes: {
    flag: null,
    envKey: 'HERMES_REASONING_EFFORT',
    defaultEfforts: ['low', 'medium', 'high']
  },
  MiniMax: {
    flag: null,
    envKey: 'MINIMAX_REASONING_EFFORT',
    defaultEfforts: ['low', 'medium', 'high']
  },
  OpenClaw: {
    flag: null,
    envKey: 'OPENCLAW_REASONING_EFFORT',
    defaultEfforts: ['low', 'medium', 'high']
  }
}

export function isValidEffort(level) {
  return Boolean(level && EFFORT_LEVELS.includes(String(level)))
}

export function sortEfforts(list = []) {
  const set = new Set(list.map(x => String(x || '').trim().toLowerCase()).filter(Boolean))
  return EFFORT_LEVELS.filter(e => set.has(e))
}

export function parseEffortsFromHelp(helpText = '') {
  if (!helpText || typeof helpText !== 'string') return { flag: null, efforts: [] }
  const patterns = [
    { flag: '--effort', re: /--effort\s+<[^>]+>[^(]*\(([^)]+)\)/i },
    { flag: '--thinking', re: /--thinking\s+<[^>]+>[^(]*\(([^)]+)\)/i },
    { flag: '--reasoning-effort', re: /--reasoning-effort\s+<[^>]+>[^(]*\(([^)]+)\)/i },
    { flag: '--variant', re: /--variant\s+<[^>]+>[^(]*\(([^)]+)\)/i }
  ]
  for (const { flag, re } of patterns) {
    const m = helpText.match(re)
    if (m?.[1]) {
      const parsed = sortEfforts(m[1].split(/[,|/]/))
      if (parsed.length) return { flag, efforts: parsed }
    }
  }
  return { flag: null, efforts: [] }
}

export function defaultEffortsFor(agent, helpText = '') {
  const fromHelp = parseEffortsFromHelp(helpText)
  if (fromHelp.efforts.length) return fromHelp.efforts
  const profile = REASONING_PROFILES[agent]
  return profile?.defaultEfforts ? [...profile.defaultEfforts] : [...DEFAULT_FALLBACK_EFFORTS]
}

export function normalizeModelEfforts(agent, list = [], helpText = '') {
  const fallback = defaultEffortsFor(agent, helpText)
  return (Array.isArray(list) ? list : []).map(item => {
    if (!item || typeof item !== 'object') return item
    const existing = Array.isArray(item.efforts) ? sortEfforts(item.efforts) : []
    return {
      ...item,
      efforts: existing.length ? existing : fallback
    }
  })
}

export function applyReasoningEffort({ agent, effort, args, env, emit }) {
  if (!effort) return { applied: false }
  if (!isValidEffort(effort)) throw Error('未知的思考强度')
  const profile = REASONING_PROFILES[agent] || {}

  // Native protocol agents (Codex JSON-RPC, Antigravity Desktop RPC) handle effort directly.
  if (profile.protocol) return { applied: true, mode: profile.protocol }

  if (profile.flag && Array.isArray(args)) {
    const dashIdx = args.indexOf('--')
    if (dashIdx >= 0) args.splice(dashIdx, 0, profile.flag, effort)
    else args.push(profile.flag, effort)
    emit?.('log', '请求思考强度 · ' + effort)
    return { applied: true, mode: 'flag', flag: profile.flag }
  }

  if (env && typeof env === 'object') {
    env.REASONING_EFFORT = effort
    if (profile.envKey) env[profile.envKey] = effort
  }
  emit?.('log', '请求思考强度 · ' + effort)
  return { applied: true, mode: 'env', envKey: profile.envKey || 'REASONING_EFFORT' }
}
