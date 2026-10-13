// pulse-progress drawing: pure functions that turn runs into SVG and text.
//
// No runtime import from 'claude-code': a preview script can import this file as it is.
import type { AgentRun, BarState } from '../types'

// QueerPulse tokens (src/styles/tokens/colors.css), copied as hex: a mod cannot read CSS variables.
export const CORAL = '#e8775a'
export const ROSE = '#b0628f'
export const JADE = '#4a8c6f'
export const JADE_SOFT = '#7cd7ad'
// Lilac is the one non-token colour: peach (--accent-soft) was unreadable as text on cream.
export const LILAC = '#8a72cf'
export const MUTED = '#9a8fa8'
export const FONT = "'DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"
export const SERIF = 'Fraunces,Georgia,serif'

// ---------------------------------------------------------------------------
// Roles: what a subagent type looks like. Unknown types are pride crabs.

export type Role = 'engineer' | 'reviewer' | 'explore' | 'plan' | 'pride'
const ROLES: Role[] = ['engineer', 'reviewer', 'explore', 'plan', 'pride']

export const roleOf = (type: string): Role => {
  const bare = type.replace(/^[^:]*:/, '').toLowerCase()
  if (bare === 'explore') return 'explore'
  if (bare === 'plan') return 'plan'
  if (/reviewer$/.test(bare)) return 'reviewer'
  if (/(engineer|animator)$/.test(bare)) return 'engineer'
  return 'pride'
}

// The terminal's colours, and the crabs' costume trims.
export const ROLE_COLOR: Record<Role, string> = {
  engineer: CORAL,
  reviewer: ROSE,
  explore: JADE,
  plan: LILAC,
  pride: MUTED,
}

// The panel's colours. Fills draw capsules, bars and tiles; inks draw role text on a 14% tint.
// Each ink holds at least 4.5:1 on its chip, on cream and on near-black.
const ROLE_FILL: Record<Role, string> = { ...ROLE_COLOR, pride: '#8a7ba6' }
const ROLE_FILL_DARK: Record<Role, string> = { engineer: CORAL, reviewer: '#c4729f', explore: '#5aa784', plan: '#9580d8', pride: '#a99cc0' }
const ROLE_INK: Record<Role, string> = { engineer: '#9e472c', reviewer: '#8f4672', explore: '#2f6a50', plan: '#5d47a8', pride: '#665a7e' }
const ROLE_INK_DARK: Record<Role, string> = { engineer: '#f0907a', reviewer: '#d98fbb', explore: JADE_SOFT, plan: '#a996e0', pride: '#b8acc9' }

// ---------------------------------------------------------------------------
// Numbers.

export const modelName = (id: string): string => {
  const match = /(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id)
  const [, family = '', major = '', minor] = match ?? []
  if (!id) return ''
  if (!family) return id.replace(/^claude-/, '').replace(/\[.*\]$/, '') || 'unknown model'
  return `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()} ${major}${minor ? '.' + minor : ''}`
}

// Empty when the run reported no model yet.
export const runModel = (a: AgentRun): string => (a.model && a.effort ? `${modelName(a.model)} · ${a.effort}` : modelName(a.model))

export const fmtTokens = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${Math.round(n)}`
export const fmtCost = (usd: number): string =>
  usd >= 1000 ? `$${(usd / 1000).toFixed(1)}k` : usd >= 100 ? `$${Math.round(usd)}` : `$${usd < 10 ? usd.toFixed(2) : usd.toFixed(1)}`
export const fmtTime = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = String(seconds % 60).padStart(2, '0')
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`
}

export const endOf = (a: AgentRun, at: number): number => a.endedAt ?? Math.max(at, a.startedAt)
export const elapsed = (a: AgentRun, at: number): number => endOf(a, at) - a.startedAt
export const ctxOf = (a: AgentRun): number => (a.contextMax ? Math.min(100, Math.round((a.contextTokens / a.contextMax) * 100)) : 0)

export type Totals = { cost: number; tokens: number; time: number }

export const totals = (list: AgentRun[], at: number): Totals => {
  const start = Math.min(...list.map(a => a.startedAt))
  const end = Math.max(...list.map(a => endOf(a, at)))
  return {
    cost: list.reduce((sum, a) => sum + a.costUsd, 0),
    tokens: list.reduce((sum, a) => sum + a.tokens, 0),
    time: list.length ? end - start : 0,
  }
}

// The band's progress: finished runs out of all runs since the last dismiss.
export const progressOf = (done: number, total: number) => ({ done, total, ratio: total ? done / total : 0, isFinished: total > 0 && done === total })
export const progress = (list: AgentRun[]) => progressOf(list.filter(a => a.status !== 'running').length, list.length)

// ---------------------------------------------------------------------------
// Motion. Every redraw is a new image whose CSS animations start over, so each one is
// started part way through: a loop at the wall clock's phase, a tween at the time since its change.

export const TWEEN_MS = 700
const EASE = 'cubic-bezier(.33,1,.68,1)'
// The same easeOutCubic in JS, to find where a tween stands when the next change lands on it.
const eased = (t: number): number => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3)
export const isTweenAt = (changedAt: number | undefined, at: number): changedAt is number =>
  changedAt !== undefined && at - changedAt >= 0 && at - changedAt < TWEEN_MS
const between = (from: number, to: number, changedAt: number | undefined, at: number): number =>
  isTweenAt(changedAt, at) ? from + (to - from) * eased((at - changedAt) / TWEEN_MS) : to

// The delay that starts a loop of `period` seconds where the clock has it, `offset` seconds further on.
export const phase = (at: number, period: number, offset = 0): string => `${(-(((at / 1000) % period) + offset)).toFixed(3)}s`

