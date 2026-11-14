# pulse-ports

A Claude Code mod that keeps your testing ports free. When Claude runs a Bash command that would start a dev server on a port you keep for your own testing, pulse-ports holds the command and offers a free port instead.

- **Port held pane**: the first line states the decision, "Held  server on port 3000", and the next says it "would start a server on port 3000, which you keep for your own testing". The buttons come right after, then the details: the command, where the port comes from (`--port 3000`, `PORT=3000`, `vite default`, `vite.config.ts server.port`), which reservation it hits (the `reservedPorts` setting, a package.json script, or the vite config), the free port, and the command as it runs there ("Runs as").
- **Buttons**: `1` **Run on port 4100** runs the command moved to the free port; it holds the focus, so Enter presses it. `2` **Cancel command** refuses it. `3` **Run on 3000 anyway** runs it as Claude wrote it. The numbers match the other pulse guards: `2` refuses everywhere.
- **Toasts**: "pulse-ports moved npm run dev to port 4100" once the moved command has run (no toast when something further down refused it), "pulse-ports cancelled npm run dev: port 3000 stays free for your own testing" after Cancel command, and "pulse-ports cancelled npm run dev after 10 minutes without an answer" after a timeout.
- **What Claude reads after a cancel**: "pulse-ports held this command: it would start a server on port 3000, which the user keeps for their own manual testing. Start it on another port, for example 4100 with --port 4100." followed by why it did not run (the user pressed Cancel command, it was cancelled after 10 minutes without an answer, the turn was interrupted, or the error the hold hit).
- **Narrow terminals**: when the surface won't place the pane, the same hold is drawn in the band above the prompt, with the hint "Claude is waiting: click here or press ctrl+x tab, then 1, 2 or 3". A toast and a system notification say the same, since the band cannot take the keys by itself.

The pane takes the keys when it opens: press `1`, `2` or `3`, or walk the buttons with Tab and the arrows. Esc hands the keys back to the prompt and the hold stays; ctrl+x tab returns to the buttons. Closing the pane counts as Cancel command, and a hold is cancelled after 10 minutes without an answer. The pane closes whenever a hold ends.

## Install

```
claude plugin marketplace add MrValraven/pulse-mods
claude plugin install pulse-ports@pulse-mods --scope user
```

Start a new Claude Code session to load it.

## Settings

Change them with `/config`.

| Setting | Default | What it does |
| --- | --- | --- |
| `reservedPorts` | `3000` | Ports you keep for your own testing, as a comma list (`3000, 8080`). Entries that are no port from 1 to 65535 are ignored, and `/ports` lists them. |
| `checkPackageJson` | `on` | `on` reserves the ports the nearest package.json would serve on, as listed under "What it reserves". `off` reserves only the `reservedPorts` list. The package.json is still read to tell which port `npm run dev` would use. |
| `firstFreePort` | `4100` | Where the search for a free port starts. The offered port is the first one from here up that is not reserved and has no listener (`lsof -nP -iTCP:<port> -sTCP:LISTEN`). When lsof cannot run (missing, or no answer within 5 seconds), the first unreserved port is offered and the pane names the error. |

## Commands

| Command | What it does |
| --- | --- |
| `/ports` | Lists every reserved port with where it comes from, the package.json it read, and the three settings under "Settings (/config, pulse-ports):" by their /config title and key. |
| `/ports help` | Explains holds, the three buttons and their hotkeys, and that ctrl+x tab returns to the buttons. |

Any other argument answers `/ports does not take "x". It takes help or nothing.`

## What it reserves

- Every port in `reservedPorts`.
- With `checkPackageJson` on, the nearest package.json from the folder the command runs in, walking up. For each script that starts a server: an explicit `--port N` or `-p N`, a `PORT=N` in the script, or the framework default when the script sets none: vite 5173, vite preview 4173, next dev and next start 3000, nest start the literal port in `src/main.ts` `listen(...)` (or the `?? N` fallback beside `process.env.PORT`, else 3000), astro 4321, remix 3000, remix vite:dev 5173, nuxt 3000, SvelteKit through vite 5173. A script that runs another script (`"dev": "npm run web"`) is followed up to three deep.
- A literal `server.port` in `vite.config.*` beside that package.json. It also replaces vite's 5173 default for the scripts.

## What it detects

