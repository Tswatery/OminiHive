// Pure state transitions for the per-room "send later" queue (no React), unit-tested with node --test.
// The queue is FIFO per room; a room's head is dispatched once none of its target agents is running.

export type QueuedMessage<A extends string = string> = {
  id: string
  room: string
  raw: string
  targets: A[] | 'all'
  /** resolved agent names (expands 'all'), used for busy checks and prefs */
  targetList: A[]
  images: { name: string; dataUrl: string }[]
  /** set when auto-dispatch failed; the room's queue pauses until the user retries or withdraws */
  error?: string
}

export type QueueState<A extends string = string> = Record<string, QueuedMessage<A>[]>

export type RunningJob = { room: string; agent: string }

function setRoom<A extends string>(state: QueueState<A>, room: string, list: QueuedMessage<A>[]): QueueState<A> {
  if (list.length) return { ...state, [room]: list }
  if (!(room in state)) return state
  const next = { ...state }
  delete next[room]
  return next
}

/** Append to the end of the item's room queue. */
export function appendItem<A extends string>(state: QueueState<A>, item: QueuedMessage<A>): QueueState<A> {
  return setRoom(state, item.room, [...(state[item.room] || []), item])
}

/** Put the item at the head of its room queue (moving it if already queued). Clears a previous failure. */
export function prioritizeItem<A extends string>(state: QueueState<A>, item: QueuedMessage<A>): QueueState<A> {
  const rest = (state[item.room] || []).filter(x => x.id !== item.id)
  const { error: _error, ...fresh } = item
  return setRoom(state, item.room, [fresh as QueuedMessage<A>, ...rest])
}

/** Put a failed dispatch back at the head of its room, keeping its text, with the error attached. */
export function restoreFailed<A extends string>(state: QueueState<A>, item: QueuedMessage<A>, error: string): QueueState<A> {
  const rest = (state[item.room] || []).filter(x => x.id !== item.id)
  return setRoom(state, item.room, [{ ...item, error: error || '发送失败' }, ...rest])
}

/** Remove one item; drops the room key when its queue becomes empty. */
export function removeItem<A extends string>(state: QueueState<A>, room: string, id: string): QueueState<A> {
  const list = state[room] || []
  if (!list.some(x => x.id === id)) return state
  return setRoom(state, room, list.filter(x => x.id !== id))
}

/**
 * Room heads that can be sent now: none of their target agents is running in that room,
 * and the room is not already mid-dispatch (`skipRooms`), so each room sends one at a time.
 */
export function drainableHeads<A extends string>(state: QueueState<A>, running: RunningJob[], skipRooms: ReadonlySet<string>): QueuedMessage<A>[] {
  const busy = new Set(running.map(j => j.room + '\u0000' + j.agent))
  const heads: QueuedMessage<A>[] = []
  for (const [room, list] of Object.entries(state)) {
    const head = list[0]
    if (!head || head.error || skipRooms.has(room)) continue
    if (head.targetList.some(a => busy.has(room + '\u0000' + a))) continue
    heads.push(head)
  }
  return heads
}
