# pulse-cache-tax

A Claude Code mod that keeps the prompt cache warm while you are away, and holds a cold send once to show its estimated rewrite cost. Pinging runs only after you arm it with `/keepwarm`. The cache lifetime is the `cacheTtl` setting: `1h` (the default) or `5m`, and every timing and price below follows it.

- **Keepwarm window**: `/keepwarm` arms a window (the `defaultWindow` setting, 6 hours by default). After 50 idle minutes on the `1h` cache, or 4 on the `5m` cache, it sends one short fork of the conversation so the cache is read again before it expires. Each new turn of yours restarts that countdown.
- **5-minute cache warning**: on the `5m` cache, the first `/keepwarm` of a session says it pings every 4 minutes (15 pings an hour) and shows the estimated cost per hour at the current context size, read at the cache-read rate. Before a turn has set the context size it says the figure comes on the next `/keepwarm`, and warns again then.
- **Cold-send guard**: when the context is at least the `guardMinTokens` setting (50,000 tokens by default) and the last request is older than the cache lifetime, your next message is dropped once with the estimated cost. Send it again to go through. `/cache-tax guard warn` shows the price and sends straight away. While the cache is cold and the context is under the threshold, the status line, the band row and the cost card say `guard off below 50k tokens` (with your threshold), keepwarm on or off, so a send that went through has a visible reason. While the cache is warm the phrase is hidden.
- **Self-stopping pings**: after every ping the mod reads the token counts. It stops the window if the ping read nothing, wrote a tenth or more of what it read, failed, or was interrupted, and shows the reason.
- **Status row**: while a window is armed or has stopped, or while the cache is cold with the context under the guard threshold, in the terminal and the desktop Code tab, a row above the prompt shows a cube icon, the state (`warm`, `cold`, `unknown` or `stopped`), a warmth meter, the next ping, the time left in the window, the last ping's cost and the session's ping spend against savings (`keepwarm: pings $0.40, saved about $3.10`). On a cold cache it reads `keepwarm starts pinging after your next turn`. On desktop the row leads with the state word; the terminal puts `cache-tax` before it. When keepwarm has stopped, the row gives the reason and says `/keepwarm` starts it again. Other surfaces get the plain status text. `NO_COLOR` swaps the icon for a bold `[>]`.
- **Colours**: the state word, the terminal meter and the held card use the pulse palette, the same values the desktop drawings use: jade for warm, coral for cold and for the last stretch before it, each in the shade that holds contrast on a light or a dark theme. `NO_COLOR` leaves the text uncoloured.
- **Warmth meter**: a bar for the cache's life (60 minutes on `1h`, 5 on `5m`), filled with the time left. The fill turns coral in the last sixth of it: the last 10 minutes on `1h`, the last 50 seconds on `5m`. On desktop a lilac mark shows where the next ping lands. While a ping runs the meter reads `pinging`, and once the cache is cold it shows the rewrite price. Desktop draws it as an image on the right of the row. The terminal, and `NO_COLOR` anywhere, draws it as a row of text cells with `Xm left`, `pinging` or `≈$X to re-write`. A terminal under 50 columns leaves the meter out. On desktop the fill drains as the minutes pass and a running ping pulses; under reduced motion it stays still. While a message is held, the card shows the price and the row leaves the meter out.
- **Held-message card**: in refuse mode a held message shows a card above the prompt. It reads "Message held" with how long the cache has been cold, and two bars compare Send now with a Warm turn. The buttons are **Send message ≈$X** (hotkey `1`) and **Discard message** (hotkey `2`), with a hint to `/clear` and paste a summary. A short band, and the terminal, get a one-line card that leads with the price, `about $4.01 to send cold, cache cold for 2h00m · message held, a warm turn about $0.05`, so a narrow terminal cuts the tail and keeps the price. The card shows whether or not a window is armed.
- **Live redraw**: the row and card redraw once a minute while a window is armed or a message is held, so the countdowns stay true.
- **Cost card**: `/cache-tax` shows the model, cache state, the cache lifetime and its write rate, context size, the cold rewrite price, keepwarm's ping spend against savings, a break-even figure for pings, the guard and its threshold, and the cold writes paid this session.
- **Ping spend and savings**: the mod adds up what this session's pings cost, and estimates the cold writes they avoided. A turn that arrives after a gap longer than the cache lifetime, with the cache still warm because a ping landed in that gap, counts as one avoided cold write at the context size of that moment. The band (while keepwarm is on) and the cost card show `keepwarm: pings $0.40, saved about $3.10`. Both totals reset each session, and on `/clear`. When the model's price is unknown the line gives the counts and says price unknown.
- **One-time tip**: the first cold write that costs $0.50 or more while keepwarm is off brings one toast suggesting `/keepwarm`. It never shows again (the `keepwarmTipShown` store key).

