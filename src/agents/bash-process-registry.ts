/**
 * In-memory registry for bash exec sessions.
 * Tracks running/backgrounded sessions, bounded pending output, finished
 * session retention, and process cleanup for reconnect/poll flows.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { EventSessionRoutingPolicy } from "../infra/event-session-routing.js";
import type { TerminationReason } from "../process/supervisor/types.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
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

type PendingOutputChunk = {
  stream: "stdout" | "stderr";
  text: string;
};

type PendingPollDelivery = {
  output: string;
  outputDropped: boolean;
  scope: object;
};

/** One process record from execution through completed retention. */
export interface ProcessSession {
  id: string;
  command: string;
  scopeKey?: string;
  sessionKey?: string;
  /** Agent owner frozen when the exec process starts. */
  agentId?: string;
  /** Start-time routing policy for detached exec system events. */
  eventRouting?: EventSessionRoutingPolicy;
  notifyDeliveryContext?: DeliveryContext;
  notifyOnExit?: boolean;
  notifyOnExitEmptySuccess?: boolean;
  exitNotified?: boolean;
  /** Set only after a terminal poll result is delivered or persisted. */
  terminalPollObserved?: boolean;
  notifyOnExitRemoval?: NotifyOnExitRemoval;
  // Deprecated declaration-closure compatibility only; runtime never uses this.
  // ProcessSupervisor owns raw processes. Remove when the public Plugin SDK closure no
  // longer reaches registry types, or at the next compatible boundary change.
  child?: ChildProcessWithoutNullStreams;
  stdin?: SessionStdin;
  pid?: number;
  startedAt: number;
  /** Set only on admission to completed retention; survives index removal. */
  endedAt?: number;
  cwd?: string;
  maxOutputChars: number;
  pendingMaxOutputChars?: number;
  totalOutputChars: number;
  /** Live chunks become frozen text at completion, releasing the chunk graph. */
  pendingOutput: PendingOutputChunk[] | string;
  pendingStdoutChars: number;
  pendingStderrChars: number;
  /** Output was dropped from the pending poll buffers since their last drain. */
  pendingOutputDropped: boolean;
  /** Output prepared for a poll but not yet attached to the agent transcript. */
  pendingPollDelivery?: PendingPollDelivery;
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

const runningSessions = new Map<string, ProcessSession>();
const finishedSessions = new Map<string, ProcessSession & { endedAt: number }>();
// Display uses start chronology; retained records are evicted in completion order.
let processSessionStartOrders = new WeakMap<object, number>();
let nextProcessSessionStartOrder = 0;
// Promotion stays live when process removal clears its presentation state.
const activeExecSessions = new Map<
  string,
  { session: ProcessSession; promoted: boolean; settled?: Deferred }
>();
let finishedSessionOutputChars = 0;

let sweeper: NodeJS.Timeout | null = null;

/** Return whether a process session id is live, retained, or reserved for notification. */
export function isProcessSessionIdTaken(id: string): boolean {
  return runningSessions.has(id) || finishedSessions.has(id) || activeExecSessions.has(id);
}

/** Adds a running session and starts retention sweeping if needed. */
export function addSession(session: ProcessSession) {
  processSessionStartOrders.set(session, nextProcessSessionStartOrder++);
  runningSessions.set(session.id, session);
  activeExecSessions.set(session.id, { session, promoted: session.backgrounded });
  startSweeper();
}

/** Sorts registered process records newest-first, including same-millisecond starts. */
export function compareProcessSessionStartOrder(
  left: { startedAt: number },
  right: { startedAt: number },
): number {
  return (
    right.startedAt - left.startedAt ||
    processSessionStartOrders.get(right)! - processSessionStartOrders.get(left)!
  );
}

/** Returns a running session by id. */
export function getSession(id: string) {
  return runningSessions.get(id);
}

/** Returns a retained finished background session by id. */
export function getFinishedSession(id: string) {
  return finishedSessions.get(id);
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
  if (typeof session.pendingOutput === "string") {
    return;
  }
  const streamChars = stream === "stdout" ? session.pendingStdoutChars : session.pendingStderrChars;
  const pendingCap = Math.min(
    session.pendingMaxOutputChars ?? DEFAULT_PENDING_OUTPUT_CHARS,
    session.maxOutputChars,
  );
  session.pendingOutput.push({ stream, text: chunk });
  let pendingChars = streamChars + chunk.length;
  if (pendingChars > pendingCap) {
    session.truncated = true;
    session.pendingOutputDropped = true;
    pendingChars = capPendingStream(session.pendingOutput, stream, pendingChars, pendingCap);
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

/** Drains pending chunks in producer callback order for a process poll. */
function drainSession(session: ProcessSession) {
  const pending = session.pendingOutput;
  const output =
    typeof pending === "string" ? pending : pending.map((chunk) => chunk.text).join("");
  const outputDropped = session.pendingOutputDropped;
  // Draining a terminal record must not reopen it to late producer callbacks.
  session.pendingOutput = typeof pending === "string" ? "" : [];
  session.pendingStdoutChars = 0;
  session.pendingStderrChars = 0;
  session.pendingOutputDropped = false;
  return { output, outputDropped };
}

/** Stages one poll result until the agent transcript acknowledges its attachment. */
export function prepareSessionPoll(session: ProcessSession, scope: object | undefined) {
  if (!scope) {
    return { ...drainSession(session), acknowledge() {} };
  }
  const pending = session.pendingPollDelivery;
  if (pending) {
    // The first retry claims the staged bytes for its turn. Parallel siblings then
    // observe that scope and cannot duplicate the recovery result.
    if (pending.scope === scope) {
      return { output: "", outputDropped: false, acknowledge() {} };
    }
    pending.scope = scope;
    return {
      output: pending.output,
      outputDropped: pending.outputDropped,
      acknowledge() {
        if (session.pendingPollDelivery === pending) {
          session.pendingPollDelivery = undefined;
        }
      },
    };
  }
  const drained = drainSession(session);
  if (drained.output.length === 0 && !drained.outputDropped) {
    return { ...drained, acknowledge() {} };
  }
  const delivery = { ...drained, scope };
  session.pendingPollDelivery = delivery;
  return {
    ...drained,
    acknowledge() {
      if (session.pendingPollDelivery === delivery) {
        session.pendingPollDelivery = undefined;
      }
    },
  };
}

/** Returns whether a prior poll has output ready for immediate replay. */
export function hasPendingPollDelivery(session: ProcessSession): boolean {
  return session.pendingPollDelivery !== undefined;
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
  session.terminalStatus = status;
  session.exited = true;
  session.exitCode = exitCode;
  session.exitSignal = exitSignal;
  session.exitReason = exitReason;
  session.noOutputTimedOut = noOutputTimedOut;
  session.tail = tail(session.aggregated, 2000);
  // Finalizer diagnostics are already appended. Freeze output before retention
  // accounts for its size, and release the live per-callback chunk objects.
  const pending = drainSession(session);
  session.pendingOutput = pending.output;
  session.pendingOutputDropped = pending.outputDropped;
  moveToFinished(session);
  const active = activeExecSessions.get(session.id);
  if (active?.session === session) {
    activeExecSessions.delete(session.id);
    // The exec owner's synchronous task/notification callbacks run before
    // these promise continuations resume and release the environment state.
    active.settled?.resolve();
  }
}

/** Marks a running session as reconnectable after the exec call returns. */
export function markBackgrounded(session: ProcessSession) {
  session.backgrounded = true;
  const active = activeExecSessions.get(session.id);
  if (active?.session === session) {
    active.promoted = true;
  }
}

/** Retains the precise completion-event removal handle on its process owner. */
export function recordNotifyOnExitRemoval(
  session: ProcessSession,
  remove: NotifyOnExitRemoval,
): void {
  if (session.terminalPollObserved) {
    remove();
    return;
  }
  session.notifyOnExitRemoval = remove;
}

/** Acknowledges one completion event without touching unrelated queue entries. */
export function acknowledgeNotifyOnExit(record: {
  notifyOnExitRemoval?: NotifyOnExitRemoval;
  terminalPollObserved?: boolean;
}): void {
  record.terminalPollObserved = true;
  const remove = record.notifyOnExitRemoval;
  if (!remove) {
    return;
  }
  remove();
  record.notifyOnExitRemoval = undefined;
}

/** Reports owner-tracked process liveness even after visibility is removed. */
export function hasActiveBackgroundExecSession(sessionId: string): boolean {
  return activeExecSessions.get(sessionId)?.promoted === true;
}

/** Returns the number of live background exec sessions without exposing process details. */
export function getActiveBackgroundExecSessionCount(): number {
  let count = 0;
  for (const { promoted } of activeExecSessions.values()) {
    if (promoted) {
      count += 1;
    }
  }
  return count;
}

/** Joins registered exec cleanup, including foreground and hidden processes. */
export async function waitForExecScope(scopeKey: string): Promise<void> {
  while (true) {
    const pending = Array.from(activeExecSessions.values())
      .filter(({ session }) => session.scopeKey === scopeKey)
      .map((active) => (active.settled ??= createDeferredCore()).promise);
    if (pending.length === 0) {
      return;
    }
    await Promise.all(pending);
  }
}

function moveToFinished(session: ProcessSession) {
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
  finishedSessions.set(session.id, Object.assign(session, { endedAt: Date.now() }));
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

function capPendingStream(
  output: PendingOutputChunk[],
  stream: PendingOutputChunk["stream"],
  pendingCharsInput: number,
  cap: number,
) {
  let pendingChars = pendingCharsInput;
  let overflow = pendingChars - cap;
  for (let index = 0; index < output.length && overflow > 0;) {
    const chunk = output[index];
    if (!chunk || chunk.stream !== stream) {
      index += 1;
      continue;
    }
    if (chunk.text.length <= overflow) {
      overflow -= chunk.text.length;
      pendingChars -= chunk.text.length;
      output.splice(index, 1);
      continue;
    }
    const trimmed = sliceUtf16Safe(chunk.text, overflow);
    const removedChars = chunk.text.length - trimmed.length;
    pendingChars -= removedChars;
    chunk.text = trimmed;
    break;
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
  processSessionStartOrders = new WeakMap();
  nextProcessSessionStartOrder = 0;
  finishedSessionOutputChars = 0;
  for (const active of activeExecSessions.values()) {
    active.settled?.resolve();
  }
  activeExecSessions.clear();
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
