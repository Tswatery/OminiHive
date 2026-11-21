import {execFile} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {existsSync} from 'node:fs'
import {lstat, readFile, readdir, realpath} from 'node:fs/promises'
import {homedir} from 'node:os'
import path from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {promisify} from 'node:util'

const run = promisify(execFile)
const appPaths = ['/Applications/Antigravity.app', path.join(homedir(), 'Applications/Antigravity.app')]
export const desktopApp = () => appPaths.find(dir => existsSync(path.join(dir, 'Contents/Resources/bin/language_server')))
const registry = path.join(homedir(), '.gemini/antigravity/daemon')
const projectRequests = new Map()
const callbackWatchers = new Map()
const activeDesktopRpcs = new Map()
let watcherTimer = null

function parseToolArgs(step) {
  const rawArgs = step.metadata?.toolCall?.argumentsJson
  if (typeof rawArgs === 'string' && rawArgs.trim()) {
    try { return JSON.parse(rawArgs) } catch {}
  }
  return null
}

function cleanPathLike(raw) {
  if (typeof raw !== 'string') return ''
  let s = raw.trim()
  if (s.startsWith('file://')) {
    try { s = fileURLToPath(s) } catch { s = s.replace(/^file:\/\//, '') }
  }
  return s
}

function buildAgToolStep(step, idx, status) {
  const name = step.metadata?.toolCall?.name || step.type?.replace('CORTEX_STEP_TYPE_', '').toLowerCase()
  if (!name) return null
  const parsedArgs = parseToolArgs(step)
  const hintRaw =
    step.runCommand?.commandLine ||
    step.viewFile?.absolutePathUri ||
    step.grepSearch?.query ||
    parsedArgs?.CommandLine || parsedArgs?.command || parsedArgs?.Path || parsedArgs?.AbsolutePath || parsedArgs?.TargetFile || parsedArgs?.Query || ''
  const hint = cleanPathLike(hintRaw).replace(/\s+/g, ' ')
  const title = hint ? `${name} · ${hint.length > 68 ? hint.slice(0, 68) + '…' : hint}` : name
  const parts = []
  if (parsedArgs) {
    try {
      const s = JSON.stringify(parsedArgs, null, 2)
      if (s && s !== '{}') parts.push('输入：\n' + s.slice(0, 800))
    } catch {}
  } else if (hint) {
    parts.push('输入：\n' + hint.slice(0, 800))
  }
  const errText = step.error?.userErrorMessage || step.error?.shortError || (typeof step.error === 'string' ? step.error : '')
  if (errText) parts.push('错误：\n' + errText.slice(0, 800))
  return { id: 'ag-' + idx, kind: 'tool', title, status, detail: parts.length ? parts.join('\n\n') : undefined }
}

const isTerminalStep = step => ['DONE','ERROR','CANCELED','INTERRUPTED','INVALID','CLEARED'].some(s => step.status?.endsWith('_' + s))
const isWaitingStep = step => Boolean(step?.status?.endsWith('_WAITING'))

function permissionTitleForAction(action) {
  const a = String(action || '').toLowerCase()
  if (a.includes('read')) return '允许读取此路径？'
  if (a.includes('write') || a.includes('edit')) return '允许修改此路径？'
  if (a.includes('command') || a.includes('exec') || a.includes('unsandbox')) return '允许执行此命令？'
  if (a.includes('mcp')) return '允许调用此 MCP 工具？'
  if (a.includes('url') || a.includes('web') || a.includes('browser')) return '允许访问此链接？'
  return action ? `允许执行 ${action}？` : '需要你的授权确认'
}

function buildAgInteraction(step, idx, cascadeId, trajectoryId) {
  const req = step?.requestedInteraction || {}
  const parsedArgs = parseToolArgs(step)
  const base = { cascadeId, trajectoryId: trajectoryId || cascadeId, stepIndex: idx }

  if (req.permission) {
    const spec = req.permission
    const action = spec.resource?.action || step.metadata?.toolCall?.name || ''
    const target = cleanPathLike(
      spec.resource?.target ||
      parsedArgs?.Path || parsedArgs?.AbsolutePath || parsedArgs?.TargetFile || parsedArgs?.CommandLine || ''
    )
    const allowPersist = spec.persistSuggestionType !== 'PERSIST_SUGGESTION_TYPE_BLOCKED'
    const options = [
      { id: 'once', label: '允许这一次', payload: { permission: { allow: true, scope: 'PERMISSION_SCOPE_ONCE' } } },
      ...(allowPersist ? [
        { id: 'conversation', label: '本会话始终允许', payload: { permission: { allow: true, scope: 'PERMISSION_SCOPE_CONVERSATION' } } },
        { id: 'global', label: '始终允许', payload: { permission: { allow: true, scope: 'PERMISSION_SCOPE_GLOBAL' } } }
      ] : []),
      { id: 'deny', label: '拒绝', danger: true, payload: { permission: { allow: false } } }
    ]
    return {
      ...base,
      kind: 'permission',
      title: spec.actionDescription || permissionTitleForAction(action),
      target,
      reason: spec.reason || '',
      options
    }
  }

  if (req.filePermission) {
    const spec = req.filePermission
    const rawUri = spec.absolutePathUri || ''
    const target = cleanPathLike(rawUri)
    const blockNote = spec.blockReason === 'BLOCK_REASON_OUTSIDE_WORKSPACE'
      ? '该路径位于当前工作区之外'
      : spec.blockReason === 'BLOCK_REASON_GITIGNORED'
        ? '该路径位于 .gitignore 忽略范围内'
        : ''
    return {
      ...base,
      kind: 'filePermission',
      title: spec.isDirectory ? '允许访问此目录？' : '允许读取此路径？',
      target,
      reason: blockNote,
      options: [
        { id: 'once', label: '允许这一次', payload: { filePermission: { allow: true, scope: 'PERMISSION_SCOPE_ONCE', absolutePathUri: rawUri } } },
        { id: 'conversation', label: '本会话始终允许', payload: { filePermission: { allow: true, scope: 'PERMISSION_SCOPE_CONVERSATION', absolutePathUri: rawUri } } },
        { id: 'global', label: '始终允许', payload: { filePermission: { allow: true, scope: 'PERMISSION_SCOPE_GLOBAL', absolutePathUri: rawUri } } },
        { id: 'deny', label: '拒绝', danger: true, payload: { filePermission: { allow: false, scope: 'PERMISSION_SCOPE_ONCE', absolutePathUri: rawUri } } }
      ]
    }
  }

  if (req.runCommand) {
    const cmd = step.runCommand?.commandLine || parsedArgs?.CommandLine || parsedArgs?.command || ''
    return {
      ...base,
      kind: 'runCommand',
      title: '允许执行此命令？',
      target: cmd,
      reason: '',
      options: [
        { id: 'allow', label: '允许执行', payload: { runCommand: { confirm: true, proposedCommandLine: cmd, submittedCommandLine: cmd } } },
        { id: 'deny', label: '拒绝', danger: true, payload: { runCommand: { confirm: false, proposedCommandLine: cmd, submittedCommandLine: cmd } } }
      ]
    }
  }

  if (req.mcp) {
    const toolName = step.metadata?.toolCall?.name || 'MCP 工具'
    return {
      ...base,
      kind: 'mcp',
      title: `允许调用 ${toolName}？`,
      target: parsedArgs ? JSON.stringify(parsedArgs).slice(0, 240) : '',
      reason: '',
      options: [
        { id: 'allow', label: '允许调用', payload: { mcp: { confirm: true } } },
        { id: 'deny', label: '拒绝', danger: true, payload: { mcp: { confirm: false } } }
      ]
    }
  }

  if (req.approvalInteraction) {
    const toolName = step.metadata?.toolCall?.name || ''
    return {
      ...base,
      kind: 'approvalInteraction',
      title: toolName ? `确认执行 ${toolName}？` : '需要你的确认',
      target: cleanPathLike(parsedArgs?.Path || parsedArgs?.CommandLine || ''),
      reason: '',
      options: [
        { id: 'allow', label: '确认允许', payload: { approvalInteraction: { confirm: true } } },
        { id: 'deny', label: '拒绝', danger: true, payload: { approvalInteraction: { confirm: false } } }
      ]
    }
  }

  const fallbackKind = Object.keys(req).find(k => req[k] != null) || 'unknown'
  return {
    ...base,
    kind: fallbackKind,
    title: '正在等待你在 Antigravity 客户端中确认',
    target: cleanPathLike(parsedArgs?.Path || parsedArgs?.AbsolutePath || parsedArgs?.CommandLine || ''),
    reason: '此交互类型暂需在 Antigravity 原生窗口处理',
    fallbackOnly: true,
    options: []
  }
}

export async function respondDesktopInteraction({ cascadeId, trajectoryId, stepIndex, payload }) {
  if (!cascadeId || stepIndex == null || !payload || typeof payload !== 'object') {
    throw Error('无效的交互响应参数')
  }
  const active = activeDesktopRpcs.get(cascadeId)
  const app = active?.app || desktopApp()
  const rpc = active?.rpc || (app ? await connect(app, AbortSignal.timeout(10000)) : null)
  if (!rpc) throw Error('无法连接 Antigravity 客户端')
  const interaction = {
    trajectoryId: trajectoryId || cascadeId,
    stepIndex: Number(stepIndex),
    ...payload
  }
  await rpc('HandleCascadeUserInteraction', { cascadeId, interaction })
  return true
}

export async function focusDesktopApp() {
  const app = desktopApp()
  if (!app) return false
  await run('/usr/bin/open', ['-a', app])
  return true
}

async function pollCallbackWatchers() {
  const now = Date.now()
  for (const [cascadeId, w] of callbackWatchers) {
    if (now > w.expiresAt) {
      if (w.isActive) { w.isActive = false; w.onFollowup('status', '完成') }
      callbackWatchers.delete(cascadeId)
      continue
    }
    try {
      const rpc = w.rpc || await findDesktop(w.app)
      if (!rpc) continue
      const summaries = (await rpc('GetAllCascadeTrajectories', {excludeSubtrajectories:true})).trajectorySummaries || {}
      const summary = summaries[cascadeId]
      if (!summary) {
        if (w.isActive) { w.isActive = false; w.onFollowup('status', '完成') }
        callbackWatchers.delete(cascadeId)
        continue
      }
      const stepCount = Number(summary.stepCount || 0)
      const summaryActive = Boolean((summary.status && !summary.status.endsWith('_IDLE')) || summary.notFullyIdle)
      if (stepCount !== w.lastStepCount || summaryActive) {
        w.lastStepCount = stepCount
        w.lastProgressAt = now
      }
      if (stepCount <= w.offset && w.settled.size === 0 && !summaryActive && !w.isActive) continue
      const startOffset = w.offset
      const {steps = []} = await rpc('GetCascadeTrajectorySteps', {cascadeId, stepOffset:startOffset, trajectoryVerbosity:2})
      let hitNewUser = false
      let hasLiveStep = false
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i], idx = startOffset + i
        if (step.userInput) { hitNewUser = true; break }
        if (w.settled.has(idx)) continue
        if (!isTerminalStep(step)) {
          hasLiveStep = true
          if (!step.plannerResponse && !step.errorMessage && !w.reportedRunning.has(idx)) {
            const item = buildAgToolStep(step, idx, 'running')
            if (item) {
              w.reportedRunning.add(idx)
              w.onFollowup('log', '::step::' + JSON.stringify(item))
            }
          }
          continue
        }
        w.settled.add(idx)
        w.reportedRunning.delete(idx)
        w.lastProgressAt = now
        const thinking = step.plannerResponse?.thinking
        if (typeof thinking === 'string' && thinking.trim()) {
          w.onFollowup('log', '::step::' + JSON.stringify({ id: 'ag-think-' + idx, kind: 'thought', title: '思考过程', status: 'done', detail: thinking.trim().slice(-2000) }))
        }
        const text = step.plannerResponse?.modifiedResponse || step.plannerResponse?.response || step.notifyUser?.notificationContent
        if (text) {
          w.onFollowup('text', '\n\n' + text)
          w.expiresAt = Date.now() + 30 * 60 * 1000
        }
        if (!step.plannerResponse && !step.errorMessage) {
          const item = buildAgToolStep(step, idx, step.error ? 'error' : 'done')
          if (item) w.onFollowup('log', '::step::' + JSON.stringify(item))
        }
      }
      while (w.settled.has(w.offset)) { w.settled.delete(w.offset); w.reportedRunning.delete(w.offset); w.offset++ }
      const nextActive = !hitNewUser && (summaryActive || (hasLiveStep && (now - w.lastProgressAt < 5 * 60 * 1000)))
      if (nextActive !== w.isActive) {
        w.isActive = nextActive
        w.onFollowup('status', nextActive ? '执行中' : '完成')
      }
      if (hitNewUser) callbackWatchers.delete(cascadeId)
    } catch {}
  }
  if (callbackWatchers.size === 0 && watcherTimer) {
    clearInterval(watcherTimer)
    watcherTimer = null
  }
}

