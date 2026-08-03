// Diagnostic run activity helpers summarize run lifecycle activity for diagnostics.
import {
  getInternalDiagnosticEventSequence,
  onInternalDiagnosticEvent,
  type DiagnosticEventPayload,
  type DiagnosticSessionActiveWorkKind,
} from "../infra/diagnostic-events.js";
import {
  applyArgumentChurnObservation,
  clearArgumentChurnActivity,
  clearArgumentChurnPolicyWaits,
  type DiagnosticArgumentChurnActivity,
  type DiagnosticArgumentChurnObservationParams,
  mergeArgumentChurnActivity,
  recordDiagnosticActivityProgress,
  resolveArgumentChurnProgress,
} from "./diagnostic-argument-churn-activity.js";
import { createDiagnosticEmbeddedRunIndex } from "./diagnostic-embedded-run-index.js";

export type SessionActivity = DiagnosticArgumentChurnActivity & {
  sessionId?: string;
  sessionKey?: string;
  activeEmbeddedRuns: Map<string, ActiveEmbeddedRun>;
  activeTools: Map<string, ActiveTool>;
  activeModelCalls: Map<string, ActiveModelCall>;
  recoveredOwnerStartEventCutoffs: Map<string, number>;
  lastProgressAt: number;
  lastProgressReason?: string;
  // CLI-owned fact: the claude-cli session reports outstanding background
  // subagent/workflow tasks, so a quiet parent model_call is still doing work.
  hasOutstandingBackgroundWork: boolean;
};

export type ActiveEmbeddedRun = {
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

// Default quiet-run reclaim window for steer/takeover. Evidence clocks stay local.
export const RUN_STALE_TAKEOVER_MS = 10 * 60_000;

export type DiagnosticSessionActivitySnapshot = {
  activeWorkKind?: DiagnosticSessionActiveWorkKind;
  hasActiveEmbeddedRun?: boolean;
  hasOutstandingBackgroundWork?: boolean;
  activeToolName?: string;
  activeToolCallId?: string;
  activeToolAgeMs?: number;
  lastProgressAgeMs?: number;
  lastProgressReason?: string;
};

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
export const embeddedRunIndex = createDiagnosticEmbeddedRunIndex(activityByRunId);
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

export function registerSessionActivityRefs(
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
  if (source.hasOutstandingBackgroundWork) {
    target.hasOutstandingBackgroundWork = true;
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
  replaceSessionActivityReferences(source, target);
}

export function resolveSessionActivity(params: {
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
    hasOutstandingBackgroundWork: false,
    lastProgressAt: Date.now(),
  };
  registerSessionActivityRefs(created, params);
  return created;
}

export function touchSessionActivity(
  activity: SessionActivity,
  reason: string,
  now = Date.now(),
): void {
  activity.lastProgressAt = now;
  activity.lastProgressReason = reason;
  recordDiagnosticActivityProgress(activity);
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

export function markDiagnosticArgumentChurnObservation(
  params: DiagnosticArgumentChurnObservationParams,
): void {
  const activity = resolveSessionActivity({ ...params, create: params.active === true });
  if (activity) {
    applyArgumentChurnObservation(activity, activity.activeEmbeddedRuns.values(), params);
  }
}

export function markDiagnosticRunProgress(params: DiagnosticRunProgressActivityEvent): void {
  const activity = resolveSessionActivity({ ...params, create: true });
  if (!activity) {
    return;
  }
  touchSessionActivity(activity, params.reason);
}

/**
 * Records the claude-cli-owned background-work fact: while the CLI reports
 * outstanding subagent/workflow tasks, the parent's quiet model_call is still
 * doing work and must not be recovered at the bare abort threshold.
 */
export function markDiagnosticClaudeBackgroundWorkState(params: {
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
  active: boolean;
}): void {
  const activity = resolveSessionActivity({ ...params, create: params.active });
  if (!activity) {
    return;
  }
  activity.hasOutstandingBackgroundWork = params.active;
  if (params.active) {
    touchSessionActivity(activity, "cli_background_work:active");
  }
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
  activity.hasOutstandingBackgroundWork = false;
  embeddedRunIndex.clear(activity);
  clearArgumentChurnActivity(activity, { runId: event.runId });
  clearArgumentChurnPolicyWaits(activity, { runId: event.runId });
  touchSessionActivity(activity, "run:completed");
}

export function markDiagnosticEmbeddedRunStarted(params: {
  sessionId: string;
  sessionKey?: string;
  runId?: string;
  workKey?: string;
}): void {
  const ownerRunId = params.runId?.trim() || params.sessionId.trim();
  const activity = resolveSessionActivity({ ...params, runId: ownerRunId, create: true });
  if (!activity) {
    return;
  }
  // Registration is the ownership boundary. A replacement or re-armed run
  // must never inherit the prior owner's semantic-stall clock.
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
  touchSessionActivity(activity, "embedded_run:ended");
}

function resolveEmbeddedRunWorkKey(params: { sessionId: string; workKey?: string }): string {
  return params.workKey ?? params.sessionId;
}

function ownerRefsForStartedEvent(event: { runId?: string; sessionId?: string }): string[] {
  return [event.runId?.trim(), event.sessionId?.trim()].filter((ref): ref is string =>
    Boolean(ref),
  );
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
  const churnProgress = resolveArgumentChurnProgress(
    activity,
    activity.activeEmbeddedRuns.values(),
    now,
  );
  return {
    activeWorkKind,
    ...(activity.activeEmbeddedRuns.size > 0 ? { hasActiveEmbeddedRun: true } : {}),
    ...(activity.hasOutstandingBackgroundWork ? { hasOutstandingBackgroundWork: true } : {}),
    activeToolName: activeTool?.toolName,
    activeToolCallId: activeTool?.toolCallId,
    activeToolAgeMs: activeTool ? Math.max(0, now - activeTool.startedAt) : undefined,
    lastProgressAgeMs: Math.max(0, now - churnProgress.lastProgressAt),
    lastProgressReason: churnProgress.lastProgressReason,
  };
}

export function getDiagnosticEmbeddedRunActivitySequence(): number {
  return embeddedRunSequence;
}

function markDiagnosticRunProgressForTest(params: DiagnosticRunProgressActivityEvent): void {
  markDiagnosticRunProgress(params);
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

function markDiagnosticModelStartedForTest(params: DiagnosticModelStartedActivityEvent): void {
  recordModelStarted(params);
}

export function resetDiagnosticRunActivityForTest(): void {
  stopDiagnosticRunActivityTracking();
}

let unregisterDiagnosticRunActivityListener: (() => void) | undefined;

export function startDiagnosticRunActivityTracking(): void {
  if (unregisterDiagnosticRunActivityListener) {
    return;
  }
  const startAfterEventSequence = getInternalDiagnosticEventSequence();
  unregisterDiagnosticRunActivityListener = onInternalDiagnosticEvent((event) => {
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

export function stopDiagnosticRunActivityTracking(): void {
  unregisterDiagnosticRunActivityListener?.();
  unregisterDiagnosticRunActivityListener = undefined;
  activityByRef.clear();
  activityByRunId.clear();
  embeddedRunSequence = 0;
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.diagnosticRunActivityTestApi")
  ] = {
    markDiagnosticModelStartedForTest,
    markDiagnosticRunProgressForTest,
    markDiagnosticToolStartedForTest,
  };
}
