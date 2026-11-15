import { describe, expect, mock, test, tier } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { CommandRunInput, ConfigSetInput, ModelForkResult, On, PromptSubmitInput, RenderPropsOf, SessionStartInput, TurnCompleteInput, TurnUsage } from 'claude-code'

import { bandColors } from '../hooks/draw'
import { statusIcons } from '../hooks/status-icons'
import { cacheTaxHelp, DEFAULT_SETTINGS, fmtDuration, freshState, heldBlocker, keepwarmHelp, noteTurnRequest, parseDuration, pingAfterMsOf, pingCostPerHour, readSettings, resetForClear, savingsText, seedFromResume, ttlMsOf } from '../hooks/register'

tier('user')

const MIN = 60 * 1000
const HOUR = 60 * MIN
const START = 1_000_000

const session: SessionStartInput = { surface: null, isInteractive: false, cwd: '/work' }

const usage = (over: Partial<TurnUsage> = {}): TurnUsage => ({
  input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 200000, cache_creation_input_tokens: 500, model: 'claude-fable-5-1', ...over,
})

// TurnCompleteInput is a union on `reason`; the tests only drive the answered arm.
type AnsweredTurn = Exclude<TurnCompleteInput, { reason: 'refusal' }>
let turns = 0
const turn = (over: Partial<AnsweredTurn> = {}): TurnCompleteInput => ({
  answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't' + ++turns, reason: 'answer', usage: usage(), ...over,
})

const run = (command: 'keepwarm' | 'cache-tax', args: string): CommandRunInput => ({
  command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 },
})

const prompt = (text: string): PromptSubmitInput => ({ text, wait: false, origin: { kind: 'composer' } })
const themeChange = (value: string): ConfigSetInput => ({ key: 'theme', value, previous: 'dark', provider: { plugin: 'engine', tier: 'core' }, origin: { kind: 'composer' } })

type ForkAnswer = null | 'throw' | ModelForkResult | { read: number; write: number; out?: number; input?: number }

// The world beneath the mod: its store, the engine's answers, and a fork that
// replies from a script so each test decides what the cache looked like.
function world(on: On, forkAnswers: ForkAnswer[], opts: { store?: Map<string, unknown>; commands?: string[]; live?: { tokens?: number }; sid?: string; model?: string; bandText?: string; theme?: { value: string }; noColor?: boolean; denyTheme?: boolean; writtenTheme?: string; box?: { text: string }; failResend?: string } = {}) {
  if (opts.store) {
    const store = opts.store
    on('store.get', ($, e) => ({ value: store.get(e.key) }))
    on('store.set', ($, e) => { store.set(e.key, e.value); return { value: undefined } })
    on('store.delete', ($, e) => { store.delete(e.key); return { value: undefined } })
    on('store.keys', () => ({ value: [...store.keys()] }))
  } else mock.store(on, {})
  const reads = { theme: 0, env: 0 }
  on('env.get', ($, e) => { reads.env++; return { value: e.name === 'NO_COLOR' && opts.noColor ? '1' : undefined } })
  on('config.list', () => {
    reads.theme++
    return { value: [{ key: 'theme', label: 'Theme', kind: 'choice', value: opts.theme?.value ?? 'dark', provider: { plugin: 'engine', tier: 'core' }, isLocked: false }] }
  })
  on('config.set', ($, e) => opts.denyTheme ? { deny: 'theme locked' } : { value: opts.writtenTheme ?? e.value })
  const forks: number[] = []
  const status: Array<string | undefined> = []
  const logs: string[] = []
  const entered: string[] = []
  const toasts: string[] = []
  const copies: string[] = []
  const fills: string[] = []
  const box = opts.box ?? { text: '' }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: opts.sid ?? 'S1' }))
  on('session.model', () => ({ value: opts.model ?? 'claude-fable-5-1' }))
  on('session.usage', () => ({ value: { startedAt: START, context: { window: 1000000, tokens: opts.live?.tokens }, rateLimits: [] } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('command.list', () => ({ value: (opts.commands ?? []).map(name => ({ name, description: '', source: 'plugin' as const })) }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => {
    if (opts.failResend && e.origin.kind === 'plugin') return { drop: opts.failResend }
    entered.push(e.text)
    return { text: e.text }
  })
  on('prompt.read', () => ({ value: { text: box.text, cursor: box.text.length } }))
  on('prompt.fill', ($, e) => { fills.push(e.text); box.text = e.text; return { isFilled: true } })
  on('ui.copy', ($, e) => { copies.push(e.text); return { value: { isCopied: true as const } } })
  on('ui.toast', ($, e) => { toasts.push(e.text); return { value: undefined } })
  on('session.compact', ($, e) => ({ messages: e.messages }))
  on('classic.SessionStart', () => ({}))
  on('ui.log', ($, e) => { logs.push(e.text); return { value: undefined } })
  on('ui.status', ($, e) => { status.push(e.text); return { value: undefined } })
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: [opts.bandText ?? ''] }))
  on('model.fork', () => {
    forks.push(forks.length)
    const a = forkAnswers.shift()
    // Older Claude Code releases returned null instead of a failure object.
    if (a === null || a === undefined) return { value: null as unknown as ModelForkResult }
    if (a === 'throw') throw new Error('network down')
    if ('isAnswered' in a) return { value: a }
    const value: ModelForkResult = { isAnswered: true, text: 'warm', usage: { input_tokens: a.input ?? 2, output_tokens: a.out ?? 1, cache_read_input_tokens: a.read, cache_creation_input_tokens: a.write } }
    return { value }
  })
  return { forks, status, logs, entered, reads, toasts, copies, fills, box }
}

const warm: ForkAnswer = { read: 200000, write: 0 }

const bandProps: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false, isWorking: false, isCollapsed: false, maxRows: 10, bodyColumns: 75,
  scroll: { offset: 0, bodyRows: 10 }, view: {},
}

