import React, { useState, useEffect, useRef, useMemo } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Folder, FolderPlus, FolderOpen, MessageSquare, Plus, ArrowUp, Square,
  PanelLeft, Compass, Copy, Check,
  RotateCcw, Sparkles, ChevronRight, ChevronDown, ChevronUp, X, Forward, Users, FileText, UserPlus, ExternalLink, Sun, Moon, Pencil, Eye, FolderSearch, Image as ImageIcon
} from 'lucide-react'
import { Theme, Button } from '@radix-ui/themes'
import '@radix-ui/themes/styles.css'
import { DeleteButton } from './Controls'
import { ModelEffortPicker, Settings, type ModelOption, type ClientInfo, type CCSwitchSummary } from './Preferences'
import { AgentIcon } from './AgentIcon'
import { RoomMembersPicker, TargetSelector } from './RoomMembers'
import { ALL_AGENTS, CORE_AGENTS, AGENT_CLASS, agentColor, finishedAgentsByRoom, runKey, agentShort, agentMatchesQuery, type Agent } from './agentMeta'
import { MarkdownView } from './MarkdownView'
import { buildMentionTools } from './mentions'
import type { QuotaResult } from './VolcQuota'
import { FileDrawer, type FileEntry, type GitStatusResult, type PreviewResult } from './FileDrawer'
import { FilePreviewPanel } from './FilePreviewPanel'
import { ImageLightbox, copyImageToClipboard, loadLocalImage, type LightboxImageItem } from './ImageLightbox'
import { ImportSessionModal, type ExternalSessionItem } from './ImportSessionModal'
import { OverlayScrollbar, ScrollArea } from './OverlayScrollbar'
import { ExecutionTimeline, InlineStepGroup, ProjectDirContext, buildTimelineSegments, formatDuration, parseStepsWithMeta } from './ExecutionTimeline'
import { ChatHeader } from './ChatHeader'
import { ComposerToolbar, type AccessMode } from './ComposerToolbar'
import { cleanError } from './errors'
import { loadJson } from './storage'
import { useAgentPrefs, type AgentPrefs } from './useAgentPrefs'
import { useSendQueue, type QueuedMessage } from './useSendQueue'
import { SendQueueBar } from './SendQueueBar'
import { TypewriterTitle, isAutoTitle } from './TypewriterTitle'
import './tokens.css'
import './style.css'

type Project = { id: string; name: string; dir: string }
type Room = { id: string; project: string; title: string; title_locked?: number; title_auto?: number }
type Msg = { id: string; author: string; body: string; log: string; status: string; time: number; duration?: number; attachments?: string }
type ImageDraft = { id: string; name: string; dataUrl: string; isImage: boolean }
type RunningJob = { room: string; agent: Agent }
type SessionBinding = { room: string; agent: string }
type Tree = { projects: Project[]; rooms: Room[]; agents: Record<Agent, boolean>; running?: RunningJob[]; sessions?: SessionBinding[] }
type SkillEntry = { id: string; name: string; description: string; source: string; path: string }
declare global {
  interface Window {
    hive: {
      tree(): Promise<Tree>
      messages(id: string): Promise<Msg[]>
      messagesDelta(id: string, known: Record<string, string>): Promise<{ ids: string[]; rows: (Msg & { sig: string })[] }>
      syncRoom(id: string): Promise<number>
      add(): Promise<string | null>
      room(id: string): Promise<string>
      renameProject(id: string, name: string): Promise<void>
      renameRoom(id: string, title: string): Promise<void>
      externalSessions(projectId: string): Promise<ExternalSessionItem[]>
      searchCodexSessions(projectId: string, query: string): Promise<ExternalSessionItem[]>
      importSharedChat(projectId: string, url: string): Promise<string>
      importSession(projectId: string, item: ExternalSessionItem): Promise<string>
      volcQuota(): Promise<QuotaResult>
      volcLogin(): Promise<QuotaResult>
      clients(): Promise<ClientInfo[]>
      ccSwitch(): Promise<CCSwitchSummary>
      files(roomId: string, relDir?: string): Promise<FileEntry[]>
      gitStatus(roomId: string): Promise<GitStatusResult>
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
      copyImage(pngDataUrl: string): Promise<boolean>
      revealPath(filePath: string, roomId?: string): Promise<boolean>
      respondInteraction(req: { cascadeId: string; trajectoryId?: string; stepIndex: number; payload: Record<string, unknown> }): Promise<boolean>
      focusAntigravity(): Promise<boolean>
      setTheme(mode: 'light' | 'dark' | 'system'): Promise<boolean>
      listen(fn: () => void): () => void
    }
  }
}

const api = window.hive
const allAgents: Agent[] = ALL_AGENTS
const coreAgents: Agent[] = CORE_AGENTS
const agentClass: Record<Agent, string> = AGENT_CLASS
/** Each agent's own accent (non-core agents used to borrow one of three core colors). */
const agentTint = (a: string) => ({ '--agent-color': agentColor(a) } as React.CSSProperties)
const { MENTION_SPLIT_RE, LEADING_MENTIONS_RE, parseMentionedAgents } = buildMentionTools<Agent>(ALL_AGENTS)

const STARTER_PROMPTS = [
  { title: '梳理项目结构', desc: '快速理解目录职责与核心模块', text: '帮我梳理这个项目的目录结构、核心入口和主要模块职责。' },
  { title: '排查潜在问题', desc: '检查边界条件与异常处理漏洞', text: '检查核心代码中的异常处理和边界条件，列出最值得改进的 3 个问题。' },
  { title: '生成或完善测试', desc: '为关键路径补充单元测试', text: '看一下当前的测试覆盖情况，为最关键的逻辑设计或补充单元测试。' },
  { title: '多 Agent 联合评审', desc: '让 Codex 与 Claude 同时给建议', text: '@Codex @Claude 从架构与代码细节两个角度，评估这个项目当前最需要重构的地方。' }
]



/** Sidebar status: breathing dots for running agents, solid agent-colored dots for finished ones. */
function AgentStatusDots({ running, done, justDone, scope = '' }: { running: string[]; done: string[]; justDone: string[]; scope?: string }) {
  const runningSet = new Set(running)
  const finished = done.filter(a => !runningSet.has(a))
  if (!running.length && !finished.length) return null
  const title = [
    ...running.map(a => `${agentShort(a)} 执行中`),
    ...finished.map(a => `${agentShort(a)} 已完成`)
  ].join('、')
  return (
    <span className="room-dots" title={scope ? `${scope}：${title}` : title}>
      {running.map(a => <i key={'r-' + a} className="dot" style={{ '--agent-dot': agentColor(a) } as React.CSSProperties} />)}
      {finished.map(a => (
        <span
          key={'d-' + a}
          className={'done-dot' + (justDone.includes(a) ? ' pulse' : '')}
          style={{ '--agent-dot': agentColor(a) } as React.CSSProperties}
        />
      ))}
    </span>
  )
}


function scoreSlashOption(searchTitle: string, searchDesc: string, rawQuery: string): number {
  const q = rawQuery.trim().toLowerCase()
  if (!q) return 1
  const qCompact = q.replace(/[-_.\s/]+/g, '')
  const title = searchTitle.toLowerCase()
  const titleCompact = title.replace(/[-_.\s/]+/g, '')
  const words = title.split(/[-_.\s/]+/).filter(Boolean)
  const acronym = words.map(w => w[0]).join('')
  const desc = searchDesc.toLowerCase()

  if (title === q || (qCompact && titleCompact === qCompact)) return 1000
  if (title.startsWith(q) || (qCompact && titleCompact.startsWith(qCompact))) {
    return 860 - Math.min(title.length, 60)
  }
  if (words.some(w => w.startsWith(q) || (qCompact && w.startsWith(qCompact)))) {
    return 760 - Math.min(title.length, 60)
  }
  const titleIdx = title.indexOf(q)
  if (titleIdx >= 0) return 680 - Math.min(titleIdx * 4, 80) - Math.min(title.length, 40)
  if (qCompact) {
    const compactIdx = titleCompact.indexOf(qCompact)
    if (compactIdx >= 0) return 640 - Math.min(compactIdx * 4, 80)
  }

  const qTokens = q.split(/[-_.\s/]+/).filter(Boolean)
  if (qTokens.length > 1) {
    if (qTokens.every(t => title.includes(t))) return 600 - Math.min(title.length, 40)
    if (qTokens.every(t => title.includes(t) || desc.includes(t))) {
      const titleHits = qTokens.filter(t => title.includes(t)).length
      return 300 + titleHits * 70
    }
  }

  if (qCompact.length >= 2 && acronym.includes(qCompact)) {
    return acronym.startsWith(qCompact) ? 580 : 520
  }

  if (qCompact.length >= 2) {
    let qi = 0
    let first = -1
    let last = -1
    let prev = -2
    let bonus = 0
    for (let i = 0; i < title.length && qi < qCompact.length; i++) {
      if (title[i] === qCompact[qi]) {
        if (first < 0) first = i
        if (i === prev + 1) bonus += 18
        if (i === 0 || /[-_.\s/]/.test(title[i - 1])) bonus += 22
        prev = i
        last = i
        qi++
      }
    }
    if (qi === qCompact.length) {
      const span = last - first + 1
      if (span <= Math.max(qCompact.length * 4, 16)) {
        return Math.max(320, 360 + bonus - span * 2)
      }
    }
  }

  const descIdx = desc.indexOf(q)
  if (descIdx >= 0) return 240 - Math.min(descIdx, 80)
  if (qCompact.length >= 2) {
    const descCompact = desc.replace(/[-_.\s/]+/g, '')
    if (descCompact.includes(qCompact)) return 190
  }

  return 0
}

