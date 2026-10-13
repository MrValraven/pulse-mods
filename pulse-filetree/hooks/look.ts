import type { Theme } from '../types'
import { DEFAULT_THEME } from './tree'

// The pane's colours. Without a theme file the pane can sit on a cream (#faf6f0) or a
// near-black (#141414) background and nothing says which, so text colours there are the
// person's own theme keys (inactive, success, warning, error, merged), which follow their
// light or dark theme. The house inks below colour marks only: the activity bar, the
// shimmer, icons. An Omarchy theme names its background, so there the inks are picked for
// that background, and its own accent, muted, red and selection win.

type Hue = 'coral' | 'jade' | 'amber' | 'red' | 'lilac' | 'teal' | 'blue' | 'cyan'
type Mode = 'light' | 'dark' | 'both'

const INKS: Record<Mode, Record<Hue, string>> = {
  light: { coral: '#a8492f', jade: '#2f6e52', amber: '#875c14', red: '#a83e3b', lilac: '#6a50b8', teal: '#1f6e69', blue: '#3a62a8', cyan: '#1f6c84' },
  both: { coral: '#cc6448', jade: '#3f8a68', amber: '#a57524', red: '#c4524f', lilac: '#8a6fd0', teal: '#2e8a84', blue: '#4f7cc4', cyan: '#2b88a3' },
  dark: { coral: '#f0907a', jade: '#7cd7ad', amber: '#e3b65e', red: '#f08a84', lilac: '#b9a6f0', teal: '#6fd0c8', blue: '#8db4f0', cyan: '#74cde6' },
}

const MUTED: Record<Mode, string> = { light: '#6e6478', both: '#7a7183', dark: '#a89cb4' }

// Claude's activity tones (git.ts TONES names) mapped onto the house hues.
const TONE_HUE: Record<string, Hue> = { orange: 'coral', green: 'jade', teal: 'teal', blue: 'blue', purple: 'lilac', cyan: 'cyan', red: 'red' }

export type Palette = {
  isCustomTheme: boolean
  text: string | undefined
  muted: string
  // The muted colour as a hex, for mixing: a theme key cannot be mixed.
  mutedHex: string
  faint: string
  accent: string
  cursorBg: string
  hoverBg: string
  added: string
  modified: string
  deleted: string
  renamed: string
  addedLines: string
  deletedLines: string
  ink: (tone: string) => string
  shimmer: Record<string, { bright: string[]; dim: string[] }>
}

