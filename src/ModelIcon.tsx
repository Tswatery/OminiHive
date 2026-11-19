import { Cpu } from 'lucide-react'
import { resolveModelIconSrc } from './iconRegistry'

export function ModelIcon({
  model = '',
  label = '',
  size = 14
}: {
  model?: string
  label?: string
  size?: number
}) {
  const src = resolveModelIconSrc(model, label)
  if (src) {
    return (
      <img
        src={src}
        width={size}
        height={size}
        alt=""
        aria-hidden="true"
        className="model-icon"
        style={{ width: size, height: size, objectFit: 'contain', flexShrink: 0, display: 'block' }}
      />
    )
  }
  return <Cpu size={size} className="model-icon generic" aria-hidden="true" />
}
