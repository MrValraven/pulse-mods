# pulse-cache-tax

A Claude Code mod that keeps the one-hour prompt cache warm while you are away, and holds a cold send once to show its estimated rewrite cost. Pinging runs only after you arm it with `/keepwarm`.

- **Keepwarm window**: `/keepwarm` arms a window (6 hours by default). After 50 idle minutes it sends one short fork of the conversation so the cache is read again before it expires. Each new turn of yours restarts the 50-minute countdown.
- **Cold-send guard**: when the context is 50,000 tokens or more and the last request was an hour ago or longer, your next message is dropped once with the estimated cost. Send it again to go through. `/cache-tax guard warn` shows the price and sends straight away.
- **Self-stopping pings**: after every ping the mod reads the token counts. It stops the window if the ping read nothing, wrote a tenth or more of what it read, failed, or was interrupted, and shows the reason.
- **Status row**: while a window is armed or has stopped, in the terminal and the desktop Code tab, a row above the prompt shows a cube icon, the state (`warm`, `cold`, `unknown` or `stopped`), a warmth meter, the next ping, the time left in the window and the last ping's cost. On desktop the row leads with the state word; the terminal puts `cache-tax` before it. When keepwarm has stopped, the row gives the reason and says `/keepwarm` starts it again. Other surfaces get the plain status text. `NO_COLOR` swaps the icon for a bold `[>]`.
- **Warmth meter**: a bar for the cache's 60-minute life, filled with the time left. The fill turns coral in the last 10 minutes. On desktop a lilac mark shows where the next ping lands. While a ping runs the meter reads `pinging`, and once the cache is cold it shows the rewrite price. Desktop draws it as an image on the right of the row. The terminal, and `NO_COLOR` anywhere, draws it as a row of text cells with `Xm left`, `pinging` or `≈$X to re-write`. A terminal under 50 columns leaves the meter out. On desktop the fill drains as the minutes pass and a running ping pulses; under reduced motion it stays still. While a message is held, the card shows the price and the row leaves the meter out.
- **Held-message card**: in refuse mode a held message shows a card above the prompt. It reads "Message held" with how long the cache has been cold, and two bars compare Send now with a Warm turn. The buttons are **Send anyway ≈$X** and **Discard message**, with a hint to `/clear` and paste a summary. A short band gets a one-line card with the same buttons. The card shows whether or not a window is armed.
- **Live redraw**: the row and card redraw once a minute while a window is armed or a message is held, so the countdowns stay true.
- **Cost card**: `/cache-tax` shows the model, cache state, context size, the cold rewrite price, a break-even figure for pings and the cold writes paid this session.

## The held message

- **Send anyway** resends your held message as you, through the engine's prompt submit. It counts as the resend, so it goes through and pays the rewrite. It shows only while the cache is still cold.
- **Send anyway** is hidden when the message had attachments or @-mentions. A resend from the mod cannot carry those, so the card asks you to send it again from the prompt.
- **Discard message** clears the card. The message stays unsent, and the guard holds the next cold send again.
- Sending the message again from the prompt works too, and clears the card.
- If a resend is refused, the card comes back as it was and the log says why.
- The held text is kept in memory only. It is cleared when it is sent or discarded, on the next turn, on compaction, on `/clear` and on a resume.
- Prompts you did not type, such as notifications, follow their own rule while the cache is cold: the first is dropped once and the next one goes through. They never touch your held message.

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
- `/clear` resets the clock, context, tally and any held message. A compaction resets the state until the next turn. Subagent turns never move the timer.
- Each window belongs to the session that armed it. Another session never inherits it or turns it off.

## What it touches

- **Events hooked**: `config.set` (theme key), `ui.render` (AbovePrompt), `session.start`, `classic.SessionStart`, `command.run` (`keepwarm`, `cache-tax`), `prompt.submit`, `turn.step`, `turn.complete`, `session.compact`.
- **Commands registered**: `/keepwarm` and `/cache-tax`. It registers no model tools.
- **Model requests**: one `$.model.fork` per ping, only inside an armed window and only while the cache counts as warm. The prompt is the fixed text `Reply with the single word: warm`. This is a normal Claude Code API request over the session's own transcript.
- **Prompt submits**: one `$.prompt.submit` per press of **Send anyway**, with your held message's text, sent as you. It runs only in refuse mode, only on your press, and only while the cache is still cold.
- **Prompts**: it reads whether your message starts with `/`, whether it has attachments or an @-mention, and whether you typed it. In refuse mode it can drop one message, and keeps the text of a message you typed in memory so **Send anyway** can submit it. The resend always goes through. Messages from plugins and slash commands pass untouched.
- **Timers**: `$.clock.after` for each ping and the window's end, plus a minute timer that redraws the band while a window is armed or a message is held.
- **Reads**: the theme setting and `NO_COLOR` once at session start, the session id, model, token usage, the band's width and height, and the command list (to warn if the separate hook form, `cache-tax:status`, is also installed).
- **Storage**: Claude Code's mod store only. Keys are `deadline:<session id>`, `every:<session id>`, `always` and `guard`. Ended windows of this session and the old bare `deadline`/`every` keys are deleted at start. The cold-write tally and the held message live in memory.
- **No** file access, processes or network hosts of its own. The icons are embedded in `hooks/status-icons.ts`, and the meter and the card are drawn as SVG by `hooks/draw.ts`.

## Install

```
claude plugin marketplace add MrValraven/pulse-mods
claude plugin install pulse-cache-tax@pulse-mods --scope user
```

Then start a new Claude Code session.

## Credits

Fork of [karanb192/cache-tax](https://github.com/karanb192/cache-tax) by Karan Bansal, MIT licence. See `LICENSE`. This fork removes the automatic keepwarm window that the original arms after a paid cold write.
