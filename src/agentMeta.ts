export type Agent =
  | 'Codex'
  | 'Claude'
  | 'Antigravity'
  | 'Gemini'
  | 'OpenCode'
  | 'Kimi'
  | 'Qwen'
  | 'OpenClaw'
  | 'Grok'
  | 'Hermes'
  | 'Pi'
  | 'MiniMax'
  | 'DeepSeek'
  | 'OhMyPi'
  | 'WorkBuddy'

export const ALL_AGENTS: Agent[] = [
  'Codex',
  'Claude',
  'Antigravity',
  'WorkBuddy',
  'Gemini',
  'OpenCode',
  'Kimi',
  'Qwen',
  'OpenClaw',
  'Grok',
  'Hermes',
  'Pi',
  'MiniMax',
  'DeepSeek',
  'OhMyPi'
]

export const CORE_AGENTS: Agent[] = ['Codex', 'Claude', 'Antigravity']

export const AGENT_LABEL: Record<Agent, string> = {
  Codex: 'Codex',
  Claude: 'Claude Code',
  Antigravity: 'Antigravity',
  WorkBuddy: 'WorkBuddy',
  Gemini: 'Gemini',
  OpenCode: 'OpenCode',
  Kimi: 'Kimi Code',
  Qwen: 'Qwen',
  OpenClaw: 'OpenClaw',
  Grok: 'Grok',
  Hermes: 'Hermes',
  Pi: 'Pi',
  MiniMax: 'MiniMax Code',
  DeepSeek: 'DeepSeek Harness',
  OhMyPi: 'Oh My Pi'
}

export const AGENT_SHORT: Record<Agent, string> = {
  Codex: 'Codex',
  Claude: 'Claude',
  Antigravity: 'Antigravity',
  WorkBuddy: 'WorkBuddy',
  Gemini: 'Gemini',
  OpenCode: 'OpenCode',
  Kimi: 'Kimi',
  Qwen: 'Qwen',
  OpenClaw: 'OpenClaw',
  Grok: 'Grok',
  Hermes: 'Hermes',
  Pi: 'Pi',
  MiniMax: 'MiniMax',
  DeepSeek: 'DeepSeek',
  OhMyPi: 'Oh My Pi'
}

export const AGENT_CLASS: Record<Agent, string> = {
  Codex: 'codex',
  Claude: 'claude',
  Antigravity: 'antigravity',
  WorkBuddy: 'antigravity',
  Gemini: 'antigravity',
  OpenCode: 'codex',
  Kimi: 'antigravity',
  Qwen: 'codex',
  OpenClaw: 'claude',
  Grok: 'codex',
  Hermes: 'codex',
  Pi: 'antigravity',
  MiniMax: 'claude',
  DeepSeek: 'antigravity',
  OhMyPi: 'codex'
}

export const AGENT_KEYWORDS: Record<Agent, string> = {
  Codex: 'codex openai gpt',
  Claude: 'claude anthropic cc',
  Antigravity: 'antigravity agy google',
  WorkBuddy: 'workbuddy codebuddy tencent wb cb',
  Gemini: 'gemini google',
  OpenCode: 'opencode',
  Kimi: 'kimi moonshot',
  Qwen: 'qwen alibaba tongyi',
  OpenClaw: 'openclaw claw lobster',
  Grok: 'grok xai',
  Hermes: 'hermes nous',
  Pi: 'pi coding',
  MiniMax: 'minimax code',
  DeepSeek: 'deepseek harness dsh',
  OhMyPi: 'ohmypi oh my pi omp'
}

export function agentLabel(name: string): string {
  return (AGENT_LABEL as Record<string, string>)[name] || name
}

export function agentShort(name: string): string {
  return (AGENT_SHORT as Record<string, string>)[name] || name
}

export function agentMatchesQuery(agent: Agent, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (
    agent.toLowerCase().includes(q) ||
    AGENT_LABEL[agent].toLowerCase().includes(q) ||
    AGENT_KEYWORDS[agent].includes(q)
  )
}
