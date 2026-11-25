import test from 'node:test'
import assert from 'node:assert/strict'
import {
  claudeContextTokens, claudeWindowFromResult, readCodexTokenUsage, codexUsageFromRollout,
  claudeUsageFromTranscript, antigravityContextFromGenerators, claudeProjectDirName, createContextUsage
} from '../desktop/context-usage.mjs'
import { mapCodexRateLimits, parseAgyUsage, agyRanModelTurn, versionAtLeast } from '../desktop/agent-quota.mjs'

test('claude context tokens sum input, cache and output', () => {
  assert.equal(claudeContextTokens({ input_tokens: 2, cache_creation_input_tokens: 1176, cache_read_input_tokens: 121537, output_tokens: 617 }), 123332)
  assert.equal(claudeContextTokens(null), 0)
})

test('claude window prefers the main model over subagent models', () => {
  const modelUsage = {
    'claude-haiku-5-5': { contextWindow: 200000 },
    'claude-opus-5-5[1m]': { contextWindow: 1000000 },
  }
  assert.equal(claudeWindowFromResult(modelUsage, 'claude-opus-5-5[1m]'), 1000000)
  assert.equal(claudeWindowFromResult(modelUsage, 'claude-haiku-5-5'), 200000)
  assert.equal(claudeWindowFromResult({}, 'x'), 0)
})

test('codex token usage reads last turn and model window', () => {
  assert.deepEqual(readCodexTokenUsage({ tokenUsage: { last: { totalTokens: 44171 }, total: { totalTokens: 999999 }, modelContextWindow: 828400 } }), { usedTokens: 44171, windowTokens: 828400 })
  assert.equal(readCodexTokenUsage({ tokenUsage: { last: { totalTokens: 0 } } }), null)
})

test('codex rollout tail yields the newest token_count', () => {
  const lines = [
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 100 }, model_context_window: 1000 } } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 250 }, model_context_window: 1000 } } }),
    'partial-line-{'
  ].join('\n')
  assert.deepEqual(codexUsageFromRollout(lines), { usedTokens: 250, windowTokens: 1000 })
})

test('claude transcript skips sidechain messages', () => {
  const lines = [
    JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 5 } } }),
    JSON.stringify({ type: 'assistant', isSidechain: true, message: { model: 'claude-haiku-5-5', usage: { input_tokens: 99999 } } })
  ].join('\n')
  assert.deepEqual(claudeUsageFromTranscript(lines), { usedTokens: 15, responseModel: 'claude-opus-5-5' })
})

test('antigravity context uses reported usage, not the inflated estimate', () => {
  const meta = est => ({ contextWindowMetadata: { estimatedTokensUsed: est, maxContextTokens: 512000 } })
  const list = [
    { chatModel: { chatStartMetadata: meta(638887), usage: { inputTokens: '4086', cacheReadTokens: '488102', outputTokens: '1728' } } },
    { chatModel: { chatStartMetadata: meta(641886), usage: { inputTokens: '495197', outputTokens: '836' } } },
    // still streaming: no usage yet
    { chatModel: { chatStartMetadata: meta(650000) } }
  ]
  assert.deepEqual(antigravityContextFromGenerators(list), { usedTokens: 496033, windowTokens: 512000 })
  // Without any usage the estimate is the fallback.
  assert.deepEqual(antigravityContextFromGenerators([{ chatModel: { chatStartMetadata: meta(124448) } }]), { usedTokens: 124448, windowTokens: 512000 })
})

test('claude project dir name replaces every non-alphanumeric char', () => {
  assert.equal(claudeProjectDirName('/Users/lin/code/OminiHive'), '-Users-lin-code-OminiHive')
  assert.equal(claudeProjectDirName('/tmp/a_b.c'), '-tmp-a-b-c')
})

test('context store resets readings when the native session changes and learns windows', () => {
  const store = createContextUsage({})
  store.update('r', 'Claude', { sessionId: 's1', model: 'claude-opus-5-5' })
  store.update('r', 'Claude', { usedTokens: 50000 })
  assert.equal(store.snapshot('r').Claude.windowTokens, null)
  store.update('r', 'Claude', { windowTokens: 200000 })
  assert.equal(store.snapshot('r').Claude.percentage, 25)
  store.update('r', 'Claude', { sessionId: 's2', model: 'claude-opus-5-5' })
  assert.equal(store.snapshot('r').Claude.usedTokens, null)
  // The learned window for the model still applies to the new session.
  store.update('r', 'Claude', { usedTokens: 100000 })
  assert.equal(store.snapshot('r').Claude.percentage, 50)
  store.update('r', 'Gemini', { usedTokens: 1 })
  assert.equal(store.snapshot('r').Gemini, undefined)
})

