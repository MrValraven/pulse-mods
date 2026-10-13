// pulse-cache-tax drawing: pure functions that turn the cache's state into SVG and text.
//
// No runtime import from 'claude-code': a preview script can import this file as it is.

// QueerPulse tokens, copied as hex: a mod cannot read CSS variables. The same palette as pulse-progress.
export const CORAL = '#e8775a'
export const JADE = '#4a8c6f'
export const LILAC = '#8a72cf'
const FONT = "'DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"
const SERIF = 'Fraunces,Georgia,serif'
const TABULAR = ' style="font-variant-numeric:tabular-nums"'

// ---------------------------------------------------------------------------
// Numbers.

export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60000))
  const hours = Math.floor(total / 60)
  const minutes = total % 60
  if (hours >= 48) return `${Math.floor(hours / 24)}d ${hours % 24}h`
  return hours > 0 ? `${hours}h${String(minutes).padStart(2, '0')}m` : `${minutes}m`
}

export function fmtUsd(usd: number | null): string {
  return usd == null ? 'n/a' : '$' + (usd >= 100 ? usd.toFixed(0) : usd.toFixed(2))
}

export function fmtTok(count: number): string {
  return count >= 1e6 ? (count / 1e6).toFixed(1) + 'M' : count >= 1000 ? Math.round(count / 1000) + 'k' : String(count)
}

/** Whole minutes left, rounded up: a countdown reads 1m through its last minute. */
export const minutesLeft = (ms: number): number => Math.max(0, Math.ceil(ms / 60000))

