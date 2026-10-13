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
export declare class SessionManager {
    private readonly piBin;
    private readonly cwd;
    /** Every pi child spawned since boot (shutdown must kill all of them). */
    private readonly children;
    constructor(opts?: {
        piBin?: string;
        cwd?: string;
    });
    get workingDirectory(): string;
    /**
     * Spawn `pi --print --session-id <sessionId> <input>` and return a handle
     * whose async generator yields stdout chunks as they arrive.
     */
    spawnPi(opts: PiStreamOptions): PiStreamHandle;
    /**
     * Async generator over the child's stdout. Chunks are split on newlines
     * when possible (never yielding mid-line for text) and ANSI color codes
     * are stripped. The generator settles once stdout ends and the process
     * has closed — including after kill().
     */
    private makeStream;
    /**
     * Delete the session JSONL files for this session id from
     * ~/.pi/agent/sessions/ (files live in per-cwd subdirectories, so all of
     * them are scanned). Returns the number of files deleted.
     */
    resetSession(id: string): number;
    /**
     * Discover active skills: every SKILL.md under ~/.pi/agent/skills/
     * (discovered recursively, mirroring Pi's own discovery).
     */
    getLoadedSkills(): SkillInfo[];
    /** Number of pi children currently running. */
    get runningCount(): number;
    /**
     * Forcefully kill every running pi child process (SIGTERM, then SIGKILL
     * after a grace period). Called on SIGINT/SIGTERM so a stopped bot never
     * leaves orphaned intelligence processes behind. Idempotent.
     */
    killAll(): void;
}
