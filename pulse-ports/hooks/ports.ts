// pulse-ports: the pure part. It reads a shell command and a project's
// package.json, works out which port a dev server would start on, which ports
// are reserved and why, and how to move a command to another port.
// Nothing here touches `$`, so the tests import it directly.

// ---- Tools ------------------------------------------------------------------

export type ToolName =
  | 'vite'
  | 'vite-preview'
  | 'next'
  | 'nest'
  | 'astro'
  | 'remix'
  | 'remix-vite'
  | 'nuxt'
  | 'python-http'
  | 'rails'
  | 'php'
  | 'generic'

/** How a tool is moved to another port. */
export type MoveMethod = 'flag' | 'env' | 'positional' | 'php-host'

type ToolTraits = {
  label: string
  defaultPort: number | null
  moveMethod: MoveMethod
  readsPortEnv: boolean
  acceptsDashP: boolean
}

export const TOOLS: Record<ToolName, ToolTraits> = {
  vite: { label: 'vite', defaultPort: 5173, moveMethod: 'flag', readsPortEnv: false, acceptsDashP: false },
  'vite-preview': { label: 'vite preview', defaultPort: 4173, moveMethod: 'flag', readsPortEnv: false, acceptsDashP: false },
  next: { label: 'next', defaultPort: 3000, moveMethod: 'flag', readsPortEnv: true, acceptsDashP: true },
  nest: { label: 'nest start', defaultPort: 3000, moveMethod: 'env', readsPortEnv: true, acceptsDashP: false },
  astro: { label: 'astro', defaultPort: 4321, moveMethod: 'flag', readsPortEnv: false, acceptsDashP: false },
  remix: { label: 'remix dev', defaultPort: 3000, moveMethod: 'env', readsPortEnv: true, acceptsDashP: false },
  'remix-vite': { label: 'remix vite:dev', defaultPort: 5173, moveMethod: 'flag', readsPortEnv: false, acceptsDashP: false },
  nuxt: { label: 'nuxt', defaultPort: 3000, moveMethod: 'flag', readsPortEnv: true, acceptsDashP: false },
  'python-http': { label: 'python -m http.server', defaultPort: 8000, moveMethod: 'positional', readsPortEnv: false, acceptsDashP: false },
  rails: { label: 'rails server', defaultPort: 3000, moveMethod: 'flag', readsPortEnv: true, acceptsDashP: true },
  php: { label: 'php -S', defaultPort: null, moveMethod: 'php-host', readsPortEnv: false, acceptsDashP: false },
  generic: { label: 'server', defaultPort: null, moveMethod: 'flag', readsPortEnv: true, acceptsDashP: false },
}

// Tools that take `-p N` for their port. Any other command's -p means something else.
const DASH_P_TOOLS = new Set(['next', 'rails', 'http-server', 'serve', 'flask', 'hugo', 'live-server', 'json-server'])
// Clients and port tools: a --port on these names a port they connect to or free up.
const PORT_CLIENTS = new Set([
  'psql', 'mysql', 'mongosh', 'mongo', 'redis-cli', 'ssh', 'scp', 'sftp', 'curl', 'wget', 'nc', 'telnet',
  'lsof', 'kill', 'kill-port', 'fkill', 'docker', 'kubectl', 'gh', 'git',
])
// Test runners and build tools: a PORT= in front of them points them at a server, it starts none.
const TEST_TOOLS = new Set([
  'playwright', 'jest', 'vitest', 'cypress', 'mocha', 'ava', 'tap', 'karma', 'wdio', 'testcafe', 'tsc', 'eslint',
  'prettier', 'newman', 'k6', 'artillery',
])
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const PNPM_BUILTINS = new Set([
  'add', 'install', 'i', 'remove', 'rm', 'uninstall', 'update', 'up', 'exec', 'dlx', 'create', 'init', 'link', 'ln',
  'unlink', 'list', 'ls', 'outdated', 'publish', 'pack', 'prune', 'rebuild', 'rb', 'store', 'test', 't', 'why',
  'audit', 'config', 'env', 'setup', 'import', 'fetch', 'patch', 'patch-commit', 'deploy', 'licenses', 'root', 'bin',
])
const YARN_BUILTINS = new Set([
  'add', 'install', 'remove', 'upgrade', 'up', 'info', 'init', 'link', 'list', 'global', 'cache', 'config', 'why',
  'workspace', 'workspaces', 'dlx', 'exec', 'set', 'plugin', 'pack', 'publish', 'test', 'version', 'audit', 'bin',
  'create', 'import', 'licenses', 'login', 'logout', 'outdated', 'owner', 'policies', 'tag', 'team', 'unlink',
  'upgrade-interactive', 'node', 'npm', 'constraints', 'dedupe', 'explain', 'rebuild', 'unplug',
])
const BUN_BUILTINS = new Set([
  'install', 'i', 'add', 'a', 'remove', 'rm', 'update', 'link', 'unlink', 'pm', 'build', 'test', 'x', 'init',
  'create', 'c', 'upgrade', 'outdated', 'publish', 'patch', 'repl', 'exec', 'audit', 'info',
])
// Words that can stand before the real command without changing what it serves.
const COMMAND_PREFIXES = new Set(['command', 'exec', 'nohup', 'time', 'then', 'do', 'else', '!'])
const SUDO_VALUE_OPTIONS = new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-T', '-U'])
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s

// ---- Reading a command -------------------------------------------------------

export type ScriptRun = {
  runner: 'npm' | 'pnpm' | 'yarn' | 'bun'
  script: string
  /** The words handed on to the script: after `--` for npm, every extra word for the others. */
  passArgs: string[]
}

