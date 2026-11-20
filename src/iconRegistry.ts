export type VendorIconKey =
  | 'openai'
  | 'claude'
  | 'gemini'
  | 'deepseek'
  | 'kimi'
  | 'doubao'
  | 'zhipu'
  | 'qwen'
  | 'minimax'
  | 'grok'
  | 'hunyuan'
  | 'meta'
  | 'mistral'
  | 'stepfun'
  | 'yi'
  | 'baichuan'
  | 'cohere'
  | 'perplexity'
  | 'openclaw'
  | 'opencode'
  | 'workbuddy'
  | 'xiaomi'

export const VENDOR_ICON_SRC: Record<VendorIconKey, string> = {
  openai: './icons/openai.svg',
  claude: './icons/claude-color.svg',
  gemini: './icons/gemini-color.svg',
  deepseek: './icons/deepseek-color.svg',
  kimi: './icons/kimi-color.svg',
  doubao: './icons/doubao-color.svg',
  zhipu: './icons/zai.svg',
  qwen: './icons/qwen-color.svg',
  minimax: './icons/minimax-color.svg',
  grok: './icons/grok.svg',
  hunyuan: './icons/hunyuan-color.svg',
  meta: './icons/meta-color.svg',
  mistral: './icons/mistral-color.svg',
  stepfun: './icons/stepfun-color.svg',
  yi: './icons/yi-color.svg',
  baichuan: './icons/baichuan-color.svg',
  cohere: './icons/cohere-color.svg',
  perplexity: './icons/perplexity-color.svg',
  openclaw: './icons/openclaw-color.svg',
  opencode: './icons/opencode.svg',
  workbuddy: './icons/workbuddy.png',
  xiaomi: './icons/xiaomi-color.svg'
}

/**
 * 统一模型 -> 厂商图标注册表
 * 按前缀/关键词匹配，同一厂商旗下所有模型自动复用官方正版 SVG
 */
const MODEL_VENDOR_RULES: Array<{ vendor: VendorIconKey; pattern: RegExp }> = [
  { vendor: 'openai', pattern: /(?:^|[^a-z0-9])(gpt|o1|o3|o4|codex|openai|chatgpt)(?:[^a-z0-9]|$)|^gpt[-_.]|^o[134][-_]/i },
  { vendor: 'claude', pattern: /(?:claude|anthropic|sonnet|opus|haiku|fable)/i },
  { vendor: 'gemini', pattern: /(?:gemini|gemma|google|orchestrator|neon|argon|hydrogen)/i },
  { vendor: 'deepseek', pattern: /(?:deepseek|dsh)/i },
  { vendor: 'kimi', pattern: /(?:kimi|moonshot)/i },
  { vendor: 'zhipu', pattern: /(?:glm|chatglm|zhipu|codegeex|z\.ai)/i },
  { vendor: 'doubao', pattern: /(?:doubao|seed[-_.]?\d|bytedance|volc|ep-\d)/i },
  { vendor: 'qwen', pattern: /(?:qwen|qwq|tongyi)/i },
  { vendor: 'minimax', pattern: /(?:minimax|abab)/i },
  { vendor: 'grok', pattern: /(?:grok|xai)/i },
  { vendor: 'hunyuan', pattern: /(?:hunyuan|tencent|(?:^|[^a-z])hy\d)/i },
  { vendor: 'workbuddy', pattern: /(?:workbuddy|codebuddy|space[-_.]?bunny|fast-model|balanced-model|deep-model)/i },
  { vendor: 'meta', pattern: /(?:llama|meta[-_/])/i },
  { vendor: 'mistral', pattern: /(?:mistral|mixtral|codestral|devstral|pixtral)/i },
  { vendor: 'stepfun', pattern: /(?:step[-_.]?\d|stepfun)/i },
  { vendor: 'yi', pattern: /(?:^|[^a-z])yi[-_.]?(?:\d|lightning|large|medium|vision|coder)/i },
  { vendor: 'baichuan', pattern: /baichuan/i },
  { vendor: 'cohere', pattern: /(?:cohere|command[-_.]?(?:r|a))/i },
  { vendor: 'perplexity', pattern: /(?:perplexity|sonar)/i },
  { vendor: 'xiaomi', pattern: /(?:xiaomi|mimo)/i }
]

export function resolveModelVendor(model?: string, label?: string): VendorIconKey | null {
  const bareModel = model?.includes('/') ? model.split('/').slice(1).join('/') : (model || '')
  const primary = `${bareModel} ${label || ''}`.trim()
  if (primary) {
    for (const rule of MODEL_VENDOR_RULES) {
      if (rule.pattern.test(primary)) return rule.vendor
    }
  }
  const fallback = (model || '').trim()
  if (fallback && fallback !== bareModel) {
    for (const rule of MODEL_VENDOR_RULES) {
      if (rule.pattern.test(fallback)) return rule.vendor
    }
  }
  return null
}

export function resolveModelIconSrc(model?: string, label?: string): string | null {
  const vendor = resolveModelVendor(model, label)
  return vendor ? VENDOR_ICON_SRC[vendor] : null
}
