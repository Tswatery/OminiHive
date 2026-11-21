import React from 'react'
import { ChevronRight, Download, FolderTree, PanelLeft, RefreshCw, SquarePen } from 'lucide-react'
import { TypewriterTitle, isAutoTitle } from './TypewriterTitle'

export type ChatHeaderProps = {
  collapsed: boolean
  onExpandSidebar: () => void
  /** Shown only while the sidebar is collapsed, since the sidebar owns the "new room" entry otherwise. */
  onNewRoom: () => void
  project: { id: string; name: string; dir: string } | null
  currentRoom: { id: string; project: string; title: string; title_locked?: number; title_auto?: number } | null
  onOpenProjectDir: (dir: string) => void
  /** Slot for the room-members picker (kept outside so the header doesn't forward its props). */
  members?: React.ReactNode
  syncing: boolean
  onSyncRoom: () => void
  showFiles: boolean
  onToggleFiles: () => void
  onOpenImport: () => void
}

export function ChatHeader({
  collapsed,
  onExpandSidebar,
  onNewRoom,
  project,
  currentRoom,
  onOpenProjectDir,
  members,
  syncing,
  onSyncRoom,
  showFiles,
  onToggleFiles,
  onOpenImport
}: ChatHeaderProps) {
  return (
    <header className={'chathead ' + (collapsed ? 'with-traffic-lights' : '')}>
      {collapsed && (
        <>
          <button type="button" className="icon-btn" title="展开项目栏 (⌘/)" aria-label="展开项目栏" onClick={onExpandSidebar}>
            <PanelLeft size={16} />
          </button>
          {project && (
            <button type="button" className="icon-btn" title="新建讨论 (⌘N)" aria-label="新讨论" onClick={onNewRoom}>
              <SquarePen size={15} />
            </button>
          )}
        </>
      )}
      <div className="head-title">
        {project ? (
          <>
            <span className="head-proj" onClick={() => onOpenProjectDir(project.dir)} title={'在 Finder 打开 ' + project.dir}>
              {project.name}
            </span>
            <ChevronRight size={13} className="head-sep" />
            {currentRoom && (
              <strong><TypewriterTitle key={currentRoom.id} text={currentRoom.title} animate={isAutoTitle(currentRoom)} /></strong>
            )}
          </>
        ) : (
          <strong>OminiHive</strong>
        )}
      </div>

      <div className="head-actions">
        {project && (
          <>
            {members}
            <button
              type="button"
              className="head-icon-btn"
              disabled={syncing}
              onClick={onSyncRoom}
              title="从客户端同步外部最新对话"
              aria-label="同步外部对话"
            >
              <RefreshCw size={15} className={syncing ? 'spin' : ''} />
            </button>
            <button
              type="button"
              className={'head-icon-btn' + (showFiles ? ' active' : '')}
              onClick={onToggleFiles}
              title="展开或收起项目文件目录"
              aria-label="项目文件"
            >
              <FolderTree size={15} />
            </button>
            <button
              type="button"
              className="head-icon-btn"
              onClick={onOpenImport}
              title="从外部客户端导入已有会话"
              aria-label="导入会话"
            >
              <Download size={15} />
            </button>
          </>
        )}
      </div>
    </header>
  )
}
