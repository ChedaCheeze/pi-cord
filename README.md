# pi-cord

Standalone, production-ready Discord gateway for the [Pi Agent](https://pi.dev).

One long-running Node.js process (`pi-cord`) manages its own Discord WebSocket
(discord.js v14) and spawns local `pi --print --session-id <channel_id>` child
processes to do the actual intelligence work. One pi session per Discord
channel/thread/DM; output streams back into a single Discord message with
throttled edits (≥75 new chars, capped at Discord's 2000-char limit).

Installed globally as a Node.js binary:

```
pi-cord    # wizard if no token, else boots the gateway
```

## Features

- **Discord-native slash commands** — an 8-command base set plus one command per
  installed Pi skill.
- **Select-menu pickers** — `/thinking`, `/model`, `/resume` show a native
  Discord select menu when their optional argument is omitted (60 s expiry,
  25-option cap, ephemeral confirmation).
- **Per-channel session overrides** — thinking level, model pattern, and
  attached session are kept in memory per channel; reset on bot restart by
  design (pi's own defaults win afterwards).
- **Streaming replies** — throttled message edits, 2000-char safe, no
  `Thinking...` placeholder leakage.
- **Token setup wizard** — interactive, writes `.env` (mode `0600`, gitignored);
  env vars always take precedence.
- **Graceful shutdown** — `SIGTERM` kills every pi run (process group,
  SIGTERM→SIGKILL 2 s grace), zero zombies.
- **No rich presence** — the bot deliberately sets no Discord activity.

## Commands

| Command | Behavior |
|---------|----------|
| `/new` | Fresh session for this channel: deletes its saved session file(s) and detaches any attached session (`/clear` is the same action) |
| `/stop` | Aborts every live pi run for this channel (the Esc equivalent) — partial output is kept, the message gets a `⏱ *stopped*` marker |
| `/thinking [level]` | Optional arg sets the level directly (`off`…`xhigh`, `max`); omitted → select menu. Applies from the next message |
| `/model [pattern]` | Optional arg sets a model pattern directly; omitted → select menu built from `pi --list-models` (5-min cache) |
| `/resume [id]` | Optional arg attaches an existing pi session by id; omitted → select menu of the 25 newest saved sessions, labelled by their first user message |
| `/status` | Pi workspace, in-flight runs, this channel's overrides, and loaded skills |
| `/help` | The command list, in Discord |
| `/clear` | Alias of `/new` (original confirmation wording kept) |

Skill commands run through the same per-channel session and honour the active
overrides.

## Project layout

```
pi-cord/
├── bin/pi-cord.js            # CLI launcher: .env load, PICORD_BOT_TOKEN mapping,
│                             #   interactive wizard, then requires dist/index.js
├── src/
│   ├── index.ts              # gateway: client, intents, streaming reply, thread
│   │                         #   hooks, slash-command sync, shutdown
│   ├── sessions.ts           # SessionManager: spawn pi (with --thinking/--model/
│   │                         #   --session args), stream, abort/kill, resetSession,
│   │                         #   per-channel overrides, listSessions, listModels,
│   │                         #   getLoadedSkills
│   ├── interaction-handler.ts # deferReply-first router for the 8 base commands
│   │                         #   + skills; select-menu picker machinery
│   └── commands-def.ts       # buildApplicationCommands (8 base + skill commands)
├── tests/
│   ├── gateway.test.ts       # offline integration: real bin vs in-repo mock
│   ├── sessions.test.ts      # SessionManager unit tests (hermetic, no real pi)
│   ├── live.test.ts          # opt-in real-Discord login test (skips w/o token)
│   └── mock/                 # in-process REST+WS Discord mock + fake-pi.sh
├── dist/                     # tsc output (committed — fresh clone runs as-is)
├── STATUS.md                 # full status: verified items, known gaps, history
└── .env                      # local config (gitignored)
```

## Quick start

```bash
npm install          # if node_modules is absent
npm run build        # rebuild dist/ from src/
pi-cord              # wizard on first run (writes .env), then boots
```

Production (this machine, user systemd service):

```bash
systemctl --user status  pi-cord       # active (running)
systemctl --user restart pi-cord       # after `npm run build`
systemctl --user stop|disable pi-cord  # full teardown
journalctl --user -u pi-cord -f        # follow logs
```

## Tests

```bash
npm test             # offline: 23 tests (13 gateway + 9 sessions + 1 live,
                     #   live self-skips without a token)
npm run test:live    # real Discord login test (needs DISCORD_TOKEN in .env)
```

The gateway suite boots the **real** `bin/pi-cord.js` against an in-repo mock
Discord server (REST + WS) with a scripted fake `pi` — fully offline, no real
token required. Set `DUMP_BOT_LOGS=1` to print the captured bot log after a run.

## Environment variables

| Var | Purpose |
|-----|---------|
| `DISCORD_TOKEN` | bot token (wizard writes this to `.env` if unset) |
| `PICORD_BOT_TOKEN` | alias mapped to `DISCORD_TOKEN` by `bin/pi-cord.js` |
| `PICORD_API_BASE` | optional REST+WS base override (offline harness; unset in production) |
| `PICORD_PI_BIN` | path to the `pi` executable (defaults to `pi`) |
| `PICORD_PI_CWD` | working dir for spawned `pi` processes |
| `PI_SKILLS_DIR` | skills dir to scan for `SKILL.md` (defaults to `~/.pi/agent/skills`) |

## Repo history note

This repository previously held an earlier, separate implementation
("picord v1", 2026-07) which was retired and removed on 2026-10-15. The current
history is the standalone rewrite (formerly developed as "picord v2", renamed
pi-cord on 2026-10-15). Full changelog/verification detail: see `STATUS.md`.
