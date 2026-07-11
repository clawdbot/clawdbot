/**
 * In-memory registry for bash exec sessions.
 * Tracks running/backgrounded sessions, bounded pending output, finished
 * session retention, and process cleanup for reconnect/poll flows.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { EventSessionRoutingPolicy } from "../infra/event-session-routing.js";
import type { TerminationReason } from "../process/supervisor/types.js";
import type { DeliveryContext } from "../utils/delivery-context.js";
import { readEnvInt } from "./bash-tools.shared.js";
import { createSessionSlug as createSessionSlugId } from "./session-slug.js";

const DEFAULT_JOB_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MIN_JOB_TTL_MS = 60 * 1000; // 1 minute
const MAX_JOB_TTL_MS = 3 * 60 * 60 * 1000; // 3 hours
const DEFAULT_PENDING_OUTPUT_CHARS = 30_000;

function clampTtl(value: number | undefined) {
  if (value === undefined || Number.isNaN(value)) {
    return DEFAULT_JOB_TTL_MS;
  }
  return Math.min(Math.max(value, MIN_JOB_TTL_MS), MAX_JOB_TTL_MS);
}

let jobTtlMs = clampTtl(readEnvInt("OPENCLAW_BASH_JOB_TTL_MS", "PI_BASH_JOB_TTL_MS"));

/** Lifecycle status recorded for background process sessions. */
type ProcessStatus = "running" | "completed" | "failed" | "killed";

/** Writable stdin surface shared by child-process and PTY-backed sessions. */
type SessionStdin = {
  write: (data: string, cb?: (err?: Error | null) => void) => void;
  end: () => void;
  // When backed by a real Node stream (child.stdin), this exists; for PTY wrappers it may not.
  destroy?: () => void;
  destroyed?: boolean;
  writable?: boolean;
  writableEnded?: boolean;
  writableFinished?: boolean;
};

/** Mutable session state for a running bash exec process. */
export interface ProcessSession {
  id: string;
  command: string;
  scopeKey?: string;
  sessionKey?: string;
  /** `session.mainKey` from the runtime config, snapshotted at exec start.
   *  Used by background-exit notifications to remap cron-run keys to the
   *  agent's main queue without an ambient config load. If config changes
   *  while the process runs, the exit notification follows the start-time
   *  session contract. */
  mainKey?: string;
  /** `session.scope` from the runtime config; required so the cron-run remap
   *  can route global-scope agents to the literal "global" queue instead
   *  of an agent-main queue the heartbeat never drains. Snapshotted with
   *  `mainKey` for the same start-time routing reason. */
  sessionScope?: "per-sender" | "global";
  /** Start-time routing policy for detached exec system events. */
  eventRouting?: EventSessionRoutingPolicy;
  notifyDeliveryContext?: DeliveryContext;
  notifyOnExit?: boolean;
  notifyOnExitEmptySuccess?: boolean;
  exitNotified?: boolean;
  child?: ChildProcessWithoutNullStreams;
  stdin?: SessionStdin;
  pid?: number;
  startedAt: number;
  cwd?: string;
  maxOutputChars: number;
  pendingMaxOutputChars?: number;
  totalOutputChars: number;
  pendingStdout: string[];
  pendingStderr: string[];
  pendingStdoutChars: number;
  pendingStderrChars: number;
  aggregated: string;
  tail: string;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | number | null;
  exitReason?: TerminationReason;
  noOutputTimedOut?: boolean;
  exited: boolean;
  truncated: boolean;
  backgrounded: boolean;
  /** PTY cursor key mode: unknown until a PTY reports smkx/rmkx. */
  cursorKeyMode: "unknown" | "normal" | "application";
}

/** Retained summary for a completed background session. */
interface FinishedSession {
  id: string;
  command: string;
  scopeKey?: string;
  startedAt: number;
  endedAt: number;
  cwd?: string;
  status: ProcessStatus;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | number | null;
  exitReason?: TerminationReason;
  noOutputTimedOut?: boolean;
  aggregated: string;
  tail: string;
  truncated: boolean;
  totalOutputChars: number;
}

const runningSessions = new Map<string, ProcessSession>();
const finishedSessions = new Map<string, FinishedSession>();
const activeBackgroundExecSessionIds = new Set<string>();

let sweeper: NodeJS.Timeout | null = null;

