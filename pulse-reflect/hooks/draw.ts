// pulse-reflect drawing: the learned-rule card the desktop band shows above the prompt.
//
// Pure functions, no runtime import from 'claude-code': a preview script can import this file as it is.

// QueerPulse tokens, copied as hex: a mod cannot read CSS variables. The same palette as pulse-progress.
export const CORAL = '#e8775a'
export const ROSE = '#b0628f'
export const FONT = "'DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"
export const SERIF = 'Fraunces,Georgia,serif'

const TEXT_LIGHT = '45,27,61'
const TEXT_DARK = '243,239,233'
// Coral as text: deep on cream, light on near-black, each above 4.5:1.
const INK_LIGHT = '#9e472c'
const INK_DARK = '#f0907a'

/** How long a card takes to settle in when it first shows, in milliseconds. */
export const ENTER_MS = 420
const EASE = 'cubic-bezier(.33,1,.68,1)'

const EYEBROW_BASELINE = 13
const RULE_SIZE = 15
const RULE_LINE = 21
const RULE_FIRST_BASELINE = 37
const BOTTOM_ROOM = 10
// Rules are capped at 200 characters, so this only guards against a runaway estimate; a rule is never cut.
const MAX_RULE_LINES = 12

export type Card = {
  rule: string
  /** How many times the person said it. */
  count: number
  /** Rules waiting behind this one. */
  waiting: number
  /** Where the check suggests saving it. */
  suggested: 'global' | 'project'
}

// ---------------------------------------------------------------------------
// Text in SVG: escaping, a width estimate, and word wrap.

export const xml = (text: string): string =>
  text.replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character] ?? character)

const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿가-힣豈-﫿！-｠\u{1F300}-\u{1FAFF}]/u
const characterEm = (character: string): number =>
  WIDE.test(character)
    ? 1
    : /[0-9]/.test(character)
      ? 0.6
      : /[\s.,:;'|!il()[\]]/.test(character)
        ? 0.3
        : /[MWmwЖШЩЮЫжшщюы@%]/u.test(character)
          ? 0.95
          : /\p{Lu}/u.test(character)
            ? 0.76
            : /\p{Script=Cyrillic}/u.test(character)
              ? 0.64
              : 0.54
/** A generous estimate, so a wrapped line never runs past the edge in the fallback font. */
export const textWidth = (text: string, size: number): number =>
  [...text].reduce((width, character) => width + characterEm(character) * size, 0)

const fitText = (text: string, size: number, maxWidth: number): string => {
  if (textWidth(text, size) <= maxWidth) return text
  let fitted = ''
  for (const character of text) {
    if (textWidth(`${fitted}${character}…`, size) > maxWidth) break
    fitted += character
  }
  return `${fitted.trimEnd()}…`
}

/**
 * The longest head of `word` that fits `maxWidth`. It ends before the last `/` or after the last `-`, `.` or `_`
 * when that point is past half the line, so a path breaks between its parts; otherwise it breaks where it must.
 */
const headOfLongWord = (word: string, size: number, maxWidth: number): string => {
  let head = ''
  for (const character of word) {
    if (textWidth(head + character, size) > maxWidth) break
    head += character
  }
  const cut = Math.max(head.lastIndexOf('/'), ...['-', '.', '_'].map(mark => head.lastIndexOf(mark) + 1))
  const isGoodCut = cut > 0 && cut < head.length && textWidth(head.slice(0, cut), size) > maxWidth / 2
  return isGoodCut ? head.slice(0, cut) : head
}

/** Splits `text` into lines no wider than `maxWidth`; a word longer than a line breaks between its parts. */
export const wrapText = (text: string, size: number, maxWidth: number, maxLines: number): string[] => {
  const lines: string[] = []
  let current = ''
  const push = (line: string) => lines.push(line)
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = current === '' ? word : `${current} ${word}`
    if (textWidth(candidate, size) <= maxWidth) {
      current = candidate
      continue
    }
    if (current !== '') push(current)
    current = ''
    let rest = word
    while (textWidth(rest, size) > maxWidth) {
      const head = headOfLongWord(rest, size, maxWidth)
      if (head === '') break
      push(head)
      rest = rest.slice(head.length)
    }
    current = rest
  }
  if (current !== '') push(current)
  if (lines.length <= maxLines) return lines
  const kept = lines.slice(0, maxLines)
  kept[maxLines - 1] = fitText(`${kept[maxLines - 1] ?? ''} ${lines[maxLines] ?? ''}`, size, maxWidth)
  return kept
}

