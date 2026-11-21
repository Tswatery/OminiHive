import React, { createContext, useContext, useEffect, useState } from 'react'
import { Check, ChevronRight, ExternalLink, Images, ShieldAlert } from 'lucide-react'
import { cleanError } from './errors'
import { LocalImageThumb, type LightboxImageItem } from './ImageLightbox'
import { shortenPathsInText } from './filePresentation'

/** Project root of the current room, used to show step paths relative to it. */
export const ProjectDirContext = createContext<string>('')

import {
  extractStepImages,
  formatDuration,
  summarizeStepGroup,
  type StepBlock,
  type StepInteractionOption
} from './steps'

export {
  buildTimelineSegments,
  formatDuration,
  parseStepsWithMeta,
  summarizeStepGroup,
  type StepBlock,
  type StepEndState,
  type StepInteraction,
  type StepInteractionOption,
  type ParsedStepsResult,
  type TimelineSegment
} from './steps'

export function StepTimelineItem({
  step,
  defaultOpen = false,
  onRespondInteraction,
  onFocusAntigravity
}: {
  step: StepBlock
  defaultOpen?: boolean
  onRespondInteraction: (payload: {
    cascadeId: string
    trajectoryId?: string
    stepIndex: number
    payload: Record<string, unknown>
  }) => Promise<unknown>
  onFocusAntigravity: () => Promise<unknown>
}) {
  const projectDir = useContext(ProjectDirContext)
  const [manualOpen, setManualOpen] = useState<boolean | null>(null)
  const [submittingId, setSubmittingId] = useState('')
  const [submittedLabel, setSubmittedLabel] = useState('')
  const [submitErr, setSubmitErr] = useState('')
  const [customAnswer, setCustomAnswer] = useState('')
  const hasDetail = Boolean(step.detail?.trim())
  const open = manualOpen !== null ? manualOpen : defaultOpen
  const interaction = step.status === 'waiting' ? step.interaction : null

  useEffect(() => {
    if (step.status !== 'waiting') {
      setSubmittingId('')
      setSubmittedLabel('')
      setSubmitErr('')
      setCustomAnswer('')
    }
  }, [step.status])

  async function pickOption(opt: StepInteractionOption) {
    if (!interaction || submittingId) return
    setSubmittingId(opt.id)
    setSubmitErr('')
    try {
      await onRespondInteraction({
        cascadeId: interaction.cascadeId,
        trajectoryId: interaction.trajectoryId,
        stepIndex: interaction.stepIndex,
        payload: opt.payload
      })
      setSubmittedLabel(opt.label)
    } catch (e) {
      setSubmitErr(cleanError(e))
    } finally {
      setSubmittingId('')
    }
  }

  async function submitCustomAnswer() {
    const clean = customAnswer.trim()
    if (!interaction || !clean || submittingId) return
    setSubmittingId('__custom__')
    setSubmitErr('')
    try {
      await onRespondInteraction({
        cascadeId: interaction.cascadeId,
        trajectoryId: interaction.trajectoryId,
        stepIndex: interaction.stepIndex,
        payload: { answer: clean }
      })
      setSubmittedLabel(clean)
      setCustomAnswer('')
    } catch (e) {
      setSubmitErr(cleanError(e))
    } finally {
      setSubmittingId('')
    }
  }

  return (
    <div className={`step-row ${step.status} ${step.kind}`}>
      <button
        type="button"
        className="step-row-head"
        disabled={!hasDetail}
        onClick={() => hasDetail && setManualOpen(!open)}
      >
        <span className={'step-dot ' + step.status}>
          {step.status === 'running' || step.status === 'waiting'
            ? <span className="pulse-dot mini" />
            : step.status === 'error' ? '✕' : step.status === 'stopped' ? '–' : '✓'}
        </span>
        <span className={'step-title' + (step.kind === 'cmd' ? ' is-cmd' : '')} title={step.title}>{shortenPathsInText(step.title, projectDir)}</span>
        {step.status === 'running' && <span className="step-badge running">运行中</span>}
        {step.status === 'waiting' && <span className="step-badge waiting">等待确认</span>}
        {step.status === 'error' && <span className="step-badge error">失败</span>}
        {step.status === 'stopped' && <span className="step-badge stopped">未完成</span>}
        {hasDetail && <ChevronRight size={12} className={'step-caret ' + (open ? 'open' : '')} />}
      </button>
      {interaction && (
        <div className="step-interact">
          <div className="step-interact-head">
            <div className="step-interact-title">
              <ShieldAlert size={13} />
              <strong>{interaction.title}</strong>
            </div>
            {(!interaction.provider || interaction.provider === 'Antigravity') && (
              <button
                type="button"
                className="step-interact-open"
                onClick={() => void onFocusAntigravity()}
                title="切换到 Antigravity 客户端"
              >
                <span>去 Antigravity</span>
                <ExternalLink size={11} />
              </button>
            )}
          </div>
          {interaction.target && (
            <div className="step-interact-target">{interaction.target}</div>
          )}
          {interaction.reason && (
            <div className="step-interact-reason">{interaction.reason}</div>
          )}
          {submittedLabel ? (
            <div className="step-interact-sent">
              <Check size={12} />
              <span>已选择「{submittedLabel}」，正在等待客户端继续执行…</span>
            </div>
          ) : (
            <>
              {interaction.options.length > 0 ? (
                <div className="step-interact-opts">
                  {interaction.options.map((opt, idx) => (
                    <button
                      key={opt.id}
                      type="button"
                      disabled={Boolean(submittingId)}
                      title={opt.description || opt.label}
                      className={'step-interact-opt' + (opt.danger ? ' danger' : '') + (idx === 0 && !opt.danger ? ' primary' : '')}
                      onClick={() => void pickOption(opt)}
                    >
                      <span className="opt-num">{idx + 1}</span>
                      <span>{submittingId === opt.id ? '提交中…' : opt.label}</span>
                    </button>
                  ))}
                </div>
              ) : (!interaction.allowCustom && (
                <div className="step-interact-opts">
                  <button
                    type="button"
                    className="step-interact-opt primary"
                    onClick={() => void onFocusAntigravity()}
                  >
                    <ExternalLink size={12} />
                    <span>打开 Antigravity 处理</span>
                  </button>
                </div>
              ))}
              {interaction.allowCustom && (
                <div className="step-interact-custom">
                  <input
                    type="text"
                    placeholder="或直接输入自定义回复，按 Enter 提交…"
                    value={customAnswer}
                    disabled={Boolean(submittingId)}
                    onChange={e => setCustomAnswer(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                        e.preventDefault()
                        void submitCustomAnswer()
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="step-interact-opt primary"
                    disabled={!customAnswer.trim() || Boolean(submittingId)}
                    onClick={() => void submitCustomAnswer()}
                  >
                    {submittingId === '__custom__' ? '提交中…' : '提交'}
                  </button>
                </div>
              )}
            </>
          )}
          {submitErr && <div className="step-interact-err">{submitErr}</div>}
        </div>
      )}
      {open && hasDetail && <pre className="step-detail">{step.detail}</pre>}
    </div>
  )
}

function StepImageGallery({
  steps,
  roomId,
  onOpenLightbox,
  onFileContextMenu
}: {
  steps: StepBlock[]
  roomId?: string
  onOpenLightbox?: (items: LightboxImageItem[], index: number) => void
  onFileContextMenu?: (e: React.MouseEvent, absPath: string, allowPreview?: boolean) => void
}) {
  const images = extractStepImages(steps)
  const [open, setOpen] = useState(true)
  if (!images.length) return null

  return (
    <div className="step-img-gallery">
      <button type="button" className="step-img-gallery-head" onClick={() => setOpen(v => !v)}>
        <Images size={13} />
        <span>已查看 {images.length} 张图像</span>
        <ChevronRight size={12} className={'step-caret ' + (open ? 'open' : '')} />
      </button>
      {open && (
        <div className="step-img-strip">
          {images.map((img, i) => (
            <LocalImageThumb
              key={img.path}
              path={img.path}
              roomId={roomId}
              alt={img.name}
              onOpen={(resolvedPath, dataUrl) => {
                if (onOpenLightbox) {
                  const list: LightboxImageItem[] = images.map((it, idx) =>
                    idx === i ? { path: resolvedPath, name: it.name, dataUrl } : { path: it.path, name: it.name }
                  )
                  onOpenLightbox(list, i)
                } else {
                  void window.hive.openPath(resolvedPath, roomId)
                }
              }}
              onContextMenu={(e, absPath) => onFileContextMenu?.(e, absPath, true)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function ExecutionTimeline({
  steps,
  isRunning,
  connected = false,
  hasBody = false,
  duration,
  defaultExpanded = false,
  roomId,
  onRespondInteraction,
  onFocusAntigravity,
  onOpenLightbox,
  onFileContextMenu
}: {
  steps: StepBlock[]
  isRunning: boolean
  connected?: boolean
  hasBody?: boolean
  duration?: number
  defaultExpanded?: boolean
  roomId?: string
  onRespondInteraction: (payload: {
    cascadeId: string
    trajectoryId?: string
    stepIndex: number
    payload: Record<string, unknown>
  }) => Promise<unknown>
  onFocusAntigravity: () => Promise<unknown>
  onOpenLightbox?: (items: LightboxImageItem[], index: number) => void
  onFileContextMenu?: (e: React.MouseEvent, absPath: string, allowPreview?: boolean) => void
}) {
  const [showAllLive, setShowAllLive] = useState(false)
  if (isRunning) {
    const hasWaiting = steps.some(s => s.status === 'waiting')
    const tail = steps.slice(-3)
    const liveSteps = showAllLive
      ? steps
      : hasWaiting
        ? [...steps.filter(s => s.status === 'waiting' && !tail.includes(s)), ...tail]
        : tail
    const hiddenCount = Math.max(0, steps.length - liveSteps.length)
    if (liveSteps.length === 0 && hasBody) return null

    return (
      <div className="step-timeline live">
        {(hiddenCount > 0 || showAllLive) && steps.length > 3 && (
          <button type="button" className="step-hidden-hint" onClick={() => setShowAllLive(v => !v)}>
            <ChevronRight size={11} className={'step-caret ' + (showAllLive ? 'open' : '')} />
            {showAllLive ? '只看最近步骤' : `已完成前 ${hiddenCount} 步 · 展开`}
          </button>
        )}
        {liveSteps.length > 0 ? (
          liveSteps.map(s => (
            <StepTimelineItem
              key={s.id}
              step={s}
              defaultOpen={s.status === 'running' && s.kind === 'thought'}
              onRespondInteraction={onRespondInteraction}
              onFocusAntigravity={onFocusAntigravity}
            />
          ))
        ) : (
          <div className={'step-row ' + (connected ? 'done' : 'info') + ' info live-progress-row'}>
            <button type="button" className="step-row-head" disabled>
              <span className={'step-dot ' + (connected ? 'done' : 'running')}>
                {connected ? '✓' : <span className="pulse-dot mini" />}
              </span>
              <span className="step-title">
                {connected ? '已连接客户端，模型思考中…' : '正在准备上下文并连接客户端…'}
              </span>
            </button>
          </div>
        )}
        <StepImageGallery steps={steps} roomId={roomId} onOpenLightbox={onOpenLightbox} onFileContextMenu={onFileContextMenu} />
      </div>
    )
  }

  if (steps.length === 0) return null

  return (
    <div className="step-group-wrap">
      <details className="log-box" open={defaultExpanded || undefined}>
        <summary>
          <ChevronRight size={13} className="log-caret" />
          <span>{steps.length} 步{duration ? ` · ${formatDuration(duration)}` : ''}</span>
        </summary>
        <div className="step-timeline">
          {steps.map(s => (
            <StepTimelineItem
              key={s.id}
              step={s}
              defaultOpen={s.status === 'error'}
              onRespondInteraction={onRespondInteraction}
              onFocusAntigravity={onFocusAntigravity}
            />
          ))}
        </div>
      </details>
      <StepImageGallery steps={steps} roomId={roomId} onOpenLightbox={onOpenLightbox} onFileContextMenu={onFileContextMenu} />
    </div>
  )
}

export function InlineStepGroup({
  steps,
  isActiveGroup,
  defaultExpanded = false,
  roomId,
  onRespondInteraction,
  onFocusAntigravity,
  onOpenLightbox,
  onFileContextMenu
}: {
  steps: StepBlock[]
  isActiveGroup: boolean
  defaultExpanded?: boolean
  roomId?: string
  onRespondInteraction: (payload: {
    cascadeId: string
    trajectoryId?: string
    stepIndex: number
    payload: Record<string, unknown>
  }) => Promise<unknown>
  onFocusAntigravity: () => Promise<unknown>
  onOpenLightbox?: (items: LightboxImageItem[], index: number) => void
  onFileContextMenu?: (e: React.MouseEvent, absPath: string, allowPreview?: boolean) => void
}) {
  const [showAllLive, setShowAllLive] = useState(false)
  if (steps.length === 0) return null

  if (isActiveGroup) {
    const hasWaiting = steps.some(s => s.status === 'waiting')
    const tail = steps.slice(-4)
    const liveSteps = showAllLive
      ? steps
      : hasWaiting
        ? [...steps.filter(s => s.status === 'waiting' && !tail.includes(s)), ...tail]
        : tail
    const hiddenCount = Math.max(0, steps.length - liveSteps.length)

    return (
      <div className="step-group-wrap">
        <div className="step-timeline live inline-step-live">
          {(hiddenCount > 0 || showAllLive) && steps.length > 4 && (
            <button type="button" className="step-hidden-hint" onClick={() => setShowAllLive(v => !v)}>
              <ChevronRight size={11} className={'step-caret ' + (showAllLive ? 'open' : '')} />
              {showAllLive ? '只看最近步骤' : `已完成前 ${hiddenCount} 步 · 展开`}
            </button>
          )}
          {liveSteps.map(s => (
            <StepTimelineItem
              key={s.id}
              step={s}
              defaultOpen={s.status === 'running' && s.kind === 'thought'}
              onRespondInteraction={onRespondInteraction}
              onFocusAntigravity={onFocusAntigravity}
            />
          ))}
        </div>
        <StepImageGallery steps={steps} roomId={roomId} onOpenLightbox={onOpenLightbox} onFileContextMenu={onFileContextMenu} />
      </div>
    )
  }

  const label = summarizeStepGroup(steps, false)
  return (
    <div className="step-group-wrap">
      <details className="log-box inline-step-group" open={defaultExpanded || undefined}>
        <summary>
          <ChevronRight size={13} className="log-caret" />
          <span className="inline-step-summary">{label}</span>
          {steps.length > 1 && <span className="inline-step-count">· {steps.length} 步</span>}
        </summary>
        <div className="step-timeline">
          {steps.map(s => (
            <StepTimelineItem
              key={s.id}
              step={s}
              defaultOpen={s.status === 'error'}
              onRespondInteraction={onRespondInteraction}
              onFocusAntigravity={onFocusAntigravity}
            />
          ))}
        </div>
      </details>
      <StepImageGallery steps={steps} roomId={roomId} onOpenLightbox={onOpenLightbox} onFileContextMenu={onFileContextMenu} />
    </div>
  )
}
