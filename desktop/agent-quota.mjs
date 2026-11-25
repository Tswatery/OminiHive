// Subscription quota for Codex (ChatGPT plan rate limits) and Antigravity (agy /usage).
// Both reads spend no model turns: Codex asks its app-server, agy answers /usage as a slash command.
import { spawn, execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'

const run = promisify(execFile)
const SESSION_MINUTES = 300
const WEEKLY_MINUTES = 10080
const MIN_AGY_USAGE_VERSION = '1.1.11'

function finite(value) {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

function clampPct(value) {
  return Math.min(100, Math.max(0, value))
}

function windowLabel(minutes) {
  if (Math.abs(minutes - SESSION_MINUTES) <= 1) return '5h'
  if (Math.abs(minutes - WEEKLY_MINUTES) <= 1) return '每周'
  if (minutes >= 43000 && minutes <= 44700) return '每月'
  if (minutes > 0 && minutes % 1440 === 0) return minutes / 1440 + '天'
  if (minutes > 0 && minutes % 60 === 0) return minutes / 60 + 'h'
  return ''
}

/** Map `account/rateLimits/read` to display windows (used percent, reset epoch ms). */
export function mapCodexRateLimits(result, account) {
  const limits = result?.rateLimits
  if (!limits || typeof limits !== 'object') return null
  const windows = []
  for (const raw of [limits.primary, limits.secondary]) {
    const used = finite(raw?.usedPercent)
    if (used === null) continue
    const minutes = finite(raw.windowDurationMins) || 0
    const reset = finite(raw.resetsAt)
    windows.push({
      id: minutes ? 'w' + minutes : 'w' + windows.length,
      label: windowLabel(minutes) || (windows.length ? '每周' : '5h'),
      minutes,
      usedPercent: clampPct(used),
      resetsAt: reset && reset > 0 ? reset * 1000 : null
    })
  }
  const individual = finite(limits.individualLimit?.remainingPercent)
  if (!windows.length && individual !== null) {
    const reset = finite(limits.individualLimit?.resetsAt)
    windows.push({ id: 'monthly', label: '每月', minutes: 43200, usedPercent: clampPct(100 - individual), resetsAt: reset ? reset * 1000 : null })
  }
  windows.sort((a, b) => (a.minutes || 0) - (b.minutes || 0))
  const credits = result?.rateLimitResetCredits
  const resetCredits = finite(credits?.availableCount)
  const plan = String(limits.planType || account?.planType || '')
  return {
    provider: 'Codex',
    state: 'ready',
    plan,
    account: String(account?.email || ''),
    groups: [{ name: '', buckets: windows }],
    resetCredits: resetCredits !== null && resetCredits > 0 ? resetCredits : 0,
    reachedType: limits.rateLimitReachedType || null,
    updatedAt: Date.now()
  }
}

/** Short status-bar label for an agy group name. */
function agyGroupShort(name) {
  const n = String(name || '')
  if (/^gemini/i.test(n)) return 'Gemini'
  if (/claude/i.test(n) && /gpt/i.test(n)) return 'Claude/GPT'
  return n.replace(/\s+models?$/i, '')
}

/** Parse the `agy -p /usage --output-format json` envelope. Null when it is not a usage reply. */
export function parseAgyUsage(stdout) {
  for (const line of String(stdout || '').split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    let value
    try { value = JSON.parse(t) } catch { continue }
    if (value?.status !== 'SUCCESS' || value?.command?.name !== 'usage') continue
    const groups = []
    for (const g of value.command.data?.groups || []) {
      if (!g?.name || !Array.isArray(g.buckets)) continue
      const buckets = []
      for (const b of g.buckets) {
        const fraction = finite(b?.remaining_fraction)
        // Disabled buckets are unmetered; showing them as unused would invent headroom.
        if (!b?.id || fraction === null || b.disabled === true) continue
        const minutes = b.window === 'weekly' ? WEEKLY_MINUTES : b.window === '5h' ? SESSION_MINUTES : 0
        const reset = Date.parse(b.reset_time || '')
        buckets.push({
          id: String(b.id),
          label: windowLabel(minutes) || String(b.window || b.name || ''),
          minutes,
          usedPercent: clampPct(Math.round((1 - fraction) * 1000) / 10),
          resetsAt: Number.isFinite(reset) ? reset : null
        })
      }
      buckets.sort((a, b) => (b.minutes || 0) - (a.minutes || 0))
      if (buckets.length) groups.push({ name: agyGroupShort(g.name), buckets })
    }
    return { provider: 'Antigravity', state: 'ready', plan: '', account: '', groups, resetCredits: 0, updatedAt: Date.now() }
  }
  return null
}

/** True when agy treated the command as a billed prompt (conversation or turns recorded). */
export function agyRanModelTurn(stdout) {
  for (const line of String(stdout || '').split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      const v = JSON.parse(t)
      if ((typeof v.num_turns === 'number' && v.num_turns > 0) || (typeof v.conversation_id === 'string' && v.conversation_id)) return true
    } catch {}
  }
  return false
}

export function versionAtLeast(version, min) {
  const a = String(version || '').match(/(\d+)\.(\d+)\.(\d+)/)
  const b = min.split('.').map(Number)
  if (!a) return false
  for (let i = 0; i < 3; i++) {
    const x = Number(a[i + 1])
    if (x !== b[i]) return x > b[i]
  }
  return true
}

function failure(provider, message, state = 'error') {
  return { provider, state, message, groups: [], updatedAt: Date.now() }
}

function readCodexQuota(exe, env) {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(exe, ['app-server', '--stdio'], { env, stdio: 'pipe' })
    } catch (e) {
      resolve(failure('Codex', 'Codex CLI 无法启动'))
      return
    }
    let settled = false, stderr = '', account = null
    const done = result => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill('SIGTERM') } catch {}
      resolve(result)
    }
    const timer = setTimeout(() => done(failure('Codex', 'Codex 额度查询超时')), 20000)
    const send = obj => { try { child.stdin.write(JSON.stringify(obj) + '\n') } catch {} }
    child.on('error', () => done(failure('Codex', 'Codex CLI 无法启动')))
    child.stdin.on('error', () => {})
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-2000) })
    child.on('close', () => done(failure('Codex', /login|auth|sign in/i.test(stderr) ? '请先登录 Codex（ChatGPT 账号）' : 'Codex 进程已退出')))
    createInterface({ input: child.stdout }).on('line', line => {
      let msg
      try { msg = JSON.parse(line) } catch { return }
      if (msg.id === 1) {
        send({ method: 'initialized', params: {} })
        send({ id: 3, method: 'account/read', params: {} })
        send({ id: 2, method: 'account/rateLimits/read', params: {} })
      } else if (msg.id === 3) {
        account = msg.result?.account || null
      } else if (msg.id === 2) {
        if (msg.error) {
          const text = String(msg.error.message || '')
          done(failure('Codex', /api key|apikey/i.test(text) ? 'API Key 登录没有订阅额度可查' : /auth|login|token/i.test(text) ? '请先登录 Codex（ChatGPT 账号）' : 'Codex 额度暂不可用', /auth|login|api key/i.test(text) ? 'login' : 'error'))
          return
        }
        // account/read usually answers first; give it a beat so the plan name is filled.
        setTimeout(() => {
          const mapped = mapCodexRateLimits(msg.result, account)
          done(mapped || failure('Codex', 'Codex 未返回额度信息'))
        }, account ? 0 : 300)
      }
    })
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'ominihive', title: 'OminiHive', version: '0.1.0' } } })
  })
}

