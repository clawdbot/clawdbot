// Owns gateway PTYs for operator connections and agent tool sessions.
import { randomUUID } from "node:crypto";
import {
  ensureTerminalUploadCleanup,
  stageTerminalUpload,
  type TerminalUploadFile,
  type TerminalUploadResult,
} from "../../infra/terminal-file-upload.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  createLocalTerminalBackend,
  type LocalTerminalBackendSpawner,
  type TerminalBackend,
} from "./backend.js";
import { TERMINAL_EVENT_DATA, TERMINAL_EVENT_EXIT } from "./gateway-transport.js";
import { composeTerminalIntroBanner } from "./intro-banner.js";
import { TerminalOutputController } from "./output-flow-control.js";
import { TerminalOutputRing } from "./output-ring.js";
import {
  DEFAULT_MAX_DETACHED_SESSIONS,
  DEFAULT_MAX_SESSIONS,
  DEFAULT_SCROLLBACK_CHARS,
} from "./session-limits.js";
import type { TerminalAttachSummary, TerminalSessionSummary } from "./session-types.js";
export { DEFAULT_TERMINAL_DETACH_SECONDS } from "./session-limits.js";
import type {
  TerminalEventSink,
  TerminalExitReason,
  TerminalOpenOutcome,
  TerminalOpenRequest,
  TerminalPendingOpen,
  TerminalSession,
  TerminalSessionManagerOptions,
  TerminalOwner,
} from "./session-manager.types.js";

const log = createSubsystemLogger("gateway/terminal");

// Task binding is manager-private metadata: public terminal ownership stays
// conversation-scoped while lifecycle cleanup can target the exact producer.
type TaskBoundAgentOwner = Extract<TerminalOwner, { kind: "agent" }> & { taskId?: string };

function terminalOwnerMatches(
  owner: TerminalOwner | null,
  ownerKey: string,
  agentId?: string,
): boolean {
  if (owner?.kind !== "agent") {
    return false;
  }
  return owner.agentSessionKey === ownerKey && owner.agentId === agentId;
}

function terminalLifecycleOwnerMatches(owner: TerminalOwner | null, ownerKey: string): boolean {
  return (
    owner?.kind === "agent" &&
    (owner.agentSessionKey === ownerKey || (owner as TaskBoundAgentOwner).taskId === ownerKey)
  );
}

/**
 * Tracks live PTY sessions keyed by session id, with a reverse index for
 * connection owners and viewers so disconnect cleanup stays bounded.
 */
export class TerminalSessionManager {
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly byConn = new Map<string, Set<string>>();
  private readonly pendingOpens = new Map<TerminalPendingOpen, TerminalOwner>();
  // Connection-owned opens still awaiting spawn. A disconnect flips their
  // abort flag so the resumed open kills the PTY instead of registering an
  // orphan for a dead connection.
  private readonly pendingByConn = new Map<string, Set<TerminalPendingOpen>>();
  private readonly emit: TerminalEventSink;
  private readonly getBufferedAmount: (connId: string) => number | undefined;
  private readonly spawn?: LocalTerminalBackendSpawner;
  private readonly maxSessions: number;
  private readonly detachGraceMs: number;
  private readonly maxDetachedSessions: number;
  private readonly scrollbackChars: number;
  // Slots reserved by opens that are still awaiting spawn. Counted against the
  // cap so concurrent opens cannot all pass the check and exceed maxSessions.
  private opening = 0;
  // Cancellation frees a session slot, but cannot stop every backend factory.
  // Bound those physical operations until they settle so disconnect churn
  // cannot create an unbounded number of native/node spawn attempts.
  private spawning = 0;

  constructor(options: TerminalSessionManagerOptions) {
    void ensureTerminalUploadCleanup();
    this.emit = options.emit;
    this.getBufferedAmount = options.getBufferedAmount ?? (() => undefined);
    this.spawn = options.spawn;
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.detachGraceMs = options.detachGraceMs ?? 0;
    this.maxDetachedSessions = options.maxDetachedSessions ?? DEFAULT_MAX_DETACHED_SESSIONS;
    this.scrollbackChars = options.scrollbackChars ?? DEFAULT_SCROLLBACK_CHARS;
  }

