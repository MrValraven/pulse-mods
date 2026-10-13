#!/usr/bin/env node
// Checks that the marketplace and the mods agree, so an edit always ships.
//
//   node scripts/check-versions.mjs            check the tree as it is
//   node scripts/check-versions.mjs origin/main  also require a version bump for every mod changed since that ref
//
// A mod whose code changed without a version bump never reaches a session: Claude Code keeps running the cached copy.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const baseRef = process.argv[2]
const problems = []

function readJson(path) {
  try {
    return JSON.parse(readFileSync(join(root, path), 'utf8'))
  } catch (error) {
    problems.push(`${path}: ${error.message}`)
    return undefined
  }
}

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
}

const marketplace = readJson('.claude-plugin/marketplace.json')
const entries = marketplace?.plugins ?? []
const listedNames = new Set(entries.map((entry) => entry.name))

for (const entry of entries) {
  const folder = entry.source.replace(/^\.\//, '')
  const manifestPath = `${folder}/.claude-plugin/plugin.json`
  if (!existsSync(join(root, manifestPath))) {
    problems.push(`${entry.name}: ${manifestPath} is missing`)
    continue
  }
  const manifest = readJson(manifestPath)
  if (!manifest) continue
  if (manifest.name !== entry.name) problems.push(`${entry.name}: plugin.json name is "${manifest.name}"`)
  if (manifest.version !== entry.version) {
    problems.push(`${entry.name}: plugin.json has ${manifest.version}, marketplace.json has ${entry.version}`)
  }
  if (!existsSync(join(root, folder, 'LICENSE')) && !existsSync(join(root, folder, 'NOTICE'))) {
    problems.push(`${entry.name}: no LICENSE or NOTICE in ${folder}/`)
  }
}

for (const folder of readdirSync(root)) {
  if (folder.startsWith('pulse-') && !listedNames.has(folder)) {
    problems.push(`${folder}/ is not listed in .claude-plugin/marketplace.json`)
  }
}

if (baseRef) {
  const changedFiles = git('diff', '--name-only', `${baseRef}...HEAD`).split('\n').filter(Boolean)
  for (const entry of entries) {
    const folder = entry.source.replace(/^\.\//, '')
    const codeChanged = changedFiles.some(
      (file) => file.startsWith(`${folder}/`) && !file.endsWith('.md'),
    )
    if (!codeChanged) continue
    let baseVersion
    try {
      baseVersion = JSON.parse(git('show', `${baseRef}:${folder}/.claude-plugin/plugin.json`)).version
    } catch {
      continue // a new mod has nothing to bump
    }
    if (baseVersion === entry.version) {
      problems.push(`${entry.name}: files changed but the version is still ${baseVersion}; bump plugin.json and marketplace.json`)
    }
  }
}

if (problems.length > 0) {
  console.error(problems.map((problem) => `- ${problem}`).join('\n'))
  process.exit(1)
}
console.log(`All ${entries.length} mods agree with the marketplace.`)
