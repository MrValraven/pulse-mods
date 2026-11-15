import { describe, expect, test } from 'claude-code/testing'

import {
  analyzeScript,
  collectReservations,
  denyMessage,
  detectServerStart,
  findLaunchConfiguration,
  parseLaunchJson,
  parseNestMainPort,
  parsePackageScripts,
  parsePortList,
  parseViteConfigPort,
  planRewrite,
  resolveCommand,
  resolvePort,
  rewriteLaunchConfiguration,
  splitCommandPieces,
} from '../hooks/ports'
import type { Project } from '../hooks/ports'

const project = (scripts: Record<string, string>, extra: Partial<Project> = {}): Project => ({
  packageJsonPath: '/work/package.json',
  scripts,
  viteConfig: null,
  nestMain: null,
  ...extra,
})

/** The port a command would serve on, with its project. */
const portOf = (command: string, around: Project | null = null): number | null => {
  const start = detectServerStart(command)
  return start === null ? null : (resolveCommand(start.analysis, around)?.port ?? null)
}

/** The command moved to `port`. */
const moved = (command: string, port: number, around: Project | null = null): string => {
  const start = detectServerStart(command)
  if (start === null) throw new Error(`no server start in ${command}`)
  const effective = resolveCommand(start.analysis, around)
  if (effective === null) throw new Error(`no port for ${command}`)
  return planRewrite(start, effective, port).command
}

describe('port resolution order', () => {
  test('explicit flag beats env beats script beats config beats framework default', () => {
    const all = { flag: 1, env: 2, script: 3, config: 4, frameworkDefault: 5 }
    expect(resolvePort(all)).toEqual({ port: 1, level: 'flag' })
    expect(resolvePort({ ...all, flag: null })).toEqual({ port: 2, level: 'env' })
    expect(resolvePort({ ...all, flag: null, env: null })).toEqual({ port: 3, level: 'script' })
    expect(resolvePort({ ...all, flag: null, env: null, script: null })).toEqual({ port: 4, level: 'config' })
    expect(resolvePort({ flag: null, env: null, script: null, config: null, frameworkDefault: 5 })).toEqual({ port: 5, level: 'default' })
    expect(resolvePort({ flag: null, env: null, script: null, config: null, frameworkDefault: null })).toBe(null)
  })

  test('a command-line flag beats PORT and the script', () => {
    const around = project({ dev: 'PORT=3000 next dev' })
    expect(portOf('npm run dev', around)).toBe(3000)
    expect(portOf('npm run dev -- --port 3005', around)).toBe(3005)
    expect(portOf('PORT=3004 next dev --port 3006')).toBe(3006)
    expect(portOf('PORT=3004 next dev')).toBe(3004)
  })

  test('PORT counts only for tools that read it', () => {
    expect(portOf('PORT=4000 vite')).toBe(5173)
    expect(portOf('PORT=4000 node server.js')).toBe(4000)
  })

  test('a PORT the script sets itself beats one set around the run', () => {
    expect(portOf('PORT=4000 npm run dev', project({ dev: 'PORT=3000 next dev' }))).toBe(3000)
    expect(portOf('PORT=4000 npm run dev', project({ dev: 'next dev' }))).toBe(4000)
  })
})

describe('package.json script parsing', () => {
  test('scripts come out of package.json text, and bad JSON is null', () => {
    expect(parsePackageScripts('{"scripts":{"dev":"vite","n":1}}')).toEqual({ dev: 'vite' })
    expect(parsePackageScripts('{"name":"x"}')).toEqual({})
    expect(parsePackageScripts('{ not json')).toBe(null)
  })

  test('script runs and their shorthands', () => {
    const around = project({ dev: 'vite --port 5174', start: 'next start -p 3001', serve: 'vite preview' })
    expect(portOf('npm run dev', around)).toBe(5174)
    expect(portOf('pnpm dev', around)).toBe(5174)
    expect(portOf('yarn dev', around)).toBe(5174)
    expect(portOf('bun run dev', around)).toBe(5174)
    expect(portOf('npm start', around)).toBe(3001)
    expect(portOf('pnpm run serve', around)).toBe(4173)
  })

  test('builtins and non-server scripts start nothing', () => {
    const around = project({ build: 'vite build', test: 'vitest' })
    expect(portOf('npm run build', around)).toBe(null)
    expect(portOf('npm test', around)).toBe(null)
    expect(portOf('pnpm install')).toBe(null)
    expect(portOf('yarn add vite')).toBe(null)
  })

  test('a script that runs another script is followed', () => {
    const around = project({ dev: 'npm run web', web: 'astro dev --port 4400' })
    expect(analyzeScript('dev', around)?.chain).toEqual(['dev', 'web'])
    expect(portOf('npm run dev', around)).toBe(4400)
  })

  test('npm hands on only what follows --', () => {
    const around = project({ dev: 'vite' })
    expect(portOf('npm run dev --port 4000', around)).toBe(5173)
    expect(portOf('npm run dev -- --port 4000', around)).toBe(4000)
    expect(portOf('pnpm dev --port 4000', around)).toBe(4000)
  })
})

