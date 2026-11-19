import { useEffect, useState } from 'react'
import { Button, Flex, Progress, Text } from '@radix-ui/themes'
import { RefreshCw } from 'lucide-react'

const labels = { session: '近 5 小时', weekly: '近一周', monthly: '近一月' }
export type QuotaResult =
  | { state: 'ready'; checkedAt: number; windows: { id: keyof typeof labels; used: number | null; reset: number | null }[] }
  | { state: 'login' | 'empty' | 'error'; message: string }

const resetFormat = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })

export function VolcQuota() {
  const [result, setResult] = useState<QuotaResult>()
  const [action, setAction] = useState<'read' | 'login' | null>('read')

  useEffect(() => {
    if (!action) return
    let active = true
    const request = action === 'login' ? window.hive.volcLogin() : window.hive.volcQuota()
    request.catch((): QuotaResult => ({ state: 'error', message: '查询失败，请重试。' })).then(next => {
      if (active) { setResult(next); setAction(null) }
    })
    return () => { active = false }
  }, [action])

  useEffect(() => {
    if (action || result?.state !== 'ready') return
    const timer = window.setTimeout(() => setAction('read'), 60000)
    return () => window.clearTimeout(timer)
  }, [action, result])

  return (
    <section className="quota-panel" aria-label="火山方舟 Coding Plan">
      <Flex align="center" justify="between" gap="2">
        <strong>火山方舟 · Coding Plan</strong>
        <Button size="1" variant="soft" disabled={!!action} onClick={() => setAction('read')}>
          <RefreshCw size={13} /> 刷新额度
        </Button>
      </Flex>
      {result?.state === 'ready' ? <>
        {result.windows.map(({ id, used, reset }) => (
          <div className="quota-window" key={id}>
            <Flex align="center" justify="between">
              <span>{labels[id]}</span>
              <strong>{used === null ? '暂无用量数据' : '已用 ' + used.toFixed(2) + '%'}</strong>
            </Flex>
            {used !== null && <Progress size="2" value={used} aria-label={labels[id] + '已用额度'} />}
            <Text size="1" color="gray">{reset ? resetFormat.format(reset) + ' 重置' : '暂无重置时间'}</Text>
          </div>
        ))}
        <Text size="1" color="gray">上次查询 {new Date(result.checkedAt).toLocaleTimeString('zh-CN')}</Text>
      </> : (
        <div className="quota-connect">
          <Text as="p" size="2" color="gray" role="status">
            {action === 'login' ? '请在浏览器完成火山账号授权，完成后会自动读取额度。' : result?.message || '正在读取套餐额度…'}
          </Text>
          {result && <Button size="2" variant="soft" disabled={!!action} onClick={() => setAction('login')}>登录火山账号</Button>}
        </div>
      )}
    </section>
  )
}
