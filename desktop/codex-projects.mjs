import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

function normalizeDir(p) {
  if (!p || typeof p !== 'string') return ''
  const resolved = path.resolve(p)
  try { return realpathSync(resolved) } catch { return resolved }
}

function sameDir(a, b) {
  if (!a || !b) return false
  if (a === b) return true
  return process.platform === 'darwin' && a.toLowerCase() === b.toLowerCase()
}

const hasRoots = p => Array.isArray(p?.roots) && p.roots.some(r => r?.path)

export async function ensureCodexProject(request, cwd, projectName = '') {
  const normCwd = normalizeDir(cwd)
  if (!normCwd) return null
  const targetName = String(projectName || '').trim() || path.basename(normCwd) || '未命名项目'

  const projects = []
  let cursor = null
  for (let page = 0; page < 10; page++) {
    const res = await request('project/list', { limit: 100, ...(cursor ? { cursor } : {}) })
    if (Array.isArray(res?.data)) projects.push(...res.data)
    cursor = res?.nextCursor || null
    if (!cursor) break
  }

  // 1. A project whose roots already contain this folder.
  for (const p of projects) {
    const roots = Array.isArray(p?.roots) ? p.roots : []
    if (roots.some(r => sameDir(normalizeDir(r?.path || ''), normCwd))) {
      return { projectId: p.id, name: p.name, created: false, updated: false }
    }
  }

  // 2. A same-name project that has no folder yet: attach this folder to it.
  //    Same-name projects that are already bound to other folders are left alone,
  //    otherwise unrelated folders that happen to share a name (src, docs…) get merged.
  const nameMatch = projects.find(p => !hasRoots(p) && String(p?.name || '').trim().toLowerCase() === targetName.toLowerCase())
  if (nameMatch?.id) {
    await request('project/update', { projectId: nameMatch.id, roots: [{ path: normCwd }] })
    return { projectId: nameMatch.id, name: nameMatch.name, created: false, updated: true }
  }

  // 3. Create a new project bound to the folder.
  const create = idempotencyKey => request('project/create', { name: targetName, roots: [{ path: normCwd }], idempotencyKey })
  let created
  try {
    created = await create(`ominihive:${normCwd}`)
  } catch (err) {
    // The stable key still points at a project the user deleted in Codex; use a fresh key.
    if (!/idempotency key/i.test(String(err?.message || ''))) throw err
    created = await create(`ominihive:${normCwd}:${randomUUID()}`)
  }
  const project = created?.project
  if (!project?.id) return null
  return { projectId: project.id, name: project.name || targetName, created: true, updated: false }
}

// Runs `fn(request)` against a short-lived `codex app-server`, for work done outside an agent turn.
export function withCodexAppServer({ exe, cwd, env = process.env, timeoutMs = 12000 }, fn) {
  if (!exe) return Promise.resolve(null)
  return new Promise(resolve => {
    let settled = false
    let child
    let rl
    const finish = val => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { rl?.close() } catch {}
      try { child?.stdin?.end() } catch {}
      try { child?.kill('SIGTERM') } catch {}
      resolve(val)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    timer.unref?.()

    try {
      child = spawn(exe, ['app-server', '--stdio'], { cwd: cwd || undefined, env, stdio: ['pipe', 'pipe', 'ignore'] })
    } catch {
      finish(null)
      return
    }
    child.once('error', () => finish(null))
    child.once('close', () => finish(null))

    let seq = 0
    const pending = new Map()
    rl = readline.createInterface({ input: child.stdout })
    rl.on('line', line => {
      if (!line.trim()) return
      let msg
      try { msg = JSON.parse(line) } catch { return }
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id)
        pending.delete(msg.id)
        msg.error ? rej(Error(msg.error.message || JSON.stringify(msg.error))) : res(msg.result)
      }
    })
    const request = (method, params) => new Promise((res, rej) => {
      const id = ++seq
      pending.set(id, { res, rej })
      try {
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
      } catch (e) {
        pending.delete(id)
        rej(e)
      }
    })

    ;(async () => {
      await request('initialize', {
        clientInfo: { name: 'ominihive', title: 'OminiHive', version: '0.3.2' },
        capabilities: { experimentalApi: true }
      })
      child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n')
      finish(await fn(request))
    })().catch(() => finish(null))
  })
}

const inflightSync = new Map()

export function syncCodexProjectStandalone({ exe, cwd, projectName = '', env = process.env, timeoutMs = 12000 }) {
  const normCwd = normalizeDir(cwd)
  if (!exe || !normCwd) return Promise.resolve(null)
  const key = `${normCwd}::${projectName}`
  if (inflightSync.has(key)) return inflightSync.get(key)
  const p = withCodexAppServer({ exe, cwd: normCwd, env, timeoutMs }, request => ensureCodexProject(request, normCwd, projectName))
    .finally(() => { if (inflightSync.get(key) === p) inflightSync.delete(key) })
  inflightSync.set(key, p)
  return p
}

export function setCodexThreadNameStandalone({ exe, threadId, name, env = process.env, timeoutMs = 12000 }) {
  if (!exe || !threadId || !name) return Promise.resolve(false)
  return withCodexAppServer({ exe, env, timeoutMs }, async request => {
    await request('thread/name/set', { threadId, name })
    return true
  }).then(Boolean)
}
