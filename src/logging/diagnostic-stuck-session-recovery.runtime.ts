import { resolveEmbeddedSessionLane } from "../agents/pi-embedded-runner/lanes.js";
import {
  abortEmbeddedPiRun,
  forceClearEmbeddedPiRun,
  isEmbeddedPiRunActive,
  isEmbeddedPiRunHandleActive,
  resolveActiveEmbeddedRunSessionId,
  resolveActiveEmbeddedRunHandleSessionId,
  waitForEmbeddedPiRunEnd,
} from "../agents/pi-embedded-runner/runs.js";
import { getCommandLaneSnapshot, resetCommandLane } from "../process/command-queue.js";
import { diagnosticLogger as diag } from "./diagnostic-runtime.js";

const STUCK_SESSION_ABORT_SETTLE_MS = 15_000;
const recoveriesInFlight = new Set<string>();

export type StuckSessionRecoveryParams = {
  sessionId?: string;
  sessionKey?: string;
  ageMs: number;
  queueDepth?: number;
  allowActiveAbort?: boolean;
};

function recoveryKey(params: StuckSessionRecoveryParams): string | undefined {
  return params.sessionKey?.trim() || params.sessionId?.trim() || undefined;
}

export async function recoverStuckDiagnosticSession(
  params: StuckSessionRecoveryParams,
): Promise<void> {
  const key = recoveryKey(params);
  if (!key || recoveriesInFlight.has(key)) {
    return;
  }

  recoveriesInFlight.add(key);
  try {
    const fallbackActiveSessionId =
      params.sessionId && isEmbeddedPiRunHandleActive(params.sessionId)
        ? params.sessionId
        : undefined;
    const activeSessionId = params.sessionKey
      ? (resolveActiveEmbeddedRunHandleSessionId(params.sessionKey) ?? fallbackActiveSessionId)
      : fallbackActiveSessionId;
    const activeWorkSessionId = params.sessionKey
      ? (resolveActiveEmbeddedRunSessionId(params.sessionKey) ?? params.sessionId)
      : params.sessionId;
    const laneKey = params.sessionKey?.trim() || params.sessionId?.trim();
    const sessionLane = laneKey ? resolveEmbeddedSessionLane(laneKey) : null;
    let aborted = false;
    let drained = true;

    if (activeSessionId) {
      if (params.allowActiveAbort !== true) {
        diag.debug(
          `stuck session recovery skipped active abort: sessionId=${
            params.sessionId ?? activeSessionId
          } sessionKey=${params.sessionKey ?? "unknown"} age=${Math.round(
            params.ageMs / 1000,
          )}s queueDepth=${params.queueDepth ?? 0}`,
        );
        return;
      }
      aborted = abortEmbeddedPiRun(activeSessionId);
      if (aborted) {
        drained = await waitForEmbeddedPiRunEnd(activeSessionId, STUCK_SESSION_ABORT_SETTLE_MS);
      }
      if (!aborted || !drained) {
        forceClearEmbeddedPiRun(activeSessionId, params.sessionKey, "stuck_recovery");
      }
    }

    if (!activeSessionId && activeWorkSessionId && isEmbeddedPiRunActive(activeWorkSessionId)) {
      diag.debug(
        `stuck session recovery skipped lane reset: active reply work sessionId=${activeWorkSessionId} sessionKey=${
          params.sessionKey ?? "unknown"
        } age=${Math.round(params.ageMs / 1000)}s queueDepth=${params.queueDepth ?? 0}`,
      );
      return;
    }

    if (!activeSessionId && sessionLane) {
      const laneSnapshot = getCommandLaneSnapshot(sessionLane);
      if (laneSnapshot.activeCount > 0) {
        diag.debug(
          `stuck session recovery skipped lane reset: active lane task lane=${sessionLane} active=${laneSnapshot.activeCount} queued=${laneSnapshot.queuedCount} sessionId=${
            params.sessionId ?? "unknown"
          } sessionKey=${params.sessionKey ?? "unknown"} age=${Math.round(params.ageMs / 1000)}s`,
        );
        return;
      }
    }

    const released =
      sessionLane && (!activeSessionId || !aborted || !drained) ? resetCommandLane(sessionLane) : 0;

    if (aborted || released > 0) {
      diag.warn(
        `stuck session recovery: sessionId=${params.sessionId ?? activeSessionId ?? "unknown"} sessionKey=${
          params.sessionKey ?? "unknown"
        } age=${Math.round(params.ageMs / 1000)}s aborted=${aborted} drained=${drained} released=${released}`,
      );
    }
  } catch (err) {
    diag.warn(
      `stuck session recovery failed: sessionId=${params.sessionId ?? "unknown"} sessionKey=${
        params.sessionKey ?? "unknown"
      } err=${String(err)}`,
    );
  } finally {
    recoveriesInFlight.delete(key);
  }
}

export const __testing = {
  resetRecoveriesInFlight(): void {
    recoveriesInFlight.clear();
  },
};