test('context store tracks live agents', () => {
  const store = createContextUsage({})
  store.update('r', 'Codex', { usedTokens: 10, windowTokens: 100 })
  store.setLive('r', 'Codex', true)
  assert.equal(store.snapshot('r').Codex.live, true)
  assert.ok(store.liveSignature())
  store.setLive('r', 'Codex', false)
  assert.equal(store.liveSignature(), '')
})

test('codex rate limits map to labelled windows', () => {
  const q = mapCodexRateLimits({
    rateLimits: { primary: { usedPercent: 71, windowDurationMins: 10080, resetsAt: 1795587093 }, secondary: null, planType: 'prolite' },
    rateLimitResetCredits: { availableCount: 2 }
  }, { email: 'a@b.c' })
  assert.equal(q.plan, 'prolite')
  assert.equal(q.resetCredits, 2)
  assert.deepEqual(q.groups[0].buckets, [{ id: 'w10080', label: '每周', minutes: 10080, usedPercent: 71, resetsAt: 1795587093000 }])
  const both = mapCodexRateLimits({ rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300 }, secondary: { usedPercent: 40, windowDurationMins: 10080 } } })
  assert.deepEqual(both.groups[0].buckets.map(b => b.label), ['5h', '每周'])
  assert.equal(mapCodexRateLimits({}), null)
})

test('agy usage envelope parses groups and drops disabled buckets', () => {
  const stdout = 'log noise\n' + JSON.stringify({
    conversation_id: '', status: 'SUCCESS', num_turns: 0,
    command: { name: 'usage', data: { groups: [
      { name: 'Gemini Models', buckets: [
        { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.98, reset_time: '2026-11-28T11:14:10Z' },
        { id: 'gemini-5h', window: '5h', remaining_fraction: 0.93, reset_time: '2026-11-21T16:14:10Z' }
      ] },
      { name: 'Claude and GPT models', buckets: [{ id: '3p-5h', window: '5h', remaining_fraction: 1, disabled: true }] }
    ] } }
  })
  const q = parseAgyUsage(stdout)
  assert.equal(q.groups.length, 1)
  assert.equal(q.groups[0].name, 'Gemini')
  assert.deepEqual(q.groups[0].buckets.map(b => [b.label, b.usedPercent]), [['每周', 2], ['5h', 7]])
  assert.equal(agyRanModelTurn(stdout), false)
  assert.equal(parseAgyUsage(JSON.stringify({ status: 'SUCCESS', response: 'hello', num_turns: 1, conversation_id: 'x' })), null)
  assert.equal(agyRanModelTurn(JSON.stringify({ status: 'SUCCESS', num_turns: 1 })), true)
})

test('agy version gate', () => {
  assert.equal(versionAtLeast('1.5.14', '1.1.11'), true)
  assert.equal(versionAtLeast('agy 1.1.11', '1.1.11'), true)
  assert.equal(versionAtLeast('1.1.9', '1.1.11'), false)
  assert.equal(versionAtLeast('', '1.1.11'), false)
})

test('claude /context report parses used and window tokens', async () => {
  const { parseClaudeContextReport } = await import('../desktop/claude-window.mjs')
  assert.deepEqual(parseClaudeContextReport('## Context Usage\n\n**Model:** claude-opus-5-5  \n**Tokens:** 9.7k / 1m (1%)'), { usedTokens: 9700, windowTokens: 1000000 })
  assert.deepEqual(parseClaudeContextReport('**Tokens:** 150.2k / 200k (75%)'), { usedTokens: 150200, windowTokens: 200000 })
  assert.equal(parseClaudeContextReport('no report'), null)
})

test('context store probes a Claude window once and applies it', async () => {
  let calls = 0, changed = 0
  const store = createContextUsage({ probeWindow: async () => { calls++; return 1000000 }, onChange: () => changed++ })
  store.update('r', 'Claude', { sessionId: 's', model: 'claude-opus-5-5', usedTokens: 250000 })
  assert.equal(store.snapshot('r').Claude.percentage, null)
  store.snapshot('r')
  await new Promise(r => setTimeout(r, 10))
  assert.equal(calls, 1)
  assert.equal(changed, 1)
  assert.equal(store.snapshot('r').Claude.percentage, 25)
})

