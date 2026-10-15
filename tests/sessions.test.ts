/**
 * SessionManager unit tests — the checks from verify-sessions.js, promoted
 * into the jest suite and made hermetic: the real `pi` binary and the real
 * ~/.pi/agent/sessions are replaced by tests/mock/fake-pi.sh and a
 * temporary PI_SESSION_DIR / PI_SKILLS_DIR, so the suite runs offline with
 * no model server and never touches real session files.
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionManager } from '../src/sessions';

const ROOT = path.resolve(__dirname, '..');
const FAKE_PI = path.join(ROOT, 'tests', 'mock', 'fake-pi.sh');
/** Unique marker so the orphan check never matches this test's own shell. */
const ORPHAN_MARKER = 'picord-orphan-probe';

function orphanPids(): string[] {
  try {
    // Bracket trick: the pattern matches the marker but not its own
    // literal occurrence inside the pgrep/sh command line.
    const out = execSync(`pgrep -f 'picord-orphan[-]probe' || true`, { encoding: 'utf8' });
    return out
      .trim()
      .split('\n')
      .filter(Boolean)
      .filter((pid) => {
        try {
          return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').includes(ORPHAN_MARKER);
        } catch {
          return false; // already exited
        }
      });
  } catch {
    return [];
  }
}

async function waitFor(cond: () => boolean, timeoutMs = 15_000, label = 'condition'): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('SessionManager', () => {
  let tmpDir: string;
  let workDir: string;
  let skillsDir: string;
  let sessionsDir: string;
  let mgr: SessionManager;
  const savedEnv: { skills?: string; sessions?: string } = {};

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picord-v2-sessions-'));
    workDir = path.join(tmpDir, 'work');
    skillsDir = path.join(tmpDir, 'skills');
    sessionsDir = path.join(tmpDir, 'sessions');
    fs.mkdirSync(workDir, { recursive: true });

    // Skills: one with a description, one with an empty description.
    fs.mkdirSync(path.join(skillsDir, 'test-skill'), { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, 'test-skill', 'SKILL.md'),
      '---\nname: test-skill\ndescription: A verification skill for pi-cord.\n---\n\n# Test skill\n',
    );
    fs.mkdirSync(path.join(skillsDir, 'no-desc-skill'), { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, 'no-desc-skill', 'SKILL.md'),
      '---\nname: no-desc-skill\n---\n\n# No description skill\n',
    );

    // Session store: files live in per-cwd subdirectories as
    // <timestamp>_<sessionId>.jsonl.
    fs.mkdirSync(path.join(sessionsDir, 'slug-a'), { recursive: true });
    fs.mkdirSync(path.join(sessionsDir, 'slug-b'), { recursive: true });

    savedEnv.skills = process.env.PI_SKILLS_DIR;
    savedEnv.sessions = process.env.PI_SESSION_DIR;
    process.env.PI_SKILLS_DIR = skillsDir;
    process.env.PI_SESSION_DIR = sessionsDir;

    mgr = new SessionManager({ piBin: FAKE_PI, cwd: workDir });
  });

  afterAll(() => {
    mgr.killAll();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k as 'PI_SKILLS_DIR'];
      else process.env[k as 'PI_SKILLS_DIR'] = v;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('streams a pi run: chunks arrive, exit code 0, no live children after', async () => {
    const handle = mgr.spawnPi({ sessionId: 'unit-test-stream', input: 'stream me' });
    let collected = '';
    let chunkCount = 0;
    for await (const chunk of handle.stream) {
      chunkCount++;
      collected += chunk;
    }
    // The 'close' event can land a tick after stdout ends; give it a beat.
    await new Promise((r) => setTimeout(r, 300));
    expect(handle.exitCode()).toBe(0);
    expect(chunkCount).toBeGreaterThanOrEqual(2);
    expect(collected).toContain('Hello from the fake pi process');
    expect(collected.trim().endsWith('Done.')).toBe(true);
    expect(mgr.runningCount).toBe(0);
  }, 30_000);

  test('kill mid-run terminates the whole process group (no orphans)', async () => {
    // fake-pi runs ~2s total (3 x 0.5s sleeps); kill it mid-run.
    const slow = mgr.spawnPi({ sessionId: 'unit-test-kill', input: ORPHAN_MARKER });
    await new Promise((r) => setTimeout(r, 300));
    expect(mgr.runningCount).toBe(1);

    slow.kill();
    await waitFor(() => mgr.runningCount === 0, 10_000, 'child removed from pool after kill');
    // SIGTERM->SIGKILL escalation is 2s; wait past it before probing.
    await new Promise((r) => setTimeout(r, 2500));
    expect(orphanPids()).toEqual([]);
  }, 30_000);

  test('resetSession deletes only the matching session files', () => {
    const a = path.join(sessionsDir, 'slug-a');
    const b = path.join(sessionsDir, 'slug-b');
    const target1 = path.join(a, '2026-01-01T00-00-00-000Z_ses-abc.jsonl');
    const target2 = path.join(b, '2026-01-02T00-00-00-000Z_ses-abc.jsonl');
    const sibling = path.join(a, '2026-01-01T00-00-00-000Z_ses-xyz.jsonl');
    // "abc" is a different session id — must NOT be deleted by 'ses-abc'.
    const prefixCollision = path.join(a, '2026-01-01T00-00-01-000Z_abc.jsonl');
    for (const f of [target1, target2, sibling, prefixCollision]) fs.writeFileSync(f, '{}\n');

    const deleted = mgr.resetSession('ses-abc');
    expect(deleted).toBe(2);
    expect(fs.existsSync(target1)).toBe(false);
    expect(fs.existsSync(target2)).toBe(false);
    expect(fs.existsSync(sibling)).toBe(true);
    expect(fs.existsSync(prefixCollision)).toBe(true);
  });

  test('getLoadedSkills parses SKILL.md frontmatter recursively', () => {
    const skills = mgr.getLoadedSkills();
    const byName = Object.fromEntries(skills.map((s) => [s.name, s]));
    expect(skills).toHaveLength(2);
    expect(byName['test-skill']?.description).toBe('A verification skill for pi-cord.');
    expect(byName['no-desc-skill']?.description).toBe('');
    expect(byName['test-skill']?.path).toBe(path.join(skillsDir, 'test-skill', 'SKILL.md'));
  });

  test('killAll is idempotent and safe when idle', () => {
    expect(mgr.runningCount).toBe(0);
    expect(() => mgr.killAll()).not.toThrow();
    expect(mgr.runningCount).toBe(0);
  });

  test('listSessions: newest-first, first-user-message labels, dedupe by id', () => {
    const dirA = path.join(sessionsDir, 'slug-a');
    const dirB = path.join(sessionsDir, 'slug-b');
    const mk = (dir: string, sid: string, ts: string, firstMsg: string | undefined, mtimeSec: number): void => {
      const lines = [`{"type":"session","id":"${sid}"}`];
      if (firstMsg) {
        lines.push(`{"type":"message","id":"m1","message":{"role":"user","content":"${firstMsg}"}}`);
      }
      const f = path.join(dir, `${ts}_${sid}.jsonl`);
      fs.writeFileSync(f, lines.join('\n') + '\n');
      fs.utimesSync(f, mtimeSec, mtimeSec);
    };
    // The shared session store also holds files from earlier tests (written
    // at "now"), so the newest-seeded session gets a future mtime to stay
    // deterministically on top.
    const now = Math.floor(Date.now() / 1000);
    mk(dirA, 'old-sess', '2026-01-01T00-00-00-000Z', 'the old question', 1700000000);
    mk(dirA, 'new-sess', '2026-05-01T00-00-00-000Z', 'the new question', 1750000000);
    // Same id in two dirs: the newer mtime wins.
    mk(dirA, 'dup-sess', '2026-02-01T00-00-00-000Z', undefined, 1710000000);
    mk(dirB, 'dup-sess', '2026-06-01T00-00-00-000Z', 'the dup question', now + 3600);

    const list = mgr.listSessions(25);
    const ids = list.map((s) => s.id);
    expect(ids.filter((id) => id === 'dup-sess')).toHaveLength(1);
    expect(list.find((s) => s.id === 'dup-sess')?.label).toBe('the dup question');
    expect(ids.indexOf('dup-sess')).toBeLessThan(ids.indexOf('new-sess'));
    expect(ids.indexOf('new-sess')).toBeLessThan(ids.indexOf('old-sess'));
    expect(list.find((s) => s.id === 'new-sess')?.label).toBe('the new question');
    expect(list.find((s) => s.id === 'old-sess')?.label).toBe('the old question');
    expect(mgr.listSessions(1)).toHaveLength(1);
    expect(mgr.listSessions(1)[0].id).toBe('dup-sess');
  });

  test('listModels parses the pi --list-models table', () => {
    const models = mgr.listModels();
    expect(models.map((m) => m.id)).toEqual(['llama.cpp/fake/Model-A', 'llama.cpp/fake/Model-B']);
    expect(models[0].provider).toBe('llama.cpp');
    expect(models[0].context).toBe('131.0K');
    expect(models[1].images).toBe('yes');
  });

  test('spawn args honor thinking/model/attachment overrides, default otherwise', async () => {
    const argLog = path.join(tmpDir, 'spawn-args.log');
    process.env.FAKE_PI_ARGS_FILE = argLog;
    try {
      mgr.setThinking('unit-think', 'low');
      mgr.setModel('unit-model', 'llama.cpp/fake/Model-B');
      mgr.attachSession('unit-attach', 'attached-sid-123');

      const drain = async (sessionId: string, input: string): Promise<void> => {
        const h = mgr.spawnPi({ sessionId, input });
        for await (const _ of h.stream) {
          /* drain */
        }
        await new Promise((r) => setTimeout(r, 200));
      };
      await drain('unit-think', 'think probe');
      await drain('unit-model', 'model probe');
      await drain('unit-attach', 'attach probe');
      await drain('unit-plain', 'plain probe');

      const runs = fs
        .readFileSync(argLog, 'utf8')
        .split('\n\n')
        .map((s) => s.split('\n').filter(Boolean))
        .filter((r) => r.length > 0);
      expect(runs).toHaveLength(4);
      expect(runs[0]).toEqual(['--print', '--thinking', 'low', '--session-id', 'unit-think', 'think probe']);
      expect(runs[1]).toEqual([
        '--print',
        '--model',
        'llama.cpp/fake/Model-B',
        '--session-id',
        'unit-model',
        'model probe',
      ]);
      // Attached session replaces --session-id entirely.
      expect(runs[2]).toEqual(['--print', '--session', 'attached-sid-123', 'attach probe']);
      expect(runs[2]).not.toContain('--session-id');
      expect(runs[3]).toEqual(['--print', '--session-id', 'unit-plain', 'plain probe']);

      // Cleanup: per-channel overrides are forgettable.
      mgr.forget('unit-think');
      expect(mgr.thinkingFor('unit-think')).toBeUndefined();
      mgr.detachSession('unit-attach');
      expect(mgr.attachedFor('unit-attach')).toBeUndefined();
    } finally {
      delete process.env.FAKE_PI_ARGS_FILE;
    }
  }, 60_000);

  test('abortSession kills every live run for a channel and reports the count', async () => {
    const h = mgr.spawnPi({ sessionId: 'unit-abort', input: 'abort probe' });
    await new Promise((r) => setTimeout(r, 300));
    expect(mgr.runningCount).toBe(1);
    expect(mgr.abortSession('unit-abort')).toBe(1);
    await waitFor(() => mgr.runningCount === 0, 10_000, 'run aborted');
    expect(h.killed()).toBe(true);
    expect(mgr.abortSession('unit-abort')).toBe(0);
    expect(mgr.abortSession('unit-nobody-home')).toBe(0);
  }, 30_000);
});
