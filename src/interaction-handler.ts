/**
 * Synchronous slash-command router for picord v2.
 *
 * Rule 1 (spec): the first line of handleInteraction is
 *   await interaction.deferReply({ ephemeral: false });
 * then the command is routed and the deferred reply is replaced with
 * interaction.editReply(...):
 *   /clear   -> SessionManager.resetSession(channelId)
 *   /new     -> resetSession(active session) + detach any attached session
 *   /stop    -> abortSession(channelId) (the Esc equivalent)
 *   /status  -> skills + running count + this channel's overrides
 *   /thinking [level] -> show + set, or select menu when omitted
 *   /model [pattern]  -> show + set, or select menu (pi --list-models)
 *   /resume [id]      -> attach session, or select menu (saved sessions)
 *   /help    -> command list
 *   anything else -> dynamic skill execution: the command name (plus its
 *   `arg`, if any) is streamed through the channel's pi session.
 *
 * Pickers (the no-arg paths of /thinking, /model, /resume) replace the
 * deferred reply with a native Discord select menu; the selection is
 * acknowledged with a single ephemeral reply. Menus expire after 60s.
 */
import {
  ActionRowBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { THINKING_LEVELS, type PiStreamHandle, type SessionManager } from './sessions';

const DISCORD_LIMIT = 2000;
const LOG_GREEN = '\u001b[32m';
const LOG_RED = '\u001b[31m';
const LOG_RESET = '\u001b[0m';

function logError(msg: string): void {
  console.error(`${LOG_RED}[picord] ${msg}${LOG_RESET}`);
}

function clip(text: string): string {
  return text.length > DISCORD_LIMIT - 1 ? `${text.slice(0, DISCORD_LIMIT - 1)}\u2026` : text;
}

/** Local-time label for picker rows, e.g. "Oct 13 11:54". */
function fmtWhen(d: Date): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${months[d.getMonth()]} ${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const PICKER_TIMEOUT_MS = 60_000;

interface PendingPicker {
  timer: NodeJS.Timeout;
  onPick: (value: string) => Promise<string> | string;
}

/**
 * Live pickers, keyed by the menu's unique customId (always present on
 * component interactions — no message cache needed). The gateway's
 * interactionCreate handler routes select-menu interactions here (see
 * handleSelectMenu) — discord.js 14 has no per-interaction collector.
 */
const pendingPickers = new Map<string, PendingPicker>();

/**
 * Replace the deferred reply with a select menu (terminal-picker style).
 * On selection, `onPick(value)` runs (via handleSelectMenu) and its return
 * value is posted as an ephemeral confirmation. When the menu times out
 * un-picked, the message is annotated as expired. Discord caps menus at 25
 * options — callers slice.
 */
async function presentPicker(
  interaction: ChatInputCommandInteraction,
  intro: string,
  options: { name: string; value: string }[],
  onPick: (value: string) => Promise<string> | string,
): Promise<void> {
  if (options.length === 0) {
    await interaction.editReply({ content: clip(`${intro}\n\n\u26a0\ufe0f No options available right now.`) });
    return;
  }
  const customId = `picord-${interaction.commandName}-${Math.random().toString(36).slice(2, 10)}`;
  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder('Pick one\u2026')
    .addOptions(
      options.slice(0, 25).map((o) => ({ label: o.name.slice(0, 100), value: o.value.slice(0, 100) })),
    );
  const message = await interaction.editReply({
    content: clip(intro),
    components: [new ActionRowBuilder().addComponents(menu).toJSON()],
  });

  const timer = setTimeout(() => {
    if (!pendingPickers.delete(customId)) return; // already picked
    void message
      .edit({ content: clip(`${intro}\n\n\u23f1 Menu expired (${PICKER_TIMEOUT_MS / 1000}s). Run the command again.`) })
      .catch(() => undefined);
  }, PICKER_TIMEOUT_MS);
  timer.unref?.();
  pendingPickers.set(customId, { timer, onPick });
}

/**
 * Route a select-menu component interaction to its pending picker. Called
 * from the gateway's interactionCreate handler; safe for stray menus (the
 * caller's customId is not ours).
 */
export async function handleSelectMenu(interaction: StringSelectMenuInteraction): Promise<void> {
  if (!interaction.customId.startsWith('picord-')) return;
  const entry = pendingPickers.get(interaction.customId);
  if (!entry) {
    await interaction
      .reply({ content: '\u23f1 Menu expired. Run the command again.', flags: MessageFlags.Ephemeral })
      .catch(() => undefined);
    return;
  }
  pendingPickers.delete(interaction.customId);
  clearTimeout(entry.timer);
  try {
    const text = await entry.onPick(interaction.values[0]);
    await interaction.reply({ content: clip(text), flags: MessageFlags.Ephemeral });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await interaction
      .reply({ content: clip(`\u26a0\ufe0f ${msg}`), flags: MessageFlags.Ephemeral })
      .catch(() => undefined);
  }
}

/**
 * Stream a pi run and replace the deferred interaction reply with the
 * final answer. Chunks accumulate; the reply is sent in full once (this is
 * a command acknowledgement, not the streaming chat loop — the gateway's
 * messageCreate path does the throttled edits).
 */
async function runAndEditReply(
  interaction: ChatInputCommandInteraction,
  handle: PiStreamHandle,
): Promise<void> {
  let text = '';
  for await (const chunk of handle.stream) text += chunk;
  const stderr = handle.stderr();
  const code = handle.exitCode();
  if (code !== 0 && !text) {
    const headline = stderr
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) ?? `pi exited with code ${code}`;
    await interaction.editReply({ content: clip(`\u26a0\ufe0f pi run failed: ${headline}`) });
    return;
  }
  if (!text) {
    await interaction.editReply({ content: '\u26a0\ufe0f pi finished with no output.' });
    return;
  }
  await interaction.editReply({ content: clip(text.trim()) });
}

/**
 * The router. Every chat-input command ends up with exactly one visible
 * reply: the deferred acknowledgement is always replaced via editReply.
 */
export async function handleInteraction(
  interaction: ChatInputCommandInteraction,
  sessions: SessionManager,
): Promise<void> {
  await interaction.deferReply({ ephemeral: false });
  const name = interaction.commandName.toLowerCase();
  // DMs share one pi session ('dm') — same mapping as the gateway's
  // messageCreate routing. guildId is null for DM interactions, so this
  // needs no channel cache.
  const sessionKey = interaction.guildId ? interaction.channelId : 'dm';

  try {
    switch (name) {
      case 'status': {
        const skills = sessions.getLoadedSkills();
        const list = skills.length
          ? skills.map((s) => `\u2022 ${s.name} \u2014 ${s.description || '(no description)'}`).join('\n')
          : '\u2022 (no skills loaded)';
        const thinking = sessions.thinkingFor(sessionKey);
        const model = sessions.modelFor(sessionKey);
        const attached = sessions.attachedFor(sessionKey);
        await interaction.editReply({
          content: clip(
            `\u2139\ufe0f **picord v2 status**\n` +
              `Pi workspace: \`${sessions.workingDirectory}\`\n` +
              `Pi runs in flight: ${sessions.runningCount}\n\n` +
              `**This channel**\n` +
              `Thinking: ${thinking ?? 'pi default'}\n` +
              `Model: ${model ?? 'pi default'}\n` +
              `Session: ${attached ? `attached \`${attached}\`` : 'channel default'}\n\n` +
              `**Loaded skills (${skills.length})**\n${list}`,
          ),
        });
        return;
      }
      case 'new':
      case 'clear': {
        // /new and /clear: delete the channel's saved session memory. When a
        // session is attached (via /resume), its files are the memory too.
        const ch = sessionKey;
        const active = sessions.attachedFor(ch) ?? ch;
        const deleted = sessions.resetSession(active);
        sessions.detachSession(ch);
        await interaction.editReply({
          content:
            name === 'clear'
              ? `\u2705 Session memory for this channel cleared (${deleted} file(s) deleted).`
              : `\u2705 New session started for this channel (${deleted} saved file(s) deleted).`,
        });
        console.log(`${LOG_GREEN}[picord] /${name} channel=${ch} deleted=${deleted}${LOG_RESET}`);
        return;
      }
      case 'stop': {
        const n = sessions.abortSession(sessionKey);
        await interaction.editReply({
          content:
            n > 0
              ? `\u23f1 Stopped ${n} pi run(s) in this channel.`
              : '\u23f1 Nothing is running in this channel right now.',
        });
        console.log(`${LOG_GREEN}[picord] /stop channel=${sessionKey} aborted=${n}${LOG_RESET}`);
        return;
      }
      case 'thinking': {
        const ch = sessionKey;
        const current = sessions.thinkingFor(ch);
        const level = interaction.options.getString('level');
        if (level) {
          sessions.setThinking(ch, level);
          await interaction.editReply({
            content: `\u2705 Thinking level set to **${level}** (applies from the next message).`,
          });
          return;
        }
        await presentPicker(
          interaction,
          `Thinking level for this channel: **${current ?? 'pi default'}** — pick a new one:`,
          THINKING_LEVELS.map((l) => ({ name: l === current ? `${l} (current)` : l, value: l })),
          (v) => {
            sessions.setThinking(ch, v);
            return `\u2705 Thinking level set to **${v}** (applies from the next message).`;
          },
        );
        return;
      }
      case 'model': {
        const ch = sessionKey;
        const pattern = interaction.options.getString('pattern');
        if (pattern) {
          sessions.setModel(ch, pattern);
          await interaction.editReply({
            content: `\u2705 Model set to \`${pattern}\` (applies from the next message).`,
          });
          return;
        }
        const current = sessions.modelFor(ch);
        const models = sessions.listModels();
        if (models.length === 0) {
          await interaction.editReply({
            content: clip(
              `\u26a0\ufe0f Could not list models from pi. Set one directly: \`/model pattern:<provider/id>\`\n` +
                `Current override: ${current ?? 'none (pi default)'}`,
            ),
          });
          return;
        }
        await presentPicker(
          interaction,
          `Available models (current override: **${current ?? 'pi default'}**):`,
          models.map((m) => ({ name: `${m.id}${m.id === current ? ' (current)' : ''}`, value: m.id })),
          (v) => {
            sessions.setModel(ch, v);
            return `\u2705 Model set to \`${v}\` (applies from the next message).`;
          },
        );
        return;
      }
      case 'resume': {
        const ch = sessionKey;
        const id = interaction.options.getString('id');
        if (id) {
          sessions.attachSession(ch, id);
          await interaction.editReply({
            content: `\u2705 This channel now resumes session \`${id}\` from the next message.`,
          });
          return;
        }
        const saved = sessions.listSessions(25);
        if (saved.length === 0) {
          await interaction.editReply({
            content: '\u26a0\ufe0f No saved pi sessions found. Send a message first — every conversation is saved.',
          });
          return;
        }
        await presentPicker(
          interaction,
          `Pick a session to attach to this channel (newest first):`,
          saved.map((s) => ({ name: `${fmtWhen(s.mtime)} \u2014 ${s.label || s.id.slice(0, 8)}`, value: s.id })),
          (v) => {
            sessions.attachSession(ch, v);
            return `\u2705 Session \`${v}\` attached — the next message continues that conversation. \`/new\` starts fresh.`;
          },
        );
        return;
      }
      case 'help': {
        await interaction.editReply({
          content: clip(
            '**picord v2 commands**\n' +
              '\u2022 `/new` — fresh session for this channel (\`/clear\` = same)\n' +
              '\u2022 `/stop` — abort the live pi run (Esc)\n' +
              '\u2022 `/thinking [level]` — show/set thinking level (menu when omitted)\n' +
              '\u2022 `/model [pattern]` — show/set model (menu when omitted)\n' +
              '\u2022 `/resume [id]` — attach an existing pi session (menu when omitted)\n' +
              '\u2022 `/status` — skills, runs, and this channel\u2019s overrides\n' +
              '\u2022 Skill names in the slash menu run that skill through this channel\u2019s session',
          ),
        });
        return;
      }
      default: {
        // Dynamic skill execution: route to the channel's pi session.
        const arg = interaction.options.getString('arg') ?? '';
        const input = arg ? `${name} ${arg}` : name;
        const handle = sessions.spawnPi({ sessionId: sessionKey, input });
        await runAndEditReply(interaction, handle);
        return;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(`interaction /${name} failed: ${msg}`);
    try {
      await interaction.editReply({ content: clip(`\u26a0\ufe0f Command failed: ${msg}`) });
    } catch {
      /* the deferred reply already stands as acknowledgement */
    }
  }
}

/**
 * Acknowledge an interaction that is not a chat-input command (or that
 * arrives for a command we don't own) with a single ephemeral reply, so the
 * 3-second acknowledgement deadline is still met.
 */
export async function ackNonCommand(interaction: {
  isChatInputCommand: () => boolean;
  reply: (opts: { content: string; flags: MessageFlags }) => Promise<unknown>;
}): Promise<void> {
  if (interaction.isChatInputCommand()) return;
  try {
    await interaction.reply({ content: '\u26a0\ufe0f Unknown command.', flags: MessageFlags.Ephemeral });
  } catch {
    /* too late to acknowledge; Discord shows its own error */
  }
}
