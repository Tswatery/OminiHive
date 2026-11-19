import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { runDesktopTurn, stopWatchingDesktopCallbacks } from '../desktop/antigravity-desktop.mjs'

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
