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

async function ensureProject(rpc, cwd, preferred) {
  const uri = pathToFileURL(cwd).href
  const {projectIds = []} = await rpc('ListProjects', {})
  const {projects = [], failedIds = []} = projectIds.length ? await rpc('ReadProjects', {ids:projectIds}) : {}
  if (failedIds.length) throw Error('Antigravity 未能读取项目列表，请稍后重试。')
  const matches = []
  for (const project of projects) {
    if (project.archived || project.sidecar) continue
    for (const resource of project.projectResources?.resources || []) {
      if (!resource.folderUri?.startsWith('file:')) continue
      if (await realpath(fileURLToPath(resource.folderUri)).catch(() => null) === cwd) {
        matches.push(project.id)
        break
      }
    }
  }
  if (matches.includes(preferred)) return preferred
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) throw Error('Antigravity 有多个项目使用同一目录，请在客户端保留唯一的项目映射。')
  const id = randomUUID()
  await rpc('CreateProject', {project:{id, name:path.basename(cwd), projectResources:{resources:[{folderUri:uri}]}}})
  return id
}

function projectFor(rpc, cwd, preferred) {
  // Coalesce first-use creation when multiple rooms use a newly added folder.
  if (!projectRequests.has(cwd)) projectRequests.set(cwd, ensureProject(rpc, cwd, preferred).finally(() => projectRequests.delete(cwd)))
  return projectRequests.get(cwd)
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

export async function runDesktopTurn({app, cwd, session, prompt, historyPrompt, title, images = [], model, effort, write, signal, emit, rpc}) {
  rpc ??= await connect(app, signal)
  const selected = await modelFor(rpc, model, effort, signal)
  const summaries = async () => (await rpc('GetAllCascadeTrajectories', {excludeSubtrajectories:true}, signal)).trajectorySummaries || {}
  const previous = session ? (await summaries())[session] : null
  const project = await projectFor(rpc, cwd, previous?.trajectoryMetadata?.projectId)
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
  if (title && (id !== session || title !== previous?.annotations?.title)) await rpc('UpdateConversationAnnotations', {cascadeIds:[id], annotations:{title}, mergeAnnotations:true}, signal)
  emit('log', '已连接 Antigravity 项目会话' + (selected ? ' · ' + selected.label : ''))
  const toolConfig = write ? {} : {
    autoInteractionBehavior:2,
    permissionConfig:{permissionsV2:true, effectivePermissionPreset:2, effectiveGrants:{
      allow:['read_file(' + cwd + ')'], deny:['write_file(*)','command(*)','unsandboxed(*)','mcp(*)','execute_url(*)','download_url(*)']
    }}
  }
  const messageId = randomUUID()
  const plannerConfig = {toolConfig, ...(selected ? {requestedModel:selected.modelOrAlias} : {})}
  const body = {cascadeId:id, clientMessageId:messageId, items:[{text:prompt}], media:images.map(x => ({mimeType:x.mimeType, inlineData:x.base64})),
    cascadeConfig:{plannerConfig}, customAgentSpec:{builtinAgent:{defaultAgent:{isGoogle:false, isInteractive:true, surface:'AGENT_SURFACE_HUB'}}}}
  let sending = false, mine = false, output = false, nextUser = false, lastError = ''
  const settled = new Set(), seenRunning = new Set()
  const isTerminal = step => ['DONE','ERROR','CANCELED','INTERRUPTED','INVALID','CLEARED'].some(s => step.status?.endsWith('_' + s))
  try {
    sending = true
    await rpc('SendUserCascadeMessage', body, signal)
    const sentAt = Date.now()
    for (;;) {
      const summary = (await summaries())[id]
      if (!summary) throw Error('Antigravity 会话已经不可用。')
      const startOffset = offset
      const {steps = []} = await rpc('GetCascadeTrajectorySteps', {cascadeId:id, stepOffset:startOffset, trajectoryVerbosity:2}, signal)
      let pendingResponse = false
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i], idx = startOffset + i
        if (step.userInput) {
          if (step.userInput.clientMessageId === messageId) mine = true
          else if (mine) { nextUser = true; break }
        }
        if (settled.has(idx)) continue
        if (!isTerminal(step)) {
          if (mine && step.plannerResponse) pendingResponse = true
          if (mine && !step.userInput && !step.plannerResponse && !step.errorMessage && !seenRunning.has(idx)) {
            const name = step.metadata?.toolCall?.name || step.type?.replace('CORTEX_STEP_TYPE_', '').toLowerCase()
            if (name) {
              seenRunning.add(idx)
              emit('log', '::step::' + JSON.stringify({id:'ag-' + idx, kind:'tool', title:name, status:'running'}))
            }
          }
          continue
        }
        settled.add(idx)
        if (!mine || step.userInput) continue
        const text = step.plannerResponse?.modifiedResponse || step.plannerResponse?.response || step.notifyUser?.notificationContent
        if (text) { emit('text', (output ? '\n\n' : '') + text); output = true }
        if (step.errorMessage) lastError = step.errorMessage.error?.userErrorMessage || step.errorMessage.error?.shortError || 'Antigravity 执行失败'
        if (!step.plannerResponse && !step.errorMessage) {
          const name = step.metadata?.toolCall?.name || step.type?.replace('CORTEX_STEP_TYPE_', '').toLowerCase()
          if (name) emit('log', '::step::' + JSON.stringify({id:'ag-' + idx, kind:'tool', title:name, status:step.error?'error':'done'}))
        }
      }
      while (settled.has(offset)) { settled.delete(offset); seenRunning.delete(offset); offset++ }
      const fullyIdle = Boolean(summary.status?.endsWith('_IDLE') && !summary.notFullyIdle)
      const reachedEnd = startOffset + steps.length >= Number(summary.stepCount || 0)
      if (!mine && fullyIdle && Date.now() - sentAt > 20000) throw Error('客户端未确认这条消息，请检查该项目的原生会话。')
      if (nextUser || (mine && fullyIdle && reachedEnd && !pendingResponse)) break
      await delay(750, null, {signal})
    }
    if (lastError || !output) throw Error(lastError || 'Antigravity 已结束本轮，未返回正文。')
  } finally {
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
