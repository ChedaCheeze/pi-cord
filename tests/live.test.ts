/**
 * Opt-in live integration test: connects the real bot to Discord using the
 * real DISCORD_TOKEN (from the environment or v2/.env) and verifies the
 * gateway login (READY + bot user), then disconnects cleanly.
 *
 * Skips automatically when no token is present, so `npm test` stays green on
 * a clean clone. Run explicitly with:  npm run test:live
 */
import { Client, GatewayIntentBits } from 'discord.js';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

// Conditional registration: skips the whole suite (visible as "skipped")
// when no token is present.
const describeLive = process.env.DISCORD_TOKEN ? describe : describe.skip;

describeLive('Discord Gateway Live Test', () => {
  let client: Client;

  beforeAll(() => {
    client = new Client({ intents: [GatewayIntentBits.Guilds] });
  });

  afterAll(async () => {
    await client.destroy();
  });

  it('logs in as a real bot and receives READY', async () => {
    const token = process.env.DISCORD_TOKEN;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for READY (30s)')), 30_000);
      client.once('ready', () => {
        clearTimeout(timer);
        expect(client.user?.bot).toBe(true);
        resolve();
      });
      client.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      client.login(token).catch(reject);
    });
  }, 35_000);
});
