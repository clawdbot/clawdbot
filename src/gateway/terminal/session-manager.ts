// Owns the lifecycle of operator terminal sessions: one PTY per open, bound to
// the connection that opened it, streamed back over the gateway event channel.
import { randomUUID } from "node:crypto";
import { spawnTerminalPty, type TerminalPtyHandle } from "./pty.js";

/** Emits one terminal event frame to the single owning connection. */
type TerminalEventSink = (connId: string, event: string, payload: unknown) => void;

/** Injectable PTY spawner so tests can drive sessions without a real shell. */
type TerminalSpawner = typeof spawnTerminalPty;

const TERMINAL_EVENT_DATA = "terminal.data" as const;
const TERMINAL_EVENT_EXIT = "terminal.exit" as const;

type TerminalExitReason = "process_exit" | "closed" | "disconnected" | "detached" | "error";

type TerminalSession = {
  id: string;
  /** Owning connection; null while the session is detached. */
  connId: string | null;
  agentId: string;
  cwd: string;
  shell: string;
  pty: TerminalPtyHandle;
  seq: number;
  closed: boolean;
  createdAtMs: number;
  buffer: TerminalOutputRing;
  /** Kills the session when a detach outlives the grace period. */
  reaper: ReturnType<typeof setTimeout> | null;
  detachedAtMs: number | null;
};

/** One session's facts as reported by terminal.list. */
type TerminalSessionSummary = {
  sessionId: string;
  agentId: string;
  shell: string;
  cwd: string;
  attached: boolean;
  createdAtMs: number;
};

/** Bounds concurrent shells so a client cannot exhaust host processes. */
const DEFAULT_MAX_SESSIONS = 24;
/**
 * Rolling output kept per session for reattach replay and terminal.text,
 * in UTF-16 code units (≈ bytes for typical terminal output). Constant, not
 * config: ~256 KiB × session cap bounds worst-case memory at a few MiB.
 */
const DEFAULT_SCROLLBACK_CHARS = 256 * 1024;
/**
 * Cap on simultaneously detached sessions; the oldest detached session is
 * killed to make room. Keeps repeated disconnects from parking a full
 * session-cap worth of headless shells.
 */
const DEFAULT_MAX_DETACHED_SESSIONS = 8;
/** Default grace period before a detached session is killed (seconds). */
export const DEFAULT_TERMINAL_DETACH_SECONDS = 300;

/**
 * Bounded ring of recent PTY output. Raw bytes, not a screen snapshot: after
 * head truncation a replay can start mid-escape-sequence; emulators recover on
 * the next full repaint (prompt, clear, resize-triggered redraw). A true
 * server-side VT snapshot would need a terminal emulator per session and is a
 * tracked follow-up.
 */
class TerminalOutputRing {
  private chunks: string[] = [];
  private total = 0;

  constructor(private readonly cap: number) {}

  push(chunk: string): void {
    if (chunk.length >= this.cap) {
      this.chunks = [chunk.slice(chunk.length - this.cap)];
      this.total = this.cap;
      return;
    }
    this.chunks.push(chunk);
    this.total += chunk.length;
    // Evict whole chunks (PTY write granularity) so surviving data keeps its
    // original boundaries; the ring may briefly dip below cap, never above.
    while (this.total > this.cap && this.chunks.length > 1) {
      const head = this.chunks.shift();
      if (!head) {
        break;
      }
      this.total -= head.length;
    }
  }

  snapshot(): string {
    return this.chunks.join("");
  }
}

type TerminalSessionManagerOptions = {
  emit: TerminalEventSink;
  spawn?: TerminalSpawner;
  maxSessions?: number;
  env?: NodeJS.ProcessEnv;
  /**
   * How long a session may stay detached after its connection drops before it
   * is killed. 0 (default) preserves kill-on-disconnect; the config-facing
   * default lives in DEFAULT_TERMINAL_DETACH_SECONDS and is applied by the
   * gateway wiring.
   */
  detachGraceMs?: number;
  maxDetachedSessions?: number;
  scrollbackChars?: number;
};

/** Parameters for a resolved host terminal launch (isolation already checked). */
type TerminalOpenRequest = {
  connId: string;
  agentId: string;
  cwd: string;
  shell: string;
  args: string[];
  cols: number;
  rows: number;
  env: Record<string, string>;
};

