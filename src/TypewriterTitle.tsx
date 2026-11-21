import { useEffect, useRef, useState } from 'react'

type Phase = 'idle' | 'erase' | 'type' | 'glow'

const ERASE_BUDGET_MS = 360
const TYPE_BUDGET_MS = 1100
const GLOW_MS = 1300

/** Rooms renamed by the app (AI summary or a native client's title), as opposed to by the user. */
export const isAutoTitle = (r: { title_locked?: number; title_auto?: number }) => !r.title_locked && (r.title_auto ?? 0) > 0

const reducedMotion = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/**
 * Shows a title; when it changes while `animate` is set (an automatic rename), the old
 * title is backspaced and the new one typed in character by character, so the user sees
 * the rename happen instead of a silent swap. Mount it with a `key` per room so switching
 * rooms never animates.
 */
export function TypewriterTitle({ text, animate, className }: { text: string; animate: boolean; className?: string }) {
  const [shown, setShown] = useState(text)
  const [phase, setPhase] = useState<Phase>('idle')
  // Index of the first character typed in this run; earlier ones are the kept common prefix.
  const [typedFrom, setTypedFrom] = useState(Number.POSITIVE_INFINITY)
  const prev = useRef(text)
  const shownRef = useRef(text)

  useEffect(() => {
    const from = shownRef.current
    prev.current = text
    if (from === text) return
    const show = (s: string) => { shownRef.current = s; setShown(s) }
    if (!animate || reducedMotion()) {
      show(text)
      setPhase('idle')
      setTypedFrom(Number.POSITIVE_INFINITY)
      return
    }
    const a = Array.from(from)
    const b = Array.from(text)
    let common = 0
    while (common < a.length && common < b.length && a[common] === b[common]) common++

    const timers: number[] = []
    const at = (ms: number, fn: () => void) => { timers.push(window.setTimeout(fn, ms)) }

    // Erase: several characters per tick for long titles so it never drags.
    const eraseCount = a.length - common
    const eraseTicks = Math.min(eraseCount, 12)
    const eraseStep = eraseTicks ? ERASE_BUDGET_MS / eraseTicks : 0
    let t = 0
    setPhase('erase')
    setTypedFrom(Number.POSITIVE_INFINITY)
    for (let i = 1; i <= eraseTicks; i++) {
      const keep = a.length - Math.round((eraseCount * i) / eraseTicks)
      t += eraseStep
      at(t, () => show(a.slice(0, keep).join('')))
    }

    // Type: one character per tick, pace adapted to length.
    const typeCount = b.length - common
    const typeStep = Math.max(38, Math.min(80, TYPE_BUDGET_MS / Math.max(typeCount, 1)))
    t += 120
    at(t, () => { setPhase('type'); setTypedFrom(common) })
    for (let i = common + 1; i <= b.length; i++) {
      t += typeStep
      at(t, () => show(b.slice(0, i).join('')))
    }
    t += 160
    at(t, () => setPhase('glow'))
    at(t + GLOW_MS, () => { setPhase('idle'); setTypedFrom(Number.POSITIVE_INFINITY) })
    return () => {
      timers.forEach(clearTimeout)
      // An interrupted run must still land on the latest title.
      show(prev.current)
      setPhase('idle')
      setTypedFrom(Number.POSITIVE_INFINITY)
    }
  }, [text, animate])

  const busy = phase === 'erase' || phase === 'type'
  const cls = ['tw-title', busy ? 'tw-busy' : '', phase === 'glow' ? 'tw-glow' : '', className || ''].filter(Boolean).join(' ')
  if (!busy) return <span className={cls} title={shown}>{shown}</span>
  const chars = Array.from(shown)
  return (
    <span className={cls} aria-label={text}>
      {chars.slice(0, Math.min(typedFrom, chars.length)).join('')}
      {chars.slice(typedFrom).map((c, i) => <i key={typedFrom + i} className="tw-ch">{c}</i>)}
      <i className="tw-caret" aria-hidden="true" />
    </span>
  )
}
