import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, mkdir, mkdtemp, rename, rm, symlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'

const run = promisify(execFile)
export const privateDir = path.join(homedir(), 'Library', 'Application Support', 'OminiHive', 'cli')
export const managedCodex = path.join(privateDir, 'codex')
export const managedGemini = path.join(privateDir, 'gemini')
export const managedOpenCode = path.join(privateDir, 'opencode')
export const managedQwen = path.join(privateDir, 'qwen')
export const managedOpenClaw = path.join(privateDir, 'openclaw')
export const managedPi = path.join(privateDir, 'pi')
export const managedDeepSeek = path.join(privateDir, 'dsh')
export const managedMiniMax = path.join(privateDir, 'minimax')
export const managedOhMyPi = path.join(privateDir, 'omp')

const NPM_SPECS = {
  Codex: { pkg: '@openai/codex', bin: 'codex', dest: managedCodex },
  Gemini: { pkg: '@google/gemini-cli', bin: 'gemini', dest: managedGemini },
  OpenCode: { pkg: 'opencode-ai', bin: 'opencode', dest: managedOpenCode },
  Qwen: { pkg: '@qwen-code/qwen-code', bin: 'qwen', dest: managedQwen },
  OpenClaw: { pkg: 'openclaw', bin: 'openclaw', dest: managedOpenClaw },
  Pi: { pkg: '@mariozechner/pi-coding-agent', bin: 'pi', dest: managedPi },
  DeepSeek: { pkg: '@deepseek-ai/dsh', bin: 'dsh', dest: managedDeepSeek },
  MiniMax: { pkg: '@minimax-ai/minimax-code', bin: 'minimax', dest: managedMiniMax },
  OhMyPi: { pkg: '@oh-my-pi/pi-coding-agent', bin: 'omp', dest: managedOhMyPi }
}

async function findNpm(envPath) {
  for (const dir of envPath.split(':')) {
    const file = path.join(dir, 'npm')
    try { await access(file, constants.X_OK); return file } catch {}
  }
  throw Error('安装或更新需要本机的 npm，请先安装 Node.js。')
}

async function installNpmPackage(agent, target, options) {
  const spec = NPM_SPECS[agent]
  const npm = await findNpm(options.env.PATH)
  await mkdir(privateDir, { recursive: true, mode: 0o700 })
  const stage = await mkdtemp(path.join(privateDir, agent.toLowerCase() + '-install-'))
  try {
    const pkgRef = target ? `${spec.pkg}@${target}` : `${spec.pkg}@latest`
    await run(npm, ['install', '--prefix', stage, '--no-save', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org', pkgRef], { ...options, cwd: stage })
    const binary = path.join(stage, 'node_modules', '.bin', spec.bin)
    await access(binary, constants.X_OK)
    const link = path.join(stage, 'activate')
    await symlink(binary, link)
    await rename(link, spec.dest)
  } catch (e) {
    await rm(stage, { recursive: true, force: true })
    throw e
  }
}

export async function installClient(agent, executable, target, dirs) {
  if (target && !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(target)) throw Error('无效的发布版本')
  const options = { timeout: 300000, maxBuffer: 4 * 1024 * 1024, cwd: homedir(), env: { ...process.env, PATH: dirs.join(':'), CI: '1', NO_COLOR: '1' } }
  if (agent === 'Hermes') {
    return run('/bin/bash', ['-c', 'curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash'], options)
  }
  if (agent === 'OhMyPi') {
    try {
      return await run('/bin/bash', ['-c', 'curl -fsSL https://omp.sh/install | sh'], options)
    } catch {
      return installNpmPackage(agent, target, options)
    }
  }
  if (agent === 'MiniMax') {
    try {
      return await run('/bin/bash', ['-c', 'curl -fsSL https://code.minimax.io/install.sh | bash'], options)
    } catch {
      return installNpmPackage(agent, target, options)
    }
  }
  if (NPM_SPECS[agent]) return installNpmPackage(agent, target, options)
  if (agent === 'Claude') {
    if (executable) return run(executable, ['install', target || 'latest'], options)
    return run('/bin/bash', ['-c', 'curl -fsSL https://claude.ai/install.sh | bash'], options)
  }
  if (agent === 'Kimi') {
    return run('/bin/bash', ['-c', 'curl -LsSf https://code.kimi.com/install.sh | bash'], options)
  }
  if (agent === 'Antigravity') {
    if (!executable) throw Error('请先安装 Antigravity 应用或 agy CLI')
    return run(executable, ['update'], options)
  }
  throw Error('不支持的 CLI')
}
