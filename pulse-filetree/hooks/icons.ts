import type { FileNode } from '../types'
import { luminance } from './look'

const cp = (n: number) => String.fromCodePoint(n)

export const CHEVRON_OPEN = cp(0xf47c)
export const CHEVRON_CLOSED = cp(0xf460)

const NAMES: Record<string, number> = {
  'agents.md': 0xf0354,
  'changelog.md': 0xf0354,
  'contributing.md': 0xf0354,
  'todo.md': 0xf0354,
  'readme.md': 0xf0354,
  license: 0xe60a,
  dockerfile: 0xf0868,
  makefile: 0xf1064,
  'cmakelists.txt': 0xf1064,
  justfile: 0xf05b7,
  gemfile: 0xf0d2d,
  rakefile: 0xf0d2d,
  'cargo.toml': 0xe6b2,
  'cargo.lock': 0xe6b2,
  'pyproject.toml': 0xe6b2,
  'requirements.txt': 0xf160e,
  'go.mod': 0xf0afa,
  'go.sum': 0xf07d3,
  'package.json': 0xf0626,
  'package-lock.json': 0xf0626,
  'tsconfig.json': 0xf0626,
  '.prettierrc': 0xf0626,
  '.eslintrc': 0xf0626,
  'pnpm-lock.yaml': 0xe6a8,
  'yarn.lock': 0xe6a8,
  '.gitignore': 0xf02a2,
  '.gitmodules': 0xf0493,
  '.editorconfig': 0xe652,
}

const EXTS: Record<string, number> = {
  lua: 0xe620,
  py: 0xe606,
  pyi: 0xe606,
  js: 0xe60c,
  mjs: 0xe60c,
  cjs: 0xe60c,
  ts: 0xe628,
  jsx: 0xe625,
  tsx: 0xe7ba,
  json: 0xe60b,
  jsonc: 0xe60b,
  yaml: 0xe6a8,
  yml: 0xe6a8,
  sh: 0xe795,
  bash: 0xe795,
  zsh: 0xe795,
  fish: 0xe795,
  md: 0xf0354,
  markdown: 0xf0354,
  css: 0xe6b8,
  scss: 0xf031c,
  html: 0xe736,
  htm: 0xe736,
  go: 0xe627,
  rs: 0xe68b,
  rb: 0xe791,
  php: 0xe608,
  java: 0xe738,
  cs: 0xf031b,
  sql: 0xe706,
  graphql: 0xf20e,
  gql: 0xf20e,
  xml: 0xf05c0,
  toml: 0xe6b2,
  ini: 0xf0bc2,
  conf: 0xf0493,
  pdf: 0xeaeb,
  svg: 0xf0721,
  jpg: 0xf0225,
  jpeg: 0xf0225,
  png: 0xe60d,
  gif: 0xf0d78,
  webp: 0xf021f,
  mp4: 0xf022b,
  mkv: 0xf022b,
  mov: 0xf022b,
  mp3: 0xf0223,
  wav: 0xf0223,
  flac: 0xf0223,
  zip: 0xf05c4,
  gz: 0xf05c4,
  xz: 0xf05c4,
  tar: 0xf05c4,
  qml: 0xf375,
  cpp: 0xe61d,
  cc: 0xe61d,
  cxx: 0xe61d,
  c: 0xe61e,
  h: 0xf0af5,
  hpp: 0xf0af5,
  vue: 0xe6a0,
  svelte: 0xe697,
  csv: 0xe64a,
  txt: 0xf09aa,
}

export function fileIcon(n: FileNode, open: boolean, isRepo: boolean): string {
  if (n.kind === 'link') return cp(0xf481)
  if (n.kind === 'dir') return cp(isRepo ? 0xf02a2 : open ? 0xe5fe : 0xe5ff)
  const lower = n.name.toLowerCase()
  const named = NAMES[lower]
  if (named) return cp(named)
  const dot = lower.lastIndexOf('.')
  const ext = dot >= 0 ? lower.slice(dot + 1) : ''
  return cp(EXTS[ext] ?? 0xf0214)
}

