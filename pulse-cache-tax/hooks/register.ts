import type { EngineInterface, PluginOptions, Register, RenderChildren, RenderElement } from 'claude-code'
import { bandColors, fmtDuration, fmtTok, fmtUsd, HOLD_TITLE_H, holdBarsAlt, holdBarsHeight, holdBarsSvg, holdTitleAlt, holdTitleSvg, isSoonCold, meterAlt, meterSvg, METER_H, minutesLeft, textMeter } from './draw'
import type { Hold, Warmth } from './draw'
import { priceOf } from './prices'
import type { ModelPrice } from './prices'
import { statusIcons } from './status-icons'

export { fmtDuration }

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const MIN_PING_MS = MINUTE_MS
const PING_PROMPT = 'Reply with the single word: warm'
// The band redraws once a minute while a window is armed, so its countdowns stay true.
const TICK_MS = MINUTE_MS
const KEY_DEADLINE = 'deadline'
const KEY_EVERY = 'every'
const KEY_GUARD = 'guard'
const KEY_ALWAYS = 'always'
const KEY_TIP_SHOWN = 'keepwarmTipShown'
/** A first cold write at or above this many dollars brings the one-time /keepwarm tip. */
export const KEEPWARM_TIP_MIN_USD = 0.5

/** How long the prompt cache lives after a request, as the cacheTtl setting names it. */
export type CacheTtl = '1h' | '5m'
const TTL_MS: Record<CacheTtl, number> = { '1h': HOUR_MS, '5m': 5 * MINUTE_MS }
// A ping lands this long after the last request, ahead of the cache's expiry.
const PING_AFTER_MS: Record<CacheTtl, number> = { '1h': 50 * MINUTE_MS, '5m': 4 * MINUTE_MS }

export type Settings = {
  cacheTtl: CacheTtl
  /** Below this context size the guard lets a cold send through. */
  guardMinTokens: number
  /** What a bare /keepwarm and the always switch arm. */
  defaultWindowMs: number
  /** One line per setting that was out of range and fell back to its default. */
  problems: string[]
}

/** Each setting as /config shows it: its title, then its key. Keep the titles in step with plugin.json. */
const SETTING_TITLES = {
  cacheTtl: 'Cache lifetime (cacheTtl)',
  guardMinTokens: 'Guard threshold (guardMinTokens)',
  defaultWindow: 'Default keepwarm window (defaultWindow)',
}

export const DEFAULT_SETTINGS: Settings = { cacheTtl: '1h', guardMinTokens: 50000, defaultWindowMs: 6 * HOUR_MS, problems: [] }

type PingRecord = { at: number; read: number; write: number; usd: number | null; warm: boolean }
type Miss = { at: number; tokens: number; usd: number | null }
type GuardMode = 'refuse' | 'warn'
/** A cold send the guard dropped: kept in memory only, for the band's Send message, until the next turn. */
type HeldPrompt = { text: string; isResendable: boolean; /** Why Send message is hidden: "has an attachment" or "mentions @<path>". */ blocker: string | null }

export type State = {
  hasBand: boolean
  sid: string
  ttl: CacheTtl
  guardMinTokens: number
  defaultWindowMs: number
  deadline: number
  every: number
  always: boolean
  lastRequestAt: number
  /** The last request of a turn of the person's (pings excluded), for the savings estimate. */
  lastTurnAt: number
  /** When the last warm ping landed. */
  lastPingAt: number
  lastModel: string | null
  ctx: number
  compacted: boolean
  guard: GuardMode
  ackedAt: number
  /** The guard's ack for prompts the person did not type (notifications, scheduled prompts): one drop, then the next goes through. */
  notificationAckedAt: number
  coldWritePending: boolean
  misses: Miss[]
  /** This session's pings: how many ran and what they cost. */
  pingCount: number
  pingSpendUsd: number
  /** Cold writes keepwarm avoided this session, and their estimated price at the context size of the time. */
  avoidedColdWrites: number
  savedUsd: number
  hasWarnedFiveMinutePings: boolean
  /** Set when the person sent a different message while one was held: the held text comes back after that turn, with this cause. */
  heldRestoreCause: string | null
  pending: { cancel: () => void } | null
  last: PingRecord | null
  stopped: string | null
  isPinging: boolean
  held: HeldPrompt | null
  ticker: { cancel: () => void } | null
  /** The last request the ticker's phase was set from. */
  tickerAnchor: number
}

/** Reads the userConfig values; a value out of range falls back to its default and leaves a line in `problems`. */
export function readSettings(options: PluginOptions | Record<string, unknown> | undefined): Settings {
  const given = (options ?? {}) as Record<string, unknown>
  const problems: string[] = []
  const ttlValue = given.cacheTtl
  const cacheTtl: CacheTtl = ttlValue === '5m' ? '5m' : '1h'
  if (ttlValue !== undefined && ttlValue !== '1h' && ttlValue !== '5m') problems.push(`${SETTING_TITLES.cacheTtl} is "${String(ttlValue)}", which is neither 1h nor 5m, so the mod uses 1h`)
  let guardMinTokens = DEFAULT_SETTINGS.guardMinTokens
  if (given.guardMinTokens !== undefined && given.guardMinTokens !== '') {
    const parsed = Number(given.guardMinTokens)
    if (Number.isFinite(parsed) && parsed >= 0) guardMinTokens = Math.round(parsed)
    else problems.push(`${SETTING_TITLES.guardMinTokens} is "${String(given.guardMinTokens)}", which is not a whole number of tokens, so the guard uses ${DEFAULT_SETTINGS.guardMinTokens.toLocaleString('en-US')}`)
  }
  let defaultWindowMs = DEFAULT_SETTINGS.defaultWindowMs
  if (typeof given.defaultWindow === 'string' && given.defaultWindow.trim() !== '') {
    const parsed = parseDuration(given.defaultWindow)
    if (parsed != null && parsed > 0) defaultWindowMs = parsed
    else problems.push(`${SETTING_TITLES.defaultWindow} is "${given.defaultWindow}", which is not a duration such as 6h, 90m or 2h30m, so a bare /keepwarm arms ${fmtDuration(DEFAULT_SETTINGS.defaultWindowMs)}`)
  }
  return { cacheTtl, guardMinTokens, defaultWindowMs, problems }
}

export const ttlMsOf = (s: State): number => TTL_MS[s.ttl]
export const pingAfterMsOf = (s: State): number => PING_AFTER_MS[s.ttl]

/** The cache-write rate for the active lifetime, $ per million tokens. */
function writeRateOf(price: ModelPrice, ttl: CacheTtl): number {
  return ttl === '5m' ? price.cacheWriteFiveMinutes : price.cacheWriteHour
}

