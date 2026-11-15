// pulse-progress: a QueerPulse take on johnnyvizz's savvy-progress (MIT, see NOTICE).
//
// Cosmetic: the mod watches subagents start, step and finish, and draws them.
// It registers no tool the model can call and never rewrites a prompt or a tool call.
// Its one command, /pulse, is typed by a person. The one outside access is the pulse mods
// update check: it reads ~/.claude/plugins/installed_plugins.json and known_marketplaces.json
// (and a local clone's marketplace.json) and fetches the marketplace.json on GitHub.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { AgentRun, BarState, ClearedRuns, View } from '../types'
import { PULSE_ARGUMENTS, helpText, parsePulseArgs, pulseSuggestions, unknownArgumentText } from './commands'
import {
  BAND_H,
  errorDetailOf,
  CORAL,
  EMPTY_COPY,
  JADE_SOFT,
  ROLE_COLOR,
  ROW_H,
  agentSvg,
  bandSvg,
  bandWords,
  compactSvg,
  costText,
  ctxOf,
  elapsed,
  emptyHeight,
  emptySvg,
  fmtCost,
  fmtTime,
  fmtTokens,
  hiddenRunsText,
  isTweenAt,
  headerSvg,
  progress,
  progressOf,
  roleOf,
  runModel,
  runStopLabel,
  shownRatio,
  statusPhrase,
  terminalBandLayout,
  totals,
  TWEEN_MS,
  unpricedNote,
  withCtxTween,
} from './draw'
import { PRICES_AS_OF, contextWindowOf, priceOf } from './prices'
import { checkForUpdates, formatReport, isCheckDue, toastFor } from './updates'
import type { UpdateIo } from './updates'

const agents = atom({ plugin: 'pulse-progress', key: 'agents' } as const, [])
const view = atom({ plugin: 'pulse-progress', key: 'view' } as const, {
  isCompact: false,
  isDoneCollapsed: false,
  isBandHidden: false,
  didAutoOpen: false,
  isPaneOpen: false,
})
const now = atom({ plugin: 'pulse-progress', key: 'now' } as const, 0)
// The band draws from this and the `now` tick, so a subagent's every model request leaves it alone.
const bar = atom({ plugin: 'pulse-progress', key: 'bar' } as const, {
  done: 0,
  total: 0,
  stopped: 0,
  fromRatio: 0,
  fromDone: 0,
  fromTotal: 0,
  fromStopped: 0,
  changedAt: 0,
})
// The runs the band's clear removed, held for its Undo.
const cleared = atom({ plugin: 'pulse-progress', key: 'cleared' } as const, null as ClearedRuns)

const PANE = 'pulse-agents'
const PANE_TITLE = 'Pulse · agents'
const MAX_RUNS = 200
const UNDO_MS = 10_000
// $.store keys: the panel's two view choices, and when the update check last ran.
const VIEW_STORE_KEY = 'view'
const UPDATE_CHECK_STORE_KEY = 'update-check-at'
// The quiet update check waits this long after the session starts, so it never holds up the first prompt.
const UPDATE_CHECK_DELAY_MS = 5000

const messageOf = (cause: unknown): string => {
  const text = cause instanceof Error ? cause.message : String(cause)
  return text.split('\n')[0] || 'no message given'
}

// ---------------------------------------------------------------------------
// Numbers.

type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

const sumTokens = (usage: Usage): number =>
  (usage.input_tokens || 0) + (usage.output_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0)

// USD from prices.ts, cache writes at the 1-hour rate; null when the model has no price row.
const costOf = (model: string, usage: Usage): number | null => {
  const price = priceOf(model)
  if (!price) return null
  return (
    ((usage.input_tokens || 0) * price.input +
      (usage.output_tokens || 0) * price.output +
      (usage.cache_read_input_tokens || 0) * price.cacheRead +
      (usage.cache_creation_input_tokens || 0) * price.cacheWriteHour) /
    1e6
  )
}

// ---------------------------------------------------------------------------
// Terminal drawing helpers.

