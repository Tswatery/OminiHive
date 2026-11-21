import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { listDesktopSessions, readDesktopHistory, readDesktopTitle } from './antigravity-desktop.mjs'
import { PROMPT_TASK_MARKER, PROMPT_TASK_OPEN, PROMPT_TASK_CLOSE, summarizeTitle } from './store.mjs'
import { looksLikeSmartTitle } from './auto-title.mjs'

function normalizeText(raw) {
  let s = String(raw || '').trim()
  // Strip structured <user_task>...</user_task> wrapper
  const openIdx = s.lastIndexOf(PROMPT_TASK_OPEN)
  if (openIdx !== -1) {
    let inner = s.slice(openIdx + PROMPT_TASK_OPEN.length)
    const closeIdx = inner.indexOf(PROMPT_TASK_CLOSE)
    if (closeIdx !== -1) inner = inner.slice(0, closeIdx)
    s = inner.trim()
  }
  // Strip legacy OminiHive group-chat context wrappers
  const taskMarker = s.lastIndexOf('\n当前任务：')
  if (taskMarker !== -1) s = s.slice(taskMarker + '\n当前任务：'.length).trim()
  const taskMarker2 = s.lastIndexOf('\n请接着处理用户的最新要求：')
  if (taskMarker2 !== -1) s = s.slice(taskMarker2 + '\n请接着处理用户的最新要求：'.length).trim()
  // Legacy wrapper: "...\n\n本轮用户请求：\n<task>"
  if (s.startsWith(PROMPT_TASK_MARKER)) s = s.slice(PROMPT_TASK_MARKER.length).trim()
  const taskMarker3 = s.lastIndexOf('\n' + PROMPT_TASK_MARKER)
  if (taskMarker3 !== -1) s = s.slice(taskMarker3 + 1 + PROMPT_TASK_MARKER.length).trim()
  // Strip attachment path notes appended by OminiHive
  s = s.replace(/\n\n\[(?:用户附带了以下(?:图片)?文件|附带(?:图片|文件)路径)[\s\S]*?\]\s*$/g, '')
  // Strip leading @mentions
  s = s.replace(/^(?:@[a-z0-9_-]+\s+)+/i, '')
  return s.replace(/\s+/g, ' ').trim()
}

function fingerprint(role, text) {
  const norm = normalizeText(text)
  if (!norm) return ''
  // Use prefix + suffix + length to avoid false collisions on long replies
  const head = norm.slice(0, 120)
  const tail = norm.length > 160 ? norm.slice(-40) : ''
  return `${role}:${norm.length}:${head}|${tail}`
}

// Parsed transcripts keyed by path and invalidated by mtime/size: background sync runs often,
// and re-reading + JSON-parsing a multi-MB rollout every time stalls the main process.
const parsedCache = new Map()
function cachedParse(filePath, parse) {
  let st
  try { st = statSync(filePath) } catch { return [] }
  const hit = parsedCache.get(filePath)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.turns
  const turns = parse(filePath)
  parsedCache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, turns })
  if (parsedCache.size > 64) parsedCache.delete(parsedCache.keys().next().value)
  return turns
}

const rolloutPathCache = new Map()
function findCodexRollout(threadId) {
  if (!threadId) return null
  const cachedPath = rolloutPathCache.get(threadId)
  if (cachedPath && existsSync(cachedPath)) return cachedPath
  const found = findCodexRolloutUncached(threadId)
  if (found) rolloutPathCache.set(threadId, found)
  return found
}

function findCodexRolloutUncached(threadId) {
  const codexHome = process.env.CODEX_HOME || path.join(homedir(), '.codex')
  const dbPath = path.join(codexHome, 'state_5.sqlite')
  if (existsSync(dbPath)) {
    let db
    try {
      db = new DatabaseSync(dbPath, { readOnly: true })
      const row = db.prepare('SELECT rollout_path FROM threads WHERE id=?').get(threadId)
      if (row?.rollout_path && existsSync(row.rollout_path)) return row.rollout_path
    } catch {} finally {
      try { db?.close() } catch {}
    }
  }
  // Fallback: scan ~/.codex/sessions/YYYY/MM/DD/*<threadId>*.jsonl
  const sessionsDir = path.join(codexHome, 'sessions')
  if (!existsSync(sessionsDir)) return null
  const stack = [sessionsDir]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const ent of entries) {
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) stack.push(full)
      else if (ent.isFile() && ent.name.includes(threadId) && ent.name.endsWith('.jsonl')) return full
    }
  }
  return null
}

