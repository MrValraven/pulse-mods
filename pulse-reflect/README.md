# pulse-reflect

A Claude Code mod that notices when you correct Claude or state a standing preference, and offers to save it as a rule in CLAUDE.md. It is a rewrite of claude-reflect as a mod: a small model checks each short prompt, and a band above the prompt saves the rule with one press.

- **Checks as you type**: each short prompt you send goes to a small model (Haiku by default), which decides whether it holds a reusable rule. Any language works. The rule comes back as one line in English, or in your prompt's language with the `ruleLanguage` setting.
- **Band above the prompt**: found rules wait there until you save, reword or discard them, one at a time, counted `1 of 3`.
- **Undo**: a save or a discard can be undone from the band for 15 seconds.
- **Rules pane**: `/reflect-rules` lists every saved, waiting and discarded rule, with delete, move and restore.
- **`remember:` shortcut**: start a prompt with `remember:` and the text after it becomes a rule at once, with no model call.
- **Repeats are merged**: saying the same thing again raises a count (`×2`, `×3`) on the existing rule. A rule close to one already in either CLAUDE.md is counted there and never suggested.
- **Shared between sessions**: learnings live in the mod's store, so another open session shows the same band.

## How a learning is found

A prompt is checked only when all of these hold:

- You sent it: typed in the terminal or sent through Remote Control. Prompts from any other origin are skipped.
- It does not start with `/`.
- It is more than an acknowledgement. Words like `yes`, `ok`, `go on`, `continue`, `thanks`, `lgtm`, their Russian equivalents, and bare numbers up to three digits are skipped.
- It is at most 500 characters. Longer prompts are skipped, unless they start with `remember:`.
- It looks free of secrets (see below).
- The check is on (see `/reflect-pause`).

At most 20 prompts wait in the queue. They run one at a time on a timer after the prompt is sent, so your prompt is never held up.

For each prompt, the model gets your message, the last 1200 characters of Claude's previous reply (for context), and the project directory path. It answers with JSON: whether it is a rule, the rule, a scope (`global` or `project`) and a confidence. Rules below the `minConfidence` setting (0.7 by default) are dropped. A `remember:` rule is global, unless it is a rule you reworded with **Edit rule** (see below).

### What a rule must pass

Every rule, from the model or from `remember:`, passes the same checks before it is kept. When a `remember:` rule fails one, a toast reads `reflect: not kept because` and names the check:

- `the rule is empty`
- `the rule is more than one line`
- `the rule is N characters, over the 200 character limit`
- `the rule holds a control character`
- `the rule holds <!-- or -->, which would break the claude-reflect markers`
- `the rule looks like a secret (<pattern>)`, naming the pattern it matched

The secret check flags these known prefixes and shapes: `sk-`, Stripe's `sk_live_`, `sk_test_`, `rk_live_`, `rk_test_`, `pk_live_` and `pk_test_`, `npm_`, `hf_`, `pypi-`, `ghp_`, `gho_`, `ghs_`, `ghu_`, `ghr_`, `github_pat_`, `xoxb-`, `xoxp-`, `xoxa-`, `xoxs-`, `glpat-`, `AKIA`, `AIza`, `-----BEGIN`, a JWT, and `password:`, `token =` or `api key is` style pairs. It also flags any run of 32 or more characters that mixes upper case, lower case and digits with no separator, which is how generated keys look. Long plain identifiers pass: one with `_` or `-` in it (`THE_MAX_PROMPT_LENGTH`, `release-2026-11-14`), one of letters alone (`aVeryLongCamelCaseName`), and a lower case hash such as a git commit id. The same check runs on the whole prompt first, so a prompt that holds a secret is never queued or sent to the model. A `remember:` prompt that holds one raises the `not kept because the rule looks like a secret (<pattern>)` toast at once; any other prompt that holds one is skipped quietly.

### Near-duplicates

Two rules count as the same when they share at least 60% of their ordered word pairs. Before a rule is suggested, it is compared with every bullet already in this repo's `CLAUDE.md` and in `~/.claude/CLAUDE.md`. A near-duplicate is never suggested: it is recorded as saved, and saying it again raises its count, which `/reflect-queue` shows. A `remember:` rule that is a near-duplicate says so in a toast naming the file.

## The band

The band shows waiting rules for this project plus global ones, most repeated first, one rule at a time. The rule on top stays there until you decide on it, so a rule found later never slides in under your press.

In the desktop app, the rule shows as a card. The card reads `Learned rule`, then `said twice` or `said N times` when you said it more than once. On the right it reads `1 of 3` while more than one rule waits (`1/3` when the band is narrow). The rule follows in quotes, wrapped to the band's width and never cut, then `Suggested: this repo` or `Suggested: every project`, where the check suggests saving it. The buttons sit below the card. A new card eases in when it first shows, and stays still when your system asks for reduced motion.

