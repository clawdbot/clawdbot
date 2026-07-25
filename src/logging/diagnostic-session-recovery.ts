// Diagnostic session recovery types describe session recovery diagnostic payloads.
import type {
  DiagnosticSessionActiveWorkKind,
  DiagnosticSessionState,
} from "../infra/diagnostic-events.js";

type DiagnosticSessionRecoverySkipReason =
  | "active_embedded_run"
  | "active_reply_work"
  | "deferred_maintenance_wait"
  | "active_lane_task"
  | "already_in_flight"
  | "missing_session_ref"
  | "stale_session_state";

type DiagnosticSessionRecoveryNoopReason = "no_active_work";

export type StuckSessionRecoveryRequest = {
  sessionId?: string;
  sessionKey?: string;
  sessionFile?: string;
  ageMs: number;
  queueDepth?: number;
  allowActiveAbort?: boolean;
  expectedState?: DiagnosticSessionState;
  stateGeneration?: number;
  /**
   * Built-in no-forward-progress age after
   * which an "active" run with queued work is treated as a leaked/dead handle and
   * reclaimed. Honors an operator-raised threshold; falls back to a safe floor.
   */
  staleActiveProgressAbortMs?: number;
  /**
   * Resolved compaction safety timeout. Ownerless lane recovery waits at least
   * this long plus settle grace so queued compaction cannot be double-run.
   */
  compactionSafetyTimeoutMs?: number;
};

export function resolveStuckSessionRecoveryRef(
  params: Pick<StuckSessionRecoveryRequest, "sessionId" | "sessionKey">,
): string | undefined {
  // In-flight recovery gates must key by logical session only; generation is
  // stale-state evidence, not concurrency identity.
  return params.sessionKey?.trim() || params.sessionId?.trim() || undefined;
}

type DiagnosticSessionRecoveryBaseOutcome = {
  sessionId?: string;
  sessionKey?: string;
  activeSessionId?: string;
  lane?: string;
  activeWorkKind?: DiagnosticSessionActiveWorkKind;
};

export type StuckSessionRecoveryOutcome =
  | (DiagnosticSessionRecoveryBaseOutcome & {
      status: "aborted";
      action: "abort_embedded_run";
      aborted: boolean;
      drained: boolean;
      forceCleared: boolean;
      released: number;
      queuedCount?: number;
    })
  | (DiagnosticSessionRecoveryBaseOutcome & {
      status: "released";
      action: "release_lane";
      reason?: "stale_lane_task";
      released: number;
      queuedCount?: number;
    })
  | (DiagnosticSessionRecoveryBaseOutcome & {
      status: "skipped";
      action: "observe_only" | "keep_lane";
      reason: DiagnosticSessionRecoverySkipReason;
      activeCount?: number;
      queuedCount?: number;
    })
  | (DiagnosticSessionRecoveryBaseOutcome & {
      status: "noop";
      action: "none";
      reason: DiagnosticSessionRecoveryNoopReason;
    })
  | (DiagnosticSessionRecoveryBaseOutcome & {
      status: "failed";
      action: "none";
      reason: "exception";
      error: string;
    });

export function recoveryOutcomeMutatesSessionState(
  outcome: StuckSessionRecoveryOutcome | undefined,
): boolean {
  if (!outcome) {
    return false;
  }
  return (
    outcome.status === "aborted" ||
    outcome.status === "released" ||
    (outcome.status === "noop" && outcome.reason === "no_active_work")
  );
}

export function recoveryOutcomeClearsQueuedSessionState(
  outcome: StuckSessionRecoveryOutcome,
): boolean {
  return (
    outcome.status === "released" ||
    (outcome.status === "aborted" && outcome.released > 0 && (outcome.queuedCount ?? 0) === 0) ||
    (outcome.status === "noop" && outcome.reason === "no_active_work")
  );
}

export function recoveryOutcomeReleasedCount(outcome: StuckSessionRecoveryOutcome): number {
  return "released" in outcome ? outcome.released : 0;
}

export function formatRecoveryOutcome(outcome: StuckSessionRecoveryOutcome): string {
  const fields = [
    `status=${outcome.status}`,
    `action=${outcome.action}`,
    `sessionId=${outcome.sessionId ?? outcome.activeSessionId ?? "unknown"}`,
    `sessionKey=${outcome.sessionKey ?? "unknown"}`,
  ];
  if (outcome.activeSessionId) {
    fields.push(`activeSessionId=${outcome.activeSessionId}`);
  }
  if (outcome.activeWorkKind) {
    fields.push(`activeWorkKind=${outcome.activeWorkKind}`);
  }
  if (outcome.lane) {
    fields.push(`lane=${outcome.lane}`);
  }
  if ("reason" in outcome) {
    fields.push(`reason=${outcome.reason}`);
  }
  if ("aborted" in outcome) {
    fields.push(
      `aborted=${outcome.aborted}`,
      `drained=${outcome.drained}`,
      `forceCleared=${outcome.forceCleared}`,
    );
  }
  if ("released" in outcome) {
    fields.push(`released=${outcome.released}`);
  }
  if (
    (outcome.status === "aborted" || outcome.status === "released") &&
    outcome.queuedCount !== undefined
  ) {
    fields.push(`queuedCount=${outcome.queuedCount}`);
  }
  if ("activeCount" in outcome && outcome.activeCount !== undefined) {
    fields.push(`laneActive=${outcome.activeCount}`);
  }
  if (outcome.status === "skipped" && outcome.queuedCount !== undefined) {
    fields.push(`laneQueued=${outcome.queuedCount}`);
  }
  if ("error" in outcome) {
    fields.push(`error=${outcome.error}`);
  }
  return fields.join(" ");
}
