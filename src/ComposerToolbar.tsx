import React from 'react'
import { DropdownMenu } from '@radix-ui/themes'
import { ArrowUp, Check, ListPlus, Plus, RotateCcw, Shield, ShieldAlert, Sparkles, Square, Terminal, Zap } from 'lucide-react'
import type { Agent } from './agentMeta'

export type AccessMode = 'read-only' | 'workspace' | 'full'

const ACCESS_OPTIONS: Array<{
  mode: AccessMode
  Icon: typeof Shield
  chip: string
  chipClass: string
  title: string
  desc: string
  itemClass: string
}> = [
  { mode: 'read-only', Icon: Shield, chip: '只读', chipClass: 'read-only', title: '只读模式', desc: '仅读取项目代码，禁止修改与联网', itemClass: 'readonly' },
  { mode: 'workspace', Icon: Terminal, chip: '工作区', chipClass: 'writable', title: '工作区可编辑', desc: '可编辑当前项目文件并允许联网', itemClass: 'workspace' },
  { mode: 'full', Icon: ShieldAlert, chip: '完全访问', chipClass: 'full-access', title: '完全访问权限', desc: '不受限制地访问互联网、SSH 和电脑上的任何文件', itemClass: 'danger' }
]

/** Per-agent execution permission chip + menu. */
export function AccessModePicker({ agent, value, onChange }: {
  agent: Agent
  value: AccessMode
  onChange: (mode: AccessMode) => void
}) {
  const current = ACCESS_OPTIONS.find(o => o.mode === value) || ACCESS_OPTIONS[0]
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        <button type="button" className={'tool-chip perm-btn ' + current.chipClass} title={`${agent} 权限：${current.title}`}>
          <current.Icon size={13} />
          <span>{current.chip}</span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content size="2" side="top" align="start" sideOffset={7} className="access-menu">
        <DropdownMenu.Label>{agent} 执行权限</DropdownMenu.Label>
        {ACCESS_OPTIONS.map(o => (
          <DropdownMenu.Item key={o.mode} className={'access-item ' + o.itemClass} onSelect={() => onChange(o.mode)}>
            <o.Icon size={15} className="access-ico" />
            <div className="access-copy">
              <strong>{o.title}</strong>
              <small>{o.desc}</small>
            </div>
            {value === o.mode && <Check size={14} className="access-check" />}
          </DropdownMenu.Item>
        ))}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  )
}

export type ComposerToolbarProps = {
  /** agent whose model / access / session settings the toolbar edits */
  inspectedAgent: Agent
  /** slot: who receives the message (TargetSelector) */
  targetPicker: React.ReactNode
  /** slot: model + effort picker for the inspected agent */
  modelPicker: React.ReactNode
  access: { value: AccessMode; onChange: (mode: AccessMode) => void }
  /** resume the agent's native session vs. start a clean one */
  session: { hasExisting: boolean; fresh: boolean; onToggle: () => void }
  onPickFiles: () => void
  skills: { count: number; onToggle: () => void }
  /** shown when sending to more than one agent */
  batch: { targets: Agent[]; isAll: boolean }
  send: {
    /** nothing typed and a target is running → the main button stops it */
    showStop: boolean
    targetBusy: boolean
    canSend: boolean
    onStop: () => void
    onSend: () => void
    onQueue: () => void
    onInterrupt: () => void
  }
}

export function ComposerToolbar({
  inspectedAgent,
  targetPicker,
  modelPicker,
  access,
  session,
  onPickFiles,
  skills,
  batch,
  send
}: ComposerToolbarProps) {
  return (
    <div className="toolbar">
      <div className="toolbar-left">
        {targetPicker}
        {modelPicker}
        <AccessModePicker agent={inspectedAgent} value={access.value} onChange={access.onChange} />
      </div>

      <div className="toolbar-right">
        <button
          type="button"
          className={'tool-chip icon-only session-btn ' + (!session.hasExisting ? 'cold' : session.fresh ? 'fresh' : 'resume')}
          disabled={!session.hasExisting}
          title={
            !session.hasExisting
              ? `${inspectedAgent} 在本讨论尚无原生会话，发送后将新开会话`
              : session.fresh
                ? `${inspectedAgent} 本轮将新开干净会话（点击切回续接）`
                : `${inspectedAgent} 当前将续接已有原生会话（点击切换为新开会话）`
          }
          onClick={session.onToggle}
        >
          {(!session.hasExisting || session.fresh) ? <Sparkles size={13} /> : <RotateCcw size={13} />}
        </button>

        <button
          type="button"
          className="tool-chip icon-only img-pick-btn"
          title="添加图片或文件（也支持直接粘贴或拖入）"
          onClick={onPickFiles}
        >
          <Plus size={15} />
        </button>

        {skills.count > 0 && (
          <button
            type="button"
            className="tool-chip skills-btn"
            title={`查看 ${inspectedAgent} 的 ${skills.count} 个专属 Skills（也可直接输入 /）`}
            onClick={skills.onToggle}
          >
            <Sparkles size={12} />
            <span><em className="skills-word">Skills </em>{skills.count}</span>
          </button>
        )}

        {batch.targets.length > 1 && (
          <span className="batch-pill" title={'将同时发送给：' + batch.targets.join('、')}>
            {batch.isAll ? `@all · ${batch.targets.length}` : `群发 · ${batch.targets.length}`}
          </span>
        )}

        {send.targetBusy && send.canSend ? (
          <div className="busy-send-group">
            <button
              type="button"
              className="interrupt-send-btn"
              onClick={send.onInterrupt}
              title="立即打断当前运行中的 Agent 并发送 (⌘Enter)"
            >
              <Zap size={12} />
              <span>打断发送</span>
            </button>
            <button
              type="button"
              className="send queue ready"
              aria-label="排队发送"
              onClick={send.onQueue}
              title="加入待发队列，当前任务结束后自动发送 (Enter)"
            >
              <ListPlus size={15} />
            </button>
          </div>
        ) : (
          <button
            type="button"
            className={'send ' + (send.showStop ? 'stop' : '') + (send.canSend ? ' ready' : '')}
            aria-label={send.showStop ? '停止' : '发送'}
            disabled={!send.showStop && !send.canSend}
            onClick={() => send.showStop ? send.onStop() : send.onSend()}
            title={send.showStop ? '停止当前运行 (⌘.)' : '发送 (Enter)'}
          >
            {send.showStop ? <Square size={12} /> : <ArrowUp size={16} />}
          </button>
        )}
      </div>
    </div>
  )
}
