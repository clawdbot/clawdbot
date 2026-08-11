// Gateway methods for ephemeral model-proposed follow-up tasks.
import path from "node:path";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  type TaskSuggestion,
  type TaskSuggestionsAcceptParams,
  type TaskSuggestionsAcceptResult,
  validateTaskSuggestionsAcceptParams,
  validateTaskSuggestionsCreateParams,
  validateTaskSuggestionsDismissParams,
  validateTaskSuggestionsListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { insideGitCheckout } from "../../agents/worktrees/git.js";
import { resolveSessionWorkStartError } from "../../config/sessions.js";
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
import { handleChatSend } from "./chat-send-handler.js";
import { listWorkerProfiles } from "./environments.js";
import { resolveVisibleActiveSessionRunState } from "./session-active-runs.js";
import { sessionCreateHandlers } from "./sessions-create.js";
import { sessionDeleteHandlers } from "./sessions-delete.js";
import { sessionDispatchHandlers } from "./sessions-dispatch.js";
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

type TaskSuggestionAcceptMode = NonNullable<TaskSuggestionsAcceptParams["mode"]>;

const activeAcceptances = new Map<string, Promise<TaskSuggestionAcceptanceResult>>();

function abandonSuggestedTaskAcceptance(
  taskId: string,
  options: GatewayRequestHandlerOptions,
): void {
  if (abandonTaskSuggestionAcceptance(taskId)) {
    options.context.broadcast(
      "task.suggestion",
      { action: "resolved", taskId, resolution: "expired" },
      { dropIfSlow: true },
    );
  }
}

async function rollbackSuggestedTaskSession(params: {
  key: string;
  agentId?: string;
  options: GatewayRequestHandlerOptions;
}): Promise<boolean> {
  let deletionResponse: { ok: true; worktreePreserved: boolean } | { ok: false } | undefined;
  try {
    const deleteSession = sessionDeleteHandlers["sessions.delete"];
    if (!deleteSession) {
      return false;
    }
    await deleteSession({
      ...params.options,
      params: {
        key: params.key,
        ...(params.agentId ? { agentId: params.agentId } : {}),
        deleteTranscript: true,
        emitLifecycleHooks: false,
      },
      respond: (ok, payload) => {
        if (
          !ok ||
          !payload ||
          typeof payload !== "object" ||
          typeof (payload as { deleted?: unknown }).deleted !== "boolean"
        ) {
          deletionResponse = { ok: false };
          return;
        }
        deletionResponse = {
          ok: true,
          worktreePreserved:
            (payload as { worktreePreserved?: unknown }).worktreePreserved !== undefined,
        };
      },
    });
  } catch {
    return false;
  }
  if (!deletionResponse?.ok || deletionResponse.worktreePreserved) {
    return false;
  }
  try {
    return !loadSessionEntryReadOnly(params.key, { agentId: params.agentId }).entry;
  } catch {
    return false;
  }
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
  abandonSuggestedTaskAcceptance(params.taskId, params.options);
  return {
    ok: false,
    error: errorShape(
      ErrorCodes.UNAVAILABLE,
      `${params.error.message}; failed to roll back the partial suggested task session`,
    ),
  };
}

function finishSuggestedTaskAcceptance(params: {
  taskId: string;
  sessionKey: string;
  options: GatewayRequestHandlerOptions;
}): TaskSuggestionAcceptanceResult {
  completeTaskSuggestionAcceptance(params.taskId, params.sessionKey);
  params.options.context.broadcast(
    "task.suggestion",
    { action: "resolved", taskId: params.taskId, resolution: "accepted" },
    { dropIfSlow: true },
  );
  return { ok: true, result: { taskId: params.taskId, key: params.sessionKey } };
}