function inferLastTargets(messages: Msg[], pool: Agent[]): Agent[] {
  if (!messages.length || !pool.length) return []
  let lastUserIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].author === '我') { lastUserIdx = i; break }
  }
  if (lastUserIdx >= 0) {
    const replied: Agent[] = []
    for (let i = lastUserIdx + 1; i < messages.length; i++) {
      const a = messages[i].author as Agent
      if (pool.includes(a) && !replied.includes(a)) replied.push(a)
    }
    if (replied.length) return replied
    const mentioned = parseMentionedAgents(messages[lastUserIdx].body, pool).agents.filter(a => pool.includes(a))
    if (mentioned.length) return mentioned
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const a = messages[i].author as Agent
    if (pool.includes(a)) return [a]
  }
  return []
}

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  return <AgentIcon name={name} size={size} />
}

const ASSEMBLED_CTX_PREFIX = '同一项目讨论的近期记录（引用资料，请仅执行本轮用户请求）：'
const USER_TASK_MARKERS = ['本轮用户请求：', '当前任务：', '请接着处理用户的最新要求：']

function parseUserBody(raw: string): { display: string; assembledContext: string | null } {
  const text = String(raw || '')
  const leadMatch = text.match(/^((?:@[a-z0-9_-]+\s+)+)/i)
  const lead = leadMatch ? leadMatch[1] : ''
  const rest = lead ? text.slice(lead.length) : text

  const taskOpenIdx = rest.lastIndexOf('<user_task>')
  if (taskOpenIdx !== -1) {
    let task = rest.slice(taskOpenIdx + '<user_task>'.length)
    const taskCloseIdx = task.indexOf('</user_task>')
    if (taskCloseIdx !== -1) task = task.slice(0, taskCloseIdx)
    const ctxOpenIdx = rest.indexOf('<group_context>')
    const ctxCloseIdx = rest.indexOf('</group_context>')
    const ctx = ctxOpenIdx !== -1 && ctxCloseIdx > ctxOpenIdx
      ? rest.slice(ctxOpenIdx + '<group_context>'.length, ctxCloseIdx).trim()
      : null
    return { display: (lead + task.trim()).trim(), assembledContext: ctx }
  }

  if (rest.startsWith(ASSEMBLED_CTX_PREFIX)) {
    for (const marker of USER_TASK_MARKERS) {
      const idx = rest.lastIndexOf(marker)
      if (idx !== -1) {
        const task = rest.slice(idx + marker.length).trim()
        const ctx = rest.slice(0, idx).trim()
        return { display: (lead + (task || '(未提取到任务正文)')).trim(), assembledContext: ctx }
      }
    }
    return { display: (lead + '（已折叠系统组装的上下文记录）').trim(), assembledContext: rest }
  }

  for (const marker of USER_TASK_MARKERS) {
    if (rest.startsWith(marker)) {
      return { display: (lead + rest.slice(marker.length).trim()).trim(), assembledContext: null }
    }
  }

  return { display: text, assembledContext: null }
}

const IMAGE_PATH_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i

/** Attachment image: uses the inline preview when present, otherwise loads it by path (cached). */
function BubbleImage({ path, dataUrl, alt, onClick, onContextMenu }: {
  path: string
  dataUrl?: string
  alt: string
  onClick: () => void
  onContextMenu: (e: React.MouseEvent) => void
}) {
  const [src, setSrc] = useState(dataUrl || '')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    setFailed(false)
    if (dataUrl) { setSrc(dataUrl); return }
    let alive = true
    void loadLocalImage(undefined, path).then(res => {
      if (!alive) return
      if (res) setSrc(res.dataUrl)
      else setFailed(true)
    })
    return () => { alive = false }
  }, [path, dataUrl])
  // A deleted attachment must not pulse as "loading" forever.
  if (failed) return <span className="bubble-img-missing" title={path}><FileText size={13} />{alt || '图片'}已不存在</span>
  if (!src) return <span className="bubble-img-skeleton" title={alt} />
  return (
    <img
      src={src}
      alt={alt}
      title={alt + '（点击查看大图，右键可复制）'}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
      onContextMenu={onContextMenu}
    />
  )
}

const UserBubble = React.memo(function UserBubble({
  body, attachments, log, onPreviewFile, onOpenLightbox, onFileContextMenu
}: {
  body: string
  attachments?: string
  log?: string
  onPreviewFile?: (targetPath: string) => void
  onOpenLightbox?: (items: LightboxImageItem[], index: number) => void
  onFileContextMenu?: (e: React.MouseEvent, absPath: string, allowPreview?: boolean) => void
}) {
  const { display, assembledContext } = parseUserBody(body)
  const copyText = (display.replace(LEADING_MENTIONS_RE, '').trim() || display.trim())
  const isLong = display.length > 320 || display.split('\n').length > 6
  const [expanded, setExpanded] = useState(false)
  const [ctxOpen, setCtxOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const parts = display.split(MENTION_SPLIT_RE)
  let atts: { path: string; name: string; dataUrl?: string; mimeType?: string; isImage?: boolean }[] = []
  try { if (attachments) atts = JSON.parse(attachments) } catch {}
  const syncLabel = log && /^同步自\s+.+\s+客户端$/.test(log.trim()) ? log.trim().replace(/\s*客户端$/, '') : ''
  // The message list ships attachments without inline base64 (see store.slimAttachments);
  // images are then loaded on demand from their saved path.
  const isImageAtt = (a: typeof atts[number]) => a.isImage !== false && (Boolean(a.dataUrl) || IMAGE_PATH_RE.test(a.path || ''))
  const imgAtts: LightboxImageItem[] = atts
    .filter(isImageAtt)
    .map(a => ({ path: a.path, name: a.name, dataUrl: a.dataUrl || undefined }))

  function copyBody() {
    if (!copyText) return
    void navigator.clipboard.writeText(copyText)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="msg-user-row">
      <div className="msg-user-col">
        <div className="mine">
          {atts.length > 0 && (
            <div className="bubble-imgs">
              {atts.map((att, i) => {
                const isImg = isImageAtt(att)
                return isImg ? (
                  <BubbleImage
                    key={i}
                    path={att.path}
                    dataUrl={att.dataUrl}
                    alt={att.name}
                    onClick={() => {
                      if (onOpenLightbox && imgAtts.length) {
                        const imgIdx = Math.max(0, imgAtts.findIndex(x => x.path === att.path))
                        onOpenLightbox(imgAtts, imgIdx)
                      } else if (onPreviewFile && att.path) {
                        onPreviewFile(att.path)
                      } else {
                        void api.openPath(att.path)
                      }
                    }}
                    onContextMenu={e => { if (att.path) onFileContextMenu?.(e, att.path, true) }}
                  />
                ) : (
                  <button
                    key={i}
                    type="button"
                    className="bubble-file"
                    title={att.path || att.name}
                    onClick={() => (onPreviewFile && att.path ? onPreviewFile(att.path) : void api.openPath(att.path))}
                    onContextMenu={e => { if (att.path) onFileContextMenu?.(e, att.path, true) }}
                  >
                    <FileText size={13} />
                    <span>{att.name}</span>
                  </button>
                )
              })}
            </div>
          )}
          <div className={'mine-body' + (isLong && !expanded ? ' clamped' : '')}>
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
                  <span key={i} className={'mention-chip agent-tinted ' + agentClass[matched]} style={agentTint(matched)}>
                    <Icon name={matched} size={13} />
                    @{matched}
                  </span>
                )
              }
              return <React.Fragment key={i}>{part}</React.Fragment>
            })}
          </div>
          {(isLong || assembledContext || syncLabel) && (
            <div className="mine-meta">
              {isLong && (
                <button type="button" className="fold-link" onClick={() => setExpanded(e => !e)}>
                  {expanded ? <><ChevronUp size={12} /> 收起</> : <><ChevronDown size={12} /> 展开全部</>}
                </button>
              )}
              {assembledContext && (
                <button type="button" className="fold-link" onClick={() => setCtxOpen(o => !o)}>
                  {ctxOpen ? <><ChevronUp size={12} /> 收起附带上下文</> : <><ChevronDown size={12} /> 查看附带上下文</>}
                </button>
              )}
              {syncLabel && <span className="sync-tag">{syncLabel}</span>}
            </div>
          )}
          {ctxOpen && assembledContext && (
            <pre className="mine-ctx-pre">{assembledContext}</pre>
          )}
        </div>
        {copyText && (
          <div className={'mine-actions' + (copied ? ' copied' : '')}>
            <button type="button" className="mine-copy-btn" onClick={copyBody} title="复制文字" aria-label="复制文字">
              {copied ? <Check size={13} /> : <Copy size={13} />}
              <span>{copied ? '已复制' : '复制'}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  )
})

function LiveTimer({ startTime }: { startTime: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(id)
  }, [])
  return <>{formatDuration(now - startTime)}</>
}

