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
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  dismissSubagentCompletionDelivery,
  retrySubagentCompletionDelivery,
} from "../../agents/subagent-completion-delivery.js";
import { canonicalizeMainSessionAlias } from "../../config/sessions.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { getTaskById, listTaskRecordPage } from "../../tasks/runtime-internal.js";
import type { TaskStatus } from "../../tasks/task-registry.types.js";
import { mapTaskSummary } from "./task-summary.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const DEFAULT_TASKS_LIST_LIMIT = 100;
const MAX_TASKS_LIST_LIMIT = 500;

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
    let sessionKey: string | undefined;
    if (requestedSessionKey) {
      const cfg = context.getRuntimeConfig();
      sessionKey = canonicalizeMainSessionAlias({
        cfg,
        agentId:
          parseAgentSessionKey(requestedSessionKey)?.agentId ??
          normalizeOptionalString(params.agentId) ??
          resolveDefaultAgentId(cfg),
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
      agentId: params.agentId,
      sessionKey,
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
    const { cancelDetachedTaskRunById } =
      await import("../../tasks/task-executor-cancel.runtime.js");
    const result = await cancelDetachedTaskRunById({
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
  "tasks.dismiss": ({ params, respond }) => {
    if (!assertValidParams(params, validateTasksRecoveryParams, "tasks.dismiss", respond)) {
      return;
    }
    respond(true, {
      results: params.taskIds.map((taskId) => {
        const result = dismissSubagentCompletionDelivery(taskId);
        return {
          taskId,
          ok: result.ok,
          ...(result.reason ? { reason: result.reason } : {}),
          ...(result.task ? { task: mapTaskSummary(result.task, { includePrompt: true }) } : {}),
        };
      }),
    });
  },
};

export const testApi = {
  mapTaskSummary,
};
export { testApi as __test };