export type FlagSpelling = '--port' | '-p' | 'positional' | 'php-host'

export type CommandAnalysis = {
  /** The tool serving, or null for a package-manager script run (the script says which). */
  tool: ToolName | null
  run: ScriptRun | null
  flagPort: number | null
  flagSpelling: FlagSpelling | null
  envPort: number | null
  /** A folder the command moves to before it runs: `cd`, `--prefix`, `-C`, `--dir`, `--cwd`. */
  dir: string | null
}

export type ServerStart = {
  analysis: CommandAnalysis
  /** The command split at && || ; | and newlines, separators kept at the odd places. */
  pieces: string[]
  pieceIndex: number
}

/**
 * Splits a command line at && || |& ; | newlines and a lone `&` that backgrounds
 * a command (the `&` inside `&&`, `&>`, `>&` and `2>&1` stays in its piece), with the
 * separators kept at the odd places so the pieces join back to the line.
 * Quotes are honoured, and a heredoc's body rides inside the newline separator
 * that starts it, so its lines are never read as commands.
 */
export function splitCommandPieces(command: string): string[] {
  const pieces: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  const pendingHeredocs: { delimiter: string; isTabStripped: boolean }[] = []
  const pushSeparator = (separator: string): void => {
    pieces.push(current, separator)
    current = ''
  }
  let index = 0
  while (index < command.length) {
    const char = command[index] ?? ''
    if (quote !== null) {
      if (char === '\\' && quote === '"' && index + 1 < command.length) {
        current += command.slice(index, index + 2)
        index += 2
        continue
      }
      current += char
      if (char === quote) quote = null
      index += 1
      continue
    }
    // An escaped character, a backslash-newline continuation among them, stays in its piece.
    if (char === '\\' && index + 1 < command.length) {
      current += command.slice(index, index + 2)
      index += 2
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      index += 1
      continue
    }
    if (command.startsWith('<<', index) && !command.startsWith('<<<', index)) {
      const heredoc = /^<<(-?)\s*(['"]?)([A-Za-z0-9_.-]+)\2/.exec(command.slice(index))
      if (heredoc !== null) {
        pendingHeredocs.push({ delimiter: heredoc[3] ?? '', isTabStripped: heredoc[1] === '-' })
        current += heredoc[0]
        index += heredoc[0].length
        continue
      }
    }
    if (char === '\n') {
      let separator = '\n'
      index += 1
      for (const heredoc of pendingHeredocs) {
        while (index < command.length) {
          const lineEnd = command.indexOf('\n', index)
          const end = lineEnd < 0 ? command.length : lineEnd + 1
          const line = command.slice(index, end)
          separator += line
          index = end
          const bare = line.replace(/\n$/, '')
          if ((heredoc.isTabStripped ? bare.replace(/^\t+/, '') : bare) === heredoc.delimiter) break
        }
      }
      pendingHeredocs.length = 0
      pushSeparator(separator)
      continue
    }
    const pair = command.slice(index, index + 2)
    if (pair === '&&' || pair === '||' || pair === '|&') {
      pushSeparator(pair)
      index += 2
      continue
    }
    if (char === ';' || char === '|') {
      pushSeparator(char)
      index += 1
      continue
    }
    if (char === '&') {
      const previous = command[index - 1]
      const following = command[index + 1]
      if (previous === '>' || previous === '<' || following === '>') {
        current += char
      } else {
        pushSeparator(char)
      }
      index += 1
      continue
    }
    current += char
    index += 1
  }
  pieces.push(current)
  return pieces
}

/** Splits one segment into words, honouring quotes. Good enough to read flags and paths. */
export function tokenize(text: string): string[] {
  const words: string[] = []
  const pattern = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    words.push(match[1] ?? match[2] ?? match[3] ?? '')
  }
  return words
}

/** A segment as `{ head, core, tail }`: leading space and `(`, the command, then trailing redirects, `&` and `)`. */
export function splitSegmentEdges(segment: string): { head: string; core: string; tail: string } {
  const head = /^\s*[({]*\s*/.exec(segment)?.[0] ?? ''
  const rest = segment.slice(head.length)
  const tail = /(?:\s*(?:\d*>>?|&>>?|<)\s*\S+|\s*&|\s*[)}]+)+\s*$/.exec(rest)?.[0] ?? ''
  const trailingSpace = tail === '' ? (/\s*$/.exec(rest)?.[0] ?? '') : ''
  const core = rest.slice(0, rest.length - Math.max(tail.length, trailingSpace.length))
  return { head, core, tail: tail === '' ? trailingSpace : tail }
}

export function toPort(text: string | undefined): number | null {
  if (text === undefined || !/^\d{1,5}$/.test(text)) {
    return null
  }
  const port = Number(text)
  return port >= 1 && port <= 65535 ? port : null
}

function basename(word: string): string {
  return word.replace(/^\\/, '').split('/').pop() ?? word
}

/** A folder a later `cd target` moves to, given the folder so far (null is the session folder). */
export function joinDir(dir: string | null, target: string | undefined): string {
  if (target === undefined || target === '~' || target.startsWith('/') || target.startsWith('~/')) {
    return target ?? '~'
  }
  return dir ? `${dir}/${target}` : target
}

/** `--port N`, `--port=N`, and `-p N` where the tool takes it. */
export function findFlagPort(args: readonly string[], isDashPAccepted: boolean): { port: number; spelling: '--port' | '-p' } | null {
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index] ?? ''
    if (word === '--port') {
      const port = toPort(args[index + 1])
      if (port !== null) return { port, spelling: '--port' }
    } else if (word.startsWith('--port=')) {
      const port = toPort(word.slice('--port='.length))
      if (port !== null) return { port, spelling: '--port' }
    } else if (isDashPAccepted && word === '-p') {
      const port = toPort(args[index + 1])
      if (port !== null) return { port, spelling: '-p' }
    }
  }
  return null
}

