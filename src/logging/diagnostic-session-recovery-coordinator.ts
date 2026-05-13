import { emitDiagnosticEvent } from "../infra/diagnostic-events.js";
import { markDiagnosticActivity as markActivity } from "./diagnostic-runtime.js";
import type { SessionAttentionClassification } from "./diagnostic-session-attention.js";
import {
  recoveryOutcomeClearsQueuedSessionState,
  recoveryOutcomeMutatesSessionState,
  recoveryOutcomeReleasedCount,
  type StuckSessionRecoveryOutcome,
  type StuckSessionRecoveryRequest,
} from "./diagnostic-session-recovery.js";
import {
  getDiagnosticSessionState,
  isDiagnosticSessionStateCurrent,
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
    state: "processing",
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
    state: "processing",
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
  const ref = request.sessionKey?.trim() || request.sessionId?.trim();
  if (!ref) {
    return undefined;
  }
  return `${ref}:${request.stateGeneration ?? "unknown"}`;
}

function isRecoveryPromiseLike(
  value: void | StuckSessionRecoveryOutcome | Promise<void | StuckSessionRecoveryOutcome>,
): value is Promise<void | StuckSessionRecoveryOutcome> {
  return (
    typeof (value as Promise<void | StuckSessionRecoveryOutcome> | undefined)?.then === "function"
  );
}

function applyRecoveryOutcomeToDiagnosticState(params: {
  request: StuckSessionRecoveryRequest;
  outcome: StuckSessionRecoveryOutcome | undefined;
}): void {
  if (!params.outcome) {
    return;
  }
  if (!recoveryOutcomeMutatesSessionState(params.outcome)) {
    emitSessionRecoveryCompleted({ request: params.request, outcome: params.outcome });
    return;
  }
  if (
    !isDiagnosticSessionStateCurrent({
      sessionId: params.request.sessionId,
      sessionKey: params.request.sessionKey,
      generation: params.request.stateGeneration,
      state: "processing",
    })
  ) {
    emitSessionRecoveryCompleted({
      request: params.request,
      outcome: params.outcome,
      stale: true,
    });
    return;
  }
  const state = getDiagnosticSessionState(params.request);
  const prevState = state.state;
  state.state = "idle";
  state.lastActivity = Date.now();
  state.generation = (state.generation ?? 0) + 1;
  state.lastStuckWarnAgeMs = undefined;
  state.lastLongRunningWarnAgeMs = undefined;
  state.queueDepth = recoveryOutcomeClearsQueuedSessionState(params.outcome)
    ? 0
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
          });
        })
        .catch(failRecovery)
        .finally(clearInFlight);
      return;
    }
    applyRecoveryOutcomeToDiagnosticState({
      request: params.request,
      outcome: result ?? undefined,
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