type TerminalOpenOutcome =
  | { ok: true; sessionId: string; agentId: string; cwd: string; shell: string }
  | { ok: false; code: "limit" | "spawn_failed" | "closed"; message: string };

/** Abort state shared between a pending open and lifecycle/policy teardown. */
type OpenToken = { agentId: string; abortMessage?: string };

/**
 * Tracks live PTY sessions keyed by session id, with a reverse index by
 * connection so a disconnect can tear down every shell it owned.
 */
export class TerminalSessionManager {
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly byConn = new Map<string, Set<string>>();
  // Opens still awaiting spawn, keyed by connection. A disconnect flips their
  // abort flag so the resumed open kills the PTY instead of registering an
  // orphan for a dead connection.
  private readonly pendingOpens = new Map<string, Set<OpenToken>>();
  private readonly emit: TerminalEventSink;
  private readonly spawn: TerminalSpawner;
  private readonly maxSessions: number;
  private readonly detachGraceMs: number;
  private readonly maxDetachedSessions: number;
  private readonly scrollbackChars: number;
  // Slots reserved by opens that are still awaiting spawn. Counted against the
  // cap so concurrent opens cannot all pass the check and exceed maxSessions.
  private opening = 0;

  constructor(options: TerminalSessionManagerOptions) {
    this.emit = options.emit;
    this.spawn = options.spawn ?? spawnTerminalPty;
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.detachGraceMs = options.detachGraceMs ?? 0;
    this.maxDetachedSessions = options.maxDetachedSessions ?? DEFAULT_MAX_DETACHED_SESSIONS;
    this.scrollbackChars = options.scrollbackChars ?? DEFAULT_SCROLLBACK_CHARS;
  }

  /** Number of live sessions; used by tests and health surfaces. */
  get size(): number {
    return this.sessions.size;
  }

  /** Spawns a shell and wires its output/exit to the owning connection. */
  async open(request: TerminalOpenRequest): Promise<TerminalOpenOutcome> {
    if (this.sessions.size + this.opening >= this.maxSessions) {
      return {
        ok: false,
        code: "limit",
        message: `terminal session limit reached (${this.maxSessions})`,
      };
    }
    // Reserve the slot before the async spawn so it is visible to concurrent opens.
    this.opening += 1;
    const token: OpenToken = { agentId: request.agentId };
    this.trackPendingOpen(request.connId, token);
    let pty: TerminalPtyHandle;
    try {
      pty = await this.spawn({
        file: request.shell,
        args: request.args,
        cwd: request.cwd,
        env: request.env,
        cols: request.cols,
        rows: request.rows,
      });
    } catch (err) {
      this.opening -= 1;
      this.untrackPendingOpen(request.connId, token);
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, code: "spawn_failed", message };
    }
    // Hand the reservation over to the live session (synchronous from here — no
    // await — so the counts never both drop).
    this.opening -= 1;
    this.untrackPendingOpen(request.connId, token);
    if (token.abortMessage) {
      // The owning connection disconnected while the shell was spawning; kill it
      // now rather than register an orphan no one can reach or close.
      try {
        pty.kill();
      } catch {
        // Best-effort; the process may already be gone.
      }
      return { ok: false, code: "closed", message: token.abortMessage };
    }

    const session: TerminalSession = {
      id: randomUUID(),
      connId: request.connId,
      agentId: request.agentId,
      cwd: request.cwd,
      shell: request.shell,
      pty,
      seq: 0,
      closed: false,
      createdAtMs: Date.now(),
      buffer: new TerminalOutputRing(this.scrollbackChars),
      reaper: null,
      detachedAtMs: null,
    };
    this.sessions.set(session.id, session);
    this.indexByConn(request.connId, session.id);

    pty.onData((chunk) => {
      if (session.closed) {
        return;
      }
      // Always buffer so attach can replay; stream only while a conn owns it.
      session.buffer.push(chunk);
      if (session.connId === null) {
        return;
      }
      this.emit(session.connId, TERMINAL_EVENT_DATA, {
        sessionId: session.id,
        seq: session.seq++,
        data: chunk,
      });
    });
    pty.onExit((event) => {
      const signal = event.signal && event.signal !== 0 ? event.signal : null;
      this.finalize(session, "process_exit", { exitCode: event.exitCode ?? null, signal });
    });

