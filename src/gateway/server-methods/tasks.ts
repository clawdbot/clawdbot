// Task gateway methods expose detached task list/get/cancel operations with
// bounded public summaries over the runtime task registry.
import { createHash, randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  TASKS_LIST_CURSOR_MAX_LENGTH,
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
import type { TaskRecord, TaskStatus } from "../../tasks/task-registry.types.js";
import { readGatewayAccessRevision } from "../gateway-access-revision.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { canAccessTaskRequesterSession } from "../task-session-access.js";
import { mapTaskSummary } from "./task-summary.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const DEFAULT_TASKS_LIST_LIMIT = 100;
const MAX_TASKS_LIST_LIMIT = 500;
const TASKS_LIST_MAX_ATTEMPTS = 3;
const TASKS_LIST_CURSOR_VERSION = "1";

type TaskListCursor = {
  offset: number;
  taskRevision: number;
  accessRevision: number;
  binding: string;
};

type TaskLedgerStatus = TaskSummary["status"];

// One request context is shared for a Gateway lifetime. Its weak identity
// rejects prior-lifetime cursors without widening every request with bootId.
const taskListGatewayIds = new WeakMap<object, string>();

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

function taskListGatewayId(context: object): string {
  const current = taskListGatewayIds.get(context);
  if (current) {
    return current;
  }
  const created = randomUUID();
  taskListGatewayIds.set(context, created);
  return created;
}

function taskListFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url");
}

function encodeTaskListCursor(cursor: TaskListCursor): string {
  return [
    TASKS_LIST_CURSOR_VERSION,
    cursor.offset,
    cursor.taskRevision,
    cursor.accessRevision,
    cursor.binding,
  ].join(".");
}

function parseTaskListCursor(value: string | undefined): TaskListCursor | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (!value || value.length > TASKS_LIST_CURSOR_MAX_LENGTH) {
    return null;
  }
  const [version, rawOffset, rawTaskRevision, rawAccessRevision, binding] = value.split(".");
  const cursor: TaskListCursor = {
    offset: Number(rawOffset),
    taskRevision: Number(rawTaskRevision),
    accessRevision: Number(rawAccessRevision),
    binding: binding ?? "",
  };
  if (
    version !== TASKS_LIST_CURSOR_VERSION ||
    !Number.isSafeInteger(cursor.offset) ||
    cursor.offset < 0 ||
    !Number.isSafeInteger(cursor.taskRevision) ||
    cursor.taskRevision < 0 ||
    !Number.isSafeInteger(cursor.accessRevision) ||
    cursor.accessRevision < 0 ||
    encodeTaskListCursor(cursor) !== value
  ) {
    return null;
  }
  return cursor;
}

function invalidTaskListCursor(
  respond: Parameters<GatewayRequestHandlers["tasks.list"]>[0]["respond"],
) {
  respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      "invalid or expired tasks.list cursor; restart pagination without a cursor",
    ),
  );
}

