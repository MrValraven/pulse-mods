import { expect, test } from 'claude-code/testing'
import { planTransition } from '../hooks/rows'

const snap = { kind: 'snap', start: 0, count: 0 }
const childrenOf = (folder: string, count: number) => Array.from({ length: count }, (_, index) => `${folder}/f${String(index).padStart(3, '0')}.txt`)

test('unfolding a folder plans one inserted block right under it', () => {
  const before = ['/r/a', '/r/b', '/r/c']
  expect(planTransition(before, ['/r/a', '/r/b', '/r/b/x', '/r/b/y', '/r/c'])).toEqual({ kind: 'insert', start: 2, count: 2 })
  // Remembered open subfolders unfold with it as one block.
  expect(planTransition(before, ['/r/a', '/r/b', '/r/b/x', '/r/b/x/1', '/r/b/y', '/r/c'])).toEqual({ kind: 'insert', start: 2, count: 4 })
  expect(planTransition(['/r/a', '/r/b'], ['/r/a', '/r/b', '/r/b/x'])).toEqual({ kind: 'insert', start: 2, count: 1 })
  expect(planTransition(['C:\\r\\a', 'C:\\r\\b'], ['C:\\r\\a', 'C:\\r\\a\\x', 'C:\\r\\b'])).toEqual({ kind: 'insert', start: 1, count: 1 })
})

test('folding a folder plans one removed block right under it', () => {
  const after = ['/r/a', '/r/b', '/r/c']
  expect(planTransition(['/r/a', '/r/b', '/r/b/x', '/r/b/y', '/r/c'], after)).toEqual({ kind: 'remove', start: 2, count: 2 })
  expect(planTransition(['/r/a', '/r/b', '/r/c', '/r/c/x'], after)).toEqual({ kind: 'remove', start: 3, count: 1 })
})

test('the first draw and an empty side snap', () => {
  expect(planTransition(undefined, ['/r/a', '/r/b'])).toEqual(snap)
  expect(planTransition([], ['/r/a', '/r/b'])).toEqual(snap)
  expect(planTransition(['/r/a', '/r/a/x'], [])).toEqual(snap)
  expect(planTransition(['/r/a', '/r/b'], ['/r/a', '/r/b'])).toEqual(snap)
})

test('scrolling by one row snaps, windowed or whole', () => {
  const before = ['/r/a', '/r/b', '/r/c', '/r/d']
  const after = ['/r/b', '/r/c', '/r/d', '/r/e']
  expect(planTransition(before, after)).toEqual(snap)
  expect(planTransition(before, after, true)).toEqual(snap)
  expect(planTransition(after, before, true)).toEqual(snap)
})

test('a reorder, two changed blocks or rows outside the anchor folder snap', () => {
  expect(planTransition(['/r', '/r/a', '/r/b'], ['/r', '/r/b', '/r/a'])).toEqual(snap)
  expect(planTransition(['/r/a', '/r/b', '/r/c'], ['/r/a', '/r/b', '/r/b/x', '/r/c', '/r/c/y'])).toEqual(snap)
  // A sibling showing up is no unfolding.
  expect(planTransition(['/r/a', '/r/c'], ['/r/a', '/r/b', '/r/c'])).toEqual(snap)
  // A note row (empty id) anchors nothing.
  expect(planTransition(['/r/a', '', '/r/b'], ['/r/a', '', '/r/x', '/r/b'])).toEqual(snap)
})

test('blocks past 80 rows snap', () => {
  expect(planTransition(['/r/big', '/r/z'], ['/r/big', ...childrenOf('/r/big', 80), '/r/z'])).toEqual({ kind: 'insert', start: 1, count: 80 })
  expect(planTransition(['/r/big', '/r/z'], ['/r/big', ...childrenOf('/r/big', 81), '/r/z'])).toEqual(snap)
  expect(planTransition(['/r/big', ...childrenOf('/r/big', 81), '/r/z'], ['/r/big', '/r/z'])).toEqual(snap)
})

test('a scrolled window may cut its tail on unfold and extend it on fold', () => {
  const before = ['/r/a', '/r/b', '/r/c', '/r/d']
  const unfolded = ['/r/a', '/r/a/1', '/r/a/2', '/r/b']
  expect(planTransition(before, unfolded, true)).toEqual({ kind: 'insert', start: 1, count: 2 })
  expect(planTransition(before, unfolded)).toEqual(snap)
  expect(planTransition(unfolded, before, true)).toEqual({ kind: 'remove', start: 1, count: 2 })
  expect(planTransition(unfolded, before)).toEqual(snap)
  // The block alone may fill the whole window below its folder.
  expect(planTransition(['/r/a', '/r/b', '/r/c'], ['/r/a', '/r/a/1', '/r/a/2'], true)).toEqual({ kind: 'insert', start: 1, count: 2 })
})
