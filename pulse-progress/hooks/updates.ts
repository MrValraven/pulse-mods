// pulse-progress update check for the pulse mods: pure functions, with every read and fetch handed in.
//
// No runtime import from 'claude-code': the tests call `checkForUpdates` with their own reader and fetcher,
// so no test ever reaches the network or the person's files.

export const MARKETPLACE = 'pulse-mods'
export const LATEST_URL = 'https://raw.githubusercontent.com/MrValraven/pulse-mods/main/.claude-plugin/marketplace.json'
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

/** Numeric semver compare: -1 when `left` is older, 1 when newer, 0 when equal. Missing parts count as 0. */
export function compareVersions(left: string, right: string): -1 | 0 | 1 {
  const partsOf = (version: string): number[] =>
    version
      .trim()
      .replace(/^v/i, '')
      .split(/[-+]/)[0]!
      .split('.')
      .map(part => {
        const parsed = Number.parseInt(part, 10)
        return Number.isFinite(parsed) ? parsed : 0
      })
  const leftParts = partsOf(left)
  const rightParts = partsOf(right)
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return difference < 0 ? -1 : 1
  }
  return 0
}

export type VersionMap = Record<string, string>

const messageOf = (cause: unknown): string => {
  const text = cause instanceof Error ? cause.message : String(cause)
  return text.split('\n')[0] || 'no message given'
}

/** The pulse mods in installed_plugins.json, name to version. Throws naming the path when the text is not that file's JSON. */
export function parseInstalled(text: string, path: string): VersionMap {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    throw new Error(`${path} is not valid JSON: ${messageOf(cause)}`)
  }
  const plugins = (parsed as { plugins?: unknown } | null)?.plugins
  if (!plugins || typeof plugins !== 'object') throw new Error(`${path} has no "plugins" object`)
  const versions: VersionMap = {}
  for (const [key, entries] of Object.entries(plugins as Record<string, unknown>)) {
    if (!key.endsWith(`@${MARKETPLACE}`)) continue
    const first = Array.isArray(entries) ? (entries[0] as { version?: unknown } | undefined) : undefined
    if (typeof first?.version === 'string') versions[key.slice(0, -`@${MARKETPLACE}`.length)] = first.version
  }
  return versions
}

/** The mods a marketplace.json lists, name to version. Throws naming `where` when the text is not a marketplace. */
export function parseMarketplace(text: string, where: string): VersionMap {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    throw new Error(`${where} is not valid JSON: ${messageOf(cause)}`)
  }
  const plugins = (parsed as { plugins?: unknown } | null)?.plugins
  if (!Array.isArray(plugins)) throw new Error(`${where} has no "plugins" list`)
  const versions: VersionMap = {}
  for (const plugin of plugins as { name?: unknown; version?: unknown }[]) {
    if (typeof plugin?.name === 'string' && typeof plugin.version === 'string') versions[plugin.name] = plugin.version
  }
  return versions
}

/** The folder of a pulse-mods marketplace added from a local clone, or null when it comes from GitHub or is not known. */
export function localCloneOf(knownMarketplacesText: string): string | null {
  const parsed = JSON.parse(knownMarketplacesText) as Record<string, { source?: { source?: string; path?: string }; installLocation?: string }>
  const entry = parsed?.[MARKETPLACE]
  if (!entry || entry.source?.source !== 'directory') return null
  return entry.installLocation || entry.source.path || null
}

export type UpdateIo = {
  /** The home folder, from $.env. */
  home: string
  /** Reads a file's text; rejects when it is missing or unreadable. */
  readText: (path: string) => Promise<string>
  /** GETs a URL; rejects when the network is unreachable. */
  fetchText: (url: string) => Promise<{ status: number; ok: boolean; text: string }>
}

export type ModRow = { name: string; installed: string | null; latest: string | null; isBehind: boolean }

export type UpdateReport = {
  rows: ModRow[]
  /** Set when the marketplace was added from a local folder. */
  clonePath: string | null
  /** The clone's mods older than GitHub's, as "name 0.4.0, GitHub 0.5.0". Empty when the clone is current or absent. */
  cloneBehind: string[]
  /** Why the clone could not be compared, naming the path; null when it was compared or there is none. */
  cloneNote: string | null
}

// `isAnswered` is true once GitHub answered (an HTTP status, or a body that is not a marketplace):
// the check completed, so the daily stamp holds. A rejected fetch or an unreadable file leaves it unset.
export type UpdateResult = { isOk: true; report: UpdateReport } | { isOk: false; cause: string; isAnswered: boolean }

// A fetch rejection that means the host could not connect; any other (a web-fetch policy, a traffic switch) keeps its own words.
const CONNECTION_ERROR = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|getaddrinfo|socket hang up|network is unreachable|connection (refused|reset|timed out)/i

/** The headline for a rejected fetch: "No network" for a connection error, the fetch's own message otherwise. */
export const fetchFailureText = (url: string, message: string): string =>
  CONNECTION_ERROR.test(message) ? `No network: could not fetch ${url}: ${message}` : `Could not fetch ${url}: ${message}`

