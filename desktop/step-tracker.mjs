export function formatToolInput(input) {
  if (input == null) return ''
  if (typeof input === 'string') return input
  try { return JSON.stringify(input, null, 2) } catch { return String(input) }
}

export function extractToolResultText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(c => (typeof c === 'string' ? c : c?.text || c?.content || '')).filter(Boolean).join('\n')
  }
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text
    if (Array.isArray(content.content)) return extractToolResultText(content.content)
    if (typeof content.output === 'string') return content.output
    try { return JSON.stringify(content, null, 2) } catch { return String(content) }
  }
  return ''
}

export function summarizeToolTitle(name, input) {
  const n = name || '调用工具'
  if (input && typeof input === 'object') {
    const cmd = input.command || input.cmd
    if (typeof cmd === 'string' && cmd.trim()) {
      const s = cmd.trim().replace(/\s+/g, ' ')
      return `${n} · ${s.length > 72 ? s.slice(0, 72) + '…' : s}`
    }
    const fp = input.file_path || input.path || input.file || input.filename || input.pattern || input.query || input.url || input.glob
    if (typeof fp === 'string' && fp.trim()) {
      const s = fp.trim()
      return `${n} · ${s.length > 72 ? s.slice(0, 72) + '…' : s}`
    }
  }
  return n
}

/**
 * Base class for unified agent execution step tracking (thinking, tool calls, progress).
 * Protocol-specific adapters inherit from this class so every agent shares consistent step UX.
 */
export class AgentStepTracker {
  constructor({ emit, append, fail, prefix = 'step' }) {
    this.emit = emit
    this.append = append
    this.fail = fail
    this.prefix = prefix
    this.thinkSeq = 0
    this.thinkId = ''
    this.thinkBuf = ''
    this.thinkActive = false
    this.lastThinkEmit = 0
    this.tools = new Map()
    this.lastProgressEmit = 0
    this.hasTextOutput = false
  }

  emitStep(step) {
    this.emit('log', '::step::' + JSON.stringify(step))
  }

  startThinking(initial = '') {
    if (!this.thinkActive) {
      this.thinkId = `${this.prefix}-think-${++this.thinkSeq}`
      this.thinkBuf = typeof initial === 'string' ? initial : ''
      this.thinkActive = true
      this.lastThinkEmit = Date.now()
      this.emitStep({
        id: this.thinkId,
        kind: 'thought',
        title: '思考中',
        status: 'running',
        detail: this.thinkBuf ? this.thinkBuf.slice(-2000) : undefined
      })
    } else if (initial) {
      this.appendThinking(initial)
    }
  }

  appendThinking(delta) {
    if (!delta || typeof delta !== 'string') return
    if (!this.thinkActive) {
      this.startThinking(delta)
      return
    }
    this.thinkBuf = (this.thinkBuf + delta).slice(-3000)
    const now = Date.now()
    if (now - this.lastThinkEmit > 300) {
      this.lastThinkEmit = now
      this.emitStep({
        id: this.thinkId,
        kind: 'thought',
        title: '思考中',
        status: 'running',
        detail: this.thinkBuf.slice(-2000)
      })
    }
  }

  finishThinking(finalText = '') {
    if (finalText && typeof finalText === 'string' && finalText.trim()) {
      const id = this.thinkId || `${this.prefix}-think-${++this.thinkSeq}`
      this.thinkActive = false
      this.thinkBuf = ''
      this.emitStep({
        id,
        kind: 'thought',
        title: '思考过程',
        status: 'done',
        detail: finalText.trim().slice(-2000)
      })
      return
    }
    if (!this.thinkActive || !this.thinkId) return
    const detail = this.thinkBuf.trim()
    this.thinkActive = false
    this.thinkBuf = ''
    this.emitStep({
      id: this.thinkId,
      kind: 'thought',
      title: '思考过程',
      status: 'done',
      detail: detail ? detail.slice(-2000) : undefined
    })
  }

