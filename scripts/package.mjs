import {prepareArkCli} from './arkcli.mjs'
import {packager} from '@electron/packager'
import {mkdtempSync,cpSync,rmSync,readFileSync,writeFileSync,existsSync,readdirSync} from 'node:fs'
import path from 'node:path'
import {tmpdir,homedir,release} from 'node:os'
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
const root=fileURLToPath(new URL('../',import.meta.url))

// @electron/get keys its cache by download URL, so a zip fetched through a mirror at
// `npm install` time is invisible to packager's default GitHub URL and gets re-downloaded
// (very slow here). Reuse any cached zip of the exact version/arch unless overridden.
function cachedElectronZipDir(electronVersion){
  if(process.env.OMINIHIVE_ELECTRON_ZIPS)return process.env.OMINIHIVE_ELECTRON_ZIPS
  const file=`electron-v${electronVersion}-darwin-${process.arch}.zip`
  const cacheRoot=process.env.electron_config_cache||path.join(homedir(),'Library/Caches/electron')
  const dirs=[cacheRoot]
  try{for(const d of readdirSync(cacheRoot,{withFileTypes:true}))if(d.isDirectory())dirs.push(path.join(cacheRoot,d.name))}catch{}
  const hit=dirs.find(dir=>existsSync(path.join(dir,file)))
  if(hit)console.log('Using cached Electron zip:',path.join(hit,file))
  return hit
}

// macOS 26 "Icon Composer" (.icon, Liquid Glass) needs macOS 26 + Xcode 26 actool to compile.
// packager auto-probes <icon>.icon next to the .icns and *throws* if it can't compile it, so the
// bundle lives in its own folder and is only handed over when the toolchain supports it.
const icns=path.join(root,'assets/OminiHive.icns')
const iconComposer=path.join(root,'assets/icon-composer/OminiHive.icon')
function iconComposerUnsupportedReason(){
  if(!existsSync(iconComposer))return 'no .icon bundle'
  if(Number(release().split('.')[0])<25)return 'needs macOS 26'
  try{
    const out=execFileSync('xcrun',['actool','--version'],{encoding:'utf8',stdio:['ignore','pipe','ignore']})
    const v=Number((out.match(/<key>short-bundle-version<\/key>\s*<string>(\d+)/)||[])[1]||0)
    return v>=26?'':'needs Xcode 26 actool (found '+(v||'unknown')+')'
  }catch{return 'needs Xcode 26 (actool not available)'}
}

// packager always looks for "<icon>.icon" and warns when it is absent; when we deliberately skip
// Icon Composer, replace that cryptic line with one explaining why (other warnings pass through).
async function withIconComposerNote(reason,fn){
  const warn=console.warn
  console.warn=(...a)=>{
    if(typeof a[0]==='string'&&a[0].includes('with extension ".icon"'))return warn(`Icon Composer (.icon) skipped: ${reason}; using .icns only.`)
    warn(...a)
  }
  try{return await fn()}finally{console.warn=warn}
}
const stage=mkdtempSync(path.join(tmpdir(),'omini-package-'))
try{
  for(const name of ['dist','desktop'])cpSync(path.join(root,name),path.join(stage,name),{recursive:true})
  const {name,productName,version,main,type}=JSON.parse(readFileSync(path.join(root,'package.json'),'utf8'))
  writeFileSync(path.join(stage,'package.json'),JSON.stringify({name,productName,version,main,type}))
  const electronVersion=JSON.parse(readFileSync(path.join(root,'node_modules/electron/package.json'),'utf8')).version
  const base={dir:stage,name:productName,extraResource:prepareArkCli(),appBundleId:'local.ominihive.desktop',platform:'darwin',arch:process.arch,electronVersion,electronZipDir:cachedElectronZipDir(electronVersion),out:path.join(root,'release'),overwrite:true,asar:true,prune:false}
  const skip=iconComposerUnsupportedReason()
  let paths
  if(skip){
    paths=await withIconComposerNote(skip,()=>packager({...base,icon:icns}))
  }else{
    try{paths=await packager({...base,icon:[icns,iconComposer]})}
    catch(e){
      // never let the optional glass icon block a release; the .icns still covers every macOS
      console.warn('Icon Composer (.icon) compile failed, retrying with .icns only:',e.message)
      paths=await withIconComposerNote('compile failed',()=>packager({...base,icon:icns}))
    }
  }
  console.log(paths.join('\n'))
}finally{rmSync(stage,{recursive:true,force:true})}

