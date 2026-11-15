import { describe, expect, test } from 'claude-code/testing'

import {
  announceBandText,
  BAND_HINT,
  heldLine,
  helpText,
  holdButtons,
  movedToastText,
  paneRows,
  settingsLines,
  timeoutToastText,
  unknownArgumentText,
  wrappedRows,
} from '../hooks/hold-copy'
import type { HoldRowsInput } from '../hooks/hold-copy'

const hold = (over: Partial<HoldRowsInput> = {}): HoldRowsInput => ({
  port: 3000,
  shownCommand: 'npm run dev',
  portDetail: 'next default',
  sources: ['reservedPorts setting'],
  freeNote: null,
  moveSummary: 'npm run dev -- --port 4100',
  moveNote: null,
  moveLabel: 'Run on port 4100',
  ...over,
})

describe('buttons and hotkeys', () => {
  test('1 moves, 2 cancels, 3 runs anyway, as in the other pulse guards', () => {
    expect(holdButtons('Run on port 4100', 3000)).toEqual([
      { key: 'move', label: 'Run on port 4100', hotkey: '1', isPrimary: true },
      { key: 'cancel', label: 'Cancel command', hotkey: '2', isPrimary: false },
      { key: 'anyway', label: 'Run on 3000 anyway', hotkey: '3', isPrimary: false },
    ])
    expect(holdButtons('Edit launch.json to port 4100', 5173)[0]?.label).toBe('Edit launch.json to port 4100')
  })

  test('help lists the same three buttons, and that ctrl+x tab returns to them', () => {
    const help = helpText(4100)
    expect(help).toMatch(/1 {2}Run on port N/)
    expect(help).toMatch(/2 {2}Cancel command/)
    expect(help).toMatch(/3 {2}Run on <port> anyway/)
    expect(help).toMatch(/ctrl\+x tab returns to the buttons/)
    expect(help).toMatch(/cancelled after 10 minutes without an answer/)
  })
})

describe('the hold as drawn', () => {
  test('the first line states the decision', () => {
    expect(heldLine(3000)).toEqual({ word: 'Held', rest: '  server on port 3000' })
  })

  test('the band says how to reach the buttons', () => {
    expect(BAND_HINT).toBe('Claude is waiting: click here or press ctrl+x tab, then 1, 2 or 3')
    expect(announceBandText('npm run dev', 3000, 'Run on port 4100')).toBe(
      'pulse-ports is holding npm run dev, which would start a server on port 3000. ' +
        'Click the band above the prompt or press ctrl+x tab, then press 1 to run on port 4100, 2 to cancel it or 3 to run it on 3000 anyway.',
    )
  })

  test('rows count a command that wraps', () => {
    expect(wrappedRows('a'.repeat(66), 66)).toBe(1)
    expect(wrappedRows('a'.repeat(67), 66)).toBe(2)
    const short = paneRows(hold())
    const long = paneRows(hold({ shownCommand: `cd web && ${'npm run dev '.repeat(20)}` }))
    expect(long - short).toBe(wrappedRows(' '.repeat(11) + `cd web && ${'npm run dev '.repeat(20)}`, 66) - 1)
  })
})

describe('toasts', () => {
  test('the move toast is raised only when the moved call was not refused', () => {
    expect(movedToastText({}, 'npm run dev', 4100)).toBe('pulse-ports moved npm run dev to port 4100')
    expect(movedToastText({ deny: 'refused below' }, 'npm run dev', 4100)).toBe(null)
    expect(movedToastText({}, 'preview web', 4100, '.claude/launch.json')).toBe('pulse-ports moved preview web to port 4100 in .claude/launch.json')
  })

  test('the timeout toast uses the same words as the help', () => {
    expect(timeoutToastText('npm run dev')).toBe('pulse-ports cancelled npm run dev after 10 minutes without an answer')
  })
})

describe('/ports words', () => {
  test('an unknown argument says what /ports takes', () => {
    expect(unknownArgumentText('list')).toBe('/ports does not take "list". It takes help or nothing.')
  })

  test('settings read by their /config title and key', () => {
    expect(settingsLines({ reservedPortsText: '3000, 8080', isPackageJsonChecked: true, firstFreePort: 4100 })).toEqual([
      'Settings (/config, pulse-ports):',
      '  Reserved ports (reservedPorts)                 3000, 8080',
      '  Reserve package.json ports (checkPackageJson)  on',
      '  First free port (firstFreePort)                4100',
    ])
  })
})