function mergeConsecutiveAssistantTurns(turns) {
  const merged = []
  for (const t of turns) {
    const prev = merged[merged.length - 1]
    if (prev && prev.role === 'assistant' && t.role === 'assistant') {
      if (!prev.text.includes(t.text)) {
        prev.text = prev.text + '\n\n' + t.text
      }
      if (t.time && (!prev.time || t.time > prev.time)) prev.time = t.time
    } else {
      merged.push({ ...t })
    }
  }
  return merged
}

function parseCodexRollout(filePath) {
  let raw = ''
  try { raw = readFileSync(filePath, 'utf8') } catch { return [] }
  const eventTurns = []
  const itemTurns = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let rec
    try { rec = JSON.parse(line) } catch { continue }
    const ts = rec.timestamp ? Date.parse(rec.timestamp) || Date.now() : Date.now()
    if (rec.type === 'event_msg' && rec.payload) {
      const p = rec.payload
      if (p.type === 'user_message' && typeof p.message === 'string' && p.message.trim()) {
        eventTurns.push({ role: 'user', text: p.message.trim(), time: ts })
      } else if (p.type === 'agent_message' && typeof p.message === 'string' && p.message.trim()) {
        eventTurns.push({ role: 'assistant', text: p.message.trim(), time: ts })
      }
    } else if (rec.type === 'response_item' && rec.payload?.type === 'message') {
      const role = rec.payload.role
      if (role !== 'user' && role !== 'assistant') continue
      const content = Array.isArray(rec.payload.content) ? rec.payload.content : []
      const text = content
        .filter(c => c && (c.type === 'input_text' || c.type === 'output_text' || c.type === 'text') && typeof c.text === 'string')
        .map(c => c.text)
        .join('\n')
        .trim()
      if (!text) continue
      // Skip Codex injected system/environment instructions
      if (role === 'user' && (/^<environment_context>/i.test(text) || /^<permissions/i.test(text) || /^#\s*AGENTS\.md/i.test(text))) continue
      itemTurns.push({ role, text, time: ts })
    }
  }
  return mergeConsecutiveAssistantTurns(eventTurns.length ? eventTurns : itemTurns)
}

export function findClaudeTranscript(sessionId, cwd) {
  if (!sessionId) return null
  const projectsDir = path.join(homedir(), '.claude', 'projects')
  if (!existsSync(projectsDir)) return null
  if (cwd) {
    const encoded = cwd.replace(/[^a-zA-Z0-9-]/g, '-')
    const direct = path.join(projectsDir, encoded, `${sessionId}.jsonl`)
    if (existsSync(direct)) return direct
  }
  let dirs
  try { dirs = readdirSync(projectsDir, { withFileTypes: true }) } catch { return null }
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const candidate = path.join(projectsDir, d.name, `${sessionId}.jsonl`)
    if (existsSync(candidate)) return candidate
  }
  return null
}

function parseClaudeTranscript(filePath) {
  let raw = ''
  try { raw = readFileSync(filePath, 'utf8') } catch { return [] }
  const turns = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let rec
    try { rec = JSON.parse(line) } catch { continue }
    const ts = rec.timestamp ? Date.parse(rec.timestamp) || Date.now() : Date.now()
    if (rec.type === 'user' && !rec.isMeta) {
      const msg = rec.message?.content
      let text = ''
      if (typeof msg === 'string') text = msg.trim()
      else if (Array.isArray(msg)) {
        const hasOnlyToolResult = msg.every(b => b?.type === 'tool_result')
        if (hasOnlyToolResult) continue
        text = msg.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n').trim()
      }
      if (text) turns.push({ role: 'user', text, time: ts })
    } else if (rec.type === 'assistant') {
      if (rec.isApiErrorMessage) continue
      const content = Array.isArray(rec.message?.content) ? rec.message.content : []
      const text = content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n').trim()
      if (text && !/^API Error:/i.test(text)) turns.push({ role: 'assistant', text, time: ts })
    }
  }
  return mergeConsecutiveAssistantTurns(turns)
}

function readCodexTitle(threadId) {
  if (!threadId) return ''
  const codexHome = process.env.CODEX_HOME || path.join(homedir(), '.codex')
  const dbPath = path.join(codexHome, 'state_5.sqlite')
  if (!existsSync(dbPath)) return ''
  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    const row = db.prepare('SELECT name, title FROM threads WHERE id=?').get(threadId)
    // Only an explicit thread name counts; `title` is just the first-message preview.
    return typeof row?.name === 'string' ? row.name.trim() : ''
  } catch {
    return ''
  } finally {
    try { db?.close() } catch {}
  }
}

