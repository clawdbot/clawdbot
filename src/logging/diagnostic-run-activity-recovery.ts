import type { CoreModelRequestOwnerGeneration } from "../infra/diagnostic-model-request-provenance.js";

type DiagnosticRecoveryMarker = {
  runId?: string;
  sessionId?: string;
  sequence?: number;
};

export type DiagnosticRecoveryEmbeddedRun = DiagnosticRecoveryMarker & {
  runId: string;
  sessionKey?: string;
  sequence: number;
  generation?: CoreModelRequestOwnerGeneration;
};

export type DiagnosticRecoveryTool = DiagnosticRecoveryMarker & {
  sessionKey?: string;
  toolName: string;
  toolCallId?: string;
  startedAt: number;
  lastProgressAt: number;
};

export type DiagnosticRecoveryModelCall = DiagnosticRecoveryMarker & {
  sessionKey?: string;
  requestTimeoutMs?: number;
};

type DiagnosticRecoveryActivity = {
  activeEmbeddedRuns: Map<string, DiagnosticRecoveryEmbeddedRun>;
  activeTools: Map<string, DiagnosticRecoveryTool>;
  activeModelCalls: Map<string, DiagnosticRecoveryModelCall>;
  activeCoreModelCalls: Map<
    CoreModelRequestOwnerGeneration,
    Map<string, DiagnosticRecoveryModelCall>
  >;
  recoveredOwnerStartEventCutoffs: Map<string, number>;
};

export function ownerRefsForRecovery(params: {
  sessionId?: string;
  activeSessionId?: string;
}): Set<string> {
  return new Set(
    [params.activeSessionId?.trim(), params.sessionId?.trim()].filter((ref): ref is string =>
      Boolean(ref),
    ),
  );
}

export function ownerRefsForStartedEvent(event: { runId?: string; sessionId?: string }): string[] {
  return [event.runId?.trim(), event.sessionId?.trim()].filter((ref): ref is string =>
    Boolean(ref),
  );
}

export function markerBelongsToRecoveredOwner(
  marker: DiagnosticRecoveryMarker,
  ownerRefs: Set<string>,
): boolean {
  return (
    (marker.runId !== undefined && ownerRefs.has(marker.runId)) ||
    (marker.sessionId !== undefined && ownerRefs.has(marker.sessionId))
  );
}

function embeddedRunStartedAfter(
  embeddedRun: DiagnosticRecoveryEmbeddedRun,
  sequence: number | undefined,
): boolean {
  return sequence !== undefined && embeddedRun.sequence > sequence;
}

export function activityMarkerStartedAfter(
  marker: DiagnosticRecoveryMarker,
  sequence: number | undefined,
): boolean {
  return sequence !== undefined && marker.sequence !== undefined && marker.sequence > sequence;
}

export function clearRecoveredOwnerEmbeddedRuns(
  activity: DiagnosticRecoveryActivity,
  ownerRefs: Set<string>,
  recoveryStartedAfterSequence: number | undefined,
  removeEmbeddedRun: (key: string) => void,
): void {
  if (ownerRefs.size === 0) {
    return;
  }
  for (const [key, embeddedRun] of activity.activeEmbeddedRuns) {
    if (
      embeddedRun.sessionId !== undefined &&
      ownerRefs.has(embeddedRun.sessionId) &&
      !embeddedRunStartedAfter(embeddedRun, recoveryStartedAfterSequence)
    ) {
      removeEmbeddedRun(key);
    }
  }
}

export function hasEmbeddedRunStartedAfter(
  activity: DiagnosticRecoveryActivity,
  sequence: number | undefined,
): boolean {
  if (sequence === undefined) {
    return activity.activeEmbeddedRuns.size > 0;
  }
  for (const embeddedRun of activity.activeEmbeddedRuns.values()) {
    if (embeddedRun.sequence > sequence) {
      return true;
    }
  }
  return false;
}

