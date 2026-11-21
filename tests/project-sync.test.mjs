import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ensureCodexProject } from '../desktop/codex-projects.mjs'
import { runDesktopTurn } from '../desktop/antigravity-desktop.mjs'
import { Store } from '../desktop/store.mjs'

test('ensureCodexProject reuses existing project when folder is already in roots', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ominihive-codex-proj-'))
  try {
    const calls = []
    const request = async (method, params) => {
      calls.push({ method, params })
      if (method === 'project/list') {
        return {
          data: [{ id: 'proj-1', name: 'OmniHive', roots: [{ path: dir }] }],
          nextCursor: null
        }
      }
      throw Error('unexpected rpc: ' + method)
    }
    const res = await ensureCodexProject(request, dir, 'OminiHive')
    assert.deepEqual(res, { projectId: 'proj-1', name: 'OmniHive', created: false, updated: false })
    assert.deepEqual(calls.map(c => c.method), ['project/list'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ensureCodexProject attaches folder only to a same-name project that has no roots', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ominihive-codex-proj-'))
  try {
    const calls = []
    const request = async (method, params) => {
      calls.push({ method, params })
      if (method === 'project/list') {
        return {
          data: [
            { id: 'proj-bound', name: 'EmailMCP', roots: [{ path: '/tmp/other' }] },
            { id: 'proj-empty', name: 'EmailMCP', roots: [] }
          ],
          nextCursor: null
        }
      }
      if (method === 'project/update') return { project: { id: params.projectId, name: 'EmailMCP', roots: params.roots } }
      throw Error('unexpected rpc: ' + method)
    }
    const res = await ensureCodexProject(request, dir, 'EmailMCP')
    assert.equal(res.projectId, 'proj-empty')
    assert.equal(res.updated, true)
    const updateCall = calls.find(c => c.method === 'project/update')
    assert.equal(updateCall.params.projectId, 'proj-empty')
    assert.equal(updateCall.params.roots.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ensureCodexProject never merges a folder into a same-name project bound elsewhere', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ominihive-codex-proj-'))
  try {
    const calls = []
    const request = async (method, params) => {
      calls.push({ method, params })
      if (method === 'project/list') return { data: [{ id: 'proj-src', name: 'src', roots: [{ path: '/tmp/another/src' }] }], nextCursor: null }
      if (method === 'project/create') return { project: { id: 'proj-new', name: params.name, roots: params.roots } }
      throw Error('unexpected rpc: ' + method)
    }
    const res = await ensureCodexProject(request, dir, 'src')
    assert.equal(res.projectId, 'proj-new')
    assert.equal(res.created, true)
    assert.ok(!calls.some(c => c.method === 'project/update'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ensureCodexProject recreates a project whose idempotency key points to a deleted one', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ominihive-codex-proj-'))
  try {
    const keys = []
    const request = async (method, params) => {
      if (method === 'project/list') return { data: [], nextCursor: null }
      if (method === 'project/create') {
        keys.push(params.idempotencyKey)
        if (keys.length === 1) throw Error('idempotency key refers to deleted project: ' + params.idempotencyKey)
        return { project: { id: 'proj-again', name: params.name, roots: params.roots } }
      }
      throw Error('unexpected rpc: ' + method)
    }
    const res = await ensureCodexProject(request, dir, 'EmailMCP')
    assert.equal(res.projectId, 'proj-again')
    assert.equal(keys.length, 2)
    assert.notEqual(keys[0], keys[1])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ensureCodexProject creates new project with folder root when missing', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ominihive-codex-proj-'))
  try {
    const calls = []
    const request = async (method, params) => {
      calls.push({ method, params })
      if (method === 'project/list') return { data: [], nextCursor: null }
      if (method === 'project/create') return { project: { id: 'proj-new', name: params.name, roots: params.roots } }
      throw Error('unexpected rpc: ' + method)
    }
    const res = await ensureCodexProject(request, dir, 'EmailMCP')
    assert.equal(res.projectId, 'proj-new')
    assert.equal(res.created, true)
    const createCall = calls.find(c => c.method === 'project/create')
    assert.ok(createCall)
    assert.equal(createCall.params.name, 'EmailMCP')
    assert.equal(createCall.params.roots.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runDesktopTurn creates Antigravity project using projectName and only overrides title when titleLocked is true', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ominihive-ag-proj-'))
  try {
    const runWith = async titleLocked => {
      const createdProjects = []
      const annotationCalls = []
      let sent = false
      const rpc = async (method, body) => {
        if (method === 'GetAllCascadeTrajectories') {
          return {
            trajectorySummaries: sent
              ? { 'cas-1': { status: 'CASCADE_RUN_STATUS_IDLE', stepCount: 2, trajectoryMetadata: { projectId: 'p-1' } } }
              : {}
          }
        }
        if (method === 'ListProjects') return { projectIds: [] }
        if (method === 'CreateProject') {
          createdProjects.push(body.project)
          return {}
        }
        if (method === 'StartCascade') return { cascadeId: 'cas-1' }
        if (method === 'UpdateConversationAnnotations') {
          annotationCalls.push(body)
          return {}
        }
        if (method === 'SendUserCascadeMessage') {
          sent = true
          return {}
        }
        if (method === 'GetCascadeTrajectorySteps') {
          return {
            steps: [
              { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { clientMessageId: body?.clientMessageId || '' } },
              { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE', plannerResponse: { modifiedResponse: 'ok' } }
            ]
          }
        }
        return {}
      }

      // Track the messageId from SendUserCascadeMessage so USER_INPUT matches
      let lastMsgId = ''
      const wrappedRpc = async (method, body) => {
        if (method === 'SendUserCascadeMessage') lastMsgId = body.clientMessageId
        const res = await rpc(method, body)
        if (method === 'GetCascadeTrajectorySteps' && res.steps?.[0]?.userInput) {
          res.steps[0].userInput.clientMessageId = lastMsgId
        }
        return res
      }

      await runDesktopTurn({
        app: '/Applications/Antigravity.app',
        cwd: dir,
        projectName: 'EmailMCP',
        prompt: 'hello',
        title: '自定义标题',
        titleLocked,
        write: true,
        signal: new AbortController().signal,
        emit: () => {},
        rpc: wrappedRpc
      })
      return { createdProjects, annotationCalls }
    }

    const unlocked = await runWith(false)
    assert.equal(unlocked.createdProjects.length, 1)
    assert.equal(unlocked.createdProjects[0].name, 'EmailMCP')
    assert.equal(unlocked.annotationCalls.length, 0, 'unlocked title must not overwrite Antigravity smart title')

    const locked = await runWith(true)
    assert.equal(locked.annotationCalls.length, 1, 'user-locked title should sync to Antigravity')
    assert.equal(locked.annotationCalls[0].annotations.title, '自定义标题')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Store.startBatch passes projectName and titleLocked state accurately', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ominihive-store-sync-'))
  const projDir = path.join(root, 'EmailMCP')
  mkdirSync(projDir, { recursive: true })
  const store = new Store(path.join(root, 'hive.db'))
  try {
    const pid = store.project(projDir)
    const rid = store.room(pid)
    const [run1] = store.startBatch(rid, '统一管理所有邮箱', 'Codex', ['Codex'])
    assert.equal(run1.projectName, 'EmailMCP')
    assert.equal(run1.titleLocked, false)

    store.renameRoom(rid, '邮箱助手')
    const [run2] = store.startBatch(rid, '继续', 'Codex', ['Codex'])
    assert.equal(run2.title, '邮箱助手')
    assert.equal(run2.titleLocked, true)
  } finally {
    store.db.close()
    try { rmSync(root, { recursive: true, force: true }) } catch {}
  }
})
