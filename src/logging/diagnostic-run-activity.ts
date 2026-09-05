// Diagnostic run activity helpers summarize run lifecycle activity for diagnostics.
import {
  getInternalDiagnosticEventSequence,
  onInternalDiagnosticEvent,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import type {
  CoreModelRequestLifecycleProvenance,
  CoreModelRequestOwnerGeneration,
  DiagnosticEmbeddedRunOwner,
} from "../infra/diagnostic-model-request-provenance.js";
import { resolveCoreModelRequestLifecycleDiagnosticMetadata } from "../infra/diagnostic-model-request.js";
import { isCoreSemanticRunProgressDiagnosticMetadata } from "../infra/diagnostic-semantic-run-progress.js";
import {
  applyArgumentChurnObservation,
  clearArgumentChurnActivity,
  clearArgumentChurnPolicyWaits,
  type DiagnosticArgumentChurnObservationParams,
} from "./diagnostic-argument-churn-activity.js";
import {
  clearRepeatedRequestActivity,
  recordRepeatedRequestObservation,
} from "./diagnostic-repeated-request-activity.js";
import {
  activityMarkerStartedAfter,
  clearRecoveredOwnerEmbeddedRuns,
  clearRecoveredOwnerMarkers,
  countActiveCoreModelCalls,
  hasEmbeddedRunStartedAfter,
  markerBelongsToRecoveredOwner,
  ownerRefsForRecovery,
  ownerRefsForStartedEvent,
  pruneActivityStartedBeforeRecoveryCutoff,
  rememberRecoveredOwnerStartEventCutoffs,
  shouldIgnoreRecoveredOwnerStartEvent,
} from "./diagnostic-run-activity-recovery.js";
import {
  buildDiagnosticSessionActivitySnapshot,
  type DiagnosticSessionActivitySnapshot,
} from "./diagnostic-run-activity-snapshot.js";
import {
  activeDiagnosticOwners,
  activityByRef,
  activityByRunId,
  embeddedRunIndex,
  registerSessionActivityRefs,
  resolveSessionActivity,
  sessionRefs,
  touchSessionActivity,
  type DiagnosticBackendActivity,
  type DiagnosticOwnerRegistration,
  type SessionActivity,
} from "./diagnostic-run-activity-state.js";

export {
  BLOCKED_TOOL_CALL_ABORT_FLOOR_MS,
  RUN_STALE_TAKEOVER_MS,
  resolveRunStaleThresholdMs,
} from "./diagnostic-run-activity-snapshot.js";
export type { DiagnosticSessionActivitySnapshot } from "./diagnostic-run-activity-snapshot.js";
export type { DiagnosticEmbeddedRunOwner } from "../infra/diagnostic-model-request-provenance.js";

type DiagnosticToolStartedActivityEvent = Pick<
  Extract<DiagnosticEventPayload, { type: "tool.execution.started" }>,
  "runId" | "sessionId" | "sessionKey" | "toolName" | "toolCallId"
> & { seq?: number; deadlineAtMs?: number };

type ModelStartedActivityEvent = Pick<
  Extract<DiagnosticEventPayload, { type: "model.call.started" }>,
  "runId" | "sessionId" | "sessionKey" | "provider" | "model" | "callId" | "observationUnit"
> & { seq?: number };

type RunProgressEvent = Pick<
  Extract<DiagnosticEventPayload, { type: "run.progress" }>,
  "runId" | "sessionId" | "sessionKey" | "reason"
>;

const closedDiagnosticOwnerGenerations = new WeakSet<CoreModelRequestOwnerGeneration>();
let embeddedRunSequence = 0;

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
    deadlineAtMs: event.deadlineAtMs,
  });
  touchSessionActivity(activity, `tool:${event.toolName}:started`, now);
}

function recordToolEnded(event: DiagnosticToolStartedActivityEvent): void {
  const activity = resolveSessionActivity(event);
  if (!activity) {
    return;
  }
  activity.activeTools.delete(toolKey(event));
  touchSessionActivity(activity, `tool:${event.toolName}:ended`);
}

export function markDiagnosticOwnedToolActivity(
  owner: DiagnosticEmbeddedRunOwner,
  event: Pick<DiagnosticToolStartedActivityEvent, "toolName" | "toolCallId" | "deadlineAtMs"> & {
    phase: "start" | "end";
  },
): void {
  if (activeDiagnosticOwners.get(owner.generation)?.owner === owner) {
    const record = event.phase === "start" ? recordToolStarted : recordToolEnded;
    record({ ...event, ...owner });
  }
}

