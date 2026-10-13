import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const PLUGIN = 'pulse-progress'
const band = { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4 }, view: {} }
const pane = { title: '', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as const
const SPAWN = { tool_use_id: 't1', prompt: 'Do the thing', description: 'Polish the hero', subagentType: 'react-engineer', provider: 'engine', parentModel: 'claude-opus-5-5', background: false, fork: false }

const setup = (on: On, seen: { prompt?: string }) => {
  const clock = mock.clock(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  // Stands for Claude Code's own drawing beneath the mod.
  on('ui.render', () => ({ type: 'engine', ref: 0 }) as never)
  on('agent.spawn', (_$, e) => {
    seen.prompt = e.prompt
    return { model: 'claude-opus-5-5', agentId: 'a1' }
  })
  on('turn.complete', () => ({ text: '' }) as never)
  return clock
}

const spawn = ($: Engine) => $.agent.spawn(SPAWN as never)
const finish = ($: Engine) => ($.turn.complete as (e: unknown) => Promise<unknown>)({ agentId: 'a1', reason: 'answer', answer: 'ok', usage: null })

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
    expect((await ui.find({ key: 'pulse-agents' }))?.props.label).toBe('×1')
    await ui.unmount()

    await finish($)
    const pnl = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'pulse-agents', props: pane })
    expect(await pnl.find({ key: 'done' })).toBeDefined()
  })

  test(`${surface}: dismiss hides the band`, async ($, on) => {
    setup(on, {})
    await spawn($)
    await finish($)
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: band })
    await ui.press({ key: 'pulse-dismiss' })
    const after = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: band })
    expect(await after.find({ key: 'pulse-agents' })).toBeUndefined()
  })
}

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
