// Gateway methods for ephemeral model-proposed follow-up tasks.
import path from "node:path";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  type TaskSuggestion,
  type TaskSuggestionsAcceptResult,
  validateTaskSuggestionsAcceptParams,
  validateTaskSuggestionsCreateParams,
  validateTaskSuggestionsDismissParams,
  validateTaskSuggestionsListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { managedWorktrees } from "../../agents/worktrees/service.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { buildDashboardSessionKey } from "../session-create-service.js";
import { loadSessionEntryReadOnly } from "../session-utils.js";
import {
  abandonTaskSuggestionAcceptance,
  beginTaskSuggestionAcceptance,
  cancelTaskSuggestionAcceptance,
  completeTaskSuggestionAcceptance,
  createTaskSuggestion,
  dismissTaskSuggestion,
  listTaskSuggestions,
} from "../task-suggestion-registry.js";
import { sessionsHandlers } from "./sessions.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers, RespondFn } from "./types.js";

function invalidParams(method: string, errors: Parameters<typeof formatValidationErrors>[0]) {
  return errorShape(
    ErrorCodes.INVALID_REQUEST,
    `invalid ${method} params: ${formatValidationErrors(errors)}`,
  );
}

type TaskSuggestionAcceptanceResult =
  | { ok: true; result: TaskSuggestionsAcceptResult }
  | { ok: false; error: NonNullable<Parameters<RespondFn>[2]> };

const activeAcceptances = new Map<string, Promise<TaskSuggestionAcceptanceResult>>();

async function rollbackSuggestedTaskSession(params: {
  key: string;
  agentId?: string;
  options: GatewayRequestHandlerOptions;
}): Promise<boolean> {
  let deletionConfirmed = false;
  try {
    await sessionsHandlers["sessions.delete"]?.({
      ...params.options,
      params: {
        key: params.key,
        ...(params.agentId ? { agentId: params.agentId } : {}),
        deleteTranscript: true,
        emitLifecycleHooks: false,
      },
      respond: (ok, payload) => {
        deletionConfirmed = Boolean(
          ok &&
          payload &&
          typeof payload === "object" &&
          typeof (payload as { deleted?: unknown }).deleted === "boolean",
        );
      },
    });
  } catch {
    // The state probes below determine whether the preallocated session key
    // and its worktree were fully removed despite a handler-level failure.
  }
  try {
    if (
      !deletionConfirmed &&
      loadSessionEntryReadOnly(params.key, { agentId: params.agentId }).entry
    ) {
      return false;
    }
  } catch {
    return false;
  }
  const worktree = managedWorktrees.findLiveByOwner("session", params.key);
  if (worktree) {
    try {
      await managedWorktrees.remove({
        id: worktree.id,
        reason: "suggested-task-seed-failed",
        force: true,
      });
    } catch {
      return false;
    }
  }
  return managedWorktrees.findLiveByOwner("session", params.key) === undefined;
}

async function failSuggestedTaskSession(params: {
  taskId: string;
  sessionKey: string;
  agentId: string;
  options: GatewayRequestHandlerOptions;
  error: NonNullable<Parameters<RespondFn>[2]>;
}): Promise<TaskSuggestionAcceptanceResult> {
  const rolledBack = await rollbackSuggestedTaskSession({
    key: params.sessionKey,
    agentId: params.agentId,
    options: params.options,
  });
  if (rolledBack) {
    const restored = cancelTaskSuggestionAcceptance(params.taskId);
    if (restored) {
      params.options.context.broadcast(
        "task.suggestion",
        { action: "created", suggestion: restored },
        { dropIfSlow: true },
      );
    }
    return { ok: false, error: params.error };
  }
  if (abandonTaskSuggestionAcceptance(params.taskId)) {
    params.options.context.broadcast(
      "task.suggestion",
      { action: "resolved", taskId: params.taskId, resolution: "expired" },
      { dropIfSlow: true },
    );
  }
  return {
    ok: false,
    error: errorShape(
      ErrorCodes.UNAVAILABLE,
      `${params.error.message}; failed to roll back the partial suggested task session`,
    ),
  };
}

async function createSuggestedTaskSession(params: {
  taskId: string;
  suggestion: TaskSuggestion;
  options: GatewayRequestHandlerOptions;
}): Promise<TaskSuggestionAcceptanceResult> {
  let sessionResponse: Parameters<RespondFn> | undefined;
  const agentId = normalizeAgentId(
    params.suggestion.agentId ??
      parseAgentSessionKey(params.suggestion.sessionKey)?.agentId ??
      resolveDefaultAgentId(params.options.context.getRuntimeConfig()),
  );
  const sessionKey = buildDashboardSessionKey(agentId);
  try {
    await sessionsHandlers["sessions.create"]?.({
      ...params.options,
      params: {
        key: sessionKey,
        agentId,
        parentSessionKey: params.suggestion.sessionKey,
        label: params.suggestion.title,
        task: params.suggestion.prompt,
        worktree: true,
        cwd: params.suggestion.cwd,
      },
      respond: (...args) => {
        sessionResponse = args;
      },
    });
  } catch (error) {
    return await failSuggestedTaskSession({
      taskId: params.taskId,
      sessionKey,
      agentId,
      options: params.options,
      error: errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)),
    });
  }
  if (!sessionResponse) {
    return await failSuggestedTaskSession({
      taskId: params.taskId,
      sessionKey,
      agentId,
      options: params.options,
      error: errorShape(ErrorCodes.UNAVAILABLE, "sessions.create did not respond"),
    });
  }
  const [ok, payload, error] = sessionResponse;
  if (!ok) {
    return await failSuggestedTaskSession({
      taskId: params.taskId,
      sessionKey,
      agentId,
      options: params.options,
      error: error ?? errorShape(ErrorCodes.UNAVAILABLE, "failed to create suggested task"),
    });
  }
  const key =
    payload && typeof payload === "object" && typeof (payload as { key?: unknown }).key === "string"
      ? (payload as { key: string }).key
      : undefined;
  if (!key) {
    return await failSuggestedTaskSession({
      taskId: params.taskId,
      sessionKey,
      agentId,
      options: params.options,
      error: errorShape(ErrorCodes.UNAVAILABLE, "sessions.create returned no session key"),
    });
  }
  const result = payload as { runError?: unknown; runStarted?: unknown };
  if (result.runStarted !== true) {
    const runMessage =
      result.runError &&
      typeof result.runError === "object" &&
      typeof (result.runError as { message?: unknown }).message === "string"
        ? (result.runError as { message: string }).message
        : "initial task did not start";
    return await failSuggestedTaskSession({
      taskId: params.taskId,
      sessionKey: key,
      agentId,
      options: params.options,
      error: errorShape(ErrorCodes.UNAVAILABLE, runMessage),
    });
  }
  completeTaskSuggestionAcceptance(params.taskId, key);
  params.options.context.broadcast(
    "task.suggestion",
    { action: "resolved", taskId: params.taskId, resolution: "accepted" },
    { dropIfSlow: true },
  );
  return { ok: true, result: { taskId: params.taskId, key } };
}

