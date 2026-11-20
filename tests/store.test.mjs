import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,rmSync,existsSync,readFileSync,statSync,writeFileSync,chmodSync,readdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {Store,route,routeTargets} from '../desktop/store.mjs'
import {roomArchiveDir,roomArchiveRelDir,removeRoomArchive} from '../desktop/context-archive.mjs'
test('提及路由拒绝空任务和未知客户端',()=>{
  assert.equal(route('@aNtIgRaViTy 检查').agent,'Antigravity')
  for(const t of ['@Claude ','@Other 你好','无前缀'])assert.throws(()=>route(t))
})
test('无前缀路由、群发与讨论管理',()=>{
  assert.deepEqual(routeTargets('帮我看下架构','Claude'),{agents:['Claude'],task:'帮我看下架构',isAll:false})
  assert.deepEqual(routeTargets('@codex @claude @Codex 联合评审','Antigravity'),{agents:['Codex','Claude'],task:'联合评审',isAll:false})
  assert.deepEqual(routeTargets('@all 你怎么看','Codex'),{agents:['Codex','Claude','Antigravity','Gemini','OpenCode','Kimi','Qwen','OpenClaw','Grok','Hermes','Pi','MiniMax','DeepSeek','OhMyPi','WorkBuddy'],task:'你怎么看',isAll:true})
  assert.deepEqual(routeTargets('@DeepSeek @Hermes @OhMyPi @WorkBuddy 一起看下','Codex'),{agents:['DeepSeek','Hermes','OhMyPi','WorkBuddy'],task:'一起看下',isAll:false})
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
    store.finish(resumed.id,'完成')
    store.remove('project',project)
    store.db.close()
  }finally{rmSync(base,{recursive:true,force:true})}
})
test('最后一条完整无截断内联、只读归档、轨迹脱敏与 git exclude',()=>{
  const base=mkdtempSync(path.join(tmpdir(),'hive-ctx-'))
  try{
    const folder=path.join(base,'project')
    mkdirSync(path.join(folder,'.git','info'),{recursive:true})
    const store=new Store(path.join(base,'hive.sqlite'))
    const p=store.project(folder),r=store.tree().rooms[0].id
    const huge='【头部】'+'B'.repeat(28000)+'【尾部】'
    const c1=store.start(r,'@Codex 分析')
    store.record(c1.id,r,'Codex','log','::step::'+JSON.stringify({id:'t1',kind:'tool',title:'Bash · npm test',status:'done',detail:'api_key=sk-secret12345678901234567890\nPASS all tests'}))
    store.record(c1.id,r,'Codex','text',huge)
    store.finish(c1.id,'完成')

    // 验证 .git/info/exclude 自动写入 .ominihive/
    const exclude=readFileSync(path.join(folder,'.git','info','exclude'),'utf8')
    assert.match(exclude,/\.ominihive\//)

    // 验证目录与文件只读权限
    const archDir=roomArchiveDir(folder,r)
    assert.equal(existsSync(path.join(archDir,'index.md')),true)
    assert.equal(statSync(archDir).mode & 0o777,0o555)
    assert.equal(statSync(path.join(archDir,'index.md')).mode & 0o777,0o444)
    assert.throws(()=>writeFileSync(path.join(archDir,'index.md'),'tamper'))

    // 验证轨迹脱敏
    const traceFile=path.join(archDir,'002-Codex.trace.md')
    assert.equal(existsSync(traceFile),true)
    const traceContent=readFileSync(traceFile,'utf8')
    assert.match(traceContent,/\[REDACTED\]/)
    assert.doesNotMatch(traceContent,/sk-secret1234567890/)

    // 验证最新一条超长消息完整内联，不做硬截断，且给出只读索引与轨迹路径
    const cl=store.start(r,'@Claude 评审')
    assert.match(cl.prompt,/【头部】/)
    assert.match(cl.prompt,/【尾部】/)
    assert.doesNotMatch(cl.prompt,/已省略/)
    assert.match(cl.prompt,new RegExp(roomArchiveRelDir(r).replace(/\//g,'\\/')+'/index\\.md'))
    assert.match(cl.prompt,/002-Codex\.trace\.md/)

    // 删除项目时自动解锁并清理归档目录
    store.finish(cl.id,'完成')
    store.remove('project',p)
    assert.equal(existsSync(archDir),false)
    store.db.close()
  }finally{
    try{chmodSync(path.join(base,'project','.ominihive'),0o755)}catch{}
    rmSync(base,{recursive:true,force:true})
  }
})
test('内联每个有未读回复的 Agent 最后一条，其余更早未读提供只读文件路径索引且不重复发送',()=>{
  const base=mkdtempSync(path.join(tmpdir(),'hive-inc-'))
  try{
    const folder=path.join(base,'project');mkdirSync(folder)
    const store=new Store(path.join(base,'hive.sqlite'))
    const p=store.project(folder),r=store.tree().rooms[0].id
    const wb0=store.startBatch(r,'@WorkBuddy 第一轮意见','WorkBuddy')[0]
    store.record(wb0.id,r,'WorkBuddy','text','WorkBuddy 的旧评审意见')
    store.finish(wb0.id,'完成')
    const wb=store.startBatch(r,'@WorkBuddy 看一下你的意见','WorkBuddy')[0]
    store.record(wb.id,r,'WorkBuddy','text','WorkBuddy 的核心评审意见')
    store.finish(wb.id,'完成')
    for(let i=0;i<4;i++){
      const c=store.start(r,`@Codex 第${i}轮`)
      store.record(c.id,r,'Codex','text',`Codex 第${i}轮回复`)
      store.finish(c.id,'完成')
    }
    const ag1=store.startBatch(r,'@Antigravity 汇总一下','Antigravity')[0]
    store.record(ag1.id,r,'Antigravity','session','ag-sess-1')
    store.finish(ag1.id,'完成')
    store.markDelivered(r,'Antigravity',ag1.deliveredIds)
    // 每个有未读新回复的 Agent 都内联其最后一条（WorkBuddy 最新 + Codex 第3轮），更早的未读不内联正文，改为路径索引
    assert.match(ag1.prompt,/WorkBuddy 的核心评审意见/)
    assert.match(ag1.prompt,/Codex 第3轮回复/)
    assert.doesNotMatch(ag1.prompt,/WorkBuddy 的旧评审意见/)
    assert.doesNotMatch(ag1.prompt,/Codex 第0轮回复/)
    assert.match(ag1.prompt,/\[未读\] Codex/)
    assert.match(ag1.prompt,/index\.md/)
    assert.match(ag1.prompt,/<group_context>/)
    assert.match(ag1.prompt,/<user_task>/)
    const ag1Msg=store.messages(r).find(m=>m.id===ag1.id)
    assert.match(ag1Msg.log,/上下文 · 带入最新 2 条（WorkBuddy、Codex）/)
    // 下一轮没有新消息时，智能感知不重复发送上下文
    const ag2=store.startBatch(r,'@Antigravity 继续','Antigravity')[0]
    assert.doesNotMatch(ag2.prompt,/<group_context>/)
    assert.doesNotMatch(ag2.prompt,/Codex 第3轮回复/)
    store.finish(ag2.id,'完成')
    store.remove('project',p)
    store.db.close()
  }finally{rmSync(base,{recursive:true,force:true})}
})
test('并行群发后智能送达记录不会互相漏看且不重复发',()=>{
  const base=mkdtempSync(path.join(tmpdir(),'hive-cursor-'))
  try{
    const folder=path.join(base,'project');mkdirSync(folder)
    const store=new Store(path.join(base,'hive.sqlite'))
    const p=store.project(folder),r=store.tree().rooms[0].id
    const runs=store.startBatch(r,'@Codex @WorkBuddy 一起评审','Codex')
    const [rCodex,rWb]=runs
    store.record(rCodex.id,r,'Codex','session','c-1')
    store.record(rCodex.id,r,'Codex','text','Codex 观点 A')
    store.finish(rCodex.id,'完成')
    store.markDelivered(r,'Codex',rCodex.deliveredIds)
    store.record(rWb.id,r,'WorkBuddy','session','w-1')
    store.record(rWb.id,r,'WorkBuddy','text','WorkBuddy 观点 B')
    store.finish(rWb.id,'完成')
    store.markDelivered(r,'WorkBuddy',rWb.deliveredIds)
    const nextCodex=store.startBatch(r,'@Codex 评价下 WorkBuddy','Codex')[0]
    assert.match(nextCodex.prompt,/WorkBuddy 观点 B/)
    assert.doesNotMatch(nextCodex.prompt,/Codex 观点 A/)
    store.finish(nextCodex.id,'完成')
    store.markDelivered(r,'Codex',nextCodex.deliveredIds)
    const nextCodex2=store.startBatch(r,'@Codex 补充一句','Codex')[0]
    assert.doesNotMatch(nextCodex2.prompt,/WorkBuddy 观点 B/)
    const nextWb=store.startBatch(r,'@WorkBuddy 评价下 Codex','WorkBuddy')[0]
    assert.match(nextWb.prompt,/Codex 观点 A/)
    assert.doesNotMatch(nextWb.prompt,/WorkBuddy 观点 B/)
    store.finish(nextCodex2.id,'完成')
    store.finish(nextWb.id,'完成')
    // 强制新会话（freshAgents）跳过旧绑定且仍带入最新上下文与只读归档
    const freshCodex=store.startBatch(r,'@Codex 重新审一下','Codex',['Codex'],[],{},new Set(['Codex']))[0]
    assert.equal(freshCodex.session,undefined)
    assert.match(freshCodex.prompt,/WorkBuddy 观点 B/)
    assert.match(freshCodex.prompt,/index\.md/)
    store.finish(freshCodex.id,'完成')
    store.remove('project',p)
    store.db.close()
  }finally{
    rmSync(base,{recursive:true,force:true})
  }
})


test('项目重命名、自动标题提炼/锁定与外部会话导入',()=>{
  const base=mkdtempSync(path.join(tmpdir(),'hive-import-'))
  try{
    const folder=path.join(base,'project');mkdirSync(folder)
    const store=new Store(path.join(base,'hive.sqlite'))
    const p=store.project(folder),r=store.tree().rooms[0].id
    store.renameProject(p,'我的自定义项目名')
    assert.equal(store.tree().projects[0].name,'我的自定义项目名')

    // 自动标题提炼与 title_locked 保护
    const r1=store.start(r,'@Codex 请帮我看一下这个压测方案有没有问题？谢谢')
    store.finish(r1.id,'完成')
    const autoTitle=store.tree().rooms.find(x=>x.id===r).title
    assert.equal(autoTitle,'这个压测方案有没有问题')
    assert.equal(store.autoTitleRoom(r,'压测方案评审'),true)
    assert.equal(store.tree().rooms.find(x=>x.id===r).title,'压测方案评审')
    store.renameRoom(r,'用户手动定名')
    assert.equal(store.autoTitleRoom(r,'不应覆盖的名字'),false)
    assert.equal(store.tree().rooms.find(x=>x.id===r).title,'用户手动定名')

    // 外部会话导入：创建讨论、绑定原生会话、标记已读、落盘只读归档
    const importedId=store.importRoom(p,{
      agent:'Codex',
      nativeId:'codex-ext-1',
      title:'导入的 Codex 压测讨论',
      turns:[
        {role:'user',text:'先压测一下接口',time:1000},
        {role:'assistant',text:'压测结果 P99 为 120ms',time:2000}
      ]
    })
    assert.equal(store.messages(importedId).length,2)
    assert.equal(existsSync(path.join(roomArchiveDir(folder,importedId),'index.md')),true)
    // 导入后直接续接 Codex 不应重复带入已导入消息，而 @Claude 应直接看到 Codex 结论
    const contCodex=store.start(importedId,'@Codex 继续优化')
    assert.equal(contCodex.session,'codex-ext-1')
    assert.doesNotMatch(contCodex.prompt,/P99 为 120ms/)
    const askClaude=store.start(importedId,'@Claude 评审一下压测结果')
    assert.match(askClaude.prompt,/P99 为 120ms/)
    store.finish(contCodex.id,'完成')
    store.finish(askClaude.id,'完成')
    store.remove('project',p)
    store.db.close()
  }finally{
    rmSync(base,{recursive:true,force:true})
  }
})

test('Store.record stamps step offsets and separates post-step text paragraphs', async () => {
  const { parseStepsWithMeta, buildTimelineSegments } = await import('../src/steps.ts')
  const base = mkdtempSync(path.join(tmpdir(), 'ominihive-offset-'))
  try {
    const folder = path.join(base, 'repo')
    mkdirSync(folder)
    const store = new Store(path.join(base, 'db.sqlite'))
    const p = store.project(folder)
    const r = store.tree().rooms[0].id
    const run = store.start(r, '@Claude 检查配置')

    store.record(run.id, r, 'Claude', 'text', '我先看 package.json：')
    store.record(run.id, r, 'Claude', 'log', '::step::' + JSON.stringify({ id: 't1', kind: 'tool', title: 'Read · package.json', status: 'running' }))
    store.record(run.id, r, 'Claude', 'log', '::step::' + JSON.stringify({ id: 't1', kind: 'tool', title: 'Read · package.json', status: 'done', detail: 'ok' }))
    store.record(run.id, r, 'Claude', 'text', '确认了依赖，现在跑测试：')
    store.record(run.id, r, 'Claude', 'log', '::step::' + JSON.stringify({ id: 't2', kind: 'cmd', title: 'Bash · npm test', status: 'done' }))
    store.record(run.id, r, 'Claude', 'text', '全部通过。')
    store.finish(run.id, '完成')

    const msg = store.messages(r).find(m => m.id === run.id)
    assert.equal(msg.body, '我先看 package.json：\n\n确认了依赖，现在跑测试：\n\n全部通过。')
    const { steps } = parseStepsWithMeta(msg.log, true)
    const segs = buildTimelineSegments(msg.body, steps)
    assert.ok(segs)
    assert.deepEqual(segs.map(s => s.type), ['text', 'steps', 'text', 'steps', 'text'])
    assert.equal(segs[0].content, '我先看 package.json：')
    assert.deepEqual(segs[1].steps.map(s => s.id), ['t1'])
    assert.equal(segs[2].content, '确认了依赖，现在跑测试：')
    assert.deepEqual(segs[3].steps.map(s => s.id), ['t2'])
    assert.equal(segs[4].content, '全部通过。')

    store.remove('project', p)
    store.db.close()
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('Store.record does not split streaming text after leading steps or same-step updates', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'ominihive-stream-split-'))
  try {
    const folder = path.join(base, 'repo')
    mkdirSync(folder)
    const store = new Store(path.join(base, 'db.sqlite'))
    const p = store.project(folder)
    const r = store.tree().rooms[0].id

    // Case 1: steps before any body text must not cause a paragraph break between chunk 1 and chunk 2
    const run1 = store.start(r, '@Claude 检查图 1')
    store.record(run1.id, r, 'Claude', 'log', '::step::' + JSON.stringify({ id: 'claude-think-1', kind: 'thought', title: '思考中', status: 'running' }))
    store.record(run1.id, r, 'Claude', 'log', '::step::' + JSON.stringify({ id: 'claude-think-1', kind: 'thought', title: '思考过程', status: 'done', detail: 'checking' }))
    store.record(run1.id, r, 'Claude', 'text', '图')
    store.record(run1.id, r, 'Claude', 'text', '1 的版面基本可用')
    store.finish(run1.id, '完成')
    assert.equal(store.messages(r).find(m => m.id === run1.id).body, '图1 的版面基本可用')

    // Case 2: late update to an already-seen step during text streaming must not split the sentence
    const run2 = store.start(r, '@Claude 修改命名')
    store.record(run2.id, r, 'Claude', 'log', '::step::' + JSON.stringify({ id: 'claude-think-1', kind: 'thought', title: '思考中', status: 'running' }))
    store.record(run2.id, r, 'Claude', 'text', '明')
    store.record(run2.id, r, 'Claude', 'log', '::step::' + JSON.stringify({ id: 'claude-think-1', kind: 'thought', title: '思考过程', status: 'done', detail: 'done' }))
    store.record(run2.id, r, 'Claude', 'text', '白，只有编译出的论文 PDF 用日期命名。')
    store.finish(run2.id, '完成')
    assert.equal(store.messages(r).find(m => m.id === run2.id).body, '明白，只有编译出的论文 PDF 用日期命名。')

    store.remove('project', p)
    store.db.close()
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('超长回复内联有上限并指向归档；增量读取只返回变化的消息', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'hive-cap-'))
  try {
    const folder = path.join(base, 'project'); mkdirSync(folder)
    const store = new Store(path.join(base, 'hive.sqlite'))
    store.project(folder); const r = store.tree().rooms[0].id
    const c = store.start(r, '@Codex 输出')
    store.record(c.id, r, 'Codex', 'text', '甲'.repeat(400000))
    store.finish(c.id, '完成')
    const cl = store.start(r, '@Claude 评审')
    assert.ok(cl.prompt.length < 80000, 'prompt stays bounded: ' + cl.prompt.length)
    assert.match(cl.prompt, /共 400000 字/)
    assert.match(cl.prompt, /\.ominihive\/context\//)

    const first = store.messagesDelta(r, {})
    assert.equal(first.ids.length, first.rows.length)
    const known = Object.fromEntries(first.rows.map(x => [x.id, x.sig]))
    assert.deepEqual(store.messagesDelta(r, known).rows, [])
    store.record(cl.id, r, 'Claude', 'text', '新内容')
    const delta = store.messagesDelta(r, known)
    assert.deepEqual(delta.rows.map(x => x.id), [cl.id])
    assert.equal(delta.ids.length, first.ids.length)
    store.db.close()
  } finally {
    try { chmodSync(path.join(base, 'project', '.ominihive'), 0o755) } catch {}
    for (const d of [path.join(base, 'project', '.ominihive', 'context')]) { try { for (const n of readdirSync(d)) chmodSync(path.join(d, n), 0o755) } catch {} }
    rmSync(base, { recursive: true, force: true })
  }
})

test('并发完成顺序不同时归档文件名保持稳定，旧文件被清理', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'hive-arch-'))
  try {
    const folder = path.join(base, 'project'); mkdirSync(folder)
    const store = new Store(path.join(base, 'hive.sqlite'))
    store.project(folder); const r = store.tree().rooms[0].id
    const [codex, claude] = store.startBatch(r, '@Codex @Claude 对比', 'Codex')
    store.record(claude.id, r, 'Claude', 'text', 'Claude 先完成')
    store.finish(claude.id, '完成')
    store.record(codex.id, r, 'Codex', 'text', 'Codex 后完成')
    store.finish(codex.id, '完成')
    const dir = roomArchiveDir(folder, r)
    const files = readdirSync(dir).filter(n => n.endsWith('.md')).sort()
    assert.deepEqual(files, ['001-user.md', '002-Codex.md', '003-Claude.md', 'index.md'])
    assert.match(readFileSync(path.join(dir, '003-Claude.md'), 'utf8'), /Claude 先完成/)
    store.db.close()
  } finally {
    try { chmodSync(path.join(base, 'project', '.ominihive', 'context'), 0o755) } catch {}
    try { const d = path.join(base, 'project', '.ominihive', 'context'); for (const n of readdirSync(d)) chmodSync(path.join(d, n), 0o755) } catch {}
    rmSync(base, { recursive: true, force: true })
  }
})
