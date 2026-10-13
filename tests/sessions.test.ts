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
      '---\nname: test-skill\ndescription: A verification skill for picord v2.\n---\n\n# Test skill\n',
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
    expect(byName['test-skill']?.description).toBe('A verification skill for picord v2.');
    expect(byName['no-desc-skill']?.description).toBe('');
    expect(byName['test-skill']?.path).toBe(path.join(skillsDir, 'test-skill', 'SKILL.md'));
  });

  test('killAll is idempotent and safe when idle', () => {
    expect(mgr.runningCount).toBe(0);
    expect(() => mgr.killAll()).not.toThrow();
    expect(mgr.runningCount).toBe(0);
  });
});
