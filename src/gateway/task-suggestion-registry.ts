// Process-local registry for model-proposed follow-up tasks.
import { randomUUID } from "node:crypto";
import type {
  TaskSuggestion,
  TaskSuggestionsCreateParams,
  TaskSuggestionsListParams,
} from "../../packages/gateway-protocol/src/index.js";

const MAX_TASK_SUGGESTIONS = 100;
const MAX_TASK_SUGGESTION_RETAINED_BYTES = 2 * 1024 * 1024;
type TaskSuggestionRecord =
  | { status: "pending" | "accepting" | "dismissed"; suggestion: TaskSuggestion }
  | { status: "accepted"; suggestion: TaskSuggestion; sessionKey: string };

const suggestions = new Map<string, TaskSuggestionRecord>();
let retainedSuggestionBytes = 0;

function retainedBytesForSuggestion(suggestion: TaskSuggestion): number {
  // Account for one array delimiter per record. Keeping one extra byte free
  // covers the surrounding brackets in the list response.
  return Buffer.byteLength(JSON.stringify(suggestion)) + 1;
}

type CreateTaskSuggestionResult =
  | { status: "created"; suggestion: TaskSuggestion; evictedPendingTaskIds: string[] }
  | { status: "full" };

function evictTaskSuggestion(): string | null | undefined {
  for (const [taskId, record] of suggestions) {
    if (record.status === "accepted" || record.status === "dismissed") {
      retainedSuggestionBytes -= retainedBytesForSuggestion(record.suggestion);
      suggestions.delete(taskId);
      return null;
    }
  }
  for (const [taskId, record] of suggestions) {
    if (record.status === "pending") {
      retainedSuggestionBytes -= retainedBytesForSuggestion(record.suggestion);
      suggestions.delete(taskId);
      return taskId;
    }
  }
  return undefined;
}

/** Records one suggestion without starting work. IDs intentionally vanish on restart. */
export function createTaskSuggestion(
  params: TaskSuggestionsCreateParams,
): CreateTaskSuggestionResult {
  const suggestion: TaskSuggestion = {
    id: `task_${randomUUID()}`,
    title: params.title,
    prompt: params.prompt,
    tldr: params.tldr,
    cwd: params.cwd,
    sessionKey: params.sessionKey,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    createdAt: Date.now(),
  };
  const suggestionBytes = retainedBytesForSuggestion(suggestion);
  const evictedPendingTaskIds: string[] = [];
  while (
    suggestions.size >= MAX_TASK_SUGGESTIONS ||
    retainedSuggestionBytes + suggestionBytes + 1 > MAX_TASK_SUGGESTION_RETAINED_BYTES
  ) {
    const evictedTaskId = evictTaskSuggestion();
    if (evictedTaskId === undefined) {
      // All retained tasks are in-flight acceptances. Reject new work instead
      // of losing either its UI card or an acceptance's idempotency result.
      return { status: "full" };
    }
    if (evictedTaskId) {
      evictedPendingTaskIds.push(evictedTaskId);
    }
  }
  suggestions.set(suggestion.id, { status: "pending", suggestion });
  retainedSuggestionBytes += suggestionBytes;
  return { status: "created", suggestion, evictedPendingTaskIds };
}

/** Lists newest suggestions first, optionally scoped to their source chat. */
export function listTaskSuggestions(params: TaskSuggestionsListParams): TaskSuggestion[] {
  return [...suggestions.values()]
    .filter((record) => record.status === "pending")
    .map((record) => record.suggestion)
    .filter(
      (suggestion) =>
        (!params.sessionKey || suggestion.sessionKey === params.sessionKey) &&
        (!params.agentId || suggestion.agentId === params.agentId),
    )
    .toReversed();
}

type TaskSuggestionAcceptance =
  | { status: "claimed"; suggestion: TaskSuggestion }
  | { status: "accepted"; sessionKey: string }
  | { status: "accepting" | "dismissed" | "missing" };

/** Claims one suggestion before any privileged worktree/session side effects begin. */
export function beginTaskSuggestionAcceptance(taskId: string): TaskSuggestionAcceptance {
  const record = suggestions.get(taskId);
  if (!record) {
    return { status: "missing" };
  }
  if (record.status === "accepted") {
    return { status: "accepted", sessionKey: record.sessionKey };
  }
  if (record.status !== "pending") {
    return { status: record.status };
  }
  suggestions.set(taskId, { status: "accepting", suggestion: record.suggestion });
  return { status: "claimed", suggestion: record.suggestion };
}

/** Restores a claim when session creation fails before an acceptance result exists. */
export function cancelTaskSuggestionAcceptance(taskId: string): TaskSuggestion | undefined {
  const record = suggestions.get(taskId);
  if (record?.status === "accepting") {
    suggestions.set(taskId, { status: "pending", suggestion: record.suggestion });
    return record.suggestion;
  }
  return undefined;
}

/** Retires a claimed suggestion when partial side effects cannot be rolled back safely. */
export function abandonTaskSuggestionAcceptance(taskId: string): boolean {
  const record = suggestions.get(taskId);
  if (record?.status !== "accepting") {
    return false;
  }
  suggestions.set(taskId, { status: "dismissed", suggestion: record.suggestion });
  return true;
}

/** Retains the created session key so retries return the same accepted task. */
export function completeTaskSuggestionAcceptance(taskId: string, sessionKey: string): void {
  const record = suggestions.get(taskId);
  if (record?.status === "accepting") {
    suggestions.set(taskId, { status: "accepted", suggestion: record.suggestion, sessionKey });
  }
}

/** Dismisses only a pending suggestion; accepted or in-flight tasks stay immutable. */
export function dismissTaskSuggestion(taskId: string): boolean {
  const record = suggestions.get(taskId);
  if (record?.status !== "pending") {
    return false;
  }
  suggestions.set(taskId, { status: "dismissed", suggestion: record.suggestion });
  return true;
}