const textBar = (ratio: number, width: number): string => {
  const filled = Math.round(width * Math.min(1, Math.max(0, ratio)))
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

// Three shapes, so the compact strip reads without colour: filled running, hollow done, a cross for stopped.
const STATUS_GLYPH: Record<string, string> = { running: '●', done: '○', failed: '×' }

// ---------------------------------------------------------------------------
// Pane open and close.

async function openPane($: EngineInterface): Promise<void> {
  const at = await $.clock.now()
  await update($, now, () => at)
  await $.ui.open({ id: PANE, title: PANE_TITLE })
  await update($, view, prev => ({ ...prev, isPaneOpen: true }))
}

async function closePane($: EngineInterface): Promise<boolean> {
  const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
  if (isOpen) await $.ui.close({ id: PANE })
  await update($, view, prev => ({ ...prev, isPaneOpen: false }))
  return isOpen
}

async function togglePane($: EngineInterface): Promise<boolean> {
  if (await closePane($)) return false
  await openPane($)
  return true
}

// One settle timer at a time: a newer change cancels the redraw the previous one asked for.
let settleTimer: Timer | undefined
let undoTimer: Timer | undefined

// The band's bar follows the runs: written only when the finished count, the stopped count or the total
// moved, starting a tween from the ratio the band showed at `at`.
async function syncBar($: EngineInterface, at: number): Promise<void> {
  const counts = progress(await read($, agents))
  const isSame = (state: BarState) => state.done === counts.done && state.total === counts.total && (state.stopped ?? 0) === counts.stopped
  if (isSame(await read($, bar))) return
  await update($, bar, prev =>
    isSame(prev)
      ? prev
      : {
          done: counts.done,
          total: counts.total,
          stopped: counts.stopped,
          fromRatio: shownRatio(prev, at),
          fromDone: prev.done,
          fromTotal: prev.total,
          fromStopped: prev.stopped ?? 0,
          changedAt: at,
        },
  )
  // The surface rebuilds the band's image whenever it lays the prompt out again, and a rebuilt
  // image plays its CSS from the start. A drawing left holding the tween would slide from the old
  // count again each time, so the band redraws once the tween is over, settled.
  settleTimer?.cancel()
  settleTimer = $.clock.after(TWEEN_MS + 50, () => {
    void (async () => {
      const settledAt = await $.clock.now()
      await update($, now, () => settledAt)
    })().catch(cause => $.ui.log(`pulse-progress: the band's redraw after its tween stopped: ${messageOf(cause)}`))
  })
}

// The band's clear: finished runs leave, held for Undo for UNDO_MS.
async function clearFinished($: EngineInterface): Promise<void> {
  const at = await $.clock.now()
  const finished = (await read($, agents)).filter(run => run.status !== 'running')
  await update($, agents, list => list.filter(run => run.status === 'running'))
  await syncBar($, at)
  const until = at + UNDO_MS
  await update($, cleared, () => (finished.length ? { runs: finished, until } : null))
  await update($, view, prev => ({ ...prev, isBandHidden: true }))
  undoTimer?.cancel()
  if (!finished.length) return
  undoTimer = $.clock.after(UNDO_MS, () => {
    void update($, cleared, prev => (prev && prev.until === until ? null : prev)).catch(cause =>
      $.ui.log(`pulse-progress: the Undo row could not close after 10 seconds: ${messageOf(cause)}`),
    )
  })
}

async function undoClear($: EngineInterface): Promise<void> {
  const held = await read($, cleared)
  undoTimer?.cancel()
  if (!held) return
  await update($, agents, list =>
    [...held.runs.filter(run => !list.some(other => other.id === run.id)), ...list]
      .sort((left, right) => left.startedAt - right.startedAt)
      .slice(-MAX_RUNS),
  )
  await update($, cleared, () => null)
  await update($, view, prev => ({ ...prev, isBandHidden: false }))
  await syncBar($, await $.clock.now())
}

// ---------------------------------------------------------------------------
// Update check for the pulse mods.

async function updateIoOf($: EngineInterface): Promise<UpdateIo> {
  const home = await $.env.get('HOME')
  if (!home) throw new Error('HOME is not set, so ~/.claude/plugins/installed_plugins.json cannot be found')
  return {
    home,
    readText: path => $.fs.read(path),
    fetchText: url => $.http.fetch(url, { method: 'GET' }),
  }
}

async function modsReply($: EngineInterface): Promise<string> {
  try {
    const result = await checkForUpdates(await updateIoOf($))
    return result.isOk ? formatReport(result.report) : `The update check stopped: ${result.cause}`
  } catch (cause) {
    return `The update check stopped: ${messageOf(cause)}`
  }
}

// One quiet check per session at most, whatever its outcome.
let hasQuietCheckRun = false

// At most once a day, quietly: a toast only when an installed mod is older than GitHub's.
// Failures go to the debug log alone; /pulse mods typed by hand reports them in the transcript.
async function quietUpdateCheck($: EngineInterface): Promise<void> {
  if (hasQuietCheckRun) return
  hasQuietCheckRun = true
  const at = await $.clock.now()
  if (!isCheckDue(await $.store.get(UPDATE_CHECK_STORE_KEY), at)) return
  const result = await checkForUpdates(await updateIoOf($))
  // Stamped once the check completed (a report, or an HTTP answer from GitHub). An unreachable network
  // or an unreadable file leaves the stamp as it was, so the next session tries again.
  if (result.isOk || result.isAnswered) await $.store.set(UPDATE_CHECK_STORE_KEY, at)
  if (!result.isOk) {
    $.ui.log(`pulse-progress: the daily update check stopped: ${result.cause}`, { to: 'debug' })
    return
  }
  const toast = toastFor(result.report)
  if (toast) $.ui.toast(toast, { timeoutMs: 10_000 })
}

export const register: Register = (on, options) => {
  const settings = {
    autoOpen: options.autoOpen === 'never' ? 'never' : 'once',
    updateCheck: options.updateCheck === 'off' ? 'off' : 'on',
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'pulse',
      description: 'Show or hide the Pulse panel of subagents: running and finished, with model, context, cost and time',
      argumentHint: PULSE_ARGUMENTS.map(item => item.name).join('|'),
    })
    // Compact view and hide finished, as the person last left them.
    try {
      const saved = (await $.store.get(VIEW_STORE_KEY)) as { isCompact?: unknown; isDoneCollapsed?: unknown } | undefined
      if (saved && typeof saved === 'object') {
        await update($, view, prev => ({
          ...prev,
          isCompact: saved.isCompact === true,
          isDoneCollapsed: saved.isDoneCollapsed === true,
        }))
      }
    } catch (cause) {
      $.ui.log(`pulse-progress: the saved compact view and hide finished choices could not be read from $.store: ${messageOf(cause)}`)
    }
    // Ticks the running agents' clocks; quiet when nothing runs.
    $.clock.every(1000, () => {
      void (async () => {
        if (!(await read($, agents)).some(a => a.status === 'running')) return
        const at = await $.clock.now()
        await update($, now, () => at)
      })()
    })
    if (settings.updateCheck === 'on') {
      $.clock.after(UPDATE_CHECK_DELAY_MS, () => {
        void quietUpdateCheck($).catch(cause =>
          $.ui.log(`pulse-progress: the daily update check stopped: ${messageOf(cause)}`, { to: 'debug' }),
        )
      })
    }
    return started
  })

  on('command.run', { command: 'pulse' }, async ($, e) => {
    const parsed = parsePulseArgs(e.args)
    switch (parsed.kind) {
      case 'toggle':
        return { text: (await togglePane($)) ? 'Pulse panel opened.' : 'Pulse panel closed.' }
      case 'open':
        await openPane($)
        return { text: 'Pulse panel opened.' }
      case 'close':
        return { text: (await closePane($)) ? 'Pulse panel closed.' : 'The Pulse panel was already closed.' }
      case 'help':
        return { text: helpText(settings, PRICES_AS_OF) }
      case 'mods':
        return { text: await modsReply($) }
      case 'unknown':
        return { text: unknownArgumentText(parsed.argument) }
    }
  })

  // Typeahead for the argument after "/pulse ".
  on('prompt.autocomplete', async ($, e, next) => {
    const result = await next(e)
    const rows = pulseSuggestions(e.text, e.start, e.token)
    return rows.length ? { suggestions: [...result.suggestions, ...rows] } : result
  })

  // The person can close the pane with its own close mark: the band's "/pulse" hint comes back.
  on('ui.close', async ($, e, next) => {
    const result = await next(e)
    if (e.id === PANE) await update($, view, prev => ({ ...prev, isPaneOpen: false }))
    return result
  }).catch(($, e, next) => next(e))

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
      contextMax: contextWindowOf(started.model),
      tokens: 0,
      costUsd: 0,
      steps: 0,
    }
    await update($, agents, list => [...list.filter(a => a.id !== run.id), run].slice(-MAX_RUNS))
    await syncBar($, at)
    await update($, now, () => at)
    const current = await update($, view, prev => ({ ...prev, isBandHidden: false }))
    if (settings.autoOpen !== 'never' && current && !current.didAutoOpen) {
      await update($, view, prev => ({ ...prev, didAutoOpen: true }))
      void openPane($).catch(cause => $.ui.log(`pulse-progress: the panel did not open on the first subagent: ${messageOf(cause)}`))
    }
    return started
  }).catch(($, e, next) => {
    // The spawn still goes on unchanged; the log says why the band missed it.
    const why = next.error.kind === 'timeout' ? 'ran past its time budget' : 'threw'
    $.ui.log(`pulse-progress: tracking subagent "${e.description}" ${why}: ${next.error.message ?? 'no message given'}`)
    return next(e)
  })

  // Each model request of a subagent: live context, tokens and cost. The result passes through untouched.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const agentId = e.agentId
    if (!agentId) return result
    const usage = result.usage
    if (!usage) {
      // No response or no usage: keep the stop reason alone, to name a limit an error hit.
      if (result.stopReason) {
        const stop = result.stopReason
        await update($, agents, list => list.map(a => (a.agentId === agentId ? { ...a, lastStepStop: stop } : a)))
      }
      return result
    }

    const model = usage.model || e.model
    const cost = costOf(model, usage)
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
                endReason: undefined,
                lastStepStop: result.stopReason,
                contextTokens: sumTokens(usage),
                contextMax: contextWindowOf(model),
                tokens: a.tokens + sumTokens(usage),
                costUsd: a.costUsd + (cost ?? 0),
                isPriceUnknown: a.isPriceUnknown || cost === null,
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
          const usageModel = usage ? usage.model || a.model : a.model
          const cost = usage ? costOf(usageModel, usage) : null
          return withCtxTween(
            a,
            {
              ...a,
              status: e.reason === 'answer' ? 'done' : 'failed',
              endReason: e.reason,
              endDetail: e.reason === 'refusal' ? (e.refusal.category ?? undefined) : e.reason === 'error' ? errorDetailOf(e.answer) : undefined,
              endedAt: at,
              ...(usage
                ? {
                    model: usageModel,
                    contextTokens: sumTokens(usage),
                    tokens: sumTokens(usage),
                    costUsd: cost ?? 0,
                    isPriceUnknown: cost === null,
                  }
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
    const currentView: View = await read($, view)
    const at = Math.max(await read($, now), ...list.map(a => a.startedAt), 0)
    // A fresh read for motion: loops keep their phase and tweens their progress across redraws.
    const clockAt = await $.clock.now()
    const running = list.filter(a => a.status === 'running').reverse()
    const finished = list.filter(a => a.status !== 'running').reverse()
    const sums = totals(list, at)
    const costSummary = list.length && sums.unpriced === list.length ? 'price unknown' : `≈${fmtCost(sums.cost)}`
    const note = unpricedNote(sums.unpriced)
    const summary = `${costSummary}${note && sums.unpriced < list.length ? ` (${note})` : ''}, ${fmtTokens(sums.tokens)} tokens, ${fmtTime(sums.time)} active`

    // Both choices persist in $.store, so the next session opens the panel the same way.
    const savePreferences = async (next: View) => {
      try {
        await $.store.set(VIEW_STORE_KEY, { isCompact: next.isCompact, isDoneCollapsed: next.isDoneCollapsed })
      } catch (cause) {
        $.ui.log(`pulse-progress: the compact view and hide finished choices were not saved to $.store: ${messageOf(cause)}`)
      }
    }
    const flipCompact = async () => {
      const next = await update($, view, prev => ({ ...prev, isCompact: !prev.isCompact }))
      if (next) await savePreferences(next)
    }
    const flipDone = async () => {
      const next = await update($, view, prev => ({ ...prev, isDoneCollapsed: !prev.isDoneCollapsed }))
      if (next) await savePreferences(next)
    }

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
        <Button key="compact" label={currentView.isCompact ? 'Show detailed view' : 'Show compact view'} plain dimColor onPress={() => void flipCompact()} />
      )
      if (currentView.isCompact) {
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
          alt={`${a.description || a.type}: ${[a.type, runModel(a), a.status === 'failed' ? runStopLabel(a) : a.status, fmtTime(elapsed(a, at)), `context ${ctxOf(a)}%`, a.isPriceUnknown ? 'price unknown' : ''].filter(Boolean).join(', ')}`}
          width={W}
          height={ROW_H}
        />
      )
      const doneToggle = (
        <Button key="done" label={currentView.isDoneCollapsed ? 'Show finished' : 'Hide finished'} plain dimColor onPress={() => void flipDone()} />
      )
      const hidden = hiddenRunsText(header.hidden)
      return (
        <Box flexDirection="column">
          {/* Tooltips need a sandboxed frame. While runs tick the header is a new image every second,
              which would rebuild that frame and drop the hover each time, so tooltips wait until all settle
              and a caption says so meanwhile. */}
          <Svg
            key="header"
            source={header.source}
            alt={`${phrase}. ${summary}. Timeline of ${list.length} runs${hidden ? `, ${hidden} past the lanes` : ''}`}
            width={W}
            height={header.height}
            isInteractive={running.length === 0}
          />
          {note ? (
            <Text mono dimColor>
              {note}, left out of the cost
            </Text>
          ) : null}
          {running.length > 0 && (
            <Text mono dimColor>
              Hover the timeline for names once every run has finished
            </Text>
          )}
          {running.length > 0 && (
            <Box key="working" flexDirection="row" justifyContent="space-between" alignItems="center" marginTop={1}>
              <Text mono dimColor>Working · {running.length}</Text>
              {viewToggle}
            </Box>
          )}
          {running.map(rowOf)}
          {finished.length > 0 && (
            <Box key="finished" flexDirection="row" justifyContent="space-between" alignItems="center" marginTop={1}>
              <Text mono dimColor>Finished · {finished.length}</Text>
              <Box flexDirection="row" gap={2}>
                {running.length === 0 && viewToggle}
                {doneToggle}
              </Box>
            </Box>
          )}
          {!currentView.isDoneCollapsed && finished.map(rowOf)}
        </Box>
      )
    }

    // Terminal: the same content in text rows.
    const toggleCompact = (
      <Button key="compact" label={currentView.isCompact ? 'Show detailed view' : 'Show compact view'} plain onPress={() => void flipCompact()} />
    )
    const toggleDone = (
      <Button
        key="done"
        label={`${currentView.isDoneCollapsed ? '▸' : '▾'} Finished · ${finished.length}`}
        plain
        onPress={() => void flipDone()}
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
            {a.status === 'failed' && <Text color={CORAL} wrap="truncate-end">{runStopLabel(a)}</Text>}
          </Box>
          <Text dimColor wrap="truncate-end">  {[a.type, runModel(a)].filter(Boolean).join(' · ')}</Text>
          <Text wrap="truncate-end">
            {'  '}
            <Text color={a.status === 'done' ? JADE_SOFT : color}>{textBar(a.status === 'done' ? 1 : ctx / 100, barW)}</Text>
            <Text dimColor> ctx {ctx}% · {fmtTokens(a.contextTokens)} {costText(a)} {fmtTime(elapsed(a, at))}</Text>
          </Text>
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text dimColor wrap="truncate-end">
            {[costSummary, note, `${fmtTokens(sums.tokens)} tokens`, `${fmtTime(sums.time)} active`].filter(Boolean).join(' · ')}
          </Text>
          {toggleCompact}
        </Box>
        {currentView.isCompact ? (
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
            {!currentView.isDoneCollapsed && finished.map(row)}
          </Box>
        )}
      </Box>
    )
  })

  // Reads `bar`, `view`, `cleared` and the `now` tick: a subagent's steps that move no count never redraw it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const barState = await read($, bar)
    const currentView = await read($, view)
    const held = await read($, cleared)
    // Subscribes to the tick. The surface rebuilds the band's image each second while the pane's
    // clock runs, and a rebuilt image starts its loops at the phase baked into its source: drawn
    // fresh each tick, that phase is the clock's, so the twinkle and the crab carry on unbroken.
    await read($, now)
    const isBandShown = barState.total > 0 && !currentView.isBandHidden
    if ((!isBandShown && !held) || e.props.hasSurvey) return next(e)
    // Other mods' bands draw beneath this row. Claude Code's own placeholder is never nested.
    const drawn = await Promise.resolve(next(e)).catch(() => null)
    const below = drawn && typeof drawn === 'object' && (drawn as { type?: string }).type !== 'engine' ? drawn : null

    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const isDesktop = e.surface !== 'terminal' && 'Svg' in ui
    const stopped = barState.stopped ?? 0
    const counts = progressOf(barState.done, barState.total)
    const words = bandWords(counts.done, counts.total, stopped)
    const crewLabel = `Agents ${barState.total}`
    const isHintWanted = !currentView.isPaneOpen
    const crewButton = <Button key="pulse-agents" label={crewLabel} plain onPress={() => void togglePane($)} />
    // With finished runs the close button clears them (Undo clear brings them back for 10 seconds);
    // with none it only hides the band, and says so.
    const hasFinished = barState.done > 0
    const layout = terminalBandLayout(
      e.props.bodyColumns || 80,
      words,
      crewLabel,
      isHintWanted,
      hasFinished ? 'Clear finished' : 'Hide band',
      hasFinished ? 'Clear' : 'Hide',
    )
    const dismiss = (
      <Button
        key="pulse-dismiss"
        label={isDesktop ? (hasFinished ? 'Clear finished runs' : 'Hide band') : layout.dismissLabel}
        plain
        role="dismiss"
        onPress={() => void clearFinished($)}
      />
    )
    const clearedCount = held?.runs.length ?? 0
    const undoRow = held ? (
      <Box key="pulse-cleared" flexDirection="row" gap={2}>
        <Text mono={isDesktop || undefined} dimColor wrap="truncate-end">
          Cleared {clearedCount} finished {clearedCount === 1 ? 'run' : 'runs'}
        </Text>
        <Button key="pulse-undo" label="Undo clear" plain onPress={() => void undoClear($)} />
      </Box>
    ) : null

    if (isDesktop && 'Svg' in ui) {
      const { Svg } = ui
      const width = Math.max(180, Math.min(1600, (e.props.bodyColumns || 100) * 8 - 96 - (isHintWanted ? 56 : 0)))
      const at = await $.clock.now()
      return (
        <Box flexDirection="column">
          {isBandShown && (
            <Box flexDirection="row" alignItems="center" gap={1}>
              <Svg key="pulse-band" source={bandSvg(barState, width, at)} alt={`Pulse: ${counts.done} of ${counts.total} subagents finished. ${words}`} width={width} height={BAND_H} />
              {crewButton}
              {isHintWanted && (
                <Text mono dimColor>
                  /pulse
                </Text>
              )}
              {dismiss}
            </Box>
          )}
          {undoRow}
          {below}
        </Box>
      )
    }

    const tint = counts.isFinished ? JADE_SOFT : CORAL
    return (
      <Box flexDirection="column">
        {isBandShown && (
          <Box flexDirection="row" gap={2}>
            <Text color={tint}>● Pulse</Text>
            {layout.barWidth > 0 && <Text color={tint}>{textBar(counts.ratio, layout.barWidth)}</Text>}
            <Text bold>{words}</Text>
            {layout.isPercentShown && <Text dimColor>{Math.round(counts.ratio * 100)}%</Text>}
            {crewButton}
            {dismiss}
            {layout.isHintShown && <Text dimColor>/pulse</Text>}
          </Box>
        )}
        {undoRow}
        {below}
      </Box>
    )
  })
}
