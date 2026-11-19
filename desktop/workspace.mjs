import { existsSync, readdirSync, readFileSync, statSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const IGNORE_NAMES = new Set(['node_modules', '.git', '.DS_Store', 'dist', '.next', '__pycache__', '.turbo', '.cache'])
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.bmp', '.ico'])
const TEXT_EXTS = new Set([
  '.md', '.mdx', '.txt', '.json', '.jsonl', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.css', '.scss', '.html', '.xml', '.yml', '.yaml', '.toml', '.ini', '.env', '.sh', '.zsh',
  '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.sql', '.csv', '.log', '.gitignore'
])

function safeResolve(rootDir, targetPath = '') {
  const root = realpathSync(rootDir)
  const resolved = path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(root, targetPath)
  const rel = path.relative(root, resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw Error('无权访问项目目录之外的文件')
  return { root, resolved, rel }
}

export function listFiles(rootDir, relDir = '') {
  const { resolved } = safeResolve(rootDir, relDir)
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) return []
  const entries = readdirSync(resolved, { withFileTypes: true })
  const out = []
  for (const ent of entries) {
    if (IGNORE_NAMES.has(ent.name)) continue
    const full = path.join(resolved, ent.name)
    let isDir = ent.isDirectory()
    let size = 0
    try {
      const st = statSync(full)
      isDir = st.isDirectory()
      size = st.size
    } catch { continue }
    out.push({
      name: ent.name,
      path: full,
      relPath: path.relative(rootDir, full),
      isDir,
      size,
      ext: isDir ? '' : path.extname(ent.name).toLowerCase()
    })
  }
  return out.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, 'zh-CN') : a.isDir ? -1 : 1))
}

export function previewFile(rootDir, filePath) {
  const { resolved } = safeResolve(rootDir, filePath)
  if (!existsSync(resolved)) throw Error('文件不存在')
  const st = statSync(resolved)
  if (st.isDirectory()) throw Error('不支持直接预览文件夹')
  const name = path.basename(resolved)
  const ext = path.extname(name).toLowerCase()

  if (IMAGE_EXTS.has(ext)) {
    if (st.size > 15 * 1024 * 1024) return { kind: 'binary', name, path: resolved, size: st.size, note: '图片超过 15MB，请用系统应用打开' }
    const mime = ext === '.svg' ? 'image/svg+xml' : ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg'
    const base64 = readFileSync(resolved).toString('base64')
    return { kind: 'image', name, path: resolved, size: st.size, dataUrl: `data:${mime};base64,${base64}` }
  }

  if (ext === '.pdf') {
    if (st.size > 30 * 1024 * 1024) return { kind: 'binary', name, path: resolved, size: st.size, note: 'PDF 超过 30MB，请用系统应用打开' }
    const base64 = readFileSync(resolved).toString('base64')
    return { kind: 'pdf', name, path: resolved, size: st.size, dataUrl: `data:application/pdf;base64,${base64}` }
  }

  if (TEXT_EXTS.has(ext) || st.size < 256 * 1024) {
    const buf = readFileSync(resolved)
    const slice = buf.subarray(0, 262144)
    if (!slice.includes(0)) {
      return {
        kind: ext === '.md' || ext === '.mdx' ? 'markdown' : 'text',
        name,
        path: resolved,
        ext,
        size: st.size,
        truncated: buf.length > 262144,
        content: slice.toString('utf8')
      }
    }
  }

  return { kind: 'binary', name, path: resolved, size: st.size }
}

