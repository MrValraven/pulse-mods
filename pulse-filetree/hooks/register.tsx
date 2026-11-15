import { type BuiltinToolResults, type EngineInterface, type Register, type Timer, update } from 'claude-code'
import { LINUX_LAUNCH, openCommand, openWithCommand } from './open'
import type { ButtonProps } from './button'

import type { Activity, FileNode, FileTree, Theme } from '../types'
import { BRANCH_ICON, chainOf, type GitAction, gitActions, readOnly, readTargets, removedTargets, resolve } from './git'
import { type RowSpec, type RowsProps, type Seg, specCost } from './rows'
import {
  backgroundCause,
  bashFailureCause,
  causeOf,
  copyFailure,
  countsLegend,
  exitCause,
  gitUnavailable,
  MIN_COLUMNS,
  isMissingCause,
  pathCheckReply,
  runningChips,
  searchUnavailable,
  SELECTED_SUFFIX,
  startBlockedReason,
  helpText,
  TOAST_PREFIX,
} from './copy'
import {
  type ColumnMode,
  type Ghost,
  GHOST_PREFIX,
  gutterMark,
  homeRelative,
  isListable,
  liveGhosts,
  nextColumn,
  nextGhostEnd,
  outsideOf,
  type OutsideTouch,
  barFor,
  recordOutside,
  type RowKeyAction,
  rowKeyAction,
  type TouchKind,
  touchTone,
  withGhosts,
} from './marks'
import { CHEVRON_CLOSED, CHEVRON_OPEN, fileBadge, fileIcon, folderInk, onInkFor } from './icons'
import { type LucideName, lucideNameFor, lucideSvg } from './lucide'
import { buildPalette, dateLabel, gitInk, inkOnPane, mix, type Palette, RECENT_MS, RECENT_SOFT_MS, recentLevel, truncateMiddle, widthOf } from './look'
import {
  age,
  ancestorsOf,
  type Change,
  DEFAULT_THEME,
  dirname,
  emptyTree,
  formatSize,
  inside,
  isAbsolute,
  join,
  mapper,
  parseGit,
  parseNumstat,
  parseTheme,
  posix,
  relative,
  type Row,
  dropBelow,
  useDrives,
  rollCounts,
  replaceChildren,
  rollUp,
  toNodes,
  underAny,
  visibleRows,
} from './tree'

const TREE = { plugin: 'pulse-filetree', key: 'tree' } as const
const THEME = { plugin: 'pulse-filetree', key: 'theme' } as const
const ACTIVITY = { plugin: 'pulse-filetree', key: 'activity' } as const
const PANE = 'filetree'
const BRANCH_ROW = '#branch'
const FLASH_MS = 2700
const RUNNING_MAX_MS = 600_000
const NO_REPO_DEPTH = 4
const DOUBLE_MS = 450
const FIND_LIMIT = 200
const ROWS_BUDGET = 80_000
const READ_REVEAL_LIMIT = 12
const SEARCH_REVEAL_LIMIT = 60
const ACTIVITY_TTL_MS = 45_000
const THEME_FILE = '.local/state/omarchy/current/theme/colors.toml'
const THEME_POLL_MS = 2000
const FONT_SCRIPT =
  'if command -v fc-list >/dev/null 2>&1; then f=$(fc-list ":charset=$1" file | head -n1 | cut -d: -f1); ' +
  'else f=$(ls "$HOME"/Library/Fonts/*Nerd* /Library/Fonts/*Nerd* 2>/dev/null | head -n1); fi; ' +
  '[ -n "$f" ] || { echo missing; exit 0; }; m=$(stat -c %Z "$f" 2>/dev/null || stat -f %c "$f"); p=$PPID; ' +
  'while [ -n "$p" ] && [ "$p" -gt 1 ]; do c=$(ps -o comm= -p "$p" 2>/dev/null); c=$(basename "$c" 2>/dev/null | tr -d " "); case "$c" in ' +
  'ghostty|kitty|alacritty|Alacritty|foot|footclient|wezterm-gui|konsole|gnome-terminal-|xterm|urxvt|st|Terminal|iTerm2) ' +
  'e=$(ps -o etime= -p "$p" 2>/dev/null | awk -F\'[-:]\' \'{n=NF; s=$n+60*$(n-1); if (n>2) s+=3600*$(n-2); if (n>3) s+=86400*$(n-3); print s}\'); [ -n "$e" ] && [ $(( $(date +%s) - e )) -lt "$m" ] && echo stale || echo ok; exit 0;; esac; ' +
  'p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d " "); done; echo ok'
const PRUNE = ['.git', 'node_modules', 'target', '.venv', '__pycache__', 'dist', '.next']
const HOME_PRUNE = ['Library', 'AppData', '.Trash']
const SIZE_TIMEOUT_MS = 15_000
const SIZE_JOBS = 2
const SIZE_WALK_LIMIT = 50_000
const AGE_TICK_MS = 60_000
const NARROW_COLUMNS = 48
const VERY_NARROW_COLUMNS = 34

let blink: Timer | null = null
let themePoll: Timer | null = null
let ageTick: Timer | null = null
let themeMtime: number | null = null
let generation = 0
let lastPress = { key: '', at: 0 }
let noNerd = false
let glyphSetting = 'auto'
let openWithSetting = ''
let previewed: { path: string; text: string; note: string } | null = null
let previewRows = 20
let follow = true
let followClaude = true
let scanning: Promise<void> | null = null
let scanJobs: Job[] = []
let gitRun: Promise<void> | null = null
let gitNext: Promise<void> | null = null
let queuedReads: QueuedRead[] = []
let showReads = true
let showWrites = true
let searchIndex: { root: string; paths: Promise<string[]> } | null = null
let activityId = 0
let pointer = true
let hovered = ''
let view = { from: 0, max: 0 }
let nativeScroll = false
let lastSync = 0
let noDock = false
let home = ''
let platform: Promise<'linux' | 'darwin' | 'win32'> | null = null
let dirty: { root: string; files: Record<string, Change> } = { root: '', files: {} }
let markId = 0
let listSeq = 0
let lastRoot = ''
let sizeDefault = false
let showAge = false
let showHints = true
let sizeEpoch = 0
let sizeActive = 0
let sizeQueue: string[] = []
const sizing = new Set<string>()
const listLatest = new Map<string, number>()
const unreadable = new Set<string>()
const background = new Map<string, Background>()
// Files Claude touched lately, so a quiet mark stays beside them after the shimmer ends.
const recentTouches = new Map<string, { tone: string; at: number }>()
// Roots whose first listing came back, so an empty tree can say loading or empty.
const listedRoots = new Set<string>()
// One timer redraws the tree when the next recent mark softens or ends.
let recentTimer: Timer | null = null
// The search still running, so an empty tree can say it is searching while it runs.
let pendingQuery = ''
// Counts every write to the tree state, so the visible rows are worked out once per change.
let treeVersion = 0
let rowsMemo: { version: number; ghostKey: string; rows: Row[] } | null = null
// True while the pane is open because the start setting opened it, so a terminal too narrow
// for the sidebar closes it and says why.
let openedByStart = false
// Files Claude read or wrote outside the tree's folder, newest first.
let outsideTouches: OutsideTouch[] = []
// Files Claude deleted, drawn as faded rows for a while; one timer redraws when the next ends.
const ghosts = new Map<string, Ghost>()
let ghostTimer: Timer | null = null

type QueuedRead = { path: string; isSubagent: boolean }

function osName($: EngineInterface): Promise<'linux' | 'darwin' | 'win32'> {
  platform ??= (async () => {
    if ((await $.env.get('OS')) === 'Windows_NT') return 'win32'
    try {
      return (await $.process.run(['uname', '-s'], { timeoutMs: 3_000 })).stdout.trim() === 'Darwin' ? 'darwin' : 'linux'
    } catch {
      return 'linux'
    }
  })()
  return platform
}

async function cwdOf($: EngineInterface): Promise<string> {
  return posix(await $.session.cwd())
}

function clean(segs: Seg[]): Seg[] {
  for (const seg of segs) for (const k of Object.keys(seg) as (keyof Seg)[]) if (seg[k] === undefined) delete seg[k]
  return segs
}

async function get($: EngineInterface): Promise<FileTree> {
  return { ...emptyTree(''), ...(await $.state.get(TREE)).value }
}

async function put($: EngineInterface, fn: (t: FileTree) => FileTree): Promise<void> {
  await update($, TREE, cur => fn({ ...emptyTree(''), ...cur }))
  // Counted after the write lands: a reader that took the version before reading the state
  // never pairs an older state with a newer version.
  treeVersion += 1
}

// The tree's visible rows, deleted files' ghosts included, worked out once per tree change.
// `version` is treeVersion as read before the state was.
function rowsOf(t: FileTree, version: number, ghostList: readonly Ghost[]): Row[] {
  const ghostKey = ghostList.map(ghost => ghost.node.id).join('\n')
  if (rowsMemo && rowsMemo.version === version && rowsMemo.ghostKey === ghostKey) return rowsMemo.rows
  const rows = visibleRows(ghostList.length ? { ...t, nodes: withGhosts(t.nodes, ghostList) } : t)
  rowsMemo = { version, ghostKey, rows }
  return rows
}

function patch($: EngineInterface, fn: (t: FileTree) => Partial<FileTree>) {
  return put($, t => ({ ...t, ...fn(t) }))
}

async function activities($: EngineInterface): Promise<Activity[]> {
  return (await $.state.get(ACTIVITY)).value ?? []
}

async function setActivities($: EngineInterface, fn: (list: Activity[]) => Activity[]): Promise<void> {
  await update($, ACTIVITY, cur => fn(cur ?? []).slice(-6))
}

async function list($: EngineInterface, dir: string): Promise<FileNode[] | null> {
  try {
    const entries = await $.fs.list(dir)
    const resolved = await Promise.all(
      entries.map(async e => {
        if (!e.isLink) return { name: e.name, kind: e.kind, mtimeMs: e.mtimeMs, size: e.size, isLink: false }
        try {
          const target = await $.fs.stat(join(dir, e.name))
          return target.kind === 'dir'
            ? { name: e.name, kind: 'dir' as const, mtimeMs: target.mtimeMs, size: 0, isLink: false }
            : { name: e.name, kind: 'file' as const, mtimeMs: target.mtimeMs, size: target.size, isLink: true }
        } catch {
          return { name: e.name, kind: 'other' as const, mtimeMs: 0, size: 0, isLink: true }
        }
      }),
    )
    unreadable.delete(dir)
    return toNodes(dir, resolved)
  } catch (err) {
    if (!(await exists($, dir))) return []
    if (!unreadable.has(dir)) {
      unreadable.add(dir)
      $.ui.toast(`${TOAST_PREFIX}could not list ${shortPath(dir)}: ${err instanceof Error ? err.message : String(err)}`)
    }
    return null
  }
}

async function loadDirs($: EngineInterface, dirs: string[]): Promise<Map<string, FileNode[]>> {
  const root = (await get($)).root
  const seq = ++listSeq
  for (const dir of dirs) listLatest.set(dir, seq)
  const results = await Promise.all(dirs.map(async dir => [dir, await list($, dir)] as const))
  const listed = new Map<string, FileNode[]>()
  for (const [dir, kids] of results) {
    if (listLatest.get(dir) !== seq) continue
    listLatest.delete(dir)
    if (kids) listed.set(dir, kids)
  }
  if (listed.has(root)) listedRoots.add(root)
  await patch($, t => (t.root === root ? { nodes: replaceChildren(t.nodes, listed) } : {}))
  return listed
}

async function git($: EngineInterface, cwd: string, args: string[], timeoutMs = 20_000) {
  return $.process.run(['git', '--no-optional-locks', '-C', cwd, ...args], { timeoutMs, env: { GIT_OPTIONAL_LOCKS: '0' } })
}

async function detectRepo($: EngineInterface): Promise<void> {
  const t = await get($)
  if (!t.root) return
  let top = ''
  let prefix = ''
  // Outside a repo git says so and that is no failure; anything else it says is.
  let gitError = ''
  try {
    const run = await git($, t.root, ['rev-parse', '--show-prefix', '--show-toplevel'], 5_000)
    const [p = '', tl = ''] = run.exitCode === 0 ? run.stdout.split('\n') : []
    prefix = p.trim()
    top = tl.trim()
    if (run.exitCode !== 0 && !/not a git repository/i.test(run.stderr)) gitError = `git rev-parse ${exitCause(run)}`
  } catch (err) {
    top = ''
    gitError = `git could not run: ${causeOf(err)}`
  }
  await patch($, cur => (cur.root === t.root ? { top, prefix, gitError } : {}))
}

async function readGit($: EngineInterface): Promise<void> {
  const t = await get($)
  if (!t.root || !t.top) return
  const root = t.root
  const fail = (cause: string) => patch($, cur => (cur.root === root ? { gitError: cause } : {}))
  try {
    const status = await git($, root, ['status', '--porcelain=v1', '-b', '-z', '--ignored=traditional', '--untracked-files=normal', '--', '.'])
    if (status.exitCode !== 0) {
      await fail(`git status ${exitCause(status)}`)
      return
    }
    const parsed = parseGit(status.stdout, root, t.prefix)
    const diff: Record<string, [number, number]> = {}
    const head = await git($, root, ['diff', 'HEAD', '--numstat', '-z', '--', '.'])
    if (head.exitCode === 0) parseNumstat(head.stdout, root, t.prefix, diff)
    const files = { ...parsed.files }
    if (parsed.untrackedDirs.length) {
      const others = await git($, root, ['ls-files', '-o', '--exclude-standard', '-z', '--', ...parsed.untrackedDirs.map(d => d.slice(root.length + 1) || '.')])
      if (others.exitCode === 0) for (const rel of others.stdout.split('\0').filter(Boolean)) files[join(root, rel)] = 'new'
    }
    for (const path of Object.keys(diff)) if (files[path] === 'new' || files[path] === 'add') delete diff[path]
    dirty = { root, files }
    await patch($, cur =>
      cur.root === root
        ? {
            git: parsed.git,
            ignored: parsed.ignored,
            untrackedDirs: parsed.untrackedDirs,
            branch: parsed.branch,
            counts: rollCounts(files, root),
            diff: rollUp(diff, root),
            gitError: '',
          }
        : {},
    )
  } catch (err) {
    await fail(`git status could not run: ${causeOf(err)}`)
  }
}

