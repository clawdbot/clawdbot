import { resolveCurrentDiagnosticRunId } from "./diagnostic-embedded-run-index.js";

// A semantic-stall clock remains continuous across short model/tool handoffs,
// but later model progress wins once no churn observation refreshes this lease.
const ARGUMENT_CHURN_CONTINUITY_WINDOW_MS = 60_000;

export type DiagnosticArgumentChurnActivity = {
  argumentChurnStartedAt?: number;
  argumentChurnObservationAt?: number;
  argumentChurnObservationSequence?: number;
  argumentChurnRunId?: string;
  argumentChurnPolicyWaitRunId?: string;
  argumentChurnPolicyWaitTokens?: Set<symbol>;
  lastProgressSequence?: number;
};

// Wall-clock timestamps measure staleness; this process-local order breaks
// same-millisecond ties between progress, churn observations, and merged refs.
let diagnosticActivitySequence = 0;

function nextDiagnosticActivitySequence(): number {
  diagnosticActivitySequence += 1;
  return diagnosticActivitySequence;
}

export function recordDiagnosticActivityProgress(activity: DiagnosticArgumentChurnActivity): void {
  activity.lastProgressSequence = nextDiagnosticActivitySequence();
}

export type DiagnosticArgumentChurnObservationParams = {
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
  active?: boolean;
  existingOnly?: boolean;
  policyWait?: "enter" | "exit";
  policyWaitToken?: symbol;
  now?: number;
};

function hasArgumentChurnContinuityExpired(
  activity: DiagnosticArgumentChurnActivity & { lastProgressAt?: number },
  now: number,
): boolean {
  const observationAt = activity.argumentChurnObservationAt;
  const lastProgressAt = activity.lastProgressAt;
  const observationSequence = activity.argumentChurnObservationSequence;
  const lastProgressSequence = activity.lastProgressSequence;
  const progressFollowedObservation =
    observationSequence !== undefined && lastProgressSequence !== undefined
      ? lastProgressSequence > observationSequence
      : lastProgressAt !== undefined &&
        observationAt !== undefined &&
        lastProgressAt > observationAt;
  return (
    observationAt !== undefined &&
    progressFollowedObservation &&
    now - observationAt >= ARGUMENT_CHURN_CONTINUITY_WINDOW_MS
  );
}

export function resolveArgumentChurnProgress(
  activity: DiagnosticArgumentChurnActivity & {
    lastProgressAt: number;
    lastProgressReason?: string;
  },
  currentOwnerRunId: string | undefined,
  now: number,
): { lastProgressAt: number; lastProgressReason?: string } {
  if (
    currentOwnerRunId !== undefined &&
    activity.argumentChurnPolicyWaitRunId === currentOwnerRunId &&
    (activity.argumentChurnPolicyWaitTokens?.size ?? 0) > 0
  ) {
    return { lastProgressAt: now, lastProgressReason: "tool_policy:pending" };
  }
  const startedAt = activity.argumentChurnStartedAt;
  const belongsToOwner =
    startedAt !== undefined && currentOwnerRunId === activity.argumentChurnRunId;
  if (!belongsToOwner) {
    return {
      lastProgressAt: activity.lastProgressAt,
      lastProgressReason: activity.lastProgressReason,
    };
  }
  if (hasArgumentChurnContinuityExpired(activity, now)) {
    return {
      lastProgressAt: activity.lastProgressAt,
      lastProgressReason: activity.lastProgressReason,
    };
  }
  return {
    lastProgressAt: startedAt,
    lastProgressReason: "tool_loop:argument_churn",
  };
}

function recordArgumentChurnActivityObservation(
  activity: DiagnosticArgumentChurnActivity & { lastProgressAt?: number },
  params: {
    runId?: string;
    active: boolean;
    existingOnly?: boolean;
    now: number;
  },
): void {
  if (
    params.existingOnly &&
    (activity.argumentChurnStartedAt === undefined || activity.argumentChurnRunId !== params.runId)
  ) {
    return;
  }
  if (!params.active) {
    if (activity.argumentChurnRunId === params.runId) {
      clearArgumentChurnActivity(activity, params);
    }
    return;
  }
  const continuityExpired = hasArgumentChurnContinuityExpired(activity, params.now);
  if (
    activity.argumentChurnStartedAt === undefined ||
    activity.argumentChurnRunId !== params.runId ||
    continuityExpired
  ) {
    activity.argumentChurnStartedAt = params.now;
    activity.argumentChurnRunId = params.runId;
  }
  activity.argumentChurnObservationAt = params.now;
  activity.argumentChurnObservationSequence = nextDiagnosticActivitySequence();
}

function updateArgumentChurnPolicyWait(
  activity: DiagnosticArgumentChurnActivity,
  params: {
    action: "enter" | "exit";
    runId?: string;
    token: symbol;
  },
): void {
  if (params.action === "enter") {
    if (activity.argumentChurnPolicyWaitRunId !== params.runId) {
      activity.argumentChurnPolicyWaitRunId = params.runId;
      activity.argumentChurnPolicyWaitTokens = new Set();
    }
    activity.argumentChurnPolicyWaitTokens?.add(params.token);
    return;
  }
  if (activity.argumentChurnPolicyWaitRunId !== params.runId) {
    return;
  }
  activity.argumentChurnPolicyWaitTokens?.delete(params.token);
  if (activity.argumentChurnPolicyWaitTokens?.size === 0) {
    activity.argumentChurnPolicyWaitRunId = undefined;
    activity.argumentChurnPolicyWaitTokens = undefined;
  }
}

