# pulse-progress

A cosmetic Claude Code mod in QueerPulse colours (coral, rose, jade). It shows the subagents of a session. It does not change what Claude does.

- **Band above the prompt**: "Pulse", a dithered bar from coral to rose to jade, finished subagents out of all subagents, and a pride crab that walks while work runs. `×N` opens the panel. `✕` hides the band and clears the finished runs. The next subagent shows the band again.
- **Panel** (`/pulse` opens or closes it, `/pulse open` only opens it): a header shows how many subagents work, the total time, cost and tokens, and a timeline of every run in lanes. Hover a lane to see its name, type and time. Each row shows the crab, the description, the type and model, aligned context, token and cost figures, and a context bar. Finished runs keep their last context fill. "Compact view" shrinks the panel to one strip of crabs, totals and a small timeline. "Hide finished" folds the finished runs.
- **Smooth motion**: the bar and the pill glide to each new count, context bars ease to their new fill, and the crabs keep their stride when the picture redraws.
- **Crabs by role**: `*-engineer` and `*-animator` wear a hard hat, `*-reviewer` a detective hat, `Explore` a pirate hat, `Plan` a space helmet. All other types hold a pride flag. `prefers-reduced-motion` stops the motion.

## What it does not do

This mod only watches. Compared to savvy-progress, it removes all behaviour changes:

- It registers no tools that the model can call. (savvy-progress adds `progress` and `step`, and puts `step` in the tool list of every subagent.)
- It does not change subagent prompts. (savvy-progress adds a reporting instruction to each `savvy-*` brief.)
- It does not read settings or environment variables. (savvy-progress reads them for the language.)
- It has no network, file or process access.

If the mod has an error, the subagent starts as usual.

Cost is an estimate from token counts and a fixed price table (`PRICES` in `hooks/register.tsx`). It is not a bill.

## Settings

`autoOpen`: `once` (default) opens the panel the first time a subagent starts in a session. `never` opens it only with `/pulse`.

## Install

This folder is a plugin and also a marketplace with one plugin in it.

1. Unzip it to a folder you keep, for example `~/claude-mods/pulse-progress`. Do not delete the folder after you install: Claude Code reads the plugin from it.
2. In a terminal, run:

```
claude plugin marketplace add ~/claude-mods/pulse-progress
claude plugin install pulse-progress@pulse-mods
```

3. Start a new Claude Code session, or type `/reload-plugins` in an open one.

To change the mod later, edit the files in that folder and raise `version` in `.claude-plugin/plugin.json` and in the marketplace entry. Then run `claude plugin update pulse-progress@pulse-mods` and start a new Claude Code session. Claude Code runs a copy of each version from `~/.claude/plugins/cache/`, so an edit without a new version never loads.

To remove it: `claude plugin uninstall pulse-progress@pulse-mods`.

## Check it

```
claude plugin validate .
claude plugin test .
```
