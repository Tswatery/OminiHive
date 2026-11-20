import { app, BrowserWindow, dialog, ipcMain, nativeTheme, session, shell } from 'electron'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'
import { createQuotaClient } from './volc-quota.mjs'
import { createCatalog } from './catalog.mjs'
import { Store, routeTargets } from './store.mjs'
import { execute, availability, respondAgentInteraction } from './agents.mjs'
import { respondDesktopInteraction, focusDesktopApp } from './antigravity-desktop.mjs'
import { initClients, inventory, updates, upgrade, isUpgrading } from './clients.mjs'
import { ccSwitchSummary } from './ccswitch.mjs'
import { listFiles, previewFile, listAgentSkills } from './workspace.mjs'
import { syncRoomExternal, listExternalSessions, loadExternalSessionTurns } from './sync.mjs'

app.setName('OminiHive')
const root = fileURLToPath(new URL('../', import.meta.url))
const page = path.join(root, 'dist/index.html')
let win, store, timer, activeRoomId = ''
const jobs = new Map()
const bgRunning = new Map()
const syncInflight = new Map()
const lastSyncAt = new Map()

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

  await syncRoom(room, { force: true }).catch(() => 0)
  const savedImages = saveAttachments(images)
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
  const runs = store.startBatch(room, text, targetAgents, agents, savedImages, sessionKeys, freshAgents)
  await Promise.all(runs.map(async item => {
    const key = room + ':' + item.agent
    const prevBg = bgRunning.get(key)
    if (prevBg) {
      bgRunning.delete(key)
      store.finish(prevBg.msgId, '完成')
    }
    const controller = new AbortController()
    jobs.set(key, { room, agent: item.agent, controller })
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
          if (type === 'status') {
            if (value === '执行中') {
              bgRunning.set(key, { room, agent: item.agent, msgId: item.id })
              store.setStatus(item.id, '执行中')
            } else {
              if (bgRunning.get(key)?.msgId === item.id) bgRunning.delete(key)
              store.finish(item.id, String(value || '完成'))
            }
            changed()
            return
          }
          store.record(item.id, room, type === 'session' ? item.sessionKey : item.agent, type, value)
          changed()
        }
      })
      if (bgRunning.get(key)?.msgId !== item.id) {
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
      jobs.delete(key)
      changed()
    }
  }))
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
  await initClients()
  store = new Store(path.join(app.getPath('userData'), 'workspace.sqlite'))
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  handle('tree', () => ({
    ...store.tree(),
    agents: availability(),
    running: allRunning()
  }))
  handle('messages', room => { activeRoomId = room; void syncRoom(room); return store.messages(room) })
  handle('syncRoom', room => syncRoom(room, { force: true }))
  handle('add', async () => {
    const r = await dialog.showOpenDialog(win, { title: '选择本地项目', properties: ['openDirectory'] })
    return r.canceled ? null : store.project(r.filePaths[0])
  })
  handle('room', id => store.room(id))
  handle('renameProject', (id, name) => { store.renameProject(id, name); changed() })
  handle('renameRoom', (id, title) => { store.renameRoom(id, title); changed() })
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
  handle('previewFile', (roomId, filePath) => {
    const row = store.get('SELECT p.dir FROM projects p JOIN rooms r ON p.id=r.project WHERE r.id=?', roomId)
    if (!row) throw Error('未找到对应项目目录')
    return previewFile(row.dir, filePath)
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
      const bg = bgRunning.get(k)
      if (bg) { bgRunning.delete(k); store.finish(bg.msgId, '已停止'); changed() }
      return
    }
    for (const [k, job] of jobs.entries()) {
      if (job.room === room) job.controller.abort()
    }
    let bgCleared = false
    for (const [k, bg] of bgRunning.entries()) {
      if (bg.room === room) { bgRunning.delete(k); store.finish(bg.msgId, '已停止'); bgCleared = true }
    }
    if (bgCleared) changed()
  })
  handle('openExternal', async url => {
    const parsed = new URL(String(url))
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw Error('不支持的链接协议')
    await shell.openExternal(parsed.href)
  })
  handle('openPath', async (targetPath, roomId) => {
    let resolved = String(targetPath || '').trim()
    if (!resolved) return false
    if (!path.isAbsolute(resolved) && roomId) {
      const row = store.get('SELECT p.dir FROM projects p JOIN rooms r ON p.id=r.project WHERE r.id=?', roomId)
      if (row) resolved = path.resolve(row.dir, resolved)
    }
    if (!existsSync(resolved)) return false
    const err = await shell.openPath(resolved)
    if (err) shell.showItemInFolder(resolved)
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
app.on('before-quit', () => { for (const job of jobs.values()) job.controller.abort() })
app.on('window-all-closed', () => app.quit())
