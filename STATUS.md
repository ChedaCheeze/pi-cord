# pi-cord — Status

> Renamed **picord v2 → pi-cord** on **2026-10-15**: this is now the single, current
> pi-cord project (old v1 deleted), at `~/projects/pi-cord`, repo
> `git@github.com:ChedaCheeze/pi-cord.git`. History below keeps its original
> "picord v2" wording where it records past events.
>
> Exact state as of **2026-07-09**, updated **2026-10-13 (b)**: automated test suite added,
> `Thinking...` streaming bug fixed, `verify-sessions.js` promoted into jest, live login test
> passed with the Crash token, **v2 deployed as the live systemd service (v1 retired)**, presence
> removed entirely, and the full **8-command Discord-native command set with select-menu
> pickers** implemented (stop / new / thinking / model / resume / help / status / clear).
> Read order: **Done → Missing → Errors (found & fixed) → What's Next**.

## What pi-cord is

A standalone, production-ready Discord Gateway for the Pi Agent. It is installed
as a global Node.js binary (`pi-cord`) that:

1. Manages its own Discord WebSocket (discord.js v14).
2. Spawns local `pi --print --session-id <channel_id>` child processes to do the
   actual intelligence work.
3. Exposes Discord-native slash commands: an 8-command base set
   (`/clear` `/new` `/stop` `/status` `/thinking` `/model` `/resume` `/help`,
   choice-based ones backed by 60 s select-menu pickers) plus one command per
   installed Pi skill.