export function watchDesktopCallbacks({app, cascadeId, offset, settled, onFollowup, rpc, initialRunning = false, stepCount = 0}) {
  if (!cascadeId || typeof onFollowup !== 'function') return
  const now = Date.now()
  callbackWatchers.set(cascadeId, {
    app,
    rpc,
    offset,
    settled: new Set(settled || []),
    reportedRunning: new Set(),
    onFollowup,
    isActive: Boolean(initialRunning),
    lastStepCount: Number(stepCount || 0),
    lastProgressAt: now,
    expiresAt: now + 30 * 60 * 1000
  })
  if (initialRunning) onFollowup('status', '执行中')
  if (!watcherTimer) {
    watcherTimer = setInterval(() => { void pollCallbackWatchers() }, 2500)
    watcherTimer.unref?.()
  }
}

export function stopWatchingDesktopCallbacks(cascadeId) {
  callbackWatchers.delete(cascadeId)
  if (callbackWatchers.size === 0 && watcherTimer) {
    clearInterval(watcherTimer)
    watcherTimer = null
  }
}

/**
 * Stop a background (callback-watched) desktop turn: drop the watcher so no more events
 * are emitted, cancel the cascade in the desktop app, then wait briefly for it to go idle
 * so an immediate follow-up turn is not rejected as "still running".
 */
