import {readFileSync,writeFileSync,renameSync,statSync,realpathSync} from 'node:fs'
import {homedir} from 'node:os'
import path from 'node:path'
import {binary,names} from './clients.mjs'
import {modelList} from './agents.mjs'

const reference=JSON.parse(readFileSync(new URL('./antigravity-catalog.json',import.meta.url),'utf8')).models

const ttl=10*60*1000
function stamp(file){
  try{const st=statSync(file);return [realpathSync(file),st.ino,st.size,st.mtimeMs]}catch{return null}
}
function fingerprint(agent){
  const exe=binary(agent)
  if(!Object.hasOwn(names,agent)||!exe)throw Error('未找到本机客户端')
  const config=agent==='Claude'?path.join(homedir(),'.claude/settings.json'):
    agent==='Codex'?path.join(process.env.CODEX_HOME||path.join(homedir(),'.codex'),'config.toml'):null
  return JSON.stringify([stamp(exe),config&&stamp(config)])
}

export function createCatalog(dir,load=modelList){
  const entries=new Map(),pending=new Map()
  const file=path.join(dir,'model-lists-v1.json')
  try{
    for(const [agent,e] of Object.entries(JSON.parse(readFileSync(file,'utf8')))){
      if(Object.hasOwn(names,agent)&&e?.list?.length&&Array.isArray(e.list)&&e.list.every(m=>typeof m?.id==='string'&&Array.isArray(m.efforts)))entries.set(agent,e)
    }
  }catch{}
  function peek(agent){
    const entry=entries.get(agent)
    if(entry?.key===fingerprint(agent))return {list:entry.list,reference:false}
    return agent==='Antigravity'?{list:reference,reference:true}:{list:[],reference:false}
  }
  function get(agent){
    const key=fingerprint(agent),entry=entries.get(agent)
    if(entry?.key===key&&Date.now()-entry.time<ttl)return Promise.resolve(entry.list)
    const running=pending.get(agent)
    if(running?.key===key)return running.promise
    const promise=Promise.resolve().then(()=>load(agent,dir)).then(list=>{
      if(!list.length)throw Error('客户端未返回可用模型')
      if(fingerprint(agent)!==key)throw Error('CLI 配置已变化，请重试')
      entries.set(agent,{key,list,time:Date.now()})
      try{
        writeFileSync(file+'.tmp',JSON.stringify(Object.fromEntries(entries)),{mode:0o600})
        renameSync(file+'.tmp',file)
      }catch{} // In-memory reuse still works if the profile cannot be written.
      return list
    }).finally(()=>{if(pending.get(agent)?.promise===promise)pending.delete(agent)})
    pending.set(agent,{key,promise})
    return promise
  }
  return {peek,get}
}
