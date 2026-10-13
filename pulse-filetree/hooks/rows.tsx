import type { ClientModule, RenderElement } from 'claude-code'

// role marks two segments: the folder caret, drawn in the accent while its folder unfolds, and
// the file or folder icon, reserved for icon styling.
export type Seg = { t: string; c?: string; b?: boolean; s?: boolean; i?: boolean; sh?: string; dim?: boolean; one?: boolean; spin?: boolean; bg?: string; tab?: string; role?: 'caret' | 'icon' }
export type RowSpec = { id: string; left: Seg[]; right: Seg[] }
export type RowsProps = {
  rows: RowSpec[]
  active: string
  activeBg: string
  hoverBg: string
  tones: Record<string, { bright: string[]; dim: string[] }>
  spinner?: string[]
  pointer?: boolean
  bar?: { pos: number; size: number; thumb: string; track: string }
  preview?: { text: string; path: string; startLine: number; markdown: boolean }
  accent?: string
}
export type Transition = { kind: 'insert' | 'remove' | 'snap'; start: number; count: number }
type Motion = Transition & { firstFrame: number; ghosts: RowSpec[]; spare: RowSpec[]; limit: number }
type Ref = { stop?: () => void; unpoint?: () => void; stopFrames?: () => void; lastRows?: RowSpec[]; lastKey?: string; wasWindowed?: boolean; motion?: Motion }
type Local = { phase: number; frame: number; drag: boolean; ref: Ref }
// A ghost row is drawn yet no longer in the tree; a faded one draws dim while it arrives or leaves.
type DrawnRow = { row: RowSpec; isGhost: boolean; isFaded: boolean; isAnchor: boolean }

const TICK_MS = 90
const FRAME_MS = 33
const INSERT_FRAMES = 6
const REMOVE_FRAMES = 5
const FRESH_FRAMES = 2
const MAX_ANIMATED_ROWS = 80
const TREE_BUDGET = 70_000
const MAX_ROWS = 1_500
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const isInside = (folder: string, id: string) => folder !== '' && id !== folder && (id.startsWith(folder.endsWith('/') ? folder : `${folder}/`) || id.startsWith(`${folder}\\`))

// Rows `withBlock` holds at `start` that `withoutBlock` lacks, all inside the anchor folder and with the
// rows after them unchanged; 0 for any other change. A scrolled window may cut or extend its tail.
function blockAfter(anchor: string, start: number, withoutBlock: readonly string[], withBlock: readonly string[], isWindowed: boolean): number {
  const known = new Set(withoutBlock)
  let end = start
  while (end < withBlock.length && !known.has(withBlock[end] as string)) {
    if (!isInside(anchor, withBlock[end] as string)) return 0
    end++
  }
  const count = end - start
  const tailWith = withBlock.length - end
  const tailWithout = withoutBlock.length - start
  if (count === 0 || count > MAX_ANIMATED_ROWS) return 0
  if (isWindowed ? tailWithout < tailWith : tailWithout !== tailWith) return 0
  for (let offset = 0; offset < tailWith; offset++) {
    if (withBlock[end + offset] !== withoutBlock[start + offset]) return 0
  }
  return count
}

// One folder unfolding or folding shows as a single block of its descendants appearing or leaving right
// under it; anything else (first draw, scrolling, search, reloads, reorders) snaps.
export function planTransition(previousIds: readonly string[] | undefined, nextIds: readonly string[], isWindowed = false): Transition {
  const snap: Transition = { kind: 'snap', start: 0, count: 0 }
  if (!previousIds || previousIds.length === 0 || nextIds.length === 0) return snap
  let shared = 0
  while (shared < previousIds.length && shared < nextIds.length && previousIds[shared] === nextIds[shared]) shared++
  const anchor = shared > 0 ? (previousIds[shared - 1] as string) : ''
  if (!anchor) return snap
  const inserted = blockAfter(anchor, shared, previousIds, nextIds, isWindowed)
  if (inserted > 0) return { kind: 'insert', start: shared, count: inserted }
  const removed = blockAfter(anchor, shared, nextIds, previousIds, isWindowed)
  if (removed > 0) return { kind: 'remove', start: shared, count: removed }
  return snap
}