// ---------------------------------------------------------------------------
// Words.

export const timesSaid = (count: number): string => (count <= 1 ? '' : count === 2 ? 'said twice' : `said ${count} times`)
export const waitingText = (waiting: number): string => (waiting > 0 ? `${waiting} more waiting` : '')

/** What the card says, for a reader that cannot see it. */
export const cardAlt = (card: Card): string =>
  [
    `Learned rule: “${card.rule}”`,
    `Suggested: ${card.suggested === 'project' ? 'this repo' : 'global'}`,
    timesSaid(card.count),
    waitingText(card.waiting),
  ]
    .filter(Boolean)
    .map(sentence => `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}`)
    .join('. ')

// ---------------------------------------------------------------------------
// The card: an eyebrow (a coral dot, "Learned rule" in Fraunces italic, how often it was said, and the
// queue on the right), then the rule itself in quotes, wrapped to the band's width.

export const ruleLines = (rule: string, width: number): string[] =>
  wrapText(`“${rule}”`, RULE_SIZE, Math.max(120, width - 6), MAX_RULE_LINES)

/**
 * The card's SVG at `width` CSS pixels. `enteredMs` is how long ago this card first showed: under ENTER_MS it
 * eases up into place from where that time puts it; past it (or undefined) the source is the settled drawing,
 * byte for byte the same on every redraw.
 */
export const cardSvg = (card: Card, width: number, enteredMs?: number): { source: string; height: number } => {
  const lines = ruleLines(card.rule, width)
  const height = RULE_FIRST_BASELINE + (lines.length - 1) * RULE_LINE + BOTTOM_ROOM
  const said = timesSaid(card.count)
  const titleWidth = 14 + textWidth('Learned rule', 13.5) + (said ? 12 + textWidth(`· ${said}`, 12) : 0)
  const fullWaiting = waitingText(card.waiting)
  // A narrow band keeps the count and drops the words around it.
  const waiting = fullWaiting && titleWidth + textWidth(fullWaiting, 12) + 16 > width ? `+${card.waiting}` : fullWaiting
  const isEntering = enteredMs !== undefined && enteredMs >= 0 && enteredMs < ENTER_MS
  const enter = isEntering
    ? `.in{animation:in ${ENTER_MS}ms ${EASE} ${-Math.round(enteredMs)}ms both}@keyframes in{from{opacity:0;transform:translateY(5px)}}
@media (prefers-reduced-motion: reduce){.in{animation:none}}`
    : ''
  const rule = lines
    .map(
      (line, index) =>
        `<text class="tx" x="0" y="${RULE_FIRST_BASELINE + index * RULE_LINE}" font-family="${FONT}" font-size="${RULE_SIZE}">${xml(line)}</text>`,
    )
    .join('')
  return {
    height,
    source: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<style>
.tx{fill:rgb(${TEXT_LIGHT})}.m{fill:rgba(${TEXT_LIGHT},.63)}.ink{fill:${INK_LIGHT}}
@media (prefers-color-scheme: dark){.tx{fill:rgb(${TEXT_DARK})}.m{fill:rgba(${TEXT_DARK},.52)}.ink{fill:${INK_DARK}}}
${enter}
</style>
<defs><linearGradient id="dot" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${CORAL}"/><stop offset="1" stop-color="${ROSE}"/></linearGradient></defs>
<g${isEntering ? ' class="in"' : ''}>
<circle cx="4" cy="${EYEBROW_BASELINE - 4.5}" r="3.5" fill="url(#dot)"/>
<text x="14" y="${EYEBROW_BASELINE}"><tspan class="ink" font-family="${SERIF}" font-size="13.5" font-style="italic" font-weight="500">Learned rule</tspan>${
      said ? `<tspan class="m" font-family="${FONT}" font-size="12" dx="7">·</tspan><tspan class="m" font-family="${FONT}" font-size="12" dx="5">${said}</tspan>` : ''
    }</text>
${waiting ? `<text class="m" x="${width}" y="${EYEBROW_BASELINE}" text-anchor="end" font-family="${FONT}" font-size="12" style="font-variant-numeric:tabular-nums">${waiting}</text>` : ''}
${rule}
</g>
</svg>`,
  }
}
