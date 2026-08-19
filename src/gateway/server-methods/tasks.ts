// Task gateway methods expose detached task list/get/cancel operations with
// bounded public summaries over the runtime task registry.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type TaskSummary,
  type TasksListParams,
  validateTasksCancelParams,
  validateTasksGetParams,
  validateTasksListParams,
  validateTasksRecoveryParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  dismissSubagentCompletionDelivery,
  retrySubagentCompletionDelivery,
} from "../../agents/subagents/completion/subagent-completion-delivery.js";
import { canonicalizeMainSessionAlias } from "../../config/sessions.js";
import { getTaskById, listTaskRecordPage } from "../../tasks/runtime-internal.js";
import { isTerminalTaskStatus } from "../../tasks/task-executor-policy.js";
import type { TaskRecord, TaskStatus } from "../../tasks/task-registry.types.js";
import { abortChatRunById } from "../chat-abort.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { createChatAbortOps } from "./chat-abort-runtime.js";
import { mapTaskSummary } from "./task-summary.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const DEFAULT_TASKS_LIST_LIMIT = 100;
const MAX_TASKS_LIST_LIMIT = 500;
const CLI_TASK_CANCEL_SETTLE_TIMEOUT_MS = 10_000;
const CLI_TASK_CANCEL_POLL_MS = 20;

type TaskLedgerStatus = TaskSummary["status"];

const LEDGER_STATUS_TO_TASK_STATUSES: Record<TaskLedgerStatus, TaskStatus[]> = {
  queued: ["queued"],
  running: ["running"],
  completed: ["succeeded"],
  failed: ["failed", "lost"],
  timed_out: ["timed_out"],
  cancelled: ["cancelled"],
};

function normalizeTaskStatusFilter(status: TasksListParams["status"]): Set<TaskStatus> | null {
  if (!status) {
    return null;
  }
  const statuses = Array.isArray(status) ? status : [status];
  return new Set(statuses.flatMap((value) => LEDGER_STATUS_TO_TASK_STATUSES[value] ?? []));
}

// Cursor strings are offsets, not opaque tokens; reject malformed values so a
// client cannot silently restart pagination at the first page.
function parseCursor(cursor: string | undefined): number | null {
  if (!cursor) {
    return 0;
  }
  if (!/^\d+$/.test(cursor.trim())) {
    return null;
  }
  const parsed = Number(cursor);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function waitForCliTaskCancellationSettlement(taskId: string): Promise<TaskRecord | null> {
  const deadline = Date.now() + CLI_TASK_CANCEL_SETTLE_TIMEOUT_MS;
  while (true) {
    const current = getTaskById(taskId);
    if (current && isTerminalTaskStatus(current.status)) {
      return current;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, CLI_TASK_CANCEL_POLL_MS));
  }
}

async function cancelGatewayCliTask(params: {
  task: TaskRecord;
  reason?: string;
  context: GatewayRequestContext;
}): Promise<{ found: true; cancelled: boolean; reason?: string; task: TaskRecord }> {
  const runId = params.task.runId?.trim();
  const active = runId ? params.context.chatAbortControllers.get(runId) : undefined;
  if (!runId || !active || active.kind !== "agent") {
    return {
      found: true,
      cancelled: false,
      reason: "CLI task has no active gateway cancellation handle.",
      task: params.task,
    };
  }
  const result = abortChatRunById(createChatAbortOps(params.context), {
    runId,
    sessionKey: active.sessionKey,
    stopReason: "rpc",
  });
  if (!result.aborted) {
    return {
      found: true,
      cancelled: false,
      reason: "CLI task runtime rejected cancellation.",
      task: getTaskById(params.task.taskId) ?? params.task,
    };
  }
  const settled = await waitForCliTaskCancellationSettlement(params.task.taskId);
  if (!settled) {
    return {
      found: true,
      cancelled: false,
      reason: `CLI task received cancellation but did not terminate within ${CLI_TASK_CANCEL_SETTLE_TIMEOUT_MS}ms.`,
      task: getTaskById(params.task.taskId) ?? params.task,
    };
  }
  if (settled.status !== "cancelled") {
    return {
      found: true,
      cancelled: false,
      reason: `CLI task became ${settled.status} while cancellation was in progress.`,
      task: settled,
    };
  }
  return { found: true, cancelled: true, task: settled };
}

