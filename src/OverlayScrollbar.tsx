import { useCallback, useEffect, useRef, useState } from 'react'

type OverlayScrollbarProps = {
  targetRef: React.RefObject<HTMLElement | null>
  /** Optional hover container ref; defaults to targetRef */
  hoverRef?: React.RefObject<HTMLElement | null>
  variant?: 'timeline' | 'input'
  insetTop?: number
  insetBottom?: number
}

export function OverlayScrollbar({
  targetRef,
  hoverRef,
  variant = 'timeline',
  insetTop = 6,
  insetBottom = 6
}: OverlayScrollbarProps) {
  const [thumb, setThumb] = useState({ visible: false, height: 0, top: 0 })
  const [active, setActive] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [dragging, setDragging] = useState(false)
  const hideTimer = useRef<number | null>(null)
  const rafId = useRef<number | null>(null)
  const dragState = useRef<{ startY: number; startScrollTop: number; maxScroll: number; maxThumbTop: number } | null>(null)
  const trackRef = useRef<HTMLDivElement>(null)

  const measure = useCallback(() => {
    const el = targetRef.current
    if (!el) return
    const { scrollHeight, clientHeight, scrollTop } = el
    const maxScroll = scrollHeight - clientHeight
    if (maxScroll <= 1 || clientHeight <= 0) {
      setThumb(prev => (prev.visible ? { visible: false, height: 0, top: 0 } : prev))
      return
    }
    const trackH = Math.max(24, clientHeight - insetTop - insetBottom)
    const minThumb = variant === 'input' ? 24 : 32
    const rawH = Math.round((clientHeight / scrollHeight) * trackH)
    const height = Math.max(minThumb, Math.min(trackH, rawH))
    const maxThumbTop = Math.max(0, trackH - height)
    const ratio = Math.min(1, Math.max(0, scrollTop / maxScroll))
    const top = Math.round(ratio * maxThumbTop)
    setThumb(prev =>
      prev.visible && prev.height === height && prev.top === top
        ? prev
        : { visible: true, height, top }
    )
  }, [targetRef, insetTop, insetBottom, variant])

  const scheduleMeasure = useCallback(() => {
    if (rafId.current !== null) return
    rafId.current = window.requestAnimationFrame(() => {
      rafId.current = null
      measure()
    })
  }, [measure])

  const flashActive = useCallback(() => {
    setActive(true)
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => {
      setActive(false)
      hideTimer.current = null
    }, 900)
  }, [])

  useEffect(() => {
    const el = targetRef.current
    if (!el) return
    scheduleMeasure()

    const onScroll = () => {
      scheduleMeasure()
      flashActive()
    }
    const onInput = () => {
      scheduleMeasure()
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    if (variant === 'input') {
      el.addEventListener('input', onInput, { passive: true })
    }

    const ro = new ResizeObserver(() => scheduleMeasure())
    ro.observe(el)
    let observedChild = el.firstElementChild
    if (observedChild) ro.observe(observedChild)

    // Only watch direct child swaps (e.g. welcome -> transcript) so we re-attach ResizeObserver,
    // never subtree/characterData mutations which cause forced synchronous layout during streaming/typing.
    const mo = new MutationObserver(() => {
      const nextChild = el.firstElementChild
      if (nextChild !== observedChild) {
        if (observedChild) ro.unobserve(observedChild)
        observedChild = nextChild
        if (observedChild) ro.observe(observedChild)
        scheduleMeasure()
      }
    })
    mo.observe(el, { childList: true })

    window.addEventListener('resize', scheduleMeasure, { passive: true })

    return () => {
      el.removeEventListener('scroll', onScroll)
      if (variant === 'input') {
        el.removeEventListener('input', onInput)
      }
      ro.disconnect()
      mo.disconnect()
      window.removeEventListener('resize', scheduleMeasure)
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current)
      if (rafId.current !== null) window.cancelAnimationFrame(rafId.current)
    }
  }, [targetRef, scheduleMeasure, flashActive, variant])

  useEffect(() => {
    const host = hoverRef?.current || targetRef.current
    if (!host) return
    const onEnter = () => {
      scheduleMeasure()
      setHovered(true)
    }
    const onLeave = () => setHovered(false)
    host.addEventListener('mouseenter', onEnter)
    host.addEventListener('mouseleave', onLeave)
    return () => {
      host.removeEventListener('mouseenter', onEnter)
      host.removeEventListener('mouseleave', onLeave)
    }
  }, [hoverRef, targetRef, scheduleMeasure])

  function onThumbPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault()
    e.stopPropagation()
    const el = targetRef.current
    if (!el) return
    const trackH = Math.max(24, el.clientHeight - insetTop - insetBottom)
    const maxScroll = Math.max(1, el.scrollHeight - el.clientHeight)
    const maxThumbTop = Math.max(1, trackH - thumb.height)
    dragState.current = {
      startY: e.clientY,
      startScrollTop: el.scrollTop,
      maxScroll,
      maxThumbTop
    }
    setDragging(true)
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  function onThumbPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragState.current
    const el = targetRef.current
    if (!drag || !el) return
    const deltaY = e.clientY - drag.startY
    const nextScroll = drag.startScrollTop + (deltaY / drag.maxThumbTop) * drag.maxScroll
    el.scrollTop = Math.max(0, Math.min(drag.maxScroll, nextScroll))
  }

  function onThumbPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragState.current) return
    dragState.current = null
    setDragging(false)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  function onTrackClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target !== trackRef.current) return
    const el = targetRef.current
    const track = trackRef.current
    if (!el || !track) return
    const rect = track.getBoundingClientRect()
    const clickY = e.clientY - rect.top
    const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight)
    const maxThumbTop = Math.max(1, rect.height - thumb.height)
    const targetTop = Math.max(0, Math.min(maxThumbTop, clickY - thumb.height / 2))
    el.scrollTo({ top: (targetTop / maxThumbTop) * maxScroll, behavior: 'smooth' })
  }

  if (!thumb.visible) return null

  const show = hovered || active || dragging

  return (
    <div
      ref={trackRef}
      className={
        'overlay-scrollbar overlay-scrollbar-' +
        variant +
        (show ? ' show' : '') +
        (dragging ? ' dragging' : '')
      }
      style={{ top: insetTop, bottom: insetBottom }}
      onClick={onTrackClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-hidden="true"
    >
      <div
        className="overlay-scrollbar-thumb"
        style={{ height: thumb.height, transform: `translateY(${thumb.top}px)` }}
        onPointerDown={onThumbPointerDown}
        onPointerMove={onThumbPointerMove}
        onPointerUp={onThumbPointerUp}
        onPointerCancel={onThumbPointerUp}
      />
    </div>
  )
}

