import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import {
  buildSessionAsyncTaskStatusDetails,
  findActiveSessionTask,
} from "./session-async-task-status.js";

export function isActiveMediaGenerationTask(params: {
  task: TaskRecord;
  taskKind: string;
}): boolean {
  return (
    params.task.runtime === "cli" &&
    params.task.scopeKind === "session" &&
    params.task.taskKind === params.taskKind &&
    (params.task.status === "queued" || params.task.status === "running")
  );
}

export function getMediaGenerationTaskProviderId(
  task: TaskRecord,
  sourcePrefix: string,
): string | undefined {
  const sourceId = task.sourceId?.trim() ?? "";
  if (!sourceId.startsWith(`${sourcePrefix}:`)) {
    return undefined;
  }
  const providerId = sourceId.slice(`${sourcePrefix}:`.length).trim();
  return providerId || undefined;
}

export function findActiveMediaGenerationTaskForSession(params: {
  sessionKey?: string;
  taskKind: string;
  sourcePrefix: string;
}): TaskRecord | undefined {
  return findActiveSessionTask({
    sessionKey: params.sessionKey,
    runtime: "cli",
    taskKind: params.taskKind,
    sourceIdPrefix: params.sourcePrefix,
  });
}

export function buildMediaGenerationTaskStatusDetails(params: {
  task: TaskRecord;
  sourcePrefix: string;
}): Record<string, unknown> {
  const provider = getMediaGenerationTaskProviderId(params.task, params.sourcePrefix);
  return {
    ...buildSessionAsyncTaskStatusDetails(params.task),
    ...(provider ? { provider } : {}),
  };
}

export function buildMediaGenerationTaskStatusText(params: {
  task: TaskRecord;
  sourcePrefix: string;
  nounLabel: string;
  toolName: string;
  completionLabel: string;
  duplicateGuard?: boolean;
}): string {
  const provider = getMediaGenerationTaskProviderId(params.task, params.sourcePrefix);
  const lines = [
    `${params.nounLabel} task ${params.task.taskId} is already ${params.task.status}${provider ? ` with ${provider}` : ""}.`,
    params.task.progressSummary ? `Progress: ${params.task.progressSummary}.` : null,
    params.duplicateGuard
      ? `Do not call ${params.toolName} again for this request. Wait for the completion event; the completion agent will send the finished ${params.completionLabel} here.`
      : `Wait for the completion event; the completion agent will send the finished ${params.completionLabel} here when it's ready.`,
  ].filter((entry): entry is string => Boolean(entry));
  return lines.join("\n");
}

export function buildActiveMediaGenerationTaskPromptContextForSession(params: {
  sessionKey?: string;
  taskKind: string;
  sourcePrefix: string;
  nounLabel: string;
  toolName: string;
  completionLabel: string;
}): string | undefined {
  const task = findActiveMediaGenerationTaskForSession({
    sessionKey: params.sessionKey,
    taskKind: params.taskKind,
    sourcePrefix: params.sourcePrefix,
  });
  if (!task) {
    return undefined;
  }
  const provider = getMediaGenerationTaskProviderId(task, params.sourcePrefix);
  const lines = [
    `An active ${normalizeLowercaseStringOrEmpty(params.nounLabel)} background task already exists for this session.`,
    `Task ${task.taskId} is currently ${task.status}${provider ? ` via ${provider}` : ""}.`,
    task.progressSummary ? `Current progress: ${task.progressSummary}.` : null,
    `Do not call \`${params.toolName}\` again for the same request while that task is queued or running.`,
    `If the user asks for progress or whether the work is async, explain the active task state or call \`${params.toolName}\` with \`action:"status"\` instead of starting a new generation.`,
    `Only start a new \`${params.toolName}\` call if the user clearly asks for different/new ${params.completionLabel}.`,
  ].filter((entry): entry is string => Boolean(entry));
  return lines.join("\n");
}
