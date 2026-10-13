// pulse-progress: a QueerPulse take on johnnyvizz's savvy-progress (MIT, see NOTICE).
//
// Cosmetic only. The mod watches subagents start, step and finish, and draws them.
// It registers no tool the model can call, never rewrites a prompt or a tool call,
// reads no settings, environment, files or network. Its one command, /pulse, is
// typed by a person.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRun, BarState, View } from '../types'
import {
  BAND_H,
  CORAL,
  EMPTY_COPY,
  JADE_SOFT,
  ROLE_COLOR,
  ROW_H,
  agentSvg,
  bandSvg,
  compactSvg,
  ctxOf,
  elapsed,
  emptyHeight,
  emptySvg,
  fmtCost,
  fmtTime,
  fmtTokens,
  isTweenAt,
  headerSvg,
  progress,
  progressOf,
  roleOf,
  runModel,
  shownRatio,
  statusPhrase,
  totals,
  withCtxTween,
} from './draw'

const agents = atom({ plugin: 'pulse-progress', key: 'agents' } as const, [])
const view = atom({ plugin: 'pulse-progress', key: 'view' } as const, {
  isCompact: false,
  isDoneCollapsed: false,
  isBandHidden: false,
  didAutoOpen: false,
})
const now = atom({ plugin: 'pulse-progress', key: 'now' } as const, 0)
// The band reads only this, so a subagent's every model request leaves it alone.
const bar = atom({ plugin: 'pulse-progress', key: 'bar' } as const, {
  done: 0,
  total: 0,
  fromRatio: 0,
  fromDone: 0,
  fromTotal: 0,
  changedAt: 0,
})

const PANE = 'pulse-agents'
const PANE_TITLE = 'Pulse · agents'
const MAX_RUNS = 200

// ---------------------------------------------------------------------------
// Numbers.

// USD per million tokens: input, output, cache read, cache write (1-hour rate).
// List prices as savvy-progress had them on 2026-10-10; the first match wins.
type Price = [input: number, output: number, cacheRead: number, cacheWrite: number]
const PRICES: [RegExp, Price][] = [
  [/(fable|mythos)-5-1/, [10, 50, 0.25, 20]],
  [/fable|mythos/, [10, 50, 1, 20]],
  [/opus-5-5/, [4, 20, 0.2, 8]],
  [/opus/, [5, 25, 0.5, 10]],
  [/sonnet-5-5/, [2, 10, 0.1, 4]],
  [/sonnet-5/, [2, 10, 0.2, 4]],
  [/sonnet/, [3, 15, 0.3, 6]],
  [/haiku-5-5/, [0.1, 0.5, 0.01, 0.2]],
  [/haiku/, [1, 5, 0.1, 2]],
]

type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

const sumTokens = (u: Usage): number =>
  (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)

const costOf = (model: string, u: Usage): number => {
  const [i, o, r, w] = PRICES.find(([re]) => re.test(model.toLowerCase()))?.[1] ?? [4, 20, 0.2, 8]
  return (
    ((u.input_tokens || 0) * i +
      (u.output_tokens || 0) * o +
      (u.cache_read_input_tokens || 0) * r +
      (u.cache_creation_input_tokens || 0) * w) /
    1e6
  )
}

const windowOf = (model: string): number => (/haiku-4|claude-3/i.test(model) ? 200_000 : 1_000_000)

// ---------------------------------------------------------------------------
// Terminal drawing helpers.

