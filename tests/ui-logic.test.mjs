// Renderer-side pure logic. Node 22.6+ strips TS types natively, so these .ts modules import directly.
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseStepsWithMeta, buildTimelineSegments, summarizeStepGroup, fenceSafeCut, extractStepImages } from '../src/steps.ts'
import { cleanError } from '../src/errors.ts'
import { preprocessMathDelimiters } from '../src/markdownMath.ts'

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

import { appendItem, prioritizeItem, removeItem, drainableHeads, restoreFailed } from '../src/sendQueue.ts'

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

test('buildTimelineSegments interleaves text and step groups by offset and falls back for legacy logs', () => {
  // Legacy steps without offset -> returns null so UI keeps legacy layout
  const legacySteps = parseStepsWithMeta(step({ id: 't1', kind: 'cmd', title: 'Bash · ls', status: 'done' }), true).steps
  assert.equal(buildTimelineSegments('hello', legacySteps), null)

  // Interleaved: text -> [read, bash] -> text -> [write] -> text
  const body = '先看配置：\n\n确认了问题。\n\n已完成修改。'
  const offset1 = '先看配置：'.length
  const offset2 = '先看配置：\n\n确认了问题。'.length
  const log = [
    step({ id: 's1', kind: 'tool', title: 'Read · src/App.tsx', status: 'running', offset: offset1 }),
    step({ id: 's1', kind: 'tool', title: 'Read · src/App.tsx', status: 'done', offset: offset2 }), // later update must keep original offset1
    step({ id: 's2', kind: 'cmd', title: 'Bash · npm test', status: 'done', offset: offset1 }),
    step({ id: 's3', kind: 'tool', title: 'Write · src/steps.ts', status: 'done', offset: offset2 })
  ].join('\n')

  const { steps } = parseStepsWithMeta(log, true)
  assert.equal(steps[0].offset, offset1)
  const segs = buildTimelineSegments(body, steps)
  assert.ok(segs)
  assert.equal(segs.length, 5)
  assert.deepEqual(segs.map(s => s.type), ['text', 'steps', 'text', 'steps', 'text'])
  assert.equal(segs[0].type === 'text' ? segs[0].content : '', '先看配置：')
  assert.deepEqual(segs[1].type === 'steps' ? segs[1].steps.map(x => x.id) : [], ['s1', 's2'])
  assert.equal(segs[2].type === 'text' ? segs[2].content : '', '确认了问题。')
  assert.deepEqual(segs[3].type === 'steps' ? segs[3].steps.map(x => x.id) : [], ['s3'])
  assert.equal(segs[4].type === 'text' ? segs[4].content : '', '已完成修改。')

  assert.equal(summarizeStepGroup(segs[1].type === 'steps' ? segs[1].steps : []), '已读取/搜索 1 次，运行 1 条命令')
  assert.equal(summarizeStepGroup(segs[3].type === 'steps' ? segs[3].steps : []), 'Write · src/steps.ts')
})

test('interleaving never splits a fenced code block and keeps first-line indentation', () => {
  const body = '运行下面的命令：\n```bash\nnpm test\nnpm run build\n```\n结果正常。\n\n    indented code\n继续'
  const midFence = body.indexOf('npm run build')            // a step that "arrived" mid-fence
  assert.equal(fenceSafeCut(body, midFence), body.indexOf('结果正常'), 'cut moves past the closing fence')
  assert.equal(fenceSafeCut(body, 3), 3, 'outside a fence the cut is untouched')
  assert.equal(fenceSafeCut('```js\nstill streaming', 8), '```js\nstill streaming'.length, 'unclosed fence → end')

  const steps = [
    { id: 'a', kind: 'cmd', title: 'Bash · npm test', status: 'done', offset: midFence },
    { id: 'b', kind: 'cmd', title: 'Bash · ls', status: 'done', offset: body.indexOf('    indented') }
  ]
  const segs = buildTimelineSegments(body, steps)
  assert.deepEqual(segs.map(x => x.type), ['text', 'steps', 'text', 'steps', 'text'])
  assert.ok(segs[0].content.endsWith('```'), 'code block stays whole in the first segment')
  assert.ok(segs[4].content.startsWith('    indented code'), 'indentation preserved')
})

test('step group summary recognises Chinese titles and the provider meta step', () => {
  const s = (title, kind = 'tool') => ({ id: title, kind, title, status: 'done' })
  assert.equal(summarizeStepGroup([s('读取 · a.ts'), s('编辑 · b.ts'), s('执行 · npm test')]), '已读取/搜索 1 次，修改 1 个文件，运行 1 条命令')
  assert.equal(summarizeStepGroup([s('Readme 生成器'), s('Read · x')]), '已读取/搜索 1 次，调用工具 1 次', '"Readme" is not "read"')
  const r = parseStepsWithMeta('::step::' + JSON.stringify({ id: 'meta-provider', kind: 'info', title: '渠道 · 智谱', status: 'done' }), true)
  assert.deepEqual(r.metaTags, ['智谱'])
  assert.equal(r.steps.length, 0)
})

