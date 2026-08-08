// Task gateway methods expose detached task list/get/cancel operations with
// bounded public summaries over the runtime task registry.
import { stableStringify } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  GatewayErrorDetailCodes,
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
import { sha256Base64Url } from "../../infra/crypto-digest.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { getTaskById, listTaskRecordPage } from "../../tasks/runtime-internal.js";
import type { TaskStatus } from "../../tasks/task-registry.types.js";
import { mapTaskSummary } from "./task-summary.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const DEFAULT_TASKS_LIST_LIMIT = 100;
const MAX_TASKS_LIST_LIMIT = 500;
const MAX_TASKS_LIST_CURSOR_LENGTH = 1024;

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

type TasksListCursor = {
  v: 1;
  offset: number;
  revision: string;
  query: string;
};

function encodeCursor(cursor: TasksListCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function parseCursor(cursor: string | undefined): TasksListCursor | "legacy" | null | undefined {
  if (!cursor) {
    return undefined;
  }
  const normalized = cursor.trim();
  if (!normalized || normalized.length > MAX_TASKS_LIST_CURSOR_LENGTH) {
    return null;
  }
  // The previous Gateway emitted decimal offsets. Never resume one against the
  // mutable task order, but preserve its upgrade path through the stale-cursor
  // response that clients already know how to restart.
  if (/^\d+$/.test(normalized) && Number.isSafeInteger(Number(normalized))) {
    return "legacy";
  }
  if (!/^[A-Za-z0-9_-]+$/.test(normalized)) {
    return null;
  }
  try {
    const decoded = JSON.parse(Buffer.from(normalized, "base64url").toString("utf8")) as unknown;
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      return null;
    }
    const candidate = decoded as Partial<TasksListCursor>;
    if (
      candidate.v !== 1 ||
      !Number.isSafeInteger(candidate.offset) ||
      (candidate.offset ?? -1) < 0 ||
      typeof candidate.revision !== "string" ||
      !candidate.revision ||
      typeof candidate.query !== "string" ||
      !candidate.query
    ) {
      return null;
    }
    const parsed = candidate as TasksListCursor;
    return encodeCursor(parsed) === normalized ? parsed : null;
  } catch {
    return null;
  }
}

function resolveQueryFingerprint(params: {
  statuses?: readonly TaskStatus[];
  agentId?: string;
  sessionKey?: string;
}): string {
  return `sha256:${sha256Base64Url(
    stableStringify({
      statuses: params.statuses?.toSorted() ?? [],
      agentId: normalizeOptionalString(params.agentId) ?? null,
      sessionKey: normalizeOptionalString(params.sessionKey) ?? null,
    }),
  )}`;
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
    if (cursor === "legacy") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "stale tasks.list cursor", {
          details: { code: GatewayErrorDetailCodes.TASKS_LIST_CURSOR_STALE },
        }),
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
    const statuses = statusFilter ? [...statusFilter] : undefined;
    const queryFingerprint = resolveQueryFingerprint({
      statuses,
      agentId: params.agentId,
      sessionKey,
    });
    // The ledger pages by last activity so an old long-running task that just
    // finished still surfaces first. Selection stays inside the registry so
    // only the bounded wire page pays for defensive record cloning.
    const offset = cursor?.offset ?? 0;
    const page = listTaskRecordPage({
      offset,
      limit,
      statuses,
      agentId: params.agentId,
      sessionKey,
    });
    if (cursor && (cursor.revision !== page.revision || cursor.query !== queryFingerprint)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "stale tasks.list cursor", {
          details: { code: GatewayErrorDetailCodes.TASKS_LIST_CURSOR_STALE },
        }),
      );
      return;
    }
    const nextOffset = offset + page.tasks.length;
    respond(true, {
      tasks: page.tasks.map((task) => mapTaskSummary(task)),
      ...(page.hasMore
        ? {
            nextCursor: encodeCursor({
              v: 1,
              offset: nextOffset,
              revision: page.revision,
              query: queryFingerprint,
            }),
          }
        : {}),
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
