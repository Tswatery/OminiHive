import React, { useState, useEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Folder, FolderPlus, FolderOpen, MessageSquare, Plus, ArrowUp, Square,
  Shield, ShieldAlert, Hexagon, Terminal, PanelLeft, Compass, Copy, Check,
  RotateCcw, Sparkles, ChevronRight, X, Forward, Users, ImagePlus, FolderTree
} from 'lucide-react'
import { Theme, Button } from '@radix-ui/themes'
import '@radix-ui/themes/styles.css'
import { DeleteButton } from './Controls'
import { ModelEffortPicker, Settings, type ModelOption, type ClientInfo, type CCSwitchSummary } from './Preferences'
import { ModelIcon } from './ModelIcon'
import { MarkdownView } from './MarkdownView'
import type { QuotaResult } from './VolcQuota'
import { FileDrawer, type FileEntry, type PreviewResult } from './FileDrawer'
import './tokens.css'
import './style.css'

type Agent = 'Codex' | 'Claude' | 'Antigravity' | 'Gemini' | 'OpenCode' | 'Kimi' | 'Qwen' | 'OpenClaw' | 'Grok'
type Project = { id: string; name: string; dir: string }
type Room = { id: string; project: string; title: string }
type Msg = { id: string; author: string; body: string; log: string; status: string; time: number; duration?: number; attachments?: string }
type ImageDraft = { id: string; name: string; dataUrl: string }
type RunningJob = { room: string; agent: Agent }
type Tree = { projects: Project[]; rooms: Room[]; agents: Record<Agent, boolean>; running?: RunningJob[] }
type SkillEntry = { id: string; name: string; description: string; source: string; path: string }
type AgentPrefs = Partial<Record<Agent, { model: string; effort: string; write?: boolean; provider?: string }>>

declare global {
  interface Window {
    hive: {
      tree(): Promise<Tree>
      messages(id: string): Promise<Msg[]>
      add(): Promise<string | null>
      room(id: string): Promise<string>
      renameRoom(id: string, title: string): Promise<void>
      volcQuota(): Promise<QuotaResult>
      volcLogin(): Promise<QuotaResult>
      clients(): Promise<ClientInfo[]>
      ccSwitch(): Promise<CCSwitchSummary>
      files(roomId: string, relDir?: string): Promise<FileEntry[]>
      previewFile(roomId: string, filePath: string): Promise<PreviewResult>
      agentSkills(roomId?: string): Promise<Record<Agent, SkillEntry[]>>
      updates(): Promise<ClientInfo[]>
      upgrade(agent: string): Promise<void>
      onUpgrade(fn: (row: ClientInfo) => void): () => void
      cachedModels(agent: Agent): Promise<{ list: ModelOption[]; reference: boolean }>
      models(agent: Agent): Promise<ModelOption[]>
      remove(kind: string, id: string): Promise<Pick<Tree, 'rooms' | 'projects'>>
      send(id: string, text: string, write: boolean, modelOrPrefs: string | AgentPrefs, effort: string, targetAgents?: Agent | Agent[] | 'all', images?: { name: string; dataUrl: string }[]): Promise<void>
      stop(id: string, agent?: Agent): Promise<void>
      openExternal(url: string): Promise<void>
      openPath(filePath: string, roomId?: string): Promise<boolean>
      listen(fn: () => void): () => void
    }
  }
}

const api = window.hive
const allAgents: Agent[] = ['Codex', 'Claude', 'Antigravity', 'Gemini', 'OpenCode', 'Kimi', 'Qwen', 'OpenClaw', 'Grok']
const coreAgents: Agent[] = ['Codex', 'Claude', 'Antigravity']
const iconFiles: Partial<Record<Agent, string>> = { Codex: 'codex', Claude: 'claudecode', Antigravity: 'antigravity' }
const agentClass: Record<Agent, string> = {
  Codex: 'codex', Claude: 'claude', Antigravity: 'antigravity',
  Gemini: 'antigravity', OpenCode: 'codex', Kimi: 'antigravity', Qwen: 'codex', OpenClaw: 'claude', Grok: 'codex'
}

const STARTER_PROMPTS = [
  { title: '梳理项目结构', desc: '快速理解目录职责与核心模块', text: '帮我梳理这个项目的目录结构、核心入口和主要模块职责。' },
  { title: '排查潜在问题', desc: '检查边界条件与异常处理漏洞', text: '检查核心代码中的异常处理和边界条件，列出最值得改进的 3 个问题。' },
  { title: '生成或完善测试', desc: '为关键路径补充单元测试', text: '看一下当前的测试覆盖情况，为最关键的逻辑设计或补充单元测试。' },
  { title: '多 Agent 联合评审', desc: '让 Codex 与 Claude 同时给建议', text: '@Codex @Claude 从架构与代码细节两个角度，评估这个项目当前最需要重构的地方。' }
]

function cleanError(e: unknown) {
  return String(e || '未知错误')
    .replace(/^Error:\s*Error invoking remote method '[^']+':\s*(Error:\s*)?/i, '')
    .replace(/^Error:\s*/i, '')
}

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch { return fallback }
}

function parseMentionedAgents(text: string): { agents: Agent[]; isAll: boolean } {
  const found: Agent[] = []
  let isAll = false
  for (const m of text.matchAll(/(?:^|\s)@(Codex|Claude|Antigravity|Gemini|OpenCode|Kimi|Qwen|OpenClaw|Grok|all)(?=\s|$|[，。,.!?！？])/gi)) {
    if (m[1].toLowerCase() === 'all') {
      isAll = true
      for (const a of allAgents) if (!found.includes(a)) found.push(a)
    } else {
      const norm = allAgents.find(a => a.toLowerCase() === m[1].toLowerCase())
      if (norm && !found.includes(norm)) found.push(norm)
    }
  }
  return { agents: found, isAll }
}

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const file = iconFiles[name as Agent]
  if (file) return <img className="agent-icon" src={'./agents/' + file + '.svg'} width={size} height={size} alt="" />
  if (name === 'Gemini') return <ModelIcon model="gemini" size={size} />
  if (name === 'Qwen') return <ModelIcon model="qwen" size={size} />
  if (name === 'Kimi') return <span className="agent-badge kimi" style={{ width: size, height: size, fontSize: Math.round(size * 0.6) }}>K</span>
  if (name === 'Grok') return <span className="agent-badge grok" style={{ width: size, height: size, fontSize: Math.round(size * 0.6) }}>G</span>
  if (name === 'OpenClaw') return <span className="agent-badge claw" style={{ width: size, height: size, fontSize: Math.round(size * 0.6) }}>C</span>
  if (name === 'OpenCode') return <Terminal size={size - 2} />
  return null
}

