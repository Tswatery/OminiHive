import {prepareArkCli} from './arkcli.mjs'
import {packager} from '@electron/packager'
import {mkdtempSync,cpSync,rmSync,readFileSync,writeFileSync} from 'node:fs'
import path from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath} from 'node:url'
const root=fileURLToPath(new URL('../',import.meta.url))
const stage=mkdtempSync(path.join(tmpdir(),'omini-package-'))
try{
  for(const name of ['dist','desktop'])cpSync(path.join(root,name),path.join(stage,name),{recursive:true})
  const {name,productName,version,main,type}=JSON.parse(readFileSync(path.join(root,'package.json'),'utf8'))
  writeFileSync(path.join(stage,'package.json'),JSON.stringify({name,productName,version,main,type}))
  const electronVersion=JSON.parse(readFileSync(path.join(root,'node_modules/electron/package.json'),'utf8')).version
  const paths=await packager({dir:stage,name:productName,extraResource:prepareArkCli(),appBundleId:'local.ominihive.desktop',platform:'darwin',arch:process.arch,electronVersion,electronZipDir:process.env.OMINIHIVE_ELECTRON_ZIPS,icon:path.join(root,'assets/OminiHive.icns'),out:path.join(root,'release'),overwrite:true,asar:true,prune:false})
  console.log(paths.join('\n'))
}finally{rmSync(stage,{recursive:true,force:true})}