test('parseStepsWithMeta ignores truncated leading base64/JSON log fragments', () => {
  const log = [
    'u2Ocs2xHMdIQAgh80wSWAQWnIpsb+T+EmeUAhYCGzCJc1jHzk7Z3OTCxfHCHIJ36jiL2XDXPR4nETIGC',
    '::step::' + JSON.stringify({ id: 'c1', kind: 'cmd', title: 'Bash · ls', status: 'done', offset: 10 })
  ].join('\n')
  const { steps } = parseStepsWithMeta(log, true)
  assert.deepEqual(steps.map(s => s.id), ['c1'])
})

test('extractStepImages collects explicit imagePath and Read image tool steps without duplicates', () => {
  const log = [
    step({ id: 'i1', kind: 'file', title: '查看图像 · fig1.png', status: 'done', imagePath: '/tmp/fig1.png' }),
    step({ id: 'i2', kind: 'tool', title: 'Read · /tmp/fig2.jpg', status: 'done', detail: '输入：\n{"file_path": "/tmp/fig2.jpg"}' }),
    step({ id: 'i3', kind: 'tool', title: 'Read · /tmp/fig1.png', status: 'done', detail: '输入：\n{"file_path": "/tmp/fig1.png"}' }),
    step({ id: 'c1', kind: 'cmd', title: 'Bash · ls', status: 'done' })
  ].join('\n')
  const { steps } = parseStepsWithMeta(log, true)
  const imgs = extractStepImages(steps)
  assert.deepEqual(imgs, [
    { path: '/tmp/fig1.png', name: 'fig1.png' },
    { path: '/tmp/fig2.jpg', name: 'fig2.jpg' }
  ])
})

test('file preview labels hide noisy absolute paths and UUID attachment names', async () => {
  const { friendlyDir, friendlyFileName, imageMetaLine, formatBytes } = await import('../src/filePresentation.ts')
  const proj = '/Users/lin/Desktop/赛力斯/1218交流报告工作区'
  assert.equal(friendlyDir(proj + '/build/P43重绘/p43.png', proj), 'build/P43重绘')
  assert.equal(friendlyDir(proj + '/p43.png', proj), '项目根目录')
  assert.equal(friendlyDir('/Users/lin/a/b/c/d/e/f.png'), '~/a/…/d/e')
  assert.equal(friendlyDir('/Users/lin/Library/Application Support/OminiHive/attachments/x.png'), '对话附件')
  assert.equal(friendlyFileName('', '/x/f7eeadd3-8870-4776-bdb3-ae41b5394330.png'), '图片附件')
  assert.equal(friendlyFileName('p43_imagegen.png', '/x/p43_imagegen.png'), 'p43_imagegen.png')
  assert.equal(imageMetaLine({ width: 2048, height: 1152, name: 'a.png', size: 1.2 * 1024 * 1024 }), '2048×1152 · PNG · 1.2 MB')
  assert.equal(imageMetaLine({ name: 'noext' }), '')
  assert.equal(formatBytes(undefined), '')
})

test('sidebar completion dots know which agent finished in which room', async () => {
  const { finishedAgentsByRoom, runKey, agentColor } = await import('../src/agentMeta.ts')
  const prev = [runKey('r1', 'Codex'), runKey('r1', 'Claude'), runKey('r2', 'Antigravity')]
  assert.deepEqual(finishedAgentsByRoom(prev, [{ room: 'r1', agent: 'Claude' }]), { r1: ['Codex'], r2: ['Antigravity'] })
  assert.deepEqual(finishedAgentsByRoom(prev, [{ room: 'r1', agent: 'Codex' }, { room: 'r1', agent: 'Claude' }, { room: 'r2', agent: 'Antigravity' }]), {})
  assert.notEqual(agentColor('Codex'), agentColor('Antigravity'))
  assert.equal(agentColor('Unknown'), 'var(--accent)')
})

test('step titles show project-relative paths and fold the home folder', async () => {
  const { shortenPathsInText } = await import('../src/filePresentation.ts')
  assert.equal(shortenPathsInText('Read · /Users/lin/code/OminiHive/src/App.tsx', '/Users/lin/code/OminiHive'), 'Read · src/App.tsx')
  assert.equal(shortenPathsInText('Bash · cat "/Users/lin/Desktop/a.txt"', '/Users/lin/code/OminiHive'), 'Bash · cat "~/Desktop/a.txt"')
  assert.equal(shortenPathsInText('Read · /etc/hosts', ''), 'Read · /etc/hosts')
})

test('frontend mention parsing routes exactly like the backend', async () => {
  const { buildMentionTools } = await import('../src/mentions.ts')
  const { ALL_AGENTS } = await import('../src/agentMeta.ts')
  const { parseMentionedAgents } = buildMentionTools(ALL_AGENTS)
  const { routeTargets } = await import('../desktop/store.mjs')
  const cases = [
    '@Codex 参考 @Claude 的方案',
    '@Codex @Claude 对比一下',
    '看下 @Claude 的方案',
    '你怎么看 @Antigravity @codex',
    '@Codex帮我看看',
    '@Codex，帮我看看',
    '@all 你怎么看',
    '@Claude\n第二行提到 @Codex'
  ]
  for (const text of cases) {
    const front = parseMentionedAgents(text).agents
    let back = []
    try { back = routeTargets(text, []).agents } catch {}
    assert.deepEqual([...front].sort(), [...back].sort(), text)
  }
})

