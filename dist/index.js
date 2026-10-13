"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startGateway = startGateway;
/**
 * picord v2 — standalone Discord gateway for Pi agents.
 *
 * One pi --print session per Discord channel/thread. Boots a discord.js
 * Client, registers slash commands (base + skills) with Discord's
 * application-command API, streams pi output into messages with throttled
 * edits (>=75 new chars, never past Discord's 2000-char limit), and cleans
 * up sessions when threads are deleted or archived.
 */
const discord_js_1 = require("discord.js");
const sessions_1 = require("./sessions");
const commands_def_1 = require("./commands-def");
const interaction_handler_1 = require("./interaction-handler");
// --- ANSI terminal logging ---------------------------------------------------
const GREEN = '\u001b[32m';
const YELLOW = '\u001b[33m';
const RED = '\u001b[31m';
const RESET = '\u001b[0m';
const TAG = '[picord]';
function logInfo(msg) {
    console.log(`${GREEN}${TAG} ${msg}${RESET}`);
}
function logWarn(msg) {
    console.warn(`${YELLOW}${TAG} ${msg}${RESET}`);
}
function logError(msg) {
    console.error(`${RED}${TAG} ${msg}${RESET}`);
}
// --- Throttled streaming reply -------------------------------------------------
const DISCORD_LIMIT = 2000;
const EDIT_THRESHOLD = 75;
/**
 * A message reply that accumulates streamed text and edits itself only when
 * >= EDIT_THRESHOLD new characters have arrived, clipping at Discord's
 * 2000-char limit. The first edit replaces the "Thinking..." placeholder
 * with the actual output — the placeholder is never part of the final text.
 */
class ThrottledReply {
    message;
    total = '';
    sentLen = 0;
    constructor(message) {
        this.message = message;
    }
    /** Feed a chunk; edits the reply when enough new text has accumulated. */
    async push(chunk) {
        this.total += chunk;
        if (this.total.length - this.sentLen < EDIT_THRESHOLD)
            return;
        const visible = clipAt(this.total, DISCORD_LIMIT);
        this.sentLen = visible.length;
        try {
            await this.message.edit(visible);
        }
        catch {
            /* message vanished; stop trying */
        }
    }
    /** Final edit with everything remaining (clipped to the limit). */
    async finish() {
        if (this.total.length === this.sentLen)
            return;
        const visible = clipAt(this.total, DISCORD_LIMIT);
        this.sentLen = visible.length;
        try {
            await this.message.edit(visible);
        }
        catch {
            /* message vanished */
        }
    }
    get text() {
        return this.total;
    }
}
/**
 * Clip streamed text to the Discord limit. When the total exceeds the
 * limit, the visible window slides forward so the most recent text stays
 * readable.
 */