function parseSkillMeta(skillMdPath, fallbackName) {
  try {
    const raw = readFileSync(skillMdPath, 'utf8').slice(0, 4096)
    const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] || ''
    const nameMatch = fm.match(/^name:\s*['"]?(.+?)['"]?\s*$/m)
    const descMatch = fm.match(/^description:\s*['"]?(.+?)['"]?\s*$/m)
    return {
      name: (nameMatch?.[1] || fallbackName).trim(),
      description: (descMatch?.[1] || '').trim()
    }
  } catch {
    return { name: fallbackName, description: '' }
  }
}

function scanSkillsDir(dir, source) {
  if (!dir || !existsSync(dir)) return []
  const items = []
  try {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith('.') || ent.name === '_shared') continue
      const full = path.join(dir, ent.name)
      let isDir = false
      try { isDir = statSync(full).isDirectory() } catch { continue }
      if (isDir) {
        const md = path.join(full, 'SKILL.md')
        if (existsSync(md)) {
          const meta = parseSkillMeta(md, ent.name)
          items.push({ id: `${source}:${meta.name}`, name: meta.name, description: meta.description, source, path: md })
        }
      } else if (ent.name.endsWith('.md') && ent.name !== 'README.md') {
        const base = ent.name.replace(/\.md$/i, '')
        const meta = parseSkillMeta(full, base)
        items.push({ id: `${source}:${meta.name}`, name: meta.name, description: meta.description, source, path: full })
      }
    }
  } catch {}
  return items
}

function scanAntigravityPlugins() {
  const pluginsRoot = path.join(homedir(), '.gemini', 'config', 'plugins')
  const items = []
  if (!existsSync(pluginsRoot)) return items
  try {
    for (const p of readdirSync(pluginsRoot, { withFileTypes: true })) {
      if (!p.isDirectory()) continue
      items.push(...scanSkillsDir(path.join(pluginsRoot, p.name, 'skills'), '插件/' + p.name))
    }
  } catch {}
  return items
}

function dedupSkills(lists) {
  const seen = new Map()
  for (const item of lists.flat()) {
    if (!seen.has(item.name)) seen.set(item.name, item)
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function listAgentSkills(projectDir = '') {
  const home = homedir()
  const proj = projectDir && existsSync(projectDir) ? projectDir : ''

  return {
    Codex: dedupSkills([
      proj ? scanSkillsDir(path.join(proj, '.codex', 'skills'), '项目') : [],
      proj ? scanSkillsDir(path.join(proj, '.agents', 'skills'), '项目') : [],
      scanSkillsDir(path.join(home, '.codex', 'skills'), 'Codex'),
      scanSkillsDir(path.join(home, '.agents', 'skills'), 'Agents')
    ]),
    Claude: dedupSkills([
      proj ? scanSkillsDir(path.join(proj, '.claude', 'skills'), '项目') : [],
      proj ? scanSkillsDir(path.join(proj, '.claude', 'commands'), '项目命令') : [],
      scanSkillsDir(path.join(home, '.claude', 'skills'), 'Claude'),
      scanSkillsDir(path.join(home, '.claude', 'commands'), 'Claude命令')
    ]),
    Antigravity: dedupSkills([
      proj ? scanSkillsDir(path.join(proj, '.agent', 'skills'), '项目') : [],
      scanSkillsDir(path.join(home, '.gemini', 'antigravity', 'skills'), 'Antigravity'),
      scanSkillsDir(path.join(home, '.gemini', 'antigravity', 'builtin', 'skills'), '内置'),
      scanAntigravityPlugins()
    ]),
    Gemini: dedupSkills([
      proj ? scanSkillsDir(path.join(proj, '.gemini', 'skills'), '项目') : [],
      scanSkillsDir(path.join(home, '.gemini', 'skills'), 'Gemini')
    ]),
    OpenCode: dedupSkills([
      proj ? scanSkillsDir(path.join(proj, '.opencode', 'skills'), '项目') : [],
      scanSkillsDir(path.join(home, '.config', 'opencode', 'skills'), 'OpenCode')
    ]),
    Kimi: dedupSkills([
      proj ? scanSkillsDir(path.join(proj, '.kimi', 'skills'), '项目') : [],
      scanSkillsDir(path.join(home, '.kimi', 'skills'), 'Kimi')
    ]),
    Qwen: dedupSkills([
      proj ? scanSkillsDir(path.join(proj, '.qwen', 'skills'), '项目') : [],
      scanSkillsDir(path.join(home, '.qwen', 'skills'), 'Qwen')
    ]),
    OpenClaw: dedupSkills([
      scanSkillsDir(path.join(home, '.openclaw', 'skills'), 'OpenClaw')
    ]),
    Grok: dedupSkills([
      scanSkillsDir(path.join(home, '.grok', 'skills'), 'Grok')
    ])
  }
}