describe('cache indicator', () => {
  test('redraws reuse session preferences and theme changes repaint immediately', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    await $.command.run(run('keepwarm', '90m'))
    const ui = await $.ui.mount({ plugin: 'cache-tax', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '2h'))
    expect((await ui.find({ type: 'Image' }))?.props.source).toEqual({ png: statusIcons.dark.warm.png })
    expect(w.reads).toEqual({ theme: 1, env: 1 })
    await $.config.set(themeChange('light'))
    expect((await ui.find({ type: 'Image' }))?.props.source).toEqual({ png: statusIcons.light.warm.png })
    await $.config.set(themeChange('dark'))
    expect((await ui.find({ type: 'Image' }))?.props.source).toEqual({ png: statusIcons.dark.warm.png })
    expect(w.reads).toEqual({ theme: 1, env: 1 })
    expect(w.forks.length).toBe(0)
  })

  test('a denied theme change preserves the existing icon', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { denyTheme: true })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    await $.command.run(run('keepwarm', '90m'))
    const ui = await $.ui.mount({ plugin: 'cache-tax', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    expect((await $.config.set(themeChange('light'))).deny).toBe('theme locked')
    await $.turn.complete(turn())
    expect((await ui.find({ type: 'Image' }))?.props.source).toEqual({ png: statusIcons.dark.warm.png })
  })

  test('the written theme wins over the requested value', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { writtenTheme: 'light' })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    await $.command.run(run('keepwarm', '90m'))
    const ui = await $.ui.mount({ plugin: 'cache-tax', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    await $.config.set(themeChange('dark'))
    expect((await ui.find({ type: 'Image' }))?.props.source).toEqual({ png: statusIcons.light.neutral.png })
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: official cube follows state and theme with a text alternative`, async ($, on) => {
      const clock = mock.clock(on, { now: 10 * HOUR })
      const theme = { value: 'dark' }
      const w = world(on, [], { theme })
      await $.session.start({ ...session, surface, isInteractive: true })
      await $.command.run(run('keepwarm', '3h every 90m'))
      const ui = await $.ui.mount({ plugin: 'cache-tax', surface, component: 'AbovePrompt', props: bandProps })
      const type = surface === 'terminal' ? 'Image' : 'Svg'
      const source = (variant: typeof statusIcons.dark) => surface === 'terminal' ? { png: variant.neutral.png } : variant.neutral.svg
      expect((await ui.find({ type }))?.props.source).toEqual(source(statusIcons.dark))
      expect((await ui.find({ type }))?.props.alt).toBe(surface === 'terminal' ? '[>]' : 'Cache Tax')
      if (surface === 'terminal') {
        expect((await ui.find({ type }))?.props.columns).toBe(3)
        expect((await ui.find({ type }))?.props.rows).toBe(1)
      }
      await $.turn.complete(turn())
      expect((await ui.find({ type }))?.props.source).toEqual(surface === 'terminal' ? { png: statusIcons.dark.warm.png } : statusIcons.dark.warm.svg)
      await $.config.set(themeChange('light'))
      await clock.advance(HOUR)
      expect((await ui.find({ type }))?.props.source).toEqual(surface === 'terminal' ? { png: statusIcons.light.cold.png } : statusIcons.light.cold.svg)
      expect((await ui.find({ type: 'Text', text: /^cold$/ }))?.props.color).toBe(bandColors(true).coralInk)
      expect(w.forks.length).toBe(0)
      await $.command.run(run('keepwarm', 'off'))
      expect(await ui.find({ type })).toBe(undefined)
    })

    test(`${surface}: NO_COLOR uses a bold text icon and uncolored state`, async ($, on) => {
      mock.clock(on, { now: START })
      world(on, [], { noColor: true })
      await $.session.start({ ...session, surface, isInteractive: true })
      await $.turn.complete(turn())
      await $.command.run(run('keepwarm', '90m'))
      const ui = await $.ui.mount({ plugin: 'cache-tax', surface, component: 'AbovePrompt', props: bandProps })
      expect(await ui.find({ type: 'Image' })).toBe(undefined)
      expect(await ui.find({ type: 'Svg' })).toBe(undefined)
      expect((await ui.find({ type: 'Text', text: /^\[>\]$/ }))?.props.bold).toBe(true)
      expect((await ui.find({ type: 'Text', text: /^warm$/ }))?.props.color).toBe(undefined)
    })
  }

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: unknown, warm, cold and warm again agree with the card`, async ($, on) => {
      const clock = mock.clock(on, { now: 10 * HOUR })
      const w = world(on, [], { bandText: 'other mod' })
      // Desktop's row leads with the state word, the icon's alt naming the mod; the terminal's starts with cache-tax.
      const row = surface === 'desktop' ? { type: 'Text', text: /^(warm|cold|unknown|stopped) · / } : { type: 'Text', text: 'cache-tax' }
      await $.session.start({ ...session, surface, isInteractive: true })
      const ui = await $.ui.mount({ plugin: 'cache-tax', surface, component: 'AbovePrompt', props: bandProps })
      expect(await ui.find(row)).toBe(undefined)
      await $.command.run(run('keepwarm', '3h every 90m'))
      expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe(undefined)
      expect((await ui.find(row))?.text).toMatch(/unknown.*waiting for the first turn/)
      await $.turn.complete(turn())
      expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe(bandColors(false).jade)
      expect((await ui.find(row))?.text).toMatch(/warm.*ping in 1h30m/)
      await clock.advance(HOUR)
      expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe(bandColors(false).coralInk)
      expect((await ui.find(row))?.text).toMatch(/cold.*keepwarm starts pinging after your next turn/)
      expect((await $.command.run(run('cache-tax', ''))).text).toMatch(/state       COLD/)
      expect(w.forks.length).toBe(0)
      expect((await ui.find({ text: /^other mod$/ }))?.text).toBe('other mod')
      await $.turn.complete(turn())
      expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe(bandColors(false).jade)
      expect((await $.command.run(run('cache-tax', ''))).text).toMatch(/state       warm/)
      expect(w.status.filter(Boolean)).toEqual([])
      await $.command.run(run('keepwarm', 'off'))
      expect(await ui.find(row)).toBe(undefined)
      expect(w.forks.length).toBe(0)
    })
  }

  test('cold resume, compaction and clear reset the row without a ping', async ($, on) => {
    const clock = mock.clock(on, { now: 10 * HOUR })
    const w = world(on, [], { store: new Map([['deadline:S1', 13 * HOUR]]) })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'cache-tax', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 7200, context_tokens: 200000, prompt_cache_likely_expired: true })
    expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe(bandColors(false).coralInk)
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
    expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe(undefined)
    expect((await ui.find({ type: 'Text', text: 'cache-tax' }))?.text).toMatch(/unknown.*after compaction/)
    await clock.advance(HOUR)
    expect(w.forks.length).toBe(0)
    await $.turn.complete(turn())
    expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe(bandColors(false).jade)
    await $.classic.SessionStart({ source: 'clear' })
    expect(await ui.find({ text: 'cache-tax' })).toBe(undefined)
    await clock.advance(HOUR)
    expect(w.forks.length).toBe(0)
  })

  test('window expiry removes the row and surveys retain their band', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [], { bandText: 'survey' })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '10m'))
    const ui = await $.ui.mount({ plugin: 'cache-tax', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    const survey = await $.ui.mount({ plugin: 'cache-tax', surface: 'terminal', component: 'AbovePrompt', props: { ...bandProps, hasSurvey: true } })
    expect(await survey.find({ text: 'cache-tax' })).toBe(undefined)
    expect((await survey.find({ text: 'survey' }))?.text).toBe('survey')
    await clock.advance(10 * MIN)
    expect(await ui.find({ text: 'cache-tax' })).toBe(undefined)
    expect(w.forks.length).toBe(0)
  })

  test('a warm resume restores green and ignores subagent cache activity', async ($, on) => {
    const clock = mock.clock(on, { now: 10 * HOUR })
    const w = world(on, [], { store: new Map<string, unknown>([['deadline:S1', 13 * HOUR], ['every:S1', 90 * MIN]]) })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 30 * 60, context_tokens: 200000 })
    const ui = await $.ui.mount({ plugin: 'cache-tax', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe(bandColors(false).jade)
    await $.turn.complete(turn({ agentId: 'worker' }))
    await $.session.compact({ trigger: 'manual', agentId: 'worker', messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
    await clock.advance(30 * MIN)
    expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe(bandColors(false).coralInk)
    expect(w.forks.length).toBe(0)
  })

  for (const surface of ['vscode', 'mobile', null] as const) {
    test(`${surface ?? 'headless'} keeps the plain status fallback`, async ($, on) => {
      mock.clock(on, { now: START })
      const w = world(on, [])
      await $.session.start({ ...session, surface })
      await $.turn.complete(turn())
      await $.command.run(run('keepwarm', '90m'))
      expect(w.status.at(-1)).toBe('keepwarm 1h30m left · ping in 50m')
      expect(w.status.at(-1)).not.toMatch(/\x1b/)
      expect(w.forks.length).toBe(0)
    })
  }

  test('a warm ping keeps the green row and a cold read stops it neutrally', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm, { read: 0, write: 200000 }])
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    const ui = await $.ui.mount({ plugin: 'cache-tax', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    await clock.advance(50 * MIN)
    expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe(bandColors(false).jade)
    expect((await ui.find({ type: 'Text', text: 'cache-tax' }))?.text).toMatch(/last ping read 200k/)
    await clock.advance(50 * MIN)
    expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe(undefined)
    expect((await ui.find({ type: 'Text', text: 'cache-tax' }))?.text).toMatch(/stopped.*cache was already gone/)
    await clock.advance(HOUR)
    expect(w.forks.length).toBe(2)
  })

  for (const failure of [
    { isAnswered: false, reason: 'nothing-to-fork' },
    { isAnswered: false, reason: 'api-error', status: 429, error: 'rate_limit', usage: usage() },
    { isAnswered: false, reason: 'empty-reply', usage: usage() },
    { isAnswered: false, reason: 'aborted', usage: usage() },
  ] satisfies ModelForkResult[]) {
    test(`structured fork failure ${failure.reason} stops without retrying`, async ($, on) => {
      const clock = mock.clock(on, { now: START })
      const w = world(on, [failure])
      await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
      await $.turn.complete(turn())
      await $.command.run(run('keepwarm', '3h every 1m'))
      const ui = await $.ui.mount({ plugin: 'cache-tax', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
      await clock.advance(MIN)
      expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe(undefined)
      expect((await ui.find({ type: 'Text', text: 'cache-tax' }))?.text).toMatch(/stopped/)
      await clock.advance(2 * HOUR)
      expect(w.forks.length).toBe(1)
    })
  }
})

describe('parse and format', () => {
  test('durations', async () => {
    expect(parseDuration('6h')).toBe(6 * HOUR)
    expect(parseDuration('90m')).toBe(90 * MIN)
    expect(parseDuration('2h30m')).toBe(150 * MIN)
    expect(parseDuration('soon')).toBe(null)
    expect(fmtDuration(150 * MIN)).toBe('2h30m')
    expect(fmtDuration(7 * MIN)).toBe('7m')
    expect(fmtDuration((15 * 24 + 9) * 60 * MIN)).toBe('15d 9h')
  })
})

describe('guard', () => {
  test('refuses a cold send once with the price, then lets the resend through', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    const first = await $.prompt.submit(prompt('hi'))
    expect(first.drop).toMatch(/cache-tax: the prompt cache went cold 2h00m ago\. Sending this re-writes up to 200,502 tokens at \$20\/MTok = \$4\.01/)
    expect(w.entered).toEqual([])
    const second = await $.prompt.submit(prompt('hi'))
    expect(second.drop).toBe(undefined)
    expect(w.entered).toEqual(['hi'])
  })

  test('lets slash commands, warm sends and small contexts through', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(30 * MIN)
    await $.prompt.submit(prompt('warm one'))
    await clock.advance(3 * HOUR)
    await $.prompt.submit(prompt('/clear'))
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 20000 }) }))
    await clock.advance(3 * HOUR)
    await $.prompt.submit(prompt('small one'))
    expect(w.entered).toEqual(['warm one', '/clear', 'small one'])
  })

  test('warn mode shows the price and sends', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    const r = await $.command.run(run('cache-tax', 'guard warn'))
    expect(r.text).toMatch(/guard set to warn/)
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    await $.prompt.submit(prompt('hi'))
    expect(w.entered).toEqual(['hi'])
    expect(w.logs.at(-1)).toMatch(/Sending anyway/)
  })

  test('a paid cold write is scored and arms nothing until /keepwarm', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm, warm, warm, warm])
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    await $.prompt.submit(prompt('hi'))
    await $.prompt.submit(prompt('hi'))
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200502 }) }))
    expect(w.logs.at(-1)).toBe('cold write of 201k tokens paid ($4.01). /keepwarm holds the cache so it is not paid again.')
    expect(w.status.at(-1)).toBe(undefined)
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(0)
    const card = await $.command.run(run('cache-tax', 'status'))
    expect(card.text).toMatch(/session     1 cold write paid, \$4\.01/)
    expect(card.text).not.toMatch(/keepwarm    on/)
  })

  test('context comes from the live window, not the turn\'s summed usage', async ($, on) => {
    mock.clock(on, { now: START })
    const live: { tokens?: number } = {}
    const w = world(on, [], { live })
    await $.session.start(session)
    await $.turn.complete(turn())
    live.tokens = 100000
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 500000, cache_creation_input_tokens: 2000 }) }))
    const card = await $.command.run(run('cache-tax', 'status'))
    expect(card.text).toMatch(/context     100,000 tokens/)
    expect(card.text).toMatch(/0 cold writes paid/)
    expect(w.status.at(-1)).toBe(undefined)
  })

  test('/clear forgets the context, the clock and the tally', async () => {
    const s = freshState()
    s.ctx = 200000
    s.lastRequestAt = START - 2 * HOUR
    s.ackedAt = s.lastRequestAt
    s.misses = [{ at: START, tokens: 200000, usd: 4 }]
    let cancelled = false
    s.pending = { cancel: () => { cancelled = true } }
    resetForClear(s)
    expect(s.ctx).toBe(0)
    expect(s.lastRequestAt).toBe(0)
    expect(s.ackedAt).toBe(0)
    expect(s.misses).toEqual([])
    expect(s.pending).toBe(null)
    expect(cancelled).toBe(true)
  })

  test('an unguarded full miss is scored too', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, [warm])
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200502 }) }))
    const card = await $.command.run(run('cache-tax', 'status'))
    expect(card.text).toMatch(/1 cold write paid/)
    expect(w.status.at(-1)).toBe(undefined)
    expect(w.forks.length).toBe(0)
  })

  test('stays quiet after a compaction until the first new turn', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'old', toolUses: [] }] })
    await $.prompt.submit(prompt('after compact'))
    expect(w.entered).toEqual(['after compact'])
    const card = await $.command.run(run('cache-tax', 'status'))
    expect(card.text).toMatch(/reset by compaction/)
  })

  test('a cold resume seeds the guard before any turn and returns the estimate line', async () => {
    const s = freshState()
    const now = START
    const line = seedFromResume(s, { source: 'resume', model: 'claude-fable-5-1', context_tokens: 396113, seconds_since_last_response: 3 * 3600, prompt_cache_likely_expired: true, estimated_cache_write_usd: 7.92 }, now)
    expect(line).toMatch(/resuming cold\. The first message re-writes 396,113 tokens, about \$7\.92/)
    expect(s.ctx).toBe(396113)
    expect(s.lastRequestAt).toBe(now - 3 * HOUR)
    expect(seedFromResume(freshState(), { source: 'startup' }, now)).toBe(null)
    expect(seedFromResume(freshState(), { source: 'resume', context_tokens: 20000, prompt_cache_likely_expired: true }, now)).toBe(null)
  })

  test('warns once when the hook form is installed beside it', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, [], { commands: ['cache-tax:status'] })
    await $.session.start(session)
    expect(w.logs.at(-1)).toMatch(/hook form .* is also installed/)
    expect(w.toasts.at(-1)).toMatch(/^cache-tax: the hook form .* is also installed/)
  })
})

