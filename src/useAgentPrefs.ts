import { useEffect, useRef, useState } from 'react'
import type { Agent } from './agentMeta'
import type { AccessMode } from './ComposerToolbar'
import type { ModelOption } from './Preferences'
import { loadJson } from './storage'

/** Per-agent run settings sent to the main process with every message. */
export type AgentPrefs = Partial<Record<Agent, {
  model: string
  effort: string
  fast?: boolean
  write?: boolean
  access?: AccessMode
  provider?: string
  fresh?: boolean
}>>

function loadAccessModes(): Partial<Record<Agent, AccessMode>> {
  const raw = loadJson<Record<string, unknown>>('ominihive:writes', {})
  const next: Partial<Record<Agent, AccessMode>> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (v === 'read-only' || v === 'workspace' || v === 'full') next[k as Agent] = v
    else if (v === true) next[k as Agent] = 'workspace' // legacy boolean "write" flag
    else if (v === false) next[k as Agent] = 'read-only'
  }
  return next
}

/**
 * Owns everything that decides *how* an agent runs: chosen model, effort per model,
 * access mode, CC Switch provider, "fresh session" flags, and the model catalog.
 * Persisted settings live in localStorage; fresh-session flags are per room and in-memory.
 */
export function useAgentPrefs() {
  const [accessModes, setAccessModes] = useState<Partial<Record<Agent, AccessMode>>>(loadAccessModes)
  const [providers, setProviders] = useState<Partial<Record<Agent, string>>>(() => loadJson('ominihive:providers', {}))
  const [selected, setSelected] = useState<Partial<Record<Agent, string>>>(() => loadJson('ominihive:models', {}))
  const [efforts, setEfforts] = useState<Record<string, string>>(() => loadJson('ominihive:efforts', {}))
  const [codexFast, setCodexFast] = useState<boolean>(() => Boolean(loadJson<boolean>('ominihive:codex-fast', false)))
  /** key: `${roomId}:${agent}` → next send starts a new native session */
  const [freshSessions, setFreshSessions] = useState<Record<string, boolean>>({})
  const [catalog, setCatalog] = useState<Partial<Record<Agent, ModelOption[]>>>({})
  const [hints, setHints] = useState<Partial<Record<Agent, string>>>({})
  const requests = useRef<Partial<Record<Agent, number>>>({})

  useEffect(() => { localStorage.setItem('ominihive:writes', JSON.stringify(accessModes)) }, [accessModes])
  useEffect(() => { localStorage.setItem('ominihive:providers', JSON.stringify(providers)) }, [providers])
  useEffect(() => { localStorage.setItem('ominihive:models', JSON.stringify(selected)) }, [selected])
  useEffect(() => { localStorage.setItem('ominihive:efforts', JSON.stringify(efforts)) }, [efforts])
  useEffect(() => { localStorage.setItem('ominihive:codex-fast', JSON.stringify(codexFast)) }, [codexFast])

  /** Show the cached list immediately, then refresh from the client; stale responses are dropped. */
  async function loadModels(a: Agent) {
    const request = (requests.current[a] || 0) + 1
    requests.current[a] = request
    let cached: ModelOption[] = [], isReference = false
    try {
      const initial = await window.hive.cachedModels(a)
      cached = initial.list; isReference = initial.reference
      if (requests.current[a] !== request) return
      setCatalog(c => ({ ...c, [a]: cached }))
      setHints(h => ({ ...h, [a]: isReference ? '参考列表 · 正在核对' : cached.length ? '' : '首次读取模型列表…' }))
      const list = await window.hive.models(a)
      if (requests.current[a] !== request) return
      setCatalog(c => ({ ...c, [a]: list }))
      setHints(h => ({ ...h, [a]: '' }))
    } catch {
      if (requests.current[a] !== request) return
      setCatalog(c => ({ ...c, [a]: cached }))
      setHints(h => ({ ...h, [a]: isReference ? '暂未连上客户端，显示参考列表' : cached.length ? '刷新失败，显示缓存' : '读取失败，打开重试' }))
    }
  }

  /**
   * Build the prefs payload for a send. `forRoom` / `extraAgents` matter for queued sends that
   * drain while another room is open: fresh flags are per room, and every target needs explicit
   * prefs so the main process never falls back to the currently inspected agent's write flag.
   */
  function buildPrefs(members: Agent[], forRoom: string, extraAgents: Agent[] = []): AgentPrefs {
    const prefs: AgentPrefs = {}
    for (const a of new Set<Agent>([...members, ...extraAgents])) {
      const m = selected[a] || ''
      const activeM = catalog[a]?.find(opt => m ? opt.id === m : opt.isDefault)
      const k = a + '/' + (activeM?.id || m)
      const ef = activeM?.efforts?.includes(efforts[k]) ? efforts[k] : ''
      const acc: AccessMode = accessModes[a] || 'read-only'
      prefs[a] = {
        model: m,
        effort: ef,
        ...(a === 'Codex' ? { fast: codexFast } : {}),
        write: acc !== 'read-only',
        access: acc,
        provider: providers[a] || '',
        fresh: Boolean(forRoom && freshSessions[forRoom + ':' + a])
      }
    }
    return prefs
  }

  return {
    accessModes, setAccessModes,
    providers, setProviders,
    selected, setSelected,
    efforts, setEfforts,
    codexFast, setCodexFast,
    freshSessions, setFreshSessions,
    catalog, hints, loadModels,
    buildPrefs
  }
}