function readClaudeTitle(sessionId, cwd) {
  const filePath = findClaudeTranscript(sessionId, cwd)
  if (!filePath) return ''
  let raw = ''
  try { raw = readFileSync(filePath, 'utf8') } catch { return '' }
  // Latest of each kind wins; a user-set custom title beats the AI title, which beats a summary.
  let custom = '', ai = '', summary = ''
  for (const line of raw.split('\n')) {
    if (!line.includes('-title"') && !line.includes('"summary"')) continue
    let rec
    try { rec = JSON.parse(line) } catch { continue }
    const pick = v => typeof v === 'string' ? v.trim() : ''
    if (rec.type === 'custom-title' && pick(rec.customTitle)) custom = pick(rec.customTitle)
    else if (rec.type === 'ai-title' && pick(rec.aiTitle)) ai = pick(rec.aiTitle)
    else if (rec.type === 'summary' && pick(rec.summary)) summary = pick(rec.summary)
  }
  return custom || ai || summary
}

function safeRealpath(p) {
  if (!p) return ''
  try { return realpathSync(p) } catch { return p }
}

function listCodexSessions(projectDir = '') {
  const codexHome = process.env.CODEX_HOME || path.join(homedir(), '.codex')
  const dbPath = path.join(codexHome, 'state_5.sqlite')
  if (!existsSync(dbPath)) return []
  const normTarget = safeRealpath(projectDir)
  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    const rows = db.prepare(
      `SELECT id, name, title, first_user_message, cwd, updated_at, updated_at_ms, rollout_path
       FROM threads
       WHERE COALESCE(archived, 0) = 0
       ORDER BY COALESCE(updated_at_ms, updated_at * 1000, 0) DESC
       LIMIT 80`
    ).all()
    const out = []
    for (const r of rows) {
      if (!r?.id) continue
      const normCwd = safeRealpath(r.cwd || '')
      const rawTitle = (r.name && r.name.trim()) || normalizeText(r.first_user_message || r.title || '')
      const cleanTitle = (r.name && r.name.trim()) ? r.name.trim() : summarizeTitle(rawTitle || 'Codex 会话')
      const updatedAt = Number(r.updated_at_ms) || (Number(r.updated_at) ? Number(r.updated_at) * 1000 : 0)
      out.push({
        agent: 'Codex',
        nativeId: r.id,
        title: cleanTitle.slice(0, 60),
        cwd: normCwd || r.cwd || '',
        updatedAt,
        sameProject: Boolean(normTarget && normCwd && normTarget === normCwd)
      })
    }
    return out
  } catch {
    return []
  } finally {
    try { db?.close() } catch {}
  }
}

