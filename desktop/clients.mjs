import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { accessSync, constants, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import {
  managedCodex, managedGemini, managedOpenCode, managedQwen, managedOpenClaw, installClient
} from './upgrade.mjs'

const run = promisify(execFile)
export const names = {
  Codex: 'codex',
  Claude: 'claude',
  Antigravity: 'agy',
  Gemini: 'gemini',
  OpenCode: 'opencode',
  Kimi: 'kimi',
  Qwen: 'qwen',
  OpenClaw: 'openclaw',
  Grok: 'grok'
}

export const installHints = {
  Codex: '通过 npm (@openai/codex) 安装',
  Claude: '通过官方安装脚本 / claude install 安装',
  Antigravity: '通过 agy CLI 更新',
  Gemini: '通过 npm (@google/gemini-cli) 安装',
  OpenCode: '通过 npm (opencode-ai) 安装',
  Kimi: '通过官方脚本 (code.kimi.com) 安装',
  Qwen: '通过 npm (@qwen-code/qwen-code) 安装',
  OpenClaw: '通过 npm (openclaw) 安装',
  Grok: '本机 Grok Build CLI'
}

export const dirs = [
  path.join(homedir(), '.local/bin'),
  path.join(homedir(), '.kimi-code/bin'),
  path.join(homedir(), '.opencode/bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  ...(process.env.PATH || '').split(':').filter(path.isAbsolute)
]

const bundled = 'ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'
const releases = {
  Codex: 'https://api.github.com/repos/openai/codex/releases/latest',
  Claude: 'https://downloads.claude.ai/claude-code-releases/latest',
  Antigravity: 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/darwin_' + (process.arch === 'arm64' ? 'arm64' : 'amd64') + '.json',
  Gemini: 'https://registry.npmjs.org/@google/gemini-cli/latest',
  OpenCode: 'https://registry.npmjs.org/opencode-ai/latest',
  Qwen: 'https://registry.npmjs.org/@qwen-code/qwen-code/latest',
  OpenClaw: 'https://registry.npmjs.org/openclaw/latest'
}

let installed = {}, initial, checking, last = []
const version = s => s.match(/\d+\.\d+\.\d+(?:-[\w.-]+)?/)?.[0]

function compare(a, b) {
  const [core, pre] = a.split('-'), [other, suffix] = b.split('-')
  for (let i = 0; i < 3; i++) {
    const diff = Number(core.split('.')[i]) - Number(other.split('.')[i])
    if (diff) return diff
  }
  if (!pre || !suffix) return Number(!pre) - Number(!suffix)
  return pre.localeCompare(suffix, 'en', { numeric: true })
}

async function discover(agent) {
  const candidates = dirs.map(dir => path.join(dir, names[agent]))
  if (agent === 'Codex') {
    candidates.unshift(managedCodex)
    candidates.push('/Applications/' + bundled, path.join(homedir(), 'Applications', bundled))
  }
  if (agent === 'Gemini') candidates.unshift(managedGemini)
  if (agent === 'OpenCode') candidates.unshift(managedOpenCode)
  if (agent === 'Qwen') candidates.unshift(managedQwen)
  if (agent === 'OpenClaw') candidates.unshift(managedOpenClaw)

  const seen = new Set()
  const rows = await Promise.all(candidates.map(async file => {
    try {
      accessSync(file, constants.X_OK)
      const real = realpathSync(file)
      if (seen.has(real)) return
      seen.add(real)
      const { stdout } = await run(file, ['--version'], { timeout: 4000, env: { ...process.env, PATH: dirs.join(':') } })
      const current = version(stdout)
      if (current) return { path: file, version: current }
    } catch {}
  }))
  return rows.filter(Boolean).sort((a, b) => compare(b.version, a.version))
}

const upgrading = new Set()
const outcomes = new Map()
const scans = new Map()
export const isUpgrading = agent => upgrading.has(agent)

function clientRow(agent) {
  const candidates = installed[agent] || []
  const check = last.find(r => r.agent === agent)?.check
  const current = candidates[0]?.version
  const status = check?.latest
    ? (current ? (compare(check.latest, current) > 0 ? '有新版' : '已是最新或更高') : '未安装')
    : (current ? check?.status : '未安装')
  return {
    agent,
    hint: installHints[agent],
    canInstall: agent !== 'Antigravity' && agent !== 'Grok',
    candidates,
    ...check,
    status,
    installing: isUpgrading(agent),
    outcome: outcomes.get(agent)
  }
}

async function scan(agent) {
  const token = Symbol()
  scans.set(agent, token)
  const found = await discover(agent)
  if (scans.get(agent) === token) installed[agent] = found
  return found
}

export async function inventory() {
  await Promise.all(Object.keys(names).map(scan))
  return Object.keys(names).map(clientRow)
}

export function initClients() { return initial ??= inventory() }
export function binary(agent) { return installed[agent]?.[0]?.path }
export const availability = () => Object.fromEntries(Object.keys(names).map(a => [a, Boolean(binary(a))]))

export async function updates() {
  if (checking) return checking
  checking = (async () => {
    const rows = await inventory()
    last = await Promise.all(rows.map(async row => {
      if (!releases[row.agent]) {
        return { agent: row.agent, check: { status: row.candidates.length ? '本地已安装' : '未安装', checked: new Date().toISOString() } }
      }
      let check
      try {
        const { stdout } = await run('/usr/bin/curl', ['-fsSL', '--max-time', '10', releases[row.agent]], { timeout: 12000, maxBuffer: 1048576 })
        const raw = row.agent === 'Claude'
          ? stdout
          : JSON.parse(stdout)[row.agent === 'Codex' ? 'tag_name' : 'version']
        const latest = version(raw)
        if (!latest) throw Error()
        const current = row.candidates[0]?.version
        check = { latest, status: current ? (compare(latest, current) > 0 ? '有新版' : '已是最新或更高') : '未安装' }
      } catch {
        check = { status: '查询失败，可重试' }
      }
      return { agent: row.agent, check: { ...check, checked: new Date().toISOString() } }
    }))
    return Object.keys(names).map(clientRow)
  })()
  try { return await checking } finally { checking = null }
}

export async function upgrade(agent, notify) {
  if (!Object.hasOwn(names, agent)) throw Error('未知的 CLI')
  if (isUpgrading(agent)) throw Error(agent + ' 正在安装或更新')
  upgrading.add(agent)
  outcomes.delete(agent)
  try {
    notify(clientRow(agent))
    const candidates = await scan(agent)
    const row = clientRow(agent)
    const target = row.latest || ''
    await installClient(agent, candidates[0]?.path, target, dirs)
    const current = (await scan(agent))[0]?.version
    if (!current) throw Error('安装完成但未能检测到可执行版本，请检查环境')
    outcomes.set(agent, { message: (candidates.length ? '已更新至 ' : '已安装 ') + current })
  } catch (e) {
    const detail = String(e.stderr || e.stdout || e.message).trim().slice(-480)
    outcomes.set(agent, { error: true, message: '操作失败：' + detail })
    throw Error(detail)
  } finally {
    upgrading.delete(agent)
    notify(clientRow(agent))
  }
}
