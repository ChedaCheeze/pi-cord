"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.skillCommands = skillCommands;
exports.buildApplicationCommands = buildApplicationCommands;
/**
 * Discord slash-command schema for picord v2.
 *
 * Base commands are built with SlashCommandBuilder;
 * buildApplicationCommands(skills) additionally turns every loaded Pi skill
 * into its own slash command so skills are first-class from the Discord
 * menu. Descriptions must be 1-100 chars for the Discord API; an empty skill
 * description falls back to the skill name.
 *
 * Picker convention: /thinking, /model and /resume take an OPTIONAL argument.
 * With the argument the value is applied directly; without it the command
 * replies with a native Discord select menu (see interaction-handler.ts).
 */
const discord_js_1 = require("discord.js");
const sessions_1 = require("./sessions");
const NAME_RE = /^[a-z0-9_-]{1,32}$/;
const DESC_RE = /^.{1,100}$/;
/** Base commands every picord v2 instance registers (as API JSON). */
function baseCommands() {
    return [
        new discord_js_1.SlashCommandBuilder()
            .setName('clear')
            .setDescription('Delete the saved session memory for this channel (alias of /new)')
            .toJSON(),
        new discord_js_1.SlashCommandBuilder()
            .setName('new')
            .setDescription('Start a fresh session: clears saved memory and any attached session')
            .toJSON(),
        new discord_js_1.SlashCommandBuilder()
            .setName('stop')
            .setDescription('Abort the pi run currently live in this channel (Esc)')
            .toJSON(),
        new discord_js_1.SlashCommandBuilder()
            .setName('status')
            .setDescription('Show skills, session info, and this channel\u2019s overrides')
            .toJSON(),
        new discord_js_1.SlashCommandBuilder()
            .setName('thinking')
            .setDescription('Show or set the thinking level (menu when omitted)')
            .addStringOption((opt) => opt
            .setName('level')
            .setDescription('Thinking level (optional — omitted shows a picker)')
            .setRequired(false)
            .addChoices(...sessions_1.THINKING_LEVELS.map((l) => ({ name: l, value: l }))))
            .toJSON(),
        new discord_js_1.SlashCommandBuilder()
            .setName('model')
            .setDescription('Show or set the model for this channel (menu when omitted)')
            .addStringOption((opt) => opt
            .setName('pattern')
            .setDescription('Model pattern, e.g. llama.cpp/unsloth/Qwen (optional — omitted shows a picker)')
            .setRequired(false))
            .toJSON(),
        new discord_js_1.SlashCommandBuilder()
            .setName('resume')
            .setDescription('Attach an existing pi session to this channel (menu when omitted)')
            .addStringOption((opt) => opt.setName('id').setDescription('Session id or unique prefix (optional — omitted shows a picker)').setRequired(false))
            .toJSON(),
        new discord_js_1.SlashCommandBuilder().setName('help').setDescription('List the picord commands').toJSON(),
    ];
}
function skillCommands(skills) {
    const out = [];
    const used = new Set();
    for (const skill of skills) {
        const name = skill.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
        if (!NAME_RE.test(name) || used.has(name))
            continue;
        used.add(name);
        // Discord requires a 1-100 char description; fall back to the name.
        const description = skill.description || skill.name;
        if (!DESC_RE.test(description))
            continue;
        out.push(new discord_js_1.SlashCommandBuilder()
            .setName(name)
            .setDescription(description)
            .addStringOption((opt) => opt.setName('arg').setDescription('Input for the skill (optional)').setRequired(false))
            .toJSON());
    }
    return out;
}
/**
 * Full command set (base + skills) as the JSON body for
 * REST.put(Routes.applicationCommands(appId), { body }).
 */
function buildApplicationCommands(skills) {
    return [...baseCommands(), ...skillCommands(skills)];
}