function refreshGit($: EngineInterface): Promise<void> {
  if (!gitRun) {
    gitRun = readGit($).finally(() => {
      gitRun = null
    })
    return gitRun
  }
  const rerun = () => {
    gitNext = null
    return refreshGit($)
  }
  gitNext ??= gitRun.then(rerun, rerun)
  return gitNext
}

async function reset($: EngineInterface, root: string, focus = false): Promise<void> {
  const prev = await get($)
  generation += 1
  blink?.cancel()
  blink = null
  lastRoot = root
  searchIndex = null
  sizeEpoch += 1
  sizeQueue = []
  recentTouches.clear()
  recentTimer?.cancel()
  recentTimer = null
  ghosts.clear()
  ghostTimer?.cancel()
  ghostTimer = null
  listedRoots.delete(root)
  await put($, () => ({ ...emptyTree(root), showHidden: prev.showHidden, showSize: prev.root ? prev.showSize : sizeDefault }))
  const title = `Files: ${root.split('/').pop() || root}`
  if (focus) {
    openedByStart = false
    await $.ui.open({ id: PANE, title, focus: true })
  } else if (!noDock) await $.ui.open({ id: PANE, title })
  await loadDirs($, [root])
  await detectRepo($)
  await refreshGit($)
}

async function revealPaths($: EngineInterface, paths: string[]): Promise<void> {
  const tried = new Set<string>()
  for (let pass = 0; pass < 32; pass++) {
    const t = await get($)
    const loaded = new Set(t.nodes.filter(n => n.loaded).map(n => n.id))
    if (t.nodes.some(n => n.parent === t.root)) loaded.add(t.root)
    const need = new Set<string>()
    for (const p of paths) {
      for (const dir of [t.root, ...ancestorsOf(p, t.root).reverse()]) {
        if (!loaded.has(dir)) {
          if (!tried.has(dir)) need.add(dir)
          break
        }
      }
    }
    if (need.size === 0) return
    for (const dir of need) tried.add(dir)
    await loadDirs($, [...need])
  }
}

function pruneArgs(root: string, ignored: string[] = []): string[] {
  const names = broad(root) ? [...PRUNE, ...HOME_PRUNE] : PRUNE
  return ['(', ...names.flatMap((name, i) => (i === 0 ? ['-name', name] : ['-o', '-name', name])), ...ignored.flatMap(p => ['-o', '-path', p]), ')', '-prune', '-o']
}

async function newer($: EngineInterface, paths: string[], sinceMs: number): Promise<string[]> {
  const stats = await Promise.all(
    paths.map(async p => {
      try {
        return (await $.fs.stat(p)).mtimeMs > sinceMs ? p : ''
      } catch {
        return ''
      }
    }),
  )
  return stats.filter(Boolean)
}

function broad(root: string): boolean {
  return root === home || root === '/' || /^[A-Za-z]:\/$/.test(root)
}

function rootOfDisk(root: string): boolean {
  return root === '/' || /^[A-Za-z]:\/$/.test(root)
}

async function changedSince($: EngineInterface, root: string, since: Since, depth: number, ignored: string[] = []): Promise<string[]> {
  if (rootOfDisk(root)) return []
  const test = since.mark ? ['-newer', since.mark] : ['-newermt', `@${(since.ms / 1000).toFixed(3)}`]
  try {
    const run = await $.process.run(['find', '-H', root, '-xdev', ...(depth ? ['-maxdepth', String(depth)] : []), ...pruneArgs(root, ignored.filter(p => inside(root, p)).slice(0, 40)), ...test, '-print0'], { timeoutMs: 8_000 })
    return run.stdout.split('\0').filter(p => p && p !== root)
  } catch {
    return []
  }
}

async function changedInRepo($: EngineInterface, root: string, since: Since, before: Record<string, Change>, ignored: string[]): Promise<{ hits: string[]; gone: string[] }> {
  if (since.os !== 'win32') return { hits: await changedSince($, root, since, 0, ignored), gone: [] }
  if (dirty.root !== root) return { hits: [], gone: [] }
  const entries = Object.entries(dirty.files)
  const gone = entries.filter(([p, c]) => c === 'del' && before[p] !== 'del').map(([p]) => p)
  const live = entries.filter(([, c]) => c !== 'del').map(([p]) => p)
  return { hits: await newer($, live.slice(0, 4_000), since.ms), gone }
}

type Since = { ms: number; mark: string; os: 'linux' | 'darwin' | 'win32' }

async function sinceNow($: EngineInterface, writes: boolean): Promise<Since> {
  const ms = await $.clock.now()
  const os = await osName($)
  if (os !== 'darwin' || !writes) return { ms, mark: '', os }
  const mark = `${((await $.env.get('TMPDIR')) || '/tmp').replace(/\/+$/, '')}/filetree-${await $.session.id()}-${++markId}.mark`
  try {
    await $.process.run(['touch', mark], { timeoutMs: 3_000 })
    return { ms, mark, os }
  } catch {
    return { ms, mark: '', os }
  }
}

async function walkSize($: EngineInterface, dir: string): Promise<number> {
  let total = 0
  let seen = 0
  let level = [dir]
  while (level.length) {
    const next: string[] = []
    for (const d of level) {
      let entries
      try {
        entries = await $.fs.list(d)
      } catch {
        continue
      }
      for (const e of entries) {
        if (++seen > SIZE_WALK_LIMIT) return -1
        if (e.kind === 'dir' && !e.isLink) next.push(join(d, e.name))
        else if (e.kind === 'file') total += e.size
      }
    }
    level = next
  }
  return total
}

async function dirSize($: EngineInterface, dir: string): Promise<number> {
  if (rootOfDisk(dir)) return -1
  if ((await osName($)) === 'win32') return walkSize($, dir)
  try {
    const run = await $.process.run(['du', '-skxH', dir], { timeoutMs: SIZE_TIMEOUT_MS })
    const kb = Number(run.stdout.trim().split(/\s/)[0] || NaN)
    return Number.isFinite(kb) ? kb * 1024 : -1
  } catch {
    return -1
  }
}

function pumpSizes($: EngineInterface): void {
  while (sizeActive < SIZE_JOBS && sizeQueue.length) {
    const dir = sizeQueue.shift() ?? ''
    const epoch = sizeEpoch
    sizing.add(dir)
    sizeActive += 1
    void dirSize($, dir)
      .then(async bytes => {
        if (epoch === sizeEpoch) return patch($, cur => (inside(cur.root, dir) ? { dirSizes: { ...cur.dirSizes, [dir]: bytes } } : {}))
        const cur = await get($)
        if (cur.showSize && inside(cur.root, dir) && !(dir in cur.dirSizes) && !sizeQueue.includes(dir)) sizeQueue.push(dir)
      })
      .catch(() => undefined)
      .finally(() => {
        sizing.delete(dir)
        sizeActive -= 1
        pumpSizes($)
      })
  }
}

function wantSizes($: EngineInterface, dirs: string[]): void {
  for (const dir of dirs) if (!sizing.has(dir) && !sizeQueue.includes(dir)) sizeQueue.push(dir)
  pumpSizes($)
}

async function staleSizes($: EngineInterface, paths?: string[]): Promise<void> {
  sizeEpoch += 1
  sizeQueue = []
  await patch($, cur => {
    if (!paths) return { dirSizes: {} }
    const keep: Record<string, number> = {}
    for (const [dir, bytes] of Object.entries(cur.dirSizes)) if (!paths.some(p => inside(dir, p))) keep[dir] = bytes
    return { dirSizes: keep }
  })
}

function openDirs(t: FileTree): string[] {
  const open = new Set(t.expanded)
  return t.nodes.filter(n => n.kind === 'dir' && n.loaded && open.has(n.id)).map(n => n.id)
}

function keepTop(cur: FileTree, expanded: string[]): Partial<FileTree> {
  if (followClaude) return { scroll: null }
  const top = visibleRows(cur)[cur.scroll ?? view.from]?.node.id
  const at = top ? visibleRows({ ...cur, expanded }).findIndex(r => r.node.id === top) : -1
  return at < 0 ? {} : { scroll: at }
}

async function flash($: EngineInterface, tones: Record<string, string>): Promise<void> {
  const unique = Object.keys(tones)
  if (unique.length === 0) return
  const mine = ++generation
  const root = (await get($)).root
  blink?.cancel()
  blink = null
  await patch($, cur => {
    if (cur.root !== root) return {}
    const open = new Set(cur.expanded)
    const bright = new Set([...(cur.flashOn ? cur.flash.filter(id => !unique.includes(id)) : []), ...unique])
    const dim = new Set<string>()
    const all: Record<string, string> = cur.flashOn ? { ...cur.flashTones } : {}
    if (cur.flashOn) {
      for (const id of cur.flashDim) dim.add(id)
    }
    for (const id of unique) {
      const tone = tones[id] ?? 'orange'
      all[id] = tone
      if (id === BRANCH_ROW) continue
      const chain = ancestorsOf(id, cur.root)
      if (!chain.some(a => !open.has(a))) continue
      for (const a of chain) {
        if (!open.has(a)) {
          dim.add(a)
          all[a] = all[a] ?? tone
        }
        open.add(a)
      }
    }
    for (const id of bright) dim.delete(id)
    return {
      flash: [...bright],
      flashDim: [...dim],
      flashOn: true,
      flashTones: all,
      expanded: [...open],
      ...keepTop(cur, [...open]),
    }
  })
  const touchedAt = await $.clock.now()
  for (const id of unique) if (id !== BRANCH_ROW) recentTouches.set(id, { tone: tones[id] ?? 'orange', at: touchedAt })
  scheduleRecent($, touchedAt)
  if (generation !== mine) return
  blink = $.clock.after(FLASH_MS, () => {
    if (generation !== mine) return
    blink = null
    void patch($, cur => (generation === mine ? { flash: [], flashDim: [], flashOn: false, flashTones: {} } : {}))
  })
}

// Sets the one timer for the next moment a recent mark softens or ends, redraws then and
// looks again; marks past their time are dropped on the way.
function scheduleRecent($: EngineInterface, now: number): void {
  recentTimer?.cancel()
  recentTimer = null
  let next = Infinity
  for (const [id, touch] of recentTouches) {
    if (now - touch.at >= RECENT_MS) {
      recentTouches.delete(id)
      continue
    }
    for (const edge of [touch.at + RECENT_SOFT_MS, touch.at + RECENT_MS]) if (edge > now && edge < next) next = edge
  }
  if (next === Infinity) return
  recentTimer = $.clock.after(next - now + 50, () => {
    recentTimer = null
    void $.ui.invalidate('ui.render')
    void $.clock.now().then(later => scheduleRecent($, later))
  })
}

// Sets the one timer for the moment the next ghost row ends; ended ones are dropped on the way.
function scheduleGhosts($: EngineInterface, now: number): void {
  ghostTimer?.cancel()
  ghostTimer = null
  const live = new Set(liveGhosts([...ghosts.values()], now).map(ghost => ghost.node.id))
  for (const id of [...ghosts.keys()]) if (!live.has(id)) ghosts.delete(id)
  const next = nextGhostEnd([...ghosts.values()], now)
  if (next === null) return
  ghostTimer = $.clock.after(next - now + 50, () => {
    ghostTimer = null
    void $.ui.invalidate('ui.render')
    void $.clock.now().then(later => scheduleGhosts($, later))
  })
}

// The ghosts to draw now: still in their time and absent from the tree. A pure filter: a ghost is
// added while its node is still listed (the scan that drops the node runs after), so a present
// path only hides its ghost and never deletes it. A file that truly came back keeps its ghost
// hidden until scheduleGhosts lets it expire, and its real row draws and takes clicks meanwhile.
function shownGhosts(t: FileTree, now: number): Ghost[] {
  if (ghosts.size === 0) return []
  const present = new Set(t.nodes.map(node => node.id))
  return liveGhosts([...ghosts.values()], now).filter(ghost => !present.has(ghost.node.id))
}

// Keeps rows Claude deleted in the tree as ghosts.
async function addGhosts($: EngineInterface, nodes: FileNode[]): Promise<void> {
  if (nodes.length === 0) return
  const at = await $.clock.now()
  for (const node of nodes) ghosts.set(node.id, { node, at })
  scheduleGhosts($, at)
  void $.ui.invalidate('ui.render')
}

// After a command that names paths to delete: the rows whose files are gone stay as ghosts, and
// gone paths outside the folder join the outside list as writes.
async function settleRemoval($: EngineInterface, removal: Removal): Promise<void> {
  if (!showWrites) return
  const gone: FileNode[] = []
  for (const node of removal.nodes) if (!(await exists($, node.id))) gone.push(node)
  await addGhosts($, gone)
  const root = (await get($)).root
  const goneOutside: string[] = []
  for (const path of removal.paths) if (root && !inside(root, path) && !(await exists($, path))) goneOutside.push(path)
  if (goneOutside.length) await noteOutside($, goneOutside, 'write', removal.isSubagent)
}

