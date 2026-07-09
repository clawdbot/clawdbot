// Diagnostic run activity helpers summarize run lifecycle activity for diagnostics.
import {
  onInternalDiagnosticEvent,
  type DiagnosticEventPayload,
  type DiagnosticSessionActiveWorkKind,
} from "../infra/diagnostic-events.js";

type SessionActivity = {
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

type DiagnosticModelStartedActivityEvent = Pick<
  Extract<DiagnosticEventPayload, { type: "model.call.started" }>,
  "runId" | "sessionId" | "sessionKey" | "provider" | "model"
> & { seq?: number };

type DiagnosticRunProgressActivityEvent = Pick<
  Extract<DiagnosticEventPayload, { type: "run.progress" }>,
  "runId" | "sessionId" | "sessionKey" | "reason"
>;

// Quiet-but-alive tools are normal agent behavior; the CLI byte watchdog kills
// truly silent children within its own deadline. This floor bounds every
// staleness consumer (diagnostic recovery aborts, reply-run stale takeover,
// steer gates): lowering it reopens #88870, removing it reopens #96168.
export const BLOCKED_TOOL_CALL_ABORT_FLOOR_MS = 15 * 60_000;

export type DiagnosticSessionActivitySnapshot = {
  activeWorkKind?: DiagnosticSessionActiveWorkKind;
  hasActiveEmbeddedRun?: boolean;
  activeToolName?: string;
  activeToolCallId?: string;
  activeToolAgeMs?: number;
  lastProgressAgeMs?: number;
  lastProgressReason?: string;
};

const activityByRef = new Map<string, SessionActivity>();
const activityByRunId = new Map<string, SessionActivity>();
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
  if (source.lastProgressAt > target.lastProgressAt) {
    target.lastProgressAt = source.lastProgressAt;
    target.lastProgressReason = source.lastProgressReason;
  }
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
  if (!activity) {
    return;
  }
  if (shouldIgnoreRecoveredOwnerStartEvent(activity, event)) {
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

function recordModelStarted(event: DiagnosticModelStartedActivityEvent): void {
  const activity = resolveSessionActivity({ ...event, create: true });
  if (!activity) {
    return;
  }
  if (shouldIgnoreRecoveredOwnerStartEvent(activity, event)) {
    return;
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

function recordRunProgress(event: DiagnosticRunProgressActivityEvent): void {
  markDiagnosticRunProgress(event);
}

export function markDiagnosticRunProgress(params: DiagnosticRunProgressActivityEvent): void {
  const activity = resolveSessionActivity({ ...params, create: true });
  if (!activity) {
    return;
  }
  touchSessionActivity(activity, params.reason);
}

function recordRunCompleted(
  event: Extract<DiagnosticEventPayload, { type: "run.completed" }>,
): void {
  const activity = resolveSessionActivity(event);
  if (!activity) {
    return;
  }
  activityByRunId.delete(event.runId);
  activity.activeTools.clear();
  activity.activeModelCalls.clear();
  activity.activeEmbeddedRuns.clear();
  touchSessionActivity(activity, "run:completed");
}

export function markDiagnosticEmbeddedRunStarted(params: {
  sessionId: string;
  sessionKey?: string;
  workKey?: string;
}): void {
  const activity = resolveSessionActivity({ ...params, create: true });
  if (!activity) {
    return;
  }
  activity.activeEmbeddedRuns.set(resolveEmbeddedRunWorkKey(params), {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
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
  activity.activeEmbeddedRuns.delete(resolveEmbeddedRunWorkKey(params));
  if (params.clearRunActivity !== false) {
    activity.activeTools.clear();
    activity.activeModelCalls.clear();
  }
  touchSessionActivity(activity, "embedded_run:ended");
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
      activity.activeEmbeddedRuns.delete(key);
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
      activity.activeEmbeddedRuns.delete(key);
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
    return { cleared: false, blockedByActiveEmbeddedRun: false };
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
    activity.activeEmbeddedRuns.clear();
  }
  activity.activeTools.clear();
  activity.activeModelCalls.clear();
  touchSessionActivity(activity, "embedded_run:ended");
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

  let activeWorkKind: DiagnosticSessionActiveWorkKind | undefined;
  if (activity.activeTools.size > 0) {
    activeWorkKind = "tool_call";
  } else if (activity.activeModelCalls.size > 0) {
    activeWorkKind = "model_call";
  } else if (activity.activeEmbeddedRuns.size > 0) {
    activeWorkKind = "embedded_run";
  }

  let activeTool: ActiveTool | undefined;
  for (const tool of activity.activeTools.values()) {
    if (!activeTool || tool.startedAt < activeTool.startedAt) {
      activeTool = tool;
    }
  }
  return {
    activeWorkKind,
    ...(activity.activeEmbeddedRuns.size > 0 ? { hasActiveEmbeddedRun: true } : {}),
    activeToolName: activeTool?.toolName,
    activeToolCallId: activeTool?.toolCallId,
    activeToolAgeMs: activeTool ? Math.max(0, now - activeTool.startedAt) : undefined,
    lastProgressAgeMs: Math.max(0, now - activity.lastProgressAt),
    lastProgressReason: activity.lastProgressReason,
  };
}

export function getDiagnosticEmbeddedRunActivitySequence(): number {
  return embeddedRunSequence;
}

export function markDiagnosticRunProgressForTest(params: DiagnosticRunProgressActivityEvent): void {
  markDiagnosticRunProgress(params);
}

export function markDiagnosticToolStartedForTest(params: {
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
  toolName: string;
  toolCallId?: string;
}): void {
  recordToolStarted(params);
}

export function markDiagnosticModelStartedForTest(
  params: DiagnosticModelStartedActivityEvent,
): void {
  recordModelStarted(params);
}

export function resetDiagnosticRunActivityForTest(): void {
  activityByRef.clear();
  activityByRunId.clear();
  embeddedRunSequence = 0;
  unregisterDiagnosticRunActivityListener?.();
  unregisterDiagnosticRunActivityListener = undefined;
  registerDiagnosticRunActivityListener();
}

let unregisterDiagnosticRunActivityListener: (() => void) | undefined;

function registerDiagnosticRunActivityListener(): void {
  if (unregisterDiagnosticRunActivityListener) {
    return;
  }
  unregisterDiagnosticRunActivityListener = onInternalDiagnosticEvent((event) => {
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
        recordModelStarted(event);
        return;
      case "model.call.completed":
      case "model.call.error":
        recordModelEnded(event);
        return;
      case "run.progress":
        recordRunProgress(event);
        return;
      case "run.completed":
        recordRunCompleted(event);

      default:
    }
  });
}

registerDiagnosticRunActivityListener();
