import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, realpathSync, openSync, readSync, closeSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const IGNORE_NAMES = new Set(['node_modules', '.git', '.DS_Store', '.ominihive', 'dist', '.next', '__pycache__', '.turbo', '.cache'])
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.bmp', '.ico'])
const OFFICE_EXTS = new Set(['.pptx', '.ppt', '.docx', '.doc', '.xlsx', '.xls', '.odp', '.odt', '.ods'])
const QUICKLOOK_EXTS = new Set(['.key', '.pages', '.numbers', '.heic', '.tiff', '.tif', '.psd'])
const TEXT_EXTS = new Set([
  '.md', '.mdx', '.txt', '.json', '.jsonl', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.css', '.scss', '.html', '.xml', '.yml', '.yaml', '.toml', '.ini', '.env', '.sh', '.zsh',
  '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.sql', '.csv', '.log', '.gitignore'
])

function findSoffice() {
  const candidates = [
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    path.join(homedir(), '.local', 'bin', 'soffice'),
    '/opt/homebrew/bin/soffice',
    '/usr/local/bin/soffice'
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return ''
}

function safeResolve(rootDir, targetPath = '') {
  const root = realpathSync(rootDir)
  const resolved = path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(root, targetPath)
  const rel = path.relative(root, resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw Error('无权访问项目目录之外的文件')
  return { root, resolved, rel }
}

export function resolveLocalFilePath(rootDir, rawPath = '') {
  let target = String(rawPath || '').trim()
  if (!target) return ''
  if (/^file:\/\//i.test(target)) {
    try {
      target = fileURLToPath(target)
    } catch {
      target = decodeURIComponent(target.replace(/^file:\/\//i, ''))
    }
  } else if (/%[0-9A-Fa-f]{2}/.test(target)) {
    try {
      const decoded = decodeURIComponent(target)
      if (!existsSync(target) && existsSync(decoded)) target = decoded
    } catch {}
  }
  if (target === '~' || target.startsWith('~/')) {
    target = path.join(homedir(), target.slice(2))
  }
  const resolveBase = p => (path.isAbsolute(p) ? path.resolve(p) : (rootDir ? path.resolve(rootDir, p) : path.resolve(p)))
  let resolved = resolveBase(target)
  if (!existsSync(resolved)) {
    // Strip optional `#L10-L20` or `:10:5` line suffixes when the raw path itself does not exist
    const stripped = target.replace(/(?:#L?\d+(?:-L?\d+)?|:\d+(?::\d+)?)$/i, '')
    if (stripped && stripped !== target) {
      const candidate = resolveBase(stripped)
      if (existsSync(candidate)) resolved = candidate
    }
  }
  return resolved
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

async function convertOfficeToPdf(resolved, st) {
  const soffice = findSoffice()
  if (!soffice) return ''
  const key = createHash('sha1').update(`${resolved}:${st.mtimeMs}:${st.size}`).digest('hex').slice(0, 16)
  const cacheDir = path.join(tmpdir(), 'ominihive-preview-cache', key)
  mkdirSync(cacheDir, { recursive: true })
  const baseName = path.basename(resolved, path.extname(resolved))
  const expectedPdf = path.join(cacheDir, baseName + '.pdf')
  if (existsSync(expectedPdf)) return expectedPdf
  const profileDir = path.join(tmpdir(), 'ominihive-lo-profile')
  mkdirSync(profileDir, { recursive: true })
  try {
    await execFileAsync(
      soffice,
      [
        `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
        '--headless',
        '--nologo',
        '--nofirststartwizard',
        '--convert-to', 'pdf',
        '--outdir', cacheDir,
        resolved
      ],
      { timeout: 45000 }
    )
    if (existsSync(expectedPdf)) return expectedPdf
    const found = readdirSync(cacheDir).find(f => f.toLowerCase().endsWith('.pdf'))
    return found ? path.join(cacheDir, found) : ''
  } catch {
    return ''
  }
}

async function renderQuickLookPng(resolved, st) {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/qlmanage')) return ''
  const key = createHash('sha1').update(`ql:${resolved}:${st.mtimeMs}:${st.size}`).digest('hex').slice(0, 16)
  const cacheDir = path.join(tmpdir(), 'ominihive-preview-cache', key)
  mkdirSync(cacheDir, { recursive: true })
  const existing = readdirSync(cacheDir).find(f => f.toLowerCase().endsWith('.png'))
  if (existing) return path.join(cacheDir, existing)
  try {
    await execFileAsync('/usr/bin/qlmanage', ['-t', '-s', '1600', '-o', cacheDir, resolved], { timeout: 15000 })
    const found = readdirSync(cacheDir).find(f => f.toLowerCase().endsWith('.png'))
    return found ? path.join(cacheDir, found) : ''
  } catch {
    return ''
  }
}

const TEXT_PREVIEW_BYTES = 262144
// Credential stores that a link in agent output must never surface in the preview pane.
const SENSITIVE_DIRS = ['.ssh', '.gnupg', '.aws', '.kube', '.docker', '.config/gcloud', 'Library/Keychains', 'Library/Cookies']
// Opening these with the default app runs code; reveal them in Finder instead.
const EXECUTABLE_EXTS = new Set(['.app', '.command', '.tool', '.sh', '.zsh', '.bash', '.csh', '.fish', '.terminal', '.workflow', '.scpt', '.scptd', '.applescript', '.jar', '.pkg', '.mpkg', '.action', '.prefpane', '.webloc', '.inetloc', '.fileloc'])

export function isSensitivePath(resolved) {
  let real = resolved
  try { real = realpathSync(resolved) } catch {}
  if (real === '/dev' || real.startsWith('/dev/')) return true
  const home = homedir()
  return SENSITIVE_DIRS.some(d => {
    const dir = path.join(home, d)
    return real === dir || real.startsWith(dir + path.sep)
  })
}

/** True when handing this path to the OS "open" action would execute something. */
export function opensAsProgram(resolved) {
  const ext = path.extname(resolved).toLowerCase()
  if (EXECUTABLE_EXTS.has(ext)) return true
  try {
    const st = statSync(resolved)
    if (st.isDirectory()) return false
    // A plain file with an exec bit and no document extension is a script or binary.
    return st.isFile() && (st.mode & 0o111) !== 0 && !ext
  } catch {
    return false
  }
}

function readHead(file, maxBytes) {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(maxBytes)
    const n = readSync(fd, buf, 0, maxBytes, 0)
    return buf.subarray(0, n)
  } finally {
    closeSync(fd)
  }
}

export async function previewFile(rootDir, filePath) {
  const resolved = resolveLocalFilePath(rootDir, filePath)
  if (!resolved || !existsSync(resolved)) throw Error('文件不存在：' + (resolved || filePath))
  const st = statSync(resolved)
  if (st.isDirectory()) throw Error('不支持直接预览文件夹')
  // FIFOs, sockets and device files would block the main process on read.
  if (!st.isFile()) throw Error('不是普通文件，无法预览')
  if (isSensitivePath(resolved)) throw Error('出于安全考虑，不预览凭据或系统目录中的文件')
  const name = path.basename(resolved)
  const ext = path.extname(name).toLowerCase()

  if (IMAGE_EXTS.has(ext)) {
    if (st.size > 15 * 1024 * 1024) return { kind: 'binary', name, path: resolved, size: st.size, note: '图片超过 15MB，请用系统应用打开' }
    const mime = ext === '.svg' ? 'image/svg+xml' : ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg'
    const base64 = (await readFile(resolved)).toString('base64')
    return { kind: 'image', name, path: resolved, size: st.size, dataUrl: `data:${mime};base64,${base64}` }
  }

  if (ext === '.pdf') {
    return { kind: 'pdf', name, path: resolved, size: st.size, pdfFilePath: resolved }
  }

  if (OFFICE_EXTS.has(ext)) {
    // Fast path: reuse an up-to-date sibling .pdf with the same basename if present
    const siblingPdf = resolved.slice(0, -ext.length) + '.pdf'
    if (existsSync(siblingPdf)) {
      try {
        const sibSt = statSync(siblingPdf)
        if (sibSt.isFile() && sibSt.mtimeMs >= st.mtimeMs - 5000) {
          return { kind: 'pdf', name, path: resolved, size: st.size, pdfFilePath: siblingPdf }
        }
      } catch {}
    }
    if (st.size <= 120 * 1024 * 1024) {
      const pdfPath = await convertOfficeToPdf(resolved, st)
      if (pdfPath && existsSync(pdfPath)) {
        return { kind: 'pdf', name, path: resolved, size: st.size, pdfFilePath: pdfPath }
      }
      const pngPath = await renderQuickLookPng(resolved, st)
      if (pngPath && existsSync(pngPath)) {
        const base64 = (await readFile(pngPath)).toString('base64')
        return { kind: 'image', name, path: resolved, size: st.size, dataUrl: `data:image/png;base64,${base64}` }
      }
    }
    return { kind: 'binary', name, path: resolved, size: st.size, note: '转换预览失败或文件过大，可点击右上角用系统应用打开。' }
  }

  if (QUICKLOOK_EXTS.has(ext)) {
    const pngPath = await renderQuickLookPng(resolved, st)
    if (pngPath && existsSync(pngPath)) {
      const base64 = (await readFile(pngPath)).toString('base64')
      return { kind: 'image', name, path: resolved, size: st.size, dataUrl: `data:image/png;base64,${base64}` }
    }
  }

  if (TEXT_EXTS.has(ext) || st.size < TEXT_PREVIEW_BYTES) {
    // Only the head is shown, so never pull a multi-GB log into memory.
    const slice = readHead(resolved, TEXT_PREVIEW_BYTES)
    if (!slice.includes(0)) {
      return {
        kind: ext === '.md' || ext === '.mdx' ? 'markdown' : 'text',
        name,
        path: resolved,
        ext,
        size: st.size,
        truncated: st.size > TEXT_PREVIEW_BYTES,
        content: slice.toString('utf8')
      }
    }
  }

  return { kind: 'binary', name, path: resolved, size: st.size }
}

export async function getGitStatus(rootDir) {
  if (!rootDir || !existsSync(rootDir)) return { isRepo: false, branch: '', files: {}, dirs: {}, changes: [] }
  try {
    const [{ stdout: statusOut }, branchRes] = await Promise.all([
      execFileAsync('git', ['-C', rootDir, '-c', 'core.quotepath=false', 'status', '--porcelain', '-uall'], { timeout: 2500, maxBuffer: 4 * 1024 * 1024 }),
      execFileAsync('git', ['-C', rootDir, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 1500 }).catch(() => ({ stdout: '' }))
    ])
    const files = {}
    const dirs = {}
    const changes = []
    for (const rawLine of statusOut.split(/\r?\n/)) {
      if (!rawLine || rawLine.length < 4) continue
      const xy = rawLine.slice(0, 2)
      let rel = rawLine.slice(3).trim()
      if (rel.includes(' -> ')) rel = rel.split(' -> ').pop().trim()
      if ((rel.startsWith('"') && rel.endsWith('"'))) rel = rel.slice(1, -1)
      rel = rel.replace(/\\/g, '/')
      let code = 'M'
      if (xy === '??') code = 'U'
      else if (xy.includes('D')) code = 'D'
      else if (xy.includes('A')) code = 'A'
      else if (xy.includes('R')) code = 'R'
      files[rel] = code
      const fullPath = path.resolve(rootDir, rel)
      const name = path.basename(rel)
      changes.push({
        name,
        path: fullPath,
        relPath: rel,
        isDir: false,
        size: 0,
        ext: path.extname(name).toLowerCase(),
        gitStatus: code
      })
      const parts = rel.split('/')
      for (let i = 1; i < parts.length; i++) {
        const dirRel = parts.slice(0, i).join('/')
        dirs[dirRel] = true
      }
    }
    return {
      isRepo: true,
      branch: (branchRes.stdout || '').trim(),
      files,
      dirs,
      changes
    }
  } catch {
    return { isRepo: false, branch: '', files: {}, dirs: {}, changes: [] }
  }
}

function parseSkillMeta(skillMdPath, fallbackName) {
  try {
    const raw = readFileSync(skillMdPath, 'utf8').slice(0, 4096)
    const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] || ''
    const nameMatch = fm.match(/^name:\s*['"]?(.+?)['"]?\s*$/m)
    let description = ''
    const descMatch = fm.match(/^description:\s*(.*)$/m)
    if (descMatch) {
      const first = descMatch[1].trim()
      if (/^[>|][+-]?$/.test(first)) {
        const rest = fm.slice((descMatch.index ?? 0) + descMatch[0].length)
        const lines = []
        for (const line of rest.split(/\r?\n/).slice(1)) {
          if (!line.trim()) { if (lines.length) break; continue }
          if (!/^[ \t]+/.test(line)) break
          lines.push(line.trim())
        }
        description = lines.join(' ').trim()
      } else {
        description = first.replace(/^['"]|['"]$/g, '').trim()
      }
    }
    return {
      name: (nameMatch?.[1] || fallbackName).trim(),
      description
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
