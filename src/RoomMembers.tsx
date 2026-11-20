import { useState } from 'react'
import { Popover } from '@radix-ui/themes'
import { Check, ChevronDown, Search, UserPlus, Users } from 'lucide-react'
import { AgentIcon } from './AgentIcon'
import { ALL_AGENTS, CORE_AGENTS, agentLabel, agentShort, agentMatchesQuery, type Agent } from './agentMeta'
import { ScrollArea } from './OverlayScrollbar'

export function RoomMembersPicker({
  open,
  onOpenChange,
  members,
  availableMap,
  enabledAgents,
  onChangeMembers,
  onEnableAgent
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  members: Agent[]
  availableMap: Partial<Record<Agent, boolean>>
  enabledAgents: Record<string, boolean>
  onChangeMembers: (next: Agent[]) => void
  onEnableAgent: (agent: Agent) => void
}) {
  const [query, setQuery] = useState('')

  const isInstalled = (a: Agent) => Boolean(availableMap[a])
  const isEnabled = (a: Agent) => enabledAgents[a] ?? isInstalled(a)

  const filtered = ALL_AGENTS.filter(a => agentMatchesQuery(a, query))
  const installedList = filtered.filter(a => isInstalled(a))
  const uninstalledList = filtered.filter(a => !isInstalled(a))

  const allInstalledEnabled = ALL_AGENTS.filter(a => isInstalled(a) && isEnabled(a))

  function toggleMember(a: Agent) {
    if (!isInstalled(a)) return
    if (!isEnabled(a)) onEnableAgent(a)
    if (members.includes(a)) {
      if (members.length <= 1) return
      onChangeMembers(members.filter(x => x !== a))
    } else {
      onChangeMembers([...members, a])
    }
  }

  function inviteAllReady() {
    if (!allInstalledEnabled.length) return
    onChangeMembers(allInstalledEnabled)
  }

  function resetCore() {
    const fallback = CORE_AGENTS.filter(a => isInstalled(a))
    onChangeMembers(fallback.length ? fallback : CORE_AGENTS)
  }

  const visibleAvatars = members.slice(0, 4)
  const extraCount = members.length - visibleAvatars.length

  return (
    <Popover.Root open={open} onOpenChange={v => { onOpenChange(v); if (!v) setQuery('') }}>
      <Popover.Trigger>
        <button type="button" className="head-members-btn" title="管理当前讨论的群成员（支持一次性拉入多个 Agent）">
          <span className="avatar-stack">
            {visibleAvatars.map(a => (
              <span key={a} className="avatar-stack-item">
                <AgentIcon name={a} size={14} />
              </span>
            ))}
            {extraCount > 0 && <span className="avatar-stack-more">+{extraCount}</span>}
          </span>
          <span className="head-members-count">{members.length}</span>
          <UserPlus size={13} className="head-members-plus" />
        </button>
      </Popover.Trigger>
      <Popover.Content side="bottom" align="end" sideOffset={8} width="320px" className="members-popover">
        <div className="members-pop-head">
          <div>
            <strong>群聊成员</strong>
            <span>勾选拉入当前讨论，可一次多选</span>
          </div>
          <div className="members-pop-quick">
            <button type="button" onClick={inviteAllReady} title="一次性拉入所有已安装且启用的 Agent">全拉入</button>
            <button type="button" onClick={resetCore} title="恢复默认主力成员">默认</button>
          </div>
        </div>

        <div className="members-search">
          <Search size={13} />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="搜索 Agent（如 DeepSeek、Hermes、Kimi…）"
          />
        </div>

        <ScrollArea className="members-list" variant="input" insetTop={4} insetBottom={4}>
          {installedList.length > 0 && (
            <div className="members-group">
              <div className="members-group-title">可拉入 · {installedList.length}</div>
              {installedList.map(a => {
                const inRoom = members.includes(a)
                const enabled = isEnabled(a)
                return (
                  <button
                    key={a}
                    type="button"
                    className={'member-row' + (inRoom ? ' in-room' : '')}
                    onClick={() => toggleMember(a)}
                  >
                    <span className={'member-check' + (inRoom ? ' checked' : '')}>
                      {inRoom && <Check size={11} />}
                    </span>
                    <AgentIcon name={a} size={18} />
                    <span className="member-info">
                      <strong>{agentLabel(a)}</strong>
                      <small>@{a}{!enabled ? ' · 点击将自动启用' : ''}</small>
                    </span>
                    {inRoom && <span className="member-pill">已在群</span>}
                  </button>
                )
              })}
            </div>
          )}

          {uninstalledList.length > 0 && (
            <div className="members-group">
              <div className="members-group-title">未安装 · {uninstalledList.length}</div>
              {uninstalledList.map(a => (
                <div key={a} className="member-row disabled" title="请先在左下角「设置与 CLI」中安装">
                  <span className="member-check" />
                  <AgentIcon name={a} size={18} />
                  <span className="member-info">
                    <strong>{agentLabel(a)}</strong>
                    <small>未安装 · 在设置中安装</small>
                  </span>
                </div>
              ))}
            </div>
          )}

          {!installedList.length && !uninstalledList.length && (
            <div className="members-empty">未找到匹配的 Agent</div>
          )}
        </ScrollArea>
      </Popover.Content>
    </Popover.Root>
  )
}

