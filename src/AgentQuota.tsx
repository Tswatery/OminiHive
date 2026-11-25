import { useCallback, useEffect, useState } from 'react'
import { Popover } from '@radix-ui/themes'
import { ChevronDown, RefreshCw } from 'lucide-react'
import { AgentIcon } from './AgentIcon'
import { Tip } from './Tip'
import { formatAgo, formatResetCompact, formatResetIn, planLabel, tightestBucket, type ProviderQuota, type QuotaBucket } from './usageFormat'

type Mode = 'remaining' | 'used'
type Provider = ProviderQuota['provider']
const PROVIDERS: Provider[] = ['Codex', 'Antigravity']
const POLL_MS = 5 * 60 * 1000

const shown = (b: QuotaBucket, mode: Mode) => Math.round(mode === 'remaining' ? 100 - b.usedPercent : b.usedPercent)
const tone = (b?: QuotaBucket) => (!b ? 'ok' : b.usedPercent >= 90 ? 'critical' : b.usedPercent >= 70 ? 'warn' : 'ok')
const bucketName = (group: string, b: QuotaBucket) => [group, b.label].filter(Boolean).join(' · ')

function Bar({ bucket, mode, thin = false }: { bucket: QuotaBucket; mode: Mode; thin?: boolean }) {
  return (
    <div className={'qp-bar ' + tone(bucket) + (thin ? ' thin' : '')}>
      <i style={{ width: Math.max(2, shown(bucket, mode)) + '%' }} />
    </div>
  )
}

