import type {
  CoreModelRequestOwnerGeneration,
  DiagnosticEmbeddedRunOwner,
} from "../infra/diagnostic-model-request-provenance.js";
import {
  type DiagnosticArgumentChurnActivity,
  mergeArgumentChurnActivity,
  recordDiagnosticActivityProgress,
} from "./diagnostic-argument-churn-activity.js";
import { createDiagnosticEmbeddedRunIndex } from "./diagnostic-embedded-run-index.js";
import {
  type DiagnosticRepeatedRequestActivity,
  mergeRepeatedRequestActivity,
} from "./diagnostic-repeated-request-activity.js";
import type {
  DiagnosticRecoveryEmbeddedRun,
  DiagnosticRecoveryModelCall,
  DiagnosticRecoveryTool,
} from "./diagnostic-run-activity-recovery.js";

export type SessionActivity = DiagnosticArgumentChurnActivity &
  DiagnosticRepeatedRequestActivity & {
    sessionId?: string;
    sessionKey?: string;
    activeEmbeddedRuns: Map<string, DiagnosticRecoveryEmbeddedRun>;
    activeTools: Map<string, DiagnosticRecoveryTool>;
    activeModelCalls: Map<string, DiagnosticRecoveryModelCall>;
    activeCoreModelCalls: Map<
      CoreModelRequestOwnerGeneration,
      Map<string, DiagnosticRecoveryModelCall>
    >;
    recoveredOwnerStartEventCutoffs: Map<string, number>;
    lastProgressAt: number;
    lastProgressReason?: string;
  };

export type DiagnosticBackendActivity = {
  deadlineAtMs: number;
  assertCurrent: () => void;
};

export type DiagnosticOwnerRegistration = {
  activity: SessionActivity;
  owner: DiagnosticEmbeddedRunOwner;
  backendActivity?: DiagnosticBackendActivity;
};

export const activityByRef = new Map<string, SessionActivity>();
export const activityByRunId = new Map<string, SessionActivity>();
export const embeddedRunIndex = createDiagnosticEmbeddedRunIndex(activityByRunId);
export const activeDiagnosticOwners = new Map<
  CoreModelRequestOwnerGeneration,
  DiagnosticOwnerRegistration
>();
export function sessionRefs(params: { sessionId?: string; sessionKey?: string }): string[] {
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
  for (const [generation, modelCalls] of source.activeCoreModelCalls) {
    target.activeCoreModelCalls.set(generation, modelCalls);
  }
  for (const registration of activeDiagnosticOwners.values()) {
    if (registration.activity === source) {
      registration.activity = target;
    }
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
    activeCoreModelCalls: new Map(),
    recoveredOwnerStartEventCutoffs: new Map(),
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