test('a failed queued dispatch is kept at the head and pauses the room until retried', () => {
  const item = (id, room, targets) => ({ id, room, raw: id, targets, targetList: targets, images: [] })
  let state = appendItem({}, item('b', 'r1', ['Codex']))
  state = restoreFailed(state, item('a', 'r1', ['Claude']), 'CLI 不存在')
  assert.deepEqual(state.r1.map(x => x.id), ['a', 'b'])
  assert.equal(state.r1[0].error, 'CLI 不存在')
  assert.deepEqual(drainableHeads(state, [], new Set()), [])
  state = prioritizeItem(state, state.r1[0])
  assert.equal(state.r1[0].error, undefined)
  assert.deepEqual(drainableHeads(state, [], new Set()).map(x => x.id), ['a'])
})

test('preprocessMathDelimiters converts LaTeX brackets outside code blocks and inline code', () => {
  const input = [
    '行内 \\(1/(N+1)\\) 与行内代码 `\\(keep\\)`',
    '\\[\\lfloor N/2 \\rfloor + 1\\]',
    '```tex',
    '\\(inside fence\\)',
    '```'
  ].join('\n')
  const out = preprocessMathDelimiters(input)
  assert.equal(out, [
    '行内 $1/(N+1)$ 与行内代码 `\\(keep\\)`',
    '$$\\lfloor N/2 \\rfloor + 1$$',
    '```tex',
    '\\(inside fence\\)',
    '```'
  ].join('\n'))
})

test('markdown math pipeline renders inline and block LaTeX formulas via KaTeX without breaking inline code', async () => {
  const React = (await import('react')).default
  const { renderToStaticMarkup } = await import('react-dom/server')
  const Markdown = (await import('react-markdown')).default
  const gfm = (await import('remark-gfm')).default
  const remarkMath = (await import('remark-math')).default
  const rehypeKatex = (await import('rehype-katex')).default

  const render = md => renderToStaticMarkup(React.createElement(Markdown, {
    remarkPlugins: [gfm, remarkMath],
    rehypePlugins: [[rehypeKatex, { throwOnError: false, strict: false }]]
  }, preprocessMathDelimiters(md)))

  const inline1 = render('迁移约 $1/(N+1)$）与热点治理')
  assert.match(inline1, /class="katex"/)
  assert.doesNotMatch(inline1, /\$1\/\(N\+1\)\$/)

  const inline2 = render('多数派提交（$\\lfloor N/2 \\rfloor + 1$），只讲原理')
  assert.match(inline2, /class="katex"/)
  assert.match(inline2, /<span class="mopen">⌊<\/span>/)
  assert.doesNotMatch(inline2, /\$\\lfloor/)

  const latexParen = render('复杂度为 \\(O(\\log N)\\)')
  assert.match(latexParen, /class="katex"/)

  const inlineCode = render('保留行内代码 `$1/(N+1)$` 与 `report.docx`')
  assert.doesNotMatch(inlineCode, /class="katex"/)
  assert.match(inlineCode, /<code>\$1\/\(N\+1\)\$<\/code>/)
})

test('remarkHtmlBr renders <br> tags in tables and paragraphs while keeping code and other HTML safe', async () => {
  const React = (await import('react')).default
  const { renderToStaticMarkup } = await import('react-dom/server')
  const Markdown = (await import('react-markdown')).default
  const gfm = (await import('remark-gfm')).default
  const { remarkHtmlBr } = await import('../src/remarkHtmlBr.ts')

  const render = md => renderToStaticMarkup(React.createElement(Markdown, {
    remarkPlugins: [gfm, remarkHtmlBr]
  }, md))

  const tableHtml = render([
    '| 幕次 | 要点 |',
    '| --- | --- |',
    '| **第一幕：破题与亮底牌<br>**《车企》 | 开局先给结论。<br>· **给领导**：痛点<br/>· **亮肌肉**：实绩 |'
  ].join('\n'))
  assert.match(tableHtml, /<br\s*\/>/)
  assert.doesNotMatch(tableHtml, /&lt;br\s*\/?&gt;/i)

  const variants = render('第一行<br />第二行<BR><br/>第三行')
  assert.equal((variants.match(/<br\s*\/>/g) || []).length, 3)

  const safeCode = render('行内 `<br>` 与 <span>raw</span>\n\n```html\n<br>\n```')
  assert.match(safeCode, /<code>&lt;br&gt;<\/code>/)
  assert.match(safeCode, /&lt;span&gt;raw&lt;\/span&gt;/)
  assert.doesNotMatch(safeCode, /<br\s*\/>/)
})
