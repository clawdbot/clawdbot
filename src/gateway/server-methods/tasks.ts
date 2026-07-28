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
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { canonicalizeMainSessionAlias } from "../../config/sessions.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { getTaskById, listTaskRecordsUnsorted } from "../../tasks/runtime-internal.js";
import type { TaskRecord, TaskStatus } from "../../tasks/task-registry.types.js";
import { mapTaskSummary, taskUpdatedAt } from "./task-summary.js";
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

// Session filtering needs all ownership keys because detached child runs may be
// queried from the requester, child session, or owner/control-plane view.
function taskMatchesSession(task: TaskRecord, sessionKey: string | undefined): boolean {
  const normalized = normalizeOptionalString(sessionKey);
  if (!normalized) {
    return true;
  }
  return [task.requesterSessionKey, task.childSessionKey, task.ownerKey].some(
    (candidate) => normalizeOptionalString(candidate) === normalized,
  );
}

// Explicit `task.agentId` is authoritative: a task that records its own agent
// must not also match other agents through the session-key fallback. Only
// records that predate a direct `agentId` recover the owning agent from
// session-style keys instead of being hidden.
function taskMatchesAgent(task: TaskRecord, agentId: string | undefined): boolean {
  const normalized = normalizeOptionalString(agentId);
  if (!normalized) {
    return true;
  }
  const explicitAgentId = normalizeOptionalString(task.agentId);
  if (explicitAgentId) {
    return explicitAgentId === normalized;
  }
  return [task.requesterSessionKey, task.childSessionKey, task.ownerKey].some(
    (candidate) => parseAgentSessionKey(candidate)?.agentId === normalized,
  );
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
    // The ledger view pages by last activity so an old long-running task that
    // just finished still surfaces on the first page instead of hiding behind
    // newer-created records. Start from a cloned insertion-order snapshot so
    // this sort does not first pay for the registry's discarded createdAt sort.
    const filtered = listTaskRecordsUnsorted()
      .filter((task) => {
        if (statusFilter && !statusFilter.has(task.status)) {
          return false;
        }
        return taskMatchesAgent(task, params.agentId) && taskMatchesSession(task, sessionKey);
      })
      .toSorted((left, right) => {
        const updatedDiff = taskUpdatedAt(right) - taskUpdatedAt(left);
        if (updatedDiff !== 0) {
          return updatedDiff;
        }
        return left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0;
      });
    const page = filtered.slice(cursor, cursor + limit);
    const nextOffset = cursor + page.length;
    respond(true, {
      tasks: page.map((task) => mapTaskSummary(task)),
      ...(nextOffset < filtered.length ? { nextCursor: String(nextOffset) } : {}),
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
};

export const testApi = {
  mapTaskSummary,
};
export { testApi as __test };
