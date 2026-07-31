// Diagnostic runtime helpers expose process runtime facts for diagnostics.
import {
  areDiagnosticsEnabledForProcess,
  emitInternalDiagnosticEvent as emitDiagnosticEvent,
} from "../infra/diagnostic-events.js";
import { getDiagnosticSessionState, type SessionRef } from "./diagnostic-session-state.js";
import { createSubsystemLogger } from "./subsystem.js";

// Shared diagnostic logger and queue-activity event helpers.
const diag = createSubsystemLogger("diagnostic");
let lastActivityAt = 0;

/** Root diagnostic subsystem logger. */
export const diagnosticLogger = diag;

/** Marks that diagnostics emitted useful activity. */
export function markDiagnosticActivity(): void {
  lastActivityAt = Date.now();
}

/** Returns the last diagnostic activity timestamp for watchdog-style checks. */
export function getLastDiagnosticActivityAt(): number {
  return lastActivityAt;
}

/** Clears diagnostic activity state for tests. */
export function resetDiagnosticActivityForTest(): void {
  lastActivityAt = 0;
}

type DiagnosticMessageQueueParams = SessionRef & {
  channel?: string;
  source: string;
};

/** Records queue activity while letting internal run owners distinguish steering from backlog. */
export function logMessageQueuedWithBacklogPolicy(
  params: DiagnosticMessageQueueParams,
  countsTowardBacklog: boolean,
): void {
  if (!areDiagnosticsEnabledForProcess()) {
    return;
  }
  const state = getDiagnosticSessionState(params);
  if (countsTowardBacklog) {
    state.queueDepth += 1;
  }
  state.lastActivity = Date.now();
  state.generation = (state.generation ?? 0) + 1;
  state.lastStuckWarnAgeMs = undefined;
  state.lastLongRunningWarnAgeMs = undefined;
  if (diag.isEnabled("debug")) {
    diag.debug(
      `message queued: sessionId=${state.sessionId ?? "unknown"} sessionKey=${
        state.sessionKey ?? "unknown"
      } source=${params.source} queueDepth=${state.queueDepth} sessionState=${state.state}`,
    );
  }
  emitDiagnosticEvent({
    type: "message.queued",
    sessionId: state.sessionId,
    sessionKey: state.sessionKey,
    channel: params.channel,
    source: params.source,
    queueDepth: state.queueDepth,
  });
  markDiagnosticActivity();
}

/** Logs and emits a diagnostic event when work enters a serialized lane. */
export function logLaneEnqueue(lane: string, queueSize: number): void {
  if (!areDiagnosticsEnabledForProcess()) {
    return;
  }
  diag.debug(`lane enqueue: lane=${lane} queueSize=${queueSize}`);
  emitDiagnosticEvent({
    type: "queue.lane.enqueue",
    lane,
    queueSize,
  });
  markDiagnosticActivity();
}

/** Logs and emits a diagnostic event when work leaves a serialized lane. */
export function logLaneDequeue(lane: string, waitMs: number, queueSize: number): void {
  if (!areDiagnosticsEnabledForProcess()) {
    return;
  }
  diag.debug(`lane dequeue: lane=${lane} waitMs=${waitMs} queueSize=${queueSize}`);
  emitDiagnosticEvent({
    type: "queue.lane.dequeue",
    lane,
    queueSize,
    waitMs,
  });
  markDiagnosticActivity();
}
