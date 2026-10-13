/**
 * SessionManager — direct lifecycle of Pi CLI child processes.
 *
 * One `pi --print --session-id <channel_id>` spawn per prompt; stdout is
 * exposed as an async generator so callers can stream chunks into Discord.
 * Session memory lives in the JSONL files under ~/.pi/agent/sessions/ and
 * is purged with resetSession(). Skills are discovered from SKILL.md files
 * under ~/.pi/agent/skills/.
 */
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface PiStreamOptions {
  /** Pi binary (path or name resolvable via PATH). */
  piBin?: string;
  /** Working directory the Pi process runs in (its workspace). */
  cwd?: string;
  /** Session ID passed as `--session-id` (one per Discord channel/thread). */
  sessionId: string;
  /** The user input / prompt. */
  input: string;
  /** Kill the run after this long (ms). Default 10 minutes. */
  timeoutMs?: number;
  /** SIGTERM-to-SIGKILL grace when the timeout or kill() fires. */
  graceMs?: number;
}

export interface PiStreamHandle {
  /** Streamed stdout chunks as they arrive. */
  stream: AsyncGenerator<string, void, unknown>;
  /** Exit code (null when still running). */
  exitCode: () => number | null;
  /** stderr captured so far (for error headlines). */
  stderr: () => string;
  /**
   * Forcefully terminate the run (SIGKILL after a grace period). Idempotent.
   * The generator settles with whatever was printed before the kill.
   */
  kill(): void;
}

export interface SkillInfo {
  /** Frontmatter `name`, falling back to the parent directory name. */
  name: string;
  /** Frontmatter `description` (may be empty — callers must fall back). */
  description: string;
  /** Absolute path of the SKILL.md file. */
  path: string;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_GRACE_MS = 3000;
const ANSI_RE = /\u001b\[[0-9;]*m/g;
const KILL_GRACE_MS = 2000;

function sessionsRoot(): string {
  return process.env.PI_SESSION_DIR
    ? path.resolve(process.env.PI_SESSION_DIR)
    : path.join(os.homedir(), '.pi', 'agent', 'sessions');
}

function skillsRoot(): string {
  return process.env.PI_SKILLS_DIR
    ? path.resolve(process.env.PI_SKILLS_DIR)
    : path.join(os.homedir(), '.pi', 'agent', 'skills');
}

/**
 * Minimal YAML frontmatter reader for SKILL.md (name/description only —
 * the Agent Skills fields are flat scalars; quoted values are unquoted).
 */
function parseSkillFrontmatter(raw: string): { name?: string; description?: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(name|description):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[kv[1] as 'name' | 'description'] = value;
  }
  return out;
}

export class SessionManager {
  private readonly piBin: string;
  private readonly cwd: string;
  /** Every pi child spawned since boot (shutdown must kill all of them). */
  private readonly children = new Set<ChildProcess>();

  constructor(opts?: { piBin?: string; cwd?: string }) {
    this.piBin = opts?.piBin ?? (process.env.PICORD_PI_BIN?.trim() || 'pi');
    this.cwd = opts?.cwd ?? (process.env.PICORD_PI_CWD?.trim() || process.cwd());
  }

  get workingDirectory(): string {
    return this.cwd;
  }