export async function cancelDesktopBackground(cascadeId) {
  if (!cascadeId) return false
  const w = callbackWatchers.get(cascadeId)
  const active = activeDesktopRpcs.get(cascadeId)
  stopWatchingDesktopCallbacks(cascadeId)
  activeDesktopRpcs.delete(cascadeId)
  const app = w?.app || active?.app || desktopApp()
  const rpc = w?.rpc || active?.rpc || (app ? await findDesktop(app) : null)
  if (!rpc) return false
  await rpc('CancelCascadeInvocation', {cascadeId}).catch(() => {})
  for (let i = 0; i < 12; i++) {
    const meta = await rpc('GetAllCascadeTrajectories', {excludeSubtrajectories:true}).catch(() => null)
    const s = meta?.trajectorySummaries?.[cascadeId]
    if (!s || !((s.status && !s.status.endsWith('_IDLE')) || s.notFullyIdle)) return true
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return false
}

// The CLI publishes descriptors here too. Only use a listener owned by the installed desktop executable.
async function findDesktop(app) {
  const expected = path.join(app, 'Contents/Resources/bin/language_server')
  const entries = await readdir(registry).catch(() => [])
  for (const name of entries.filter(name => /^hub_\d+\.json$/.test(name))) {
    const file = path.join(registry, name)
    try {
      const st = await lstat(file)
      if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o077)) continue
      const {pid, httpPort, csrfToken} = JSON.parse(await readFile(file, 'utf8'))
      if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isInteger(httpPort) || httpPort < 1 || httpPort > 65535 || !csrfToken) continue
      const ps = await run('/bin/ps', ['-p', String(pid), '-o', 'comm='])
      if (ps.stdout.trim() !== expected) continue
      const listener = await run('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-iTCP:' + httpPort, '-sTCP:LISTEN', '-Fn'])
      if (!listener.stdout.split('\n').some(s => s.startsWith('n') && s.endsWith(':' + httpPort))) continue
      return async (method, body, signal) => {
        const response = await fetch('http://127.0.0.1:' + httpPort + '/exa.language_server_pb.LanguageServerService/' + method, {
          method: 'POST', redirect: 'error', headers: {'content-type':'application/json', 'x-codeium-csrf-token':csrfToken},
          body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000)
        })
        const result = await response.json()
        if (!response.ok) throw Object.assign(Error(result.message || 'Antigravity 客户端请求失败'), {code:result.code})
        return result
      }
    } catch { /* A stale descriptor can outlive the process. */ }
  }
}

