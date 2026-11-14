#!/usr/bin/env node
// Checks that every pulse mod carrying hooks/prices.ts ships the same copy, so the
// mods never disagree about what a token costs.
//
//   node scripts/check-prices.mjs

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const copies = readdirSync(root)
  .filter((folder) => folder.startsWith('pulse-'))
  .map((folder) => join(folder, 'hooks', 'prices.ts'))
  .filter((path) => existsSync(join(root, path)))

if (copies.length < 2) {
  console.log(`${copies.length} copy of hooks/prices.ts found; nothing to compare`)
  process.exit(0)
}

const [reference, ...others] = copies
const referenceText = readFileSync(join(root, reference), 'utf8')
const mismatches = others.filter((path) => readFileSync(join(root, path), 'utf8') !== referenceText)

if (mismatches.length > 0) {
  console.error(mismatches.map((path) => `- ${path} differs from ${reference}; edit every copy together`).join('\n'))
  process.exit(1)
}
console.log(`${copies.length} copies of hooks/prices.ts match`)