function stripLeadingAssignments(words: string[]): number | null {
  let envPort: number | null = null
  while (words.length > 0) {
    const match = ASSIGNMENT.exec(words[0] ?? '')
    if (match === null) break
    if (match[1] === 'PORT') envPort = toPort(match[2]) ?? envPort
    words.shift()
  }
  return envPort
}

/** Drops sudo, nohup, env and the like, collecting any PORT= they carry. */
function stripPrefixes(words: string[], envPort: number | null): number | null {
  let port = envPort
  let isChanged = true
  while (isChanged && words.length > 0) {
    isChanged = false
    const first = basename(words[0] ?? '')
    if (first === 'sudo') {
      words.shift()
      while ((words[0]?.startsWith('-') ?? false)) {
        const option = words.shift() ?? ''
        if (SUDO_VALUE_OPTIONS.has(option)) words.shift()
      }
      isChanged = true
    } else if (first === 'env') {
      words.shift()
      while ((words[0]?.startsWith('-') ?? false)) words.shift()
      port = stripLeadingAssignments(words) ?? port
      isChanged = true
    } else if (first === 'nice') {
      words.shift()
      if (words[0] === '-n') words.splice(0, 2)
      else if (/^-\d+$/.test(words[0] ?? '')) words.shift()
      isChanged = true
    } else if (COMMAND_PREFIXES.has(first)) {
      words.shift()
      port = stripLeadingAssignments(words) ?? port
      isChanged = true
    }
  }
  return port
}

/** Drops npx, bunx, `pnpm exec`, `yarn dlx` and the like, which run a package's bin. */
function stripBinRunners(words: string[]): void {
  const first = basename(words[0] ?? '')
  if (first === 'npx' || first === 'bunx') {
    words.shift()
    while ((words[0]?.startsWith('-') ?? false)) {
      const option = words.shift() ?? ''
      if (option === '-p' || option === '--package') words.shift()
    }
  } else if ((first === 'pnpm' || first === 'yarn' || first === 'npm') && (words[1] === 'exec' || words[1] === 'dlx')) {
    words.splice(0, 2)
  }
  if (words[0] === '--') words.shift()
}

function toolOf(name: string, args: readonly string[]): ToolName | null {
  const firstPositional = args.find((word) => !word.startsWith('-'))
  if (name === 'vite') {
    if (firstPositional === 'preview') return 'vite-preview'
    if (firstPositional === 'build' || firstPositional === 'optimize') return null
    return 'vite'
  }
  if (name === 'next') return firstPositional === 'dev' || firstPositional === 'start' ? 'next' : null
  if (name === 'nest') return firstPositional === 'start' ? 'nest' : null
  if (name === 'astro') return firstPositional === 'dev' || firstPositional === 'preview' || firstPositional === 'start' ? 'astro' : null
  if (name === 'remix') {
    if (firstPositional === 'dev') return 'remix'
    if (firstPositional === 'vite:dev') return 'remix-vite'
    return null
  }
  if (name === 'nuxt' || name === 'nuxi') {
    return firstPositional === 'dev' || firstPositional === 'preview' || firstPositional === 'start' ? 'nuxt' : null
  }
  if (/^python(\d+(\.\d+)?)?$/.test(name)) return args[0] === '-m' && args[1] === 'http.server' ? 'python-http' : null
  if (name === 'rails') return firstPositional === 's' || firstPositional === 'server' ? 'rails' : null
  if (name === 'php') return args.includes('-S') ? 'php' : null
  return null
}

function analyzeScriptRun(runner: ScriptRun['runner'], args: string[], envPort: number | null): CommandAnalysis | null {
  let dir: string | null = null
  const rest = [...args]
  // The package manager's own options before the subcommand; some move the folder.
  while ((rest[0]?.startsWith('-') ?? false)) {
    const option = rest.shift() ?? ''
    if (option === '--prefix' || option === '-C' || option === '--dir' || option === '--cwd') {
      dir = joinDir(dir, rest.shift())
    } else if (/^--(prefix|dir|cwd)=/.test(option)) {
      dir = joinDir(dir, option.slice(option.indexOf('=') + 1))
    } else if (option === '--filter' || option === '-F' || option === '--workspace' || option === '-w') {
      rest.shift()
    }
  }
  const subcommand = rest.shift()
  if (subcommand === undefined) return null
  let script: string | undefined
  if (subcommand === 'run' || subcommand === 'run-script' || (runner === 'npm' && (subcommand === 'rum' || subcommand === 'urn'))) {
    script = rest.shift()
  } else if (subcommand === 'start') {
    script = 'start'
  } else if (runner === 'pnpm' && !PNPM_BUILTINS.has(subcommand)) {
    script = subcommand
  } else if (runner === 'yarn' && !YARN_BUILTINS.has(subcommand)) {
    script = subcommand
  } else if (runner === 'bun' && !BUN_BUILTINS.has(subcommand) && !/[./]/.test(subcommand)) {
    script = subcommand
  }
  if (script === undefined || script.startsWith('-')) return null
  let passArgs: string[]
  if (runner === 'npm') {
    const doubleDash = rest.indexOf('--')
    passArgs = doubleDash < 0 ? [] : rest.slice(doubleDash + 1)
  } else {
    passArgs = rest[0] === '--' ? rest.slice(1) : rest
  }
  const flag = findFlagPort(passArgs, false)
  return {
    tool: null,
    run: { runner, script, passArgs },
    flagPort: flag?.port ?? null,
    flagSpelling: flag?.spelling ?? null,
    envPort,
    dir,
  }
}

