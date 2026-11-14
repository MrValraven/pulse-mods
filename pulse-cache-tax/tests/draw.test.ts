import { describe, expect, test, tier } from 'claude-code/testing'

import { bandColors, fmtUsd, holdBarsAlt, holdBarsSvg, holdTitleAlt, holdTitleSvg, isSoonCold, meterAlt, meterSvg } from '../hooks/draw'
import type { Hold, Warmth } from '../hooks/draw'

tier('user')

const MIN = 60 * 1000
const HOUR = 60 * MIN

const cold: Warmth = { tone: 'cold', msLeft: 0, ttlMs: HOUR, pingMsLeft: null, coldPrice: '$4.01' }
const warm: Warmth = { tone: 'warm', msLeft: 30 * MIN, ttlMs: HOUR, pingMsLeft: 10 * MIN, coldPrice: '$4.01' }
const unpriced: Warmth = { ...cold, coldPrice: null }
const hold: Hold = { coldFor: '2h00m', rewriteUsd: 4.01, warmUsd: 0.05, tokens: '200,502' }
const unpricedHold: Hold = { ...hold, rewriteUsd: null, warmUsd: null }

describe('meter', () => {
  test('a cold meter draws the price and its alt text names it', async () => {
    const source = meterSvg(cold, 190)
    expect(source.startsWith('<svg')).toBe(true)
    expect(source).toContain('$4.01')
    expect(meterAlt(cold)).toBe('Prompt cache cold, the next message re-writes it for about $4.01')
  })

  test('a warm meter has alt text with the minutes and the ping', async () => {
    expect(meterSvg(warm, 190)).toContain('30m')
    expect(meterAlt(warm)).toBe('Prompt cache warm for 30 more minutes, keepwarm pings it with 10 minutes left')
  })

  test('an unpriced meter says price unknown, and so does its alt text', async () => {
    expect(meterSvg(unpriced, 190)).toContain('price unknown')
    expect(meterAlt(unpriced)).toBe('Prompt cache cold, price unknown')
    expect(meterSvg(unpriced, 120)).toContain('no price')
    expect(fmtUsd(null)).toBe('price unknown')
  })

  test('soon-cold follows the cache lifetime: the last sixth', async () => {
    expect(isSoonCold({ ...warm, msLeft: 10 * MIN })).toBe(true)
    expect(isSoonCold({ ...warm, msLeft: 11 * MIN })).toBe(false)
    const fiveMinutes: Warmth = { ...warm, ttlMs: 5 * MIN, pingMsLeft: MIN }
    expect(isSoonCold({ ...fiveMinutes, msLeft: 50 * 1000 })).toBe(true)
    expect(isSoonCold({ ...fiveMinutes, msLeft: 2 * MIN })).toBe(false)
  })
})

describe('band colours', () => {
  test('the text row uses the pulse coral ink and jade for each theme', async () => {
    expect(bandColors(true)).toEqual({ coralInk: '#9e472c', coralFill: '#d4603f', jade: '#4a8c6f' })
    expect(bandColors(false)).toEqual({ coralInk: '#f0907a', coralFill: '#e8775a', jade: '#5aa784' })
  })
})

describe('held card', () => {
  test('the bars draw both prices and the alt text names them', async () => {
    const source = holdBarsSvg(hold, 560)
    expect(source).toContain('$4.01')
    expect(source).toContain('$0.05')
    expect(holdBarsAlt(hold)).toBe('Sending now re-writes up to 200,502 tokens for about $4.01; a warm turn would have cost $0.05.')
  })

  test('unpriced bars say so, in the drawing and the alt text', async () => {
    expect(holdBarsSvg(unpricedHold, 560)).toContain('Price unknown: sending re-writes up to 200,502 tokens.')
    expect(holdBarsAlt(unpricedHold)).toBe('Price unknown: sending re-writes up to 200,502 tokens.')
  })

  test('the title draws how long the cache has been cold and its alt text says it', async () => {
    // The title carries no price; the bars below it do.
    expect(holdTitleSvg(hold, 560)).toContain('cold for 2h00m')
    expect(holdTitleAlt(hold)).toBe('Message held, the cache has been cold for 2h00m')
  })
})