export const taskSuggestionsHandlers: GatewayRequestHandlers = {
  "taskSuggestions.list": ({ params, respond }) => {
    if (!validateTaskSuggestionsListParams(params)) {
      respond(
        false,
        undefined,
        invalidParams("taskSuggestions.list", validateTaskSuggestionsListParams.errors),
      );
      return;
    }
    respond(true, { suggestions: listTaskSuggestions(params) }, undefined);
  },
  "taskSuggestions.create": ({ params, respond, context }) => {
    if (!validateTaskSuggestionsCreateParams(params)) {
      respond(
        false,
        undefined,
        invalidParams("taskSuggestions.create", validateTaskSuggestionsCreateParams.errors),
      );
      return;
    }
    if (!path.isAbsolute(params.cwd)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "task suggestion cwd must be absolute"),
      );
      return;
    }
    const sessionAgentId = parseAgentSessionKey(params.sessionKey)?.agentId;
    const requestedAgentId = params.agentId ? normalizeAgentId(params.agentId) : undefined;
    if (
      requestedAgentId &&
      sessionAgentId &&
      requestedAgentId !== normalizeAgentId(sessionAgentId)
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "task suggestion agentId must match its source session",
        ),
      );
      return;
    }
    const agentId = normalizeAgentId(
      requestedAgentId ?? sessionAgentId ?? resolveDefaultAgentId(context.getRuntimeConfig()),
    );
    const created = createTaskSuggestion({ ...params, agentId });
    if (created.status === "full") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "task suggestion registry is busy", {
          retryable: true,
        }),
      );
      return;
    }
    const { suggestion } = created;
    // The registry is ephemeral; live events keep open Control UI tabs in sync
    // without turning suggestions into durable task state.
    for (const taskId of created.evictedPendingTaskIds) {
      context.broadcast(
        "task.suggestion",
        { action: "resolved", taskId, resolution: "expired" },
        { dropIfSlow: true },
      );
    }
    context.broadcast("task.suggestion", { action: "created", suggestion }, { dropIfSlow: true });
    respond(true, { taskId: suggestion.id, suggestion }, undefined);
  },
  "taskSuggestions.accept": async (options) => {
    const { params, respond } = options;
    if (!validateTaskSuggestionsAcceptParams(params)) {
      respond(
        false,
        undefined,
        invalidParams("taskSuggestions.accept", validateTaskSuggestionsAcceptParams.errors),
      );
      return;
    }
    const active = activeAcceptances.get(params.taskId);
    if (active) {
      const outcome = await active;
      respond(
        outcome.ok,
        outcome.ok ? outcome.result : undefined,
        outcome.ok ? undefined : outcome.error,
      );
      return;
    }
    const acceptance = beginTaskSuggestionAcceptance(params.taskId);
    if (acceptance.status === "accepted") {
      respond(true, { taskId: params.taskId, key: acceptance.sessionKey }, undefined);
      return;
    }
    if (acceptance.status !== "claimed") {
      respond(
        false,
        undefined,
        errorShape(
          acceptance.status === "accepting" ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST,
          `task suggestion cannot be accepted: ${acceptance.status}`,
        ),
      );
      return;
    }
    const pending = createSuggestedTaskSession({
      taskId: params.taskId,
      suggestion: acceptance.suggestion,
      options,
    });
    activeAcceptances.set(params.taskId, pending);
    try {
      const outcome = await pending;
      respond(
        outcome.ok,
        outcome.ok ? outcome.result : undefined,
        outcome.ok ? undefined : outcome.error,
      );
    } finally {
      activeAcceptances.delete(params.taskId);
    }
  },
  "taskSuggestions.dismiss": ({ params, respond, context }) => {
    if (!validateTaskSuggestionsDismissParams(params)) {
      respond(
        false,
        undefined,
        invalidParams("taskSuggestions.dismiss", validateTaskSuggestionsDismissParams.errors),
      );
      return;
    }
    const dismissed = dismissTaskSuggestion(params.taskId);
    if (dismissed) {
      context.broadcast(
        "task.suggestion",
        { action: "resolved", taskId: params.taskId, resolution: "dismissed" },
        { dropIfSlow: true },
      );
    }
    respond(true, { taskId: params.taskId, dismissed }, undefined);
  },
};
