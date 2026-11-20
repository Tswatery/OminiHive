import { _electron as electron } from 'playwright-core'
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
const base=mkdtempSync(path.join(tmpdir(),'omini-ui-'))
const folder=path.join(base,'HelloHive')
mkdirSync(folder)
const token='HIVE-'+Math.random().toString(36).slice(2,9)
writeFileSync(path.join(folder,'marker.txt'),token)
const exe=process.env.OMINIHIVE_APP_BINARY
const launch=()=>electron.launch({executablePath:exe,args:[...(exe?[]:['.']),'--user-data-dir='+path.join(base,'profile')]})
let app=await launch()
try{
  let page=await app.firstWindow()
  page.on('pageerror',e=>console.log('页面错误',e.message))
  // fresh profile → no project yet, the welcome screen offers the folder picker
  await page.getByRole('button',{name:'选择文件夹'}).waitFor()
  await app.evaluate(({dialog},folder)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]})},folder)
  await page.getByRole('button',{name:'选择文件夹'}).click()
  async function send(text,expected){
    const before=await page.locator('article').count()
    await page.getByRole('textbox',{name:'任务'}).fill(text)
    await page.getByRole('button',{name:'发送',exact:true}).click()
    await page.waitForFunction(n=>document.querySelectorAll('article').length>n,before,{timeout:30000})
    await page.waitForFunction(()=>{const last=[...document.querySelectorAll('article')].pop();return last&&!last.querySelector('.status-pill.running,.status-pill.waiting')&&!document.querySelector('.send[aria-label="停止"]')},{},{timeout:180000})
    const msg=page.locator('article').last()
    const body=await msg.innerText()
    assert.ok(!body.includes('失败') && body.includes(expected),body.slice(-1000))
    console.log(text.slice(0,20),'通过')
  }
  await send('@Codex 读取当前目录的 marker.txt，只回复文件中的标识。',token)
  await send('@Claude 根据上一个 Agent 的回复，只重复标识，不读取文件。',token)
  await send('@Antigravity 根据本讨论只重复该标识。',token)
  await send('@Antigravity 再次只重复标识。',token)
  await send('@Claude 再次只重复标识。',token)
  await send('@Codex 再次只重复标识。',token)
  await page.screenshot({path:path.join(base,'chat.png')})
  await app.close();app=await launch();page=await app.firstWindow()
  await page.locator('article').last().waitFor();assert.equal(await page.locator('article').count(),6)
  await page.getByRole('button',{name:'新建讨论',exact:true}).last().click()
  await page.getByText('多 Agent 协作工作区').waitFor()
  assert.equal(await page.locator('article').count(),0)
  console.log('重启恢复与独立讨论通过。截图',base)
}finally{await app.close()}