  /** Number of live sessions; used by tests and health surfaces. */
  get size(): number {
    return this.sessions.size;
  }

  /** Spawns a shell and wires its output/exit to its live connection recipients. */
  async open(request: TerminalOpenRequest): Promise<TerminalOpenOutcome> {
    if (request.signal?.aborted) {
      return { ok: false, code: "closed", message: this.openAbortMessage(request.signal) };
    }
    if (this.spawning >= this.maxSessions * 2) {
      return {
        ok: false,
        code: "limit",
        message: `terminal spawn limit reached (${this.maxSessions * 2})`,
      };
    }
    // Agent-opened shells outlive their commands and have no automatic reaper,
    // so a busy agent would otherwise exhaust the pool for the whole gateway
    // until restart. Under pressure, claim the longest-idle viewer-free agent
    // session as an eviction candidate; it is killed only after the replacement
    // backend spawns, so a failed spawn never destroys a live session.
    let evictionCandidate: TerminalSession | undefined;
    if (this.sessions.size + this.opening >= this.maxSessions) {
      evictionCandidate = this.claimLongestIdleAgentSession();
      if (!evictionCandidate) {
        return {
          ok: false,
          code: "limit",
          message: `terminal session limit reached (${this.maxSessions})`,
        };
      }
    }
    const releaseEvictionClaim = () => {
      if (evictionCandidate) {
        evictionCandidate.evictionClaimed = false;
        evictionCandidate = undefined;
      }
    };
    // Reserve the slot before the async spawn so it is visible to concurrent opens.
    this.opening += 1;
    this.spawning += 1;
    let reservationActive = true;
    const releaseReservation = () => {
      if (!reservationActive) {
        return;
      }
      reservationActive = false;
      this.opening -= 1;
      this.untrackPendingOpen(request.owner, pending);
    };
    const pending: TerminalPendingOpen = {
      agentId: request.agentId,
      abort: (message) => {
        pending.abortMessage ??= message;
        // A hung spawn must not consume capacity after its owner is gone.
        // Its eventual backend is still killed by the abortMessage check below.
        // The eviction claim must also drop now: a cancelled open whose spawn
        // never settles would otherwise keep its victim unclaimable forever.
        releaseReservation();
        releaseEvictionClaim();
      },
    };
    const abortPending = () => {
      pending.abort(this.openAbortMessage(request.signal));
    };
    request.signal?.addEventListener("abort", abortPending, { once: true });
    this.trackPendingOpen(request.owner, pending);
    let backend: TerminalBackend;
    try {
      backend = request.createBackend
        ? await request.createBackend()
        : await createLocalTerminalBackend(
            {
              file: request.shell,
              args: request.args,
              cwd: request.cwd,
              env: request.env,
              cols: request.cols,
              rows: request.rows,
            },
            this.spawn,
          );
    } catch (err) {
      this.spawning -= 1;
      releaseReservation();
      releaseEvictionClaim();
      request.signal?.removeEventListener("abort", abortPending);
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, code: "spawn_failed", message };
    }
    // Hand the reservation over to the live session (synchronous from here — no
    // await — so the counts never both drop).
    this.spawning -= 1;
    releaseReservation();
    request.signal?.removeEventListener("abort", abortPending);
    if (pending.abortMessage) {
      // The request was cancelled while the shell was spawning; kill it now
      // rather than register an unreachable orphan.
      releaseEvictionClaim();
      try {
        backend.kill();
      } catch {
        // Best-effort; the process may already be gone.
      }
      return { ok: false, code: "closed", message: pending.abortMessage };
    }
    if (evictionCandidate) {
      // The replacement backend exists; retire a victim now, still inside the
      // synchronous window, so registration stays within the cap. Revalidate
      // first: the claimed candidate may have gained a viewer or exited during
      // the spawn await, and viewer-attached sessions are never evicted.
      const claimed = evictionCandidate;
      evictionCandidate = undefined;
      claimed.evictionClaimed = false;
      // Count other opens' outstanding reservations (our own was released
      // above): skipping eviction against sessions.size alone lets concurrent
      // spawns that finish out of order register past the hard cap. Evicting
      // for a reservation whose spawn later fails is the safer direction.
      if (this.sessions.size + this.opening >= this.maxSessions) {
        // Reselect fresh: the idle ranking goes stale across the spawn await —
        // the claimed session may now be viewer-attached or active while an
        // idler alternative exists. The released claim rejoins the pool, so a
        // still-idlest claimed session is simply selected again.
        const victim = this.claimLongestIdleAgentSession();
        if (!victim) {
          try {
            backend.kill();
          } catch {
            // Best-effort; the process may already be gone.
          }
          return {
            ok: false,
            code: "limit",
            message: `terminal session limit reached (${this.maxSessions})`,
          };
        }
        victim.evictionClaimed = false;
        log.info(
          `evicted idle agent terminal session under pool pressure: id=${victim.id} agent=${victim.agentId} idleMs=${Date.now() - victim.lastActivityAtMs}`,
        );
        this.finalize(victim, "closed", {});
      }
    }

