# pulse-blast-radius

A Claude Code mod that holds a risky shell command and shows you what it would change before it runs. When Claude calls Bash with something destructive, the call waits in a pane until you press **Run command** or **Cancel command**. Claude sees a refusal with its reason.

Based on anthropics/claude-code-playground blast-radius (Apache-2.0). See `LICENSE` and `NOTICE`.

## Install

```
claude plugin marketplace add MrValraven/pulse-mods
claude plugin install pulse-blast-radius@pulse-mods --scope user
```

Then start a new Claude Code session.

## What it holds

Blast Radius reads the whole command line, every part of it, and measures each risky part with read-only commands (list, stat, `du`, `git status`, `git diff`). Run `/blast-radius help` in a session for the same list.

**Files**

| Command | What the pane shows |
|---|---|
| `rm` (with or without flags), `rmdir`, `unlink` | The files it would delete, with the count and total size. Globs and `~` are expanded. |
| `shred` | The files it would overwrite, and delete with `-u`. |
| `find ... -delete`, `find ... -exec rm` | What `find` matches, from a dry run with the same arguments and `-print`. A `find` that also runs another `-exec` or writes with `-fprint` is held without a dry run. |
| `xargs rm` | Held, unmeasured: the paths arrive on xargs input. |
| `> file` (also `>|`, `&>`, `>&file`) | Held when the file exists and holds data: its current size. A new or empty file runs without a hold, unless an earlier part of the line changes files (see Nothing to discard). `>>` appends and is never held. |
| `mv` | Held when it would replace an existing path: the paths it would replace. Also held after an earlier part that changes files. `mv -n` is never held. |
| `dd of=` | What it would write over: a file and its size, or a device. |
| `mkfs`, `mke2fs`, `newfs`, `wipefs` | Held, unmeasured. |
| `chmod -R`, `chown -R`, `chgrp -R` | How many files it would change. |

**Git**

| Command | What the pane shows |
|---|---|
| `reset --hard`, `checkout -- <path>`, `checkout <ref> -- <path>`, `checkout .`, `checkout -f`, `switch -f` / `--discard-changes`, `restore <path>` | The files with uncommitted changes it would discard, from `git status --porcelain`, and `git diff --shortstat`. A reset to another commit also lists the commits it leaves behind; a form that takes files from another commit lists untracked files it may write over. |
| `checkout <name>` | Measured to tell a branch from a path: a branch switch runs without a hold, a path is treated as `checkout -- <path>`. |
| `clean` | The untracked paths it would remove, from `git clean -n` with the same flags. |
| `push --force` (also `-f`, `--force-with-lease`, `+ref`) | The commits on the remote branch that your HEAD doesn't have, which the push would drop. |
| `push --delete`, `push origin :branch` | The remote branch, and its commits that no local branch has. |
| `push --mirror`, `push --prune` | Held, unmeasured. |
| `branch -D`, `branch -d --force` | The commits on that branch and on no other branch or remote. |
| `stash drop`, `stash clear` | The stash it would delete and its files, or every stash. |
| `reflog expire`, `gc --prune`, `prune` | The reflog entries or loose objects there are now. |
| `filter-branch`, `filter-repo` | Held, unmeasured. |
| `update-ref -d` | The commit the ref points to now. |

**Databases**

| Command | What the pane shows |
|---|---|
| `manage.py migrate`, `db:migrate`, `alembic upgrade`, `prisma migrate` | With `measureMigrations` on, the pending migrations from the tool's own status command. With it off (the default), a line saying they are not listed and why. |
| any other `migrate` | A note that it can't list the pending migrations for that tool. |
| `prisma migrate reset`, `prisma db push --force-reset` / `--accept-data-loss` | Held, unmeasured. |
| `rails db:drop`, `db:reset`, `db:schema:load` (and `db:purge`, `db:truncate_all`, `db:migrate:reset`, `db:structure:load`) | Held, unmeasured. |
| `alembic downgrade`, `manage.py flush`, `manage.py reset_db` | Held, unmeasured. |
| SQL `DROP`, `TRUNCATE`, `DELETE FROM` in `psql -c`, `mysql -e`, `sqlite3`, piped into one of them, or in a here-document fed to one | Held, unmeasured: Blast Radius does not connect to databases. |

**Infrastructure**

| Command | What the pane shows |
|---|---|
| `docker system prune`, `docker volume prune`, `docker container prune` | What `docker system df`, the unused volumes or the stopped containers list. |
| `docker rm`, `docker volume rm` | The containers or volumes named, from `docker inspect`. |
| `docker compose down -v` | Held, unmeasured. |
| `kubectl delete` (and `oc delete`) | The resources `kubectl get` lists for the same names and selectors. |
| `terraform destroy` (and `tofu destroy`, `apply -destroy`) | The resources in the state, from `terraform state list`. |

**Wrappers it reads through**