async function connect(app, signal) {
  let rpc = await findDesktop(app)
  if (rpc) return rpc
  await run('/usr/bin/open', ['-g', '-a', app])
  for (let i = 0; i < 25; i++) {
    await delay(450, null, {signal})
    rpc = await findDesktop(app)
    if (rpc) return rpc
  }
  throw Error('无法连接 Antigravity 桌面端，请打开客户端后重试。')
}

function samePath(a, b) {
  if (!a || !b) return false
  if (a === b) return true
  return process.platform === 'darwin' && a.toLowerCase() === b.toLowerCase()
}

async function normalizeFolder(raw) {
  if (!raw || typeof raw !== 'string') return ''
  let fsPath = raw
  if (raw.startsWith('file:')) {
    try { fsPath = fileURLToPath(raw) } catch { fsPath = cleanPathLike(raw) }
  }
  const resolved = path.resolve(fsPath)
  return realpath(resolved).catch(() => resolved)
}

async function ensureProject(rpc, cwd, preferred, projectName = '') {
  const normCwd = await normalizeFolder(cwd)
  const uri = pathToFileURL(normCwd || cwd).href
  const baseName = path.basename(normCwd || cwd)
  const targetName = String(projectName || '').trim() || baseName
  const {projectIds = []} = await rpc('ListProjects', {})
  const {projects = [], failedIds = []} = projectIds.length ? await rpc('ReadProjects', {ids:projectIds}) : {}
  if (failedIds.length) throw Error('Antigravity 未能读取项目列表，请稍后重试。')
  const matches = []
  const nameMatches = []
  const usedNames = new Set()
  for (const project of projects) {
    if (project?.name) usedNames.add(String(project.name).trim().toLowerCase())
    if (project.archived || project.sidecar) continue
    let folderMatched = false
    let hasOtherFolder = false
    for (const resource of project.projectResources?.resources || []) {
      const rawUri = resource?.folderUri || resource?.workspaceUri || resource?.uri || resource?.path || ''
      if (!rawUri) continue
      const resPath = await normalizeFolder(rawUri)
      if (samePath(resPath, normCwd)) {
        matches.push(project.id)
        folderMatched = true
        break
      }
      if (resPath) hasOtherFolder = true
    }
    if (!folderMatched && !hasOtherFolder && project.name && String(project.name).trim().toLowerCase() === targetName.toLowerCase()) {
      nameMatches.push(project.id)
    }
  }
  if (matches.includes(preferred)) return preferred
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) throw Error('Antigravity 有多个项目使用同一目录，请在客户端保留唯一的项目映射。')
  if (nameMatches.includes(preferred)) return preferred
  if (nameMatches.length === 1) return nameMatches[0]

  let candidateName = targetName
  if (usedNames.has(candidateName.toLowerCase())) {
    const parent = path.basename(path.dirname(normCwd || cwd))
    if (parent && !usedNames.has(`${targetName} (${parent})`.toLowerCase())) {
      candidateName = `${targetName} (${parent})`
    } else {
      let n = 2
      while (usedNames.has(`${targetName} (${n})`.toLowerCase())) n++
      candidateName = `${targetName} (${n})`
    }
  }
  const id = randomUUID()
  try {
    await rpc('CreateProject', {project:{id, name:candidateName, projectResources:{resources:[{folderUri:uri}]}}})
    return id
  } catch (err) {
    const msg = String(err?.message || '')
    if (/already_exists|already exists/i.test(msg)) {
      const fallbackName = `${targetName}-${id.slice(0, 6)}`
      await rpc('CreateProject', {project:{id, name:fallbackName, projectResources:{resources:[{folderUri:uri}]}}})
      return id
    }
    throw err
  }
}