export function parseDuration(text: string): number | null {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(text.trim())
  if (!m || (m[1] === undefined && m[2] === undefined)) return null
  return (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 * 1000
}

function coldUsd(s: State): number | null {
  const price = priceOf(s.lastModel)
  return price ? s.ctx * writeRateOf(price, s.ttl) / 1e6 : null
}

function warmUsd(s: State): number | null {
  const price = priceOf(s.lastModel)
  return price ? s.ctx * price.cacheRead / 1e6 : null
}

type ForkUsage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

/** Everything a fork bills: the cache read, any cache write at the active lifetime's rate, uncached input at the base rate, and the output. */
export function pingUsd(usage: ForkUsage, price: ModelPrice, ttl: CacheTtl): number {
  return (usage.cache_read_input_tokens * price.cacheRead + usage.cache_creation_input_tokens * writeRateOf(price, ttl) + usage.input_tokens * price.input + usage.output_tokens * price.output) / 1e6
}

/** The read-only upper bound: pings at the cache-read rate that cost as much as one cold write of the same context. */
function breakEvenPings(s: State): number | null {
  const price = priceOf(s.lastModel)
  if (!price || s.ctx <= 0) return null
  return Math.floor(writeRateOf(price, s.ttl) / price.cacheRead)
}

/** What keepwarm's pings cost an hour at the current context, reads only; null when the model has no price or no context is known. */
export function pingCostPerHour(s: State): number | null {
  const price = priceOf(s.lastModel)
  if (!price || s.ctx <= 0 || s.every <= 0) return null
  return (HOUR_MS / s.every) * s.ctx * price.cacheRead / 1e6
}

function isCold(s: State, now: number): boolean {
  return s.lastRequestAt > 0 && !s.compacted && now - s.lastRequestAt >= ttlMsOf(s)
}

function guardText(s: State, now: number): string {
  const price = priceOf(s.lastModel)
  const cost = price ? `at $${writeRateOf(price, s.ttl)}/MTok = ${fmtUsd(coldUsd(s))}` : 'at the cache-write rate, price unknown'
  const warm = warmUsd(s)
  return `the prompt cache went cold ${fmtDuration(now - s.lastRequestAt - ttlMsOf(s))} ago. Sending this re-writes ` +
    `up to ${s.ctx.toLocaleString('en-US')} tokens ${cost}` +
    (warm == null ? '' : ` (a warm turn would have cost ${fmtUsd(warm)})`) + '.'
}

/**
 * A turn's first request, before the clock moves to it. When the gap since the person's last turn
 * is longer than the cache's life and a ping kept the cache warm across it, that ping avoided one
 * cold write at the current context size. Returns the dollars saved, or null when nothing was.
 */
export function noteTurnRequest(s: State, at: number): number | null {
  const ttl = ttlMsOf(s)
  const wasSaved = s.lastTurnAt > 0 && !s.compacted && s.ctx > 0 &&
    at - s.lastTurnAt > ttl && s.lastPingAt > s.lastTurnAt && at - s.lastRequestAt < ttl
  s.lastTurnAt = at
  if (!wasSaved) return null
  const usd = coldUsd(s)
  s.avoidedColdWrites++
  if (usd != null) s.savedUsd += usd
  return usd
}

/** "keepwarm: pings $0.40, saved about $3.10", or the price-unknown form. */
export function savingsText(s: State): string {
  if (!priceOf(s.lastModel)) return `keepwarm: ${s.pingCount} ping${s.pingCount === 1 ? '' : 's'}, ${s.avoidedColdWrites} cold write${s.avoidedColdWrites === 1 ? '' : 's'} avoided, price unknown`
  return `keepwarm: pings ${fmtUsd(s.pingSpendUsd)}, saved about ${fmtUsd(s.savedUsd)}`
}

/** Why the guard lets a cold send through on size; empty while the cache is warm, or the context is at or above the threshold or unknown. */
function guardOffText(s: State, now: number): string {
  return isCold(s, now) && s.ctx > 0 && s.ctx < s.guardMinTokens ? `guard off below ${fmtTok(s.guardMinTokens)} tokens` : ''
}

/** Why a held message cannot be resent by the mod: an attachment, or an @-mention that looks like a path. Null when it can. */
export function heldBlocker(text: string, attachmentCount: number): string | null {
  if (attachmentCount > 0) return 'has an attachment'
  for (const match of text.matchAll(/(?:^|\s)@(\S+)/g)) {
    // Trailing punctuation belongs to the sentence: "read @src/a.ts." mentions src/a.ts.
    const mention = (match[1] ?? '').replace(/[.,;:!?)\]}'"]+$/, '')
    const isPathLike = mention.includes('/') || /\.[A-Za-z0-9]{1,10}$/.test(mention)
    if (isPathLike) return `mentions @${mention}`
  }
  return null
}

export type ResumeFields = {
  source: string
  model?: string
  context_tokens?: number
  seconds_since_last_response?: number
  prompt_cache_likely_expired?: boolean
  estimated_cache_write_usd?: number
}

/** /clear starts a new conversation in the same process; nothing priced before it still exists. */
export function resetForClear(s: State) {
  s.ctx = 0
  s.lastRequestAt = 0
  s.lastTurnAt = 0
  s.lastPingAt = 0
  s.compacted = false
  s.ackedAt = 0
  s.notificationAckedAt = 0
  s.coldWritePending = false
  s.misses = []
  s.pingCount = 0
  s.pingSpendUsd = 0
  s.avoidedColdWrites = 0
  s.savedUsd = 0
  s.held = null
  s.heldRestoreCause = null
  disarm(s)
}

/** Applies a resumed session's fields to the state; returns the line to log, if any. */
export function seedFromResume(s: State, e: ResumeFields, now: number): string | null {
  if (e.source !== 'resume' && e.source !== 'fork') return null
  if (typeof e.context_tokens === 'number' && e.context_tokens > 0) s.ctx = e.context_tokens
  if (typeof e.seconds_since_last_response === 'number') {
    s.lastRequestAt = now - e.seconds_since_last_response * 1000
    s.lastTurnAt = s.lastRequestAt
  }
  if (typeof e.model === 'string') s.lastModel = e.model
  s.compacted = false
  if (e.prompt_cache_likely_expired !== true || s.ctx < s.guardMinTokens) return null
  const usd = typeof e.estimated_cache_write_usd === 'number' ? e.estimated_cache_write_usd : coldUsd(s)
  return `resuming cold. The first message re-writes ${s.ctx.toLocaleString('en-US')} tokens, ${usd == null ? 'price unknown' : `about ${fmtUsd(usd)}`}. /clear and paste a summary if you only need the conclusions.`
}