const textBar = (ratio: number, width: number): string => {
  const filled = Math.round(width * Math.min(1, Math.max(0, ratio)))
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

const STATUS_GLYPH: Record<string, string> = { running: '●', done: '✓', failed: '✗' }

// ---------------------------------------------------------------------------
// Pane open and close.

async function openPane($: EngineInterface): Promise<void> {
  const at = await $.clock.now()
  await update($, now, () => at)
  await $.ui.open({ id: PANE, title: PANE_TITLE })
}

// The band's bar follows the runs: written only when the finished count or the total moved,
// starting a tween from the ratio the band showed at `at`.
async function syncBar($: EngineInterface, at: number): Promise<void> {
  const p = progress(await read($, agents))
  const isSame = (b: BarState) => b.done === p.done && b.total === p.total
  if (isSame(await read($, bar))) return
  await update($, bar, prev =>
    isSame(prev)
      ? prev
      : { done: p.done, total: p.total, fromRatio: shownRatio(prev, at), fromDone: prev.done, fromTotal: prev.total, changedAt: at },
  )
}

async function togglePane($: EngineInterface): Promise<boolean> {
  if ((await $.ui.panes()).some(p => p.id === PANE)) {
    await $.ui.close({ id: PANE })
    return false
  }
  await openPane($)
  return true
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'pulse',
      description: 'Show or hide the Pulse panel of subagents: running and finished, with model, context, cost and time',
    })
    // Ticks the running agents' clocks; quiet when nothing runs.
    $.clock.every(1000, () => {
      void (async () => {
        if (!(await read($, agents)).some(a => a.status === 'running')) return
        const at = await $.clock.now()
        await update($, now, () => at)
      })()
    })
    return started
  })

  on('command.run', { command: 'pulse' }, async ($, e) => {
    if ((e.args ?? '').trim() === 'open') {
      await openPane($)
      return { text: 'Pulse panel opened.' }
    }
    return { text: (await togglePane($)) ? 'Pulse panel opened.' : 'Pulse panel closed.' }
  })

  // Observe only: the spawn goes on exactly as it came in.
  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny !== undefined) return started

    const at = await $.clock.now()
    const run: AgentRun = {
      id: started.agentId ?? e.tool_use_id,
      agentId: started.agentId,
      type: e.subagentType,
      description: e.description,
      model: started.model,
      status: 'running',
      startedAt: at,
      contextTokens: 0,
      contextMax: windowOf(started.model),
      tokens: 0,
      costUsd: 0,
      steps: 0,
    }
    await update($, agents, list => [...list.filter(a => a.id !== run.id), run].slice(-MAX_RUNS))
    await syncBar($, at)
    await update($, now, () => at)
    const v = await update($, view, prev => ({ ...prev, isBandHidden: false }))
    if (options.autoOpen !== 'never' && v && !v.didAutoOpen) {
      await update($, view, prev => ({ ...prev, didAutoOpen: true }))
      void $.ui.open({ id: PANE, title: PANE_TITLE })
    }
    return started
  }).catch(($, e, next) => next(e)) // If drawing bookkeeping fails, the spawn still goes on unchanged.

  // Each model request of a subagent: live context, tokens and cost. The result passes through untouched.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const agentId = e.agentId
    const usage = result.usage
    if (!agentId || !usage) return result

    const model = usage.model || e.model
    const at = await $.clock.now()
    await update($, agents, list =>
      list.map((a): AgentRun =>
        a.agentId !== agentId
          ? a
          : withCtxTween(
              a,
              {
                ...a,
                model,
                effort: typeof e.effort === 'string' ? e.effort : a.effort,
                status: 'running',
                endedAt: undefined,
                contextTokens: sumTokens(usage),
                contextMax: windowOf(model),
                tokens: a.tokens + sumTokens(usage),
                costUsd: a.costUsd + costOf(model, usage),
                steps: a.steps + 1,
              },
              at,
            ),
      ),
    )
    // A step can bring a finished run back to running.
    await syncBar($, at)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId) {
      const at = await $.clock.now()
      await update($, agents, list =>
        list.map((a): AgentRun => {
          if (a.agentId !== agentId) return a
          // A run whose steps went unseen still gets the turn's own sum.
          const usage = a.steps === 0 ? e.usage : null
          return withCtxTween(
            a,
            {
              ...a,
              status: e.reason === 'answer' ? 'done' : 'failed',
              endedAt: at,
              ...(usage
                ? { model: usage.model || a.model, contextTokens: sumTokens(usage), tokens: sumTokens(usage), costUsd: costOf(usage.model || a.model, usage) }
                : {}),
            },
            at,
          )
        }),
      )
      await syncBar($, at)
      await update($, now, () => at)
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const list = await read($, agents)
    const v: View = await read($, view)
    const at = Math.max(await read($, now), ...list.map(a => a.startedAt), 0)
    // A fresh read for motion: loops keep their phase and tweens their progress across redraws.
    const clockAt = await $.clock.now()
    const running = list.filter(a => a.status === 'running').reverse()
    const finished = list.filter(a => a.status !== 'running').reverse()
    const t = totals(list, at)
    const summary = `≈${fmtCost(t.cost)}, ${fmtTokens(t.tokens)} tokens, ${fmtTime(t.time)}`

    const flipCompact = () => update($, view, prev => ({ ...prev, isCompact: !prev.isCompact }))
    const flipDone = () => update($, view, prev => ({ ...prev, isDoneCollapsed: !prev.isDoneCollapsed }))

    if (e.surface === 'desktop' && 'Svg' in ui) {
      const { Svg } = ui
      const W = Math.max(240, Math.min(900, (e.props.bodyColumns || 40) * 8 - 8))
      if (list.length === 0) {
        return (
          <Box flexDirection="column">
            <Svg key="empty" source={emptySvg(W, clockAt)} alt={`No subagents yet. ${EMPTY_COPY}`} width={W} height={emptyHeight(W)} />
          </Box>
        )
      }
      const phrase = statusPhrase(list)
      const viewToggle = (
        <Button key="compact" label={v.isCompact ? 'Show detailed view' : 'Show compact view'} plain dimColor onPress={flipCompact} />
      )
      if (v.isCompact) {
        const compact = compactSvg(W, list, at, clockAt)
        return (
          <Box flexDirection="column">
            <Svg key="overview" source={compact.source} alt={`${phrase}. ${summary}, timeline of ${list.length} runs`} width={W} height={compact.height} />
            <Box key="controls" flexDirection="row" justifyContent="flex-end" marginTop={1}>
              {viewToggle}
            </Box>
          </Box>
        )
      }
      const header = headerSvg(W, list, at, clockAt)
      // A settled row is drawn with a still clock, so it stays the same image from tick to tick.
      const rowOf = (a: AgentRun, index: number, section: AgentRun[]) => (
        <Svg
          key={a.id}
          source={agentSvg(W, a, at, a.status === 'running' || isTweenAt(a.ctxAt, clockAt) ? clockAt : 0, index === section.length - 1)}
          alt={`${a.description || a.type}: ${[a.type, runModel(a), a.status === 'failed' ? 'stopped' : a.status, fmtTime(elapsed(a, at)), `context ${ctxOf(a)}%`].filter(Boolean).join(', ')}`}
          width={W}
          height={ROW_H}
        />
      )
      const doneToggle = (
        <Button key="done" label={v.isDoneCollapsed ? 'Show finished' : 'Hide finished'} plain dimColor onPress={flipDone} />
      )
      return (
        <Box flexDirection="column">
          {/* Tooltips need a sandboxed frame; while runs tick it would be rebuilt every second, so it waits until all settle. */}
          <Svg
            key="header"
            source={header.source}
            alt={`${phrase}. ${summary}. Timeline of ${list.length} runs`}
            width={W}
            height={header.height}
            isInteractive={running.length === 0}
          />
          {running.length > 0 && (
            <Box key="working" flexDirection="row" justifyContent="space-between" alignItems="center" marginTop={1}>
              <Text dimColor>Working · {running.length}</Text>
              {viewToggle}
            </Box>
          )}
          {running.map(rowOf)}
          {finished.length > 0 && (
            <Box key="finished" flexDirection="row" justifyContent="space-between" alignItems="center" marginTop={1}>
              <Text dimColor>Finished · {finished.length}</Text>
              <Box flexDirection="row" gap={2}>
                {running.length === 0 && viewToggle}
                {doneToggle}
              </Box>
            </Box>
          )}
          {!v.isDoneCollapsed && finished.map(rowOf)}
        </Box>
      )
    }

    // Terminal: the same content in text rows.
    const toggleCompact = (
      <Button key="compact" label={v.isCompact ? 'Expand' : 'Collapse'} plain onPress={flipCompact} />
    )
    const toggleDone = (
      <Button
        key="done"
        label={`${v.isDoneCollapsed ? '▸' : '▾'} Finished · ${finished.length}`}
        plain
        onPress={flipDone}
      />
    )
    const empty = <Text dimColor>No subagents yet. {EMPTY_COPY}</Text>
    const barW = Math.max(6, Math.min(20, Math.max(24, e.props.bodyColumns || 40) - 34))
    const row = (a: AgentRun) => {
      const color = ROLE_COLOR[roleOf(a.type)]
      const ctx = ctxOf(a)
      return (
        <Box key={a.id} flexDirection="column" marginBottom={1}>
          <Box flexDirection="row" gap={1}>
            <Text color={color}>▣</Text>
            <Text bold wrap="truncate-end">{a.description || a.type}</Text>
            <Text color={a.status === 'failed' ? CORAL : a.status === 'done' ? JADE_SOFT : color}>{STATUS_GLYPH[a.status]}</Text>
          </Box>
          <Text dimColor wrap="truncate-end">  {[a.type, runModel(a)].filter(Boolean).join(' · ')}</Text>
          <Text wrap="truncate-end">
            {'  '}
            <Text color={a.status === 'done' ? JADE_SOFT : color}>{textBar(a.status === 'done' ? 1 : ctx / 100, barW)}</Text>
            <Text dimColor> ctx {ctx}% · {fmtTokens(a.contextTokens)} ≈{fmtCost(a.costUsd)} {fmtTime(elapsed(a, at))}</Text>
          </Text>
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text dimColor>≈{fmtCost(t.cost)} · {fmtTokens(t.tokens)} tokens · {fmtTime(t.time)}</Text>
          {toggleCompact}
        </Box>
        {v.isCompact ? (
          <Text wrap="truncate-end">
            {[...running, ...finished].map(a => (
              <Text key={a.id} color={ROLE_COLOR[roleOf(a.type)]}>{STATUS_GLYPH[a.status]} </Text>
            ))}
          </Text>
        ) : (
          <Box flexDirection="column" marginTop={1}>
            {list.length === 0 && empty}
            {running.length > 0 && <Text dimColor>Working · {running.length}</Text>}
            {running.map(row)}
            {finished.length > 0 && toggleDone}
            {!v.isDoneCollapsed && finished.map(row)}
          </Box>
        )}
      </Box>
    )
  })

  // Reads only `bar` and `view`: a subagent's steps that move no count never redraw it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const b = await read($, bar)
    const v = await read($, view)
    if (b.total === 0 || v.isBandHidden || e.props.hasSurvey) return next(e)
    // Other mods' bands draw beneath this row. Claude Code's own placeholder is never nested.
    const drawn = await Promise.resolve(next(e)).catch(() => null)
    const below = drawn && typeof drawn === 'object' && (drawn as { type?: string }).type !== 'engine' ? drawn : null

    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const p = progressOf(b.done, b.total)
    const crewButton = <Button key="pulse-agents" label={`×${b.total}`} plain onPress={() => void togglePane($)} />
    // Dismiss hides the band and forgets the finished runs; the next spawn brings it back.
    const dismiss = (
      <Button
        key="pulse-dismiss"
        label="✕"
        plain
        role="dismiss"
        onPress={async () => {
          await update($, agents, l => l.filter(a => a.status === 'running'))
          await syncBar($, await $.clock.now())
          await update($, view, prev => ({ ...prev, isBandHidden: true }))
        }}
      />
    )

    if (e.surface !== 'terminal' && 'Svg' in ui) {
      const { Svg } = ui
      const width = Math.max(180, Math.min(1600, (e.props.bodyColumns || 100) * 8 - 96))
      const at = await $.clock.now()
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Svg source={bandSvg(b, width, at)} alt={`Pulse: ${p.done} of ${p.total} subagents finished`} width={width} height={BAND_H} />
            {crewButton}
            {dismiss}
          </Box>
          {below}
        </Box>
      )
    }

    const width = Math.max(6, Math.min(40, e.props.bodyColumns - 40))
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={2}>
          <Text color={p.isFinished ? JADE_SOFT : CORAL}>● Pulse</Text>
          <Text color={p.isFinished ? JADE_SOFT : CORAL}>{textBar(p.ratio, width)}</Text>
          <Text bold>{p.isFinished ? 'All done' : `${p.done}/${p.total}`}</Text>
          <Text dimColor>{Math.round(p.ratio * 100)}%</Text>
          {crewButton}
          {dismiss}
        </Box>
        {below}
      </Box>
    )
  })
}