function projectFor(rpc, cwd, preferred, projectName = '') {
  // Coalesce first-use creation when multiple rooms use a newly added folder.
  if (!projectRequests.has(cwd)) projectRequests.set(cwd, ensureProject(rpc, cwd, preferred, projectName).finally(() => projectRequests.delete(cwd)))
  return projectRequests.get(cwd)
}

export async function ensureDesktopProject({ app = desktopApp(), cwd, projectName = '' } = {}) {
  if (!app || !cwd) return null
  try {
    const rpc = await findDesktop(app)
    if (!rpc) return null
    return await projectFor(rpc, cwd, '', projectName)
  } catch {
    return null
  }
}

async function modelFor(rpc, model, effort, signal) {
  if (!model && !effort) return
  const data = await rpc('GetCascadeModelConfigData', {}, signal)
  const all = (data.clientModelConfigs || []).filter(x => !x.disabled)
  const family = id => id?.replace(/-(minimal|low|medium|high|xhigh|max|ultra)$/, '')
  const def = all.find(x => JSON.stringify(x.modelOrAlias) === JSON.stringify(data.defaultOverrideModelConfig?.modelOrAlias))
  const base = model || family(def?.modelId)
  const choices = all.filter(x => family(x.modelId) === base)
  const picked = effort ? choices.find(x => x.modelId === base + '-' + effort)
    : choices.find(x => x === def || x.modelId === base || x.modelId === base + '-medium') || choices[0]
  if (!picked?.modelOrAlias) throw Error('Antigravity 桌面端没有所选模型或思考强度，请重新选择。')
  return picked
}