describe('framework defaults', () => {
  test('each known tool has its default', () => {
    expect(portOf('vite')).toBe(5173)
    expect(portOf('npx vite')).toBe(5173)
    expect(portOf('vite preview')).toBe(4173)
    expect(portOf('next dev')).toBe(3000)
    expect(portOf('next start')).toBe(3000)
    expect(portOf('nest start --watch')).toBe(3000)
    expect(portOf('astro dev')).toBe(4321)
    expect(portOf('remix dev')).toBe(3000)
    expect(portOf('nuxt dev')).toBe(3000)
    expect(portOf('python3 -m http.server')).toBe(8000)
    expect(portOf('python -m http.server 9000')).toBe(9000)
    expect(portOf('rails s')).toBe(3000)
    expect(portOf('bin/rails server -p 3100')).toBe(3100)
    expect(portOf('php -S localhost:8080')).toBe(8080)
  })

  test('builds and clients are not servers', () => {
    expect(portOf('vite build')).toBe(null)
    expect(portOf('next build')).toBe(null)
    expect(portOf('psql --port 5432')).toBe(null)
    expect(portOf('docker run -p 3000:3000 app')).toBe(null)
    expect(portOf('ls -p 3000')).toBe(null)
  })

  test('any command with --port or a PORT prefix, -p only for known server tools', () => {
    expect(portOf('uvicorn main:app --port 3000')).toBe(3000)
    expect(portOf('node server.js --port=3002')).toBe(3002)
    expect(portOf('http-server -p 3003')).toBe(3003)
    expect(portOf('PORT=3000 node server.js')).toBe(3000)
  })

  test('a literal vite server.port replaces the vite default', () => {
    expect(parseViteConfigPort('export default defineConfig({ server: { host: true, port: 5180 } })')).toBe(5180)
    expect(parseViteConfigPort('export default defineConfig({ server: { port: Number(process.env.P) } })')).toBe(null)
    const around = project({ dev: 'vite' }, { viteConfig: { fileName: 'vite.config.ts', port: 5180 } })
    expect(portOf('npm run dev', around)).toBe(5180)
    expect(portOf('vite --port 5190', around)).toBe(5190)
  })

  test("Nest's main.ts: a literal port, a fallback beside PORT, or 3000", () => {
    expect(parseNestMainPort('await app.listen(3001);', 'src/main.ts')).toEqual({ fileName: 'src/main.ts', port: 3001, readsPortEnv: false })
    expect(parseNestMainPort('await app.listen(process.env.PORT ?? 3002);', 'src/main.ts')).toEqual({ fileName: 'src/main.ts', port: 3002, readsPortEnv: true })
    const literal = project({ 'start:dev': 'nest start --watch' }, { nestMain: { fileName: 'src/main.ts', port: 3001, readsPortEnv: false } })
    expect(portOf('npm run start:dev', literal)).toBe(3001)
    expect(portOf('PORT=4000 npm run start:dev', literal)).toBe(3001)
  })
})

describe('cd following', () => {
  test('a leading cd moves the folder the command runs in', () => {
    expect(detectServerStart('cd web && npm run dev')?.analysis.dir).toBe('web')
    expect(detectServerStart('cd web && cd app && vite')?.analysis.dir).toBe('web/app')
    expect(detectServerStart('cd /srv/site && vite')?.analysis.dir).toBe('/srv/site')
    expect(detectServerStart('(cd web && npm run dev)')?.analysis.dir).toBe('web')
    expect(detectServerStart('vite')?.analysis.dir).toBe(null)
  })

  test('package-manager folder options move it too', () => {
    expect(detectServerStart('pnpm -C web dev')?.analysis.dir).toBe('web')
    expect(detectServerStart('npm --prefix web run dev')?.analysis.dir).toBe('web')
    expect(detectServerStart('cd apps && yarn --cwd web dev')?.analysis.dir).toBe('apps/web')
  })
})

