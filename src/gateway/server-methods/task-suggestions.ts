// Gateway methods for ephemeral model-proposed follow-up tasks.
import path from "node:path";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  type ErrorShape,
  type TaskSuggestion,
  type TaskSuggestionsAcceptParams,
  type TaskSuggestionsAcceptResult,
  validateTaskSuggestionsAcceptParams,
  validateTaskSuggestionsCreateParams,
  validateTaskSuggestionsDismissParams,
  validateTaskSuggestionsListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { insideGitCheckout } from "../../agents/worktrees/git.js";
import { resolveSessionWorkStartError } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { authorizeGatewaySessionCreation, hasOperatorBoundary } from "../operator-role-policy.js";
import { buildDashboardSessionKey } from "../session-create-service.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import {
  authorizeSessionSharingTarget,
  createSessionListEntryFilter,
  resolveSessionSharingTarget,
} from "../session-sharing.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import {
  abandonTaskSuggestionAcceptance,
  beginTaskSuggestionAcceptance,
  cancelTaskSuggestionAcceptance,
  completeTaskSuggestionAcceptance,
  createTaskSuggestion,
  dismissTaskSuggestion,
  getTaskSuggestion,
  listTaskSuggestions,
} from "../task-suggestion-registry.js";
import { handleChatSend } from "./chat-send-handler.js";
import { listWorkerProfiles } from "./environments.js";
import { sessionCreateHandlers } from "./sessions-create.js";
import { sessionDeleteHandlers } from "./sessions-delete.js";
import { sessionDispatchHandlers } from "./sessions-dispatch.js";
import type {
  GatewayClient,
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
  RespondFn,
} from "./types.js";

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

function broadcastResolvedTaskSuggestion(
  context: GatewayRequestHandlerOptions["context"],
  suggestion: Pick<TaskSuggestion, "id" | "sessionKey" | "agentId">,
  resolution: "accepted" | "dismissed" | "expired",
): void {
  context.broadcast(
    "task.suggestion",
    { action: "resolved", taskId: suggestion.id, resolution },
    {
      dropIfSlow: true,
      sessionKeys: [suggestion.sessionKey],
      ...(suggestion.agentId ? { agentId: suggestion.agentId } : {}),
    },
  );
}

function authorizeSuggestedTaskSource(params: {
  cfg: OpenClawConfig;
  client: GatewayClient | null;
  taskId: string;
}): { ok: true; agentId: string } | { ok: false; error: ErrorShape } {
  const suggestion = getTaskSuggestion(params.taskId);
  const target = suggestion
    ? resolveSessionSharingTarget({
        cfg: params.cfg,
        sessionKey: suggestion.sessionKey,
        agentId: suggestion.agentId,
      })
    : null;
  if (!target) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, "task suggestion was not found"),
    };
  }
  const error = authorizeSessionSharingTarget({ cfg: params.cfg, client: params.client, target });
  return error ? { ok: false, error } : { ok: true, agentId: target.agentId };
}

function abandonSuggestedTaskAcceptance(
  taskId: string,
  options: GatewayRequestHandlerOptions,
): void {
  const suggestion = getTaskSuggestion(taskId);
  if (suggestion && abandonTaskSuggestionAcceptance(taskId)) {
    broadcastResolvedTaskSuggestion(options.context, suggestion, "expired");
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
    return !loadGatewaySessionEntryReadOnly(params.key, { agentId: params.agentId }).entry;
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
  suggestion: TaskSuggestion;
  options: GatewayRequestHandlerOptions;
}): TaskSuggestionAcceptanceResult {
  completeTaskSuggestionAcceptance(params.taskId, params.sessionKey);
  broadcastResolvedTaskSuggestion(params.options.context, params.suggestion, "accepted");
  return { ok: true, result: { taskId: params.taskId, key: params.sessionKey } };
}

function restoreSuggestedTaskClaim(params: {
  taskId: string;
  options: GatewayRequestHandlerOptions;
  error: NonNullable<Parameters<RespondFn>[2]>;
}): TaskSuggestionAcceptanceResult {
  // Before session creation or after source-session delivery fails, only the
  // suggestion claim can be rolled back; never delete the source session.
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

async function sendSuggestedTaskPrompt(params: {
  taskId: string;
  suggestion: TaskSuggestion;
  options: GatewayRequestHandlerOptions;
  sessionKey: string;
  agentId: string;
  sessionId?: string;
}): Promise<Parameters<RespondFn> | undefined> {
  let response: Parameters<RespondFn> | undefined;
  const chatParams = {
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    message: params.suggestion.prompt,
    queueMode: "steer" as const,
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
  agentId: string;
  mode: Exclude<TaskSuggestionAcceptMode, "session">;
  cloudProfileId?: string;
}): Promise<TaskSuggestionAcceptanceResult> {
  let sessionResponse: Parameters<RespondFn> | undefined;
  const { agentId } = params;
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
      suggestion: params.suggestion,
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
    suggestion: params.suggestion,
    options: params.options,
  });
}