// Control UI task methods expose the stable gateway protocol shape; helpers
// above keep runtime registry details out of the wire result.
export const tasksHandlers: GatewayRequestHandlers = {
  "tasks.list": async ({ params, respond, context, client }) => {
    if (typeof params.cursor === "string" && params.cursor.length > TASKS_LIST_CURSOR_MAX_LENGTH) {
      invalidTaskListCursor(respond);
      return;
    }
    if (!assertValidParams(params, validateTasksListParams, "tasks.list", respond)) {
      return;
    }
    const cursor = parseTaskListCursor(params.cursor);
    if (cursor === null) {
      invalidTaskListCursor(respond);
      return;
    }
    const statusFilter = normalizeTaskStatusFilter(params.status);
    const statuses = statusFilter ? [...statusFilter].toSorted() : undefined;
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
    const agentId = sessionKey ? undefined : normalizeOptionalString(params.agentId);
    // Bind each carried offset to one live caller/query/revision view. If any
    // field changes, the caller restarts instead of selecting another page.
    const bindingFacts = [
      taskListGatewayId(context),
      client?.connId ?? null,
      client?.authenticatedUserProfile?.profileId ?? null,
      client?.authenticatedUserId ?? null,
      client?.pairedClientId ?? null,
      client?.connect.role ?? null,
      client?.connect.scopes?.toSorted() ?? null,
      statuses,
      agentId,
      sessionKey,
      sessionAgentId,
      params.sortBy ?? null,
    ];
    const bindCursor = (...fields: number[]) => taskListFingerprint([fields, ...bindingFacts]);
    const cursorBinding =
      cursor && bindCursor(cursor.offset, cursor.taskRevision, cursor.accessRevision);
    if (cursor && cursor.binding !== cursorBinding) {
      invalidTaskListCursor(respond);
      return;
    }
    // Selection stays inside the registry so ordering applies before pagination
    // and only the bounded wire page pays for defensive record cloning.
    const canReadTask = (task: Readonly<TaskRecord>) =>
      canAccessTaskRequesterSession({ cfg, client, task });
    const pageParams = {
      offset: cursor?.offset ?? 0,
      limit,
      expectedRevision: cursor?.taskRevision,
      statuses,
      agentId,
      sessionKey,
      sessionAgentId,
      cfg,
      filter: canReadTask,
      sortBy: params.sortBy,
    };
    // Page scans yield to active task updates. Restart the complete selection
    // and authorization attempt so transient registry churn never reaches clients.
    for (let attempt = 0; attempt < TASKS_LIST_MAX_ATTEMPTS; attempt += 1) {
      const accessRevision = readGatewayAccessRevision();
      if (cursor && cursor.accessRevision !== accessRevision) {
        invalidTaskListCursor(respond);
        return;
      }
      const pageResult = await listTaskRecordPage(pageParams);
      if (!pageResult.ok) {
        // A cursor bound to an older revision can never succeed on retry, so it
        // restarts the caller. Transient registry churn gets another attempt.
        if (pageResult.error === "cursor_stale") {
          invalidTaskListCursor(respond);
          return;
        }
        continue;
      }
      const page = pageResult.value;
      // Sharing changes invalidate every access decision made before a yield.
      // Recheck selected rows in the final synchronous response turn as well.
      if (
        accessRevision !== readGatewayAccessRevision() ||
        page.tasks.some((task) => !canReadTask(task))
      ) {
        if (cursor) {
          invalidTaskListCursor(respond);
          return;
        }
        continue;
      }
      const nextOffset = pageParams.offset + page.tasks.length;
      respond(true, {
        tasks: page.tasks.map((task) => mapTaskSummary(task)),
        ...(page.hasMore
          ? {
              nextCursor: encodeTaskListCursor({
                offset: nextOffset,
                taskRevision: page.revision,
                accessRevision,
                binding: bindCursor(nextOffset, page.revision, accessRevision),
              }),
            }
          : {}),
      });
      return;
    }
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.UNAVAILABLE,
        "Task activity did not stabilize. Wait a moment, then refresh Tasks.",
        { retryable: true, retryAfterMs: 250 },
      ),
    );
  },
  "tasks.get": ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateTasksGetParams, "tasks.get", respond)) {
      return;
    }
    const taskId = params.taskId;
    const task = getTaskById(taskId);
    if (
      !task ||
      !canAccessTaskRequesterSession({ cfg: context.getRuntimeConfig(), client, task })
    ) {
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
  "tasks.cancel": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateTasksCancelParams, "tasks.cancel", respond)) {
      return;
    }
    const taskId = params.taskId;
    const reason = normalizeOptionalString(params.reason);
    const { cancelDetachedTaskRunByIdCore } =
      await import("../../tasks/task-executor-cancel.runtime.js");
    const cfg = context.getRuntimeConfig();
    const task = getTaskById(taskId);
    if (task && !canAccessTaskRequesterSession({ access: "write", cfg, client, task })) {
      respond(true, { found: false, cancelled: false });
      return;
    }
    const result = await cancelDetachedTaskRunByIdCore({
      cfg,
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
  "tasks.retry": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateTasksRecoveryParams, "tasks.retry", respond)) {
      return;
    }
    const results = [];
    const cfg = context.getRuntimeConfig();
    for (const taskId of params.taskIds) {
      const task = getTaskById(taskId);
      if (task && !canAccessTaskRequesterSession({ access: "write", cfg, client, task })) {
        results.push({ taskId, ok: false, reason: "task not found" });
        continue;
      }
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
  "tasks.dismiss": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateTasksRecoveryParams, "tasks.dismiss", respond)) {
      return;
    }
    const { discardSubagentTerminalDelivery } =
      await import("../../agents/subagents/registry/subagent-registry.js");
    const results = [];
    const cfg = context.getRuntimeConfig();
    for (const taskId of params.taskIds) {
      const task = getTaskById(taskId);
      if (task && !canAccessTaskRequesterSession({ access: "write", cfg, client, task })) {
        results.push({ taskId, ok: false, reason: "task not found" });
        continue;
      }
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