function clipAt(total, limit) {
    return total.length <= limit ? total : total.slice(-limit);
}
// --- Gateway ---------------------------------------------------------------------
async function startGateway() {
    const token = process.env.DISCORD_TOKEN;
    if (!token) {
        logError('DISCORD_TOKEN is not set. Re-run `picord` to trigger the setup wizard.');
        process.exit(1);
    }
    const sessions = new sessions_1.SessionManager();
    const skills = sessions.getLoadedSkills();
    // Optional local REST/gateway base (defaults to Discord). When set, the
    // gateway's REST client and the Client both point at this base — used by
    // the offline integration harness. Production leaves it unset.
    const apiBase = process.env.PICORD_API_BASE?.replace(/\/+$/, '');
    const restOpts = {
        version: '10',
        ...(apiBase ? { api: `${apiBase}/api` } : {}),
    };
    const client = new discord_js_1.Client({
        intents: [
            discord_js_1.GatewayIntentBits.Guilds,
            discord_js_1.GatewayIntentBits.GuildMessages,
            discord_js_1.GatewayIntentBits.MessageContent,
            discord_js_1.GatewayIntentBits.DirectMessages,
            // Thread events (threadCreate/threadDelete/threadUpdate) are included
            // in the Guilds intent — there is no separate GuildThreads flag.
        ],
        partials: [discord_js_1.Partials.Channel],
        rest: apiBase ? { api: `${apiBase}/api` } : undefined,
    });
    // --- Local session cache (cleared when threads are archived) ----------------
    // Keyed by channel/thread id: the id of the pi session in use plus the
    // accumulated reply text. Pi itself flushes to disk synchronously; this
    // map is only the daemon-side mirror.
    const localCache = new Map();
    let shuttingDown = false;
    async function shutdown(signal) {
        if (shuttingDown)
            return;
        shuttingDown = true;
        logWarn(`${signal} received — shutting down (killing ${sessions.runningCount} pi run(s))`);
        sessions.killAll();
        try {
            client.destroy();
        }
        catch {
            /* already destroyed */
        }
        logInfo('shutdown complete.');
        process.exit(0);
    }
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('unhandledRejection', (reason) => {
        logError(`unhandled rejection: ${String(reason instanceof Error ? reason.message : reason)}`);
    });
    // --- Ready: slash-command registration ----------------------------------
    client.once('clientReady', async () => {
        if (!client.user)
            return;
        logInfo(`connected to Discord as ${client.user.tag}`);
        // Intentionally no rich presence: the bot shows no "Playing/Watching"
        // activity in Discord.
        // Register slash commands (base + skills) globally.
        try {
            const commands = (0, commands_def_1.buildApplicationCommands)(sessions.getLoadedSkills());
            const rest = new discord_js_1.REST(restOpts).setToken(token);
            await rest.put(discord_js_1.Routes.applicationCommands(client.user.id), { body: commands });
            logInfo(`synced ${commands.length} slash commands with Discord (global).`);
        }
        catch (err) {
            logError(`command sync failed: ${String(err instanceof Error ? err.message : err)}`);
        }
    });
    // --- Slash commands -----------------------------------------------------------
    client.on('interactionCreate', (interaction) => {
        if (shuttingDown)
            return;
        // Select menus from the /thinking, /model and /resume pickers.
        if (interaction.isStringSelectMenu()) {
            void (0, interaction_handler_1.handleSelectMenu)(interaction).catch((err) => {
                logError(`picker routing failed: ${String(err instanceof Error ? err.message : err)}`);
            });
            return;
        }
        if (!interaction.isChatInputCommand())
            return;
        void (0, interaction_handler_1.handleInteraction)(interaction, sessions).catch((err) => {
            logError(`interaction routing failed: ${String(err instanceof Error ? err.message : err)}`);
        });
    });
    // --- Chat loop (threads and mentions) -----------------------------------------
    client.on('messageCreate', (message) => {
        if (shuttingDown || !client.user)
            return;
        if (message.author.bot)
            return;
        const channel = message.channel;
        const isThread = channel.isThread();
        const isDm = message.guild === null;
        const mentioned = message.mentions.has(client.user.id);
        // Respond in DMs, in threads, or when mentioned in a channel.
        const shouldRespond = isDm || isThread || mentioned;
        if (!shouldRespond)
            return;
        void handleChatMessage(message, isDm ? 'dm' : message.channelId, mentioned).catch((err) => {
            logError(`message handling failed: ${String(err instanceof Error ? err.message : err)}`);
        });
        async function handleChatMessage(msg, sessionId, stripMention) {
            let input = msg.content;
            if (stripMention)
                input = input.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
            if (!input)
                return;
            // Local cache: reuse the accumulated text for this place (cleared on
            // archive; pi's on-disk session is the source of truth either way).
            const cached = localCache.get(sessionId);
            const reply = await msg.reply('Thinking...');
            localCache.set(sessionId, { sessionId, text: '' });
            const handle = sessions.spawnPi({ sessionId, input });
            const throttled = new ThrottledReply(reply);
            for await (const chunk of handle.stream) {
                await throttled.push(chunk);
                localCache.get(sessionId).text = throttled.text;
            }
            await throttled.finish();
            const code = handle.exitCode();
            if (handle.killed()) {
                // Aborted via /stop (or the hard timeout): keep whatever streamed and
                // mark the message — the Esc equivalent in the terminal.
                const kept = throttled.text.trimEnd();
                const marked = kept
                    ? `${kept}\n\n\u23f1 *stopped*`
                    : '\u23f1 *stopped — no output yet.*';
                await reply.edit(clipAt(marked, DISCORD_LIMIT)).catch(() => undefined);
                logInfo(`run stopped in ${sessionId} (${kept.length} chars kept)`);
            }
            else if (code !== 0 && !throttled.text.trim()) {
                const headline = handle
                    .stderr()
                    .split(/\r?\n/)
                    .map((l) => l.replace(/\u001b\[[0-9;]*m/g, '').trim())
                    .find(Boolean) ?? `pi exited with code ${code}`;
                logError(`pi run failed (${sessionId}): ${headline}`);
                await reply.edit(`\u26a0\ufe0f pi run failed: ${headline.slice(0, DISCORD_LIMIT - 32)}\u2026`).catch(() => undefined);
            }
            else {
                logInfo(`replied in ${sessionId} (${throttled.text.trim().length} chars, exit ${code})`);
            }
            localCache.delete(sessionId);
        }
    });
    // --- Memory hooks ------------------------------------------------------------
    client.on('threadDelete', (thread) => {
        // Purge volatile memory for a deleted thread.
        const deleted = sessions.resetSession(thread.id);
        sessions.forget(thread.id);
        localCache.delete(thread.id);
        logInfo(`thread ${thread.name} deleted — session purged (${deleted} file(s))`);
    });
    client.on('threadUpdate', (oldThread, newThread) => {
        if (newThread.archived && !oldThread.archived) {
            // Archived: drop the daemon-side mirror. Pi's session JSONL is already
            // flushed to disk synchronously by the pi process.
            localCache.delete(newThread.id);
            logInfo(`thread ${newThread.name} archived — local cache cleared`);
        }
    });
    await client.login(token);
}
// Boot on module load. The CLI launcher (bin/picord.js) `require`s this
// file after resolving the token, so the gateway must start at require
// time — not only when run directly (require.main !== module then).
startGateway().catch((err) => {
    logError(`fatal: ${String(err instanceof Error ? (err.stack ?? err.message) : err)}`);
    process.exit(1);
});