// Without a Nerd Font a file shows a two-cell chip in its language's colour, as in VS Code's
// Material icon theme, and a folder a block in its kind's colour. The chip's text is white or
// near-black, whichever reads better on that colour.
export type Badge = { text: string; ink: string; onInk: string }

const DARK_TEXT = '#1b1b19'
const GREY = '#8a877f'

export function onInkFor(ink: string): string {
  const level = luminance(ink)
  return 1.05 / (level + 0.05) >= (level + 0.05) / (luminance(DARK_TEXT) + 0.05) ? '#ffffff' : DARK_TEXT
}

// Each row: the names or extensions (space separated), the chip's two cells and its colour.
const NAME_BADGES: [string, string, string][] = [
  ['package.json', 'NP', '#cb3837'],
  ['package-lock.json pnpm-lock.yaml yarn.lock bun.lockb bun.lock cargo.lock poetry.lock gemfile.lock composer.lock', 'LK', GREY],
  ['dockerfile containerfile .dockerignore docker-compose.yml docker-compose.yaml compose.yml compose.yaml', 'DK', '#2496ed'],
  ['.gitignore .gitattributes .gitmodules .gitkeep', 'GI', '#e2643c'],
  ['.env', 'EV', '#d9b54a'],
  ['license licence license.md license.txt', '© ', '#c9a25a'],
  ['readme readme.md readme.txt', 'i ', '#5b8fd6'],
  ['makefile gnumakefile', 'MK', '#6d8086'],
  ['claude.md agents.md', '✱ ', '#d97757'],
  ['.bashrc .bash_profile .zshrc .zprofile .zshenv .profile', '$_', '#7cc36e'],
]

const PATTERN_BADGES: [RegExp, string, string][] = [
  [/^tsconfig.*\.json$/, 'TS', '#3178c6'],
  [/^\.env\./, 'EV', '#d9b54a'],
  [/^(\.prettierrc|prettier\.config\.)/, 'PR', '#c596c7'],
  [/^(eslint\.config\.|\.eslintrc)/, 'ES', '#8080f2'],
  [/^vite\.config\./, 'VT', '#a855f7'],
  [/^vitest\.config\./, 'VI', '#6e9f18'],
  [/^(dockerfile|containerfile)\.|\.dockerfile$|^docker-compose\..+\.ya?ml$/, 'DK', '#2496ed'],
]

const EXTENSION_BADGES: [string, string, string][] = [
  ['ts mts cts', 'TS', '#3178c6'],
  ['tsx', 'TX', '#2fa7c9'],
  ['js mjs cjs', 'JS', '#f0db4f'],
  ['jsx', 'JX', '#e8c93a'],
  ['json jsonc json5', '{}', '#d9a93a'],
  ['md mdx markdown', 'M↓', '#5b8fd6'],
  ['css', '# ', '#8f6fd6'],
  ['scss sass', 'S#', '#cd6799'],
  ['html htm', '<>', '#e2643c'],
  ['sh bash zsh fish', '$_', '#7cc36e'],
  ['ps1 psm1', 'PS', '#5391fe'],
  ['yaml yml', 'YM', '#cb5d5d'],
  ['toml', 'TM', '#9c4221'],
  ['ini cfg conf properties', 'CF', GREY],
  ['py pyi pyw', 'PY', '#3776ab'],
  ['ipynb', 'NB', '#f37626'],
  ['go', 'GO', '#00add8'],
  ['rs', 'RS', '#dea584'],
  ['rb erb', 'RB', '#cc342d'],
  ['java', 'JV', '#b07219'],
  ['kt kts', 'KT', '#a97bff'],
  ['scala', 'SC', '#dc322f'],
  ['swift', 'SW', '#f05138'],
  ['dart', 'DT', '#00b4ab'],
  ['c', 'C ', '#555fbf'],
  ['h', 'H ', '#7b83c9'],
  ['cpp cc cxx', 'C+', '#f34b7d'],
  ['hpp hh hxx', 'H+', '#c96a8f'],
  ['cs', 'C#', '#178600'],
  ['php', 'PH', '#777bb4'],
  ['lua', 'LU', '#4f6fd6'],
  ['ex exs', 'EX', '#8e6fb8'],
  ['hs', 'HS', '#5e5086'],
  ['zig', 'ZG', '#f7a41d'],
  ['r', 'R ', '#276dc3'],
  ['sql', 'SQ', '#e38c00'],
  ['db sqlite sqlite3', 'DB', '#e38c00'],
  ['graphql gql', 'GQ', '#e10098'],
  ['proto', 'PB', '#4f9de0'],
  ['tf tfvars', 'TF', '#7b42bc'],
  ['vue', 'VU', '#41b883'],
  ['svelte', 'SV', '#ff3e00'],
  ['astro', 'AS', '#ff5d01'],
  ['xml plist', '<>', GREY],
  ['svg', 'SG', '#ffb13b'],
  ['png jpg jpeg gif webp avif ico bmp heic', 'IM', '#a074c4'],
  ['mp4 mkv mov webm avi', 'VD', '#e05d44'],
  ['mp3 wav flac ogg m4a aac', 'AU', '#e06c9f'],
  ['pdf', 'PD', '#e5252a'],
  ['zip gz tgz tar xz 7z bz2 rar', 'ZP', GREY],
  ['csv tsv', 'CS', '#3fae6a'],
  ['txt log', 'Tx', GREY],
  ['diff patch', 'DF', '#7cc36e'],
  ['ttf otf woff woff2', 'FT', GREY],
  ['wasm', 'WA', '#654ff0'],
  ['lock', 'LK', GREY],
]

