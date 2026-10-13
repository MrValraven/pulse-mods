# pulse-cache-tax

A Claude Code mod that keeps the one-hour prompt cache warm while you are away, and holds a cold send once to show its estimated rewrite cost. Pinging runs only after you arm it with `/keepwarm`.

- **Keepwarm window**: `/keepwarm` arms a window (6 hours by default). After 50 idle minutes it sends one short fork of the conversation so the cache is read again before it expires. Each new turn of yours restarts the 50-minute countdown.
- **Cold-send guard**: when the context is 50,000 tokens or more and the last request was an hour ago or longer, your next message is dropped once with the estimated cost. Send it again to go through. `/cache-tax guard warn` shows the price and sends straight away.
- **Self-stopping pings**: after every ping the mod reads the token counts. It stops the window if the ping read nothing, wrote a tenth or more of what it read, failed, or was interrupted, and shows the reason.
- **Status row**: while a window is armed or has stopped, in the terminal and the desktop Code tab, a row above the prompt shows a cube icon, the state (`warm`, `cold`, `unknown` or `stopped`), the time left, the next ping and the last ping's cost. Other surfaces get the same text as plain status. `NO_COLOR` swaps the icon for a bold `[>]`.
- **Cost card**: `/cache-tax` shows the model, cache state, context size, the cold rewrite price, a break-even figure for pings and the cold writes paid this session.

## Commands

| Command | What it does |
| --- | --- |
| `/keepwarm` | Arms a 6-hour window. |
| `/keepwarm 90m` | Arms a window of your own length (`6h`, `90m`, `2h30m`). |
| `/keepwarm 6h every 2m` | Same, with a custom ping period (at least `1m`). The period lasts for that window only. |
| `/keepwarm always` | Arms 6 hours now and at every later session start, remembered across sessions. |
| `/keepwarm off` | Stops the window and turns `always` off. |
| `/keepwarm status` | Shows the window, next ping and last ping. |
| `/cache-tax` or `/cache-tax status` | Shows the cost card. |
| `/cache-tax guard refuse` | Drops a cold send once (the default). |
| `/cache-tax guard warn` | Logs the price of a cold send and sends it. |

## Settings

None. The mod declares no `userConfig`. The guard mode and the `always` switch are set with the commands above.

## How it works

- Cold means an hour or more since the last main-session request, by the mod's own clock. It is an estimate from timing; the mod has no view of the server cache.
- Prices come from a fixed table in `hooks/register.ts` (`PRICES`, list prices per million tokens for Fable, Opus, Sonnet and Haiku families). Unknown models show `n/a`.
- A cold write is counted when a turn writes at least half of a previous context above 20,000 tokens, or after a guarded send. With no window armed, the mod logs the cost and suggests `/keepwarm`. It arms nothing on its own.
- On a resumed session, Claude Code's resume fields seed the clock and context. A cold resume of 50,000 tokens or more logs one line with the estimated cost.
- `/clear` resets the clock, context and tally. A compaction resets the state until the next turn. Subagent turns never move the timer.
- Each window belongs to the session that armed it. Another session never inherits it or turns it off.

## What it touches

- **Events hooked**: `config.set` (theme key), `ui.render` (AbovePrompt), `session.start`, `classic.SessionStart`, `command.run` (`keepwarm`, `cache-tax`), `prompt.submit`, `turn.step`, `turn.complete`, `session.compact`.
- **Commands registered**: `/keepwarm` and `/cache-tax`. It registers no model tools.
- **Model requests**: one `$.model.fork` per ping, only inside an armed window and only while the cache counts as warm. The prompt is the fixed text `Reply with the single word: warm`. This is a normal Claude Code API request over the session's own transcript.
- **Prompts**: it reads whether your message starts with `/` and leaves the text unchanged. In refuse mode it can drop one message; the resend always goes through. Messages from plugins and slash commands pass untouched.
- **Reads**: the theme setting and `NO_COLOR` once at session start, the session id, model, token usage and the command list (to warn if the separate hook form, `cache-tax:status`, is also installed).
- **Storage**: Claude Code's mod store only. Keys are `deadline:<session id>`, `every:<session id>`, `always` and `guard`. Ended windows of this session and the old bare `deadline`/`every` keys are deleted at start. The cold-write tally lives in memory.
- **No** file access, processes or network hosts of its own. The icons are embedded in `hooks/status-icons.ts`.

## Install

```
claude plugin marketplace add MrValraven/pulse-mods
claude plugin install pulse-cache-tax@pulse-mods --scope user
```

Then start a new Claude Code session.

## Credits

Fork of [karanb192/cache-tax](https://github.com/karanb192/cache-tax) by Karan Bansal, MIT licence. See `LICENSE`. This fork removes the automatic keepwarm window that the original arms after a paid cold write.
