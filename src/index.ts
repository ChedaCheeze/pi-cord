/**
 * picord v2 — standalone Discord gateway for Pi agents.
 *
 * One pi --print session per Discord channel/thread. Boots a discord.js
 * Client, registers slash commands (base + skills) with Discord's
 * application-command API, streams pi output into messages with throttled
 * edits (>=75 new chars, never past Discord's 2000-char limit), and cleans
 * up sessions when threads are deleted or archived.
 */
import {
  ActivityType,
  Client,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  REST,
  Routes,
  type Message,
  type ThreadChannel,
} from 'discord.js';
import { SessionManager, type SkillInfo } from './sessions';
import { buildApplicationCommands } from './commands-def';
import { handleInteraction } from './interaction-handler';

// --- ANSI terminal logging ---------------------------------------------------

const GREEN = '\u001b[32m';
const YELLOW = '\u001b[33m';
const RED = '\u001b[31m';
const RESET = '\u001b[0m';
const TAG = '[picord]';

function logInfo(msg: string): void {
  console.log(`${GREEN}${TAG} ${msg}${RESET}`);
}
function logWarn(msg: string): void {
  console.warn(`${YELLOW}${TAG} ${msg}${RESET}`);
}
function logError(msg: string): void {
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
  private total = '';
  private sentLen = 0;

  constructor(private readonly message: Message) {}

  /** Feed a chunk; edits the reply when enough new text has accumulated. */
  async push(chunk: string): Promise<void> {
    this.total += chunk;
    if (this.total.length - this.sentLen < EDIT_THRESHOLD) return;
    const visible = clipAt(this.total, DISCORD_LIMIT);
    this.sentLen = visible.length;
    try {
      await this.message.edit(visible);
    } catch {
      /* message vanished; stop trying */
    }
  }

  /** Final edit with everything remaining (clipped to the limit). */
  async finish(): Promise<void> {
    if (this.total.length === this.sentLen) return;
    const visible = clipAt(this.total, DISCORD_LIMIT);
    this.sentLen = visible.length;
    try {
      await this.message.edit(visible);
    } catch {
      /* message vanished */
    }
  }

  get text(): string {
    return this.total;
  }
}

/**
 * Clip streamed text to the Discord limit. When the total exceeds the
 * limit, the visible window slides forward so the most recent text stays
 * readable.
 */
function clipAt(total: string, limit: number): string {
  return total.length <= limit ? total : total.slice(-limit);
}

// --- Gateway ---------------------------------------------------------------------