function channels(hex: string): [number, number, number] {
  const value = parseInt(hex.slice(1, 7), 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

export function mix(from: string, to: string, amount: number): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(from) || !/^#[0-9a-fA-F]{6}$/.test(to)) return from
  const start = channels(from)
  const end = channels(to)
  return `#${start.map((channel, index) => Math.round(channel + ((end[index] ?? channel) - channel) * amount).toString(16).padStart(2, '0')).join('')}`
}

function luminance(hex: string): number {
  const linear = (channel: number) => {
    const value = channel / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  const [red, green, blue] = channels(hex).map(linear) as [number, number, number]
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

// The old selection hover: the selection colour pulled most of the way to a dark grey.
function towardDark(hex: string): string {
  return mix(hex, '#262626', 0.7)
}

export function buildPalette(theme: Theme, isDesktop: boolean): Palette {
  const isCustomTheme = (Object.keys(DEFAULT_THEME) as (keyof Theme)[]).some(key => theme[key] !== DEFAULT_THEME[key])
  const hasBackground = /^#[0-9a-fA-F]{6}$/.test(theme.bg)
  const mode: Mode = hasBackground ? (luminance(theme.bg) < 0.35 ? 'dark' : 'light') : 'both'
  const isBoth = mode === 'both'
  const inks = INKS[mode]
  const mutedHex = isCustomTheme ? theme.muted : MUTED[mode]
  const muted = isCustomTheme ? theme.muted : isBoth ? 'inactive' : MUTED[mode]
  const deleted = isCustomTheme ? theme.urgent : isBoth ? 'error' : inks.red
  const peakOf = (hue: Hue) => (mode === 'dark' ? mix(INKS.dark[hue], '#ffffff', 0.45) : mode === 'light' ? INKS.both[hue] : mix(INKS.both[hue], INKS.dark[hue], 0.5))
  const shimmer: Record<string, { bright: string[]; dim: string[] }> = {}
  for (const [tone, hue] of Object.entries(TONE_HUE)) {
    const ink = inks[hue]
    const peak = peakOf(hue)
    const soft = mix(ink, mutedHex, 0.55)
    shimmer[tone] = { bright: [ink, mix(ink, peak, 0.35), mix(ink, peak, 0.7), peak], dim: [soft, mix(soft, ink, 0.35), mix(soft, ink, 0.7), ink] }
  }
  return {
    isCustomTheme,
    text: theme.fg || undefined,
    muted,
    mutedHex,
    faint: hasBackground ? mix(mutedHex, theme.bg, 0.55) : 'subtle',
    accent: isCustomTheme ? theme.accent : inks.coral,
    cursorBg: isCustomTheme ? theme.selection : 'userMessageBackground',
    hoverBg: isCustomTheme ? (hasBackground ? mix(theme.selection, theme.bg, 0.55) : towardDark(theme.selection)) : isDesktop ? 'userMessageBackgroundHover' : 'userMessageBackground',
    added: isBoth ? 'success' : inks.jade,
    modified: isBoth ? 'warning' : inks.amber,
    deleted,
    renamed: isBoth ? 'merged' : inks.lilac,
    addedLines: isBoth ? 'success' : inks.jade,
    deletedLines: deleted,
    ink: tone => inks[TONE_HUE[tone] ?? 'coral'],
    shimmer,
  }
}

export function gitInk(palette: Palette, letter: string | undefined): string | undefined {
  if (!letter) return undefined
  if (letter === 'D' || letter === 'U') return palette.deleted
  if (letter === 'M' || letter === 'T') return palette.modified
  if (letter === 'R' || letter === 'C') return palette.renamed
  if (letter === 'A' || letter === '?') return palette.added
  return palette.muted
}

// Cuts a long name in its middle so the start and the extension both stay readable.
export function truncateMiddle(name: string, room: number): string {
  const characters = [...name]
  if (characters.length <= room) return name
  if (room <= 1) return '…'
  // Too little room for both ends: the start alone says more.
  if (room < 10) return `${characters.slice(0, room - 1).join('')}…`
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 && name.length - dot <= 8 ? [...name.slice(dot)] : []
  const tailLength = Math.min(Math.max(extension.length + 2, Math.floor((room - 1) / 3)), room - 2)
  const headLength = Math.max(1, room - 1 - tailLength)
  return `${characters.slice(0, headLength).join('')}…${characters.slice(characters.length - (room - 1 - headLength)).join('')}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// The date column, in the month words age() uses: this year's with the time (Oct 12 09:30),
// an older one with its year (Nov 14 2023). Very narrow panes keep one part: today's time
// (09:30), this year's day (Oct 12), an older one's year (2023). The day is padded so the
// column lines up.
export function dateLabel(ms: number, now: number, isVeryNarrow = false): string {
  if (!ms) return ''
  const date = new Date(ms)
  const today = new Date(now)
  const pad = (value: number) => String(value).padStart(2, '0')
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const day = `${MONTHS[date.getMonth()]} ${String(date.getDate()).padStart(2, ' ')}`
  const isThisYear = date.getFullYear() === today.getFullYear()
  if (!isVeryNarrow) return `${day} ${isThisYear ? time : date.getFullYear()}`
  if (isThisYear && date.getMonth() === today.getMonth() && date.getDate() === today.getDate()) return time
  return isThisYear ? day : String(date.getFullYear())
}

export function widthOf(text: string): number {
  return [...text].length
}

export const RECENT_SOFT_MS = 30_000
export const RECENT_MS = 90_000

// How strongly a file Claude touched a while ago is still marked: 2 just after the shimmer,
// 1 once it has settled, 0 when the mark is gone.
export function recentLevel(at: number, now: number): 0 | 1 | 2 {
  const elapsed = now - at
  return elapsed < RECENT_SOFT_MS ? 2 : elapsed < RECENT_MS ? 1 : 0
}
