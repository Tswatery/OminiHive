import { useId } from 'react'
import { Terminal } from 'lucide-react'
import { VENDOR_ICON_SRC } from './iconRegistry'

const agentAssetSrc: Record<string, string> = {
  Codex: './agents/codex.svg',
  Claude: './agents/claudecode.svg',
  Antigravity: './agents/antigravity.svg',
  Gemini: VENDOR_ICON_SRC.gemini,
  Qwen: VENDOR_ICON_SRC.qwen,
  Kimi: VENDOR_ICON_SRC.kimi,
  DeepSeek: VENDOR_ICON_SRC.deepseek,
  MiniMax: VENDOR_ICON_SRC.minimax,
  Grok: VENDOR_ICON_SRC.grok,
  OpenClaw: VENDOR_ICON_SRC.openclaw,
  OpenCode: VENDOR_ICON_SRC.opencode,
  WorkBuddy: VENDOR_ICON_SRC.workbuddy
}

export function AgentIcon({ name, size = 18 }: { name: string; size?: number }) {
  const uid = useId().replace(/:/g, '')

  const src = agentAssetSrc[name]
  if (src) {
    return (
      <img
        className="agent-icon"
        src={src}
        width={size}
        height={size}
        alt=""
        style={{
          width: size,
          height: size,
          objectFit: 'contain',
          borderRadius: name === 'WorkBuddy' ? Math.max(3, Math.round(size * 0.22)) : undefined
        }}
      />
    )
  }

  // Hermes: 黑白复古赫尔墨斯侧颜剪影
  if (name === 'Hermes') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className="agent-icon" aria-hidden="true">
        <path
          d="M12.2 3.2C8.4 3.2 5.8 5.9 5.6 9.8C5.4 12.2 6.4 14.1 6.4 15.9C6.4 17.8 5.2 19.1 4.4 19.8C6.6 20.6 9.3 20.4 10.5 19.2V21H15.5V17.4C17.4 16.7 18.6 15 18.6 12.6C18.6 11.3 18.1 10.2 17.3 9.4C18.5 8.8 19.4 7.7 19.6 6.2C18.2 6.5 17 6.3 16 5.6C15.1 4.1 13.8 3.2 12.2 3.2Z"
          fill="#18181B"
        />
        <path
          d="M11.6 7.2C13.8 7.2 15.4 8.6 15.6 10.8C15.7 11.7 16.4 12.2 16.3 12.8C16.2 13.3 15.5 13.5 15.3 14.1C15 15.1 14.3 15.9 13.1 16.2C11.9 16.4 10.9 15.8 10.5 14.8C10.1 13.8 10.3 12.4 9.7 11.5C9.2 10.8 9.6 7.2 11.6 7.2Z"
          fill="#FFFFFF"
        />
        <circle cx="13.8" cy="10.9" r="0.75" fill="#18181B" />
        <path d="M12.7 13.9C13.3 14.2 14 14.1 14.5 13.8" stroke="#18181B" strokeWidth="0.9" strokeLinecap="round" />
      </svg>
    )
  }

  // Pi: 彩色像素块拼成的 Pi
  if (name === 'Pi') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className="agent-icon" aria-hidden="true">
        <rect x="4" y="6" width="3.5" height="3.5" rx="0.5" fill="#E11D48" />
        <rect x="7.5" y="6" width="3.5" height="3.5" rx="0.5" fill="#F97316" />
        <rect x="11" y="6" width="3.5" height="3.5" rx="0.5" fill="#FACC15" />
        <rect x="4" y="9.5" width="3.5" height="3.5" rx="0.5" fill="#3B82F6" />
        <rect x="11" y="9.5" width="3.5" height="3.5" rx="0.5" fill="#F59E0B" />
        <rect x="4" y="13" width="3.5" height="3.5" rx="0.5" fill="#2563EB" />
        <rect x="7.5" y="13" width="3.5" height="3.5" rx="0.5" fill="#60A5FA" />
        <rect x="4" y="16.5" width="3.5" height="3.5" rx="0.5" fill="#1D4ED8" />
        <rect x="16.5" y="9.5" width="3.2" height="3.2" rx="0.5" fill="#10B981" />
        <rect x="16.5" y="13.5" width="3.2" height="3.2" rx="0.5" fill="#0EA5E9" />
        <rect x="16.5" y="16.8" width="3.2" height="3.2" rx="0.5" fill="#6366F1" />
      </svg>
    )
  }

  // Oh My Pi: 黑底圆角方形 + 紫粉渐变 π
  if (name === 'OhMyPi') {
    const grad = 'omp-' + uid
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className="agent-icon" aria-hidden="true">
        <defs>
          <linearGradient id={grad} x1="5" y1="6" x2="19" y2="18" gradientUnits="userSpaceOnUse">
            <stop stopColor="#A855F7" />
            <stop offset="0.55" stopColor="#818CF8" />
            <stop offset="1" stopColor="#EC4899" />
          </linearGradient>
        </defs>
        <rect x="2.5" y="2.5" width="19" height="19" rx="5" fill="#09090B" />
        <path
          d="M6.8 8.4H17.2M9.8 8.4V16.6M14.4 8.4V15.3C14.4 16.2 15 16.7 15.9 16.7"
          stroke={`url(#${grad})`}
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }

  return <Terminal size={Math.max(12, size - 2)} className="agent-icon" />
}
