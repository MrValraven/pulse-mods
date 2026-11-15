// pulse-ports: holds a command that would start a dev server on a port the
// person keeps for their own testing, and offers a free port instead.
//
// tool.call (Bash): read the command, find the port it would serve on, and
// when that port is reserved open the "Port held" pane and wait for a button.
// tool.call (desktop preview_start): the same for a .claude/launch.json
// configuration, where the move edits launch.json.
// ui.render (Pane): draws the hold. If the surface won't place the pane (a
// narrow terminal), the same hold is drawn in the AbovePrompt band instead.
//
// Holding: a hook has 10 s of its own time, but time spent inside a `$` call
// is free, so the hold waits on a short `$.process.run(["sleep", ...])` until
// a button's onPress sets the decision.
//
// The host reads `on(...)` and `$.noun.method(...)` from source, so they are
// spelled literally, and helpers that take `$` are top-level functions.
import type { BoxProps, ButtonProps, ElementConstructor, EngineInterface, PluginOptions, Register, RenderElement, TextProps } from 'claude-code'

import {
  collectReservations,
  denyMessage,
  detectServerStart,
  findLaunchConfiguration,
  parseLaunchJson,
  parseNestMainPort,
  parsePackageScripts,
  parsePortList,
  parseViteConfigPort,
  planRewrite,
  replaceLaunchConfiguration,
  resolveCommand,
  rewriteLaunchConfiguration,
  shortCommand,
  toPort,
  TOOLS,
} from './ports'
import type { DenyReason, Project, Reservation, ServerStart } from './ports'
import {
  announceBandText,
  BAND_HINT,
  cancelToastText,
  heldLine,
  helpText,
  holdButtons,
  LABEL_WIDTH,
  movedToastText,
  PANE_HINT,
  paneRows,
  settingsLines,
  timeoutToastText,
  unknownArgumentText,
} from './hold-copy'

const PANE_ID = 'pulse-ports'
const PANE_TITLE = 'Port held'
const POLL_SECONDS = '0.25'
const HOLD_LIMIT_MS = 10 * 60 * 1000
const FREE_PORT_SPAN = 500
const PARENT_LIMIT = 40
const DEFAULT_RESERVED = '3000'
const DEFAULT_FIRST_FREE = 4100
const VITE_CONFIG_NAMES = ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs', 'vite.config.cts', 'vite.config.cjs']
const LAUNCH_JSON = '.claude/launch.json'
// The desktop app's preview tool, as the CLI names it (local and remote-device sessions).
const PREVIEW_TOOL = /^mcp__.*Claude_(?:Browser|Preview)__preview_start$/

// Pulse colours, the values pulse-cache-tax and pulse-progress use.
const CORAL = '#e8775a'
const JADE = '#4a8c6f'
const LILAC = '#8a72cf'

type Settings = {
  reservedPorts: number[]
  reservedPortsText: string
  ignoredEntries: string[]
  isPackageJsonChecked: boolean
  firstFreePort: number
}

type Decision = 'move' | 'anyway' | DenyReason

type Hold = {
  /** How Claude's refusal names it: `this command`, `the preview "web"`. */
  subject: string
  shownCommand: string
  port: number
  portDetail: string
  sources: string[]
  freePort: number
  freeNote: string | null
  moveLabel: string
  moveSummary: string
  moveNote: string | null
  hint: string
  decision: Decision | null
  errorText: string | null
  where: 'pane' | 'band'
}

// The call being held, or null. One at a time: Bash calls in a turn run in order.
let held: Hold | null = null

type Elements = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
}

