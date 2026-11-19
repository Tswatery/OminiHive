import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

const DB_PATH = path.join(homedir(), '.cc-switch', 'cc-switch.db')
const ALL_AGENTS = ['Claude', 'Codex', 'Antigravity', 'Gemini', 'OpenCode', 'Kimi', 'Qwen', 'OpenClaw', 'Grok', 'Hermes', 'Pi', 'MiniMax', 'DeepSeek', 'OhMyPi', 'WorkBuddy']
const APP_TO_AGENT = {
  claude: 'Claude',
  codex: 'Codex',
  agy: 'Antigravity',
  antigravity: 'Antigravity',
  gemini: 'Gemini',
  opencode: 'OpenCode',
  kimi: 'Kimi',
  'kimi-code': 'Kimi',
  qwen: 'Qwen',
  grokbuild: 'Grok',
  grok: 'Grok',
  openclaw: 'OpenClaw',
  hermes: 'Hermes',
  'hermes-agent': 'Hermes',
  pi: 'Pi',
  minimax: 'MiniMax',
  'minimax-code': 'MiniMax',
  deepseek: 'DeepSeek',
  'deepseek-harness': 'DeepSeek',
  dsh: 'DeepSeek',
  omp: 'OhMyPi',
  'oh-my-pi': 'OhMyPi',
  ohmypi: 'OhMyPi',
  workbuddy: 'WorkBuddy',
  codebuddy: 'WorkBuddy'
}
const AGENT_TO_APPS = ALL_AGENTS.reduce((acc, ag) => {
  acc[ag] = Object.entries(APP_TO_AGENT).filter(([, v]) => v === ag).map(([k]) => k)
  return acc
}, {})
const emptyProviders = () => Object.fromEntries(ALL_AGENTS.map(a => [a, []]))

function openDb() {
  if (!existsSync(DB_PATH)) return null
  return new DatabaseSync(DB_PATH, { readOnly: true })
}

function parseJson(raw, fallback = {}) {
  try { return JSON.parse(raw) } catch { return fallback }
}

export function extractClaudeModelsFromEnv(env = {}) {
  return ['sonnet', 'opus', 'fable', 'haiku'].map(role => {
    const key = 'ANTHROPIC_DEFAULT_' + role.toUpperCase() + '_MODEL'
    return {
      role,
      id: env[key] || role,
      label: env[key + '_NAME'] || env[key] || role
    }
  })
}

export function ccSwitchSummary() {
  const db = openDb()
  if (!db) {
    return { installed: false, providers: emptyProviders(), prompts: [], mcps: [], skills: [] }
  }
  try {
    const providers = emptyProviders()
    const rows = db.prepare(
      'SELECT id, app_type, name, category, is_current, settings_config, sort_index FROM providers ORDER BY is_current DESC, COALESCE(sort_index, 999), rowid'
    ).all()
    for (const r of rows) {
      const agent = APP_TO_AGENT[r.app_type]
      if (!agent) continue
      const cfg = parseJson(r.settings_config, {})
      let models = []
      if (agent === 'Claude' && cfg.env) {
        models = extractClaudeModelsFromEnv(cfg.env).map(m => ({ ...m, isDefault: m.role === cfg.model }))
      } else if (agent === 'Codex' && Array.isArray(cfg.modelCatalog?.models)) {
        models = cfg.modelCatalog.models.map(m => ({ id: m.id || m.slug || m, label: m.display_name || m.name || m.id || m }))
      }
      providers[agent].push({
        id: r.id,
        name: r.name,
        category: r.category || '',
        isCurrent: Boolean(r.is_current),
        models
      })
    }

    let prompts = []
    try {
      prompts = db.prepare('SELECT id, app_type, name, description, content, enabled FROM prompts WHERE enabled=1 ORDER BY rowid DESC').all()
        .map(p => ({ id: p.id, appType: p.app_type, name: p.name, description: p.description || '', content: p.content }))
    } catch {}

    let mcps = []
    try {
      mcps = db.prepare('SELECT id, name, description, enabled_claude, enabled_codex, enabled_agy FROM mcp_servers').all()
        .filter(m => m.enabled_claude || m.enabled_codex || m.enabled_agy)
        .map(m => ({
          id: m.id,
          name: m.name,
          description: m.description || '',
          agents: [m.enabled_claude && 'Claude', m.enabled_codex && 'Codex', m.enabled_agy && 'Antigravity'].filter(Boolean)
        }))
    } catch {}

    let skills = []
    try {
      skills = db.prepare('SELECT id, name, description, directory, enabled_claude, enabled_codex, enabled_agy FROM skills').all()
        .filter(s => s.enabled_claude || s.enabled_codex || s.enabled_agy)
        .map(s => ({
          id: s.id,
          name: s.name,
          description: s.description || '',
          directory: s.directory,
          agents: [s.enabled_claude && 'Claude', s.enabled_codex && 'Codex', s.enabled_agy && 'Antigravity'].filter(Boolean)
        }))
    } catch {}

    return { installed: true, providers, prompts, mcps, skills }
  } finally {
    db.close()
  }
}

export function resolveProviderConfig(agent, providerId) {
  if (!providerId) return null
  const appTypes = AGENT_TO_APPS[agent]
  if (!appTypes?.length) return null
  const db = openDb()
  if (!db) return null
  try {
    const placeholders = appTypes.map(() => '?').join(',')
    const row = db.prepare(`SELECT id, name, settings_config FROM providers WHERE id=? AND app_type IN (${placeholders})`).get(providerId, ...appTypes)
    if (!row) return null
    const cfg = parseJson(row.settings_config, {})
    return { id: row.id, name: row.name, cfg }
  } finally {
    db.close()
  }
}

export function legacyCodexRollout(provider, session) {
  if (!provider || !session) return
  const old = path.join(tmpdir(), 'ominihive-codex-' + provider.id.replace(/[^a-zA-Z0-9_-]/g, '_'), 'state_5.sqlite')
  if (!existsSync(old)) return
  const db = new DatabaseSync(old, {readOnly:true})
  try {
    const row = db.prepare('SELECT rollout_path FROM threads WHERE id=?').get(session)
    return row?.rollout_path && existsSync(row.rollout_path) ? row.rollout_path : undefined
  } finally { db.close() }
}

export function prepareCodexHome(provider, sharedHome) {
  if (!provider?.cfg) return null
  const dir = path.join(homedir(), 'Library/Application Support/OminiHive/providers', encodeURIComponent(provider.id).replace(/\./g,'%2E'))
  mkdirSync(dir, { recursive:true, mode:0o700 })
  const shared = path.join(sharedHome, 'sessions')
  mkdirSync(shared, {recursive:true, mode:0o700})
  const link = path.join(dir, 'sessions')
  try { symlinkSync(shared, link, 'dir') } catch (e) {
    if (e.code !== 'EEXIST' || realpathSync(link) !== realpathSync(shared)) throw e
  }
  if (provider.cfg.auth && typeof provider.cfg.auth === 'object') {
    writeFileSync(path.join(dir, 'auth.json'), JSON.stringify(provider.cfg.auth, null, 2), {mode:0o600})
  }
  if (typeof provider.cfg.config === 'string') {
    writeFileSync(path.join(dir, 'config.toml'), provider.cfg.config, {mode:0o600})
  }
  return dir
}