## The held message

- **Send message** resends your held message as you, through the engine's prompt submit. It counts as the resend, so it goes through and pays the rewrite. It shows only while the cache is still cold.
- Press **1** for Send message and **2** for Discard message. The hotkeys work while the band holds the focus, and from an empty prompt box. The terminal draws the buttons plain with the digit first (`1: Send message ≈$4.01`, `2: Discard message`), as Blast Radius's buttons read; the desktop app draws its own native buttons.
- **Send message** is hidden when the message has an attachment or an @-mention of a path (one with a `/` or a file extension, such as `@src/a.ts` or `@README.md`). A resend from the mod cannot carry those, so the card says which (`It has an attachment` or `It mentions @src/a.ts`) and asks you to send it again from the prompt. Other @-words, such as `@everyone`, keep Send message.
- **Discard message** clears the card. The message stays unsent, and the guard holds the next cold send again.
- Sending the message again from the prompt works too, and clears the card.
- Sending a different message while one is held lets the new one through. The held message comes back after that turn, with the cause `you sent a different message while it was held`: in the prompt box when it is empty, else on the clipboard.
- If a resend is refused, the card comes back as it was and a toast names the cause: `the resend did not go through:` and the reason the engine gave.
- The held text is kept in memory only. It is cleared when it is sent or discarded.
- **Lost on a turn, a compaction, a resume or `/clear`**: the card goes away, so the text comes back to you. With an empty prompt box it goes back in the box, and a toast says `Your held message is back in the prompt box:` and the cause. With a draft in the box it goes to the clipboard, and the toast says so and that the box had a draft. If the clipboard copy is refused too, the text is written to the log and the toast names both causes.
- Prompts you did not type, such as notifications, follow their own rule while the cache is cold: the first is dropped once and the next one goes through. They never touch your held message.

## Commands

| Command | What it does |
| --- | --- |
| `/keepwarm` | Arms a window of Default keepwarm window (`defaultWindow`), 6 hours by default. |
| `/keepwarm 90m` | Arms a window of your own length (`6h`, `90m`, `2h30m`). |
| `/keepwarm 6h every 2m` | Same, with a custom ping period (at least `1m`). The period lasts for that window only. |
| `/keepwarm always` | Arms the default window now and at every later session start, remembered across sessions. |
| `/keepwarm off` | Stops the window and turns `always` off. |
| `/keepwarm status` | Shows the window, next ping and last ping. |
| `/keepwarm help` | Lists every `/keepwarm` form, `every` included, and when pings land. |
| `/cache-tax` or `/cache-tax status` | Shows the cost card. |
| `/cache-tax guard refuse` | Drops a cold send once (the default). |
| `/cache-tax guard warn` | Logs the price of a cold send and sends it. |
| `/cache-tax help` | Lists every `/cache-tax` form, then every `/keepwarm` form, then the current settings. |

Any other argument gets a reply that quotes it and lists every accepted form. `/keepwarm 90m every 10s` names the period it could not read.

## Settings