export function TargetSelector({
  members,
  activeTargets,
  isAllMode,
  busyAgents,
  inspected,
  onSelectSingle,
  onToggleMulti,
  onToggleAll,
  onInspect,
  onOpenInvite
}: {
  members: Agent[]
  activeTargets: Agent[]
  isAllMode: boolean
  busyAgents: Set<Agent>
  inspected: Agent
  onSelectSingle: (a: Agent) => void
  onToggleMulti: (a: Agent) => void
  onToggleAll: () => void
  onInspect: (a: Agent) => void
  onOpenInvite: () => void
}) {
  const [open, setOpen] = useState(false)
  const visible = activeTargets.slice(0, 3)
  const anyBusy = activeTargets.some(a => busyAgents.has(a))

  const label = isAllMode
    ? `全体群员 (${members.length})`
    : activeTargets.length === 1
      ? agentShort(activeTargets[0])
      : `${activeTargets.length} 位成员`

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger>
        <button
          type="button"
          className={'target-capsule' + (activeTargets.length > 1 ? ' multi' : '')}
          title={'当前发送给：' + activeTargets.map(agentLabel).join('、') + '（点击切换或群发）'}
        >
          <span className="avatar-stack compact">
            {visible.map(a => (
              <span key={a} className="avatar-stack-item">
                <AgentIcon name={a} size={13} />
              </span>
            ))}
            {activeTargets.length > 3 && <span className="avatar-stack-more">+{activeTargets.length - 3}</span>}
          </span>
          <span className="target-capsule-label">{label}</span>
          {anyBusy && <span className="pulse-dot mini" />}
          <ChevronDown size={12} className={'tool-chip-caret' + (open ? ' open' : '')} />
        </button>
      </Popover.Trigger>
      <Popover.Content side="top" align="start" sideOffset={8} width="268px" className="target-popover">
        <div className="target-pop-head">
          <span>发送对象（当前群成员）</span>
          <span className="target-pop-hint">点名称单选 · 勾选多发</span>
        </div>

        <div className="target-list">
          {members.length > 1 && (
            <button
              type="button"
              className={'target-row all' + (isAllMode ? ' active' : '')}
              onClick={() => { onToggleAll() }}
            >
              <span className={'member-check' + (isAllMode ? ' checked' : '')}>
                {isAllMode && <Check size={11} />}
              </span>
              <Users size={15} />
              <span className="target-row-name">全体群员 (@all)</span>
              <span className="target-row-sub">{members.length} 位</span>
            </button>
          )}

          {members.map(a => {
            const selected = activeTargets.includes(a)
            const busy = busyAgents.has(a)
            const isConfigTarget = inspected === a && activeTargets.length > 1
            return (
              <div key={a} className={'target-row' + (selected ? ' active' : '') + (isConfigTarget ? ' inspecting' : '')}>
                <button
                  type="button"
                  className="target-check-btn"
                  title={selected ? '取消群发该成员' : '加入本次群发'}
                  onClick={e => { e.stopPropagation(); onToggleMulti(a) }}
                >
                  <span className={'member-check' + (selected ? ' checked' : '')}>
                    {selected && <Check size={11} />}
                  </span>
                </button>
                <button
                  type="button"
                  className="target-main-btn"
                  onMouseEnter={() => { if (selected) onInspect(a) }}
                  onClick={() => { onSelectSingle(a) }}
                >
                  <AgentIcon name={a} size={16} />
                  <span className="target-row-name">{agentLabel(a)}</span>
                  {busy && <span className="pulse-dot mini" />}
                </button>
              </div>
            )
          })}
        </div>

        <button
          type="button"
          className="target-invite-footer"
          onClick={() => { setOpen(false); onOpenInvite() }}
        >
          <UserPlus size={13} />
          <span>拉更多 Agent 进群…</span>
        </button>
      </Popover.Content>
    </Popover.Root>
  )
}
