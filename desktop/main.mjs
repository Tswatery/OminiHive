import { app, BrowserWindow, dialog, ipcMain, nativeTheme, net, protocol, session, shell } from 'electron'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'
import { createQuotaClient } from './volc-quota.mjs'
import { createCatalog } from './catalog.mjs'
import { Store, routeTargets } from './store.mjs'
import { execute, availability, respondAgentInteraction, killAllAgentProcesses, syncCodexProject, setCodexThreadName } from './agents.mjs'
import { respondDesktopInteraction, focusDesktopApp, cancelDesktopBackground, ensureDesktopProject, readDesktopTitle, setDesktopTitle } from './antigravity-desktop.mjs'
import { initClients, inventory, updates, upgrade, isUpgrading, binary, dirs } from './clients.mjs'
import { ccSwitchSummary } from './ccswitch.mjs'
import { listFiles, previewFile, listAgentSkills, resolveLocalFilePath, getGitStatus, opensAsProgram } from './workspace.mjs'
import { syncRoomExternal, listExternalSessions, loadExternalSessionTurns, findClaudeTranscript } from './sync.mjs'
import { generateTitleWithCodex, looksLikeSmartTitle, appendClaudeTitle } from './auto-title.mjs'

app.setName('OminiHive')
protocol.registerSchemesAsPrivileged([
  { scheme: 'ominihive-preview', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])
const root = fileURLToPath(new URL('../', import.meta.url))
const page = path.join(root, 'dist/index.html')
let win, store, timer, activeRoomId = ''
const jobs = new Map()
const bgRunning = new Map()
// Messages the user explicitly stopped: late events from a background watcher must not revive them.
const stoppedMsgIds = new Set()
// room:agent -> in-flight desktop cancellation, so an "interrupt and send" waits for it.
const bgCancels = new Map()

function stopBackground(key) {
  const bg = bgRunning.get(key)
  if (!bg) return null
  bgRunning.delete(key)
  stoppedMsgIds.add(bg.msgId)
  if (stoppedMsgIds.size > 200) stoppedMsgIds.delete(stoppedMsgIds.values().next().value)
  store.finish(bg.msgId, '已停止')
  if (!bg.cascadeId) return null
  const p = cancelDesktopBackground(bg.cascadeId).catch(() => false).finally(() => {
    if (bgCancels.get(key) === p) bgCancels.delete(key)
  })
  bgCancels.set(key, p)
  return p
}
const syncInflight = new Map()
const lastSyncAt = new Map()
const previewTokens = new Map()

function issuePreviewUrl(filePath) {
  const token = randomUUID()
  previewTokens.set(token, filePath)
  if (previewTokens.size > 64) {
    const first = previewTokens.keys().next().value
    if (first) previewTokens.delete(first)
  }
  return `ominihive-preview://file/${token}.pdf`
}

function allRunning() {
  const map = new Map()
  for (const j of jobs.values()) map.set(j.room + ':' + j.agent, { room: j.room, agent: j.agent })
  for (const j of bgRunning.values()) map.set(j.room + ':' + j.agent, { room: j.room, agent: j.agent })
  return [...map.values()]
}

async function syncRoom(roomId, { force = false } = {}) {
  if (!roomId || !store) return 0
  if (syncInflight.has(roomId)) return syncInflight.get(roomId)
  const now = Date.now()
  if (!force && now - (lastSyncAt.get(roomId) || 0) < 1500) return 0
  const busy = new Set(allRunning().filter(j => j.room === roomId).map(j => j.agent))
  const p = syncRoomExternal(store, roomId, busy)
    .then(added => {
      lastSyncAt.set(roomId, Date.now())
      if (added > 0) changed()
      return added
    })
    .catch(() => 0)
    .finally(() => syncInflight.delete(roomId))
  syncInflight.set(roomId, p)
  return p
}

function syncExternalProjects(cwd, projectName = '') {
  if (!cwd) return
  void syncCodexProject(cwd, projectName).catch(() => null)
  void ensureDesktopProject({ cwd, projectName }).catch(() => null)
}

// Pushes a room title into every native client session bound to the room.
async function writeBackTitle(roomId, title, { custom = false, skipAgents = [] } = {}) {
  const st = store.roomTitleState(roomId)
  if (!st || !title) return
  const busy = new Set(allRunning().filter(j => j.room === roomId).map(j => j.agent))
  await Promise.all(store.listSessions(roomId).map(async ({ agent, native }) => {
    if (!native || skipAgents.includes(agent)) return
    try {
      // Provider-specific sessions live in separate homes or CLIs that native clients don't show.
      if (agent === 'Codex') await setCodexThreadName(native, title)
      else if (agent === 'Antigravity') await setDesktopTitle(native, title)
      else if (agent.split(':')[0] === 'Claude' && !busy.has('Claude')) {
        appendClaudeTitle(findClaudeTranscript(native, st.dir), native, title, { custom })
      }
    } catch {}
  }))
}

const autoNaming = new Set()

// After the first completed turn, replace the "first words of the message" title with a summary.
// Antigravity names its own conversations, so when it took part its title wins; otherwise Codex generates one.
async function autoNameRoom(roomId) {
  if (!store || autoNaming.has(roomId)) return
  const st = store.roomTitleState(roomId)
  if (!st || st.title_locked || st.title_auto > 0) return
  const first = store.get("SELECT body FROM messages WHERE room=? AND author='我' ORDER BY time, rowid LIMIT 1", roomId)
  const reply = store.get("SELECT body FROM messages WHERE room=? AND author<>'我' AND status='完成' AND body<>'' ORDER BY time, rowid LIMIT 1", roomId)
  if (!first?.body || !reply?.body) return
  autoNaming.add(roomId)
  try {
    const ag = store.listSessions(roomId).find(s => s.agent === 'Antigravity' && s.native)
    if (ag) {
      for (let i = 0; i < 12; i++) {
        const now = store.roomTitleState(roomId)
        if (!now || now.title_locked) return
        if (now.title_auto > 0) {
          await writeBackTitle(roomId, now.title, { skipAgents: ['Antigravity'] })
          return
        }
        const t = String(await readDesktopTitle(ag.native).catch(() => '') || '').trim()
        if (looksLikeSmartTitle(t, first.body)) {
          if (store.autoTitleRoom(roomId, t, 1)) changed()
          await writeBackTitle(roomId, t, { skipAgents: ['Antigravity'] })
          return
        }
        await new Promise(r => setTimeout(r, 2000))
      }
    }
    await initClients()
    const exe = binary('Codex')
    if (!exe) return
    const title = await generateTitleWithCodex({ exe, env: { ...process.env, PATH: dirs.join(':') }, task: first.body, reply: reply.body })
    if (!title) return
    const now = store.roomTitleState(roomId)
    if (!now || now.title_locked || now.title_auto > 0) return
    if (store.autoTitleRoom(roomId, title, 2)) changed()
    await writeBackTitle(roomId, title)
  } catch {} finally {
    autoNaming.delete(roomId)
  }
}

function changed() {
  if (!timer) timer = setTimeout(() => {
    timer = null
    if (win && !win.isDestroyed()) win.webContents.send('changed')
  }, 60)
}

function handle(name, fn) {
  ipcMain.handle(name, (event, ...args) => {
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== pathToFileURL(page).href) {
      throw Error('无效的页面来源')
    }
    return fn(...args)
  })
}