describe('separators, background jobs and heredocs', () => {
  test('a lone & ends the server part, and the flag lands on the server', () => {
    const around = project({ dev: 'vite' })
    expect(moved('npm run dev & sleep 3', 4100, around)).toBe('npm run dev -- --port 4100 & sleep 3')
    expect(moved('npx vite > log 2>&1 & sleep 3 && curl x', 4100)).toBe('npx vite --port 4100 > log 2>&1 & sleep 3 && curl x')
    expect(moved('sleep 1 & npm run dev', 4100, around)).toBe('sleep 1 & npm run dev -- --port 4100')
    expect(moved('vite &> log &', 4100)).toBe('vite --port 4100 &> log &')
  })

  test('&& >& 2>&1 and |& are kept apart from a lone &', () => {
    expect(splitCommandPieces('a 2>&1 & b && c |& d')).toEqual(['a 2>&1 ', '&', ' b ', '&&', ' c ', '|&', ' d'])
    expect(splitCommandPieces('echo "a & b"')).toEqual(['echo "a & b"'])
  })

  test('heredoc bodies are never read as commands', () => {
    expect(portOf('cat <<EOF > notes.md\nnpm run dev\nEOF\necho done', project({ dev: 'vite' }))).toBe(null)
    expect(moved("cat <<'EOF'\nvite --port 3000\nEOF\nnpx vite", 4100)).toBe("cat <<'EOF'\nvite --port 3000\nEOF\nnpx vite --port 4100")
  })
})

describe('test runners', () => {
  test('a PORT prefix in front of a test runner starts no server', () => {
    expect(portOf('PORT=3000 npx playwright test')).toBe(null)
    expect(portOf('PORT=3000 vitest run')).toBe(null)
    expect(portOf('PORT=3000 node --test')).toBe(null)
    expect(portOf('PORT=3000 npm run test:e2e', project({ 'test:e2e': 'playwright test' }))).toBe(null)
    expect(portOf('PORT=3000 node server.js')).toBe(3000)
    expect(portOf('PORT=3000 node server.js --test')).toBe(3000)
  })

  test('a script that serves with no port of its own still takes the port from the command line', () => {
    expect(portOf('PORT=3000 npm run dev', project({ dev: 'tsx watch src/index.ts' }))).toBe(3000)
    expect(portOf('npm run serve -- --port 3000', project({ serve: 'node server.js' }))).toBe(3000)
    expect(portOf('PORT=3000 pnpm api', project({ api: 'nodemon app.js' }))).toBe(3000)
    expect(portOf('PORT=3000 npm run build', project({ build: 'next build' }))).toBe(null)
    expect(portOf('PORT=3000 npm run lint', project({ lint: 'eslint .' }))).toBe(null)
  })

  test('a build before a server leaves the script a server', () => {
    expect(portOf('PORT=3000 npm run start', project({ start: 'tsc && node dist/index.js' }))).toBe(3000)
    expect(portOf('PORT=3000 npm run start', project({ start: 'next build && node server.js' }))).toBe(3000)
    expect(portOf('PORT=3000 npm run check', project({ check: 'vitest run && eslint .' }))).toBe(null)
  })
})

