import { AlertDialog, Button, DropdownMenu, Flex, IconButton } from '@radix-ui/themes'
import { Check, ChevronDown, Trash2 } from 'lucide-react'
import type { ReactNode } from 'react'

export type Option = { id: string; label: string; icon?: ReactNode }

export function Picker({
  label, icon, title, options, value, onPick, onOpen, hint, className = ''
}: {
  label: string
  icon?: ReactNode
  title: string
  options: Option[]
  value: string
  onPick: (id: string) => void
  onOpen?: () => void
  hint?: string
  className?: string
}) {
  return (
    <DropdownMenu.Root onOpenChange={open => { if (open) onOpen?.() }}>
      <DropdownMenu.Trigger>
        <Button variant="soft" color="gray" size="1" aria-label={label + ' · ' + title} className={'choice ' + className}>
          {icon}
          <span>{title}</span>
          <ChevronDown size={12} />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content size="2" side="top" align="start" sideOffset={7} className="choice-list">
        <DropdownMenu.Label>{label}</DropdownMenu.Label>
        {options.map(o => (
          <DropdownMenu.Item key={o.id} onSelect={() => onPick(o.id)}>
            {o.icon}
            <span className="option-text">{o.label}</span>
            {value === o.id && <Check size={14} />}
          </DropdownMenu.Item>
        ))}
        {hint && <div className="picker-hint">{hint}</div>}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  )
}

export function DeleteButton({
  project = false, name, onDelete
}: {
  project?: boolean
  name: string
  onDelete: () => void
}) {
  const label = project ? '移除项目' : '删除讨论'
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger>
        <IconButton
          size="1"
          variant="ghost"
          color="gray"
          className="row-action danger"
          aria-label={label + ' ' + name}
          title={label}
          onClick={e => e.stopPropagation()}
        >
          <Trash2 size={13} />
        </IconButton>
      </AlertDialog.Trigger>
      <AlertDialog.Content maxWidth="400px">
        <AlertDialog.Title>{label}「{name}」？</AlertDialog.Title>
        <AlertDialog.Description size="2">
          {project
            ? '这个项目的本地讨论记录将一并移除，磁盘上的项目文件会保留。'
            : '这段讨论的消息和会话关联将从 OminiHive 中删除。'}
        </AlertDialog.Description>
        <Flex gap="3" justify="end" mt="5">
          <AlertDialog.Cancel><Button variant="soft" color="gray">取消</Button></AlertDialog.Cancel>
          <AlertDialog.Action><Button color="red" onClick={onDelete}>{label}</Button></AlertDialog.Action>
        </Flex>
      </AlertDialog.Content>
    </AlertDialog.Root>
  )
}