/** Reads what is installed, fetches what GitHub lists, and compares. Every failure names its cause. */
export async function checkForUpdates(io: UpdateIo): Promise<UpdateResult> {
  const pluginsFolder = `${io.home.replace(/\/$/, '')}/.claude/plugins`
  const installedPath = `${pluginsFolder}/installed_plugins.json`
  let installed: VersionMap
  try {
    installed = parseInstalled(await io.readText(installedPath), installedPath)
  } catch (cause) {
    const message = messageOf(cause)
    return { isOk: false, isAnswered: false, cause: message.startsWith(installedPath) ? message : `Could not read ${installedPath}: ${message}` }
  }

  let response: { status: number; ok: boolean; text: string }
  try {
    response = await io.fetchText(LATEST_URL)
  } catch (cause) {
    return { isOk: false, isAnswered: false, cause: fetchFailureText(LATEST_URL, messageOf(cause)) }
  }
  if (!response.ok) return { isOk: false, isAnswered: true, cause: `GitHub answered HTTP ${response.status} for ${LATEST_URL}` }
  let latest: VersionMap
  try {
    latest = parseMarketplace(response.text, `The marketplace.json on GitHub (${LATEST_URL})`)
  } catch (cause) {
    return { isOk: false, isAnswered: true, cause: messageOf(cause) }
  }

  let clonePath: string | null = null
  let cloneBehind: string[] = []
  let cloneNote: string | null = null
  const knownPath = `${pluginsFolder}/known_marketplaces.json`
  try {
    clonePath = localCloneOf(await io.readText(knownPath))
  } catch (cause) {
    cloneNote = `Could not read ${knownPath}, so the local clone was left unchecked: ${messageOf(cause)}`
  }
  if (clonePath) {
    const cloneFile = `${clonePath.replace(/\/$/, '')}/.claude-plugin/marketplace.json`
    try {
      const clone = parseMarketplace(await io.readText(cloneFile), cloneFile)
      cloneBehind = Object.entries(latest)
        .filter(([name, version]) => clone[name] === undefined || compareVersions(clone[name]!, version) < 0)
        .map(([name, version]) => `${name} ${clone[name] ?? 'missing'}, GitHub ${version}`)
    } catch (cause) {
      const message = messageOf(cause)
      cloneNote = message.startsWith(cloneFile) ? message : `Could not read ${cloneFile}: ${message}`
    }
  }

  const names = [...new Set([...Object.keys(latest), ...Object.keys(installed)])].sort()
  const rows = names.map((name): ModRow => {
    const installedVersion = installed[name] ?? null
    const latestVersion = latest[name] ?? null
    return {
      name,
      installed: installedVersion,
      latest: latestVersion,
      isBehind: installedVersion !== null && latestVersion !== null && compareVersions(installedVersion, latestVersion) < 0,
    }
  })
  return { isOk: true, report: { rows, clonePath, cloneBehind, cloneNote } }
}

/** The /pulse mods reply: plain text lines, read in a terminal and in the desktop app alike. */
export function formatReport(report: UpdateReport): string {
  const nameWidth = Math.max(...report.rows.map(row => row.name.length), 4)
  const installedWidth = Math.max(...report.rows.map(row => (row.installed ? `installed ${row.installed}` : 'not installed').length), 13)
  const lines = ['Pulse mods, installed and on GitHub:']
  for (const row of report.rows) {
    const installed = row.installed ? `installed ${row.installed}` : 'not installed'
    const latest = row.latest ? `latest ${row.latest}` : 'missing from GitHub'
    const mark = row.isBehind ? '  newer on GitHub' : ''
    lines.push(`${row.name.padEnd(nameWidth)}  ${installed.padEnd(installedWidth)}  ${latest}${mark}`.trimEnd())
  }
  if (report.cloneNote) lines.push('', report.cloneNote)
  const behind = report.rows.filter(row => row.isBehind)
  if (report.cloneBehind.length && report.clonePath) {
    lines.push(
      '',
      `The clone at ${report.clonePath} is behind GitHub (${report.cloneBehind.join('; ')}). Pull it first: Claude Code installs from that folder.`,
    )
  }
  if (!behind.length && !report.cloneBehind.length) {
    lines.push('', 'Every installed pulse mod matches GitHub.')
    return lines.join('\n')
  }
  const installedNames = report.rows.filter(row => row.installed).map(row => row.name)
  const refresh = report.clonePath
    ? `git -C ${report.clonePath} pull --ff-only origin main && claude plugin marketplace update ${MARKETPLACE}`
    : `claude plugin marketplace update ${MARKETPLACE}`
  lines.push(
    '',
    'To update:',
    `1. ${refresh}`,
    `2. for mod in ${installedNames.join(' ')}; do claude plugin update "$mod@${MARKETPLACE}"; done`,
    '3. start a new session; /reload-plugins keeps the old version',
  )
  return lines.join('\n')
}

/** The quiet session-start toast, or null when every installed mod matches GitHub. */
export function toastFor(report: UpdateReport): string | null {
  const behind = report.rows.filter(row => row.isBehind)
  if (!behind.length) return null
  if (behind.length === 1) {
    const [row] = behind
    return `${row!.name} ${row!.latest} is on GitHub, you run ${row!.installed}. /pulse mods shows the update steps`
  }
  const list = behind.map(row => `${row.name} ${row.latest}`).join(', ')
  return `${behind.length} pulse mods have newer versions on GitHub (${list}). /pulse mods shows the update steps`
}

/** True when the last check is older than a day, or there was none. */
export const isCheckDue = (lastCheckedAt: unknown, now: number): boolean =>
  typeof lastCheckedAt !== 'number' || now - lastCheckedAt >= CHECK_INTERVAL_MS
