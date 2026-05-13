import type { DiagnosticSessionActiveWorkKind } from "../infra/diagnostic-events.js";

export type DiagnosticSessionRecoveryStatus =
  | "aborted"
  | "released"
  | "skipped"
  | "noop"
  | "failed";

export type DiagnosticSessionRecoverySkipReason =
  | "active_embedded_run"
  | "active_reply_work"
  | "active_lane_task"
  | "already_in_flight"
  | "missing_session_ref"
  | "stale_session_state";

export type DiagnosticSessionRecoveryNoopReason = "no_active_work";

export type StuckSessionRecoveryRequest = {
  sessionId?: string;
  sessionKey?: string;
  ageMs: number;
  queueDepth?: number;
  allowActiveAbort?: boolean;
  stateGeneration?: number;
};

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
    })
  | (DiagnosticSessionRecoveryBaseOutcome & {
      status: "released";
      action: "release_lane";
      released: number;
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
  if ("activeCount" in outcome && outcome.activeCount !== undefined) {
    fields.push(`laneActive=${outcome.activeCount}`);
  }
  if ("queuedCount" in outcome && outcome.queuedCount !== undefined) {
    fields.push(`laneQueued=${outcome.queuedCount}`);
  }
  if ("error" in outcome) {
    fields.push(`error=${outcome.error}`);
  }
  return fields.join(" ");
}