    return {
      ok: true,
      sessionId: session.id,
      agentId: session.agentId,
      cwd: session.cwd,
      shell: session.shell,
    };
  }

  /** Writes client input to a session; returns false when the session is gone. */
  write(connId: string, sessionId: string, data: string): boolean {
    const session = this.ownedSession(connId, sessionId);
    if (!session) {
      return false;
    }
    try {
      session.pty.write(data);
      return true;
    } catch {
      this.finalize(session, "error", { error: "write failed" });
      return false;
    }
  }

  /** Applies a new PTY grid size; returns false when the session is gone. */
  resize(connId: string, sessionId: string, cols: number, rows: number): boolean {
    const session = this.ownedSession(connId, sessionId);
    if (!session) {
      return false;
    }
    try {
      session.pty.resize(cols, rows);
      return true;
    } catch {
      return false;
    }
  }

  /** Closes one session on operator request. */
  close(connId: string, sessionId: string): boolean {
    const session = this.ownedSession(connId, sessionId);
    if (!session) {
      return false;
    }
    this.finalize(session, "closed", {});
    return true;
  }

  /**
   * Rebinds a live-or-detached session to `connId` and returns the replay
   * buffer. Take-over is deliberate: the surface is operator.admin (full host
   * access already), so any admin connection may adopt any session; a previous
   * live owner is notified with reason "detached". Snapshot and rebind happen
   * in one synchronous step, so no PTY chunk can land in both the returned
   * buffer and the new owner's event stream.
   */
  attach(
    connId: string,
    sessionId: string,
  ):
    | { sessionId: string; agentId: string; cwd: string; shell: string; buffer: string }
    | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) {
      return undefined;
    }
    if (session.reaper) {
      clearTimeout(session.reaper);
      session.reaper = null;
    }
    session.detachedAtMs = null;
    if (session.connId !== null && session.connId !== connId) {
      this.byConn.get(session.connId)?.delete(session.id);
      this.emit(session.connId, TERMINAL_EVENT_EXIT, {
        sessionId: session.id,
        exitCode: null,
        signal: null,
        reason: "detached",
      });
    }
    session.connId = connId;
    this.indexByConn(connId, session.id);
    return {
      sessionId: session.id,
      agentId: session.agentId,
      cwd: session.cwd,
      shell: session.shell,
      buffer: session.buffer.snapshot(),
    };
  }

  /** Every live session, oldest first; all admin connections see the same list. */
  list(): TerminalSessionSummary[] {
    return [...this.sessions.values()]
      .filter((session) => !session.closed)
      .map((session) => ({
        sessionId: session.id,
        agentId: session.agentId,
        shell: session.shell,
        cwd: session.cwd,
        attached: session.connId !== null,
        createdAtMs: session.createdAtMs,
      }))
      .toSorted((a, b) => a.createdAtMs - b.createdAtMs);
  }

  /** Raw buffered output for one session, or undefined when it is gone. */
  snapshot(sessionId: string): string | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) {
      return undefined;
    }
    return session.buffer.snapshot();
  }

  private trackPendingOpen(connId: string, token: OpenToken): void {
    let set = this.pendingOpens.get(connId);
    if (!set) {
      set = new Set();
      this.pendingOpens.set(connId, set);
    }
    set.add(token);
  }

  private untrackPendingOpen(connId: string, token: OpenToken): void {
    const set = this.pendingOpens.get(connId);
    if (set) {
      set.delete(token);
      if (set.size === 0) {
        this.pendingOpens.delete(connId);
      }
    }
  }

  /**
   * Handles a dropped connection: detaches its sessions for later reattach
   * when a grace period is configured, otherwise kills them (legacy behavior,
   * still selected by detachedSessionTimeoutSeconds: 0).
   */
  handleDisconnect(connId: string): void {
    // Abort opens still awaiting spawn so they don't register orphaned PTYs.
    // These stay kill-on-disconnect even with detach enabled: the open RPC
    // never answered, so the client has no session id to reattach.
    const opens = this.pendingOpens.get(connId);
    if (opens) {
      for (const token of opens) {
        token.abortMessage = "connection closed during open";
      }
    }
    const ids = this.byConn.get(connId);
    if (!ids) {
      return;
    }
    // Snapshot first: finalize()/detach() mutate the same set during iteration.
    for (const id of Array.from(ids)) {
      const session = this.sessions.get(id);
      if (!session) {
        continue;
      }
      if (this.detachGraceMs > 0) {
        this.detach(session);
      } else {
        this.finalize(session, "disconnected", {}, { silent: true });
      }
    }
    this.byConn.delete(connId);
  }

  /** Closes live and pending sessions whose agent no longer permits a host shell. */
  closeDisallowedAgents(isAllowed: (agentId: string) => boolean): void {
    // Config can change while spawn is awaiting the native PTY import. Mark the
    // pending open so it kills the process instead of registering stale access.
    for (const opens of this.pendingOpens.values()) {
      for (const token of opens) {
        if (!isAllowed(token.agentId)) {
          token.abortMessage = "terminal closed because the agent policy changed";
        }
      }
    }
    // Snapshot first: finalize() mutates the session map. Detached sessions of
    // disallowed agents are killed too; finalize clears their reaper and skips
    // the exit event when no connection owns the stream.
    for (const session of Array.from(this.sessions.values())) {
      if (!isAllowed(session.agentId)) {
        this.finalize(session, "closed", {
          error: "terminal closed because the agent policy changed",
        });
      }
    }
  }

  /** Parks a session ownerless with a reaper; PTY output keeps buffering. */
  private detach(session: TerminalSession): void {
    session.connId = null;
    session.detachedAtMs = Date.now();
    session.reaper = setTimeout(() => {
      // Silent: nobody owns the stream, so there is no socket to notify.
      this.finalize(session, "disconnected", {}, { silent: true });
    }, this.detachGraceMs);
    // Never keep the process alive just to reap an abandoned shell.
    session.reaper.unref?.();
    this.enforceDetachedCap();
  }

  private enforceDetachedCap(): void {
    const detached = [...this.sessions.values()]
      .filter((session) => !session.closed && session.connId === null)
      .toSorted((a, b) => (a.detachedAtMs ?? 0) - (b.detachedAtMs ?? 0));
    for (const session of detached.slice(
      0,
      Math.max(0, detached.length - this.maxDetachedSessions),
    )) {
      this.finalize(session, "disconnected", {}, { silent: true });
    }
  }

  /**
   * Tears down every session — detached ones included — on gateway
   * shutdown/stop. Silent because the sockets are going away anyway (disabling
   * the terminal is a `gateway` restart, so that path also runs through here,
   * not a live notification).
   */
  disposeAll(): void {
    // Abort any opens still spawning so they don't register after shutdown.
    for (const opens of this.pendingOpens.values()) {
      for (const token of opens) {
        token.abortMessage = "gateway closed during terminal open";
      }
    }
    // Snapshot first: finalize() deletes from this.sessions during iteration.
    for (const session of Array.from(this.sessions.values())) {
      this.finalize(session, "disconnected", {}, { silent: true });
    }
  }

  private indexByConn(connId: string, sessionId: string): void {
    let connSessions = this.byConn.get(connId);
    if (!connSessions) {
      connSessions = new Set();
      this.byConn.set(connId, connSessions);
    }
    connSessions.add(sessionId);
  }

  private ownedSession(connId: string, sessionId: string): TerminalSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || session.connId !== connId || session.closed) {
      return undefined;
    }
    return session;
  }

  private finalize(
    session: TerminalSession,
    reason: TerminalExitReason,
    detail: { exitCode?: number | null; signal?: number | null; error?: string },
    opts?: { silent?: boolean },
  ): void {
    if (session.closed) {
      return;
    }
    session.closed = true;
    if (session.reaper) {
      clearTimeout(session.reaper);
      session.reaper = null;
    }
    this.sessions.delete(session.id);
    if (session.connId !== null) {
      this.byConn.get(session.connId)?.delete(session.id);
    }
    try {
      session.pty.kill();
    } catch {
      // Process may already be gone; the kill is best-effort teardown.
    }
    // A disconnect already dropped the socket, so emitting there is pointless;
    // process/close/error exits still notify the live client. Detached
    // sessions have no owner to notify at all.
    if (!opts?.silent && session.connId !== null) {
      this.emit(session.connId, TERMINAL_EVENT_EXIT, {
        sessionId: session.id,
        exitCode: detail.exitCode ?? null,
        signal: detail.signal ?? null,
        reason,
        ...(detail.error ? { error: detail.error } : {}),
      });
    }
  }
}