describe('held send card', () => {
  test('Send message resends the held message once and scores the write it pays', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'cache-tax', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    expect((await $.prompt.submit(prompt('hi'))).drop).toMatch(/^cache-tax: the prompt cache went cold 2h00m ago\..* Send it again, or use Send message below\.$/)
    expect((await ui.find({ key: 'cache-tax-send' }))?.props.label).toBe('Send message ≈$4.01')
    await $.ui.press({ plugin: 'cache-tax', key: 'cache-tax-send' })
    expect(w.entered).toEqual(['hi'])
    expect(await ui.find({ key: 'cache-tax-send' })).toBe(undefined)
    // A write too small to read as a full miss is scored only because the press paid it.
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 5000 }) }))
    expect((await $.command.run(run('cache-tax', 'status'))).text).toMatch(/session     1 cold write paid, \$0\.10/)
  })

  test('a double press of Send message sends the message once', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    await $.ui.mount({ plugin: 'cache-tax', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    await $.prompt.submit(prompt('hi'))
    await Promise.allSettled([
      $.ui.press({ plugin: 'cache-tax', key: 'cache-tax-send' }),
      $.ui.press({ plugin: 'cache-tax', key: 'cache-tax-send' }),
    ])
    expect(w.entered).toEqual(['hi'])
  })

  test('Discard message keeps it unsent and holds the next cold send again', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'cache-tax', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    await $.prompt.submit(prompt('hi'))
    expect((await ui.find({ key: 'cache-tax-cancel' }))?.props.label).toBe('Discard message')
    await $.ui.press({ plugin: 'cache-tax', key: 'cache-tax-cancel' })
    expect(await ui.find({ key: 'cache-tax-cancel' })).toBe(undefined)
    expect((await $.prompt.submit(prompt('hi'))).drop).toMatch(/^cache-tax: /)
    expect(w.entered).toEqual([])
    expect(await ui.find({ key: 'cache-tax-send' })).toBeDefined()
  })

  test('a ping that throws stops keepwarm and clears the pinging state', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, ['throw', warm])
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h every 1m'))
    const ui = await $.ui.mount({ plugin: 'cache-tax', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    await clock.advance(MIN)
    expect(w.forks.length).toBe(1)
    expect((await ui.find({ type: 'Text', text: 'cache-tax' }))?.text).toMatch(/stopped.*the ping failed/)
    // Armed again, the row must read warm with a countdown, with nothing left over from the failed ping.
    await $.command.run(run('keepwarm', '3h'))
    await $.turn.complete(turn())
    expect((await ui.find({ type: 'Text', text: 'cache-tax' }))?.text).toMatch(/warm.*ping in 50m/)
    expect(await ui.find({ type: 'Text', text: /pinging/ })).toBe(undefined)
  })

  for (const [what, input, blocker] of [
    ['an attachment', { ...prompt('see this'), attachments: [{ type: 'image' }] }, 'has an attachment'],
    ['an @-mention of a path', prompt('read @src/app.ts first'), 'mentions @src/app.ts'],
  ] satisfies Array<[string, PromptSubmitInput, string]>) {
    test(`a held message with ${what} offers no Send message`, async ($, on) => {
      const clock = mock.clock(on, { now: START })
      const w = world(on, [])
      await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
      const ui = await $.ui.mount({ plugin: 'cache-tax', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
      await $.turn.complete(turn())
      await clock.advance(3 * HOUR)
      expect((await $.prompt.submit(input)).drop?.endsWith(`It ${blocker}, so send it again from the prompt to pay it.`)).toBe(true)
      expect(await ui.find({ key: 'cache-tax-send' })).toBe(undefined)
      expect((await ui.find({ key: 'cache-tax-cancel' }))?.props.label).toBe('Discard message')
      expect((await ui.find({ type: 'Text', text: /so send it again from the prompt\.$/ }))?.text).toBe(`It ${blocker}, so send it again from the prompt.`)
      expect(w.entered).toEqual([])
    })
  }

  test('a notification while a message is held is dropped once, then goes through, and leaves the card alone', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'cache-tax', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    await $.prompt.submit(prompt('hi'))
    const note = (text: string): PromptSubmitInput => ({ text, wait: false, origin: { kind: 'task-notification' } })
    const first = await $.prompt.submit(note('a background task finished'))
    expect(first.drop).toMatch(/^cache-tax: the prompt cache went cold 2h00m ago\..* Send it again to pay it, then \/keepwarm holds the cache\. Or \/clear and start from a note\.$/)
    expect((await ui.find({ key: 'cache-tax-send' }))?.props.label).toBe('Send message ≈$4.01')
    expect(w.entered).toEqual([])
    const second = await $.prompt.submit(note('another background task finished'))
    expect(second.drop).toBe(undefined)
    expect(w.entered).toEqual(['another background task finished'])
    expect((await ui.find({ key: 'cache-tax-send' }))?.props.label).toBe('Send message ≈$4.01')
  })
})