function ProviderCard({ q, mode, expanded, onToggle, loading }: {
  q: ProviderQuota
  mode: Mode
  expanded: boolean
  onToggle: () => void
  loading: boolean
}) {
  const tight = tightestBucket(q)
  const rest = q.groups.flatMap(g => g.buckets.map(b => ({ group: g.name, b }))).filter(x => x.b !== tight?.bucket)
  const canExpand = q.state === 'ready' && rest.length > 0
  return (
    <div className={'qp-card' + (expanded ? ' open' : '')}>
      <button type="button" className="qp-card-main" onClick={canExpand ? onToggle : undefined} aria-expanded={canExpand ? expanded : undefined}>
        <span className="qp-icon"><AgentIcon name={q.provider} size={17} /></span>
        <span className="qp-body">
          <span className="qp-title">
            <strong>{q.provider}</strong>
            {q.plan && <span className="qp-plan">{planLabel(q.plan)}</span>}
            {loading && <RefreshCw size={11} className="spin qp-loading" />}
          </span>
          {q.state === 'ready' && tight ? (
            <>
              <Bar bucket={tight.bucket} mode={mode} />
              <span className="qp-sub">
                {bucketName(tight.group, tight.bucket)}
                {tight.bucket.resetsAt ? ` · ${formatResetIn(tight.bucket.resetsAt)}后重置` : ''}
              </span>
            </>
          ) : (
            <span className="qp-sub">{q.message || '暂时无法获取额度'}</span>
          )}
        </span>
        {q.state === 'ready' && tight && (
          <span className={'qp-pct ' + tone(tight.bucket)}>{shown(tight.bucket, mode)}<small>%</small></span>
        )}
        {canExpand && <ChevronDown size={14} className="qp-caret" />}
      </button>
      {expanded && canExpand && (
        <div className="qp-more">
          {rest.map(({ group, b }) => (
            <div className="qp-more-row" key={group + b.id}>
              <div className="qp-more-line">
                <span>{bucketName(group, b)}</span>
                <span className="qp-more-reset">{b.resetsAt ? formatResetIn(b.resetsAt) + '后重置' : ''}</span>
                <b>{shown(b, mode)}%</b>
              </div>
              <Bar bucket={b} mode={mode} thin />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Sidebar status row with Codex / Antigravity quota; click for the condensed panel. */
export function AgentQuota({ enabled }: { enabled: Record<Provider, boolean> }) {
  const [quotas, setQuotas] = useState<Partial<Record<Provider, ProviderQuota>>>({})
  const [loading, setLoading] = useState<Partial<Record<Provider, boolean>>>({})
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState<Provider | ''>('')
  const [mode, setMode] = useState<Mode>(() => (localStorage.getItem('quotaMode') === 'used' ? 'used' : 'remaining'))
  const [, tick] = useState(0)

  const providers = PROVIDERS.filter(p => enabled[p])
  const providerKey = providers.join(',')

  const load = useCallback((force: boolean) => {
    // Each provider lands on its own: Codex answers in ~2s, agy can take longer.
    for (const p of providerKey.split(',').filter(Boolean) as Provider[]) {
      setLoading(prev => ({ ...prev, [p]: true }))
      window.hive.agentQuota(force, p)
        .then(q => setQuotas(prev => ({ ...prev, [p]: q })))
        .catch(() => {})
        .finally(() => setLoading(prev => ({ ...prev, [p]: false })))
    }
  }, [providerKey])

  useEffect(() => {
    let alive = true
    window.hive.agentQuotaCached().then(list => {
      if (!alive) return
      setQuotas(prev => {
        const next = { ...prev }
        for (const q of list) if (!next[q.provider]) next[q.provider] = q
        return next
      })
    }).catch(() => {})
    load(false)
    const poll = window.setInterval(() => load(false), POLL_MS)
    // Countdowns are minute-precise; re-render so they keep moving.
    const clock = window.setInterval(() => tick(n => n + 1), 60000)
    return () => { alive = false; window.clearInterval(poll); window.clearInterval(clock) }
  }, [load])

  useEffect(() => { localStorage.setItem('quotaMode', mode) }, [mode])

  if (!providers.length) return null
  const anyLoading = providers.some(p => loading[p])
  const newest = Math.max(0, ...providers.map(p => quotas[p]?.updatedAt || 0))
  const credits = quotas.Codex?.state === 'ready' ? quotas.Codex.resetCredits || 0 : 0

  return (
    <div className="quota-bar">
      <Popover.Root open={open} onOpenChange={next => { setOpen(next); if (next) load(false) }}>
        <Popover.Trigger>
          <button type="button" className="quota-bar-btn" aria-label="查看 Agent 额度">
            <span className="quota-bar-label">{mode === 'remaining' ? '剩余' : '已用'}</span>
            {providers.map(p => {
              const q = quotas[p]
              const tight = q?.state === 'ready' ? tightestBucket(q) : null
              return (
                <span key={p} className={'quota-bar-item ' + (tight ? tone(tight.bucket) : 'muted')}>
                  <AgentIcon name={p} size={12} />
                  <b>{tight ? shown(tight.bucket, mode) + '%' : q ? '—' : '…'}</b>
                  {tight?.bucket.resetsAt ? <span className="quota-bar-reset">{formatResetCompact(tight.bucket.resetsAt)}</span> : null}
                </span>
              )
            })}
          </button>
        </Popover.Trigger>
        <Popover.Content side="top" align="start" sideOffset={10} className="qp">
          <div className="qp-head">
            <strong>使用量</strong>
            <Tip content="刷新额度">
              <button type="button" className="qp-icon-btn" aria-label="刷新额度" disabled={anyLoading} onClick={() => load(true)}>
                <RefreshCw size={13} className={anyLoading ? 'spin' : ''} />
              </button>
            </Tip>
            <span className="qp-flex" />
            <div className="qp-seg" role="tablist" aria-label="显示方式">
              <button type="button" role="tab" aria-selected={mode === 'remaining'} className={mode === 'remaining' ? 'on' : ''} onClick={() => setMode('remaining')}>剩余</button>
              <button type="button" role="tab" aria-selected={mode === 'used'} className={mode === 'used' ? 'on' : ''} onClick={() => setMode('used')}>已用</button>
            </div>
          </div>
          <div className="qp-list">
            {providers.map(p => quotas[p] ? (
              <ProviderCard
                key={p}
                q={quotas[p]!}
                mode={mode}
                loading={!!loading[p]}
                expanded={expanded === p}
                onToggle={() => setExpanded(e => (e === p ? '' : p))}
              />
            ) : (
              <div key={p} className="qp-card qp-skeleton">
                <span className="qp-icon"><AgentIcon name={p} size={17} /></span>
                <span className="qp-body"><strong>{p}</strong><span className="qp-sub">正在读取额度…</span></span>
              </div>
            ))}
          </div>
          <div className="qp-foot">
            <span>{newest ? '更新于 ' + formatAgo(newest) : '读取中…'}</span>
            {credits > 0 && <span>Codex 可重置限额 {credits} 次</span>}
          </div>
        </Popover.Content>
      </Popover.Root>
      <Tip content="刷新额度">
        <button type="button" className="quota-icon-btn" aria-label="刷新额度" disabled={anyLoading} onClick={() => load(true)}>
          <RefreshCw size={12} className={anyLoading ? 'spin' : ''} />
        </button>
      </Tip>
    </div>
  )
}
