import {randomUUID} from 'node:crypto'
import { promisify } from 'node:util'
import { spawn,execFile } from 'node:child_process'
import { existsSync, readFileSync, accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'

import {names,dirs,binary,initClients} from './clients.mjs'
import {desktopApp,runDesktopTurn} from './antigravity-desktop.mjs'
import {antigravityEnv} from './antigravity-env.mjs'
import {resolveProviderConfig,prepareCodexHome,legacyCodexRollout} from './ccswitch.mjs'
export {availability} from './clients.mjs'
const ordered=['minimal','low','medium','high','xhigh','max','ultra']
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
  if(agent==='DeepSeek')return [{id:'',label:'跟随 DeepSeek Harness 默认配置',efforts:[],isDefault:true}]
  if(agent==='OhMyPi')return [{id:'',label:'跟随 Oh My Pi 默认配置',efforts:[],isDefault:true}]
  if(agent==='WorkBuddy'){
    const exe=binary(agent)
    try{
      const isMjs=exe.endsWith('.mjs')
      const {stdout}=await promisify(execFile)(isMjs?process.execPath:exe,isMjs?[exe,'--help']:['--help'],{timeout:5000,env:{...process.env,PATH:dirs.join(':'),...(isMjs?{ELECTRON_RUN_AS_NODE:'1'}:{})}})
      const raw=stdout.match(/Currently supported:\s*\(([^)]+)\)/i)?.[1]
      if(raw){
        const ids=raw.split(',').map(s=>s.trim()).filter(Boolean)
        if(ids.length)return ids.map((id,i)=>({id:id==='auto'?'':id,label:id==='auto'?'Auto (WorkBuddy 默认)':id,efforts:[],isDefault:i===0}))
      }
    }catch{}
    return [
      {id:'',label:'Auto (WorkBuddy 默认)',efforts:[],isDefault:true},
      {id:'glm-5.1',label:'glm-5.1',efforts:[]},
      {id:'kimi-k2.5',label:'kimi-k2.5',efforts:[]},
      {id:'minimax-m2.7',label:'minimax-m2.7',efforts:[]},
      {id:'deepseek-v3-2-volc',label:'deepseek-v3-2-volc',efforts:[]}
    ]
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

export async function execute({agent,cwd,prompt,historyPrompt,title,images=[],session,write=false,signal,emit,model='',effort='',providerId='',catalogOnly=false}) {
  await initClients()
  if(effort&&!ordered.includes(effort))throw Error('未知的思考强度')
  const exe=binary(agent)
  if (!exe) throw Error('未找到 '+names[agent])
  signal.throwIfAborted()
  const provider=providerId?resolveProviderConfig(agent,providerId):null
  if (providerId && !provider) throw Error('渠道配置已变化，请重新选择。')
  const gravityApp = agent === 'Antigravity' && !provider && desktopApp()
  if (gravityApp) {
    return runDesktopTurn({app:gravityApp,cwd,prompt,historyPrompt,title,session,images,write,model,effort,signal,emit})
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
  const imgPrompt=images.length?prompt+'\n\n[附带图片路径：\n'+images.map(i=>i.path).join('\n')+'\n]':prompt
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
    args=['-p',imgPrompt]
    if(model)args.push('--model',model)
  }
  if(minimax){
    args=['-p',imgPrompt]
    if(model)args.push('--model',model)
  }
  if(deepseek){
    args=['run',imgPrompt]
    if(model)args.push('--model',model)
  }
  if(claude) {
    args=['-p','--verbose','--output-format','stream-json','--include-partial-messages','--restricted','--strict-mcp-config','--permission-mode',write?'acceptEdits':'dontAsk','--tools',write?'Read,Glob,Grep,Edit,Write':'Read,Glob,Grep']
    if(images.length){
      const dirsSet=new Set(images.map(i=>path.dirname(i.path)))
      for(const d of dirsSet)args.push('--add-dir',d)
    }
    claudeConfig(env,args,model,provider)
    if(effort)args.push('--effort',effort)
    if(session) args.push('--resume',session)
  }
  if(workbuddy) {
    args=['-p','--verbose','--output-format','stream-json','--include-partial-messages','--permission-mode',write?'acceptEdits':'dontAsk','--tools',write?'Read,Glob,Grep,Edit,Write':'Read,Glob,Grep']
    if(images.length){
      const dirsSet=new Set(images.map(i=>path.dirname(i.path)))
      for(const d of dirsSet)args.push('--add-dir',d)
    }
    if(model)args.push('--model',model)
    if(session)args.push('--resume',session)
  }
  const isMjsExe = exe.endsWith('.mjs')
  const spawnCmd = isMjsExe ? process.execPath : exe
  const spawnArgs = isMjsExe ? [exe, ...args] : args
  if (isMjsExe) env.ELECTRON_RUN_AS_NODE = '1'
  const child=spawn(spawnCmd,spawnArgs,{cwd,env:agent==='Antigravity'?await antigravityEnv(env):env,stdio:'pipe',detached:true})
  const lines=createInterface({input:child.stdout})
  const pending=new Map()
  let seq=0, failure, stderr='', finish, output='', currentItem='', deltas='', active=false, thoughtBuf='', lastThoughtEmit=0, closed=false, codexThreadId=''
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
  if(provider)emitStep({id:'meta-provider',kind:'info',title:'渠道 · '+provider.name,status:'done'})
  function append(s){if(s){output+=s;emit('text',s)}}
  lines.on('line',line=>{
    if(gemini || kimi){
      let e; try{e=JSON.parse(line)}catch{if(line.trim())append(line+'\n');return}
      if(e.session_id)emit('session',e.session_id)
      if(e.type==='message'&&e.role==='assistant'&&e.content)append(e.content)
      else if(e.content&&typeof e.content==='string'&&e.role==='assistant')append(e.content)
      if(e.delta?.text)append(e.delta.text)
      if(e.type==='tool_use')emitStep({id:e.tool_id||e.tool_name||'tool',kind:'tool',title:e.tool_name||'调用工具',status:'running'})
      if(e.type==='tool_result')emitStep({id:e.tool_id||'tool',kind:'tool',title:e.tool_name||'工具完成',status:e.status==='error'?'error':'done'})
      if(e.type==='result'&&e.response&&!output)append(e.response)
      return
    }
    if(opencode){
      let e;try{e=JSON.parse(line)}catch{return}
      if(e.sessionID)emit('session',e.sessionID)
      if(e.type==='text' && typeof e.part?.text==='string')append(e.part.text)
      if(e.type==='error')fail(Error(e.error?.data?.message||'OpenCode 执行失败'))
      return
    }
    if(qwen){
      let e;try{e=JSON.parse(line)}catch{return}
      if(e.session_id)emit('session',e.session_id)
      if(e.type==='assistant')for(const block of e.message?.content||[])if(block.type==='text')append(block.text)
      if(e.type==='result'&&!output&&typeof e.result==='string')append(e.result)
      return
    }
    if(openclaw || grok || extraSimpleCli){
      append(line+'\n')
      return
    }
    let e; try{e=JSON.parse(line)}catch{return}
    const p=e.params??{}
    if(claude || workbuddy){
      if(e.type==='system'&&e.subtype==='init'){emit('session',e.session_id);if(e.model)emitStep({id:'meta-model',kind:'info',title:'模型 · '+e.model,status:'done'})}
      const block=e.event
      if(block?.type==='content_block_start'&&block.content_block?.type==='thinking'){emitStep({id:'claude-think',kind:'thought',title:'思考中',status:'running'})}
      if(block?.type==='content_block_delta'){
        if(block.delta?.text){
          if(!output)emitStep({id:'claude-think',kind:'thought',title:'思考完成',status:'done'})
          append(block.delta.text)
        }
      }
      if(block?.content_block?.type==='tool_use')emitStep({id:block.content_block.id||('tool-'+block.index),kind:'tool',title:block.content_block.name,status:'running'})
      if(e.type==='user'&&Array.isArray(e.message?.content)){
        for(const c of e.message.content){
          if(c.type==='tool_result')emitStep({id:c.tool_use_id,kind:'tool',title:'工具返回',status:c.is_error?'error':'done',detail:typeof c.content==='string'?c.content.slice(-600):''})
        }
      }
      if(e.type==='result'){
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
    if(e.method==='item/agentMessage/delta'){
      if(currentItem!==p.itemId){if(output)append('\n\n');currentItem=p.itemId;deltas=''}
      deltas+=p.delta;append(p.delta)
    }
    if(e.method==='item/started' && p.item?.type==='commandExecution')emitStep({id:p.item.id,kind:'cmd',title:p.item.command||'执行命令',status:'running'})
    if(e.method==='item/completed'){
      if(p.item?.type==='agentMessage' && (currentItem!==p.item.id || !deltas))append((output?'\n\n':'')+p.item.text)
      if(p.item?.type==='commandExecution')emitStep({id:p.item.id,kind:'cmd',title:p.item.command||'执行命令',status:p.item.exitCode===0?'done':'error',detail:(p.item.aggregatedOutput||('退出码 '+p.item.exitCode)).slice(-800)})
      if(p.item?.type==='fileChange')emitStep({id:p.item.id,kind:'file',title:'修改文件 · '+(p.item.changes?.length||0)+' 个',status:'done',detail:p.item.changes?.map(c=>c.path).join('\n')})
    }
    if(e.method==='turn/completed')finish(p.turn?.status==='completed'?undefined:Error(p.turn?.error?.message||p.turn?.status||'执行失败'))
  })
  try {
    if(simpleCli){
      const exitPromise=new Promise((resolve,reject)=>{
        child.removeAllListeners('close')
        child.on('close',code=>code===0&&!failure?resolve():reject(Error('CLI 已退出（'+code+'）'+(stderr?' '+stderr.slice(-400):''))))
      })
      child.stdin.end()
      await exitPromise
      signal.throwIfAborted()
      if(explicitSession)emit('session',explicitSession)
      return
    }
    if(claude || workbuddy){
      if(effort && claude)emit('log','请求思考强度 · '+effort)
      const fullPrompt=images.length?prompt+'\n\n[用户附带了以下图片文件，请使用 Read 工具查看：\n'+images.map(i=>i.path).join('\n')+'\n]':prompt
      child.stdin.end(fullPrompt);await done
      return
    }
    if(codex){
      await request('initialize',{clientInfo:{name:'ominihive',title:'OminiHive',version:'0.1.0'},capabilities:{experimentalApi:false}})
      send({method:'initialized',params:{}})
      const catalog=await request('model/list',{})
      if(catalogOnly)return catalog.data.map(m=>({id:m.model,label:m.displayName||m.model,isDefault:m.isDefault,defaultEffort:m.defaultReasoningEffort,efforts:m.supportedReasoningEfforts.map(e=>e.reasoningEffort)}))
      if(model&&!catalog.data.some(m=>m.model===model))throw Error('该模型已不在 Codex 列表中')
      const defaultModel=model||catalog.data.find(m=>m.isDefault)?.model
      if(effort&&!catalog.data.find(m=>m.model===defaultModel)?.supportedReasoningEfforts.some(e=>e.reasoningEffort===effort))throw Error('当前模型不支持此强度')
      const turnEffort=effort||catalog.data.find(m=>m.model===defaultModel)?.defaultReasoningEffort
      const opts={cwd,...(defaultModel?{model:defaultModel}:{}),sandbox:write?'workspace-write':'read-only',approvalPolicy:'never'}
      const resumeCodex=async params=>{
        for(let attempt=0;;attempt++){
          try{ return await request('thread/resume',params) }
          catch(e){
            if(!/already has an active writer/i.test(e.message))throw e
            if(attempt>=2)throw Error('该 Codex 会话正被其他 Codex 客户端或进程占用，请在 Codex 客户端切走该对话（等待约 1 分钟）或退出客户端后重试')
            signal.throwIfAborted()
            await new Promise(r=>setTimeout(r,attempt===0?500:1000))
            signal.throwIfAborted()
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
      }else result=await request('thread/start',opts)
      if(result.model)emit('log','模型 · '+result.model)
      const id=result.thread.id;codexThreadId=id;emit('session',id);active=true
      if(title && result.thread.name !== title) await request('thread/name/set',{threadId:id,name:title}).catch(()=>emit('log','Codex 未能更新会话标题，原生会话已保存。'))
      const sandboxPolicy=write?{type:'workspaceWrite',writableRoots:[cwd],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true}:{type:'readOnly',networkAccess:false}
      if(effort)emit('log','请求思考强度 · '+effort)
      const codexInput=[{type:'text',text:prompt,text_elements:[]},...images.map(i=>({type:'localImage',path:i.path}))]
      await request('turn/start',{threadId:id,cwd,...(turnEffort?{effort:turnEffort}:{}),...(defaultModel?{model:defaultModel}:{}),approvalPolicy:'never',sandboxPolicy,input:codexInput})
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
      const agPrompt=[{type:'text',text:prompt},...images.map(i=>({type:'image',data:i.base64,mimeType:i.mimeType}))]
      const turn=await request('session/prompt',{sessionId:id,prompt:agPrompt})
      if(turn.stopReason!=='end_turn')throw Error(turn.stopReason||'执行中断')
      if(!output.trim())throw Error('Antigravity 未返回正文（可能因工具权限被规划模式取消）')
    }
  }finally{
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

