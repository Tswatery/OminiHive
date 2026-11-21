import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { cleanTitle, looksLikeSmartTitle, buildTitlePrompt, appendClaudeTitle } from '../desktop/auto-title.mjs'
import { Store } from '../desktop/store.mjs'

test('cleanTitle strips labels, quotes and trailing punctuation', () => {
  assert.equal(cleanTitle('标题：“客户端项目同步修复”。\n多余的第二行'), '客户端项目同步修复')
  assert.equal(cleanTitle('  《Gemini 改动审核》  '), 'Gemini 改动审核')
  assert.equal(cleanTitle(''), '')
  assert.ok(cleanTitle('一'.repeat(80)).length <= 24)
})

test('looksLikeSmartTitle rejects titles that just echo the user message', () => {
  const task = '@Codex @Antigravity 我觉得这个客户端的同步有问题 帮我看看'
  assert.equal(looksLikeSmartTitle('我觉得这个客户端的同步有问题', task), false)
  assert.equal(looksLikeSmartTitle('我觉得这个客户端', task), false)
  assert.equal(looksLikeSmartTitle('客户端同步问题排查', task), true)
  assert.equal(looksLikeSmartTitle('<user_task> 我觉得', task), false)
  assert.equal(looksLikeSmartTitle('', task), false)
})

test('buildTitlePrompt drops leading mentions and caps length', () => {
  const p = buildTitlePrompt('@Codex @Claude ' + '问'.repeat(3000), '答'.repeat(3000))
  assert.ok(!p.includes('@Codex'))
  assert.ok(p.length < 2600)
})

test('appendClaudeTitle writes ai-title or custom-title records on a new line', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ominihive-claude-title-'))
  try {
    const file = path.join(dir, 's1.jsonl')
    writeFileSync(file, '{"type":"user"}')
    appendClaudeTitle(file, 's1', '客户端修复讨论')
    appendClaudeTitle(file, 's1', '我的标题', { custom: true })
    const lines = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    assert.deepEqual(lines[1], { type: 'ai-title', aiTitle: '客户端修复讨论', sessionId: 's1' })
    assert.deepEqual(lines[2], { type: 'custom-title', customTitle: '我的标题', sessionId: 's1' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Store.autoTitleRoom tracks title source and respects user renames', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ominihive-store-title-'))
  const projDir = path.join(root, 'Demo')
  mkdirSync(projDir, { recursive: true })
  const store = new Store(path.join(root, 'hive.db'))
  try {
    const rid = store.room(store.project(projDir))
    assert.equal(store.roomTitleState(rid).title_auto, 0)
    assert.equal(store.autoTitleRoom(rid, 'AI 标题', 2), true)
    assert.equal(store.roomTitleState(rid).title_auto, 2)
    // A later native-client title keeps the higher source level.
    assert.equal(store.autoTitleRoom(rid, '客户端标题', 1), true)
    assert.equal(store.roomTitleState(rid).title_auto, 2)
    store.renameRoom(rid, '我改的')
    assert.equal(store.autoTitleRoom(rid, '又一个 AI 标题', 2), false)
    assert.equal(store.roomTitleState(rid).title, '我改的')
  } finally {
    store.db.close()
    try { rmSync(root, { recursive: true, force: true }) } catch {}
  }
})