const COLD_NEXT = 'cold now. keepwarm starts pinging after your next turn'

function statusText(s: State, now: number): string | undefined {
  const guardOff = guardOffText(s, now)
  if (s.stopped) return `keepwarm stopped: ${s.stopped}${guardOff ? ` · ${guardOff}` : ''}`
  // With keepwarm off the line shows only to say why a cold send will go through.
  if (!s.deadline) return guardOff ? `cache cold · ${guardOff}` : undefined
  const pingText = s.last ? ` · last ping read ${fmtTok(s.last.read)} ${fmtUsd(s.last.usd)}` : ''
  const nextText = !s.lastRequestAt ? ' · waiting for the first turn'
    : s.compacted ? ' · waiting for the first turn after compaction'
    : isCold(s, now) ? ` · ${COLD_NEXT}`
    : ` · ping in ${fmtDuration(s.lastRequestAt + s.every - now)}`
  return `keepwarm ${fmtDuration(s.deadline - now)} left${nextText}${pingText}${guardOff ? ` · ${guardOff}` : ''}`
}

function updateStatus($: EngineInterface, s: State, now: number) {
  if (s.hasBand) $.ui.invalidate('ui.render')
  else $.ui.status(statusText(s, now))
  syncTicker($, s, now)
}

function redraw($: EngineInterface, s: State) {
  if (s.hasBand) $.ui.invalidate('ui.render')
}

/** Redraws the band each minute while a window is armed or a send is held; the status line keeps its own updates. */
function syncTicker($: EngineInterface, s: State, now: number) {
  const shouldTick = s.hasBand && (s.deadline > now || isHeld(s, now))
  // A new request moves the minute boundary, so a ticker set from the old one starts again.
  if (s.ticker && (!shouldTick || s.tickerAnchor !== s.lastRequestAt)) {
    s.ticker.cancel()
    s.ticker = null
  }
  if (!shouldTick || s.ticker) return
  // The meter counts whole minutes from the last request, so the redraw lands as its minute turns.
  s.tickerAnchor = s.lastRequestAt
  const intoMinute = s.lastRequestAt ? (((now - s.lastRequestAt) % TICK_MS) + TICK_MS) % TICK_MS : 0
  s.ticker = $.clock.after(Math.max(1000, TICK_MS - intoMinute), () => {
    s.ticker = null
    $.ui.invalidate('ui.render')
    void $.clock.now().then(at => syncTicker($, s, at))
  })
}

/** A cold send the guard dropped, still waiting for the person to send it again or cancel. */
function isHeld(s: State, now: number): boolean {
  return s.held !== null && s.guard === 'refuse' && s.ackedAt !== 0 && s.ackedAt === s.lastRequestAt && isCold(s, now)
}

/** What the band's meter shows; null while nothing is known about the cache, or keepwarm stopped. */
function warmthOf(s: State, now: number): Warmth | null {
  if (s.stopped || !s.lastRequestAt || s.compacted) return null
  const ttl = ttlMsOf(s)
  const usd = coldUsd(s)
  const coldPrice = usd == null ? null : fmtUsd(usd)
  if (isCold(s, now)) return { tone: 'cold', msLeft: 0, ttlMs: ttl, pingMsLeft: null, coldPrice }
  const isPingAhead = s.deadline > 0 && s.every < ttl && s.lastRequestAt + s.every < s.deadline
  return { tone: s.isPinging ? 'pinging' : 'warm', msLeft: s.lastRequestAt + ttl - now, ttlMs: ttl, pingMsLeft: isPingAhead ? ttl - s.every : null, coldPrice }
}

/** The band's words after the state: what happens next, the window, the last ping. The status line's phrases, reordered; the state word already says cold. */
function bandDetails(s: State, now: number): string {
  const guardOff = guardOffText(s, now)
  if (s.stopped) return `${s.stopped} · /keepwarm starts it again${guardOff ? ` · ${guardOff}` : ''}`
  // With keepwarm off the row shows only to say why a cold send will go through.
  if (!s.deadline) return guardOff
  const next = !s.lastRequestAt ? 'waiting for the first turn'
    : s.compacted ? 'waiting for the first turn after compaction'
    : isCold(s, now) ? 'keepwarm starts pinging after your next turn'
    : s.isPinging ? 'pinging now'
    : `ping in ${fmtDuration(s.lastRequestAt + s.every - now)}`
  const pingText = s.last ? ` · last ping read ${fmtTok(s.last.read)} ${fmtUsd(s.last.usd)}` : ''
  return `${next} · keepwarm ${fmtDuration(s.deadline - now)} left${pingText} · ${savingsText(s)}${guardOff ? ` · ${guardOff}` : ''}`
}

/** The band's Send message: the same as sending the held message again from the prompt. */
async function sendHeld($: EngineInterface, s: State) {
  const held = s.held
  if (!held) return
  // Taken at once, so a second press finds nothing left to send.
  s.held = null
  if (!isCold(s, await $.clock.now()) || s.guard !== 'refuse' || s.ackedAt === 0 || s.ackedAt !== s.lastRequestAt) return
  const ackedAt = s.ackedAt
  s.ackedAt = 0
  s.coldWritePending = true
  redraw($, s)
  let failure: string | null = null
  try {
    const result = await $.prompt.submit({ text: held.text, asUser: true })
    if (result.drop !== undefined) failure = result.drop
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err)
  }
  if (failure === null) return
  // Nothing entered: the card comes back as it was.
  s.held = held
  s.ackedAt = ackedAt
  s.coldWritePending = false
  $.ui.toast(`cache-tax: the resend did not go through: ${failure}`)
  redraw($, s)
}

/** The band's Discard message: the message stays unsent and the guard holds the next cold send again. */
function cancelHeld($: EngineInterface, s: State) {
  s.held = null
  s.ackedAt = 0
  redraw($, s)
}

/**
 * A held message whose card is about to go away (a compaction, a resume, another turn, /clear):
 * the text goes back in an empty prompt box, else onto the clipboard, else into the log, and a
 * toast says where and why.
 */
