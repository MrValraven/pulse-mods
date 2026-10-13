# pulse-filetree

A Claude Code mod that adds a file tree pane to the right sidebar. It shows git status per file and folder, and it lights up the files Claude reads, writes and commits while it works.

- **Tree of the working folder**: folders first, natural sort. Each file shows a small coloured badge for its type (`TS`, `JS`, `{}`, `M↓`) and each folder a block in a colour for its kind (green `src`, blue `docs`, teal `tests`, red `dist`). With a Nerd Font in the terminal the Nerd Font icons show instead, in the same colours. Git-ignored files and folders fade. Indent guides show how deep each row sits, and the guide of the folder holding the cursor is drawn brighter. Long names are cut in the middle so the start and the extension stay readable. It follows the session cwd, or stays on a folder you pick with `/filetree <path>`.
- **Colours**: without an Omarchy theme file the pane uses your Claude Code theme colours, so it fits a light or a dark theme. With an Omarchy theme it uses that theme's colours.
- **Git status**: each file is coloured by its status, and modified files show `+N -N` lines changed. Folders keep the text colour, show a dot in their status colour, and show file counts such as `?1 M2 D1`. A branch row shows the branch, upstream, ahead and behind. The repo totals (or "clean") sit beside the title in the desktop app and on the branch row in the terminal.
- **Claude activity**: files Claude reads or searches shimmer purple, files it writes shimmer orange, staged and committed files shimmer green. Closed folders open to show the file. After the shimmer, a mark stays in the gutter beside the file and fades out over about 90 seconds.
- **Git footer**: when Claude runs a `git` or `gh` command that changes something, the footer shows it as running, then done (with the short commit hash) or failed.
- **Search**: the search field filters the tree by path, including folders you have not opened yet.
- **Selection as context**: the file you select is named to Claude with each prompt, and `@path` mentions in a prompt reveal that file in the tree.
- **Sizes and dates**: the right column shows the modified date, the age or the size, lined up down the tree. Dates read like `Oct 12 09:30`, with the year in place of the time for older years. Narrow panes show a shorter date, and a row with too little room for its name drops the date. Folder sizes are worked out in the background for the rows on screen.
- **Empty states**: the tree says "Loading files…", "Searching…", "No files match", "This folder is empty", "Only dotfiles here" or "Could not read this folder" when there are no rows to show.

## Slash command

`/filetree [path]` opens the pane and focuses it. Without a path it shows the cwd and follows it. With a path (relative, absolute or `~/...`) it shows that folder and stops following the cwd. In the terminal it needs the fullscreen layout (`/tui fullscreen`) and at least 110 columns; it replies with what to fix when either is missing.

## In the pane

- **Click** a row: select a file, or open and close a folder. **Double-click** a file: open it (see "Open with"). **Double-click** a folder: show that folder as the tree root. **Ctrl-click** or **Shift-click** opens at once.
- **Right-click** a row copies its path relative to the root. **Shift+right-click** copies the absolute path.
- **Wheel** scrolls the tree. The scrollbar on the right edge can be clicked or dragged.
- **Keys**: `Up`/`k` and `Down`/`j` move, `PageUp`/`PageDown` move 10 rows, `Home`/`End` jump to the ends. `Right`/`l` opens a folder, `Left`/`h` closes it or moves to the parent. `Enter` opens a file or toggles a folder. `Space` shows a file in Quick Look on macOS (on a folder, or on other systems, it acts like a click). `y` copies the relative path, `Y` the absolute path.
- **Search field**: typing filters the tree. `Enter` ("jump") opens the folders of the first 10 hits, moves the cursor to the first one and clears the field. "Clear search" clears it ("clear" in the terminal).
- **Buttons** say what they do, and hovering one shows a short hint. In the desktop app, "Go up" and "Reload" sit beside the search field. The next row has "Hide dotfiles" or "Show dotfiles", "Show sizes" (or "Show dates" or "Show ages" while sizes show) and "Collapse all". "Follow cwd" shows only while the tree is not following the cwd. "Clear selection" sits in the footer beside "selected:". In the terminal the same buttons use short words on one row that wraps: go up, reload, show dotfiles, show sizes, collapse, follow cwd, and unselect in the footer.
- **Preview** (with "Open with" set to `preview`): Markdown is rendered and code is highlighted. Arrow keys, `j`/`k`, Page keys, `Home`/`End` and the wheel scroll it. `Left`/`h` or "Close preview" goes back, and "Open in default app" opens the file in the default app. In the terminal these buttons read `← files` and `↗ open`. Files over 4 MB and binary files show a note instead.

## Settings

All settings are in `/config` under this plugin.

| Setting | Default | Options | Meaning |
| --- | --- | --- | --- |
| `activity` | `reads and writes` | `reads and writes`, `writes`, `reads`, `none` | Which Claude activity shimmers in the tree. |
| `glyphs` | `auto` | `auto`, `nerd`, `plain` | `auto` uses Nerd Font icons when one is found (always over SSH), and coloured type badges and folders in the desktop app or without a Nerd Font. `nerd` always uses Nerd Font icons. `plain` always uses the badges. |
| `follow` | `on` | `on`, `off` | `on` scrolls the tree to what Claude touches. `off` keeps your scroll position; highlights still show. |
| `start` | `on` | `on`, `off` | `on` opens the pane when a session starts. `off` waits for `/filetree`. |
| `column` | `date` | `date`, `age`, `size` | What the right column shows at start. The sizes button switches between size and date or age. |
| `hints` | `on` | `on`, `off` | Shows a line outside a git repo: "Git status starts after git init". |
| `open` | empty | free text | Empty opens files in the default app. `preview` shows them in the pane. Any other text is a command run without a shell, with `{path}` and `{dir}` filled in (the path goes last when `{path}` is missing). |

## What it touches

- **Events hooked**: `session.start`, `command.run` (for `/filetree`), `tool.call` (after Edit, Write, NotebookEdit, Bash, PowerShell, Read, Grep and Glob finish), `prompt.submit`, `prompt.attachment`, `ui.render`, `ui.message`, `ui.focus` and `ui.scroll` for its own pane, and the classic `SessionStart`, `CwdChanged` and `FileChanged` events. Tool calls run as usual; the mod reads their input and result afterwards.
- **Tools registered**: none. It registers one slash command, `/filetree`.
- **Prompt change**: when a file is selected and still exists, each prompt gets one extra context line naming its full path and saying "this" or "it" likely refers to it. Nothing else is added.
- **Watched files**: on `SessionStart` it asks Claude Code to watch the repo's `.git/index` and `.git/HEAD`, and reloads the tree when they change.
- **Files read**: directory listings and file stats under the tree root, the file shown in preview, a `.git` file when looking for the git folder, and `~/.local/state/omarchy/current/theme/colors.toml` for Omarchy theme colours (polled every 2 seconds while it exists).
- **Files written**: on macOS, before a shell command that may write, it creates an empty marker file `$TMPDIR/filetree-<session id>-<n>.mark` with `touch` and deletes it with `rm -f` after the scan. Its own tree, theme and activity state goes to Claude Code's plugin state store.
- **Timers**: the theme poll above, a redraw once a minute while the column shows ages, one timer that ends each shimmer, one timer that redraws when a gutter mark fades or ends (30 and 90 seconds after the touch), one that clears finished git footer entries after 45 seconds, and short delays before reloading after a `cd` or a `.git` change. They only redraw, reload or tidy the pane.
- **Clipboard**: copies a path when you right-click or press `y`/`Y`.
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