// The ratio the band shows at `at`: the target, or a point on the way to it.
export const shownRatio = (b: BarState, at: number): number => between(b.fromRatio, progressOf(b.done, b.total).ratio, b.changedAt, at)

// The percent an agent row's context bar shows when settled (a finished run keeps its last fill),
// and at `at` while the fill tweens.
export const ctxTarget = (a: AgentRun): number => ctxOf(a)
export const shownCtx = (a: AgentRun, at: number): number => between(a.ctxFrom ?? ctxTarget(a), ctxTarget(a), a.ctxAt, at)

// A run after a change: when its bar's fill or colour changed, it tweens from where the bar stood at `at`.
export const withCtxTween = (before: AgentRun, after: AgentRun, at: number): AgentRun =>
  ctxTarget(before) !== ctxTarget(after) || before.status !== after.status
    ? { ...after, ctxFrom: shownCtx(before, at), ctxAt: at }
    : after

// ---------------------------------------------------------------------------
// Text in SVG.

export const xml = (s: string): string =>
  s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] ?? ch)

const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿가-힣豈-﫿！-｠\u{1F300}-\u{1FAFF}]/u
const charEm = (ch: string): number =>
  WIDE.test(ch) ? 1 : /[0-9]/.test(ch) ? 0.67 : /[\s.,:;'|!il()[\]]/.test(ch) ? 0.3 : /[A-Zmw@%]/.test(ch) ? 0.72 : 0.56
export const textWidth = (s: string, size: number): number => [...s].reduce((width, ch) => width + charEm(ch) * size, 0)

export const fitText = (s: string, size: number, maxW: number): string => {
  if (textWidth(s, size) <= maxW) return s
  let out = ''
  for (const ch of s) {
    if (textWidth(out + ch + '…', size) > maxW) break
    out += ch
  }
  return out + '…'
}

// ---------------------------------------------------------------------------
// Colour: the band runs coral, rose, jade along its length, so it warms into jade as work lands.

const hex = (c: string): number[] => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16))
const mix = (from: string, to: string, t: number): string =>
  '#' + hex(from).map((v, i) => Math.round(v + ((hex(to)[i] ?? 0) - v) * t).toString(16).padStart(2, '0')).join('')
const pulseAt = (t: number): string => (t < 0.5 ? mix(CORAL, ROSE, t * 2) : mix(ROSE, JADE, (t - 0.5) * 2))

const noise = (x: number, y: number): number => {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
  return s - Math.floor(s)
}

// ---------------------------------------------------------------------------
// Pixel crabs (sprites from savvy-progress, after DockCrab's Clawd), one costume per role.

const CLAY = '#D97757'
const INK = '#1F1E1D'

type Fill = (x: number, y: number, w: number, h: number, c: string, cls?: string) => void

const stamp = (f: Fill, x: number, y: number, rows: string[], map: Record<string, string>, cls?: string): void =>
  rows.forEach((row, dy) => [...row].forEach((ch, dx) => map[ch] && f(x + dx, y + dy, 1, 1, map[ch] ?? '', cls)))

const crabBody = (f: Fill, armFront = 0, armCls?: string): void => {
  f(7, 10, 16, 12, CLAY)
  f(3, 14, 4, 4, CLAY)
  f(23, 14 + armFront, 4, 4, CLAY, armCls)
  f(9, 12, 2, 2, INK)
  f(19, 12, 2, 2, INK)
  f(7, 22, 2, 4, CLAY, 'la')
  f(17, 22, 2, 4, CLAY, 'la')
  f(11, 22, 2, 4, CLAY, 'lb')
  f(21, 22, 2, 4, CLAY, 'lb')
}

const PRIDE = ['#E40303', '#FF8C00', '#FFED00', '#008026', '#24408E', '#732982']

const COSTUMES: Record<Role, (f: Fill, t: string) => void> = {
  // Pride: holds a six-stripe flag that waves while the crab works.
  pride: f => {
    crabBody(f, -4)
    f(25, 1, 1, 13, '#8E929A')
    PRIDE.forEach((c, i) => f(26, 1 + i, 4, 1, c, 'flag'))
  },
  // Engineer: hard hat; the wrench turns a bolt.
  engineer: (f, t) => {
    crabBody(f)
    stamp(f, 6, 4, ['.....yyyyyyyy.....', '...yyyyyhhyyyyy...', '..yyyyyyhhyyyyyy..', '..yyyyyyhhyyyyyy..', '.yyyyyyyhhyyyyyyy.', 'dddddddddddddddddd'], { y: '#F5C542', h: '#FBE08A', d: '#C99A1E' })
    f(13, 5, 4, 2, t)
    stamp(f, 0, 10, ['.s.s', 'sss.', '.s..', '.s..'], { s: '#8E929A' }, 'it')
  },
  // Reviewer: deerstalker; the magnifier sweeps and glints.
  reviewer: (f, t) => {
    crabBody(f, -4, 'it')
    stamp(f, 6, 3, ['......bbbbbb......', '....bbcbbcbbbb....', '...bbbbbbbbbbbb...', '..bcbbcbbcbbcbbb..', '.bbbbbbbbbbbbbbbb.', 'dddddddddddddddddd'], { b: '#7A4A26', c: '#A0703F', d: '#5A3519' })
    f(6, 9, 18, 1, t)
    stamp(f, 23, 1, ['.kkk.', 'k...k', 'k...k', 'k...k', '.kkk.'], { k: '#3A3A3C' }, 'it')
    f(24, 2, 3, 3, 'rgba(169,214,245,.7)', 'it'); f(25, 6, 1, 4, '#7A4A26', 'it'); f(24, 2, 1, 1, '#fff', 'gl')
  },
  // Explore: pirate scout; the cutlass fences.
  explore: (f, t) => {
    crabBody(f)
    stamp(f, 5, 3, ['.kk..............kk.', '.kkk....kkkk....kkk.', '..kkkkkkkwwkkkkkkk..', '..kkkkkkkkkkkkkkkk..', '.gggggggggggggggggg.'], { k: '#55514C', w: '#F8F6F1', g: t })
    f(7, 11, 11, 1, INK); f(18, 11, 4, 3, INK)
    f(27, 6, 1, 9, '#C9CCD2', 'it'); f(26, 15, 3, 1, '#7A4A26', 'it')
  },
  // Plan: astronaut in a glass dome; floats, and the antenna and the star blink.
  plan: (f, t) => {
    crabBody(f)
    f(6, 7, 18, 1, '#E6E8EE'); f(5, 8, 1, 14, '#E6E8EE'); f(24, 8, 1, 14, '#E6E8EE'); f(6, 22, 18, 1, '#C9CCD2')
    f(6, 8, 18, 14, 'rgba(169,214,245,.32)'); f(8, 9, 2, 1, '#fff'); f(8, 10, 1, 2, '#fff')
    f(14, 4, 2, 3, '#C9CCD2'); f(14, 2, 2, 2, t, 'ant'); f(13, 18, 4, 2, t)
    f(27, 3, 1, 3, '#F5C542', 'star'); f(26, 4, 3, 1, '#F5C542', 'star')
  },
}

