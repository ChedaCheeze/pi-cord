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
import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import type { SessionManager } from './sessions';
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
