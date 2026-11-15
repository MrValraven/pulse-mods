// pulse-ports: the words and layout numbers of a hold, kept apart from `$` so
// the tests import them directly. register.ts draws and says what this answers.

import { shortCommand } from './ports'

export const PANE_HINT = 'Claude is waiting on your answer'
export const BAND_HINT = 'Claude is waiting: click here or press ctrl+x tab, then 1, 2 or 3'

export type HoldButton = { key: 'move' | 'cancel' | 'anyway'; label: string; hotkey: '1' | '2' | '3'; isPrimary: boolean }

/** The three buttons in order. 2 refuses, as in the other pulse guards. */
export function holdButtons(moveLabel: string, port: number): HoldButton[] {
  return [
    { key: 'move', label: moveLabel, hotkey: '1', isPrimary: true },
    { key: 'cancel', label: 'Cancel command', hotkey: '2', isPrimary: false },
    { key: 'anyway', label: `Run on ${port} anyway`, hotkey: '3', isPrimary: false },
  ]
}

/** The first line of the hold: the decision, then what it is about. */
export function heldLine(port: number): { word: string; rest: string } {
  return { word: 'Held', rest: `  server on port ${port}` }
}

/** Said by toast and notification when the hold falls back to the band, which cannot take the keys by itself. */
export function announceBandText(shownCommand: string, port: number, moveLabel: string): string {
  const moveAction = moveLabel.charAt(0).toLowerCase() + moveLabel.slice(1)
  return (
    `pulse-ports is holding ${shortCommand(shownCommand)}, which would start a server on port ${port}. ` +
    `Click the band above the prompt or press ctrl+x tab, then press 1 to ${moveAction}, 2 to cancel it or 3 to run it on ${port} anyway.`
  )
}

/** The toast after a move, raised only once the moved call ran without a refusal; null when it was refused. */
export function movedToastText(result: { deny?: string }, what: string, port: number, where?: string): string | null {
  if (result.deny !== undefined) {
    return null
  }
  return `pulse-ports moved ${what} to port ${port}${where === undefined ? '' : ` in ${where}`}`
}

export function cancelToastText(shownCommand: string, port: number): string {
  return `pulse-ports cancelled ${shortCommand(shownCommand)}: port ${port} stays free for your own testing`
}

export function timeoutToastText(shownCommand: string): string {
  return `pulse-ports cancelled ${shortCommand(shownCommand)} after 10 minutes without an answer`
}

export function unknownArgumentText(argument: string): string {
  return `/ports does not take "${argument}". It takes help or nothing.`
}

/** The settings as /config names them: the title shown there, then the key. */
export const SETTING_TITLES = {
  reservedPorts: 'Reserved ports',
  checkPackageJson: 'Reserve package.json ports',
  firstFreePort: 'First free port',
} as const

export function settingsLines(values: { reservedPortsText: string; isPackageJsonChecked: boolean; firstFreePort: number }): string[] {
  const rows: Array<[string, string]> = [
    [`${SETTING_TITLES.reservedPorts} (reservedPorts)`, values.reservedPortsText === '' ? '(empty)' : values.reservedPortsText],
    [`${SETTING_TITLES.checkPackageJson} (checkPackageJson)`, values.isPackageJsonChecked ? 'on' : 'off'],
    [`${SETTING_TITLES.firstFreePort} (firstFreePort)`, String(values.firstFreePort)],
  ]
  const width = Math.max(...rows.map(([label]) => label.length)) + 2
  return ['Settings (/config, pulse-ports):', ...rows.map(([label, value]) => `  ${label.padEnd(width)}${value}`)]
}

export function helpText(firstFreePort: number): string {
  return [
    'pulse-ports holds a Bash command that would start a dev server on a port you keep for your own testing.',
    '',
    'A port is reserved when it is in the reservedPorts setting, or (with checkPackageJson on) when a',
    'package.json script would serve on it: --port N, -p N, PORT=N, a literal server.port in vite.config.*,',
    "a literal port in Nest's src/main.ts, or the framework default (vite 5173, vite preview 4173, next 3000,",
    'nest 3000, astro 4321, remix 3000, nuxt 3000).',
    '',
    'When a command would serve on a reserved port, the "Port held" pane opens and Claude waits:',
    `  1  Run on port N          runs the command moved to the first free port from ${firstFreePort} up`,
    '                            (--port N, or PORT=N where the tool reads PORT)',
    '  2  Cancel command         refuses it; Claude is told the port is yours and is given the free one',
    '  3  Run on <port> anyway   runs the command as Claude wrote it',
    'Run on port N holds the focus, so Enter presses it. Tab and the arrows walk the buttons, Esc hands',
    'the keys back to the prompt, and ctrl+x tab returns to the buttons.',
    'On a narrow terminal the hold is drawn in the band above the prompt: click it or press ctrl+x tab first.',
    'Closing the pane counts as Cancel command, and a hold is cancelled after 10 minutes without an answer.',
    '',
    'A desktop preview (preview_start) of a .claude/launch.json configuration on a reserved port is held the',
    'same way; its first button edits launch.json to the free port.',
    '',
    '/ports lists the reserved ports and where each comes from.',
  ].join('\n')
}

// ---- Rows -------------------------------------------------------------------

/** The width a pane body is assumed to have when rows are asked for, before the surface has measured. */
export const ASSUMED_COLUMNS = 66
export const LABEL_WIDTH = 11

/** How many rows a text takes once wrapped at `columns`. */
export function wrappedRows(text: string, columns: number): number {
  const width = Math.max(1, columns)
  return text.split('\n').reduce((total, line) => total + Math.max(1, Math.ceil(line.length / width)), 0)
}

export type HoldRowsInput = {
  port: number
  shownCommand: string
  portDetail: string
  sources: readonly string[]
  freeNote: string | null
  moveSummary: string
  moveNote: string | null
  moveLabel: string
}

/** The body rows a hold needs at `columns`, wrapped rows counted, for `$.ui.open`'s `rows`. */
export function paneRows(hold: HoldRowsInput, columns = ASSUMED_COLUMNS): number {
  const labelled = (value: string): number => wrappedRows(' '.repeat(LABEL_WIDTH) + value, columns)
  const buttonsWidth = holdButtons(hold.moveLabel, hold.port).reduce((total, button) => total + button.label.length + 5, 0)
  const wouldLine = `${'Would'.padEnd(LABEL_WIDTH)}start a server on port ${hold.port}, which you keep for your own testing`
  return (
    1 + // Held  server on port N
    wrappedRows(wouldLine, columns) +
    1 + // margin above the buttons
    Math.ceil(buttonsWidth / Math.max(1, columns)) +
    wrappedRows(BAND_HINT, columns) +
    1 + // margin above the details
    labelled(hold.shownCommand) +
    labelled(hold.portDetail) +
    hold.sources.reduce((total, source) => total + labelled(source), 0) +
    1 + // Free port
    (hold.freeNote === null ? 0 : wrappedRows(hold.freeNote, columns)) +
    labelled(hold.moveSummary) +
    (hold.moveNote === null ? 0 : wrappedRows(hold.moveNote, columns))
  )
}