- `bash -c`, `sh -c`, `zsh -c "<inner>"`, `su -c` and `eval`: the inner string is read as a command line of its own.
- `$( )`, backticks, `<( )` and here-documents: the commands inside are read too.
- `sudo`, `doas`, `env` (`-i`, `-C dir`, `-S`), `timeout N`, `time -p`, `nice`, `nohup`, `stdbuf`, `ionice`, `setsid`, `command`, `exec` and `xargs`: the command they run is read.
- `( ... )` subshells and `name() { ... }` functions: the commands inside are read.
- The command `ssh host`, `docker exec <container>` and `kubectl exec <pod> --` run elsewhere, quoted or not (`ssh host 'rm -rf /data'`, `ssh host -t 'rm -rf x'`, `docker exec c sh -c 'rm -rf /x'`), and a quoted argument of any other program that reads as a risky command (`ssh host "git reset --hard"`, `python3 -c 'os.system("rm -rf x")'`): held and marked not measured, since it may run in a container or on another host.
- awk and sed programs: the strings an awk program could run (`system("...")`, `"cmd" | getline`, `print | "cmd"`) and sed's `e` command are read as commands; sed's `s///e` flag is held as unreadable.
- A shell that reads commands on its input (`curl ... | sh`, `cat script | bash`, `bash -s`) is held as unreadable, and so is a command whose name is an expansion (`$CMD -rf x`, `$PYTHON script.py`, `"$(which rm)" x`, `eval "$(...)"`). When the expansion is only a leading folder inside double quotes (`"$HOME/.venv/bin/python"`, `"$(npm bin)/eslint"`), the command is read by its literal name; unquoted (`$(npm bin)/eslint`, `$X/ls`) the shell can split it into other words, so it is held.

Every other command runs as normal. If the command line moves first, with `cd dir &&`, `pushd`/`popd`, `env -C dir` or `git -C dir`, Blast Radius measures in that folder. A `cd` inside `( ... )` only applies inside the parentheses, as in the shell.

## Reading the command line

The command is split on `;`, `&&`, `||`, `|`, `&` and newlines only outside single quotes, double quotes and backslash escapes, so `git commit -m "fix; rm -rf x"` and `echo "a && b"` run without a hold. Quoted arguments of programs that print, search or send text (`echo`, `printf`, `grep`, `rg`, `jq`, `curl`, `gh`, and `git commit`, `tag`, `log`, `stash` and `merge` messages) are read as text. Comments (a `#` that starts a word) are skipped; a `#` right after `(` is part of the command, as in zsh's `(#i)` glob flag. If a quote never closes, the line is also read the old way with every quote ignored, and anything risky found there is held.

## The pane

