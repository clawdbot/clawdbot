// Session recovery coordinator helpers orchestrate stuck-session diagnostics.
import {
  emitInternalDiagnosticEvent as emitDiagnosticEvent,
  getInternalDiagnosticEventSequence,
} from "../infra/diagnostic-events.js";
import {
  clearDiagnosticEmbeddedRunActivityForSession,
  getDiagnosticEmbeddedRunActivitySequence,
} from "./diagnostic-run-activity.js";
import { markDiagnosticActivity as markActivity } from "./diagnostic-runtime.js";
import type { SessionAttentionClassification } from "./diagnostic-session-attention.js";
import {
  recoveryOutcomeClearsQueuedSessionState,
  recoveryOutcomeMutatesSessionState,
  recoveryOutcomeReleasedCount,
  resolveStuckSessionRecoveryRef,
  type StuckSessionRecoveryOutcome,
  type StuckSessionRecoveryRequest,
} from "./diagnostic-session-recovery.js";
import {
  getDiagnosticSessionState,
  isDiagnosticSessionStateCurrent,
  peekDiagnosticSessionState,
} from "./diagnostic-session-state.js";

export type RecoverStuckSession = (
  params: StuckSessionRecoveryRequest,
) => void | StuckSessionRecoveryOutcome | Promise<void | StuckSessionRecoveryOutcome>;

const recoveryRequestsInFlight = new Set<string>();

function emitSessionRecoveryRequested(params: {
  request: StuckSessionRecoveryRequest;
  classification: SessionAttentionClassification;
}): void {
  emitDiagnosticEvent({
    type: "session.recovery.requested",
    sessionId: params.request.sessionId,
    sessionKey: params.request.sessionKey,
    state: params.request.expectedState ?? "processing",
    stateGeneration: params.request.stateGeneration,
    ageMs: params.request.ageMs,
    queueDepth: params.request.queueDepth,
    reason: params.classification.reason,
    activeWorkKind: params.classification.activeWorkKind,
    allowActiveAbort: params.request.allowActiveAbort,
  });
}

function emitSessionRecoveryCompleted(params: {
  request: StuckSessionRecoveryRequest;
  outcome: StuckSessionRecoveryOutcome;
  stale?: boolean;
}): void {
  emitDiagnosticEvent({
    type: "session.recovery.completed",
    sessionId: params.request.sessionId,
    sessionKey: params.request.sessionKey,
    state: params.request.expectedState ?? "processing",
    stateGeneration: params.request.stateGeneration,
    ageMs: params.request.ageMs,
    queueDepth: params.request.queueDepth,
    activeWorkKind: params.outcome.activeWorkKind,
    status: params.outcome.status,
    action: params.outcome.action,
    outcomeReason: "reason" in params.outcome ? params.outcome.reason : undefined,
    released: recoveryOutcomeReleasedCount(params.outcome) || undefined,
    stale: params.stale,
  });
}

function recoveryRequestKey(request: StuckSessionRecoveryRequest): string | undefined {
  return resolveStuckSessionRecoveryRef(request);
}

function isRecoveryPromiseLike(
  value: void | StuckSessionRecoveryOutcome | Promise<void | StuckSessionRecoveryOutcome>,
): value is Promise<void | StuckSessionRecoveryOutcome> {
  return (
    typeof (value as Promise<void | StuckSessionRecoveryOutcome> | undefined)?.then === "function"
  );
}

function recoveryOutcomeHasQueuedLaneWork(outcome: StuckSessionRecoveryOutcome): boolean {
  return outcome.status === "aborted" && (outcome.queuedCount ?? 0) > 0;
}

