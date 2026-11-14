// The pane's messages that carry a cause: replies, toasts, footer details and empty states.
// Every failure names what failed and why, so none of them reads as a bare "failed".

// The terminal width the sidebar needs, for /filetree and for opening at start.
export const MIN_COLUMNS = 110

export const SELECTED_SUFFIX = ', sent with your prompts'

// Every toast the pane raises starts with this, so a toast says which mod it came from.
export const TOAST_PREFIX = 'File tree: '

// The first line of a message that holds any text, trimmed.
export function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map(line => line.trim())
      .find(Boolean) ?? ''
  )
}

// What a thrown value says, in one line.
export function causeOf(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : String(error)
  return firstLine(message) || 'it threw with no message'
}

// A process that ran and exited non-zero: its exit code and the first line it wrote to stderr.
export function exitCause(run: { exitCode: number | null; stderr: string }): string {
  const line = firstLine(run.stderr)
  const code = run.exitCode === null ? 'no exit code' : `exit ${run.exitCode}`
  return line ? `${code}, ${line}` : code
}

// The /filetree reply for a path that holds no folder, that names a file, or that could not be
// read. `detail` is the file's folder for a file and the stat error for an unreadable path.
export function pathCheckReply(kind: 'missing' | 'file' | 'unreadable', shownPath: string, detail = ''): string {
  if (kind === 'missing') return `No folder at ${shownPath}`
  if (kind === 'unreadable') return `Could not read ${shownPath}: ${detail}`
  return `${shownPath} is a file, so the tree opens its folder ${detail}.`
}

// A stat error that means nothing is at the path.
export function isMissingCause(cause: string): boolean {
  return /ENOENT|ENOTDIR|no such file|not found/i.test(cause)
}

const COPY_REASONS: Record<string, string> = {
  'no-surface': 'no screen that can take the clipboard is attached',
  'no-clipboard': 'no clipboard tool took the text',
  refused: 'a plugin refused the copy',
}

export function copyFailure(reason: string): string {
  return `${TOAST_PREFIX}could not copy the path: ${COPY_REASONS[reason] ?? reason}`
}

// Why a Bash call the tool reported as an error failed, from the text the model read: the exit
// code and the first line after it, which is where stderr starts.
export function bashFailureCause(text: string | undefined, isInterrupted = false): string {
  if (isInterrupted) return 'interrupted before it finished'
  const body = text ?? ''
  const code = /Exit code (\d+)/i.exec(body)?.[1]
  const line = firstLine(body.replace(/^\s*Exit code \d+\s*$/im, ''))
  if (code) return line ? `exit ${code}, ${line}` : `exit ${code}`
  return line || 'the command reported an error with no output'
}

// A background command's end, from its task notification summary.
export function backgroundCause(status: string, summary: string): string {
  const code = /exit code (\d+)/i.exec(summary)?.[1]
  return code ? `exit ${code}` : `background task ${status}`
}

export function gitUnavailable(cause: string): string {
  return `git status unavailable: ${cause}`
}

export function searchUnavailable(cause: string): string {
  return `Search unavailable: ${cause}`
}

// The summary's hover card: each folder count letter spelled out, as "?1 untracked, M2 modified".
export function countsLegend(counts: readonly number[] | undefined): string {
  const [untracked = 0, modified = 0, deleted = 0, added = 0] = counts ?? []
  const parts = [
    untracked > 0 ? `?${untracked} untracked` : '',
    added > 0 ? `A${added} staged as added` : '',
    modified > 0 ? `M${modified} modified` : '',
    deleted > 0 ? `D${deleted} deleted` : '',
  ].filter(Boolean)
  return parts.length ? parts.join(', ') : 'clean: every file matches HEAD'
}

// The running chips the footer has room for, and how many more run past them.
export function runningChips<T>(running: readonly T[], room = 3): { shown: T[]; more: number } {
  return { shown: running.slice(0, room), more: Math.max(0, running.length - room) }
}

// The toast when the start setting would open the pane in a terminal that cannot dock it.
export function startBlockedReason(viewport: { columns: number; isFullscreen?: boolean }): string {
  if (viewport.isFullscreen === false) return `${TOAST_PREFIX}stayed closed at start, since the sidebar needs the fullscreen layout. Run /tui fullscreen, then /filetree.`
  return `${TOAST_PREFIX}stayed closed at start, since the terminal is ${viewport.columns} columns wide and the sidebar needs ${MIN_COLUMNS}. Widen it, then run /filetree.`
}

// The settings as /config lists them: each title and the key it is stored under.
export const SETTINGS: [title: string, key: string][] = [
  ['Claude activity', 'activity'],
  ['Glyphs', 'glyphs'],
  ['Follow Claude', 'follow'],
  ['Open at start', 'start'],
  ['Right column', 'column'],
  ['Hints', 'hints'],
  ['Open with', 'open'],
]

// The /filetree help reply: the keys, the mouse, what the selection does and where the settings are.
export function helpText(): string {
  return [
    'File tree keys (click a row first, so the tree has the keys):',
    '  Up or k, Down or j: move one row. PageUp, PageDown: move 10 rows. Home, End: jump to the ends.',
    '  Right or l: open a folder. Left or h: close it, or move to the parent.',
    '  Enter: open a file, or open and close a folder. Space: Quick Look on macOS.',
    '  y: copy the relative path. Y: copy the absolute path.',
    '  .: show or hide dotfiles. s: cycle the right column through date, age and size.',
    '  c: collapse all folders. r: reload the tree and git. u or Backspace: go up to the parent folder.',
    '  /: move to the search field. Escape leaves the field; click a row to give the tree the keys again.',
    'Mouse:',
    '  Click: select a file, or open and close a folder. Double-click: open a file, or show a folder as the root.',
    '  Ctrl-click or Shift-click: open at once. Right-click: copy the relative path. Shift+right-click: copy the absolute path.',
    '  Wheel or scrollbar: scroll the tree.',
    'Selection: the selected file is sent with your prompts, so "this" or "it" can refer to it. "Clear selection" stops that.',
    'Settings (/config, pulse-filetree):',
    ...SETTINGS.map(([title, key]) => `  ${title} (${key})`),
    'Run /filetree <path> to show a folder, or /filetree alone to follow the cwd.',
  ].join('\n')
}
