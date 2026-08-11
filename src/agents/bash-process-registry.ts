/**
 * In-memory registry for bash exec sessions.
 * Tracks running/backgrounded sessions, bounded pending output, finished
 * session retention, and process cleanup for reconnect/poll flows.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { EventSessionRoutingPolicy } from "../infra/event-session-routing.js";
import type { TerminationReason } from "../process/supervisor/types.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import { readEnvInt } from "./bash-tools.shared.js";

const DEFAULT_JOB_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MIN_JOB_TTL_MS = 60 * 1000; // 1 minute
const MAX_JOB_TTL_MS = 3 * 60 * 60 * 1000; // 3 hours
const DEFAULT_PENDING_OUTPUT_CHARS = 30_000;
const MAX_FINISHED_SESSION_COUNT = 50;
const MAX_FINISHED_SESSION_OUTPUT_CHARS = 2_000_000;

function clampTtl(value: number | undefined) {
  if (value === undefined || Number.isNaN(value)) {
    return DEFAULT_JOB_TTL_MS;
  }
  return Math.min(Math.max(value, MIN_JOB_TTL_MS), MAX_JOB_TTL_MS);
}

let jobTtlMs = clampTtl(readEnvInt("OPENCLAW_BASH_JOB_TTL_MS", "PI_BASH_JOB_TTL_MS"));

/** Lifecycle status recorded for background process sessions. */
type ProcessStatus = "running" | "completed" | "failed" | "killed";

/** Writable stdin surface prepared by the supervisor for child and PTY sessions. */
type SessionStdin = {
  write: (data: string, cb?: (err?: Error | null) => void) => void;
  end: () => void;
  // Child and PTY wrappers both expose destroy today; keep it optional for alternate backends.
  destroy?: () => void;
  destroyed?: boolean;
  writable?: boolean;
  writableEnded?: boolean;
  writableFinished?: boolean;
};

/** Removes one queued notify-on-exit event, if it is still pending. */
type NotifyOnExitRemoval = () => boolean;

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
  /** Set when process poll observed the terminal result before notification. */
  terminalPollObserved?: boolean;
  notifyOnExitRemoval?: NotifyOnExitRemoval;
  // Deprecated declaration-closure compatibility only; runtime never uses this.
  // ProcessSupervisor owns raw processes. Remove when the public Plugin SDK closure no
  // longer reaches registry types, or at the next compatible boundary change.
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
  /** Output was dropped from the pending poll buffers since their last drain. */
  pendingOutputDropped: boolean;
  aggregated: string;
  tail: string;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | number | null;
  exitReason?: TerminationReason;
  /** Preserve the lifecycle owner's verdict for polls that captured the running session. */
  terminalStatus?: Exclude<ProcessStatus, "running">;
  noOutputTimedOut?: boolean;
  exited: boolean;
  /** Process exit observed; backend cleanup still owns the terminal transition. */
  finalizing?: boolean;
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
  unreadOutput?: ReturnType<typeof drainSession>;
  terminalPollObserved?: boolean;
  notifyOnExitRemoval?: NotifyOnExitRemoval;
}

const runningSessions = new Map<string, ProcessSession>();
const finishedSessions = new Map<string, FinishedSession>();
let finishedSessionsByProcess = new WeakMap<ProcessSession, FinishedSession>();
const activeBackgroundExecSessionIds = new Set<string>();
let finishedSessionOutputChars = 0;

let sweeper: NodeJS.Timeout | null = null;

