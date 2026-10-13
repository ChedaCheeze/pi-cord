# picord v2 — Status

> Exact state as of **2026-07-09**, updated **2026-10-13** (automated test suite added,
> `Thinking...` streaming bug fixed, `verify-sessions.js` promoted into jest).
> Read order: **Done → Missing → Errors (found & fixed) → What's Next**.

## What picord v2 is

A standalone, production-ready Discord Gateway for the Pi Agent. It is installed
as a global Node.js binary (`picord`) that:

1. Manages its own Discord WebSocket (discord.js v14).
2. Spawns local `pi --print --session-id <channel_id>` child processes to do the
   actual intelligence work.
3. Exposes skill-driven slash commands (base `/clear` `/status` `/model` + one per
   installed Pi skill).
4. Streams pi output back into a Discord message with throttled edits
   (≥75 new chars, capped at Discord's 2000-char limit).
5. Offers an interactive token setup wizard, graceful shutdown (zombie-safe),
   rich presence, and ANSI-colored terminal logging.

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
| 5 | Rich presence | gateway `op 3` PresenceUpdate from the bot: `{"activity":{"name":"Watching /commands — Powered by Pi Agent"}}` |
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
| 17 | Live login test (opt-in) | `tests/live.test.ts` — connects the real bot (READY + bot user) and disconnects; self-skips without `DISCORD_TOKEN`; run explicitly with `npm run test:live` |

### Project layout
```
v2/
├── bin/picord.js            # CLI launcher: .env load, PICORD_BOT_TOKEN mapping,
│                            #   interactive wizard, then requires dist/index.js
├── src/
│   ├── index.ts             # gateway: client, intents, streaming reply, thread
│   │                        #   hooks, slash-command sync, shutdown
│   ├── sessions.ts          # SessionManager: spawn pi, stream, killAll,
│   │                        #   resetSession, getLoadedSkills
│   ├── interaction-handler.ts # deferReply-first command router (base + skills)
│   └── commands-def.ts      # buildApplicationCommands (base + skill commands)
├── tests/
│   ├── gateway.test.ts      # offline integration: real bin/picord.js vs the mock
│   ├── sessions.test.ts     # SessionManager unit tests (hermetic, no real pi)
│   ├── live.test.ts         # opt-in real-Discord login test (skips w/o token)
│   └── mock/
│       ├── discord-mock.ts  # in-process REST+WS Discord mock (injectable
│       │                    #   THREAD_UPDATE / THREAD_DELETE dispatches)
│       └── fake-pi.sh       # scripted fake pi (exercises the edit throttle)
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
2. **No `.gitignore` inside `v2/`.** `v2/` inherits the parent `picord` repo's
   `.gitignore`. `dist/` is intentionally **committed** (matches the parent's
   convention). `node_modules/` and `.env` are ignored by the parent.
3. **No `prepare`/postinstall build hook.** `dist/` is committed pre-built; a fresh
   clone runs without building, but source changes require `npm run build` before
   the new behavior is live.
4. **Live login test not yet run with the Crash token.** `tests/live.test.ts`
   compiles and self-skips; the real-READY assertion needs `DISCORD_TOKEN`
   in `v2/.env` (then `npm run test:live`).

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

---

## ⏭️ What's Next (proposed, not started)

1. **Add `--help` / `--version`** to `bin/picord.js` (and a `--token`/env-only flag so
   a missing token doesn't always enter the wizard).
2. **Silence the `ephemeral` deprecation warning.** `deferReply({ ephemeral: false })`
   (kept exactly per spec) prints a discord.js deprecation notice per command; changing
   to `deferReply()` (same public behavior) removes it. Needs a spec-confirmation.
3. **Run the live login test** with the Crash token (`v2/.env` + `npm run test:live`),
   then consider extending it (send a real DM, assert the streamed reply).
4. **(Optional)** `prepare` build hook so a fresh clone auto-builds `dist/`.

---

## Test suite

```bash
cd /home/local/projects/picord/v2
npm install          # if node_modules is absent
npm run build        # rebuild dist/ from src/ (gateway.test.ts runs the committed dist)
npm test             # offline: 12 tests (gateway + sessions); live test self-skips
npm run test:live    # real Discord login test (needs DISCORD_TOKEN in v2/.env)
```

## How to run

```bash
cd /home/local/projects/picord/v2
npm install          # if node_modules is absent
npm run build        # rebuild dist/ from src/

# Production (real token):
picord                       # wizard if no token, else boot

# Offline integration check (mock):
P=8888
MOCK_PORT=$P node /tmp/discord-mock.js &          # REST+WS mock on :$P
sleep 1
DISCORD_TOKEN='MTAwMDAwMDAwMDAwMDAwMDAx.x.y' \
PICORD_API_BASE="http://127.0.0.1:$P" \
PICORD_PI_CWD=/tmp PICORD_PI_BIN=/tmp/fake-pi.sh \
PI_SKILLS_DIR=/tmp/test-skills \
timeout 15 picord
# mock stdout shows COMMANDS / CREATE / EDIT / INTERACT-CALLBACK / WEBHOOK-EDIT / PRESENCE
```

### Env vars
| Var | Purpose |
|-----|---------|
| `DISCORD_TOKEN` | bot token (wizard writes this to `.env` if unset) |
| `PICORD_BOT_TOKEN` | alias mapped to `DISCORD_TOKEN` by `bin/picord.js` |
| `PICORD_API_BASE` | optional REST+WS base override (offline harness; unset in production) |
| `PICORD_PI_BIN` | path to the `pi` executable (defaults to `pi`) |
| `PICORD_PI_CWD` | working dir for spawned `pi` processes |
| `PI_SKILLS_DIR` | skills dir to scan for `SKILL.md` (defaults to `~/.pi/agent/skills`) |
