/**
 * Synchronous slash-command router for pi-cord.
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
import { MessageFlags, type ChatInputCommandInteraction, type StringSelectMenuInteraction } from 'discord.js';
import { type SessionManager } from './sessions';
/**
 * Route a select-menu component interaction to its pending picker. Called
 * from the gateway's interactionCreate handler; safe for stray menus (the
 * caller's customId is not ours).
 */
export declare function handleSelectMenu(interaction: StringSelectMenuInteraction): Promise<void>;
/**
 * The router. Every chat-input command ends up with exactly one visible
 * reply: the deferred acknowledgement is always replaced via editReply.
 */
export declare function handleInteraction(interaction: ChatInputCommandInteraction, sessions: SessionManager): Promise<void>;
/**
 * Acknowledge an interaction that is not a chat-input command (or that
 * arrives for a command we don't own) with a single ephemeral reply, so the
 * 3-second acknowledgement deadline is still met.
 */
export declare function ackNonCommand(interaction: {
    isChatInputCommand: () => boolean;
    reply: (opts: {
        content: string;
        flags: MessageFlags;
    }) => Promise<unknown>;
}): Promise<void>;