describe('keepwarm', () => {
  test('pings 50 minutes after the last request, then again, and reports the read', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm, warm])
    await $.session.start(session)
    const r = await $.command.run(run('keepwarm', '6h'))
    expect(r.text).toMatch(/keepwarm on for 6h00m/)
    await $.turn.complete(turn())
    await clock.advance(49 * MIN)
    expect(w.forks.length).toBe(0)
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toMatch(/keepwarm 5h10m left · ping in 50m · last ping read 200k \$0\.05/)
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(2)
  })

  test('a new turn resets the countdown', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn())
    await clock.advance(40 * MIN)
    await $.turn.complete(turn())
    await clock.advance(40 * MIN)
    expect(w.forks.length).toBe(0)
    await clock.advance(10 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('stops when a ping reads cold', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [{ read: 0, write: 180000 }, warm])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toMatch(/keepwarm stopped: the ping read 0 and wrote 180k tokens \(\$3\.60\)/)
    await clock.advance(120 * MIN)
    expect(w.forks.length).toBe(1)
    const s = await $.command.run(run('keepwarm', 'status'))
    expect(s.text).toMatch(/stopped/)
  })

  test('stops when the engine returns null, a cold snapshot or an API error', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [null])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '1h'))
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toMatch(/either the snapshot was cold or the API call failed/)
  })

  test('the window ends on its own, forgetting the every knob, and off cancels', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    const w = world(on, [warm, warm, warm], { store })
    await $.session.start(session)
    await $.command.run(run('keepwarm', '3m every 1m'))
    await $.turn.complete(turn())
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(1)
    await clock.advance(5 * MIN)
    expect(w.forks.length).toBe(2)
    expect(w.status.at(-1)).toBe(undefined)
    expect(store.has('every:S1')).toBe(false)
    expect(store.has('deadline:S1')).toBe(false)
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn())
    await clock.advance(10 * MIN)
    expect(w.forks.length).toBe(2)
    const off = await $.command.run(run('keepwarm', 'off'))
    expect(off.text).toBe('keepwarm is off')
    await clock.advance(60 * MIN)
    expect(w.forks.length).toBe(2)
  })

  test('the every knob lasts one window only', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm, warm, warm, warm])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '1h every 1m'))
    await $.turn.complete(turn())
    await clock.advance(2 * MIN)
    expect(w.forks.length).toBe(2)
    await $.command.run(run('keepwarm', 'off'))
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn())
    await clock.advance(10 * MIN)
    expect(w.forks.length).toBe(2)
    await $.command.run(run('keepwarm', '1h every 1m'))
    await $.turn.complete(turn())
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(3)
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn())
    await clock.advance(10 * MIN)
    expect(w.forks.length).toBe(3)
  })

  test('a bare /keepwarm arms six hours', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm])
    await $.session.start(session)
    const r = await $.command.run(run('keepwarm', ''))
    expect(r.text).toMatch(/^keepwarm on for 6h00m, a ping 50m after each idle stretch keeps the 1h cache warm/)
    await $.turn.complete(turn())
    expect(w.status.at(-1)).toBe('keepwarm 6h00m left · ping in 50m')
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('always is remembered, arms every session start, and off ends it for good', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true], ['deadline:S1', START - MIN], ['every:S1', MIN]])
    const w = world(on, [warm], { store })
    await $.session.start(session)
    expect(w.status.at(-1)).toBe('keepwarm 6h00m left · waiting for the first turn')
    expect(store.get('deadline:S1')).toBe(START + 6 * HOUR)
    expect(store.has('every:S1')).toBe(false)
    await $.turn.complete(turn())
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(0)
    await clock.advance(49 * MIN)
    expect(w.forks.length).toBe(1)
    const card = await $.command.run(run('cache-tax', ''))
    expect(card.text).toMatch(/keepwarm    on, 5h10m left · ping in 50m · last ping read 200k \$0\.05 \(always\)/)
    const off = await $.command.run(run('keepwarm', 'off'))
    expect(off.text).toBe('keepwarm is off, and no longer arms itself at session start')
    expect(store.has('always')).toBe(false)
    expect(w.status.at(-1)).toBe(undefined)
  })

  test('/keepwarm always sets the switch and arms now', async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    const w = world(on, [], { store })
    await $.session.start(session)
    const r = await $.command.run(run('keepwarm', 'always'))
    expect(r.text).toMatch(/^keepwarm always on: every session starts with a 6h00m window/)
    expect(store.get('always')).toBe(true)
    expect(store.get('deadline:S1')).toBe(START + 6 * HOUR)
    expect(w.status.at(-1)).toBe('keepwarm 6h00m left · waiting for the first turn')
  })

  test('the ping figure counts output tokens at the model\'s rate, Sonnet 5 priced as itself', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [{ read: 200000, write: 0, out: 1000 }])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn({ usage: usage({ model: 'claude-sonnet-5' }) }))
    await clock.advance(50 * MIN)
    expect(w.status.at(-1)).toBe('keepwarm 5h10m left · ping in 50m · last ping read 200k $0.05')
    const card = await $.command.run(run('cache-tax', ''))
    expect(card.text).toMatch(/cold cost   \$0\.80 to re-write it \(warm turn \$0\.04\)/)
    expect(card.text).toMatch(/break-even  up to 20 pings at the read rate cost one cold write, about 16h40m of idle at one ping per 50m/)
  })

  test('a partial write, a zero read, or a full write stops the loop; a ping\'s own few tokens do not', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [{ read: 200000, write: 500 }, { read: 75000, write: 70000 }, warm])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '6h every 1m'))
    await $.turn.complete(turn())
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toMatch(/^keepwarm 5h59m left · ping in 1m · last ping read 200k/)
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(2)
    expect(w.status.at(-1)).toMatch(/^keepwarm stopped: the ping read 75k and wrote 70k tokens/)
    await clock.advance(5 * MIN)
    expect(w.forks.length).toBe(2)
  })

  test('a ping that reads nothing stops the loop too', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [{ read: 0, write: 0 }, warm])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.status.at(-1)).toMatch(/^keepwarm stopped: the ping read 0 and wrote 0 tokens/)
    await clock.advance(60 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('the ping figure counts uncached input at the base rate', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [{ read: 200000, write: 0, input: 50000, out: 1000 }])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn({ usage: usage({ model: 'claude-sonnet-5' }) }))
    await clock.advance(50 * MIN)
    expect(w.status.at(-1)).toBe('keepwarm 5h10m left · ping in 50m · last ping read 200k $0.15')
  })

  test('the card states the break-even for Fable 5.1', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [])
    await $.session.start(session)
    await $.turn.complete(turn())
    const card = await $.command.run(run('cache-tax', ''))
    expect(card.text).toMatch(/break-even  up to 80 pings at the read rate cost one cold write, about 2d 18h of idle at one ping per 50m/)
  })

  test('/keepwarm on a cold session schedules no fork before a turn, and does after one', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm])
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(15 * 24 * HOUR)
    const r = await $.command.run(run('keepwarm', ''))
    expect(r.text).toBe('keepwarm on for 6h00m. The cache is cold now, so keepwarm starts pinging after your next turn')
    expect(w.status.at(-1)).toBe('keepwarm 6h00m left · cold now. keepwarm starts pinging after your next turn')
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(0)
    await clock.advance(60 * MIN)
    expect(w.forks.length).toBe(0)
    const card = await $.command.run(run('cache-tax', ''))
    expect(card.text).toMatch(/keepwarm    on, 4h59m left · cold now\. keepwarm starts pinging after your next turn/)
    await $.turn.complete(turn())
    expect(w.status.at(-1)).toBe('keepwarm 4h59m left · ping in 50m')
    await clock.advance(49 * MIN)
    expect(w.forks.length).toBe(0)
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('the always switch on a cold resume schedules no fork before a turn, and does after one', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true]])
    const w = world(on, [warm], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', 'off'))
    await clock.advance(15 * 24 * HOUR)
    // The cold state comes from the turn above and the clock; a second session start then arms the always switch over it.
    store.set('always', true)
    await $.session.start(session)
    expect(w.status.at(-1)).toBe('keepwarm 6h00m left · cold now. keepwarm starts pinging after your next turn')
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(0)
    const r = await $.command.run(run('keepwarm', 'always'))
    expect(r.text).toBe('keepwarm always on: every session starts with a 6h00m window; /keepwarm off turns it off for good. The cache is cold now, so keepwarm starts pinging after your next turn')
    await clock.advance(60 * MIN)
    expect(w.forks.length).toBe(0)
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('a cold window expires and a later paid write does not arm another', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    const w = world(on, [warm], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(2 * HOUR)
    await $.command.run(run('keepwarm', '90m every 1m'))
    await clock.advance(90 * MIN)
    expect(w.forks.length).toBe(0)
    expect(store.has('deadline:S1')).toBe(false)
    expect(store.has('every:S1')).toBe(false)
    expect(w.status.at(-1)).toBe(undefined)
    expect((await $.command.run(run('keepwarm', 'status'))).text).toBe('keepwarm is off')
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(0)
    expect(store.has('deadline:S1')).toBe(false)
  })

  test('a turn after sleep clears the expired period before the overdue timer runs', async ($, on) => {
    let now = START
    on('clock.now', () => ({ value: now }))
    on('clock.after', () => new Promise<{ value: void }>(() => {}))
    const store = new Map<string, unknown>()
    const w = world(on, [], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    now += 2 * HOUR
    await $.command.run(run('keepwarm', '90m every 1m'))
    now += 91 * MIN
    expect(store.get('every:S1')).toBe(MIN)
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
    expect(store.has('every:S1')).toBe(false)
    expect(store.has('deadline:S1')).toBe(false)
    expect(w.status.at(-1)).toBe(undefined)
    expect(w.forks.length).toBe(0)
  })

  test('subagent turns do not touch the timer', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn())
    await clock.advance(40 * MIN)
    await $.turn.complete(turn({ agentId: 'a1' }))
    await clock.advance(10 * MIN)
    expect(w.forks.length).toBe(1)
  })
})