function listClaudeSessions(projectDir = '') {
  const projectsDir = path.join(homedir(), '.claude', 'projects')
  if (!existsSync(projectsDir) || !projectDir) return []
  const encoded = projectDir.replace(/[^a-zA-Z0-9-]/g, '-')
  const dir = path.join(projectsDir, encoded)
  if (!existsSync(dir)) return []
  try {
    const files = readdirSync(dir)
      .filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'))
      .map(f => {
        const full = path.join(dir, f)
        try { return { id: f.slice(0, -6), full, mtime: statSync(full).mtimeMs } } catch { return null }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 25)
    const out = []
    for (const item of files) {
      const turns = parseClaudeTranscript(item.full)
      if (!turns.length) continue
      const firstUser = turns.find(t => t.role === 'user')?.text || turns[0].text
      out.push({
        agent: 'Claude',
        nativeId: item.id,
        title: summarizeTitle(normalizeText(firstUser) || 'Claude 会话'),
        cwd: projectDir,
        updatedAt: item.mtime,
        sameProject: true
      })
    }
    return out
  } catch {
    return []
  }
}

export async function listExternalSessions(projectDir = '') {
  const [agList, codexList, claudeList] = await Promise.all([
    listDesktopSessions(projectDir).catch(() => []),
    Promise.resolve(listCodexSessions(projectDir)),
    Promise.resolve(listClaudeSessions(projectDir))
  ])
  const all = [...codexList, ...agList, ...claudeList]
  return all.sort((a, b) => (Number(b.sameProject) - Number(a.sameProject)) || (b.updatedAt - a.updatedAt))
}

export async function loadExternalSessionTurns(agent, nativeId, cwd = '') {
  let turns = []
  if (agent === 'Codex') {
    const rollout = findCodexRollout(nativeId)
    if (rollout) turns = parseCodexRollout(rollout)
  } else if (agent === 'Antigravity') {
    turns = (await readDesktopHistory(nativeId).catch(() => null)) || []
  } else if (agent === 'Claude') {
    const transcript = findClaudeTranscript(nativeId, cwd)
    if (transcript) turns = parseClaudeTranscript(transcript)
  }
  return turns
    .map(t => ({
      role: t.role,
      text: t.role === 'user' ? normalizeText(t.text) : String(t.text || '').trim(),
      time: t.time || Date.now()
    }))
    .filter(t => t.text.length > 0)
}

export async function syncRoomExternal(store, roomId, busyAgents = new Set()) {
  if (!roomId) return 0
  const sessions = store.listSessions(roomId)
  if (!sessions.length) return 0

  const projectRow = store.get('SELECT p.dir FROM projects p JOIN rooms r ON p.id=r.project WHERE r.id=?', roomId)
  const cwd = projectRow?.dir || ''

  const existing = store.messages(roomId)
  const firstUserBody = existing.find(m => m.author === '我')?.body || ''
  const knownFingerprints = new Set()
  const knownNormTexts = new Set()
  const knownAssistantBodies = []
  for (const m of existing) {
    const role = m.author === '我' ? 'user' : 'assistant'
    const fp = fingerprint(role, m.body)
    if (fp) knownFingerprints.add(fp)
    const norm = normalizeText(m.body)
    if (norm) {
      knownNormTexts.add(role + ':' + norm.slice(0, 80))
      if (role === 'assistant') knownAssistantBodies.push(norm)
    }
  }
  const isKnownTurn = (role, text) => {
    const norm = normalizeText(text)
    if (!norm) return true
    const fp = fingerprint(role, norm)
    const shortKey = role + ':' + norm.slice(0, 80)
    if ((fp && knownFingerprints.has(fp)) || knownNormTexts.has(shortKey)) return true
    if (role === 'assistant' && norm.length >= 20) {
      for (const body of knownAssistantBodies) {
        if (body.includes(norm) || (body.length >= 40 && norm.includes(body))) return true
      }
    }
    return false
  }

  let addedCount = 0
  let titleUpdated = false
  for (const row of sessions) {
    const agent = String(row.agent || '').split(':')[0]
    const nativeId = row.native
    if (!agent || !nativeId || busyAgents.has(agent)) continue

    // Auto-sync concise title generated by native Antigravity/Codex/Claude clients when room title is not user-locked
    if (!titleUpdated) {
      let extTitle = ''
      if (agent === 'Antigravity') extTitle = await readDesktopTitle(nativeId).catch(() => '')
      else if (agent === 'Codex') extTitle = readCodexTitle(nativeId)
      else if (agent === 'Claude') extTitle = readClaudeTitle(nativeId, cwd)
      // Titles that merely echo the first message (older OminiHive builds wrote those) aren't smart titles.
      if (extTitle && extTitle.length <= 52 && looksLikeSmartTitle(extTitle, firstUserBody)) {
        if (store.autoTitleRoom(roomId, extTitle)) {
          titleUpdated = true
          addedCount++
        }
      }
    }

    let turns = null
    if (agent === 'Codex') {
      const rollout = findCodexRollout(nativeId)
      if (rollout) turns = cachedParse(rollout, parseCodexRollout)
    } else if (agent === 'Claude') {
      const transcript = findClaudeTranscript(nativeId, cwd)
      if (transcript) turns = cachedParse(transcript, parseClaudeTranscript)
    } else if (agent === 'Antigravity') {
      turns = await readDesktopHistory(nativeId).catch(() => null)
    }
    if (!turns || !turns.length) continue

    // Find the last turn already present in OminiHive so we only append truly newer external turns
    // (or if none matched yet, check each turn against knownFingerprints)
    let startIdx = 0
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i]
      if (isKnownTurn(t.role, t.text)) {
        startIdx = i + 1
        break
      }
    }

    for (let i = startIdx; i < turns.length; i++) {
      const t = turns[i]
      const cleanText = normalizeText(t.text)
      if (!cleanText || isKnownTurn(t.role, cleanText)) continue
      const fp = fingerprint(t.role, cleanText)
      const shortKey = t.role + ':' + cleanText.slice(0, 80)

      const author = t.role === 'user' ? '我' : agent
      const body = t.role === 'user' ? `@${agent} ${cleanText}` : t.text.trim()
      store.insertSyncedMessage(roomId, author, body, `同步自 ${agent} 客户端`, t.time || Date.now())
      if (fp) knownFingerprints.add(fp)
      knownNormTexts.add(shortKey)
      if (t.role === 'assistant') knownAssistantBodies.push(cleanText)
      addedCount++
    }
  }
  return addedCount
}
