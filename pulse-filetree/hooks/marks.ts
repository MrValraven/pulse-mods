import type { FileNode } from '../types'
import { compareNodes, inside } from './tree'

// The pure parts of the pane's marks: the gutter bar and the cursor, files Claude touched outside
// the tree's folder, deleted files kept as ghost rows, the right column cycle and the row keys.

export type TouchKind = 'read' | 'write'

export const SUBAGENT_READ_TONE = 'subagent read'
export const SUBAGENT_WRITE_TONE = 'subagent write'

// The tone a touch shimmers in: purple reads and orange writes on the main loop, lilac for both
// in a subagent.
export function touchTone(kind: TouchKind, isSubagent: boolean): string {
  if (isSubagent) return kind === 'read' ? SUBAGENT_READ_TONE : SUBAGENT_WRITE_TONE
  return kind === 'read' ? 'purple' : 'orange'
}

export function isReadTone(tone: string): boolean {
  return tone === 'purple' || tone === SUBAGENT_READ_TONE
}

export function isSubagentTone(tone: string): boolean {
  return tone === SUBAGENT_READ_TONE || tone === SUBAGENT_WRITE_TONE
}

// A read draws a thin bar and a write a thick one, so the two differ by shape as well as colour.
// A subagent's draw dashed: thin dashed for a read, heavy dashed for a write, so they stand
// apart from the main loop's solid bars even where both are lilac.
export const READ_BAR = '▏'
export const WRITE_BAR = '▌'
export const SUBAGENT_READ_BAR = '╎'
export const SUBAGENT_WRITE_BAR = '┇'

export function barFor(kind: TouchKind, isSubagent = false): string {
  if (isSubagent) return kind === 'read' ? SUBAGENT_READ_BAR : SUBAGENT_WRITE_BAR
  return kind === 'read' ? READ_BAR : WRITE_BAR
}

export const CURSOR_MARK = '›'

// What the one gutter cell shows. The cursor marker always wins its row; a shimmer or a recent
// touch gives way to it and shows on every other row.
export type GutterInput = {
  isCursor: boolean
  lit: { tone: string; isDim: boolean } | null
  recent: { tone: string; step: 0 | 1 | 2 } | null
}
export type Gutter =
  | { glyph: string; ink: 'accent' }
  | { glyph: string; ink: 'touch'; tone: string; strength: 'bright' | 'dim' | 'soft' | 'faint' }
  | { glyph: ' '; ink: 'none' }

export function gutterMark(input: GutterInput): Gutter {
  if (input.isCursor) return { glyph: CURSOR_MARK, ink: 'accent' }
  if (input.lit) {
    const kind: TouchKind = isReadTone(input.lit.tone) ? 'read' : 'write'
    return { glyph: barFor(kind, isSubagentTone(input.lit.tone)), ink: 'touch', tone: input.lit.tone, strength: input.lit.isDim ? 'dim' : 'bright' }
  }
  if (input.recent && input.recent.step > 0) {
    const kind: TouchKind = isReadTone(input.recent.tone) ? 'read' : 'write'
    return { glyph: barFor(kind, isSubagentTone(input.recent.tone)), ink: 'touch', tone: input.recent.tone, strength: input.recent.step === 2 ? 'soft' : 'faint' }
  }
  return { glyph: ' ', ink: 'none' }
}

// Files Claude read or wrote outside the tree's folder.
export const OUTSIDE_LIMIT = 20

export type OutsideTouch = { path: string; kind: TouchKind; at: number; isSubagent: boolean }

// Adds touches to the list, newest first, one entry a path and at most `limit`. A path written
// and later only read keeps its write mark.
export function recordOutside(list: readonly OutsideTouch[], touches: readonly OutsideTouch[], limit = OUTSIDE_LIMIT): OutsideTouch[] {
  const byPath = new Map<string, OutsideTouch>()
  for (const touch of list) byPath.set(touch.path, touch)
  for (const touch of touches) {
    const previous = byPath.get(touch.path)
    const kind: TouchKind = touch.kind === 'write' || previous?.kind === 'write' ? 'write' : 'read'
    const isNewer = !previous || touch.at >= previous.at
    const newest = isNewer ? touch : previous
    byPath.set(touch.path, { path: touch.path, kind, at: newest.at, isSubagent: newest.isSubagent })
  }
  return [...byPath.values()].sort((first, second) => second.at - first.at).slice(0, limit)
}

// The entries that are still outside the folder the tree shows now.
export function outsideOf(list: readonly OutsideTouch[], root: string): OutsideTouch[] {
  return root ? list.filter(touch => !inside(root, touch.path)) : [...list]
}

// System paths a Bash reader names that are no files worth listing.
export function isListable(path: string): boolean {
  return path !== '/' && !/^\/(dev|proc|sys)(\/|$)/.test(path)
}

export function homeRelative(path: string, home: string): string {
  if (!home) return path
  if (path === home) return '~'
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

// A file Claude deleted stays this long as a faded, struck-through row.
export const GHOST_MS = 90_000
export const GHOST_PREFIX = 'deleted:'

export type Ghost = { node: FileNode; at: number }

export function liveGhosts(ghosts: readonly Ghost[], now: number): Ghost[] {
  return ghosts.filter(ghost => now - ghost.at < GHOST_MS)
}

// When the next ghost row ends, or null with none left.
export function nextGhostEnd(ghosts: readonly Ghost[], now: number): number | null {
  let next: number | null = null
  for (const ghost of liveGhosts(ghosts, now)) {
    const end = ghost.at + GHOST_MS
    if (next === null || end < next) next = end
  }
  return next
}

// The tree's nodes with each ghost back among its siblings, in listing order. A ghost whose path
// is in the tree again (the file came back) is left out.
export function withGhosts(nodes: readonly FileNode[], ghosts: readonly Ghost[]): FileNode[] {
  if (ghosts.length === 0) return [...nodes]
  const present = new Set(nodes.map(node => node.id))
  const out = [...nodes]
  for (const ghost of ghosts) {
    if (present.has(ghost.node.id)) continue
    const ghostNode: FileNode = { ...ghost.node, loaded: false }
    let insertAt = -1
    let lastSibling = -1
    for (let index = 0; index < out.length; index++) {
      const node = out[index] as FileNode
      if (node.parent !== ghostNode.parent) continue
      lastSibling = index
      if (insertAt < 0 && compareNodes(ghostNode, node) < 0) insertAt = index
    }
    if (insertAt < 0) insertAt = lastSibling >= 0 ? lastSibling + 1 : out.length
    out.splice(insertAt, 0, ghostNode)
    present.add(ghostNode.id)
  }
  return out
}

// The right column cycles date, age, size with `s`.
export type ColumnMode = 'date' | 'age' | 'size'

export function nextColumn(mode: ColumnMode): ColumnMode {
  return mode === 'date' ? 'age' : mode === 'age' ? 'size' : 'date'
}

// Keys the rows take beside moving and opening.
export type RowKeyAction = 'dotfiles' | 'column' | 'collapse' | 'reload' | 'up' | 'search'

const ROW_KEYS: Record<string, RowKeyAction> = {
  '.': 'dotfiles',
  s: 'column',
  c: 'collapse',
  r: 'reload',
  u: 'up',
  backspace: 'up',
  '/': 'search',
}

export function rowKeyAction(key: string, isCtrl = false): RowKeyAction | null {
  if (isCtrl) return null
  return ROW_KEYS[key] ?? null
}
