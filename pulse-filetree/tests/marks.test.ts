import { expect, test } from 'claude-code/testing'
import type { FileNode } from '../types'
import { backgroundCause, bashFailureCause, causeOf, copyFailure, countsLegend, exitCause, helpText, isMissingCause, pathCheckReply, runningChips, SETTINGS, startBlockedReason } from '../hooks/copy'
import { removedTargets } from '../hooks/git'
import {
  CURSOR_MARK,
  GHOST_MS,
  gutterMark,
  homeRelative,
  liveGhosts,
  nextColumn,
  nextGhostEnd,
  outsideOf,
  barFor,
  READ_BAR,
  recordOutside,
  SUBAGENT_READ_BAR,
  SUBAGENT_WRITE_BAR,
  rowKeyAction,
  touchTone,
  withGhosts,
  WRITE_BAR,
} from '../hooks/marks'
import { planFadedRemoval, type RowSpec, specCost } from '../hooks/rows'
import { parseGit, rollCounts } from '../hooks/tree'

const node = (id: string, kind: 'file' | 'dir' = 'file'): FileNode => {
  const slash = id.lastIndexOf('/')
  return { id, parent: id.slice(0, slash) || '/', name: id.slice(slash + 1), kind, hidden: false, mtime: 0, size: 0, loaded: false }
}

test('path check replies: a missing path opens nothing, a file opens its folder', () => {
  expect(pathCheckReply('missing', '~/nope')).toBe('No folder at ~/nope')
  expect(pathCheckReply('file', '~/proj/a.ts', '~/proj')).toBe('~/proj/a.ts is a file, so the tree opens its folder ~/proj.')
  expect(pathCheckReply('unreadable', '~/locked', "EACCES: permission denied, stat '/home/k/locked'")).toBe("Could not read ~/locked: EACCES: permission denied, stat '/home/k/locked'")
  expect(isMissingCause("ENOENT: no such file or directory, stat '/home/k/nope'")).toBe(true)
  expect(isMissingCause("EACCES: permission denied, stat '/home/k/locked'")).toBe(false)
})

test('error copy names the cause', () => {
  expect(copyFailure('no-clipboard')).toBe('File tree: could not copy the path: no clipboard tool took the text')
  expect(copyFailure('no-surface')).toContain('no screen')
  expect(copyFailure('refused')).toContain('a plugin refused the copy')
  expect(bashFailureCause('Exit code 128\nfatal: could not read Username for https://github.com\n')).toBe('exit 128, fatal: could not read Username for https://github.com')
  expect(bashFailureCause('Exit code 1')).toBe('exit 1')
  expect(bashFailureCause('')).toBe('the command reported an error with no output')
  expect(bashFailureCause('anything', true)).toBe('interrupted before it finished')
  expect(backgroundCause('failed', 'Background command "git pull" failed with exit code 1')).toBe('exit 1')
  expect(backgroundCause('killed', '')).toBe('background task killed')
  expect(exitCause({ exitCode: 7, stderr: '\n  gio: no handler\nmore' })).toBe('exit 7, gio: no handler')
  expect(exitCause({ exitCode: 1, stderr: '' })).toBe('exit 1')
  expect(causeOf(new Error('spawn git ENOENT\nstack'))).toBe('spawn git ENOENT')
  expect(causeOf(undefined)).toBe('undefined')
  expect(startBlockedReason({ columns: 80, isFullscreen: true })).toContain('80 columns wide and the sidebar needs 110')
  expect(startBlockedReason({ columns: 200, isFullscreen: false })).toContain('/tui fullscreen')
})

test('the outside-folder list: newest first, one entry a path, at most 20, a write keeps its mark', () => {
  let list = recordOutside([], [{ path: '/home/k/notes/a.md', kind: 'write', at: 1, isSubagent: false }])
  list = recordOutside(list, [{ path: '/home/k/notes/a.md', kind: 'read', at: 2, isSubagent: true }])
  expect(list).toEqual([{ path: '/home/k/notes/a.md', kind: 'write', at: 2, isSubagent: true }])
  list = recordOutside(list, [{ path: '/etc/hosts', kind: 'read', at: 3, isSubagent: false }])
  expect(list.map(touch => touch.path)).toEqual(['/etc/hosts', '/home/k/notes/a.md'])
  const many = Array.from({ length: 30 }, (_, index) => ({ path: `/tmp/f${index}`, kind: 'read' as const, at: 10 + index, isSubagent: false }))
  const capped = recordOutside(list, many)
  expect(capped.length).toBe(20)
  expect(capped[0]?.path).toBe('/tmp/f29')
  expect(outsideOf(list, '/home/k/notes').map(touch => touch.path)).toEqual(['/etc/hosts'])
  expect(homeRelative('/home/k/notes/a.md', '/home/k')).toBe('~/notes/a.md')
  expect(homeRelative('/home/kate/a.md', '/home/k')).toBe('/home/kate/a.md')
})