  startTool(id, name, input) {
    this.finishThinking()
    const tid = id || `${this.prefix}-tool-${this.tools.size + 1}`
    const title = summarizeToolTitle(name, input)
    const inStr = formatToolInput(input)
    this.tools.set(tid, { id: tid, name: name || '调用工具', title, inStr })
    this.emitStep({
      id: tid,
      kind: 'tool',
      title,
      status: 'running',
      detail: inStr ? `输入：\n${inStr.slice(0, 800)}` : undefined
    })
    return tid
  }

  updateTool(id, { name, input, partialOutput } = {}) {
    const prev = this.tools.get(id)
    const toolName = name || prev?.name || '调用工具'
    const inStr = input !== undefined ? formatToolInput(input) : (prev?.inStr || '')
    const title = input !== undefined ? summarizeToolTitle(toolName, input) : (prev?.title || toolName)
    this.tools.set(id, { id, name: toolName, title, inStr })
    const parts = []
    if (inStr) parts.push('输入：\n' + inStr.slice(0, 800))
    const outStr = partialOutput ? extractToolResultText(partialOutput).trim() : ''
    if (outStr) parts.push('输出中：\n' + outStr.slice(-1200))
    this.emitStep({
      id,
      kind: 'tool',
      title,
      status: 'running',
      detail: parts.length ? parts.join('\n\n') : undefined
    })
  }

  finishTool(id, { name, output, isError = false } = {}) {
    const prev = this.tools.get(id)
    const title = prev?.title || name || '工具调用'
    const outStr = extractToolResultText(output).trim()
    const parts = []
    if (prev?.inStr) parts.push('输入：\n' + prev.inStr.slice(0, 800))
    if (outStr) parts.push('返回：\n' + outStr.slice(-1400))
    this.emitStep({
      id: id || `${this.prefix}-tool-done`,
      kind: 'tool',
      title,
      status: isError ? 'error' : 'done',
      detail: parts.length ? parts.join('\n\n') : undefined
    })
  }

  emitText(text) {
    if (!text || typeof text !== 'string') return
    this.finishThinking()
    this.hasTextOutput = true
    this.append(text)
  }

  onStderrChunk(chunk) {
    const clean = String(chunk || '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim()
    if (!clean) return
    const line = clean.split(/\r?\n/).map(s => s.trim()).filter(Boolean).pop() || ''
    if (!line || line.length < 3 || /^warning:/i.test(line)) return
    const now = Date.now()
    if (now - this.lastProgressEmit < 600) return
    this.lastProgressEmit = now
    this.emitStep({
      id: `${this.prefix}-progress`,
      kind: 'info',
      title: line.length > 84 ? line.slice(0, 84) + '…' : line,
      status: 'running'
    })
  }

  finalize() {
    this.finishThinking()
  }

  handleLine(line) {
    if (line) this.emitText(line + '\n')
  }
}

/**
 * Adapter for OhMyPi (`omp --mode json`) and Pi (`pi --mode json`).
 */
export class PiStreamAdapter extends AgentStepTracker {
  constructor(opts) {
    super({ ...opts, prefix: opts.prefix || 'pi' })
    this.streamedText = false
  }