function isSessionIdTaken(id: string) {
  return (
    runningSessions.has(id) || finishedSessions.has(id) || activeBackgroundExecSessionIds.has(id)
  );
}

/** Creates a unique short session id that avoids running and retained sessions. */
export function createSessionSlug(): string {
  return createSessionSlugId(isSessionIdTaken);
}

/** Adds a running session and starts retention sweeping if needed. */
export function addSession(session: ProcessSession) {
  runningSessions.set(session.id, session);
  startSweeper();
}

/** Returns a running session by id. */
export function getSession(id: string) {
  return runningSessions.get(id);
}

/** Returns a retained finished background session by id. */
export function getFinishedSession(id: string) {
  return finishedSessions.get(id);
}

/** Removes visible session records without changing live-process activity. */
export function deleteSession(id: string) {
  runningSessions.delete(id);
  finishedSessions.delete(id);
}

/** Appends process output while enforcing aggregate and pending-output caps. */
export function appendOutput(session: ProcessSession, stream: "stdout" | "stderr", chunk: string) {
  session.pendingStdout ??= [];
  session.pendingStderr ??= [];
  session.pendingStdoutChars ??= sumPendingChars(session.pendingStdout);
  session.pendingStderrChars ??= sumPendingChars(session.pendingStderr);
  const buffer = stream === "stdout" ? session.pendingStdout : session.pendingStderr;
  const bufferChars = stream === "stdout" ? session.pendingStdoutChars : session.pendingStderrChars;
  const pendingCap = Math.min(
    session.pendingMaxOutputChars ?? DEFAULT_PENDING_OUTPUT_CHARS,
    session.maxOutputChars,
  );
  buffer.push(chunk);
  let pendingChars = bufferChars + chunk.length;
  if (pendingChars > pendingCap) {
    session.truncated = true;
    pendingChars = capPendingBuffer(buffer, pendingChars, pendingCap);
  }
  if (stream === "stdout") {
    session.pendingStdoutChars = pendingChars;
  } else {
    session.pendingStderrChars = pendingChars;
  }
  session.totalOutputChars += chunk.length;
  const aggregated = trimWithCap(session.aggregated + chunk, session.maxOutputChars);
  session.truncated =
    session.truncated || aggregated.length < session.aggregated.length + chunk.length;
  session.aggregated = aggregated;
  session.tail = tail(session.aggregated, 2000);
}

/** Drains pending stdout/stderr chunks returned by a process poll. */
export function drainSession(session: ProcessSession) {
  const stdout = session.pendingStdout.join("");
  const stderr = session.pendingStderr.join("");
  session.pendingStdout = [];
  session.pendingStderr = [];
  session.pendingStdoutChars = 0;
  session.pendingStderrChars = 0;
  return { stdout, stderr };
}

/** Moves a session to finished state and records exit metadata. */
export function markExited(
  session: ProcessSession,
  exitCode: number | null,
  exitSignal: NodeJS.Signals | number | null,
  status: ProcessStatus,
  exitReason?: TerminationReason,
  noOutputTimedOut?: boolean,
) {
  // Visibility can be cleared before process termination. Keep suspension
  // blocked until the process owner reports the actual terminal transition.
  activeBackgroundExecSessionIds.delete(session.id);
  session.exited = true;
  session.exitCode = exitCode;
  session.exitSignal = exitSignal;
  session.exitReason = exitReason;
  session.noOutputTimedOut = noOutputTimedOut;
  session.tail = tail(session.aggregated, 2000);
  moveToFinished(session, status);
}

/** Marks a running session as reconnectable after the exec call returns. */
export function markBackgrounded(session: ProcessSession) {
  session.backgrounded = true;
  if (!session.exited) {
    activeBackgroundExecSessionIds.add(session.id);
  }
}

/** Returns the number of live background exec sessions without exposing process details. */
export function getActiveBackgroundExecSessionCount(): number {
  return activeBackgroundExecSessionIds.size;
}

