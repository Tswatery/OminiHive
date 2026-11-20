import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { runDesktopTurn, respondDesktopInteraction, stopWatchingDesktopCallbacks } from '../desktop/antigravity-desktop.mjs'

test('waits for swarm / notFullyIdle completion and does not block on lingering RUNNING background steps', async () => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), 'oh-ag-')))
  const projectId = 'proj-1'
  const cascadeId = 'cas-1'
  let sentMsgId = ''
  let poll = 0
  const texts = []
  const logs = []

  const rpc = async (method, body) => {
    if (method === 'ListProjects') return { projectIds: [projectId] }
    if (method === 'ReadProjects') {
      return {
        projects: [{
          id: projectId,
          projectResources: { resources: [{ folderUri: pathToFileURL(cwd).href }] }
        }]
      }
    }
    if (method === 'StartCascade') return { cascadeId }
    if (method === 'SendUserCascadeMessage') {
      sentMsgId = body.clientMessageId
      return {}
    }
    if (method === 'GetAllCascadeTrajectories') {
      poll++
      if (poll === 1) {
        return {
          trajectorySummaries: {
            [cascadeId]: { status: 'CASCADE_RUN_STATUS_IDLE', notFullyIdle: true, stepCount: 3 }
          }
        }
      }
      return {
        trajectorySummaries: {
          [cascadeId]: { status: 'CASCADE_RUN_STATUS_IDLE', notFullyIdle: false, stepCount: 7 }
        }
      }
    }
    if (method === 'GetCascadeTrajectorySteps') {
      const all = poll === 1
        ? [
            { status: 'CORTEX_STEP_STATUS_DONE', userInput: { clientMessageId: sentMsgId } },
            { status: 'CORTEX_STEP_STATUS_DONE', type: 'CORTEX_STEP_TYPE_SWARM', metadata: { toolCall: { name: 'swarm' } } },
            { status: 'CORTEX_STEP_STATUS_DONE', plannerResponse: { response: '我已启动 Swarm 并行收尾。' } }
          ]
        : [
            { status: 'CORTEX_STEP_STATUS_DONE', userInput: { clientMessageId: sentMsgId } },
            { status: 'CORTEX_STEP_STATUS_DONE', type: 'CORTEX_STEP_TYPE_SWARM', metadata: { toolCall: { name: 'swarm' } } },
            { status: 'CORTEX_STEP_STATUS_DONE', plannerResponse: { response: '我已启动 Swarm 并行收尾。' } },
            { status: 'CORTEX_STEP_STATUS_DONE', type: 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE' },
            { status: 'CORTEX_STEP_STATUS_RUNNING', type: 'CORTEX_STEP_TYPE_RUN_COMMAND', metadata: { toolCall: { name: 'run_command' } } },
            { status: 'CORTEX_STEP_STATUS_DONE', plannerResponse: { response: '两位 Swarm 成员已全部完工。' } },
            { status: 'CORTEX_STEP_STATUS_DONE', plannerResponse: { response: '全书构建与排版检查 PASS。' } }
          ]
      return { steps: all.slice(body.stepOffset || 0) }
    }
    return {}
  }

  try {
    await runDesktopTurn({
      cwd,
      prompt: '开swarm开始改了',
      write: true,
      signal: AbortSignal.timeout(10000),
      emit: (type, value) => {
        if (type === 'text') texts.push(value)
        if (type === 'log') logs.push(value)
      },
      rpc
    })
  } finally {
    stopWatchingDesktopCallbacks(cascadeId)
    rmSync(cwd, { recursive: true, force: true })
  }

  const combined = texts.join('')
  assert.match(combined, /我已启动 Swarm 并行收尾/)
  assert.match(combined, /两位 Swarm 成员已全部完工/)
  assert.match(combined, /全书构建与排版检查 PASS/)
  assert.ok(poll >= 2)
})

