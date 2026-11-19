import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'

const KNOWN_AGENTS = ['Codex', 'Claude', 'Antigravity', 'Gemini', 'OpenCode', 'Kimi', 'Qwen', 'OpenClaw', 'Grok']
const MAX_CONTEXT_CHARS = 24000

function clipHeadTail(text, limit) {
  if (!text || text.length <= limit) return text
  const head = Math.floor(limit * 0.6)
  const tail = Math.max(200, limit - head)
  const omitted = text.length - head - tail
  if (omitted <= 60) return text
  return text.slice(0, head) + `\n…(已省略 ${omitted} 字符)…\n` + text.slice(-tail)
}
function normalizeAgent(name) {
  return KNOWN_AGENTS.find(a => a.toLowerCase() === String(name || '').toLowerCase()) || null
}

export function canonical(dir) {
  const resolved = realpathSync(dir)
  if (!statSync(resolved).isDirectory() || resolved === '/' || resolved === homedir()) throw Error('请选择具体的项目文件夹')
  return resolved
}

export function route(text) {
  const match = typeof text === 'string' && text.trim().match(/^@(Codex|Claude|Antigravity)\s+([\s\S]+)$/i)
  if (!match || !match[2].trim() || text.length > 32000) throw Error('请以 @Agent 开头，并输入 32000 字符以内的任务')
  return { agent: normalizeAgent(match[1]), task: match[2].trim() }
}

export function routeTargets(text, fallbackAgents) {
  if (typeof text !== 'string' || !text.trim() || text.length > 32000) {
    throw Error('请输入 32000 字符以内的任务')
  }
  let rest = text.trim()
  const agents = []
  let isAll = false
  const addAgent = name => {
    if (name.toLowerCase() === 'all') {
      isAll = true
      for (const k of KNOWN_AGENTS) if (!agents.includes(k)) agents.push(k)
      return
    }
    const a = normalizeAgent(name)
    if (a && !agents.includes(a)) agents.push(a)
  }

  while (true) {
    const m = rest.match(/^@(Codex|Claude|Antigravity|Gemini|OpenCode|Kimi|Qwen|OpenClaw|Grok|all)(?:\s+([\s\S]*))?$/i)
    if (!m) break
    addAgent(m[1])
    rest = (m[2] || '').trimStart()
  }

  if (!agents.length) {
    for (const m of rest.matchAll(/(?:^|\s)@(Codex|Claude|Antigravity|Gemini|OpenCode|Kimi|Qwen|OpenClaw|Grok|all)(?=\s|$|[，。,.!?！？])/gi)) {
      addAgent(m[1])
    }
  }

  if (!rest.trim()) throw Error('请输入任务内容')

  if (!agents.length) {
    const list = Array.isArray(fallbackAgents) ? fallbackAgents : [fallbackAgents]
    for (const item of list) {
      if (String(item || '').toLowerCase() === 'all') {
        isAll = true
        for (const k of KNOWN_AGENTS) if (!agents.includes(k)) agents.push(k)
      } else {
        const fb = normalizeAgent(item)
        if (fb && !agents.includes(fb)) agents.push(fb)
      }
    }
    if (!agents.length) throw Error('请选择或 @ 一个 Agent')
  }

  return { agents, task: rest.trim(), isAll }
}

