import test from 'node:test'
import assert from 'node:assert/strict'
import { names } from '../desktop/clients.mjs'
import {
  EFFORT_LEVELS,
  normalizeModelEfforts,
  applyReasoningEffort,
  parseEffortsFromHelp
} from '../desktop/reasoning.mjs'
import { createStepAdapter } from '../desktop/step-tracker.mjs'
import { buildDeepSeekArgs, formatClaudeSystemStep } from '../desktop/agents.mjs'

test('all registered agents receive unified reasoning effort levels', () => {
  for (const agent of Object.keys(names)) {
    const list = normalizeModelEfforts(agent, [{ id: 'test-model', label: 'Test', efforts: [] }])
    assert.equal(list.length, 1)
    assert.ok(list[0].efforts.length >= 3, `${agent} should expose at least 3 effort levels`)
    for (const e of list[0].efforts) {
      assert.ok(EFFORT_LEVELS.includes(e), `${agent} effort ${e} must be valid`)
    }
  }
})

test('applyReasoningEffort injects native flags and respects -- separator', () => {
  const logs = []
  const emit = (t, v) => { if (t === 'log') logs.push(v) }

  const wbArgs = ['-p', '--output-format', 'stream-json']
  applyReasoningEffort({ agent: 'WorkBuddy', effort: 'high', args: wbArgs, env: {}, emit })
  assert.deepEqual(wbArgs.slice(-2), ['--effort', 'high'])

  const ompArgs = ['-p', '--mode', 'json', 'hello']
  applyReasoningEffort({ agent: 'OhMyPi', effort: 'off', args: ompArgs, env: {}, emit })
  assert.deepEqual(ompArgs.slice(-2), ['--thinking', 'off'])

  const ocArgs = ['run', '--format', 'json', '--', 'hello']
  applyReasoningEffort({ agent: 'OpenCode', effort: 'max', args: ocArgs, env: {}, emit })
  assert.deepEqual(ocArgs, ['run', '--format', 'json', '--variant', 'max', '--', 'hello'])

  const dsEnv = {}
  applyReasoningEffort({ agent: 'DeepSeek', effort: 'high', args: ['run', 'hello'], env: dsEnv, emit })
  assert.equal(dsEnv.DEEPSEEK_REASONING_EFFORT, 'high')
  assert.equal(dsEnv.REASONING_EFFORT, 'high')

  const parsed = parseEffortsFromHelp('  --effort <level>   Reasoning effort level (minimal, low, medium, high, xhigh, max)')
  assert.equal(parsed.flag, '--effort')
  assert.deepEqual(parsed.efforts, ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
})

test('PiStreamAdapter extracts thinking, tool execution steps, and text for OhMyPi/Pi', () => {
  const steps = []
  let output = ''
  const adapter = createStepAdapter('OhMyPi', {
    emit: (type, value) => {
      if (type === 'log' && String(value).startsWith('::step::')) {
        steps.push(JSON.parse(String(value).slice(8)))
      }
    },
    append: s => { output += s },
    fail: err => { throw err }
  })

  adapter.handleLine(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'thinking_start' } }))
  adapter.handleLine(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '先检查项目结构' } }))
  adapter.handleLine(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'thinking_end', content: '先检查项目结构并读取配置' } }))
  adapter.handleLine(JSON.stringify({ type: 'tool_execution_start', toolCallId: 'tc-1', toolName: 'bash', args: { command: 'ls -la' } }))
  adapter.handleLine(JSON.stringify({ type: 'tool_execution_end', toolCallId: 'tc-1', toolName: 'bash', result: { content: [{ type: 'text', text: 'package.json' }] }, isError: false }))
  adapter.handleLine(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '检查完成。' } }))
  adapter.finalize()

  assert.equal(output, '检查完成。')
  assert.ok(steps.some(s => s.kind === 'thought' && s.status === 'done' && s.detail.includes('先检查项目结构')))
  assert.ok(steps.some(s => s.kind === 'tool' && s.id === 'tc-1' && s.status === 'running' && s.title.includes('ls -la')))
  assert.ok(steps.some(s => s.kind === 'tool' && s.id === 'tc-1' && s.status === 'done' && s.detail.includes('package.json')))
})

test('buildDeepSeekArgs uses dsh headless profile with valid flags and no --model', () => {
  const argsFull = buildDeepSeekArgs({ prompt: 'hello', accessMode: 'full', write: true, session: 'session-123', patchFile: '/tmp/p.yml' })
  assert.deepEqual(argsFull, [
    'headless',
    '--patch', '/tmp/p.yml',
    '--json',
    '--permission-mode', 'danger-full-access',
    '--session-id', 'session-123',
    '--', 'hello'
  ])
  assert.ok(!argsFull.includes('run'))
  assert.ok(!argsFull.includes('--model'))

  const argsRead = buildDeepSeekArgs({ prompt: '- check', accessMode: 'read', write: false })
  assert.deepEqual(argsRead, [
    'headless',
    '--json',
    '--permission-mode', 'read-only',
    '--approval-policy', 'never',
    '--', '- check'
  ])

  const argsWrite = buildDeepSeekArgs({ prompt: 'fix bug', accessMode: 'workspace', write: true })
  assert.deepEqual(argsWrite, [
    'headless',
    '--json',
    '--permission-mode', 'workspace-write',
    '--approval-policy', 'never',
    '--', 'fix bug'
  ])
})