test('syncs late background task callback even after turn becomes idle', async () => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), 'oh-ag-late-')))
  const projectId = 'proj-2'
  const cascadeId = 'cas-2'
  let sentMsgId = ''
  let lateCallbackArrived = false
  const texts = []

  const rpc = async (method, body) => {
    if (method === 'ListProjects') return { projectIds: [projectId] }
    if (method === 'ReadProjects') {
      return {
        projects: [{
          id: projectId,
          projectResources: { resources: [{ folderUri: pathToFileURL(cwd).href }] }
        }]
      }
    }
    if (method === 'StartCascade') return { cascadeId }
    if (method === 'SendUserCascadeMessage') {
      sentMsgId = body.clientMessageId
      return {}
    }
    if (method === 'GetAllCascadeTrajectories') {
      return {
        trajectorySummaries: {
          [cascadeId]: {
            status: 'CASCADE_RUN_STATUS_IDLE',
            notFullyIdle: false,
            stepCount: lateCallbackArrived ? 4 : 2
          }
        }
      }
    }
    if (method === 'GetCascadeTrajectorySteps') {
      const all = lateCallbackArrived
        ? [
            { status: 'CORTEX_STEP_STATUS_DONE', userInput: { clientMessageId: sentMsgId } },
            { status: 'CORTEX_STEP_STATUS_DONE', plannerResponse: { response: '正在后台构建，完成后立即同步结果。' } },
            { status: 'CORTEX_STEP_STATUS_DONE', type: 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE' },
            { status: 'CORTEX_STEP_STATUS_DONE', plannerResponse: { response: '后台构建已完成，排版检查 PASS。' } }
          ]
        : [
            { status: 'CORTEX_STEP_STATUS_DONE', userInput: { clientMessageId: sentMsgId } },
            { status: 'CORTEX_STEP_STATUS_DONE', plannerResponse: { response: '正在后台构建，完成后立即同步结果。' } }
          ]
      return { steps: all.slice(body.stepOffset || 0) }
    }
    return {}
  }

  try {
    await runDesktopTurn({
      cwd,
      prompt: '开始改吧',
      write: true,
      signal: AbortSignal.timeout(10000),
      emit: (type, value) => { if (type === 'text') texts.push(value) },
      rpc
    })
    assert.match(texts.join(''), /正在后台构建/)
    lateCallbackArrived = true
    await new Promise(r => setTimeout(r, 2800))
    assert.match(texts.join(''), /后台构建已完成，排版检查 PASS/)
  } finally {
    stopWatchingDesktopCallbacks(cascadeId)
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('emits waiting interaction step and resolves it via respondDesktopInteraction', async () => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), 'oh-ag-wait-')))
  const projectId = 'proj-3'
  const cascadeId = 'cas-3'
  const trajectoryId = 'traj-3'
  let sentMsgId = ''
  let approved = false
  let receivedInteractionReq = null
  const stepsEmitted = []
  const texts = []

  const rpc = async (method, body) => {
    if (method === 'ListProjects') return { projectIds: [projectId] }
    if (method === 'ReadProjects') {
      return {
        projects: [{
          id: projectId,
          projectResources: { resources: [{ folderUri: pathToFileURL(cwd).href }] }
        }]
      }
    }
    if (method === 'StartCascade') return { cascadeId }
    if (method === 'SendUserCascadeMessage') {
      sentMsgId = body.clientMessageId
      return {}
    }
    if (method === 'HandleCascadeUserInteraction') {
      receivedInteractionReq = body
      approved = true
      return {}
    }
    if (method === 'GetAllCascadeTrajectories') {
      return {
        trajectorySummaries: {
          [cascadeId]: {
            trajectoryId,
            status: approved ? 'CASCADE_RUN_STATUS_IDLE' : 'CASCADE_RUN_STATUS_RUNNING',
            notFullyIdle: !approved,
            stepCount: approved ? 3 : 2
          }
        }
      }
    }
    if (method === 'GetCascadeTrajectorySteps') {
      const all = approved
        ? [
            { status: 'CORTEX_STEP_STATUS_DONE', userInput: { clientMessageId: sentMsgId } },
            { status: 'CORTEX_STEP_STATUS_DONE', type: 'CORTEX_STEP_TYPE_VIEW_FILE', metadata: { toolCall: { name: 'read_file' } } },
            { status: 'CORTEX_STEP_STATUS_DONE', plannerResponse: { response: '已读取目标文件并完成分析。' } }
          ]
        : [
            { status: 'CORTEX_STEP_STATUS_DONE', userInput: { clientMessageId: sentMsgId } },
            {
              status: 'CORTEX_STEP_STATUS_WAITING',
              type: 'CORTEX_STEP_TYPE_VIEW_FILE',
              metadata: { toolCall: { name: 'read_file' } },
              requestedInteraction: {
                permission: {
                  resource: { action: 'read_file', target: '/Users/lin/code/other/load-admission.js' }
                }
              }
            }
          ]
      return { steps: all.slice(body.stepOffset || 0) }
    }
    return {}
  }

  try {
    await runDesktopTurn({
      cwd,
      prompt: '读取外部文件',
      write: false,
      signal: AbortSignal.timeout(10000),
      emit: (type, value) => {
        if (type === 'text') texts.push(value)
        if (type === 'log' && String(value).startsWith('::step::')) {
          const parsed = JSON.parse(String(value).slice(8))
          stepsEmitted.push(parsed)
          if (parsed.status === 'waiting' && parsed.interaction) {
            const opt = parsed.interaction.options[0]
            void respondDesktopInteraction({
              cascadeId: parsed.interaction.cascadeId,
              trajectoryId: parsed.interaction.trajectoryId,
              stepIndex: parsed.interaction.stepIndex,
              payload: opt.payload
            })
          }
        }
      },
      rpc
    })
  } finally {
    stopWatchingDesktopCallbacks(cascadeId)
    rmSync(cwd, { recursive: true, force: true })
  }

  const waitingStep = stepsEmitted.find(s => s.status === 'waiting')
  assert.ok(waitingStep, 'should emit waiting step')
  assert.equal(waitingStep.interaction.target, '/Users/lin/code/other/load-admission.js')
  assert.equal(waitingStep.interaction.options.length, 4)
  assert.deepEqual(receivedInteractionReq, {
    cascadeId,
    interaction: {
      trajectoryId,
      stepIndex: 1,
      permission: { allow: true, scope: 'PERMISSION_SCOPE_ONCE' }
    }
  })
  const finalStep = stepsEmitted.find(s => s.id === waitingStep.id && s.status === 'done')
  assert.ok(finalStep, 'should emit terminal step after approval')
  assert.equal(finalStep.interaction, null)
  assert.match(texts.join(''), /已读取目标文件并完成分析/)
})

