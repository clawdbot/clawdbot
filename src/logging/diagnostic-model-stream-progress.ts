import {
  areDiagnosticsEnabledForProcess,
  emitTrustedDiagnosticEvent,
} from "../infra/diagnostic-events.js";
import { markDiagnosticRunProgress } from "./diagnostic-run-activity.js";

const MODEL_CALL_STREAM_PROGRESS_INTERVAL_MS = 30_000;

/** Canonical progress reason for model output observed on a live backend stream. */
const MODEL_CALL_STREAM_PROGRESS_REASON = "model_call:stream_progress";

export type ModelCallStreamProgressTarget = {
  runId: string;
  sessionKey?: string;
  sessionId?: string;
};

// Refresh recovery on every chunk, but throttle public events. Owner-bound
// callbacks also reject late output without refreshing a replacement's clock.
export function createModelCallStreamProgressReporter(
  recordProgress?: () => boolean,
): (target: ModelCallStreamProgressTarget) => void {
  let lastEmittedAtMs: number | undefined;
  return (target) => {
    if (recordProgress && !recordProgress()) {
      return;
    }
    if (!areDiagnosticsEnabledForProcess()) {
      return;
    }
    const fields = {
      runId: target.runId,
      ...(target.sessionKey ? { sessionKey: target.sessionKey } : {}),
      ...(target.sessionId ? { sessionId: target.sessionId } : {}),
      reason: MODEL_CALL_STREAM_PROGRESS_REASON,
    };
    if (!recordProgress) {
      markDiagnosticRunProgress(fields);
    }
    const now = Date.now();
    if (
      lastEmittedAtMs !== undefined &&
      now - lastEmittedAtMs < MODEL_CALL_STREAM_PROGRESS_INTERVAL_MS
    ) {
      return;
    }
    lastEmittedAtMs = now;
    emitTrustedDiagnosticEvent({ type: "run.progress", ...fields });
  };
}
