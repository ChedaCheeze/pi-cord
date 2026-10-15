#!/usr/bin/env node
'use strict';

/**
 * pi-cord — global CLI launcher.
 *
 * 1. Loads .env from the project directory (dotenv), mapping
 *    PICORD_BOT_TOKEN to DISCORD_TOKEN if present.
 * 2. If no token is available, runs the interactive setup wizard
 *    (native readline) and writes the token to .env securely.
 * 3. Boots the gateway from ../dist/index.js.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const projectDir = path.resolve(__dirname, '..');
const envPath = path.join(projectDir, '.env');
const TOKEN_LINE = /^\s*DISCORD_TOKEN\s*=/m;

// --- 1. Load .env and map PICORD_BOT_TOKEN -> DISCORD_TOKEN ----------------
//
// Real environment variables always take precedence; .env is the fallback
// (dotenv never overrides an existing process.env value).

function writeTokenToEnv(token) {
  const lines = [];
  if (fs.existsSync(envPath)) {
    const existing = fs.readFileSync(envPath, 'utf8');
    const hadToken = TOKEN_LINE.test(existing);
    for (const line of existing.split(/\r?\n/)) {
      if (TOKEN_LINE.test(line)) continue; // replaced below
      lines.push(line);
    }
    if (hadToken) lines.push(`DISCORD_TOKEN="${token}"`);
  } else {
    lines.push('# pi-cord configuration');
    lines.push(`DISCORD_TOKEN="${token}"`);
  }
  fs.writeFileSync(envPath, lines.join('\n') + '\n', { mode: 0o600 });
}

// --- 2. Interactive setup wizard (only when no token) -----------------------

function boot() {
  require(path.join(projectDir, 'dist', 'index.js'));
}

try {
  require('dotenv').config({ path: envPath });
} catch {
  // dotenv not installed yet (pre-build); fall through to the wizard.
}

if (process.env.PICORD_BOT_TOKEN && !process.env.DISCORD_TOKEN) {
  process.env.DISCORD_TOKEN = process.env.PICORD_BOT_TOKEN;
}

if (process.env.DISCORD_TOKEN) {
  boot();
} else {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('Welcome to pi-cord! Please paste your Discord Bot Token: ', (answer) => {
    rl.close();
    const token = answer.trim();
    if (!token) {
      console.error('No token provided. Exiting.');
      process.exit(1);
    }
    writeTokenToEnv(token);
    process.env.DISCORD_TOKEN = token;
    console.log('Token saved to .env — booting gateway...');
    boot();
  });
}
