// Per-room, per-agent context window usage and native session file size.
// Agents report live readings while they run (emit('context', …)); rooms that
// have not run in this app session are hydrated from the native session files.
import { existsSync, readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { homedir } from 'node:os'

export const CONTEXT_AGENTS = ['Codex', 'Claude', 'Antigravity']

function positive(value) {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0
}

/** Tokens the model had in context for one Claude API call. */
export function claudeContextTokens(usage) {
  if (!usage || typeof usage !== 'object') return 0
  return positive(usage.input_tokens) + positive(usage.cache_creation_input_tokens) +
    positive(usage.cache_read_input_tokens) + positive(usage.output_tokens)
}

/** Strip the window suffix (`[1m]`) and casing so init and response names compare. */
function baseModel(model) {
  return String(model || '').replace(/\[[^\]]*\]$/, '').trim().toLowerCase()
}

/** The main thread's window from a Claude `result.modelUsage`; subagents may use other models. */
export function claudeWindowFromResult(modelUsage, model = '') {
  if (!modelUsage || typeof modelUsage !== 'object') return 0
  const entries = Object.entries(modelUsage)
    .map(([key, u]) => ({ key, window: positive(u?.contextWindow) }))
    .filter(e => e.window > 0)
  if (!entries.length) return 0
  const want = baseModel(model)
  const exact = entries.filter(e => e.key === model)
  const named = entries.filter(e => want && baseModel(e.key) === want)
  const pool = exact.length ? exact : named.length ? named : entries
  return Math.max(...pool.map(e => e.window))
}

export function claudeWindowHint(model) {
  return /\[1m\]$/i.test(String(model || '').trim()) ? 1_000_000 : 0
}

/** Codex `thread/tokenUsage/updated`: `last.totalTokens` is the current context, `total` is lifetime spend. */
export function readCodexTokenUsage(params) {
  const usage = params?.tokenUsage
  if (!usage || typeof usage !== 'object') return null
  const usedTokens = positive(usage.last?.totalTokens)
  if (!usedTokens) return null
  return { usedTokens, windowTokens: positive(usage.modelContextWindow) || undefined }
}

/** Last `token_count` event in a Codex rollout tail. */
export function codexUsageFromRollout(text) {
  const lines = String(text || '').split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.includes('"token_count"')) continue
    try {
      const e = JSON.parse(line)
      const info = e?.payload?.info
      const used = positive(info?.last_token_usage?.total_tokens)
      const at = Date.parse(e?.timestamp || '')
      if (used) return { usedTokens: used, windowTokens: positive(info?.model_context_window) || undefined, ...(Number.isFinite(at) ? { measuredAt: at } : {}) }
    } catch {}
  }
  return null
}

/** Last main-thread assistant usage in a Claude transcript tail. */
export function claudeUsageFromTranscript(text) {
  const lines = String(text || '').split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.includes('"assistant"') || !line.includes('"usage"')) continue
    try {
      const e = JSON.parse(line)
      if (e?.type !== 'assistant' || e.isSidechain) continue
      const used = claudeContextTokens(e.message?.usage)
      const at = Date.parse(e.timestamp || '')
      if (used) return { usedTokens: used, responseModel: String(e.message?.model || ''), ...(Number.isFinite(at) ? { measuredAt: at } : {}) }
    } catch {}
  }
  return null
}

/**
 * Newest Antigravity reading. The model's reported usage (input + cache read + output) is what the
 * client itself shows; `estimatedTokensUsed` is a local pre-estimate that runs well above it
 * (641k estimated vs 496k billed on a 512k window), so it is only a fallback.
 */
