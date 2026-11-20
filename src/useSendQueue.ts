import { useEffect, useRef, useState } from 'react'
import {
  appendItem, drainableHeads, prioritizeItem, removeItem,
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
export function useSendQueue<A extends string>(running: RunningJob[] | undefined, dispatch: (item: QueuedMessage<A>) => Promise<unknown>) {
  const [queuedByRoom, setQueuedByRoom] = useState<QueueState<A>>({})
  const draining = useRef(new Set<string>())
  const dispatchRef = useRef(dispatch)
  dispatchRef.current = dispatch

  useEffect(() => {
    for (const head of drainableHeads(queuedByRoom, running || [], draining.current)) {
      draining.current.add(head.room)
      setQueuedByRoom(prev => removeItem(prev, head.room, head.id))
      void Promise.resolve()
        .then(() => dispatchRef.current(head))
        .catch(() => {})
        .finally(() => { draining.current.delete(head.room) })
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