// Framework subcommands that build, check or lint, and start no server.
const BUILD_SUBCOMMANDS = new Set(['build', 'lint', 'check', 'typecheck', 'sync', 'generate', 'export', 'info', 'test', 'add'])
const FRAMEWORK_CLIS = new Set(['vite', 'next', 'astro', 'nest', 'nuxt', 'nuxi', 'remix', 'svelte-kit', 'react-router'])
// Build and lint tools that start no server. webpack and esbuild are judged by their arguments in isKnownNonServer.
const BUILD_TOOLS = new Set(['rollup', 'tsup', 'biome', 'stylelint', 'babel', 'swc', 'rimraf'])

/** `node --test`, with --test among node's own options before the script path, or a known test runner. */
function isTestRun(name: string, args: readonly string[]): boolean {
  if (TEST_TOOLS.has(name)) return true
  if (name !== 'node') return false
  const scriptIndex = args.findIndex((word) => !word.startsWith('-'))
  const nodeOptions = scriptIndex < 0 ? args : args.slice(0, scriptIndex)
  return nodeOptions.includes('--test')
}

/** True when one command is positively no server: a test runner, a build or lint tool, or a framework's build subcommand. */
function isCommandKnownNonServer(words: string[]): boolean {
  stripPrefixes(words, stripLeadingAssignments(words))
  stripBinRunners(words)
  const name = basename(words[0] ?? '')
  const args = words.slice(1)
  if (isTestRun(name, args)) return true
  const firstPositional = args.find((word) => !word.startsWith('-'))
  if (FRAMEWORK_CLIS.has(name)) return firstPositional !== undefined && BUILD_SUBCOMMANDS.has(firstPositional)
  if (name === 'webpack') return firstPositional !== 'serve'
  if (name === 'esbuild') return !args.some((word) => word === '--serve' || word.startsWith('--serve='))
  return BUILD_TOOLS.has(name)
}

/**
 * True when every command of a script body (each `cd` aside) is positively no
 * server. One command this cannot place (`node server.js` after `tsc &&`, or
 * `tsx watch src/index.ts` alone) makes the whole body false.
 */
export function isKnownNonServer(body: string): boolean {
  const pieces = splitCommandPieces(body)
  let hasCommand = false
  for (let pieceIndex = 0; pieceIndex < pieces.length; pieceIndex += 2) {
    const words = tokenize(splitSegmentEdges(pieces[pieceIndex] ?? '').core)
    if (words.length === 0 || words[0] === 'cd' || words[0] === 'pushd') continue
    if (!isCommandKnownNonServer(words)) return false
    hasCommand = true
  }
  return hasCommand
}

/** What one command (already split from its neighbours) would serve, or null when it starts no server. */
export function analyzeWords(input: readonly string[]): CommandAnalysis | null {
  const words = [...input]
  let envPort = stripLeadingAssignments(words)
  envPort = stripPrefixes(words, envPort)
  stripBinRunners(words)
  if (words.length === 0) return null
  const name = basename(words[0] ?? '')
  const args = words.slice(1)
  if (PACKAGE_MANAGERS.has(name)) {
    return analyzeScriptRun(name as ScriptRun['runner'], args, envPort)
  }
  const tool = toolOf(name, args)
  if (tool === 'python-http') {
    const port = toPort(args.slice(2).find((word) => /^\d+$/.test(word)))
    return { tool, run: null, flagPort: port, flagSpelling: port === null ? null : 'positional', envPort, dir: null }
  }
  if (tool === 'php') {
    const host = args[args.indexOf('-S') + 1] ?? ''
    const port = toPort(/:(\d+)$/.exec(host)?.[1])
    return { tool, run: null, flagPort: port, flagSpelling: port === null ? null : 'php-host', envPort, dir: null }
  }
  if (tool !== null) {
    const flag = findFlagPort(args, TOOLS[tool].acceptsDashP)
    return { tool, run: null, flagPort: flag?.port ?? null, flagSpelling: flag?.spelling ?? null, envPort, dir: null }
  }
  if (PORT_CLIENTS.has(name)) return null
  const flag = findFlagPort(args, DASH_P_TOOLS.has(name))
  if (flag === null && envPort === null) return null
  // A PORT= alone in front of a test runner (or `node --test`) names a server to reach.
  if (flag === null && isTestRun(name, args)) return null
  return { tool: 'generic', run: null, flagPort: flag?.port ?? null, flagSpelling: flag?.spelling ?? null, envPort, dir: null }
}

/**
 * The first segment of a shell command that starts a server, with the folder
 * any `cd dir &&` before it moved to. Null when no segment starts one.
 */
export function detectServerStart(command: string): ServerStart | null {
  const pieces = splitCommandPieces(command)
  let dir: string | null = null
  for (let pieceIndex = 0; pieceIndex < pieces.length; pieceIndex += 2) {
    const { core } = splitSegmentEdges(pieces[pieceIndex] ?? '')
    const words = tokenize(core)
    const first = words[0]
    if (first === 'cd' || first === 'pushd') {
      dir = words[1] === '-' ? dir : joinDir(dir, words[1])
      continue
    }
    const analysis = analyzeWords(words)
    if (analysis !== null) {
      const combinedDir = analysis.dir === null ? dir : joinDir(dir, analysis.dir)
      return { analysis: { ...analysis, dir: combinedDir }, pieces, pieceIndex }
    }
  }
  return null
}

