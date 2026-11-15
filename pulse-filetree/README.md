# pulse-filetree

A Claude Code mod that adds a file tree pane to the right sidebar. It shows git status per file and folder, and it lights up the files Claude reads, writes and commits while it works.

- **Tree of the working folder**: folders first, natural sort. In the desktop app each file and folder shows a Lucide icon for its type, tinted in its language colour (blue for TypeScript, yellow for JavaScript) and its folder kind (green `src`, blue `docs`, teal `tests`, red `dist`). In the terminal each file shows a small coloured badge for its type (`TS`, `JS`, `{}`, `M↓`) and each folder a block in its colour; with a Nerd Font the Nerd Font icons show instead, in the same colours. Git-ignored files and folders fade. Indent guides show how deep each row sits, and the guide of the folder holding the cursor is drawn brighter. Long names are cut in the middle so the start and the extension stay readable. It follows the session cwd, or stays on a folder you pick with `/filetree <path>`.
- **Colours**: without an Omarchy theme file the pane uses your Claude Code theme colours, so it fits a light or a dark theme. With an Omarchy theme it uses that theme's colours.
- **Git status**: each file is coloured by its status, and modified files show `+N -N` lines changed. Folders keep the text colour, show a dot in their status colour, and show file counts such as `?1 A1 M2 D1`: `?` untracked, `A` staged as added (a new file you ran `git add` on), `M` modified, `D` deleted. A branch row shows the branch, upstream, ahead and behind. The repo totals (or "clean") sit beside the title in the desktop app and on the branch row in the terminal; hovering them shows a card that spells the letters out, such as "?1 untracked, M2 modified, D1 deleted".
- **When git cannot be read**: if `git rev-parse` or `git status` fails (git missing, a repo git refuses to read, a corrupt index), a dim line under the header says "git status unavailable:" and the cause, such as `git status exit 128, fatal: detected dubious ownership`. The letters in the tree are then the last ones read, and the line stays until a read works.
- **Claude activity**: files Claude reads or searches shimmer purple, files it writes shimmer orange, staged and committed files shimmer green. Closed folders open to show the file. After the shimmer, a mark stays in the gutter beside the file and fades out over about 90 seconds. Reads and writes differ by shape as well as colour: a read draws a thin bar (`▏`) and a write a thick one (`▌`). The cursor marker (`›`) always shows on the cursor row, and the touch mark gives way to it there.
- **Subagents**: a tool call a subagent or teammate makes reaches the mod with its agent id, and the mod checks that id against the session's agent list. Its touches then draw dashed gutter bars, thin dashed (`╎`) for a read and heavy dashed (`┇`) for a write, in lilac, so they stand apart from the main loop's solid bars; its writes shimmer lilac where the main loop's shimmer orange (its reads shimmer lilac like the main loop's, and the dashed bar tells them apart). A git or gh command it runs shows in the footer with "subagent" before its label, and the outside-folder list says "read by a subagent" or "written by a subagent". The engine's own forks (compaction, memory) and a workflow's agents also carry an agent id, which the agent list never names, so their touches count as the main loop's. A subagent's relative paths are read against the session's cwd.
- **Deleted files**: a file Claude deletes stays in the tree for 90 seconds as a faded, struck-through row, then fades out. The mod sees a deletion two ways: a Bash or PowerShell command that removes a path (`rm`, `unlink`, `rmdir`, `git rm`, `Remove-Item`) and the path is gone afterwards (for a background command, once its notification arrives), or a file git newly reports as deleted after one of Claude's commands and that is gone from disk (so `git rm --cached` keeps its row). Paths named by a glob (`rm *.log`) are left out. A file that comes back within the 90 seconds (written again, restored with git) drops its ghost and shows as itself. Right-click on the row still copies the old path, and the cursor marker stays on it.
- **Outside this folder**: files Claude reads or writes outside the tree's folder show in a group under the tree: paths from your home folder as `~/...`, a thin bar for a read and a thick one for a write (lilac and dashed for a subagent's), newest first, 20 at most. The terminal shows the five newest and counts the rest. "Clear list" empties it. Writes there are seen from Edit, Write, NotebookEdit and Bash removals; a Bash redirect such as `> /tmp/x` is left out, since the change scan only walks the tree's folder.
- **Git footer**: when Claude runs a `git` or `gh` command that changes something, the footer shows it as running, then done (with the short commit hash) or failed. A failed one says why after its label: the exit code and the first line of stderr (`push failed: exit 128, fatal: could not read Username`), the exit code from a background task's notification, or "HEAD stayed on the same commit" for a commit that changed nothing. Every running command shows, up to three, then "+N more".
- **Search**: the search field filters the tree by path, including folders you have not opened yet. It reveals at most 60 hits. Inside a git repo the search list comes from `git ls-files`, so files your `.gitignore` ignores are left out of search; outside a repo `find` lists files six levels deep and skips `.git`, `node_modules`, `target`, `.venv`, `__pycache__`, `dist` and `.next`. If the list cannot be built, the tree says "Search unavailable:" and the cause in place of "No files match".
- **Selection as context**: the file you select is named to Claude with each prompt, and the footer says so: "selected: src/a.ts, sent with your prompts". `@path` mentions in a prompt reveal that file in the tree.
- **Sizes and dates**: the right column shows the modified date, the age or the size, lined up down the tree. Dates read like `Oct 12 09:30`, with the year in place of the time for older years. Narrow panes show a shorter date, and a row with too little room for its name drops the date. Folder sizes are worked out in the background for the rows on screen.
- **Empty states**: the tree says "Loading files…", "Searching…", "No files match", "Search unavailable: <cause>", "This folder is empty", "Only dotfiles here" or "Could not read this folder" when there are no rows to show.
- **Row cap**: one drawing of the tree holds about 70,000 characters of elements, which is roughly 60 to 80 rows (fewer while names shimmer), and never more than 1,500 rows. The desktop app draws every open row, so a large expanded tree reaches that limit there first. Past it a last row says how many more rows there are and suggests collapsing folders or searching.
- **Toasts** all start with "File tree:", such as "File tree: copied src/a.ts".
- **Errors say why**: every failure names its cause. A copy that does not reach the clipboard says which of the three reasons Claude Code gave (no screen attached, no clipboard tool took the text, a plugin refused it). Opening a file names the program and its exit code and first stderr line, or the error it threw; Quick Look names the error too.

