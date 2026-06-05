// Diagnostic runtime helpers expose process runtime facts for diagnostics.
import {
  areDiagnosticsEnabledForProcess,
  emitInternalDiagnosticEvent as emitDiagnosticEvent,
} from "../infra/diagnostic-events.js";
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