// ---- The project around it ---------------------------------------------------

export type NestMain = { fileName: string; port: number | null; readsPortEnv: boolean }

export type Project = {
  packageJsonPath: string
  /** The scripts in package.json order. */
  scripts: Record<string, string>
  /** A literal `server.port` in vite.config.*, else null. */
  viteConfig: { fileName: string; port: number } | null
  nestMain: NestMain | null
}

/** The scripts of a package.json text, or null when it does not parse. */
export function parsePackageScripts(text: string): Record<string, string> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const scripts = (parsed as { scripts?: unknown }).scripts
  const result: Record<string, string> = {}
  if (scripts !== null && typeof scripts === 'object') {
    for (const [name, body] of Object.entries(scripts as Record<string, unknown>)) {
      if (typeof body === 'string') result[name] = body
    }
  }
  return result
}

/** A literal `server: { port: N }` in a vite config, else null. Nested objects inside `server` before `port` are not followed. */
export function parseViteConfigPort(text: string): number | null {
  const match = /\bserver\s*:\s*\{[^{}]*?\bport\s*:\s*(\d{1,5})\b/.exec(text)
  return toPort(match?.[1])
}

/** The port in a Nest `src/main.ts` `listen(...)`: a literal, or the `?? N` / `|| N` fallback beside an env read. */
export function parseNestMainPort(text: string, fileName: string): NestMain {
  const listen = /\.listen\(\s*([^)]*)\)/.exec(text)
  const argument = listen?.[1]?.split(',')[0]?.trim() ?? ''
  const readsPortEnv = /process\.env\.PORT|process\.env\[['"]PORT['"]\]|get\(\s*['"]PORT['"]/.test(text)
  if (/^\d{1,5}$/.test(argument)) {
    return { fileName, port: toPort(argument), readsPortEnv: false }
  }
  const fallback = /(?:\?\?|\|\|)\s*['"]?(\d{1,5})['"]?/.exec(argument)
  return { fileName, port: toPort(fallback?.[1]), readsPortEnv: readsPortEnv || argument !== '' }
}

export type ScriptAnalysis = CommandAnalysis & { tool: ToolName; chain: string[] }

/** What a package.json script would serve, following `npm run other` up to three deep. Null when it starts no server. */
export function analyzeScript(name: string, project: Project, depth = 0): ScriptAnalysis | null {
  const body = project.scripts[name]
  if (body === undefined || depth > 3) return null
  const start = detectServerStart(body)
  if (start === null) return null
  const { analysis } = start
  if (analysis.run !== null) {
    if (analysis.run.script === name) return null
    const inner = analyzeScript(analysis.run.script, project, depth + 1)
    if (inner === null) return null
    const passedFlag = findFlagPort(analysis.run.passArgs, TOOLS[inner.tool].acceptsDashP)
    return {
      ...inner,
      flagPort: passedFlag?.port ?? inner.flagPort,
      flagSpelling: passedFlag?.spelling ?? inner.flagSpelling,
      envPort: inner.envPort ?? analysis.envPort,
      chain: [name, ...inner.chain],
    }
  }
  if (analysis.tool === null) return null
  return { ...analysis, tool: analysis.tool, chain: [name] }
}

// ---- Which port --------------------------------------------------------------

export type PortLevel = 'flag' | 'env' | 'script' | 'config' | 'default'

export type PortLevels = {
  flag: number | null
  env: number | null
  script: number | null
  config: number | null
  frameworkDefault: number | null
}

/** Explicit flag beats env, which beats the script's own port, then the config file, then the framework default. */
export function resolvePort(levels: PortLevels): { port: number; level: PortLevel } | null {
  if (levels.flag !== null) return { port: levels.flag, level: 'flag' }
  if (levels.env !== null) return { port: levels.env, level: 'env' }
  if (levels.script !== null) return { port: levels.script, level: 'script' }
  if (levels.config !== null) return { port: levels.config, level: 'config' }
  if (levels.frameworkDefault !== null) return { port: levels.frameworkDefault, level: 'default' }
  return null
}

function isPortEnvRead(tool: ToolName, project: Project | null): boolean {
  if (tool === 'nest') return project?.nestMain?.readsPortEnv ?? true
  return TOOLS[tool].readsPortEnv
}

/** The config-file port for a tool: vite.config's server.port, or Nest's main.ts listen port. */
export function configPortFor(tool: ToolName, project: Project | null): { port: number; label: string } | null {
  if ((tool === 'vite' || tool === 'remix-vite') && project?.viteConfig) {
    return { port: project.viteConfig.port, label: `${project.viteConfig.fileName} server.port` }
  }
  if (tool === 'nest' && project?.nestMain?.port != null) {
    return { port: project.nestMain.port, label: `${project.nestMain.fileName} listen(${project.nestMain.port})` }
  }
  return null
}

export type Effective = {
  port: number
  level: PortLevel
  tool: ToolName
  /** Where the port came from, for the pane: `--port 3000`, `vite default`, `vite.config.ts server.port`. */
  detail: string
  script: ScriptAnalysis | null
}

function levelDetail(level: PortLevel, port: number, tool: ToolName, spelling: FlagSpelling | null, configLabel: string | null, scriptName: string | null): string {
  if (level === 'flag') {
    if (spelling === 'positional') return `port argument ${port}`
    if (spelling === 'php-host') return `-S host:${port}`
    return `${spelling ?? '--port'} ${port}`
  }
  if (level === 'env') return `PORT=${port}`
  if (level === 'script') return `script "${scriptName ?? ''}"`
  if (level === 'config') return configLabel ?? 'config'
  return `${TOOLS[tool].label} default`
}

/** The port this command would serve on, or null when it cannot be told. */
export function resolveCommand(analysis: CommandAnalysis, project: Project | null): Effective | null {
  if (analysis.run !== null) {
    const script = project === null ? null : analyzeScript(analysis.run.script, project)
    if (script === null) {
      // A script that is positively no server (a test run, a build, a lint) serves nothing.
      const body = project?.scripts[analysis.run.script]
      if (body !== undefined && isKnownNonServer(body)) return null
      // An unknown script body: only a port on the command line says anything.
      const flag = findFlagPort(analysis.run.passArgs, false)
      if (flag !== null) return { port: flag.port, level: 'flag', tool: 'generic', detail: `--port ${flag.port}`, script: null }
      if (analysis.envPort !== null) return { port: analysis.envPort, level: 'env', tool: 'generic', detail: `PORT=${analysis.envPort}`, script: null }
      return null
    }
    const isEnvRead = isPortEnvRead(script.tool, project)
    const passedFlag = findFlagPort(analysis.run.passArgs, TOOLS[script.tool].acceptsDashP)
    const config = configPortFor(script.tool, project)
    const resolved = resolvePort({
      flag: passedFlag?.port ?? null,
      // A PORT= the script sets itself overrides one set around the run.
      env: isEnvRead && script.envPort === null ? analysis.envPort : null,
      script: script.flagPort ?? (isEnvRead ? script.envPort : null),
      config: config?.port ?? null,
      frameworkDefault: TOOLS[script.tool].defaultPort,
    })
    if (resolved === null) return null
    const detail =
      resolved.level === 'script'
        ? `script "${analysis.run.script}" (${script.flagPort !== null ? `${script.flagSpelling ?? '--port'} ${script.flagPort}` : `PORT=${script.envPort}`})`
        : levelDetail(resolved.level, resolved.port, script.tool, passedFlag?.spelling ?? null, config?.label ?? null, analysis.run.script)
    return { port: resolved.port, level: resolved.level, tool: script.tool, detail, script }
  }
  const tool = analysis.tool ?? 'generic'
  const config = configPortFor(tool, project)
  const resolved = resolvePort({
    flag: analysis.flagPort,
    env: isPortEnvRead(tool, project) ? analysis.envPort : null,
    script: null,
    config: config?.port ?? null,
    frameworkDefault: TOOLS[tool].defaultPort,
  })
  if (resolved === null) return null
  return {
    port: resolved.port,
    level: resolved.level,
    tool,
    detail: levelDetail(resolved.level, resolved.port, tool, analysis.flagSpelling, config?.label ?? null, null),
    script: null,
  }
}

// ---- Reserved ports ----------------------------------------------------------

export type Reservation = { port: number; sources: string[] }

export const SETTING_SOURCE = 'reservedPorts setting'

/** Ports from the setting's comma list, and the entries that are no port. */
export function parsePortList(text: string): { ports: number[]; ignored: string[] } {
  const ports: number[] = []
  const ignored: string[] = []
  for (const entry of text.split(/[,\s]+/)) {
    if (entry === '') continue
    const port = toPort(entry)
    if (port === null) ignored.push(entry)
    else if (!ports.includes(port)) ports.push(port)
  }
  return { ports, ignored }
}

/** The label for a package.json script's port: `package.json script "dev" (vite default)`. */
export function scriptSourceLabel(name: string, script: ScriptAnalysis, project: Project): { port: number; label: string } | null {
  const isEnvRead = isPortEnvRead(script.tool, project)
  const config = configPortFor(script.tool, project)
  let port: number | null
  let how: string
  if (script.flagPort !== null) {
    port = script.flagPort
    how = script.flagSpelling === 'positional' ? `port argument ${port}` : script.flagSpelling === 'php-host' ? `-S host:${port}` : `${script.flagSpelling ?? '--port'} ${port}`
  } else if (isEnvRead && script.envPort !== null) {
    port = script.envPort
    how = `PORT=${port}`
  } else if (config !== null) {
    port = config.port
    how = config.label
  } else {
    port = TOOLS[script.tool].defaultPort
    how = `${TOOLS[script.tool].label} default`
  }
  if (port === null) return null
  return { port, label: `package.json script "${name}" (${how})` }
}

/** Every reserved port with where it comes from: the setting first, then package.json scripts, then vite.config. */
export function collectReservations(settingPorts: readonly number[], project: Project | null): Reservation[] {
  const byPort = new Map<number, string[]>()
  const add = (port: number, source: string): void => {
    const sources = byPort.get(port) ?? []
    if (!sources.includes(source)) sources.push(source)
    byPort.set(port, sources)
  }
  for (const port of settingPorts) add(port, SETTING_SOURCE)
  if (project !== null) {
    for (const name of Object.keys(project.scripts)) {
      const script = analyzeScript(name, project)
      if (script === null) continue
      const labelled = scriptSourceLabel(name, script, project)
      if (labelled !== null) add(labelled.port, labelled.label)
    }
    if (project.viteConfig !== null) add(project.viteConfig.port, `${project.viteConfig.fileName} server.port`)
  }
  return [...byPort.entries()].map(([port, sources]) => ({ port, sources })).sort((left, right) => left.port - right.port)
}

// ---- Moving a command --------------------------------------------------------

export type RewritePlan = {
  command: string
  method: MoveMethod | 'both'
  /** The words Claude is told to use: `--port 4100`, `PORT=4100`. */
  hint: string
  /** Said in the pane when the move may not take. */
  note: string | null
}

function replacePortFlag(core: string, port: number, isDashPAccepted: boolean): string | null {
  const longForm = /(--port(?:=|\s+))\d{1,5}\b/
  if (longForm.test(core)) return core.replace(longForm, `$1${port}`)
  const shortForm = /(^|\s)(-p\s+)\d{1,5}\b/
  if (isDashPAccepted && shortForm.test(core)) return core.replace(shortForm, `$1$2${port}`)
  return null
}

function setPortEnv(core: string, port: number): string {
  const existing = /(^|\s)PORT=\S*/
  // Only a PORT= among the leading assignments counts; one later is an argument.
  const leading = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/.exec(core)?.[0] ?? ''
  if (existing.test(leading)) return leading.replace(existing, `$1PORT=${port}`) + core.slice(leading.length)
  return `PORT=${port} ${core}`
}

function appendWords(core: string, words: string): string {
  return `${core.replace(/\s+$/, '')} ${words}`
}

/** Moves a package-manager run to a port by handing the flag on to its script. */
function passFlagToScript(core: string, run: ScriptRun, port: number): string {
  const replaced = replacePortFlag(core, port, false)
  if (replaced !== null) return replaced
  if (run.runner === 'npm') {
    return /(^|\s)--(\s|$)/.test(core) ? appendWords(core, `--port ${port}`) : appendWords(core, `-- --port ${port}`)
  }
  return appendWords(core, `--port ${port}`)
}

function moveCore(core: string, analysis: CommandAnalysis, effective: Effective, port: number): Omit<RewritePlan, 'command'> & { core: string } {
  const tool = effective.tool
  const traits = TOOLS[tool]
  if (analysis.run !== null) {
    const run = analysis.run
    const script = effective.script
    const flagHint = run.runner === 'npm' ? `-- --port ${port}` : `--port ${port}`
    if (script === null) {
      return { core: setPortEnv(passFlagToScript(core, run, port), port), method: 'both', hint: `PORT=${port} and ${flagHint}`, note: `pulse-ports could not read the script "${run.script}", so it set both PORT=${port} and --port ${port}; check the server's output for the port it took.` }
    }
    const isFlagMoveKnown = tool === 'generic' ? script.flagSpelling === '--port' : traits.moveMethod === 'flag'
    if (isFlagMoveKnown) {
      const note = script.flagPort !== null && script.flagSpelling === '--port'
        ? `The script already passes --port ${script.flagPort}; most servers take the last --port, so check its output.`
        : null
      return { core: passFlagToScript(core, run, port), method: 'flag', hint: flagHint, note }
    }
    const isEnvMoveKnown = isPortEnvRead(tool, null) && script.envPort === null && script.flagPort === null
    if (isEnvMoveKnown && !(tool === 'nest' && effective.level === 'config')) {
      return { core: setPortEnv(core, port), method: 'env', hint: `PORT=${port}`, note: null }
    }
    const why = script.envPort !== null
      ? `the script sets PORT=${script.envPort} itself`
      : script.flagPort !== null
        ? `the script passes ${script.flagSpelling === '-p' ? '-p' : 'its port'} ${script.flagPort} itself`
        : `${traits.label} takes its port from ${effective.detail}`
    return { core: setPortEnv(passFlagToScript(core, run, port), port), method: 'both', hint: `PORT=${port} and ${flagHint}`, note: `Neither PORT nor --port is known to move this script (${why}), so pulse-ports set both; check the server's output for the port it took.` }
  }
  if (traits.moveMethod === 'positional') {
    const positional = /(http\.server)(\s+)\d{1,5}\b/
    const moved = positional.test(core) ? core.replace(positional, `$1$2${port}`) : core.replace(/http\.server/, `http.server ${port}`)
    return { core: moved, method: 'positional', hint: `the port argument ${port}`, note: null }
  }
  if (traits.moveMethod === 'php-host') {
    return { core: core.replace(/(-S\s+\S*?:)\d{1,5}\b/, `$1${port}`), method: 'php-host', hint: `-S localhost:${port}`, note: null }
  }
  if (tool === 'generic') {
    if (analysis.flagSpelling === '--port' || analysis.flagSpelling === '-p') {
      const moved = replacePortFlag(core, port, analysis.flagSpelling === '-p') ?? appendWords(core, `--port ${port}`)
      const withEnv = analysis.envPort !== null ? setPortEnv(moved, port) : moved
      return { core: withEnv, method: 'flag', hint: `${analysis.flagSpelling} ${port}`, note: null }
    }
    return { core: setPortEnv(core, port), method: 'env', hint: `PORT=${port}`, note: null }
  }
  if (traits.moveMethod === 'flag') {
    const moved = replacePortFlag(core, port, traits.acceptsDashP) ?? appendWords(core, `--port ${port}`)
    const withEnv = analysis.envPort !== null && traits.readsPortEnv ? setPortEnv(moved, port) : moved
    return { core: withEnv, method: 'flag', hint: `--port ${port}`, note: null }
  }
  // nest and remix dev read PORT.
  const note = tool === 'nest' && effective.level === 'config'
    ? `${effective.detail} is a literal, so PORT=${port} may not move it; have main.ts read process.env.PORT.`
    : null
  return { core: setPortEnv(core, port), method: 'env', hint: `PORT=${port}`, note }
}

/** The command rewritten to serve on `port`, with how and a note when the move may not take. */
export function planRewrite(start: ServerStart, effective: Effective, port: number): RewritePlan {
  const pieces = [...start.pieces]
  const { head, core, tail } = splitSegmentEdges(pieces[start.pieceIndex] ?? '')
  const moved = moveCore(core, start.analysis, effective, port)
  pieces[start.pieceIndex] = `${head}${moved.core}${tail}`
  return { command: pieces.join(''), method: moved.method, hint: moved.hint, note: moved.note }
}

// ---- .claude/launch.json -----------------------------------------------------

export type LaunchConfiguration = {
  name?: unknown
  runtimeExecutable?: unknown
  runtimeArgs?: unknown
  port?: unknown
  url?: unknown
  cwd?: unknown
  [field: string]: unknown
}

export type LaunchDocument = { configurations?: unknown; [field: string]: unknown }

/** Parses launch.json, allowing // line comments and trailing commas as editors write them. */
export function parseLaunchJson(text: string): LaunchDocument | null {
  const withoutComments = text.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*/g, (whole, quoted: string | undefined) => quoted ?? '')
  const withoutTrailingCommas = withoutComments.replace(/,(\s*[}\]])/g, '$1')
  try {
    const parsed: unknown = JSON.parse(withoutTrailingCommas)
    return parsed !== null && typeof parsed === 'object' ? (parsed as LaunchDocument) : null
  } catch {
    return null
  }
}