async function deliverSuggestedTaskToSourceSession(params: {
  taskId: string;
  suggestion: TaskSuggestion;
  options: GatewayRequestHandlerOptions;
  agentId: string;
}): Promise<TaskSuggestionAcceptanceResult> {
  const { agentId } = params;
  const fail = (error: NonNullable<Parameters<RespondFn>[2]>) =>
    restoreSuggestedTaskClaim({ taskId: params.taskId, options: params.options, error });
  let source: ReturnType<typeof loadGatewaySessionEntryReadOnly>;
  try {
    source = loadGatewaySessionEntryReadOnly(params.suggestion.sessionKey, { agentId });
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
  let sendResponse: Parameters<RespondFn> | undefined;
  try {
    sendResponse = await sendSuggestedTaskPrompt({
      taskId: params.taskId,
      suggestion: params.suggestion,
      options: params.options,
      sessionKey: params.suggestion.sessionKey,
      agentId,
      sessionId: source.entry.sessionId,
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
    suggestion: params.suggestion,
    options: params.options,
  });
}

export const taskSuggestionsHandlers: GatewayRequestHandlers = {
  "taskSuggestions.list": ({ params, respond, context, client }) => {
    if (!validateTaskSuggestionsListParams(params)) {
      respond(
        false,
        undefined,
        invalidParams("taskSuggestions.list", validateTaskSuggestionsListParams.errors),
      );
      return;
    }
    const requestedSessionKey = params.sessionKey;
    const sessionOwner = requestedSessionKey
      ? resolveRequestedSessionAgentId(
          context.getRuntimeConfig(),
          requestedSessionKey,
          params.agentId,
        )
      : undefined;
    if (sessionOwner && !sessionOwner.ok) {
      respond(false, undefined, sessionOwner.error);
      return;
    }
    const cfg = context.getRuntimeConfig();
    const visibilityFilter = hasOperatorBoundary(client, cfg)
      ? createSessionListEntryFilter({ client, cfg })
      : undefined;
    respond(
      true,
      {
        suggestions: listTaskSuggestions({
          ...params,
          ...(sessionOwner ? { agentId: sessionOwner.agentId } : {}),
        }).filter((suggestion) => {
          if (!visibilityFilter) {
            return true;
          }
          const target = resolveSessionSharingTarget({
            cfg,
            sessionKey: suggestion.sessionKey,
            agentId: suggestion.agentId,
          });
          return Boolean(target && visibilityFilter(target.storeKey, target.entry));
        }),
      },
      undefined,
    );
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
    const requestedAgentId = params.agentId ? normalizeAgentId(params.agentId) : undefined;
    const sourceOwner = resolveRequestedSessionAgentId(
      context.getRuntimeConfig(),
      params.sessionKey,
      requestedAgentId,
    );
    if (!sourceOwner.ok) {
      respond(false, undefined, sourceOwner.error);
      return;
    }
    const agentId = normalizeAgentId(sourceOwner.agentId);
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
    for (const evicted of created.evictedPendingSuggestions) {
      broadcastResolvedTaskSuggestion(context, evicted, "expired");
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
    const config = options.context.getRuntimeConfig();
    if (hasOperatorBoundary(options.client, config)) {
      const authorization = authorizeSuggestedTaskSource({
        cfg: config,
        client: options.client,
        taskId: params.taskId,
      });
      if (!authorization.ok) {
        respond(false, undefined, authorization.error);
        return;
      }
      if (mode !== "session") {
        const creationError = authorizeGatewaySessionCreation({
          cfg: config,
          client: options.client,
          agentId: authorization.agentId,
        });
        if (creationError) {
          respond(false, undefined, creationError);
          return;
        }
      }
    }
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
    const pending = (async () => {
      const sourceOwner = resolveRequestedSessionAgentId(
        config,
        acceptance.suggestion.sessionKey,
        acceptance.suggestion.agentId,
      );
      if (!sourceOwner.ok) {
        return restoreSuggestedTaskClaim({
          taskId: params.taskId,
          options,
          error: sourceOwner.error,
        });
      }
      const agentId = normalizeAgentId(sourceOwner.agentId);
      return mode === "session"
        ? deliverSuggestedTaskToSourceSession({
            taskId: params.taskId,
            suggestion: acceptance.suggestion,
            options,
            agentId,
          })
        : createSuggestedTaskSession({
            taskId: params.taskId,
            suggestion: acceptance.suggestion,
            options,
            agentId,
            mode,
            ...(cloudProfileId ? { cloudProfileId } : {}),
          });
    })().catch((error: unknown) => {
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
  "taskSuggestions.dismiss": ({ params, respond, context, client }) => {
    if (!validateTaskSuggestionsDismissParams(params)) {
      respond(
        false,
        undefined,
        invalidParams("taskSuggestions.dismiss", validateTaskSuggestionsDismissParams.errors),
      );
      return;
    }
    const config = context.getRuntimeConfig();
    if (hasOperatorBoundary(client, config)) {
      const authorization = authorizeSuggestedTaskSource({
        cfg: config,
        client,
        taskId: params.taskId,
      });
      if (!authorization.ok) {
        respond(true, { taskId: params.taskId, dismissed: false }, undefined);
        return;
      }
    }
    const suggestion = getTaskSuggestion(params.taskId);
    const dismissed = dismissTaskSuggestion(params.taskId);
    if (dismissed && suggestion) {
      broadcastResolvedTaskSuggestion(context, suggestion, "dismissed");
    }
    respond(true, { taskId: params.taskId, dismissed }, undefined);
  },
};