function UserBubble({ body, attachments }: { body: string; attachments?: string }) {
  const parts = body.split(/(@(?:Codex|Claude|Antigravity|Gemini|OpenCode|Kimi|Qwen|OpenClaw|Grok|all)\b)/gi)
  let imgs: { path: string; name: string; dataUrl: string }[] = []
  try { if (attachments) imgs = JSON.parse(attachments) } catch {}
  return (
    <div className="msg-user-row">
      <div className="mine">
        {imgs.length > 0 && (
          <div className="bubble-imgs">
            {imgs.map((img, i) => (
              <img
                key={i}
                src={img.dataUrl}
                alt={img.name}
                title={img.name + ' · 点击打开'}
                onClick={() => void api.openPath(img.path)}
              />
            ))}
          </div>
        )}
        {parts.map((part, i) => {
          if (part.toLowerCase() === '@all') {
            return (
              <span key={i} className="mention-chip all">
                <Users size={12} />
                @all
              </span>
            )
          }
          const matched = allAgents.find(a => part.toLowerCase() === '@' + a.toLowerCase())
          if (matched) {
            return (
              <span key={i} className={'mention-chip ' + agentClass[matched]}>
                <Icon name={matched} size={13} />
                @{matched}
              </span>
            )
          }
          return <React.Fragment key={i}>{part}</React.Fragment>
        })}
      </div>
    </div>
  )
}

type StepBlock = {
  id: string
  kind: 'tool' | 'cmd' | 'thought' | 'file' | 'info'
  title: string
  status: 'running' | 'done' | 'error'
  detail?: string
}

function formatDuration(ms: number): string {
  if (!ms || ms < 0) return '0s'
  const s = ms / 1000
  if (s < 60) return s.toFixed(1) + 's'
  const m = Math.floor(s / 60)
  const rem = Math.round(s % 60)
  return `${m}m ${rem}s`
}

function parseSteps(log: string, messageEnded: boolean): StepBlock[] {
  if (!log) return []
  const map = new Map<string, StepBlock>()
  const order: string[] = []
  let rawIdx = 0

  const upsert = (step: StepBlock) => {
    const existing = map.get(step.id)
    if (existing) {
      map.set(step.id, {
        ...existing,
        ...step,
        detail: step.detail ?? existing.detail
      })
    } else {
      map.set(step.id, step)
      order.push(step.id)
    }
  }

  for (const line of log.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.startsWith('::step::')) {
      try {
        const parsed = JSON.parse(trimmed.slice(8)) as StepBlock
        if (parsed && parsed.id) {
          upsert({
            id: parsed.id,
            kind: parsed.kind || 'tool',
            title: parsed.title || '步骤',
            status: parsed.status || 'done',
            detail: parsed.detail
          })
          continue
        }
      } catch {}
    }

    const legacyTool = trimmed.match(/^(.+?)\s·\s(pending|in_progress|completed|failed|cancelled)$/i)
    if (legacyTool) {
      const title = legacyTool[1].trim()
      const rawSt = legacyTool[2].toLowerCase()
      const status: StepBlock['status'] = rawSt === 'completed' ? 'done' : (rawSt === 'failed' || rawSt === 'cancelled') ? 'error' : 'running'
      upsert({ id: 'legacy:' + title, kind: 'cmd', title, status })
      continue
    }

    if (trimmed.startsWith('模型 · ') || trimmed.startsWith('请求思考强度 · ')) {
      upsert({ id: 'meta:' + trimmed.split(' · ')[0], kind: 'info', title: trimmed, status: 'done' })
      continue
    }

    const prevId = order[order.length - 1]
    const prev = prevId ? map.get(prevId) : undefined
    if (prev && prev.id.startsWith('raw:')) {
      prev.detail = ((prev.detail ? prev.detail + '\n' : '') + line).slice(-1200)
    } else {
      const id = 'raw:' + (rawIdx++)
      upsert({ id, kind: 'cmd', title: trimmed.slice(0, 80), status: 'done', detail: trimmed.length > 80 ? trimmed : undefined })
    }
  }

  return order.map(id => {
    const item = map.get(id)!
    if (messageEnded && item.status === 'running') return { ...item, status: 'done' }
    return item
  })
}

function LiveTimer({ startTime }: { startTime: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(id)
  }, [])
  return <>{formatDuration(now - startTime)}</>
}