Set in `/config`, under pulse-cache-tax (the mod's `userConfig`). Each is listed as its `/config` title, then its key. A change reloads the mod. `/keepwarm help` and `/cache-tax help` end with the same list and the current values.

| Setting | Values | Default | What it does |
| --- | --- | --- | --- |
| Cache lifetime (`cacheTtl`) | `1h` or `5m` | `1h` | The cache lifetime. Cold means idle longer than it. Keepwarm pings 50 minutes after your last turn on `1h` and 4 minutes after on `5m`. Cold writes are priced at the 1-hour or the 5-minute write rate to match. |
| Guard threshold (`guardMinTokens`) | a number of tokens | `50000` | The guard holds or warns only at this context size or above. It also sets the size a cold resume must reach before its one-line estimate is logged. |
| Default keepwarm window (`defaultWindow`) | a duration such as `6h`, `90m`, `2h30m` | `6h` | What a bare `/keepwarm` and `/keepwarm always` arm. |

A value the mod cannot read falls back to its default, and a toast at session start names the setting (title and key), the value and the default it used. The guard mode and the `always` switch are set with the commands above.

## How it works

- Cold means the cache lifetime (`cacheTtl`: an hour, or five minutes) or more since the last main-session request, by the mod's own clock. It is an estimate from timing; the mod has no view of the server cache.
- Prices come from `hooks/prices.ts`, the price table pulse-progress shares (list prices per million tokens for the Fable, Mythos, Opus, Sonnet and Haiku families). A cold write is priced at the 1-hour write rate (twice the input price) or the 5-minute one (1.25 times it). A ping is priced as its cache read, any cache write, its uncached input and its output. Unknown models say price unknown.
- A cold write is counted when a turn writes at least half of a previous context above 20,000 tokens, or after a guarded send. With no window armed, the mod logs the cost and suggests `/keepwarm`. It arms nothing on its own.
- On a resumed session, Claude Code's resume fields seed the clock and context. A cold resume at or above `guardMinTokens` logs one line with the estimated cost.
- `/clear` resets the clock, context, tally and the ping spend and savings totals, and gives any held message back to you first. A compaction resets the state until the next turn. Subagent turns never move the timer.
- Each window belongs to the session that armed it. Another session never inherits it or turns it off.

## What it touches

- **Events hooked**: `config.set` (theme key), `ui.render` (AbovePrompt), `session.start`, `classic.SessionStart`, `command.run` (`keepwarm`, `cache-tax`), `prompt.submit`, `turn.step`, `turn.complete`, `session.compact`.
- **Settings read**: `cacheTtl`, `guardMinTokens` and `defaultWindow` from the mod's `userConfig`, once when the mod loads.
- **Commands registered**: `/keepwarm` and `/cache-tax`. It registers no model tools.
- **Model requests**: one `$.model.fork` per ping, only inside an armed window and only while the cache counts as warm. The prompt is the fixed text `Reply with the single word: warm`. This is a normal Claude Code API request over the session's own transcript.
- **Prompt submits**: one `$.prompt.submit` per press of **Send message**, with your held message's text, sent as you. It runs only in refuse mode, only on your press, and only while the cache is still cold.
- **Prompt box**: when a held message is lost to a turn, a compaction, a resume or `/clear`, it reads the prompt box (`$.prompt.read`) to see whether it is empty, then puts the text back with `$.prompt.fill`, or copies it with `$.ui.copy` when the box has a draft.
- **Toasts**: a held message put back, a refused resend and its cause, the double-install warning, a setting it could not read, and the one-time `/keepwarm` tip.
- **Prompts**: it reads whether your message starts with `/`, whether it has attachments or an @-mention of a path, and whether you typed it. In refuse mode it can drop one message, and keeps the text of a message you typed in memory so **Send message** can submit it. The resend always goes through. Messages from plugins and slash commands pass untouched.
- **Timers**: `$.clock.after` for each ping and the window's end, one for the moment the cache goes cold when the context is under the guard threshold and no window is armed, plus a minute timer that redraws the band while a window is armed or a message is held.
- **Reads**: the theme setting and `NO_COLOR` once at session start, the session id, model, token usage, the band's width and height, and the command list (to warn if the separate hook form, `cache-tax:status`, is also installed).
- **Storage**: Claude Code's mod store only. Keys are `deadline:<session id>`, `every:<session id>`, `always`, `guard` and `keepwarmTipShown`. Ended windows of this session and the old bare `deadline`/`every` keys are deleted at start. The cold-write tally, the ping spend and savings totals and the held message live in memory.
- **No** file access, processes or network hosts of its own. The icons are embedded in `hooks/status-icons.ts`, the meter and the card are drawn as SVG by `hooks/draw.ts`, and the prices live in `hooks/prices.ts`.

## Install

```
claude plugin marketplace add MrValraven/pulse-mods
claude plugin install pulse-cache-tax@pulse-mods --scope user
```

Then start a new Claude Code session.

## Credits

Fork of [karanb192/cache-tax](https://github.com/karanb192/cache-tax) by Karan Bansal, MIT licence. See `LICENSE`. This fork removes the automatic keepwarm window that the original arms after a paid cold write.