test('ghost rows sit among their siblings in listing order and end after 90 seconds', () => {
  const nodes = [node('/r/src', 'dir'), node('/r/a.ts'), node('/r/c.ts'), node('/r/src/x.ts')]
  const ghosts = [{ node: node('/r/b.ts'), at: 1_000 }]
  expect(withGhosts(nodes, ghosts).map(entry => entry.id)).toEqual(['/r/src', '/r/a.ts', '/r/b.ts', '/r/c.ts', '/r/src/x.ts'])
  // A file that came back is drawn once, as itself.
  expect(withGhosts([...nodes, node('/r/b.ts')], ghosts).filter(entry => entry.id === '/r/b.ts').length).toBe(1)
  // A ghost folder goes before the files.
  expect(withGhosts(nodes, [{ node: node('/r/lib', 'dir'), at: 0 }]).map(entry => entry.id).slice(0, 2)).toEqual(['/r/lib', '/r/src'])
  expect(liveGhosts(ghosts, 1_000 + GHOST_MS - 1).length).toBe(1)
  expect(liveGhosts(ghosts, 1_000 + GHOST_MS).length).toBe(0)
  expect(nextGhostEnd(ghosts, 2_000)).toBe(1_000 + GHOST_MS)
  expect(nextGhostEnd(ghosts, 1_000 + GHOST_MS)).toBe(null)
})

test('a ghost row leaving fades out as a block; other removals snap', () => {
  const before = [{ id: '/r/a' }, { id: 'deleted:/r/b', isFaded: true }, { id: '/r/c' }]
  expect(planFadedRemoval(before, ['/r/a', '/r/c'])).toEqual({ kind: 'remove', start: 1, count: 1 })
  expect(planFadedRemoval([{ id: '/r/a' }, { id: '/r/b' }, { id: '/r/c' }], ['/r/a', '/r/c'])).toEqual({ kind: 'snap', start: 0, count: 0 })
  expect(planFadedRemoval(before, ['/r/a', '/r/x'])).toEqual({ kind: 'snap', start: 0, count: 0 })
})

test('rm, unlink, git rm and Remove-Item name the paths a command deletes', () => {
  expect(removedTargets('rm -rf build a.txt', '/r')).toEqual(['/r/build', '/r/a.txt'])
  expect(removedTargets('cd src && rm -- -odd.ts', '/r')).toEqual(['/r/src/-odd.ts'])
  expect(removedTargets('git rm --cached old.ts', '/r')).toEqual(['/r/old.ts'])
  expect(removedTargets('rm *.log; unlink ~/tmp/x', '/r', '/home/k')).toEqual(['/home/k/tmp/x'])
  expect(removedTargets('Remove-Item -Recurse dist', '/r')).toEqual(['/r/dist'])
  expect(removedTargets('cat a.txt', '/r')).toEqual([])
})

test('the row keys', () => {
  expect(rowKeyAction('.')).toBe('dotfiles')
  expect(rowKeyAction('s')).toBe('column')
  expect(rowKeyAction('c')).toBe('collapse')
  expect(rowKeyAction('r')).toBe('reload')
  expect(rowKeyAction('u')).toBe('up')
  expect(rowKeyAction('backspace')).toBe('up')
  expect(rowKeyAction('/')).toBe('search')
  expect(rowKeyAction('r', true)).toBe(null)
  expect(rowKeyAction('j')).toBe(null)
  // Only Backspace goes up.
  expect(rowKeyAction('delete')).toBe(null)
  expect(nextColumn('date')).toBe('age')
  expect(nextColumn('age')).toBe('size')
  expect(nextColumn('size')).toBe('date')
})