/** Return whether a process session id is live, retained, or reserved for notification. */
export function isProcessSessionIdTaken(id: string): boolean {
  return (
    runningSessions.has(id) || finishedSessions.has(id) || activeBackgroundExecSessionIds.has(id)
  );
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

/** Returns the terminal snapshot owned by this exact process incarnation. */
export function getFinishedSessionForProcess(session: ProcessSession) {
  return finishedSessionsByProcess.get(session);
}

function deleteFinishedSession(id: string): boolean {
  const session = finishedSessions.get(id);
  if (!session) {
    return false;
  }
  finishedSessions.delete(id);
  finishedSessionOutputChars -= session.aggregated.length;
  return true;
}

/** Removes visible session records without changing live-process activity. */
export function deleteSession(id: string) {
  runningSessions.delete(id);
  deleteFinishedSession(id);
}

/** Removes completed process records belonging to retired session identities. */
export function clearFinishedSessionsForScopes(scopeKeys: Iterable<string>): void {
  const retiredScopes = new Set<string>();
  for (const scopeKey of scopeKeys) {
    const normalizedScope = scopeKey.trim();
    if (normalizedScope) {
      retiredScopes.add(normalizedScope);
    }
  }
  if (retiredScopes.size === 0) {
    return;
  }
  for (const [id, session] of finishedSessions) {
    if (session.scopeKey && retiredScopes.has(session.scopeKey)) {
      deleteFinishedSession(id);
    }
  }
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
    session.pendingOutputDropped = true;
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
  const outputDropped = session.pendingOutputDropped;
  session.pendingStdout = [];
  session.pendingStderr = [];
  session.pendingStdoutChars = 0;
  session.pendingStderrChars = 0;
  session.pendingOutputDropped = false;
  return { stdout, stderr, outputDropped };
}

/** Consumes the output transferred to one exact terminal snapshot. */
export function drainFinishedSession(session: FinishedSession) {
  const output = session.unreadOutput;
  session.unreadOutput = undefined;
  return output ?? { stdout: "", stderr: "", outputDropped: false };
}

/** Moves a session to finished state and records exit metadata. */
export function markExited(
  session: ProcessSession,
  exitCode: number | null,
  exitSignal: NodeJS.Signals | number | null,
  status: Exclude<ProcessStatus, "running">,
  exitReason?: TerminationReason,
  noOutputTimedOut?: boolean,
) {
  // Visibility can be cleared before process termination. Keep suspension
  // blocked until the process owner reports the actual terminal transition.
  activeBackgroundExecSessionIds.delete(session.id);
  session.terminalStatus = status;
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

/** Records that a terminal process poll consumed the process result. */
export function markTerminalPollObserved(session: ProcessSession): void {
  session.terminalPollObserved = true;
  const finished = finishedSessionsByProcess.get(session);
  if (finished) {
    finished.terminalPollObserved = true;
  }
}

/** Retains the precise event removal handle across the finished-session move. */
export function recordNotifyOnExitRemoval(
  session: ProcessSession,
  remove: NotifyOnExitRemoval,
): void {
  if (session.terminalPollObserved) {
    remove();
    return;
  }
  session.notifyOnExitRemoval = remove;
  const finished = finishedSessionsByProcess.get(session);
  if (finished) {
    finished.notifyOnExitRemoval = remove;
  }
}

/** Acknowledges one completion event without touching unrelated queue entries. */
export function acknowledgeNotifyOnExit(record: {
  notifyOnExitRemoval?: NotifyOnExitRemoval;
}): void {
  const remove = record.notifyOnExitRemoval;
  if (!remove) {
    return;
  }
  remove();
  record.notifyOnExitRemoval = undefined;
}

/** Reports owner-tracked process liveness even after visibility is removed. */
export function hasActiveBackgroundExecSession(sessionId: string): boolean {
  return activeBackgroundExecSessionIds.has(sessionId);
}

/** Returns the number of live background exec sessions without exposing process details. */
export function getActiveBackgroundExecSessionCount(): number {
  return activeBackgroundExecSessionIds.size;
}

function moveToFinished(session: ProcessSession, status: ProcessStatus) {
  runningSessions.delete(session.id);

  // The supervisor owns the raw process. The registry releases only the
  // prepared stdin wrapper retained for process-tool input.
  const stdin = session.stdin;
  if (stdin) {
    if (typeof stdin.destroy === "function") {
      stdin.destroy();
    } else if (typeof stdin.end === "function") {
      stdin.end();
    }
    delete session.stdin;
  }

  if (!session.backgrounded) {
    return;
  }
  // Keep full completed logs; evict older records rather than silently
  // truncating the process poll/log contract or dropping the newest result.
  deleteFinishedSession(session.id);
  const finished: FinishedSession = {
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
    unreadOutput: drainSession(session),
    ...(session.terminalPollObserved ? { terminalPollObserved: true } : {}),
    ...(session.notifyOnExitRemoval ? { notifyOnExitRemoval: session.notifyOnExitRemoval } : {}),
  };
  finishedSessionsByProcess.set(session, finished);
  finishedSessions.set(session.id, finished);
  finishedSessionOutputChars += session.aggregated.length;
  while (
    finishedSessions.size > MAX_FINISHED_SESSION_COUNT ||
    (finishedSessions.size > 1 && finishedSessionOutputChars > MAX_FINISHED_SESSION_OUTPUT_CHARS)
  ) {
    const oldestSessionId = finishedSessions.keys().next().value;
    if (oldestSessionId === undefined) {
      break;
    }
    deleteFinishedSession(oldestSessionId);
  }
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
    const firstChunk = buffer.at(0);
    if (firstChunk !== undefined) {
      const trimmedChunk = sliceUtf16Safe(firstChunk, overflow);
      buffer[0] = trimmedChunk;
      pendingChars -= firstChunk.length - trimmedChunk.length;
    }
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
function resetProcessRegistryForTests() {
  runningSessions.clear();
  finishedSessions.clear();
  finishedSessionsByProcess = new WeakMap();
  finishedSessionOutputChars = 0;
  activeBackgroundExecSessionIds.clear();
  stopSweeper();
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.bashProcessRegistryTestApi")] =
    { resetProcessRegistryForTests };
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
      deleteFinishedSession(id);
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
