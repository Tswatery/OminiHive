import React from 'react'
import { Tip } from './Tip'
import { contextLevel, formatAgo, formatBytes, formatTokens, type ContextUsage } from './usageFormat'

/** Above this, the images re-sent with every request make uploads slow enough to time out. */
const IMAGE_HEAVY_BYTES = 20 * 1024 * 1024

/** A small progress ring; fill is the share of the context window in use. */
export function ContextRing({ pct, size = 14, stroke = 2.2 }: { pct: number | null; size?: number; stroke?: number }) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const filled = pct == null ? 0 : Math.min(100, Math.max(0, pct))
  return (
    <svg className={'ctx-ring ' + contextLevel(pct)} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <circle className="ctx-ring-track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} fill="none" />
      {pct != null && (
        <circle
          className="ctx-ring-fill"
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeWidth={stroke}
          fill="none"
          strokeDasharray={`${(filled / 100) * c} ${c}`}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      )}
    </svg>
  )
}

function ContextDetail({ usage, agent }: { usage: ContextUsage; agent: string }) {
  const level = contextLevel(usage.percentage)
  return (
    <div className="ctx-tip">
      <div className="ctx-tip-head">
        <strong>{agent} 上下文</strong>
        {usage.live && <span className="ctx-tip-live">实时</span>}
      </div>
      <div className="ctx-tip-row">
        <span>已用</span>
        <b>
          {usage.usedTokens != null ? formatTokens(usage.usedTokens) : '—'}
          {usage.windowTokens ? ' / ' + formatTokens(usage.windowTokens) : ''}
          {usage.percentage != null ? `（${usage.percentage}%）` : ''}
        </b>
      </div>
      {usage.percentage != null && (
        <div className={'ctx-tip-bar ' + level}>
          <i style={{ width: Math.min(100, usage.percentage) + '%' }} />
        </div>
      )}
      <div className="ctx-tip-row">
        <span>会话文件</span>
        <b>{formatBytes(usage.sessionBytes)}</b>
      </div>
      {usage.images && usage.images.count > 0 && (
        <>
          <div className="ctx-tip-row">
            <span>其中图片</span>
            <b>
              {usage.images.count} 张 · {formatBytes(usage.images.bytes)}
              {usage.sessionBytes ? `（${Math.round((usage.images.bytes / usage.sessionBytes) * 100)}%）` : ''}
            </b>
          </div>
          <div className="ctx-tip-row">
            <span>上下文内图片</span>
            <b>{usage.images.contextCount} 张 · {formatBytes(usage.images.contextBytes)}</b>
          </div>
          {usage.images.contextBytes >= IMAGE_HEAVY_BYTES && (
            <div className="ctx-tip-warn">每轮请求都会重新上传这些图片，体积过大时容易出现 408 上传超时，建议压缩上下文或新开会话。</div>
          )}
        </>
      )}
      {usage.model && <div className="ctx-tip-row"><span>模型</span><b>{usage.model}</b></div>}
      {usage.measuredAt && <div className="ctx-tip-foot">更新于 {formatAgo(usage.measuredAt)}</div>}
      {level !== 'ok' && (
        <div className={'ctx-tip-warn ' + level}>
          {level === 'critical' ? '上下文即将占满，Agent 可能自动压缩或丢失早期细节，建议新开会话。' : '上下文占用较高，长任务可能触发压缩。'}
        </div>
      )}
      {!usage.windowTokens && usage.usedTokens != null && (
        <div className="ctx-tip-foot">正在获取上下文窗口大小…</div>
      )}
    </div>
  )
}

/** Composer chip: ring + percent (or token count) + session size, with a detail tooltip. */
export function ContextChip({ usage, agent, compact = false }: { usage?: ContextUsage; agent: string; compact?: boolean }) {
  if (!usage || (usage.usedTokens == null && usage.sessionBytes == null)) return null
  const label = usage.percentage != null
    ? Math.round(usage.percentage) + '%'
    : usage.usedTokens != null ? formatTokens(usage.usedTokens) : ''
  return (
    <Tip content={<ContextDetail usage={usage} agent={agent} />} side="top">
      <span className={'tool-chip ctx-chip ' + contextLevel(usage.percentage) + (usage.live ? ' live' : '')} tabIndex={0} aria-label={`${agent} 上下文使用情况`}>
        <ContextRing pct={usage.percentage} />
        {label && <span className="ctx-chip-pct">{label}</span>}
        {!compact && usage.sessionBytes != null && <span className="ctx-chip-size">{formatBytes(usage.sessionBytes)}</span>}
      </span>
    </Tip>
  )
}

/** Inline readout for a running message header. */
export function ContextInline({ usage, agent }: { usage?: ContextUsage; agent: string }) {
  if (!usage || (usage.usedTokens == null && usage.sessionBytes == null)) return null
  const parts: string[] = []
  if (usage.usedTokens != null) {
    parts.push('上下文 ' + (usage.percentage != null ? usage.percentage.toFixed(usage.percentage < 10 ? 1 : 0) + '%' : formatTokens(usage.usedTokens)))
  }
  if (usage.sessionBytes != null) parts.push('会话 ' + formatBytes(usage.sessionBytes))
  if (usage.images && usage.images.contextCount > 0) parts.push('图片 ' + usage.images.contextCount)
  return (
    <Tip content={<ContextDetail usage={usage} agent={agent} />} side="bottom">
      <span className={'ctx-inline ' + contextLevel(usage.percentage)} tabIndex={0}>
        <ContextRing pct={usage.percentage} size={12} stroke={2} />
        {parts.join(' · ')}
      </span>
    </Tip>
  )
}
