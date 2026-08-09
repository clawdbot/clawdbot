// Recovered-owner helpers keep stuck-session recovery from resurrecting tool,
// model-call, or embedded-run activity that predates the recovery watermark.
// The structural activity shape keeps SessionActivity owned by
// diagnostic-run-activity.ts so this module stays import-cycle free.
type DiagnosticRecoveredOwnerActivity = {
  activeEmbeddedRuns: Map<string, { sessionId?: string; sequence: number }>;
  activeTools: Map<string, { runId?: string; sessionId?: string; sequence?: number }>;
  activeModelCalls: Map<string, { runId?: string; sessionId?: string; sequence?: number }>;
  recoveredOwnerStartEventCutoffs: Map<string, number>;
};

export function ownerRefsForRecovery(params: {
  sessionId?: string;
  activeSessionId?: string;
}): Set<string> {
  const refs = [params.activeSessionId?.trim(), params.sessionId?.trim()].filter(
    (ref): ref is string => Boolean(ref),
  );
  return new Set(refs);
}

function ownerRefsForStartedEvent(event: { runId?: string; sessionId?: string }): string[] {
  return [event.runId?.trim(), event.sessionId?.trim()].filter((ref): ref is string =>
    Boolean(ref),
  );
}

function markerBelongsToRecoveredOwner(
  marker: { runId?: string; sessionId?: string },
  ownerRefs: Set<string>,
): boolean {
  return (
    (marker.runId !== undefined && ownerRefs.has(marker.runId)) ||
    (marker.sessionId !== undefined && ownerRefs.has(marker.sessionId))
  );
}

function embeddedRunStartedAfter(
  embeddedRun: { sequence: number },
  sequence: number | undefined,
): boolean {
  return sequence !== undefined && embeddedRun.sequence > sequence;
}

function activityMarkerStartedAfter(
  marker: { sequence?: number },
  sequence: number | undefined,
): boolean {
  return sequence !== undefined && marker.sequence !== undefined && marker.sequence > sequence;
}

export function clearRecoveredOwnerEmbeddedRuns(
  activity: DiagnosticRecoveredOwnerActivity,
  ownerRefs: Set<string>,
  recoveryStartedAfterSequence: number | undefined,
  removeEmbeddedRun: (workKey: string) => void,
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
  activity: DiagnosticRecoveredOwnerActivity,
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
  activity: DiagnosticRecoveredOwnerActivity,
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
}

export function pruneActivityStartedBeforeRecoveryCutoff(
  activity: DiagnosticRecoveredOwnerActivity,
  recoveryStartedAfterEmbeddedRunSequence: number | undefined,
  recoveryStartedAfterDiagnosticEventSequence: number | undefined,
  removeEmbeddedRun: (workKey: string) => void,
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
}

export function rememberRecoveredOwnerStartEventCutoffs(
  activity: DiagnosticRecoveredOwnerActivity,
  ownerRefs: Set<string>,
  recoveryStartedAfterSequence: number | undefined,
): void {
  if (recoveryStartedAfterSequence === undefined) {
    return;
  }
  for (const ownerRef of ownerRefs) {
    // Recovery can clear a session before the async diagnostic queue drains.
    // Remember the queue watermark so older start events cannot recreate stale activity.
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
  activity: DiagnosticRecoveredOwnerActivity,
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
