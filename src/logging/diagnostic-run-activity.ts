import {
  onInternalDiagnosticEvent,
  type DiagnosticEventPayload,
  type DiagnosticSessionActiveWorkKind,
} from "../infra/diagnostic-events.js";

type SessionActivity = {
  sessionId?: string;
  sessionKey?: string;
  activeEmbeddedRun: boolean;
  activeTools: Map<string, ActiveTool>;
  activeModelCalls: Set<string>;
  lastProgressAt: number;
  lastProgressReason?: string;
};

type ActiveTool = {
  toolName: string;
  toolCallId?: string;
  startedAt: number;
  lastProgressAt: number;
};

export type DiagnosticSessionActivitySnapshot = {
  activeWorkKind?: DiagnosticSessionActiveWorkKind;
  activeToolName?: string;
  activeToolCallId?: string;
  activeToolAgeMs?: number;
  lastProgressAgeMs?: number;
  lastProgressReason?: string;
};

const activityByRef = new Map<string, SessionActivity>();
const activityByRunId = new Map<string, SessionActivity>();

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
  target.activeEmbeddedRun ||= source.activeEmbeddedRun;
  for (const [key, tool] of source.activeTools) {
    target.activeTools.set(key, tool);
  }
  for (const call of source.activeModelCalls) {
    target.activeModelCalls.add(call);
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
    activeEmbeddedRun: false,
    activeTools: new Map(),
    activeModelCalls: new Set(),
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

function recordToolStarted(
  event: Extract<DiagnosticEventPayload, { type: "tool.execution.started" }>,
): void {
  const activity = resolveSessionActivity({ ...event, create: true });
  if (!activity) {
    return;
  }
  const now = Date.now();
  activity.activeTools.set(toolKey(event), {
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

function recordModelStarted(
  event: Extract<DiagnosticEventPayload, { type: "model.call.started" }>,
): void {
  const activity = resolveSessionActivity({ ...event, create: true });
  if (!activity) {
    return;
  }
  activity.activeModelCalls.add(modelCallKey(event));
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

function recordRunProgress(event: Extract<DiagnosticEventPayload, { type: "run.progress" }>): void {
  const activity = resolveSessionActivity({ ...event, create: true });
  if (!activity) {
    return;
  }
  touchSessionActivity(activity, event.reason);
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
  activity.activeEmbeddedRun = false;
  touchSessionActivity(activity, "run:completed");
}

export function markDiagnosticEmbeddedRunStarted(params: {
  sessionId: string;
  sessionKey?: string;
}): void {
  const activity = resolveSessionActivity({ ...params, create: true });
  if (!activity) {
    return;
  }
  activity.activeEmbeddedRun = true;
  touchSessionActivity(activity, "embedded_run:started");
}

export function markDiagnosticEmbeddedRunEnded(params: {
  sessionId: string;
  sessionKey?: string;
}): void {
  const activity = resolveSessionActivity(params);
  if (!activity) {
    return;
  }
  activity.activeEmbeddedRun = false;
  activity.activeTools.clear();
  activity.activeModelCalls.clear();
  touchSessionActivity(activity, "embedded_run:ended");
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
  } else if (activity.activeEmbeddedRun) {
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
    activeToolName: activeTool?.toolName,
    activeToolCallId: activeTool?.toolCallId,
    activeToolAgeMs: activeTool ? Math.max(0, now - activeTool.startedAt) : undefined,
    lastProgressAgeMs: Math.max(0, now - activity.lastProgressAt),
    lastProgressReason: activity.lastProgressReason,
  };
}

export function resetDiagnosticRunActivityForTest(): void {
  activityByRef.clear();
  activityByRunId.clear();
}

onInternalDiagnosticEvent((event) => {
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
      return;
    default:
      return;
  }
});
