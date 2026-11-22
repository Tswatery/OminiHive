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
  archived?: boolean
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
  const [agentFilter, setAgentFilter] = useState<'all' | 'Codex' | 'Antigravity' | 'Claude' | 'share'>('all')
  const [onlySameProject, setOnlySameProject] = useState(true)
  const [query, setQuery] = useState('')

  const [shareUrl, setShareUrl] = useState('')
  const shareMode = agentFilter === 'share'
  const [searchResult, setSearchResult] = useState<{ key: string; rows: ExternalSessionItem[]; error?: string } | null>(null)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const term = query.trim()
  const searchCodex = open && !shareMode && Boolean(term) && (agentFilter === 'all' || agentFilter === 'Codex')
  const searchKey = JSON.stringify([projectId, term, refreshVersion])

  useEffect(() => {
    if (!searchCodex) return
    let active = true
    const timer = setTimeout(async () => {
      try {
        const rows = await window.hive.searchCodexSessions(projectId, term)
        if (active) setSearchResult({ key: searchKey, rows })
      } catch (e) {
        if (active) setSearchResult({ key: searchKey, rows: [], error: cleanError(e) })
      }
    }, 180)
    return () => { active = false; clearTimeout(timer) }
  }, [searchCodex, projectId, term, searchKey])

  async function refresh() {
    if (!projectId) return
    setRefreshVersion(v => v + 1)
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
      setShareUrl('')
      setQuery('')
      setAgentFilter('all')
      void refresh()
    }
  }, [open, projectId])

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    const rows = searchCodex ? [...(searchResult?.key === searchKey ? searchResult.rows : []), ...items.filter(it => it.agent !== 'Codex')] : items
    return rows.filter(it => {
      if (agentFilter !== 'all' && it.agent !== agentFilter) return false
      if (q && it.agent !== 'Codex' && !it.title.toLowerCase().includes(q) && !it.cwd.toLowerCase().includes(q)) return false
      return true
    })
  }, [items, agentFilter, query, searchCodex, searchKey, searchResult])

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

  async function importLink(e: React.FormEvent) {
    e.preventDefault()
    if (importingId || !shareUrl.trim()) return
    setImportingId('share')
    setErr('')
    try {
      const room = await window.hive.importSharedChat(projectId, shareUrl.trim())
      onOpenChange(false)
      onImported(room)
    } catch (error) {
      setErr(cleanError(error))
    } finally {
      setImportingId('')
    }
  }

  const sameCount = matches.filter(x => x.sameProject).length
  const filtered = onlySameProject ? matches.filter(it => it.sameProject) : matches

  return (
    <Dialog.Root open={open} onOpenChange={next => { if (!importingId) onOpenChange(next) }}>
      <Dialog.Content className="import-modal" maxWidth="620px">
        <div className="import-head">
          <div>
            <Dialog.Title size="4" mb="1">导入外部会话</Dialog.Title>
            <Dialog.Description size="2" color="gray">
              将本机会话或公开分享的对话导入「{projectName}」
            </Dialog.Description>
          </div>
          <div className="import-head-actions">
            <button type="button" className="icon-btn" onClick={() => void refresh()} title="刷新列表" disabled={loading || shareMode}>
              <RefreshCw size={14} className={loading ? 'spin' : ''} />
            </button>
            <button type="button" className="icon-btn" onClick={() => onOpenChange(false)} aria-label="关闭" disabled={Boolean(importingId)}>
              <X size={15} />
            </button>
          </div>
        </div>

        <div className="import-controls">
          <div className="import-tabs">
            {(['all', 'Codex', 'Antigravity', 'Claude', 'share'] as const).map(tab => (
              <button
                key={tab}
                type="button"
                className={'import-tab' + (agentFilter === tab ? ' active' : '')}
                disabled={Boolean(importingId)}
                onClick={() => { setAgentFilter(tab); setErr('') }}
              >
                {tab === 'all' ? '全部' : tab === 'share' ? '共享链接' : tab}
              </button>
            ))}
          </div>
          {!shareMode && <label className="import-scope-toggle">
            <input
              type="checkbox"
              checked={onlySameProject}
              onChange={e => setOnlySameProject(e.target.checked)}
            />
            <span>仅当前项目 ({sameCount})</span>
          </label>}
        </div>

        {err && <div className="import-error" role="alert">{err}</div>}
        {shareMode ? <form className="share-import-form" onSubmit={importLink}>
          <label htmlFor="shared-chat-url">ChatGPT 或 Gemini 公开分享链接</label>
          <div className="import-search">
            <input id="shared-chat-url" type="url" autoFocus required placeholder="粘贴分享链接…"
              value={shareUrl} onChange={e => setShareUrl(e.target.value)} disabled={Boolean(importingId)} />
            <button type="submit" className="import-btn" disabled={!shareUrl.trim() || Boolean(importingId)}>
              {importingId ? '正在导入…' : '导入对话'}
            </button>
          </div>
          <small>按原顺序导入文字记录，图片和文件仅保留分享中可读取的说明。</small>
        </form> : <>
        <div className="import-search">
          <Search size={14} />
          <input
            type="text"
            placeholder="搜索会话标题或目录…"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
        </div>

        {searchCodex && searchResult?.key === searchKey && searchResult.error && <div className="import-error">{searchResult.error}</div>}


        <ScrollArea className="import-list" variant="input" insetTop={4} insetBottom={4}>
          {searchCodex && searchResult?.key !== searchKey ? <div className="import-empty">正在搜索全部本机 Codex 会话…</div> : loading && items.length === 0 ? (
            <div className="import-empty">正在读取本机 Codex / Antigravity / Claude 会话…</div>
          ) : filtered.length === 0 ? (
            <div className="import-empty">
              {onlySameProject && matches.length > 0
                ? '当前项目目录下暂无匹配会话，可取消勾选「仅当前项目」查看全部会话。'
                : '未找到匹配的会话。'}
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
                      {item.archived && <em className="import-badge">已归档</em>}
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
        </>}
      </Dialog.Content>
    </Dialog.Root>
  )
}