function hasDiagnosticActivityOwner(activity: SessionActivity | undefined): boolean {
  if (!activity) {
    return false;
  }
  for (const registration of activeDiagnosticOwners.values()) {
    if (
      registration.activity === activity &&
      resolveCurrentDiagnosticOwner(registration.owner) === registration
    ) {
      return true;
    }
  }
  return false;
}

function hasDiagnosticOwnerForRefs(params: {
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
}): boolean {
  return (
    (params.runId && hasDiagnosticActivityOwner(activityByRunId.get(params.runId))) ||
    sessionRefs(params).some((ref) => hasDiagnosticActivityOwner(activityByRef.get(ref)))
  );
}

function resolveCurrentDiagnosticOwner(
  owner: DiagnosticEmbeddedRunOwner,
  assertCurrent?: () => void,
): DiagnosticOwnerRegistration | undefined {
  const registration = activeDiagnosticOwners.get(owner.generation);
  if (registration?.owner !== owner) {
    return undefined;
  }
  try {
    assertCurrent?.();
  } catch {
    return undefined;
  }
  // The caller assertion may synchronously retire or replace the registration.
  return activeDiagnosticOwners.get(owner.generation) === registration &&
    registration.activity.activeEmbeddedRuns.get(owner.workKey)?.generation === owner.generation
    ? registration
    : undefined;
}

/** Binds one backend attempt's quiet allowance to its exact live core owner. */
export function beginDiagnosticBackendActivity(params: {
  owner: DiagnosticEmbeddedRunOwner;
  noOutputTimeoutMs: number;
  assertCurrent: () => void;
}): { observeOutput: (modelProgress: boolean) => boolean; close: () => void } {
  const { owner, noOutputTimeoutMs, assertCurrent } = params;
  const registration = resolveCurrentDiagnosticOwner(owner, assertCurrent);
  const backendActivity: DiagnosticBackendActivity = {
    deadlineAtMs: Date.now() + noOutputTimeoutMs,
    assertCurrent,
  };
  if (registration) {
    registration.backendActivity = backendActivity;
  }
  return {
    observeOutput: (modelProgress) => {
      const current = resolveCurrentDiagnosticOwner(owner, assertCurrent);
      if (!current || current.backendActivity !== backendActivity) {
        return false;
      }
      const now = Date.now();
      backendActivity.deadlineAtMs = now + noOutputTimeoutMs;
      if (!modelProgress || current.activity.activeTools.size > 0) {
        return false;
      }
      touchSessionActivity(current.activity, "model_call:stream_progress", now);
      return true;
    },
    close: () => {
      // Compare-release remains valid after abort and cannot retire a later attempt.
      const current = activeDiagnosticOwners.get(owner.generation);
      if (current?.owner === owner && current.backendActivity === backendActivity) {
        delete current.backendActivity;
      }
    },
  };
}