export type ScrollAreaProps = {
  children: React.ReactNode
  className?: string
  viewportClassName?: string
  style?: React.CSSProperties
  viewportStyle?: React.CSSProperties
  viewportRef?: React.RefObject<HTMLDivElement | null>
  onScroll?: React.UIEventHandler<HTMLDivElement>
  variant?: 'timeline' | 'input'
  insetTop?: number
  insetBottom?: number
}

export function ScrollArea({
  children,
  className = '',
  viewportClassName = '',
  style,
  viewportStyle,
  viewportRef,
  onScroll,
  variant = 'timeline',
  insetTop = 6,
  insetBottom = 6
}: ScrollAreaProps) {
  const shellRef = useRef<HTMLDivElement>(null)
  const fallbackRef = useRef<HTMLDivElement>(null)
  const activeRef = viewportRef || fallbackRef

  return (
    <div ref={shellRef} className={'scroll-area' + (className ? ' ' + className : '')} style={style}>
      <div
        ref={activeRef}
        className={'scroll-area-viewport' + (viewportClassName ? ' ' + viewportClassName : '')}
        style={viewportStyle}
        onScroll={onScroll}
      >
        {children}
      </div>
      <OverlayScrollbar
        targetRef={activeRef}
        hoverRef={shellRef}
        variant={variant}
        insetTop={insetTop}
        insetBottom={insetBottom}
      />
    </div>
  )
}
