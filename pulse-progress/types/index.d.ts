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
  // The context percent the pane showed just before it last changed, and when (ms), so the fill can tween.
  ctxFrom?: number
  ctxAt?: number
}

// What the band draws: the finished count, and the step it is tweening from.
export type BarState = {
  done: number
  total: number
  fromRatio: number
  fromDone: number
  fromTotal: number
  changedAt: number
}

export type View = {
  isCompact: boolean
  isDoneCollapsed: boolean
  isBandHidden: boolean
  didAutoOpen: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'pulse-progress': {
      agents: AgentRun[]
      view: View
      now: number
      bar: BarState
    }
  }
}
