// Shared price table for the pulse mods. pulse-progress and pulse-cache-tax each ship an
// identical copy of this file; scripts/check-prices.mjs fails when the copies differ.
// Edit both copies together.
//
// USD per million tokens. Source: Anthropic first-party list prices as published on 2026-11-03.
// The 1-hour cache write is twice the input price; the 5-minute write is 1.25 times it.

export const PRICES_AS_OF = '2026-11-03'

export type ModelPrice = {
  input: number
  output: number
  cacheRead: number
  /** 1-hour cache write. */
  cacheWriteHour: number
  /** 5-minute cache write. */
  cacheWriteFiveMinutes: number
  /** Context window in tokens. */
  contextWindow: number
}

type PriceRow = [family: string, input: number, output: number, cacheRead: number, contextWindow: number]

// Longer family names first: a model id takes the first row whose family it contains.
const PRICE_ROWS: PriceRow[] = [
  ['fable-5-2', 8, 40, 0.2, 1_000_000],
  ['mythos-5-2', 8, 40, 0.2, 1_000_000],
  ['fable-5-1', 10, 50, 0.25, 1_000_000],
  ['mythos-5-1', 10, 50, 0.25, 1_000_000],
  ['fable-5', 10, 50, 1, 1_000_000],
  ['mythos-5', 10, 50, 1, 1_000_000],
  ['opus-5-5', 4, 20, 0.2, 1_000_000],
  ['opus-5', 5, 25, 0.5, 1_000_000],
  ['opus-4-8', 5, 25, 0.5, 1_000_000],
  ['opus-4-7', 5, 25, 0.5, 1_000_000],
  ['opus-4-6', 5, 25, 0.5, 1_000_000],
  ['sonnet-5-5', 2, 10, 0.1, 1_000_000],
  ['sonnet-5', 2, 10, 0.2, 1_000_000],
  ['sonnet-4-6', 3, 15, 0.3, 1_000_000],
  ['haiku-5-5', 0.1, 0.5, 0.01, 1_000_000],
  ['haiku-4-5', 1, 5, 0.1, 200_000],
]

/** Lowercases a model id and turns dots and spaces into dashes, so "Opus 5.5" and "claude-opus-5-5[1m]" both match "opus-5-5". */
export const normalizeModelId = (model: string | null | undefined): string =>
  (model ?? '').toLowerCase().replace(/[\s.]+/g, '-')

/** The price row for a model id, or null when the table has no row for it. Callers show "price unknown" for null. */
export function priceOf(model: string | null | undefined): ModelPrice | null {
  const normalized = normalizeModelId(model)
  if (!normalized) return null
  for (const [family, input, output, cacheRead, contextWindow] of PRICE_ROWS) {
    if (normalized.includes(family)) {
      return {
        input,
        output,
        cacheRead,
        cacheWriteHour: input * 2,
        cacheWriteFiveMinutes: input * 1.25,
        contextWindow,
      }
    }
  }
  return null
}

/** Context window for a model id; 1M when the model is unknown, the size every current model has. */
export const contextWindowOf = (model: string | null | undefined): number => priceOf(model)?.contextWindow ?? 1_000_000