// The rows drawn on one frame of a motion, and whether the motion has run its course.
function frameRows(rows: RowSpec[], motion: Motion, elapsed: number): { drawnRows: DrawnRow[]; isDone: boolean } {
  const plain = (row: RowSpec): DrawnRow => ({ row, isGhost: false, isFaded: false, isAnchor: false })
  const head = rows.slice(0, motion.start).map((row, index) => ({ ...plain(row), isAnchor: index === motion.start - 1 }))
  if (motion.kind === 'insert') {
    const perFrame = Math.max(1, Math.ceil(motion.count / INSERT_FRAMES))
    const revealed = Math.min(motion.count, (elapsed + 1) * perFrame)
    const block = rows.slice(motion.start, motion.start + revealed).map((row, index) => ({ ...plain(row), isFaded: elapsed - Math.floor(index / perFrame) < FRESH_FRAMES }))
    const tail = rows.slice(motion.start + motion.count).map(plain)
    // Rows the unfolding pushed out of a scrolled window stay until the block has filled their room.
    const spare = motion.spare.map(row => ({ ...plain(row), isGhost: true }))
    const isDone = elapsed >= Math.ceil(motion.count / perFrame) - 1 + FRESH_FRAMES
    return { drawnRows: [...head, ...block, ...tail, ...spare].slice(0, motion.limit), isDone }
  }
  const perFrame = Math.max(1, Math.ceil(motion.count / REMOVE_FRAMES))
  const remaining = Math.max(0, motion.count - elapsed * perFrame)
  const ghosts = motion.ghosts.slice(0, remaining).map(row => ({ ...plain(row), isGhost: true, isFaded: true }))
  const tail = rows.slice(motion.start).map(plain)
  return { drawnRows: [...head, ...ghosts, ...tail].slice(0, motion.limit), isDone: remaining === 0 }
}

// A soft band of the tone's lighter shades that sweeps along the name while Claude is on it.
function shimmer(i: number, phase: number, len: number, palette: string[]): string {
  const band = ((phase * 1.2) % (len + 8)) - 4
  const d = Math.abs(i - band)
  return palette[d < 0.8 ? 3 : d < 1.8 ? 2 : d < 2.8 ? 1 : 0] ?? palette[0] ?? '#f97316'
}