export function findLaunchConfiguration(document: LaunchDocument, name: string): LaunchConfiguration | null {
  const list = Array.isArray(document.configurations) ? (document.configurations as unknown[]) : []
  for (const entry of list) {
    if (entry !== null && typeof entry === 'object' && (entry as LaunchConfiguration).name === name) {
      return entry as LaunchConfiguration
    }
  }
  return null
}

function quoteWord(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`
}

/** A launch configuration's command line, as Bash would read it. */
export function launchCommandLine(configuration: LaunchConfiguration): string {
  const executable = typeof configuration.runtimeExecutable === 'string' ? configuration.runtimeExecutable : ''
  const args = Array.isArray(configuration.runtimeArgs) ? configuration.runtimeArgs.filter((arg): arg is string => typeof arg === 'string') : []
  return [executable, ...args].filter((word) => word !== '').map(quoteWord).join(' ')
}

/**
 * The configuration moved to `port`: `port` set, any `:old` in `url` changed,
 * and the runtime command rewritten so the server listens there too. A PORT=
 * prefix becomes `env PORT=N <command>`, since launch.json runs no shell.
 */
export function rewriteLaunchConfiguration(
  configuration: LaunchConfiguration,
  oldPort: number,
  port: number,
  project: Project | null,
): { configuration: LaunchConfiguration; summary: string; note: string | null } {
  const commandLine = launchCommandLine(configuration)
  const start = detectServerStart(commandLine)
  const effective = start === null ? null : resolveCommand(start.analysis, project)
  let argv: string[]
  let note: string | null = null
  if (start !== null && effective !== null) {
    const plan = planRewrite(start, effective, port)
    argv = tokenize(plan.command)
    note = plan.note
  } else {
    argv = [`PORT=${port}`, ...tokenize(commandLine)]
    note = `pulse-ports could not tell how "${commandLine}" picks its port, so it runs it with PORT=${port}; check the server's output.`
  }
  const assignments: string[] = []
  while (ASSIGNMENT.test(argv[0] ?? '')) assignments.push(argv.shift() ?? '')
  const moved: LaunchConfiguration = { ...configuration, port }
  if (assignments.length > 0) {
    moved.runtimeExecutable = 'env'
    moved.runtimeArgs = [...assignments, ...argv]
  } else if (argv.length > 0) {
    moved.runtimeExecutable = argv[0]
    moved.runtimeArgs = argv.slice(1)
  }
  if (typeof configuration.url === 'string') {
    moved.url = configuration.url.replace(new RegExp(`:${oldPort}(?=\\b|/|$)`), `:${port}`)
  }
  const summary = `port ${port}, runs ${launchCommandLine(moved)}`
  return { configuration: moved, summary, note }
}

