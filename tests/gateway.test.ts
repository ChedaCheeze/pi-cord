/**
 * Offline integration test: boots the REAL launcher (bin/picord.js ->
 * dist/index.js) against the in-process Discord mock and asserts the full
 * verified loop — connect, command sync (base + skill), streamed DM reply
 * with the 75-char edit throttle, /status defer + editReply, rich presence,
 * thread-archive + thread-delete memory hooks, and graceful SIGTERM shutdown.
 *
 * No token, no network: DISCORD_TOKEN is the mock's fake token and
 * PICORD_API_BASE points at the localhost mock.
 */
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DiscordMock, MOCK_TOKEN, THREAD_ID } from './mock/discord-mock';

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'picord.js');
const FAKE_PI = path.join(ROOT, 'tests', 'mock', 'fake-pi.sh');

// Must stay in sync with tests/mock/fake-pi.sh (one streamed line per chunk).
const FAKE_PI_LINES = [
  'Hello from the fake pi process. This is the first streamed line of the reply, long enough to cross the threshold. \n',
  'Here comes the second line of streamed output. It keeps going so that the gateway edits the message before the very end. \n',
  'And a final line to finish the streamed reply nicely for the test. Thanks for reading all of it. \n',
  'Done. \n',
];
const EXPECTED_REPLY = FAKE_PI_LINES.join('');

async function waitFor(cond: () => boolean, timeoutMs = 30_000, label = 'condition'): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('picord v2 gateway (offline, mocked Discord)', () => {
  let mock: DiscordMock;
  let apiBase: string;
  let child: ChildProcess;
  let logs: string[];
  let tmpDir: string;
  let workDir: string;
  let skillsDir: string;
  let sessionsDir: string;
  let preCreatedSessionFile: string;
  let exited: { code: number | null } | null = null;
  let exitWaiter: ((c: { code: number | null }) => void) | null = null;

  beforeAll(async () => {
    // Scratch dirs: pi workspace, skill discovery, session storage.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picord-v2-test-'));
    workDir = path.join(tmpDir, 'work');
    skillsDir = path.join(tmpDir, 'skills');
    sessionsDir = path.join(tmpDir, 'sessions');
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(path.join(skillsDir, 'myskill'), { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, 'myskill', 'SKILL.md'),
      '---\nname: myskill\ndescription: A test skill for picord integration testing.\n---\n# MySkill\n',
    );

    // Pre-seed a session JSONL for THREAD_ID (simulates a prior in-thread run:
    // files are <timestamp>_<sessionId>.jsonl under a per-cwd subdirectory).
    const slugDir = path.join(sessionsDir, 'work-slug');
    fs.mkdirSync(slugDir, { recursive: true });
    preCreatedSessionFile = path.join(slugDir, `2026-01-01T00-00-00-000Z_${THREAD_ID}.jsonl`);
    fs.writeFileSync(preCreatedSessionFile, '{"type":"message"}\n');

    mock = new DiscordMock();
    apiBase = await mock.start();

    logs = [];
    exited = null;
    child = spawn(process.execPath, [BIN], {
      cwd: ROOT,
      env: {
        ...process.env,
        DISCORD_TOKEN: MOCK_TOKEN,
        PICORD_API_BASE: apiBase,
        PICORD_PI_BIN: FAKE_PI,
        PICORD_PI_CWD: workDir,
        PI_SKILLS_DIR: skillsDir,
        PI_SESSION_DIR: sessionsDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (d: Buffer) => logs.push(d.toString()));
    child.stderr?.on('data', (d: Buffer) => logs.push(d.toString()));
    child.on('close', (code) => {
      exited = { code };
      exitWaiter?.({ code });
      exitWaiter = null;
    });

    await waitFor(() => logs.some((l) => l.includes('connected to Discord as picord-mock#0001')), 30_000, 'gateway connect');
  }, 60_000);

  afterAll(async () => {
    if (child && !exited) {
      child.kill('SIGKILL');
    }
    await mock.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('registers the base commands plus the discovered skill', async () => {
    await waitFor(() => mock.snapshot().commandNames !== null, 15_000, 'command sync (PUT /commands)');
    const names = mock.snapshot().commandNames!;
    expect(names).toEqual(expect.arrayContaining(['clear', 'status', 'model', 'myskill']));
  });

  test('streams the DM reply with the 75-char edit throttle', async () => {
    const snap = () => mock.snapshot();

    // The reply starts as "Thinking..." (a POST create in the DM channel).
    await waitFor(() => snap().creates.some((c) => c.content === 'Thinking...'), 15_000, '"Thinking..." create');
    const replyId = snap().creates.find((c) => c.content === 'Thinking...')!.id;

    // fake-pi emits 4 lines (~330 chars total): with a 75-char throttle that is
    // 3 incremental edits plus one final flush.
    await waitFor(
      () => snap().updates.filter((u) => u.id === replyId).length >= 4,
      30_000,
      'at least 4 edits (3 throttle + 1 flush)',
    );

    const edits = snap().updates.filter((u) => u.id === replyId);
    // Edits grow monotonically (each edit sends the accumulated text so far).
    for (let i = 1; i < edits.length; i++) {
      expect(edits[i].content.length).toBeGreaterThan(edits[i - 1].content.length);
    }
    // Final content is the complete fake-pi output, under Discord's 2000 cap.
    expect(edits[edits.length - 1].content).toBe(EXPECTED_REPLY);
    expect(edits[edits.length - 1].content.length).toBeLessThanOrEqual(2000);

    await waitFor(() => logs.some((l) => l.includes('replied in')), 15_000, 'bot success log');
  });

  test('handles /status: defer within the 3-second window, then editReply', async () => {
    const snap = () => mock.snapshot();
    // deferReply must be the first acknowledgement. In the current
    // discord-api-types enum, DeferredChannelMessageWithSource === 5.
    await waitFor(() => snap().callbackTypes.includes(5), 15_000, 'deferred acknowledgement (type 5)');
    await waitFor(
      () => snap().editReplyBodies.some((b) => b.includes('picord v2 status') && b.includes('myskill')),
      15_000,
      'editReply with status body',
    );
  });

  test('sets rich presence after ready', async () => {
    await waitFor(
      () => mock.snapshot().presenceActivities.some((a) => a.includes('Watching /commands')),
      15_000,
      'presence activity',
    );
  });

  test('clears the local cache when the thread is archived', async () => {
    const ts = new Date().toISOString();
    // type/name must match the cached channel or ChannelUpdate replaces it.
    mock.injectThreadUpdate({
      type: 11,
      name: 'test-thread',
      thread_metadata: {
        archived: true,
        auto_archive_duration: 1440,
        archive_timestamp: ts,
        create_timestamp: ts,
      },
    });
    await waitFor(() => logs.some((l) => l.includes('local cache cleared')), 15_000, 'archive log');
  });

  test('purges the thread session when the thread is deleted', async () => {
    expect(fs.existsSync(preCreatedSessionFile)).toBe(true);
    mock.injectThreadDelete();
    await waitFor(
      () => logs.some((l) => l.includes(`session purged (1 file(s))`)),
      15_000,
      'threadDelete purge log',
    );
    expect(fs.existsSync(preCreatedSessionFile)).toBe(false);
  });

  test('shuts down gracefully on SIGTERM (no zombies, exit 0)', async () => {
    child.kill('SIGTERM');
    await waitFor(() => exited !== null, 15_000, 'process exit');
    expect(exited!.code).toBe(0);
    expect(logs.some((l) => l.includes('shutting down'))).toBe(true);
    expect(logs.some((l) => l.includes('shutdown complete'))).toBe(true);
  });
});