function moveToFinished(session: ProcessSession, status: ProcessStatus) {
  runningSessions.delete(session.id);

  // Clean up child process stdio streams to prevent FD leaks
  if (session.child) {
    // Destroy stdio streams to release file descriptors
    session.child.stdin?.destroy?.();
    session.child.stdout?.destroy?.();
    session.child.stderr?.destroy?.();

    // Remove all event listeners to prevent memory leaks
    session.child.removeAllListeners();

    // Clear the reference
    delete session.child;
  }

  // Clean up stdin wrapper - call destroy if available, otherwise just remove reference
  if (session.stdin) {
    // Try to call destroy/end method if exists
    if (typeof session.stdin.destroy === "function") {
      session.stdin.destroy();
    } else if (typeof session.stdin.end === "function") {
      session.stdin.end();
    }
    // Only set flag if writable
    try {
      (session.stdin as { destroyed?: boolean }).destroyed = true;
    } catch {
      // Ignore if read-only
    }
    delete session.stdin;
  }

  if (!session.backgrounded) {
    return;
  }
  finishedSessions.set(session.id, {
    id: session.id,
    command: session.command,
    scopeKey: session.scopeKey,
    startedAt: session.startedAt,
    endedAt: Date.now(),
    cwd: session.cwd,
    status,
    exitCode: session.exitCode,
    exitSignal: session.exitSignal,
    exitReason: session.exitReason,
    ...(session.noOutputTimedOut !== undefined
      ? { noOutputTimedOut: session.noOutputTimedOut }
      : {}),
    aggregated: session.aggregated,
    tail: session.tail,
    truncated: session.truncated,
    totalOutputChars: session.totalOutputChars,
  });
}

/** Returns the last `max` characters of text without adding ellipses. */
export function tail(text: string, max = 2000) {
  if (text.length <= max) {
    return text;
  }
  return sliceUtf16Safe(text, text.length - max);
}

function sumPendingChars(buffer: string[]) {
  let total = 0;
  for (const chunk of buffer) {
    total += chunk.length;
  }
  return total;
}

function capPendingBuffer(buffer: string[], pendingCharsInput: number, cap: number) {
  let pendingChars = pendingCharsInput;
  if (pendingChars <= cap) {
    return pendingChars;
  }
  const last = buffer.at(-1);
  if (last && last.length >= cap) {
    buffer.length = 0;
    const kept = tail(last, cap);
    buffer.push(kept);
    return kept.length;
  }
  let dropCount = 0;
  while (dropCount < buffer.length) {
    const chunk = buffer[dropCount];
    if (chunk === undefined || pendingChars - chunk.length < cap) {
      break;
    }
    pendingChars -= chunk.length;
    dropCount += 1;
  }
  if (dropCount > 0) {
    buffer.splice(0, dropCount);
  }
  if (buffer.length && pendingChars > cap) {
    const overflow = pendingChars - cap;
    const previousLength = buffer[0].length;
    buffer[0] = sliceUtf16Safe(buffer[0], overflow);
    pendingChars -= previousLength - buffer[0].length;
  }
  return pendingChars;
}

/** Keeps only the last `max` characters for bounded aggregate output storage. */
function trimWithCap(text: string, max: number) {
  return tail(text, max);
}

/** Lists backgrounded running sessions visible to reconnect/poll callers. */
export function listRunningSessions() {
  return Array.from(runningSessions.values()).filter((s) => s.backgrounded);
}

/** Lists retained finished background sessions. */
export function listFinishedSessions() {
  return Array.from(finishedSessions.values());
}

/** Test-only reset for in-memory registry state and retention timers. */
export function resetProcessRegistryForTests() {
  runningSessions.clear();
  finishedSessions.clear();
  activeBackgroundExecSessionIds.clear();
  stopSweeper();
}

/** Overrides finished-session retention TTL, clamped to supported bounds. */
export function setJobTtlMs(value?: number) {
  if (value === undefined || Number.isNaN(value)) {
    return;
  }
  jobTtlMs = clampTtl(value);
  stopSweeper();
  startSweeper();
}

function pruneFinishedSessions() {
  const cutoff = Date.now() - jobTtlMs;
  for (const [id, session] of finishedSessions.entries()) {
    if (session.endedAt < cutoff) {
      finishedSessions.delete(id);
    }
  }
}

function startSweeper() {
  if (sweeper) {
    return;
  }
  sweeper = setInterval(pruneFinishedSessions, Math.max(30_000, jobTtlMs / 6));
  sweeper.unref?.();
}

function stopSweeper() {
  if (!sweeper) {
    return;
  }
  clearInterval(sweeper);
  sweeper = null;
}
