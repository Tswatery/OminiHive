import React, { useEffect, useMemo, useState } from 'react'
import { Dialog } from '@radix-ui/themes'
import { Download, RefreshCw, Search, X, Folder } from 'lucide-react'
import { AgentIcon } from './AgentIcon'
import type { Agent } from './agentMeta'
import { ScrollArea } from './OverlayScrollbar'
import { cleanError } from './errors'

export type ExternalSessionItem = {
  agent: Agent
  nativeId: string
  title: string
  cwd: string
  updatedAt: number
  sameProject: boolean
}

function relativeTime(ms: number) {
  if (!ms) return ''
  const diff = Math.max(0, Date.now() - ms)
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day} 天前`
  return new Date(ms).toLocaleDateString('zh-CN')
}

function shortDir(dir: string) {
  if (!dir) return ''
  const parts = dir.split(/[/\\]/).filter(Boolean)
  return parts.length >= 2 ? parts.slice(-2).join('/') : dir
}

export function ImportSessionModal({
  open,
  onOpenChange,
  projectId,
  projectName,
  onImported
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  projectId: string
  projectName: string
  onImported: (roomId: string) => void
}) {
  const [items, setItems] = useState<ExternalSessionItem[]>([])
  const [loading, setLoading] = useState(false)
  const [importingId, setImportingId] = useState('')
  const [err, setErr] = useState('')
  const [agentFilter, setAgentFilter] = useState<'all' | 'Codex' | 'Antigravity' | 'Claude'>('all')
  const [onlySameProject, setOnlySameProject] = useState(true)
  const [query, setQuery] = useState('')

  async function refresh() {
    if (!projectId) return
    setLoading(true)
    setErr('')
    try {
      const list = await window.hive.externalSessions(projectId)
      setItems(list || [])
      if (list && list.length > 0 && !list.some(x => x.sameProject)) {
        setOnlySameProject(false)
      }
    } catch (e) {
      setErr(cleanError(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open && projectId) {
      setOnlySameProject(true)
      setQuery('')
      setAgentFilter('all')
      void refresh()
    }
  }, [open, projectId])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return items.filter(it => {
      if (onlySameProject && !it.sameProject) return false
      if (agentFilter !== 'all' && it.agent !== agentFilter) return false
      if (q && !it.title.toLowerCase().includes(q) && !it.cwd.toLowerCase().includes(q)) return false
      return true
    })
  }, [items, onlySameProject, agentFilter, query])

  async function handleImport(item: ExternalSessionItem) {
    if (importingId) return
    setImportingId(item.nativeId)
    setErr('')
    try {
      const newRoomId = await window.hive.importSession(projectId, item)
      onOpenChange(false)
      onImported(newRoomId)
    } catch (e) {
      setErr(cleanError(e))
    } finally {
      setImportingId('')
    }
  }

  const sameCount = items.filter(x => x.sameProject).length

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content className="import-modal" maxWidth="620px">
        <div className="import-head">
          <div>
            <Dialog.Title size="4" mb="1">导入外部会话</Dialog.Title>
            <Dialog.Description size="2" color="gray">
              将 Codex、Antigravity 或 Claude 客户端的已有会话导入到「{projectName}」并继续对话
            </Dialog.Description>
          </div>
          <div className="import-head-actions">
            <button type="button" className="icon-btn" onClick={() => void refresh()} title="刷新列表" disabled={loading}>
              <RefreshCw size={14} className={loading ? 'spin' : ''} />
            </button>
            <button type="button" className="icon-btn" onClick={() => onOpenChange(false)} aria-label="关闭">
              <X size={15} />
            </button>
          </div>
        </div>

        <div className="import-controls">
          <div className="import-tabs">
            {(['all', 'Codex', 'Antigravity', 'Claude'] as const).map(tab => (
              <button
                key={tab}
                type="button"
                className={'import-tab' + (agentFilter === tab ? ' active' : '')}
                onClick={() => setAgentFilter(tab)}
              >
                {tab === 'all' ? '全部' : tab}
              </button>
            ))}
          </div>
          <label className="import-scope-toggle">
            <input
              type="checkbox"
              checked={onlySameProject}
              onChange={e => setOnlySameProject(e.target.checked)}
            />
            <span>仅当前项目 ({sameCount})</span>
          </label>
        </div>

        <div className="import-search">
          <Search size={14} />
          <input
            type="text"
            placeholder="搜索会话标题或目录…"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
        </div>

        {err && <div className="import-error">{err}</div>}

        <ScrollArea className="import-list" variant="input" insetTop={4} insetBottom={4}>
          {loading && items.length === 0 ? (
            <div className="import-empty">正在读取本机 Codex / Antigravity / Claude 会话…</div>
          ) : filtered.length === 0 ? (
            <div className="import-empty">
              {onlySameProject && items.length > 0
                ? '当前项目目录下暂无匹配会话，可取消勾选「仅当前项目」查看全部会话。'
                : '未找到可导入的外部会话（请确认对应客户端已运行或有历史记录）。'}
            </div>
          ) : (
            filtered.map(item => {
              const busy = importingId === item.nativeId
              return (
                <div key={`${item.agent}:${item.nativeId}`} className="import-row">
                  <div className="import-row-main">
                    <div className="import-row-title">
                      <AgentIcon name={item.agent} size={16} />
                      <span>{item.title}</span>
                      {item.sameProject && <em className="import-badge">本项目</em>}
                    </div>
                    <div className="import-row-meta">
                      <span>{item.agent}</span>
                      {item.cwd && (
                        <span className="import-row-dir" title={item.cwd}>
                          <Folder size={11} />
                          {shortDir(item.cwd)}
                        </span>
                      )}
                      {item.updatedAt > 0 && <span>{relativeTime(item.updatedAt)}</span>}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="import-btn"
                    disabled={Boolean(importingId)}
                    onClick={() => void handleImport(item)}
                  >
                    <Download size={13} />
                    <span>{busy ? '导入中…' : '导入'}</span>
                  </button>
                </div>
              )
            })
          )}
        </ScrollArea>
      </Dialog.Content>
    </Dialog.Root>
  )
}