describe('store per session', () => {
  test('another session\'s window does not arm this one', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['deadline:other', START + HOUR], ['every:other', MIN]])
    const w = world(on, [warm], { store, sid: 'mine' })
    await $.session.start(session)
    expect(w.status.at(-1)).toBe(undefined)
    const r = await $.command.run(run('keepwarm', 'status'))
    expect(r.text).toBe('keepwarm is off')
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(0)
    expect(store.get('deadline:other')).toBe(START + HOUR)
    expect(store.get('every:other')).toBe(MIN)
  })

  test('this session\'s own window is restored on start', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['deadline:mine', START + 2 * HOUR], ['every:mine', MIN]])
    const w = world(on, [warm], { store, sid: 'mine' })
    await $.session.start(session)
    expect(w.status.at(-1)).toBe('keepwarm 2h00m left · waiting for the first turn')
    await $.turn.complete(turn())
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('a window that lapsed less than a week ago is left for its own session', async ($, on) => {
    const now = START + 30 * 24 * HOUR
    mock.clock(on, { now })
    const store = new Map<string, unknown>([['deadline:recent', now - HOUR], ['every:recent', MIN]])
    world(on, [], { store, sid: 'mine' })
    await $.session.start(session)
    expect([...store.keys()]).toEqual(['deadline:recent', 'every:recent'])
  })

  test('/keepwarm off deletes only this session\'s keys', async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['deadline:other', START + HOUR], ['every:other', MIN], ['always', true], ['guard', 'warn']])
    world(on, [], { store, sid: 'mine' })
    await $.session.start(session)
    await $.command.run(run('keepwarm', '1h every 1m'))
    expect(store.get('deadline:mine')).toBe(START + HOUR)
    expect(store.get('every:mine')).toBe(MIN)
    await $.command.run(run('keepwarm', 'off'))
    expect(store.has('deadline:mine')).toBe(false)
    expect(store.has('every:mine')).toBe(false)
    expect(store.has('always')).toBe(false)
    expect(store.get('deadline:other')).toBe(START + HOUR)
    expect(store.get('every:other')).toBe(MIN)
    expect(store.get('guard')).toBe('warn')
  })

  test('legacy bare keys are cleared on start; other sessions\' keys, live or dead, and the global switches stay', async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>([
      ['deadline:old1', START - 8 * 24 * HOUR], ['every:old1', MIN],
      ['deadline:old2', 0],
      ['deadline', 0], ['every', MIN],
      ['deadline:live', START + HOUR], ['every:live', 2 * MIN],
      ['guard', 'warn'],
    ])
    world(on, [], { store, sid: 'mine' })
    await $.session.start(session)
    expect([...store.keys()]).toEqual(['deadline:old1', 'every:old1', 'deadline:old2', 'deadline:live', 'every:live', 'guard'])
  })

  test('this session\'s own dead window is cleared on start', async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['deadline:mine', START - MIN], ['every:mine', MIN], ['deadline:other', START - MIN], ['every:other', MIN]])
    world(on, [], { store, sid: 'mine' })
    await $.session.start(session)
    expect([...store.keys()]).toEqual(['deadline:other', 'every:other'])
  })
})

