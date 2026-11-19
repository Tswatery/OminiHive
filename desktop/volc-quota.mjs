import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const periods = ['session', 'weekly', 'monthly']

function failure(details) {
  if (/not configured|auth login|not logged in|unauthenticated|expired.*token|token.*expired|invalid_grant/i.test(details)) {
    return { state: 'login', message: '请登录购买 Coding Plan 的火山账号。' }
  }
  if (/accessdenied|access denied|forbidden/i.test(details)) {
    return { state: 'error', message: '当前账号缺少套餐用量查询权限，请使用订阅账号登录。' }
  }
  return { state: 'error', message: '暂时无法获取火山额度，请稍后刷新。' }
}

export function readPlan(data) {
  if (data?.error) return failure(JSON.stringify(data.error))
  const item = data?.items?.find?.(row => row?.product === 'coding-plan')
  if (item?.error) return failure(JSON.stringify(item.error))
  if (item?.subscribed === false) return { state: 'empty', message: '当前火山账号没有生效的个人 Coding Plan。' }
  if (item?.subscribed !== true || !Array.isArray(item.periods)) return failure('')
  const windows = periods.map(id => {
    const row = item.periods.find(row => row?.label === id)
    const percent = row?.percent
    const reset = Date.parse(row?.reset_at)
    return { id, used: Number.isFinite(percent) && percent >= 0 && percent <= 100 ? percent : null,
      reset: Number.isFinite(reset) ? reset : null }
  })
  if (windows.every(row => row.used === null)) return failure('')
  return { state: 'ready', windows, checkedAt: Date.now() }
}

export function createQuotaClient(binary) {
  let pendingRead, pendingLogin
  async function query() {
    try {
      const { stdout } = await run(binary, ['usage', 'plan', '--product', 'coding-plan', '--format', 'json', '--ui-lang', 'en_us'], { timeout: 20000 })
      return readPlan(JSON.parse(stdout))
    } catch (error) {
      return failure([error.stdout, error.stderr].join(' '))
    }
  }
  async function login() {
    try {
      await run(binary, ['auth', 'login'], { timeout: 240000 })
    } catch {
      return { state: 'login', message: '火山授权未完成，请重新登录。' }
    }
    return query()
  }
  return {
    read: () => pendingLogin ?? (pendingRead ??= query().finally(() => { pendingRead = null })),
    login: () => pendingLogin ??= login().finally(() => { pendingLogin = null })
  }
}