// Pure CSS, run by the compositor. Every working crab walks; each costume moves its prop.
// Eased loops that rest at 0% and 100%, each started at the clock's phase so a redraw picks the motion up.
export const crabCss = (at: number): string => {
  const d = (period: number, offset = 0) => phase(at, period, offset)
  return `<style>
.run .la{animation:st .5s ease-in-out infinite ${d(0.5)}}.run .lb{animation:st .5s ease-in-out infinite ${d(0.5, 0.25)}}
.run .bd{animation:bob .5s ease-in-out infinite ${d(0.5, 0.125)}}
.run g{transform-box:fill-box}
@keyframes st{0%,100%{transform:translateY(0)}50%{transform:translateY(-1px)}}@keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(1px)}}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.15}}
.c-pride.run .flag{transform-origin:0 50%;animation:wave .5s ease-in-out infinite ${d(0.5)}}
.c-pride.run .flag:nth-child(even){animation-delay:${d(0.5, 0.25)}}
@keyframes wave{0%,100%{transform:skewY(0) scaleX(1)}50%{transform:skewY(-10deg) scaleX(.85)}}
.c-engineer.run .it{transform-origin:100% 100%;animation:twist .5s ease-in-out infinite ${d(0.5)}}
@keyframes twist{0%,100%{transform:rotate(0)}50%{transform:rotate(-35deg)}}
.c-reviewer.run .it{animation:scan 1s ease-in-out infinite ${d(1)}}
.c-reviewer.run .gl{animation:blink 1s ease-in-out infinite ${d(1, 0.5)}}
@keyframes scan{0%,100%{transform:translate(0,0)}50%{transform:translate(-2px,2px)}}
.c-explore.run .it{transform-origin:50% 100%;animation:fence .5s ease-in-out infinite ${d(0.5)}}
@keyframes fence{0%,100%{transform:rotate(0)}50%{transform:rotate(25deg)}}
.c-plan.run{animation:float 1s ease-in-out infinite ${d(1)}}
.c-plan.run .la,.c-plan.run .lb,.c-plan.run .bd{animation:none}
.c-plan.run .ant{animation:blink 1s ease-in-out infinite ${d(1)}}
.c-plan.run .star{animation:blink .5s ease-in-out infinite ${d(0.5, 0.25)}}
@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-2px)}}
@media (prefers-reduced-motion: reduce){.run,.run g{animation:none!important}}
</style>`
}

export const crab = (x: number, y: number, role: Role, isWalking = false, scale = 1.1): string => {
  const groups = new Map<string, string[]>([['bd', []]])
  const f: Fill = (cx, cy, w, h, c, cls = 'bd') => {
    if (!groups.has(cls)) groups.set(cls, [])
    groups.get(cls)?.push(`<rect x="${cx}" y="${cy}" width="${w}" height="${h}" fill="${c}"/>`)
  }
  COSTUMES[role](f, ROLE_COLOR[role])
  const group = (cls: string) => `<g class="${cls}">${(groups.get(cls) ?? []).join('')}</g>`
  const props = [...groups.keys()].filter(k => k !== 'bd' && k !== 'la' && k !== 'lb')
  const body = `<g class="bd">${(groups.get('bd') ?? []).join('')}${props.map(group).join('')}</g>`
  return `<g transform="translate(${x},${y}) scale(${scale})" shape-rendering="crispEdges"><g class="c-${role}${isWalking ? ' run' : ''}">${body}${group('la')}${group('lb')}</g></g>`
}

// ---------------------------------------------------------------------------
// The band above the prompt.

export const BAND_H = 22
const BAR_H = 16
const CELL = 3
const CRAB_W = 26

const bandText = (done: number, total: number): string =>
  progressOf(done, total).isFinished ? 'All done' : `${done}/${total} · ${total - done} working`
const percentText = (done: number, total: number): string => `${Math.round(progressOf(done, total).ratio * 100)}%`

// One tween: the element's attributes hold where it ends, the keyframe only where it starts.
const tweenCss = (cls: string, from: string, delay: number): string =>
  `.${cls}{animation:${cls}k ${TWEEN_MS}ms ${EASE} ${delay}ms both}@keyframes ${cls}k{from{${from}}}`