test('claude transcript image scan counts sent payloads and resets after compaction', async () => {
  const { scanClaudeImages, scanTranscriptLine } = await import('../desktop/context-usage.mjs')
  const { mkdtempSync, writeFileSync, appendFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const path = (await import('node:path')).default
  const img = 'A'.repeat(1000)
  const imageLine = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'image', source: { type: 'base64', data: img, media_type: 'image/png' } }] }] }, toolUseResult: { type: 'image', file: { base64: img, type: 'image/png' } } })
  assert.deepEqual(scanTranscriptLine(imageLine), { count: 1, bytes: 2000, sentBytes: 1000, compact: false })
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'omh-img-')), 's.jsonl')
  writeFileSync(file, imageLine + '\n' + JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }) + '\n')
  const a = await scanClaudeImages(file)
  assert.equal(a.count, 1); assert.equal(a.bytes, 2000); assert.equal(a.ctxCount, 1); assert.equal(a.ctxBytes, 1000)
  appendFileSync(file, JSON.stringify({ type: 'system', subtype: 'compact_boundary' }) + '\n' + imageLine + '\n' + '{"partial":')
  const b = await scanClaudeImages(file, a)
  assert.equal(b.count, 2); assert.equal(b.ctxCount, 1)
  // The unfinished last line is left for the next scan.
  appendFileSync(file, '1}\n')
  const c = await scanClaudeImages(file, b)
  assert.equal(c.count, 2); assert.ok(c.offset > b.offset)
})

test('hydrated transcript model is kept as response model, not the displayed model', () => {
  const store = createContextUsage({})
  store.update('r', 'Claude', { sessionId: 's', responseModel: 'deepseek-v4-1-flash-economy', usedTokens: 100 })
  assert.equal(store.snapshot('r').Claude.model, '')
  store.update('r', 'Claude', { model: 'claude-opus-5-5' })
  assert.equal(store.snapshot('r').Claude.model, 'claude-opus-5-5')
})

test('hydration picks the most recently written session among route bindings', async () => {
  const { mkdtempSync, writeFileSync, utimesSync, mkdirSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const path = (await import('node:path')).default
  // Claude transcripts are found under ~/.claude/projects; point HOME at a sandbox.
  const home = mkdtempSync(path.join(tmpdir(), 'omh-home-'))
  const projects = path.join(home, '.claude', 'projects', '-p')
  mkdirSync(projects, { recursive: true })
  const line = (model, tokens) => JSON.stringify({ type: 'assistant', timestamp: '2026-11-19T15:46:33Z', message: { model, usage: { input_tokens: tokens } } }) + '\n'
  writeFileSync(path.join(projects, 'old.jsonl'), line('deepseek-v4-1-flash-economy', 111))
  writeFileSync(path.join(projects, 'new.jsonl'), line('claude-opus-5-5', 222))
  utimesSync(path.join(projects, 'old.jsonl'), new Date(Date.now() - 86400000), new Date(Date.now() - 86400000))
  const prevHome = process.env.HOME
  process.env.HOME = home
  try {
    const store = createContextUsage({})
    await store.hydrate('r', [{ agent: 'Claude', native: 'old' }, { agent: 'Claude:route:gw.example', native: 'new' }])
    const snap = store.snapshot('r').Claude
    assert.equal(snap.usedTokens, 222)
    assert.equal(snap.measuredAt, Date.parse('2026-11-19T15:46:33Z'))
  } finally {
    process.env.HOME = prevHome
  }
})

test('antigravity desktop tool policy follows access mode', async () => {
  const { desktopToolConfig, autoApprovalPayload } = await import('../desktop/antigravity-desktop.mjs')
  const full = desktopToolConfig('full', '/p')
  assert.equal(full.autoInteractionBehavior, 1)
  assert.equal(full.permissionConfig.effectivePermissionPreset, 3)
  assert.ok(full.permissionConfig.effectiveGrants.allow.includes('read_file(*)'))
  assert.deepEqual(desktopToolConfig('workspace', '/p'), {})
  const ro = desktopToolConfig('read-only', '/p')
  assert.equal(ro.autoInteractionBehavior, 2)
  assert.deepEqual(ro.permissionConfig.effectiveGrants.allow, ['read_file(/p)'])

  const conv = { permission: { allow: true, scope: 'PERMISSION_SCOPE_CONVERSATION' } }
  assert.deepEqual(autoApprovalPayload({ kind: 'filePermission', options: [{ id: 'once', payload: { a: 1 } }, { id: 'conversation', payload: conv }] }), conv)
  assert.deepEqual(autoApprovalPayload({ kind: 'runCommand', options: [{ id: 'allow', payload: { runCommand: { confirm: true } } }] }), { runCommand: { confirm: true } })
  // Questions need the user's answer; full access must not invent one.
  assert.equal(autoApprovalPayload({ kind: 'question', options: [{ id: 'once', payload: {} }] }), null)
})