export function antigravityContextFromGenerators(list) {
  if (!Array.isArray(list)) return null
  const metaOf = g => g?.chatModel?.chatStartMetadata?.contextWindowMetadata
  let windowTokens = 0, estimate = 0
  for (let i = list.length - 1; i >= 0 && !(windowTokens && estimate); i--) {
    windowTokens ||= positive(metaOf(list[i])?.maxContextTokens)
    estimate ||= positive(metaOf(list[i])?.estimatedTokensUsed)
  }
  for (let i = list.length - 1; i >= 0; i--) {
    const u = list[i]?.chatModel?.usage
    // A generator still streaming has no usage yet; the previous call is the latest real measurement.
    const used = positive(u?.inputTokens) + positive(u?.cacheReadTokens) + positive(u?.outputTokens)
    if (used) return { usedTokens: used, windowTokens: windowTokens || undefined }
  }
  return estimate ? { usedTokens: estimate, windowTokens: windowTokens || undefined } : null
}

export function claudeProjectDirName(cwd) {
  return String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-')
}

export function claudeSessionFile(cwd, sessionId) {
  if (!sessionId) return ''
  return path.join(homedir(), '.claude', 'projects', claudeProjectDirName(cwd), sessionId + '.jsonl')
}

export function antigravitySessionFile(cascadeId) {
  if (!cascadeId) return ''
  return path.join(homedir(), '.gemini', 'antigravity', 'conversations', cascadeId + '.db')
}

async function readTail(file, bytes = 512 * 1024) {
  const fh = await open(file, 'r')
  try {
    const { size } = await fh.stat()
    const start = Math.max(0, size - bytes)
    const buf = Buffer.alloc(size - start)
    await fh.read(buf, 0, buf.length, start)
    return buf.toString('utf8')
  } finally {
    await fh.close()
  }
}

async function findClaudeTranscript(sessionId) {
  const root = path.join(homedir(), '.claude', 'projects')
  for (const dir of await readdir(root).catch(() => [])) {
    const file = path.join(root, dir, sessionId + '.jsonl')
    if (existsSync(file)) return file
  }
  return ''
}

const codexRolloutCache = new Map()
const codexRolloutMisses = new Map()
async function findCodexRollout(threadId) {
  if (codexRolloutCache.has(threadId)) return codexRolloutCache.get(threadId)
  // A thread whose rollout is not written yet (or was deleted) must not re-walk the tree on every refresh.
  const miss = codexRolloutMisses.get(threadId)
  if (miss && Date.now() - miss < 20000) return ''
  const root = path.join(process.env.CODEX_HOME || path.join(homedir(), '.codex'), 'sessions')
  const suffix = '-' + threadId + '.jsonl'
  // Newest days first: an active thread almost always lives in a recent folder.
  const desc = async dir => (await readdir(dir).catch(() => [])).sort().reverse()
  for (const y of await desc(root)) {
    for (const m of await desc(path.join(root, y))) {
      for (const d of await desc(path.join(root, y, m))) {
        const dayDir = path.join(root, y, m, d)
        const hit = (await readdir(dayDir).catch(() => [])).find(f => f.endsWith(suffix))
        if (hit) {
          const file = path.join(dayDir, hit)
          codexRolloutCache.set(threadId, file)
          return file
        }
      }
    }
  }
  codexRolloutMisses.set(threadId, Date.now())
  return ''
}

/** Count base64 image payloads in one transcript line. `sent` is the copy in message content (what the API receives). */
export function scanTranscriptLine(line) {
  const out = { count: 0, bytes: 0, sentBytes: 0, compact: false }
  if (line.includes('"compact_boundary"')) out.compact = true
  if (!line.includes('image/')) return out
  let i = 0
  const marker = '"media_type":"image/'
  while ((i = line.indexOf(marker, i)) !== -1) { out.count++; i += marker.length }
  for (const key of ['"data":"', '"base64":"']) {
    let at = 0
    while ((at = line.indexOf(key, at)) !== -1) {
      const start = at + key.length
      const end = line.indexOf('"', start)
      if (end === -1) break
      const len = end - start
      // Short values are ids or tiny strings, not image payloads.
      if (len >= 512) {
        out.bytes += len
        if (key === '"data":"') out.sentBytes += len
      }
      at = end + 1
    }
  }
  return out
}

