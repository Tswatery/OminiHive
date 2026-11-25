import React from 'react'
import { Tooltip } from '@radix-ui/themes'

export type TipProps = {
  content: React.ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
  delayDuration?: number
  /** Wrap trigger in a span so disabled buttons still receive hover events. */
  allowDisabled?: boolean
  children: React.ReactElement
}

export function Tip({
  content,
  side = 'top',
  delayDuration = 160,
  allowDisabled = false,
  children
}: TipProps) {
  if (!content) return children
  const trigger = allowDisabled ? <span className="tip-trigger">{children}</span> : children
  return (
    <Tooltip
      content={content}
      side={side}
      sideOffset={6}
      delayDuration={delayDuration}
      className="hive-tooltip"
    >
      {trigger}
    </Tooltip>
  )
}
