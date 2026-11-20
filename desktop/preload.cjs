const { contextBridge, ipcRenderer } = require('electron')
const api = {}
for (const key of [
  'tree', 'messages', 'syncRoom', 'add', 'room', 'renameProject', 'renameRoom', 'externalSessions', 'importSession',
  'send', 'stop', 'remove',
  'cachedModels', 'models', 'clients', 'ccSwitch', 'updates', 'upgrade', 'openExternal', 'openPath',
  'volcQuota', 'volcLogin', 'files', 'previewFile', 'agentSkills',
  'respondInteraction', 'focusAntigravity', 'setTheme'
]) {
  api[key] = (...args) => ipcRenderer.invoke(key, ...args)
}
api.onUpgrade = fn => {
  const listener = (_event, row) => fn(row)
  ipcRenderer.on('upgrade-state', listener)
  return () => ipcRenderer.removeListener('upgrade-state', listener)
}
api.listen = fn => {
  const update = () => fn()
  ipcRenderer.on('changed', update)
  return () => ipcRenderer.removeListener('changed', update)
}
contextBridge.exposeInMainWorld('hive', api)
