// Renderer-side pure logic. Node 22.6+ strips TS types natively, so these .ts modules import directly.
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseStepsWithMeta } from '../src/steps.ts'
import { cleanError } from '../src/errors.ts'

const step = o => '::step::' + JSON.stringify(o)

test('meta steps become header tags: model/effort first, context last, with its detail kept', () => {
  const log = [
    step({ id: 'meta-context', kind: 'info', title: '上下文 · 带入最新 1 条（Claude） · 归档 4 条', status: 'done', detail: '#012 Claude: …' }),
    '模型 · gpt-6.2-astra',
    '请求思考强度 · high',
    step({ id: 't1', kind: 'cmd', title: 'Bash · ls', status: 'done' })
  ].join('\n')
  const r = parseStepsWithMeta(log, true)
  assert.deepEqual(r.metaTags, ['gpt-6.2-astra', 'high', '上下文 带入最新 1 条（Claude） · 归档 4 条'])
  assert.equal(r.contextDetail, '#012 Claude: …')
  assert.deepEqual(r.steps.map(s => s.id), ['t1'])
})

test('empty finished thoughts are dropped, running ones are kept', () => {
  const log = [
    step({ id: 'th1', kind: 'thought', title: '思考过程', status: 'done' }),
    step({ id: 'th2', kind: 'thought', title: '思考过程', status: 'done', detail: '有内容' }),
    step({ id: 'th3', kind: 'thought', title: '思考过程', status: 'running' })
  ].join('\n')
  assert.deepEqual(parseStepsWithMeta(log, false).steps.map(s => s.id), ['th2', 'th3'])
})

test('unfinished steps take the message end state instead of always showing ✓', () => {
  const log = [
    step({ id: 'a', kind: 'cmd', title: 'Bash · npm test', status: 'done' }),
    step({ id: 'b', kind: 'cmd', title: 'Bash · npm run build', status: 'running' }),
    step({ id: 'c', kind: 'tool', title: '写入文件', status: 'waiting', interaction: { cascadeId: 'x', stepIndex: 1, kind: 'perm', title: '?', options: [] } })
  ].join('\n')
  const status = endState => parseStepsWithMeta(log, true, endState).steps.map(s => s.status)
  assert.deepEqual(status('done'), ['done', 'done', 'done'])
  assert.deepEqual(status('error'), ['done', 'error', 'error'])
  assert.deepEqual(status('stopped'), ['done', 'stopped', 'stopped'])
  assert.ok(parseStepsWithMeta(log, true, 'stopped').steps.every(s => !s.interaction), 'ended steps drop pending interactions')
  assert.deepEqual(parseStepsWithMeta(log, false).steps.map(s => s.status), ['done', 'running', 'waiting'])
})

test('step updates merge by id and keep earlier detail', () => {
  const log = [
    step({ id: 'x', kind: 'cmd', title: 'Bash · ls', status: 'running', detail: 'out' }),
    step({ id: 'x', kind: 'cmd', title: 'Bash · ls', status: 'done' })
  ].join('\n')
  const [s] = parseStepsWithMeta(log, true).steps
  assert.equal(s.status, 'done')
  assert.equal(s.detail, 'out')
})

test('cleanError strips the Electron IPC envelope but keeps the real message', () => {
  const wrapped = "Error invoking remote method 'send': Error: Codex 正在执行 (Error: inner)"
  assert.equal(cleanError(new Error(wrapped)), 'Codex 正在执行 (Error: inner)')
  assert.equal(cleanError(String(new Error(wrapped))), 'Codex 正在执行 (Error: inner)')
  assert.equal(cleanError(new Error('plain')), 'plain')
  assert.equal(cleanError(null), '未知错误')
})

import { appendItem, prioritizeItem, removeItem, drainableHeads } from '../src/sendQueue.ts'

const q = (id, room, targetList) => ({ id, room, raw: id, targets: targetList, targetList, images: [] })

test('send queue: FIFO per room, prioritize moves to head, remove drops empty rooms', () => {
  let s = {}
  s = appendItem(s, q('a', 'r1', ['Codex']))
  s = appendItem(s, q('b', 'r1', ['Claude']))
  s = appendItem(s, q('c', 'r2', ['Codex']))
  assert.deepEqual(s.r1.map(x => x.id), ['a', 'b'])
  s = prioritizeItem(s, s.r1[1])
  assert.deepEqual(s.r1.map(x => x.id), ['b', 'a'], 'already-queued item moves, not duplicates')
  s = removeItem(s, 'r2', 'c')
  assert.ok(!('r2' in s), 'empty room key removed')
  assert.equal(removeItem(s, 'r1', 'missing'), s, 'no-op returns same state')
})

test('send queue: a room head drains only when its targets are idle in that room', () => {
  const s = {
    r1: [q('a', 'r1', ['Codex']), q('b', 'r1', ['Claude'])],
    r2: [q('c', 'r2', ['Claude', 'Codex'])],
    r3: [q('d', 'r3', ['Codex'])]
  }
  const running = [{ room: 'r1', agent: 'Codex' }, { room: 'r2', agent: 'Codex' }]
  // r1 head waits for Codex (even though Claude is free: strict FIFO), r2 waits for Codex,
  // r3 is free (Codex busy elsewhere doesn't matter), r3 skipped when already draining
  assert.deepEqual(drainableHeads(s, running, new Set()).map(x => x.id), ['d'])
  assert.deepEqual(drainableHeads(s, running, new Set(['r3'])).map(x => x.id), [])
  assert.deepEqual(drainableHeads(s, [], new Set()).map(x => x.id), ['a', 'c', 'd'])
})