describe('settings', () => {
  test('readSettings fills the defaults and names each value it could not use', async () => {
    expect(readSettings({})).toEqual(DEFAULT_SETTINGS)
    expect(readSettings({ cacheTtl: '5m', guardMinTokens: 120000, defaultWindow: '2h30m' })).toEqual({ cacheTtl: '5m', guardMinTokens: 120000, defaultWindowMs: 150 * MIN, problems: [] })
    const bad = readSettings({ cacheTtl: '10m', guardMinTokens: -5, defaultWindow: 'soon' })
    expect(bad.cacheTtl).toBe('1h')
    expect(bad.guardMinTokens).toBe(50000)
    expect(bad.defaultWindowMs).toBe(6 * HOUR)
    expect(bad.problems).toEqual([
      'Cache lifetime (cacheTtl) is "10m", which is neither 1h nor 5m, so the mod uses 1h',
      'Guard threshold (guardMinTokens) is "-5", which is not a whole number of tokens, so the guard uses 50,000',
      'Default keepwarm window (defaultWindow) is "soon", which is not a duration such as 6h, 90m or 2h30m, so a bare /keepwarm arms 6h00m',
    ])
  })

  test('TTL timings: 1h goes cold after an hour and pings at 50m, 5m after five minutes and pings at 4m', async () => {
    const hour = freshState(readSettings({ cacheTtl: '1h' }))
    expect(ttlMsOf(hour)).toBe(HOUR)
    expect(pingAfterMsOf(hour)).toBe(50 * MIN)
    expect(hour.every).toBe(50 * MIN)
    const fiveMinutes = freshState(readSettings({ cacheTtl: '5m' }))
    expect(ttlMsOf(fiveMinutes)).toBe(5 * MIN)
    expect(pingAfterMsOf(fiveMinutes)).toBe(4 * MIN)
    expect(fiveMinutes.every).toBe(4 * MIN)
  })

  test('5m cache: pings 4 minutes after a turn and warns once with the hourly cost', { options: { cacheTtl: '5m' } }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm, warm])
    await $.session.start(session)
    await $.turn.complete(turn())
    const first = await $.command.run(run('keepwarm', '1h'))
    // 15 pings an hour of 200,502 tokens at Fable 5.1's $0.25/MTok read rate.
    expect(first.text).toMatch(/On the 5m cache keepwarm pings every 4m, 15 pings an hour: about \$0\.75 an hour at the current 201k-token context$/)
    await clock.advance(3 * MIN)
    expect(w.forks.length).toBe(0)
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(1)
    const second = await $.command.run(run('keepwarm', '2h'))
    expect(second.text).not.toMatch(/On the 5m cache/)
  })

  test('5m cache: cold after five idle minutes, priced at the 5-minute write rate', { options: { cacheTtl: '5m' } }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(4 * MIN)
    expect((await $.command.run(run('cache-tax', ''))).text).toMatch(/state       warm, 1m left/)
    await clock.advance(1 * MIN)
    const card = await $.command.run(run('cache-tax', ''))
    expect(card.text).toMatch(/state       COLD/)
    expect(card.text).toMatch(/lifetime    5m cache, cold after 5m idle, writes at \$12\.5\/MTok; set by Cache lifetime \(cacheTtl\)/)
    // 200,502 tokens at Fable 5.1's 5-minute write rate, $12.50/MTok.
    expect((await $.prompt.submit(prompt('hi'))).drop).toMatch(/at \$12\.5\/MTok = \$2\.51/)
    expect(w.entered).toEqual([])
  })

  test('guard threshold: under it the status says why a cold send went through', { options: { guardMinTokens: 300000 } }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    await $.turn.complete(turn())
    // Warm, the line has nothing to explain.
    expect(w.status.at(-1)).toBe(undefined)
    await clock.advance(59 * MIN)
    expect(w.status.at(-1)).toBe(undefined)
    // Cold with keepwarm off, it says why the next send goes through.
    await clock.advance(1 * MIN)
    expect(w.status.at(-1)).toBe('cache cold · guard off below 300k tokens')
    await $.command.run(run('keepwarm', '6h'))
    expect(w.status.at(-1)).toBe('keepwarm 6h00m left · cold now. keepwarm starts pinging after your next turn · guard off below 300k tokens')
    await $.command.run(run('keepwarm', 'off'))
    expect(w.status.at(-1)).toBe('cache cold · guard off below 300k tokens')
    await $.prompt.submit(prompt('hi'))
    expect(w.entered).toEqual(['hi'])
    expect((await $.command.run(run('cache-tax', ''))).text).toMatch(/guard off below 300k tokens: this context is 201k, so a cold send goes through/)
    await $.turn.complete(turn())
    expect(w.status.at(-1)).toBe(undefined)
  })

  test('guard threshold: /keepwarm off on a warm cache still shows the guard-off line once it goes cold', { options: { guardMinTokens: 300000 } }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '6h'))
    expect(w.status.at(-1)).toBe('keepwarm 6h00m left · ping in 50m')
    await $.command.run(run('keepwarm', 'off'))
    expect(w.status.at(-1)).toBe(undefined)
    await clock.advance(HOUR)
    expect(w.status.at(-1)).toBe('cache cold · guard off below 300k tokens')
    expect(w.forks.length).toBe(0)
  })

  test('guard threshold: the band row appears once the cache is cold, keepwarm off', { options: { guardMinTokens: 300000 } }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, [])
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'cache-tax', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    await $.turn.complete(turn())
    expect(await ui.find({ type: 'Text', text: 'cache-tax' })).toBe(undefined)
    await clock.advance(HOUR)
    expect((await ui.find({ type: 'Text', text: 'cache-tax' }))?.text).toMatch(/cold.* · guard off below 300k tokens$/)
  })

  test('defaultWindow sets what a bare /keepwarm arms', { options: { defaultWindow: '2h' } }, async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [])
    await $.session.start(session)
    expect((await $.command.run(run('keepwarm', ''))).text).toMatch(/^keepwarm on for 2h00m/)
  })
})

