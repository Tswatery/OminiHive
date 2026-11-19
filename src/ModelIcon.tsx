import { useId } from 'react'
import { Cpu } from 'lucide-react'

export type ModelVendor =
  | 'deepseek'
  | 'google'
  | 'anthropic'
  | 'openai'
  | 'qwen'
  | 'glm'
  | 'llama'
  | 'unknown'

export function detectModelVendor(model?: string, label?: string): ModelVendor {
  const text = `${model || ''} ${label || ''}`.toLowerCase()
  if (!text.trim()) return 'unknown'

  if (/deepseek/.test(text)) return 'deepseek'
  if (/(gemini|gemma|google)/.test(text)) return 'google'
  if (/(claude|opus|sonnet|haiku|fable|anthropic)/.test(text)) return 'anthropic'
  if (
    /(gpt|codex|openai|chatgpt)/.test(text) ||
    /(^|[^a-z0-9])(o[134]|astra|sol|terra)($|[^a-z0-9])/.test(text)
  ) {
    return 'openai'
  }
  if (/(qwen|qwq|tongyi)/.test(text)) return 'qwen'
  if (/(^|[^a-z])glm($|[^a-z0-9])|chatglm|zhipu/.test(text)) return 'glm'
  if (/llama/.test(text)) return 'llama'

  return 'unknown'
}

export function ModelIcon({
  model,
  label,
  size = 14,
  className = '',
}: {
  model?: string
  label?: string
  size?: number
  className?: string
}) {
  const uid = useId()
  const vendor = detectModelVendor(model, label)
  const cls = className ? `model-icon ${className}` : 'model-icon'

  switch (vendor) {
    case 'deepseek':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          className={cls}
          aria-hidden="true"
        >
          <path
            d="M19.8 11.4c-.3-3.6-3.4-6.4-7.2-6.4-2.5 0-4.7 1.2-6 3.1-.5-.2-1.1-.3-1.7-.2-1.8.3-3 2-2.7 3.8.2 1.2.9 2.2 2 2.7-.2.7-.3 1.5-.1 2.2.5 2.1 2.5 3.4 4.7 3.4h7.5c2.5 0 4.5-2 4.5-4.5 0-2-1.3-3.7-3-4.1Z"
            fill="#4D6BFE"
          />
          <circle cx="15.2" cy="11.2" r="1.25" fill="#fff" />
          <path
            d="M8.5 14.5c1.5 1.1 3.7 1.2 5.4.1"
            stroke="#fff"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      )

    case 'google': {
      const gradId = `gemini-grad-${uid}`
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          className={cls}
          aria-hidden="true"
        >
          <defs>
            <linearGradient id={gradId} x1="3" y1="3" x2="21" y2="21" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#4285F4" />
              <stop offset="50%" stopColor="#9B72CB" />
              <stop offset="100%" stopColor="#D96570" />
            </linearGradient>
          </defs>
          <path
            d="M12 2c.6 5.2 4.8 9.4 10 10-5.2.6-9.4 4.8-10 10-.6-5.2-4.8-9.4-10-10 5.2-.6 9.4-4.8 10-10Z"
            fill={`url(#${gradId})`}
          />
        </svg>
      )
    }

    case 'anthropic':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          className={cls}
          aria-hidden="true"
        >
          <g stroke="#D97757" strokeWidth="2.1" strokeLinecap="round">
            <line x1="12" y1="3" x2="12" y2="21" />
            <line x1="4.2" y1="7.5" x2="19.8" y2="16.5" />
            <line x1="19.8" y1="7.5" x2="4.2" y2="16.5" />
          </g>
          <circle cx="12" cy="12" r="2.2" fill="#D97757" />
        </svg>
      )

    case 'openai':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          className={cls}
          aria-hidden="true"
        >
          <path
            d="M20.3 10.2a4.6 4.6 0 0 0-.4-3.8 4.7 4.7 0 0 0-5-2.3 4.7 4.7 0 0 0-3.5-1.6 4.7 4.7 0 0 0-4.5 3.2 4.7 4.7 0 0 0-3.1 2.3 4.7 4.7 0 0 0 .6 5.5 4.6 4.6 0 0 0 .4 3.8 4.7 4.7 0 0 0 5 2.3 4.7 4.7 0 0 0 3.5 1.6 4.7 4.7 0 0 0 4.5-3.2 4.7 4.7 0 0 0 3.1-2.3 4.7 4.7 0 0 0-.6-5.5Z"
            stroke="#10A37F"
            strokeWidth="1.75"
            strokeLinejoin="round"
          />
          <circle cx="12" cy="12" r="2.5" stroke="#10A37F" strokeWidth="1.75" />
        </svg>
      )

    case 'qwen': {
      const gradId = `qwen-grad-${uid}`
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          className={cls}
          aria-hidden="true"
        >
          <defs>
            <linearGradient id={gradId} x1="4" y1="4" x2="20" y2="20" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#6366F1" />
              <stop offset="100%" stopColor="#8B5CF6" />
            </linearGradient>
          </defs>
          <path
            d="M12 3.2 19.6 7.6v8.8L12 20.8l-7.6-4.4V7.6L12 3.2Z"
            stroke={`url(#${gradId})`}
            strokeWidth="2"
            strokeLinejoin="round"
          />
          <path
            d="M12 7.5a4.5 4.5 0 1 0 3.2 7.7l2.1 2.1"
            stroke={`url(#${gradId})`}
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      )
    }

    case 'glm':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          className={cls}
          aria-hidden="true"
        >
          <rect x="3.5" y="3.5" width="17" height="17" rx="4.5" fill="#2563EB" />
          <path
            d="M8.2 8.5h7.6l-7.6 7h7.6"
            stroke="#fff"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )

    case 'llama':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          className={cls}
          aria-hidden="true"
        >
          <path
            d="M7.2 7.5c-2.5 0-4.2 2.4-4.2 5.1 0 2.5 1.4 3.9 3.1 3.9 1.6 0 2.9-1.4 4.5-4.2l1.4-2.4c1.6-2.8 2.9-4.2 4.8-4.2 2.5 0 4.2 2.4 4.2 5.3 0 2.8-1.5 5.5-4.1 5.5-1.7 0-3-1.1-4.2-3.1"
            stroke="#0668E1"
            strokeWidth="2.1"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )

    default:
      return <Cpu size={size} className={cls} aria-hidden="true" />
  }
}