test('staged-added files count as A, untracked ones as ?', () => {
  const status = parseGit('## main\0A  src/new.ts\0?? notes.md\0 M src/a.ts\0 D gone.ts\0', '/r', '')
  expect(status.files).toEqual({ '/r/src/new.ts': 'add', '/r/notes.md': 'new', '/r/src/a.ts': 'mod', '/r/gone.ts': 'del' })
  expect(status.git['/r/src/new.ts']).toBe('A')
  const counts = rollCounts(status.files, '/r')
  expect(counts['/r']).toEqual([1, 1, 1, 1])
  expect(counts['/r/src']).toEqual([0, 1, 0, 1])
  expect(countsLegend(counts['/r'])).toBe('?1 untracked, A1 staged as added, M1 modified, D1 deleted')
  expect(countsLegend([2, 0, 0])).toBe('?2 untracked')
  expect(countsLegend(undefined)).toBe('clean: every file matches HEAD')
})

test('the cursor marker wins its row; reads draw a thin bar and writes a thick one', () => {
  expect(gutterMark({ isCursor: true, lit: { tone: 'orange', isDim: false }, recent: { tone: 'purple', step: 2 } })).toEqual({ glyph: CURSOR_MARK, ink: 'accent' })
  expect(gutterMark({ isCursor: false, lit: { tone: 'purple', isDim: false }, recent: null })).toEqual({ glyph: READ_BAR, ink: 'touch', tone: 'purple', strength: 'bright' })
  expect(gutterMark({ isCursor: false, lit: { tone: 'orange', isDim: true }, recent: null })).toEqual({ glyph: WRITE_BAR, ink: 'touch', tone: 'orange', strength: 'dim' })
  expect(gutterMark({ isCursor: false, lit: null, recent: { tone: 'subagent read', step: 1 } })).toEqual({ glyph: SUBAGENT_READ_BAR, ink: 'touch', tone: 'subagent read', strength: 'faint' })
  expect(gutterMark({ isCursor: false, lit: { tone: 'subagent write', isDim: false }, recent: null })).toEqual({ glyph: SUBAGENT_WRITE_BAR, ink: 'touch', tone: 'subagent write', strength: 'bright' })
  // A subagent's bars differ from the main loop's by shape, and still read thin and thick.
  expect(new Set([barFor('read'), barFor('write'), barFor('read', true), barFor('write', true)]).size).toBe(4)
  expect(gutterMark({ isCursor: false, lit: null, recent: { tone: 'green', step: 0 } })).toEqual({ glyph: ' ', ink: 'none' })
  expect(touchTone('read', false)).toBe('purple')
  expect(touchTone('write', true)).toBe('subagent write')
})

test('the footer shows three running chips and counts the rest', () => {
  expect(runningChips(['a', 'b'])).toEqual({ shown: ['a', 'b'], more: 0 })
  expect(runningChips(['a', 'b', 'c', 'd', 'e'])).toEqual({ shown: ['a', 'b', 'c'], more: 2 })
})

test("specCost is the row spec's exact serialized length, escapes included", () => {
  const specs: RowSpec[] = [
    { id: '/Users/someone/projects/a-long-project-name/src/components/Widget.tsx', left: [{ t: '›', c: '#cc6448' }, { t: '│ │ ', c: 'subtle' }, { t: '  ', c: 'inactive' }, { t: 'TS', c: '#ffffff', bg: '#3a62a8', b: true, role: 'icon' }, { t: ' ' }, { t: 'Widget.tsx', c: 'warning' }], right: [{ t: '  +12 -3', c: 'success' }, { t: ' M', c: 'warning', b: true }] },
    { id: '/r/src/handler.ts', left: [{ t: '▌', c: '#cc6448' }, { t: 'handler.ts', sh: 'orange', b: true, dim: false }], right: [] },
    { id: 'deleted:/r/a"b\nc.ts', isFaded: true, left: [{ t: 'a"b\nc.ts', c: 'inactive', s: true }], right: [{ t: '  ' }] },
  ]
  for (const spec of specs) expect(specCost(spec)).toBe(JSON.stringify(spec).length)
})

test('/filetree help lists the keys, the selection note and each setting by title and key', () => {
  const help = helpText()
  for (const key of ['u or Backspace', 'r: reload', '.: show or hide dotfiles', 's: cycle', 'c: collapse', 'y: copy', '/: move to the search field']) expect(help).toContain(key)
  expect(help).toContain('the selected file is sent with your prompts')
  expect(help).toContain('Settings (/config, pulse-filetree):')
  for (const [title, key] of SETTINGS) expect(help).toContain(`  ${title} (${key})`)
  expect(help).toContain('Open with (open)')
})