function failSuggestedTaskDelivery(params: {
  taskId: string;
  options: GatewayRequestHandlerOptions;
  error: NonNullable<Parameters<RespondFn>[2]>;
}): TaskSuggestionAcceptanceResult {
  // Session-mode delivery owns only the registry claim. Never roll back the
  // operator-owned source session or its worktree when message delivery fails.
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

function resolveSuggestionAgentId(
  suggestion: TaskSuggestion,
  options: GatewayRequestHandlerOptions,
): string {
  return normalizeAgentId(
    suggestion.agentId ??
      parseAgentSessionKey(suggestion.sessionKey)?.agentId ??
      resolveDefaultAgentId(options.context.getRuntimeConfig()),
  );
}

async function sendSuggestedTaskPrompt(params: {
  taskId: string;
  suggestion: TaskSuggestion;
  options: GatewayRequestHandlerOptions;
  sessionKey: string;
  agentId: string;
  sessionId?: string;
  activeRunId?: string;
}): Promise<Parameters<RespondFn> | undefined> {
  let response: Parameters<RespondFn> | undefined;
  const chatParams = {
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    message: params.suggestion.prompt,
    ...(params.activeRunId
      ? { queueMode: "steer" as const, expectedRunId: params.activeRunId }
      : {}),
    idempotencyKey: `task-suggestion:${params.taskId}`,
  };
  await handleChatSend({
    ...params.options,
    req: { ...params.options.req, method: "chat.send", params: chatParams },
    params: chatParams,
    respond: (...args) => {
      response = args;
    },
  });
  return response;
}

async function createSuggestedTaskSession(params: {
  taskId: string;
  suggestion: TaskSuggestion;
  options: GatewayRequestHandlerOptions;
  mode: Exclude<TaskSuggestionAcceptMode, "session">;
  cloudProfileId?: string;
}): Promise<TaskSuggestionAcceptanceResult> {
  let sessionResponse: Parameters<RespondFn> | undefined;
  const agentId = resolveSuggestionAgentId(params.suggestion, params.options);
  const sessionKey = buildDashboardSessionKey(agentId);
  const fail = (key: string, error: NonNullable<Parameters<RespondFn>[2]>) =>
    failSuggestedTaskSession({
      taskId: params.taskId,
      sessionKey: key,
      agentId,
      options: params.options,
      error,
    });
  try {
    await sessionCreateHandlers["sessions.create"]?.({
      ...params.options,
      params: {
        key: sessionKey,
        agentId,
        parentSessionKey: params.suggestion.sessionKey,
        label: params.suggestion.title,
        ...(params.mode === "cloud" ? {} : { task: params.suggestion.prompt }),
        ...(params.mode === "local" ? {} : { worktree: true }),
        cwd: params.suggestion.cwd,
      },
      respond: (...args) => {
        sessionResponse = args;
      },
    });
  } catch (error) {
    return await fail(sessionKey, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
  }
  if (!sessionResponse) {
    return await fail(
      sessionKey,
      errorShape(ErrorCodes.UNAVAILABLE, "sessions.create did not respond"),
    );
  }
  const [ok, payload, sessionError] = sessionResponse;
  if (!ok) {
    return await fail(
      sessionKey,
      sessionError ?? errorShape(ErrorCodes.UNAVAILABLE, "failed to create suggested task"),
    );
  }
  const key =
    payload && typeof payload === "object" && typeof (payload as { key?: unknown }).key === "string"
      ? (payload as { key: string }).key
      : undefined;
  if (!key) {
    return await fail(
      sessionKey,
      errorShape(ErrorCodes.UNAVAILABLE, "sessions.create returned no session key"),
    );
  }
  if (params.mode === "cloud") {
    let dispatchResponse: Parameters<RespondFn> | undefined;
    try {
      await sessionDispatchHandlers["sessions.dispatch"]?.({
        ...params.options,
        params: { key, agentId, profileId: params.cloudProfileId },
        respond: (...args) => {
          dispatchResponse = args;
        },
      });
    } catch (error) {
      return await fail(key, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
    }
    if (!dispatchResponse?.[0]) {
      return await fail(
        key,
        dispatchResponse?.[2] ??
          errorShape(
            ErrorCodes.UNAVAILABLE,
            dispatchResponse
              ? "failed to dispatch suggested task"
              : "sessions.dispatch did not respond",
          ),
      );
    }
    let sendResponse: Parameters<RespondFn> | undefined;
    try {
      sendResponse = await sendSuggestedTaskPrompt({
        taskId: params.taskId,
        suggestion: params.suggestion,
        options: params.options,
        sessionKey: key,
        agentId,
      });
    } catch (error) {
      return await fail(key, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
    }
    if (!sendResponse?.[0]) {
      return await fail(
        key,
        sendResponse?.[2] ??
          errorShape(
            ErrorCodes.UNAVAILABLE,
            sendResponse ? "failed to deliver suggested task" : "chat.send did not respond",
          ),
      );
    }
    return finishSuggestedTaskAcceptance({
      taskId: params.taskId,
      sessionKey: key,
      options: params.options,
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
    return await fail(key, errorShape(ErrorCodes.UNAVAILABLE, runMessage));
  }
  return finishSuggestedTaskAcceptance({
    taskId: params.taskId,
    sessionKey: key,
    options: params.options,
  });
}

async function deliverSuggestedTaskToSourceSession(params: {
  taskId: string;
  suggestion: TaskSuggestion;
  options: GatewayRequestHandlerOptions;
}): Promise<TaskSuggestionAcceptanceResult> {
  const agentId = resolveSuggestionAgentId(params.suggestion, params.options);
  const fail = (error: NonNullable<Parameters<RespondFn>[2]>) =>
    failSuggestedTaskDelivery({ taskId: params.taskId, options: params.options, error });
  let source: ReturnType<typeof loadSessionEntryReadOnly>;
  try {
    source = loadSessionEntryReadOnly(params.suggestion.sessionKey, { agentId });
  } catch (error) {
    return fail(errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
  }
  if (!source.entry?.sessionId) {
    return fail(
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "source session no longer exists; start it in a worktree instead",
      ),
    );
  }
  const lifecycleError = resolveSessionWorkStartError(source.canonicalKey, source.entry);
  if (lifecycleError) {
    return fail(errorShape(ErrorCodes.INVALID_REQUEST, lifecycleError));
  }
  let activeRunState: ReturnType<typeof resolveVisibleActiveSessionRunState>;
  try {
    activeRunState = resolveVisibleActiveSessionRunState({
      context: params.options.context,
      requestedKey: params.suggestion.sessionKey,
      canonicalKey: source.canonicalKey,
      sessionId: source.entry.sessionId,
      agentId,
    });
  } catch (error) {
    return fail(errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
  }
  if (activeRunState.active && activeRunState.runIds.length !== 1) {
    const message =
      activeRunState.runIds.length === 0
        ? "active session run has no exact dispatch identity; refresh and retry"
        : "session has multiple active runs; choose the target run before accepting the task suggestion";
    return fail(
      errorShape(ErrorCodes.INVALID_REQUEST, message, {
        retryable: false,
        details: {
          code: "SESSION_SUGGESTION_ACTIVE_RUN_AMBIGUOUS",
          sessionKey: params.suggestion.sessionKey,
        },
      }),
    );
  }
  let sendResponse: Parameters<RespondFn> | undefined;
  try {
    sendResponse = await sendSuggestedTaskPrompt({
      taskId: params.taskId,
      suggestion: params.suggestion,
      options: params.options,
      sessionKey: params.suggestion.sessionKey,
      agentId,
      sessionId: source.entry.sessionId,
      activeRunId: activeRunState.runIds[0],
    });
  } catch (error) {
    return fail(errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
  }
  if (!sendResponse?.[0]) {
    return fail(
      sendResponse?.[2] ??
        errorShape(
          ErrorCodes.UNAVAILABLE,
          sendResponse ? "failed to deliver suggested task" : "chat.send did not respond",
        ),
    );
  }
  return finishSuggestedTaskAcceptance({
    taskId: params.taskId,
    sessionKey: params.suggestion.sessionKey,
    options: params.options,
  });
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
    if (!insideGitCheckout(params.cwd)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "task suggestion cwd must be inside a git checkout"),
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
    const mode = params.mode ?? "worktree";
    let cloudProfileId: string | undefined;
    if (mode === "cloud") {
      const profiles = listWorkerProfiles(options.context);
      if (profiles.length === 0) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "no cloud worker profiles configured"),
        );
        return;
      }
      cloudProfileId = params.cloudProfileId;
      if (!cloudProfileId || !profiles.some((profile) => profile.id === cloudProfileId)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            cloudProfileId
              ? `unknown cloud worker profile: ${cloudProfileId}`
              : "cloudProfileId is required for cloud mode",
          ),
        );
        return;
      }
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
    const pending = (
      mode === "session"
        ? deliverSuggestedTaskToSourceSession({
            taskId: params.taskId,
            suggestion: acceptance.suggestion,
            options,
          })
        : createSuggestedTaskSession({
            taskId: params.taskId,
            suggestion: acceptance.suggestion,
            options,
            mode,
            ...(cloudProfileId ? { cloudProfileId } : {}),
          })
    ).catch((error: unknown) => {
      abandonSuggestedTaskAcceptance(params.taskId, options);
      throw error;
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