async function readAgyQuota(exe, env, state) {
  if (state.unsupported) return failure('Antigravity', '当前 agy 版本不支持 /usage，请升级 agy CLI', 'unavailable')
  const probeEnv = { ...env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' }
  // Older agy answers /usage as a billed prompt, so confirm the version before asking.
  let version = ''
  try {
    const r = await run(exe, ['--version'], { env: probeEnv, timeout: 6000 })
    version = (r.stdout || r.stderr || '').trim()
  } catch {}
  if (!versionAtLeast(version, MIN_AGY_USAGE_VERSION)) {
    return failure('Antigravity', `需要 agy ${MIN_AGY_USAGE_VERSION} 及以上版本${version ? '（当前 ' + version + '）' : ''}`, 'unavailable')
  }
  let stdout = '', stderr = ''
  try {
    const r = await run(exe, ['-p', '/usage', '--output-format', 'json', '--print-timeout', '20s'], { env: probeEnv, timeout: 30000, maxBuffer: 512 * 1024 })
    stdout = r.stdout; stderr = r.stderr
  } catch (e) {
    stdout = e.stdout || ''; stderr = e.stderr || ''
  }
  const reading = parseAgyUsage(stdout)
  if (reading) return reading.groups.length ? reading : failure('Antigravity', 'agy 未报告此账号的额度', 'unavailable')
  if (agyRanModelTurn(stdout)) {
    state.unsupported = true
    return failure('Antigravity', '当前 agy 版本不支持 /usage，请升级 agy CLI', 'unavailable')
  }
  const text = stdout + '\n' + stderr
  if (/sign.?in|log.?in|unauthenticated|credential/i.test(text)) return failure('Antigravity', '请先运行 agy 登录 Google 账号', 'login')
  if (/429|rate.?limit|resource.?exhausted/i.test(text)) return failure('Antigravity', 'Antigravity 额度接口限流，请稍后刷新')
  return failure('Antigravity', 'Antigravity 未返回额度信息')
}

/**
 * Cached quota reader. `read(force)` returns the last snapshot unless it is older than
 * `maxAgeMs` (or forced); concurrent reads share one in-flight request per provider.
 */
export function createAgentQuota({ binary, env, file, maxAgeMs = 4 * 60 * 1000 } = {}) {
  const cache = new Map()
  // The last good reading survives restarts so the status bar paints instantly, then refreshes.
  try {
    if (file && existsSync(file)) {
      for (const q of JSON.parse(readFileSync(file, 'utf8'))) if (q?.provider && q.state === 'ready') cache.set(q.provider, q)
    }
  } catch {}
  const persist = () => {
    if (!file) return
    try { writeFileSync(file, JSON.stringify([...cache.values()].filter(q => q.state === 'ready'))) } catch {}
  }
  const inflight = new Map()
  const agyState = { unsupported: false }
  const readers = {
    Codex: async () => {
      const exe = binary('Codex')
      if (!exe) return failure('Codex', '未安装 Codex CLI', 'unavailable')
      return readCodexQuota(exe, await env('Codex'))
    },
    Antigravity: async () => {
      const exe = binary('Antigravity')
      if (!exe) return failure('Antigravity', '未安装 agy CLI', 'unavailable')
      return readAgyQuota(exe, await env('Antigravity'), agyState)
    }
  }
  function readOne(provider, force) {
    if (!readers[provider]) return Promise.resolve(failure(provider, '不支持的额度来源', 'unavailable'))
    const hit = cache.get(provider)
    if (!force && hit && Date.now() - hit.updatedAt < maxAgeMs) return Promise.resolve(hit)
    if (inflight.has(provider)) return inflight.get(provider)
    const p = readers[provider]()
      .catch(() => failure(provider, '额度查询失败'))
      .then(result => {
        // Keep the last good reading visible when a refresh fails transiently.
        const prev = cache.get(provider)
        const next = result.state !== 'ready' && prev?.state === 'ready' ? { ...prev, stale: true, message: result.message } : result
        cache.set(provider, next)
        persist()
        return next
      })
      .finally(() => inflight.delete(provider))
    inflight.set(provider, p)
    return p
  }
  return {
    peek: () => Object.keys(readers).map(p => cache.get(p)).filter(Boolean),
    readOne,
    read: async (force = false) => Promise.all(Object.keys(readers).map(p => readOne(p, force)))
  }
}
