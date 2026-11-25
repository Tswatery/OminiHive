import React from 'react'
import { DropdownMenu } from '@radix-ui/themes'
import { ArrowUp, Check, ListPlus, Plus, RotateCcw, Shield, ShieldAlert, Sparkles, Square, Terminal, Zap } from 'lucide-react'
import type { Agent } from './agentMeta'
import { Tip } from './Tip'
import { ContextChip } from './ContextMeter'
import type { ContextUsage } from './usageFormat'

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
        <button type="button" className={'tool-chip perm-btn ' + current.chipClass}>
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
  /** live context window / session file reading for the inspected agent */
  context?: ContextUsage
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
  context,
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
        {!session.fresh && <ContextChip usage={context} agent={inspectedAgent} compact={send.targetBusy && send.canSend} />}
        <Tip
          allowDisabled
          content={
            !session.hasExisting
              ? `${inspectedAgent} 尚无原生会话，发送后将新开会话`
              : session.fresh
                ? `${inspectedAgent} 本轮将新开干净会话（点击切回续接）`
                : `重置 ${inspectedAgent} 会话上下文（点击新开干净会话）`
          }
        >
          <button
            type="button"
            className={'tool-chip icon-only session-btn ' + (!session.hasExisting ? 'cold' : session.fresh ? 'fresh' : 'resume')}
            disabled={!session.hasExisting}
            aria-label="重置或切换会话"
            onClick={session.onToggle}
          >
            {(!session.hasExisting || session.fresh) ? <Sparkles size={13} /> : <RotateCcw size={13} />}
          </button>
        </Tip>

        <Tip content="添加图片或文件（也支持粘贴或拖入）">
          <button
            type="button"
            className="tool-chip icon-only img-pick-btn"
            aria-label="添加图片或文件"
            onClick={onPickFiles}
          >
            <Plus size={15} />
          </button>
        </Tip>

        {skills.count > 0 && (
          <Tip content={`查看 ${inspectedAgent} 的 ${skills.count} 个专属 Skills（也可输入 /）`}>
            <button
              type="button"
              className="tool-chip skills-btn"
              onClick={skills.onToggle}
            >
              <Sparkles size={12} />
              <span><em className="skills-word">Skills </em>{skills.count}</span>
            </button>
          </Tip>
        )}

        {batch.targets.length > 1 && (
          <Tip content={'将同时发送给：' + batch.targets.join('、')}>
            <span className="batch-pill">
              {batch.isAll ? `@all · ${batch.targets.length}` : `群发 · ${batch.targets.length}`}
            </span>
          </Tip>
        )}

        {send.targetBusy && send.canSend ? (
          <div className="busy-send-group">
            <Tip content="立即打断当前运行中的 Agent 并发送 (⌘Enter)">
              <button
                type="button"
                className="interrupt-send-btn"
                onClick={send.onInterrupt}
              >
                <Zap size={12} />
                <span>打断发送</span>
              </button>
            </Tip>
            <Tip content="加入待发队列，当前任务结束后自动发送 (Enter)">
              <button
                type="button"
                className="send queue ready"
                aria-label="排队发送"
                onClick={send.onQueue}
              >
                <ListPlus size={15} />
              </button>
            </Tip>
          </div>
        ) : (
          <Tip allowDisabled content={send.showStop ? '停止当前运行 (⌘.)' : '发送 (Enter)'}>
            <button
              type="button"
              className={'send ' + (send.showStop ? 'stop' : '') + (send.canSend ? ' ready' : '')}
              aria-label={send.showStop ? '停止' : '发送'}
              disabled={!send.showStop && !send.canSend}
              onClick={() => send.showStop ? send.onStop() : send.onSend()}
            >
              {send.showStop ? <Square size={12} /> : <ArrowUp size={16} />}
            </button>
          </Tip>
        )}
      </div>
    </div>
  )
}