export const register: Register = (on, options) => {
  const settings = readSettings(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ports',
      description: 'List the ports pulse-ports keeps free for your own testing and where each comes from',
      argumentHint: '[help]',
    })
    return next(e)
  })

  on('command.run', { command: 'ports' }, async ($, e) => {
    const argument = e.args.trim().toLowerCase()
    if (argument === 'help') {
      return { text: helpText(settings.firstFreePort) }
    }
    if (argument !== '') {
      return { text: unknownArgumentText(argument) }
    }
    return { text: await portsReport($, settings) }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = String(e.command ?? '')
    const start = detectServerStart(command)
    if (start === null) {
      return next(e)
    }
    let prepared: { hold: Hold; rewritten: string } | null
    try {
      prepared = await prepareBashHold($, settings, start)
    } catch {
      return next(e) // the port could not be worked out, so there is nothing to hold it on
    }
    if (prepared === null) {
      return next(e)
    }
    const { hold, rewritten } = prepared
    await holdForAnswer($, next.signal, hold)
    if (hold.decision === 'move') {
      const result = await next({ ...e, command: rewritten })
      const toast = movedToastText(result, shortCommand(command), hold.freePort)
      if (toast !== null) {
        $.ui.toast(toast)
      }
      return result
    }
    if (hold.decision === 'anyway') {
      return next(e)
    }
    return refuse($, hold)
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: holdFailureMessage('this command', next.error.kind, next.error.message) },
  )

  on('tool.call', { tool: PREVIEW_TOOL }, async ($, e, next) => {
    const name = (e as { name?: unknown }).name
    if (typeof name !== 'string' || name === '') {
      return next(e)
    }
    let prepared: { hold: Hold; launchPath: string; launchText: string } | null
    try {
      prepared = await preparePreviewHold($, settings, name)
    } catch {
      return next(e)
    }
    if (prepared === null) {
      return next(e)
    }
    const { hold, launchPath, launchText } = prepared
    await holdForAnswer($, next.signal, hold)
    if (hold.decision === 'move') {
      try {
        await $.fs.write(launchPath, launchText)
      } catch (error) {
        return {
          deny: `pulse-ports could not write ${launchPath} (${errorMessage(error)}), so the preview "${name}" did not start. Set its port to ${hold.freePort} by hand, or start it on another port.`,
        }
      }
      const result = await next(e)
      const toast = movedToastText(result, `preview ${name}`, hold.freePort, LAUNCH_JSON)
      if (toast !== null) {
        $.ui.toast(toast)
      }
      return result
    }
    if (hold.decision === 'anyway') {
      return next(e)
    }
    return refuse($, hold)
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: holdFailureMessage('this preview', next.error.kind, next.error.message) },
  )

  // Closing the pane with its close mark answers as Cancel.
  on('ui.close', { id: PANE_ID }, ($, e, next) => {
    if (held !== null && held.decision === null && e.origin.kind === 'person') {
      held.decision = 'cancel'
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, ($, e, next) => {
    if (held === null) {
      return next(e)
    }
    return drawHold($.ui.resolve(e), held)
  })

  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    if (held === null || held.where !== 'band') {
      return next(e)
    }
    return drawHold($.ui.resolve(e), held)
  })
}

// ---- Settings ---------------------------------------------------------------

function readSettings(options: PluginOptions): Settings {
  const raw = options.reservedPorts
  const reservedPortsText = typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : DEFAULT_RESERVED
  const { ports, ignored } = parsePortList(reservedPortsText)
  const firstFreePort = toPort(String(options.firstFreePort ?? DEFAULT_FIRST_FREE)) ?? DEFAULT_FIRST_FREE
  return {
    reservedPorts: ports,
    reservedPortsText,
    ignoredEntries: ignored,
    isPackageJsonChecked: options.checkPackageJson !== 'off',
    firstFreePort,
  }
}

// ---- Reading the project ----------------------------------------------------

// Resolves a `cd` target to an absolute folder, or null if it doesn't exist.
// The target reaches bash as an argument, so nothing in it runs.
const CD_SCRIPT = `unset CDPATH; d="$1"; case "$d" in "~") d="$HOME";; "~/"*) d="$HOME/\${d#\\~/}";; esac; cd -- "$d" 2>/dev/null && pwd -P`

async function resolveDir($: EngineInterface, sessionCwd: string, dir: string): Promise<string | null> {
  const run = await $.process.run(['bash', '-c', CD_SCRIPT, 'pulse-ports', dir], { cwd: sessionCwd, timeoutMs: 5000 })
  const out = run.stdout.trim()
  return run.exitCode === 0 && out !== '' ? out : null
}