/**
 * Incremental image accounting for a Claude transcript: resumes from the last scanned byte,
 * consumes whole lines only, and restarts if the file was rewritten shorter.
 */
export async function scanClaudeImages(file, prev) {
  const { size } = await stat(file)
  let s = prev && size >= prev.offset
    ? { ...prev }
    : { offset: 0, count: 0, bytes: 0, ctxCount: 0, ctxBytes: 0 }
  if (size === s.offset) return s
  const fh = await open(file, 'r')
  try {
    let pending = Buffer.alloc(0)
    let pos = s.offset
    const CHUNK = 8 * 1024 * 1024
    while (pos < size) {
      const buf = Buffer.alloc(Math.min(CHUNK, size - pos))
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos)
      if (!bytesRead) break
      pos += bytesRead
      pending = pending.length ? Buffer.concat([pending, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead)
      const lastNl = pending.lastIndexOf(0x0a)
      if (lastNl === -1) continue
      const text = pending.subarray(0, lastNl).toString('utf8')
      for (const line of text.split('\n')) {
        const r = scanTranscriptLine(line)
        if (r.compact) { s.ctxCount = 0; s.ctxBytes = 0 }
        s.count += r.count
        s.bytes += r.bytes
        s.ctxCount += r.count
        s.ctxBytes += r.sentBytes
      }
      s.offset += lastNl + 1
      pending = pending.subarray(lastNl + 1)
    }
  } finally {
    await fh.close()
  }
  return s
}

async function resolveSessionFile(agent, sessionId) {
  if (!sessionId) return ''
  if (agent === 'Codex') return findCodexRollout(sessionId)
  if (agent === 'Claude') return findClaudeTranscript(sessionId)
  const f = antigravitySessionFile(sessionId)
  return existsSync(f) ? f : ''
}

function fileBytes(file) {
  if (!file) return null
  try {
    let total = statSync(file).size
    // SQLite keeps recent writes in the WAL until checkpoint; count it as part of the session.
    if (file.endsWith('.db')) { try { total += statSync(file + '-wal').size } catch {} }
    return total
  } catch {
    return null
  }
}