export async function startGateway(): Promise<void> {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    logError('DISCORD_TOKEN is not set. Re-run `picord` to trigger the setup wizard.');
    process.exit(1);
  }

  const sessions = new SessionManager();
  const skills: SkillInfo[] = sessions.getLoadedSkills();

  // Optional local REST/gateway base (defaults to Discord). When set, the
  // gateway's REST client and the Client both point at this base — used by
  // the offline integration harness. Production leaves it unset.
  const apiBase = process.env.PICORD_API_BASE?.replace(/\/+$/, '');
  const restOpts: { version: string; api?: string } = {
    version: '10',
    ...(apiBase ? { api: `${apiBase}/api` } : {}),
  };

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
      // Thread events (threadCreate/threadDelete/threadUpdate) are included
      // in the Guilds intent — there is no separate GuildThreads flag.
    ],
    partials: [Partials.Channel],
    rest: apiBase ? { api: `${apiBase}/api` } : undefined,
  });

  // --- Local session cache (cleared when threads are archived) ----------------
  // Keyed by channel/thread id: the id of the pi session in use plus the
  // accumulated reply text. Pi itself flushes to disk synchronously; this
  // map is only the daemon-side mirror.
  const localCache = new Map<string, { sessionId: string; text: string }>();

  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logWarn(`${signal} received — shutting down (killing ${sessions.runningCount} pi run(s))`);
    sessions.killAll();
    try {
      client.destroy();
    } catch {
      /* already destroyed */
    }
    logInfo('shutdown complete.');
    process.exit(0);
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason: unknown) => {
    logError(`unhandled rejection: ${String(reason instanceof Error ? reason.message : reason)}`);
  });

  // --- Ready: presence + slash-command registration -------------------------

  client.once('clientReady', async () => {
    if (!client.user) return;
    logInfo(`connected to Discord as ${client.user.tag}`);

    // Rich presence: "Watching /commands — Powered by Pi Agent". The type
    // must be Watching (3) — with Playing (0) Discord renders the
    // double-verb "Playing Watching ...".
    try {
      await client.user.setActivity('Watching /commands — Powered by Pi Agent', {
        type: ActivityType.Watching,
      });
    } catch (err) {
      logWarn(`setActivity failed: ${String(err instanceof Error ? err.message : err)}`);
    }

    // Register slash commands (base + skills) globally.
    try {
      const commands = buildApplicationCommands(sessions.getLoadedSkills());
      const rest = new REST(restOpts).setToken(token);
      await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
      logInfo(`synced ${commands.length} slash commands with Discord (global).`);
    } catch (err) {
      logError(`command sync failed: ${String(err instanceof Error ? err.message : err)}`);
    }
  });

  // --- Slash commands -----------------------------------------------------------

  client.on('interactionCreate', (interaction) => {
    if (!interaction.isChatInputCommand() || shuttingDown) return;
    void handleInteraction(interaction, sessions).catch((err: unknown) => {
      logError(`interaction routing failed: ${String(err instanceof Error ? err.message : err)}`);
    });
  });

  // --- Chat loop (threads and mentions) -----------------------------------------

  client.on('messageCreate', (message: Message) => {
    if (shuttingDown || !client.user) return;
    if (message.author.bot) return;

    const channel = message.channel;
    const isThread = channel.isThread();
    const isDm = message.guild === null;
    const mentioned = message.mentions.has(client.user.id);

    // Respond in DMs, in threads, or when mentioned in a channel.
    const shouldRespond = isDm || isThread || mentioned;
    if (!shouldRespond) return;

    void handleChatMessage(message, isDm ? 'dm' : message.channelId, mentioned).catch((err: unknown) => {
      logError(`message handling failed: ${String(err instanceof Error ? err.message : err)}`);
    });

    async function handleChatMessage(msg: Message, sessionId: string, stripMention: boolean): Promise<void> {
      let input = msg.content;
      if (stripMention) input = input.replace(new RegExp(`<@!?${client!.user!.id}>`, 'g'), '').trim();
      if (!input) return;

      // Local cache: reuse the accumulated text for this place (cleared on
      // archive; pi's on-disk session is the source of truth either way).
      const cached = localCache.get(sessionId);
      const reply = await msg.reply('Thinking...');
      localCache.set(sessionId, { sessionId, text: '' });

      const handle = sessions.spawnPi({ sessionId, input });
      const throttled = new ThrottledReply(reply);
      for await (const chunk of handle.stream) {
        await throttled.push(chunk);
        localCache.get(sessionId)!.text = throttled.text;
      }
      await throttled.finish();

      const code = handle.exitCode();
      if (code !== 0 && !throttled.text.trim()) {
        const headline = handle
          .stderr()
          .split(/\r?\n/)
          .map((l) => l.replace(/\u001b\[[0-9;]*m/g, '').trim())
          .find(Boolean) ?? `pi exited with code ${code}`;
        logError(`pi run failed (${sessionId}): ${headline}`);
        await reply.edit(`\u26a0\ufe0f pi run failed: ${headline.slice(0, DISCORD_LIMIT - 32)}\u2026`).catch(() => undefined);
      } else {
        logInfo(`replied in ${sessionId} (${throttled.text.trim().length} chars, exit ${code})`);
      }
      localCache.delete(sessionId);
    }
  });

  // --- Memory hooks ------------------------------------------------------------

  client.on('threadDelete', (thread: ThreadChannel) => {
    // Purge volatile memory for a deleted thread.
    const deleted = sessions.resetSession(thread.id);
    localCache.delete(thread.id);
    logInfo(`thread ${thread.name} deleted — session purged (${deleted} file(s))`);
  });

  client.on('threadUpdate', (oldThread: ThreadChannel, newThread: ThreadChannel) => {
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
startGateway().catch((err: unknown) => {
  logError(`fatal: ${String(err instanceof Error ? (err.stack ?? err.message) : err)}`);
  process.exit(1);
});