describe('ping spend and savings', () => {
  test('a turn that arrives warm after a gap longer than the TTL, thanks to a ping, saves one cold write', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm, warm])
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'cache-tax', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '6h'))
    await clock.advance(50 * MIN)
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(2)
    await clock.advance(20 * MIN)
    await $.turn.complete(turn())
    // Two pings of about $0.05 each; the turn avoided a 200,502-token write at $20/MTok.
    expect((await ui.find({ type: 'Text', text: 'cache-tax' }))?.text).toMatch(/keepwarm: pings \$0\.10, saved about \$4\.01/)
    const card = await $.command.run(run('cache-tax', ''))
    expect(card.text).toMatch(/savings     keepwarm: pings \$0\.10, saved about \$4\.01 this session \(1 cold write avoided\); the totals reset each session/)
  })

  test('savings math: no ping in the gap, or a gap within the TTL, saves nothing', async () => {
    const base = () => {
      const state = freshState()
      state.lastModel = 'claude-fable-5-1'
      state.ctx = 200000
      state.lastTurnAt = START
      state.lastRequestAt = START
      return state
    }
    const noPing = base()
    expect(noteTurnRequest(noPing, START + 2 * HOUR)).toBe(null)
    const shortGap = base()
    shortGap.lastPingAt = START + 50 * MIN
    shortGap.lastRequestAt = shortGap.lastPingAt
    expect(noteTurnRequest(shortGap, START + 55 * MIN)).toBe(null)
    const saved = base()
    saved.lastPingAt = START + 100 * MIN
    saved.lastRequestAt = saved.lastPingAt
    saved.pingCount = 2
    saved.pingSpendUsd = 0.1
    expect(noteTurnRequest(saved, START + 2 * HOUR)).toBe(4)
    expect(saved.savedUsd).toBe(4)
    expect(saved.avoidedColdWrites).toBe(1)
    expect(savingsText(saved)).toBe('keepwarm: pings $0.10, saved about $4.00')
    // The same gap a second time is not counted again: the turn clock moved.
    expect(noteTurnRequest(saved, START + 2 * HOUR + MIN)).toBe(null)
    resetForClear(saved)
    expect(savingsText(saved)).toBe('keepwarm: pings $0.00, saved about $0.00')
  })

  test('the hourly ping cost reads the context at the read rate', async () => {
    const state = freshState(readSettings({ cacheTtl: '5m' }))
    expect(pingCostPerHour(state)).toBe(null)
    state.lastModel = 'claude-sonnet-5'
    state.ctx = 100000
    // 15 pings an hour of 100,000 tokens at $0.20/MTok.
    expect(Math.round((pingCostPerHour(state) ?? 0) * 1e6) / 1e6).toBe(0.3)
  })
})