    const sessionId = randomUUID();
    const buffer = new TerminalOutputRing(this.scrollbackChars);
    // getConnIds runs only when output emits, after `session` below is assigned,
    // so the forward reference from this closure is safe.
    const output = new TerminalOutputController({
      backend,
      getConnIds: () => this.sessionConnIds(session),
      getBufferedAmount: this.getBufferedAmount,
      record: (chunk) => buffer.push(chunk),
      emit: (connIds, data, seq) => {
        for (const connId of connIds) {
          this.emit(connId, TERMINAL_EVENT_DATA, {
            sessionId,
            seq,
            data,
          });
        }
      },
    });
    const session: TerminalSession = {
      id: sessionId,
      owner: request.owner,
      viewers: new Set(),
      agentId: request.agentId,
      cwd: request.cwd,
      shell: request.shell,
      backend,
      stageUpload: request.stageUpload ?? stageTerminalUpload,
      closed: false,
      createdAtMs: Date.now(),
      buffer,
      output,
      reaper: null,
      detachedAtMs: null,
      lastActivityAtMs: Date.now(),
    };
    this.sessions.set(session.id, session);
    if (request.owner.kind === "conn") {
      this.indexByConn(request.owner.connId, session.id);
      session.output.push(composeTerminalIntroBanner());
    }

