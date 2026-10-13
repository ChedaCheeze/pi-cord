#!/usr/bin/env node
/**
 * Verification script for SessionManager (stage 2).
 * Tests: stream, kill-mid-run (zombie check), resetSession, getLoadedSkills.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const { SessionManager } = require('./dist/sessions.js');

function pgrepPi() {
  try {
    const out = execSync("pgrep -f 'pi --print --session-id' || true", { encoding: 'utf8' });
    // pgrep -f can match its own shell wrapper, so verify each candidate by
    // reading /proc/<pid>/cmdline (the actual process command).
    return out
      .trim()
      .split('\n')
      .filter(Boolean)
      .filter((pid) => {
        try {
          const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ');
          return cmd.includes('pi --print --session-id');
        } catch {
          return false; // already exited
        }
      });
  } catch {
    return [];
  }
}

function section(name) {
  console.log(`\n=== ${name} ===`);
}

(async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'picord-v2-test-'));
  const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picord-v2-skills-'));
  fs.mkdirSync(path.join(skillsDir, 'test-skill'));
  fs.writeFileSync(
    path.join(skillsDir, 'test-skill', 'SKILL.md'),
    '---\nname: test-skill\ndescription: A verification skill for picord v2 stage 2.\n---\n\n# Test skill\nSay hello.\n',
  );
  // A skill with an EMPTY description (exercises the fallback path).
  fs.mkdirSync(path.join(skillsDir, 'no-desc-skill'));
  fs.writeFileSync(
    path.join(skillsDir, 'no-desc-skill', 'SKILL.md'),
    '---\nname: no-desc-skill\n---\n\n# No description skill\n',
  );
  process.env.PI_SKILLS_DIR = skillsDir;

  const mgr = new SessionManager({ cwd });
  let failures = 0;
  const check = (cond, label) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}`);
    if (!cond) failures++;
  };

  // --- 1. Streaming ---------------------------------------------------------
  section('1. stream a real pi run');
  const handle = mgr.spawnPi({ sessionId: 'picord-v2-verify', input: 'Reply with exactly: ok' });
  let collected = '';
  let chunkCount = 0;
  for await (const chunk of handle.stream) {
    chunkCount++;
    collected += chunk;
  }
  // The 'close' event can land a tick after stdout ends; give it a beat.
  await new Promise((r) => setTimeout(r, 500));
  check(handle.exitCode() === 0, `exit code 0 (got ${handle.exitCode()})`);
  check(collected.includes('ok'), `stream yielded the answer (chunks=${chunkCount}): ${JSON.stringify(collected.trim())}`);
  check(mgr.runningCount === 0, `no live children after completion (got ${mgr.runningCount})`);

  // --- 2. Kill mid-run, zombie check ----------------------------------------
  section('2. kill mid-run (zombie prevention)');
  const slow = mgr.spawnPi({
    sessionId: 'picord-v2-verify',
    input: 'Write a very long essay about the history of lighthouses, at least 2000 words.',
  });
  await new Promise((r) => setTimeout(r, 5000));
  check(mgr.runningCount === 1, `child is live mid-run (got ${mgr.runningCount})`);
  slow.kill();
  await new Promise((r) => setTimeout(r, 4000));
  check(mgr.runningCount === 0, `child removed from pool after kill (got ${mgr.runningCount})`);
  let leftovers = pgrepPi();
  if (leftovers.length > 0) {
    // SIGKILL escalation window: give the group one more grace before failing.
    await new Promise((r) => setTimeout(r, 4000));
    leftovers = pgrepPi();
  }
  check(leftovers.length === 0, `no orphaned pi processes (found: ${leftovers.join(',') || 'none'})`);

  // --- 3. resetSession ------------------------------------------------------
  section('3. resetSession deletes the JSONL');
  const sessionsRoot = path.join(os.homedir(), '.pi', 'agent', 'sessions');
  const findSessionFiles = (id) => {
    const out = [];
    for (const entry of fs.readdirSync(sessionsRoot)) {
      const dir = path.join(sessionsRoot, entry);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const f of fs.readdirSync(dir)) {
        const base = f.replace(/\.jsonl$/, '');
        const sid = base.slice(base.lastIndexOf('_') + 1);
        if (sid === id) out.push(path.join(dir, f));
      }
    }
    return out;
  };
  const before = findSessionFiles('picord-v2-verify');
  check(before.length >= 1, `session JSONL exists before reset (${before.length} file(s))`);
  const deleted = mgr.resetSession('picord-v2-verify');
  const after = findSessionFiles('picord-v2-verify');
  check(deleted === before.length, `resetSession deleted ${deleted} of ${before.length} file(s)`);
  check(after.length === 0, `no JSONL left after reset`);
  const otherSessions = fs.readdirSync(sessionsRoot).filter((e) => e.includes('--home-local-projects-PI-UI'));
  check(otherSessions.length > 0, 'other sessions untouched (PI-UI dirs still present)');

  // --- 4. getLoadedSkills ----------------------------------------------------
  section('4. getLoadedSkills parses SKILL.md');
  const skills = mgr.getLoadedSkills();
  const byName = Object.fromEntries(skills.map((s) => [s.name, s]));
  check(skills.length === 2, `found 2 skills (got ${skills.length}: ${skills.map((s) => s.name).join(', ')})`);
  check(byName['test-skill']?.description === 'A verification skill for picord v2 stage 2.', 'frontmatter description parsed');
  check(byName['no-desc-skill']?.description === '', 'empty description stays empty (caller falls back to name)');
  check(byName['test-skill']?.path.endsWith(path.join('test-skill', 'SKILL.md')), 'skill path recorded');

  // --- 5. killAll ------------------------------------------------------------
  section('5. killAll is idempotent and safe when idle');
  mgr.killAll();
  check(mgr.runningCount === 0, `killAll with no children is a no-op`);

  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(skillsDir, { recursive: true, force: true });
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