function applyRecoveryOutcomeToDiagnosticState(params: {
  request: StuckSessionRecoveryRequest;
  outcome: StuckSessionRecoveryOutcome | undefined;
  recoveryStartedAfterEmbeddedRunSequence?: number;
  recoveryStartedAfterDiagnosticEventSequence?: number;
}): void {
  if (!params.outcome) {
    return;
  }
  if (!recoveryOutcomeMutatesSessionState(params.outcome)) {
    emitSessionRecoveryCompleted({ request: params.request, outcome: params.outcome });
    return;
  }
  const expectedState = params.request.expectedState ?? "processing";
  const currentState = peekDiagnosticSessionState(params.request);
  const currentGeneration = currentState?.generation ?? 0;
  const requestGeneration = params.request.stateGeneration ?? 0;
  const stateIsCurrent =
    expectedState === "idle" &&
    params.request.stateGeneration !== undefined &&
    params.outcome.action === "abort_embedded_run"
      ? currentState?.state === "idle" &&
        (currentGeneration === requestGeneration || currentGeneration === requestGeneration + 1)
      : isDiagnosticSessionStateCurrent({
          sessionId: params.request.sessionId,
          sessionKey: params.request.sessionKey,
          generation: params.request.stateGeneration,
          state: expectedState,
        });
  if (!stateIsCurrent) {
    emitSessionRecoveryCompleted({
      request: params.request,
      outcome: params.outcome,
      stale: true,
    });
    return;
  }
  const state = getDiagnosticSessionState(params.request);
  // The idle declaration is authoritative for the recovered owner only. If a
  // different embedded owner appeared under the same session key while recovery
  // awaited abort/drain, keep the lane active instead of erasing fresh work.
  const activityClear = clearDiagnosticEmbeddedRunActivityForSession({
    sessionId: state.sessionId,
    sessionKey: state.sessionKey,
    activeSessionId: params.outcome.activeSessionId,
    recoveryStartedAfterEmbeddedRunSequence: params.recoveryStartedAfterEmbeddedRunSequence,
    recoveryStartedAfterDiagnosticEventSequence: params.recoveryStartedAfterDiagnosticEventSequence,
  });
  if (activityClear.blockedByActiveEmbeddedRun) {
    emitSessionRecoveryCompleted({
      request: params.request,
      outcome: params.outcome,
      stale: true,
    });
    return;
  }
  const prevState = state.state;
  state.state = "idle";
  state.lastActivity = Date.now();
  state.generation = (state.generation ?? 0) + 1;
  state.lastStuckWarnAgeMs = undefined;
  state.lastLongRunningWarnAgeMs = undefined;
  const preserveQueuedIdleWork =
    params.request.expectedState === "idle" && recoveryOutcomeHasQueuedLaneWork(params.outcome);
  state.queueDepth = recoveryOutcomeClearsQueuedSessionState(params.outcome)
    ? 0
    : preserveQueuedIdleWork
      ? Math.max(state.queueDepth, params.request.queueDepth ?? 0)
      : Math.max(0, state.queueDepth - 1);
  emitDiagnosticEvent({
    type: "session.state",
    sessionId: state.sessionId,
    sessionKey: state.sessionKey,
    prevState,
    state: "idle",
    reason: `stuck_recovery:${params.outcome.status}`,
    queueDepth: state.queueDepth,
  });
  emitSessionRecoveryCompleted({ request: params.request, outcome: params.outcome });
  markActivity();
}

export function requestStuckSessionRecovery(params: {
  recover: RecoverStuckSession;
  request: StuckSessionRecoveryRequest;
  classification: SessionAttentionClassification;
}): void {
  const inFlightKey = recoveryRequestKey(params.request);
  if (inFlightKey && recoveryRequestsInFlight.has(inFlightKey)) {
    emitSessionRecoveryCompleted({
      request: params.request,
      outcome: {
        status: "skipped",
        action: "observe_only",
        reason: "already_in_flight",
        sessionId: params.request.sessionId,
        sessionKey: params.request.sessionKey,
        activeWorkKind: params.classification.activeWorkKind,
      },
    });
    return;
  }
  if (inFlightKey) {
    recoveryRequestsInFlight.add(inFlightKey);
  }
  emitSessionRecoveryRequested({
    request: params.request,
    classification: params.classification,
  });
  const recoveryStartedAfterEmbeddedRunSequence = getDiagnosticEmbeddedRunActivitySequence();
  const recoveryStartedAfterDiagnosticEventSequence = getInternalDiagnosticEventSequence();
  const clearInFlight = () => {
    if (inFlightKey) {
      recoveryRequestsInFlight.delete(inFlightKey);
    }
  };
  const failRecovery = (err: unknown) => {
    applyRecoveryOutcomeToDiagnosticState({
      request: params.request,
      outcome: {
        status: "failed",
        action: "none",
        reason: "exception",
        sessionId: params.request.sessionId,
        sessionKey: params.request.sessionKey,
        error: String(err),
      },
      recoveryStartedAfterEmbeddedRunSequence,
      recoveryStartedAfterDiagnosticEventSequence,
    });
  };
  try {
    const result = params.recover(params.request);
    if (isRecoveryPromiseLike(result)) {
      void result
        .then((outcome) => {
          applyRecoveryOutcomeToDiagnosticState({
            request: params.request,
            outcome: outcome ?? undefined,
            recoveryStartedAfterEmbeddedRunSequence,
            recoveryStartedAfterDiagnosticEventSequence,
          });
        })
        .catch(failRecovery)
        .finally(clearInFlight);
      return;
    }
    applyRecoveryOutcomeToDiagnosticState({
      request: params.request,
      outcome: result ?? undefined,
      recoveryStartedAfterEmbeddedRunSequence,
      recoveryStartedAfterDiagnosticEventSequence,
    });
    clearInFlight();
  } catch (err) {
    try {
      failRecovery(err);
    } finally {
      clearInFlight();
    }
  }
}

export function resetDiagnosticSessionRecoveryCoordinatorForTest(): void {
  recoveryRequestsInFlight.clear();
}
