// Diagnostic run activity helpers summarize run lifecycle activity for diagnostics.
import {
  getInternalDiagnosticEventSequence,
  onInternalDiagnosticEvent,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { isCoreModelRequestStartedDiagnosticMetadata } from "../infra/diagnostic-model-request.js";
import { isCoreSemanticRunProgressDiagnosticMetadata } from "../infra/diagnostic-semantic-run-progress.js";
import {
  applyArgumentChurnObservation,
  clearArgumentChurnActivity,
  clearArgumentChurnPolicyWaits,
  type DiagnosticArgumentChurnActivity,
  type DiagnosticArgumentChurnObservationParams,
  mergeArgumentChurnActivity,
  recordDiagnosticActivityProgress,
} from "./diagnostic-argument-churn-activity.js";
import { createDiagnosticEmbeddedRunIndex } from "./diagnostic-embedded-run-index.js";
import {
  clearRepeatedRequestActivity,
  type DiagnosticRepeatedRequestActivity,
  mergeRepeatedRequestActivity,
  recordRepeatedRequestObservation,
} from "./diagnostic-repeated-request-activity.js";
import {
  buildDiagnosticSessionActivitySnapshot,
  type DiagnosticSessionActivitySnapshot,
} from "./diagnostic-run-activity-snapshot.js";

export type { DiagnosticSessionActivitySnapshot } from "./diagnostic-run-activity-snapshot.js";

type SessionActivity = DiagnosticArgumentChurnActivity &
  DiagnosticRepeatedRequestActivity & {
    sessionId?: string;
    sessionKey?: string;
    activeEmbeddedRuns: Map<string, ActiveEmbeddedRun>;
    activeTools: Map<string, ActiveTool>;
    activeModelCalls: Map<string, ActiveModelCall>;
    recoveredOwnerStartEventCutoffs: Map<string, number>;
    lastProgressAt: number;
    lastProgressReason?: string;
  };

type ActiveEmbeddedRun = {
  runId: string;
  sessionId?: string;
  sessionKey?: string;
  sequence: number;
};

type ActiveTool = {
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  sequence?: number;
  toolName: string;
  toolCallId?: string;
  startedAt: number;
  lastProgressAt: number;
};

type ActiveModelCall = {
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  sequence?: number;
};

type DiagnosticToolStartedActivityEvent = Pick<
  Extract<DiagnosticEventPayload, { type: "tool.execution.started" }>,
  "runId" | "sessionId" | "sessionKey" | "toolName" | "toolCallId"
> & { seq?: number };

type ModelStartedActivityEvent = Pick<
  Extract<DiagnosticEventPayload, { type: "model.call.started" }>,
  "runId" | "sessionId" | "sessionKey" | "provider" | "model" | "observationUnit"
> & { seq?: number };

type RunProgressEvent = Pick<
  Extract<DiagnosticEventPayload, { type: "run.progress" }>,
  "runId" | "sessionId" | "sessionKey" | "reason"
> & { progressKind?: "semantic" | "liveness" };

// Quiet-but-alive tools are normal agent behavior; the CLI byte watchdog kills
// truly silent children within its own deadline. This floor bounds every
// staleness consumer (diagnostic recovery aborts, reply-run stale takeover,
// steer gates): lowering it reopens #88870, removing it reopens #96168.
export const BLOCKED_TOOL_CALL_ABORT_FLOOR_MS = 15 * 60_000;

// Default quiet-run reclaim window for steer/takeover. Evidence clocks stay local.
export const RUN_STALE_TAKEOVER_MS = 10 * 60_000;

// Quiet-but-alive tool phases get the blocked-tool floor so a human message
// cannot reclaim a healthy long tool that stuck recovery would not touch yet.
export function resolveRunStaleThresholdMs(
  activity: Pick<DiagnosticSessionActivitySnapshot, "activeWorkKind">,
): number {
  return activity.activeWorkKind === "tool_call"
    ? Math.max(RUN_STALE_TAKEOVER_MS, BLOCKED_TOOL_CALL_ABORT_FLOOR_MS)
    : RUN_STALE_TAKEOVER_MS;
}

const activityByRef = new Map<string, SessionActivity>();
const activityByRunId = new Map<string, SessionActivity>();
const embeddedRunIndex = createDiagnosticEmbeddedRunIndex(activityByRunId);
let embeddedRunSequence = 0;

function sessionRefs(params: { sessionId?: string; sessionKey?: string }): string[] {
  const refs: string[] = [];
  const sessionId = params.sessionId?.trim();
  const sessionKey = params.sessionKey?.trim();
  if (sessionId) {
    refs.push(`id:${sessionId}`);
  }
  if (sessionKey) {
    refs.push(`key:${sessionKey}`);
  }
  return refs;
}

function registerSessionActivityRefs(
  activity: SessionActivity,
  params: { sessionId?: string; sessionKey?: string; runId?: string },
): void {
  activity.sessionId ??= params.sessionId;
  activity.sessionKey ??= params.sessionKey;
  for (const ref of sessionRefs(params)) {
    activityByRef.set(ref, activity);
  }
  if (params.runId) {
    activityByRunId.set(params.runId, activity);
  }
}

function replaceSessionActivityReferences(source: SessionActivity, target: SessionActivity): void {
  for (const [ref, activity] of activityByRef) {
    if (activity === source) {
      activityByRef.set(ref, target);
    }
  }
  for (const [runId, activity] of activityByRunId) {
    if (activity === source) {
      activityByRunId.set(runId, target);
    }
  }
}

function mergeSessionActivity(target: SessionActivity, source: SessionActivity): void {
  target.sessionId ??= source.sessionId;
  target.sessionKey ??= source.sessionKey;
  for (const [key, embeddedRun] of source.activeEmbeddedRuns) {
    const existing = target.activeEmbeddedRuns.get(key);
    if (existing && existing.runId !== embeddedRun.runId) {
      embeddedRunIndex.remove(target, key);
    }
    target.activeEmbeddedRuns.set(key, embeddedRun);
  }
  for (const [key, tool] of source.activeTools) {
    target.activeTools.set(key, tool);
  }
  for (const [key, modelCall] of source.activeModelCalls) {
    target.activeModelCalls.set(key, modelCall);
  }
  for (const [ownerRef, cutoff] of source.recoveredOwnerStartEventCutoffs) {
    target.recoveredOwnerStartEventCutoffs.set(
      ownerRef,
      Math.max(cutoff, target.recoveredOwnerStartEventCutoffs.get(ownerRef) ?? 0),
    );
  }
  const sourceProgressIsNewer =
    source.lastProgressSequence !== undefined
      ? target.lastProgressSequence === undefined ||
        source.lastProgressSequence > target.lastProgressSequence
      : target.lastProgressSequence === undefined && source.lastProgressAt > target.lastProgressAt;
  if (sourceProgressIsNewer) {
    target.lastProgressAt = source.lastProgressAt;
    target.lastProgressReason = source.lastProgressReason;
    target.lastProgressSequence = source.lastProgressSequence;
  }
  mergeArgumentChurnActivity(target, source);
  mergeRepeatedRequestActivity(target, source);
  replaceSessionActivityReferences(source, target);
}

function resolveSessionActivity(params: {
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
  create?: boolean;
}): SessionActivity | undefined {
  let activity: SessionActivity | undefined;
  if (params.runId) {
    const byRun = activityByRunId.get(params.runId);
    if (byRun) {
      activity = byRun;
    }
  }

  for (const ref of sessionRefs(params)) {
    const byRef = activityByRef.get(ref);
    if (!byRef) {
      continue;
    }
    if (!activity) {
      activity = byRef;
    } else if (activity !== byRef) {
      mergeSessionActivity(activity, byRef);
    }
  }

  if (activity) {
    registerSessionActivityRefs(activity, params);
    return activity;
  }

  if (!params.create) {
    return undefined;
  }

  const created: SessionActivity = {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    activeEmbeddedRuns: new Map(),
    activeTools: new Map(),
    activeModelCalls: new Map(),
    recoveredOwnerStartEventCutoffs: new Map(),
    lastProgressAt: Date.now(),
  };
  registerSessionActivityRefs(created, params);
  return created;
}

function touchSessionActivity(activity: SessionActivity, reason: string, now = Date.now()): void {
  activity.lastProgressAt = now;
  activity.lastProgressReason = reason;
  recordDiagnosticActivityProgress(activity);
}

function touchSemanticSessionActivity(
  activity: SessionActivity,
  reason: string,
  params: { runId?: string; now?: number } = {},
): void {
  clearRepeatedRequestActivity(activity, { runId: params.runId });
  touchSessionActivity(activity, reason, params.now);
}

function toolKey(event: {
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  toolCallId?: string;
  toolName: string;
}): string {
  return `${event.runId ?? event.sessionId ?? event.sessionKey ?? "unknown"}:${
    event.toolCallId ?? event.toolName
  }`;
}

function modelCallKey(event: { runId?: string; provider?: string; model?: string }): string {
  return `${event.runId ?? "unknown"}:${event.provider ?? "provider"}:${event.model ?? "model"}`;
}

function recordToolStarted(event: DiagnosticToolStartedActivityEvent): void {
  const activity = resolveSessionActivity({ ...event, create: true });
  if (!activity || shouldIgnoreRecoveredOwnerStartEvent(activity, event)) {
    return;
  }
  const now = Date.now();
  activity.activeTools.set(toolKey(event), {
    runId: event.runId,
    sessionId: event.sessionId,
    sessionKey: event.sessionKey,
    sequence: event.seq,
    toolName: event.toolName,
    toolCallId: event.toolCallId,
    startedAt: now,
    lastProgressAt: now,
  });
  touchSessionActivity(activity, `tool:${event.toolName}:started`, now);
}

function recordToolEnded(
  event: Extract<
    DiagnosticEventPayload,
    { type: "tool.execution.completed" | "tool.execution.error" | "tool.execution.blocked" }
  >,
): void {
  const activity = resolveSessionActivity(event);
  if (!activity) {
    return;
  }
  activity.activeTools.delete(toolKey(event));
  touchSessionActivity(activity, `tool:${event.toolName}:ended`);
}

function recordModelStarted(event: ModelStartedActivityEvent, coreRequest: boolean): void {
  const activity = resolveSessionActivity({ ...event, create: true });
  if (!activity) {
    return;
  }
  if (shouldIgnoreRecoveredOwnerStartEvent(activity, event)) {
    return;
  }
  if (coreRequest) {
    recordRepeatedRequestObservation(activity, activity.activeEmbeddedRuns.values(), event);
  }
  activity.activeModelCalls.set(modelCallKey(event), {
    runId: event.runId,
    sessionId: event.sessionId,
    sessionKey: event.sessionKey,
    sequence: event.seq,
  });
  touchSessionActivity(activity, "model_call:started");
}

function recordModelEnded(
  event: Extract<DiagnosticEventPayload, { type: "model.call.completed" | "model.call.error" }>,
): void {
  const activity = resolveSessionActivity(event);
  if (!activity) {
    return;
  }
  activity.activeModelCalls.delete(modelCallKey(event));
  touchSessionActivity(activity, "model_call:ended");
}

function recordRunProgress(event: RunProgressEvent, coreSemantic: boolean): void {
  applyRunProgress(event, coreSemantic);
}

export function markDiagnosticArgumentChurnObservation(
  params: DiagnosticArgumentChurnObservationParams,
): void {
  const activity = resolveSessionActivity({ ...params, create: params.active === true });
  if (activity) {
    applyArgumentChurnObservation(activity, activity.activeEmbeddedRuns.values(), params);
  }
}

export const markDiagnosticRunProgress: (params: RunProgressEvent) => void = applyRunProgress;

function applyRunProgress(params: RunProgressEvent, semantic = false): void {
  const runId = params.runId?.trim() || undefined;
  const activity = resolveSessionActivity({ ...params, runId, create: true });
  if (!activity) {
    return;
  }
  // Only an explicit fact from the current owner may clear its recovery evidence.
  if (!semantic || !runId) {
    touchSessionActivity(activity, params.reason);
    return;
  }
  touchSemanticSessionActivity(activity, params.reason, { runId });
}

function recordRunCompleted(
  event: Extract<DiagnosticEventPayload, { type: "run.completed" }>,
): void {
  const activity = resolveSessionActivity(event);
  if (!activity) {
    return;
  }
  activity.activeTools.clear();
  activity.activeModelCalls.clear();
  activityByRunId.delete(event.runId);
  if (activity.repeatedRequestOwnerRunId === event.runId) {
    touchSessionActivity(activity, "run:attempt_completed"); // Session evidence survives retry re-arm.
    return;
  }
  embeddedRunIndex.clear(activity);
  clearArgumentChurnActivity(activity, { runId: event.runId });
  clearArgumentChurnPolicyWaits(activity, { runId: event.runId });
  touchSemanticSessionActivity(activity, "run:completed", { runId: event.runId });
}

export function markDiagnosticEmbeddedRunStarted(params: {
  sessionId: string;
  sessionKey?: string;
  runId?: string;
  workKey?: string;
}): void {
  const ownerRunId = params.runId?.trim() || params.sessionId.trim();
  const activity = resolveSessionActivity({ ...params, runId: ownerRunId, create: true })!;
  // New owners must not inherit the prior owner's semantic-stall clock.
  if (activity.repeatedRequestOwnerRunId !== ownerRunId) {
    clearRepeatedRequestActivity(activity);
  }
  if (activity.argumentChurnStartedAt !== undefined) {
    clearArgumentChurnActivity(activity, { runId: ownerRunId });
  }
  clearArgumentChurnPolicyWaits(activity);
  const workKey = resolveEmbeddedRunWorkKey(params);
  const existing = activity.activeEmbeddedRuns.get(workKey);
  if (existing && existing.runId !== ownerRunId) {
    embeddedRunIndex.remove(activity, workKey);
  }
  activity.activeEmbeddedRuns.set(workKey, {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    runId: ownerRunId,
    sequence: ++embeddedRunSequence,
  });
  touchSessionActivity(activity, "embedded_run:started");
}

export function markDiagnosticEmbeddedRunEnded(params: {
  sessionId: string;
  sessionKey?: string;
  workKey?: string;
  clearRunActivity?: boolean;
}): void {
  const activity = resolveSessionActivity(params);
  if (!activity) {
    return;
  }
  embeddedRunIndex.remove(activity, resolveEmbeddedRunWorkKey(params));
  if (params.clearRunActivity !== false) {
    activity.activeTools.clear();
    activity.activeModelCalls.clear();
  }
  if (activity.activeEmbeddedRuns.size === 0) {
    clearArgumentChurnActivity(activity);
    clearArgumentChurnPolicyWaits(activity);
  }
  touchSessionActivity(activity, "embedded_run:ended"); // Retained retry evidence is inert here.
}

function resolveEmbeddedRunWorkKey(params: { sessionId: string; workKey?: string }): string {
  return params.workKey ?? params.sessionId;
}

function ownerRefsForRecovery(params: {
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
  embeddedRun: ActiveEmbeddedRun,
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

function clearRecoveredOwnerEmbeddedRuns(
  activity: SessionActivity,
  ownerRefs: Set<string>,
  recoveryStartedAfterSequence: number | undefined,
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
      embeddedRunIndex.remove(activity, key);
    }
  }
}

function hasEmbeddedRunStartedAfter(
  activity: SessionActivity,
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

function clearRecoveredOwnerMarkers(
  activity: SessionActivity,
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

function pruneActivityStartedBeforeRecoveryCutoff(
  activity: SessionActivity,
  recoveryStartedAfterEmbeddedRunSequence: number | undefined,
  recoveryStartedAfterDiagnosticEventSequence: number | undefined,
): void {
  if (
    recoveryStartedAfterEmbeddedRunSequence === undefined &&
    recoveryStartedAfterDiagnosticEventSequence === undefined
  ) {
    return;
  }
  for (const [key, embeddedRun] of activity.activeEmbeddedRuns) {
    if (!embeddedRunStartedAfter(embeddedRun, recoveryStartedAfterEmbeddedRunSequence)) {
      embeddedRunIndex.remove(activity, key);
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

function rememberRecoveredOwnerStartEventCutoffs(
  activity: SessionActivity,
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

function shouldIgnoreRecoveredOwnerStartEvent(
  activity: SessionActivity,
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

// Reconciles a session's terminal embedded-run activity at once. Used when an
// authority (stuck-session recovery) declares the lane idle and the per-run
// markDiagnosticEmbeddedRunEnded may have been bypassed. Clears the embedded-run
// owners AND their tool/model markers, matching the default teardown so the lane
// cannot be left as idle + orphaned tool/model activity (which
// isIdleQueuedRecoverableSessionStall still treats as recoverable).
export function clearDiagnosticEmbeddedRunActivityForSession(params: {
  sessionId?: string;
  sessionKey?: string;
  activeSessionId?: string;
  recoveryStartedAfterEmbeddedRunSequence?: number;
  recoveryStartedAfterDiagnosticEventSequence?: number;
}): { cleared: boolean; blockedByActiveEmbeddedRun: boolean } {
  const shouldCreateCutoffActivity =
    params.recoveryStartedAfterDiagnosticEventSequence !== undefined;
  const activity = resolveSessionActivity({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    runId: params.activeSessionId,
    create: shouldCreateCutoffActivity,
  });
  if (!activity) {
    return { cleared: false, blockedByActiveEmbeddedRun: false };
  }
  if (params.activeSessionId) {
    registerSessionActivityRefs(activity, {
      sessionId: params.activeSessionId,
      sessionKey: params.sessionKey,
      runId: params.activeSessionId,
    });
  }
  const ownerRefs = ownerRefsForRecovery(params);
  rememberRecoveredOwnerStartEventCutoffs(
    activity,
    ownerRefs,
    params.recoveryStartedAfterDiagnosticEventSequence,
  );
  if (
    activity.activeEmbeddedRuns.size === 0 &&
    activity.activeTools.size === 0 &&
    activity.activeModelCalls.size === 0
  ) {
    const clearedChurn = clearArgumentChurnActivity(activity, {
      runId: params.activeSessionId,
    });
    const clearedPolicyWait = clearArgumentChurnPolicyWaits(activity, {
      runId: params.activeSessionId,
    });
    const clearedRepeatedRequests = clearRepeatedRequestActivity(activity);
    return {
      cleared: clearedChurn || clearedPolicyWait || clearedRepeatedRequests,
      blockedByActiveEmbeddedRun: false,
    };
  }
  clearRecoveredOwnerEmbeddedRuns(
    activity,
    ownerRefs,
    params.recoveryStartedAfterEmbeddedRunSequence,
  );
  clearRecoveredOwnerMarkers(
    activity,
    ownerRefs,
    params.recoveryStartedAfterDiagnosticEventSequence,
  );
  if (activity.activeEmbeddedRuns.size > 0) {
    if (hasEmbeddedRunStartedAfter(activity, params.recoveryStartedAfterEmbeddedRunSequence)) {
      pruneActivityStartedBeforeRecoveryCutoff(
        activity,
        params.recoveryStartedAfterEmbeddedRunSequence,
        params.recoveryStartedAfterDiagnosticEventSequence,
      );
      touchSessionActivity(activity, "embedded_run:recovery_skipped_active_owner");
      return { cleared: false, blockedByActiveEmbeddedRun: true };
    }
    embeddedRunIndex.clear(activity);
  }
  activity.activeTools.clear();
  activity.activeModelCalls.clear();
  clearArgumentChurnActivity(activity, { runId: params.activeSessionId });
  clearArgumentChurnPolicyWaits(activity, { runId: params.activeSessionId });
  clearRepeatedRequestActivity(activity);
  touchSemanticSessionActivity(activity, "embedded_run:ended");
  return { cleared: true, blockedByActiveEmbeddedRun: false };
}

export function getDiagnosticSessionActivitySnapshot(
  params: { sessionId?: string; sessionKey?: string },
  now = Date.now(),
): DiagnosticSessionActivitySnapshot {
  const activity = resolveSessionActivity(params);
  if (!activity) {
    return {};
  }

  return buildDiagnosticSessionActivitySnapshot(activity, now);
}

export function getDiagnosticEmbeddedRunActivitySequence(): number {
  return embeddedRunSequence;
}

function markDiagnosticRunProgressForTest(params: RunProgressEvent): void {
  applyRunProgress(params, params.progressKind === "semantic");
}

function markDiagnosticToolStartedForTest(params: {
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
  toolName: string;
  toolCallId?: string;
}): void {
  recordToolStarted(params);
}

function markDiagnosticModelStartedForTest(params: ModelStartedActivityEvent): void {
  recordModelStarted(params, true);
}

export function resetDiagnosticRunActivityForTest(): void {
  stopDiagnosticRunActivityTracking();
  installDiagnosticRunActivityTestApi();
}

function installDiagnosticRunActivityTestApi(): void {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.diagnosticRunActivityTestApi")
  ] = {
    markDiagnosticModelStartedForTest,
    markDiagnosticRunProgressForTest,
    markDiagnosticToolStartedForTest,
  };
}

let unregisterDiagnosticRunActivityListener: (() => void) | undefined;

export function startDiagnosticRunActivityTracking(): void {
  if (unregisterDiagnosticRunActivityListener) {
    return;
  }
  const startAfterEventSequence = getInternalDiagnosticEventSequence();
  unregisterDiagnosticRunActivityListener = onInternalDiagnosticEvent((event, metadata) => {
    // A prior lifecycle can leave already-sequenced events in the async queue.
    // Ignore them so a restart cannot recreate activity that stop cleared.
    if (event.seq <= startAfterEventSequence) {
      return;
    }
    switch (event.type) {
      case "tool.execution.started":
        recordToolStarted(event);
        return;
      case "tool.execution.completed":
      case "tool.execution.error":
      case "tool.execution.blocked":
        recordToolEnded(event);
        return;
      case "model.call.started":
        recordModelStarted(event, isCoreModelRequestStartedDiagnosticMetadata(metadata));
        return;
      case "model.call.completed":
      case "model.call.error":
        recordModelEnded(event);
        return;
      case "run.progress":
        recordRunProgress(event, isCoreSemanticRunProgressDiagnosticMetadata(metadata));
        return;
      case "run.completed":
        recordRunCompleted(event);

      default:
    }
  });
}

export function stopDiagnosticRunActivityTracking(): void {
  unregisterDiagnosticRunActivityListener?.();
  unregisterDiagnosticRunActivityListener = undefined;
  activityByRef.clear();
  activityByRunId.clear();
  embeddedRunSequence = 0;
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  installDiagnosticRunActivityTestApi();
}
