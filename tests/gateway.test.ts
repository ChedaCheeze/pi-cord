/**
 * Offline integration test: boots the REAL launcher (bin/picord.js ->
 * dist/index.js) against the in-process Discord mock and asserts the full
 * verified loop — connect, command sync (base + skill), streamed DM reply
 * with the 75-char edit throttle, /status defer + editReply, no-presence,
 * thread-archive + thread-delete memory hooks, and graceful SIGTERM shutdown.
 *
 * No token, no network: DISCORD_TOKEN is the mock's fake token and
 * PICORD_API_BASE points at the localhost mock.
 */
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DiscordMock, DM_CHANNEL_ID, MOCK_TOKEN, THREAD_ID } from './mock/discord-mock';

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
  let argsFile: string;
  let preCreatedSessionFile: string;
  let exited: { code: number | null } | null = null;
  let exitWaiter: ((c: { code: number | null }) => void) | null = null;

  beforeAll(async () => {
    // Scratch dirs: pi workspace, skill discovery, session storage.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picord-v2-test-'));
    workDir = path.join(tmpDir, 'work');
    skillsDir = path.join(tmpDir, 'skills');
    sessionsDir = path.join(tmpDir, 'sessions');
    argsFile = path.join(tmpDir, 'pi-args.log');
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
        FAKE_PI_ARGS_FILE: argsFile,
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
    if (process.env.DUMP_BOT_LOGS) {
      process.stdout.write('\n=== BOT LOGS ===\n');
      for (const l of logs) process.stdout.write(l);
    }
    await mock.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('registers the base commands plus the discovered skill', async () => {
    await waitFor(() => mock.snapshot().commandNames !== null, 15_000, 'command sync (PUT /commands)');
    const names = mock.snapshot().commandNames!;
    expect(names).toEqual(
      expect.arrayContaining(['clear', 'new', 'stop', 'status', 'thinking', 'model', 'resume', 'help', 'myskill']),
    );
  });

  /** fake-pi argv log: one run per entry, args in order. */
  const readRuns = (): string[][] =>
    fs
      .existsSync(argsFile)
      ? fs
          .readFileSync(argsFile, 'utf8')
          .split('\n\n')
          .map((s) => s.split('\n').filter(Boolean))
          .filter((run) => run.length > 0)
      : [];

  const pgrepRunning = (marker: string): boolean => {
    const r = spawnSync('pgrep', ['-f', marker], { encoding: 'utf8' });
    return r.status === 0 && r.stdout.trim().length > 0;
  };

  /** Inject a chat-input command interaction in the DM channel. */
  const injectChat = (name: string, options: Record<string, unknown>[] = []): void => {
    mock.injectInteraction(2, {
      id: `cmd-${name}`,
      name,
      type: 1,
      options,
      target_id: null,
      resolved: {},
    });
  };

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

  test('answers /help with the command list', async () => {
    const snap = () => mock.snapshot();
    const before = snap().editReplyBodies.length;
    injectChat('help');
    await waitFor(
      () => snap().editReplyBodies.slice(before).some((b) => b.includes('/stop') && b.includes('/resume')),
      15_000,
      'help reply',
    );
  });

  test('/new clears the channel session files', async () => {
    // DMs share the single 'dm' session key (see the gateway's DM routing).
    const slugDir = path.join(sessionsDir, 'work-slug');
    const file = path.join(slugDir, '2026-02-01T00-00-00-000Z_dm.jsonl');
    fs.writeFileSync(file, '{"type":"message"}\n');
    const before = mock.snapshot().editReplyBodies.length;
    injectChat('new');
    await waitFor(
      () => mock.snapshot().editReplyBodies.slice(before).some((b) => b.includes('New session started')),
      15_000,
      '/new confirmation',
    );
    expect(fs.existsSync(file)).toBe(false);
  });

  test('/thinking picker: menu -> pick -> next run gets --thinking', async () => {
    const snap = () => mock.snapshot();
    const menusBefore = snap().menuCustomIds.length;
    injectChat('thinking');
    await waitFor(() => snap().menuCustomIds.length > menusBefore, 15_000, 'thinking menu attached');
    const customId = snap().menuCustomIds[menusBefore];
    expect(snap().menuLabels).toEqual(expect.arrayContaining(['xhigh', 'off']));

    mock.injectSelectMenu(customId, 'xhigh');
    await waitFor(
      () => snap().callbackContents.some((c) => c.includes('Thinking level set to **xhigh**')),
      15_000,
      'picker confirmation',
    );

    const runsBefore = readRuns().length;
    mock.injectDM('probe-one after thinking pick');
    await waitFor(() => readRuns().length > runsBefore, 30_000, 'next run spawned');
    expect(readRuns().slice(-1)[0]).toEqual(expect.arrayContaining(['--thinking', 'xhigh']));
  });

  test('/model picker: lists models from pi, applies the choice', async () => {
    const snap = () => mock.snapshot();
    const menusBefore = snap().menuCustomIds.length;
    injectChat('model');
    await waitFor(() => snap().menuCustomIds.length > menusBefore, 15_000, 'model menu attached');
    expect(snap().menuLabels.some((l) => l.startsWith('llama.cpp/fake/Model-A'))).toBe(true);
    expect(snap().menuLabels.some((l) => l.startsWith('llama.cpp/fake/Model-B'))).toBe(true);

    mock.injectSelectMenu(snap().menuCustomIds[menusBefore], 'llama.cpp/fake/Model-B');
    await waitFor(
      () => snap().callbackContents.some((c) => c.includes('Model set to') && c.includes('llama.cpp/fake/Model-B')),
      15_000,
      'model confirmation',
    );

    const runsBefore = readRuns().length;
    mock.injectDM('probe-two after model pick');
    await waitFor(() => readRuns().length > runsBefore, 30_000, 'next run spawned');
    expect(readRuns().slice(-1)[0]).toEqual(expect.arrayContaining(['--model', 'llama.cpp/fake/Model-B']));
  });

  test('/resume picker: labels by first user message, attaches on pick', async () => {
    const slugDir = path.join(sessionsDir, 'work-slug');
    const mkSession = (sid: string, firstMsg: string, ts: string): void => {
      fs.writeFileSync(
        path.join(slugDir, `${ts}_${sid}.jsonl`),
        [
          `{"type":"session","id":"${sid}","timestamp":"${ts}","cwd":"${workDir}"}`,
          `{"type":"message","id":"m-${sid}","message":{"role":"user","content":"${firstMsg}"}}`,
        ].join('\n') + '\n',
      );
    };
    mkSession('aaaa1111-aaaa-aaaa-aaaa-aaaaaaaaaaa1', 'old question about testing', '2026-03-01T00-00-00-000Z');
    const newSid = 'bbbb2222-bbbb-bbbb-bbbb-bbbbbbbbbbb2';
    mkSession(newSid, 'brand new session probe', '2026-04-01T00-00-00-000Z');

    const snap = () => mock.snapshot();
    const menusBefore = snap().menuCustomIds.length;
    injectChat('resume');
    await waitFor(() => snap().menuCustomIds.length > menusBefore, 15_000, 'resume menu attached');
    expect(snap().menuLabels.some((l) => l.includes('brand new session probe'))).toBe(true);
    expect(snap().menuLabels.some((l) => l.includes('old question about testing'))).toBe(true);

    mock.injectSelectMenu(snap().menuCustomIds[menusBefore], newSid);
    await waitFor(
      () => snap().callbackContents.some((c) => c.includes(newSid) && c.includes('attached')),
      15_000,
      'resume confirmation',
    );

    const runsBefore = readRuns().length;
    mock.injectDM('probe-three continue resumed session');
    await waitFor(() => readRuns().length > runsBefore, 30_000, 'next run spawned');
    const run = readRuns().slice(-1)[0];
    expect(run).toEqual(expect.arrayContaining(['--session', newSid]));
    expect(run).not.toContain('--session-id');
  });

  test('/stop kills a live run mid-flight (Esc equivalent)', async () => {
    const snap = () => mock.snapshot();
    const createsBefore = snap().creates.length;
    mock.injectDM('run the slow probe stop-probe-slow');
    await waitFor(() => snap().creates.length > createsBefore, 15_000, 'probe reply created');
    await new Promise((r) => setTimeout(r, 500)); // let the run get a head start

    const bodiesBefore = snap().editReplyBodies.length;
    injectChat('stop');
    // The count is 1+ — earlier tests' DM runs may still be live in the same
    // shared 'dm' session.
    await waitFor(
      () => snap().editReplyBodies.slice(bodiesBefore).some((b) => /Stopped \d+ pi run\(s\)/.test(b)),
      15_000,
      '/stop confirmation',
    );
    // The streamed reply message gets the stopped marker (partial output kept).
    await waitFor(() => snap().updates.some((u) => u.content.includes('*stopped*')), 15_000, 'stopped marker edit');
    // The fake pi process must be dead (SIGTERM -> SIGKILL grace, 2s).
    await waitFor(() => !pgrepRunning('stop-probe-slow'), 10_000, 'fake-pi killed');
  });

  test('sets no rich presence (status stays clean)', async () => {
    // Once the gateway is up (commands synced) and a beat has passed for any
    // (unexpected) presence op to arrive, none may have been sent.
    await waitFor(
      () => (mock.snapshot().commandNames?.length ?? 0) > 0,
      15_000,
      'commands synced',
    );
    await new Promise((r) => setTimeout(r, 1500));
    expect(mock.snapshot().presenceActivities).toEqual([]);
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