export async function restoreHeld($: EngineInterface, s: State, cause: string) {
  const held = s.held
  s.held = null
  s.heldRestoreCause = null
  if (!held) return
  let whyNotInBox: string
  try {
    const box = await $.prompt.read()
    if (box.text.trim() === '') {
      const filled = await $.prompt.fill({ text: held.text })
      if (filled.isFilled) {
        $.ui.toast(`Your held message is back in the prompt box: ${cause}`)
        return
      }
      whyNotInBox = filled.refusal === 'dialog' ? 'a dialog held the prompt box'
        : filled.refusal === 'no_composer' ? 'this session has no prompt box'
        : 'a hook declined it'
    } else {
      whyNotInBox = 'the prompt box already had a draft'
    }
    const copied = await $.ui.copy({ text: held.text })
    if (copied.isCopied) {
      $.ui.toast(`Your held message is on the clipboard: ${cause}, and ${whyNotInBox}`)
      return
    }
    $.ui.log(`cache-tax: your held message, kept here because ${cause}: ${held.text}`)
    $.ui.toast(`Your held message is in the log: ${cause}, ${whyNotInBox}, and the clipboard copy was refused (${copied.reason})`)
  } catch (err) {
    $.ui.log(`cache-tax: your held message, kept here because ${cause}: ${held.text}`)
    $.ui.toast(`Your held message is in the log: ${cause}, and putting it back threw ${err instanceof Error ? err.message : String(err)}`)
  }
}

function disarm(s: State) {
  if (s.pending) s.pending.cancel()
  s.pending = null
}

// The window and its ping period belong to the session that armed them, so a
// second session, or one resumed from another transcript, never inherits them
// and cannot turn them off. The always switch and the guard mode stay global.
function deadlineKey(s: State): string {
  return `${KEY_DEADLINE}:${s.sid}`
}

function everyKey(s: State): string {
  return `${KEY_EVERY}:${s.sid}`
}

/** Clears this session's own dead window and the bare keys a store written before 2.1.1 still holds. Other sessions' keys are never touched: a read followed by a delete cannot be made atomic against their renewal. */
async function prune($: EngineInterface, s: State, now: number) {
  for (const key of [KEY_DEADLINE, deadlineKey(s)]) {
    const deadline = await $.store.get(key)
    if (deadline === undefined) continue
    if (typeof deadline === 'number' && deadline > now) continue
    await $.store.delete(key)
    await $.store.delete(KEY_EVERY + key.slice(KEY_DEADLINE.length))
  }
}

async function stop($: EngineInterface, s: State, why: string | null, forgetAlways = false) {
  s.deadline = 0
  s.every = pingAfterMsOf(s)
  s.stopped = why
  disarm(s)
  await $.store.delete(deadlineKey(s))
  await $.store.delete(everyKey(s))
  if (forgetAlways) {
    s.always = false
    await $.store.delete(KEY_ALWAYS)
  }
  // The deadline is 0 now, so arm only sets the no-window timer for the guard-off line and updates the status.
  await arm($, s)
}

async function arm($: EngineInterface, s: State) {
  disarm(s)
  if (!s.deadline) {
    // No window: only the guard-off line needs a timer, to appear the moment the cache goes cold.
    const now = await $.clock.now()
    const isUnderThreshold = s.ctx > 0 && s.ctx < s.guardMinTokens
    if (isUnderThreshold && s.lastRequestAt && !s.compacted && !isCold(s, now)) {
      s.pending = $.clock.after(s.lastRequestAt + ttlMsOf(s) - now, () => { void $.clock.now().then(at => updateStatus($, s, at)) })
    }
    updateStatus($, s, now)
    return
  }
  const now = await $.clock.now()
  if (now >= s.deadline) return stop($, s, null)
  // A cold window still needs expiry cleanup, but must not send a model request.
  if (s.lastRequestAt && !s.compacted && !isCold(s, now)) {
    const untilCold = s.lastRequestAt + ttlMsOf(s) - now
    const delay = Math.min(s.deadline - now, untilCold, Math.max(1000, s.lastRequestAt + s.every - now))
    s.pending = $.clock.after(delay, () => { void ping($, s) })
  } else {
    s.pending = $.clock.after(s.deadline - now, () => { void arm($, s) })
  }
  updateStatus($, s, now)
}

async function ping($: EngineInterface, s: State) {
  s.pending = null
  if (!s.deadline) return
  const now = await $.clock.now()
  if (now >= s.deadline) return arm($, s)
  // A turn in the meantime re-armed the timer; this callback is stale.
  if (isCold(s, now)) return arm($, s)
  if (now - s.lastRequestAt < s.every - 1000) return
  s.isPinging = true
  redraw($, s)
  let reply
  try {
    reply = await $.model.fork({ prompt: PING_PROMPT })
  } catch (err) {
    s.isPinging = false
    return stop($, s, `the ping failed, ${err instanceof Error ? err.message : String(err)}`)
  }
  s.isPinging = false
  if (reply === null) return stop($, s, 'the engine did not send the ping, either the snapshot was cold or the API call failed')
  if (reply.isAnswered === false) {
    const reason = reply.reason === 'nothing-to-fork' ? 'no conversation to warm yet'
      : reply.reason === 'api-error' ? `the API call failed (${reply.status === null ? 'no response arrived' : `HTTP ${reply.status}`}, ${reply.error})`
      : reply.reason === 'aborted' ? 'the ping was interrupted'
      : 'the ping returned no text'
    return stop($, s, reason)
  }
  const u = reply.usage
  const price = priceOf(s.lastModel)
  // A warm ping reads the prefix and writes only its own message; a write of a tenth of the read or more means the prefix broke.
  const warm = u.cache_read_input_tokens > 0 && u.cache_creation_input_tokens < 0.1 * u.cache_read_input_tokens
  const usd = price ? pingUsd(u, price, s.ttl) : null
  // Every answered ping is billed, the one that found the cache gone too.
  s.pingCount++
  if (usd != null) s.pingSpendUsd += usd
  s.last = { at: now, read: u.cache_read_input_tokens, write: u.cache_creation_input_tokens, usd, warm }
  if (!warm) return stop($, s, `the ping read ${fmtTok(u.cache_read_input_tokens)} and wrote ${fmtTok(u.cache_creation_input_tokens)} tokens (${fmtUsd(usd)}), the cache was already gone`)
  s.lastRequestAt = now
  s.lastPingAt = now
  await arm($, s)
}

/** The reply to an arming command; on a cold cache it says when pinging starts. */
function armedText(s: State, now: number, windowMs: number): string {
  if (isCold(s, now)) return `keepwarm on for ${fmtDuration(windowMs)}. The cache is cold now, so keepwarm starts pinging after your next turn`
  return `keepwarm on for ${fmtDuration(windowMs)}, a ping ${fmtDuration(s.every)} after each idle stretch keeps the ${s.ttl} cache warm, so the next turn reads it at the cache-read rate`
}

