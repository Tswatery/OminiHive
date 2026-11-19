import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { createQuotaClient } from './volc-quota.mjs'
import { createCatalog } from './catalog.mjs'
import { Store, routeTargets } from './store.mjs'
import { execute, availability } from './agents.mjs'
import { initClients, inventory, updates, upgrade, isUpgrading } from './clients.mjs'
import { ccSwitchSummary } from './ccswitch.mjs'
import { listFiles, previewFile, listAgentSkills } from './workspace.mjs'

app.setName('OminiHive')
const root = fileURLToPath(new URL('../', import.meta.url))
const page = path.join(root, 'dist/index.html')
let win, store, timer
const jobs = new Map()

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
    const m = String(img?.dataUrl || '').match(/^data:(image\/[a-z0-9+.-]+);base64,(.+)$/i)
    if (!m) continue
    const mimeType = m[1].toLowerCase()
    const base64 = m[2]
    const ext = mimeType.includes('png') ? '.png' : mimeType.includes('webp') ? '.webp' : mimeType.includes('gif') ? '.gif' : '.jpg'
    const filePath = path.join(dir, randomUUID() + ext)
    writeFileSync(filePath, Buffer.from(base64, 'base64'))
    saved.push({ path: filePath, mimeType, base64, name: String(img.name || ('image' + ext)), preview: img.dataUrl })
  }
  return saved
}

async function run(room, text, allowWrite, modelOrPrefs = '', effort = '', targetAgents = '', images = []) {
  const { agents: parsedAgents, isAll } = routeTargets(text, targetAgents)
  const avail = availability()
  const agents = isAll ? parsedAgents.filter(a => avail[a]) : parsedAgents
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

  const savedImages = saveAttachments(images)
  const agProvider = prefs?.Antigravity?.provider
  const sessionKeys = agProvider ? {Antigravity: 'Antigravity:cli:' + agProvider} : {}
  const runs = store.startBatch(room, text, targetAgents, agents, savedImages, sessionKeys)
  await Promise.all(runs.map(async item => {
    const key = room + ':' + item.agent
    const controller = new AbortController()
    jobs.set(key, { room, agent: item.agent, controller })
    changed()
    const m = prefs ? (prefs[item.agent]?.model || '') : modelOrPrefs
    const ef = prefs ? (prefs[item.agent]?.effort || '') : effort
    const pv = prefs ? (prefs[item.agent]?.provider || '') : ''
    const rawWrite = prefs && typeof prefs[item.agent]?.write === 'boolean' ? prefs[item.agent].write : allowWrite
    const canWrite = rawWrite === true
    try {
      await execute({
        ...item,
        images: savedImages,
        model: m,
        effort: ef,
        providerId: pv,
        write: canWrite,
        signal: controller.signal,
        emit(type, value) {
          store.record(item.id, room, type === 'session' ? item.sessionKey : item.agent, type, value)
          changed()
        }
      })
      store.finish(item.id, '完成')
    } catch (e) {
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
    running: [...jobs.values()].map(j => ({ room: j.room, agent: j.agent }))
  }))
  handle('messages', room => store.messages(room))
  handle('add', async () => {
    const r = await dialog.showOpenDialog(win, { title: '选择本地项目', properties: ['openDirectory'] })
    return r.canceled ? null : store.project(r.filePaths[0])
  })
  handle('room', id => store.room(id))
  handle('renameRoom', (id, title) => { store.renameRoom(id, title); changed() })
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
      jobs.get(room + ':' + agent)?.controller.abort()
      return
    }
    for (const [k, job] of jobs.entries()) {
      if (job.room === room) job.controller.abort()
    }
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
  openWindow()
  for (const [agent, installed] of Object.entries(availability())) {
    if (installed) void catalog.get(agent).catch(() => {})
  }
})

app.on('second-instance', () => win?.focus())
app.on('before-quit', () => { for (const job of jobs.values()) job.controller.abort() })
app.on('window-all-closed', () => app.quit())