4. Streams pi output back into a Discord message with throttled edits
   (≥75 new chars, capped at Discord's 2000-char limit).
5. Offers an interactive token setup wizard, graceful shutdown (zombie-safe),
   and ANSI-colored terminal logging. (Rich presence was removed by design —
   the bot sets no Discord activity.)

---

## ✅ Done (verified end-to-end)

Every item below was verified **fully locally** — against a self-built mock Discord
server (`/tmp/discord-mock.js`, REST + WS on one port) with a fake `pi`
(`/tmp/fake-pi.sh`). **No cloud, no real token.** The mock logs every REST call and
gateway event; assertions below are from that log.

| # | Requirement | How it was verified |
|---|-------------|---------------------|
| 1 | Gateway connect | `IDENTIFY → READY → clientReady`; log `connected to Discord as picord-mock#0001` |
| 2 | Command registration (base + skills) | `synced 4 slash commands with Discord (global)`; mock `COMMANDS ["clear","status","model","myskill"]` |
| 3 | Streaming chat loop | mock `CREATE "Thinking..."` then 4 incremental `EDIT`s (126→248→346→353 chars) at the 75-char throttle, then final flush; bot log `replied in dm (351 chars, exit 0)` |
| 4 | Slash-command interaction (`/status`) | mock `INTERACT-CALLBACK {"type":5}` (defer) then `WEBHOOK-EDIT` with correct status body (workspace, in-flight count, skill list) |
| 5 | No rich presence | **removed by design** — regression test asserts no `op 3` PresenceUpdate is ever sent (the bot shows no Playing/Watching status) |
| 6 | Graceful shutdown / no zombies | `SIGTERM → shutting down (killing 0 pi run(s)) → shutdown complete`; clean exit |
| 7 | Token fail-fast | bad/absent token → red `fatal` log, `exit 1` |
| 8 | Token setup wizard | env var, piped token, and `.env` write (mode `0600`) all verified |
| 9 | Global binary | `npm install -g .` → `which picord` on PATH, symlinked into the project (live edits) |
| 10 | 2000-char limit + `client.destroy()` | code: `ThrottledReply.clipAt` / `DISCORD_LIMIT=2000`; `client.destroy()` in shutdown path |
| 11 | Token can't leak to VCS | `v2/.env` matches parent `.gitignore` (`.env`) — confirmed via `git check-ignore` |
| 12 | Session reset + skill parsing | `resetSession(id)` JSONL deletion and `getLoadedSkills()` front-matter parse verified (15-check stage test) |
| 13 | Clean build | `npm run build` → `tsc`, exit 0 |
| 14 | `npm test` suite (jest) | `tests/gateway.test.ts` boots the real `bin/picord.js` against the in-repo mock (`tests/mock/discord-mock.ts` + `fake-pi.sh`) and asserts connect, command sync (base+skill), 75-char-throttled DM stream, `/status` defer+editReply, presence, thread archive/delete hooks (with real JSONL purge), graceful SIGTERM exit 0 — 7/7 green, fully offline |
| 15 | Live thread-event path | `THREAD_CREATE` (with `GUILD_CREATE`) + injected `THREAD_UPDATE` (archive) and `THREAD_DELETE` dispatches in the mock — closes old gap #2 |
| 16 | SessionManager unit tests | `tests/sessions.test.ts` — the 15 checks from `verify-sessions.js`, hermetized (fake-pi + temp `PI_SESSION_DIR`/`PI_SKILLS_DIR`): stream, kill-mid-run orphan check, resetSession suffix matching, frontmatter parse, killAll — 5/5 green |
| 17 | Live login test (opt-in) | `tests/live.test.ts` — connects the real bot (READY + bot user) and disconnects; self-skips without `DISCORD_TOKEN`; run explicitly with `npm run test:live`. **Passed with the Crash token** (READY in ~1s) |
| 18 | Production deployment | v2 runs as the user systemd service `picord.service` (unit rewritten to `node /home/local/projects/picord/v2/bin/picord.js`, enabled, `Restart=always`); token from `v2/.env` (0600, gitignored). Verified live: connect as Crash#1198, **8 slash commands synced** (re-verified after the command-set rollout), real DM/thread/@mention replies through the local pi model. **No rich presence** — the bot shows no Playing/Watching status in Discord |
| 19 | v1 retirement | The old v1 daemon (running from a since-deleted clone dir) was stopped, its unit disabled (backup kept at `~/.config/systemd/user/picord.service.v1.bak`); no old processes remain |
| 20 | **8-command set + pickers** | `/clear` `/new` `/stop` `/status` `/thinking` `/model` `/resume` `/help`. Choice commands show a native select menu when the optional arg is omitted (60 s expiry, 25-option cap, ephemeral confirmation, expired-menu annotation); direct args always work. Gateway tests cover: `/help` body, `/new` file purge, `/thinking` menu→pick→`--thinking` in the next spawn argv, `/model` menu→pick→`--model` (list parsed from `pi --list-models`, 5-min cache), `/resume` menu→pick→`--session <id>` replacing `--session-id` (labels = first user message of each saved session, newest first) |
| 21 | **`/stop` (Esc equivalent)** | kills every live pi run for the channel's session (process group, SIGTERM→SIGKILL 2 s grace); the streamed reply keeps its partial output plus a `⏱ *stopped*` marker. Gateway test: mid-run kill confirmed by pgrep + stopped-marker edit; `abortSession` unit test covers counts |
| 22 | **Per-channel session overrides** | thinking level, model pattern, and attached session are in-memory, per channel (DMs share the `dm` key, matching message routing; `interaction.guildId` distinguishes DMs without a channel cache); reset on bot restart by design. Unit tests assert the exact spawn argv with/without each override; `/status` shows this channel's current overrides |
| 23 | Session browsing | `listSessions()` — scans `~/.pi/agent/sessions/*/*.jsonl` (honours `PI_SESSION_DIR`), dedupes by session id (newest mtime wins), labels from the first user message (first 64 KB), newest-first, capped. Unit-tested incl. dedupe + limit |
| 24 | Mock parity with discord.js 14.27 | the in-repo mock now speaks the current API shape: `InteractionType.MessageComponent === 3`, top-level `message` member on component interactions, `channel: {id}` objects, callback-content + select-menu (customId/labels) capture, `injectDM()`/`injectInteraction()`/`injectSelectMenu()`, BigInt message ids (plain-number ids exceeded `MAX_SAFE_INTEGER` and silently collided) |

### Project layout
```
pi-cord/
├── bin/pi-cord.js           # CLI launcher: .env load, PICORD_BOT_TOKEN mapping,
│                            #   interactive wizard, then requires dist/index.js
├── src/
│   ├── index.ts             # gateway: client, intents, streaming reply, thread
│   │                        #   hooks, slash-command sync, shutdown
│   ├── sessions.ts          # SessionManager: spawn pi (with --thinking/--model/
│   │                        #   --session args), stream, abortSession/killAll,
│   │                        #   resetSession, per-channel overrides, listSessions,
│   │                        #   listModels, getLoadedSkills
│   ├── interaction-handler.ts # deferReply-first router for the 8 base commands
│   │                        #   + skills; select-menu picker machinery
│   │                        #   (handleSelectMenu, customId-keyed, 60 s expiry)
│   └── commands-def.ts      # buildApplicationCommands (8 base + skill commands)
├── tests/
│   ├── gateway.test.ts      # offline integration: real bin/picord.js vs the mock
│   │                        #   (13 tests: connect, sync, stream, all 8 commands
│   │                        #   incl. picker flows + /stop, no presence, thread
│   │                        #   hooks, SIGTERM)
│   ├── sessions.test.ts     # SessionManager unit tests (hermetic, no real pi;
│   │                        #   9 tests incl. argv/overrides, listSessions,
│   │                        #   listModels, abortSession)
│   ├── live.test.ts         # opt-in real-Discord login test (skips w/o token)
│   └── mock/
│       ├── discord-mock.ts  # in-process REST+WS Discord mock (injectable
│       │                    #   THREAD_UPDATE / THREAD_DELETE, DMs, chat-input
│       │                    #   interactions, select-menu clicks)
│       └── fake-pi.sh       # scripted fake pi: edit-throttle chunks,
│                            #   --list-models table, stop-probe-slow mode,
│                            #   argv logging via FAKE_PI_ARGS_FILE
├── dist/                    # tsc output (committed)
├── package.json             # name: picord, bin: picord, main: dist/index.js
├── jest.config.js           # ts-jest; tests/**/*.test.ts
├── tsconfig.json / tsconfig.test.json
├── package-lock.json
└── STATUS.md                # this file
```

---

## ❌ Missing / not done

These are **not** bugs — they are deliberately-unaddressed gaps, listed so the
reviewer knows the boundaries.

1. **No `--help` / `--version` / CLI flags.** `bin/picord.js` has no flag parsing;
   any invocation without a token goes straight into the wizard. (Not a spec item.)
2. **`dist/` is intentionally committed.** A fresh clone runs without building;
   after editing `src/`, run `npm run build` and commit the rebuilt `dist/`.
   (`node_modules/` and `.env` are gitignored in-repo.)
3. **No `prepare`/postinstall build hook.** `dist/` is committed pre-built; a fresh
   clone runs without building, but source changes require `npm run build` before
   the new behavior is live.
4. **Overrides are in-memory.** Thinking/model/session overrides live in the bot
   process and reset on restart (accepted design — pi's own defaults win after a
   restart). Session *files* and pi's session store persist regardless.
5. **`/resume` picker is capped at 25 sessions** (Discord's option limit) — older
   sessions can still be attached via `/resume <id>`.
6. **Picker menus expire in 60 s** with no re-arm; re-running the command gives a
   fresh menu.

---

## 🐛 Errors found & fixed (during verification)

The bot code was correct throughout. Every failure below was a **protocol bug in the
mock Discord server**, not in picord. Fixed so the connected-loop could be verified.

**Product bug found & fixed (2026-10-13, by the new test suite):** the streamed
chat reply kept the `"Thinking..."` placeholder **permanently prefixed** to the
final message (`ThrottledReply` appended pi output to the placeholder text). Fixed
in `src/index.ts` — the first edit now *replaces* the placeholder; the final
message contains only the pi output. Regression-covered by
tests/gateway.test.ts ("streams the DM reply with the 75-char edit throttle").

**Product bug found & fixed (2026-10-13, in production):** rich presence was set
with `{ type: 0 }` (Playing), so Discord rendered the double-verb
"*Playing* Watching /commands — Powered by Pi Agent". Resolution: the presence was
**removed entirely** — the bot intentionally sets no activity. Regression-covered by
tests/gateway.test.ts ("sets no rich presence").

| # | Error (symptom) | Root cause (in the mock) | Fix |
|---|-----------------|--------------------------|-----|
| 1 | `messageCreate` never fired for DM | MESSAGE_CREATE payload lacked `channel_type: 1`, so discord.js couldn't construct the DM channel and dropped the event | added `channel_type: 1` to the DM MESSAGE_CREATE |
| 2 | `interactionCreate` crashed (`Cannot read properties of undefined (reduce)`) | INTERACTION_CREATE missing `entitlements: []` (BaseInteraction does `data.entitlements.reduce`) | added `entitlements: []` |
| 3 | `interactionCreate` crashed (`Cannot read properties of undefined (read '0')`) | INTERACTION_CREATE missing `authorizing_integration_owners` (BaseInteraction reads `[0]` off it) | added `authorizing_integration_owners: {}` |
| 4 | `interactionCreate` never fired for `/status` | nested command `type` was `2` (User context-menu); ChatInput must be `1` | changed nested command `type` to `1` |
| 5 | `deferReply` threw `Unexpected end of JSON input` | mock returned `204` **with** `Content-Type: application/json`, so `@discordjs/rest` JSON-parsed the empty body | 204 responses omit the JSON content-type |
| 6 | Presence "not found" in logs | mock was watching for `op 0` (Dispatch); PresenceUpdate is **`op 3`** | presence handler now matches `op 3` |

Also added for observability (mock only): full REST request logging
(`[rest] METHOD path`) and gateway event logging (`CREATE` / `EDIT` / `COMMANDS` /
`INTERACT-CALLBACK` / `WEBHOOK-EDIT` / `PRESENCE`), plus a `[gw-recv]` raw-packet log.

**2026-10-13 (b) — while building the command set:**

*Product bug found & fixed:* the interaction router keyed per-channel overrides by
`interaction.channelId`, but DM *messages* are routed under the shared `'dm'` session
key — so a picker pick in a DM would never apply to the next DM run. Fixed in
`src/interaction-handler.ts`: `sessionKey = interaction.guildId ? channelId : 'dm'`
(guildId is null for DM interactions, so no channel cache is needed). Regression-
covered by the picker gateway tests (menu → pick → next DM run's argv).

| # | Error (symptom) | Root cause (in the mock) | Fix |
|---|-----------------|--------------------------|-----|
| 7 | Select-menu clicks silently ignored | current discord-api-types enum: `InteractionType.MessageComponent === 3` (not 4) — the mock dispatched the click as an *autocomplete* interaction, which the gateway ignores by design | dispatch type 3; comment added |
| 8 | (same) interaction never constructed | component interactions carry the attached `message` as a **top-level** payload member (sibling of `data`), and `channel` as an **object** (`data.channel?.id` is what discord.js 14.27 reads) | `injectSelectMenu`/`injectInteraction` send the current shape |
| 9 | Second DM in a session never answered | `newId()` used `900000000000000000 + n` — past `Number.MAX_SAFE_INTEGER`, so **every** id collapsed to the same string; the DM collided with a cached bot message and discord.js re-emitted that (bot-authored) message, which the gateway ignores | BigInt id arithmetic |

---

## ⏭️ What's Next (proposed, not started)

1. **Add `--help` / `--version`** to `bin/picord.js` (and a `--token`/env-only flag so
   a missing token doesn't always enter the wizard).
2. **Silence the `ephemeral` deprecation warning.** `deferReply({ ephemeral: false })`
   (kept exactly per spec) prints a discord.js deprecation notice per command; changing
   to `deferReply()` (same public behavior) removes it. Needs a spec-confirmation.
3. **(Optional)** `prepare` build hook so a fresh clone auto-builds `dist/`.
4. **(Optional)** extend `tests/live.test.ts` beyond login (send a real DM, assert the
   streamed reply).

---

## Commands

The 8 base commands (all in the bot's slash menu; DMs, threads, and guild channels):

| Command | Behavior |
|---------|----------|
| `/new` | Fresh session for this channel: deletes its saved session file(s) and detaches any attached session (`/clear` is the same action, same confirmation text style) |
| `/stop` | Aborts every live pi run for this channel (the Esc equivalent) — partial output is kept, the message gets a `⏱ *stopped*` marker |
| `/thinking [level]` | Optional arg sets the level directly (`off`…`xhigh`, `max`); omitted → select menu. Applies from the next message; in-memory (reset on bot restart) |
| `/model [pattern]` | Optional arg sets a model pattern directly; omitted → select menu built from `pi --list-models` (5-min cache). In-memory |
| `/resume [id]` | Optional arg attaches an existing pi session by id; omitted → select menu of the 25 newest saved sessions, labelled by their first user message. The next message continues that conversation (`pi --session <id>`) |
| `/status` | Pi workspace, in-flight runs, **this channel's overrides** (thinking/model/session), and loaded skills |
| `/help` | This command list, in Discord |
| `/clear` | Alias of `/new` (original confirmation wording kept) |

Picker semantics (all three pickers): native Discord select menu, 60 s expiry with
an annotated expired message, ephemeral confirmation on pick, 25-option cap,
unique `customId` per menu (no message-cache dependency), routed by the gateway's
`interactionCreate` handler (`handleSelectMenu`). Skill commands run through the
same per-channel session and therefore honour the active overrides.

## Test suite

```bash
cd /home/local/projects/pi-cord
npm install          # if node_modules is absent
npm run build        # rebuild dist/ from src/ (gateway.test.ts runs the committed dist)
npm test             # offline: 23 tests (13 gateway + 9 sessions + 1 live, self-skips w/o token)
npm run test:live    # real Discord login test (needs DISCORD_TOKEN in .env)
```

Set `DUMP_BOT_LOGS=1` to print the captured bot log after a gateway-suite run
(useful when extending the mock).

## How to run

```bash
cd /home/local/projects/pi-cord
npm install          # if node_modules is absent
npm run build        # rebuild dist/ from src/

# Foreground (real token): the token comes from .env
pi-cord                      # wizard if no token, else boot

# Production (this machine): user systemd service
systemctl --user status  pi-cord       # active (running) as Crash#1198
systemctl --user restart pi-cord       # after `npm run build`
systemctl --user stop|disable pi-cord  # full teardown
journalctl --user -u pi-cord -f        # follow logs
```

The offline integration check no longer needs a manual harness — `npm test`
runs the in-repo mock (`tests/mock/discord-mock.ts` + `fake-pi.sh`).

### Env vars
| Var | Purpose |
|-----|---------|
| `DISCORD_TOKEN` | bot token (wizard writes this to `.env` if unset) |
| `PICORD_BOT_TOKEN` | alias mapped to `DISCORD_TOKEN` by `bin/picord.js` |
| `PICORD_API_BASE` | optional REST+WS base override (offline harness; unset in production) |
| `PICORD_PI_BIN` | path to the `pi` executable (defaults to `pi`) |
| `PICORD_PI_CWD` | working dir for spawned `pi` processes |
| `PI_SKILLS_DIR` | skills dir to scan for `SKILL.md` (defaults to `~/.pi/agent/skills`) |