export function clearArgumentChurnPolicyWaits(
  activity: DiagnosticArgumentChurnActivity,
  params: { runId?: string } = {},
): boolean {
  if (params.runId !== undefined && activity.argumentChurnPolicyWaitRunId !== params.runId) {
    return false;
  }
  const cleared = (activity.argumentChurnPolicyWaitTokens?.size ?? 0) > 0;
  activity.argumentChurnPolicyWaitRunId = undefined;
  activity.argumentChurnPolicyWaitTokens = undefined;
  return cleared;
}

export function applyArgumentChurnObservation<T extends { runId: string; sequence: number }>(
  activity: DiagnosticArgumentChurnActivity,
  owners: Iterable<T>,
  params: DiagnosticArgumentChurnObservationParams,
): void {
  const now = params.now ?? Date.now();
  const runId = params.runId?.trim() || undefined;
  const currentOwnerRunId = resolveCurrentDiagnosticRunId(owners);
  if (currentOwnerRunId !== undefined && currentOwnerRunId !== runId) {
    return;
  }
  if (params.policyWait) {
    if (params.policyWaitToken) {
      updateArgumentChurnPolicyWait(activity, {
        action: params.policyWait,
        runId,
        token: params.policyWaitToken,
      });
    }
    return;
  }
  recordArgumentChurnActivityObservation(activity, {
    runId,
    active: params.active === true,
    existingOnly: params.existingOnly,
    now,
  });
}

export function mergeArgumentChurnActivity(
  target: DiagnosticArgumentChurnActivity,
  source: DiagnosticArgumentChurnActivity,
): void {
  const sourceObservationSequence = source.argumentChurnObservationSequence;
  const targetObservationSequence = target.argumentChurnObservationSequence;
  const sourceClearsAtSameTime =
    sourceObservationSequence === undefined &&
    targetObservationSequence === undefined &&
    source.argumentChurnObservationAt !== undefined &&
    source.argumentChurnObservationAt === target.argumentChurnObservationAt &&
    source.argumentChurnStartedAt === undefined &&
    target.argumentChurnStartedAt !== undefined;
  const sourceIsNewer =
    sourceObservationSequence !== undefined
      ? targetObservationSequence === undefined ||
        sourceObservationSequence > targetObservationSequence
      : targetObservationSequence === undefined &&
        source.argumentChurnObservationAt !== undefined &&
        (target.argumentChurnObservationAt === undefined ||
          source.argumentChurnObservationAt > target.argumentChurnObservationAt ||
          sourceClearsAtSameTime);

  if (
    source.argumentChurnStartedAt !== undefined &&
    source.argumentChurnRunId === target.argumentChurnRunId &&
    target.argumentChurnStartedAt !== undefined
  ) {
    target.argumentChurnStartedAt = Math.min(
      target.argumentChurnStartedAt,
      source.argumentChurnStartedAt,
    );
    if (
      source.argumentChurnObservationAt !== undefined &&
      (sourceIsNewer ||
        (sourceObservationSequence === undefined &&
          source.argumentChurnObservationAt >= (target.argumentChurnObservationAt ?? 0)))
    ) {
      target.argumentChurnObservationAt = source.argumentChurnObservationAt;
      target.argumentChurnObservationSequence = sourceObservationSequence;
    }
  } else if (sourceIsNewer) {
    target.argumentChurnStartedAt = source.argumentChurnStartedAt;
    target.argumentChurnObservationAt = source.argumentChurnObservationAt;
    target.argumentChurnObservationSequence = sourceObservationSequence;
    target.argumentChurnRunId = source.argumentChurnRunId;
  }

  if ((source.argumentChurnPolicyWaitTokens?.size ?? 0) === 0) {
    return;
  }
  if (target.argumentChurnPolicyWaitRunId !== source.argumentChurnPolicyWaitRunId) {
    if ((target.argumentChurnPolicyWaitTokens?.size ?? 0) === 0) {
      target.argumentChurnPolicyWaitRunId = source.argumentChurnPolicyWaitRunId;
      target.argumentChurnPolicyWaitTokens = new Set(source.argumentChurnPolicyWaitTokens);
    }
    return;
  }
  target.argumentChurnPolicyWaitTokens ??= new Set();
  for (const token of source.argumentChurnPolicyWaitTokens ?? []) {
    target.argumentChurnPolicyWaitTokens.add(token);
  }
}

export function clearArgumentChurnActivity(
  activity: DiagnosticArgumentChurnActivity,
  params: { now?: number; runId?: string } = {},
): boolean {
  const cleared = activity.argumentChurnStartedAt !== undefined;
  activity.argumentChurnStartedAt = undefined;
  activity.argumentChurnObservationAt = params.now ?? Date.now();
  activity.argumentChurnObservationSequence = nextDiagnosticActivitySequence();
  activity.argumentChurnRunId = params.runId;
  return cleared;
}