describe('held message restore and resendability', () => {
  const holdOne = async ($: Engine, clock: MockClock) => {
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    await $.prompt.submit(prompt('the long question'))
  }

  test('compaction puts the held text back in an empty prompt box', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await holdOne($, clock)
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
    expect(w.fills).toEqual(['the long question'])
    expect(w.toasts.at(-1)).toBe('Your held message is back in the prompt box: the conversation was compacted')
  })

  test('another turn with a draft in the box copies the held text and says why', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [], { box: { text: 'half typed' } })
    await holdOne($, clock)
    await $.turn.complete(turn())
    expect(w.fills).toEqual([])
    expect(w.copies).toEqual(['the long question'])
    expect(w.toasts.at(-1)).toBe('Your held message is on the clipboard: another turn ran before you sent it, and the prompt box already had a draft')
  })

  test('a different message sent while one is held goes through, and the held one comes back after its turn', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await holdOne($, clock)
    expect((await $.prompt.submit(prompt('a shorter question'))).drop).toBe(undefined)
    expect(w.entered).toEqual(['a shorter question'])
    expect(w.fills).toEqual([])
    await $.turn.complete(turn())
    expect(w.fills).toEqual(['the long question'])
    expect(w.toasts.at(-1)).toBe('Your held message is back in the prompt box: you sent a different message while it was held')
  })

  test('sending the held message itself again gives nothing back', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await holdOne($, clock)
    await $.prompt.submit(prompt('the long question'))
    expect(w.entered).toEqual(['the long question'])
    await $.turn.complete(turn())
    expect(w.fills).toEqual([])
    expect(w.copies).toEqual([])
  })

  test('a resume puts the held text back too', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await holdOne($, clock)
    await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 30, context_tokens: 200000 })
    expect(w.fills).toEqual(['the long question'])
    expect(w.toasts.at(-1)).toBe('Your held message is back in the prompt box: the session was resumed')
  })

  test('the held card buttons carry hotkeys 1 and 2, drawn plain so the digit shows', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, [])
    await holdOne($, clock)
    const ui = await $.ui.mount({ plugin: 'cache-tax', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    const send = await ui.find({ key: 'cache-tax-send' })
    const discard = await ui.find({ key: 'cache-tax-cancel' })
    expect(send?.props.hotkey).toBe('1')
    expect(send?.props.plain).toBe(true)
    expect(send?.props.label).toBe('Send message ≈$4.01')
    expect(discard?.props.hotkey).toBe('2')
    expect(discard?.props.plain).toBe(true)
    expect(discard?.props.label).toBe('Discard message')
  })

  test('the one-line card leads with the price, then how long the cache has been cold', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, [])
    await holdOne($, clock)
    const ui = await $.ui.mount({ plugin: 'cache-tax', surface: 'terminal', component: 'AbovePrompt', props: { ...bandProps, maxRows: 4 } })
    expect((await ui.find({ type: 'Text', text: /^about \S+ to send cold, cache cold for \S+$/ }))?.text).toBe('about $4.01 to send cold, cache cold for 2h00m')
    expect((await ui.find({ type: 'Text', text: /^ · message held/ }))?.text).toBe(' · message held, a warm turn about $0.05')
  })

  test('a refused resend comes back with a toast naming the cause', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [], { failResend: 'the session is busy with another turn' })
    await holdOne($, clock)
    const ui = await $.ui.mount({ plugin: 'cache-tax', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    await $.ui.press({ plugin: 'cache-tax', key: 'cache-tax-send' })
    expect(w.toasts.at(-1)).toBe('cache-tax: the resend did not go through: the session is busy with another turn')
    expect(await ui.find({ key: 'cache-tax-send' })).toBeDefined()
  })

  test('@everyone stays resendable; a path mention or an attachment does not', async () => {
    expect(heldBlocker('thanks @everyone, ship it', 0)).toBe(null)
    expect(heldBlocker('ping @here', 0)).toBe(null)
    expect(heldBlocker('mail a@b.com', 0)).toBe(null)
    expect(heldBlocker('read @src/a.ts first', 0)).toBe('mentions @src/a.ts')
    expect(heldBlocker('see @README.md.', 0)).toBe('mentions @README.md')
    expect(heldBlocker('see this', 1)).toBe('has an attachment')
  })

  test('a held message with @everyone keeps Send message', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, [])
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'cache-tax', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    expect((await $.prompt.submit(prompt('thanks @everyone'))).drop).toMatch(/Send it again, or use Send message below\.$/)
    expect((await ui.find({ key: 'cache-tax-send' }))?.props.label).toBe('Send message ≈$4.01')
  })
})

describe('tip and help', () => {
  test('the first cold write of $0.50 or more brings one /keepwarm tip, ever', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    const w = world(on, [], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200502 }) }))
    expect(w.toasts.filter(text => text.startsWith('Tip:'))).toEqual(['Tip: that cold write cost $4.01. /keepwarm pings the cache while you are away, so your next turn reads it at the cache-read rate. /keepwarm help lists its forms.'])
    expect(store.get('keepwarmTipShown')).toBe(true)
    await clock.advance(MIN)
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200502 }) }))
    expect(w.toasts.filter(text => text.startsWith('Tip:')).length).toBe(1)
  })

  test('/keepwarm help and /cache-tax help list every argument, every included', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [])
    await $.session.start(session)
    const keepwarm = (await $.command.run(run('keepwarm', 'help'))).text
    expect(keepwarm).toBe(keepwarmHelp(freshState()))
    for (const form of ['/keepwarm  ', '/keepwarm 90m  ', '/keepwarm 90m every 2m', '/keepwarm always', '/keepwarm off', '/keepwarm status', '/keepwarm help']) expect(keepwarm).toContain(form)
    const cacheTax = (await $.command.run(run('cache-tax', 'help'))).text
    expect(cacheTax).toBe(cacheTaxHelp(freshState()))
    for (const form of ['/cache-tax status', '/cache-tax guard refuse', '/cache-tax guard warn', '/cache-tax help', '/keepwarm 90m every 2m']) expect(cacheTax).toContain(form)
    expect(cacheTax).toContain('Settings (/config, pulse-cache-tax):\n  Cache lifetime (cacheTtl): 1h\n  Guard threshold (guardMinTokens): 50,000 tokens\n  Default keepwarm window (defaultWindow): 6h00m')
  })

  test('the /keepwarm error lists every accepted form', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [])
    await $.session.start(session)
    const text = (await $.command.run(run('keepwarm', 'soon'))).text
    expect(text).toBe('keepwarm does not take "soon". It takes a bare /keepwarm, a window such as 6h, 90m or 2h30m, a window with a ping period such as 90m every 2m, always, off, status or help.')
    expect((await $.command.run(run('keepwarm', '90m every 10s'))).text).toBe('every takes a period of at least 1m, as in /keepwarm 90m every 2m; "10s" is not a period')
  })
})