const badgeOf = (text: string, ink: string): Badge => ({ text, ink, onInk: onInkFor(ink) })

function badgeTable(entries: [string, string, string][]): Map<string, Badge> {
  const table = new Map<string, Badge>()
  for (const [keys, text, ink] of entries) {
    const badge = badgeOf(text, ink)
    for (const key of keys.split(' ')) table.set(key, badge)
  }
  return table
}

const BY_NAME = badgeTable(NAME_BADGES)
const BY_EXTENSION = badgeTable(EXTENSION_BADGES)
const BY_PATTERN = PATTERN_BADGES.map(([pattern, text, ink]) => [pattern, badgeOf(text, ink)] as const)
const DEFAULT_BADGE = badgeOf('··', GREY)

export function fileBadge(node: Pick<FileNode, 'name'>): Badge {
  const lower = node.name.toLowerCase()
  const named = BY_NAME.get(lower)
  if (named) return named
  for (const [pattern, badge] of BY_PATTERN) if (pattern.test(lower)) return badge
  const dot = lower.lastIndexOf('.')
  return (dot > 0 ? BY_EXTENSION.get(lower.slice(dot + 1)) : undefined) ?? DEFAULT_BADGE
}

const FOLDER_INKS: [string, string][] = [
  ['.claude .github .vscode', '#e0795a'],
  ['src source lib', '#58b86a'],
  ['docs doc', '#4f9de0'],
  ['test tests __tests__ e2e spec coverage', '#3fae9e'],
  ['public static assets', '#3fb6d8'],
  ['dist build out', '#d8605e'],
  ['node_modules', '#7aa35a'],
  ['scripts bin config configs', '#7f93ad'],
  ['hooks plugins', '#a98be8'],
  ['components ui', '#e8a33d'],
  ['types @types', '#4f7cc4'],
  ['styles css', '#8f6fd6'],
  ['images img icons', '#a074c4'],
]
const FOLDER_BY_NAME = new Map(FOLDER_INKS.flatMap(([names, ink]) => names.split(' ').map(name => [name, ink] as const)))

export function folderInk(name: string): string {
  return FOLDER_BY_NAME.get(name.toLowerCase()) ?? '#c9a25a'
}

export const GIT_COLOR: Record<string, string> = {
  A: '#98c379',
  '?': '#98c379',
  R: '#61afef',
  C: '#61afef',
  M: '#e5c07b',
  T: '#e5c07b',
}

const PRIORITY = ['U', 'D', 'M', 'T', 'R', 'C', 'A', '?']

export function stronger(a: string | undefined, b: string): string {
  if (!a) return b
  return PRIORITY.indexOf(b) < PRIORITY.indexOf(a) ? b : a
}