// Whether a tool call's loop is a subagent or a teammate. tool.call carries an agentId in any loop
// other than the main one, the engine's own forks (compaction, memory) and a workflow's agents
// included; those carry ids `$.agent.list()` never names, so only a listed id counts. Answers are
// kept per id, a listed one for good and an unlisted one for a few seconds, since the list can
// lag a spawn.
const agentLoops = new Map<string, { isSubagent: boolean; at: number }>()
// With `waitMs`, a list slower than that counts as the main loop for this answer; the lookup still
// finishes and its answer is kept for the next call.
async function isSubagentLoop($: EngineInterface, agentId: string | undefined, waitMs?: number): Promise<boolean> {
  if (!agentId) return false
  const lookup = lookUpAgent($, agentId)
  if (waitMs === undefined) return lookup
  return Promise.race([lookup, $.clock.sleep(waitMs).then(() => false)])
}

async function lookUpAgent($: EngineInterface, agentId: string): Promise<boolean> {
  const now = await $.clock.now()
  const known = agentLoops.get(agentId)
  if (known && (known.isSubagent || now - known.at < 5_000)) return known.isSubagent
  let isSubagent = false
  try {
    isSubagent = (await $.agent.list()).some(agent => agent.id === agentId)
  } catch {
    isSubagent = false
  }
  agentLoops.set(agentId, { isSubagent, at: now })
  return isSubagent
}

// A tree update that runs off the tool's path and threw: the cause goes to the debug log, since
// the tool call it followed has already answered.
function logFailure($: EngineInterface, what: string, error: unknown): void {
  $.ui.log(`pulse-filetree: ${what} stopped: ${causeOf(error)}`, { to: 'debug' })
}

// Lists files Claude touched outside the tree's folder.
async function noteOutside($: EngineInterface, paths: string[], kind: TouchKind, isSubagent: boolean): Promise<void> {
  const listable = paths.filter(isListable)
  if (listable.length === 0) return
  const at = await $.clock.now()
  outsideTouches = recordOutside(
    outsideTouches,
    listable.map(path => ({ path, kind, at, isSubagent })),
  )
  void $.ui.invalidate('ui.render')
}

async function followCwd($: EngineInterface): Promise<boolean> {
  if (!follow) return false
  const cwd = await cwdOf($)
  const t = await get($)
  if (t.root === cwd) return false
  await reset($, cwd)
  return true
}

type Pending = { actions: GitAction[]; ids: number[]; command: string; head: string }
type Job = { actions: GitAction[]; since: Since; initRepo: boolean; readOnly: boolean; isSubagent: boolean }
type Removal = { paths: string[]; nodes: FileNode[]; isSubagent: boolean }
type Background = { p: Pending | null; job: Job; reads: QueuedRead[]; removal: Removal | null }
type GitOperation = NonNullable<BuiltinToolResults['Bash']['gitOperation']>
type Outcome = { state: 'done' | 'failed'; label: string; detail: string }

const PROOF: Record<string, (op: GitOperation) => boolean> = {
  push: op => Boolean(op.push),
  merge: op => op.branch?.action === 'merged',
  rebase: op => op.branch?.action === 'rebased',
  'pr create': op => op.pr?.action === 'created',
  'pr merge': op => op.pr?.action === 'merged',
  'pr comment': op => op.pr?.action === 'commented',
}

async function startGit($: EngineInterface, actions: GitAction[], isSubagent: boolean): Promise<number[]> {
  const now = await $.clock.now()
  const ids = actions.map(() => ++activityId)
  await setActivities($, cur => [
    ...cur.filter(a => a.state === 'running' || now - a.at < ACTIVITY_TTL_MS),
    ...actions.map((a, i) => ({
      id: ids[i] ?? 0,
      kind: a.kind,
      label: a.running,
      state: 'running' as const,
      detail: '',
      at: now,
      tone: a.tone,
      nerd: a.icon.nerd,
      plain: a.icon.plain,
      ...(isSubagent ? { isSubagent: true } : {}),
    })),
  ])
  return ids
}

async function headOf($: EngineInterface, cwd: string): Promise<string> {
  try {
    const run = await git($, cwd, ['rev-parse', 'HEAD'], 5_000)
    return run.exitCode === 0 ? run.stdout.trim() : ''
  } catch {
    return ''
  }
}

// `cause` says why the command failed (its exit code and first stderr line); a commit that
// exited cleanly yet left HEAD where it was says that instead.
async function outcomes($: EngineInterface, p: Pending, ok: boolean, op: GitOperation | undefined, cause: string): Promise<Outcome[]> {
  const chain = chainOf(p.command)
  const after = p.actions.some(a => a.verb === 'commit') && !op?.commit ? await headOf($, (await get($)).root || (await cwdOf($))) : ''
  return p.actions.map(a => {
    if (a.verb === 'commit') {
      const sha = op?.commit?.sha || (after && after !== p.head ? after : '')
      return sha ? { state: 'done', label: a.done, detail: sha.slice(0, 7) } : { state: 'failed', label: `${a.verb} failed`, detail: ok ? 'HEAD stayed on the same commit' : cause }
    }
    if ((op && PROOF[a.verb]?.(op)) || (ok && chain.and)) return { state: 'done', label: a.done, detail: '' }
    if (!ok && chain.and && chain.size === 1) return { state: 'failed', label: `${a.verb} failed`, detail: cause }
    return { state: 'done', label: `ran ${a.kind}`, detail: '' }
  })
}

async function finishGit($: EngineInterface, p: Pending, results: Outcome[]): Promise<void> {
  const now = await $.clock.now()
  await setActivities($, cur =>
    cur.map(a => {
      const i = p.ids.indexOf(a.id)
      const result = i < 0 ? undefined : results[i]
      return result ? { ...a, ...result, at: now } : a
    }),
  )
  $.clock.after(ACTIVITY_TTL_MS + 500, () => void setActivities($, cur => cur.filter(a => a.state === 'running' || a.at > now)))
}

function failAll(p: Pending, cause: string): Outcome[] {
  return p.actions.map(a => ({ state: 'failed', label: `${a.verb} failed`, detail: cause }))
}

function proven(p: Pending | null, results: Outcome[]): GitAction[] {
  return p ? p.actions.filter((_, i) => results[i]?.state !== 'failed') : []
}

function taskEnds(text: string): [string, string, string][] {
  return [...text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)].flatMap(m => {
    const id = /<task-id>([^<]*)<\/task-id>/.exec(m[1] ?? '')?.[1]?.trim()
    const status = /<status>([^<]*)<\/status>/.exec(m[1] ?? '')?.[1]?.trim()
    const summary = /<summary>([^<]*)<\/summary>/.exec(m[1] ?? '')?.[1]?.trim() ?? ''
    return id && status ? [[id, status, summary] as [string, string, string]] : []
  })
}

async function settleBackground($: EngineInterface, text: string): Promise<void> {
  if (background.size === 0 || !text.includes('<task-notification>')) return
  for (const [id, status, summary] of taskEnds(text)) {
    const task = background.get(id)
    if (!task) continue
    background.delete(id)
    const ok = status === 'completed'
    const results = task.p ? await outcomes($, task.p, ok, undefined, backgroundCause(status, summary)) : []
    if (task.p) await finishGit($, task.p, results)
    if (task.removal) await settleRemoval($, task.removal)
    if (showReads) queuedReads.push(...task.reads)
    scheduleScan($, { ...task.job, actions: proven(task.p, results) })
  }
}

