import React from 'react'
import { Clock, X, Zap } from 'lucide-react'
import type { QueuedMessage } from './sendQueue'

/** Pending messages of the current room, shown above the composer. */
export function SendQueueBar<A extends string>({
  items,
  onSendNow,
  onWithdraw
}: {
  items: QueuedMessage<A>[]
  /** interrupt the running agent(s) and send this item next */
  onSendNow: (item: QueuedMessage<A>) => void
  /** drop from the queue and restore its text to the composer */
  onWithdraw: (item: QueuedMessage<A>) => void
}) {
  if (!items.length) return null
  return (
    <div className="queue-bar">
      <div className="queue-bar-head">
        <Clock size={12} />
        <span>待发队列 · {items.length} 条（当前任务完成后自动发送）</span>
      </div>
      <div className="queue-bar-list">
        {items.map(q => (
          <div key={q.id} className="queue-item">
            <span className="queue-item-target">{q.targets === 'all' ? '@all' : q.targetList.join('、')}</span>
            <span className="queue-item-text" title={q.error ? q.error : q.raw}>
              {q.error && <span className="queue-item-error">发送失败</span>}
              {q.raw}
            </span>
            <div className="queue-item-actions">
              <button
                type="button"
                className="queue-item-now"
                title={q.error ? '重新发送：' + q.error : '立即打断当前运行并发送此消息'}
                onClick={() => onSendNow(q)}
              >
                <Zap size={11} />
                <span>{q.error ? '重试' : '打断发'}</span>
              </button>
              <button
                type="button"
                className="queue-item-del"
                title="撤回排队（恢复到输入框）"
                aria-label="撤回排队"
                onClick={() => onWithdraw(q)}
              >
                <X size={12} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