  handleLine(line) {
    if (!line || !line.trim()) return
    let e
    try { e = JSON.parse(line) } catch {
      this.emitText(line + '\n')
      return
    }
    if (e.sessionId || e.session_id) this.emit('session', e.sessionId || e.session_id)

    if (e.type === 'message_update' && e.assistantMessageEvent) {
      const ev = e.assistantMessageEvent
      if (ev.type === 'thinking_start') this.startThinking('')
      else if (ev.type === 'thinking_delta') this.appendThinking(ev.delta || '')
      else if (ev.type === 'thinking_end') this.finishThinking(ev.content || '')
      else if (ev.type === 'text_delta' && typeof ev.delta === 'string') {
        this.streamedText = true
        this.emitText(ev.delta)
      } else if (ev.type === 'toolcall_end' && ev.toolCall) {
        const tc = ev.toolCall
        this.startTool(tc.id, tc.name, tc.arguments ?? tc.input)
      }
      return
    }

    if (e.type === 'tool_execution_start') {
      this.startTool(e.toolCallId || e.id, e.toolName || e.name, e.args ?? e.arguments ?? e.input)
      return
    }
    if (e.type === 'tool_execution_update') {
      this.updateTool(e.toolCallId || e.id, {
        name: e.toolName || e.name,
        input: e.args,
        partialOutput: e.partialResult ?? e.output
      })
      return
    }
    if (e.type === 'tool_execution_end') {
      this.finishTool(e.toolCallId || e.id, {
        name: e.toolName || e.name,
        output: e.result ?? e.output,
        isError: Boolean(e.isError)
      })
      return
    }

    if (e.type === 'message_end' && e.message?.role === 'assistant') {
      const content = Array.isArray(e.message.content) ? e.message.content : []
      for (const block of content) {
        if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
          this.finishThinking(block.thinking)
        } else if (block?.type === 'text' && typeof block.text === 'string' && !this.streamedText) {
          this.emitText(block.text)
        }
      }
      if (e.message.stopReason === 'error' && e.message.errorMessage) {
        this.fail(Error(e.message.errorMessage))
      }
      return
    }

    if (e.type === 'error') {
      this.fail(Error(e.message || e.error?.message || 'Pi / OhMyPi 执行失败'))
    }
  }
}

/**
 * Adapter for OpenCode (`opencode run --format json`).
 */
export class OpenCodeStreamAdapter extends AgentStepTracker {
  constructor(opts) {
    super({ ...opts, prefix: 'opencode' })
  }

  handleLine(line) {
    if (!line || !line.trim()) return
    let e
    try { e = JSON.parse(line) } catch { return }
    if (e.sessionID) this.emit('session', e.sessionID)
    if (e.type === 'reasoning' || e.type === 'thinking') {
      const txt = e.part?.text || e.text || ''
      if (txt) this.finishThinking(txt)
      return
    }
    if (e.type === 'tool_use' || (e.type === 'tool' && e.part)) {
      const part = e.part || e
      const tid = part.callID || part.id || part.tool || 'opencode-tool'
      const state = part.state || {}
      if (state.status === 'completed' || state.status === 'error') {
        this.finishTool(tid, {
          name: part.tool || part.name,
          output: state.output ?? state.error ?? state.title,
          isError: state.status === 'error'
        })
      } else {
        this.startTool(tid, part.tool || part.name, state.input ?? part.input)
      }
      return
    }
    if (e.type === 'text' && typeof e.part?.text === 'string') {
      this.emitText(e.part.text)
      return
    }
    if (e.type === 'error') {
      this.fail(Error(e.error?.data?.message || e.message || 'OpenCode 执行失败'))
    }
  }
}

/**
 * Adapter for Qwen (`qwen -p ... --output-format stream-json`).
 */
export class QwenStreamAdapter extends AgentStepTracker {
  constructor(opts) {
    super({ ...opts, prefix: 'qwen' })
  }

  handleLine(line) {
    if (!line || !line.trim()) return
    let e
    try { e = JSON.parse(line) } catch { return }
    if (e.session_id) this.emit('session', e.session_id)
    if (e.type === 'assistant') {
      for (const block of e.message?.content || []) {
        if (block?.type === 'thinking' && typeof block.thinking === 'string') {
          this.finishThinking(block.thinking)
        } else if (block?.type === 'tool_use') {
          this.startTool(block.id, block.name, block.input)
        } else if (block?.type === 'text' && typeof block.text === 'string') {
          this.emitText(block.text)
        }
      }
      return
    }
    if (e.type === 'user') {
      for (const block of e.message?.content || []) {
        if (block?.type === 'tool_result') {
          this.finishTool(block.tool_use_id, {
            output: block.content,
            isError: Boolean(block.is_error)
          })
        }
      }
      return
    }
    if (e.type === 'result' && !this.hasTextOutput && typeof e.result === 'string') {
      this.emitText(e.result)
    }
  }
}