function recordModelStarted(
  event: ModelStartedActivityEvent,
  provenance?: CoreModelRequestLifecycleProvenance,
  coreRequestForTest = false,
): void {
  const registration = provenance ? activeDiagnosticOwners.get(provenance.generation) : undefined;
  if (
    provenance &&
    (provenance.phase !== "started" ||
      !registration ||
      registration.owner.runId !== event.runId ||
      registration.owner.sessionId !== event.sessionId)
  ) {
    return;
  }
  const activity = registration?.activity ?? resolveSessionActivity({ ...event, create: true });
  if (!activity) {
    return;
  }
  if (!provenance && !coreRequestForTest && hasDiagnosticActivityOwner(activity)) {
    return;
  }
  if (shouldIgnoreRecoveredOwnerStartEvent(activity, event)) {
    return;
  }
  if (provenance?.phase === "started" && registration) {
    recordRepeatedRequestObservation(activity, activity.activeEmbeddedRuns.values(), event);
    const calls = activity.activeCoreModelCalls.get(provenance.generation) ?? new Map();
    calls.set(event.callId, {
      runId: event.runId,
      sessionId: event.sessionId,
      sessionKey: event.sessionKey,
      sequence: event.seq,
      requestTimeoutMs: provenance.requestTimeoutMs,
    });
    activity.activeCoreModelCalls.set(provenance.generation, calls);
    touchSessionActivity(activity, "model_call:started");
    return;
  }
  if (coreRequestForTest) {
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
  provenance?: CoreModelRequestLifecycleProvenance,
): void {
  const registration = provenance ? activeDiagnosticOwners.get(provenance.generation) : undefined;
  if (provenance && (provenance.phase !== "ended" || !registration)) {
    return;
  }
  const activity = registration?.activity ?? resolveSessionActivity(event);
  if (!activity) {
    return;
  }
  if (!provenance && hasDiagnosticActivityOwner(activity)) {
    activity.activeModelCalls.delete(modelCallKey(event));
    return;
  }
  if (provenance?.phase === "ended" && registration) {
    const calls = activity.activeCoreModelCalls.get(provenance.generation);
    if (!calls?.delete(event.callId)) {
      return;
    }
    if (calls.size === 0) {
      activity.activeCoreModelCalls.delete(provenance.generation);
    }
    touchSessionActivity(activity, "model_call:ended");
    return;
  }
  activity.activeModelCalls.delete(modelCallKey(event));
  touchSessionActivity(activity, "model_call:ended");
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

function applyRunProgress(
  params: RunProgressEvent,
  provenance: "direct" | "semantic" | "unbound" = "direct",
): void {
  const runId = params.runId?.trim() || undefined;
  // Exact owners record transport progress synchronously. Delayed public events
  // must neither merge their session refs nor refresh a replacement or tool phase.
  if (provenance === "unbound" && hasDiagnosticOwnerForRefs({ ...params, runId })) {
    return;
  }
  const activity = resolveSessionActivity({ ...params, runId, create: true });
  if (!activity) {
    return;
  }
  // Only an explicit fact from the current owner may clear its recovery evidence.
  if (provenance !== "semantic" || !runId) {
    touchSessionActivity(activity, params.reason);
    return;
  }
  touchSemanticSessionActivity(activity, params.reason, { runId });
}

function recordRunCompleted(
  event: Extract<DiagnosticEventPayload, { type: "run.completed" }>,
): void {
  if (hasDiagnosticOwnerForRefs(event)) {
    return;
  }
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

export function createDiagnosticEmbeddedRunOwner(params: {
  sessionId: string;
  sessionKey?: string;
  runId?: string;
  workKey?: string;
}): DiagnosticEmbeddedRunOwner {
  return Object.freeze({
    generation: Object.freeze({}),
    sessionId: params.sessionId,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.runId ? { runId: params.runId } : {}),
    workKey: resolveEmbeddedRunWorkKey(params),
  });
}

export function markDiagnosticEmbeddedRunStarted(params: {
  sessionId: string;
  sessionKey?: string;
  runId?: string;
  workKey?: string;
  owner?: DiagnosticEmbeddedRunOwner;
}): void {
  if (params.owner && closedDiagnosticOwnerGenerations.has(params.owner.generation)) {
    return;
  }
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
    generation: params.owner?.generation,
  });
  if (params.owner) {
    activeDiagnosticOwners.set(params.owner.generation, { activity, owner: params.owner });
  }
  touchSessionActivity(activity, "embedded_run:started");
}

/** Synchronously retires one exact queue owner before its handle authority is lost. */
export function closeDiagnosticEmbeddedRunOwner(owner: DiagnosticEmbeddedRunOwner): void {
  const registration = activeDiagnosticOwners.get(owner.generation);
  if (!registration || registration.owner !== owner) {
    return;
  }
  const { activity } = registration;
  activeDiagnosticOwners.delete(owner.generation);
  closedDiagnosticOwnerGenerations.add(owner.generation);
  activity.activeCoreModelCalls.delete(owner.generation);
  if (activity.activeEmbeddedRuns.get(owner.workKey)?.generation !== owner.generation) {
    return;
  }
  const cutoff = getInternalDiagnosticEventSequence();
  const ownerRefs = new Set(ownerRefsForStartedEvent(owner));
  rememberRecoveredOwnerStartEventCutoffs(activity, ownerRefs, cutoff);
  embeddedRunIndex.remove(activity, owner.workKey);
  for (const [key, tool] of activity.activeTools) {
    if (
      markerBelongsToRecoveredOwner(tool, ownerRefs) &&
      !activityMarkerStartedAfter(tool, cutoff)
    ) {
      activity.activeTools.delete(key);
    }
  }
  if (activity.activeEmbeddedRuns.size === 0) {
    clearArgumentChurnActivity(activity);
    clearArgumentChurnPolicyWaits(activity);
  }
  touchSessionActivity(activity, "embedded_run:ended");
}

