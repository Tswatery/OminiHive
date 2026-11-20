import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { syncRoomArchive, removeRoomArchive, roomArchiveRelDir } from './context-archive.mjs'

const KNOWN_AGENTS = ['Codex', 'Claude', 'Antigravity', 'Gemini', 'OpenCode', 'Kimi', 'Qwen', 'OpenClaw', 'Grok', 'Hermes', 'Pi', 'MiniMax', 'DeepSeek', 'OhMyPi', 'WorkBuddy']
const AGENT_PATTERN = KNOWN_AGENTS.join('|')
const LEADING_MENTION_RE = new RegExp(`^@(${AGENT_PATTERN}|all)(?:\\s+([\\s\\S]*))?$`, 'i')
const ANY_MENTION_RE = new RegExp(`(?:^|\\s)@(${AGENT_PATTERN}|all)(?=\\s|$|[，。,.!?！？])`, 'gi')
export const PROMPT_CONTEXT_HEADER = '以下是同一项目群聊中各成员的最新回复上下文及只读历史归档索引（仅供参考，请仅执行 <user_task> 中的本轮要求）：'
export const PROMPT_CONTEXT_OPEN = '<group_context>'
export const PROMPT_CONTEXT_CLOSE = '</group_context>'
export const PROMPT_TASK_OPEN = '<user_task>'
export const PROMPT_TASK_CLOSE = '</user_task>'
export const PROMPT_TASK_MARKER = '本轮用户请求：'

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
    const m = rest.match(LEADING_MENTION_RE)
    if (!m) break
    addAgent(m[1])
    rest = (m[2] || '').trimStart()
  }

  if (!agents.length) {
    for (const m of rest.matchAll(ANY_MENTION_RE)) {
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

export function summarizeTitle(raw = '') {
  let s = String(raw || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
  s = s.replace(/^(?:@[a-z0-9_-]+\s+)+/i, '').trim()
  const leadRe = /^(?:请帮我|帮我|帮忙|麻烦|请你|请|这个任务是要求我们|这个任务要求我们|现在需要你|你帮我|看一下|看看|审核一下|检查一下|分析一下)\s*/i
  while (leadRe.test(s)) {
    const next = s.replace(leadRe, '').trim()
    if (next === s || next.length < 4) break
    s = next
  }
  s = s.replace(/^[，。,:：；;、\-\s]+/, '').trim()
  const firstClause = s.split(/[。！？!?\n]/)[0]?.trim() || s
  const chosen = firstClause.length >= 6 ? firstClause : s
  return (chosen || '新讨论').slice(0, 28)
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
      CREATE TABLE IF NOT EXISTS session_seen(room TEXT NOT NULL,agent TEXT NOT NULL,native TEXT NOT NULL,msg_id TEXT NOT NULL,PRIMARY KEY(room,agent,native,msg_id));
      UPDATE messages SET status='中断' WHERE status='执行中';`)
    try { this.db.exec('ALTER TABLE messages ADD COLUMN duration INTEGER DEFAULT 0') } catch {}
    try { this.db.exec("ALTER TABLE messages ADD COLUMN attachments TEXT DEFAULT ''") } catch {}
    try { this.db.exec('ALTER TABLE sessions ADD COLUMN last_seen_rowid INTEGER DEFAULT 0') } catch {}
    try { this.db.exec('ALTER TABLE rooms ADD COLUMN title_locked INTEGER DEFAULT 0') } catch {}
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
    this.run('INSERT INTO rooms(id,project,title,title_locked) VALUES(?,?,?,0)', id, project, '新讨论')
    return id
  }

  renameProject(id, name) {
    const clean = String(name || '').trim().slice(0, 60)
    if (!clean) throw Error('项目名称不能为空')
    this.run('UPDATE projects SET name=? WHERE id=?', clean, id)
  }

  renameRoom(id, title) {
    const clean = String(title || '').trim().slice(0, 60)
    if (!clean) throw Error('讨论标题不能为空')
    this.run('UPDATE rooms SET title=?, title_locked=1 WHERE id=?', clean, id)
  }

  autoTitleRoom(id, title) {
    const clean = String(title || '').trim().slice(0, 60)
    if (!clean) return false
    const row = this.get('SELECT title, title_locked FROM rooms WHERE id=?', id)
    if (!row || row.title_locked) return false
    if (row.title === clean) return false
    this.run('UPDATE rooms SET title=? WHERE id=?', clean, id)
    return true
  }

  importRoom(projectId, { agent, nativeId, title, turns = [] }) {
    const proj = this.get('SELECT id, dir FROM projects WHERE id=?', projectId)
    if (!proj) throw Error('未找到对应项目')
    const roomId = randomUUID()
    const cleanTitle = String(title || '').trim().slice(0, 60) || `导入自 ${agent}`
    const now = Date.now()
    this.db.exec('BEGIN')
    try {
      this.run('INSERT INTO rooms(id,project,title,title_locked) VALUES(?,?,?,0)', roomId, projectId, cleanTitle)
      const insertedIds = []
      for (let i = 0; i < turns.length; i++) {
        const t = turns[i]
        const text = String(t?.text || '').trim()
        if (!text) continue
        const msgId = randomUUID()
        const author = t.role === 'user' ? '我' : agent
        const body = t.role === 'user' ? `@${agent} ${text}` : text
        const log = t.role === 'user' ? '' : `导入自 ${agent} 客户端\n`
        const ts = Number(t.time) || (now + i)
        this.run(
          'INSERT INTO messages(id,room,author,body,log,status,time,duration,attachments) VALUES(?,?,?,?,?,?,?,?,?)',
          msgId, roomId, author, body, log, '完成', ts, 0, ''
        )
        insertedIds.push(msgId)
      }
      if (nativeId) {
        this.run(
          `INSERT INTO sessions(room,agent,native,last_seen_rowid) VALUES(?,?,?,0)
           ON CONFLICT(room,agent) DO UPDATE SET native=excluded.native`,
          roomId, agent, nativeId
        )
        const stmt = this.db.prepare('INSERT OR IGNORE INTO session_seen(room,agent,native,msg_id) VALUES(?,?,?,?)')
        for (const mid of insertedIds) stmt.run(roomId, agent, nativeId, mid)
      }
      this.db.exec('COMMIT')
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
    this.syncArchive(roomId)
    return roomId
  }

  tree() {
    return {
      projects: this.all('SELECT * FROM projects ORDER BY rowid'),
      rooms: this.all('SELECT * FROM rooms ORDER BY rowid DESC'),
      sessions: this.all('SELECT room, agent FROM sessions')
    }
  }

  messages(room) {
    return this.all('SELECT * FROM messages WHERE room=? ORDER BY rowid', room)
  }

  syncArchive(room) {
    const project = this.get('SELECT p.dir FROM projects p JOIN rooms r ON p.id=r.project WHERE r.id=?', room)
    if (!project) return new Map()
    const allMsgs = this.messages(room)
    return syncRoomArchive(project.dir, room, allMsgs)
  }

  remove(kind, id) {
    if (kind !== 'project' && kind !== 'room') throw Error('无效的删除目标')
    const rooms = kind === 'project'
      ? this.all('SELECT r.id, r.project, p.dir FROM rooms r JOIN projects p ON p.id=r.project WHERE r.project=?', id)
      : this.all('SELECT r.id, r.project, p.dir FROM rooms r JOIN projects p ON p.id=r.project WHERE r.id=?', id)
    this.db.exec('BEGIN')
    try {
      for (const room of rooms) {
        if (this.get("SELECT 1 FROM messages WHERE room=? AND status='执行中'", room.id)) {
          throw Error('请先停止正在执行的任务')
        }
        this.run('DELETE FROM session_seen WHERE room=?', room.id)
        this.run('DELETE FROM sessions WHERE room=?', room.id)
        this.run('DELETE FROM messages WHERE room=?', room.id)
        this.run('DELETE FROM rooms WHERE id=?', room.id)
      }
      if (kind === 'project') this.run('DELETE FROM projects WHERE id=?', id)
      else if (rooms.length && !this.get('SELECT 1 FROM rooms WHERE project=?', rooms[0].project)) this.room(rooms[0].project)
      this.db.exec('COMMIT')
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
    for (const room of rooms) {
      removeRoomArchive(room.dir, room.id)
    }
  }

  buildAgentPrompt(room, agent, task, session = '', sessionKey = agent, archiveMap = null) {
    const seenIds = session
      ? new Set(
          this.all(
            'SELECT msg_id FROM session_seen WHERE room=? AND agent=? AND native=?',
            room, sessionKey, session
          ).map(r => r.msg_id)
        )
      : new Set()

    // Fetch all valid non-running, non-empty messages from other authors in chronological order
    const rows = this.all(
      "SELECT rowid,id,author,body FROM messages WHERE room=? AND author!=? AND status!='执行中' AND length(trim(body))>0 ORDER BY rowid ASC",
      room, agent
    )

    const unseen = rows.filter(m => !seenIds.has(m.id))
    if (!unseen.length) {
      return {
        prompt: `${PROMPT_TASK_OPEN}\n${task}\n${PROMPT_TASK_CLOSE}`,
        sentMsgIds: [],
        contextMeta: { count: 0, authors: [], omitted: 0, archivedTotal: archiveMap?.size || 0, mode: session ? 'smart' : 'cold', detail: '' }
      }
    }

    const lastByAgent = new Map()
    for (const m of unseen) {
      if (m.author !== '我') lastByAgent.set(m.author, m)
    }
    const inlined = lastByAgent.size > 0
      ? unseen.filter(m => lastByAgent.get(m.author)?.id === m.id)
      : [unseen[unseen.length - 1]]
    const inlinedIds = new Set(inlined.map(m => m.id))
    const earlierUnseen = unseen.filter(m => !inlinedIds.has(m.id))
    const relDir = roomArchiveRelDir(room)
    const totalArchived = archiveMap?.size || 0

    const blocks = []
    for (const m of inlined) {
      const body = String(m.body || '').trim()
      const meta = archiveMap?.get(m.id)
      let block = `[${m.author}]:\n${body}`
      if (meta?.traceRelPath) {
        block += `\n\n（该回复的完整工具/命令执行轨迹：${meta.traceRelPath}）`
      }
      blocks.push(block)
    }

    if (totalArchived > 0) {
      const archiveLines = [
        `[只读历史归档（禁止修改）] 完整目录：${relDir}/index.md（共 ${totalArchived} 条记录）`,
        '如需查阅更早对话、其他成员完整回复或工具执行轨迹，请直接读取 index.md 或对应文件。'
      ]
      if (earlierUnseen.length > 0) {
        const listed = earlierUnseen.slice(-8)
        if (earlierUnseen.length > listed.length) {
          archiveLines.push(`- （另有更早 ${earlierUnseen.length - listed.length} 条未读记录见 index.md）`)
        }
        for (const m of listed) {
          const meta = archiveMap?.get(m.id)
          if (meta) {
            const traceSuffix = meta.traceRelPath ? ` | 轨迹: ${meta.traceRelPath}` : ''
            archiveLines.push(`- [未读] ${m.author} (${meta.bodyLen}字): ${meta.relPath}${traceSuffix}`)
          }
        }
      }
      blocks.push(archiveLines.join('\n'))
    }

    const prompt = `${PROMPT_CONTEXT_HEADER}\n${PROMPT_CONTEXT_OPEN}\n${blocks.join('\n\n---\n\n')}\n${PROMPT_CONTEXT_CLOSE}\n\n${PROMPT_TASK_OPEN}\n${task}\n${PROMPT_TASK_CLOSE}`
    const authors = [...new Set(unseen.map(m => m.author))]
    const inlinedAuthors = inlined.map(m => m.author)
    const detailLines = []
    for (const m of inlined) {
      const body = String(m.body || '').trim()
      const meta = archiveMap?.get(m.id)
      detailLines.push(`内联最新：[${m.author}] (${body.length} 字)：${body.replace(/\s+/g, ' ').slice(0, 120)}${body.length > 120 ? '…' : ''}`)
      if (meta?.traceRelPath) detailLines.push(`轨迹文件：[${m.author}] ${meta.traceRelPath}`)
    }
    if (earlierUnseen.length > 0) {
      detailLines.push(`其余 ${earlierUnseen.length} 条未读已提供只读文件路径索引`)
    }
    if (totalArchived > 0) {
      detailLines.push(`归档目录：${relDir}/index.md（共 ${totalArchived} 条，只读）`)
    }

    return {
      prompt,
      sentMsgIds: unseen.map(m => m.id),
      contextMeta: {
        count: inlined.length,
        unreadTotal: unseen.length,
        authors,
        inlinedAuthors,
        inlinedAuthor: inlinedAuthors.filter(a => a !== '我').join('、') || inlinedAuthors[0] || '',
        omitted: earlierUnseen.length,
        archivedTotal: totalArchived,
        mode: session ? 'smart' : 'cold',
        detail: detailLines.join('\n')
      }
    }
  }

  startBatch(room, text, fallbackAgents, explicitAgents, savedImages = [], sessionKeys = {}, freshAgents = null) {
    const parsed = routeTargets(text, fallbackAgents)
    const agents = Array.isArray(explicitAgents) && explicitAgents.length ? explicitAgents : parsed.agents
    const task = parsed.task
    const project = this.get('SELECT p.dir FROM projects p JOIN rooms r ON p.id=r.project WHERE r.id=?', room)
    if (!project || canonical(project.dir) !== project.dir) throw Error('项目目录已变化，请重新选择')
    const hasMention = new RegExp(`(?:^|\\s)@(?:${AGENT_PATTERN}|all)(?=\\s|$|[，。,.!?！？])`, 'i').test(text)
    const prefix = parsed.isAll ? '@all' : '@' + agents.join(' @')
    const displayText = hasMention ? text.trim() : prefix + ' ' + task
    const attJson = savedImages.length ? JSON.stringify(savedImages.map(i => ({ path: i.path, name: i.name, dataUrl: i.preview || '', mimeType: i.mimeType || '', isImage: i.isImage !== false }))) : ''
    const now = Date.now()
    const runs = []

    const archiveMap = syncRoomArchive(project.dir, room, this.messages(room))
    const freshSet = freshAgents instanceof Set ? freshAgents : new Set(Array.isArray(freshAgents) ? freshAgents : [])

    const agentPrompts = new Map()
    for (const agent of agents) {
      const sKey = sessionKeys[agent] || agent
      const isFresh = freshSet.has(agent)
      const binding = isFresh ? null : this.get('SELECT native FROM sessions WHERE room=? AND agent=?', room, sKey)
      const session = binding?.native || ''
      const built = this.buildAgentPrompt(room, agent, task, session, sKey, archiveMap)
      const historyBuilt = agent === 'Antigravity' && session ? this.buildAgentPrompt(room, agent, task, '', sKey, archiveMap) : undefined
      agentPrompts.set(agent, {
        session: session || undefined,
        prompt: built.prompt,
        sentMsgIds: built.sentMsgIds,
        contextMeta: built.contextMeta,
        historyPrompt: historyBuilt?.prompt
      })
    }

    this.db.exec('BEGIN')
    try {
      const hasMessages = this.get('SELECT 1 FROM messages WHERE room=? LIMIT 1', room)
      if (!hasMessages) this.run('UPDATE rooms SET title=? WHERE id=? AND COALESCE(title_locked,0)=0', summarizeTitle(task), room)
      const userMsgId = randomUUID()
      const userInsert = this.run('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?)', userMsgId, room, '我', displayText, '', '完成', now, 0, attJson)
      const seenRowid = Number(userInsert.lastInsertRowid) || 0
      const {title} = this.get('SELECT title FROM rooms WHERE id=?', room)
      for (let i = 0; i < agents.length; i++) {
        const agent = agents[i]
        const id = randomUUID()
        const { session, prompt, historyPrompt, contextMeta, sentMsgIds } = agentPrompts.get(agent)
        let initLog = ''
        if (contextMeta.count > 0) {
          const who = contextMeta.inlinedAuthor && contextMeta.inlinedAuthor !== '我' ? `（${contextMeta.inlinedAuthor}）` : ''
          const archiveNote = contextMeta.archivedTotal > 1 ? ` · 归档 ${contextMeta.archivedTotal} 条` : ''
          initLog = '::step::' + JSON.stringify({
            id: 'meta-context',
            kind: 'info',
            title: `上下文 · 带入最新 ${contextMeta.count} 条${who}${archiveNote}`,
            status: 'done',
            detail: contextMeta.detail
          }) + '\n'
        }
        this.run('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?)', id, room, agent, '', initLog, '执行中', now + i + 1, 0, '')
        runs.push({
          id,
          agent,
          session,
          cwd: project.dir,
          prompt,
          historyPrompt,
          title,
          sessionKey: sessionKeys[agent] || agent,
          seenRowid,
          deliveredIds: [...sentMsgIds, userMsgId]
        })
      }
      this.db.exec('COMMIT')
    } catch (e) { this.db.exec('ROLLBACK'); throw e }

    return runs
  }

  start(room, text) {
    const { agent } = route(text)
    return this.startBatch(room, text, agent)[0]
  }

  markDelivered(room, sessionKey, msgIds = []) {
    if (!msgIds?.length) return
    const binding = this.get('SELECT native FROM sessions WHERE room=? AND agent=?', room, sessionKey)
    if (!binding?.native) return
    const stmt = this.db.prepare('INSERT OR IGNORE INTO session_seen(room,agent,native,msg_id) VALUES(?,?,?,?)')
    for (const mid of msgIds) {
      if (mid) stmt.run(room, sessionKey, binding.native, mid)
    }
  }

  markSeen(room, sessionKey, maxRowid) {
    if (!maxRowid) return
    this.run(
      'UPDATE sessions SET last_seen_rowid = MAX(COALESCE(last_seen_rowid, 0), ?) WHERE room=? AND agent=?',
      maxRowid, room, sessionKey
    )
  }

  record(id, room, agent, type, value) {
    if (type === 'session') {
      this.run(
        `INSERT INTO sessions(room,agent,native,last_seen_rowid) VALUES(?,?,?,0)
         ON CONFLICT(room,agent) DO UPDATE SET
           last_seen_rowid = CASE WHEN native = excluded.native THEN last_seen_rowid ELSE 0 END,
           native = excluded.native`,
        room, agent, value
      )
      return
    }
    if (!value) return
    if (type === 'text') this.run('UPDATE messages SET body=body||? WHERE id=?', value, id)
    if (type === 'log') this.run("UPDATE messages SET log=substr(log||?,-524288) WHERE id=?", value + '\n', id)
  }

  listSessions(room) {
    return this.all('SELECT agent, native FROM sessions WHERE room=?', room)
  }

  insertSyncedMessage(room, author, body, log = '', time = Date.now()) {
    const id = randomUUID()
    this.run(
      'INSERT INTO messages(id,room,author,body,log,status,time,duration,attachments) VALUES(?,?,?,?,?,?,?,?,?)',
      id, room, author, body, log ? log + '\n' : '', '完成', time, 0, ''
    )
    this.syncArchive(room)
    return id
  }

  setStatus(id, status) {
    this.run('UPDATE messages SET status=? WHERE id=?', status, id)
  }

  finish(id, status) {
    const row = this.get('SELECT room, time FROM messages WHERE id=?', id)
    const duration = row?.time ? Math.max(0, Date.now() - row.time) : 0
    this.run('UPDATE messages SET status=?, duration=? WHERE id=?', status, duration, id)
    if (row?.room) this.syncArchive(row.room)
  }
}
