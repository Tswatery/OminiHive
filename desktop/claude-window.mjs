// Claude's context window for a model, read from the local `/context` command.
// In print mode `/context` is answered by the CLI itself: no model call, no cost,
// and with --no-session-persistence it leaves no transcript behind.
import { execFile } from 'node:child_process'
import { mkdirSync, realpathSync, rmSync, readdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

function toTokens(num, unit) {
  const n = Number(num)
  if (!Number.isFinite(n) || n <= 0) return 0
  const u = String(unit || '').toLowerCase()
  return Math.round(u === 'm' ? n * 1_000_000 : u === 'k' ? n * 1000 : n)
}

/** `**Tokens:** 9.7k / 1m (1%)` → { usedTokens, windowTokens } */
export function parseClaudeContextReport(text) {
  const m = String(text || '').match(/Tokens:\**\s*([\d.,]+)\s*([kKmM]?)\s*\/\s*([\d.,]+)\s*([kKmM]?)/)
  if (!m) return null
  const windowTokens = toTokens(m[3].replace(/,/g, ''), m[4])
  if (!windowTokens) return null
  return { usedTokens: toTokens(m[1].replace(/,/g, ''), m[2]), windowTokens }
}

export async function probeClaudeWindow({ exe, env, model }) {
  if (!exe || !model) return 0
  const dir = path.join(tmpdir(), 'ominihive-claude-probe')
  mkdirSync(dir, { recursive: true })
  try {
    const { stdout } = await run(exe, ['-p', '/context', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config', '--model', model], {
      cwd: dir, env, timeout: 30000, maxBuffer: 2 * 1024 * 1024
    })
    const result = JSON.parse(stdout)
    // A zero-turn, zero-cost reply proves the CLI answered locally instead of prompting the model.
    if (result?.num_turns > 0) return 0
    return parseClaudeContextReport(result?.result)?.windowTokens || 0
  } catch {
    return 0
  } finally {
    // The CLI still creates an (empty) project folder for the probe directory.
    try {
      const real = realpathSync(dir)
      const projectDir = path.join(homedir(), '.claude', 'projects', real.replace(/[^a-zA-Z0-9]/g, '-'))
      const left = readdirSync(projectDir, { recursive: true }).filter(f => /\.jsonl$/.test(String(f)))
      if (!left.length) rmSync(projectDir, { recursive: true, force: true })
    } catch {}
  }
}
