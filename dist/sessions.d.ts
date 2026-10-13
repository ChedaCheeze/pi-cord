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
    /** Exit code (null when still running or killed). */
    exitCode: () => number | null;
    /** stderr captured so far (for error headlines). */
    stderr: () => string;
    /**
     * Forcefully terminate the run (SIGKILL after a grace period). Idempotent.
     * The generator settles with whatever was printed before the kill.
     */
    kill(): void;
    /** True once kill() (or the hard timeout) has fired. */
    killed: () => boolean;
}
/** Thinking levels accepted by `pi --thinking` (used for validation + pickers). */
export declare const THINKING_LEVELS: readonly ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
/** A saved pi session (from listSessions), for the /resume picker. */
export interface SessionInfo {
    /** Session id (the JSONL suffix after the last underscore). */
    id: string;
    /** Last-modified time of the (newest) file for this id. */
    mtime: Date;
    /** Size in bytes of that file. */
    size: number;
    /** First user message text (truncated to 80 chars), '' when unreadable. */
    label: string;
}
/** A model row from `pi --list-models`, for the /model picker. */
export interface ModelInfo {
    /** `provider/id` pattern — exactly what `pi --model <pattern>` accepts. */
    id: string;
    provider: string;
    context: string;
    thinking: string;
    images: string;
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
    /** Live runs per session id (for abortSession / /stop). */
    private readonly running;
    /** Per-channel overrides (in-memory: a bot restart resets them). */
    private readonly thinkingBySession;
    private readonly modelBySession;
    /** Channel → attached pi session id (set by /resume; replaces --session-id). */
    private readonly attachedByChannel;
    /** Cache for listModels() — `pi --list-models` startup is not free. */
    private modelCache;
    constructor(opts?: {
        piBin?: string;
        cwd?: string;
    });
    get workingDirectory(): string;
    /**
     * Spawn `pi --print [--thinking <level>] [--model <pattern>]
     * (--session <attached> | --session-id <sessionId>) <input>` and return a
     * handle whose async generator yields stdout chunks as they arrive.
     * Per-channel overrides (thinking, model, attached session) are applied
     * automatically from their setters.
     */
    spawnPi(opts: PiStreamOptions): PiStreamHandle;
    /**
     * Abort every live pi run for this session id (the /stop command — the
     * Esc equivalent). SIGTERM now, SIGKILL after the grace period. Returns
     * the number of runs aborted (0 when nothing was running).
     */
    abortSession(sessionId: string): number;
    setThinking(sessionId: string, level: string): void;
    thinkingFor(sessionId: string): string | undefined;
    setModel(sessionId: string, pattern: string): void;
    modelFor(sessionId: string): string | undefined;
    /** Attach an existing pi session to this channel (next spawn uses `--session <id>`). */
    attachSession(channelId: string, sessionId: string): void;
    attachedFor(channelId: string): string | undefined;
    detachSession(channelId: string): void;
    /** Drop all per-channel state for a vanished place (thread deleted). */
    forget(sessionId: string): void;
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
     * Saved pi sessions, newest first (the /resume picker). Scans all per-cwd
     * subdirectories of the session store; when one session id has several
     * timestamped files (recreated after /clear), only its newest counts.
     * Labels are the session's first user message, when readable.
     */
    listSessions(limit?: number): SessionInfo[];
    /**
     * Available models from `pi --list-models` (the /model picker). Runs the
     * real pi binary synchronously; results are cached for 5 minutes. Returns
     * [] when the list cannot be produced (callers fall back to a hint).
     */
    listModels(): ModelInfo[];
    /**
     * Forcefully kill every running pi child process (SIGTERM, then SIGKILL
     * after a grace period). Called on SIGINT/SIGTERM so a stopped bot never
     * leaves orphaned intelligence processes behind. Idempotent.
     */
    killAll(): void;
}