    backend.onData((chunk) => {
      if (!session.closed) {
        session.lastActivityAtMs = Date.now();
        session.output.push(chunk);
      }
    });
    backend.onExit((event) => {
      const signal = event.signal && event.signal !== 0 ? event.signal : null;
      this.finalize(session, event.error ? "error" : "process_exit", {
        exitCode: event.exitCode ?? null,
        signal,
        ...(event.error ? { error: event.error } : {}),
      });
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
    const session = this.interactiveSession(connId, sessionId);
    if (!session) {
      return false;
    }
    return this.writeSession(session, data);
  }

  /** Writes agent input after proving session-key ownership. */
  writeAgent(agentSessionKey: string, sessionId: string, data: string, agentId?: string): boolean {
    const session = this.agentOwnedSession(agentSessionKey, sessionId, agentId);
    return session ? this.writeSession(session, data) : false;
  }

  private writeSession(session: TerminalSession, data: string): boolean {
    try {
      session.lastActivityAtMs = Date.now();
      session.output.noteInput();
      session.backend.write(data);
      return true;
    } catch {
      this.finalize(session, "error", { error: "write failed" });
      return false;
    }
  }

  /** Applies a new PTY grid size; returns false when the session is gone. */
  resize(connId: string, sessionId: string, cols: number, rows: number): boolean {
    const session = this.interactiveSession(connId, sessionId);
    if (!session) {
      return false;
    }
    return this.resizeSession(session, cols, rows);
  }

  /** Resizes an agent-owned PTY after proving session-key ownership. */
  resizeAgent(
    agentSessionKey: string,
    sessionId: string,
    cols: number,
    rows: number,
    agentId?: string,
  ): boolean {
    const session = this.agentOwnedSession(agentSessionKey, sessionId, agentId);
    return session ? this.resizeSession(session, cols, rows) : false;
  }

  private resizeSession(session: TerminalSession, cols: number, rows: number): boolean {
    try {
      session.backend.resize(cols, rows);
      return true;
    } catch {
      this.finalize(session, "error", { error: "resize failed" });
      return false;
    }
  }

  /** Stages a file on the same host as an owned terminal session. */
  async upload(
    connId: string,
    sessionId: string,
    file: TerminalUploadFile,
  ): Promise<TerminalUploadResult | undefined> {
    // Co-attached viewers of an agent-owned session may upload, matching their
    // write/resize authorization; interactiveSession covers owner and viewer.
    const session = this.interactiveSession(connId, sessionId);
    if (!session) {
      return undefined;
    }
    const result = await session.stageUpload(file);
    // Upload can outlive a socket or take-over. Do not return a usable path to
    // a connection that no longer interacts with the terminal after the await.
    return this.interactiveSession(connId, sessionId) === session ? result : undefined;
  }

  /** Closes one session on operator request. */
  close(connId: string, sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }
    if (session.owner?.kind === "agent" && session.viewers.has(connId)) {
      // Closing an agent-owned browser tab detaches only that view. The agent
      // retains lifecycle ownership and may close the PTY through its tool.
      return this.removeViewer(session, connId);
    }
    if (session.owner?.kind !== "conn" || session.owner.connId !== connId || session.closed) {
      return false;
    }
    this.finalize(session, "closed", {});
    return true;
  }

  /** Closes an agent-owned PTY after proving session-key ownership. */
  closeAgent(agentSessionKey: string, sessionId: string, agentId?: string): boolean {
    const session = this.agentOwnedSession(agentSessionKey, sessionId, agentId);
    if (!session) {
      return false;
    }
    this.finalize(session, "closed", {});
    return true;
  }

  /** Closes every live or spawning PTY owned by one exact agent session or task. */
  closeAgentSessions(agentSessionKey: string, agentId?: string): number {
    for (const [pending, owner] of this.pendingOpens) {
      if (
        agentId
          ? terminalOwnerMatches(owner, agentSessionKey, agentId)
          : terminalLifecycleOwnerMatches(owner, agentSessionKey)
      ) {
        pending.abort("terminal closed because its task ended");
      }
    }
    const owned = [...this.sessions.values()].filter(
      (session) =>
        !session.closed &&
        (agentId
          ? terminalOwnerMatches(session.owner, agentSessionKey, agentId)
          : terminalLifecycleOwnerMatches(session.owner, agentSessionKey)),
    );
    for (const session of owned) {
      this.finalize(session, "closed", {});
    }
    return owned.length;
  }