function saveAttachments(images) {
  if (!Array.isArray(images) || !images.length) return []
  const dir = path.join(app.getPath('userData'), 'attachments')
  mkdirSync(dir, { recursive: true })
  const saved = []
  for (const img of images.slice(0, 8)) {
    const m = String(img?.dataUrl || '').match(/^data:([^;]*);base64,(.*)$/i)
    if (!m) continue
    const mimeType = (m[1] || 'application/octet-stream').toLowerCase()
    const base64 = m[2]
    const isImage = mimeType.startsWith('image/')
    const rawName = path.basename(String(img.name || '')).replace(/[\\/:*?"<>|]/g, '_')
    const nameExt = path.extname(rawName).slice(0, 16)
    const fallbackExt = isImage
      ? (mimeType.includes('png') ? '.png' : mimeType.includes('webp') ? '.webp' : mimeType.includes('gif') ? '.gif' : '.jpg')
      : ''
    const ext = nameExt || fallbackExt
    const filePath = path.join(dir, randomUUID() + ext)
    writeFileSync(filePath, Buffer.from(base64, 'base64'))
    saved.push({
      path: filePath,
      mimeType,
      isImage,
      base64: isImage ? base64 : '',
      name: rawName || ((isImage ? 'image' : 'file') + ext),
      preview: isImage ? img.dataUrl : ''
    })
  }
  return saved
}

async function run(room, text, allowWrite, modelOrPrefs = '', effort = '', targetAgents = '', images = []) {
  const { agents: parsedAgents, isAll } = routeTargets(text, targetAgents)
  const avail = availability()
  const roomScope = Array.isArray(targetAgents) && targetAgents.length ? targetAgents : null
  const agents = isAll
    ? parsedAgents.filter(a => avail[a] && (!roomScope || roomScope.includes(a)))
    : parsedAgents
  if (!agents.length) throw Error('未找到可用的 Agent CLI')
  const prefs = typeof modelOrPrefs === 'object' && modelOrPrefs !== null ? modelOrPrefs : null
  for (const agent of agents) {
    const key = room + ':' + agent
    if (jobs.has(key)) throw Error(agent + ' 正在当前讨论中执行，请稍候或先停止')
    if (isUpgrading(agent)) throw Error(agent + ' 正在更新，请稍后发送')
    if (!avail[agent]) throw Error('未找到 ' + agent + ' CLI')
    const m = prefs ? (prefs[agent]?.model || '') : modelOrPrefs
    if (typeof m !== 'string' || m.length > 200) throw Error('无效的模型')
  }
  // Reserve every target synchronously, before the first await, so a second send
  // arriving while we sync/prepare cannot start a duplicate run of the same agent.
  const reserved = new Map()
  for (const agent of agents) {
    const entry = { room, agent, controller: new AbortController() }
    jobs.set(room + ':' + agent, entry)
    reserved.set(agent, entry)
  }
  changed()
  let runs
  let savedImages
  try {
    await syncRoom(room, { force: true }).catch(() => 0)
    // Interrupting a background Antigravity turn: cancel it in the desktop app first,
    // otherwise the new turn is rejected because the session is still running.
    await Promise.all(agents.map(agent => stopBackground(room + ':' + agent) || bgCancels.get(room + ':' + agent)))
    savedImages = saveAttachments(images)
  const sessionKeys = {}
  const freshAgents = new Set()
  for (const agent of agents) {
    const pv = prefs?.[agent]?.provider || ''
    if (pv) {
      sessionKeys[agent] = agent === 'Antigravity' ? 'Antigravity:cli:' + pv : `${agent}:p:${pv}`
    } else if (agent === 'Claude') {
      try {
        const cfgFile = path.join(homedir(), '.claude', 'settings.json')
        if (existsSync(cfgFile)) {
          const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'))
          const baseUrl = String(cfg?.env?.ANTHROPIC_BASE_URL || '').trim()
          if (baseUrl) {
            const host = new URL(baseUrl).host.toLowerCase()
            if (host && host !== 'api.anthropic.com') sessionKeys.Claude = 'Claude:route:' + host
          }
        }
      } catch {}
    }
    if (prefs?.[agent]?.fresh) freshAgents.add(agent)
  }
    runs = store.startBatch(room, text, targetAgents, agents, savedImages, sessionKeys, freshAgents)
  } catch (e) {
    for (const [agent, entry] of reserved) {
      if (jobs.get(room + ':' + agent) === entry) jobs.delete(room + ':' + agent)
    }
    changed()
    throw e
  }
  await Promise.all(runs.map(async item => {
    const key = room + ':' + item.agent
    const job = reserved.get(item.agent)
    const controller = job.controller
    let cascadeId = item.agent === 'Antigravity' ? (item.session || '') : ''
    changed()
    const m = prefs ? (prefs[item.agent]?.model || '') : modelOrPrefs
    const ef = prefs ? (prefs[item.agent]?.effort || '') : effort
    const pv = prefs ? (prefs[item.agent]?.provider || '') : ''
    const rawAccess = prefs?.[item.agent]?.access
    const access = (rawAccess === 'read-only' || rawAccess === 'workspace' || rawAccess === 'full')
      ? rawAccess
      : ((prefs && typeof prefs[item.agent]?.write === 'boolean' ? prefs[item.agent].write : allowWrite) === true ? 'workspace' : 'read-only')
    const canWrite = access !== 'read-only'
    try {
      await execute({
        ...item,
        images: savedImages,
        model: m,
        effort: ef,
        providerId: pv,
        write: canWrite,
        access,
        signal: controller.signal,
        emit(type, value) {
          if (stoppedMsgIds.has(item.id)) return
          if (type === 'title') {
            const clean = String(value || '').trim()
            if (clean && store.autoTitleRoom(room, clean)) changed()
            return
          }
          if (type === 'session' && item.agent === 'Antigravity') cascadeId = String(value || '')
          if (type === 'status') {
            if (value === '执行中') {
              bgRunning.set(key, { room, agent: item.agent, msgId: item.id, cascadeId })
              store.setStatus(item.id, '执行中')
            } else {
              if (bgRunning.get(key)?.msgId === item.id) bgRunning.delete(key)
              store.finish(item.id, String(value || '完成'))
              // Background desktop turns finish after run() returned; name the room once they do.
              void autoNameRoom(room)
            }
            changed()
            return
          }
          store.record(item.id, room, type === 'session' ? item.sessionKey : item.agent, type, value)
          changed()
        }
      })
      if (bgRunning.get(key)?.msgId !== item.id && !stoppedMsgIds.has(item.id)) {
        store.finish(item.id, '完成')
      }
      store.markSeen(room, item.sessionKey, item.seenRowid)
      store.markDelivered(room, item.sessionKey, item.deliveredIds)
      setTimeout(() => { void syncRoom(room, { force: true }) }, 1800)
      setTimeout(() => { void syncRoom(room, { force: true }) }, 6000)
    } catch (e) {
      if (bgRunning.get(key)?.msgId === item.id) bgRunning.delete(key)
      store.record(item.id, room, item.agent, 'log', e.message)
      store.finish(item.id, controller.signal.aborted ? '已停止' : '失败')
    } finally {
      if (jobs.get(key) === job) jobs.delete(key)
      changed()
    }
  }))
  void autoNameRoom(room)
}

function openWindow() {
  win = new BrowserWindow({
    title: 'OminiHive',
    width: 1220,
    height: 820,
    minWidth: 780,
    minHeight: 560,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 15 },
    vibrancy: 'sidebar',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(root, 'desktop/preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', event => event.preventDefault())
  win.on('focus', () => { if (activeRoomId) void syncRoom(activeRoomId) })
  win.loadFile(page)
}

if (!app.requestSingleInstanceLock()) app.quit()
else app.whenReady().then(async () => {
  protocol.handle('ominihive-preview', req => {
    try {
      const u = new URL(req.url)
      const token = decodeURIComponent(u.pathname.replace(/^\/+/, '')).replace(/\.pdf$/i, '')
      const filePath = previewTokens.get(token)
      if (!filePath || !existsSync(filePath)) return new Response('Not Found', { status: 404 })
      return net.fetch(pathToFileURL(filePath).href)
    } catch {
      return new Response('Bad Request', { status: 400 })
    }
  })
  await initClients()
  store = new Store(path.join(app.getPath('userData'), 'workspace.sqlite'))
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  handle('tree', () => ({
    ...store.tree(),
    agents: availability(),
    running: allRunning()
  }))
  handle('messages', room => { activeRoomId = room; void syncRoom(room); return store.messages(room) })
  // Streaming refreshes: only changed rows. External-client sync runs on the first load
  // of a room (empty `known`) and on the renderer's periodic syncRoom, not on every delta.
  handle('messagesDelta', (room, known) => {
    const first = !known || !Object.keys(known).length
    if (first || activeRoomId !== room) { activeRoomId = room; void syncRoom(room) }
    return store.messagesDelta(room, known && typeof known === 'object' ? known : {})
  })
  handle('syncRoom', room => syncRoom(room, { force: true }))
  handle('add', async () => {
    const r = await dialog.showOpenDialog(win, { title: '选择本地项目', properties: ['openDirectory'] })
    if (r.canceled) return null
    const id = store.project(r.filePaths[0])
    const proj = store.get('SELECT dir, name FROM projects WHERE id=?', id)
    if (proj?.dir) syncExternalProjects(proj.dir, proj.name)
    return id
  })
  // Projects are synced when a folder is added and on every Codex/Antigravity turn; not per new room.
  handle('room', id => store.room(id))
  handle('renameProject', (id, name) => {
    store.renameProject(id, name)
    const proj = store.get('SELECT dir, name FROM projects WHERE id=?', id)
    if (proj?.dir) syncExternalProjects(proj.dir, proj.name)
    changed()
  })
  handle('renameRoom', (id, title) => {
    store.renameRoom(id, title)
    changed()
    const st = store.roomTitleState(id)
    if (st?.title) void writeBackTitle(id, st.title, { custom: true })
  })
  handle('externalSessions', async projectId => {
    const proj = store.get('SELECT dir FROM projects WHERE id=?', projectId)
    return listExternalSessions(proj?.dir || '')
  })
  handle('importSession', async (projectId, item) => {
    const proj = store.get('SELECT id, dir FROM projects WHERE id=?', projectId)
    if (!proj) throw Error('未找到对应项目')
    const agent = String(item?.agent || '')
    const nativeId = String(item?.nativeId || '')
    if (!agent || !nativeId) throw Error('无效的会话参数')
    const turns = await loadExternalSessionTurns(agent, nativeId, proj.dir)
    const roomId = store.importRoom(projectId, {
      agent,
      nativeId,
      title: item?.title || `导入自 ${agent}`,
      turns
    })
    changed()
    return roomId
  })
  handle('remove', (kind, id) => { store.remove(kind, id); changed(); return store.tree() })
  const arkBinary = app.isPackaged ? path.join(process.resourcesPath, 'arkcli') : path.join(root, 'node_modules/.cache/ominihive/arkcli')
  const quota = createQuotaClient(arkBinary)
  handle('volcQuota', quota.read)
  handle('volcLogin', quota.login)
  handle('clients', inventory)
  handle('ccSwitch', ccSwitchSummary)
  handle('files', (roomId, relDir = '') => {
    const row = store.get('SELECT p.dir FROM projects p JOIN rooms r ON p.id=r.project WHERE r.id=?', roomId)
    return row ? listFiles(row.dir, relDir) : []
  })
  handle('gitStatus', roomId => {
    const row = store.get('SELECT p.dir FROM projects p JOIN rooms r ON p.id=r.project WHERE r.id=?', roomId)
    return row ? getGitStatus(row.dir) : { isRepo: false, branch: '', files: {}, dirs: {}, changes: [] }
  })
  handle('previewFile', async (roomId, filePath) => {
    const row = roomId ? store.get('SELECT p.dir FROM projects p JOIN rooms r ON p.id=r.project WHERE r.id=?', roomId) : null
    const res = await previewFile(row?.dir || '', filePath)
    if (res && res.kind === 'pdf' && res.pdfFilePath) {
      const { pdfFilePath, ...rest } = res
      return { ...rest, dataUrl: issuePreviewUrl(pdfFilePath) }
    }
    return res
  })
  handle('agentSkills', roomId => {
    const row = roomId ? store.get('SELECT p.dir FROM projects p JOIN rooms r ON p.id=r.project WHERE r.id=?', roomId) : null
    return listAgentSkills(row?.dir || '')
  })
  handle('updates', updates)
  handle('upgrade', async agent => {
    if ([...jobs.values()].some(job => job.agent === agent)) throw Error('请等待 ' + agent + ' 当前任务结束后再更新')
    await upgrade(agent, row => { if (win && !win.isDestroyed()) win.webContents.send('upgrade-state', row) })
    changed()
  })
  const catalog = createCatalog(app.getPath('userData'))
  handle('cachedModels', agent => catalog.peek(agent))
  handle('models', agent => catalog.get(agent))
  handle('send', run)
  handle('stop', (room, agent) => {
    if (agent) {
      const k = room + ':' + agent
      jobs.get(k)?.controller.abort()
      if (bgRunning.has(k)) { void stopBackground(k); changed() }
      return
    }
    for (const [k, job] of jobs.entries()) {
      if (job.room === room) job.controller.abort()
    }
    let bgCleared = false
    for (const [k, bg] of [...bgRunning.entries()]) {
      if (bg.room === room) { void stopBackground(k); bgCleared = true }
    }
    if (bgCleared) changed()
  })
  handle('openExternal', async url => {
    const parsed = new URL(String(url))
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw Error('不支持的链接协议')
    await shell.openExternal(parsed.href)
  })
  handle('openPath', async (targetPath, roomId) => {
    const row = roomId ? store.get('SELECT p.dir FROM projects p JOIN rooms r ON p.id=r.project WHERE r.id=?', roomId) : null
    const resolved = resolveLocalFilePath(row?.dir || '', targetPath)
    if (!resolved || !existsSync(resolved)) return false
    // A click on a link in agent output must never launch an app or script; reveal it instead.
    if (opensAsProgram(resolved)) { shell.showItemInFolder(resolved); return true }
    const err = await shell.openPath(resolved)
    if (err) shell.showItemInFolder(resolved)
    return true
  })
  handle('revealPath', (targetPath, roomId) => {
    const row = roomId ? store.get('SELECT p.dir FROM projects p JOIN rooms r ON p.id=r.project WHERE r.id=?', roomId) : null
    const resolved = resolveLocalFilePath(row?.dir || '', targetPath)
    if (!resolved || !existsSync(resolved)) return false
    shell.showItemInFolder(resolved)
    return true
  })
  handle('respondInteraction', req => {
    if (respondAgentInteraction(req)) return true
    return respondDesktopInteraction(req)
  })
  handle('focusAntigravity', () => focusDesktopApp())
  handle('setTheme', mode => {
    nativeTheme.themeSource = mode === 'dark' || mode === 'light' ? mode : 'system'
    return nativeTheme.shouldUseDarkColors
  })
  openWindow()
  for (const [agent, installed] of Object.entries(availability())) {
    if (installed) void catalog.get(agent).catch(() => {})
  }
})

app.on('second-instance', () => win?.focus())
app.on('before-quit', () => {
  for (const job of jobs.values()) job.controller.abort()
  killAllAgentProcesses()
})
app.on('window-all-closed', () => app.quit())