function StepCard({ step, defaultOpen = false }: { step: StepBlock; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const hasDetail = Boolean(step.detail?.trim())
  return (
    <div className={'step-card ' + step.status + ' ' + step.kind}>
      <button
        type="button"
        className="step-head"
        disabled={!hasDetail}
        onClick={() => hasDetail && setOpen(o => !o)}
      >
        <span className={'step-dot ' + step.status}>
          {step.status === 'running' ? <span className="pulse-dot mini" /> : step.status === 'error' ? '✕' : '✓'}
        </span>
        <span className="step-title">{step.title}</span>
        {step.status === 'running' && <span className="step-badge running">运行中</span>}
        {step.status === 'error' && <span className="step-badge error">失败</span>}
        {hasDetail && <ChevronRight size={12} className={'step-caret ' + (open ? 'open' : '')} />}
      </button>
      {open && hasDetail && <pre className="step-detail">{step.detail}</pre>}
    </div>
  )
}

function AgentMessage({
  m, roomId, onStop, onRetry, onContinue, onForward
}: {
  m: Msg
  roomId: string
  onStop: (agent: Agent) => void
  onRetry: (agent: Agent, msgId: string) => void
  onContinue: (agent: Agent) => void
  onForward: (from: string, to: Agent, body: string) => void
}) {
  const [copied, setCopied] = useState(false)
  const agent = allAgents.find(a => a === m.author)
  const cls = agent ? agentClass[agent] : 'codex'
  const isRunning = m.status === '执行中'
  const isFailed = m.status === '失败' || m.status === '中断'
  const isIncomplete = isFailed || (!isRunning && !m.body.trim())
  const steps = parseSteps(m.log, !isRunning)

  function copyBody() {
    void navigator.clipboard.writeText(m.body || m.log)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <article className={'msg-agent ' + cls + (isRunning ? ' running' : '')}>
      <div className="msg-avatar">
        <Icon name={m.author} size={20} />
      </div>
      <div className="msg-content">
        <div className="msg-head">
          <strong className="msg-author">{m.author}</strong>
          <time>{new Date(m.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>
          {!isRunning && !!m.duration && m.duration > 0 && (
            <span className="duration-tag" title="执行耗时">耗时 {formatDuration(m.duration)}</span>
          )}
          {isRunning && (
            <span className="status-pill running">
              <span className="pulse-dot" />
              执行中 · <LiveTimer startTime={m.time} />
            </span>
          )}
          {isFailed && <span className={'status-pill ' + (m.status === '失败' ? 'failed' : 'stopped')}>{m.status}</span>}
          {isRunning && agent && (
            <button type="button" className="msg-stop-btn" onClick={() => onStop(agent)}>
              <Square size={10} /> 停止
            </button>
          )}
          {!isRunning && (
            <div className="msg-actions">
              {m.body && (
                <button type="button" onClick={copyBody} title="复制回复">
                  {copied ? <Check size={13} /> : <Copy size={13} />}
                  <span>{copied ? '已复制' : '复制'}</span>
                </button>
              )}
              {isIncomplete && agent && (
                <>
                  <button type="button" onClick={() => onContinue(agent)} title="恢复会话继续执行">
                    <ArrowUp size={13} />
                    <span>继续</span>
                  </button>
                  <button type="button" onClick={() => onRetry(agent, m.id)} title="重新执行该任务">
                    <RotateCcw size={13} />
                    <span>重试</span>
                  </button>
                </>
              )}
              {m.body && coreAgents.filter(a => a !== m.author).map(other => (
                <button key={other} type="button" onClick={() => onForward(m.author, other, m.body)} title={'转给 ' + other}>
                  <Forward size={12} />
                  <span>给 {other}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {isRunning && (
          <div className="step-list live">
            {steps.length ? (
              steps.slice(-6).map(s => <StepCard key={s.id} step={s} defaultOpen={s.status === 'running' && s.kind === 'thought'} />)
            ) : (
              <div className="live-progress">
                <Terminal size={12} />
                <span>正在准备上下文并连接客户端…</span>
              </div>
            )}
          </div>
        )}

        {!isRunning && steps.length > 0 && (
          <details className="log-box" open={m.status === '失败' || !m.body || undefined}>
            <summary>
              <Terminal size={12} />
              <span>执行步骤 · {steps.length} 步{m.duration ? ` · ${formatDuration(m.duration)}` : ''}</span>
            </summary>
            <div className="step-list">
              {steps.map(s => <StepCard key={s.id} step={s} defaultOpen={s.status === 'error'} />)}
            </div>
          </details>
        )}

        {m.body ? (
          <MarkdownView content={m.body} roomId={roomId} />
        ) : (
          isRunning ? (
            <div className="typing-skeleton"><span /><span /><span /></div>
          ) : agent && (
            <div className="incomplete-bar">
              <span>未返回正文内容</span>
              <button type="button" onClick={() => onContinue(agent)}><ArrowUp size={12} /> 继续</button>
              <button type="button" onClick={() => onRetry(agent, m.id)}><RotateCcw size={12} /> 重试</button>
            </div>
          )
        )}
      </div>
    </article>
  )
}

function App() {
  const [tree, setTree] = useState<Tree>()
  const [room, setRoom] = useState(localStorage.getItem('room') || '')
  const [messages, setMessages] = useState<Msg[]>([])
  const [drafts, setDrafts] = useState<Record<string, string>>(() => loadJson('ominihive:drafts', {}))
  const [targets, setTargets] = useState<Agent[]>(() => {
    const saved = loadJson<Agent[]>('ominihive:targets', [])
    const valid = Array.isArray(saved) ? saved.filter(a => allAgents.includes(a)) : []
    if (valid.length) return valid
    const legacy = localStorage.getItem('ominihive:target') as Agent
    return allAgents.includes(legacy) ? [legacy] : ['Codex']
  })
  const [writes, setWrites] = useState<Partial<Record<Agent, boolean>>>(() => loadJson('ominihive:writes', {}))
  const [inspected, setInspected] = useState<Agent>(() => targets[0] || 'Codex')
  const [images, setImages] = useState<ImageDraft[]>([])
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState('')
  const [collapsed, setCollapsed] = useState(false)
  const [mention, setMention] = useState<{ start: number; end: number; query: string } | null>(null)
  const [mentionIdx, setMentionIdx] = useState(0)
  const [slash, setSlash] = useState<{ start: number; end: number; query: string } | null>(null)
  const [slashIdx, setSlashIdx] = useState(0)
  const [ccSwitch, setCcSwitch] = useState<CCSwitchSummary>()
  const [agentSkills, setAgentSkills] = useState<Partial<Record<Agent, SkillEntry[]>>>({})
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({})
  const [showFiles, setShowFiles] = useState<boolean>(() => localStorage.getItem('ominihive:files') === '1')
  const [enabledAgents, setEnabledAgents] = useState<Record<string, boolean>>(() => loadJson('ominihive:enabled', { Codex: true, Claude: true, Antigravity: true }))
  const agents = (() => {
    const list = allAgents.filter(a => coreAgents.includes(a) ? enabledAgents[a] !== false : Boolean(enabledAgents[a] && tree?.agents[a]))
    return list.length ? list : coreAgents
  })()
  const [providers, setProviders] = useState<Partial<Record<Agent, string>>>(() => loadJson('ominihive:providers', {}))
  const [editingRoom, setEditingRoom] = useState('')
  const [editTitle, setEditTitle] = useState('')

  const [selected, setSelected] = useState<Partial<Record<Agent, string>>>(() => loadJson('ominihive:models', {}))
  const [efforts, setEfforts] = useState<Record<string, string>>(() => loadJson('ominihive:efforts', {}))
  const [catalog, setCatalog] = useState<Partial<Record<Agent, ModelOption[]>>>({})
  const [hints, setHints] = useState<Partial<Record<Agent, string>>>({})

  const current = tree?.rooms.find(r => r.id === room)
  const project = tree?.projects.find(p => p.id === current?.project)
  const input = drafts[room] || ''

  const textarea = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const requests = useRef<Partial<Record<Agent, number>>>({})

  const parsedMentions = parseMentionedAgents(input)
  const readyAgents = tree ? agents.filter(a => tree.agents[a]) : agents
  const activeTargets = parsedMentions.agents.length ? parsedMentions.agents : targets
  const isAllMode = parsedMentions.isAll || (activeTargets.length >= readyAgents.length && readyAgents.length > 1)
  const target = targets[0] || 'Codex'
  const agent = activeTargets.includes(inspected) ? inspected : (activeTargets[0] || target)
  const agentWrite = Boolean(writes[agent])
  const anyWrite = activeTargets.some(a => Boolean(writes[a]))
  const runningInRoom = (tree?.running || []).filter(j => j.room === room)
  const busyAgents = new Set<Agent>([
    ...runningInRoom.map(j => j.agent),
    ...(messages.filter(m => m.status === '执行中').map(m => m.author as Agent))
  ])
  const anyBusy = busyAgents.size > 0
  const targetBusy = activeTargets.some(a => busyAgents.has(a))

  const mentionOptions: Array<{ id: 'all' | Agent; label: string; desc: string }> = [
    { id: 'all' as const, label: '@all', desc: `全部就绪 (${readyAgents.length})` },
    ...agents.map(a => ({ id: a as 'all' | Agent, label: '@' + a, desc: tree?.agents[a] ? '已就绪' : '未安装' }))
  ].filter(o => !mention?.query || o.id.toLowerCase().startsWith(mention.query.toLowerCase()))

  function setInput(val: string) {
    if (!room) return
    setDrafts(prev => {
      const next = { ...prev, [room]: val }
      localStorage.setItem('ominihive:drafts', JSON.stringify(next))
      return next
    })
  }

  useEffect(() => {
    localStorage.setItem('ominihive:targets', JSON.stringify(targets))
  }, [targets])

  useEffect(() => {
    localStorage.setItem('ominihive:writes', JSON.stringify(writes))
  }, [writes])

  useEffect(() => {
    localStorage.setItem('ominihive:enabled', JSON.stringify(enabledAgents))
  }, [enabledAgents])

  useEffect(() => {
    localStorage.setItem('ominihive:providers', JSON.stringify(providers))
  }, [providers])

  useEffect(() => {
    void api.ccSwitch().then(setCcSwitch).catch(() => {})
  }, [])

  useEffect(() => {
    void api.agentSkills(room).then(setAgentSkills).catch(() => {})
  }, [room, project?.id])

  useEffect(() => {
    if (project?.id) setExpandedProjects(prev => (prev[project.id] ? prev : { ...prev, [project.id]: true }))
  }, [project?.id])

  useEffect(() => {
    localStorage.setItem('ominihive:files', showFiles ? '1' : '0')
  }, [showFiles])

  useEffect(() => {
    localStorage.setItem('ominihive:models', JSON.stringify(selected))
  }, [selected])

  useEffect(() => {
    localStorage.setItem('ominihive:efforts', JSON.stringify(efforts))
  }, [efforts])

  useEffect(() => {
    const el = textarea.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(200, Math.max(44, el.scrollHeight)) + 'px'
  }, [input, room])

  useEffect(() => {
    if (!error) return
    const t = setTimeout(() => setError(''), 6000)
    return () => clearTimeout(t)
  }, [error])

  async function loadModels(a: Agent) {
    const request = (requests.current[a] || 0) + 1
    requests.current[a] = request
    let cached: ModelOption[] = [], isReference = false
    try {
      const initial = await api.cachedModels(a)
      cached = initial.list; isReference = initial.reference
      if (requests.current[a] !== request) return
      setCatalog(c => ({ ...c, [a]: cached }))
      setHints(h => ({ ...h, [a]: isReference ? '参考列表 · 正在核对' : cached.length ? '' : '首次读取模型列表…' }))
      const list = await api.models(a)
      if (requests.current[a] !== request) return
      setCatalog(c => ({ ...c, [a]: list }))
      setHints(h => ({ ...h, [a]: '' }))
    } catch {
      if (requests.current[a] !== request) return
      setCatalog(c => ({ ...c, [a]: cached }))
      setHints(h => ({ ...h, [a]: isReference ? '暂未连上客户端，显示参考列表' : cached.length ? '刷新失败，显示缓存' : '读取失败，打开重试' }))
    }
  }

  useEffect(() => { if (project) void loadModels(agent) }, [agent, Boolean(project)])

  const pickedProviderId = providers[agent] || ''
  const activeProvider = ccSwitch?.providers?.[agent]?.find(p => p.id === pickedProviderId)
  const effectiveModels: ModelOption[] = (activeProvider?.models?.length
    ? activeProvider.models.map(m => ({ id: m.id, label: m.label, isDefault: m.isDefault, efforts: catalog[agent]?.[0]?.efforts || [] }))
    : catalog[agent]) || []

  const picked = selected[agent] || ''
  const activeModel = effectiveModels.find(m => picked ? m.id === picked : m.isDefault)
  const effortKey = agent + '/' + (activeModel?.id || picked)
  const effort = activeModel?.efforts?.includes(efforts[effortKey]) ? efforts[effortKey] : ''

  const ownSkills = agentSkills[agent] || []
  const slashOptions = [
    ...ownSkills.map(s => ({
      id: 'ag:' + s.id,
      title: s.name,
      desc: s.source + (s.description ? ' · ' + s.description : ''),
      text: agent === 'Antigravity' ? `请加载并使用技能 ${s.name}：\n` : `$${s.name} `
    })),
    ...(ccSwitch?.prompts || []).map(p => ({
      id: 'p:' + p.id,
      title: p.name,
      desc: 'CC Switch · ' + p.appType + (p.description ? ' · ' + p.description : ''),
      text: p.content
    })),
    ...(ccSwitch?.skills || []).map(s => ({
      id: 's:' + s.id,
      title: 'Skill: ' + s.name,
      desc: 'CC Switch · ' + (s.agents.join('/') || '已启用'),
      text: `请使用技能 ${s.name}：\n`
    }))
  ].filter(o => !slash?.query || o.title.toLowerCase().includes(slash.query.toLowerCase()) || o.desc.toLowerCase().includes(slash.query.toLowerCase()))

  useEffect(() => {
    let alive = true, seq = 0
    async function refresh() {
      const n = ++seq
      try {
        const [t, m] = await Promise.all([api.tree(), room ? api.messages(room) : Promise.resolve([])])
        if (!alive || seq !== n) return
        setTree(t); setMessages(m)
        if (!t.rooms.some(r => r.id === room) && t.rooms.length) setRoom(t.rooms[0].id)
      } catch (e) { if (alive) setError(cleanError(e)) }
    }
    void refresh()
    const off = api.listen(() => void refresh())
    return () => { alive = false; off() }
  }, [room])

  useEffect(() => {
    localStorage.setItem('room', room)
    setMention(null)
    setError('')
    follow.current = true
  }, [room])

  useEffect(() => {
    if (follow.current && scroll.current) {
      scroll.current.scrollTop = scroll.current.scrollHeight
    }
  }, [messages])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'n' || e.key === 'N') { e.preventDefault(); void newRoom() }
      else if (e.key === 'o' || e.key === 'O') { e.preventDefault(); void add() }
      else if (e.key === '/') { e.preventDefault(); setCollapsed(c => !c) }
      else if (e.key === '.') { e.preventDefault(); if (room && anyBusy) void api.stop(room) }
      else if (e.key === '1') { e.preventDefault(); setTargets(['Codex']) }
      else if (e.key === '2') { e.preventDefault(); setTargets(['Claude']) }
      else if (e.key === '3') { e.preventDefault(); setTargets(['Antigravity']) }
      else if (e.key === '4') { e.preventDefault(); toggleAll() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  async function add() {
    try {
      const id = await api.add()
      if (id) {
        const t = await api.tree()
        setTree(t)
        const targetRoom = t.rooms.find(r => r.project === id)
        if (targetRoom) setRoom(targetRoom.id)
      }
    } catch (e) { setError(cleanError(e)) }
  }

  async function newRoom(projectId?: string) {
    const pid = projectId || project?.id
    if (!pid) return
    try { setRoom(await api.room(pid)) }
    catch (e) { setError(cleanError(e)) }
  }

  async function commitRename(id: string) {
    const title = editTitle.trim()
    setEditingRoom('')
    if (!title) return
    try { await api.renameRoom(id, title) }
    catch (e) { setError(cleanError(e)) }
  }

  async function remove(kind: 'project' | 'room', id: string) {
    try {
      const t = await api.remove(kind, id)
      setTree(old => old ? { ...old, ...t } : old)
      if (!t.rooms.some(r => r.id === room)) {
        setRoom(t.rooms.find(r => r.project === project?.id)?.id || t.rooms[0]?.id || '')
      }
    } catch (e) { setError(cleanError(e)) }
  }

  function detectTriggers(val: string, cursor: number | null) {
    const pos = cursor ?? val.length
    const before = val.slice(0, pos)
    const m = before.match(/(?:^|\s)@([a-z]*)$/i)
    if (m && !['all', 'codex', 'claude', 'antigravity'].includes(m[1].toLowerCase())) {
      setMention({ start: pos - m[1].length - 1, end: pos, query: m[1] })
      setMentionIdx(0)
      setSlash(null)
      return
    }
    setMention(null)
    const s = before.match(/(?:^|\s)\/([^\s]*)$/)
    if (s) {
      setSlash({ start: pos - s[1].length - 1, end: pos, query: s[1] })
      setSlashIdx(0)
      return
    }
    setSlash(null)
  }

  function insertSlash(text: string) {
    if (!slash) return
    const next = input.slice(0, slash.start) + text + input.slice(slash.end)
    setInput(next)
    const nextPos = slash.start + text.length
    setSlash(null)
    requestAnimationFrame(() => {
      textarea.current?.focus()
      textarea.current?.setSelectionRange(nextPos, nextPos)
    })
  }

  function insertMention(choice: 'all' | Agent) {
    if (choice !== 'all' && !parsedMentions.agents.length) {
      setTargets(prev => prev.includes(choice) ? prev : [...prev, choice])
    }
    const tag = '@' + choice + ' '
    if (mention) {
      const next = input.slice(0, mention.start) + tag + input.slice(mention.end)
      setInput(next)
      const nextPos = mention.start + tag.length
      setMention(null)
      requestAnimationFrame(() => {
        textarea.current?.focus()
        textarea.current?.setSelectionRange(nextPos, nextPos)
      })
      return
    }
    setInput(tag + input)
    setMention(null)
    textarea.current?.focus()
  }

  function toggleAgent(a: Agent, multi: boolean) {
    setInspected(a)
    if (parsedMentions.agents.length) {
      if (parsedMentions.agents.includes(a)) {
        textarea.current?.focus()
        return
      }
      const nextText = '@' + a + ' ' + input.trimStart()
      setInput(nextText)
      textarea.current?.focus()
      return
    }
    if (multi || targets.length > 1) {
      setTargets(prev => {
        if (prev.includes(a)) return prev.length > 1 ? prev.filter(x => x !== a) : prev
        return [...prev, a]
      })
    } else {
      setTargets([a])
    }
    textarea.current?.focus()
  }

  function toggleAll() {
    const pool = readyAgents.length ? readyAgents : agents
    setTargets(prev => prev.length >= pool.length ? [prev[0] || 'Codex'] : [...pool])
    textarea.current?.focus()
  }

  function buildPrefs(): AgentPrefs {
    const prefs: AgentPrefs = {}
    for (const a of agents) {
      const m = selected[a] || ''
      const activeM = catalog[a]?.find(opt => m ? opt.id === m : opt.isDefault)
      const k = a + '/' + (activeM?.id || m)
      const ef = activeM?.efforts?.includes(efforts[k]) ? efforts[k] : ''
      prefs[a] = { model: m, effort: ef, write: Boolean(writes[a]), provider: providers[a] || '' }
    }
    return prefs
  }

  async function addImageFiles(files: FileList | File[]) {
    const list = Array.from(files).filter(f => f.type.startsWith('image/')).slice(0, 8 - images.length)
    for (const file of list) {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result || ''))
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(file)
      })
      if (dataUrl) {
        setImages(prev => [...prev, { id: Math.random().toString(36).slice(2), name: file.name || 'image.png', dataUrl }])
      }
    }
  }

  async function send(overrideText?: string, overrideTarget?: Agent | Agent[] | 'all') {
    const raw = (overrideText ?? input) || (images.length ? '请查看附带的图片' : '')
    if (!raw.trim() || !room) return
    const sendTargets = overrideTarget ?? (parsedMentions.isAll ? 'all' : activeTargets)
    if (!overrideText && !Array.isArray(sendTargets) && sendTargets !== 'all' && busyAgents.has(sendTargets) && !parsedMentions.agents.length) return
    const sendImages = overrideText ? [] : images.map(i => ({ name: i.name, dataUrl: i.dataUrl }))
    setError('')
    setMention(null)
    if (!overrideText) { setInput(''); setImages([]) }
    follow.current = true
    try {
      await api.send(room, raw, agentWrite, buildPrefs(), effort, sendTargets, sendImages)
    } catch (e) {
      setError(cleanError(e))
      if (!overrideText) setInput(raw)
    }
  }

  function handleRetry(a: Agent, msgId: string) {
    const idx = messages.findIndex(m => m.id === msgId)
    const slice = idx > 0 ? messages.slice(0, idx) : messages
    const lastUser = [...slice].reverse().find(m => m.author === '我')
    if (!lastUser) return
    const task = lastUser.body.replace(/^(?:@(?:Codex|Claude|Antigravity|all)\s+)+/i, '').trim()
    if (task) void send('@' + a + ' ' + task, a)
  }

  function handleContinue(a: Agent) {
    void send('@' + a + ' 请继续完成刚才中断或未完成的任务，并给出完整结果。', a)
  }

  function handleForward(from: string, to: Agent, body: string) {
    setTargets([to])
    const snippet = body.slice(0, 600) + (body.length > 600 ? '…' : '')
    setInput(`请评审上面 ${from} 的结论并给出你的建议：\n> ${snippet.split('\n')[0]}`)
    textarea.current?.focus()
  }

  const missingCount = tree ? agents.filter(a => !tree.agents[a]).length : 0

  return (
    <div className="shell">
      {!collapsed && (
        <aside>
          <div className="sidebar-top">
            <div className="brand">
              <img className="brand-logo" src="./logo.png" width={24} height={24} alt="" />
              <span>OminiHive</span>
            </div>
            <div className="sidebar-top-actions">
              <button type="button" className="icon-btn" title="打开本地项目 (⌘O)" aria-label="打开本地项目" onClick={add}>
                <FolderPlus size={16} />
              </button>
              <button type="button" className="icon-btn" title="收起侧栏 (⌘/)" aria-label="收起项目栏" onClick={() => setCollapsed(true)}>
                <PanelLeft size={16} />
              </button>
            </div>
          </div>

          <nav aria-label="项目与讨论">
            {!tree?.projects.length && (
              <div className="sidebar-empty">
                <p>暂无项目</p>
                <button type="button" className="sidebar-open-btn" onClick={add}>
                  <FolderPlus size={15} /> 打开本地项目
                </button>
              </div>
            )}
            {tree?.projects.map(p => {
              const isOpen = Boolean(expandedProjects[p.id])
              const isCurrentProj = project?.id === p.id
              const projRooms = tree.rooms.filter(r => r.project === p.id)
              return (
                <section key={p.id} className="project-group">
                  <div className={'navrow projectrow ' + (isOpen ? 'open' : '') + (isCurrentProj ? ' current' : '')}>
                    <button
                      type="button"
                      className="project"
                      title={p.dir + ' · 点击展开或收起讨论列表'}
                      onClick={() => setExpandedProjects(prev => ({ ...prev, [p.id]: !isOpen }))}
                    >
                      <ChevronRight size={13} className={'proj-caret ' + (isOpen ? 'open' : '')} />
                      {isOpen ? <FolderOpen size={15} /> : <Folder size={15} />}
                      <span>{p.name}</span>
                    </button>
                    <div className="row-actions">
                      <button
                        type="button"
                        className="row-action"
                        title="在此项目新建讨论"
                        aria-label="新建讨论"
                        onClick={e => { e.stopPropagation(); void newRoom(p.id) }}
                      >
                        <Plus size={14} />
                      </button>
                      <DeleteButton project name={p.name} onDelete={() => void remove('project', p.id)} />
                    </div>
                  </div>
                  {isOpen && (
                    <div className="rooms">
                      {projRooms.map(r => {
                        const roomJobs = (tree.running || []).filter(j => j.room === r.id)
                        const isEditing = editingRoom === r.id
                        return (
                          <div key={r.id} className={'navrow roomrow ' + (r.id === room ? 'active' : '')}>
                            {isEditing ? (
                              <input
                                className="rename-input"
                                autoFocus
                                value={editTitle}
                                onChange={e => setEditTitle(e.target.value)}
                                onBlur={() => void commitRename(r.id)}
                                onKeyDown={e => {
                                  if (e.key === 'Enter') void commitRename(r.id)
                                  if (e.key === 'Escape') setEditingRoom('')
                                }}
                              />
                            ) : (
                              <>
                                <button
                                  type="button"
                                  className="roomlink"
                                  onClick={() => setRoom(r.id)}
                                  onDoubleClick={() => { setEditingRoom(r.id); setEditTitle(r.title) }}
                                >
                                  <MessageSquare size={13} />
                                  <span>{r.title}</span>
                                  {roomJobs.length > 0 && (
                                    <span className="room-dots" title={roomJobs.map(j => j.agent + ' 执行中').join('、')}>
                                      {roomJobs.map(j => <i key={j.agent} className={'dot ' + agentClass[j.agent]} />)}
                                    </span>
                                  )}
                                </button>
                                <div className="row-actions">
                                  <DeleteButton name={r.title} onDelete={() => void remove('room', r.id)} />
                                </div>
                              </>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </section>
              )
            })}
          </nav>

          <div className="sidebar-foot">
            <Settings
              missingCount={missingCount}
              ccSwitch={ccSwitch}
              enabledAgents={enabledAgents}
              onToggleAgent={(ag, enabled) => setEnabledAgents(prev => ({ ...prev, [ag]: enabled }))}
              providers={providers}
              onProviderChange={(ag, pid) => setProviders(prev => ({ ...prev, [ag]: pid }))}
            />
          </div>
        </aside>
      )}

      <main>
        <header className={'chathead ' + (collapsed ? 'with-traffic-lights' : '')}>
          {collapsed && (
            <button type="button" className="icon-btn" title="展开项目栏 (⌘/)" aria-label="展开项目栏" onClick={() => setCollapsed(false)}>
              <PanelLeft size={16} />
            </button>
          )}
          <div className="head-title">
            {project ? (
              <>
                <span className="head-proj" onClick={() => void api.openPath(project.dir)} title={'在 Finder 打开 ' + project.dir}>
                  {project.name}
                </span>
                <ChevronRight size={13} className="head-sep" />
                {current && (
                  <strong
                    title="双击重命名讨论"
                    onDoubleClick={() => { setEditingRoom(current.id); setEditTitle(current.title) }}
                  >
                    {current.title}
                  </strong>
                )}
              </>
            ) : (
              <strong>OminiHive</strong>
            )}
          </div>

          <div className="head-actions">
            {anyBusy && (
              <button type="button" className="head-stop-btn" onClick={() => void api.stop(room)} title="停止所有正在执行的 Agent (⌘.)">
                <Square size={11} />
                <span>停止 ({runningInRoom.length || busyAgents.size})</span>
              </button>
            )}
            {project && (
              <>
                <button
                  type="button"
                  className={'head-new-btn' + (showFiles ? ' active' : '')}
                  onClick={() => setShowFiles(s => !s)}
                  title="展开或收起项目文件目录"
                >
                  <FolderTree size={14} />
                  <span>文件</span>
                </button>
                <button type="button" className="head-new-btn" onClick={() => void newRoom()} title="新建讨论 (⌘N)">
                  <Plus size={14} />
                  <span>新讨论</span>
                </button>
              </>
            )}
          </div>
        </header>

        <div
          className="timeline"
          ref={scroll}
          onScroll={e => {
            const el = e.currentTarget
            follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100
          }}
        >
          {!messages.length ? (
            <div className="welcome">
              <div className="symbol">
                {project ? <Sparkles size={26} /> : <Compass size={28} />}
              </div>
              <h1>{project ? '多 Agent 协作工作区' : '打开一个本地项目'}</h1>
              <p>
                {project
                  ? `${project.name} · 选择一位助手或同时 @ 多个 Agent 开始讨论`
                  : '选择代码所在的文件夹，让 Codex、Claude 与 Antigravity 在同一上下文中协同工作。'}
              </p>

              {project ? (
                <>
                  <div className="quickagents">
                    {agents.map(a => {
                      const available = tree?.agents[a] !== false
                      return (
                        <button
                          key={a}
                          type="button"
                          className={'quick-agent-card ' + agentClass[a] + (activeTargets.includes(a) ? ' selected' : '')}
                          onClick={e => { toggleAgent(a, e.metaKey || e.shiftKey) }}
                        >
                          <Icon name={a} size={20} />
                          <div>
                            <strong>{a}</strong>
                            <span>{available ? '已就绪' : '未检测到 CLI'}</span>
                          </div>
                        </button>
                      )
                    })}
                  </div>

                  <div className="starter-grid">
                    {STARTER_PROMPTS.map(item => (
                      <button
                        key={item.title}
                        type="button"
                        className="starter-card"
                        onClick={() => { setInput(item.text); textarea.current?.focus() }}
                      >
                        <strong>{item.title}</strong>
                        <span>{item.desc}</span>
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <Button size="3" onClick={add}>
                  <FolderPlus size={16} /> 选择文件夹
                </Button>
              )}
            </div>
          ) : (
            <div className="transcript">
              {messages.map(m =>
                m.author === '我'
                  ? <UserBubble key={m.id} body={m.body} attachments={m.attachments} />
                  : <AgentMessage key={m.id} m={m} roomId={room} onStop={a => void api.stop(room, a)} onRetry={handleRetry} onContinue={handleContinue} onForward={handleForward} />
              )}
            </div>
          )}
        </div>

        {error && (
          <div className="toast-error" role="alert">
            <span>{error}</span>
            <button type="button" aria-label="关闭错误提示" onClick={() => setError('')}><X size={14} /></button>
          </div>
        )}

        {project && (
          <div className="composer-wrap">
            <div
              className={'composer' + (anyWrite ? ' write-mode' : '') + (dragging ? ' dragging' : '')}
              onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true) } }}
              onDragLeave={() => setDragging(false)}
              onDrop={e => {
                e.preventDefault()
                setDragging(false)
                if (e.dataTransfer.files?.length) void addImageFiles(e.dataTransfer.files)
              }}
            >
              {images.length > 0 && (
                <div className="draft-imgs">
                  {images.map(img => (
                    <div key={img.id} className="draft-img">
                      <img src={img.dataUrl} alt={img.name} title={img.name} />
                      <button type="button" aria-label="移除图片" onClick={() => setImages(prev => prev.filter(x => x.id !== img.id))}>
                        <X size={11} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {mention && mentionOptions.length > 0 && (
                <div className="mention-menu">
                  <div className="mention-menu-label">提及 Agent（可多选，↑↓ 选择）</div>
                  {mentionOptions.map((opt, idx) => (
                    <button
                      key={opt.id}
                      type="button"
                      className={idx === mentionIdx ? 'focused' : ''}
                      onMouseEnter={() => setMentionIdx(idx)}
                      onClick={() => insertMention(opt.id)}
                    >
                      {opt.id === 'all' ? <Users size={15} className="all-icon" /> : <Icon name={opt.id} size={16} />}
                      <span>{opt.label}</span>
                      <small>{opt.desc}</small>
                    </button>
                  ))}
                </div>
              )}

              {slash && slashOptions.length > 0 && (
                <div className="mention-menu slash-menu">
                  <div className="mention-menu-label">{agent} 专属 Skills & 预设 ({slashOptions.length})</div>
                  {slashOptions.map((opt, idx) => (
                    <button
                      key={opt.id}
                      type="button"
                      className={idx === slashIdx ? 'focused' : ''}
                      onMouseEnter={() => setSlashIdx(idx)}
                      onClick={() => insertSlash(opt.text)}
                    >
                      <span>/{opt.title}</span>
                      <small>{opt.desc}</small>
                    </button>
                  ))}
                </div>
              )}

              <textarea
                ref={textarea}
                aria-label="任务"
                rows={1}
                placeholder={`给 ${isAllMode ? '全部 Agent' : activeTargets.join('、')} 下达任务…（@ 多选 / @all，/ 调 CC Switch 预设）`}
                value={input}
                onPaste={e => {
                  const files = Array.from(e.clipboardData.items)
                    .filter(it => it.type.startsWith('image/'))
                    .map(it => it.getAsFile())
                    .filter((f): f is File => Boolean(f))
                  if (files.length) {
                    e.preventDefault()
                    void addImageFiles(files)
                  }
                }}
                onChange={e => {
                  const v = e.target.value
                  setInput(v)
                  detectTriggers(v, e.target.selectionStart)
                }}
                onClick={e => detectTriggers(e.currentTarget.value, e.currentTarget.selectionStart)}
                onKeyUp={e => {
                  if (['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(e.key)) return
                  detectTriggers(e.currentTarget.value, e.currentTarget.selectionStart)
                }}
                onKeyDown={e => {
                  if (mention && mentionOptions.length > 0) {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault()
                      setMentionIdx(i => (i + 1) % mentionOptions.length)
                      return
                    }
                    if (e.key === 'ArrowUp') {
                      e.preventDefault()
                      setMentionIdx(i => (i - 1 + mentionOptions.length) % mentionOptions.length)
                      return
                    }
                    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing)) {
                      e.preventDefault()
                      insertMention(mentionOptions[mentionIdx]?.id || mentionOptions[0].id)
                      return
                    }
                  }
                  if (slash && slashOptions.length > 0) {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault()
                      setSlashIdx(i => (i + 1) % slashOptions.length)
                      return
                    }
                    if (e.key === 'ArrowUp') {
                      e.preventDefault()
                      setSlashIdx(i => (i - 1 + slashOptions.length) % slashOptions.length)
                      return
                    }
                    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing)) {
                      e.preventDefault()
                      const chosen = slashOptions[slashIdx] || slashOptions[0]
                      if (chosen) insertSlash(chosen.text)
                      return
                    }
                  }
                  if (e.key === 'Escape') { setMention(null); setSlash(null); return }
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    void send()
                  }
                }}
              />

              <div className="toolbar">
                <div className="agent-seg" role="group" aria-label="选择目标 Agent">
                  {agents.map(a => {
                    const isActive = activeTargets.includes(a)
                    const isInspecting = agent === a && activeTargets.length > 1
                    const isBusy = busyAgents.has(a)
                    return (
                      <button
                        key={a}
                        type="button"
                        className={'seg-btn ' + agentClass[a] + (isActive ? ' active' : '') + (isInspecting ? ' inspecting' : '')}
                        onMouseEnter={() => { if (isActive) setInspected(a) }}
                        onClick={e => toggleAgent(a, e.metaKey || e.shiftKey)}
                        title={a + (isActive && activeTargets.length > 1 ? '（当前显示其配置 · 悬停或点击可切换查看）' : isBusy ? ' (执行中)' : ' · ⌘+点击可多选')}
                      >
                        <Icon name={a} size={15} />
                        <span>{a}</span>
                        {isBusy && <span className="pulse-dot mini" />}
                      </button>
                    )
                  })}
                  <button
                    type="button"
                    className={'seg-btn all' + (isAllMode ? ' active' : '')}
                    onClick={toggleAll}
                    title="全选 / 取消全选所有就绪 Agent (⌘4)"
                  >
                    <Users size={13} />
                    <span>All</span>
                  </button>
                </div>

                <div className="toolbar-mid">
                  <ModelEffortPicker
                    agent={agent}
                    models={effectiveModels}
                    model={picked}
                    onModel={id => setSelected(s => ({ ...s, [agent]: id }))}
                    effort={effort}
                    onEffort={v => setEfforts(s => ({ ...s, [effortKey]: v }))}
                    onOpen={() => void loadModels(agent)}
                    hint={hints[agent]}
                  />

                  <button
                    type="button"
                    className={'tool-chip perm-btn ' + (agentWrite ? 'writable' : '')}
                    title={agentWrite ? `${agent} 可编辑 / 自动放行命令，点击切换为只读` : `${agent} 只读模式，点击允许编辑与自动放行`}
                    onClick={() => setWrites(w => ({ ...w, [agent]: !w[agent] }))}
                  >
                    {agentWrite ? <ShieldAlert size={13} /> : <Shield size={13} />}
                    <span>{agentWrite ? '可编辑' : '只读'}</span>
                  </button>
                  <button
                    type="button"
                    className="tool-chip img-pick-btn"
                    title="添加图片（也支持直接粘贴截图或拖入图片）"
                    onClick={() => fileInput.current?.click()}
                  >
                    <ImagePlus size={14} />
                  </button>
                  {ownSkills.length > 0 && (
                    <button
                      type="button"
                      className="tool-chip skills-btn"
                      title={`查看 ${agent} 的 ${ownSkills.length} 个专属 Skills（也可直接输入 /）`}
                      onClick={() => {
                        if (slash) { setSlash(null); return }
                        const pos = textarea.current?.selectionStart ?? input.length
                        const next = input.slice(0, pos) + '/' + input.slice(pos)
                        setInput(next)
                        setSlash({ start: pos, end: pos + 1, query: '' })
                        setSlashIdx(0)
                        requestAnimationFrame(() => {
                          textarea.current?.focus()
                          textarea.current?.setSelectionRange(pos + 1, pos + 1)
                        })
                      }}
                    >
                      <Sparkles size={12} />
                      <span>{ownSkills.length}</span>
                    </button>
                  )}
                  <input
                    ref={fileInput}
                    type="file"
                    accept="image/*"
                    multiple
                    hidden
                    onChange={e => {
                      if (e.target.files?.length) void addImageFiles(e.target.files)
                      e.target.value = ''
                    }}
                  />
                </div>

                {activeTargets.length > 1 && (
                  <span className="batch-pill" title={'将同时发送给：' + activeTargets.join('、')}>
                    {isAllMode ? `@all · ${activeTargets.length}` : `群发 · ${activeTargets.length}`}
                  </span>
                )}

                <button
                  type="button"
                  className={'send ' + (targetBusy && !input.trim() && !images.length ? 'stop' : '') + (input.trim() || images.length ? ' ready' : '')}
                  aria-label={targetBusy && !input.trim() && !images.length ? '停止' : '发送'}
                  disabled={!targetBusy && !input.trim() && !images.length}
                  onClick={() => targetBusy && !input.trim() && !images.length ? void api.stop(room, activeTargets.length === 1 ? agent : undefined) : void send()}
                >
                  {targetBusy && !input.trim() && !images.length ? <Square size={12} /> : <ArrowUp size={16} />}
                </button>
              </div>
            </div>
          </div>
        )}
      </main>

      {showFiles && project && (
        <FileDrawer
          roomId={room}
          projectName={project.name}
          onClose={() => setShowFiles(false)}
          onInsertPath={relPath => {
            setInput((input ? input.trimEnd() + ' ' : '') + relPath + ' ')
            textarea.current?.focus()
          }}
        />
      )}
    </div>
  )
}

function Root() {
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return (
    <Theme appearance={dark ? 'dark' : 'light'} accentColor="indigo" grayColor="slate" radius="medium" scaling="100%">
      <App />
    </Theme>
  )
}

createRoot(document.getElementById('root')!).render(<Root />)
