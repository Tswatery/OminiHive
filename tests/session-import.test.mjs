import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { listCodexSessions, loadExternalSessionTurns } from '../desktop/sync.mjs'
import { removeRoomArchive } from '../desktop/context-archive.mjs'
import { Store } from '../desktop/store.mjs'
import { identifyShare, parseChatGPTShare, parseGeminiShare } from '../desktop/shared-chat.mjs'

test('Codex 搜索查到第 81 条之后和已归档的会话，可按项目名匹配并读取正文', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hive-search-'))
  const oldHome = process.env.CODEX_HOME
  process.env.CODEX_HOME = dir
  const db = new DatabaseSync(path.join(dir, 'state_5.sqlite'))
  try {
    db.exec('CREATE TABLE projects(id TEXT, name TEXT); CREATE TABLE threads(id TEXT, project_id TEXT, title TEXT, cwd TEXT, archived INTEGER, updated_at INTEGER, rollout_path TEXT)')
    db.prepare('INSERT INTO projects VALUES(?,?)').run('p', '健康管理')
    const file = path.join(dir, 'record.jsonl')
    writeFileSync(file, JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: '正文' } }))
    const insert = db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?)')
    for (let i = 0; i < 90; i++) insert.run(String(i), i < 2 ? 'p' : '', i < 2 ? '睡眠RTSP' : '其他', dir, Number(i === 0), i, file)
    assert.equal(listCodexSessions(dir).length, 80)
    for (const term of ['健康', 'rtsp']) {
      const hits = listCodexSessions(dir, term)
      assert.deepEqual(hits.map(hit => hit.nativeId), ['1', '0'])
      assert.ok(hits[1].archived && hits[1].sameProject)
    }
    assert.equal(listCodexSessions(dir, '%').length, 0)
    assert.equal((await loadExternalSessionTurns('Codex', '0'))[0].text, '正文')
  } finally {
    db.close()
    if (oldHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = oldHome
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('普通聊天按当前分支导入，保留原回复并作为新 Codex 会话的上下文', () => {
  const msg = (role, text, parent) => ({ parent, message: { author: { role }, content: { content_type: 'text', parts: [text] } } })
  const data = { title: '睡眠录制', current_node: 'b', mapping: {
    u: msg('user', '问题', null), a: msg('assistant', '旧回复', 'u'), b: msg('assistant', '已选回复', 'u')
  } }
  const chat = parseChatGPTShare(data)
  assert.deepEqual(chat.turns.map(t => t.text), ['问题', '已选回复'])
  const dir = mkdtempSync(path.join(tmpdir(), 'hive-chat-import-'))
  const store = new Store(':memory:')
  try {
    const room = store.importRoom(store.project(dir), { agent: 'ChatGPT', ...chat })
    assert.deepEqual(store.messages(room).map(m => m.author), ['我', 'ChatGPT'])
    const run = store.start(room, '@Codex 继续')
    assert.equal(run.session, undefined)
    assert.match(run.prompt, /已选回复/)
  } finally {
    for (const room of store.tree().rooms) removeRoomArchive(dir, room.id)
    store.db.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('Gemini 分享长短链接采用同一个 ID，保留多轮顺序', () => {
  const id = '0123abcdef12'
  for (const prefix of ['https://g.co/gemini/share/', 'https://gemini.google.com/share/']) {
    assert.deepEqual(identifyShare(prefix + id + '?hl=zh'), { agent: 'Gemini', id })
  }
  assert.throws(() => identifyShare('https://example.org/share/' + id))
  const exchange = n => [null, null, [['问题' + n]], [[['candidate', ['回答' + n]]]], [1700000000 + n]]
  const root = [null, [exchange(1), exchange(2)], [null, '示例'], id]
  const raw = ")]}'\n\n" + JSON.stringify([['wrb.fr', 'ujx1Bf', JSON.stringify([root])]])
  const chat = parseGeminiShare(raw, id)
  assert.equal(chat.title, '示例')
  assert.deepEqual(chat.turns.map(t => t.text), ['问题1', '回答1', '问题2', '回答2'])
  assert.throws(() => parseGeminiShare(raw, 'other'))
})