const AgentMessage = React.memo(function AgentMessage({
  m, roomId, projectDir, isLatest, onStop, onRetry, onContinue, onForward, onPreviewFile, onOpenLightbox, onFileContextMenu
}: {
  m: Msg
  roomId: string
  projectDir?: string
  isLatest?: boolean
  onStop: (agent: Agent) => void
  onRetry: (agent: Agent, msgId: string) => void
  onContinue: (agent: Agent) => void
  onForward: (from: string, to: Agent, body: string) => void
  onPreviewFile: (targetPath: string) => void
  onOpenLightbox: (items: LightboxImageItem[], index: number) => void
  onFileContextMenu: (e: React.MouseEvent, absPath: string, allowPreview?: boolean) => void
}) {
  const [copied, setCopied] = useState(false)
  const agent = allAgents.find(a => a === m.author)
  const cls = agent ? agentClass[agent] : 'codex'
  const isRunning = m.status === '执行中'
  // 中断 = app quit mid-run (set on startup), 已停止 = user pressed stop; both are "incomplete".
  const isStopped = m.status === '中断' || m.status === '已停止'
  const isFailed = m.status === '失败' || isStopped
  const isIncomplete = isFailed || (!isRunning && !m.body.trim())
  const syncOnlyLabel = !isRunning && m.log && /^同步自\s+.+\s+客户端$/.test(m.log.trim())
    ? m.log.trim().replace(/\s*客户端$/, '')
    : ''
  const parsed = syncOnlyLabel ? { steps: [], metaTags: [], contextDetail: '' } : parseStepsWithMeta(m.log, !isRunning, m.status === '失败' ? 'error' : isStopped ? 'stopped' : 'done')
  const steps = parsed.steps
  const metaTags = parsed.metaTags
  const contextDetail = parsed.contextDetail
  const timelineSegments = syncOnlyLabel ? null : buildTimelineSegments(m.body, steps)
  const [ctxOpen, setCtxOpen] = useState(false)
  const hasWaiting = isRunning && steps.some(s => s.status === 'waiting')
  const isLongReply = !isRunning && Boolean(m.body) && (m.body.length > 1200 || m.body.split('\n').length > 20)
  const [replyExpanded, setReplyExpanded] = useState<boolean | null>(null)
  const isCollapsed = isLongReply && (replyExpanded === null ? !isLatest : !replyExpanded)

  function copyBody() {
    void navigator.clipboard.writeText(m.body || m.log)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <article className={'msg-agent agent-tinted ' + cls + (isRunning ? ' running' : '')} style={agent ? agentTint(agent) : undefined}>
      <div className="msg-avatar">
        <Icon name={m.author} size={20} />
      </div>
      <div className="msg-content">
        <div className="msg-head">
          <strong className="msg-author">{m.author}</strong>
          <time>
            {new Date(m.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
            {!isRunning && !!m.duration && m.duration > 0 ? ` · ${formatDuration(m.duration)}` : ''}
          </time>
          {metaTags.length > 0 && (contextDetail ? (
            <button
              type="button"
              className={'msg-meta-inline clickable' + (ctxOpen ? ' open' : '')}
              title={metaTags.join(' · ') + '\n点击查看本轮带入的上下文'}
              aria-expanded={ctxOpen}
              onClick={() => setCtxOpen(v => !v)}
            >
              <span className="msg-meta-text">{metaTags.join(' · ')}</span>
              <ChevronDown size={11} className="msg-meta-caret" />
            </button>
          ) : (
            <span className="msg-meta-inline" title={metaTags.join(' · ')}>
              {metaTags.join(' · ')}
            </span>
          ))}
          {syncOnlyLabel && (
            <span className="sync-tag">{syncOnlyLabel}</span>
          )}
          {isRunning && (
            <span className={'status-pill ' + (hasWaiting ? 'waiting' : 'running')}>
              <span className="pulse-dot" />
              {hasWaiting ? '等待确认' : '执行中'} · <LiveTimer startTime={m.time} />
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

        {ctxOpen && contextDetail && (
          <pre className="msg-ctx-detail">{contextDetail}</pre>
        )}

        {timelineSegments ? (
          <>
            <div className={'msg-body-wrap msg-timeline-interleaved' + (isCollapsed ? ' collapsed' : '')}>
              {/* one clipping/fade container for all segments, so collapse cuts the message as a whole */}
              <div className="msg-interleaved-content">
              {timelineSegments.map((seg, idx) =>
                seg.type === 'text' ? (
                  <div key={seg.key} className="timeline-text-seg">
                    <MarkdownView
                      content={seg.content}
                      roomId={roomId}
                      projectDir={projectDir}
                      onPreviewFile={onPreviewFile}
                      onOpenLightbox={onOpenLightbox}
                      onFileContextMenu={onFileContextMenu}
                    />
                  </div>
                ) : (
                  <InlineStepGroup
                    key={seg.key}
                    steps={seg.steps}
                    isActiveGroup={isRunning && (idx === timelineSegments.length - 1 || seg.steps.some(s => s.status === 'running' || s.status === 'waiting'))}
                    defaultExpanded={seg.steps.some(s => s.status === 'error') || (!isRunning && !m.body.trim())}
                    roomId={roomId}
                    onRespondInteraction={payload => api.respondInteraction(payload)}
                    onFocusAntigravity={() => api.focusAntigravity()}
                    onOpenLightbox={onOpenLightbox}
                    onFileContextMenu={onFileContextMenu}
                  />
                )
              )}
              </div>
              {isLongReply && (
                <div className={'msg-fold-bar' + (isCollapsed ? ' overlaid' : '')}>
                  <button
                    type="button"
                    className="msg-fold-btn"
                    onClick={() => setReplyExpanded(isCollapsed)}
                  >
                    {isCollapsed ? <><ChevronDown size={13} /> 展开完整回复</> : <><ChevronUp size={13} /> 收起回复</>}
                  </button>
                </div>
              )}
            </div>
            {!m.body.trim() && !isRunning && agent && (
              <div className="incomplete-bar">
                <span>未返回正文内容</span>
                <button type="button" onClick={() => onContinue(agent)}><ArrowUp size={12} /> 继续</button>
                <button type="button" onClick={() => onRetry(agent, m.id)}><RotateCcw size={12} /> 重试</button>
              </div>
            )}
          </>
        ) : (
          <>
            <ExecutionTimeline
              steps={steps}
              isRunning={isRunning}
              connected={metaTags.some(t => !t.startsWith('上下文 '))}
              hasBody={Boolean(m.body)}
              duration={m.duration}
              defaultExpanded={m.status === '失败' || !m.body}
              roomId={roomId}
              onRespondInteraction={payload => api.respondInteraction(payload)}
              onFocusAntigravity={() => api.focusAntigravity()}
              onOpenLightbox={onOpenLightbox}
              onFileContextMenu={onFileContextMenu}
            />

            {m.body ? (
              <div className={'msg-body-wrap' + (isCollapsed ? ' collapsed' : '')}>
                <MarkdownView
                  content={m.body}
                  roomId={roomId}
                  projectDir={projectDir}
                  onPreviewFile={onPreviewFile}
                  onOpenLightbox={onOpenLightbox}
                  onFileContextMenu={onFileContextMenu}
                />
                {isLongReply && (
                  <div className={'msg-fold-bar' + (isCollapsed ? ' overlaid' : '')}>
                    <button
                      type="button"
                      className="msg-fold-btn"
                      onClick={() => setReplyExpanded(isCollapsed)}
                    >
                      {isCollapsed ? <><ChevronDown size={13} /> 展开完整回复</> : <><ChevronUp size={13} /> 收起回复</>}
                    </button>
                  </div>
                )}
              </div>
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
          </>
        )}
      </div>
    </article>
  )
}, (prev, next) =>
  prev.roomId === next.roomId &&
  prev.projectDir === next.projectDir &&
  prev.isLatest === next.isLatest &&
  prev.m.id === next.m.id &&
  prev.m.author === next.m.author &&
  prev.m.body === next.m.body &&
  prev.m.log === next.m.log &&
  prev.m.status === next.m.status &&
  prev.m.duration === next.m.duration &&
  prev.m.time === next.m.time &&
  prev.m.attachments === next.m.attachments
)

function App({ dark, onToggleTheme }: { dark: boolean; onToggleTheme: () => void }) {
  const [tree, setTree] = useState<Tree>()
  const [room, setRoom] = useState(localStorage.getItem('room') || '')
  const [messages, setMessages] = useState<Msg[]>([])
  const [messagesRoom, setMessagesRoom] = useState('')
  const [drafts, setDrafts] = useState<Record<string, string>>(() => loadJson('ominihive:drafts', {}))
  const [defaultTargets, setDefaultTargets] = useState<Agent[]>(() => {
    const saved = loadJson<Agent[]>('ominihive:targets', [])
    const valid = Array.isArray(saved) ? saved.filter(a => allAgents.includes(a)) : []
    if (valid.length) return valid
    const legacy = localStorage.getItem('ominihive:target') as Agent
    return allAgents.includes(legacy) ? [legacy] : ['Codex']
  })
  const [roomTargetsMap, setRoomTargetsMap] = useState<Record<string, Agent[]>>(() => loadJson('ominihive:room-targets', {}))
  const {
    accessModes, setAccessModes, providers, setProviders, selected, setSelected,
    efforts, setEfforts, freshSessions, setFreshSessions, catalog, hints, loadModels,
    buildPrefs: buildPrefsFor
  } = useAgentPrefs()
  const [inspected, setInspected] = useState<Agent>(() => defaultTargets[0] || 'Codex')
  const [draftImages, setDraftImages] = useState<Record<string, ImageDraft[]>>({})
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
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewData, setPreviewData] = useState<PreviewResult | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewErr, setPreviewErr] = useState('')
  const [lightbox, setLightbox] = useState<{ items: LightboxImageItem[]; index: number } | null>(null)
  const [fileMenu, setFileMenu] = useState<{ x: number; y: number; path: string; allowPreview: boolean; isImage: boolean; dataUrl?: string } | null>(null)
  const [copyToast, setCopyToast] = useState('')
  const [enabledAgents, setEnabledAgents] = useState<Record<string, boolean>>(() => loadJson('ominihive:enabled', { Codex: true, Claude: true, Antigravity: true }))
  const [roomMembersMap, setRoomMembersMap] = useState<Record<string, Agent[]>>(() => loadJson('ominihive:room-members', {}))
  const [membersOpen, setMembersOpen] = useState(false)
  const [syncing, setSyncing] = useState(false)
  // auto-sends each room's head once its target agents are idle (dispatchPayload is hoisted)
  const sendQueue = useSendQueue<Agent>(tree?.running, item => dispatchPayload({ ...item, restoreOnFail: false }))
  const queuedByRoom = sendQueue.queuedByRoom

  // 统一已启用 Agent 判定（与设置页 Switch 默认值完全一致）
  const enabledPool = (() => {
    const list = allAgents.filter(a => {
      const installed = Boolean(tree?.agents[a])
      const enabled = enabledAgents[a] ?? installed
      return tree ? (installed && enabled) : enabled
    })
    return list.length ? list : coreAgents
  })()

  const defaultRoomMembers = (() => {
    const core = coreAgents.filter(a => enabledPool.includes(a))
    if (core.length) return core
    return enabledPool.slice(0, 3)
  })()

  const roomMessages = messagesRoom === room ? messages : []

  const agents = (() => {
    const saved = room ? roomMembersMap[room] : undefined
    if (saved?.length) {
      const valid = saved.filter(a => allAgents.includes(a) && (!tree || tree.agents[a]))
      if (valid.length) return valid
    }
    const fromHistory = Array.from(new Set(
      roomMessages
        .map(m => m.author as Agent)
        .filter(a => allAgents.includes(a) && (!tree || tree.agents[a]))
    ))
    const merged = [...defaultRoomMembers]
    for (const a of fromHistory) if (!merged.includes(a)) merged.push(a)
    return merged.length ? merged : coreAgents
  })()

  const targets: Agent[] = (() => {
    const saved = room ? roomTargetsMap[room] : undefined
    const validSaved = Array.isArray(saved) ? saved.filter(a => agents.includes(a)) : []
    if (validSaved.length) return validSaved
    const inferred = inferLastTargets(roomMessages, agents)
    if (inferred.length) return inferred
    const fallback = defaultTargets.filter(a => agents.includes(a))
    return fallback.length ? fallback : [agents[0] || 'Codex']
  })()

  function updateTargets(next: Agent[] | ((prev: Agent[]) => Agent[]), targetRoom = room) {
    const raw = typeof next === 'function' ? next(targets) : next
    const clean = Array.from(new Set(raw.filter(a => allAgents.includes(a))))
    if (!clean.length) return
    setDefaultTargets(clean)
    localStorage.setItem('ominihive:targets', JSON.stringify(clean))
    if (targetRoom) {
      setRoomTargetsMap(prev => {
        const updated = { ...prev, [targetRoom]: clean }
        localStorage.setItem('ominihive:room-targets', JSON.stringify(updated))
        return updated
      })
    }
    setInspected(prev => clean.includes(prev) ? prev : clean[0])
  }

  function updateRoomMembers(next: Agent[]) {
    if (!room || !next.length) return
    setRoomMembersMap(prev => {
      const updated = { ...prev, [room]: next }
      localStorage.setItem('ominihive:room-members', JSON.stringify(updated))
      return updated
    })
    const kept = targets.filter(a => next.includes(a))
    updateTargets(kept.length ? kept : [next[0]], room)
  }

  const [editingRoom, setEditingRoom] = useState('')
  const [editTitle, setEditTitle] = useState('')
  const [editingProject, setEditingProject] = useState('')
  const [editProjectName, setEditProjectName] = useState('')

  useEffect(() => {
    if (!editingProject && !editingRoom) return
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (target?.closest('.rename-input')) return
      const active = document.activeElement as HTMLElement | null
      if (active?.classList.contains('rename-input')) active.blur()
      else {
        setEditingProject('')
        setEditingRoom('')
      }
    }
    document.addEventListener('mousedown', onPointerDown, true)
    return () => document.removeEventListener('mousedown', onPointerDown, true)
  }, [editingProject, editingRoom])
  const [importOpen, setImportOpen] = useState(false)
  const messagesLoadedRef = useRef(false)
  const previewSeqRef = useRef(0)
  // room id -> agents whose run finished there (unread / just finished)
  const [unreadDoneRooms, setUnreadDoneRooms] = useState<Record<string, string[]>>({})
  const [justDoneRooms, setJustDoneRooms] = useState<Record<string, string[]>>({})
  const prevRunningRef = useRef<Set<string>>(new Set())
  const doneTimersRef = useRef<Record<string, number>>({})


  const current = tree?.rooms.find(r => r.id === room)
  const project = tree?.projects.find(p => p.id === current?.project)
  const input = drafts[room] || ''
  const images = draftImages[room] || []

  function setImages(next: ImageDraft[] | ((prev: ImageDraft[]) => ImageDraft[]), targetRoom: string = room) {
    if (!targetRoom) return
    setDraftImages(prev => {
      const cur = prev[targetRoom] || []
      const resolved = typeof next === 'function' ? next(cur) : next
      if (resolved.length === 0) {
        if (!(targetRoom in prev)) return prev
        const copy = { ...prev }
        delete copy[targetRoom]
        return copy
      }
      return { ...prev, [targetRoom]: resolved }
    })
  }

  const sentHistory = useMemo(() => {
    const out: string[] = []
    for (const m of roomMessages) {
      if (m.author !== '我') continue
      const { display } = parseUserBody(m.body)
      const cleaned = display.replace(LEADING_MENTIONS_RE, '').trim()
      const text = cleaned || display.trim()
      if (text) out.push(text)
    }
    return out
  }, [roomMessages])
  const historyIdxRef = useRef(-1)
  const historyDraftRef = useRef('')
  useEffect(() => {
    historyIdxRef.current = -1
    historyDraftRef.current = ''
  }, [room])

  const textarea = useRef<HTMLTextAreaElement>(null)
  const composerInputWrapRef = useRef<HTMLDivElement>(null)
  const slashMenuRef = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const timelineShellRef = useRef<HTMLDivElement>(null)
  // One-shot bottom scroll (room switch / user send); never fight user scrolling during streaming.
  const scrollToBottomPending = useRef(true)
  const prevMentionsRef = useRef<Agent[]>([])

  const readyAgents = tree ? agents.filter(a => tree.agents[a]) : agents
  const parsedMentions = parseMentionedAgents(input, readyAgents.length ? readyAgents : agents)
  const scopedTargets = targets.filter(a => agents.includes(a))
  const activeTargets = parsedMentions.agents.length
    ? parsedMentions.agents
    : (scopedTargets.length ? scopedTargets : [agents[0] || 'Codex'])
  const isAllMode = parsedMentions.isAll || (activeTargets.length >= readyAgents.length && readyAgents.length > 1)
  const target = activeTargets[0] || agents[0] || 'Codex'
  const agent = activeTargets.includes(inspected) ? inspected : target
  const mentionKey = parsedMentions.agents.join(',')
  useEffect(() => {
    const prev = prevMentionsRef.current
    const curr = parsedMentions.agents
    const added = curr.filter(a => !prev.includes(a))
    if (added.length) {
      setInspected(added[added.length - 1])
    } else if (curr.length && !curr.includes(inspected)) {
      setInspected(curr[curr.length - 1])
    }
    prevMentionsRef.current = curr
  }, [mentionKey])
  const agentAccess: AccessMode = accessModes[agent] || 'read-only'
  const agentWrite = agentAccess !== 'read-only'
  const agentSessionKey = room + ':' + agent
  const hasExistingSession = Boolean(
    room && (tree?.sessions || []).some(s => s.room === room && (s.agent === agent || s.agent.startsWith(agent + ':')))
  )
  const agentFresh = Boolean(freshSessions[agentSessionKey])
  const anyWrite = activeTargets.some(a => (accessModes[a] || 'read-only') !== 'read-only')
  const composerAccess: AccessMode = activeTargets.some(a => (accessModes[a] || 'read-only') === 'full')
    ? 'full'
    : anyWrite ? 'workspace' : 'read-only'
  const runningInRoom = (tree?.running || []).filter(j => j.room === room)
  const busyAgents = new Set<Agent>([
    ...runningInRoom.map(j => j.agent),
    ...(roomMessages.filter(m => m.status === '执行中').map(m => m.author as Agent))
  ])
  const anyBusy = busyAgents.size > 0
  const targetBusy = activeTargets.some(a => busyAgents.has(a))

  const mentionOptions: Array<{ id: 'all' | Agent; label: string; desc: string; invite?: boolean }> = (() => {
    const q = mention?.query || ''
    const inRoomList: Array<{ id: 'all' | Agent; label: string; desc: string; invite?: boolean }> = [
      ...(readyAgents.length > 1 ? [{ id: 'all' as const, label: '@all', desc: `全体 (${readyAgents.length})` }] : []),
      ...agents.map(a => ({
        id: a as 'all' | Agent,
        label: '@' + a,
        desc: tree?.agents[a] ? '' : '未安装'
      }))
    ].filter(o => !q || (o.id === 'all' ? 'all'.startsWith(q.toLowerCase()) : agentMatchesQuery(o.id, q)))

    const extraInvite = q
      ? enabledPool
          .filter(a => !agents.includes(a) && agentMatchesQuery(a, q))
          .map(a => ({ id: a as 'all' | Agent, label: '@' + a, desc: '拉入并 @', invite: true }))
      : []

    return [...inRoomList, ...extraInvite]
  })()

  function setInput(val: string) {
    if (!room) return
    setDrafts(prev => (prev[room] === val ? prev : { ...prev, [room]: val }))
  }

  useEffect(() => {
    const t = setTimeout(() => {
      try { localStorage.setItem('ominihive:drafts', JSON.stringify(drafts)) } catch {}
    }, 400)
    return () => clearTimeout(t)
  }, [drafts])

  useEffect(() => {
    localStorage.setItem('ominihive:enabled', JSON.stringify(enabledAgents))
  }, [enabledAgents])

  useEffect(() => {
    void api.ccSwitch().then(setCcSwitch).catch(() => {})
  }, [])

  useEffect(() => {
    let alive = true
    void api.agentSkills(room).then(res => { if (alive) setAgentSkills(res) }).catch(() => {})
    return () => { alive = false }
  }, [room, project?.id])

  // A preview or lightbox belongs to the room it was opened in; relative links would
  // otherwise resolve against the next room's project.
  useEffect(() => {
    previewSeqRef.current++
    setPreviewOpen(false)
    setPreviewData(null)
    setPreviewErr('')
    setPreviewLoading(false)
    setLightbox(null)
  }, [room])

  const runningKey = (tree?.running || []).map(j => runKey(j.room, j.agent)).sort().join('|')
  useEffect(() => {
    const running = tree?.running || []
    const finished = finishedAgentsByRoom(prevRunningRef.current, running)
    prevRunningRef.current = new Set(running.map(j => runKey(j.room, j.agent)))
    const finishedRooms = Object.keys(finished)
    if (!finishedRooms.length) return
    const focused = document.hasFocus()
    const merge = (old: Record<string, string[]>, rId: string) => {
      const prevList = old[rId] || []
      const add = finished[rId].filter(a => !prevList.includes(a))
      return add.length ? [...prevList, ...add] : prevList
    }
    setUnreadDoneRooms(old => {
      let changed = false
      const next = { ...old }
      for (const rId of finishedRooms) {
        if (rId === room && focused) continue
        const merged = merge(old, rId)
        if (merged !== old[rId]) { next[rId] = merged; changed = true }
      }
      return changed ? next : old
    })
    setJustDoneRooms(old => {
      const next = { ...old }
      for (const rId of finishedRooms) next[rId] = merge(old, rId)
      return next
    })
    for (const rId of finishedRooms) {
      if (doneTimersRef.current[rId]) window.clearTimeout(doneTimersRef.current[rId])
      doneTimersRef.current[rId] = window.setTimeout(() => {
        delete doneTimersRef.current[rId]
        setJustDoneRooms(old => {
          if (!old[rId]) return old
          const next = { ...old }
          delete next[rId]
          return next
        })
      }, 2400)
    }
  }, [runningKey, room])

  useEffect(() => {
    if (!room) return
    setUnreadDoneRooms(old => {
      if (!old[room]) return old
      const next = { ...old }
      delete next[room]
      return next
    })
  }, [room])

  useEffect(() => {
    const onFocus = () => {
      if (!room) return
      setUnreadDoneRooms(old => {
        if (!old[room]) return old
        const next = { ...old }
        delete next[room]
        return next
      })
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [room])

  useEffect(() => {
    if (!room) return
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void api.syncRoom(room).catch(() => {})
    }, 15000)
    return () => clearInterval(t)
  }, [room])

  useEffect(() => {
    if (project?.id) setExpandedProjects(prev => (prev[project.id] ? prev : { ...prev, [project.id]: true }))
  }, [project?.id])

  useEffect(() => {
    localStorage.setItem('ominihive:files', showFiles ? '1' : '0')
  }, [showFiles])

  useEffect(() => {
    if (!error) return
    const t = setTimeout(() => setError(''), 6000)
    return () => clearTimeout(t)
  }, [error])

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
  const slashQuery = slash?.query || ''
  const slashOptions = [
    ...ownSkills.map(s => ({
      id: 'ag:' + s.id,
      title: s.name,
      searchTitle: s.name,
      searchDesc: s.description || '',
      desc: s.source + (s.description ? ' · ' + s.description : ''),
      text: agent === 'Antigravity' ? `请加载并使用技能 ${s.name}：\n` : `$${s.name} `
    })),
    ...(ccSwitch?.prompts || []).map(p => ({
      id: 'p:' + p.id,
      title: p.name,
      searchTitle: p.name,
      searchDesc: p.description || '',
      desc: 'CC Switch · ' + p.appType + (p.description ? ' · ' + p.description : ''),
      text: p.content
    })),
    ...(ccSwitch?.skills || []).map(s => ({
      id: 's:' + s.id,
      title: 'Skill: ' + s.name,
      searchTitle: s.name,
      searchDesc: s.description || '',
      desc: 'CC Switch · ' + (s.agents.join('/') || '已启用') + (s.description ? ' · ' + s.description : ''),
      text: `请使用技能 ${s.name}：\n`
    }))
  ]
    .map(o => ({ ...o, score: scoreSlashOption(o.searchTitle, o.searchDesc, slashQuery) }))
    .filter(o => o.score > 0)
    .sort((a, b) => (slashQuery ? b.score - a.score : 0) || a.searchTitle.localeCompare(b.searchTitle))

  useEffect(() => {
    if (!slash) return
    const el = slashMenuRef.current?.querySelector<HTMLElement>('button.focused')
    el?.scrollIntoView({ block: 'nearest' })
  }, [slashIdx, slashQuery, Boolean(slash)])

  useEffect(() => {
    // Change events arrive up to ~16/s while agents stream. Keep one request in flight,
    // coalesce the rest into a single trailing refresh, and fetch only changed messages
    // so unchanged rows keep their object identity (memoized rows skip re-rendering).
    let alive = true, inflight = false, pending = false
    let byId = new Map<string, Msg>()
    let sigs: Record<string, string> = {}
    let lastTreeJson = ''
    async function refresh() {
      if (inflight) { pending = true; return }
      inflight = true
      try {
        const [t, delta] = await Promise.all([api.tree(), room ? api.messagesDelta(room, sigs) : Promise.resolve({ ids: [], rows: [] })])
        if (!alive) return
        const treeJson = JSON.stringify(t)
        if (treeJson !== lastTreeJson) { lastTreeJson = treeJson; setTree(t) }
        const nextById = new Map<string, Msg>()
        const nextSigs: Record<string, string> = {}
        for (const row of delta.rows) {
          const { sig, ...msg } = row
          nextById.set(msg.id, msg)
          nextSigs[msg.id] = sig
        }
        let changed = delta.rows.length > 0 || delta.ids.length !== byId.size
        const list: Msg[] = []
        for (const id of delta.ids) {
          const msg = nextById.get(id) || byId.get(id)
          if (!msg) continue
          if (!nextById.has(id)) { nextById.set(id, msg); nextSigs[id] = sigs[id] }
          list.push(msg)
        }
        if (!changed) changed = list.some((m, i) => m.id !== delta.ids[i])
        byId = nextById
        sigs = nextSigs
        if (changed || !messagesLoadedRef.current) { setMessages(list); messagesLoadedRef.current = true }
        setMessagesRoom(room)
        if (!t.rooms.some(r => r.id === room) && t.rooms.length) setRoom(t.rooms[0].id)
      } catch (e) {
        if (alive) setError(cleanError(e))
      } finally {
        inflight = false
        if (alive && pending) { pending = false; void refresh() }
      }
    }
    messagesLoadedRef.current = false
    void refresh()
    const off = api.listen(() => void refresh())
    return () => { alive = false; off() }
  }, [room])

  useEffect(() => {
    localStorage.setItem('room', room)
    setMention(null)
    setSlash(null)
    setError('')
    scrollToBottomPending.current = true
  }, [room])

  useEffect(() => {
    if (scrollToBottomPending.current && messagesRoom === room && scroll.current) {
      scroll.current.scrollTop = scroll.current.scrollHeight
      scrollToBottomPending.current = false
    }
  }, [messages, messagesRoom, room])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'n' || e.key === 'N') { e.preventDefault(); void newRoom() }
      else if (e.key === 'o' || e.key === 'O') { e.preventDefault(); void add() }
      else if (e.key === '/') { e.preventDefault(); setCollapsed(c => !c) }
      else if (e.key === '.') { e.preventDefault(); if (room && anyBusy) void api.stop(room) }
      else if (e.key === '1') { e.preventDefault(); updateTargets(['Codex']) }
      else if (e.key === '2') { e.preventDefault(); updateTargets(['Claude']) }
      else if (e.key === '3') { e.preventDefault(); updateTargets(['Antigravity']) }
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

  async function commitRenameProject(id: string) {
    const name = editProjectName.trim()
    setEditingProject('')
    if (!name) return
    try { await api.renameProject(id, name) }
    catch (e) { setError(cleanError(e)) }
  }

  async function renameRoom(id: string, rawTitle: string) {
    const title = rawTitle.trim()
    if (!title) return
    try { await api.renameRoom(id, title) }
    catch (e) { setError(cleanError(e)) }
  }

  /** Sidebar inline rename of a discussion. */
  async function commitRename(id: string) {
    setEditingRoom('')
    await renameRoom(id, editTitle)
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
    const m = before.match(/(?:^|\s)@([a-z0-9_-]*)$/i)
    const exactKnown = m && (m[1].toLowerCase() === 'all' || allAgents.some(a => a.toLowerCase() === m[1].toLowerCase()))
    if (m && !exactKnown) {
      setMention({ start: pos - m[1].length - 1, end: pos, query: m[1] })
      setMentionIdx(0)
      setSlash(null)
      return
    }
    setMention(null)
    const s = before.match(/(?:^|[^a-zA-Z0-9._:/\\-])\/([^\s]*)$/)
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
    if (choice !== 'all') {
      if (!agents.includes(choice)) updateRoomMembers([...agents, choice])
      setInspected(choice)
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

  function toggleAgent(a: Agent, multi: boolean, focusInput = true) {
    setInspected(a)
    if (parsedMentions.agents.length) {
      if (parsedMentions.agents.includes(a)) {
        if (focusInput) textarea.current?.focus()
        return
      }
      const nextText = '@' + a + ' ' + input.trimStart()
      setInput(nextText)
      if (focusInput) textarea.current?.focus()
      return
    }
    if (multi) {
      updateTargets(prev => {
        if (prev.includes(a)) return prev.length > 1 ? prev.filter(x => x !== a) : prev
        return [...prev, a]
      })
    } else {
      updateTargets([a])
    }
    if (focusInput) textarea.current?.focus()
  }

  function toggleAll(focusInput = true) {
    const pool = readyAgents.length ? readyAgents : agents
    updateTargets(prev => prev.length >= pool.length ? [prev[0] || 'Codex'] : [...pool])
    if (focusInput) textarea.current?.focus()
  }

  function buildPrefs(forRoom: string = room, extraAgents: Agent[] = []): AgentPrefs {
    return buildPrefsFor(agents, forRoom, extraAgents)
  }

  async function addImageFiles(files: FileList | File[]) {
    const targetRoom = room
    if (!targetRoom) return
    const all = Array.from(files)
    const list = all.slice(0, Math.max(0, 8 - images.length))
    if (list.length < all.length) setError(`每条消息最多 8 个附件，已忽略 ${all.length - list.length} 个`)
    for (const file of list) {
      if (file.size > 25 * 1024 * 1024) {
        setError(`文件「${file.name}」超过 25MB 限制`)
        continue
      }
      const isImage = file.type.startsWith('image/')
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result || ''))
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(file)
      })
      if (dataUrl) {
        setImages(prev => prev.length >= 8 ? prev : [...prev, { id: Math.random().toString(36).slice(2), name: file.name || (isImage ? 'image.png' : 'file'), dataUrl, isImage }], targetRoom)
      }
    }
  }

  const roomQueue = room ? (queuedByRoom[room] || []) : []

  function resolveCurrentDraft() {
    const defaultAttText = images.length && images.every(i => i.isImage) ? '请查看附带的图片' : '请查看附带的文件'
    const raw = input || (images.length ? defaultAttText : '')
    if (!raw.trim() || !room) return null
    const pool = readyAgents.length ? readyAgents : agents
    const sendTargets: Agent[] | 'all' = parsedMentions.isAll
      ? 'all'
      : (parsedMentions.agents.length ? parsedMentions.agents : activeTargets)
    const targetList: Agent[] = sendTargets === 'all' ? pool : sendTargets
    return {
      id: 'q-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      room,
      raw,
      targets: sendTargets,
      targetList,
      images: images.map(i => ({ name: i.name, dataUrl: i.dataUrl }))
    }
  }

  async function dispatchPayload(payload: {
    room: string
    raw: string
    targets: Agent | Agent[] | 'all'
    targetList: Agent[]
    images: { name: string; dataUrl: string }[]
    restoreOnFail?: boolean
  }) {
    setError('')
    setMention(null)
    setSlash(null)
    if (payload.targetList.length) updateTargets(payload.targetList, payload.room)
    if (payload.room === room) scrollToBottomPending.current = true
    try {
      await api.send(payload.room, payload.raw, agentWrite, buildPrefs(payload.room, payload.targetList), effort, payload.targets, payload.images)
      setFreshSessions(prev => {
        let changed = false
        const next = { ...prev }
        for (const a of payload.targetList) {
          const k = payload.room + ':' + a
          if (next[k]) { delete next[k]; changed = true }
        }
        return changed ? next : prev
      })
      return true as const
    } catch (e) {
      const message = cleanError(e)
      setError(message)
      if (payload.restoreOnFail) {
        setDrafts(prev => (prev[payload.room] ? prev : { ...prev, [payload.room]: payload.raw }))
        if (payload.images.length) {
          setImages(prev => prev.length ? prev : payload.images.map(img => ({
            id: Math.random().toString(36).slice(2),
            name: img.name,
            dataUrl: img.dataUrl,
            isImage: img.dataUrl.startsWith('data:image/')
          })), payload.room)
        }
      }
      return message || '发送失败'
    }
  }

  function enqueueCurrent() {
    const item = resolveCurrentDraft()
    if (!item) return
    historyIdxRef.current = -1
    historyDraftRef.current = ''
    setInput('')
    setImages([])
    setMention(null)
    setSlash(null)
    sendQueue.enqueue(item)
  }

  async function interruptAndSend(queuedItem?: QueuedMessage<Agent>) {
    const item = queuedItem || resolveCurrentDraft()
    if (!item) return
    if (!queuedItem) {
      historyIdxRef.current = -1
      historyDraftRef.current = ''
      setInput('')
      setImages([])
      setMention(null)
      setSlash(null)
    }
    // Put at the front of the room queue so it fires immediately once the interrupted agent stops.
    sendQueue.prioritize(item)
    const runningSet = new Set((tree?.running || []).filter(j => j.room === item.room).map(j => j.agent))
    const toStop = item.targetList.filter(a => runningSet.has(a))
    if (toStop.length) {
      await Promise.all(toStop.map(a => api.stop(item.room, a).catch(() => {})))
    }
  }

  function cancelQueued(roomId: string, itemId: string, restore = false) {
    const target = sendQueue.remove(roomId, itemId)
    if (restore && target) {
      // Merge into whatever is already being typed instead of silently discarding the queued text.
      setDrafts(prev => {
        const cur = prev[roomId] || ''
        return { ...prev, [roomId]: cur.trim() ? cur.trimEnd() + '\n' + target.raw : target.raw }
      })
      if (target.images?.length) {
        setImages(prev => [...prev, ...target.images.map(img => ({
          id: Math.random().toString(36).slice(2),
          name: img.name,
          dataUrl: img.dataUrl,
          isImage: img.dataUrl.startsWith('data:image/')
        }))].slice(0, 8), roomId)
      }
    }
  }

  async function send(overrideText?: string, overrideTarget?: Agent | Agent[] | 'all') {
    const defaultAttText = images.length && images.every(i => i.isImage) ? '请查看附带的图片' : '请查看附带的文件'
    const raw = (overrideText ?? input) || (images.length ? defaultAttText : '')
    if (!raw.trim() || !room) return
    const pool = readyAgents.length ? readyAgents : agents
    const parsedRaw = overrideText ? parseMentionedAgents(raw, pool) : parsedMentions
    const sendTargets = overrideTarget ?? (parsedRaw.isAll ? pool : (parsedRaw.agents.length ? parsedRaw.agents : activeTargets))
    const sentList: Agent[] = sendTargets === 'all'
      ? pool
      : (Array.isArray(sendTargets) ? sendTargets : [sendTargets])
    // If any target agent is currently busy and this is a normal user send, enqueue automatically.
    if (!overrideText && sentList.some(a => busyAgents.has(a))) {
      enqueueCurrent()
      return
    }
    const sendImages = overrideText ? [] : images.map(i => ({ name: i.name, dataUrl: i.dataUrl }))
    if (!overrideText) {
      historyIdxRef.current = -1
      historyDraftRef.current = ''
      setInput('')
      setImages([])
    }
    await dispatchPayload({
      room,
      raw,
      targets: sendTargets,
      targetList: sentList,
      images: sendImages,
      restoreOnFail: !overrideText
    })
  }

  function handleRetry(a: Agent, msgId: string) {
    // Retry the user message that triggered this reply (the nearest one before it).
    const idx = roomMessages.findIndex(m => m.id === msgId)
    if (idx < 0) return
    const lastUser = [...roomMessages.slice(0, idx)].reverse().find(m => m.author === '我')
    if (!lastUser) return
    // Synced messages may carry the <group_context>/<user_task> envelope; resend only the task.
    const task = parseUserBody(lastUser.body).display.replace(LEADING_MENTIONS_RE, '').trim()
    if (task) void send('@' + a + ' ' + task, a)
  }

  function handleContinue(a: Agent) {
    void send('@' + a + ' 请继续完成刚才中断或未完成的任务，并给出完整结果。', a)
  }

  function handleForward(from: string, to: Agent, body: string) {
    updateTargets([to])
    const snippet = body.slice(0, 600) + (body.length > 600 ? '…' : '')
    setInput(`请评审上面 ${from} 的结论并给出你的建议：\n> ${snippet.split('\n')[0]}`)
    textarea.current?.focus()
  }

  useEffect(() => {
    if (!copyToast) return
    const t = setTimeout(() => setCopyToast(''), 1800)
    return () => clearTimeout(t)
  }, [copyToast])

  useEffect(() => {
    if (!fileMenu) return
    const close = () => setFileMenu(null)
    // Capture phase + stopPropagation: Esc closes only the menu, not a lightbox underneath it.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setFileMenu(null) } }
    window.addEventListener('mousedown', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [fileMenu])

  async function handlePreviewFile(targetPath: string) {
    if (!targetPath) return
    // Only the latest request may update the panel (a slow large file must not replace a newer one).
    const seq = ++previewSeqRef.current
    setPreviewOpen(true)
    setPreviewLoading(true)
    setPreviewErr('')
    try {
      const res = await api.previewFile(room, targetPath)
      if (seq !== previewSeqRef.current) return
      setPreviewData(res)
    } catch (e) {
      if (seq !== previewSeqRef.current) return
      setPreviewData(null)
      setPreviewErr(cleanError(e))
    } finally {
      if (seq === previewSeqRef.current) setPreviewLoading(false)
    }
  }

  /** `extra.dataUrl` lets in-memory images (composer drafts) offer "copy image" without a file path. */
  function handleFileContextMenu(e: React.MouseEvent, absPath: string, allowPreview = true, extra?: { dataUrl?: string }) {
    const dataUrl = extra?.dataUrl
    if (!absPath && !dataUrl) return
    e.preventDefault()
    e.stopPropagation()
    const isImage = Boolean(dataUrl) || IMAGE_PATH_RE.test(absPath)
    const itemCount = (isImage ? 1 : 0) + (absPath ? 3 + (allowPreview ? 1 : 0) : 0)
    const menuW = 180
    const menuH = itemCount * 34 + 6
    const x = Math.min(e.clientX, window.innerWidth - menuW - 8)
    const y = Math.min(e.clientY, window.innerHeight - menuH - 8)
    setFileMenu({ x: Math.max(8, x), y: Math.max(8, y), path: absPath, allowPreview: allowPreview && Boolean(absPath), isImage, dataUrl })
  }

  async function copyImageFromMenu(menu: { path: string; dataUrl?: string }) {
    setFileMenu(null)
    try {
      await copyImageToClipboard({ path: menu.path, dataUrl: menu.dataUrl }, room)
      setCopyToast('已复制图片')
    } catch (err) {
      setCopyToast(cleanError(err))
    }
  }

  function copyAbsPath(absPath: string) {
    if (!absPath) return
    void navigator.clipboard.writeText(absPath)
    setCopyToast('已复制绝对路径')
    setFileMenu(null)
  }

  function handleOpenLightbox(items: LightboxImageItem[], index: number) {
    if (!items.length) return
    setLightbox({ items, index: Math.max(0, Math.min(index, items.length - 1)) })
  }

  // AgentMessage is memoized and ignores callback identity, so hand it stable wrappers
  // that always call the latest handlers (otherwise retry/continue on an old message
  // would send with stale access modes / models captured at that message's last render).
  const latestHandlers = useRef({ handleRetry, handleContinue, handleForward, handlePreviewFile, handleOpenLightbox, handleFileContextMenu })
  latestHandlers.current = { handleRetry, handleContinue, handleForward, handlePreviewFile, handleOpenLightbox, handleFileContextMenu }
  const messageHandlers = useMemo(() => ({
    onRetry: (a: Agent, msgId: string) => latestHandlers.current.handleRetry(a, msgId),
    onContinue: (a: Agent) => latestHandlers.current.handleContinue(a),
    onForward: (from: string, to: Agent, body: string) => latestHandlers.current.handleForward(from, to, body),
    onPreviewFile: (targetPath: string) => { void latestHandlers.current.handlePreviewFile(targetPath) },
    onOpenLightbox: (items: LightboxImageItem[], index: number) => latestHandlers.current.handleOpenLightbox(items, index),
    onFileContextMenu: (e: React.MouseEvent, absPath: string, allowPreview = true, extra?: { dataUrl?: string }) => latestHandlers.current.handleFileContextMenu(e, absPath, allowPreview, extra)
  }), [])

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

          <ScrollArea className="sidebar-scroll" insetTop={4} insetBottom={4}>
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
              const projRoomIds = new Set(projRooms.map(r => r.id))
              const projRunningAgents = [...new Set((tree.running || []).filter(j => projRoomIds.has(j.room)).map(j => j.agent))]
              const projDoneAgents = [...new Set(projRooms.flatMap(r => [...(unreadDoneRooms[r.id] || []), ...(justDoneRooms[r.id] || [])]))]
              const projJustDone = [...new Set(projRooms.flatMap(r => justDoneRooms[r.id] || []))]
              return (
                <section key={p.id} className="project-group">
                  <div className={'navrow projectrow ' + (isOpen ? 'open' : '') + (isCurrentProj ? ' current' : '')}>
                    {editingProject === p.id ? (
                      <input
                        className="rename-input"
                        autoFocus
                        value={editProjectName}
                        onChange={e => setEditProjectName(e.target.value)}
                        onBlur={() => void commitRenameProject(p.id)}
                        onKeyDown={e => {
                          if (e.key === 'Enter' && !e.nativeEvent.isComposing) void commitRenameProject(p.id)
                          if (e.key === 'Escape') setEditingProject('')
                        }}
                      />
                    ) : (
                      <>
                        <button
                          type="button"
                          className="project"
                          title={p.dir + ' · 点击展开或收起'}
                          onClick={() => setExpandedProjects(prev => ({ ...prev, [p.id]: !isOpen }))}
                        >
                          <ChevronRight size={13} className={'proj-caret ' + (isOpen ? 'open' : '')} />
                          {isOpen ? <FolderOpen size={15} /> : <Folder size={15} />}
                          <span>{p.name}</span>
                          <AgentStatusDots running={projRunningAgents} done={projDoneAgents} justDone={projJustDone} scope="项目中" />
                        </button>
                        <div className="row-actions">
                          <button
                            type="button"
                            className="row-action"
                            title="修改项目名称"
                            aria-label="修改项目名称"
                            onClick={e => { e.stopPropagation(); setEditingProject(p.id); setEditProjectName(p.name) }}
                          >
                            <Pencil size={12} />
                          </button>
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
                      </>
                    )}
                  </div>
                  {isOpen && (
                    <div className="rooms">
                      {projRooms.map(r => {
                        const roomJobs = (tree.running || []).filter(j => j.room === r.id)
                        const roomJustDone = justDoneRooms[r.id] || []
                        const roomDoneAgents = [...new Set([...(unreadDoneRooms[r.id] || []), ...roomJustDone])]
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
                                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) void commitRename(r.id)
                                  if (e.key === 'Escape') setEditingRoom('')
                                }}
                              />
                            ) : (
                              <>
                                <button
                                  type="button"
                                  className="roomlink"
                                  onClick={() => setRoom(r.id)}
                                >
                                  <MessageSquare size={13} />
                                  <TypewriterTitle text={r.title} animate={isAutoTitle(r)} />
                                  <AgentStatusDots running={roomJobs.map(j => j.agent)} done={roomDoneAgents} justDone={roomJustDone} />
                                </button>
                                <div className="row-actions">
                                  <button
                                    type="button"
                                    className="row-action"
                                    title="重命名讨论"
                                    aria-label="重命名讨论"
                                    onClick={e => { e.stopPropagation(); setEditingRoom(r.id); setEditTitle(r.title) }}
                                  >
                                    <Pencil size={12} />
                                  </button>
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
          </ScrollArea>

          <div className="sidebar-foot">
            <Settings
              missingCount={missingCount}
              ccSwitch={ccSwitch}
              enabledAgents={enabledAgents}
              onToggleAgent={(ag, enabled) => setEnabledAgents(prev => ({ ...prev, [ag]: enabled }))}
              providers={providers}
              onProviderChange={(ag, pid) => setProviders(prev => ({ ...prev, [ag]: pid }))}
            />
            <button
              type="button"
              className="theme-toggle-btn"
              onClick={onToggleTheme}
              title={dark ? '切换到浅色模式' : '切换到深色模式'}
              aria-label={dark ? '切换到浅色模式' : '切换到深色模式'}
            >
              {dark ? <Sun size={15} /> : <Moon size={15} />}
            </button>
          </div>
        </aside>
      )}

      <main>
        <ChatHeader
          collapsed={collapsed}
          onExpandSidebar={() => setCollapsed(false)}
          onNewRoom={() => void newRoom()}
          project={project || null}
          currentRoom={current || null}
          onOpenProjectDir={dir => void api.openPath(dir)}
          members={
            <RoomMembersPicker
              open={membersOpen}
              onOpenChange={setMembersOpen}
              members={agents}
              availableMap={tree?.agents || {}}
              enabledAgents={enabledAgents}
              onChangeMembers={updateRoomMembers}
              onEnableAgent={a => setEnabledAgents(prev => ({ ...prev, [a]: true }))}
            />
          }
          syncing={syncing}
          onSyncRoom={async () => {
            if (!room || syncing) return
            setSyncing(true)
            try { await api.syncRoom(room) } finally { setSyncing(false) }
          }}
          showFiles={showFiles}
          onToggleFiles={() => setShowFiles(s => !s)}
          onOpenImport={() => setImportOpen(true)}
        />

        <div className="timeline-shell" ref={timelineShellRef}>
        <div
          className="timeline"
          ref={scroll}
        >
          {messagesRoom === room && !roomMessages.length ? (
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
                          className={'quick-agent-card agent-tinted ' + agentClass[a] + (activeTargets.includes(a) ? ' selected' : '')}
                          style={agentTint(a)}
                          onClick={e => { toggleAgent(a, e.metaKey || e.shiftKey) }}
                        >
                          <Icon name={a} size={20} />
                          <div>
                            <strong>{agentShort(a)}</strong>
                            <span>{available ? '已在群 · 已就绪' : '未检测到 CLI'}</span>
                          </div>
                        </button>
                      )
                    })}
                    <button
                      type="button"
                      className="quick-agent-card invite-card"
                      onClick={() => setMembersOpen(true)}
                    >
                      <UserPlus size={18} />
                      <div>
                        <strong>拉人进群</strong>
                        <span>支持一次多选</span>
                      </div>
                    </button>
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
            <ProjectDirContext.Provider value={project?.dir || ''}>
            <div className="transcript">
              {(() => {
                const lastAgentMsgId = [...roomMessages].reverse().find(x => x.author !== '我')?.id
                return roomMessages.map(m =>
                  m.author === '我'
                    ? (
                      <UserBubble
                        key={m.id}
                        body={m.body}
                        attachments={m.attachments}
                        log={m.log}
                        onPreviewFile={messageHandlers.onPreviewFile}
                        onOpenLightbox={messageHandlers.onOpenLightbox}
                        onFileContextMenu={messageHandlers.onFileContextMenu}
                      />
                    ) : (
                      <AgentMessage
                        key={m.id}
                        m={m}
                        roomId={room}
                        projectDir={project?.dir}
                        isLatest={m.id === lastAgentMsgId}
                        onStop={a => void api.stop(room, a)}
                        onRetry={messageHandlers.onRetry}
                        onContinue={messageHandlers.onContinue}
                        onForward={messageHandlers.onForward}
                        onPreviewFile={messageHandlers.onPreviewFile}
                        onOpenLightbox={messageHandlers.onOpenLightbox}
                        onFileContextMenu={messageHandlers.onFileContextMenu}
                      />
                    )
                )
              })()}
            </div>
            </ProjectDirContext.Provider>
          )}
        </div>
        <OverlayScrollbar targetRef={scroll} hoverRef={timelineShellRef} variant="timeline" insetTop={8} insetBottom={8} />
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
              className={
                'composer ' +
                (composerAccess === 'full' ? 'mode-full' : composerAccess === 'workspace' ? 'mode-workspace' : 'mode-readonly') +
                (anyWrite ? ' write-mode' : '') +
                (dragging ? ' dragging' : '')
              }
              onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true) } }}
              onDragLeave={() => setDragging(false)}
              onDrop={e => {
                e.preventDefault()
                setDragging(false)
                if (e.dataTransfer.files?.length) void addImageFiles(e.dataTransfer.files)
              }}
            >
              <SendQueueBar
                items={roomQueue}
                onSendNow={q => void interruptAndSend(q)}
                onWithdraw={q => cancelQueued(q.room, q.id, true)}
              />
              {images.length > 0 && (
                <div className="draft-imgs">
                  {images.map(img => (
                    img.isImage ? (
                      <div key={img.id} className="draft-img">
                        <button
                          type="button"
                          className="draft-img-open"
                          title={img.name + '（点击查看大图）'}
                          aria-label={'查看大图：' + img.name}
                          onClick={() => {
                            const drafts = images.filter(x => x.isImage)
                            handleOpenLightbox(drafts.map(x => ({ path: '', name: x.name, dataUrl: x.dataUrl })), drafts.findIndex(x => x.id === img.id))
                          }}
                          onContextMenu={e => handleFileContextMenu(e, '', false, { dataUrl: img.dataUrl })}
                        >
                          <img src={img.dataUrl} alt={img.name} draggable={false} />
                        </button>
                        <button type="button" className="draft-img-remove" aria-label="移除附件" onClick={() => setImages(prev => prev.filter(x => x.id !== img.id))}>
                          <X size={11} />
                        </button>
                      </div>
                    ) : (
                      <div key={img.id} className="draft-file" title={img.name}>
                        <FileText size={14} />
                        <span>{img.name}</span>
                        <button type="button" aria-label="移除文件" onClick={() => setImages(prev => prev.filter(x => x.id !== img.id))}>
                          <X size={11} />
                        </button>
                      </div>
                    )
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

              {slash && (
                <div ref={slashMenuRef} className="mention-menu slash-menu">
                  <div className="mention-menu-label">
                    {agent} 专属 Skills & 预设 ({slashOptions.length})
                  </div>
                  <ScrollArea className="slash-menu-list" variant="input" insetTop={4} insetBottom={4}>
                    {slashOptions.length > 0 ? slashOptions.map((opt, idx) => (
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
                    )) : (
                      <div className="slash-empty">未找到与「{slash.query}」匹配的 Skill</div>
                    )}
                  </ScrollArea>
                </div>
              )}

              <div className="composer-input-wrap" ref={composerInputWrapRef}>
              <textarea
                ref={textarea}
                aria-label="任务"
                rows={1}
                placeholder={`给 ${isAllMode ? '全部 Agent' : activeTargets.join('、')} 下达任务…`}
                value={input}
                onPaste={e => {
                  const files = Array.from(e.clipboardData.items)
                    .filter(it => it.kind === 'file')
                    .map(it => it.getAsFile())
                    .filter((f): f is File => Boolean(f))
                  if (files.length) {
                    e.preventDefault()
                    void addImageFiles(files)
                  }
                }}
                onChange={e => {
                  const v = e.target.value
                  historyIdxRef.current = -1
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
                  if (!e.nativeEvent.isComposing && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
                    const el = e.currentTarget
                    const selStart = el.selectionStart
                    const selEnd = el.selectionEnd
                    if (e.key === 'ArrowUp' && sentHistory.length > 0 && selStart === selEnd && !el.value.slice(0, selStart).includes('\n')) {
                      e.preventDefault()
                      if (historyIdxRef.current === -1) {
                        historyDraftRef.current = input
                        historyIdxRef.current = sentHistory.length - 1
                      } else if (historyIdxRef.current > 0) {
                        historyIdxRef.current -= 1
                      }
                      const nextText = sentHistory[historyIdxRef.current]
                      setInput(nextText)
                      setMention(null)
                      setSlash(null)
                      requestAnimationFrame(() => {
                        textarea.current?.setSelectionRange(nextText.length, nextText.length)
                      })
                      return
                    }
                    if (e.key === 'ArrowDown' && historyIdxRef.current !== -1 && selStart === selEnd && !el.value.slice(selEnd).includes('\n')) {
                      e.preventDefault()
                      let nextText: string
                      if (historyIdxRef.current < sentHistory.length - 1) {
                        historyIdxRef.current += 1
                        nextText = sentHistory[historyIdxRef.current]
                      } else {
                        historyIdxRef.current = -1
                        nextText = historyDraftRef.current
                      }
                      setInput(nextText)
                      setMention(null)
                      setSlash(null)
                      requestAnimationFrame(() => {
                        textarea.current?.setSelectionRange(nextText.length, nextText.length)
                      })
                      return
                    }
                  }
                  if (e.key === 'Escape') { setMention(null); setSlash(null); return }
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    if (targetBusy) void interruptAndSend()
                    else void send()
                    return
                  }
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    void send()
                  }
                }}
              />
              <OverlayScrollbar targetRef={textarea} hoverRef={composerInputWrapRef} variant="input" insetTop={4} insetBottom={6} />
              </div>

              <ComposerToolbar
                inspectedAgent={agent}
                targetPicker={
                  <TargetSelector
                    members={agents}
                    activeTargets={activeTargets}
                    isAllMode={isAllMode}
                    busyAgents={busyAgents}
                    inspected={agent}
                    onSelectSingle={a => toggleAgent(a, false, false)}
                    onToggleMulti={a => toggleAgent(a, true, false)}
                    onToggleAll={() => toggleAll(false)}
                    onInspect={setInspected}
                    onOpenInvite={() => setMembersOpen(true)}
                  />
                }
                modelPicker={
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
                }
                access={{ value: agentAccess, onChange: mode => setAccessModes(prev => ({ ...prev, [agent]: mode })) }}
                session={{
                  hasExisting: hasExistingSession,
                  fresh: agentFresh,
                  onToggle: () => {
                    if (!hasExistingSession) return
                    setFreshSessions(prev => ({ ...prev, [agentSessionKey]: !prev[agentSessionKey] }))
                  }
                }}
                onPickFiles={() => fileInput.current?.click()}
                skills={{
                  count: ownSkills.length,
                  onToggle: () => {
                    if (slash) { setSlash(null); return }
                    const pos = textarea.current?.selectionStart ?? input.length
                    const needSpace = pos > 0 && !/\s/.test(input[pos - 1])
                    const prefix = needSpace ? ' /' : '/'
                    const slashPos = pos + (needSpace ? 1 : 0)
                    const next = input.slice(0, pos) + prefix + input.slice(pos)
                    setInput(next)
                    setSlash({ start: slashPos, end: slashPos + 1, query: '' })
                    setSlashIdx(0)
                    requestAnimationFrame(() => {
                      textarea.current?.focus()
                      textarea.current?.setSelectionRange(slashPos + 1, slashPos + 1)
                    })
                  }
                }}
                batch={{ targets: activeTargets, isAll: isAllMode }}
                send={{
                  showStop: Boolean(targetBusy && !input.trim() && !images.length),
                  targetBusy,
                  canSend: Boolean(input.trim() || images.length),
                  onStop: () => void api.stop(room, activeTargets.length === 1 ? agent : undefined),
                  onSend: () => void send(),
                  onQueue: () => enqueueCurrent(),
                  onInterrupt: () => void interruptAndSend()
                }}
              />
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                onChange={e => {
                  if (e.target.files?.length) void addImageFiles(e.target.files)
                  e.target.value = ''
                }}
              />
            </div>
          </div>
        )}
      </main>

      {previewOpen && (
        <FilePreviewPanel
          preview={previewData}
          loading={previewLoading}
          error={previewErr}
          roomId={room}
          projectDir={project?.dir}
          onClose={() => { setPreviewOpen(false); setPreviewData(null); setPreviewErr('') }}
          onPreviewFile={messageHandlers.onPreviewFile}
          onOpenLightbox={messageHandlers.onOpenLightbox}
          onFileContextMenu={messageHandlers.onFileContextMenu}
        />
      )}

      {lightbox && (
        <ImageLightbox
          items={lightbox.items}
          index={lightbox.index}
          roomId={room}
          projectDir={project?.dir}
          onIndexChange={next => setLightbox(prev => (prev ? { ...prev, index: next } : null))}
          onClose={() => setLightbox(null)}
          onOpenInSidePanel={p => void handlePreviewFile(p)}
          onFileContextMenu={messageHandlers.onFileContextMenu}
          onToast={setCopyToast}
        />
      )}

      {showFiles && project && (
        <FileDrawer
          roomId={room}
          projectName={project.name}
          activePreviewPath={previewOpen ? previewData?.path : undefined}
          onClose={() => setShowFiles(false)}
          onInsertPath={relPath => {
            setInput((input ? input.trimEnd() + ' ' : '') + relPath + ' ')
            textarea.current?.focus()
          }}
          onPreviewFile={messageHandlers.onPreviewFile}
          onFileContextMenu={messageHandlers.onFileContextMenu}
        />
      )}

      {fileMenu && (
        <div
          className="file-ctx-menu"
          style={{ left: fileMenu.x, top: fileMenu.y }}
          onMouseDown={e => e.stopPropagation()}
        >
          {fileMenu.isImage && (
            <button type="button" onClick={() => void copyImageFromMenu(fileMenu)}>
              <ImageIcon size={13} />
              <span>复制图片</span>
            </button>
          )}
          {fileMenu.path && (
            <>
              <button type="button" onClick={() => copyAbsPath(fileMenu.path)}>
                <Copy size={13} />
                <span>复制绝对路径</span>
              </button>
              {fileMenu.allowPreview && (
                // The side panel sits under the lightbox, so leave the lightbox first.
                <button type="button" onClick={() => { const p = fileMenu.path; setFileMenu(null); setLightbox(null); void handlePreviewFile(p) }}>
                  <Eye size={13} />
                  <span>在右侧预览</span>
                </button>
              )}
              <button type="button" onClick={() => { const p = fileMenu.path; setFileMenu(null); void api.openPath(p, room) }}>
                <ExternalLink size={13} />
                <span>用系统应用打开</span>
              </button>
              <button type="button" onClick={() => { const p = fileMenu.path; setFileMenu(null); void api.revealPath(p, room) }}>
                <FolderSearch size={13} />
                <span>在访达中显示</span>
              </button>
            </>
          )}
        </div>
      )}

      {copyToast && (
        <div className="copy-toast" role="status">
          <Check size={13} />
          <span>{copyToast}</span>
        </div>
      )}

      {project && (
        <ImportSessionModal
          open={importOpen}
          onOpenChange={setImportOpen}
          projectId={project.id}
          projectName={project.name}
          onImported={newRoomId => {
            setExpandedProjects(prev => ({ ...prev, [project.id]: true }))
            setRoom(newRoomId)
          }}
        />
      )}
    </div>
  )
}

function Root() {
  const [dark, setDark] = useState(() => {
    const saved = localStorage.getItem('ominihive:theme')
    if (saved === 'dark') return true
    if (saved === 'light') return false
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  })

  useEffect(() => {
    const mode = dark ? 'dark' : 'light'
    document.documentElement.dataset.theme = mode
    document.documentElement.classList.toggle('dark', dark)
    void api.setTheme?.(mode)
  }, [dark])

  function toggleTheme() {
    setDark(prev => {
      const next = !prev
      localStorage.setItem('ominihive:theme', next ? 'dark' : 'light')
      return next
    })
  }

  return (
    <Theme appearance={dark ? 'dark' : 'light'} accentColor="indigo" grayColor="slate" radius="medium" scaling="100%">
      <App dark={dark} onToggleTheme={toggleTheme} />
    </Theme>
  )
}

createRoot(document.getElementById('root')!).render(<Root />)