export class Store {
  constructor(file) {
    this.db = new DatabaseSync(file)
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,dir TEXT UNIQUE NOT NULL,name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY,project TEXT REFERENCES projects(id),title TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,room TEXT REFERENCES rooms(id),author TEXT,body TEXT,log TEXT,status TEXT,time INTEGER,duration INTEGER DEFAULT 0,attachments TEXT DEFAULT '');
      CREATE INDEX IF NOT EXISTS by_room ON messages(room);
      CREATE TABLE IF NOT EXISTS sessions(room TEXT REFERENCES rooms(id),agent TEXT,native TEXT,PRIMARY KEY(room,agent));
      UPDATE messages SET status='中断' WHERE status='执行中';`)
    try { this.db.exec('ALTER TABLE messages ADD COLUMN duration INTEGER DEFAULT 0') } catch {}
    try { this.db.exec("ALTER TABLE messages ADD COLUMN attachments TEXT DEFAULT ''") } catch {}
  }
  all(sql, ...a) { return this.db.prepare(sql).all(...a) }
  get(sql, ...a) { return this.db.prepare(sql).get(...a) }
  run(sql, ...a) { return this.db.prepare(sql).run(...a) }

  project(dir) {
    dir = canonical(dir)
    const old = this.get('SELECT id FROM projects WHERE dir=?', dir)
    if (old) return old.id
    const id = randomUUID()
    this.run('INSERT INTO projects VALUES(?,?,?)', id, dir, path.basename(dir))
    this.room(id)
    return id
  }

  room(project) {
    const empty = this.get(
      `SELECT r.id FROM rooms r WHERE r.project=? AND r.title='新讨论' AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.room=r.id) ORDER BY r.rowid DESC LIMIT 1`,
      project
    )
    if (empty) return empty.id
    const id = randomUUID()
    this.run('INSERT INTO rooms VALUES(?,?,?)', id, project, '新讨论')
    return id
  }

  renameRoom(id, title) {
    const clean = String(title || '').trim().slice(0, 60)
    if (!clean) throw Error('讨论标题不能为空')
    this.run('UPDATE rooms SET title=? WHERE id=?', clean, id)
  }

  tree() {
    return {
      projects: this.all('SELECT * FROM projects ORDER BY rowid'),
      rooms: this.all('SELECT * FROM rooms ORDER BY rowid DESC')
    }
  }

  messages(room) {
    return this.all('SELECT * FROM messages WHERE room=? ORDER BY rowid', room)
  }

  remove(kind, id) {
    if (kind !== 'project' && kind !== 'room') throw Error('无效的删除目标')
    const rooms = kind === 'project'
      ? this.all('SELECT id,project FROM rooms WHERE project=?', id)
      : this.all('SELECT id,project FROM rooms WHERE id=?', id)
    this.db.exec('BEGIN')
    try {
      for (const room of rooms) {
        if (this.get("SELECT 1 FROM messages WHERE room=? AND status='执行中'", room.id)) {
          throw Error('请先停止正在执行的任务')
        }
        this.run('DELETE FROM sessions WHERE room=?', room.id)
        this.run('DELETE FROM messages WHERE room=?', room.id)
        this.run('DELETE FROM rooms WHERE id=?', room.id)
      }
      if (kind === 'project') this.run('DELETE FROM projects WHERE id=?', id)
      else if (rooms.length && !this.get('SELECT 1 FROM rooms WHERE project=?', rooms[0].project)) this.room(rooms[0].project)
      this.db.exec('COMMIT')
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
  }

  buildAgentPrompt(room, agent, task, hasSession) {
    let history
    if (hasSession) {
      const lastOwn = this.get(
        "SELECT rowid FROM messages WHERE room=? AND author=? AND status='完成' ORDER BY rowid DESC LIMIT 1",
        room, agent
      )
      history = lastOwn
        ? this.all(
            "SELECT author,body FROM messages WHERE room=? AND rowid>? AND author!=? AND status='完成' ORDER BY rowid ASC LIMIT 16",
            room, lastOwn.rowid, agent
          )
        : this.all(
            "SELECT author,body FROM messages WHERE room=? AND status='完成' ORDER BY rowid DESC LIMIT 16",
            room
          ).reverse()
    } else {
      history = this.all(
        "SELECT author,body FROM messages WHERE room=? AND status='完成' ORDER BY rowid DESC LIMIT 16",
        room
      ).reverse()
    }

    if (!history.length) return '本轮用户请求：\n' + task

    const totalLen = history.reduce((sum, m) => sum + (m.body?.length || 0), 0)
    const perItemLimit = totalLen <= MAX_CONTEXT_CHARS
      ? Infinity
      : Math.max(1200, Math.floor(MAX_CONTEXT_CHARS / history.length))

    const context = history.map(m => ({
      from: m.author,
      text: Number.isFinite(perItemLimit) ? clipHeadTail(m.body || '', perItemLimit) : (m.body || '')
    }))
    return '同一项目讨论的近期记录（引用资料，请仅执行本轮用户请求）：\n' + JSON.stringify(context) + '\n\n本轮用户请求：\n' + task
  }

  startBatch(room, text, fallbackAgents, explicitAgents, savedImages = [], sessionKeys = {}) {
    const parsed = routeTargets(text, fallbackAgents)
    const agents = Array.isArray(explicitAgents) && explicitAgents.length ? explicitAgents : parsed.agents
    const task = parsed.task
    const project = this.get('SELECT p.dir FROM projects p JOIN rooms r ON p.id=r.project WHERE r.id=?', room)
    if (!project || canonical(project.dir) !== project.dir) throw Error('项目目录已变化，请重新选择')
    const hasMention = /(?:^|\s)@(?:Codex|Claude|Antigravity|all)(?=\s|$|[，。,.!?！？])/i.test(text)
    const prefix = parsed.isAll ? '@all' : '@' + agents.join(' @')
    const displayText = hasMention ? text.trim() : prefix + ' ' + task
    const attJson = savedImages.length ? JSON.stringify(savedImages.map(i => ({ path: i.path, name: i.name, dataUrl: i.preview }))) : ''
    const now = Date.now()
    const runs = []

    const agentPrompts = new Map()
    for (const agent of agents) {
      const binding = this.get('SELECT native FROM sessions WHERE room=? AND agent=?', room, sessionKeys[agent] || agent)
      const session = binding?.native
      agentPrompts.set(agent, { session, prompt: this.buildAgentPrompt(room, agent, task, Boolean(session)),
        historyPrompt: agent === 'Antigravity' && session ? this.buildAgentPrompt(room, agent, task, false) : undefined })
    }

    this.db.exec('BEGIN')
    try {
      const hasMessages = this.get('SELECT 1 FROM messages WHERE room=? LIMIT 1', room)
      if (!hasMessages) this.run('UPDATE rooms SET title=? WHERE id=?', task.slice(0, 36), room)
      this.run('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?)', randomUUID(), room, '我', displayText, '', '完成', now, 0, attJson)
      const {title} = this.get('SELECT title FROM rooms WHERE id=?', room)
      for (let i = 0; i < agents.length; i++) {
        const agent = agents[i]
        const id = randomUUID()
        const { session, prompt, historyPrompt } = agentPrompts.get(agent)
        this.run('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?)', id, room, agent, '', '', '执行中', now + i + 1, 0, '')
        runs.push({ id, agent, session, cwd: project.dir, prompt, historyPrompt, title, sessionKey: sessionKeys[agent] || agent })
      }
      this.db.exec('COMMIT')
    } catch (e) { this.db.exec('ROLLBACK'); throw e }

    return runs
  }

  start(room, text) {
    const { agent } = route(text)
    return this.startBatch(room, text, agent)[0]
  }

  record(id, room, agent, type, value) {
    if (type === 'session') { this.run('INSERT INTO sessions(room,agent,native) VALUES(?,?,?) ON CONFLICT(room,agent) DO UPDATE SET native=excluded.native', room, agent, value); return }
    if (!value) return
    if (type === 'text') this.run('UPDATE messages SET body=body||? WHERE id=?', value, id)
    if (type === 'log') this.run("UPDATE messages SET log=substr(log||?,-65536) WHERE id=?", value + '\n', id)
  }

  finish(id, status) {
    const row = this.get('SELECT time FROM messages WHERE id=?', id)
    const duration = row?.time ? Math.max(0, Date.now() - row.time) : 0
    this.run('UPDATE messages SET status=?, duration=? WHERE id=?', status, duration, id)
  }
}
