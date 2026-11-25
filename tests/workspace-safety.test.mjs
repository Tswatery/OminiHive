import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir, homedir } from 'node:os'
import path from 'node:path'
import { previewFile, opensAsProgram, isSensitivePath, resolveLocalFilePath } from '../desktop/workspace.mjs'

test('预览拒绝命名管道和设备文件，不会卡住主进程', async () => {
  const d = mkdtempSync(path.join(tmpdir(), 'hive-ws-'))
  try {
    execFileSync('/usr/bin/mkfifo', [path.join(d, 'pipe.png')])
    await assert.rejects(previewFile(d, 'pipe.png'), /不是普通文件/)
    await assert.rejects(previewFile(d, '/dev/zero'), /不是普通文件/)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('大文本只读取开头部分', async () => {
  const d = mkdtempSync(path.join(tmpdir(), 'hive-ws-'))
  try {
    writeFileSync(path.join(d, 'big.log'), Buffer.alloc(3 * 1024 * 1024, 'a'))
    const r = await previewFile(d, 'big.log')
    assert.equal(r.kind, 'text')
    assert.equal(r.content.length, 262144)
    assert.equal(r.truncated, true)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('脚本和可执行文件不会被直接打开，凭据目录不预览', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'hive-ws-'))
  try {
    writeFileSync(path.join(d, 'run.command'), 'echo hi')
    writeFileSync(path.join(d, 'tool'), 'x'); chmodSync(path.join(d, 'tool'), 0o755)
    writeFileSync(path.join(d, 'notes.md'), '# hi')
    assert.equal(opensAsProgram(path.join(d, 'run.command')), true)
    assert.equal(opensAsProgram(path.join(d, 'tool')), true)
    assert.equal(opensAsProgram(path.join(d, 'notes.md')), false)
    assert.equal(isSensitivePath(path.join(homedir(), '.ssh', 'id_rsa')), true)
    assert.equal(isSensitivePath(path.join(d, 'notes.md')), false)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('Agent cd 进子工作区后输出的相对路径也能找到文件', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'hive-subws-'))
  try {
    mkdirSync(path.join(root, '1218工作区', '交付'), { recursive: true })
    const real = path.join(root, '1218工作区', '交付', '报告.pptx')
    writeFileSync(real, 'x')
    writeFileSync(path.join(root, '顶层.md'), 'x')
    assert.equal(resolveLocalFilePath(root, '交付/报告.pptx'), real)
    assert.equal(resolveLocalFilePath(root, path.join(root, '交付', '报告.pptx')), real)
    assert.equal(resolveLocalFilePath(root, '顶层.md'), path.join(root, '顶层.md'))
    assert.equal(resolveLocalFilePath(root, '不存在/x.md'), path.join(root, '不存在', 'x.md'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
