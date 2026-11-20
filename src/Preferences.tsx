import { useState, useEffect, useRef } from 'react'
import { Button, Dialog, Flex, IconButton, Popover, Select, Switch, Text } from '@radix-ui/themes'
import { Check, ChevronDown, Download, RefreshCw, RotateCcw, Settings2, Waypoints, X, Zap } from 'lucide-react'
import type { Option } from './Controls'
import { VolcQuota } from './VolcQuota'
import { ModelIcon } from './ModelIcon'
import { AgentIcon } from './AgentIcon'
import { agentLabel } from './agentMeta'
import { ScrollArea } from './OverlayScrollbar'
import { cleanError } from './errors'

export type ModelOption = Option & { efforts: string[]; defaultEffort?: string; isDefault?: boolean }
export type ClientInfo = {
  agent: string
  hint?: string
  canInstall?: boolean
  candidates: { version: string; path: string }[]
  latest?: string
  status?: string
  checked?: string
  installing?: boolean
  outcome?: { error?: boolean; message: string }
}

function EffortCapsuleSlider({
  steps,
  value,
  onChange,
}: {
  steps: string[]
  value: string
  onChange: (v: string) => void
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ pointerId: number; startX: number; moved: boolean } | null>(null)
  const [dragPos, setDragPos] = useState<number | null>(null)

  const activeIdx = Math.max(0, steps.indexOf(value))
  const displayPos = dragPos !== null ? dragPos : activeIdx
  const highlightedIdx = dragPos !== null ? Math.round(dragPos) : activeIdx

  const getPosFromClientX = (clientX: number) => {
    const el = trackRef.current
    if (!el || steps.length <= 1) return 0
    const rect = el.getBoundingClientRect()
    const pad = 3
    const innerWidth = Math.max(1, rect.width - pad * 2)
    const segWidth = innerWidth / steps.length
    const raw = (clientX - (rect.left + pad) - segWidth / 2) / segWidth
    return Math.max(0, Math.min(steps.length - 1, raw))
  }

  const getSegFromClientX = (clientX: number) => {
    const el = trackRef.current
    if (!el || steps.length <= 1) return 0
    const rect = el.getBoundingClientRect()
    const pad = 3
    const innerWidth = Math.max(1, rect.width - pad * 2)
    const segWidth = innerWidth / steps.length
    const idx = Math.floor((clientX - (rect.left + pad)) / segWidth)
    return Math.max(0, Math.min(steps.length - 1, idx))
  }

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || steps.length <= 1) return
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { pointerId: e.pointerId, startX: e.clientX, moved: false }
    setDragPos(getPosFromClientX(e.clientX))
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    if (!drag.moved && Math.abs(e.clientX - drag.startX) > 3) {
      drag.moved = true
    }
    setDragPos(getPosFromClientX(e.clientX))
  }

  const finishDrag = (e: React.PointerEvent<HTMLDivElement>, commit: boolean) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    dragRef.current = null
    setDragPos(null)
    if (!commit) return
    const nextIdx = drag.moved
      ? Math.round(getPosFromClientX(e.clientX))
      : getSegFromClientX(e.clientX)
    const nextStep = steps[nextIdx]
    if (nextStep && nextStep !== value) {
      onChange(nextStep)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault()
      const next = Math.max(0, activeIdx - 1)
      if (steps[next] !== value) onChange(steps[next])
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault()
      const next = Math.min(steps.length - 1, activeIdx + 1)
      if (steps[next] !== value) onChange(steps[next])
    }
  }

  return (
    <div
      ref={trackRef}
      role="radiogroup"
      aria-label="思考强度"
      className={'effort-capsule' + (dragPos !== null ? ' dragging' : '')}
      style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={e => finishDrag(e, true)}
      onPointerCancel={e => finishDrag(e, false)}
      onKeyDown={handleKeyDown}
    >
      <div
        className="effort-capsule-thumb"
        style={{
          width: `calc((100% - 6px) / ${steps.length})`,
          transform: `translateX(${displayPos * 100}%)`,
        }}
        aria-hidden="true"
      />
      {steps.map((s, i) => (
        <button
          key={s}
          type="button"
          role="radio"
          aria-checked={i === highlightedIdx}
          tabIndex={i === activeIdx ? 0 : -1}
          className="effort-capsule-item"
          onClick={e => {
            if (e.detail === 0 && s !== value) onChange(s)
          }}
        >
          {s}
        </button>
      ))}
    </div>
  )
}

