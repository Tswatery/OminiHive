import {randomUUID} from 'node:crypto'
import { promisify } from 'node:util'
import { spawn,execFile } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, accessSync, constants, writeFileSync, unlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'

import {names,dirs,binary,initClients} from './clients.mjs'
import {desktopApp,runDesktopTurn} from './antigravity-desktop.mjs'
import {ensureCodexProject,syncCodexProjectStandalone,setCodexThreadNameStandalone} from './codex-projects.mjs'
import {antigravityEnv} from './antigravity-env.mjs'
import {resolveProviderConfig,prepareCodexHome,legacyCodexRollout} from './ccswitch.mjs'
import {EFFORT_LEVELS,isValidEffort,normalizeModelEfforts,applyReasoningEffort} from './reasoning.mjs'
import {createStepAdapter} from './step-tracker.mjs'

// Every agent CLI runs in its own process group (detached). Track them so app quit can
// terminate the whole group synchronously instead of leaving orphaned CLIs behind.
const liveChildren=new Set()
export function killAllAgentProcesses(signal='SIGTERM'){
  for(const child of liveChildren){try{process.kill(-child.pid,signal)}catch{}}
}
export {availability} from './clients.mjs'
const ordered=EFFORT_LEVELS
const pendingInteractions=new Map()

export function buildDeepSeekArgs({ prompt, accessMode, write, session, patchFile } = {}) {
  const args = ['headless']
  if (patchFile) args.push('--patch', patchFile)
  args.push('--json')
  if (accessMode === 'full') {
    args.push('--permission-mode', 'danger-full-access')
  } else if (write) {
    args.push('--permission-mode', 'workspace-write', '--approval-policy', 'never')
  } else {
    args.push('--permission-mode', 'read-only', '--approval-policy', 'never')
  }
  if (session) args.push('--session-id', session)
  args.push('--', prompt)
  return args
}

function createDeepSeekModelPatch(model) {
  if (!model) return null
  try {
    const p = path.join(homedir(), '.dsh', 'profiles', 'headless', 'cordis.patch.yml')
    if (!existsSync(p)) return null
    const raw = readFileSync(p, 'utf8')
    const defBlock = raw.match(/-\s*id:\s*agent-default-model[\s\S]*?(?=\n-\s*id:|\s*$)/)?.[0] || ''
    const defaultModel = defBlock.match(/^\s*model:\s*['"]?([^\s'"#]+)['"]?/m)?.[1] || ''
    const defaultProvider = defBlock.match(/^\s*provider:\s*['"]?([^\s'"#]+)['"]?/m)?.[1] || ''
    if (defaultModel && model === defaultModel) return null

    let targetProvider = ''
    const llmBlock = raw.match(/-\s*id:\s*llm-pi-ai[\s\S]*?(?=\n-\s*id:|\s*$)/)?.[0] || ''
    if (llmBlock) {
      let currentProvider = ''
      for (const line of llmBlock.split(/\r?\n/)) {
        const provMatch = line.match(/^[ \t]{4,6}([\w.-]+):\s*$/)
        if (provMatch && provMatch[1] !== 'providers' && provMatch[1] !== 'models' && provMatch[1] !== 'input') {
          currentProvider = provMatch[1]
          continue
        }
        const idMatch = line.match(/^[ \t]+-\s*id:\s*['"]?([^\s'"#]+)['"]?/)
        if (idMatch && idMatch[1].trim() === model && currentProvider) {
          targetProvider = currentProvider
          break
        }
      }
    }
    if (!targetProvider) targetProvider = defaultProvider
    if (!targetProvider) return null

    const patchPath = path.join(tmpdir(), `ominihive-dsh-patch-${randomUUID()}.yml`)
    const content = `- id: agent-default-model\n  config:\n    provider: ${JSON.stringify(targetProvider)}\n    model: ${JSON.stringify(model)}\n`
    writeFileSync(patchPath, content, { encoding: 'utf8', mode: 0o600 })
    return patchPath
  } catch {
    return null
  }
}

export function respondAgentInteraction(req){
  const key=req?.interactionId||req?.cascadeId||''
  const entry=key?pendingInteractions.get(key):null
  if(!entry)return false
  return entry.respond(req?.payload||{})
}
export function gravityModels(text){
  const families=new Map()
  for(const line of text.trim().split(/\r?\n/)){
    const [native,label]=line.split('\t');if(!label)continue
    const suffix=native.match(/-(minimal|low|medium|high|xhigh|max|ultra)$/)?.[1]
    const id=suffix?native.slice(0,-suffix.length-1):native
    const entry=families.get(id)||{id,label:suffix?label.replace(/\s*\([^()]*\)$/,''):label,efforts:[],variants:{}}
    if(suffix){entry.variants[suffix]=native;entry.efforts=ordered.filter(e=>entry.variants[e])}
    else entry.native=native
    families.set(id,entry)
  }
  return [...families.values()]
}