const Rows: ClientModule<RowsProps, Local> = (props, surface) => {
  const { Box, Text } = surface.elements
  let state = surface.state
  if (state === undefined) {
    state = { phase: 0, frame: 0, drag: false, ref: {} }
    surface.setState(state)
  }
  const ref = state.ref
  // A state kept from an older build of this module may lack the frame counter.
  const frame = state.frame || 0
  const lit = props.rows.some(r => r.left.some(s => s.sh || s.spin) || r.right.some(s => s.sh || s.spin))
  if (lit && !ref.stop) {
    ref.stop = surface.every(TICK_MS, () => {
      const cur = surface.state
      if (cur) surface.setState({ ...cur, phase: cur.phase + 1 })
    })
  } else if (!lit && ref.stop) {
    ref.stop()
    ref.stop = undefined
  }
  const finishMotion = () => {
    ref.motion = undefined
    ref.stopFrames?.()
    ref.stopFrames = undefined
  }
  // New props compare against the last props: a running motion snaps to its end before the next is planned.
  const ids = props.rows.map(r => r.id)
  const idsKey = ids.join('\n')
  // A window that gains or loses its scrollbar in this change still cuts or extends its tail.
  const isWindowed = Boolean(props.bar) || Boolean(ref.wasWindowed)
  if (props.preview) {
    finishMotion()
    ref.lastRows = undefined
    ref.lastKey = undefined
  } else if (idsKey !== ref.lastKey) {
    finishMotion()
    const lastRows = ref.lastRows ?? []
    const plan = planTransition(ref.lastRows?.map(r => r.id), ids, isWindowed)
    if (plan.kind !== 'snap') {
      const ghosts = plan.kind === 'remove' ? lastRows.slice(plan.start, plan.start + plan.count) : []
      const spare = plan.kind === 'insert' && isWindowed ? lastRows.slice(ids.length - plan.count) : []
      // A scrolled window keeps its height while the block moves through it.
      ref.motion = { ...plan, firstFrame: frame, ghosts, spare, limit: isWindowed ? ids.length : Number.MAX_SAFE_INTEGER }
      ref.stopFrames = surface.every(FRAME_MS, () => {
        const cur = surface.state
        if (cur) surface.setState({ ...cur, frame: (cur.frame || 0) + 1 })
      })
    }
    ref.lastKey = idsKey
  }
  if (!props.preview) ref.lastRows = props.rows
  ref.wasWindowed = Boolean(props.bar)
  let drawnRows: DrawnRow[] = props.rows.map(row => ({ row, isGhost: false, isFaded: false, isAnchor: false }))
  if (ref.motion) {
    const next = frameRows(props.rows, ref.motion, frame - ref.motion.firstFrame)
    if (next.isDone) finishMotion()
    else drawnRows = next.drawnRows
  }
  let visible = drawnRows.length
  if (props.pointer === false) {
    ref.unpoint?.()
    ref.unpoint = undefined
  } else ref.unpoint = surface.onPointer(e => {
    const cur = surface.state ?? state
    const span = Math.max(1, props.rows.length - 1)
    const onBar = Boolean(props.bar) && e.x >= surface.columns - 1
    if (props.bar && (cur.drag || (onBar && e.type === 'down' && (e.button ?? 'left') === 'left'))) {
      if (e.type === 'up' || e.type === 'leave') {
        surface.setState({ ...cur, drag: false })
        return
      }
      if (e.type === 'down' || e.type === 'move') {
        if (!cur.drag) surface.setState({ ...cur, drag: true })
        surface.post({ scrollTo: Math.max(0, Math.min(1, e.y / span)) })
        return
      }
    }
    if (e.type === 'leave' || e.y < 0 || e.y >= visible) return
    // Ghost rows are leaving the tree, so a press on one lands nowhere.
    const drawnRow = drawnRows[e.y]
    if (!drawnRow || drawnRow.isGhost) return
    const row = drawnRow.row
    if (e.type === 'down' && e.button === 'right' && row.id) {
      surface.post({ copy: row.id, shift: Boolean(e.shift) })
      return
    }
    if (e.type !== 'down' || (e.button ?? 'left') !== 'left') return
    let x = 0
    for (const seg of row.left) {
      const w = [...seg.t].length
      if (seg.tab && e.x >= x && e.x < x + w) {
        surface.post({ tab: seg.tab })
        return
      }
      x += w
    }
    if (row.id) surface.post({ press: row.id, ctrl: Boolean(e.ctrl), shift: Boolean(e.shift) })
  })
  surface.onKey(e => surface.post({ key: e.key, ctrl: Boolean(e.ctrl), shift: Boolean(e.shift) }))
  // The preview draws in this same element, so the focus a click gave the tree stays put.
  if (props.preview) {
    const { Markdown, Code } = surface.elements
    const p = props.preview
    return p.markdown ? <Markdown text={p.text} /> : <Code source={p.text} path={p.path} startLine={p.startLine} wrap="truncate-end" />
  }
  const frames = props.spinner?.length ? props.spinner : FRAMES
  // A row fading in or out draws its text dim and steady; chips keep their full colour so the fill stays even.
  const draw = (s: Seg, isDim: boolean, isAnchor: boolean) => {
    const color = isAnchor && s.role === 'caret' ? (props.accent ?? s.c) : s.c
    const tail = s.spin ? (frames[state.phase % frames.length] ?? '') : ''
    if (s.spin && !isDim) {
      return (
        <Text color={color} bold={s.b}>
          {s.t + tail}
        </Text>
      )
    }
    const palette = s.sh ? (s.dim ? props.tones[s.sh]?.dim : props.tones[s.sh]?.bright) : undefined
    if (!palette || isDim) {
      return (
        <Text color={color ?? palette?.[0]} backgroundColor={s.bg} bold={s.b} strikethrough={s.s} italic={s.i} dimColor={isDim && !s.bg ? true : undefined}>
          {s.t + tail}
        </Text>
      )
    }
    if (s.one) {
      return (
        <Text color={shimmer(-1, state.phase, s.t.length, palette)}>
          {s.t}
        </Text>
      )
    }
    const chars = [...s.t]
    return (
      <Text bold={s.b}>
        {chars.map((ch, i) => (
          <Text color={shimmer(i, state.phase, chars.length, palette)}>{ch}</Text>
        ))}
      </Text>
    )
  }
  // Each real row is a keyed Box, so the surface lights it under the pointer with no round trip here.
  const keys = new Set<string>()
  const rowEl = (drawnRow: DrawnRow, i: number) => {
    const r = drawnRow.row
    const isActive = Boolean(r.id) && r.id === props.active && !drawnRow.isGhost
    const hasKey = Boolean(r.id) && !drawnRow.isGhost && !keys.has(r.id)
    if (hasKey) keys.add(r.id)
    return (
      <Box
        {...(hasKey ? { key: r.id } : {})}
        {...(hasKey && !isActive ? { hover: { backgroundColor: props.hoverBg } } : {})}
        flexDirection="row"
        height={1}
        overflow="hidden"
        backgroundColor={isActive ? props.activeBg : undefined}
      >
        <Box flexShrink={1} overflow="hidden">
          {r.left.map(s => draw(s, drawnRow.isFaded, drawnRow.isAnchor))}
        </Box>
        <Box flexGrow={1} />
        <Box flexDirection="row" flexShrink={0}>
          {r.right.map(s => draw(s, drawnRow.isFaded, false))}
        </Box>
        {props.bar && (
          <Text color={i >= props.bar.pos && i < props.bar.pos + props.bar.size ? props.bar.thumb : props.bar.track}>
            {i >= props.bar.pos && i < props.bar.pos + props.bar.size ? '┃' : '│'}
          </Text>
        )}
      </Box>
    )
  }
  const drawn: RenderElement[] = []
  let size = 0
  for (let i = 0; i < drawnRows.length; i++) {
    const el = rowEl(drawnRows[i] as DrawnRow, i)
    let cost = 1_000
    try {
      cost = JSON.stringify(el).length
    } catch {}
    if (size + cost > TREE_BUDGET || drawn.length >= MAX_ROWS) {
      visible = i
      drawn.push(<Text dimColor>{`  … ${drawnRows.length - i} more rows, collapse folders or use search`}</Text>)
      break
    }
    size += cost
    drawn.push(el)
  }
  return <Box flexDirection="column">{drawn}</Box>
}

export default Rows
