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