function claudeModels(env){
  return ['sonnet','opus','fable','haiku'].map(role=>{
    const key='ANTHROPIC_DEFAULT_'+role.toUpperCase()+'_MODEL'
    return {role,id:env[key]||role,label:env[key+'_NAME']||env[key]||role}
  })
}
export async function modelList(agent,cwd){
  const list = await loadRawModelList(agent,cwd)
  return normalizeModelEfforts(agent,list)
}
async function loadRawModelList(agent,cwd){
  await initClients()
  if(!Object.hasOwn(names,agent)||!binary(agent))throw Error('未找到本机客户端')
  if(agent==='Claude'){
    const env={...process.env}
    const role=claudeConfig(env,[])
    const {stdout}=await promisify(execFile)(binary(agent),['--help'],{timeout:5000})
    const flags=stdout.match(/--effort <level>[^(]*\(([^)]+)\)/)?.[1]?.split(',').map(x=>x.trim())||[]
    return claudeModels(env).map(m=>({...m,isDefault:m.role===role,efforts:ordered.filter(e=>flags.includes(e))}))
  }
  if(agent==='Codex')return execute({agent,cwd,signal:AbortSignal.timeout(16000),catalogOnly:true})
  if(agent==='Gemini'){
    return [
      {id:'gemini-2.5-pro',label:'Gemini 2.5 Pro',efforts:[],isDefault:true},
      {id:'gemini-2.5-flash',label:'Gemini 2.5 Flash',efforts:[]}
    ]
  }
  if(agent==='OpenCode'){
    try{
      const {stdout}=await promisify(execFile)(binary(agent),['models'],{cwd,timeout:12000,env:{...process.env,PATH:dirs.join(':')}})
      const list=stdout.trim().split(/\r?\n/).filter(Boolean).slice(0,20).map((line,i)=>({id:line.trim(),label:line.trim(),efforts:[],isDefault:i===0}))
      if(list.length)return list
    }catch{}
    return [{id:'',label:'跟随 OpenCode 默认',efforts:[],isDefault:true}]
  }
  if(agent==='Kimi')return [{id:'',label:'跟随 Kimi 默认配置',efforts:[],isDefault:true},{id:'kimi-for-coding',label:'Kimi for Coding',efforts:[]}]
  if(agent==='Qwen')return [{id:'',label:'跟随 Qwen 默认配置',efforts:[],isDefault:true},{id:'qwen3-coder-plus',label:'Qwen3 Coder Plus',efforts:[]}]
  if(agent==='OpenClaw')return [{id:'',label:'跟随 OpenClaw 默认配置',efforts:[],isDefault:true}]
  if(agent==='Grok')return [{id:'',label:'跟随 Grok 默认配置',efforts:[],isDefault:true},{id:'grok-4',label:'Grok 4',efforts:[]}]
  if(agent==='Hermes')return [{id:'',label:'跟随 Hermes 默认配置',efforts:[],isDefault:true}]
  if(agent==='Pi')return [{id:'',label:'跟随 Pi 默认配置',efforts:[],isDefault:true}]
  if(agent==='MiniMax')return [{id:'',label:'跟随 MiniMax 默认配置',efforts:[],isDefault:true}]
  if(agent==='DeepSeek'){
    const out=[]
    const seen=new Set()
    const pushModel=(id,label,isDefault=false)=>{
      if(!id||seen.has(id))return
      seen.add(id)
      out.push({id,label:label||id,efforts:[],isDefault})
    }
    try{
      let defaultModel=''
      const profiles=['headless','web','desktop']
      for(const prof of profiles){
        const p=path.join(homedir(),'.dsh','profiles',prof,'cordis.patch.yml')
        if(!existsSync(p))continue
        const raw=readFileSync(p,'utf8')
        const defBlock=raw.match(/-\s*id:\s*agent-default-model[\s\S]*?(?=\n-\s*id:|\s*$)/)?.[0]||''
        const dm=defBlock.match(/^\s*model:\s*['"]?([^\s'"#]+)['"]?/m)?.[1]||''
        if(dm && !defaultModel)defaultModel=dm
        const llmBlock=raw.match(/-\s*id:\s*llm-pi-ai[\s\S]*?(?=\n-\s*id:|\s*$)/)?.[0]||''
        for(const m of llmBlock.matchAll(/^[ \t]+-\s*id:\s*['"]?([^\s'"#]+)['"]?(?:\r?\n[ \t]+name:\s*['"]?([^\r\n'"#]+)['"]?\s*)?/gm)){
          const id=m[1].trim()
          const name=(m[2]||id).trim()
          pushModel(id,name,id===defaultModel)
        }
        if(defaultModel && !seen.has(defaultModel))pushModel(defaultModel,defaultModel,true)
        if(out.length)break
      }
      if(out.length){
        if(!out.some(m=>m.isDefault))out[0].isDefault=true
        return out
      }
    }catch{}
    return [{id:'',label:'跟随 DeepSeek Harness 默认配置',efforts:[],isDefault:true}]
  }
  if(agent==='OhMyPi'){
    const ompEfforts=['off','low','medium','high','xhigh','max']
    const out=[]
    const seen=new Set()
    const pushModel=(id,label,isDefault=false)=>{
      if(!id||seen.has(id))return
      seen.add(id)
      out.push({id,label:label||id,efforts:ompEfforts,isDefault})
    }
    try{
      const ompDir=path.join(homedir(),'.omp','agent')
      const cfgPath=path.join(ompDir,'config.yml')
      const modelsPath=path.join(ompDir,'models.yml')
      let defaultSpec=''
      if(existsSync(cfgPath)){
        const cfg=readFileSync(cfgPath,'utf8')
        const roleBlock=cfg.match(/^modelRoles:\s*\r?\n((?:[ \t]+.*\r?\n?)*)/m)?.[1]||''
        defaultSpec=roleBlock.match(/^\s*default:\s*['"]?([^\s'"#]+)['"]?/m)?.[1]||''
      }
      const shortOf=spec=>spec.includes('/')?spec.split('/').slice(1).join('/'):spec
      if(existsSync(modelsPath)){
        const raw=readFileSync(modelsPath,'utf8')
        let curProvider=''
        for(const line of raw.split(/\r?\n/)){
          const pm=line.match(/^  ([A-Za-z0-9._-]+):\s*$/)
          if(pm){curProvider=pm[1];continue}
          const mm=line.match(/^\s*-\s*id:\s*['"]?([^\s'"#]+)['"]?/)
          if(mm){
            const rawId=mm[1].trim()
            const fullId=curProvider&&!rawId.includes('/')?`${curProvider}/${rawId}`:rawId
            const isDef=Boolean(defaultSpec&&(fullId===defaultSpec||rawId===defaultSpec||rawId===shortOf(defaultSpec)))
            pushModel(fullId,rawId,isDef)
          }
        }
      }
      if(defaultSpec && !out.some(m=>m.isDefault)){
        pushModel(defaultSpec,shortOf(defaultSpec),true)
      }
      if(out.length){
        if(!out.some(m=>m.isDefault))out[0].isDefault=true
        return out
      }
    }catch{}
    return [{id:'',label:'跟随 Oh My Pi 默认配置',efforts:ompEfforts,isDefault:true}]
  }
  if(agent==='WorkBuddy'){
    const out=[{id:'',label:'Auto (WorkBuddy 默认)',efforts:[],isDefault:true}]
    const seen=new Set(['','auto'])
    try{
      const cacheDir=path.join(homedir(),'.workbuddy','cache')
      if(existsSync(cacheDir)){
        const files=readdirSync(cacheDir)
          .filter(f=>/^acc-product-config-v3-.*\.json$/.test(f))
          .map(f=>({f:path.join(cacheDir,f),t:statSync(path.join(cacheDir,f)).mtimeMs}))
          .sort((a,b)=>b.t-a.t)
        for(const item of files){
          try{
            const cfg=JSON.parse(readFileSync(item.f,'utf8'))
            const nameMap=new Map((Array.isArray(cfg.models)?cfg.models:[]).map(m=>[m.id,m.name||m.displayName||m.id]))
            const cliAgent=Array.isArray(cfg.agents)?(cfg.agents.find(a=>a.name==='cli'||a.tags?.includes('default'))||cfg.agents[0]):null
            const orderedIds=Array.isArray(cliAgent?.models)&&cliAgent.models.length?cliAgent.models:[...nameMap.keys()]
            for(const id of orderedIds){
              if(!id||seen.has(id))continue
              seen.add(id)
              out.push({id,label:nameMap.get(id)||id,efforts:[],isDefault:false})
            }
            if(out.length>1)return out
          }catch{}
        }
      }
    }catch{}
    const exe=binary(agent)
    try{
      const isMjs=exe.endsWith('.mjs')
      const {stdout}=await promisify(execFile)(isMjs?process.execPath:exe,isMjs?[exe,'--help']:['--help'],{timeout:5000,env:{...process.env,PATH:dirs.join(':'),...(isMjs?{ELECTRON_RUN_AS_NODE:'1'}:{})}})
      const raw=stdout.match(/Currently supported:\s*\(([^)]+)\)/i)?.[1]
      if(raw){
        for(const id of raw.split(',').map(s=>s.trim()).filter(Boolean)){
          if(seen.has(id))continue
          seen.add(id)
          out.push({id,label:id,efforts:[],isDefault:false})
        }
        if(out.length>1)return out
      }
    }catch{}
    return out
  }
  const {stdout}=await promisify(execFile)(binary(agent),['models'],{cwd,timeout:16000,env:await antigravityEnv({...process.env,PATH:dirs.join(':')})})
  return gravityModels(stdout)
}
function claudeConfig(env,args,model,provider=null) {
  // Restricted mode ignores user settings. Inherit only the user's provider configuration.
  const file = path.join(homedir(),'.claude/settings.json')
  const settings = provider?.cfg || (existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{})
  // A route change must never pair an inherited token with the new gateway.
  if(settings.env?.ANTHROPIC_BASE_URL || provider){
    for(const key of Object.keys(env)){
      if(/^ANTHROPIC_(AUTH_TOKEN|API_KEY|BASE_URL|MODEL|DEFAULT_.*_MODEL(_NAME)?)$/.test(key)) delete env[key]
    }
  }
  for (const [key,value] of Object.entries(settings.env||{})) {
    if (/^ANTHROPIC_(AUTH_TOKEN|API_KEY|BASE_URL|MODEL|DEFAULT_(FABLE|OPUS|HAIKU|SONNET)_MODEL(_NAME)?)$/.test(key) && typeof value==='string') env[key]=value
  }
  const selected=model?claudeModels(env).find(m=>m.id===model):null
  if(model&&!selected)throw Error('Claude 路由已变更，请重新选择模型')
  const role=selected?.role||settings.model
  if(typeof role==='string')args.push('--model',role)
  return role
}

