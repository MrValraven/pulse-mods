# pulse-progress

A cosmetic Claude Code mod in QueerPulse colours (coral, rose, jade). It shows the subagents of a session and leaves what Claude does as it is.

Based on [savvy-progress](https://github.com/JohnnyVizz/claude-kit/tree/main/plugins/savvy-progress) by johnnyvizz (MIT, see NOTICE).

- **Band above the prompt**: "Pulse", a dithered bar from coral to rose to jade, finished subagents out of all subagents, and a pride crab that walks while work runs. The band says its state in words beside the colour: "All done" once every run finished, "N stopped" when runs stopped early. "Agents N" opens the panel. While the panel is closed the band carries a short `/pulse` hint.
- **Clear finished runs**: the band's close button (labelled "Clear finished runs" in the desktop app, "Clear finished" or "Clear" in the terminal) clears the finished runs and hides the band. For 10 seconds the band then shows "Cleared N finished runs" with an **Undo clear** button that brings them back. With no finished runs the same button reads "Hide band" ("Hide" in a narrow terminal) and hides the band alone. The next subagent shows the band again.
- **Narrow terminals**: the band row never wraps. As the terminal narrows it drops the `/pulse` hint, then the percent (under about 46 columns), then the bar; the count words always stay.
- **Panel** (`/pulse`, or the band's "Agents N"): a header shows how many subagents work, the active time, cost and tokens, and a timeline of every run in lanes. Each row shows the crab, the description, the type and model, aligned context, token and cost figures, and a context bar. Finished runs keep their last context fill. "Show compact view" shrinks the panel to one strip of crabs (in the terminal, one mark per run: `●` running, `○` done, `×` stopped), totals and a small timeline; "Show detailed view" brings the rows back. "Hide finished" folds the finished runs. Both choices are kept across sessions.
- **Active time**: the header's time is the union of the runs' intervals, labelled "active": idle gaps between runs do not count.
- **Why a run stopped**: a run that ended without an answer says why, on its desktop chip and its terminal row: "Cancelled by you", "Refused by the model" (with the refusal's category when the API gives one), "Context limit reached", "Output limit reached", "API error" (followed by the status or message when the errored turn's text gives one), or "Stopped: <reason>" for a reason this mod does not know yet.
- **Timeline**: in the desktop app, hover a lane to see its name, type and time once every run has finished. While runs work the header is a new image every second, which would drop the hover each time, so a caption says when tooltips come back. When more runs overlap than the 8 lanes hold, the axis shows "+N more" for the capsules it cannot draw.
- **Smooth motion**: the bar and the pill glide to each new count, context bars ease to their new fill, and the crabs keep their stride when the picture redraws.
- **Crabs by role**: `*-engineer` and `*-animator` wear a hard hat, `*-reviewer` a detective hat, `Explore` a pirate hat, `Plan` a space helmet. All other types hold a pride flag. `prefers-reduced-motion` stops the motion.

## Commands

| Command | What it does |
| --- | --- |
| `/pulse` | Opens the panel, or closes it when open. |
| `/pulse open` | Opens the panel. |
| `/pulse close` | Closes the panel. |
| `/pulse help` | Lists these commands, the settings with their current values, and the date of the price table (`prices as of 2026-11-03`). |
| `/pulse mods` | Compares the installed pulse mods with GitHub and shows the update steps. |

Typing `/pulse ` offers the four arguments in the typeahead. Any other argument replies `/pulse does not take "<arg>". It takes open, close, help or mods.`

## Update check (`/pulse mods`)

`/pulse mods` reads the installed versions from `~/.claude/plugins/installed_plugins.json` (the entries ending `@pulse-mods`) and fetches the latest versions from `https://raw.githubusercontent.com/MrValraven/pulse-mods/main/.claude-plugin/marketplace.json`. It replies with one line per mod, `name  installed X  latest Y`, marking mods that are not installed and mods newer on GitHub.

When `~/.claude/plugins/known_marketplaces.json` says `pulse-mods` was added from a local folder, it also reads that clone's `.claude-plugin/marketplace.json`. If the clone lists older versions than GitHub, the reply says the clone at that path is behind GitHub and must be pulled first, since Claude Code installs from that folder.

When something is out of date, the reply ends with the update steps:

```
git -C <path> pull --ff-only origin main && claude plugin marketplace update pulse-mods
for mod in <installed mods>; do claude plugin update "$mod@pulse-mods"; done
start a new session; /reload-plugins keeps the old version
```

The first line is `claude plugin marketplace update pulse-mods` alone when the marketplace comes from GitHub.

With `updateCheck` on, the same check runs quietly once a day, a few seconds after a session starts, and shows a toast only when an installed mod is out of date, for example "pulse-filetree 0.7.0 is on GitHub, you run 0.6.0. /pulse mods shows the update steps". The time of the last check is kept in the mod's store.

Errors name their cause: "Could not fetch <url>: <message>" with the message the fetch gave (headed "No network" when it is a connection error, such as a failed DNS lookup or a refused connection; a refusal by the organization's web-fetch policy or by `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` keeps its own words), the HTTP status GitHub answered, or the path of an `installed_plugins.json` that could not be read or is not valid JSON. `/pulse mods` typed by hand shows these in its reply. The quiet check writes them to the debug log alone (`claude --debug`) and raises no toast.

The quiet check runs at most once per session. It records its time only once GitHub answered (with the versions or with an HTTP status), so after an unreachable network or an unreadable file the next session tries again.

## Access

The mod watches subagents. Compared to savvy-progress, it removes the behaviour changes:

- It registers no tools that the model can call. (savvy-progress adds `progress` and `step`, and puts `step` in the tool list of every subagent.)
- It leaves subagent prompts as they are. (savvy-progress adds a reporting instruction to each `savvy-*` brief.)
- It reads its own two settings, and `HOME` to find `~/.claude/plugins`.
- Its file and network access serve the update check alone: it reads `installed_plugins.json`, `known_marketplaces.json` and a local clone's `marketplace.json`, and makes one GET to the GitHub URL above. It writes no files and runs no processes. Its store holds the two panel choices and the time of the last update check.

If the mod has an error while tracking a subagent, the subagent starts as usual and the log names the cause.

Cost is an estimate from token counts and the price table in `hooks/prices.ts` (list prices as of 2026-11-03, cache writes at the 1-hour rate). It is an estimate for orientation; the bill is Anthropic's. A run on a model the table has no row for shows "price unknown", and the totals add a note such as "2 runs without a price", whose cost is left out.

## Settings

Settings are in `/config` under pulse-progress, each by its title:

- Open the agents panel (`autoOpen`): `once` (default) opens the panel the first time a subagent starts in a session. `never` opens it only with `/pulse`.
- Check for pulse mods updates (`updateCheck`): `on` (default) runs the quiet daily update check at session start. `off` leaves the check to `/pulse mods`.

## Install

This folder is a plugin and also a marketplace with one plugin in it.

1. Unzip it to a folder you keep, for example `~/claude-mods/pulse-progress`. Keep the folder after you install: Claude Code reads the plugin from it.
2. In a terminal, run:

```
claude plugin marketplace add ~/claude-mods/pulse-progress
claude plugin install pulse-progress@pulse-mods
```

3. Start a new Claude Code session. `/reload-plugins` in an open session keeps the old version.

To change the mod later, edit the files in that folder and raise `version` in `.claude-plugin/plugin.json` and in the marketplace entry. Then run `claude plugin update pulse-progress@pulse-mods` and start a new Claude Code session. Claude Code runs a copy of each version from `~/.claude/plugins/cache/`, so an edit without a new version never loads.

To remove it: `claude plugin uninstall pulse-progress@pulse-mods`.

## Check it

```
claude plugin validate .
claude plugin test .
```
