# pulse-mods

Personal Claude Code mods, published as one folder marketplace. Every mod name starts with `pulse-`.

| Mod | What it does | Based on |
|---|---|---|
| `pulse-progress` | A QueerPulse-coloured progress band above the prompt and a `/pulse` panel of subagents. It only watches. | [savvy-progress](https://github.com/JohnnyVizz/claude-kit/tree/main/plugins/savvy-progress) (MIT) |
| `pulse-cache-tax` | Keeps the one-hour prompt cache warm during `/keepwarm` windows and holds a cold send once with its estimated rewrite cost. | [karanb192/cache-tax](https://github.com/karanb192/cache-tax) (MIT) |
| `pulse-filetree` | An IDE-style file tree pane that shows what Claude reads and writes. | [data-goblin/claude-code-filetree](https://github.com/data-goblin/claude-code-filetree) (MIT) |
| `pulse-reflect` | Finds reusable corrections in short prompts and saves them to CLAUDE.md on one press. | [bayramannakov/claude-reflect](https://github.com/bayramannakov/claude-reflect) (MIT) |

Each mod folder keeps its upstream licence and credits.

## Install

Clone the repo, then add it as a local marketplace and install the mods you want:

```bash
claude plugin marketplace add ./pulse-mods
claude plugin install pulse-progress@pulse-mods --scope user
```

## Updating a mod

Sessions run a cached copy of each version. After an edit, bump `version` in the mod's `.claude-plugin/plugin.json` and in `.claude-plugin/marketplace.json`, run `claude plugin update <mod>@pulse-mods`, then start a new session.