export async function runDesktopTurn({app, cwd, projectName = '', session, prompt, historyPrompt, title, titleLocked = false, images = [], model, effort, write, signal, emit, rpc}) {
  if (session) stopWatchingDesktopCallbacks(session)
  rpc ??= await connect(app, signal)
  const selected = await modelFor(rpc, model, effort, signal)
  const summaries = async () => (await rpc('GetAllCascadeTrajectories', {excludeSubtrajectories:true}, signal)).trajectorySummaries || {}
  const previous = session ? (await summaries())[session] : null
  const project = await projectFor(rpc, cwd, previous?.trajectoryMetadata?.projectId, projectName)
  let id = session, offset = 0
  if (previous && previous.trajectoryMetadata?.projectId === project && previous.source !== 'CORTEX_TRAJECTORY_SOURCE_CLI') {
    if ((previous.status && !previous.status.endsWith('_IDLE')) || previous.notFullyIdle) throw Error('这条 Antigravity 会话仍在运行，请等当前轮次结束。')
    offset = Number(previous.stepCount || 0)
    if (!offset && historyPrompt) prompt = historyPrompt
  } else {
    if (session) {
      if (!historyPrompt) throw Error('旧 Antigravity 会话缺少可用于交接的讨论记录。')
      prompt = historyPrompt
      emit('log', '旧会话保留，已将最近的讨论记录带入桌面项目。')
    }
    signal.throwIfAborted()
    const state = await rpc('StartCascade', {cascadeId:randomUUID(), source:'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT',
      projectEnvConfig:{projectId:project, defaultProjectEnvironment:{}}}, signal)
    id = state.cascadeId
    if (!id) throw Error('Antigravity 未返回桌面会话 ID')
    emit('session', id)
  }
  if (titleLocked && title && (id !== session || title !== previous?.annotations?.title)) await rpc('UpdateConversationAnnotations', {cascadeIds:[id], annotations:{title}, mergeAnnotations:true}, signal)
  emit('log', '已连接 Antigravity 项目会话' + (selected ? ' · ' + selected.label : ''))
  const toolConfig = write ? {} : {
    autoInteractionBehavior:2,
    permissionConfig:{permissionsV2:true, effectivePermissionPreset:2, effectiveGrants:{
      allow:['read_file(' + cwd + ')'], deny:['write_file(*)','command(*)','unsandboxed(*)','mcp(*)','execute_url(*)','download_url(*)']
    }}
  }
  const messageId = randomUUID()
  const plannerConfig = {toolConfig, ...(selected ? {requestedModel:selected.modelOrAlias} : {})}
  const imageMedia = images.filter(x => x.isImage !== false && String(x.mimeType || '').startsWith('image/'))
  const fileNotes = images.filter(x => !imageMedia.includes(x))
  const finalPrompt = fileNotes.length
    ? prompt + '\n\n[用户附带了以下文件，请按需读取：\n' + fileNotes.map(f => `${f.name}: ${f.path}`).join('\n') + '\n]'
    : prompt
  const body = {cascadeId:id, clientMessageId:messageId, items:[{text:finalPrompt}], media:imageMedia.map(x => ({mimeType:x.mimeType, inlineData:x.base64})),
    cascadeConfig:{plannerConfig}, customAgentSpec:{builtinAgent:{defaultAgent:{isGoogle:false, isInteractive:true, surface:'AGENT_SURFACE_HUB'}}}}
  let sending = false, mine = false, output = false, nextUser = false, lastError = '', idleConfirm = 0, lastSeenCount = -1
  const settled = new Set(), stepStates = new Map()
  const isTerminal = isTerminalStep
  activeDesktopRpcs.set(id, { rpc, app })
  try {
    sending = true
    await rpc('SendUserCascadeMessage', body, signal)
    const sentAt = Date.now()
    for (;;) {
      const summary = (await summaries())[id]
      if (!summary) throw Error('Antigravity 会话已经不可用。')
      const trajectoryId = summary.trajectoryId || id
      const waitingByIndex = new Map()
      if (Array.isArray(summary.waitingSteps)) {
        for (const ws of summary.waitingSteps) {
          if (ws && ws.stepIndex != null && ws.step) waitingByIndex.set(Number(ws.stepIndex), ws.step)
        }
      }
      const startOffset = offset
      const {steps = []} = await rpc('GetCascadeTrajectorySteps', {cascadeId:id, stepOffset:startOffset, trajectoryVerbosity:2}, signal)
      let pendingResponse = false
      for (let i = 0; i < steps.length; i++) {
        const rawStep = steps[i], idx = startOffset + i
        const waitingOverlay = waitingByIndex.get(idx)
        const step = waitingOverlay
          ? {
              ...rawStep,
              status: isWaitingStep(rawStep) ? rawStep.status : (waitingOverlay.status || rawStep.status),
              requestedInteraction: rawStep.requestedInteraction || waitingOverlay.requestedInteraction
            }
          : rawStep
        if (step.userInput) {
          if (step.userInput.clientMessageId === messageId) mine = true
          else if (mine) { nextUser = true; break }
        }
        if (settled.has(idx)) continue
        if (!isTerminal(step)) {
          if (mine && step.plannerResponse) pendingResponse = true
          if (mine && !step.userInput && !step.plannerResponse && !step.errorMessage) {
            const waiting = isWaitingStep(step) || Boolean(step.requestedInteraction)
            if (waiting) {
              const interaction = buildAgInteraction(step, idx, id, trajectoryId)
              const sig = 'waiting:' + interaction.kind + ':' + (interaction.target || '')
              if (stepStates.get(idx) !== sig) {
                const baseItem = buildAgToolStep(step, idx, 'waiting') || { id: 'ag-' + idx, kind: 'tool', title: interaction.title, status: 'waiting' }
                stepStates.set(idx, sig)
                emit('log', '::step::' + JSON.stringify({ ...baseItem, status: 'waiting', interaction }))
              }
            } else if (stepStates.get(idx) !== 'running') {
              const item = buildAgToolStep(step, idx, 'running')
              if (item) {
                stepStates.set(idx, 'running')
                emit('log', '::step::' + JSON.stringify({ ...item, interaction: null }))
              }
            }
          }
          continue
        }
        settled.add(idx)
        if (!mine || step.userInput) continue
        const thinking = step.plannerResponse?.thinking
        if (typeof thinking === 'string' && thinking.trim()) {
          emit('log', '::step::' + JSON.stringify({ id: 'ag-think-' + idx, kind: 'thought', title: '思考过程', status: 'done', detail: thinking.trim().slice(-2000) }))
        }
        const text = step.plannerResponse?.modifiedResponse || step.plannerResponse?.response || step.notifyUser?.notificationContent
        if (text) { emit('text', (output ? '\n\n' : '') + text); output = true }
        if (step.errorMessage) lastError = step.errorMessage.error?.userErrorMessage || step.errorMessage.error?.shortError || 'Antigravity 执行失败'
        if (!step.plannerResponse && !step.errorMessage) {
          const item = buildAgToolStep(step, idx, step.error ? 'error' : 'done')
          if (item) emit('log', '::step::' + JSON.stringify({ ...item, interaction: null }))
        }
      }
      while (settled.has(offset)) { settled.delete(offset); stepStates.delete(offset); offset++ }
      const stepCount = Number(summary.stepCount || 0)
      const fullyIdle = Boolean(summary.status?.endsWith('_IDLE') && !summary.notFullyIdle)
      const reachedEnd = startOffset + steps.length >= stepCount
      if (!mine && fullyIdle && Date.now() - sentAt > 20000) throw Error('客户端未确认这条消息，请检查该项目的原生会话。')
      if (nextUser) break
      if (mine && fullyIdle && reachedEnd && !pendingResponse) {
        if (stepStates.size > 0 && (idleConfirm < 1 || stepCount !== lastSeenCount)) {
          idleConfirm++
          lastSeenCount = stepCount
        } else {
          break
        }
      } else {
        idleConfirm = 0
        lastSeenCount = stepCount
      }
      await delay(750, null, {signal})
    }
    if (lastError || !output) throw Error(lastError || 'Antigravity 已结束本轮，未返回正文。')
    if (!nextUser) {
      watchDesktopCallbacks({
        app,
        cascadeId: id,
        offset,
        settled,
        onFollowup: (type, value) => emit(type, value),
        rpc: rpc,
        initialRunning: stepStates.size > 0,
        stepCount: lastSeenCount
      })
    }
  } finally {
    if (!callbackWatchers.has(id)) activeDesktopRpcs.delete(id)
    if (signal.aborted && sending && !nextUser) {
      // Only stop our own turn; a new user message may already be running in the desktop.
      const meta = await rpc('GetAllCascadeTrajectories', {excludeSubtrajectories:true}).catch(() => null)
      const last = meta?.trajectorySummaries?.[id]?.lastUserInputStepIndex
      if (last != null) {
        const tail = await rpc('GetCascadeTrajectorySteps', {cascadeId:id,stepOffset:last,trajectoryVerbosity:2}).catch(() => null)
        if (tail?.steps?.[0]?.userInput?.clientMessageId === messageId) await rpc('CancelCascadeInvocation', {cascadeId:id}).catch(() => {})
      }
    }
  }
}

