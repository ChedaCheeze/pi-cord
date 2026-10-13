"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.skillCommands = skillCommands;
exports.buildApplicationCommands = buildApplicationCommands;
/**
 * Discord slash-command schema for picord v2.
 *
 * Base commands (/clear, /status, /model) are built with SlashCommandBuilder;
 * buildApplicationCommands(skills) additionally turns every loaded Pi skill
 * into its own slash command so skills are first-class from the Discord
 * menu. Descriptions must be 1-100 chars for the Discord API; an empty skill
 * description falls back to the skill name.
 */
const discord_js_1 = require("discord.js");
const NAME_RE = /^[a-z0-9_-]{1,32}$/;
const DESC_RE = /^.{1,100}$/;
/** Base commands every picord v2 instance registers. */
function baseCommands() {
    return [
        new discord_js_1.SlashCommandBuilder()
            .setName('clear')
            .setDescription('Delete the saved session memory for this channel'),
        new discord_js_1.SlashCommandBuilder()
            .setName('status')
            .setDescription('Show loaded skills and session information'),
        new discord_js_1.SlashCommandBuilder()
            .setName('model')
            .setDescription('Ask Pi which model it is using'),
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
    return [...baseCommands().map((c) => c.toJSON()), ...skillCommands(skills)];
}
