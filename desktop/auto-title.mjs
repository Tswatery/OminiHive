import { spawn } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

export const TITLE_MODEL = 'gpt-6.1-terra'
const MAX_TITLE = 24

// Normalises a model/native title: first line, no wrapping quotes, labels or trailing punctuation.
export function cleanTitle(raw = '') {
  let s = String(raw || '').split(/\r?\n/).map(l => l.trim()).find(Boolean) || ''
  s = s.replace(/^(?:标题|题目|title)\s*[:：]\s*/i, '')
  for (let prev = ''; prev !== s;) {
    prev = s
    s = s.replace(/^[\s"'“”‘’「」『』《》【】`*#]+|[\s"'“”‘’「」『』《》【】`*]+$/g, '')
    s = s.replace(/[。．.！!？?，,;；:：、]+$/, '').trim()
  }
  return s.slice(0, MAX_TITLE)
}

const compact = s => String(s || '').replace(/^(?:@[\w-]+\s+)+/, '').replace(/\s+/g, '').toLowerCase()

// A native client title only counts as "smart" when it isn't just the user's message echoed back.
export function looksLikeSmartTitle(title, task = '') {
  const t = String(title || '').trim()
  if (t.length < 2 || t.length > 40 || /[<>\n]/.test(t)) return false
  const ct = compact(t), task0 = compact(task)
  if (!task0) return true
  return !(task0.startsWith(ct) || ct.startsWith(task0.slice(0, Math.min(task0.length, 12))))
}

export function buildTitlePrompt(task, reply = '') {
  const user = String(task || '').replace(/^(?:@[\w-]+\s+)+/, '').trim().slice(0, 1200)
  const answer = String(reply || '').trim().slice(0, 800)
  return [
    '你是对话标题生成器。根据下面这段多 Agent 讨论的开头，生成一个简短的中文标题，概括讨论主题。',
    '要求：不超过 16 个字；名词短语，例如“客户端项目同步修复”；不要引号、书名号和句末标点；只输出标题本身。',
    '',
    '【用户】',
    user,
    ...(answer ? ['', '【回复摘录】', answer] : [])
  ].join('\n')
}

function runCodexExec({ exe, env, prompt, model, lean, timeoutMs }) {
  return new Promise(resolve => {
    let dir
    try { dir = mkdtempSync(path.join(tmpdir(), 'ominihive-title-')) } catch { return resolve('') }
    const out = path.join(dir, 'title.txt')
    const args = ['exec', '--ephemeral', '--skip-git-repo-check', '-m', model,
      '-c', 'model_reasoning_effort="low"', '-s', 'read-only', '-C', dir, '-o', out]
    // Lean mode skips user config, rules and AGENTS.md: roughly half the tokens and time.
    if (lean) args.push('--ignore-user-config', '--ignore-rules', '-c', 'project_doc_max_bytes=0')
    args.push('-')
    let child
    const done = text => {
      clearTimeout(timer)
      try { child?.kill('SIGTERM') } catch {}
      try { rmSync(dir, { recursive: true, force: true }) } catch {}
      resolve(text)
    }
    const timer = setTimeout(() => done(''), timeoutMs)
    try {
      child = spawn(exe, args, { cwd: dir, env, stdio: ['pipe', 'ignore', 'ignore'] })
    } catch {
      return done('')
    }
    child.once('error', () => done(''))
    child.once('close', code => {
      let text = ''
      if (code === 0) { try { text = readFileSync(out, 'utf8') } catch {} }
      done(text)
    })
    child.stdin.end(prompt)
  })
}

export async function generateTitleWithCodex({ exe, env = process.env, task, reply = '', model = TITLE_MODEL, timeoutMs = 60000 }) {
  if (!exe || !String(task || '').trim()) return ''
  const prompt = buildTitlePrompt(task, reply)
  // Users routing Codex through a custom provider need their config, so fall back to it.
  for (const lean of [true, false]) {
    const title = cleanTitle(await runCodexExec({ exe, env, prompt, model, lean, timeoutMs }))
    if (title.length >= 2) return title
  }
  return ''
}

function endsWithNewline(file) {
  try {
    const size = statSync(file).size
    if (!size) return true
    const fd = openSync(file, 'r')
    try {
      const buf = Buffer.alloc(1)
      readSync(fd, buf, 0, 1, size - 1)
      return buf[0] === 0x0a
    } finally { closeSync(fd) }
  } catch { return true }
}

// Claude Code keeps titles as transcript records: `ai-title` for generated ones, `custom-title` for user renames.
export function appendClaudeTitle(file, sessionId, title, { custom = false } = {}) {
  if (!file || !sessionId || !title) return false
  const rec = custom
    ? { type: 'custom-title', customTitle: title, sessionId }
    : { type: 'ai-title', aiTitle: title, sessionId }
  appendFileSync(file, (endsWithNewline(file) ? '' : '\n') + JSON.stringify(rec) + '\n')
  return true
}
