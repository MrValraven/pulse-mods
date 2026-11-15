export type AgentStatus = 'running' | 'done' | 'failed'

export type AgentRun = {
  id: string
  agentId?: string
  type: string
  description: string
  model: string
  effort?: string
  status: AgentStatus
  startedAt: number
  endedAt?: number
  contextTokens: number
  contextMax: number
  tokens: number
  costUsd: number
  steps: number
  // True once a step ran on a model the price table has no row for: the run shows "price unknown".
  isPriceUnknown?: boolean
  // `turn.complete`'s reason for a run that ended (answer, aborted, refusal, error, or one this mod does not know).
  endReason?: string
  // The last step's stop reason (max_tokens, model_context_window_exceeded, ...), to name the limit an error hit.
  lastStepStop?: string | null
  // What the end said beyond its reason: a refusal's category, or an API error's own line (its status or message).
  endDetail?: string
  // The context percent the pane showed just before it last changed, and when (ms), so the fill can tween.
  ctxFrom?: number
  ctxAt?: number
}

// What the band draws: the finished count, how many of those stopped, and the step it is tweening from.
export type BarState = {
  done: number
  total: number
  stopped?: number
  fromRatio: number
  fromDone: number
  fromTotal: number
  fromStopped?: number
  changedAt: number
}

export type View = {
  isCompact: boolean
  isDoneCollapsed: boolean
  isBandHidden: boolean
  didAutoOpen: boolean
  // Whether the /pulse panel is open, so the band can show its "/pulse" hint while it is closed.
  isPaneOpen?: boolean
}

// The runs the band's clear removed, kept for its Undo until `until` (ms).
export type ClearedRuns = { runs: AgentRun[]; until: number } | null

declare module 'claude-code' {
  interface PluginState {
    'pulse-progress': {
      agents: AgentRun[]
      view: View
      now: number
      bar: BarState
      cleared: ClearedRuns
    }
  }
}