## Slash command

`/filetree help` lists the keys, the mouse actions, what the selection does and the settings (as "Settings (/config, pulse-filetree):", one line per setting with its title and key); it opens nothing and works in any layout. To open a folder named `help`, run `/filetree ./help`.

`/filetree [path]` opens the pane and focuses it. Without a path it shows the cwd and follows it. With a path (relative, absolute or `~/...`) it shows that folder and stops following the cwd. The path is checked first: when nothing is there it replies "No folder at <path>" and opens nothing, when the path cannot be read it replies "Could not read <path>:" with the error (a denied folder, say), and when it names a file it replies that it is a file, opens the file's folder and puts the cursor on the file. In the terminal it needs the fullscreen layout (`/tui fullscreen`) and at least 110 columns; it replies with what to fix when either is missing.

## In the pane

- **Click** a row: select a file, or open and close a folder. **Double-click** a file: open it (see "Open with"). **Double-click** a folder: show that folder as the tree root. **Ctrl-click** or **Shift-click** opens at once.
- **Right-click** a row copies its path relative to the root. **Shift+right-click** copies the absolute path.
- **Wheel** scrolls the tree. The scrollbar on the right edge can be clicked or dragged.
- **Keys** (after a click in the tree gives it the keys): `Up`/`k` and `Down`/`j` move, `PageUp`/`PageDown` move 10 rows, `Home`/`End` jump to the ends. `Right`/`l` opens a folder, `Left`/`h` closes it or moves to the parent. `Enter` opens a file or toggles a folder. `Space` shows a file in Quick Look on macOS (on a folder, or on other systems, it acts like a click). `y` copies the relative path, `Y` the absolute path. `.` shows or hides dotfiles. `s` cycles the right column through date, age and size. `c` collapses every folder. `r` reloads the tree and git. `u` or `Backspace` goes up to the parent folder. `/` moves to the search field.
- **Search field**: typing filters the tree. `Enter` ("jump") opens the folders of the first 10 hits, moves the cursor to the first one and clears the field. "Clear search" clears it ("clear search" in the terminal too). `Escape` leaves the field the way every Claude Code field does; click a row to give the tree its keys again (a plugin can move the focus only onto a button, field or select, and the tree is none of these).
- **Buttons** say what they do, and hovering one shows a short hint that names the key for the same action, such as "reload tree and git (r)". In the desktop app, "Go up" and "Reload" sit beside the search field. The next row has "Hide dotfiles" or "Show dotfiles", "Show sizes" (or "Show dates" or "Show ages" while sizes show) and "Collapse all". "Follow cwd" shows only while the tree is not following the cwd. "Clear selection" sits in the footer beside "selected:". In the terminal the same buttons use short words on one row that wraps: go up, reload, show dotfiles, show sizes, collapse, follow cwd, and clear selection in the footer.
- **Preview** (with "Open with" set to `preview`): Markdown is rendered and code is highlighted. Arrow keys, `j`/`k`, Page keys, `Home`/`End` and the wheel scroll it. `Left`/`h` or "Close preview" goes back, and "Open in default app" opens the file in the default app. In the terminal these buttons read `← files` and `↗ open`. Files over 4 MB and binary files show a note instead.

## Settings

All settings are in `/config` under this plugin.

