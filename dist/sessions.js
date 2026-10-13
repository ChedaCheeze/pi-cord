"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionManager = void 0;
/**
 * SessionManager — direct lifecycle of Pi CLI child processes.
 *
 * One `pi --print --session-id <channel_id>` spawn per prompt; stdout is
 * exposed as an async generator so callers can stream chunks into Discord.
 * Session memory lives in the JSONL files under ~/.pi/agent/sessions/ and
 * is purged with resetSession(). Skills are discovered from SKILL.md files
 * under ~/.pi/agent/skills/.
 */
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_GRACE_MS = 3000;
const ANSI_RE = /\u001b\[[0-9;]*m/g;
const KILL_GRACE_MS = 2000;
function sessionsRoot() {
    return process.env.PI_SESSION_DIR
        ? path.resolve(process.env.PI_SESSION_DIR)
        : path.join(os.homedir(), '.pi', 'agent', 'sessions');
}
function skillsRoot() {
    return process.env.PI_SKILLS_DIR
        ? path.resolve(process.env.PI_SKILLS_DIR)
        : path.join(os.homedir(), '.pi', 'agent', 'skills');
}
/**
 * Minimal YAML frontmatter reader for SKILL.md (name/description only —
 * the Agent Skills fields are flat scalars; quoted values are unquoted).
 */
function parseSkillFrontmatter(raw) {
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m)
        return {};
    const out = {};
    for (const line of m[1].split(/\r?\n/)) {
        const kv = line.match(/^(name|description):\s*(.*)$/);
        if (!kv)
            continue;
        let value = kv[2].trim();
        if (value.length >= 2 &&
            ((value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'")))) {
            value = value.slice(1, -1);
        }
        out[kv[1]] = value;
    }
    return out;
}
class SessionManager {
    piBin;
    cwd;
    /** Every pi child spawned since boot (shutdown must kill all of them). */
    children = new Set();
    constructor(opts) {
        this.piBin = opts?.piBin ?? (process.env.PICORD_PI_BIN?.trim() || 'pi');
        this.cwd = opts?.cwd ?? (process.env.PICORD_PI_CWD?.trim() || process.cwd());
    }
    get workingDirectory() {
        return this.cwd;
    }
    /**
     * Spawn `pi --print --session-id <sessionId> <input>` and return a handle
     * whose async generator yields stdout chunks as they arrive.
     */
    spawnPi(opts) {
        const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
        const args = ['--print', '--session-id', opts.sessionId, opts.input];
        let child;
        try {
            // Own process group so kill() takes down pi's tool subprocesses too.
            child = (0, child_process_1.spawn)(this.piBin, args, {
                cwd: this.cwd,
                env: { ...process.env },
                detached: true,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        }
        catch (err) {
            const e = err;
            throw new Error(`failed to spawn ${this.piBin}: ${e.message}`);
        }
        this.children.add(child);
        let exitCode = null;
        let stderrBuf = '';
        let killed = false;
        const killGroup = (signal) => {
            try {
                process.kill(-child.pid, signal);
            }
            catch {
                /* already gone */
            }
        };
        const kill = () => {
            if (killed)
                return;
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
        child.stderr?.on('data', (d) => {
            stderrBuf += d.toString('utf8');
        });
        child.on('error', (err) => {
            stderrBuf = `${stderrBuf || err.message}`;
        });
        child.on('close', (code) => {
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
    makeStream(child) {
        const stdout = child.stdout;
        if (!stdout) {
            return (async function* () {
                /* no stdout pipe; nothing to stream */
            })();
        }
        const queue = [];
        let done = false;
        let notify;
        const wake = () => {
            const n = notify;
            notify = undefined;
            n?.();
        };
        let buf = '';
        stdout.on('data', (d) => {
            buf += d.toString('utf8');
            let idx;
            while ((idx = buf.indexOf('\n')) >= 0) {
                queue.push(buf.slice(0, idx + 1));
                buf = buf.slice(idx + 1);
            }
            wake();
        });
        stdout.on('close', () => {
            if (buf) {
                queue.push(buf);
                buf = '';
            }
            done = true;
            wake();
        });
        return (async function* () {
            for (;;) {
                while (queue.length > 0) {
                    const chunk = queue.shift();
                    const clean = chunk.replace(ANSI_RE, '');
                    if (clean)
                        yield clean;
                }
                if (done)
                    return;
                await new Promise((r) => {
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
    resetSession(id) {
        const root = sessionsRoot();
        let deleted = 0;
        if (!fs.existsSync(root))
            return 0;
        let entries;
        try {
            entries = fs.readdirSync(root);
        }
        catch {
            return 0;
        }
        for (const entry of entries) {
            const dir = path.join(root, entry);
            let files;
            try {
                if (!fs.statSync(dir).isDirectory())
                    continue;
                files = fs.readdirSync(dir);
            }
            catch {
                continue;
            }
            for (const f of files) {
                if (!f.endsWith('.jsonl'))
                    continue;
                // Session files are `<timestamp>_<sessionId>.jsonl` (or, for custom
                // ids, `<timestamp>_<id>.jsonl`). Match the id as a whole suffix so
                // sibling sessions never collide.
                const base = f.replace(/\.jsonl$/, '');
                const lastUnderscore = base.lastIndexOf('_');
                const fileSessionId = lastUnderscore >= 0 ? base.slice(lastUnderscore + 1) : base;
                if (fileSessionId !== id)
                    continue;
                try {
                    fs.unlinkSync(path.join(dir, f));
                    deleted++;
                }
                catch {
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
    getLoadedSkills() {
        const root = skillsRoot();
        const out = [];
        if (!fs.existsSync(root))
            return out;
        const walk = (dir) => {
            let entries;
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            }
            catch {
                return;
            }
            for (const e of entries) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) {
                    walk(full);
                }
                else if (e.isFile() && e.name === 'SKILL.md') {
                    let raw = '';
                    try {
                        raw = fs.readFileSync(full, 'utf8');
                    }
                    catch {
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
    get runningCount() {
        return this.children.size;
    }
    /**
     * Forcefully kill every running pi child process (SIGTERM, then SIGKILL
     * after a grace period). Called on SIGINT/SIGTERM so a stopped bot never
     * leaves orphaned intelligence processes behind. Idempotent.
     */
    killAll() {
        for (const child of [...this.children]) {
            try {
                process.kill(-child.pid, 'SIGTERM');
            }
            catch {
                try {
                    child.kill('SIGTERM');
                }
                catch {
                    /* already gone */
                }
            }
        }
        setTimeout(() => {
            for (const child of [...this.children]) {
                try {
                    process.kill(-child.pid, 'SIGKILL');
                }
                catch {
                    /* already gone */
                }
            }
        }, KILL_GRACE_MS).unref?.();
    }
}
exports.SessionManager = SessionManager;
