"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleInteraction = handleInteraction;
exports.ackNonCommand = ackNonCommand;
/**
 * Synchronous slash-command router for picord v2.
 *
 * Rule 1 (spec): the first line of handleInteraction is
 *   await interaction.deferReply({ ephemeral: false });
 * then the command is routed and the deferred reply is replaced with
 * interaction.editReply(...):
 *   /clear  -> SessionManager.resetSession(channelId)
 *   /status -> loaded skills + running pi count
 *   /model  -> asks pi which model it uses (ephemeral run)
 *   anything else -> dynamic skill execution: the command name (plus its
 *   `arg`, if any) is streamed through the channel's pi session.
 */
const discord_js_1 = require("discord.js");
const DISCORD_LIMIT = 2000;
const LOG_GREEN = '\u001b[32m';
const LOG_RED = '\u001b[31m';
const LOG_RESET = '\u001b[0m';
function logError(msg) {
    console.error(`${LOG_RED}[picord] ${msg}${LOG_RESET}`);
}
function clip(text) {
    return text.length > DISCORD_LIMIT - 1 ? `${text.slice(0, DISCORD_LIMIT - 1)}\u2026` : text;
}
/**
 * Stream a pi run and replace the deferred interaction reply with the
 * final answer. Chunks accumulate; the reply is sent in full once (this is
 * a command acknowledgement, not the streaming chat loop — the gateway's
 * messageCreate path does the throttled edits).
 */
async function runAndEditReply(interaction, handle) {
    let text = '';
    for await (const chunk of handle.stream)
        text += chunk;
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
async function handleInteraction(interaction, sessions) {
    await interaction.deferReply({ ephemeral: false });
    const name = interaction.commandName.toLowerCase();
    try {
        switch (name) {
            case 'clear': {
                const deleted = sessions.resetSession(interaction.channelId);
                await interaction.editReply({
                    content: `\u2705 Session memory for this channel cleared (${deleted} file(s) deleted).`,
                });
                console.log(`${LOG_GREEN}[picord] /clear channel=${interaction.channelId} deleted=${deleted}${LOG_RESET}`);
                return;
            }
            case 'status': {
                const skills = sessions.getLoadedSkills();
                const list = skills.length
                    ? skills.map((s) => `\u2022 ${s.name} \u2014 ${s.description || '(no description)'}`).join('\n')
                    : '\u2022 (no skills loaded)';
                await interaction.editReply({
                    content: clip(`\u2139\ufe0f **picord v2 status**\n` +
                        `Pi workspace: \`${sessions.workingDirectory}\`\n` +
                        `Pi runs in flight: ${sessions.runningCount}\n\n` +
                        `**Loaded skills (${skills.length})**\n${list}`),
                });
                return;
            }
            case 'model': {
                const handle = sessions.spawnPi({
                    sessionId: interaction.channelId,
                    input: 'Which model are you running as? Reply with just the provider and model name, nothing else.',
                });
                await runAndEditReply(interaction, handle);
                return;
            }
            default: {
                // Dynamic skill execution: route to the channel's pi session.
                const arg = interaction.options.getString('arg') ?? '';
                const input = arg ? `${name} ${arg}` : name;
                const handle = sessions.spawnPi({ sessionId: interaction.channelId, input });
                await runAndEditReply(interaction, handle);
                return;
            }
        }
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logError(`interaction /${name} failed: ${msg}`);
        try {
            await interaction.editReply({ content: clip(`\u26a0\ufe0f Command failed: ${msg}`) });
        }
        catch {
            /* the deferred reply already stands as acknowledgement */
        }
    }
}
/**
 * Acknowledge an interaction that is not a chat-input command (or that
 * arrives for a command we don't own) with a single ephemeral reply, so the
 * 3-second acknowledgement deadline is still met.
 */
async function ackNonCommand(interaction) {
    if (interaction.isChatInputCommand())
        return;
    try {
        await interaction.reply({ content: '\u26a0\ufe0f Unknown command.', flags: discord_js_1.MessageFlags.Ephemeral });
    }
    catch {
        /* too late to acknowledge; Discord shows its own error */
    }
}
