/** Shared stream-liveness progress reporting for streaming model backends. */
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

/**
 * Streaming providers, local or remote, are expected to produce chunks or
 * heartbeat-style progress. Every observed chunk refreshes the in-memory
 * freshness clock the stuck-session watchdog reads, or a turn that is still
 * producing output ages into `active_work_without_progress` and gets aborted
 * mid-flight; diagnostic events stay throttled so token streams do not spam
 * observers. Silent backends refresh nothing and remain recoverable after the
 * stuck-session timeout.
 */
export function createModelCallStreamProgressReporter(): (
  target: ModelCallStreamProgressTarget,
) => void {
  let lastEmittedAtMs: number | undefined;
  return (target) => {
    if (!areDiagnosticsEnabledForProcess()) {
      return;
    }
    const fields = {
      runId: target.runId,
      ...(target.sessionKey ? { sessionKey: target.sessionKey } : {}),
      ...(target.sessionId ? { sessionId: target.sessionId } : {}),
      reason: MODEL_CALL_STREAM_PROGRESS_REASON,
    };
    markDiagnosticRunProgress(fields);
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