  /**
   * Spawn `pi --print --session-id <sessionId> <input>` and return a handle
   * whose async generator yields stdout chunks as they arrive.
   */
  spawnPi(opts: PiStreamOptions): PiStreamHandle {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
    const args = ['--print', '--session-id', opts.sessionId, opts.input];

    let child: ChildProcess;
    try {
      // Own process group so kill() takes down pi's tool subprocesses too.
      child = spawn(this.piBin, args, {
        cwd: this.cwd,
        env: { ...process.env },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const e = err as Error;
      throw new Error(`failed to spawn ${this.piBin}: ${e.message}`);
    }

    this.children.add(child);

    let exitCode: number | null = null;
    let stderrBuf = '';
    let killed = false;

    const killGroup = (signal: NodeJS.Signals): void => {
      try {
        process.kill(-child.pid!, signal);
      } catch {
        /* already gone */
      }
    };

    const kill = (): void => {
      if (killed) return;
      killed = true;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS).unref?.();
    };

    // Hard timeout: stop the run when it drags.
    setTimeout(() => {
      if (!killed) {
        kill();
        stderrBuf = `${stderrBuf}\ntimed out after ${Math.round(timeoutMs / 1000)}s`;
      }
    }, timeoutMs).unref?.();

    child.stderr?.on('data', (d: Buffer): void => {
      stderrBuf += d.toString('utf8');
    });
    child.on('error', (err: Error): void => {
      stderrBuf = `${stderrBuf || err.message}`;
    });
    child.on('close', (code: number | null): void => {
      exitCode = code;
      this.children.delete(child);
    });

    const stream = this.makeStream(child);

    return { stream, exitCode: () => exitCode, stderr: () => stderrBuf, kill };
  }

  /**
   * Async generator over the child's stdout. Chunks are split on newlines
   * when possible (never yielding mid-line for text) and ANSI color codes
   * are stripped. The generator settles once stdout ends and the process
   * has closed — including after kill().
   */
  private makeStream(child: ChildProcess): AsyncGenerator<string, void, unknown> {
    const stdout = child.stdout;
    if (!stdout) {
      return (async function* (): AsyncGenerator<string, void, unknown> {
        /* no stdout pipe; nothing to stream */
      })();
    }

    const queue: string[] = [];
    let done = false;
    let notify: (() => void) | undefined;
    const wake = (): void => {
      const n = notify;
      notify = undefined;
      n?.();
    };

    let buf = '';
    stdout.on('data', (d: Buffer): void => {
      buf += d.toString('utf8');
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        queue.push(buf.slice(0, idx + 1));
        buf = buf.slice(idx + 1);
      }
      wake();
    });
    stdout.on('close', (): void => {
      if (buf) {
        queue.push(buf);
        buf = '';
      }
      done = true;
      wake();
    });

    return (async function* (): AsyncGenerator<string, void, unknown> {
      for (;;) {
        while (queue.length > 0) {
          const chunk = queue.shift()!;
          const clean = chunk.replace(ANSI_RE, '');
          if (clean) yield clean;
        }
        if (done) return;
        await new Promise<void>((r) => {
          notify = r;
        });
      }
    })();
  }

  /**
   * Delete the session JSONL files for this session id from
   * ~/.pi/agent/sessions/ (files live in per-cwd subdirectories, so all of
   * them are scanned). Returns the number of files deleted.
   */
  resetSession(id: string): number {
    const root = sessionsRoot();
    let deleted = 0;
    if (!fs.existsSync(root)) return 0;
    let entries: string[];
    try {
      entries = fs.readdirSync(root);
    } catch {
      return 0;
    }
    for (const entry of entries) {
      const dir = path.join(root, entry);
      let files: string[];
      try {
        if (!fs.statSync(dir).isDirectory()) continue;
        files = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        // Session files are `<timestamp>_<sessionId>.jsonl` (or, for custom
        // ids, `<timestamp>_<id>.jsonl`). Match the id as a whole suffix so
        // sibling sessions never collide.
        const base = f.replace(/\.jsonl$/, '');
        const lastUnderscore = base.lastIndexOf('_');
        const fileSessionId = lastUnderscore >= 0 ? base.slice(lastUnderscore + 1) : base;
        if (fileSessionId !== id) continue;
        try {
          fs.unlinkSync(path.join(dir, f));
          deleted++;
        } catch {
          /* concurrent deletion; ignore */
        }
      }
    }
    return deleted;
  }

  /**
   * Discover active skills: every SKILL.md under ~/.pi/agent/skills/
   * (discovered recursively, mirroring Pi's own discovery).
   */
  getLoadedSkills(): SkillInfo[] {
    const root = skillsRoot();
    const out: SkillInfo[] = [];
    if (!fs.existsSync(root)) return out;
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(full);
        } else if (e.isFile() && e.name === 'SKILL.md') {
          let raw = '';
          try {
            raw = fs.readFileSync(full, 'utf8');
          } catch {
            continue;
          }
          const fm = parseSkillFrontmatter(raw);
          const dirName = path.basename(path.dirname(full));
          const name = (fm.name && fm.name.trim()) || dirName;
          out.push({ name, description: (fm.description ?? '').trim(), path: full });
        }
      }
    };
    walk(root);
    return out;
  }

  /** Number of pi children currently running. */
  get runningCount(): number {
    return this.children.size;
  }

  /**
   * Forcefully kill every running pi child process (SIGTERM, then SIGKILL
   * after a grace period). Called on SIGINT/SIGTERM so a stopped bot never
   * leaves orphaned intelligence processes behind. Idempotent.
   */
  killAll(): void {
    for (const child of [...this.children]) {
      try {
        process.kill(-child.pid!, 'SIGTERM');
      } catch {
        try {
          child.kill('SIGTERM');
        } catch {
          /* already gone */
        }
      }
    }
    setTimeout(() => {
      for (const child of [...this.children]) {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }, KILL_GRACE_MS).unref?.();
  }
}