export function createContextUsage({ file, readAntigravityContext, probeWindow, onChange } = {}) {
  let state = { rooms: {}, windows: {} }
  try { if (file && existsSync(file)) state = { rooms: {}, windows: {}, ...JSON.parse(readFileSync(file, 'utf8')) } } catch {}
  if (state.v !== 2) {
    // v1 stored the transcript's response model as `model`; behind a gateway that is not the model the user chose.
    for (const rows of Object.values(state.rooms)) for (const e of Object.values(rows)) {
      if (e?.model) { e.responseModel ||= e.model; delete e.model }
    }
    state.v = 2
  }
  if (state.v === 2) {
    // v2 read Antigravity's inflated pre-estimate; drop it so the next read uses reported usage.
    for (const rows of Object.values(state.rooms)) if (rows?.Antigravity) delete rows.Antigravity.usedTokens
    state.v = 3
  }
  let saveTimer = null
  const hydrating = new Set()
  const hydrated = new Set()
  const live = new Set()

  function save() {
    if (!file || saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      try { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(state)) } catch {}
    }, 1500)
  }

  function entry(room, agent) {
    state.rooms[room] ||= {}
    return (state.rooms[room][agent] ||= {})
  }

  /** Merge a reading; missing fields keep their previous value. */
  function update(room, agent, patch = {}) {
    if (!room || !CONTEXT_AGENTS.includes(agent)) return
    const e = entry(room, agent)
    if (patch.sessionId && e.sessionId && patch.sessionId !== e.sessionId) {
      // A different native session: the old reading measured another conversation.
      delete e.usedTokens; delete e.windowTokens; delete e.sessionFile; delete e.model; delete e.responseModel
    }
    if (patch.sessionId) e.sessionId = patch.sessionId
    if (patch.sessionFile) e.sessionFile = patch.sessionFile
    if (patch.model) e.model = patch.model
    if (patch.responseModel) e.responseModel = patch.responseModel
    if (positive(patch.windowTokens)) {
      e.windowTokens = positive(patch.windowTokens)
      if (e.model || e.responseModel) state.windows[baseModel(e.model || e.responseModel)] = e.windowTokens
    }
    if (positive(patch.usedTokens)) {
      e.usedTokens = positive(patch.usedTokens)
      e.measuredAt = positive(patch.measuredAt) || Date.now()
    }
    if (patch.compacted) e.compactedAt = Date.now()
    const lookupModel = e.model || e.responseModel
    if (!e.windowTokens && lookupModel) e.windowTokens = state.windows[baseModel(lookupModel)] || claudeWindowHint(lookupModel) || undefined
    e.updatedAt = Date.now()
    save()
  }

  function setLive(room, agent, on) {
    const key = room + '\u0000' + agent
    if (on) live.add(key); else live.delete(key)
  }

  const probes = new Map()
  /** Ask the CLI for a model's window once; Claude only reports it at the end of a run otherwise. */
  function learnWindow(agent, model) {
    const base = baseModel(model)
    if (!probeWindow || !base || state.windows[base]) return
    const last = probes.get(base)
    if (last && Date.now() - last < 10 * 60 * 1000) return
    probes.set(base, Date.now())
    void Promise.resolve(probeWindow(agent, model)).then(w => {
      if (positive(w) && !state.windows[base]) { state.windows[base] = positive(w); save(); onChange?.() }
    }).catch(() => {})
  }

  const imageScans = new Map()
  const scanning = new Set()
  /** Keep Claude's image share current; scans are incremental, so a growing file costs only its new bytes. */
  function refreshImages(file) {
    if (!file || scanning.has(file)) return
    const prev = imageScans.get(file)
    const size = fileBytes(file)
    if (size === null || (prev && prev.offset === size)) return
    if (prev?.at && Date.now() - prev.at < 2000) return
    scanning.add(file)
    void scanClaudeImages(file, prev).then(next => {
      const changed = !prev || next.count !== prev.count || next.ctxCount !== prev.ctxCount || next.bytes !== prev.bytes
      imageScans.set(file, { ...next, at: Date.now() })
      if (changed) onChange?.()
    }).catch(() => {}).finally(() => scanning.delete(file))
  }

  const lookups = new Map()
  /** A new Codex thread or Claude session writes its file a moment after it starts; find it once it exists. */
  function resolveFile(room, agent, e) {
    if (!e.sessionId || agent === 'Antigravity') return
    const key = agent + ':' + e.sessionId
    const last = lookups.get(key)
    if (last && Date.now() - last < 8000) return
    lookups.set(key, Date.now())
    const find = agent === 'Codex' ? findCodexRollout : findClaudeTranscript
    void find(e.sessionId).then(found => {
      if (found && found !== e.sessionFile && state.rooms[room]?.[agent] === e) { e.sessionFile = found; save() }
    }).catch(() => {})
  }

  function snapshot(room) {
    const rows = state.rooms[room] || {}
    const out = {}
    for (const agent of CONTEXT_AGENTS) {
      const e = rows[agent]
      if (!e) continue
      if (fileBytes(e.sessionFile) === null) resolveFile(room, agent, e)
      const lookupModel = e.model || e.responseModel || ''
      const windowTokens = e.windowTokens || (lookupModel && state.windows[baseModel(lookupModel)]) || claudeWindowHint(lookupModel) || null
      if (!windowTokens && agent === 'Claude' && lookupModel) learnWindow(agent, lookupModel)
      if (agent === 'Claude') refreshImages(e.sessionFile)
      const img = agent === 'Claude' && e.sessionFile ? imageScans.get(e.sessionFile) : null
      out[agent] = {
        agent,
        usedTokens: e.usedTokens || null,
        windowTokens,
        percentage: e.usedTokens && windowTokens ? Math.round((e.usedTokens / windowTokens) * 1000) / 10 : null,
        sessionBytes: fileBytes(e.sessionFile),
        sessionFile: e.sessionFile || '',
        // Only the model Claude was asked for; a gateway may answer with another name.
        model: e.model || '',
        images: img ? { count: img.count, bytes: img.bytes, contextCount: img.ctxCount, contextBytes: img.ctxBytes } : null,
        measuredAt: e.measuredAt || null,
        live: live.has(room + '\u0000' + agent)
      }
    }
    return out
  }

  /** Session file sizes of running agents, for change detection while a tool call is silent. */
  function liveSignature() {
    const parts = []
    for (const key of live) {
      const [room, agent] = key.split('\u0000')
      parts.push(key + ':' + fileBytes(state.rooms[room]?.[agent]?.sessionFile))
    }
    return parts.join('|')
  }

  /** Fill readings for bound native sessions that have no cached entry (or a different session). */
  const picks = new Map()
  /**
   * A room can hold several native sessions for one agent (a session per route/provider:
   * `Claude`, `Claude:route:<host>`, `Codex:p:<id>`…). The one the user is actually on is
   * the one whose session file was written most recently.
   */
  async function pickSession(room, agent, own) {
    const sig = own.map(b => b.agent + '=' + b.native).sort().join('|')
    const cached = picks.get(room + ':' + agent)
    if (cached && cached.sig === sig && Date.now() - cached.at < 30000) return cached
    let best = null
    for (const b of own) {
      const sessionFile = await resolveSessionFile(agent, b.native)
      let mtime = 0
      try { if (sessionFile) mtime = (await stat(sessionFile)).mtimeMs } catch {}
      if (!best || mtime > best.mtime) best = { sessionId: b.native, sessionFile, mtime }
    }
    const pick = { sig, at: Date.now(), sessionId: best?.sessionId || '', sessionFile: best?.sessionFile || '' }
    picks.set(room + ':' + agent, pick)
    return pick
  }

  /** Fill readings for the room's current native session when the cache holds none (or another session). */
  async function hydrate(room, bindings = []) {
    let touched = false
    for (const agent of CONTEXT_AGENTS) {
      const own = bindings.filter(b => b.native && (b.agent === agent || String(b.agent).startsWith(agent + ':')))
      if (!own.length || live.has(room + '\u0000' + agent)) continue
      const roomKey = room + ':' + agent
      if (hydrating.has(roomKey)) continue
      hydrating.add(roomKey)
      try {
        const { sessionId, sessionFile } = await pickSession(room, agent, own)
        if (!sessionId) continue
        const e = state.rooms[room]?.[agent]
        const key = roomKey + ':' + sessionId
        if (e?.sessionId === sessionId && (e.usedTokens || hydrated.has(key))) continue
        if (live.has(room + '\u0000' + agent)) continue
        let usage = null
        if (agent === 'Codex') usage = sessionFile ? codexUsageFromRollout(await readTail(sessionFile)) : null
        else if (agent === 'Claude') usage = sessionFile ? claudeUsageFromTranscript(await readTail(sessionFile)) : null
        else if (agent === 'Antigravity') {
          usage = readAntigravityContext ? await readAntigravityContext(sessionId).catch(() => null) : null
          if (usage && sessionFile) { try { usage.measuredAt = (await stat(sessionFile)).mtimeMs } catch {} }
        }
        update(room, agent, { sessionId, sessionFile, ...(usage || {}) })
        hydrated.add(key)
        touched = true
      } catch {} finally {
        hydrating.delete(roomKey)
      }
    }
    return touched
  }

  return { update, setLive, snapshot, liveSignature, hydrate }
}
