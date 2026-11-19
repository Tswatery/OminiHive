import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
const run=promisify(execFile)

// Finder-launched apps usually lack the proxy variables inherited by Terminal.
// Only the child process gets these settings; explicit environment settings win.
export async function antigravityEnv(base){
  if(process.platform!=='darwin'||base.HTTPS_PROXY||base.https_proxy||base.ALL_PROXY||base.all_proxy)return base
  let text
  try{text=(await run('/usr/sbin/scutil',['--proxy'],{timeout:1200})).stdout}catch{return base}
  const field=k=>text.match(new RegExp('^\\s*'+k+'\\s*:\\s*(\\S+)','m'))?.[1]
  if(field('ProxyAutoConfigEnable')==='1'||field('ProxyAutoDiscoveryEnable')==='1')return base
  const env={...base}
  for(const scheme of ['HTTP','HTTPS']){
    const key=scheme+'_PROXY'
    if(env[key]||env[key.toLowerCase()]||field(scheme+'Enable')!=='1')continue
    const host=field(scheme+'Proxy'),port=Number(field(scheme+'Port'))
    if(!host||!/^[-\w.:[\]]+$/.test(host)||!Number.isInteger(port)||port<1||port>65535)continue
    const address=host.includes(':')&&!host.startsWith('[')?'['+host+']':host
    env[key]=env[key.toLowerCase()]='http://'+address+':'+port
  }
  if(env.HTTPS_PROXY||env.HTTP_PROXY){
    const exceptions=text.match(/ExceptionsList\s*:\s*<array>\s*\{([^}]*)\}/)?.[1]||''
    const hosts=[...exceptions.matchAll(/\d+\s*:\s*(\S+)/g)].map(m=>m[1])
    env.NO_PROXY=env.no_proxy=[env.NO_PROXY||env.no_proxy,'localhost','127.0.0.1','::1',...hosts].filter(Boolean).join(',')
  }
  return env
}