  /**
   * Rebinds a connection-owned session, or co-attaches a viewer to an
   * agent-owned session. Operator-to-operator attach remains take-over; only
   * agent-owned sessions gain shared viewers.
   */
  attach(connId: string, sessionId: string): TerminalAttachSummary | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) {
      return undefined;
    }
    if (session.owner?.kind === "agent") {
      // Emit pending bytes to existing viewers before the new viewer's replay
      // snapshot. This prevents the newcomer from receiving those bytes twice.
      session.output.prepareViewerAttach();
      session.viewers.add(connId);
      this.indexByConn(connId, session.id);
      return this.attachSummary(session);
    }
    if (session.reaper) {
      clearTimeout(session.reaper);
      session.reaper = null;
    }
    session.output.resetOwnership();
    session.detachedAtMs = null;
    const previousConnId = session.owner?.kind === "conn" ? session.owner.connId : null;
    if (previousConnId !== null && previousConnId !== connId) {
      this.unindexByConn(previousConnId, session.id);
      this.emit(previousConnId, TERMINAL_EVENT_EXIT, {
        sessionId: session.id,
        exitCode: null,
        signal: null,
        reason: "detached",
      });
    }
    session.owner = { kind: "conn", connId };
    this.indexByConn(connId, session.id);
    return this.attachSummary(session);
  }

  private attachSummary(session: TerminalSession): TerminalAttachSummary {
    return {
      sessionId: session.id,
      agentId: session.agentId,
      cwd: session.cwd,
      shell: session.shell,
      buffer: session.buffer.snapshot(),
      seq: session.output.endOffset,
    };
  }

  /** Every live session, oldest first; all admin connections see the same list. */
  list(): TerminalSessionSummary[] {
    return [...this.sessions.values()]
      .filter((session) => !session.closed)
      .map((session) => {
        const owner: TerminalSessionSummary["owner"] =
          session.owner?.kind === "agent" ? `agent:${session.owner.agentSessionKey}` : "conn";
        return {
          sessionId: session.id,
          agentId: session.agentId,
          shell: session.shell,
          cwd: session.cwd,
          attached:
            session.owner?.kind === "conn" ||
            (session.owner?.kind === "agent" && session.viewers.size > 0),
          owner,
          createdAtMs: session.createdAtMs,
        };
      })
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

  /** Raw buffer for an agent-owned session, guarded by the caller session key. */
  snapshotAgent(agentSessionKey: string, sessionId: string, agentId?: string): string | undefined {
    return this.agentOwnedSession(agentSessionKey, sessionId, agentId)?.buffer.snapshot();
  }

  /** Live sessions owned by one agent tool caller. */
  listAgent(agentSessionKey: string, agentId?: string): TerminalSessionSummary[] {
    const sessionIds = new Set(
      [...this.sessions.values()]
        .filter(
          (session) =>
            !session.closed && terminalOwnerMatches(session.owner, agentSessionKey, agentId),
        )
        .map((session) => session.id),
    );
    return this.list().filter((summary) => sessionIds.has(summary.sessionId));
  }

  private trackPendingOpen(owner: TerminalOwner, pending: TerminalPendingOpen): void {
    this.pendingOpens.set(pending, owner);
    if (owner.kind !== "conn") {
      return;
    }
    let set = this.pendingByConn.get(owner.connId);
    if (!set) {
      set = new Set();
      this.pendingByConn.set(owner.connId, set);
    }
    set.add(pending);
  }

  private openAbortMessage(signal: AbortSignal | undefined): string {
    return signal?.reason instanceof Error ? signal.reason.message : "terminal open cancelled";
  }

  private untrackPendingOpen(owner: TerminalOwner, pending: TerminalPendingOpen): void {
    this.pendingOpens.delete(pending);
    if (owner.kind !== "conn") {
      return;
    }
    const set = this.pendingByConn.get(owner.connId);
    if (set) {
      set.delete(pending);
      if (set.size === 0) {
        this.pendingByConn.delete(owner.connId);
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
    const opens = this.pendingByConn.get(connId);
    if (opens) {
      for (const pending of opens) {
        pending.abort("connection closed during open");
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
      if (session.owner?.kind === "agent") {
        this.removeViewer(session, connId);
        continue;
      }
      if (session.owner?.kind !== "conn" || session.owner.connId !== connId) {
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
    for (const pending of this.pendingOpens.keys()) {
      if (!isAllowed(pending.agentId)) {
        pending.abort("terminal closed because the agent policy changed");
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
    session.output.resetOwnership();
    session.owner = null;
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
      .filter((session) => !session.closed && session.owner === null)
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
    for (const pending of this.pendingOpens.keys()) {
      pending.abort("gateway closed during terminal open");
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

  private unindexByConn(connId: string, sessionId: string): void {
    const sessions = this.byConn.get(connId);
    sessions?.delete(sessionId);
    if (sessions?.size === 0) {
      this.byConn.delete(connId);
    }
  }

  /**
   * Claims the longest-idle agent-owned session as an eviction candidate when
   * the pool is exhausted. Viewer-attached and connection-owned sessions are
   * never evicted; an idle viewer-free background job losing its PTY under
   * pressure is the accepted tradeoff for keeping the pool available. Claimed
   * sessions are skipped so concurrent opens select distinct victims.
   */
  private claimLongestIdleAgentSession(): TerminalSession | undefined {
    let candidate: TerminalSession | undefined;
    for (const session of this.sessions.values()) {
      if (
        session.closed ||
        session.evictionClaimed ||
        session.owner?.kind !== "agent" ||
        session.viewers.size > 0
      ) {
        continue;
      }
      if (!candidate || session.lastActivityAtMs < candidate.lastActivityAtMs) {
        candidate = session;
      }
    }
    if (candidate) {
      candidate.evictionClaimed = true;
    }
    return candidate;
  }

  private removeViewer(session: TerminalSession, connId: string): boolean {
    if (!session.viewers.delete(connId)) {
      return false;
    }
    this.unindexByConn(connId, session.id);
    if (session.viewers.size === 0) {
      // With no socket pressure left, resume immediately. Buffered bytes stay
      // in the replay ring and the next viewer starts at its high-water mark.
      session.output.resetOwnership();
    } else {
      // A departed slow viewer must not leave healthy co-viewers stalled.
      session.output.reconcileRecipients();
    }
    return true;
  }

  private interactiveSession(connId: string, sessionId: string): TerminalSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) {
      return undefined;
    }
    if (session.owner?.kind === "conn") {
      return session.owner.connId === connId ? session : undefined;
    }
    return session.owner?.kind === "agent" && session.viewers.has(connId) ? session : undefined;
  }

  /** Agents may operate only PTYs created by their exact trusted session key. */
  private agentOwnedSession(
    agentSessionKey: string,
    sessionId: string,
    agentId?: string,
  ): TerminalSession | undefined {
    const session = this.sessions.get(sessionId);
    if (
      !session ||
      session.closed ||
      session.owner?.kind !== "agent" ||
      !terminalOwnerMatches(session.owner, agentSessionKey, agentId)
    ) {
      return undefined;
    }
    return session;
  }

  private sessionConnIds(session: TerminalSession): string[] {
    const connIds = new Set(session.viewers);
    if (session.owner?.kind === "conn") {
      connIds.add(session.owner.connId);
    }
    return [...connIds];
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
    const recipients = this.sessionConnIds(session);
    session.output.dispose({ flush: !opts?.silent && recipients.length > 0 });
    session.closed = true;
    if (session.reaper) {
      clearTimeout(session.reaper);
      session.reaper = null;
    }
    this.sessions.delete(session.id);
    if (session.owner?.kind === "conn") {
      this.unindexByConn(session.owner.connId, session.id);
    }
    for (const viewerConnId of session.viewers) {
      this.unindexByConn(viewerConnId, session.id);
    }
    session.viewers.clear();
    try {
      session.backend.kill();
    } catch {
      // Process may already be gone; the kill is best-effort teardown.
    }
    // A disconnect already dropped the socket, so emitting there is pointless;
    // process/close/error exits still notify every live owner/viewer.
    if (!opts?.silent) {
      for (const connId of recipients) {
        this.emit(connId, TERMINAL_EVENT_EXIT, {
          sessionId: session.id,
          exitCode: detail.exitCode ?? null,
          signal: detail.signal ?? null,
          reason,
          ...(detail.error ? { error: detail.error } : {}),
        });
      }
    }
  }
}