test('runDesktopTurn reuses existing active Antigravity project by name instead of throwing already_exists', async () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'ominihive-ag-name-'))
  const cwd = path.join(parent, 'OminiHive')
  mkdirSync(cwd, { recursive: true })
  const existingProjectId = 'proj-existing-ominihive'
  const cascadeId = 'cascade-reuse-name-1'
  let sentMsgId = ''
  let startedProjectId = ''
  let createCalled = false

  const rpc = async (method, body) => {
    if (method === 'ListProjects') return { projectIds: [existingProjectId] }
    if (method === 'ReadProjects') {
      return {
        projects: [{
          id: existingProjectId,
          name: 'OminiHive',
          projectResources: { resources: [] }
        }]
      }
    }
    if (method === 'CreateProject') {
      createCalled = true
      throw Error('already_exists: project with name "OminiHive" already exists')
    }
    if (method === 'StartCascade') {
      startedProjectId = body?.projectEnvConfig?.projectId || ''
      return { cascadeId }
    }
    if (method === 'SendUserCascadeMessage') {
      sentMsgId = body.clientMessageId
      return {}
    }
    if (method === 'GetAllCascadeTrajectories') {
      return {
        trajectorySummaries: {
          [cascadeId]: {
            trajectoryId: 'traj-reuse-1',
            status: 'CASCADE_RUN_STATUS_IDLE',
            notFullyIdle: false,
            stepCount: 2
          }
        }
      }
    }
    if (method === 'GetCascadeTrajectorySteps') {
      const all = [
        { status: 'CORTEX_STEP_STATUS_DONE', userInput: { clientMessageId: sentMsgId } },
        { status: 'CORTEX_STEP_STATUS_DONE', plannerResponse: { response: '已在 OminiHive 项目下创建对话。' } }
      ]
      return { steps: all.slice(body.stepOffset || 0) }
    }
    return {}
  }

  try {
    await runDesktopTurn({
      cwd,
      prompt: '继续讨论',
      write: false,
      signal: AbortSignal.timeout(10000),
      emit: () => {},
      rpc
    })
  } finally {
    stopWatchingDesktopCallbacks(cascadeId)
    rmSync(parent, { recursive: true, force: true })
  }

  assert.equal(createCalled, false, 'should not call CreateProject when active same-name project exists')
  assert.equal(startedProjectId, existingProjectId, 'should start cascade under existing OminiHive project')
})

test('runDesktopTurn avoids already_exists when an archived project holds the same name', async () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'ominihive-ag-arch-'))
  const cwd = path.join(parent, 'OminiHive')
  mkdirSync(cwd, { recursive: true })
  const cascadeId = 'cascade-arch-1'
  let sentMsgId = ''
  let createdName = ''

  const rpc = async (method, body) => {
    if (method === 'ListProjects') return { projectIds: ['proj-archived'] }
    if (method === 'ReadProjects') {
      return {
        projects: [{
          id: 'proj-archived',
          name: 'OminiHive',
          archived: true,
          projectResources: { resources: [] }
        }]
      }
    }
    if (method === 'CreateProject') {
      createdName = body?.project?.name || ''
      assert.notEqual(createdName, 'OminiHive', 'should pick a non-conflicting project name')
      return {}
    }
    if (method === 'StartCascade') return { cascadeId }
    if (method === 'SendUserCascadeMessage') {
      sentMsgId = body.clientMessageId
      return {}
    }
    if (method === 'GetAllCascadeTrajectories') {
      return {
        trajectorySummaries: {
          [cascadeId]: {
            trajectoryId: 'traj-arch-1',
            status: 'CASCADE_RUN_STATUS_IDLE',
            notFullyIdle: false,
            stepCount: 2
          }
        }
      }
    }
    if (method === 'GetCascadeTrajectorySteps') {
      const all = [
        { status: 'CORTEX_STEP_STATUS_DONE', userInput: { clientMessageId: sentMsgId } },
        { status: 'CORTEX_STEP_STATUS_DONE', plannerResponse: { response: '创建成功。' } }
      ]
      return { steps: all.slice(body.stepOffset || 0) }
    }
    return {}
  }

  try {
    await runDesktopTurn({
      cwd,
      prompt: '新建测试',
      write: false,
      signal: AbortSignal.timeout(10000),
      emit: () => {},
      rpc
    })
  } finally {
    stopWatchingDesktopCallbacks(cascadeId)
    rmSync(parent, { recursive: true, force: true })
  }

  assert.ok(createdName.startsWith('OminiHive ('), `expected disambiguated name, got ${createdName}`)
})