// Control UI task methods expose the stable gateway protocol shape; helpers
// above keep runtime registry details out of the wire result.
export const tasksHandlers: GatewayRequestHandlers = {
  "tasks.list": ({ params, respond, context }) => {
    if (!assertValidParams(params, validateTasksListParams, "tasks.list", respond)) {
      return;
    }
    const cursor = parseCursor(params.cursor);
    if (cursor === null) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid tasks.list cursor"),
      );
      return;
    }
    const statusFilter = normalizeTaskStatusFilter(params.status);
    const limit = Math.min(params.limit ?? DEFAULT_TASKS_LIST_LIMIT, MAX_TASKS_LIST_LIMIT);
    const requestedSessionKey = normalizeOptionalString(params.sessionKey);
    const cfg = context.getRuntimeConfig();
    let sessionKey: string | undefined;
    let sessionAgentId: string | undefined;
    if (requestedSessionKey) {
      const sessionOwner = resolveRequestedSessionAgentId(
        cfg,
        requestedSessionKey,
        normalizeOptionalString(params.agentId),
      );
      if (!sessionOwner.ok) {
        respond(false, undefined, sessionOwner.error);
        return;
      }
      sessionAgentId = sessionOwner.agentId;
      sessionKey = canonicalizeMainSessionAlias({
        cfg,
        agentId: sessionOwner.agentId,
        sessionKey: requestedSessionKey,
      });
    }
    // The ledger pages by last activity so an old long-running task that just
    // finished still surfaces first. Selection stays inside the registry so
    // only the bounded wire page pays for defensive record cloning.
    const page = listTaskRecordPage({
      offset: cursor,
      limit,
      statuses: statusFilter ? [...statusFilter] : undefined,
      agentId: sessionKey ? undefined : params.agentId,
      sessionKey,
      sessionAgentId,
      cfg,
    });
    const nextOffset = cursor + page.tasks.length;
    respond(true, {
      tasks: page.tasks.map((task) => mapTaskSummary(task)),
      ...(page.hasMore ? { nextCursor: String(nextOffset) } : {}),
    });
  },
  "tasks.get": ({ params, respond }) => {
    if (!assertValidParams(params, validateTasksGetParams, "tasks.get", respond)) {
      return;
    }
    const taskId = params.taskId;
    const task = getTaskById(taskId);
    if (!task) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `task not found: ${taskId}`),
      );
      return;
    }
    // The potentially longer task input is lookup-only. List and event payloads
    // stay compact while detail views can show the operator what was requested.
    respond(true, { task: mapTaskSummary(task, { includePrompt: true }) });
  },
  "tasks.cancel": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateTasksCancelParams, "tasks.cancel", respond)) {
      return;
    }
    const taskId = params.taskId;
    const reason = normalizeOptionalString(params.reason);
    const task = getTaskById(taskId);
    if (task?.runtime === "cli" && !isTerminalTaskStatus(task.status)) {
      const result = await cancelGatewayCliTask({ task, reason, context });
      respond(true, {
        found: result.found,
        cancelled: result.cancelled,
        ...(result.reason ? { reason: result.reason } : {}),
        task: mapTaskSummary(result.task),
      });
      return;
    }
    const { cancelDetachedTaskRunByIdCore } =
      await import("../../tasks/task-executor-cancel.runtime.js");
    const result = await cancelDetachedTaskRunByIdCore({
      cfg: context.getRuntimeConfig(),
      taskId,
      ...(reason ? { reason } : {}),
    });
    respond(true, {
      found: result.found,
      cancelled: result.cancelled,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.task ? { task: mapTaskSummary(result.task) } : {}),
    });
  },
  "tasks.retry": async ({ params, respond }) => {
    if (!assertValidParams(params, validateTasksRecoveryParams, "tasks.retry", respond)) {
      return;
    }
    const results = [];
    for (const taskId of params.taskIds) {
      const result = await retrySubagentCompletionDelivery(taskId);
      results.push({
        taskId,
        ok: result.ok,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.duplicateRisk ? { duplicateRisk: true } : {}),
        ...(result.task ? { task: mapTaskSummary(result.task, { includePrompt: true }) } : {}),
      });
    }
    respond(true, { results });
  },
  "tasks.dismiss": async ({ params, respond }) => {
    if (!assertValidParams(params, validateTasksRecoveryParams, "tasks.dismiss", respond)) {
      return;
    }
    const { discardSubagentTerminalDelivery } =
      await import("../../agents/subagents/registry/subagent-registry.js");
    const results = [];
    for (const taskId of params.taskIds) {
      const result = await dismissSubagentCompletionDelivery(taskId, {
        discardTerminalDelivery: discardSubagentTerminalDelivery,
      });
      results.push({
        taskId,
        ok: result.ok,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.task ? { task: mapTaskSummary(result.task, { includePrompt: true }) } : {}),
      });
    }
    respond(true, { results });
  },
};
