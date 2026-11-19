import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {Store,route,routeTargets} from '../desktop/store.mjs'
test('提及路由拒绝空任务和未知客户端',()=>{
  assert.equal(route('@aNtIgRaViTy 检查').agent,'Antigravity')
  for(const t of ['@Claude ','@Other 你好','无前缀'])assert.throws(()=>route(t))
})
test('无前缀路由、群发与讨论管理',()=>{
  assert.deepEqual(routeTargets('帮我看下架构','Claude'),{agents:['Claude'],task:'帮我看下架构',isAll:false})
  assert.deepEqual(routeTargets('@codex @claude @Codex 联合评审','Antigravity'),{agents:['Codex','Claude'],task:'联合评审',isAll:false})
  assert.deepEqual(routeTargets('@all 你怎么看','Codex'),{agents:['Codex','Claude','Antigravity','Gemini','OpenCode','Kimi','Qwen','OpenClaw','Grok'],task:'你怎么看',isAll:true})
  assert.deepEqual(routeTargets('你怎么看 @Antigravity @codex','Claude'),{agents:['Antigravity','Codex'],task:'你怎么看 @Antigravity @codex',isAll:false})
  assert.throws(()=>routeTargets('@Codex   ','Codex'))
  const base=mkdtempSync(path.join(tmpdir(),'hive-batch-'))
  try{
    const folder=path.join(base,'project');mkdirSync(folder)
    const store=new Store(path.join(base,'hive.sqlite'))
    const p=store.project(folder),r1=store.tree().rooms[0].id
    assert.equal(store.room(p),r1)
    const runs=store.startBatch(r1,'@Codex @Claude 对比方案','Codex')
    assert.equal(runs.length,2)
    assert.deepEqual(runs.map(x=>x.agent),['Codex','Claude'])
    const msgs=store.messages(r1)
    assert.equal(msgs.length,3)
    assert.equal(msgs[0].author,'我')
    store.renameRoom(r1,'架构评审')
    assert.equal(store.tree().rooms[0].title,'架构评审')
    const r2=store.room(p)
    assert.notEqual(r2,r1)
    store.db.close()
  }finally{rmSync(base,{recursive:true,force:true})}
})
test('同一讨论交接、独立原生会话和崩溃恢复',()=>{
  const base=mkdtempSync(path.join(tmpdir(),'hive-unit-'))
  try{
    const folder=path.join(base,'project');mkdirSync(folder)
    const db=path.join(base,'hive.sqlite')
    let store=new Store(db)
    const project=store.project(folder),room=store.tree().rooms[0].id
    assert.equal(store.project(folder),project)
    const first=store.start(room,'@Codex 修复按钮')
    store.record(first.id,room,'Codex','text','已修改 App.tsx')
    store.record(first.id,room,'Codex','session','native-a')
    store.finish(first.id,'完成')
    const review=store.start(room,'@Claude 请审查')
    assert.match(review.prompt,/已修改 App.tsx/);assert.equal(review.session,undefined)
    const isolated=store.start(store.room(project),'@Codex 新话题')
    assert.doesNotMatch(isolated.prompt,/App.tsx/);assert.equal(isolated.session,undefined)
    store.db.close();store=new Store(db)
    assert.equal(store.messages(room).at(-1).status,'中断')
    const resumed=store.start(room,'@Codex 继续')
    assert.equal(resumed.session,'native-a')
    assert.doesNotMatch(resumed.prompt,/已修改 App\.tsx/)
    store.db.close()
  }finally{rmSync(base,{recursive:true,force:true})}
})
test('长上下文完整保留与超限头尾裁剪',()=>{
  const base=mkdtempSync(path.join(tmpdir(),'hive-ctx-'))
  try{
    const folder=path.join(base,'project');mkdirSync(folder)
    const store=new Store(path.join(base,'hive.sqlite'))
    const p=store.project(folder),r=store.tree().rooms[0].id
    const longBody='【开头总纲】' + 'A'.repeat(4000) + '【末尾细节】'
    const c1=store.start(r,'@Codex 分析')
    store.record(c1.id,r,'Codex','text',longBody)
    store.finish(c1.id,'完成')
    const cl=store.start(r,'@Claude 评审')
    assert.match(cl.prompt,/【开头总纲】/)
    assert.match(cl.prompt,/【末尾细节】/)
    assert.doesNotMatch(cl.prompt,/已省略/)
    const huge='【头部】'+'B'.repeat(28000)+'【尾部】'
    store.record(cl.id,r,'Claude','text',huge)
    store.finish(cl.id,'完成')
    const ag=store.start(r,'@Antigravity 总结')
    assert.match(ag.prompt,/【头部】/)
    assert.match(ag.prompt,/【尾部】/)
    assert.match(ag.prompt,/已省略/)
    store.db.close()
  }finally{rmSync(base,{recursive:true,force:true})}
})