test('DeepSeekStreamAdapter parses dsh headless --json events without duplicating final text', () => {
  const steps = []
  const sessions = []
  let output = ''
  const errors = []
  const adapter = createStepAdapter('DeepSeek', {
    emit: (type, value) => {
      if (type === 'session') sessions.push(value)
      if (type === 'log' && String(value).startsWith('::step::')) {
        steps.push(JSON.parse(String(value).slice(8)))
      }
    },
    append: s => { output += s },
    fail: err => { errors.push(err) }
  })

  adapter.handleLine(JSON.stringify({ type: 'session', sessionId: 'session-abc', cwd: '/tmp' }))
  adapter.handleLine(JSON.stringify({ type: 'status', phase: 'turn_start', turn: 1 }))
  adapter.handleLine(JSON.stringify({ type: 'thinking', text: '先分析需求' }))
  adapter.handleLine(JSON.stringify({ type: 'tool_call', callId: 'call-1', tool: 'bash', input: { command: 'pwd' } }))
  adapter.handleLine(JSON.stringify({ type: 'tool_result', callId: 'call-1', status: 'completed', result: '/tmp' }))
  adapter.handleLine(JSON.stringify({ type: 'text', text: '已完成检查。' }))
  adapter.handleLine(JSON.stringify({ type: 'final', sessionId: 'session-abc', reason: { kind: 'completed' }, text: '已完成检查。' }))
  adapter.finalize()

  assert.deepEqual(sessions, ['session-abc', 'session-abc'])
  assert.equal(output, '已完成检查。')
  assert.equal(errors.length, 0)
  assert.ok(steps.some(s => s.kind === 'thought' && s.status === 'done' && s.detail.includes('先分析需求')))
  assert.ok(steps.some(s => s.kind === 'tool' && s.id === 'call-1' && s.status === 'running' && s.title.includes('pwd')))
  assert.ok(steps.some(s => s.kind === 'tool' && s.id === 'call-1' && s.status === 'done' && s.detail.includes('/tmp')))
})

test('formatClaudeSystemStep surfaces 408 timeout retries, exhausted errors, and compaction status', () => {
  const retry408 = formatClaudeSystemStep({
    type: 'system',
    subtype: 'api_error',
    error: { status: 408, formatted: '408 request body upload interrupted or timed out' },
    retryAttempt: 2,
    maxRetries: 10,
    retryInMs: 1200
  })
  assert.equal(retry408.id, 'claude-api-retry')
  assert.equal(retry408.status, 'running')
  assert.match(retry408.title, /2\/10/)
  assert.match(retry408.title, /408 请求体上传超时/)
  assert.match(retry408.detail, /1\.2s/)
  assert.match(retry408.detail, /重置会话/)

  const exhausted = formatClaudeSystemStep({
    type: 'system',
    subtype: 'api_error',
    error: { status: 502, message: '502 status code' },
    retryAttempt: 10,
    maxRetries: 10
  })
  assert.equal(exhausted.status, 'error')
  assert.match(exhausted.title, /重试失败/)

  const compacting = formatClaudeSystemStep({ type: 'system', subtype: 'status', status: 'compacting' })
  assert.equal(compacting.id, 'claude-compact')
  assert.equal(compacting.status, 'running')

  const compacted = formatClaudeSystemStep({ type: 'system', subtype: 'compact_boundary' })
  assert.equal(compacted.id, 'claude-compact')
  assert.equal(compacted.status, 'done')
})

test('resolveCodexFastTier picks the Fast serviceTier id from model catalog and falls back to priority', async () => {
  const { resolveCodexFastTier } = await import('../desktop/agents.mjs')
  const catalog = [
    { model: 'gpt-6.2-astra', isDefault: true, serviceTiers: [{ id: 'priority', name: 'Fast', description: '2x speed' }] },
    { model: 'gpt-custom', isDefault: false, serviceTiers: [{ id: 'fast', name: 'Fast', description: 'fast' }] }
  ]
  assert.equal(resolveCodexFastTier(catalog, 'gpt-6.2-astra'), 'priority')
  assert.equal(resolveCodexFastTier(catalog, 'gpt-custom'), 'fast')
  assert.equal(resolveCodexFastTier([], 'gpt-6.2-astra'), 'priority')
})