export async function readDesktopHistory(cascadeId) {
  if (!cascadeId) return null
  const app = desktopApp()
  if (!app) return null
  const rpc = await findDesktop(app).catch(() => null)
  if (!rpc) return null
  const signal = AbortSignal.timeout(4000)
  const {steps = []} = await rpc('GetCascadeTrajectorySteps', {cascadeId, stepOffset:0, trajectoryVerbosity:2}, signal).catch(() => ({steps:[]}))
  if (!steps.length) return null
  const turns = []
  let assistantBuf = []
  const flushAssistant = () => {
    const text = assistantBuf.join('\n\n').trim()
    if (text) turns.push({role:'assistant', text, time:Date.now()})
    assistantBuf = []
  }
  for (const step of steps) {
    if (step.userInput) {
      flushAssistant()
      const items = Array.isArray(step.userInput.items) ? step.userInput.items : []
      const text = items.map(it => it?.text || '').filter(Boolean).join('\n').trim()
      if (text) turns.push({role:'user', text, time:Date.now()})
      continue
    }
    if (!isTerminal(step)) continue
    const text = step.plannerResponse?.modifiedResponse || step.plannerResponse?.response || step.notifyUser?.notificationContent
    if (text && text.trim()) assistantBuf.push(text.trim())
  }
  flushAssistant()
  return turns
}