export async function syncCodexProject(cwd, projectName = '') {
  try {
    await initClients()
    const exe = binary('Codex')
    if (!exe) return null
    const env = { ...process.env, PATH: dirs.join(':') }
    return await syncCodexProjectStandalone({ exe, cwd, projectName, env })
  } catch {
    return null
  }
}

export async function setCodexThreadName(threadId, name) {
  try {
    await initClients()
    const exe = binary('Codex')
    if (!exe) return false
    return await setCodexThreadNameStandalone({ exe, threadId, name, env: { ...process.env, PATH: dirs.join(':') } })
  } catch {
    return false
  }
}

export async function execute({agent,cwd,projectName='',prompt,historyPrompt,title,titleLocked=false,images=[],session,write=false,access='',signal,emit,model='',effort='',providerId='',catalogOnly=false}) {
  const accessMode = (access === 'read-only' || access === 'workspace' || access === 'full') ? access : (write ? 'workspace' : 'read-only')
  write = accessMode !== 'read-only'
  await initClients()
  if(effort&&!ordered.includes(effort))throw Error('未知的思考强度')
  const exe=binary(agent)
  if (!exe) throw Error('未找到 '+names[agent])
  signal.throwIfAborted()
  const provider=providerId?resolveProviderConfig(agent,providerId):null
  if (providerId && !provider) throw Error('渠道配置已变化，请重新选择。')
  const gravityApp = agent === 'Antigravity' && !provider && desktopApp()
  if (gravityApp) {
    return runDesktopTurn({app:gravityApp,cwd,projectName,prompt,historyPrompt,title,titleLocked,session,images,write,model,effort,signal,emit})
  }
  if (agent === 'Antigravity') emit('log', provider ? '当前渠道使用独立 CLI 会话。' : '未安装 Antigravity 桌面端，使用本机 CLI 会话。')
  const env={...process.env, PATH:dirs.join(':')}
  for(const k of Object.keys(env)) if(k.startsWith('CODEX_') || k==='CLAUDECODE') {
    if (k!=='CODEX_HOME' && k!=='CODEX_SQLITE_HOME') delete env[k]
  }
  const codex=agent==='Codex', claude=agent==='Claude', workbuddy=agent==='WorkBuddy', gemini=agent==='Gemini', opencode=agent==='OpenCode', kimi=agent==='Kimi', qwen=agent==='Qwen', openclaw=agent==='OpenClaw', grok=agent==='Grok', hermes=agent==='Hermes', pi=agent==='Pi', minimax=agent==='MiniMax', deepseek=agent==='DeepSeek', ohMyPi=agent==='OhMyPi'
  const extraSimpleCli = hermes || pi || minimax || deepseek || ohMyPi
  const simpleCli = gemini || opencode || kimi || qwen || openclaw || grok || extraSimpleCli
  if(codex && provider){
    const sharedHome=env.CODEX_HOME||path.join(homedir(),'.codex')
    env.CODEX_SQLITE_HOME ||= sharedHome
    const customHome=prepareCodexHome(provider,sharedHome)
    if(customHome)env.CODEX_HOME=customHome
  }
  if(!codex && !claude && provider?.cfg?.env){
    for(const [k,v] of Object.entries(provider.cfg.env)) if(typeof v==='string')env[k]=v
  }
  let args=codex ? ['app-server','--stdio'] : (write ? ['acp','--dangerously-skip-permissions'] : ['--sandbox','acp'])
  const imgPrompt=images.length?prompt+'\n\n[附带文件路径：\n'+images.map(i=>i.path).join('\n')+'\n]':prompt
  if(gemini){
    args=['-p',imgPrompt,'--output-format','stream-json']
    if(write)args.push('--yolo')
    if(model)args.push('--model',model)
    if(session)args.push('--resume',session)
  }
  if(opencode){
    args=['run','--format','json',...(session?['--session',session]:(title?['--title',title]:[]))]
    if(model)args.push('-m',model)
    args.push('--',imgPrompt)
  }
  if(kimi){
    args=['-p',imgPrompt,'--output-format','stream-json',write?'--auto':'--plan']
    if(model)args.push('-m',model)
    if(session)args.push('-S',session)
  }
  if(qwen){
    args=['-p',imgPrompt,'--output-format','stream-json']
    if(session)args.push('--resume',session)
    if(write)args.push('--yolo')
    if(model)args.push('--model',model)
  }
  const explicitSession = (grok || openclaw) ? session || randomUUID() : undefined
  if(openclaw){
    args=['agent','--session-id',explicitSession,'--message',imgPrompt]
  }
  if(grok){
    args=['--cwd',cwd,session?'--resume':'--session-id',explicitSession]
    if(write)args.push('--always-approve')
    if(model)args.push('--model',model)
    args.push('-p',imgPrompt)
  }
  if(hermes){
    args=['chat','-q',imgPrompt]
    if(model)args.push('--model',model)
  }
  if(pi || ohMyPi){
    args=['-p','--mode','json',imgPrompt]
    if(model)args.push('--model',model)
  }
  if(minimax){
    args=['-p',imgPrompt]
    if(model)args.push('--model',model)
  }
  let deepseekPatchFile=null
  if(deepseek){
    deepseekPatchFile=createDeepSeekModelPatch(model)
    args=buildDeepSeekArgs({prompt:imgPrompt,accessMode,write,session,patchFile:deepseekPatchFile})
  }
  if(claude) {
    args=['-p','--verbose','--output-format','stream-json','--include-partial-messages','--permission-mode',accessMode==='full'?'bypassPermissions':(write?'acceptEdits':'dontAsk')]
    if(accessMode!=='full') args.push('--restricted','--strict-mcp-config','--tools',write?'Read,Glob,Grep,Edit,Write':'Read,Glob,Grep')
    if(images.length){
      const dirsSet=new Set(images.map(i=>path.dirname(i.path)))
      for(const d of dirsSet)args.push('--add-dir',d)
    }
    claudeConfig(env,args,model,provider)
    if(session) args.push('--resume',session)
  }
  if(workbuddy) {
    args=['-p','--verbose','--output-format','stream-json','--include-partial-messages','--permission-mode',accessMode==='full'?'bypassPermissions':(write?'acceptEdits':'dontAsk')]
    if(accessMode!=='full') args.push('--tools',write?'Read,Glob,Grep,Edit,Write':'Read,Glob,Grep')
    if(images.length){
      const dirsSet=new Set(images.map(i=>path.dirname(i.path)))
      for(const d of dirsSet)args.push('--add-dir',d)
    }
    if(model)args.push('--model',model)
    if(session)args.push('--resume',session)
  }
  if(effort && !codex) applyReasoningEffort({agent,effort,args,env,emit})
  const isMjsExe = exe.endsWith('.mjs')
  const spawnCmd = isMjsExe ? process.execPath : exe
  const spawnArgs = isMjsExe ? [exe, ...args] : args
  if (isMjsExe) env.ELECTRON_RUN_AS_NODE = '1'
  const child=spawn(spawnCmd,spawnArgs,{cwd,env:agent==='Antigravity'?await antigravityEnv(env):env,stdio:'pipe',detached:true})
  liveChildren.add(child)
  child.once('close',()=>liveChildren.delete(child))
  const lines=createInterface({input:child.stdout})
  const pending=new Map()
  const runInteractionIds=new Set()
  let seq=0, failure, stderr='', finish, output='', currentItem='', deltas='', active=false, thoughtBuf='', lastThoughtEmit=0, closed=false, codexThreadId='', codexTurnId=''
  const exited=new Promise(resolve=>{child.once('close',()=>{closed=true;resolve()})})
  const done=new Promise((resolve,reject)=>{ finish=err=>err?reject(err):resolve() })
  done.catch(()=>{})
  function fail(e){failure=e;finish(e);for(const p of pending.values())p.reject(e);pending.clear()}
  function stop(){try{process.kill(-child.pid,'SIGTERM')}catch{}}
  const aborted=()=>{fail(Error('运行已停止'));if(!codex)stop()}
  signal.addEventListener('abort',aborted,{once:true})
  child.stderr.on('data',data=>{stderr=(stderr+data).slice(-1500)})
  child.on('error',fail)
  child.stdin.on('error',e=>{if(e.code!=='EPIPE')fail(e)})
  child.on('close',code=>fail(Error('CLI 已退出（'+code+'）'+(stderr? ' '+stderr.slice(-500):''))))
  const send=obj=>child.stdin.write(JSON.stringify(codex?obj:{jsonrpc:'2.0',...obj})+'\n')
  function request(method,params){
    if(failure)return Promise.reject(failure)
    const id=++seq
    return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});send({id,method,params})})
  }
  function emitStep(step){emit('log','::step::'+JSON.stringify(step))}
  function extractToolResultText(content){
    if(typeof content==='string')return content
    if(Array.isArray(content)){
      return content.map(item=>{
        if(typeof item==='string')return item
        if(item && typeof item==='object'){
          if(typeof item.text==='string')return item.text
          if(typeof item.content==='string')return item.content
          if(item.type==='image')return '[图片]'
          try{return JSON.stringify(item)}catch{return ''}
        }
        return ''
      }).filter(Boolean).join('\n')
    }
    if(content && typeof content==='object'){
      try{return JSON.stringify(content,null,2)}catch{return ''}
    }
    return ''
  }
  function summarizeToolTitle(name,input){
    const toolName=name||'调用工具'
    if(!input || typeof input!=='object')return toolName
    const file=input.file_path||input.path||input.notebook_path||input.target_file
    const cmd=input.command||input.cmd
    const pattern=input.pattern||input.query||input.regex||input.glob
    const url=input.url
    let hint=''
    if(typeof cmd==='string'&&cmd.trim())hint=cmd.trim().replace(/\s+/g,' ')
    else if(typeof file==='string'&&file.trim())hint=file.trim()
    else if(typeof pattern==='string'&&pattern.trim())hint=pattern.trim()+(typeof input.path==='string'&&input.path.trim()?` (${input.path.trim()})`:'')
    else if(typeof url==='string'&&url.trim())hint=url.trim()
    else {
      for(const v of Object.values(input)){
        if(typeof v==='string'&&v.trim()){hint=v.trim().replace(/\s+/g,' ');break}
      }
    }
    if(!hint)return toolName
    return `${toolName} · ${hint.length>68?hint.slice(0,68)+'…':hint}`
  }
  function formatToolInput(input){
    if(input==null)return ''
    if(typeof input==='string')return input.trim()
    try{
      const json=JSON.stringify(input,null,2)
      return json==='{}'?'':json
    }catch{return ''}
  }
  const toolSteps=new Map()
  const blockIndexToToolId=new Map()
  const codexReasonBuf=new Map()
  let claudeThinkSeq=0, claudeThinkId='', claudeThinkBuf='', lastClaudeThinkEmit=0, claudeThinkActive=false
  function finishClaudeThink(){
    if(!claudeThinkActive || !claudeThinkId)return
    claudeThinkActive=false
    const detail=claudeThinkBuf.trim()
    emitStep({id:claudeThinkId,kind:'thought',title:'思考过程',status:'done',detail:detail?detail.slice(-2000):undefined})
  }
  if(provider)emitStep({id:'meta-provider',kind:'info',title:'渠道 · '+provider.name,status:'done'})
  function append(s){if(s){output+=s;emit('text',s)}}
  const usesStepAdapter = opencode || qwen || openclaw || grok || extraSimpleCli
  const stepAdapter = usesStepAdapter ? createStepAdapter(agent, { emit, append, fail }) : null
  if (stepAdapter && (openclaw || grok || hermes || minimax || deepseek)) {
    child.stderr.on('data', data => stepAdapter.onStderrChunk(data))
  }
  lines.on('line',line=>{
    if(stepAdapter){
      stepAdapter.handleLine(line)
      return
    }
    if(gemini || kimi){
      let e; try{e=JSON.parse(line)}catch{if(line.trim())append(line+'\n');return}
      if(e.session_id)emit('session',e.session_id)
      if(e.type==='message'&&e.role==='assistant'&&e.content)append(e.content)
      else if(e.content&&typeof e.content==='string'&&e.role==='assistant')append(e.content)
      if(e.delta?.text)append(e.delta.text)
      if(e.type==='tool_use'){
        const tid=e.tool_id||e.tool_name||'tool'
        const input=e.parameters??e.input??e.arguments
        const title=summarizeToolTitle(e.tool_name||'调用工具',input)
        const inStr=formatToolInput(input)
        toolSteps.set(tid,{id:tid,name:e.tool_name||'调用工具',title,inStr})
        emitStep({id:tid,kind:'tool',title,status:'running',detail:inStr?`输入：\n${inStr.slice(0,800)}`:undefined})
      }
      if(e.type==='tool_result'){
        const tid=e.tool_id||'tool'
        const prev=toolSteps.get(tid)
        const title=prev?.title||e.tool_name||'工具完成'
        const outStr=extractToolResultText(e.output??e.content??e.result).trim()
        const parts=[]
        if(prev?.inStr)parts.push('输入：\n'+prev.inStr.slice(0,800))
        if(outStr)parts.push('返回：\n'+outStr.slice(-1200))
        emitStep({id:tid,kind:'tool',title,status:e.status==='error'?'error':'done',detail:parts.length?parts.join('\n\n'):undefined})
      }
      if(e.type==='result'&&e.response&&!output)append(e.response)
      return
    }
    let e; try{e=JSON.parse(line)}catch{return}
    const p=e.params??{}
    if(claude || workbuddy){
      if(e.type==='system'&&e.subtype==='init'){emit('session',e.session_id);if(e.model)emitStep({id:'meta-model',kind:'info',title:'模型 · '+e.model,status:'done'})}
      const block=e.event
      if(block?.type==='content_block_start'&&block.content_block?.type==='thinking'){
        claudeThinkId='claude-think-'+(++claudeThinkSeq)
        claudeThinkBuf=typeof block.content_block.thinking==='string'?block.content_block.thinking:''
        claudeThinkActive=true
        lastClaudeThinkEmit=Date.now()
        emitStep({id:claudeThinkId,kind:'thought',title:'思考中',status:'running',detail:claudeThinkBuf?claudeThinkBuf.slice(-2000):undefined})
      }
      if(block?.type==='content_block_start'&&block.content_block?.type==='tool_use'){
        finishClaudeThink()
        const tid=block.content_block.id||('tool-'+block.index)
        const name=block.content_block.name||'调用工具'
        const initInput=block.content_block.input
        const inStr=formatToolInput(initInput)
        const title=summarizeToolTitle(name,initInput)
        toolSteps.set(tid,{id:tid,name,inputJson:'',title,inStr})
        if(block.index!=null)blockIndexToToolId.set(block.index,tid)
        emitStep({id:tid,kind:'tool',title,status:'running',detail:inStr?`输入：\n${inStr.slice(0,800)}`:undefined})
      }
      if(block?.type==='content_block_delta'){
        if(typeof block.delta?.thinking==='string' && block.delta.thinking){
          if(!claudeThinkActive){
            claudeThinkId='claude-think-'+(++claudeThinkSeq)
            claudeThinkBuf=''
            claudeThinkActive=true
          }
          claudeThinkBuf=(claudeThinkBuf+block.delta.thinking).slice(-3000)
          const now=Date.now()
          if(now-lastClaudeThinkEmit>300){
            lastClaudeThinkEmit=now
            emitStep({id:claudeThinkId,kind:'thought',title:'思考中',status:'running',detail:claudeThinkBuf.slice(-2000)})
          }
        }
        if(typeof block.delta?.partial_json==='string' && block.index!=null){
          const tid=blockIndexToToolId.get(block.index)
          const st=tid?toolSteps.get(tid):null
          if(st)st.inputJson=(st.inputJson+block.delta.partial_json).slice(0,4000)
        }
        if(block.delta?.text){
          finishClaudeThink()
          append(block.delta.text)
        }
      }
      if(block?.type==='content_block_stop'){
        if(claudeThinkActive && (block.index==null || !blockIndexToToolId.has(block.index))){
          finishClaudeThink()
        }
        if(block.index!=null && blockIndexToToolId.has(block.index)){
          const tid=blockIndexToToolId.get(block.index)
          const st=tid?toolSteps.get(tid):null
          if(st && st.inputJson){
            try{
              const parsed=JSON.parse(st.inputJson)
              st.title=summarizeToolTitle(st.name,parsed)
              st.inStr=formatToolInput(parsed)
              emitStep({id:tid,kind:'tool',title:st.title,status:'running',detail:st.inStr?`输入：\n${st.inStr.slice(0,800)}`:undefined})
            }catch{}
          }
        }
      }
      if(e.type==='assistant'&&Array.isArray(e.message?.content)){
        for(const c of e.message.content){
          if(c.type==='thinking' && typeof c.thinking==='string' && c.thinking.trim()){
            const tid=claudeThinkId||('claude-think-'+(++claudeThinkSeq))
            claudeThinkActive=false
            claudeThinkBuf=c.thinking
            emitStep({id:tid,kind:'thought',title:'思考过程',status:'done',detail:c.thinking.trim().slice(-2000)})
          }
          if(c.type==='tool_use'){
            const tid=c.id||('tool-'+c.name)
            const title=summarizeToolTitle(c.name,c.input)
            const inStr=formatToolInput(c.input)
            toolSteps.set(tid,{id:tid,name:c.name||'调用工具',inputJson:'',title,inStr})
            emitStep({id:tid,kind:'tool',title,status:'running',detail:inStr?`输入：\n${inStr.slice(0,800)}`:undefined})
          }
        }
      }
      if(e.type==='user'&&Array.isArray(e.message?.content)){
        claudeThinkId=''
        for(const c of e.message.content){
          if(c.type==='tool_result'){
            const tid=c.tool_use_id||'tool-result'
            const prev=toolSteps.get(tid)
            const title=prev?.title||'工具调用'
            const outStr=extractToolResultText(c.content).trim()
            const parts=[]
            if(prev?.inStr)parts.push('输入：\n'+prev.inStr.slice(0,800))
            if(outStr)parts.push('返回：\n'+outStr.slice(-1400))
            emitStep({id:tid,kind:'tool',title,status:c.is_error?'error':'done',detail:parts.length?parts.join('\n\n'):undefined})
          }
        }
      }
      if(e.type==='result'){
        finishClaudeThink()
        if(e.is_error)fail(Error(e.result||e.errors?.join('\n')||(workbuddy?'WorkBuddy 执行失败':'Claude 执行失败')))
        else {if(!output)append(e.result);finish()}
      }
      return
    }
    if(e.id!=null && e.method){
      if(e.method==='session/request_permission'){
        if(write){
          const opts=e.params?.options||[]
          const allow=opts.find(o=>o.kind==='allow_always'||o.kind==='allow_once')||opts[0]
          if(allow?.optionId){
            send({id:e.id,result:{outcome:{outcome:'selected',optionId:allow.optionId}}})
            return
          }
        }
        const title=e.params?.toolCall?.title||'操作'
        emitStep({id:'perm-'+(e.params?.toolCall?.toolCallId||e.id),kind:'info',title:'权限请求已自动取消（只读模式）：'+title,status:'error'})
        send({id:e.id,result:{outcome:{outcome:'cancelled'}}})
      } else if (e.method==='item/tool/requestUserInput') {
        const questions = Array.isArray(e.params?.questions) ? e.params.questions : []
        if (!questions.length) {
          send({ id: e.id, result: { answers: {} } })
          return
        }
        const collected = {}
        const showQuestion = (qIdx) => {
          const q = questions[qIdx]
          const qId = String(q?.id || ('q-' + qIdx))
          const stepId = `codex-ask-${e.id}-${qIdx}`
          const interactionId = `codex-ask-${randomUUID()}`
          const rawOpts = Array.isArray(q?.options) ? q.options : []
          const options = rawOpts.map((opt, oi) => ({
            id: `opt-${oi}`,
            label: String(opt?.label || opt || `选项 ${oi + 1}`),
            description: typeof opt?.description === 'string' ? opt.description : undefined,
            payload: { answer: String(opt?.label || opt || '') }
          }))
          const headerText = String(q?.header || '').trim()
          const questionText = String(q?.question || headerText || 'Codex 需要你的选择').trim()
          const stepTitle = headerText
            ? `${headerText}${questions.length > 1 ? ` (${qIdx + 1}/${questions.length})` : ''}`
            : `需要你的回复${questions.length > 1 ? ` (${qIdx + 1}/${questions.length})` : ''}`
          runInteractionIds.add(interactionId)
          pendingInteractions.set(interactionId, {
            respond(payload) {
              const ans = typeof payload?.answer === 'string' ? payload.answer.trim() : ''
              if (!ans) return false
              pendingInteractions.delete(interactionId)
              runInteractionIds.delete(interactionId)
              collected[qId] = { answers: [ans] }
              emitStep({
                id: stepId,
                kind: 'tool',
                title: stepTitle,
                status: 'done',
                detail: `${questionText}\n\n已回复：${ans}`,
                interaction: null
              })
              if (qIdx + 1 < questions.length) {
                showQuestion(qIdx + 1)
              } else {
                try { send({ id: e.id, result: { answers: collected } }) } catch {}
              }
              return true
            }
          })
          emitStep({
            id: stepId,
            kind: 'tool',
            title: stepTitle,
            status: 'waiting',
            interaction: {
              provider: 'Codex',
              interactionId,
              cascadeId: interactionId,
              stepIndex: qIdx,
              kind: 'question',
              title: questionText,
              allowCustom: true,
              options
            }
          })
        }
        showQuestion(0)
      } else if (e.method==='item/commandExecution/requestApproval' || e.method==='item/fileChange/requestApproval') {
        if (accessMode === 'full') {
          send({ id: e.id, result: { decision: 'accept' } })
          return
        }
        const isCmd = e.method === 'item/commandExecution/requestApproval'
        const stepId = `codex-approval-${e.id}`
        const interactionId = `codex-approval-${randomUUID()}`
        const target = isCmd
          ? String(e.params?.command || e.params?.parsedCmd || '')
          : String(e.params?.grantRoot || e.params?.path || '')
        const reason = String(e.params?.reason || '')
        const title = isCmd ? 'Codex 请求执行命令' : 'Codex 请求修改文件'
        runInteractionIds.add(interactionId)
        pendingInteractions.set(interactionId, {
          respond(payload) {
            const decision = String(payload?.decision || 'decline')
            pendingInteractions.delete(interactionId)
            runInteractionIds.delete(interactionId)
            emitStep({
              id: stepId,
              kind: isCmd ? 'cmd' : 'file',
              title,
              status: decision === 'decline' || decision === 'cancel' ? 'error' : 'done',
              detail: [target, reason, `已选择：${decision}`].filter(Boolean).join('\n'),
              interaction: null
            })
            try { send({ id: e.id, result: { decision } }) } catch {}
            return true
          }
        })
        emitStep({
          id: stepId,
          kind: isCmd ? 'cmd' : 'file',
          title,
          status: 'waiting',
          interaction: {
            provider: 'Codex',
            interactionId,
            cascadeId: interactionId,
            stepIndex: 0,
            kind: 'permission',
            title,
            target: target || undefined,
            reason: reason || undefined,
            options: [
              { id: 'accept', label: '允许本次', payload: { decision: 'accept' } },
              { id: 'accept-session', label: '本会话始终允许', payload: { decision: 'acceptForSession' } },
              { id: 'decline', label: '拒绝', danger: true, payload: { decision: 'decline' } }
            ]
          }
        })
      }
      else send({id:e.id,error:{code:-32601,message:'Client capability unavailable'}})
      return
    }
    if(e.id!=null){
      const waiter=pending.get(e.id);pending.delete(e.id)
      if(e.error)waiter?.reject(Error(e.error.message));else waiter?.resolve(e.result)
      return
    }
    if(!active)return
    if(e.method==='session/update'){
      const u=p.update||{}
      if(u.sessionUpdate==='agent_thought_chunk'){
        thoughtBuf=(thoughtBuf+(u.content?.text||'')).slice(-800)
        const now=Date.now()
        if(now-lastThoughtEmit>450){lastThoughtEmit=now;emitStep({id:'ag-thought',kind:'thought',title:'正在思考',status:'running',detail:thoughtBuf})}
      }
      if(u.sessionUpdate==='agent_message_chunk'){
        if(thoughtBuf){emitStep({id:'ag-thought',kind:'thought',title:'思考过程',status:'done',detail:thoughtBuf});thoughtBuf=''}
        append(u.content?.text)
      }
      if(u.sessionUpdate==='tool_call'||u.sessionUpdate==='tool_call_update'){
        const st=u.status==='completed'?'done':(u.status==='failed'||u.status==='cancelled')?'error':'running'
        const detail=typeof u.rawInput==='string'?u.rawInput:(u.rawInput?JSON.stringify(u.rawInput):(Array.isArray(u.content)?u.content.map(c=>c.content?.text||'').filter(Boolean).join('\n'):''))
        emitStep({id:u.toolCallId||u.title||'ag-tool',kind:'tool',title:u.title||'调用工具',status:st,detail:detail?detail.slice(-600):undefined})
      }
    }
    const evThread=p.threadId||p.thread?.id||''
    const isSubThread=Boolean(codex && codexThreadId && evThread && evThread!==codexThreadId)
    if(e.method==='item/reasoning/summaryTextDelta'||e.method==='item/reasoning/textDelta'){
      if(isSubThread)return
      const rid=p.itemId||'codex-reason'
      const prev=codexReasonBuf.get(rid)||''
      const next=(prev+(p.delta||'')).slice(-2400)
      codexReasonBuf.set(rid,next)
      const now=Date.now()
      if(now-lastThoughtEmit>350){
        lastThoughtEmit=now
        emitStep({id:'reason-'+rid,kind:'thought',title:'思考中',status:'running',detail:next.slice(-1800)})
      }
    }
    if(e.method==='thread/name/updated' && !isSubThread){
      const nextName=String(p?.threadName||'').trim()
      if(nextName)emit('title',nextName)
    }
    if(e.method==='item/agentMessage/delta'){
      if(isSubThread)return
      if(currentItem!==p.itemId){if(output)append('\n\n');currentItem=p.itemId;deltas=''}
      deltas+=p.delta;append(p.delta)
    }
    if(e.method==='item/started'){
      const subPrefix=isSubThread?'[子代理] ':''
      if(p.item?.type==='commandExecution')emitStep({id:p.item.id,kind:'cmd',title:subPrefix+(p.item.command||'执行命令'),status:'running'})
      if(p.item?.type==='mcpToolCall'){
        const title=subPrefix+summarizeToolTitle(p.item.tool||p.item.server||'MCP 工具',p.item.arguments)
        const inStr=formatToolInput(p.item.arguments)
        emitStep({id:p.item.id,kind:'tool',title,status:'running',detail:inStr?`输入：\n${inStr.slice(0,800)}`:undefined})
      }
      if(p.item?.type==='webSearch')emitStep({id:p.item.id,kind:'tool',title:subPrefix+'WebSearch'+(p.item.query?' · '+p.item.query.slice(0,60):''),status:'running'})
      if(p.item?.type==='imageView'){
        const imgPath=String(p.item.path||p.item.imagePath||p.item.filePath||'').trim()
        const name=imgPath?path.basename(imgPath):'图像'
        emitStep({id:p.item.id||('img-'+Date.now()),kind:'file',title:subPrefix+'查看图像 · '+name,status:'running',detail:imgPath||undefined,imagePath:imgPath||undefined})
      }
      if(p.item?.type==='imageGeneration'){
        emitStep({id:p.item.id||('imggen-'+Date.now()),kind:'tool',title:subPrefix+'生成图像',status:'running'})
      }
    }
    if(e.method==='item/completed'){
      const subPrefix=isSubThread?'[子代理] ':''
      if(p.item?.type==='agentMessage'){
        if(isSubThread){
          const txt=String(p.item.text||'').trim()
          if(txt)emitStep({id:'submsg-'+(p.item.id||Date.now()),kind:'info',title:'[子代理] '+txt.replace(/\s+/g,' ').slice(0,64),status:'done',detail:txt.slice(0,2000)})
        }else if(currentItem!==p.item.id || !deltas){
          append((output?'\n\n':'')+p.item.text)
        }
      }
      if(p.item?.type==='reasoning' && !isSubThread){
        const rid=p.item.id||'codex-reason'
        const summary=Array.isArray(p.item.summary)?p.item.summary.join('\n'):(p.item.text||codexReasonBuf.get(rid)||'')
        codexReasonBuf.delete(rid)
        if(summary.trim())emitStep({id:'reason-'+rid,kind:'thought',title:'思考过程',status:'done',detail:summary.trim().slice(-2000)})
      }
      if(p.item?.type==='commandExecution')emitStep({id:p.item.id,kind:'cmd',title:subPrefix+(p.item.command||'执行命令'),status:p.item.exitCode===0?'done':'error',detail:(p.item.aggregatedOutput||('退出码 '+p.item.exitCode)).slice(-1200)})
      if(p.item?.type==='mcpToolCall'){
        const title=subPrefix+summarizeToolTitle(p.item.tool||p.item.server||'MCP 工具',p.item.arguments)
        const inStr=formatToolInput(p.item.arguments)
        const outStr=extractToolResultText(p.item.result?.content??p.item.result??p.item.error).trim()
        const parts=[]
        if(inStr)parts.push('输入：\n'+inStr.slice(0,800))
        if(outStr)parts.push('返回：\n'+outStr.slice(-1200))
        emitStep({id:p.item.id,kind:'tool',title,status:p.item.error?'error':'done',detail:parts.length?parts.join('\n\n'):undefined})
      }
      if(p.item?.type==='webSearch')emitStep({id:p.item.id,kind:'tool',title:subPrefix+'WebSearch'+(p.item.query?' · '+p.item.query.slice(0,60):''),status:'done'})
      if(p.item?.type==='fileChange')emitStep({id:p.item.id,kind:'file',title:subPrefix+'修改文件 · '+(p.item.changes?.length||0)+' 个',status:'done',detail:p.item.changes?.map(c=>c.path).join('\n')})
      if(p.item?.type==='imageView'){
        const imgPath=String(p.item.path||p.item.imagePath||p.item.filePath||'').trim()
        const name=imgPath?path.basename(imgPath):'图像'
        emitStep({id:p.item.id||('img-'+Date.now()),kind:'file',title:subPrefix+'查看图像 · '+name,status:'done',detail:imgPath||undefined,imagePath:imgPath||undefined})
      }
      if(p.item?.type==='imageGeneration'){
        const imgPath=String(p.item.savedPath||p.item.path||p.item.outputPath||p.item.imagePath||'').trim()
        const name=imgPath?path.basename(imgPath):''
        emitStep({id:p.item.id||('imggen-'+Date.now()),kind:'tool',title:subPrefix+'生成图像'+(name?' · '+name:''),status:p.item.status==='failed'?'error':'done',detail:imgPath||undefined,imagePath:imgPath||undefined})
      }
    }
    if(e.method==='turn/completed'){
      if(isSubThread)return
      if(codexTurnId && p.turn?.id && p.turn.id!==codexTurnId)return
      finish(p.turn?.status==='completed'?undefined:Error(p.turn?.error?.message||p.turn?.status||'执行失败'))
    }
  })
  try {
    if(simpleCli){
      const exitPromise=new Promise((resolve,reject)=>{
        child.removeAllListeners('close')
        child.on('close',code=>{
          if(code===0&&!failure)resolve()
          else if(failure)reject(failure)
          else reject(Error('CLI 已退出（'+code+'）'+(stderr?' '+stderr.slice(-400):'')))
        })
      })
      child.stdin.end()
      await exitPromise
      signal.throwIfAborted()
      if(explicitSession)emit('session',explicitSession)
      return
    }
    if(claude || workbuddy){
      if(effort && claude)emit('log','请求思考强度 · '+effort)
      const fullPrompt=images.length?prompt+'\n\n[用户附带了以下文件，请使用 Read 工具查看：\n'+images.map(i=>i.path).join('\n')+'\n]':prompt
      child.stdin.end(fullPrompt);await done
      return
    }
    if(codex){
      await request('initialize',{clientInfo:{name:'ominihive',title:'OminiHive',version:'0.1.0'},capabilities:{experimentalApi:true}})
      send({method:'initialized',params:{}})
      const catalog=await request('model/list',{})
      if(catalogOnly)return catalog.data.map(m=>({id:m.model,label:m.displayName||m.model,isDefault:m.isDefault,defaultEffort:m.defaultReasoningEffort,efforts:m.supportedReasoningEfforts.map(e=>e.reasoningEffort)}))
      if(model&&!catalog.data.some(m=>m.model===model))throw Error('该模型已不在 Codex 列表中')
      const defaultModel=model||catalog.data.find(m=>m.isDefault)?.model
      if(effort&&!catalog.data.find(m=>m.model===defaultModel)?.supportedReasoningEfforts.some(e=>e.reasoningEffort===effort))throw Error('当前模型不支持此强度')
      const turnEffort=effort||catalog.data.find(m=>m.model===defaultModel)?.defaultReasoningEffort
      const codexProject=await ensureCodexProject(request,cwd,projectName).catch(()=>null)
      const codexProjectId=codexProject?.projectId||''
      const codexSandbox=accessMode==='full'?'danger-full-access':(accessMode==='workspace'?'workspace-write':'read-only')
      const opts={cwd,...(defaultModel?{model:defaultModel}:{}),sandbox:codexSandbox,approvalPolicy:'never'}
      const resumeCodex=async params=>{
        for(let attempt=0;;attempt++){
          try{ return await request('thread/resume',params) }
          catch(e){
            if(!/already has an active writer/i.test(e.message))throw e
            if(attempt<1){
              signal.throwIfAborted()
              await new Promise(r=>setTimeout(r,500))
              signal.throwIfAborted()
              continue
            }
            emit('log','原 Codex 会话正被其他客户端占用，已自动分叉保留完整上下文继续。')
            return await request('thread/fork',params)
          }
        }
      }
      let result
      if(session){
        try { result=await resumeCodex({...opts,threadId:session}) }
        catch(e){
          const rollout=/not found|no rollout/i.test(e.message) && legacyCodexRollout(provider,session)
          if(!rollout)throw e
          result=await resumeCodex({...opts,threadId:session,path:rollout})
        }
      }else result=await request('thread/start',{...opts,...(codexProjectId?{projectId:codexProjectId}:{})})
      if(result.model)emit('log','模型 · '+result.model)
      const id=result.thread.id;codexThreadId=id;emit('session',id);active=true
      // Only bind threads that have no project yet, so a thread the user moved in Codex App stays where they put it.
      if(codexProjectId && !result.thread?.projectId){
        await request('thread/metadata/update',{threadId:id,projectId:codexProjectId}).catch(()=>{})
      }
      if(titleLocked && title && result.thread.name !== title) await request('thread/name/set',{threadId:id,name:title}).catch(()=>emit('log','Codex 未能更新会话标题，原生会话已保存。'))
      const sandboxPolicy=accessMode==='full'
        ? {type:'dangerFullAccess'}
        : (accessMode==='workspace'
            ? {type:'workspaceWrite',writableRoots:[cwd],networkAccess:true,excludeTmpdirEnvVar:false,excludeSlashTmp:false}
            : {type:'readOnly',networkAccess:false})
      if(effort)emit('log','请求思考强度 · '+effort)
      const codexImages=images.filter(i=>i.isImage!==false && String(i.mimeType||'').startsWith('image/'))
      const codexFiles=images.filter(i=>!codexImages.includes(i))
      const codexText=codexFiles.length?prompt+'\n\n[用户附带了以下文件，请按需读取：\n'+codexFiles.map(f=>`${f.name}: ${f.path}`).join('\n')+'\n]':prompt
      const codexInput=[{type:'text',text:codexText,text_elements:[]},...codexImages.map(i=>({type:'localImage',path:i.path}))]
      const turnRes=await request('turn/start',{threadId:id,cwd,...(turnEffort?{effort:turnEffort}:{}),...(defaultModel?{model:defaultModel}:{}),approvalPolicy:'never',sandboxPolicy,input:codexInput})
      codexTurnId=turnRes?.turn?.id||turnRes?.turnId||''
      await done
    }else{
      await request('initialize',{protocolVersion:1,clientCapabilities:{},clientInfo:{name:'OminiHive',version:'0.1'}})
      const params={cwd,mcpServers:[]}
      const state=session?await request('session/load',{...params,sessionId:session}):await request('session/new',params)
      const id=session||state.sessionId
      if(model||effort){
        const models=state.models?.availableModels||[]
        const families=gravityModels(models.map(m=>m.modelId+'\t'+m.name).join('\n'))
        const current=state.models?.currentModelId
        const family=families.find(m=>model?m.id===model:(m.native===current||Object.values(m.variants).includes(current)))
        if(!family)throw Error('请重新选择 Antigravity 模型')
        if(effort&&!family.variants[effort])throw Error('当前模型不支持此强度')
        const native=effort?family.variants[effort]:family.native||(Object.values(family.variants).includes(current)?current:family.variants.medium||Object.values(family.variants)[0])
        await request('session/set_model',{sessionId:id,modelId:native})
        emit('log','模型 · '+native)
      }
      await request('session/set_mode',{sessionId:id,modeId:write?'auto':'plan'}).catch(()=>request('session/set_mode',{sessionId:id,modeId:'plan'}).catch(()=>{}))
      if(session)await new Promise(r=>setTimeout(r,150))
      emit('session',id);active=true
      const agImages=images.filter(i=>i.isImage!==false && String(i.mimeType||'').startsWith('image/'))
      const agFiles=images.filter(i=>!agImages.includes(i))
      const agText=agFiles.length?prompt+'\n\n[用户附带了以下文件，请按需读取：\n'+agFiles.map(f=>`${f.name}: ${f.path}`).join('\n')+'\n]':prompt
      const agPrompt=[{type:'text',text:agText},...agImages.map(i=>({type:'image',data:i.base64,mimeType:i.mimeType}))]
      const turn=await request('session/prompt',{sessionId:id,prompt:agPrompt})
      if(turn.stopReason!=='end_turn')throw Error(turn.stopReason||'执行中断')
      if(!output.trim())throw Error('Antigravity 未返回正文（可能因工具权限被规划模式取消）')
    }
  }finally{
    if(deepseekPatchFile){try{unlinkSync(deepseekPatchFile)}catch{}}
    for (const id of runInteractionIds) pendingInteractions.delete(id)
    runInteractionIds.clear()
    stepAdapter?.finalize()
    signal.removeEventListener('abort',aborted)
    if(codex){
      const wait=(p,ms)=>new Promise(resolve=>{
        let settled=false
        const doneWait=()=>{if(!settled){settled=true;clearTimeout(t);resolve()}}
        const t=setTimeout(doneWait,ms)
        t.unref()
        Promise.resolve(p).then(doneWait,doneWait)
      })
      if(!closed && codexThreadId){
        if(!failure)await wait(request('thread/unsubscribe',{threadId:codexThreadId}).catch(()=>{}),800)
        else{ try{send({id:++seq,method:'thread/unsubscribe',params:{threadId:codexThreadId}})}catch{} }
      }
      lines.close()
      if(!closed){
        try{child.stdin.end()}catch{}
        await wait(exited,800)
      }
      if(!closed){
        stop()
        await wait(exited,1200)
      }
      if(!closed){
        try{process.kill(-child.pid,'SIGKILL')}catch{}
        await wait(exited,500)
      }
    }else{
      lines.close();stop()
      const kill=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL')}catch{}},1200)
      kill.unref();child.once('close',()=>clearTimeout(kill))
    }
  }
}

