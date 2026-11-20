import { useEffect, useRef, useState } from 'react'
import {
  appendItem, drainableHeads, prioritizeItem, removeItem, restoreFailed,
  type QueuedMessage, type QueueState, type RunningJob
} from './sendQueue'

export type { QueuedMessage } from './sendQueue'

/**
 * Per-room "send when the agent is free" queue. Heads are dispatched automatically as soon as
 * their target agents stop running; each room dispatches one item at a time.
 *
 * `running` should be the main process's running-job list (a fresh array on every tree refresh,
 * which also re-checks the queue after an in-flight dispatch settles).
 */
export function useSendQueue<A extends string>(
  running: RunningJob[] | undefined,
  dispatch: (item: QueuedMessage<A>) => Promise<true | string>
) {
  const [queuedByRoom, setQueuedByRoom] = useState<QueueState<A>>({})
  // room -> agents being dispatched. A room is released as soon as those agents show up as
  // running (the backend accepted the run), not when the whole run finishes, so the next
  // item for a *different* agent is not stuck behind a long task.
  const draining = useRef(new Map<string, A[]>())
  const dispatchRef = useRef(dispatch)
  dispatchRef.current = dispatch

  useEffect(() => {
    const busy = new Set((running || []).map(j => j.room + '\u0000' + j.agent))
    for (const [room, agents] of draining.current) {
      if (agents.some(a => busy.has(room + '\u0000' + a))) draining.current.delete(room)
    }
    for (const head of drainableHeads(queuedByRoom, running || [], new Set(draining.current.keys()))) {
      draining.current.set(head.room, head.targetList)
      setQueuedByRoom(prev => removeItem(prev, head.room, head.id))
      void Promise.resolve()
        .then(() => dispatchRef.current(head))
        .catch(e => String((e as Error)?.message || e || '发送失败'))
        .then(result => {
          // Never drop a message silently: a failed dispatch goes back to the head with its error.
          if (result !== true) setQueuedByRoom(prev => restoreFailed(prev, head, result))
        })
        .finally(() => {
          if (draining.current.get(head.room) === head.targetList) draining.current.delete(head.room)
        })
    }
  }, [running, queuedByRoom])

  return {
    queuedByRoom,
    enqueue(item: QueuedMessage<A>) {
      setQueuedByRoom(prev => appendItem(prev, item))
    },
    /** Move/insert at the head so it is the next thing sent in its room. */
    prioritize(item: QueuedMessage<A>) {
      setQueuedByRoom(prev => prioritizeItem(prev, item))
    },
    /** Remove an item and return it (e.g. to restore its text into the composer). */
    remove(room: string, id: string): QueuedMessage<A> | undefined {
      const target = queuedByRoom[room]?.find(x => x.id === id)
      setQueuedByRoom(prev => removeItem(prev, room, id))
      return target
    }
  }
}