export function isDiagnosticEmbeddedRunOwnerClosed(owner: DiagnosticEmbeddedRunOwner): boolean {
  return closedDiagnosticOwnerGenerations.has(owner.generation);
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
    activity.activeCoreModelCalls.clear();
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
    activity.activeModelCalls.size === 0 &&
    countActiveCoreModelCalls(activity) === 0
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
    (key) => embeddedRunIndex.remove(activity, key),
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
        (key) => embeddedRunIndex.remove(activity, key),
      );
      touchSessionActivity(activity, "embedded_run:recovery_skipped_active_owner");
      return { cleared: false, blockedByActiveEmbeddedRun: true };
    }
    embeddedRunIndex.clear(activity);
  }
  activity.activeTools.clear();
  activity.activeModelCalls.clear();
  activity.activeCoreModelCalls.clear();
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

  let activeBackendLivenessDeadlineAtMs: number | undefined;
  for (const embeddedRun of activity.activeEmbeddedRuns.values()) {
    const registration = embeddedRun.generation
      ? activeDiagnosticOwners.get(embeddedRun.generation)
      : undefined;
    const backendActivity = registration?.backendActivity;
    if (
      !registration ||
      !backendActivity ||
      resolveCurrentDiagnosticOwner(registration.owner, backendActivity.assertCurrent) !==
        registration ||
      registration.activity !== activity ||
      registration.backendActivity !== backendActivity
    ) {
      continue;
    }
    activeBackendLivenessDeadlineAtMs = Math.max(
      activeBackendLivenessDeadlineAtMs ?? backendActivity.deadlineAtMs,
      backendActivity.deadlineAtMs,
    );
  }
  return {
    ...buildDiagnosticSessionActivitySnapshot(activity, now),
    ...(activeBackendLivenessDeadlineAtMs !== undefined
      ? { activeBackendLivenessDeadlineAtMs }
      : {}),
  };
}

export function getDiagnosticEmbeddedRunActivitySequence(): number {
  return embeddedRunSequence;
}

function markDiagnosticModelStartedForTest(params: ModelStartedActivityEvent): void {
  recordModelStarted(params, undefined, true);
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
    markDiagnosticToolStartedForTest: recordToolStarted,
  };
}

let unregisterDiagnosticRunActivityListener: (() => void) | undefined;

export function startDiagnosticRunActivityTracking(): void {
  if (unregisterDiagnosticRunActivityListener) {
    return;
  }
  const startAfterEventSequence = getInternalDiagnosticEventSequence();
  unregisterDiagnosticRunActivityListener = onInternalDiagnosticEvent(
    (event, metadata) => {
      // A prior lifecycle can leave already-sequenced events in the async queue.
      // Ignore them so a restart cannot recreate activity that stop cleared.
      if (event.seq <= startAfterEventSequence) {
        return;
      }
      switch (event.type) {
        case "tool.execution.started":
          return recordToolStarted(event);
        case "tool.execution.completed":
        case "tool.execution.error":
        case "tool.execution.blocked":
          return recordToolEnded(event);
        case "model.call.started":
          recordModelStarted(event, resolveCoreModelRequestLifecycleDiagnosticMetadata(metadata));
          return;
        case "model.call.completed":
        case "model.call.error":
          recordModelEnded(event, resolveCoreModelRequestLifecycleDiagnosticMetadata(metadata));
          return;
        case "run.progress":
          return applyRunProgress(
            event,
            isCoreSemanticRunProgressDiagnosticMetadata(metadata) ? "semantic" : "unbound",
          );
        case "run.completed":
          return recordRunCompleted(event);
        default:
          break;
      }
    },
    {
      include: [
        "tool.execution.started",
        "tool.execution.completed",
        "tool.execution.error",
        "tool.execution.blocked",
        "model.call.started",
        "model.call.completed",
        "model.call.error",
        "run.progress",
        "run.completed",
      ],
    },
  );
}

export function stopDiagnosticRunActivityTracking(): void {
  unregisterDiagnosticRunActivityListener?.();
  unregisterDiagnosticRunActivityListener = undefined;
  activityByRef.clear();
  activityByRunId.clear();
  activeDiagnosticOwners.clear();
  embeddedRunSequence = 0;
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  installDiagnosticRunActivityTestApi();
}
