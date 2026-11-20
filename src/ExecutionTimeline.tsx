import React, { useEffect, useRef, useState } from 'react'
import { Check, ChevronRight, ExternalLink, ShieldAlert, Terminal } from 'lucide-react'
import { cleanError } from './errors'

import {
  formatDuration,
  type StepBlock,
  type StepInteractionOption
} from './steps'

export {
  formatDuration,
  parseStepsWithMeta,
  type StepBlock,
  type StepEndState,
  type StepInteraction,
  type StepInteractionOption,
  type ParsedStepsResult
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
  const [manualOpen, setManualOpen] = useState<boolean | null>(null)
  const [submittingId, setSubmittingId] = useState('')
  const [submittedLabel, setSubmittedLabel] = useState('')
  const [submitErr, setSubmitErr] = useState('')
  const [customAnswer, setCustomAnswer] = useState('')
  const detailRef = useRef<HTMLPreElement>(null)
  const hasDetail = Boolean(step.detail?.trim())
  const open = manualOpen !== null ? manualOpen : defaultOpen
  const interaction = step.status === 'waiting' ? step.interaction : null

  useEffect(() => {
    if (open && step.status === 'running' && detailRef.current) {
      detailRef.current.scrollTop = detailRef.current.scrollHeight
    }
  }, [open, step.status, step.detail])

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
        <span className={'step-title' + (step.kind === 'cmd' ? ' is-cmd' : '')}>{step.title}</span>
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
      {open && hasDetail && <pre ref={detailRef} className="step-detail">{step.detail}</pre>}
    </div>
  )
}

export function ExecutionTimeline({
  steps,
  isRunning,
  duration,
  defaultExpanded = false,
  onRespondInteraction,
  onFocusAntigravity
}: {
  steps: StepBlock[]
  isRunning: boolean
  duration?: number
  defaultExpanded?: boolean
  onRespondInteraction: (payload: {
    cascadeId: string
    trajectoryId?: string
    stepIndex: number
    payload: Record<string, unknown>
  }) => Promise<unknown>
  onFocusAntigravity: () => Promise<unknown>
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
          <div className="live-progress">
            <Terminal size={12} />
            <span>正在准备上下文并连接客户端…</span>
          </div>
        )}
      </div>
    )
  }

  if (steps.length === 0) return null

  return (
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
  )
}