export function clearRecoveredOwnerMarkers(
  activity: DiagnosticRecoveryActivity,
  ownerRefs: Set<string>,
  recoveryStartedAfterSequence: number | undefined,
): void {
  if (ownerRefs.size === 0) {
    return;
  }
  for (const [key, tool] of activity.activeTools) {
    if (
      markerBelongsToRecoveredOwner(tool, ownerRefs) &&
      !activityMarkerStartedAfter(tool, recoveryStartedAfterSequence)
    ) {
      activity.activeTools.delete(key);
    }
  }
  for (const [key, modelCall] of activity.activeModelCalls) {
    if (
      markerBelongsToRecoveredOwner(modelCall, ownerRefs) &&
      !activityMarkerStartedAfter(modelCall, recoveryStartedAfterSequence)
    ) {
      activity.activeModelCalls.delete(key);
    }
  }
  for (const [generation, modelCalls] of activity.activeCoreModelCalls) {
    for (const [callId, modelCall] of modelCalls) {
      if (
        markerBelongsToRecoveredOwner(modelCall, ownerRefs) &&
        !activityMarkerStartedAfter(modelCall, recoveryStartedAfterSequence)
      ) {
        modelCalls.delete(callId);
      }
    }
    if (modelCalls.size === 0) {
      activity.activeCoreModelCalls.delete(generation);
    }
  }
}

export function pruneActivityStartedBeforeRecoveryCutoff(
  activity: DiagnosticRecoveryActivity,
  recoveryStartedAfterEmbeddedRunSequence: number | undefined,
  recoveryStartedAfterDiagnosticEventSequence: number | undefined,
  removeEmbeddedRun: (key: string) => void,
): void {
  if (
    recoveryStartedAfterEmbeddedRunSequence === undefined &&
    recoveryStartedAfterDiagnosticEventSequence === undefined
  ) {
    return;
  }
  for (const [key, embeddedRun] of activity.activeEmbeddedRuns) {
    if (!embeddedRunStartedAfter(embeddedRun, recoveryStartedAfterEmbeddedRunSequence)) {
      removeEmbeddedRun(key);
    }
  }
  for (const [key, tool] of activity.activeTools) {
    if (!activityMarkerStartedAfter(tool, recoveryStartedAfterDiagnosticEventSequence)) {
      activity.activeTools.delete(key);
    }
  }
  for (const [key, modelCall] of activity.activeModelCalls) {
    if (!activityMarkerStartedAfter(modelCall, recoveryStartedAfterDiagnosticEventSequence)) {
      activity.activeModelCalls.delete(key);
    }
  }
  for (const [generation, modelCalls] of activity.activeCoreModelCalls) {
    for (const [callId, modelCall] of modelCalls) {
      if (!activityMarkerStartedAfter(modelCall, recoveryStartedAfterDiagnosticEventSequence)) {
        modelCalls.delete(callId);
      }
    }
    if (modelCalls.size === 0) {
      activity.activeCoreModelCalls.delete(generation);
    }
  }
}

export function countActiveCoreModelCalls(activity: DiagnosticRecoveryActivity): number {
  let count = 0;
  for (const calls of activity.activeCoreModelCalls.values()) {
    count += calls.size;
  }
  return count;
}

export function rememberRecoveredOwnerStartEventCutoffs(
  activity: DiagnosticRecoveryActivity,
  ownerRefs: Set<string>,
  recoveryStartedAfterSequence: number | undefined,
): void {
  if (recoveryStartedAfterSequence === undefined) {
    return;
  }
  for (const ownerRef of ownerRefs) {
    // Recovery can close an owner before its async start drains. The watermark
    // prevents that already-sequenced event from recreating stale activity.
    activity.recoveredOwnerStartEventCutoffs.set(
      ownerRef,
      Math.max(
        recoveryStartedAfterSequence,
        activity.recoveredOwnerStartEventCutoffs.get(ownerRef) ?? 0,
      ),
    );
  }
}

export function shouldIgnoreRecoveredOwnerStartEvent(
  activity: DiagnosticRecoveryActivity,
  event: { runId?: string; sessionId?: string; seq?: number },
): boolean {
  if (event.seq === undefined) {
    return false;
  }
  for (const ownerRef of ownerRefsForStartedEvent(event)) {
    const cutoff = activity.recoveredOwnerStartEventCutoffs.get(ownerRef);
    if (cutoff !== undefined && event.seq <= cutoff) {
      return true;
    }
  }
  return false;
}
