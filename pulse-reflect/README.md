# pulse-reflect

A Claude Code mod that notices when you correct Claude or state a standing preference, and offers to save it as a rule in CLAUDE.md. It is a rewrite of claude-reflect as a mod: a small model checks each short prompt, and a band above the prompt saves the rule with one press.

- **Checks as you type**: each short prompt you send goes to a small model (Haiku by default), which decides whether it holds a reusable rule. Any language works. The rule comes back as one line in English.
- **Band above the prompt**: found rules wait there until you save, reword or discard them.
- **`remember:` shortcut**: start a prompt with `remember:` and the text after it becomes a rule at once, with no model call.
- **Repeats are merged**: saying the same thing again raises a count (`×2`, `×3`) on the existing rule.
- **Shared between sessions**: learnings live in the mod's store, so another open session shows the same band.

## How a learning is found

A prompt is checked only when all of these hold:

- You sent it: typed in the terminal or sent through Remote Control. Prompts from any other origin are skipped.
- It does not start with `/`.
- It is more than an acknowledgement. Words like `yes`, `ok`, `go on`, `continue`, `thanks`, `lgtm`, their Russian equivalents, and bare numbers up to three digits are skipped.
- It is at most 500 characters. Longer prompts are skipped, unless they start with `remember:`.
- It looks free of secrets. Prompts with API key prefixes (`sk-`, `ghp_`, `xoxb-`, `AKIA`, `AIza` and similar), JWTs, long tokens of mixed letters and digits, `password:` or `token =` style pairs, or a private key header are skipped.
- The check is on (see `/reflect-pause`).

At most 20 prompts wait in the queue. They run one at a time on a timer after the prompt is sent, so your prompt is never held up.

For each prompt, the model gets your message, the last 1200 characters of Claude's previous reply (for context), and the project directory path. It answers with JSON: whether it is a rule, the rule, a scope (`global` or `project`) and a confidence. Rules below 0.7 confidence are dropped. Every rule, from the model or from `remember:`, must be one line of at most 200 characters, with no control characters, no `<!--` or `-->`, and nothing that looks like a secret. A `remember:` rule is global, unless it is a rule you reworded with **Edit rule** (see below).

Two rules count as the same when they share at least 60% of their ordered word pairs. A new rule that matches a bullet already in the target CLAUDE.md is recorded as saved and never shows in the band.

## The band

The band shows waiting rules for this project plus global ones, most repeated first. The rule on top stays there until you decide on it, so a rule found later never slides in under your press.

In the desktop app, the band shows one rule at a time as a card. The card reads `Learned rule`, then `said twice` or `said N times` when you said it more than once. On the right it reads `N more waiting` when other rules wait behind it, or just `+N` when the band is narrow. The rule follows in quotes, wrapped to the band's width and never cut. The buttons sit below the card. A new card eases in when it first shows, and stays still when your system asks for reduced motion.

In the terminal, each row reads `reflect · "<rule>"` with `×N` when said more than once, and its buttons sit below it. The band shows two rules when both fit in its rows, and one otherwise. When more wait, a dim line reads `reflect · N more waiting · /reflect-queue lists them`.

Both show the same four buttons in the same order. The save the check suggests is the primary button. In the terminal, Edit rule and Discard rule are dimmed.

- **Save to this repo**: writes it to `./CLAUDE.md`.
- **Save globally**: writes it to `~/.claude/CLAUDE.md`.
- **Edit rule**: puts `remember: <rule>` in the prompt box so you can reword it, and marks the original skipped. The prompt box must be empty first. Sending the reworded rule within 30 minutes brings it back with the original's scope, as long as it still shares at least 30% of its word pairs with the original. Otherwise it comes back global. Only the next `remember:` prompt can carry the scope over.
- **Discard rule**: marks it skipped. It stays out of the band.

If another session already saved or discarded the rule, pressing a Save button writes nothing. The band refreshes and a toast says the rule was already handled.

The band steps aside while Claude Code shows a survey.

## Commands

- `/reflect-queue` (no arguments): lists up to 40 learnings for this project and global ones, waiting ones first, with state, count, scope and rule.
- `/reflect-pause` (no arguments): turns the check off or back on. Pausing also empties the queue.

## Where rules are saved

Global rules go to `~/.claude/CLAUDE.md` (from `$HOME`). Project rules go to `CLAUDE.md` in the session's root folder. The mod writes inside a marked section:

```
<!-- claude-reflect: learned rules (saved from the band; edit freely) -->
## Learned rules
- <rule>
<!-- end claude-reflect -->
```

If the file has no markers, the section is added at the end (the file is created if missing). If it has them once each and in order, the new bullet goes just above the end marker. If the markers are broken (only one, repeated, or out of order), nothing is written and a toast says so. If any bullet in the file already matches the rule closely (80% of word pairs), the file stays as it is and the toast says `already in`. The file is read again just before each write, and saves in one session run one after another.

## What it touches

- **Events**: `session.start`, `prompt.submit`, `turn.complete` (main session only), `prompt.compose`, `command.run` and `ui.render` for the `AbovePrompt` area.
- **Tools**: none. It registers no tools the model can call.
- **Commands**: `/reflect-queue` and `/reflect-pause`.
- **Model calls**: one `$.model.complete` per checked prompt, with `haiku`, at most 300 output tokens and a 30 second timeout. `remember:` prompts make no call. A failed call drops that prompt only.
- **Files read**: `~/.claude/CLAUDE.md` and `<project>/CLAUDE.md`, to spot rules already there and before a save.
- **Files written**: one of those two files, only when you press a Save button.
- **Environment**: reads `HOME`.
- **Store**: `items` (the newest 300 learnings, decided ones dropped first), `paused`, and `lastEdit` (the rule, its scope and the time of your last **Edit rule** press, removed by the next `remember:` prompt).
- **Processes and network**: it starts no processes and opens no connections of its own. The model call goes through Claude Code.
- **Prompt changes**: once you save a rule, a section with the rules saved this session (for this project, plus global ones) is added to the system prompt for the rest of the session, so Claude follows them before it reads CLAUDE.md again.

## Settings

None in `/config`. The check uses `haiku`. The code also reads a `model` plugin option, which `plugin.json` does not declare yet, so there is no setting to change it.

## Install

```
claude plugin marketplace add MrValraven/pulse-mods
claude plugin install pulse-reflect@pulse-mods --scope user
```

Then start a new Claude Code session.

## Credits

Based on [claude-reflect](https://github.com/bayramannakov/claude-reflect) by Bayram Annakov. The original is a Python plugin that queues corrections through hooks and saves them later with `/reflect`; this mod rewrites the correction part as a model check and a band. MIT licence, see `LICENSE`.