In the terminal, the row reads `reflect · "<rule>"` with `×N` when said more than once. A dim line under it reads `Suggested: this repo` or `Suggested: every project`, then ` · 1 of 3` while more than one rule waits. The buttons sit below.

Both show the same buttons in the same order, with letter hotkeys: `s`, `g`, `e`, `d` and `n`. The save the check suggests is the primary button. In the terminal, Edit rule, Discard rule and Show next rule are dimmed, and a dim line under the buttons reads `press ctrl+x tab to reach the buttons · /reflect-rules lists every rule`: ctrl+x tab moves the keyboard into the band, where the hotkeys press the buttons. The hotkeys are letters so that typing a digit as an answer to Claude never presses one: a bare digit in an empty prompt box can press a band button, a letter only does while the band holds the keyboard.

- **Save to this repo** (`s`): writes it to `./CLAUDE.md`.
- **Save globally** (`g`): writes it to `~/.claude/CLAUDE.md`.
- **Edit rule** (`e`): puts `remember: <rule>` in the prompt box so you can reword it. The prompt box must be empty first. The original leaves the band and waits. When you send the reworded rule within 30 minutes, and it still shares at least 30% of its word pairs with the original, it takes the original's place with the original's scope, and only then is the original marked skipped. A `remember:` prompt that does not match leaves the edit waiting and comes back global. With no reworded rule after 30 minutes, the original returns to the band.
- **Discard rule** (`d`): marks it skipped. It stays out of the band.
- **Show next rule** (`n`): shows while more than one rule waits. It sends the rule on top to the back, so the count moves from `1 of 3` to `2 of 3`. Once every waiting rule has been shown, the round starts again from the most repeated rule. A rule found meanwhile comes before the ones you already passed.

### Undo

Every undo button counts down the seconds left on it (`Undo save · 12s`), has the hotkey `u`, and shows in the band and in the rules pane header.

After a save, the band reads `Saved to <path>` (or `Already in <path>` when the file already held a matching bullet) with an **Undo save** button for 15 seconds. Undo save takes that line back out of the marked section and the rule waits again at the head of the band, with the scope it had before the save (so `Suggested:` reads as it did). When the file already held the line, undo leaves the file alone and only puts the rule back.

After a discard, the band reads `Discarded` with an **Undo discard** button for 15 seconds, which puts the rule back at the head of the band.

After **Delete rule** in the rules pane, the band and the pane read `Deleted "<rule>"` with an **Undo delete** button for 15 seconds. Undo delete puts the line back at the end of the marked section it came from, marks its learnings saved again and, when it was saved in this session, puts it back in the system prompt section.

Rule across sessions: every change to a rule's state writes a new stamp on it. Undo acts only while the rule still carries the stamp your press wrote (for a delete, every learning the delete touched). If the rule was changed again after that, in the rules pane or in another session (deleted, moved, restored, decided again), undo changes nothing and a toast says why. The later change always wins.

If another session already saved or discarded the rule, pressing a Save button writes nothing. The band refreshes and a toast says the rule was already handled.

When the check is paused, the band reads `Reflect paused. /reflect-resume turns it back on`. Waiting rules still show below it.

The band steps aside while Claude Code shows a survey.

## The rules pane

`/reflect-rules` opens a pane titled **Reflect rules**. From the top:

- **Header**: `Last check error: <cause>` when the check failed in this session (see Errors), the paused line when paused, the undo row while one stands, and `N near-duplicate pairs among the saved rules` when two saved rules share at least 60% of their word pairs.
- **Saved for this repo** (`<repo>/CLAUDE.md`) and **Saved for every project** (`~/.claude/CLAUDE.md`): the bullets inside each file's marked section. A rule with a near-duplicate in either section has a line `near-duplicate of "<other rule>" (this repo)` or `(every project)` under it. Each rule has two buttons:
  - **Delete rule**: takes the line out of the marked section, with **Undo delete** for 15 seconds (see Undo). Its learning moves to Discarded, so Restore rule can also bring it back to the band later.
  - **Move to every project** or **Move to this repo**: adds the line to the other file's marked section first, then takes it out of this one, so a failure never loses it. If taking it out fails, the toast names the error and says the line is already in the other file, so it now appears in both. Move does nothing, with a toast saying why, when `HOME` is not set or when both paths are the same file (a session whose root is `~/.claude`).
- **Waiting**: the rules waiting here (the original of an **Edit rule** in progress stays out of sight, as in the band), with their count and suggested scope, and **Save to this repo**, **Save globally** and **Discard rule**.
- **Discarded**: the 20 most recently discarded rules, each with **Restore rule**, which puts it back at the head of the band.

When a file's markers are broken, its section says so and lists nothing. The pane draws again when rules change in this session or after a turn.