describe('rewrite output per tool', () => {
  test('flag tools get --port added or replaced', () => {
    expect(moved('vite', 4100)).toBe('vite --port 4100')
    expect(moved('vite --port 3000', 4100)).toBe('vite --port 4100')
    expect(moved('vite --port=3000 --host', 4100)).toBe('vite --port=4100 --host')
    expect(moved('next dev -p 3000', 4100)).toBe('next dev -p 4100')
    expect(moved('astro dev', 4100)).toBe('astro dev --port 4100')
    expect(moved('cd web && npx vite', 4100)).toBe('cd web && npx vite --port 4100')
  })

  test('npm runs hand the flag on after --, other runners directly', () => {
    const around = project({ dev: 'vite' })
    expect(moved('npm run dev', 4100, around)).toBe('npm run dev -- --port 4100')
    expect(moved('npm run dev -- --host', 4100, around)).toBe('npm run dev -- --host --port 4100')
    expect(moved('pnpm dev', 4100, around)).toBe('pnpm dev --port 4100')
    expect(moved('npm run dev > dev.log 2>&1 &', 4100, around)).toBe('npm run dev -- --port 4100 > dev.log 2>&1 &')
  })

  test('PORT tools get a PORT prefix', () => {
    expect(moved('PORT=3000 node server.js', 4100)).toBe('PORT=4100 node server.js')
    expect(moved('nest start --watch', 4100)).toBe('PORT=4100 nest start --watch')
    expect(moved('npm run start:dev', 4100, project({ 'start:dev': 'nest start --watch' }))).toBe('PORT=4100 npm run start:dev')
  })

  test('python, php and rails', () => {
    expect(moved('python3 -m http.server', 4100)).toBe('python3 -m http.server 4100')
    expect(moved('python3 -m http.server 8000 --bind 127.0.0.1', 4100)).toBe('python3 -m http.server 4100 --bind 127.0.0.1')
    expect(moved('php -S localhost:3000 -t public', 4100)).toBe('php -S localhost:4100 -t public')
    expect(moved('rails s -p 3000', 4100)).toBe('rails s -p 4100')
  })

  test('when neither is known to work, both are set and the plan says so', () => {
    const start = detectServerStart('npm run dev')
    const around = project({ dev: 'PORT=3000 node server.js' })
    if (start === null) throw new Error('no start')
    const effective = resolveCommand(start.analysis, around)
    if (effective === null) throw new Error('no port')
    const plan = planRewrite(start, effective, 4100)
    expect(plan.method).toBe('both')
    expect(plan.command).toBe('PORT=4100 npm run dev -- --port 4100')
    expect(plan.note).toMatch(/the script sets PORT=3000 itself/)
  })

  test('launch.json moves port, url and the runtime command', () => {
    const document = parseLaunchJson(`{
      // the web app
      "configurations": [
        { "name": "web", "runtimeExecutable": "npm", "runtimeArgs": ["run", "dev"], "port": 5173, "url": "http://localhost:5173/app", },
      ],
    }`)
    if (document === null) throw new Error('launch.json did not parse')
    const configuration = findLaunchConfiguration(document, 'web')
    if (configuration === null) throw new Error('no web configuration')
    const result = rewriteLaunchConfiguration(configuration, 5173, 4100, project({ dev: 'vite' }))
    expect(result.configuration.port).toBe(4100)
    expect(result.configuration.url).toBe('http://localhost:4100/app')
    expect(result.configuration.runtimeExecutable).toBe('npm')
    expect(result.configuration.runtimeArgs).toEqual(['run', 'dev', '--', '--port', '4100'])
    const env = rewriteLaunchConfiguration({ name: 'api', runtimeExecutable: 'npm', runtimeArgs: ['run', 'start:dev'], port: 3000 }, 3000, 4100, project({ 'start:dev': 'nest start' }))
    expect(env.configuration.runtimeExecutable).toBe('env')
    expect(env.configuration.runtimeArgs).toEqual(['PORT=4100', 'npm', 'run', 'start:dev'])
  })
})

describe('reserved-source labels', () => {
  test('the setting list parses, and entries that are no port are kept apart', () => {
    expect(parsePortList('3000, 8080,3000')).toEqual({ ports: [3000, 8080], ignored: [] })
    expect(parsePortList('3000, abc, 70000')).toEqual({ ports: [3000], ignored: ['abc', '70000'] })
    expect(parsePortList('')).toEqual({ ports: [], ignored: [] })
  })

  test('each reservation names the setting, the script or the vite config', () => {
    const around = project(
      { dev: 'vite', preview: 'vite preview', api: 'PORT=3001 node api.js', web: 'next dev -p 3000', build: 'vite build' },
      { viteConfig: { fileName: 'vite.config.ts', port: 5180 } },
    )
    expect(collectReservations([3000], around)).toEqual([
      { port: 3000, sources: ['reservedPorts setting', 'package.json script "web" (-p 3000)'] },
      { port: 3001, sources: ['package.json script "api" (PORT=3001)'] },
      { port: 4173, sources: ['package.json script "preview" (vite preview default)'] },
      { port: 5180, sources: ['package.json script "dev" (vite.config.ts server.port)', 'vite.config.ts server.port'] },
    ])
  })

  test('framework defaults are labelled by tool', () => {
    expect(collectReservations([], project({ dev: 'astro dev' }))).toEqual([{ port: 4321, sources: ['package.json script "dev" (astro default)'] }])
    expect(collectReservations([], null)).toEqual([])
  })

  test('the refusal names the port, the free port, how and why', () => {
    expect(denyMessage('this command', 3000, 4100, '--port 4100', 'cancel', null)).toBe(
      'pulse-ports held this command: it would start a server on port 3000, which the user keeps for their own manual testing. ' +
        'Start it on another port, for example 4100 with --port 4100. It did not run because the user pressed Cancel command.',
    )
    expect(denyMessage('this command', 3000, 4100, '--port 4100', 'timeout', null)).toMatch(/cancelled after 10 minutes without an answer/)
  })
})
