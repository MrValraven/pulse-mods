import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { parsePulseArgs, pulseSuggestions, unknownArgumentText, helpText } from './commands'
import { activeTime, bandWords, errorDetailOf, stopLabelOf, terminalBandLayout } from './draw'
import { PRICES_AS_OF, priceOf } from './prices'
import { checkForUpdates, compareVersions, formatReport, LATEST_URL, toastFor } from './updates'
import type { UpdateIo } from './updates'

const PLUGIN = 'pulse-progress'
const band = { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4 }, view: {} }
const pane = { title: '', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as const
const SPAWN = { tool_use_id: 't1', prompt: 'Do the thing', description: 'Polish the hero', subagentType: 'react-engineer', provider: 'engine', parentModel: 'claude-opus-5-5', background: false, fork: false }

const setup = (on: On, seen: { prompt?: string }, model = 'claude-opus-5-5') => {
  const clock = mock.clock(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  // Stands for Claude Code's own drawing beneath the mod.
  on('ui.render', () => ({ type: 'engine', ref: 0 }) as never)
  on('agent.spawn', (_$, e) => {
    seen.prompt = e.prompt
    return { model, agentId: 'a1' }
  })
  on('turn.complete', () => ({ text: '' }) as never)
  return clock
}

const spawn = ($: Engine) => $.agent.spawn(SPAWN as never)
const finish = ($: Engine, reason = 'answer', usage: unknown = null) =>
  ($.turn.complete as (e: unknown) => Promise<unknown>)({ agentId: 'a1', reason, answer: 'ok', usage })
const USAGE = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-mystery-1' }

test('it never rewrites the subagent prompt', async ($, on) => {
  const seen: { prompt?: string } = {}
  setup(on, seen)
  await spawn($)
  expect(seen.prompt).toBe('Do the thing')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: no band until a subagent starts, then it tracks progress`, async ($, on) => {
    setup(on, {})
    const before = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: band })
    expect(await before.find({ key: 'pulse-agents' })).toBeUndefined()
    await before.unmount()

    await spawn($)
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: band })
    expect((await ui.find({ key: 'pulse-agents' }))?.props.label).toBe('Agents 1')
    await ui.unmount()

    await finish($)
    const pnl = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'pulse-agents', props: pane })
    expect(await pnl.find({ key: 'done' })).toBeDefined()
  })

  test(`${surface}: dismiss hides the band, and Undo clear brings the runs back`, async ($, on) => {
    setup(on, {})
    await spawn($)
    await finish($)
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: band })
    await ui.press({ key: 'pulse-dismiss' })
    const after = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: band })
    expect(await after.find({ key: 'pulse-agents' })).toBeUndefined()
    expect((await after.find({ key: 'pulse-undo' }))?.props.label).toBe('Undo clear')
    await after.press({ key: 'pulse-undo' })
    const restored = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: band })
    expect((await restored.find({ key: 'pulse-agents' }))?.props.label).toBe('Agents 1')
    expect((await restored.find({ key: 'pulse-dismiss' }))?.props.label).toBe('Clear finished')
  })

  test(`${surface}: with nothing finished the close button reads Hide band`, async ($, on) => {
    setup(on, {})
    await spawn($)
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: band })
    expect((await ui.find({ key: 'pulse-dismiss' }))?.props.label).toBe('Hide band')
  })

  test(`${surface}: the Undo row leaves after 10 seconds`, async ($, on) => {
    const clock = setup(on, {})
    await spawn($)
    await finish($)
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: band })
    await ui.press({ key: 'pulse-dismiss' })
    await clock.advance(10_001)
    const after = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: band })
    expect(await after.find({ key: 'pulse-undo' })).toBeUndefined()
  })
}

test('desktop: a cancelled run names why it stopped', async ($, on) => {
  setup(on, {})
  await spawn($)
  await finish($, 'aborted')
  const pane2 = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'Pane', requestId: 'pulse-agents', props: pane })
  expect(String((await pane2.find({ key: 'a1' }))?.props.alt)).toContain('Cancelled by you')
})

test('desktop: a run on a model with no price shows "price unknown"', async ($, on) => {
  setup(on, {}, 'claude-mystery-1')
  await spawn($)
  await finish($, 'answer', USAGE)
  const pane2 = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'Pane', requestId: 'pulse-agents', props: pane })
  expect(String((await pane2.find({ key: 'a1' }))?.props.alt)).toContain('price unknown')
  expect(String((await pane2.find({ key: 'header' }))?.props.alt)).toContain('price unknown')
})

// ---------------------------------------------------------------------------
// Pure functions: no engine, no network, no files.

test('/pulse arguments: bare toggles, known words, and a named unknown', async () => {
  expect(parsePulseArgs('')).toEqual({ kind: 'toggle' })
  expect(parsePulseArgs('   ')).toEqual({ kind: 'toggle' })
  expect(parsePulseArgs('open')).toEqual({ kind: 'open' })
  expect(parsePulseArgs(' Close ')).toEqual({ kind: 'close' })
  expect(parsePulseArgs('help')).toEqual({ kind: 'help' })
  expect(parsePulseArgs('mods')).toEqual({ kind: 'mods' })
  expect(parsePulseArgs('frobnicate')).toEqual({ kind: 'unknown', argument: 'frobnicate' })
  expect(unknownArgumentText('frobnicate')).toBe('/pulse does not take "frobnicate". It takes open, close, help or mods.')
})

test('/pulse typeahead offers the arguments after "/pulse " alone', async () => {
  expect(pulseSuggestions('/pulse o', 7, 'o').map(row => row.text)).toEqual(['open'])
  expect(pulseSuggestions('/pulse m', 7, 'm').map(row => row.text)).toEqual(['mods'])
  expect(pulseSuggestions('hello o', 6, 'o')).toEqual([])
})

test('/pulse help lists the commands, the settings and the price date', async () => {
  const text = helpText({ autoOpen: 'once', updateCheck: 'on' }, PRICES_AS_OF)
  expect(text).toContain('/pulse mods')
  expect(text).toContain('Settings (/config, pulse-progress):')
  expect(text).toContain('Check for pulse mods updates (updateCheck)')
  expect(text).toContain('Open the agents panel (autoOpen)')
  expect(text).toContain(`prices as of ${PRICES_AS_OF}`)
})

test('stop reasons map to words, and an unknown reason is shown raw', async () => {
  expect(stopLabelOf('aborted')).toBe('Cancelled by you')
  expect(stopLabelOf('refusal')).toBe('Refused by the model')
  expect(stopLabelOf('error', 'model_context_window_exceeded')).toBe('Context limit reached')
  expect(stopLabelOf('error', 'max_tokens')).toBe('Output limit reached')
  expect(stopLabelOf('error', null)).toBe('API error')
  expect(stopLabelOf('error', null, '529 overloaded_error')).toBe('API error: 529 overloaded_error')
  expect(stopLabelOf('refusal', null, 'cyber')).toBe('Refused by the model: cyber')
  expect(errorDetailOf('API Error: 529 {"type":"overloaded_error"}')).toBe('529 {"type":"overloaded_error"}')
  expect(errorDetailOf('Here is my partial report')).toBeUndefined()
  expect(stopLabelOf('pause_turn')).toBe('Stopped: pause_turn')
})

test('a model with no price row is unknown', async () => {
  expect(priceOf('claude-mystery-1')).toBeNull()
  expect(priceOf('claude-opus-5-5')?.input).toBe(4)
})

test('active time leaves out the idle gaps between runs', async () => {
  const run = (startedAt: number, endedAt: number) =>
    ({ id: String(startedAt), type: 'x', description: '', model: '', status: 'done', startedAt, endedAt, contextTokens: 0, contextMax: 1, tokens: 0, costUsd: 0, steps: 0 }) as const
  // 0-10 and 5-15 overlap (15), then idle, then 100-110 (10).
  expect(activeTime([run(0, 10_000), run(5_000, 15_000), run(100_000, 110_000)], 200_000)).toBe(25_000)
})

test('the band says its state in words', async () => {
  expect(bandWords(3, 3, 0)).toBe('All done')
  expect(bandWords(3, 3, 2)).toBe('Finished · 2 stopped')
  expect(bandWords(1, 3, 1)).toBe('1/3 · 1 stopped')
})

test('a narrow terminal band drops the percent, then the bar, and keeps the words', async () => {
  const wide = terminalBandLayout(100, '1/3', 'Agents 3', true)
  expect(wide.dismissLabel).toBe('Clear finished')
  expect(wide.isPercentShown).toBe(true)
  expect(wide.barWidth).toBe(40)
  const narrow = terminalBandLayout(40, '1/3', 'Agents 3', true)
  expect(narrow.dismissLabel).toBe('Clear')
  expect(narrow.isPercentShown).toBe(false)
  expect(narrow.barWidth > 0).toBe(true)
  const tiny = terminalBandLayout(30, '1/3', 'Agents 3', true)
  expect(tiny.isPercentShown).toBe(false)
  expect(tiny.barWidth).toBe(0)
})

test('versions compare by number', async () => {
  expect(compareVersions('0.6.0', '0.7.0')).toBe(-1)
  expect(compareVersions('0.10.0', '0.9.9')).toBe(1)
  expect(compareVersions('2.5.0', '2.5.0')).toBe(0)
  expect(compareVersions('1.2', '1.2.0')).toBe(0)
  expect(compareVersions('v3.6.0', '3.5.12')).toBe(1)
})

const HOME = '/home/me'
const CLONE = '/home/me/pulse-mods'
const files = (overrides: Record<string, string> = {}): Record<string, string> => ({
  [`${HOME}/.claude/plugins/installed_plugins.json`]: JSON.stringify({
    version: 2,
    plugins: {
      'pulse-progress@pulse-mods': [{ scope: 'user', version: '0.4.0' }],
      'pulse-filetree@pulse-mods': [{ scope: 'user', version: '0.7.0' }],
      'other@elsewhere': [{ scope: 'user', version: '9.9.9' }],
    },
  }),
  [`${HOME}/.claude/plugins/known_marketplaces.json`]: JSON.stringify({
    'pulse-mods': { source: { source: 'directory', path: CLONE }, installLocation: CLONE },
  }),
  [`${CLONE}/.claude-plugin/marketplace.json`]: JSON.stringify({
    plugins: [
      { name: 'pulse-progress', version: '0.4.0' },
      { name: 'pulse-filetree', version: '0.7.0' },
    ],
  }),
  ...overrides,
})
const GITHUB = JSON.stringify({
  plugins: [
    { name: 'pulse-progress', version: '0.5.0' },
    { name: 'pulse-filetree', version: '0.7.0' },
    { name: 'pulse-ports', version: '0.1.0' },
  ],
})
const ioOf = (fileMap: Record<string, string>, response = { status: 200, ok: true, text: GITHUB }): UpdateIo => ({
  home: HOME,
  readText: async path => {
    const text = fileMap[path]
    if (text === undefined) throw new Error(`ENOENT: no such file, open '${path}'`)
    return text
  },
  fetchText: async url => {
    expect(url).toBe(LATEST_URL)
    return response
  },
})

test('update check: a local clone behind GitHub must be pulled first', async () => {
  const result = await checkForUpdates(ioOf(files()))
  expect(result.isOk).toBe(true)
  if (!result.isOk) return
  const reply = formatReport(result.report)
  expect(reply).toContain('installed 0.4.0')
  expect(reply).toContain('latest 0.5.0  newer on GitHub')
  expect(reply).toContain('not installed')
  expect(reply).toContain(`The clone at ${CLONE} is behind GitHub`)
  expect(reply).toContain(`git -C ${CLONE} pull --ff-only origin main && claude plugin marketplace update pulse-mods`)
  expect(reply).toContain('do claude plugin update "$mod@pulse-mods"; done')
  expect(reply).toContain('start a new session; /reload-plugins keeps the old version')
  expect(toastFor(result.report)).toBe('pulse-progress 0.5.0 is on GitHub, you run 0.4.0. /pulse mods shows the update steps')
})

test('update check: every failure names its cause', async () => {
  const notFound = await checkForUpdates(ioOf(files(), { status: 404, ok: false, text: '' }))
  expect(notFound.isOk ? '' : notFound.cause).toContain('HTTP 404')
  expect(notFound.isOk ? false : notFound.isAnswered).toBe(true)

  const offline = await checkForUpdates({
    ...ioOf(files()),
    fetchText: async () => {
      throw new Error('getaddrinfo ENOTFOUND raw.githubusercontent.com')
    },
  })
  expect(offline.isOk ? '' : offline.cause).toContain(`No network: could not fetch ${LATEST_URL}`)
  expect(offline.isOk ? true : offline.isAnswered).toBe(false)

  // A policy refusal keeps the fetch's own words.
  const refused = await checkForUpdates({
    ...ioOf(files()),
    fetchText: async () => {
      throw new Error("refused by the organization's web-fetch policy")
    },
  })
  expect(refused.isOk ? '' : refused.cause).toBe(`Could not fetch ${LATEST_URL}: refused by the organization's web-fetch policy`)

  const installedPath = `${HOME}/.claude/plugins/installed_plugins.json`
  const broken = await checkForUpdates(ioOf(files({ [installedPath]: '{ not json' })))
  expect(broken.isOk ? '' : broken.cause).toContain(`${installedPath} is not valid JSON`)
})

test('desktop: the band tweens its fill after a change, then draws the settled bar', async ($, on) => {
  const clock = setup(on, {})
  await spawn($)
  await finish($)
  const tweening = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: band })
  expect(String((await tweening.find({ type: 'Svg' }))?.props.source)).toContain('@keyframes rvk')
  await tweening.unmount()

  await clock.advance(1000)
  const settled = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: band })
  const source = String((await settled.find({ type: 'Svg' }))?.props.source)
  expect(source).toContain('<svg')
  expect(source).not.toContain('@keyframes rvk')
})

// The surface rebuilds a band image from the source it holds; a source still holding the tween replays it.
test('desktop: a mounted band redraws settled once its tween is over', async ($, on) => {
  const clock = setup(on, {})
  await spawn($)
  await finish($)
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: band })
  expect(String((await ui.find({ type: 'Svg' }))?.props.source)).toContain('@keyframes rvk')
  await clock.advance(1000)
  expect(String((await ui.find({ type: 'Svg' }))?.props.source)).not.toContain('@keyframes rvk')
})