/** On the 5m cache, the first arming of the session says how often it pings and what that costs an hour. */
function fiveMinuteWarning(s: State): string {
  if (s.ttl !== '5m' || s.hasWarnedFiveMinutePings) return ''
  const perHour = pingCostPerHour(s)
  const isPriceUnknown = Boolean(s.lastModel) && !priceOf(s.lastModel)
  // Before a turn has set the context size there is no hourly figure, so the next arming warns again with one.
  s.hasWarnedFiveMinutePings = perHour != null || isPriceUnknown
  const cost = perHour != null ? `about ${fmtUsd(perHour)} an hour at the current ${fmtTok(s.ctx)}-token context`
    : isPriceUnknown ? 'price unknown'
    : 'the cost per hour shows on the next /keepwarm, once a turn has set the context size'
  return `. On the 5m cache keepwarm pings every ${fmtDuration(s.every)}, ${Math.round(HOUR_MS / s.every)} pings an hour: ${cost}`
}

async function startWindow($: EngineInterface, s: State, windowMs: number, every: number) {
  const now = await $.clock.now()
  s.every = every
  if (every === pingAfterMsOf(s)) await $.store.delete(everyKey(s))
  else await $.store.set(everyKey(s), every)
  s.deadline = now + windowMs
  s.stopped = null
  await $.store.set(deadlineKey(s), s.deadline)
  await arm($, s)
}

/** Every form /keepwarm takes, one per line. */
export function keepwarmHelp(s: State): string {
  const window = fmtDuration(s.defaultWindowMs)
  return [
    '/keepwarm                  arm a ' + window + ' window (' + SETTING_TITLES.defaultWindow + ')',
    '/keepwarm 90m              arm a window of your own length, such as 6h, 90m or 2h30m',
    '/keepwarm 90m every 2m     the same, pinging every 2m (at least 1m) for that window only',
    '/keepwarm always           arm ' + window + ' now and at every later session start',
    '/keepwarm off              stop the window and turn always off',
    '/keepwarm status           show the window, the next ping and the last ping',
    '/keepwarm help             show this list',
    `Pings land ${fmtDuration(pingAfterMsOf(s))} after your last turn, on the ${s.ttl} cache.`,
    '',
    settingsHelp(s),
  ].join('\n')
}

/** Where the settings live and what each one holds now. */
function settingsHelp(s: State): string {
  return [
    'Settings (/config, pulse-cache-tax):',
    `  ${SETTING_TITLES.cacheTtl}: ${s.ttl}`,
    `  ${SETTING_TITLES.guardMinTokens}: ${s.guardMinTokens.toLocaleString('en-US')} tokens`,
    `  ${SETTING_TITLES.defaultWindow}: ${fmtDuration(s.defaultWindowMs)}`,
  ].join('\n')
}

/** Every form /cache-tax takes, then /keepwarm's, so one help lists every argument. */
export function cacheTaxHelp(s: State): string {
  return [
    '/cache-tax                 show the cost card',
    '/cache-tax status          show the cost card',
    '/cache-tax guard refuse    hold a cold send once with its price (the default)',
    '/cache-tax guard warn      log a cold send\'s price and send it',
    '/cache-tax help            show this list',
    '',
    keepwarmHelp(s),
  ].join('\n')
}

const KEEPWARM_FORMS = 'a bare /keepwarm, a window such as 6h, 90m or 2h30m, a window with a ping period such as 90m every 2m, always, off, status or help'

function card(s: State, now: number): string {
  const lines: string[] = []
  const ttl = ttlMsOf(s)
  const price = priceOf(s.lastModel)
  lines.push(`${s.lastModel ?? 'model not seen yet'}`)
  if (s.compacted) lines.push('state       reset by compaction, waiting for the first turn')
  else if (!s.lastRequestAt) lines.push('state       no request yet this session')
  else if (isCold(s, now)) lines.push(`state       COLD, last request ${fmtDuration(now - s.lastRequestAt)} ago`)
  else lines.push(`state       warm, ${fmtDuration(s.lastRequestAt + ttl - now)} left`)
  lines.push(`lifetime    ${s.ttl} cache, cold after ${fmtDuration(ttl)} idle${price ? `, writes at $${writeRateOf(price, s.ttl)}/MTok` : ', price unknown'}; set by ${SETTING_TITLES.cacheTtl}`)
  lines.push(`context     ${s.ctx.toLocaleString('en-US')} tokens`)
  lines.push(price
    ? `cold cost   ${fmtUsd(coldUsd(s))} to re-write it (warm turn ${fmtUsd(warmUsd(s))})`
    : 'cold cost   price unknown')
  const always = s.always ? ' (always)' : ''
  const window = fmtDuration(s.defaultWindowMs)
  const idle = s.always ? `off until the next session start, which arms ${window} (always)` : `off (/keepwarm to arm it for ${window})`
  lines.push(`keepwarm    ${s.deadline ? (statusText(s, now) ?? '').replace(/^keepwarm /, 'on, ') + always : s.stopped ? `stopped, ${s.stopped}${always}` : idle}`)
  if (s.deadline || s.pingCount > 0) {
    lines.push(`savings     ${savingsText(s)} this session (${s.avoidedColdWrites} cold write${s.avoidedColdWrites === 1 ? '' : 's'} avoided); the totals reset each session`)
  }
  const pings = breakEvenPings(s)
  if (pings != null) lines.push(`break-even  up to ${pings} pings at the read rate cost one cold write, about ${fmtDuration(pings * s.every)} of idle at one ping per ${fmtDuration(s.every)}`)
  const threshold = `, at ${fmtTok(s.guardMinTokens)} tokens of context or more`
  lines.push(`guard       ${s.guard === 'refuse' ? `refuse once${threshold} (/cache-tax guard warn to only show the price)` : `warn only${threshold} (/cache-tax guard refuse to be stopped once)`}`)
  const guardOff = guardOffText(s, now)
  if (guardOff) lines.push(`            ${guardOff}: this context is ${fmtTok(s.ctx)}, so a cold send goes through`)
  const paid = s.misses.reduce((a, m) => a + (m.usd ?? 0), 0)
  lines.push(`session     ${s.misses.length} cold write${s.misses.length === 1 ? '' : 's'} paid, ${fmtUsd(paid)}`)
  return lines.join('\n')
}

export function freshState(settings: Settings = DEFAULT_SETTINGS): State {
  return {
    hasBand: false, sid: '', ttl: settings.cacheTtl, guardMinTokens: settings.guardMinTokens, defaultWindowMs: settings.defaultWindowMs,
    deadline: 0, every: PING_AFTER_MS[settings.cacheTtl], always: false, lastRequestAt: 0, lastTurnAt: 0, lastPingAt: 0, lastModel: null, ctx: 0, compacted: false,
    guard: 'refuse', ackedAt: 0, notificationAckedAt: 0, coldWritePending: false, misses: [],
    pingCount: 0, pingSpendUsd: 0, avoidedColdWrites: 0, savedUsd: 0, hasWarnedFiveMinutePings: false, heldRestoreCause: null,
    pending: null, last: null, stopped: null, isPinging: false, held: null, ticker: null, tickerAnchor: 0,
  }
}