## Commands

- `/reflect-rules` (no arguments): opens the rules pane. `/reflect-rules help` answers the same as `/reflect-help`.
- `/reflect-help` (no arguments): lists the commands, the `remember:` prefix, the band hotkeys and the settings in force.
- `/reflect-queue` (no arguments): lists up to 40 learnings for this project and global ones, waiting ones first, with state, count, scope and rule, as text.
- `/reflect-pause` (no arguments): pauses the check and empties the queue. While paused, new prompts are not queued. The reply says how many queued prompts it dropped (`Paused. Dropped 2 queued prompts.`). When already paused it replies `Reflect is already paused`.
- `/reflect-resume` (no arguments): turns the check back on. When already on it replies `Reflect is already on`.

## Errors

When the check cannot finish, the first failure of each kind in a session raises one toast naming the cause, and the latest one shows in the rules pane header:

- `reflect: the rule check timed out after 30 s`
- `reflect: the model call failed: HTTP <status> (<error kind>)`, or `no response arrived`, `the reply held no text`, or the message of a call the engine refused to send
- `reflect: the rule check reply was not the JSON verdict it asks for: "<start of the reply>"`
- `reflect: the rule check stopped on a prompt: <message>` for a store or file error

A failed CLAUDE.md write (save, undo, delete or move) toasts `reflect: could not write <path>: <error>`.

## Where rules are saved

Global rules go to `~/.claude/CLAUDE.md` (from `$HOME`). Project rules go to `CLAUDE.md` in the session's root folder. The mod writes inside a marked section:

```
<!-- claude-reflect: learned rules (saved from the band; edit freely) -->
## Learned rules
- <rule>
<!-- end claude-reflect -->
```

If the file has no markers, the section is added at the end (the file is created if missing). If it has them once each and in order, the new bullet goes just above the end marker. If the markers are broken (only one, repeated, or out of order), nothing is written and a toast says so. If any bullet in the file already matches the rule closely (80% of word pairs), the file stays as it is and the band says `Already in`. Undo save, Delete rule and Move take out only the bullet inside the marked section that reads exactly the rule. The file is read again just before each write, and writes in one session run one after another.

## What it touches

- **Events**: `session.start`, `prompt.submit`, `turn.complete` (main session only), `prompt.compose`, `command.run`, and `ui.render` for the `AbovePrompt` area and the `reflect-rules` pane.
- **Tools**: none. It registers no tools the model can call.
- **Commands**: `/reflect-rules`, `/reflect-help`, `/reflect-queue`, `/reflect-pause` and `/reflect-resume`.
- **Model calls**: one `$.model.complete` per checked prompt, with the `model` setting (`haiku` by default), at most 300 output tokens and a 30 second timeout. `remember:` prompts make no call. A failed call drops that prompt only.
- **Files read**: `~/.claude/CLAUDE.md` and `<project>/CLAUDE.md`, to spot rules already there, before each write, and for the rules pane.
- **Files written**: those two files, only when you press Save, Undo save, Delete rule, Undo delete or Move.
- **Environment**: reads `HOME`.
- **Store**: `items` (the newest 300 learnings, decided ones dropped first, each with a `decidedAt` stamp), `paused`, and `lastEdit` (the id, rule and scope of your last **Edit rule** press and its time, removed when the reworded rule arrives or after 30 minutes).
- **Session state**: the band's order and Show next rule history, the undo offer and its countdown, the last check error and which error kinds were toasted.
- **Processes and network**: it starts no processes and opens no connections of its own. The model call goes through Claude Code.
- **Prompt changes**: once you save a rule, a section with the rules saved this session (for this project, plus global ones) is added to the system prompt for the rest of the session, so Claude follows them before it reads CLAUDE.md again. Undo save and Delete rule take the rule out of it, Undo delete puts it back, and Move updates its scope.

## Settings

Settings (`/config`, pulse-reflect):

- Check model (`model`): the model that checks each prompt, an alias such as `haiku` or `sonnet`, or a full model id. Default `haiku`.
- Minimum confidence (`minConfidence`): rules the check is less sure of are dropped. A value outside 0 to 1 is ignored. Default `0.7`.
- Rule language (`ruleLanguage`): `english` writes every rule in English; `same as prompt` writes it in the language of the prompt it came from. Default `english`.

`/reflect-help` lists them with the values in force.

## Install

```
claude plugin marketplace add MrValraven/pulse-mods
claude plugin install pulse-reflect@pulse-mods --scope user
```

Then start a new Claude Code session.

## Credits

Based on [claude-reflect](https://github.com/bayramannakov/claude-reflect) by Bayram Annakov. The original is a Python plugin that queues corrections through hooks and saves them later with `/reflect`; this mod rewrites the correction part as a model check and a band. MIT licence, see `LICENSE`.