// ---------------------------------------------------------------------------
// Text in SVG.

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
export const xml = (text: string): string => text.replace(/[&<>"]/g, ch => ENTITIES[ch] ?? ch)

const charEm = (ch: string): number =>
  /[0-9$]/.test(ch) ? 0.6 : /[\s.,:;'|!il()[\]]/.test(ch) ? 0.3 : /[A-Zmw@%≈]/.test(ch) ? 0.75 : 0.56
export const textWidth = (text: string, size: number): number => [...text].reduce((width, ch) => width + charEm(ch) * size, 0)

export const fitText = (text: string, size: number, maxWidth: number): string => {
  if (textWidth(text, size) <= maxWidth) return text
  let out = ''
  for (const ch of text) {
    if (textWidth(out + ch + '…', size) > maxWidth) break
    out += ch
  }
  return out.trimEnd() + '…'
}

// ---------------------------------------------------------------------------
// Light and dark. Text and tracks are neutral; jade means warm, coral means it costs, lilac marks the ping.

const TEXT_LIGHT = '45,27,61'
const TEXT_DARK = '243,239,233'
// Inks hold 4.5:1 as small text on cream (#faf6f0) and on near-black (#141414).
const CORAL_INK_LIGHT = '#9e472c'
const CORAL_INK_DARK = '#f0907a'
const LILAC_INK_LIGHT = '#5d47a8'
const LILAC_INK_DARK = '#a996e0'
const JADE_DARK = '#5aa784'
// A deeper coral for fills on cream; the brand coral stays on near-black.
const CORAL_FILL_LIGHT = '#d4603f'

const css = (motion: string): string => `<style>
.tx{fill:rgb(${TEXT_LIGHT})}.m{fill:rgba(${TEXT_LIGHT},.63)}.k{fill:rgba(${TEXT_LIGHT},.09)}
.fw{fill:${JADE}}.fc{fill:${CORAL_FILL_LIGHT}}.ci{fill:${CORAL_INK_LIGHT}}.pt{fill:${LILAC}}.li{fill:${LILAC_INK_LIGHT}}
@media (prefers-color-scheme: dark){.tx{fill:rgb(${TEXT_DARK})}.m{fill:rgba(${TEXT_DARK},.49)}.k{fill:rgba(255,255,255,.08)}
.fw{fill:${JADE_DARK}}.fc{fill:${CORAL}}.ci{fill:${CORAL_INK_DARK}}.pt{fill:${LILAC_INK_DARK}}.li{fill:${LILAC_INK_DARK}}}
${motion}</style>`

const svg = (width: number, height: number, body: string, motion = ''): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${css(motion)}${body}</svg>`

const textAt = (x: number, y: number, cls: string, size: number, content: string, extra = ''): string =>
  `<text class="${cls}" x="${x}" y="${y}" font-family="${FONT}" font-size="${size}"${extra}>${xml(content)}</text>`

// ---------------------------------------------------------------------------
// The warmth meter: a track as long as the cache's one-hour life, filled with what is left of it.

export type Warmth = {
  /** warm: the fill drains; pinging: keepwarm's ping is in flight; cold: only the price shows. */
  tone: 'warm' | 'pinging' | 'cold'
  /** Until the cache goes cold; 0 once it has. */
  msLeft: number
  ttlMs: number
  /** The warmth left when keepwarm pings and refills the meter; null when no ping lands before it goes cold. */
  pingMsLeft: number | null
  /** What the next send re-writes, as `$4.01`; null when the model has no price. */
  coldPrice: string | null
}

export const METER_H = 20
const TRACK_H = 6
// Below this the fill reads as nearly gone, so it turns coral: the last ten minutes of the hour.
const SOON_COLD_MS = 10 * 60 * 1000
// Narrower than this, a meter drops its label's small words and keeps the number.
const COMPACT_W = 130

type Label = { parts: Array<{ text: string; cls: string; size: number; weight?: number }> }

const labelWidth = (label: Label): number => label.parts.reduce((width, part) => width + textWidth(part.text, part.size), 0)

const meterLabel = (warmth: Warmth, width: number): Label => {
  if (warmth.tone === 'pinging') return { parts: [{ text: 'pinging', cls: 'li', size: 12, weight: 600 }] }
  if (warmth.tone === 'warm') {
    const minutes = { text: `${minutesLeft(warmth.msLeft)}m`, cls: 'tx', size: 12, weight: 600 }
    return { parts: width >= COMPACT_W ? [minutes, { text: ' left', cls: 'm', size: 11 }] : [minutes] }
  }
  if (!warmth.coldPrice) return { parts: [{ text: width >= 170 ? 'price unknown' : 'no price', cls: 'm', size: 11 }] }
  const price = { text: `≈${warmth.coldPrice}`, cls: 'ci', size: 12, weight: 600 }
  return { parts: width >= 170 ? [price, { text: ' to re-write', cls: 'm', size: 11 }] : [price] }
}

// The widest warm label, so the track keeps one length while the minutes count down.
const warmLabelWidth = (width: number): number => Math.ceil(textWidth('60m', 12) + (width >= COMPACT_W ? textWidth(' left', 11) : 0))

export const meterSvg = (given: Warmth, width: number): string => {
  // Whole seconds, so two draws in the same second give the same source.
  const warmth = { ...given, msLeft: Math.round(given.msLeft / 1000) * 1000 }
  const label = meterLabel(warmth, width)
  const labelW = Math.max(warmth.tone === 'cold' ? 0 : warmLabelWidth(width), Math.ceil(labelWidth(label)))
  const trackW = Math.max(24, width - labelW - 14)
  const trackY = (METER_H - TRACK_H) / 2
  const radius = TRACK_H / 2
  const isLive = warmth.tone !== 'cold'
  const fraction = isLive ? Math.min(1, Math.max(0, warmth.msLeft / warmth.ttlMs)) : 0
  const fillW = Math.max(isLive ? TRACK_H : 0, Math.round(trackW * fraction))
  const fillClass = isSoonCold(warmth) ? 'fc' : 'fw'

  // The fill drains to empty over the time that is left, and a ping in flight breathes.
  // Every motion is off under reduced motion; the band redraws each minute either way.
  const motion = isLive
    ? `@media (prefers-reduced-motion: no-preference){${
        warmth.tone === 'pinging'
          ? '.pu{animation:pu 1.4s ease-in-out infinite}@keyframes pu{0%,100%{opacity:1}50%{opacity:.4}}'
          : `.dr{animation:dr ${Math.round(warmth.msLeft)}ms linear both}@keyframes dr{to{width:${TRACK_H}px}}`
      }}`
    : ''
  const fill = isLive
    ? `<rect class="${fillClass} ${warmth.tone === 'pinging' ? 'pu' : 'dr'}" x="0" y="${trackY}" width="${fillW}" height="${TRACK_H}" rx="${radius}"/>`
    : ''
  // The ping's mark: where on the hour keepwarm refills it, while that point is still ahead.
  const pingX = warmth.pingMsLeft != null && warmth.tone === 'warm' && warmth.pingMsLeft < warmth.msLeft
    ? Math.round(trackW * Math.min(1, Math.max(0, warmth.pingMsLeft / warmth.ttlMs)))
    : null
  const pingMark = pingX == null ? '' : `<rect class="pt" x="${Math.max(0, pingX - 1)}" y="${trackY - 4}" width="2" height="${TRACK_H + 8}" rx="1"/>`

  // One text anchored at its end, so the parts flow in the real font and never collide.
  const labelText = `<text x="${width}" y="14" text-anchor="end" font-family="${FONT}"${TABULAR}>${label.parts
    .map(part => `<tspan class="${part.cls}" font-size="${part.size}"${part.weight ? ` font-weight="${part.weight}"` : ''}>${xml(part.text)}</tspan>`)
    .join('')}</text>`
  // Cold has nothing left to fill, so it shows only the price.
  const track = isLive ? `<rect class="k" x="0" y="${trackY}" width="${trackW}" height="${TRACK_H}" rx="${radius}"/>` : ''
  return svg(width, METER_H, `${track}${fill}${pingMark}${labelText}`, motion)
}

export const meterAlt = (warmth: Warmth): string => {
  if (warmth.tone === 'pinging') return 'Prompt cache warm, keepwarm is pinging it now'
  if (warmth.tone === 'cold') {
    return warmth.coldPrice ? `Prompt cache cold, the next message re-writes it for about ${warmth.coldPrice}` : 'Prompt cache cold, no price for this model'
  }
  const minutes = minutesLeft(warmth.msLeft)
  const ping = warmth.pingMsLeft != null && warmth.pingMsLeft < warmth.msLeft
    ? `, keepwarm pings it with ${minutesLeft(warmth.pingMsLeft)} minutes left`
    : ''
  return `Prompt cache warm for ${minutes} more minute${minutes === 1 ? '' : 's'}${ping}`
}

/** The terminal's meter: a row of cells standing for the hour, filled with what is left; none once cold. */
export const textMeter = (warmth: Warmth, cells: number): { filled: string; empty: string } => {
  if (warmth.tone === 'cold') return { filled: '', empty: '' }
  const filledCells = Math.max(1, Math.round(cells * Math.min(1, Math.max(0, warmth.msLeft / warmth.ttlMs))))
  return { filled: '━'.repeat(filledCells), empty: '─'.repeat(cells - filledCells) }
}

export const isSoonCold = (warmth: Warmth): boolean => warmth.tone === 'warm' && warmth.msLeft <= SOON_COLD_MS

// ---------------------------------------------------------------------------
// The held send: what sending now re-writes, beside what a warm turn costs.

export type Hold = {
  /** How long the cache has been cold, as `2h00m`. */
  coldFor: string
  rewriteUsd: number | null
  warmUsd: number | null
  /** The context the send re-writes, as `200,502`. */
  tokens: string
}

const CARD_TITLE = 'Message held'
const ROW_LABEL = 11.5
const ROW_VALUE = 12

export const HOLD_TITLE_H = 22

/** The card's head: the title, and how long the cache has been cold. */
export const holdTitleSvg = (hold: Hold, width: number): string => {
  const titleW = textWidth(CARD_TITLE, 15) + 10
  const subtitle = fitText(`cold for ${hold.coldFor}`, 12, width - titleW)
  return svg(width, HOLD_TITLE_H, `<text x="0" y="16"><tspan class="tx" font-family="${SERIF}" font-size="15" font-style="italic" font-weight="600">${CARD_TITLE}</tspan><tspan class="m" dx="10" font-family="${FONT}" font-size="12">${xml(subtitle)}</tspan></text>`)
}

export const holdTitleAlt = (hold: Hold): string => `Message held, the cache has been cold for ${hold.coldFor}`

export const holdBarsHeight = (hold: Hold): number => (hold.rewriteUsd == null ? 20 : hold.warmUsd == null ? 20 : 36)

/** The card's evidence: what sending now re-writes, on one scale with what a warm turn would have cost. */
export const holdBarsSvg = (hold: Hold, width: number): string => {
  if (hold.rewriteUsd == null) {
    return svg(width, holdBarsHeight(hold), textAt(0, 14, 'm', 12, fitText('No price for this model, so the cost is unknown.', 12, width)))
  }
  // The re-write fills its track; a warm turn is the sliver it would have cost.
  const rows: Array<{ label: string; usd: number; fillClass: string; inkClass: string }> = [
    { label: 'Send now', usd: hold.rewriteUsd, fillClass: 'fc', inkClass: 'ci' },
    ...(hold.warmUsd == null ? [] : [{ label: 'Warm turn', usd: hold.warmUsd, fillClass: 'fw', inkClass: 'tx' }]),
  ]
  const labelW = Math.ceil(Math.max(...rows.map(row => textWidth(row.label, ROW_LABEL)))) + 12
  const valueW = Math.ceil(Math.max(...rows.map(row => textWidth(fmtUsd(row.usd), ROW_VALUE)))) + 12
  const trackW = Math.max(40, width - labelW - valueW)
  const scale = Math.max(...rows.map(row => row.usd), 1e-9)
  const body = rows
    .map((row, index) => {
      const centerY = 10 + index * 16
      const fillW = Math.max(TRACK_H, Math.round((trackW * row.usd) / scale))
      return `${textAt(0, centerY + 4, 'm', ROW_LABEL, row.label)}<rect class="k" x="${labelW}" y="${centerY - TRACK_H / 2}" width="${trackW}" height="${TRACK_H}" rx="${TRACK_H / 2}"/><rect class="${row.fillClass}" x="${labelW}" y="${centerY - TRACK_H / 2}" width="${fillW}" height="${TRACK_H}" rx="${TRACK_H / 2}"/>${textAt(width, centerY + 4, row.inkClass, ROW_VALUE, fmtUsd(row.usd), `${TABULAR} text-anchor="end" font-weight="600"`)}`
    })
    .join('')
  return svg(width, holdBarsHeight(hold), body)
}

export const holdBarsAlt = (hold: Hold): string =>
  hold.rewriteUsd == null
    ? `No price for this model; sending re-writes up to ${hold.tokens} tokens.`
    : `Sending now re-writes up to ${hold.tokens} tokens for about ${fmtUsd(hold.rewriteUsd)}` +
      (hold.warmUsd == null ? '.' : `; a warm turn would have cost ${fmtUsd(hold.warmUsd)}.`)