- Script runs: `npm run <script>`, `npm start`, `pnpm|yarn|bun run <script>` and the shorthands `pnpm dev`, `yarn dev`, `bun dev`. Builtins such as `pnpm install` and `yarn add` are left alone, as are scripts that start no server (`vite build`, `vitest`).
- Direct tools, also through `npx`, `bunx`, `pnpm exec` and `yarn dlx`: `vite`, `vite preview`, `next dev`, `next start`, `nest start`, `astro dev`, `remix dev`, `nuxt dev`, `python -m http.server [N]` (8000), `rails s` (3000), `php -S host:N`.
- Any other command with `--port N`, a `PORT=N` prefix, or `-p N` on a known server tool (`next`, `rails`, `http-server`, `serve`, `flask`, `hugo`, `live-server`, `json-server`). Clients such as `psql`, `curl`, `ssh`, `docker` and `kill-port` are left alone, and so is a `PORT=N` in front of a test runner (`playwright`, `jest`, `vitest`, `cypress`, `node --test` and the like) or of a script whose every command is a test runner, a build or a lint (`PORT=3000 npm run test:e2e` with `playwright test`, `next build`, `eslint .`). A script that serves with no port of its own (`node server.js`, `tsx watch src/index.ts`, `nodemon app.js`) still takes its port from `PORT=` or `-- --port` on the command line.
- A leading `cd dir &&` (several in a row too), a `( ... )` subshell, `npm --prefix dir`, `pnpm -C dir` and `yarn --cwd dir` move the folder whose package.json is read. Trailing redirects and `&` are kept when the command is rewritten.
- The line is split at `&&`, `||`, `;`, `|`, `|&`, newlines and a lone `&` that backgrounds a command, so `npm run dev > dev.log 2>&1 & sleep 5 && curl localhost:5173` moves the server part alone. Quoted text and heredoc bodies (`cat <<EOF ... EOF`) are never read as commands.

The effective port follows this order: a flag on the command line, then `PORT` (only for tools that read it: next, nest, remix dev, nuxt, rails, and unknown commands), then the script's own port, then vite.config or Nest's main.ts, then the framework default. A `PORT=` the script sets itself beats one set around the run.

## How a command is moved

- vite, next, astro, nuxt, rails and remix vite:dev get `--port N`, replacing a `--port` or `-p` already there. An `npm run` hands it on as `-- --port N`; pnpm, yarn and bun runs get `--port N`.
- nest start and remix dev get a `PORT=N` prefix. When `src/main.ts` listens on a literal port, the pane says PORT may not move it.
- `python -m http.server` gets its port argument, `php -S` its `host:N`, other commands their `--port` value or `PORT=N`.
- When neither is known to work (a script that sets `PORT=3000` itself, a script pulse-ports could not read), it sets both `PORT=N` and `--port N`, and the pane says so.

## Desktop previews

The desktop app's preview tool (`preview_start` with a configuration `name`) reaches Claude Code as an MCP tool call, so pulse-ports sees it. It reads `.claude/launch.json` in the session folder, finds that configuration's `port`, and holds it the same way. The first button reads **Edit launch.json to port 4100**: it sets `port`, changes the port in `url`, rewrites `runtimeExecutable` and `runtimeArgs` so the server listens there (`npm run dev -- --port 4100`, or `env PORT=4100 npm run start:dev` for PORT tools), writes the file and starts the preview, with a toast once it has started. `2` and `3` work as for a command.

## Limits

- Only the first server-starting part of a command line is read. `concurrently`, `npm-run-all`, `turbo` and docker compose are not looked inside.
- Shell variables (`--port $PORT`) and ports computed in config files are not resolved. A vite `server.port` nested past another object, and `preview.port`, are not read.
- `python manage.py runserver`, `jekyll serve` and other servers with no `--port` or `PORT=` are not recognised.
- `PORT=N` placed before `sudo` is dropped by sudo; pulse-ports does not move it after.
- Writing launch.json drops its comments and lays it out as two-space JSON.
- One hold at a time: a second server command waits until the first is answered.
- A `cd` from an earlier Bash call is invisible: the folder comes from the session's working folder plus any `cd` on the same command line, so a later bare `npm run dev` may read the wrong package.json.
- If working out the port throws (reading package.json or resolving a `cd` folder fails), the command runs unheld. Once a hold has started, a failure of the hook refuses the command and tells Claude why.
- A subagent's Bash calls are held too, and the pane opens in the main session.

## Check it

```
claude plugin validate .
claude plugin test .
```

The tests in `tests/ports.test.ts` cover the pure functions in `hooks/ports.ts`: port resolution order, package.json script parsing, framework defaults, `cd` following, rewrite output per tool and the reservation labels.