async function gitPaths($: EngineInterface, root: string, prefix: string, committed: boolean): Promise<string[]> {
  const map = mapper(root, prefix)
  try {
    const run = committed
      ? await git($, root, ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', 'HEAD'], 5_000)
      : await git($, root, ['diff', '--cached', '--name-only', '-z'], 5_000)
    return run.exitCode === 0 ? run.stdout.split('\0').filter(Boolean).flatMap(rel => map(rel) ?? []) : []
  } catch {
    return []
  }
}

async function gitDir($: EngineInterface, cwd: string): Promise<string> {
  for (let dir = cwd, i = 0; i < 64; i++) {
    try {
      const dot = join(dir, '.git')
      const st = await $.fs.stat(dot)
      if (st.kind === 'dir') return dot
      const ref = /^gitdir:\s*(.+)$/m.exec(String(await $.fs.read(dot)))?.[1]?.trim()
      if (ref) return resolve(dir, ref, home)
    } catch {
      const up = dirname(dir)
      if (up === dir) return ''
      dir = up
      continue
    }
    return ''
  }
  return ''
}

async function sync($: EngineInterface, force = false): Promise<void> {
  const now = await $.clock.now()
  if (!force && now - lastSync < 2_000) return
  lastSync = now
  searchIndex = null
  const t = await get($)
  if (!t.root) return
  await loadDirs($, [t.root, ...openDirs(t)])
  if (t.top) await refreshGit($)
}

async function copyPath($: EngineInterface, id: string, absolute: boolean, surface?: string): Promise<void> {
  const t = await get($)
  const text = !absolute && id !== t.root && inside(t.root, id) ? id.slice(t.root.endsWith('/') ? t.root.length : t.root.length + 1) : id
  const done = await $.ui.copy({ text, ...(surface ? { surface: surface as 'terminal' } : {}) })
  $.ui.toast(done.isCopied ? `${TOAST_PREFIX}copied ${text}` : copyFailure(done.reason))
}

async function exists($: EngineInterface, path: string): Promise<boolean> {
  try {
    await $.fs.stat(path)
    return true
  } catch {
    return false
  }
}

async function afterBash($: EngineInterface, jobs: Job[]): Promise<void> {
  const reads = queuedReads
  queuedReads = []
  if (await followCwd($)) return
  const t = await get($)
  if (!t.root) return
  const actions = jobs.flatMap(j => j.actions)
  const writers = jobs.filter(j => !j.readOnly)
  const since = (writers.length ? writers : jobs).reduce((a, j) => (j.since.ms < a.ms ? j.since : a), (writers[0] ?? jobs[0])?.since ?? { ms: 0, mark: '', os: 'linux' as const })
  const writes = !jobs.every(j => j.readOnly)
  // Writes the scan finds cannot be told apart by command, so they take the subagent tone only
  // when every command that may have written ran in a subagent.
  const isSubagentWrite = writers.length > 0 && writers.every(j => j.isSubagent)
  const before = dirty.root === t.root ? dirty.files : {}
  if (jobs.some(j => j.initRepo)) await detectRepo($)
  else if (!t.top && (await exists($, join(t.root, '.git')))) await detectRepo($)
  const probed = await get($)
  if (probed.top && (writes || probed.top !== t.top)) await refreshGit($)
  // Files git newly reports deleted after a command that may write: Claude deleted them, so
  // their rows stay a while as ghosts.
  if (writes && dirty.root === t.root) {
    const deleted = new Set(Object.entries(dirty.files).filter(([path, change]) => change === 'del' && before[path] !== 'del').map(([path]) => path))
    // git reports `git rm --cached` as deleted while the file stays on disk: only a path that is
    // gone becomes a ghost.
    const gone: FileNode[] = []
    for (const node of t.nodes) if (deleted.has(node.id) && !(await exists($, node.id))) gone.push(node)
    if (gone.length) await addGhosts($, gone)
  }
  if (writes) {
    searchIndex = null
    await staleSizes($)
  }
  const fresh = await get($)
  const ignored = new Set(fresh.ignored)
  const tones: Record<string, string> = {}
  if (writes) {
    const found = fresh.top
      ? await changedInRepo($, t.root, since, before, fresh.ignored)
      : { hits: since.os === 'win32' ? [] : await changedSince($, t.root, since, NO_REPO_DEPTH), gone: [] }
    const hits = found.hits.filter(x => inside(t.root, x) && !underAny(x, ignored, t.root)).slice(0, FIND_LIMIT)
    await revealPaths($, hits)
    const loaded = await get($)
    const dirs = [...new Set([loaded.root, ...openDirs(loaded), ...hits.map(dirname), ...found.gone.map(dirname)])].filter(d => inside(loaded.root, d))
    const listed = await loadDirs($, dirs)
    if (!fresh.top && since.os === 'win32')
      for (const kids of listed.values()) for (const n of kids) if (n.mtime > since.ms && hits.length < FIND_LIMIT) hits.push(n.id)
    await patch($, cur => {
      const ids = new Set(cur.nodes.map(n => n.id))
      return { expanded: cur.expanded.filter(id => ids.has(id)) }
    })
    const present = new Set((await get($)).nodes.map(n => n.id))
    const writeTone = actions.find(a => !['commit', 'push', 'add'].includes(a.verb))?.tone ?? touchTone('write', isSubagentWrite)
    if (showWrites) for (const id of hits) if (present.has(id)) tones[id] = writeTone
  }
  if (showReads) {
    const found: QueuedRead[] = []
    const outside: QueuedRead[] = []
    for (const read of reads) {
      if (found.length >= READ_REVEAL_LIMIT) break
      if (read.path === t.root) continue
      if (!inside(t.root, read.path)) {
        if (outside.length < READ_REVEAL_LIMIT && (await exists($, read.path))) outside.push(read)
        continue
      }
      if (!underAny(read.path, ignored, t.root) && (await exists($, read.path))) found.push(read)
    }
    for (const isSubagent of [false, true]) {
      const paths = outside.filter(read => read.isSubagent === isSubagent).map(read => read.path)
      if (paths.length) await noteOutside($, paths, 'read', isSubagent)
    }
    if (found.length) {
      await revealPaths($, found.map(read => read.path))
      const shown = new Set((await get($)).nodes.map(n => n.id))
      for (const read of found) if (shown.has(read.path) && !tones[read.path]) tones[read.path] = touchTone('read', read.isSubagent)
    }
  }
  if (showWrites && actions.length) {
    const final = await get($)
    const committed = actions.some(a => a.verb === 'commit')
    if ((committed || actions.some(a => a.verb === 'add')) && final.top) {
      const paths = (await gitPaths($, final.root, final.prefix, committed)).filter(x => !underAny(x, ignored, final.root)).slice(0, READ_REVEAL_LIMIT)
      await revealPaths($, paths)
      const shown = new Set((await get($)).nodes.map(n => n.id))
      for (const x of paths) if (shown.has(x)) tones[x] = 'green'
    }
    const pushLike = actions.find(a => ['push', 'pull', 'fetch', 'checkout', 'switch', 'branch', 'merge', 'rebase', 'tag'].includes(a.verb) || a.kind.startsWith('gh '))
    if (pushLike) tones[BRANCH_ROW] = pushLike.tone
    else if (committed) tones[BRANCH_ROW] = 'green'
  }
  await flash($, tones)
}

function scheduleScan($: EngineInterface, job: Job): void {
  scanJobs.push(job)
  if (scanning) return
  scanning = (async () => {
    while (scanJobs.length) {
      const jobs = scanJobs
      scanJobs = []
      try {
        await afterBash($, jobs)
      } finally {
        const marks = jobs.map(j => j.since.mark).filter(Boolean)
        if (marks.length) await $.process.run(['rm', '-f', ...marks], { timeoutMs: 3_000 }).catch(() => undefined)
      }
    }
  })().finally(() => {
    scanning = null
  })
}

async function touched($: EngineInterface, paths: string[], kind: TouchKind, show: boolean, isSubagent: boolean): Promise<void> {
  const tone = touchTone(kind, isSubagent)
  if (kind === 'write' && previewed && paths.map(posix).includes(previewed.path)) previewed = null
  if (await followCwd($)) return
  const t = await get($)
  if (!t.root) return
  const outside = paths.map(posix).filter(p => !inside(t.root, p))
  if (outside.length && show) await noteOutside($, outside, kind, isSubagent)
  const within = paths.map(posix).filter(p => inside(t.root, p))
  if (within.length === 0) return
  if (kind === 'write') {
    searchIndex = null
    await staleSizes($, within)
    await revealPaths($, within.map(dirname))
    await loadDirs($, [...new Set(within.map(dirname))].filter(d => inside(t.root, d)))
    await refreshGit($)
  } else await revealPaths($, within)
  if (!show) return
  const tones: Record<string, string> = {}
  for (const p of within) tones[p] = tone
  await flash($, tones)
}

async function reveal($: EngineInterface, paths: string[]): Promise<void> {
  if (await followCwd($)) return
  await revealPaths($, paths)
  await patch($, cur => {
    const open = new Set(cur.expanded)
    for (const p of paths) for (const a of ancestorsOf(p, cur.root)) open.add(a)
    return { expanded: [...open], cursor: paths[paths.length - 1] ?? cur.cursor, scroll: null }
  })
}

async function walk($: EngineInterface, root: string, depth: number, limit: number): Promise<string[]> {
  const out: string[] = []
  let level = [root]
  for (let d = 0; d < depth && level.length && out.length < limit; d++) {
    const next: string[] = []
    for (const dir of level) {
      for (const n of (await list($, dir)) ?? []) {
        if (n.kind === 'dir') {
          if (!PRUNE.includes(n.name)) next.push(n.id)
        } else out.push(n.id)
      }
      if (out.length >= limit) break
    }
    level = next
  }
  return out
}

// Every file search can match, or why the list could not be built. Inside a repo git lists
// tracked and untracked files and leaves out what .gitignore ignores; outside one, find walks six
// levels and skips the pruned folders. find often exits non-zero over one unreadable folder while
// still listing the rest, so only a run that could not start counts as a failure there.
async function listAll($: EngineInterface, t: FileTree): Promise<{ paths: string[] } | { cause: string }> {
  const tool = t.top ? 'git ls-files' : 'find'
  try {
    if (!t.top && (await osName($)) === 'win32') return { paths: await walk($, t.root, rootOfDisk(t.root) ? 3 : 6, 20_000) }
    const run = t.top
      ? await git($, t.root, ['ls-files', '-co', '--exclude-standard', '-z'], 10_000)
      : await $.process.run(['find', '-H', t.root, '-xdev', '-maxdepth', rootOfDisk(t.root) ? '3' : '6', ...pruneArgs(t.root), '-type', 'f', '-print0'], { timeoutMs: 10_000 })
    if (t.top && run.exitCode !== 0) return { cause: `${tool} ${exitCause(run)}` }
    const paths = run.stdout.split('\0').filter(Boolean)
    if (run.isStdoutTruncated) paths.pop()
    return { paths: paths.map(p => (isAbsolute(p) ? p : join(t.root, p))) }
  } catch (err) {
    return { cause: `${tool} could not run: ${causeOf(err)}` }
  }
}

function indexPaths($: EngineInterface, t: FileTree): Promise<string[]> {
  if (searchIndex?.root !== t.root) {
    const index: { root: string; paths: Promise<string[]> } = {
      root: t.root,
      paths: listAll($, t).then(async listed => {
        const searchError = 'cause' in listed ? listed.cause : ''
        // A failed list is dropped, so the next keystroke tries again.
        if (searchError && searchIndex === index) searchIndex = null
        await patch($, cur => (cur.root === t.root && cur.searchError !== searchError ? { searchError } : {}))
        return 'paths' in listed ? listed.paths : []
      }),
    }
    searchIndex = index
  }
  return searchIndex.paths
}

async function search($: EngineInterface, query: string): Promise<string[]> {
  if (!(await get($)).query.trim()) searchIndex = null
  await patch($, () => ({ query }))
  const q = query.trim().toLowerCase()
  if (!q) return []
  pendingQuery = query
  try {
    const t = await get($)
    const hits = (await indexPaths($, t)).filter(p => relative(t.root, p).toLowerCase().includes(q)).slice(0, SEARCH_REVEAL_LIMIT)
    if ((await get($)).query !== query) return []
    await revealPaths($, hits)
    const shown = await get($)
    const ids = new Set(shown.nodes.map(n => n.id))
    const stale = [...new Set(hits.filter(p => !ids.has(p)).map(dirname))].filter(d => inside(shown.root, d))
    if (stale.length) await loadDirs($, stale)
    return hits
  } finally {
    if (pendingQuery === query) {
      pendingQuery = ''
      void $.ui.invalidate('ui.render')
    }
  }
}

async function jump($: EngineInterface, query: string): Promise<void> {
  const hits = (await search($, query)).slice(0, 10)
  await patch($, cur => {
    const open = new Set(cur.expanded)
    for (const p of hits) for (const a of ancestorsOf(p, cur.root)) open.add(a)
    return { query: '', expanded: [...open], cursor: hits[0] ?? cur.cursor, scroll: null }
  })
}

async function fontState($: EngineInterface, charset: string): Promise<'ok' | 'stale' | 'missing'> {
  try {
    const out = (await $.process.run(['sh', '-c', FONT_SCRIPT, 'sh', charset], { timeoutMs: 5_000 })).stdout.trim()
    return out === 'stale' || out === 'missing' ? out : 'ok'
  } catch {
    return 'missing'
  }
}

async function finePointerOk($: EngineInterface): Promise<boolean> {
  if (!(await $.env.get('HERDR_ENV'))) return true
  try {
    const out = (await $.process.run([(await $.env.get('HERDR_BIN_PATH')) || 'herdr', '--version'], { timeoutMs: 3_000 })).stdout
    const [major = 0, minor = 0, fix = 0] = (/(\d+)\.(\d+)\.(\d+)/.exec(out) ?? []).slice(1).map(Number)
    return major * 1e6 + minor * 1e3 + fix >= 9_001
  } catch {
    return false
  }
}

const PREVIEW_CHARS = 90_000
const PREVIEW_LINE = 2_000

function fitSerialized(lines: string[], max: number): string[] {
  let size = 0
  for (let i = 0; i < lines.length; i++) {
    size += JSON.stringify(lines[i]).length
    if (size > max) return lines.slice(0, i)
  }
  return lines
}

async function loadPreview($: EngineInterface, path: string): Promise<void> {
  let text = ''
  let note = ''
  try {
    const stat = await $.fs.stat(path)
    if (stat.size > 4_000_000) note = `${formatSize(stat.size)}, too large to preview`
    else {
      text = await $.fs.read(path)
      if (text.slice(0, 8000).includes('\0')) {
        text = ''
        note = `binary file, ${formatSize(stat.size)}`
      }
    }
  } catch (err) {
    note = `could not read: ${String((err as Error)?.message ?? err).split('\n')[0]}`
  }
  const total = text.length
  let lines = text.slice(0, PREVIEW_CHARS).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').split('\n')
  if (total > PREVIEW_CHARS && lines.length > 1) lines.pop()
  lines = lines.map(l => (l.length > PREVIEW_LINE ? `${l.slice(0, PREVIEW_LINE)}…` : l))
  const fit = fitSerialized(lines, PREVIEW_CHARS)
  if (total > PREVIEW_CHARS || fit.length < lines.length) note = `first ${fit.length.toLocaleString('en')} lines of ${total.toLocaleString('en')} characters`
  previewed = { path, text: fit.join('\n'), note }
}

async function showPreview($: EngineInterface, path: string): Promise<void> {
  await loadPreview($, path)
  await patch($, () => ({ preview: path, previewTop: 0, selected: path }))
}

async function closePreview($: EngineInterface): Promise<void> {
  await patch($, () => ({ preview: '', previewTop: 0 }))
}

async function scrollPreview($: EngineInterface, by: number): Promise<void> {
  const t = await get($)
  const last = Math.max(0, (previewed?.text.split('\n').length ?? 1) - previewRows)
  const top = Math.max(0, Math.min(last, t.previewTop + by))
  if (top !== t.previewTop) await patch($, () => ({ previewTop: top }))
}

function previewLines(text: string, top: number, rows: number, markdown: boolean): { text: string; top: number } {
  const lines = text.split('\n')
  const from = Math.max(0, Math.min(top, lines.length - 1))
  let shown = lines.slice(from, from + rows)
  if (markdown) {
    // Reopen a code fence the window starts inside, so the rest is not read as prose.
    let fence = ''
    let opener = ''
    for (const line of lines.slice(0, from)) {
      const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
      if (!m) continue
      const mark = m[1] ?? ''
      if (!fence) {
        fence = mark
        opener = line.trimStart()
      } else if (mark[0] === fence[0] && mark.length >= fence.length && !(m[2] ?? '').trim()) fence = ''
    }
    if (fence) shown = [opener, ...shown]
  }
  return { text: shown.join('\n'), top: from }
}

async function openFile($: EngineInterface, path: string, external = false): Promise<void> {
  if (!external && openWithSetting.trim() === 'preview') return showPreview($, path)
  const os = await osName($)
  const native = (p: string) => (os === 'win32' ? p.replace(/\//g, '\\') : p)
  const custom = external ? null : openWithCommand(openWithSetting, native(path), native(dirname(path)))
  const { argv, init } = custom ? { argv: os === 'linux' ? ['sh', '-c', LINUX_LAUNCH, 'sh', ...custom] : custom, init: { timeoutMs: 10_000 } } : openCommand(os, path)
  try {
    const run = await $.process.run(argv, init)
    if (run.exitCode !== 0) $.ui.toast(`${TOAST_PREFIX}could not open ${path} with ${custom?.[0] ?? argv[0]}: ${exitCause(run)}`)
  } catch (err) {
    $.ui.toast(`${TOAST_PREFIX}could not open ${path} with ${custom?.[0] ?? argv[0]}: ${causeOf(err)}`)
  }
}

async function quickLook($: EngineInterface, path: string): Promise<void> {
  try {
    await $.process.run(['sh', '-c', '(nohup qlmanage -p "$1" >/dev/null 2>&1 &); sleep 0.4; osascript -e \'tell application "System Events" to set frontmost of first process whose name is "qlmanage" to true\' >/dev/null 2>&1 || true', 'sh', path], { timeoutMs: 10_000 })
  } catch (err) {
    $.ui.toast(`${TOAST_PREFIX}could not preview ${path} with Quick Look: ${causeOf(err)}`)
  }
}

async function toggle($: EngineInterface, n: FileNode): Promise<void> {
  if (n.kind === 'dir' && !(await get($)).expanded.includes(n.id)) await loadDirs($, [n.id])
  await patch($, t => {
    const open = new Set(t.expanded)
    if (n.kind === 'dir') open.has(n.id) ? open.delete(n.id) : open.add(n.id)
    return { expanded: [...open], cursor: n.id, selected: n.kind === 'dir' ? t.selected : n.id }
  })
}

async function press($: EngineInterface, n: FileNode): Promise<void> {
  const now = await $.clock.now()
  const isDouble = lastPress.key === n.id && now - lastPress.at < DOUBLE_MS
  lastPress = { key: isDouble ? '' : n.id, at: now }
  if (!isDouble) {
    await toggle($, n)
    return
  }
  await openNode($, n)
}

async function openNode($: EngineInterface, n: FileNode): Promise<void> {
  if (n.kind === 'dir') {
    follow = false
    await reset($, n.id)
  } else await openFile($, n.id)
}

async function loadTheme($: EngineInterface): Promise<void> {
  const path = `${(await $.env.get('HOME')) ?? ''}/${THEME_FILE}`
  try {
    const stat = await $.fs.stat(path)
    if (stat.kind !== 'file') throw new Error('no theme file')
    if (stat.mtimeMs === themeMtime) return
    await $.state.set(THEME, parseTheme(String(await $.fs.read(path))))
    themeMtime = stat.mtimeMs
  } catch {
    if (themeMtime === 0) return
    await $.state.set(THEME, DEFAULT_THEME)
    themeMtime = 0
  }
}

async function pressHeader($: EngineInterface, id: string): Promise<void> {
  const t = await get($)
  if (id === 'up') {
    follow = false
    await reset($, dirname(t.root))
  } else if (id === 'cwd') {
    follow = true
    await reset($, await cwdOf($))
  } else if (id === 'refresh') {
    searchIndex = null
    await staleSizes($)
    await loadDirs($, [t.root, ...t.expanded])
    await detectRepo($)
    await refreshGit($)
    if (t.query.trim()) await search($, t.query)
  } else if (id === 'hidden') await patch($, cur => ({ showHidden: !cur.showHidden }))
  else if (id === 'size') await patch($, cur => ({ showSize: !cur.showSize }))
  else if (id === 'collapse') await patch($, cur => ({ expanded: [], nodes: dropBelow(cur.nodes, cur.nodes.filter(x => x.parent === cur.root && x.kind === 'dir').map(x => x.id)) }))
  else if (id === 'unselect') await patch($, () => ({ selected: '' }))
  else if (id === 'external' && t.preview) await openFile($, t.preview, true)
}

// `s` in the rows: the right column goes date, age, size and back to date. The age column redraws
// once a minute while it shows.
async function cycleColumn($: EngineInterface): Promise<void> {
  const t = await get($)
  const mode: ColumnMode = t.showSize ? 'size' : showAge ? 'age' : 'date'
  const next = nextColumn(mode)
  if (next !== 'size') showAge = next === 'age'
  if (showAge && !ageTick) ageTick = $.clock.every(AGE_TICK_MS, () => $.ui.invalidate('ui.render'))
  else if (!showAge && ageTick) {
    ageTick.cancel()
    ageTick = null
  }
  await patch($, () => ({ showSize: next === 'size' }))
  void $.ui.invalidate('ui.render')
}

async function runRowKey($: EngineInterface, action: RowKeyAction): Promise<void> {
  if (action === 'dotfiles') await pressHeader($, 'hidden')
  else if (action === 'column') await cycleColumn($)
  else if (action === 'collapse') await pressHeader($, 'collapse')
  else if (action === 'reload') await pressHeader($, 'refresh')
  else if (action === 'up') await pressHeader($, 'up')
  else if (action === 'search') {
    const moved = await $.ui.focus({ requestId: PANE, key: 'q' })
    if (moved.deny) $.ui.toast(`${TOAST_PREFIX}could not move to the search field: ${moved.deny}`)
  }
}

// "Clear list" under the tree: forgets the files touched outside the folder.
function clearOutside($: EngineInterface): void {
  outsideTouches = []
  void $.ui.invalidate('ui.render')
}

function shortPath(path: string): string {
  return home && inside(home, path) ? `~${path.slice(home.length)}` : path
}

export const register: Register = (on, options) => {
  glyphSetting = typeof options?.glyphs === 'string' ? options.glyphs : 'auto'
  const activity = typeof options?.activity === 'string' ? options.activity : 'reads and writes'
  showReads = activity.includes('reads')
  showWrites = activity.includes('writes')
  followClaude = options?.follow !== 'off'
  sizeDefault = options?.column === 'size'
  showAge = options?.column === 'age'
  showHints = options?.hints !== 'off'
  openWithSetting = typeof options?.open === 'string' ? options.open : ''
  noDock = options?.start === 'off'
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'filetree', description: 'Show the file tree; args: [path] (no path = cwd), or help for the keys and settings' })
    const windows = (await $.env.get('OS')) === 'Windows_NT'
    useDrives(windows)
    home = posix(((await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || '').replace(/[\\/]+$/, ''))
    activityId = Math.max(activityId, ...(await activities($)).map(a => a.id))
    void (async () => {
      pointer = await finePointerOk($)
      try {
        const remote = Boolean((await $.env.get('SSH_CONNECTION')) || (await $.env.get('SSH_TTY')))
        noNerd = !remote && (windows || (await fontState($, 'f04eb')) !== 'ok')
      } catch {
        noNerd = true
      }
      await loadTheme($)
      themePoll?.cancel()
      themePoll = themeMtime ? $.clock.every(THEME_POLL_MS, () => void loadTheme($)) : null
      ageTick?.cancel()
      ageTick = showAge ? $.clock.every(AGE_TICK_MS, () => $.ui.invalidate('ui.render')) : null
      const t = await get($)
      if (t.flashOn) await patch($, () => ({ flash: [], flashDim: [], flashOn: false, flashTones: {} }))
      if (t.preview) await patch($, () => ({ preview: '', previewTop: 0 }))
      await setActivities($, cur => cur.map(a => (a.state === 'running' ? { ...a, state: 'failed', label: `${a.kind} interrupted`, detail: 'the session restarted before it finished' } : a)))
      const cwd = await cwdOf($)
      // The pane the start setting opens meets the same terminal checks as /filetree; its first
      // drawing closes it and says why when the terminal is too narrow or not fullscreen.
      if (!noDock) openedByStart = true
      if (!t.root || t.nodes.length === 0 || (follow && t.root !== cwd)) await reset($, cwd)
      else if (!noDock) await $.ui.open({ id: PANE, title: `Files: ${t.root.split('/').pop() || t.root}` })
    })()
    return next(e)
  })

  on('command.run', { command: 'filetree' }, async ($, e) => {
    // `help` answers anywhere and opens nothing; a folder named help opens as ./help.
    if ((e.args ?? '').trim() === 'help') return { text: helpText() }
    // The layout checks are the terminal's: the desktop app docks the pane itself and
    // reports no fullscreen layout, so a session no terminal draws skips them.
    const terminal = await $.session.surfaces().then(s => s.includes('terminal'), () => true)
    if (terminal && !e.presentation.isFullscreen) return { text: 'filetree shows in the sidebar, which needs the fullscreen layout. Run /tui fullscreen, then /filetree.' }
    if (terminal && e.presentation.columns < MIN_COLUMNS) return { text: `filetree shows in the sidebar, which needs a terminal at least ${MIN_COLUMNS} columns wide. Widen it, then run /filetree.` }
    const arg = (e.args ?? '').trim()
    const cwd = await cwdOf($)
    const target = arg ? resolve(cwd, arg, home) : cwd
    // A path is checked before anything opens: a missing one opens nothing, a file opens its folder.
    let root = target
    let file = ''
    if (arg) {
      let kind = ''
      try {
        kind = (await $.fs.stat(target)).kind
      } catch (err) {
        // Nothing there is the plain reply; any other stat error (a denied folder) says itself.
        const cause = causeOf(err)
        if (!isMissingCause(cause)) return { text: pathCheckReply('unreadable', shortPath(target), cause) }
      }
      if (kind === 'file') {
        file = target
        root = dirname(target)
      } else if (kind !== 'dir') return { text: pathCheckReply('missing', shortPath(target)) }
    }
    noDock = false
    follow = !arg
    await reset($, root, true)
    if (file) {
      await patch($, cur => (cur.root === root ? { cursor: file, scroll: null } : {}))
      return { text: pathCheckReply('file', shortPath(file), shortPath(root)) }
    }
    return { text: `File tree on ${shortPath(root)}${follow ? ' (follows the cwd)' : ''}.` }
  })

  on('tool.call', async ($, e, next) => {
    const shell = e.tool === 'Bash' || e.tool === 'PowerShell'
    if (e.tool !== 'Edit' && e.tool !== 'Write' && e.tool !== 'NotebookEdit' && !shell) return next(e)
    const command = e.tool === 'Bash' || e.tool === 'PowerShell' ? e.command : ''
    const cwd = shell ? await cwdOf($) : ''
    const actions = gitActions(command)
    const quiet = !actions.length && readOnly(command)
    const since = await sinceNow($, shell && !quiet)
    const before = actions.some(a => a.verb === 'commit') ? await get($) : null
    const head = before?.top ? await headOf($, before.root) : ''
    // Paths the command names for deletion, and the rows they have now, so a deleted row can stay
    // as a ghost once the command has run.
    const removals = shell && !quiet ? removedTargets(command, cwd, home) : []
    const removedNodes = removals.length ? (await get($)).nodes.filter(node => removals.includes(node.id)) : []
    // tool.call carries the loop's agentId inside a subagent and none on the main loop. Only the
    // git chip needs the answer before the tool runs, and it waits 300 ms at most for it.
    const isChipSubagent = actions.length ? await isSubagentLoop($, e.agentId, 300) : false
    const pending: Pending | null = actions.length ? { actions, ids: await startGit($, actions, isChipSubagent), command, head } : null
    let result: Awaited<ReturnType<typeof next>>
    try {
      result = await next(e)
    } catch (err) {
      if (pending) await finishGit($, pending, failAll(pending, causeOf(err)))
      if (since.mark) void $.process.run(['rm', '-f', since.mark], { timeoutMs: 3_000 }).catch(() => undefined)
      throw err
    }
    if (pending && result.deny) {
      const ids = pending.ids
      void setActivities($, cur => cur.filter(a => !ids.includes(a.id)))
    }
    if (result.deny || (result.isError && !shell)) {
      if (since.mark) void $.process.run(['rm', '-f', since.mark], { timeoutMs: 3_000 }).catch(() => undefined)
      return result
    }
    // Everything after the tool ran works the subagent flag out off the tool's path, waiting
    // 300 ms at most for the agent list; a slower list counts as the main loop.
    const subagentLookup = isSubagentLoop($, e.agentId, 300)
    if (shell) {
      const out: Partial<BuiltinToolResults['Bash']> = !result.isError && result.result && typeof result.result === 'object' ? (result.result as Partial<BuiltinToolResults['Bash']>) : {}
      const cause = result.isError ? bashFailureCause(result.text ?? (typeof result.result === 'string' ? result.result : '')) : ''
      const reads: QueuedRead[] = showReads ? readTargets(command, cwd, typeof out.stdout === 'string' ? out.stdout : '', home).map(path => ({ path, isSubagent: false })) : []
      const job: Job = { actions: [], since, initRepo: actions.some(a => a.init), readOnly: quiet || result.isReadOnly === true, isSubagent: false }
      const removal: Removal | null = removals.length ? { paths: removals, nodes: removedNodes, isSubagent: false } : null
      // A background command deletes when it ends, so its removals wait for its notification. Its
      // entry is set before any wait, and the subagent flag is filled in once the lookup answers.
      if (out.backgroundTaskId) background.set(out.backgroundTaskId, { p: pending, job, reads, removal })
      void (async () => {
        const isSubagent = await subagentLookup
        job.isSubagent = isSubagent
        for (const read of reads) read.isSubagent = isSubagent
        if (removal) removal.isSubagent = isSubagent
        if (out.backgroundTaskId) return
        const results = pending ? await outcomes($, pending, !result.isError, out.gitOperation, cause) : []
        if (pending) await finishGit($, pending, results)
        if (removal) await settleRemoval($, removal)
        queuedReads.push(...reads)
        scheduleScan($, { ...job, actions: proven(pending, results) })
      })().catch(err => logFailure($, 'the update after a Bash call', err))
      if (follow && /(^|[;&|\s])(cd|pushd|popd)(\s|$)/.test(command)) $.clock.after(400, () => void followCwd($))
    } else {
      const file =
        'file_path' in e && typeof e.file_path === 'string'
          ? e.file_path
          : 'notebook_path' in e && typeof e.notebook_path === 'string'
            ? e.notebook_path
            : ''
      if (file)
        void subagentLookup
          .then(isSubagent => touched($, [file], 'write', showWrites, isSubagent))
          .catch(err => logFailure($, `the update after writing ${file}`, err))
    }
    return result
  })

  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny || result.isError || e.tool !== 'Read' || !showReads) return result
    const path = posix(e.file_path)
    void isSubagentLoop($, e.agentId, 300)
      .then(isSubagent => touched($, [path], 'read', true, isSubagent))
      .catch(err => logFailure($, `the update after reading ${path}`, err))
    return result
  })

  for (const tool of ['Grep', 'Glob'] as const)
    on('tool.call', { tool }, async ($, e, next) => {
      const result = await next(e)
      if (result.deny || result.isError || !showReads) return result
      const names = (result.result as Partial<BuiltinToolResults['Grep']> | undefined)?.filenames
      if (!Array.isArray(names) || names.length === 0) return result
      const cwd = await cwdOf($)
      const paths = names.slice(0, SEARCH_REVEAL_LIMIT).map(f => resolve(cwd, posix(f), home))
      void isSubagentLoop($, e.agentId, 300)
        .then(isSubagent => touched($, paths, 'read', true, isSubagent))
        .catch(err => logFailure($, `the update after a ${tool} search`, err))
      return result
    })

  on('ui.message', async ($, e, next) => {
    if (e.requestId === PANE && e.element.startsWith('button-') && e.data && typeof e.data === 'object') {
      const id = e.element.slice('button-'.length)
      const data = e.data as { over?: unknown; press?: unknown }
      if (data.press) await pressHeader($, id)
      else if (data.over === true || hovered === id) {
        hovered = data.over === true ? id : ''
        void $.ui.invalidate('ui.render')
      }
      return {}
    }
    if (e.requestId !== PANE || e.element !== 'rows' || !e.data || typeof e.data !== 'object') return next(e)
    const data = e.data as { press?: unknown; key?: unknown; ctrl?: unknown; shift?: unknown; scrollTo?: unknown; copy?: unknown }
    void sync($)
    const version = treeVersion
    const t = await get($)
    if (typeof data.copy === 'string') {
      // A deleted file's ghost row copies the path it had.
      await copyPath($, data.copy.startsWith(GHOST_PREFIX) ? data.copy.slice(GHOST_PREFIX.length) : data.copy, Boolean(data.shift), e.surface)
      return {}
    }
    if (typeof data.scrollTo === 'number') {
      const to = Math.round(Math.max(0, Math.min(1, data.scrollTo)) * view.max)
      if (to !== t.scroll) await patch($, () => ({ scroll: to }))
      return {}
    }
    if (typeof data.press === 'string') {
      const n = t.nodes.find(x => x.id === data.press)
      if (!n) return {}
      if (t.scroll === null) await patch($, () => ({ scroll: view.from }))
      if (data.ctrl || data.shift) await openNode($, n)
      else await press($, n)
      return {}
    }
    if (typeof data.key !== 'string') return {}
    if (t.preview) {
      const page = Math.max(1, previewRows - 2)
      const by: Record<string, number> = { up: -1, k: -1, down: 1, j: 1, pageup: -page, pagedown: page, home: -Infinity, end: Infinity }
      if (data.key === 'left' || data.key === 'h') await closePreview($)
      else if (data.key in by) await scrollPreview($, by[data.key] ?? 0)
      return {}
    }
    const rowKey = rowKeyAction(data.key, Boolean(data.ctrl))
    if (rowKey) {
      await runRowKey($, rowKey)
      return {}
    }
    const rows = rowsOf(t, version, shownGhosts(t, await $.clock.now()))
    const at = rows.findIndex(r => r.node.id === t.cursor)
    const cur = rows[at]?.node
    const move = (d: number) => {
      const target = rows[Math.max(0, Math.min(rows.length - 1, (at < 0 ? 0 : at) + d))]
      return target ? patch($, () => ({ cursor: target.node.id, scroll: null })) : Promise.resolve()
    }
    if (data.key === 'up' || data.key === 'k') await move(-1)
    else if (data.key === 'down' || data.key === 'j') await move(1)
    else if (data.key === 'pageup') await move(-10)
    else if (data.key === 'pagedown') await move(10)
    else if (data.key === 'home') await move(-rows.length)
    else if (data.key === 'end') await move(rows.length)
    else if (cur && (data.key === 'y' || data.key === 'Y')) await copyPath($, cur.id, data.key === 'Y' || Boolean(data.shift), e.surface)
    else if (cur && (data.key === 'right' || data.key === 'l') && cur.kind === 'dir' && !t.expanded.includes(cur.id)) await toggle($, cur)
    else if (cur && (data.key === 'left' || data.key === 'h')) {
      if (cur.kind === 'dir' && t.expanded.includes(cur.id)) await toggle($, cur)
      else if (cur.parent !== t.root) await patch($, () => ({ cursor: cur.parent }))
    } else if (cur && data.key === 'return') await (cur.kind !== 'dir' ? openNode($, cur) : toggle($, cur))
    else if (cur && (data.key === ' ' || data.key === 'space')) await (cur.kind !== 'dir' && (await osName($)) === 'darwin' ? quickLook($, cur.id) : toggle($, cur))
    return {}
  })

  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    if (e.source === 'clear' || e.source === 'resume' || e.source === 'fork') {
      void (async () => {
        await loadTheme($)
        const root = follow || !lastRoot ? await cwdOf($) : lastRoot
        const t = await get($)
        if (t.root !== root || t.nodes.length === 0) await reset($, root)
      })()
    }
    const gd = await gitDir($, posix(e.cwd))
    return gd ? { ...result, watchPaths: [...(result.watchPaths ?? []), join(gd, 'index'), join(gd, 'HEAD')] } : result
  })

  on('classic.CwdChanged', async ($, e, next) => {
    const result = await next(e)
    void followCwd($)
    return result
  })

  on('classic.FileChanged', async ($, e, next) => {
    const result = await next(e)
    if (/[\\/]\.git[\\/]|[\\/](index|HEAD)$/.test(e.file_path)) $.clock.after(300, () => void sync($, true))
    return result
  })

  on('ui.focus', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const result = await next(e)
    void sync($)
    return result
  })

  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (nativeScroll) return next(e)
    const t = await get($)
    if (t.preview) {
      await scrollPreview($, Math.sign(e.by) * Math.max(3, Math.abs(e.by)))
      return {}
    }
    const to = Math.max(0, Math.min(view.max, (t.scroll ?? view.from) + Math.sign(e.by) * Math.max(3, Math.abs(e.by))))
    if (to !== t.scroll) await patch($, () => ({ scroll: to }))
    return {}
  })

  on('prompt.submit', async ($, e, next) => {
    void settleBackground($, e.text)
    if (!(await followCwd($))) void sync($)
    const t = await get($)
    const context = [...(e.context ?? [])]
    if (t.selected && (await exists($, t.selected))) context.push(`The user has this file selected in the file tree; "this" or "it" in the prompt likely refers to it: ${t.selected}`)
    const mentions = [...e.text.matchAll(/@([^\s"'`]+)/g)]
      .map(m => (m[1] ?? '').replace(/[.,;:!?)]+$/, ''))
      .filter(Boolean)
      .map(p => resolve(t.root, p, home))
      .filter(p => inside(t.root, p))
    if (mentions.length) {
      void (async () => {
        const found: string[] = []
        for (const p of mentions) {
          try {
            await $.fs.stat(p)
            found.push(p.replace(/\/$/, ''))
          } catch {
            continue
          }
        }
        if (found.length) await reveal($, found)
      })()
    }
    return next(context.length ? { ...e, context } : e)
  })

  on('prompt.attachment', async ($, e, next) => {
    void settleBackground($, e.text)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface !== 'terminal' && e.surface !== 'desktop') return next(e)
    if (e.surface === 'terminal' && e.props.placement === 'inline') {
      noDock = true
      void $.ui.close({ id: PANE }).catch(() => undefined)
      const { Box: Empty } = $.ui.resolve(e)
      return <Empty />
    }
    // The start setting opened the pane: it keeps to the terminal width /filetree asks for.
    const viewport = e.viewport
    if (e.surface === 'terminal' && openedByStart && viewport && (viewport.isFullscreen === false || viewport.columns < MIN_COLUMNS)) {
      openedByStart = false
      noDock = true
      void $.ui.close({ id: PANE }).catch(() => undefined)
      $.ui.toast(startBlockedReason(viewport))
      const { Box: Empty } = $.ui.resolve(e)
      return <Empty />
    }
    if (e.surface === 'terminal' && viewport) openedByStart = false
    const isDesktop = e.surface === 'desktop'
    const unicode = glyphSetting === 'plain' || (glyphSetting === 'auto' && (noNerd || isDesktop))
    // The desktop draws Lucide icons unless the glyphs setting asks for the plain badges. A Client
    // has no Svg, so its rows leave the icon's cells blank and the icons are laid over them.
    const isLucide = isDesktop && glyphSetting !== 'plain'
    const { Box, Text, Button, Input, Client } = $.ui.resolve(e)
    const Svg = e.surface === 'desktop' ? $.ui.resolve(e).Svg : undefined
    const version = treeVersion
    const t = await get($)
    const theme: Theme = (await $.state.get(THEME)).value ?? DEFAULT_THEME
    const palette: Palette = buildPalette(theme, isDesktop)
    // The desktop tab never hands the wheel or the scrollbar drag to the pane, so
    // there it draws every row and lets the engine scroll the body.
    nativeScroll = isDesktop
    const button = (b: ButtonProps) => <Client key={`button-${b.id}`} module="./button.tsx" props={{ id: b.id, label: b.label, dim: b.dim } satisfies ButtonProps} />
    // What the hovered button does, beside the title, when it fits in the columns the title
    // and whatever else shares its row leave; the buttons are Clients only so that they can
    // say when the pointer is over them.
    const hint = (buttons: { id: string; hint: string }[], used: number) => {
      const text = buttons.find(b => b.id === hovered)?.hint
      if (!text) return null
      const room = e.props.bodyColumns - used - 2
      return text.length <= room ? <Text mono color={palette.muted}>{`${text} `}</Text> : null
    }
    const divider = (columns: number) => <Text mono color={palette.faint} wrap="truncate-end">{'─'.repeat(Math.max(1, columns))}</Text>
    if (t.preview) {
      if (previewed?.path !== t.preview) await loadPreview($, t.preview)
      const p = previewed
      const markdown = /\.(md|markdown|mdx)$/i.test(t.preview)
      const all = (p?.text ?? '').split('\n').length
      previewRows = nativeScroll ? all : Math.max(4, (e.props.scroll?.bodyRows ?? 40) - (p?.note ? 2 : 1))
      const win = previewLines(p?.text ?? '', nativeScroll ? 0 : Math.min(t.previewTop, Math.max(0, all - previewRows)), previewRows, markdown)
      const name = t.preview !== t.root && inside(t.root, t.preview) ? relative(t.root, t.preview) : shortPath(t.preview)
      const backLabel = isDesktop ? 'Close preview' : unicode ? '← files' : '\u{f004d} files'
      const external = { id: 'external', label: isDesktop ? 'Open in default app' : unicode ? '↗ open' : '\u{f08e} open', dim: true, hint: 'open in default app' }
      return (
        <Box flexDirection="column" minHeight={Math.max(1, e.props.scroll?.bodyRows ?? 1)} backgroundColor={theme.bg || undefined}>
          <Box flexDirection="row">
            <Button key="back" plain label={backLabel} onPress={() => void closePreview($)} />
            <Text mono> </Text>
            <Box flexShrink={1} flexGrow={1}>
              <Text mono bold color={palette.text} wrap="truncate-start">
                {name}
              </Text>
            </Box>
            {hint([external], widthOf(backLabel) + 2 + widthOf(name) + widthOf(external.label))}
            {button(external)}
          </Box>
          {p?.note ? <Text mono color={palette.muted}>{p.note}</Text> : null}
          {isDesktop && divider(e.props.bodyColumns)}
          <Client
            key="rows"
            module="./rows.tsx"
            props={{ rows: [], active: '', activeBg: palette.cursorBg, hoverBg: palette.hoverBg, tones: palette.shimmer, pointer: false, preview: { text: win.text, path: t.preview, startLine: win.top + 1, markdown } } satisfies RowsProps}
          />
        </Box>
      )
    }
    const now = await $.clock.now()
    const live = (await activities($)).filter(a => now - a.at < (a.state === 'running' ? RUNNING_MAX_MS : ACTIVITY_TTL_MS))
    // Every running git action shows, up to three and a count of the rest; with none running,
    // the one that ended last.
    const running = live.filter(a => a.state === 'running')
    const runningShown = runningChips(running)
    const lastEnded = live[live.length - 1]
    const footerChips = running.length ? runningShown.shown : lastEnded ? [lastEnded] : []
    const hasFooter = Boolean(t.selected) || footerChips.length > 0
    const bright = new Set(t.flashOn ? t.flash : [])
    const dimmed = new Set(t.flashOn ? t.flashDim : [])
    const ignored = new Set(t.ignored)
    const untracked = new Set(t.untrackedDirs)
    const width = Math.max(24, e.props.bodyColumns)
    const ghostList = shownGhosts(t, now)
    const ghostIds = new Set(ghostList.map(ghost => ghost.node.id))
    const rows = rowsOf(t, version, ghostList)
    // Files touched outside the folder: every one on the desktop, whose body scrolls; the
    // terminal keeps five rows for them and counts the rest.
    const outsideList = outsideOf(outsideTouches, t.root)
    const outsideShown = isDesktop ? outsideList : outsideList.slice(0, 5)
    const outsideRows = outsideList.length ? 1 + outsideShown.length + (outsideShown.length < outsideList.length ? 1 : 0) : 0

    // The controls. Labels say what a press does; all are drawn alike, so state is read from
    // the label. The desktop gives the search field a row of its own and puts the controls on
    // the row below in two groups that wrap as units: Go up and Reload on the left, the view
    // toggles at the right edge, dropping to their own left-aligned line when the pane is
    // narrow. The terminal puts every control on a row that wraps.
    // Follow cwd shows only while the tree is not following, and Clear selection sits beside
    // the selection in the footer.
    const say = (text: string) => (isDesktop ? text.charAt(0).toUpperCase() + text.slice(1) : text)
    const columnLabel = showAge ? 'ages' : 'dates'
    const sizeLabel = t.showSize ? `show ${columnLabel}` : 'show sizes'
    // Each hint names the key the rows take for the same action.
    const upButton = { id: 'up', label: say('go up'), dim: true, hint: 'parent folder (u)' }
    const reloadButton = { id: 'refresh', label: say('reload'), dim: true, hint: 'reload tree and git (r)' }
    const viewButtons = [
      { id: 'hidden', label: say(t.showHidden ? 'hide dotfiles' : 'show dotfiles'), dim: true, hint: t.showHidden ? 'hide hidden files (.)' : 'show hidden files (.)' },
      { id: 'size', label: say(sizeLabel), dim: true, hint: `${sizeLabel} (s cycles date, age, size)` },
      { id: 'collapse', label: isDesktop ? 'Collapse all' : 'collapse', dim: true, hint: 'collapse all (c)' },
      ...(follow ? [] : [{ id: 'cwd', label: say('follow cwd'), dim: true, hint: 'follow the cwd' }]),
    ]
    const clearSelectionButton = { id: 'unselect', label: isDesktop ? 'Clear selection' : 'clear selection', dim: true, hint: 'stop sending the file with prompts' }
    const toolbarButtons = isDesktop ? viewButtons : [upButton, reloadButton, ...viewButtons]
    const allButtons = [upButton, reloadButton, ...viewButtons, ...(t.selected ? [clearSelectionButton] : [])]
    // How many rows the terminal's toolbar wraps to, filled greedily as the row lays out:
    // each label, and the dot between two labels, a column apart.
    const toolbarRows = (() => {
      if (isDesktop) return 0
      const itemWidths = toolbarButtons.flatMap((b, index) => (index === 0 ? [widthOf(b.label)] : [1, widthOf(b.label)]))
      let lines = 1
      let used = -1
      for (const itemWidth of itemWidths) {
        if (used >= 0 && used + 1 + itemWidth > width) {
          lines += 1
          used = itemWidth
        } else used = used < 0 ? itemWidth : used + 1 + itemWidth
      }
      return lines
    })()

    // The git line under the header: why git could not be read, else outside a repo the init hint.
    const isGitHintShown = !t.top && showHints && !t.gitError
    const fixed = 2 + toolbarRows + (t.top && t.branch ? 1 : 0) + (t.gitError || isGitHintShown ? 1 : 0) + (hasFooter ? 1 : 0) + outsideRows
    const room = nativeScroll ? Math.max(1, rows.length) : Math.max(5, (e.props.scroll?.bodyRows ?? 40) - fixed)
    const isLit = (id: string) => bright.has(id) || dimmed.has(id)
    const focus = followClaude && t.flashOn ? ([...t.flash].reverse().find(id => id !== BRANCH_ROW) ?? t.cursor) : t.cursor
    const at = Math.max(0, rows.findIndex(r => r.node.id === focus))
    const lit = followClaude && t.flashOn ? rows.findIndex(r => isLit(r.node.id)) : -1
    const cap = Math.max(1, Math.floor(room / 3))
    let from = Math.max(0, Math.min(lit >= 0 && at - lit < room - 2 ? Math.max(0, lit - 1) : at - Math.floor(room / 2), rows.length - room))
    let pinned = !nativeScroll && followClaude && t.flashOn ? rows.slice(0, from).filter(r => isLit(r.node.id)).slice(-cap) : []
    if (pinned.length) {
      const rest = Math.max(3, room - pinned.length)
      from = Math.max(0, Math.min(at - Math.floor(rest / 2), rows.length - rest))
      pinned = rows.slice(0, from).filter(r => isLit(r.node.id)).slice(-cap)
    }
    const max = Math.max(0, rows.length - room)
    if (t.scroll !== null) {
      from = Math.max(0, Math.min(t.scroll, max))
      pinned = []
    }
    view = { from, max }
    const shown = rows.slice(from, from + room - pinned.length)
    if (t.showSize) wantSizes($, [...pinned, ...shown].filter(r => r.node.kind === 'dir' && !(r.node.id in t.dirSizes)).map(r => r.node.id))
    const totals: [number, number] = t.top ? (t.diff[t.root] ?? [0, 0]) : [0, 0]
    const isBarShown = !nativeScroll && rows.length > shown.length + pinned.length
    const isNarrow = width < NARROW_COLUMNS
    // Untracked files count as ?, staged-added ones as A, then modified and deleted.
    const countSegs = (counts: readonly number[] | undefined): Seg[] => {
      if (!counts) return []
      const [untracked = 0, modified = 0, deleted = 0, added = 0] = counts
      const out: Seg[] = []
      if (untracked > 0) out.push({ t: ` ?${untracked}`, c: palette.added })
      if (added > 0) out.push({ t: ` A${added}`, c: palette.added })
      if (modified > 0) out.push({ t: ` M${modified}`, c: palette.modified })
      if (deleted > 0) out.push({ t: ` D${deleted}`, c: palette.deleted })
      return out
    }
    const lineSegs = (loc: [number, number] | undefined): Seg[] => {
      if (!loc) return []
      const out: Seg[] = []
      if (loc[0] > 0) out.push({ t: ` +${loc[0]}`, c: palette.addedLines })
      if (loc[1] > 0) out.push({ t: ` -${loc[1]}`, c: palette.deletedLines })
      return out
    }
    const rootCounts = t.top ? countSegs(t.counts[t.root]) : []
    const repoName = t.top ? (t.top.split('/').pop() ?? t.top) : t.root.split('/').pop() || t.root
    const subPath = t.top ? t.prefix.replace(/\/$/, '') : ''
    const header = [repoName, subPath].filter(Boolean).join('/')

    // Every row's trailing cells, first, so the main column can be as wide as its widest cell
    // and line up down the tree: a detail cell (a folder's file counts, or line counts beside
    // sizes), the main cell (date, age, size, or the line counts of a file or folder) and the
    // git status mark. A narrow pane leaves a folder's line counts to the summary, so names
    // keep room, and shows the folder's file counts in the main cell instead.
    type Cells = { detail: Seg[]; main: Seg[]; mark: Seg; isDate: boolean }
    const cellsOf = (r: (typeof rows)[number]): Cells => {
      const n = r.node
      const status = t.git[n.id] ?? (underAny(dirname(n.id), untracked, t.root) ? '?' : undefined)
      const isIgnored = !status && underAny(n.id, ignored, t.root)
      const loc = t.diff[n.id]
      const counts = n.kind === 'dir' ? countSegs(t.counts[n.id]) : []
      const sizeText =
        n.kind === 'dir' ? (n.id in t.dirSizes ? formatSize(t.dirSizes[n.id] ?? -1) : '…') : n.kind === 'file' || (n.kind === 'link' && n.size > 0) ? formatSize(n.size) : ''
      const timeText = n.kind === 'file' ? (showAge ? age(n.mtime, now) : dateLabel(n.mtime, now, width < VERY_NARROW_COLUMNS)) : ''
      const muted = (text: string): Seg[] => (text ? [{ t: ` ${text}`, c: palette.muted }] : [])
      const ignoredMark = unicode ? ' ⊘' : ' \u{f05e}'
      const mark: Seg = status
        ? { t: n.kind === 'dir' ? ' •' : ` ${status}`, c: gitInk(palette, status), b: true }
        : isIgnored
          ? { t: ignoredMark, c: palette.faint }
          : { t: '  ' }
      const folderLines = n.kind === 'dir' && isNarrow ? [] : lineSegs(loc)
      if (t.showSize) return { detail: [...folderLines, ...counts], main: muted(sizeText), mark, isDate: false }
      if (n.kind === 'dir') return isNarrow ? { detail: [], main: counts, mark, isDate: false } : { detail: counts, main: folderLines, mark, isDate: false }
      return loc ? { detail: [], main: lineSegs(loc), mark, isDate: false } : { detail: [], main: muted(timeText), mark, isDate: Boolean(timeText) }
    }
    const drawnRows = [...pinned, ...shown].filter(r => !ghostIds.has(r.node.id))
    const cells = new Map(drawnRows.map(r => [r.node.id, cellsOf(r)]))
    const segsWidth = (segs: Seg[]) => segs.reduce((sum, segment) => sum + widthOf(segment.t), 0)
    let mainWidth = 0
    for (const rowCells of cells.values()) mainWidth = Math.max(mainWidth, segsWidth(rowCells.main))
    const padTo = (segs: Seg[], columns: number): Seg[] => {
      const gap = columns - segsWidth(segs)
      return gap > 0 ? [{ t: ' '.repeat(gap) }, ...segs] : segs
    }
    // Two columns a level; past a third of the pane the guides stop deepening and start with
    // an ellipsis, so the deepest names keep their room.
    const maxGuideLevels = Math.max(2, Math.floor((width * 0.35) / 2))
    const fixedTrailing = 2 + (isBarShown ? 1 : 0) + 1
    const MIN_NAME_ROOM = 10
    // The active indent guide, as in VS Code: the folder holding the cursor (or the cursor
    // itself when it is an open folder) has its guide drawn brighter down its open rows.
    const cursorRow = rows.find(row => row.node.id === t.cursor)
    const activeFolder = cursorRow ? (cursorRow.node.kind === 'dir' && cursorRow.open ? cursorRow.node.id : cursorRow.node.parent) : ''
    const activeLevel = activeFolder && activeFolder !== t.root ? (rows.find(row => row.node.id === activeFolder)?.depth ?? -1) : -1
    // An ignored row fades whole: its inks pulled most of the way to the muted colour.
    const FADE = 0.6
    // Where each row's Lucide icon sits on the desktop: the cells before its blank slot, the icon
    // and its colour, by row id.
    type IconOverlay = { prefixCells: number; name: LucideName; color: string }
    const iconOverlays = new Map<string, IconOverlay>()
    const LUCIDE_SLOT = '   '

    const rowSpec = (r: (typeof rows)[number]): RowSpec => {
      const n = r.node
      // A file Claude deleted: faded and struck through, with no cells, until its time is up.
      const isGhost = ghostIds.has(n.id)
      const own = isGhost ? undefined : t.git[n.id]
      const status = own ?? (underAny(dirname(n.id), untracked, t.root) ? '?' : undefined)
      const isIgnored = !status && underAny(n.id, ignored, t.root)
      const statusInk = gitInk(palette, status)
      const isBright = !isGhost && bright.has(n.id)
      const isDim = !isGhost && !isBright && dimmed.has(n.id)
      const isRowLit = isBright || isDim
      const tone = t.flashTones[n.id] ?? 'orange'
      // Files take their git colour; a folder keeps the text colour and says its changes in its cells.
      const plainColor = n.hidden ? palette.muted : palette.text
      const nameColor = isIgnored ? palette.muted : n.kind === 'dir' ? plainColor : (statusInk ?? plainColor)
      const isRepo = n.kind === 'dir' && n.id === t.top
      const fade = (color: string) => (isIgnored ? mix(color, palette.mutedHex, FADE) : color)
      // A folder's block or Nerd glyph in its kind's colour; a file's chip, or its Nerd glyph in the chip's colour.
      const badge = n.kind === 'dir' ? undefined : fileBadge(n)
      const glyphInk = isRepo ? palette.accent : badge ? inkOnPane(palette, badge.ink) : inkOnPane(palette, folderInk(n.name))
      const glyph = unicode ? (badge ? '' : '▇▅ ') : `${fileIcon(n, r.open, isRepo)} `
      const iconSegs: Seg[] = isLucide
        ? [{ t: LUCIDE_SLOT, role: 'icon' }]
        : unicode && badge
          ? [{ t: badge.text, c: onInkFor(fade(badge.ink)), bg: fade(badge.ink), b: true, role: 'icon' }, { t: ' ' }]
          : isRowLit
            ? [{ t: glyph, sh: tone, dim: isDim, one: true, role: 'icon' }]
            : [{ t: glyph, c: fade(glyphInk), role: 'icon' }]
      const linkMark = unicode && n.kind === 'link' ? ' →' : ''
      const caret = n.kind === 'dir' ? (unicode ? (r.open ? '▾' : '▸') : r.open ? CHEVRON_OPEN : CHEVRON_CLOSED) + ' ' : '  '
      const isCapped = r.depth > maxGuideLevels
      const guides = r.depth === 0 ? '' : isCapped ? `… ${'│ '.repeat(maxGuideLevels - 1)}` : '│ '.repeat(r.depth)
      // The guides in up to three runs, the middle one the active folder's level when this row
      // sits under it and that level is drawn (a capped row's ellipsis stands for the cut ones).
      const firstShownLevel = isCapped ? r.depth - (maxGuideLevels - 1) : 0
      const isUnderActive = activeLevel >= firstShownLevel && activeLevel < r.depth && inside(activeFolder, n.id)
      const guideSegs: Seg[] = !guides
        ? []
        : isUnderActive
          ? [
              { t: (isCapped ? '… ' : '') + '│ '.repeat(activeLevel - firstShownLevel), c: palette.faint },
              { t: '│ ', c: palette.muted },
              { t: '│ '.repeat(r.depth - activeLevel - 1), c: palette.faint },
            ].filter(segment => segment.t)
          : [{ t: guides, c: palette.faint }]
      const rowCells: Cells = isGhost ? { detail: [], main: [], mark: { t: '  ' }, isDate: false } : (cells.get(n.id) ?? cellsOf(r))
      const roomBesides = width - 1 - widthOf(guides) - 2 - segsWidth(iconSegs) - widthOf(linkMark) - segsWidth(rowCells.detail) - fixedTrailing
      // A row whose name would be squeezed under ten columns gives up its date for the name.
      const isDateDropped = rowCells.isDate && roomBesides - mainWidth < MIN_NAME_ROOM
      const nameRoom = Math.max(4, roomBesides - (isDateDropped ? 0 : mainWidth))
      const name = truncateMiddle(n.name, nameRoom)
      const recent = isGhost ? undefined : recentTouches.get(n.id)
      // The cursor marker always shows on its row; a shimmer or recent touch shows everywhere
      // else, a thin bar for a read and a thick one for a write.
      const mark = gutterMark({
        isCursor: n.id === t.cursor,
        lit: isRowLit ? { tone, isDim } : null,
        recent: recent ? { tone: recent.tone, step: recentLevel(recent.at, now) } : null,
      })
      const touchMix = { bright: 0, dim: 0.5, soft: 0.25, faint: 0.65 } as const
      const gutter: Seg =
        mark.ink === 'accent'
          ? { t: mark.glyph, c: palette.accent }
          : mark.ink === 'touch'
            ? { t: mark.glyph, c: mix(palette.ink(mark.tone), palette.mutedHex, touchMix[mark.strength]) }
            : { t: ' ' }
      const nameSeg: Seg = isGhost
        ? { t: name, c: palette.muted, s: true }
        : isRowLit
          ? { t: name, sh: tone, dim: isDim, b: isBright }
          : { t: name, c: nameColor, b: n.id === t.selected, s: status === 'D' && n.kind !== 'dir' }
      const left: Seg[] = [
        gutter,
        ...guideSegs,
        { t: caret, c: palette.muted, role: n.kind === 'dir' ? 'caret' : undefined },
        ...iconSegs,
        nameSeg,
        ...(linkMark ? [{ t: linkMark, c: palette.muted }] : []),
      ]
      const specId = isGhost ? `${GHOST_PREFIX}${n.id}` : n.id
      if (isLucide) {
        // A row Claude is on takes the first shade of the palette its name shimmers in.
        const shimmerPalette = isDim ? palette.shimmer[tone]?.dim : palette.shimmer[tone]?.bright
        const shimmerInk = shimmerPalette?.[0] ?? palette.ink(tone)
        iconOverlays.set(specId, {
          prefixCells: widthOf(gutter.t) + segsWidth(guideSegs) + widthOf(caret),
          name: lucideNameFor(n, r.open, isRepo),
          color: isGhost ? palette.mutedHex : isRowLit ? shimmerInk : fade(glyphInk),
        })
      }
      const cellSegs: Seg[] = [...rowCells.detail, ...(mainWidth && !isDateDropped ? padTo(rowCells.main, mainWidth) : []), rowCells.mark]
      const right = isIgnored ? cellSegs.map(segment => (segment.c === undefined ? segment : { ...segment, c: palette.faint })) : cellSegs
      return isGhost ? { id: specId, left: clean(left), right: clean(right), isFaded: true } : { id: specId, left: clean(left), right: clean(right) }
    }

    const note = (text: string): RowSpec => ({ id: '', left: [{ t: text, c: palette.muted }], right: [] })
    const query = t.query.trim()
    const isDotfilesOnly = !t.showHidden && t.nodes.some(n => n.parent === t.root && n.hidden)
    const emptyText = query
      ? pendingQuery === t.query
        ? '  Searching…'
        : t.searchError
          ? `  ${searchUnavailable(t.searchError)}`
          : `  No files match "${query}"`
      : unreadable.has(t.root)
        ? '  Could not read this folder'
        : !listedRoots.has(t.root)
          ? '  Loading files…'
          : isDotfilesOnly
            ? '  Only dotfiles here'
            : '  This folder is empty'
    const specs: RowSpec[] = [
      ...(rows.length === 0 ? [note(emptyText)] : []),
      ...pinned.map(rowSpec),
      ...(pinned.length > 0 ? [{ id: '', left: [{ t: '  ⋮', c: palette.faint }], right: [] }] : []),
      ...shown.map(rowSpec),
    ]
    if (nativeScroll) {
      // An overlaid icon's blank cells and alt count toward the drawn text too.
      const overlayText = (spec: RowSpec) => {
        const overlay = isLucide && spec.id ? iconOverlays.get(spec.id) : undefined
        return overlay ? overlay.prefixCells + overlay.name.length : 0
      }
      let size = 0
      const cut = specs.findIndex(r => (size += specCost(r) + 1 + overlayText(r)) > ROWS_BUDGET)
      if (cut >= 0) specs.splice(cut, specs.length - cut, note(`  … ${specs.length - cut} more rows, collapse folders or use search`))
    }
    // One overlay row per drawn row, so the icons stay in line; notes and the cut line get an empty one.
    const isIconOverlaid = isLucide && Svg !== undefined
    const overlayRows = isIconOverlaid ? specs.map(spec => (spec.id ? iconOverlays.get(spec.id) : undefined)) : []
    const barSize = Math.max(1, Math.round((specs.length * shown.length) / Math.max(1, rows.length)))
    const bar = isBarShown ? { pos: max ? Math.round((from / max) * (specs.length - barSize)) : 0, size: barSize, thumb: palette.accent, track: palette.faint } : undefined

    // What changed in the repo: file counts by kind and line totals, or clean. The desktop
    // shows it beside the title, where a hovered button's hint takes its place; a terminal
    // 40 columns or narrower drops the line totals first.
    // Hovering the summary shows a card under it that spells out its letters.
    const summary = () => {
      if (!t.top) return null
      const isLinesShown = isDesktop || width > 40
      return (
        <Box key="summary" flexDirection="row" flexShrink={0}>
          {rootCounts.map(segment => (
            <Text mono color={segment.c}>{segment.t}</Text>
          ))}
          {isLinesShown &&
            lineSegs(totals).map(segment => (
              <Text mono color={segment.c}>{segment.t}</Text>
            ))}
          {rootCounts.length === 0 && totals[0] === 0 && totals[1] === 0 && <Text mono color={palette.muted}> clean</Text>}
          <Box position="absolute" top={1} right={0} display="none" hover={{ display: 'flex' }} backgroundColor={palette.cursorBg} paddingX={1}>
            <Text mono color={palette.text}>
              {countsLegend(t.counts[t.root])}
            </Text>
          </Box>
        </Box>
      )
    }
    const branchRow = () => {
      if (!t.top || !t.branch) return null
      const b = t.branch
      const isFlash = bright.has(BRANCH_ROW)
      const tone = t.flashTones[BRANCH_ROW] ?? 'teal'
      return (
        <Box flexDirection="row" height={1} overflow="hidden">
          <Text mono color={isFlash ? palette.ink(tone) : palette.accent}>{(unicode ? BRANCH_ICON.plain : BRANCH_ICON.nerd) + ' '}</Text>
          {/* A branch name that fits in most of the row stays whole and the upstream gives way. */}
          <Box flexShrink={widthOf(b.head) <= width * 0.6 ? 0 : 1} overflow="hidden">
            <Text mono bold color={palette.text} wrap="truncate-end">
              {b.head}
            </Text>
          </Box>
          {b.ahead > 0 || b.behind > 0 ? (
            <Box flexDirection="row" flexShrink={0}>
              {b.ahead > 0 && <Text mono color={palette.muted}>{` ↑${b.ahead}`}</Text>}
              {b.behind > 0 && <Text mono color={palette.muted}>{` ↓${b.behind}`}</Text>}
            </Box>
          ) : null}
          {b.upstream && (
            <Box flexShrink={100} overflow="hidden">
              <Text mono color={palette.muted} wrap="truncate-end">
                {` ${b.upstream}`}
              </Text>
            </Box>
          )}
          <Box flexGrow={1} />
          {isDesktop ? null : summary()}
        </Box>
      )
    }

    // A failed chip says why after its label; a subagent's chip says "subagent" first, in lilac.
    const chip = (a: Activity) => {
      const isFailed = a.state === 'failed'
      const icon = unicode ? a.plain : a.nerd
      const hash = a.state === 'done' && a.kind === 'git commit' ? (a.detail.split(' ')[0] ?? '') : ''
      const cause = isFailed ? a.detail : ''
      return (
        <Box key={`chip-${a.id}`} flexDirection="row" marginLeft={2} flexShrink={cause ? 1 : 0} overflow="hidden">
          <Text mono color={isFailed ? palette.deleted : palette.ink(a.tone)}>{icon + ' '}</Text>
          {a.isSubagent ? <Text mono color={palette.ink('subagent write')}>subagent </Text> : null}
          <Text mono bold={a.state === 'running'} color={isFailed ? palette.deleted : palette.text}>
            {a.state === 'running' ? `${a.label}…` : a.label}
          </Text>
          {hash && <Text mono color={palette.muted}>{` ${hash}`}</Text>}
          {cause ? (
            <Box flexShrink={1} overflow="hidden">
              <Text mono color={palette.muted} wrap="truncate-end">
                {`: ${cause}`}
              </Text>
            </Box>
          ) : null}
        </Box>
      )
    }
    const moreChips = runningShown.more > 0 && running.length > 0 ? <Text mono color={palette.muted}>{`  +${runningShown.more} more`}</Text> : null

    // Files Claude touched outside the folder, under the tree: newest first, a thin bar for a
    // read and a thick one for a write; a subagent's are lilac, dashed and say so.
    const outsideGroup =
      outsideList.length === 0 ? null : (
        <Box flexDirection="column">
          <Box flexDirection="row" height={1}>
            <Text mono bold color={palette.muted}>
              Outside this folder
            </Text>
            <Box flexGrow={1} />
            <Button key="clear-outside" plain dimColor label={isDesktop ? 'Clear list' : 'clear list'} onPress={() => clearOutside($)} />
          </Box>
          {outsideShown.map(touch => (
            <Box flexDirection="row" height={1} overflow="hidden">
              <Text mono color={palette.ink(touchTone(touch.kind, touch.isSubagent))}>{barFor(touch.kind, touch.isSubagent)}</Text>
              <Text mono> </Text>
              <Box flexShrink={1} overflow="hidden">
                <Text mono color={palette.text} wrap="truncate-start">
                  {homeRelative(touch.path, home)}
                </Text>
              </Box>
              <Box flexGrow={1} />
              <Text mono color={palette.muted}>{` ${touch.kind === 'read' ? 'read' : 'written'}${touch.isSubagent ? ' by a subagent' : ''}`}</Text>
            </Box>
          ))}
          {outsideShown.length < outsideList.length ? (
            <Text mono color={palette.muted}>{`  +${outsideList.length - outsideShown.length} more`}</Text>
          ) : null}
        </Box>
      )

    // The terminal draws plain labels, so a quiet dot keeps two-word labels apart.
    const toolbar = (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {toolbarButtons.flatMap((b, index) => (index === 0 ? [button(b)] : [<Text mono color={palette.faint}>·</Text>, button(b)]))}
      </Box>
    )
    // The desktop draws its labels plain too, so each group keeps the same quiet dot between
    // labels and never breaks inside itself; the spacer pushes the view group to the right
    // edge while both groups fit on one line.
    const desktopButtonGroup = (groupKey: string, groupButtons: ButtonProps[]) => (
      <Box key={groupKey} flexDirection="row" alignItems="center" flexShrink={0} columnGap={1}>
        {groupButtons.flatMap((groupButton, index) =>
          index === 0 ? [button(groupButton)] : [<Text key={`dot-${groupButton.id}`} mono color={palette.faint}>·</Text>, button(groupButton)],
        )}
      </Box>
    )
    const desktopControls = (
      <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={2}>
        {desktopButtonGroup('navigation', [upButton, reloadButton])}
        <Box key="spacer" flexGrow={1} />
        {desktopButtonGroup('view', viewButtons)}
      </Box>
    )
    const gitIcon = unicode ? '± ' : '\u{e702} '
    const searchInput = (
      <Input
        key="q"
        {...(isDesktop ? {} : { label: '/ ' })}
        placeholder={isDesktop ? 'Search files (/ from the tree)' : 'search files'}
        submitLabel="jump"
        autoFocus
        value={t.query}
        onInput={(v: string) => void search($, v)}
        onSubmit={(v: string) => void jump($, v)}
      />
    )
    const clearSearch = t.query ? <Button key="clear" plain dimColor label={isDesktop ? 'Clear search' : 'clear search'} onPress={() => void search($, '')} /> : null
    const treeClient = (
      <Client
        key="rows"
        module="./rows.tsx"
        props={{ rows: specs, active: t.cursor, activeBg: palette.cursorBg, hoverBg: palette.hoverBg, accent: palette.accent, tones: palette.shimmer, pointer, ...(bar ? { bar } : {}), ...(isIconOverlaid ? { isStill: true } : {}) } satisfies RowsProps}
      />
    )
    // The Lucide icons lie over the tree, one row of them per tree row, each at the start of its
    // row's blank icon slot. The overlay is clipped to the tree so a row the Client cuts draws no icon.
    const tree =
      isIconOverlaid && Svg ? (
        <Box position="relative" flexDirection="column" flexShrink={0} overflow="hidden">
          {treeClient}
          <Box position="absolute" top={0} left={0} flexDirection="column">
            {overlayRows.map(overlay =>
              overlay ? (
                <Box flexDirection="row" height={1} alignItems="center">
                  <Text mono>{' '.repeat(overlay.prefixCells)}</Text>
                  <Svg source={lucideSvg(overlay.name, overlay.color)} alt={overlay.name} width={14} height={14} />
                </Box>
              ) : (
                <Box height={1} />
              ),
            )}
          </Box>
        </Box>
      ) : (
        treeClient
      )

    return (
      <Box flexDirection="column" minHeight={Math.max(1, e.props.scroll?.bodyRows ?? 1)} backgroundColor={theme.bg || undefined}>
        <Box flexDirection="row">
          <Box flexDirection="row" flexShrink={1} overflow="hidden">
            <Text mono bold color={palette.isCustomTheme ? theme.accent : palette.text} wrap="truncate-start">
              {repoName}
            </Text>
            {subPath ? (
              <Text mono color={palette.muted} wrap="truncate-start">
                {`/${subPath}`}
              </Text>
            ) : null}
          </Box>
          <Box flexGrow={1} />
          {hint(allButtons, widthOf(header)) ?? (isDesktop ? summary() : null)}
        </Box>
        {branchRow()}
        {t.gitError ? (
          <Text mono dimColor color={palette.muted} wrap="truncate-end">
            {gitIcon + gitUnavailable(t.gitError)}
          </Text>
        ) : null}
        {isGitHintShown && (
          <Text mono color={palette.muted} wrap="truncate-end">
            {gitIcon}Git status starts after git init
          </Text>
        )}
        {isDesktop ? null : toolbar}
        {isDesktop ? (
          <Box flexDirection="row" alignItems="center" columnGap={1}>
            <Box flexDirection="column" flexGrow={1} minWidth={14}>
              {searchInput}
            </Box>
            {clearSearch}
          </Box>
        ) : (
          <Box flexDirection="row">
            <Box flexGrow={1}>{searchInput}</Box>
            {clearSearch}
          </Box>
        )}
        {isDesktop ? desktopControls : null}
        {tree}
        {outsideGroup}
        <Box flexGrow={1} />
        {isDesktop && hasFooter && divider(width)}
        {hasFooter && (
          // On the desktop the activity wraps under the selection when both would be cramped.
          <Box flexDirection="row" {...(isDesktop ? { flexWrap: 'wrap' as const } : {})}>
            {t.selected ? (
              <Box flexDirection="row" flexShrink={1} {...(isDesktop ? { minWidth: Math.min(24, Math.max(8, width - 18)) } : {})}>
                <Box flexShrink={1} overflow="hidden">
                  <Text mono color={palette.muted} wrap="truncate-start">
                    selected: {t.selected !== t.root && inside(t.root, t.selected) ? t.selected.slice(t.root.endsWith('/') ? t.root.length : t.root.length + 1) : shortPath(t.selected)}
                  </Text>
                </Box>
                {/* The note gives way first, so the path keeps its room. */}
                <Box flexShrink={100} overflow="hidden">
                  <Text mono color={palette.muted} wrap="truncate-end">
                    {SELECTED_SUFFIX}
                  </Text>
                </Box>
              </Box>
            ) : null}
            {t.selected ? (
              <Box marginLeft={1} flexShrink={0}>
                {button(clearSelectionButton)}
              </Box>
            ) : null}
            <Box flexGrow={1} />
            {footerChips.map(chip)}
            {moreChips}
          </Box>
        )}
      </Box>
    )
  })
}
