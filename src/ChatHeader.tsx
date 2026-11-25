import React from 'react'
import { ChevronRight, Download, FolderTree, PanelLeft, RefreshCw, SquarePen } from 'lucide-react'
import { TypewriterTitle, isAutoTitle } from './TypewriterTitle'
import { Tip } from './Tip'

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
          <Tip side="bottom" content="展开项目栏 (⌘/)">
            <button type="button" className="icon-btn" aria-label="展开项目栏" onClick={onExpandSidebar}>
              <PanelLeft size={16} />
            </button>
          </Tip>
          {project && (
            <Tip side="bottom" content="新建讨论 (⌘N)">
              <button type="button" className="icon-btn" aria-label="新讨论" onClick={onNewRoom}>
                <SquarePen size={15} />
              </button>
            </Tip>
          )}
        </>
      )}
      <div className="head-title">
        {project ? (
          <>
            <Tip side="bottom" content={'在 Finder 打开 ' + project.dir}>
              <span className="head-proj" onClick={() => onOpenProjectDir(project.dir)}>
                {project.name}
              </span>
            </Tip>
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
            <Tip side="bottom" allowDisabled content="从客户端同步外部最新对话">
              <button
                type="button"
                className="head-icon-btn"
                disabled={syncing}
                onClick={onSyncRoom}
                aria-label="同步外部对话"
              >
                <RefreshCw size={15} className={syncing ? 'spin' : ''} />
              </button>
            </Tip>
            <Tip side="bottom" content={showFiles ? '收起项目文件目录' : '展开项目文件目录'}>
              <button
                type="button"
                className={'head-icon-btn' + (showFiles ? ' active' : '')}
                onClick={onToggleFiles}
                aria-label="项目文件"
              >
                <FolderTree size={15} />
              </button>
            </Tip>
            <Tip side="bottom" content="从外部客户端导入已有会话">
              <button
                type="button"
                className="head-icon-btn"
                onClick={onOpenImport}
                aria-label="导入会话"
              >
                <Download size={15} />
              </button>
            </Tip>
          </>
        )}
      </div>
    </header>
  )
}
