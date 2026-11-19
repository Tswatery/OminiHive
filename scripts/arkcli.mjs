import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const cache = fileURLToPath(new URL('../node_modules/.cache/ominihive/', import.meta.url))
const version = '1.0.49'
const architectures = {
  arm64: ['arm64', '0e27e58df9fecc7f479391d40f9a964e182b8a4472e43c78f3c7dbb22fd147b7'],
  x64: ['amd64', '99ee991b96dae9cdf48062a15c5de6ab562d0433fabc201048bc2ade02b3261e']
}

function ensureFile(name, url, digest) {
  const file = path.join(cache, name)
  const matches = target => createHash('sha256').update(readFileSync(target)).digest('hex') === digest
  try { if (matches(file)) return file } catch (error) { if (error.code !== 'ENOENT') throw error }
  const temp = file + '.' + randomUUID()
  try {
    execFileSync('/usr/bin/curl', ['--fail', '--location', '--silent', '--show-error', '--retry', '2', '--max-time', '180', '--output', temp, url])
    if (!matches(temp)) throw Error('火山官方组件校验失败')
    renameSync(temp, file)
    return file
  } finally { rmSync(temp, { force: true }) }
}

export function prepareArkCli() {
  if (process.platform !== 'darwin' || !architectures[process.arch]) throw Error('火山额度组件需要 macOS')
  mkdirSync(cache, { recursive: true })
  const [arch, digest] = architectures[process.arch]
  const binary = ensureFile('arkcli', 'https://github.com/volcengine/ark-cli/releases/download/v' + version + '/arkcli-' + version + '-darwin-' + arch, digest)
  chmodSync(binary, 0o755)
  const license = ensureFile('ARK-CLI-LICENSE', 'https://raw.githubusercontent.com/volcengine/ark-cli/v' + version + '/LICENSE', 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4')
  return [binary, license]
}

if (process.argv[1] === fileURLToPath(import.meta.url)) prepareArkCli()
