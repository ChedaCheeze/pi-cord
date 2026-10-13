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

const NAME_RE = /^[a-z0-9_-]{1,32}$/;
const DESC_RE = /^.{1,100}$/;

/** Base commands every picord v2 instance registers. */
function baseCommands(): SlashCommandBuilder[] {
  return [
    new SlashCommandBuilder()
      .setName('clear')
      .setDescription('Delete the saved session memory for this channel'),
    new SlashCommandBuilder()
      .setName('status')
      .setDescription('Show loaded skills and session information'),
    new SlashCommandBuilder()
      .setName('model')
      .setDescription('Ask Pi which model it is using'),
  ];
}

/**
 * Convert loaded skills into slash commands. Skill names are sanitized to
 * Discord's [a-z0-9_-]{1,32} rule (dots/spaces become hyphens); skills that
 * still don't fit are skipped. Each command takes one optional `arg` string.
 */
export type CommandJSON = ReturnType<SlashCommandBuilder['toJSON']>; // RESTPostAPIChatInputApplicationCommandsJSONBody

export function skillCommands(skills: SkillInfo[]): CommandJSON[] {
  const out: CommandJSON[] = [];
  const used = new Set<string>();
  for (const skill of skills) {
    const name = skill.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!NAME_RE.test(name) || used.has(name)) continue;
    used.add(name);
    // Discord requires a 1-100 char description; fall back to the name.
    const description = skill.description || skill.name;
    if (!DESC_RE.test(description)) continue;
    out.push(
      new SlashCommandBuilder()
        .setName(name)
        .setDescription(description)
        .addStringOption((opt) =>
          opt.setName('arg').setDescription('Input for the skill (optional)').setRequired(false),
        )
        .toJSON(),
    );
  }
  return out;
}

/**
 * Full command set (base + skills) as the JSON body for
 * REST.put(Routes.applicationCommands(appId), { body }).
 */
export function buildApplicationCommands(skills: SkillInfo[]): CommandJSON[] {
  return [...baseCommands().map((c) => c.toJSON()), ...skillCommands(skills)];
}
