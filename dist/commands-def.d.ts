/**
 * Discord slash-command schema for picord v2.
 *
 * Base commands (/clear, /status, /model) are built with SlashCommandBuilder;
 * buildApplicationCommands(skills) additionally turns every loaded Pi skill
 * into its own slash command so skills are first-class from the Discord
 * menu. Descriptions must be 1-100 chars for the Discord API; an empty skill
 * description falls back to the skill name.
 */
import { SlashCommandBuilder } from 'discord.js';
import type { SkillInfo } from './sessions';
/**
 * Convert loaded skills into slash commands. Skill names are sanitized to
 * Discord's [a-z0-9_-]{1,32} rule (dots/spaces become hyphens); skills that
 * still don't fit are skipped. Each command takes one optional `arg` string.
 */
export type CommandJSON = ReturnType<SlashCommandBuilder['toJSON']>;
export declare function skillCommands(skills: SkillInfo[]): CommandJSON[];
/**
 * Full command set (base + skills) as the JSON body for
 * REST.put(Routes.applicationCommands(appId), { body }).
 */
export declare function buildApplicationCommands(skills: SkillInfo[]): CommandJSON[];