export function ModelEffortPicker({
  agent, models, model, onModel, effort, onEffort, onOpen, hint
}: {
  agent: string
  models: ModelOption[]
  model: string
  onModel: (v: string) => void
  effort: string
  onEffort: (v: string) => void
  onOpen: () => void
  hint?: string
}) {
  const active = models.find(m => m.id === model) || (!model ? models.find(m => m.isDefault) : undefined)
  const steps = active?.efforts || []
  const level = effort || active?.defaultEffort || ''
  const modelLabel = active?.label || model || '默认模型'
  const effortTitle = effort || level || 'auto'

  return (
    <Popover.Root onOpenChange={open => { if (open) onOpen() }}>
      <Popover.Trigger>
        <button type="button" className="tool-chip" aria-label={agent + ' 模型与思考强度'}>
          <ModelIcon model={active?.id || model} label={active?.label} size={13} />
          <span className="tool-chip-label">{modelLabel}</span>
          {steps.length > 1 && (
            <span className="tool-chip-sub">
              <Zap size={11} />
              {effortTitle || '自动'}
            </span>
          )}
          <ChevronDown size={12} className="tool-chip-caret" />
        </button>
      </Popover.Trigger>
      <Popover.Content side="top" align="start" sideOffset={8} width="300px" className="model-panel">
        <div className="panel-section">
          <div className="panel-head">
            <span>{agent} 模型</span>
            {hint && <span className="panel-hint">{hint}</span>}
          </div>
          <ScrollArea className="model-list" variant="input" insetTop={4} insetBottom={4}>
            <button
              type="button"
              className={'model-item ' + (!model ? 'selected' : '')}
              onClick={() => onModel('')}
            >
              <ModelIcon size={14} />
              <span className="option-text">跟随客户端默认模型</span>
              {!model && <Check size={14} />}
            </button>
            {models.map(m => (
              <button
                key={m.id}
                type="button"
                className={'model-item ' + (model === m.id ? 'selected' : '')}
                onClick={() => onModel(m.id)}
              >
                <ModelIcon model={m.id} label={m.label} size={14} />
                <span className="option-text">{m.label}</span>
                {m.isDefault && <span className="model-badge">默认</span>}
                {model === m.id && <Check size={14} />}
              </button>
            ))}
          </ScrollArea>
        </div>

        <div className="panel-section panel-effort">
          <div className="effort-top">
            <span className="effort-label"><Zap size={13} /> 思考强度</span>
            <strong>{level || 'auto'}{!effort && level ? ' · default' : ''}</strong>
            {effort && (
              <IconButton variant="ghost" color="gray" size="1" title="恢复默认强度" aria-label="恢复默认强度" onClick={() => onEffort('')}>
                <RotateCcw size={13} />
              </IconButton>
            )}
          </div>
          {steps.length > 1 ? (
            <div className="effort-steps">
              <EffortCapsuleSlider steps={steps} value={level} onChange={onEffort} />
            </div>
          ) : (
            <p className="panel-note">
              {!active ? '选择具体模型后可查看可用档位' : steps.length ? '固定强度 · ' + steps[0] : '当前模型未提供可调思考档位'}
            </p>
          )}
          {agent === 'Claude' && (
            <p className="panel-note">档位由 Claude Code 提供，实际效果取决于当前路由。</p>
          )}
        </div>
      </Popover.Content>
    </Popover.Root>
  )
}

export type ProviderInfo = {
  id: string
  name: string
  category: string
  isCurrent: boolean
  models: { id: string; label: string; role?: string; isDefault?: boolean }[]
}
export type CCSwitchPrompt = { id: string; appType: string; name: string; description: string; content: string }
export type CCSwitchItem = { id: string; name: string; description: string; agents: string[] }
export type CCSwitchSummary = {
  installed: boolean
  providers: Record<string, ProviderInfo[]>
  prompts: CCSwitchPrompt[]
  mcps: CCSwitchItem[]
  skills: CCSwitchItem[]
}

function AgentGlyph({ name, size = 20 }: { name: string; size?: number }) {
  return <AgentIcon name={name} size={size} />
}