export const bandSvg = (b: BarState, W: number, at: number): string => {
  const H = BAND_H
  const p = progressOf(b.done, b.total)
  const was = progressOf(b.fromDone, b.fromTotal)
  const running = p.total - p.done
  const since = Math.round(at - b.changedAt)
  // A band that was hidden at zero runs has nothing to tween from.
  const isTweening = b.fromTotal > 0 && isTweenAt(b.changedAt, at)
  const title = 'Pulse'
  const BAR_X = Math.round(16 + textWidth(title, 14) + 12)
  const BAR_W = Math.max(60, W - BAR_X - 46 - CRAB_W)
  const fillW = Math.round(BAR_W * p.ratio)
  const fromFillW = isTweening ? Math.round(BAR_W * Math.min(1, Math.max(0, b.fromRatio))) : fillW
  const cols = Math.floor(fillW / CELL)
  const dotCols = Math.floor(Math.max(fillW, fromFillW) / CELL)
  const rows = Math.floor(BAR_H / CELL)
  // Dithered fill, sparse at the start and dense toward the head, as one mask path per twinkle class.
  // Columns past the final fill (a bar on its way down) stay at the head's density.
  const paths = ['', '', '', '']
  for (let c = 0; c < dotCols; c++) {
    const density = Math.min(0.95, 0.35 + 0.6 * Math.pow(c / Math.max(1, cols), 1.2))
    for (let r = 0; r < rows; r++) {
      if (noise(c, r) < density) paths[Math.floor(noise(r, c) * 4)] += `M${c * CELL + 1} ${r * CELL + 1}h2v2h-2z`
    }
  }
  const mask = paths.map((d, i) => (d ? `<path class="t${i}" fill="#fff" d="${d}"/>` : '')).join('')

  const pillOf = (text: string, w: number) => {
    const pillW = Math.round(18 + text.length * 6.6)
    return { text, pillW, pillX: Math.max(0, Math.min(BAR_W - pillW, w - pillW)) }
  }
  const pillColorOf = (isFinished: boolean, pill: ReturnType<typeof pillOf>) =>
    isFinished ? JADE : pulseAt(Math.min(1, (pill.pillX + pill.pillW) / BAR_W))
  const to = pillOf(bandText(p.done, p.total), fillW)
  const from = pillOf(bandText(was.done, was.total), fromFillW)
  const pillColor = pillColorOf(p.isFinished, to)
  const dot = p.isFinished ? JADE : CORAL
  const percent = percentText(p.done, p.total)
  const fromPercent = percentText(was.done, was.total)
  const isJadeTween = isTweening && was.isFinished !== p.isFinished
  const isLabelTween = isTweening && from.text !== to.text
  const isPercentTween = isTweening && fromPercent !== percent

  const tweens = isTweening
    ? [
        tweenCss('rv', `width:${fromFillW}px`, -since),
        tweenCss('pl', `transform:translateX(${from.pillX - to.pillX}px)`, -since),
        tweenCss('pw', `width:${from.pillW}px;fill:${pillColorOf(was.isFinished, from)}`, -since),
        isJadeTween ? tweenCss('fj', `opacity:${was.isFinished ? 1 : 0}`, -since) : '',
        isJadeTween ? tweenCss('dt', `fill:${was.isFinished ? JADE : CORAL}`, -since) : '',
        // Crossfades: the old words leave over the first 45%, the new ones arrive from 15% to 60%.
        isLabelTween || isPercentTween
          ? `.xo{animation:xo ${TWEEN_MS}ms ease-in-out ${-since}ms both}.xi{animation:xi ${TWEEN_MS}ms ease-in-out ${-since}ms both}@keyframes xo{0%{opacity:1}45%,100%{opacity:0}}@keyframes xi{0%,15%{opacity:0}60%,100%{opacity:1}}`
          : '',
      ].join('')
    : ''
  const fillRects = [
    !p.isFinished || isJadeTween ? `<rect width="${BAR_W}" height="${BAR_H}" fill="url(#g)" mask="url(#m)"/>` : '',
    p.isFinished || isJadeTween
      ? `<rect class="fj" width="${BAR_W}" height="${BAR_H}" fill="${JADE}" opacity="${p.isFinished ? 1 : 0}" mask="url(#m)"/>`
      : '',
  ].join('')
  const label = (text: string, x: number, cls: string, opacity: number) =>
    `<text${cls ? ` class="${cls}"` : ''} x="${x}" y="${BAR_H / 2 + 4}" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="600" fill="#ffffff"${opacity < 1 ? ` opacity="${opacity}"` : ''}>${xml(text)}</text>`
  const percentLabel = (text: string, cls: string, opacity: number) =>
    `<text class="m${cls ? ` ${cls}` : ''}" x="${W - CRAB_W - 6}" y="${H / 2 + 4.5}" text-anchor="end" font-family="${FONT}" font-size="12.5" style="font-variant-numeric:tabular-nums"${opacity < 1 ? ` opacity="${opacity}"` : ''}>${text}</text>`
  // Inside the moving pill group the old label sits where the old pill's centre was at the start,
  // clipped to the pill as it changes width so a longer old label never spills onto the track.
  const pillRect = (cls: string, fill: string) =>
    `<rect class="${cls}" x="${to.pillX}" width="${to.pillW}" height="${BAR_H}" rx="${BAR_H / 2}"${fill ? ` fill="${fill}"` : ''}/>`
  const labels = isLabelTween
    ? `<g clip-path="url(#pc)">${label(from.text, to.pillX + from.pillW / 2, 'xo', 0)}${label(to.text, to.pillX + to.pillW / 2, 'xi', 1)}</g>`
    : label(to.text, to.pillX + to.pillW / 2, '', 1)
  const percents = isPercentTween ? `${percentLabel(fromPercent, 'xo', 0)}${percentLabel(percent, 'xi', 1)}` : percentLabel(percent, '', 1)
  const d = (period: number, offset = 0) => phase(at, period, offset)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<style>
.tx{fill:#2d1b3d}.m{fill:#8a7f95}.k{fill:#efe8e0}
@media (prefers-color-scheme: dark){.tx{fill:#f7f3ee}.m{fill:#a89cb4}.k{fill:#2a1e38}}
.t0,.t1,.t2,.t3{animation:tw 2.2s ease-in-out infinite ${d(2.2)}}
.t1{animation-duration:2.8s;animation-delay:${d(2.8, 0.7)}}.t2{animation-duration:1.9s;animation-delay:${d(1.9, 1.3)}}.t3{animation-duration:3.3s;animation-delay:${d(3.3, 0.4)}}
@keyframes tw{0%,100%{opacity:1}50%{opacity:${p.isFinished ? 0.8 : 0.35}}}
${tweens}
@media (prefers-reduced-motion: reduce){.t0,.t1,.t2,.t3,.rv,.pl,.pw,.fj,.dt,.xo,.xi{animation:none}}
</style>
<defs><clipPath id="c"><rect width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}"/></clipPath>
<clipPath id="r"><rect class="rv" width="${fillW}" height="${BAR_H}"/></clipPath>
<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${BAR_W}" y2="0"><stop offset="0" stop-color="${CORAL}"/><stop offset=".5" stop-color="${ROSE}"/><stop offset="1" stop-color="${JADE}"/></linearGradient>
<mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="${BAR_W}" height="${BAR_H}">${mask}</mask>${isLabelTween ? `<clipPath id="pc">${pillRect('pw', '')}</clipPath>` : ''}</defs>
<circle class="dt" cx="5" cy="${H / 2}" r="4" fill="${dot}"/>
<text class="tx" x="16" y="${H / 2 + 5}" font-family="${SERIF}" font-size="14" font-style="italic" font-weight="600">${title}</text>
<g transform="translate(${BAR_X},${(H - BAR_H) / 2})">
<rect class="k" width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}"/>
<g clip-path="url(#c)"><g clip-path="url(#r)">${fillRects}</g></g>
<g class="pl">${pillRect('pw', pillColor)}
${labels}</g>
</g>
${percents}
${crabCss(at)}${crab(W - CRAB_W + 1, 0, 'pride', running > 0, 0.8)}
</svg>`
}

// ---------------------------------------------------------------------------
// The panel. Neutral tones on cream and on near-black; each role has a fill and an ink.

const TEXT_LIGHT = '45,27,61'
const TEXT_DARK = '243,239,233'
const PANE_LIGHT = '#faf6f0'
const PANE_DARK = '#141414'
// Coral text on cream needs this deeper tint to read.
const FAIL_INK = '#9e472c'

const roleRules = (fills: Record<Role, string>, inks: Record<Role, string>): string =>
  ROLES.map(role => `.f-${role}{fill:${fills[role]}}.t-${role}{fill:${inks[role]}}`).join('')

const paneCss = (at: number): string => `<style>
.tx{fill:rgb(${TEXT_LIGHT})}.s{fill:rgba(${TEXT_LIGHT},.68)}.m{fill:rgba(${TEXT_LIGHT},.63)}.k{fill:rgba(${TEXT_LIGHT},.08)}.ln{stroke:rgba(${TEXT_LIGHT},.10)}
.ck{stroke:${JADE}}.xm{stroke:${CORAL}}.xmf{fill:${CORAL}}.cdone{fill:${mix(JADE, PANE_LIGHT, 0.2)}}.cfail{fill:${mix(FAIL_INK, PANE_LIGHT, 0.3)}}.t-fail{fill:${FAIL_INK}}
.cd{opacity:.8}.cx{fill:${FAIL_INK};opacity:.55}
${roleRules(ROLE_FILL, ROLE_INK)}
@media (prefers-color-scheme: dark){.tx{fill:rgb(${TEXT_DARK})}.s{fill:rgba(${TEXT_DARK},.65)}.m{fill:rgba(${TEXT_DARK},.49)}.k{fill:rgba(255,255,255,.08)}.ln{stroke:rgba(255,255,255,.07)}
.ck{stroke:${JADE_SOFT}}.xm{stroke:#f0907a}.cdone{fill:${mix(JADE_SOFT, PANE_DARK, 0.5)}}.cfail{fill:${mix(CORAL, PANE_DARK, 0.5)}}.t-fail{fill:#f0907a}
.cd{opacity:.6}.cx{fill:${CORAL};opacity:.55}
${roleRules(ROLE_FILL_DARK, ROLE_INK_DARK)}}
.live{animation:p 1.6s ease-in-out infinite ${phase(at, 1.6)}}@keyframes p{0%,100%{opacity:1}50%{opacity:.3}}
.sh{transform-box:fill-box;animation:sh 2.4s linear infinite ${phase(at, 2.4)}}@keyframes sh{from{transform:translateX(-100%)}to{transform:translateX(100%)}}
.cap .cb{transition:opacity .15s}.cap:hover .cb{opacity:1}
@media (prefers-reduced-motion: reduce){.live,.sh{animation:none}.sh{display:none}.cap .cb{transition:none}}
</style>`

const SHEEN_DEF = '<defs><linearGradient id="sheen" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>'

// `at` is the clock at draw time: the loops start at its phase.
const svg = (W: number, h: number, body: string, at: number): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" viewBox="0 0 ${W} ${h}">${paneCss(at)}${crabCss(at)}${SHEEN_DEF}${body}</svg>`

const textAt = (x: number, y: number, cls: string, size: number, content: string, extra = ''): string =>
  `<text class="${cls}" x="${x}" y="${y}" font-family="${FONT}" font-size="${size}"${extra}>${xml(content)}</text>`
const TABULAR = ' style="font-variant-numeric:tabular-nums"'

const checkMark = (x: number, y: number): string =>
  `<path class="ck" d="M${x - 5} ${y}l3.5 3.5 6.5-7" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
const crossMark = (x: number, y: number): string =>
  `<path class="xm" d="M${x - 3.5} ${y - 3.5}l7 7M${x + 3.5} ${y - 3.5}l-7 7" fill="none" stroke-width="1.8" stroke-linecap="round"/>`

const statusMark = (x: number, y: number, a: AgentRun): string => {
  if (a.status === 'running') return `<circle class="live f-${roleOf(a.type)}" cx="${x}" cy="${y}" r="3.5"/>`
  return a.status === 'done' ? checkMark(x, y) : crossMark(x, y)
}

// ---------------------------------------------------------------------------
// The timeline: every run on one time axis, packed into as many lanes as ran at once.

const TIMELINE_RUNS = 60
const MAX_LANES = 8

type Placed = { run: AgentRun; lane: number; end: number; isOverflow: boolean }

// A run takes the first lane whose last run ended before it started; past the cap, it is drawn over the lane freed longest ago.
export const packLanes = (runs: AgentRun[], at: number, maxLanes = MAX_LANES): { placed: Placed[]; lanes: number } => {
  const laneEnds: number[] = []
  const placed = [...runs]
    .sort((left, right) => left.startedAt - right.startedAt)
    .map((run): Placed => {
      const end = endOf(run, at)
      let lane = laneEnds.findIndex(laneEnd => laneEnd < run.startedAt)
      const isOverflow = lane < 0 && laneEnds.length >= maxLanes
      if (lane < 0) lane = isOverflow ? laneEnds.indexOf(Math.min(...laneEnds)) : laneEnds.length
      // An overflow run shares a lane without holding it, so the runs after it still find free lanes.
      if (!isOverflow) laneEnds[lane] = end
      return { run, lane, end, isOverflow }
    })
  return { placed, lanes: laneEnds.length }
}

type Timeline = { body: string; height: number; span: number }

// Lanes of capsules from `top`, `width` wide. The full version has tooltips, shimmer and an axis,
// and leaves out runs past the lane cap (the header counts them).
const timeline = (list: AgentRun[], at: number, top: number, width: number, laneH: number, isFull: boolean): Timeline => {
  const runs = list.slice(-TIMELINE_RUNS)
  if (!runs.length) return { body: '', height: 0, span: 0 }
  const laneGap = isFull ? 3 : 2
  const { placed, lanes } = packLanes(runs, at)
  const origin = Math.min(...runs.map(run => run.startedAt))
  const span = Math.max(1, Math.max(...placed.map(item => item.end)) - origin)
  const radius = laneH / 2
  const capsules = placed
    .filter(item => !(isFull && item.isOverflow))
    .map(({ run, lane, end }, index) => {
      const role = roleOf(run.type)
      const capsuleW = Math.max(4, ((end - run.startedAt) / span) * width)
      const x = Math.min(width - capsuleW, ((run.startedAt - origin) / span) * width)
      const y = top + lane * (laneH + laneGap)
      const box = `x="${x.toFixed(1)}" y="${y}" width="${capsuleW.toFixed(1)}" height="${laneH}" rx="${radius}"`
      const isRunning = run.status === 'running'
      const fillClass = run.status === 'failed' ? 'cx' : isRunning ? `f-${role}` : `f-${role} cd`
      const base = `<rect class="cb ${fillClass}" ${box}/>`
      // A running run shimmers and leads with a dot in its role's ink.
      const glow =
        isRunning && isFull
          ? `<clipPath id="tl${index}"><rect ${box}/></clipPath><g clip-path="url(#tl${index})"><rect class="sh" ${box} fill="url(#sheen)" style="animation-delay:${phase(at, 2.4, lane * 0.35)}"/></g><circle class="t-${role}" cx="${(x + capsuleW - radius).toFixed(1)}" cy="${y + radius}" r="${radius}"/>`
          : ''
      const label = `${run.description || run.type}, ${run.type}, ${fmtTime(end - run.startedAt)}${run.status === 'failed' ? ', stopped' : ''}`
      return isFull ? `<g class="cap"><title>${xml(label)}</title>${base}${glow}</g>` : base
    })
    .join('')
  const lanesH = lanes * (laneH + laneGap) - laneGap
  if (!isFull) return { body: capsules, height: lanesH, span }
  const axisY = top + lanesH + 5.5
  const axis = `<line class="ln" x1="0" y1="${axisY}" x2="${width}" y2="${axisY}"/>${textAt(0, axisY + 13, 'm', 10, '0:00', TABULAR)}${textAt(width, axisY + 13, 'm', 10, fmtTime(span), `${TABULAR} text-anchor="end"`)}`
  return { body: capsules + axis, height: lanesH + 5.5 + 16, span }
}

// ---------------------------------------------------------------------------
// The header: live state, totals, timeline.

export type Drawing = { source: string; height: number }

export const statusPhrase = (list: AgentRun[]): string => {
  const working = list.filter(a => a.status === 'running').length
  const failed = list.filter(a => a.status === 'failed').length
  if (!list.length) return 'No agents yet'
  if (working) return `${working} working`
  return failed ? `All ${list.length} finished` : `All ${list.length} done`
}

const STAT_LABEL = 11
const STAT_VALUE = 12.5

export const headerSvg = (W: number, list: AgentRun[], at: number, clockAt: number): Drawing => {
  const sums = totals(list, at)
  const working = list.filter(a => a.status === 'running').length
  const failed = list.filter(a => a.status === 'failed').length
  const mark = working
    ? `<circle class="live" cx="6" cy="15" r="4" fill="${CORAL}"/>`
    : list.length
      ? checkMark(7, 15)
      : `<circle class="k" cx="6" cy="15" r="4"/>`
  const stopped = !working && failed
    ? `<tspan class="t-fail" dx="8" font-family="${FONT}" font-size="11.5" font-style="normal" font-weight="600">${failed} stopped</tspan>`
    : ''
  const status = `${mark}<text class="tx" x="18" y="20" font-family="${SERIF}" font-size="15" font-style="italic" font-weight="600">${xml(statusPhrase(list))}${stopped}</text>
<text x="${W}" y="22" text-anchor="end"><tspan class="m" font-family="${FONT}" font-size="11">elapsed</tspan><tspan class="tx" dx="6" font-family="${SERIF}" font-size="20" font-weight="600"${TABULAR}>${fmtTime(sums.time)}</tspan></text>`
  if (!list.length) return { source: svg(W, 30, status, clockAt), height: 30 }

  // The stats row: the first layout that fits, from the fullest to the most compact.
  const doneCount = list.length - working
  const agentValues = working ? [`${doneCount} of ${list.length} done`, `${doneCount}/${list.length} done`, `${doneCount}/${list.length}`] : [`${list.length}`]
  const pairsOf = (agents: string, hasTokens: boolean): [string, string][] => [
    ['cost', '≈' + fmtCost(sums.cost)],
    ...(hasTokens ? ([['tokens', fmtTokens(sums.tokens)]] as [string, string][]) : []),
    ['agents', agents],
  ]
  const shortest = agentValues[agentValues.length - 1] ?? ''
  const layouts: { pairs: [string, string][]; gap: number }[] = [
    ...agentValues.map(agents => ({ pairs: pairsOf(agents, true), gap: 25 })),
    { pairs: pairsOf(shortest, false), gap: 25 },
    { pairs: pairsOf(shortest, false), gap: 16 },
  ]
  const widthOf = ({ pairs, gap }: { pairs: [string, string][]; gap: number }) =>
    pairs.reduce((sum, [label, value]) => sum + textWidth(label, STAT_LABEL) + 5 + textWidth(value, STAT_VALUE), 0) + gap * (pairs.length - 1)
  const layout = layouts.find(candidate => widthOf(candidate) <= W) ?? layouts[layouts.length - 1] ?? layouts[0]!
  let cursor = 0
  const stats = layout.pairs
    .map(([label, value], index) => {
      const labelW = textWidth(label, STAT_LABEL)
      const divider = index ? `<line class="ln" x1="${cursor - layout.gap / 2}" y1="40" x2="${cursor - layout.gap / 2}" y2="53"/>` : ''
      const pair = `${divider}${textAt(cursor, 51, 'm', STAT_LABEL, label)}${textAt(cursor + labelW + 5, 51, 'tx', STAT_VALUE, value, `${TABULAR} font-weight="600"`)}`
      cursor += labelW + 5 + textWidth(value, STAT_VALUE) + layout.gap
      return pair
    })
    .join('')
  const lanes = timeline(list, at, 68, W, 6, true)
  const height = 68 + lanes.height
  return { source: svg(W, height, `${status}${stats}${lanes.body}`, clockAt), height }
}

// ---------------------------------------------------------------------------
// One row per run: crab in its tile, what it does, its type and model, aligned metrics, context.

export const ROW_H = 70
const ROW_X = 52
const BAR_Y = 61

const chip = (x: number, y: number, label: string, fillClass: string, inkClass: string): { body: string; width: number } => {
  const width = Math.round(textWidth(label, 10.5) + 14)
  return {
    body: `<rect class="${fillClass}" x="${x}" y="${y}" width="${width}" height="17" rx="8.5" fill-opacity=".14"/>${textAt(x + 7, y + 12.2, inkClass, 10.5, label, ' font-weight="600"')}`,
    width,
  }
}

// `at` times the run (the pane's ticking clock); `clockAt` is the clock now, for motion.
// A settled run is drawn with `clockAt` 0, so its row stays the same image from tick to tick.
export const agentSvg = (W: number, a: AgentRun, at: number, clockAt: number, isLast = false): string => {
  const role = roleOf(a.type)
  const isRunning = a.status === 'running'
  const isFailed = a.status === 'failed'

  // Line 1: what it does, then its status and time at the right.
  const time = fmtTime(elapsed(a, at))
  const timeW = textWidth(time, 12)
  const markX = W - timeW - 17
  const line1 = `${textAt(ROW_X, 20, 'tx', 13, fitText(a.description || a.type, 13, markX - ROW_X - 14), ' font-weight="600"')}
${statusMark(markX, 15.5, a)}${textAt(W, 20, isRunning ? 'tx' : 'm', 12, time, `${TABULAR} text-anchor="end" font-weight="600"`)}`

  // Line 2: the type chip, the model when one is known, and a stopped chip for a failed run.
  const typeChip = chip(ROW_X, 27, fitText(a.type, 10.5, (W - ROW_X) * 0.5), `f-${role}`, `t-${role}`)
  const stopW = isFailed ? chip(0, 27, 'Stopped', 'xmf', 't-fail').width + 8 : 0
  const modelX = ROW_X + typeChip.width + 8
  const model = fitText(runModel(a), 11, W - modelX - stopW)
  const stopX = model ? modelX + textWidth(model, 11) + 8 : modelX
  const stopChip = isFailed ? chip(stopX, 27, 'Stopped', 'xmf', 't-fail').body : ''
  const line2 = `${typeChip.body}${model ? textAt(modelX, 39, 's', 11, model) : ''}${stopChip}`

  // Line 3: metrics in fixed columns, so values line up down the panel. A narrow panel keeps ctx and cost.
  const isNarrow = W - ROW_X < 230
  const metrics: [string, string][] = [
    ['ctx', `${ctxOf(a)}%`],
    ...(isNarrow ? [] : ([['tokens', fmtTokens(a.tokens)]] as [string, string][])),
    ['cost', '≈' + fmtCost(a.costUsd)],
    ...(W >= 400 ? ([['steps', String(a.steps)]] as [string, string][]) : []),
  ]
  const columnW = Math.min(110, (W - ROW_X) / metrics.length)
  const line3 = metrics
    .map(([label, value], index) => {
      const x = ROW_X + index * columnW
      return `${textAt(x, 55, 'm', 10.5, label)}${textAt(x + textWidth(label, 10.5) + 5, 55, 's', 11, value, `${TABULAR} font-weight="600"`)}`
    })
    .join('')

  // Context bar: live fill in the role colour; a finished run keeps its last fill in a quiet tone.
  const barW = W - ROW_X
  const fillW = Math.round((barW * ctxTarget(a)) / 100)
  const fillClass = isRunning ? `f-${role}` : isFailed ? 'cfail' : 'cdone'
  // The fill tweens from where it stood; a run that just finished also fades from its role colour.
  const isTweening = a.ctxFrom !== undefined && isTweenAt(a.ctxAt, clockAt)
  const tween = isTweening
    ? `<style>@media (prefers-reduced-motion: no-preference){${tweenCss('cf', `width:${Math.round((barW * Math.min(100, Math.max(0, a.ctxFrom ?? 0))) / 100)}px${isRunning ? '' : `;fill:${ROLE_FILL[role]}`}`, -Math.round(clockAt - (a.ctxAt ?? clockAt)))}}</style>`
    : ''
  const bar = `<rect class="k" x="${ROW_X}" y="${BAR_Y}" width="${barW}" height="3" rx="1.5"/><rect class="${isTweening ? 'cf ' : ''}${fillClass}" x="${ROW_X}" y="${BAR_Y}" width="${fillW}" height="3" rx="1.5"/>${tween}`

  // The crab's home: a tile in its role colour.
  const tile = `<rect class="f-${role}" x="0" y="10" width="40" height="40" rx="12" fill-opacity=".14"/>${crab(5, 16, role, isRunning, 1)}`
  const hairline = isLast ? '' : `<line class="ln" x1="0" y1="${ROW_H - 0.5}" x2="${W}" y2="${ROW_H - 0.5}"/>`

  return svg(W, ROW_H, `${tile}${line1}${line2}${line3}${bar}${hairline}`, clockAt)
}

// ---------------------------------------------------------------------------
// The empty state and the compact view.

export const EMPTY_COPY = 'They appear here as soon as one starts.'
export const EMPTY_H = 52

// The empty state's second line, wrapped by word to the width beside the crab.
const emptyLines = (W: number): string[] =>
  EMPTY_COPY.split(' ').reduce<string[]>((lines, word) => {
    const last = lines[lines.length - 1]
    if (last !== undefined && textWidth(`${last} ${word}`, 12) <= W - ROW_X) lines[lines.length - 1] = `${last} ${word}`
    else lines.push(word)
    return lines
  }, [])

export const emptyHeight = (W: number): number => EMPTY_H + (emptyLines(W).length - 1) * 16

export const emptySvg = (W: number, clockAt: number): string =>
  svg(
    W,
    emptyHeight(W),
    `<rect class="f-pride" x="0" y="6" width="40" height="40" rx="12" fill-opacity=".14"/>${crab(5, 12, 'pride', false, 1)}
${textAt(ROW_X, 23, 'tx', 13, fitText('No subagents yet', 13, W - ROW_X), ' font-weight="600"')}
${emptyLines(W)
  .map((line, index) => textAt(ROW_X, 40 + index * 16, 's', 12, fitText(line, 12, W - ROW_X)))
  .join('')}`,
    clockAt,
  )

export const compactSvg = (W: number, list: AgentRun[], at: number, clockAt: number): Drawing => {
  const sums = totals(list, at)
  const summary = `≈${fmtCost(sums.cost)} · ${fmtTokens(sums.tokens)} · ${fmtTime(sums.time)}`
  const ordered = [...list.filter(a => a.status === 'running'), ...list.filter(a => a.status !== 'running')]
  const fit = Math.max(1, Math.floor((W - textWidth(summary, 12) - 40) / 34))
  const shown = ordered.slice(0, fit)
  const more = ordered.length - shown.length
  const crabs = shown
    .map((a, index) => {
      const x = index * 34
      const dot =
        a.status === 'running'
          ? `<circle class="live f-${roleOf(a.type)}" cx="${x + 15}" cy="35" r="2.2"/>`
          : `<circle class="${a.status === 'done' ? 'cdone' : 'cfail'}" cx="${x + 15}" cy="35" r="2.2"/>`
      return `${crab(x, 0, roleOf(a.type), a.status === 'running', 1)}${dot}`
    })
    .join('')
  const overflow = more ? textAt(shown.length * 34 + 2, 20, 's', 12, `+${more}`, TABULAR) : ''
  const totalsText = textAt(W, 20, 's', 12, summary, `${TABULAR} text-anchor="end"`)
  const lanes = timeline(list, at, 46, W, 3, false)
  const height = lanes.height ? 46 + lanes.height + 2 : 40
  return { source: svg(W, height, `${crabs}${overflow}${totalsText}${lanes.body}`, clockAt), height }
}