/**
 * Adapter for DeepSeek Harness (`dsh headless --json ...`).
 * Parses newline-delimited events emitted by `@deepseek-ai/dsh-headless`:
 * session, status, thinking, text, tool_call, tool_result, final, error.
 */
export class DeepSeekStreamAdapter extends AgentStepTracker {
  constructor(opts) {
    super({ ...opts, prefix: 'deepseek' })
  }

  handleLine(line) {
    if (!line || !line.trim()) return
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) {
      this.emitText(line + '\n')
      return
    }
    let e
    try { e = JSON.parse(trimmed) } catch {
      this.emitText(line + '\n')
      return
    }
    if (e.type === 'session') {
      if (e.sessionId) this.emit('session', e.sessionId)
      return
    }
    if (e.type === 'status') {
      if (e.phase === 'turn_end' && e.reason?.kind === 'error' && e.reason?.error?.message) {
        this.fail(Error(e.reason.error.message))
      }
      return
    }
    if (e.type === 'thinking') {
      if (typeof e.text === 'string' && e.text.trim()) this.finishThinking(e.text)
      return
    }
    if (e.type === 'text') {
      if (typeof e.text === 'string') this.emitText(e.text)
      return
    }
    if (e.type === 'tool_call') {
      this.startTool(e.callId || e.id, e.tool || e.name, e.input ?? e.arguments)
      return
    }
    if (e.type === 'tool_result') {
      const errMsg = typeof e.error === 'string' ? e.error : e.error?.message
      this.finishTool(e.callId || e.id, {
        name: e.tool || e.name,
        output: e.result ?? e.output ?? errMsg ?? '',
        isError: Boolean(e.status === 'error' || e.is_error || e.error)
      })
      return
    }
    if (e.type === 'final') {
      if (e.sessionId) this.emit('session', e.sessionId)
      if (!this.hasTextOutput && typeof e.text === 'string' && e.text) {
        this.emitText(e.text)
      }
      if (e.reason?.kind === 'error' && e.reason?.error?.message) {
        this.fail(Error(e.reason.error.message))
      }
      return
    }
    if (e.type === 'error') {
      this.fail(Error(e.message || 'DeepSeek Harness 执行失败'))
    }
  }
}

/**
 * Generic adapter for simple CLIs (Hermes, MiniMax, Grok, OpenClaw):
 * parses structured JSONL events if emitted, otherwise streams plain text + stderr progress.
 */
export class SimpleCliAdapter extends AgentStepTracker {
  constructor(opts) {
    super({ ...opts, prefix: opts.prefix || 'cli' })
  }

  handleLine(line) {
    if (!line) {
      this.emitText('\n')
      return
    }
    const trimmed = line.trim()
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const e = JSON.parse(trimmed)
        if (e.type === 'thinking' || e.type === 'reasoning') {
          this.appendThinking(e.delta || e.text || e.content || '')
          return
        }
        if (e.type === 'tool_use' || e.type === 'tool_call') {
          this.startTool(e.id || e.tool_id, e.name || e.tool_name, e.input ?? e.arguments ?? e.parameters)
          return
        }
        if (e.type === 'tool_result') {
          this.finishTool(e.tool_use_id || e.tool_id || e.id, {
            name: e.name || e.tool_name,
            output: e.output ?? e.result ?? e.content,
            isError: Boolean(e.is_error || e.status === 'error')
          })
          return
        }
        if (typeof e.text === 'string' || typeof e.delta?.text === 'string') {
          this.emitText(e.delta?.text || e.text)
          return
        }
      } catch {}
    }
    this.emitText(line + '\n')
  }
}

export function createStepAdapter(agent, opts) {
  if (agent === 'OhMyPi' || agent === 'Pi') return new PiStreamAdapter({ ...opts, prefix: agent.toLowerCase() })
  if (agent === 'OpenCode') return new OpenCodeStreamAdapter(opts)
  if (agent === 'Qwen') return new QwenStreamAdapter(opts)
  if (agent === 'DeepSeek') return new DeepSeekStreamAdapter(opts)
  return new SimpleCliAdapter({ ...opts, prefix: String(agent || 'cli').toLowerCase() })
}