| Setting | Default | Options | Meaning |
| --- | --- | --- | --- |
| `activity` | `reads and writes` | `reads and writes`, `writes`, `reads`, `none` | Which Claude activity shimmers in the tree. |
| `glyphs` | `auto` | `auto`, `nerd`, `plain` | `auto` uses Nerd Font icons when one is found (always over SSH), Lucide icons in the desktop app, and coloured type badges and folders in a terminal without a Nerd Font. `nerd` uses Nerd Font icons in the terminal and Lucide icons in the desktop app. `plain` always uses the badges. |
| `follow` | `on` | `on`, `off` | `on` scrolls the tree to what Claude touches. `off` keeps your scroll position; highlights still show. |
| `start` | `on` | `on`, `off` | `on` opens the pane when a session starts. In the terminal the pane keeps to what `/filetree` asks for: under 110 columns, or outside the fullscreen layout, it closes and a toast says which, and `/filetree` opens it once the terminal is ready. `off` waits for `/filetree`. |
| `column` | `date` | `date`, `age`, `size` | What the right column shows at start. The sizes button switches between size and date or age; `s` in the tree cycles all three. |
| `hints` | `on` | `on`, `off` | Shows a line outside a git repo: "Git status starts after git init". |
| `open` | empty | free text | Empty opens files in the default app. `preview` shows them in the pane. Any other text is a command run without a shell, with `{path}` and `{dir}` filled in (the path goes last when `{path}` is missing). |

## What it touches

- **Events hooked**: `session.start`, `command.run` (for `/filetree`), `tool.call` (after Edit, Write, NotebookEdit, Bash, PowerShell, Read, Grep and Glob finish), `prompt.submit`, `prompt.attachment`, `ui.render`, `ui.message`, `ui.focus` and `ui.scroll` for its own pane, and the classic `SessionStart`, `CwdChanged` and `FileChanged` events. Tool calls run as usual; the mod reads their input and result afterwards.
- **Tools registered**: none. It registers one slash command, `/filetree`.
- **Agent list**: `$.agent.list()` once for each new agent id a tool call carries, to tell a subagent or teammate from the engine's own forks.
- **Prompt change**: when a file is selected and still exists, each prompt gets one extra context line naming its full path and saying "this" or "it" likely refers to it. Nothing else is added.
- **Watched files**: on `SessionStart` it asks Claude Code to watch the repo's `.git/index` and `.git/HEAD`, and reloads the tree when they change.
- **Files read**: directory listings and file stats under the tree root, the file shown in preview, a `.git` file when looking for the git folder, and `~/.local/state/omarchy/current/theme/colors.toml` for Omarchy theme colours (polled every 2 seconds while it exists).
- **Files written**: on macOS, before a shell command that may write, it creates an empty marker file `$TMPDIR/filetree-<session id>-<n>.mark` with `touch` and deletes it with `rm -f` after the scan. Its own tree, theme and activity state goes to Claude Code's plugin state store.
- **Timers**: the theme poll above, a redraw once a minute while the column shows ages, one timer that ends each shimmer, one timer that redraws when a gutter mark fades or ends (30 and 90 seconds after the touch), one that redraws when a deleted file's ghost row ends (90 seconds after the deletion), one that clears finished git footer entries after 45 seconds, and short delays before reloading after a `cd` or a `.git` change. They only redraw, reload or tidy the pane.
- **Clipboard**: copies a path when you right-click or press `y`/`Y`.
- **Memory only**: the "Outside this folder" list and the deleted files' ghost rows live in the mod's memory for the session; nothing about them is written to disk.
- **Environment read**: `OS`, `HOME`, `USERPROFILE`, `TMPDIR`, `SSH_CONNECTION`, `SSH_TTY`, `HERDR_ENV`, `HERDR_BIN_PATH`.
- **Processes it runs**:
  - `git --no-optional-locks -C <root>` with `rev-parse`, `status`, `diff HEAD --numstat`, `diff --cached --name-only`, `diff-tree`, `ls-files`. These only read the repo.
  - `find` to list files changed since a shell command started and to build the search list outside a repo; `du -skxH` for folder sizes.
  - `uname -s` once, and a `sh -c` font check that uses `fc-list`, `ls`, `stat`, `ps`, `date` and `awk`. `herdr --version` only inside herdr.
  - Opening a file: `open` on macOS, `gio`, `xdg-open`, `xdg-mime` and `file` through `sh` and `setsid` on Linux, `powershell` on Windows, or your "Open with" command. `Space` on macOS runs `qlmanage -p` and an `osascript` call that brings Quick Look to the front.
- **Network**: the mod makes no network requests. It reads the `git` and `gh` commands Claude runs to label them, and runs none of them itself.

## Install

```
claude plugin marketplace add MrValraven/pulse-mods
claude plugin install pulse-filetree@pulse-mods --scope user
```

Then start a new Claude Code session.

## Credits

Based on [data-goblin/claude-code-filetree](https://github.com/data-goblin/claude-code-filetree) by Kurt Buhler, MIT licence. See `LICENSE`.

The file and folder icons in the desktop app are [Lucide](https://lucide.dev) icons, ISC licence. See `LICENSE-lucide`.
