// Public task summaries keep task-registry internals and unbounded status text
// out of gateway responses and events.
import type { TaskSummary } from "../../../packages/gateway-protocol/src/index.js";
import { getTaskActivitySnapshot } from "../../tasks/task-registry-activity.js";
import type { TaskRecord, TaskStatus } from "../../tasks/task-registry.types.js";
import {
  TASK_STATUS_DETAIL_MAX_CHARS,
  formatTaskStatusTitle,
  sanitizeTaskPromptText,
  sanitizeTaskStatusText,
  truncateTaskStatusText,
} from "../../tasks/task-status.js";

type TaskLedgerStatus = TaskSummary["status"];

const TASK_PROMPT_MAX_CHARS = 4_000;
const TASK_RESULT_MAX_CHARS = 4_000;

const TASK_STATUS_TO_LEDGER_STATUS: Record<TaskStatus, TaskLedgerStatus> = {
  queued: "queued",
  running: "running",
  succeeded: "completed",
  failed: "failed",
  timed_out: "timed_out",
  cancelled: "cancelled",
  lost: "failed",
};

export type TaskEventPayload =
  | { action: "upserted"; task: TaskSummary }
  | { action: "deleted"; taskId: string }
  | { action: "restored" };

function taskUpdatedAt(task: TaskRecord): number {
  return task.lastEventAt ?? task.endedAt ?? task.startedAt ?? task.createdAt;
}

function sanitizeOptionalTaskText(
  value: unknown,
  opts?: { errorContext?: boolean },
): string | undefined {
  const sanitized = sanitizeTaskStatusText(value, {
    errorContext: opts?.errorContext,
    maxChars: TASK_STATUS_DETAIL_MAX_CHARS,
  });
  return sanitized || undefined;
}

export function mapTaskSummary(task: TaskRecord, opts?: { includePrompt?: boolean }): TaskSummary {
  const activity = getTaskActivitySnapshot(task.taskId);
  const lastActivity = sanitizeOptionalTaskText(activity?.lastActivity);
  const progressResult = sanitizeTaskStatusText(task.progressSummary);
  const terminalResult = sanitizeTaskStatusText(task.terminalSummary, { errorContext: true });
  const progressSummary =
    truncateTaskStatusText(progressResult, TASK_STATUS_DETAIL_MAX_CHARS) || undefined;
  const terminalSummary =
    truncateTaskStatusText(terminalResult, TASK_STATUS_DETAIL_MAX_CHARS) || undefined;
  const error = sanitizeOptionalTaskText(task.error, { errorContext: true });
  const lastToolName = sanitizeOptionalTaskText(task.lastToolName);
  const prompt = opts?.includePrompt
    ? sanitizeTaskPromptText(task.task, TASK_PROMPT_MAX_CHARS) || undefined
    : undefined;
  const result = opts?.includePrompt
    ? (task.runtime === "subagent" || task.runtime === "acp"
        ? progressResult
        : terminalResult || progressResult) || undefined
    : undefined;
  const toolUseCount =
    typeof task.toolUseCount === "number" && Number.isInteger(task.toolUseCount)
      ? Math.max(0, task.toolUseCount)
      : undefined;
  return {
    id: task.taskId,
    taskId: task.taskId,
    kind: task.taskKind ?? task.runtime,
    runtime: task.runtime,
    status: TASK_STATUS_TO_LEDGER_STATUS[task.status],
    title: formatTaskStatusTitle(task),
    ...(task.agentId ? { agentId: task.agentId } : {}),
    sessionKey: task.requesterSessionKey,
    ...(task.childSessionKey ? { childSessionKey: task.childSessionKey } : {}),
    ownerKey: task.ownerKey,
    ...(task.runId ? { runId: task.runId } : {}),
    ...(task.parentFlowId ? { flowId: task.parentFlowId } : {}),
    ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
    ...(task.sourceId ? { sourceId: task.sourceId } : {}),
    createdAt: task.createdAt,
    updatedAt: taskUpdatedAt(task),
    ...(task.startedAt !== undefined ? { startedAt: task.startedAt } : {}),
    ...(task.endedAt !== undefined ? { endedAt: task.endedAt } : {}),
    ...(toolUseCount !== undefined ? { toolUseCount } : {}),
    ...(lastToolName ? { lastToolName } : {}),
    ...(lastActivity ? { lastActivity } : {}),
    ...(activity?.diffStat ? { diffStat: activity.diffStat } : {}),
    ...(progressSummary ? { progressSummary } : {}),
    ...(terminalSummary ? { terminalSummary } : {}),
    ...(error ? { error } : {}),
    deliveryStatus: task.deliveryStatus,
    ...(task.terminalOutcome ? { terminalOutcome: task.terminalOutcome } : {}),
    ...(result ? { result: truncateTaskStatusText(result, TASK_RESULT_MAX_CHARS) } : {}),
    ...(prompt ? { prompt } : {}),
  };
}