/** launch.json with one configuration replaced, written back as two-space JSON. */
export function replaceLaunchConfiguration(document: LaunchDocument, name: string, configuration: LaunchConfiguration): string {
  const list = Array.isArray(document.configurations) ? (document.configurations as unknown[]) : []
  const configurations = list.map((entry) =>
    entry !== null && typeof entry === 'object' && (entry as LaunchConfiguration).name === name ? configuration : entry,
  )
  return `${JSON.stringify({ ...document, configurations }, null, 2)}\n`
}

// ---- Words for the pane and Claude ---------------------------------------------

/** One line for a toast: the command cut to `limit` characters. */
export function shortCommand(command: string, limit = 60): string {
  const oneLine = command.replace(/\s+/g, ' ').trim()
  return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, limit - 3)}...`
}

export type DenyReason = 'cancel' | 'timeout' | 'interrupted' | 'error'

/** The refusal Claude reads, naming the port, the free one, how to use it and why the command did not run. */
export function denyMessage(subject: string, port: number, freePort: number, hint: string, reason: DenyReason, errorText: string | null): string {
  const why = {
    cancel: 'the user pressed Cancel command',
    timeout: 'it was cancelled after 10 minutes without an answer',
    interrupted: 'the turn was interrupted',
    error: `pulse-ports hit an error while holding it (${errorText ?? 'no message'})`,
  }[reason]
  return (
    `pulse-ports held ${subject}: it would start a server on port ${port}, which the user keeps for their own manual testing. ` +
    `Start it on another port, for example ${freePort} with ${hint}. It did not run because ${why}.`
  )
}