export function Settings({
  missingCount, ccSwitch, enabledAgents, onToggleAgent, providers, onProviderChange
}: {
  missingCount?: number
  ccSwitch?: CCSwitchSummary
  enabledAgents: Record<string, boolean>
  onToggleAgent: (agent: string, enabled: boolean) => void
  providers: Record<string, string>
  onProviderChange: (agent: string, providerId: string) => void
}) {
  const [tab, setTab] = useState<'apps' | 'routes' | 'quota'>('apps')
  const [rows, setRows] = useState<ClientInfo[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => window.hive.onUpgrade(next => {
    setRows(curr => curr.map(row => row.agent === next.agent ? next : row))
  }), [])

  function setRowError(agent: string, message: string) {
    setRows(curr => curr.map(row => row.agent === agent ? { ...row, outcome: { error: true, message } } : row))
  }

  async function refresh(remote: boolean) {
    setBusy(true); setError('')
    try { setRows(await (remote ? window.hive.updates() : window.hive.clients())) }
    catch (e) { setError(cleanError(e)) }
    finally { setBusy(false) }
  }

  async function install(row: ClientInfo) {
    try { await window.hive.upgrade(row.agent) }
    catch (e) { setRowError(row.agent, cleanError(e)) }
  }

  return (
    <Dialog.Root onOpenChange={open => { if (open && !busy) void refresh(false) }}>
      <Dialog.Trigger>
        <button type="button" className="settings-btn">
          <Settings2 size={15} />
          <span>设置与 CLI</span>
          {!!missingCount && missingCount > 0 && <span className="settings-dot" title="部分已启用 CLI 未检测到" />}
        </button>
      </Dialog.Trigger>
      <Dialog.Content maxWidth="650px" className="settings-dialog">
        <Flex align="center" justify="between">
          <div className="settings-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'apps'} className={tab === 'apps' ? 'active' : ''} onClick={() => setTab('apps')}>
              应用与安装
            </button>
            <button type="button" role="tab" aria-selected={tab === 'routes'} className={tab === 'routes' ? 'active' : ''} onClick={() => setTab('routes')}>
              渠道与模型
            </button>
            <button type="button" role="tab" aria-selected={tab === 'quota'} className={tab === 'quota' ? 'active' : ''} onClick={() => setTab('quota')}>
              套餐额度
            </button>
          </div>
          <Dialog.Close>
            <IconButton variant="ghost" color="gray" aria-label="关闭设置"><X size={17} /></IconButton>
          </Dialog.Close>
        </Flex>

        {tab === 'apps' ? (
          <>
            <div className="app-list">
              {[
                { label: '已安装', items: rows.filter(r => r.candidates.length > 0) },
                { label: '未安装', items: rows.filter(r => r.candidates.length === 0) }
              ].filter(g => g.items.length > 0).map(group => (
                <div key={group.label} className="app-group">
                  <div className="app-group-label">{group.label} · {group.items.length}</div>
                  {group.items.map(row => {
                    const isInstalled = row.candidates.length > 0
                    const hasUpdate = row.status === '有新版'
                    const showInstallBtn = (!isInstalled && row.canInstall) || hasUpdate || row.installing
                    const isEnabled = enabledAgents[row.agent] ?? isInstalled
                    const verText = row.candidates[0]?.version === '0.0.0' ? '已安装' : row.candidates[0]?.version
                    return (
                      <section key={row.agent} className="app-row">
                        <div className="app-row-main">
                          <div className="app-icon-box">
                            <AgentGlyph name={row.agent} size={22} />
                          </div>
                          <div className="app-meta">
                            <strong>{agentLabel(row.agent)}</strong>
                            <span>{row.hint || row.candidates[0]?.path || ''}</span>
                          </div>
                          <div className="app-ver">
                            {isInstalled ? (
                              <>
                                <code>{verText}</code>
                                {hasUpdate && <small className="has-update">有新版 {row.latest}</small>}
                              </>
                            ) : (
                              <span className="not-installed">未安装</span>
                            )}
                          </div>
                          <div className="app-actions">
                            {showInstallBtn && (
                              <Button
                                size="1"
                                variant="soft"
                                disabled={row.installing}
                                loading={row.installing}
                                onClick={() => void install(row)}
                              >
                                <Download size={12} />
                                {isInstalled ? '升级' : '安装'}
                              </Button>
                            )}
                            <Switch
                              size="1"
                              checked={isEnabled}
                              disabled={!isInstalled}
                              title={isInstalled ? '控制该 Agent 是否允许被拉入讨论群聊' : '请先安装后再启用'}
                              onCheckedChange={checked => onToggleAgent(row.agent, checked)}
                            />
                          </div>
                        </div>
                        {row.candidates[0] && <p className="version-path">{row.candidates[0].path}</p>}
                        {row.outcome && (
                          <Text as="p" size="1" mt="1" color={row.outcome.error ? 'red' : 'green'} role={row.outcome.error ? 'alert' : 'status'}>
                            {row.outcome.message}
                          </Text>
                        )}
                      </section>
                    )
                  })}
                </div>
              ))}
            </div>
            {error && <p className="error-inline" role="alert">{error}</p>}
            <Flex justify="between" align="center" gap="2" mt="3">
              <Text size="1" color="gray">
                {rows.find(r => r.checked)?.checked
                  ? '上次检查 ' + new Date(rows.find(r => r.checked)!.checked!).toLocaleTimeString()
                  : '启用后可在讨论顶部点击「群成员」拉入协作'}
              </Text>
              <Button size="2" variant="soft" loading={busy} onClick={() => void refresh(true)}>
                <RefreshCw size={13} /> 检查更新
              </Button>
            </Flex>
          </>
        ) : tab === 'quota' ? <VolcQuota /> : (
          <div className="routes-tab">
            {!ccSwitch?.installed ? (
              <div className="cc-empty">未检测到本机 CC Switch 数据库（~/.cc-switch/cc-switch.db），当前直接跟随各 CLI 自身配置文件。</div>
            ) : (
              <>
                <Text size="2" color="gray" as="p" mt="2" mb="3">
                  读取本机 CC Switch 的供应商与模型配置；选择后在 OminiHive 中独立生效，不覆盖全局设置。
                </Text>
                <div className="route-cards">
                  {Object.entries(ccSwitch.providers).map(([ag, list]) => {
                    if (!list.length) return null
                    const pickedId = providers[ag] || ''
                    const current = list.find(p => p.isCurrent)
                    const active = list.find(p => p.id === pickedId) || current
                    const selectVal = pickedId || '__follow__'
                    return (
                      <section key={ag} className="version-card">
                        <div className="route-card-head">
                          <AgentGlyph name={ag} size={18} />
                          <strong>{agentLabel(ag)}</strong>
                          <Select.Root
                            size="1"
                            value={selectVal}
                            onValueChange={v => onProviderChange(ag, v === '__follow__' ? '' : v)}
                          >
                            <Select.Trigger className="route-select-trigger" aria-label={agentLabel(ag) + ' 供应商路由'} />
                            <Select.Content position="popper" sideOffset={4} className="route-select-content">
                              <Select.Item value="__follow__">
                                跟随 CC Switch 当前{current ? ` (${current.name})` : ''}
                              </Select.Item>
                              <Select.Separator />
                              {list.map(p => (
                                <Select.Item key={p.id} value={p.id}>
                                  {p.name}{p.isCurrent ? ' (当前)' : ''}
                                </Select.Item>
                              ))}
                            </Select.Content>
                          </Select.Root>
                        </div>
                        {active && active.models.length > 0 && (
                          <div className="cc-eco-tags">
                            {active.models.map(m => (
                              <span key={m.id + (m.role || '')} className="cc-tag">
                                {m.role ? `${m.role}: ` : ''}{m.label}
                              </span>
                            ))}
                          </div>
                        )}
                      </section>
                    )
                  })}
                </div>

                <div className="cc-eco-box">
                  <div className="cc-eco-head">
                    <Waypoints size={13} />
                    <strong>已启用 MCP / Skills / Prompts</strong>
                    <span>MCP {ccSwitch.mcps.length} · Skills {ccSwitch.skills.length} · Prompts {ccSwitch.prompts.length}</span>
                  </div>
                  {(ccSwitch.mcps.length > 0 || ccSwitch.skills.length > 0) && (
                    <div className="cc-eco-tags">
                      {ccSwitch.mcps.map(m => <span key={m.id} className="cc-tag">MCP · {m.name}</span>)}
                      {ccSwitch.skills.map(s => <span key={s.id} className="cc-tag skill">Skill · {s.name}</span>)}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </Dialog.Content>
    </Dialog.Root>
  )
}