function parentOf(dir: string): string | null {
  if (dir === '/' || dir === '') {
    return null
  }
  const parent = dir.replace(/\/+$/, '').replace(/\/[^/]*$/, '')
  return parent === '' ? '/' : parent
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`
}

async function readText($: EngineInterface, path: string): Promise<string> {
  return String(await $.fs.read(path))
}

/** The nearest package.json from `dir` upward, with its scripts, a literal vite server.port and Nest's main.ts port. */
async function loadProject($: EngineInterface, dir: string): Promise<Project | null> {
  let folder: string | null = dir
  for (let level = 0; folder !== null && level < PARENT_LIMIT; level += 1) {
    const packageJsonPath = joinPath(folder, 'package.json')
    if (await $.fs.exists(packageJsonPath)) {
      const scripts = parsePackageScripts(await readText($, packageJsonPath)) ?? {}
      let viteConfig: Project['viteConfig'] = null
      for (const fileName of VITE_CONFIG_NAMES) {
        const path = joinPath(folder, fileName)
        if (await $.fs.exists(path)) {
          const port = parseViteConfigPort(await readText($, path))
          viteConfig = port === null ? null : { fileName, port }
          break
        }
      }
      let nestMain: Project['nestMain'] = null
      const mainPath = joinPath(folder, 'src/main.ts')
      if (Object.values(scripts).some((body) => /\bnest\s+start\b/.test(body)) && (await $.fs.exists(mainPath))) {
        nestMain = parseNestMainPort(await readText($, mainPath), 'src/main.ts')
      }
      return { packageJsonPath, scripts, viteConfig, nestMain }
    }
    folder = parentOf(folder)
  }
  return null
}

// ---- Finding a free port ----------------------------------------------------

/** True when something listens on the port, false when nothing does, or why lsof could not answer. */
async function hasListener($: EngineInterface, port: number): Promise<boolean | { errorText: string }> {
  const errors: string[] = []
  for (const lsof of ['lsof', '/usr/sbin/lsof']) {
    try {
      const run = await $.process.run([lsof, '-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { timeoutMs: 5000 })
      return run.exitCode === 0 && run.stdout.trim() !== ''
    } catch (error) {
      // this spelling of lsof could not start or did not finish in 5 s; try the next
      errors.push(`${lsof}: ${errorMessage(error)}`)
    }
  }
  return { errorText: errors.join('; ') }
}

async function findFreePort($: EngineInterface, first: number, reservations: readonly Reservation[]): Promise<{ port: number; note: string | null }> {
  const reserved = new Set(reservations.map((reservation) => reservation.port))
  let firstUnreserved: number | null = null
  const last = Math.min(65535, first + FREE_PORT_SPAN - 1)
  for (let port = first; port <= last; port += 1) {
    if (reserved.has(port)) {
      continue
    }
    firstUnreserved ??= port
    const isListening = await hasListener($, port)
    if (typeof isListening === 'object') {
      return { port, note: `lsof could not check port ${port} (${isListening.errorText}), so it was picked without checking for a listener.` }
    }
    if (!isListening) {
      return { port, note: null }
    }
  }
  const fallback = firstUnreserved ?? first
  return { port: fallback, note: `Every unreserved port from ${first} to ${last} has a listener, so ${fallback} may be taken too.` }
}

// ---- Preparing a hold -------------------------------------------------------

async function prepareBashHold($: EngineInterface, settings: Settings, start: ServerStart): Promise<{ hold: Hold; rewritten: string } | null> {
  const sessionCwd = await $.session.cwd()
  const cwd = start.analysis.dir === null ? sessionCwd : await resolveDir($, sessionCwd, start.analysis.dir)
  const project = cwd === null ? null : await loadProject($, cwd)
  const effective = resolveCommand(start.analysis, project)
  if (effective === null) {
    return null
  }
  const reservations = collectReservations(settings.reservedPorts, settings.isPackageJsonChecked ? project : null)
  const reservation = reservations.find((candidate) => candidate.port === effective.port)
  if (reservation === undefined) {
    return null
  }
  const free = await findFreePort($, settings.firstFreePort, reservations)
  const plan = planRewrite(start, effective, free.port)
  const command = start.pieces.join('')
  const hold: Hold = {
    subject: 'this command',
    shownCommand: command,
    port: effective.port,
    portDetail: `${effective.detail}${effective.tool === 'generic' ? '' : `, ${TOOLS[effective.tool].label}`}`,
    sources: reservation.sources,
    freePort: free.port,
    freeNote: free.note,
    moveLabel: `Run on port ${free.port}`,
    moveSummary: plan.command,
    moveNote: plan.note,
    hint: plan.hint,
    decision: null,
    errorText: null,
    where: 'pane',
  }
  return { hold, rewritten: plan.command }
}

async function preparePreviewHold($: EngineInterface, settings: Settings, name: string): Promise<{ hold: Hold; launchPath: string; launchText: string } | null> {
  const sessionCwd = await $.session.cwd()
  const launchPath = joinPath(sessionCwd, LAUNCH_JSON)
  if (!(await $.fs.exists(launchPath))) {
    return null
  }
  const document = parseLaunchJson(await readText($, launchPath))
  const configuration = document === null ? null : findLaunchConfiguration(document, name)
  if (document === null || configuration === null) {
    return null
  }
  const port = toPort(String(configuration.port ?? ''))
  if (port === null) {
    return null
  }
  const configurationCwd = typeof configuration.cwd === 'string' && configuration.cwd !== '' ? await resolveDir($, sessionCwd, configuration.cwd) : sessionCwd
  const project = await loadProject($, configurationCwd ?? sessionCwd)
  const reservations = collectReservations(settings.reservedPorts, settings.isPackageJsonChecked ? project : null)
  const reservation = reservations.find((candidate) => candidate.port === port)
  if (reservation === undefined) {
    return null
  }
  const free = await findFreePort($, settings.firstFreePort, reservations)
  const moved = rewriteLaunchConfiguration(configuration, port, free.port, project)
  const hold: Hold = {
    subject: `the preview "${name}"`,
    shownCommand: `preview "${name}" from ${LAUNCH_JSON}`,
    port,
    portDetail: `"port": ${port} in ${LAUNCH_JSON}`,
    sources: reservation.sources,
    freePort: free.port,
    freeNote: free.note,
    moveLabel: `Edit launch.json to port ${free.port}`,
    moveSummary: moved.summary,
    moveNote: moved.note,
    hint: `${LAUNCH_JSON} set to ${moved.summary}`,
    decision: null,
    errorText: null,
    where: 'pane',
  }
  return { hold, launchPath, launchText: replaceLaunchConfiguration(document, name, moved.configuration) }
}

// ---- Holding ----------------------------------------------------------------

function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return (text.split('\n')[0] ?? '').slice(0, 200) || 'an error with no message'
}

/** Claude's refusal when the hook itself failed during a hold, naming how it failed. */
function holdFailureMessage(subject: string, kind: 'throw' | 'timeout', message: string | undefined): string {
  return `pulse-ports could not finish checking ${subject} (${kind}: ${message ?? 'no message'}), so it did not run. Start it on a port the user has not reserved, and check /ports for the reserved ones.`
}

/** The band cannot take the keys by itself: say how to reach the buttons. */
async function announceBand($: EngineInterface, hold: Hold): Promise<void> {
  const text = announceBandText(hold.shownCommand, hold.port, hold.moveLabel)
  $.ui.toast(text, { timeoutMs: 15000 })
  try {
    await $.ui.notify(text, { title: 'pulse-ports' })
  } catch (error) {
    $.ui.log(`pulse-ports could not send a notification about the held command: ${errorMessage(error)}`)
  }
}

async function holdForAnswer($: EngineInterface, signal: AbortSignal, hold: Hold): Promise<void> {
  // One hold at a time. `held` is claimed with no await between the check and
  // the claim, so two waiting calls can't both get through.
  while (held !== null) {
    if (signal.aborted) {
      hold.decision = 'interrupted'
      return
    }
    await $.process.run(['sleep', POLL_SECONDS], { timeoutMs: 5000 })
  }
  held = hold
  try {
    const opened = await $.ui.open({ id: PANE_ID, title: PANE_TITLE, focus: true, rows: paneRows(hold) })
    const isPlaced = opened.isPlaced
    if (!isPlaced) {
      hold.where = 'band'
    }
    $.ui.invalidate('ui.render')
    if (!isPlaced) {
      await announceBand($, hold)
    }
    const startedAt = await $.clock.now()
    while (hold.decision === null) {
      if (signal.aborted) {
        hold.decision = 'interrupted'
        break
      }
      if ((await $.clock.now()) - startedAt > HOLD_LIMIT_MS) {
        hold.decision = 'timeout'
        break
      }
      await $.process.run(['sleep', POLL_SECONDS], { timeoutMs: 5000 })
    }
  } catch (error) {
    if (hold.decision === null) {
      hold.decision = 'error'
      hold.errorText = errorMessage(error)
    }
  } finally {
    // Close this call's pane before releasing the hold, so the next call's pane
    // can't be the one that gets closed. An unplaced pane is open too, and
    // would show up empty later, so it is closed the same way.
    try {
      await $.ui.close({ id: PANE_ID })
    } catch {
      // the pane is already gone
    }
    if (held === hold) {
      held = null
    }
    $.ui.invalidate('ui.render')
  }
}

function refuse($: EngineInterface, hold: Hold): { deny: string } {
  const reason: DenyReason = hold.decision === 'cancel' || hold.decision === 'timeout' || hold.decision === 'interrupted' ? hold.decision : 'error'
  if (reason === 'cancel') {
    $.ui.toast(cancelToastText(hold.shownCommand, hold.port))
  } else if (reason === 'timeout') {
    $.ui.toast(timeoutToastText(hold.shownCommand))
  }
  return { deny: denyMessage(hold.subject, hold.port, hold.freePort, hold.hint, reason, hold.errorText) }
}

// ---- /ports -----------------------------------------------------------------

async function portsReport($: EngineInterface, settings: Settings): Promise<string> {
  const cwd = await $.session.cwd()
  const project = await loadProject($, cwd)
  const reservations = collectReservations(settings.reservedPorts, settings.isPackageJsonChecked ? project : null)
  const lines = [`pulse-ports keeps these ports free in ${cwd}:`]
  if (reservations.length === 0) {
    lines.push('  none: reservedPorts is empty and package.json names no server port')
  }
  for (const reservation of reservations) {
    lines.push(`  ${String(reservation.port).padEnd(6)}${reservation.sources.join('; ')}`)
  }
  if (!settings.isPackageJsonChecked) {
    lines.push('checkPackageJson is off, so package.json ports are not reserved.')
  } else if (project === null) {
    lines.push(`No package.json was found in ${cwd} or the folders above it.`)
  } else {
    lines.push(`package.json: ${project.packageJsonPath}`)
  }
  lines.push('', ...settingsLines(settings))
  if (settings.ignoredEntries.length > 0) {
    lines.push(`Ignored in reservedPorts, as no port from 1 to 65535: ${settings.ignoredEntries.join(', ')}`)
  }
  lines.push('', '/ports help explains holds and keys.')
  return lines.join('\n')
}

// ---- Drawing ----------------------------------------------------------------

function drawHold(elements: Elements, hold: Hold): RenderElement {
  const { Box, Text, Button } = elements
  // The buttons answer the hold this pane was drawn for, captured here as `hold`.
  const decide = (choice: Decision) => () => {
    if (hold.decision === null) {
      hold.decision = choice
    }
  }
  const row = (label: string, value: string, color?: string) =>
    Text({
      mono: true,
      wrap: 'wrap',
      children: [Text({ mono: true, color: LILAC, children: label.padEnd(LABEL_WIDTH) }), Text({ mono: true, bold: color !== undefined, color, children: value })],
    })
  const sourceRows = hold.sources.map((source, index) => row(index === 0 ? 'Reserved by' : '', source))
  const heldText = heldLine(hold.port)
  const decisions: Record<'move' | 'cancel' | 'anyway', Decision> = { move: 'move', cancel: 'cancel', anyway: 'anyway' }
  return Box({
    flexDirection: 'column',
    borderStyle: 'round',
    borderColor: CORAL,
    paddingX: 1,
    children: [
      Text({ mono: true, wrap: 'wrap', children: [Text({ mono: true, bold: true, color: CORAL, children: heldText.word }), Text({ mono: true, bold: true, children: heldText.rest })] }),
      Text({
        mono: true,
        wrap: 'wrap',
        children: [
          Text({ mono: true, color: LILAC, children: 'Would'.padEnd(LABEL_WIDTH) }),
          'start a server on port ',
          Text({ mono: true, bold: true, color: CORAL, children: String(hold.port) }),
          ', which you keep for your own testing',
        ],
      }),
      // The buttons come before the details, so a short pane or band still shows them.
      Box({
        key: 'buttons',
        marginTop: 1,
        gap: 2,
        flexWrap: 'wrap',
        children: holdButtons(hold.moveLabel, hold.port).map((button) =>
          Button({
            key: button.key,
            label: button.label,
            hotkey: button.hotkey,
            plain: true,
            ...(button.isPrimary ? { variant: 'primary' as const, autoFocus: true as const } : {}),
            onPress: decide(decisions[button.key]),
          }),
        ),
      }),
      Text({ mono: true, dimColor: true, wrap: 'wrap', children: hold.where === 'band' ? BAND_HINT : PANE_HINT }),
      Box({
        key: 'details',
        marginTop: 1,
        flexDirection: 'column',
        children: [
          row('Command', hold.shownCommand),
          row('Port from', hold.portDetail),
          ...sourceRows,
          row('Free port', String(hold.freePort), JADE),
          hold.freeNote ? Text({ mono: true, dimColor: true, italic: true, wrap: 'wrap', children: hold.freeNote }) : null,
          row('Runs as', hold.moveSummary, JADE),
          hold.moveNote ? Text({ mono: true, dimColor: true, italic: true, wrap: 'wrap', children: hold.moveNote }) : null,
        ],
      }),
    ],
  })
}