export async function readDesktopTitle(cascadeId) {
  if (!cascadeId) return ''
  const app = desktopApp()
  if (!app) return ''
  const rpc = await findDesktop(app).catch(() => null)
  if (!rpc) return ''
  const signal = AbortSignal.timeout(3000)
  const meta = await rpc('GetAllCascadeTrajectories', { excludeSubtrajectories: true }, signal).catch(() => null)
  const summary = meta?.trajectorySummaries?.[cascadeId]?.summary || ''
  return typeof summary === 'string' ? summary.trim() : ''
}

export async function setDesktopTitle(cascadeId, title) {
  if (!cascadeId || !title) return false
  const app = desktopApp()
  if (!app) return false
  const rpc = await findDesktop(app).catch(() => null)
  if (!rpc) return false
  await rpc('UpdateConversationAnnotations', { cascadeIds: [cascadeId], annotations: { title }, mergeAnnotations: true }, AbortSignal.timeout(5000))
  return true
}

export async function listDesktopSessions(projectDir = '') {
  const app = desktopApp()
  if (!app) return []
  const rpc = await findDesktop(app).catch(() => null)
  if (!rpc) return []
  const signal = AbortSignal.timeout(5000)
  const [meta, projList] = await Promise.all([
    rpc('GetAllCascadeTrajectories', { excludeSubtrajectories: true }, signal).catch(() => null),
    rpc('ListProjects', {}, signal).catch(() => ({ projectIds: [] }))
  ])
  const summaries = meta?.trajectorySummaries || {}
  const projectDirs = new Map()
  const projectIds = projList?.projectIds || []
  if (projectIds.length) {
    const { projects = [] } = await rpc('ReadProjects', { ids: projectIds }, signal).catch(() => ({ projects: [] }))
    for (const p of projects) {
      const res = p?.projectResources?.resources || []
      const folder = res.find(r => r?.folderUri?.startsWith('file:'))
      if (folder?.folderUri) {
        const fsPath = await realpath(fileURLToPath(folder.folderUri)).catch(() => cleanPathLike(folder.folderUri))
        projectDirs.set(p.id, fsPath)
      }
    }
  }
  const normTarget = projectDir ? await realpath(projectDir).catch(() => projectDir) : ''
  const out = []
  for (const [id, info] of Object.entries(summaries)) {
    if (!info || Number(info.stepCount || 0) <= 0) continue
    const title = String(info.summary || '').trim() || '未命名 Antigravity 会话'
    let cwd = ''
    const ws = Array.isArray(info.workspaces) ? info.workspaces : []
    for (const w of ws) {
      const uri = w?.workspaceFolderAbsoluteUri || w?.gitRootAbsoluteUri || ''
      if (uri) { cwd = cleanPathLike(uri); break }
    }
    if (!cwd && info.projectId && projectDirs.has(info.projectId)) {
      cwd = projectDirs.get(info.projectId)
    }
    const normCwd = cwd ? await realpath(cwd).catch(() => cwd) : ''
    const updatedAt = info.lastModifiedTime ? (Date.parse(info.lastModifiedTime) || 0) : (info.createdTime ? (Date.parse(info.createdTime) || 0) : 0)
    out.push({
      agent: 'Antigravity',
      nativeId: id,
      title,
      cwd: normCwd || cwd,
      updatedAt,
      sameProject: Boolean(normTarget && normCwd && normTarget === normCwd)
    })
  }
  return out.sort((a, b) => (Number(b.sameProject) - Number(a.sameProject)) || (b.updatedAt - a.updatedAt))
}