- **Held** and the labels of what is held, then **Would** with what it would do.
- **Run command** (hotkey `1`) and **Cancel command** (hotkey `2`). They come before the long lists, so a short terminal still shows them; the rest scrolls.
- **Command**: the whole command line, wrapped onto as many rows as it needs.
- Every part of the command line with its status: `held` or `safe`, and under each risky part `at stake` with what it found, `not measured` with the reason, or `safe` with why (for example a `> file` whose file doesn't exist yet).

Cancel command has the focus when the pane opens, so Enter refuses the command. The pane draws in the pulse palette: coral for what is held, jade for what is safe, lilac for labels.

When a command line has more than 12 risky parts, the first 12 are measured and the rest are marked not measured, with that reason.

## Nothing to discard

`git reset --hard`, and the checkout, switch and restore forms above, run without a hold when they would discard nothing: no uncommitted changes in scope (read with `git status --untracked-files=all`, whatever the repo's `status.showUntrackedFiles` says), no untracked or ignored file on disk that a form taking files from another commit would write over (the files that commit has and HEAD lacks), and no commits a reset would leave behind. A toast says `Blast Radius: nothing to discard, ran <command>` and the decision log records it as `auto`.

This only applies when everything before it on the line changes no files (`cd`, `ls`, `mkdir`, `touch`, `git status`, `git log`, `git diff` and the like), and nothing that runs beside it does: the other commands of its pipeline (`|`) or background job (`&`), and anything inside its own command, such as `$( )` or `<( )`. `git fetch` and `git branch` count as changes, since they move the refs a reset is measured against. Otherwise the command is held, since the earlier parts could create changes first.

A bare `git checkout <name>` that names a branch runs without a hold, unless a command before it or beside it may edit refs: `git branch -m/-M/-d/-D`, `git tag -d`, `git update-ref`, `git symbolic-ref`, `git fetch --prune` or `git pull --prune`, `git remote remove/rename/prune`, `git push --delete` or `git push . :name`, a `git config` that writes, a git command that runs one of yours (`rebase --exec`, `bisect run`, `submodule foreach`, `difftool --extcmd`), any git subcommand that is not one of git's own (an alias such as `git rb`, or a `git-foo` extension, can do anything), or any other non-git command that changes files (a script like `./rename-branch.sh`). After `git branch -m foo foo2`, `git checkout foo` would restore the file foo and drop its edits. Git's own commands that leave branch names alone, such as `git stash`, `git fetch`, `git add` and `git commit`, keep the exemption.

The same rule applies to the conditional holds (`> file`, `mv`): "nothing there to replace" only lets the command run when nothing before it or beside it changes files, so `mv a.txt b.txt && mv c.txt b.txt` is held.

## Keys and the band

- In the pane, press `1` to run the command or `2` to cancel it. Tab moves between the buttons, and a click presses one.
- In a narrow terminal the report is drawn in the band above the prompt. The band can't take the keys by itself, so Blast Radius also shows a toast and sends a notification saying a command is held: click the band or press `ctrl+x tab`, then `1` or `2`.
- If nobody answers within 10 minutes, the command is refused and a toast says `Blast Radius refused <label> after 10 minutes without an answer`.
- If you interrupt the turn (Esc), the command is refused.
- After Cancel command, a toast says `Blast Radius cancelled <label>; the command did not run`.

## Commands

| Command | What it does |
|---|---|
| `/blast-radius` | The last 50 holds, newest first: when, the decision (`proceed`, `cancel`, `timeout`, `auto`, `interrupted` or `error`), the label and the command. |
| `/blast-radius help` | The patterns it holds, the settings and the keys. |

The log is kept with the mod's own store (`$.store`), on this machine, across sessions.

## Settings

Set in `/config` under pulse-blast-radius, where it is titled Measure migrations.

| Setting | Values | What it does |
|---|---|---|
| `measureMigrations` | `off` (default), `on` | Off: a held migration says its pending migrations are not listed, because listing them runs your project's code, and names this setting. On: Blast Radius runs the tool's status command (`python3 manage.py showmigrations --plan`, `bin/rails db:migrate:status`, `alembic history -r current:head`, `npx --no-install prisma migrate status`) before you answer and lists what is pending. If that command fails, the pane names its exit code and the first line of its error output, or the time limit it ran past. |

## Requirements

- Claude Code 2.1.287 or later, where mods load by default.
- `bash`, `git`, `find`, `du` and `awk` on your `PATH`. For the infrastructure measures, the tool itself (`docker`, `kubectl`, `terraform`); without it the pane says the measure failed and why, and still holds the command.
- For the side pane, a terminal about 110 columns wide or more in fullscreen. Narrower terminals get the band above the prompt.

## Notes and limitations

- It reads the command text and does not run a shell to parse it: aliases, functions defined earlier in the session, and scripts that call `rm` are not seen. A word written with `$'...'` is decoded the way bash does (`$'\x72m'` reads as `rm`), so its escapes can't hide a command. A git subcommand that is not one of git's own may be an alias, so a `migrate` argument to it is held like any other command's.
- A path or name that uses a shell variable or command output (`rm -rf "$DIR"`) can't be measured, so it is held and marked not measured. A `> "$FILE"` or `mv` with variables is held the same way, and so is anything after a `cd` into a folder named that way (`cd $HOME/proj`, `cd "$(git rev-parse --show-toplevel)"`, `cd ~other`). A folder that does not exist yet holds nothing a `> file` or `mv` could replace, as long as every link from the `cd` to that part is `&&`; after `cd missing; mv a b` or `cd missing || echo > notes.txt` the cd fails and the part runs in the folder before it, so it is held. A folder that exists but can't be entered is held.
- In the band above the prompt, mods stack their bands in hook order. A guard band like this one hides the bands below it while a command is held, and bands drawn above it can push its buttons out of view. That is why it also sends a toast and a notification saying a command is held; if the buttons are out of view, use a wider terminal or turn off a mod that draws above it, or the command is refused after 10 minutes.
- One command is held at a time. A second risky call, from a subagent for example, waits until the first is answered.
- It only watches the Bash tool. File edits and other tools aren't held.
- The `rm` count is approximate: a path matched twice is counted twice, and a file name with a line break is not counted. Sizes come from `du -k`, so a size is the space on disk to the nearest kilobyte.
- The force-push and push-delete lists use your last fetch of the remote branch. Without one, the pane says it can't list the commits.
- It holds a call and does not sandbox it: after Run command, the command runs as written. Use [permission rules](https://code.claude.com/docs/en/settings) for a hard block.

## Tests

`tests/blast-radius.test.mjs` covers the splitter, the classifier (every pattern above, the quote cases and the wrappers) and the nothing-to-discard verdict, in `node:test` style:

```bash
node --test pulse-blast-radius/tests/
```

## Files

| File | What it holds |
|---|---|
| `hooks/blast-radius.mjs` | The hooks module: the hold, the measures, the pane, the decision log and `/blast-radius`. |
| `hooks/classify.mjs` | What counts as risky, and the hold verdicts. Pure functions. |
| `hooks/split.mjs` | The quote-aware splitter and tokenizer. Pure functions. |
| `tests/blast-radius.test.mjs` | The tests. |

## Third-party notices

Git is a trademark of Software Freedom Conservancy. Python is a registered trademark of the Python Software Foundation. npm is a trademark of npm, Inc. Django is a registered trademark of the Django Software Foundation. Rails and Ruby on Rails are trademarks of David Heinemeier Hansson. Prisma is a trademark of Prisma Data, Inc. Docker is a trademark of Docker, Inc. Kubernetes is a registered trademark of the Linux Foundation. Terraform is a trademark of HashiCorp, Inc. Alembic is an open-source project of the SQLAlchemy authors. Use of these names here is descriptive and implies no endorsement.