/** The toast's cause for a held message cleared by a classic SessionStart. */
function sessionStartCause(source: string): string {
  return source === 'resume' ? 'the session was resumed'
    : source === 'fork' ? 'the session was forked'
    : source === 'compact' ? 'the conversation was compacted'
    : source === 'clear' ? 'the conversation was cleared'
    : `the session started again (${source})`
}

export const register: Register = (on, options) => {
  const settings = readSettings(options)
  const s = freshState(settings)
  let light = false
  let noColor = false

  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny === undefined) {
      light = typeof result.value === 'string' && result.value.startsWith('light')
      if (s.hasBand) $.ui.invalidate('ui.render')
    }
    return result
  })

  // The band: one row for the cache (icon, state, what comes next, a warmth meter), and a decision card while a cold send is held.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    if (!s.hasBand || e.props.hasSurvey) return rest
    const now = await $.clock.now()
    const hasRow = Boolean(statusText(s, now)) && !(s.deadline && now >= s.deadline)
    const isHeldNow = isHeld(s, now)
    if (!hasRow && !isHeldNow) return rest
    const { Box, Text, Button } = $.ui.resolve(e)
    // The pulse coral and jade, in the shades that hold contrast on this theme's background; the same values desktop's drawings use.
    const palette = noColor ? null : bandColors(light)
    const coral = palette?.coralInk
    const jade = palette?.jade
    // Desktop draws the meter and the card as images; the terminal, and NO_COLOR anywhere, draws them as text.
    const isGraphic = e.surface === 'desktop' && !noColor
    const drawSvg = (source: string, alt: string, width: number, height: number): RenderElement | null =>
      e.surface === 'desktop' && !noColor ? $.ui.resolve(e).Svg({ source, alt, width, height }) : null
    const bandWidth = Math.max(240, Math.min(1600, (e.props.bodyColumns || 80) * 8 - 8))
    const children: RenderChildren[] = [rest]

    if (hasRow) {
      const state = s.stopped ? 'stopped' : !s.lastRequestAt || s.compacted ? 'unknown' : isCold(s, now) ? 'cold' : 'warm'
      const color = state === 'warm' ? jade : state === 'cold' ? coral : undefined
      const asset = statusIcons[light ? 'light' : 'dark'][state === 'warm' || state === 'cold' ? state : 'neutral']
      const icon = noColor ? Text({ bold: true, children: ['[>]'] })
        : e.surface === 'terminal' ? $.ui.resolve(e).Image({ source: { png: asset.png }, columns: 3, rows: 1, alt: '[>]' })
        : e.surface === 'desktop' ? $.ui.resolve(e).Svg({ source: asset.svg, width: 18, height: 18, alt: 'Cache Tax' })
        : Text({ color, bold: true, children: ['[>]'] })
      // While a send is held its card shows the price, so the row leaves the meter out.
      const warmth = isHeldNow ? null : warmthOf(s, now)
      const meterWidth = Math.max(bandWidth < 300 ? 88 : 104, Math.min(190, Math.round(bandWidth * 0.3)))
      const meterImage = warmth ? drawSvg(meterSvg(warmth, meterWidth), meterAlt(warmth), meterWidth, METER_H) : null
      const meterCells = e.props.bodyColumns >= 70 ? 10 : e.props.bodyColumns >= 50 ? 6 : 0
      const meterText: RenderChildren[] = warmth && !meterImage && meterCells ? (() => {
        const cells = textMeter(warmth, meterCells)
        const fillColor = isSoonCold(warmth) ? palette?.coralFill : jade
        const label = warmth.tone === 'pinging' ? 'pinging'
          : warmth.tone === 'warm' ? `${minutesLeft(warmth.msLeft)}m left`
          : warmth.coldPrice ? `≈${warmth.coldPrice} to re-write` : 'price unknown'
        return [
          ' ',
          ...(cells.filled ? [Text({ color: fillColor, children: [cells.filled] }), Text({ dimColor: true, children: [cells.empty] }), ' '] : []),
          Text({ bold: true, color: warmth.tone === 'cold' ? coral : undefined, children: [label] }),
        ]
      })() : []
      // On desktop the icon's alt names the mod, so the row leads with the state and keeps it in view when narrow.
      const line = Text({ wrap: 'truncate-end', children: [
        ...(isGraphic ? [] : [Text({ dimColor: true, children: ['cache-tax'] }), ' ']),
        Text({ color, bold: true, children: [state] }),
        ...meterText,
        Text({ dimColor: true, children: [` · ${bandDetails(s, now)}`] }),
      ] })
      children.push(Box({ flexDirection: 'row', alignItems: 'center', gap: 1, children: [
        Box({ flexShrink: 0, children: [icon] }),
        Box({ flexGrow: 1, flexShrink: 1, children: [line] }),
        ...(meterImage ? [Box({ flexShrink: 0, children: [meterImage] })] : []),
      ] }))
    }

    if (isHeldNow && s.held) {
      const hold: Hold = { coldFor: fmtDuration(now - s.lastRequestAt - ttlMsOf(s)), rewriteUsd: coldUsd(s), warmUsd: warmUsd(s), tokens: s.ctx.toLocaleString('en-US') }
      const rewrite = hold.rewriteUsd == null ? null : fmtUsd(hold.rewriteUsd)
      // plain draws each hotkey before its label (1: Send message), as Blast Radius's buttons read; a bare digit in an empty prompt presses them.
      const buttons = Box({ flexDirection: 'row', alignItems: 'center', gap: 1, children: [
        ...(s.held.isResendable
          ? [Button({ key: 'cache-tax-send', hotkey: '1', plain: true, label: rewrite ? `Send message ≈${rewrite}` : 'Send message', variant: 'primary', onPress: () => { void sendHeld($, s) } })]
          : []),
        Button({ key: 'cache-tax-cancel', hotkey: '2', plain: true, label: 'Discard message', onPress: () => cancelHeld($, s) }),
        Text({ dimColor: true, wrap: 'truncate-end', children: [s.held.isResendable
          ? 'Or /clear and paste a summary. /keepwarm after sending keeps it warm.'
          : `It ${s.held.blocker ?? 'has an attachment'}, so send it again from the prompt.`] }),
      ] })
      // The full card needs about seven rows; a shorter band gets the one-line card.
      const cardWidth = Math.min(bandWidth, 560)
      const title = e.props.maxRows >= 7 ? drawSvg(holdTitleSvg(hold, cardWidth), holdTitleAlt(hold), cardWidth, HOLD_TITLE_H) : null
      const bars = title ? drawSvg(holdBarsSvg(hold, cardWidth), holdBarsAlt(hold), cardWidth, holdBarsHeight(hold)) : null
      if (title && bars) {
        children.push(Box({ flexDirection: 'column', gap: 1, marginTop: hasRow ? 1 : 0, children: [title, buttons, bars] }))
      } else {
        // The price leads, so a narrow terminal's truncation cuts the tail.
        const lead = `${rewrite ? `about ${rewrite}` : 'price unknown'} to send cold, cache cold for ${hold.coldFor}`
        const tail = rewrite
          ? ` · message held${hold.warmUsd == null ? '' : `, a warm turn about ${fmtUsd(hold.warmUsd)}`}`
          : ` · message held, sending re-writes up to ${hold.tokens} tokens`
        children.push(Box({ flexDirection: 'column', children: [
          Text({ wrap: 'truncate-end', children: [
            Text({ bold: true, color: coral, children: [lead] }),
            Text({ dimColor: true, children: [tail] }),
          ] }),
          buttons,
        ] }))
      }
    }

    return Box({ flexDirection: 'column', children })
  })

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    s.hasBand = e.surface === 'terminal' || e.surface === 'desktop'
    if (s.hasBand) {
      const theme = (await $.config.list()).find(row => row.key === 'theme')?.value
      light = typeof theme === 'string' && theme.startsWith('light')
      noColor = Boolean(await $.env.get('NO_COLOR'))
      $.ui.status(undefined)
    }
    for (const problem of settings.problems) $.ui.toast(`cache-tax: ${problem}`)
    s.sid = await $.session.id()
    const now = await $.clock.now()
    await prune($, s, now)
    const saved = await $.store.get(deadlineKey(s))
    const savedEvery = await $.store.get(everyKey(s))
    const savedGuard = await $.store.get(KEY_GUARD)
    s.deadline = typeof saved === 'number' && saved > now ? saved : 0
    s.every = typeof savedEvery === 'number' && savedEvery >= MIN_PING_MS ? savedEvery : pingAfterMsOf(s)
    s.guard = savedGuard === 'warn' ? 'warn' : 'refuse'
    s.always = (await $.store.get(KEY_ALWAYS)) === true
    // Always means a fresh default window every session, whatever the last one left behind.
    if (s.always) await startWindow($, s, s.defaultWindowMs, pingAfterMsOf(s))
    const usage = await $.session.usage()
    if (usage.context.tokens) s.ctx = usage.context.tokens
    await $.command.register({
      name: 'keepwarm',
      description: `Keep the prompt cache warm: bare for ${fmtDuration(s.defaultWindowMs)}, a window such as 90m, 90m every 2m, always, off, status or help (cache-tax)`,
      argumentHint: '[6h | 90m every 2m | always | off | status | help]',
      immediate: true,
    })
    await $.command.register({
      name: 'cache-tax',
      description: 'Prompt cache state, cold price, keepwarm spend and savings; guard warn|refuse; help (cache-tax, the Mod)',
      argumentHint: '[status | guard warn | guard refuse | help]',
      immediate: true,
    })
    // The hook form of cache-tax ships a /cache-tax:status skill; both installed means two guards.
    const commands = await $.command.list()
    if (commands.some(c => c.name === 'cache-tax:status')) {
      const warning = 'the hook form (cache-tax@claude-code-hooks) is also installed, so a cold send is warned about or refused twice. Uninstall it, or /cache-tax guard warn here.'
      $.ui.log(warning)
      $.ui.toast(`cache-tax: ${warning}`)
    }
    updateStatus($, s, now)
    return r
  })

  // Resume fields seed the guard before any turn of the resumed session has run.
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    if (e.source === 'clear') {
      await restoreHeld($, s, sessionStartCause(e.source))
      await stop($, s, null)
      s.stopped = null
      resetForClear(s)
      s.sid = await $.session.id()
      updateStatus($, s, await $.clock.now())
      return r
    }
    // A held message belongs to the conversation before the resume: it goes back to the person.
    await restoreHeld($, s, sessionStartCause(e.source))
    s.ackedAt = 0
    s.notificationAckedAt = 0
    const line = seedFromResume(s, e, await $.clock.now())
    // The resume payload may omit the model; without it the guard cannot price the cold write.
    if (!s.lastModel) s.lastModel = await $.session.model()
    if (line) $.ui.log(line)
    // The seeded clock decides whether a restored or always window pings before the first turn: never when it is cold.
    await arm($, s)
    return r
  })

  on('command.run', { command: 'keepwarm' }, async ($, e) => {
    const words = String(e.args ?? '').trim().split(/\s+/).filter(Boolean)
    const now = await $.clock.now()
    if (words[0] === 'help') return { text: keepwarmHelp(s) }
    if (words[0] === 'off') {
      const wasAlways = s.always
      await stop($, s, null, true)
      return { text: wasAlways ? 'keepwarm is off, and no longer arms itself at session start' : 'keepwarm is off' }
    }
    if (words[0] === 'always') {
      s.always = true
      await $.store.set(KEY_ALWAYS, true)
      await startWindow($, s, s.defaultWindowMs, pingAfterMsOf(s))
      const cold = isCold(s, now) ? '. The cache is cold now, so keepwarm starts pinging after your next turn' : ''
      return { text: `keepwarm always on: every session starts with a ${fmtDuration(s.defaultWindowMs)} window; /keepwarm off turns it off for good${cold}${fiveMinuteWarning(s)}` }
    }
    if (!words.length) {
      await startWindow($, s, s.defaultWindowMs, pingAfterMsOf(s))
      return { text: armedText(s, now, s.defaultWindowMs) + fiveMinuteWarning(s) }
    }
    if (words[0] === 'status') return { text: statusText(s, now) ?? 'keepwarm is off' }
    const window = parseDuration(words[0] ?? '')
    if (window == null || window <= 0) return { text: `keepwarm does not take "${words.join(' ')}". It takes ${KEEPWARM_FORMS}.` }
    // "every 2m" is a testing knob and lasts only for the window it was given with.
    let every = pingAfterMsOf(s)
    if (words.length > 1) {
      if (words[1] !== 'every' || words.length > 3) return { text: `keepwarm does not take "${words.join(' ')}". After a window it takes only every and a period, as in 90m every 2m. It takes ${KEEPWARM_FORMS}.` }
      const period = parseDuration(words[2] ?? '')
      if (period == null || period < MIN_PING_MS) return { text: `every takes a period of at least 1m, as in /keepwarm 90m every 2m; "${words[2] ?? ''}" is ${period == null ? 'not a period' : 'under 1m'}` }
      every = period
    }
    await startWindow($, s, window, every)
    return { text: armedText(s, now, window) + fiveMinuteWarning(s) }
  })

  on('command.run', { command: 'cache-tax' }, async ($, e) => {
    const words = String(e.args ?? '').trim().split(/\s+/).filter(Boolean)
    const now = await $.clock.now()
    if (words[0] === 'help') return { text: cacheTaxHelp(s) }
    if (words[0] === 'guard') {
      if (words[1] !== 'warn' && words[1] !== 'refuse') return { text: `/cache-tax guard takes warn or refuse; it got ${words[1] === undefined ? 'nothing' : `"${words[1]}"`}` }
      s.guard = words[1]
      await $.store.set(KEY_GUARD, s.guard)
      return { text: s.guard === 'refuse' ? 'guard set to refuse once: a cold send is dropped with its price, the resend goes through' : 'guard set to warn: a cold send goes through with its price shown' }
    }
    if (words.length && words[0] !== 'status') return { text: `/cache-tax does not take "${words.join(' ')}". It takes status, guard warn, guard refuse or help.` }
    return { text: card(s, now) }
  })

  // The message that pays. Its text is read for a leading slash; a held one stays in memory for the band's Send message until the next turn.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'plugin') return next(e)
    if (typeof e.text !== 'string' || e.text.trimStart().startsWith('/')) return next(e)
    const now = await $.clock.now()
    if (!isCold(s, now) || s.ctx < s.guardMinTokens) return next(e)
    if (s.guard === 'warn') {
      $.ui.log(`${guardText(s, now)} Sending anyway; /keepwarm holds the cache once it lands.`)
      s.coldWritePending = true
      return next(e)
    }
    // Only the person's own message is held or let through on a resend. A prompt they did not type keeps the
    // guard's old rule on its own ack (dropped once, the next goes through), so it never touches the held card.
    const isTyped = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (!isTyped) {
      if (s.notificationAckedAt === s.lastRequestAt) {
        s.notificationAckedAt = 0
        s.coldWritePending = true
        return next(e)
      }
      s.notificationAckedAt = s.lastRequestAt
      return { drop: `cache-tax: ${guardText(s, now)} Send it again to pay it, then /keepwarm holds the cache. Or /clear and start from a note.` }
    }
    if (s.ackedAt === s.lastRequestAt) {
      s.ackedAt = 0
      s.coldWritePending = true
      // The resend goes through. When it is a different message, the held one is kept for the person and
      // comes back once this turn ends (in the prompt box, or on the clipboard over a draft).
      if (s.held && s.held.text.trim() !== e.text.trim()) s.heldRestoreCause = 'you sent a different message while it was held'
      else s.held = null
      redraw($, s)
      return next(e)
    }
    // A message kept from an earlier different send whose turn never came is handed back before a new one is held.
    if (s.held && s.heldRestoreCause) await restoreHeld($, s, s.heldRestoreCause)
    s.ackedAt = s.lastRequestAt
    // A plugin's resend expands no attachments or @-mentioned files, so those are left for the person to send again.
    const blocker = heldBlocker(e.text, e.attachments?.length ?? 0)
    s.held = { text: e.text, isResendable: blocker === null, blocker }
    redraw($, s)
    syncTicker($, s, now)
    const nextStep = !s.hasBand ? 'Send it again to pay it, then /keepwarm holds the cache. Or /clear and start from a note.'
      : blocker === null ? 'Send it again, or use Send message below.'
      : `It ${blocker}, so send it again from the prompt to pay it.`
    return { drop: `cache-tax: ${guardText(s, now)} ${nextStep}` }
  })

  on('turn.step', async function* ($, e, next) {
    // A ping's fork is no turn of the person's, so it neither moves the turn clock nor counts as a saving.
    if (!e.agentId && !s.isPinging) {
      const now = await $.clock.now()
      noteTurnRequest(s, now)
      s.lastRequestAt = now
    }
    yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    const now = await $.clock.now()
    // A sleeping host may deliver this turn before the expired window's timer.
    if (s.deadline && now >= s.deadline) await stop($, s, null)
    // turn.step stamps the exact request time; when no step of this turn did, the turn's start is the saving's moment and its end the floor.
    if (now - s.lastRequestAt > e.durationMs) {
      noteTurnRequest(s, now - e.durationMs)
      s.lastRequestAt = now
    }
    s.lastTurnAt = Math.max(s.lastTurnAt, s.lastRequestAt)
    s.compacted = false
    s.ackedAt = 0
    s.notificationAckedAt = 0
    // Another turn ran while a message was held: its card goes away, so the text goes back to the person.
    await restoreHeld($, s, s.heldRestoreCause ?? 'another turn ran before you sent it')
    const u = e.usage
    if (u) {
      if (u.model) s.lastModel = u.model
      const prev = s.ctx
      // A turn's usage is its responses summed, so a ten-step turn reports ten
      // reads of the context. The live window is the engine's figure; the sum
      // is only the fallback for a host that reports no tokens.
      const write = u.cache_creation_input_tokens
      const live = (await $.session.usage()).context.tokens
      s.ctx = live && live > 0 ? live : u.input_tokens + u.cache_read_input_tokens + write
      const full = prev > 20000 && write >= 0.5 * prev
      if (full || s.coldWritePending) {
        const price = priceOf(s.lastModel)
        const usd = price ? write * writeRateOf(price, s.ttl) / 1e6 : null
        s.misses.push({ at: now, tokens: write, usd })
        // pulse: no automatic window after a paid write; pinging runs only after /keepwarm.
        if (s.deadline <= now) {
          $.ui.log(`cold write of ${fmtTok(write)} tokens paid (${fmtUsd(usd)}). /keepwarm holds the cache so it is not paid again.`)
          // One tip, ever: the first cold write that cost enough to matter.
          if (usd != null && usd >= KEEPWARM_TIP_MIN_USD && (await $.store.get(KEY_TIP_SHOWN)) !== true) {
            await $.store.set(KEY_TIP_SHOWN, true)
            $.ui.toast(`Tip: that cold write cost ${fmtUsd(usd)}. /keepwarm pings the cache while you are away, so your next turn reads it at the cache-read rate. /keepwarm help lists its forms.`)
          }
        }
      }
    }
    s.coldWritePending = false
    await arm($, s)
    return r
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) {
      s.compacted = true
      s.ctx = 0
      s.ackedAt = 0
      s.notificationAckedAt = 0
      await restoreHeld($, s, 'the conversation was compacted')
      disarm(s)
      await arm($, s)
    }
    return r
  })
}
