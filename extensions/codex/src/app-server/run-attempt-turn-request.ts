import { embeddedAgentLog, formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  CODEX_APP_SERVER_INTERRUPT_TIMEOUT_MS,
  interruptCodexTurnBestEffort,
} from "./attempt-client-cleanup.js";
import {
  createCodexModelCallDiagnosticEmitter,
  utf8JsonByteLength,
} from "./attempt-diagnostics.js";
import { assertCodexTurnStartResponse } from "./protocol-validators.js";
import type { CodexTurnStartResponse } from "./protocol.js";
import { readCodexRateLimitsRevision } from "./rate-limit-cache.js";
import {
  emitCodexAppServerEvent,
  withCodexAppServerFastModeServiceTier,
} from "./run-attempt-lifecycle.js";
import type { CodexAttemptResources } from "./run-attempt-resources.js";
import type { CodexAttemptTurnState } from "./run-attempt-turn-state.js";
import { buildTurnStartParams } from "./thread-lifecycle.js";
import { buildCodexUserPromptMessage } from "./transcript-mirror.js";

export async function prepareCodexAttemptTurnRequest(
  resources: CodexAttemptResources,
  turnRuntime: CodexAttemptTurnState,
  ensureCurrentThreadRoute: () => Promise<unknown>,
  waitForActiveNativeTurnCompletion: () => Promise<boolean>,
) {
  const { prompt, state: resourceState, releaseCurrentRoute } = resources;
  const { context, turnState, buildRenderedCodexDeveloperInstructions } = prompt;
  const { runtime, attemptTools, hookContextWindowFields, workspaceBootstrapContext } = context;
  const { connection, runtimeParams, effectiveRuntimeProviderId, effectiveRuntimeModelId } =
    runtime;
  const { tools } = attemptTools;
  const {
    params,
    usesSupervisionConnection,
    codexModelCallId,
    codexModelCallTrace,
    codexModelContentCapture,
    appServer,
    runAbortController,
  } = connection;
  const { state } = turnRuntime;
  const buildCodexModelInputMessages = () => [
    ...prompt.codexModelInputHistoryMessages,
    buildCodexUserPromptMessage({ ...runtimeParams, prompt: turnState.codexTurnPromptText }),
  ];
  const codexModelCallDiagnostics = createCodexModelCallDiagnosticEmitter({
    baseFields: {
      runId: params.runId,
      callId: codexModelCallId,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      sessionId: params.sessionId,
      provider: usesSupervisionConnection
        ? (resourceState.thread.modelProvider ?? effectiveRuntimeProviderId)
        : params.provider,
      model: usesSupervisionConnection
        ? (resourceState.thread.model ?? effectiveRuntimeModelId)
        : params.modelId,
      api: usesSupervisionConnection ? runtimeParams.model.api : params.model.api,
      transport: appServer.start.transport,
      observationUnit: "turn",
      ...hookContextWindowFields,
      trace: codexModelCallTrace,
    },
    capture: codexModelContentCapture,
    tools,
    buildInputMessages: buildCodexModelInputMessages,
    buildSystemPrompt: buildRenderedCodexDeveloperInstructions,
    onErrorDiagnostic: (error) => {
      embeddedAgentLog.debug("codex app-server model call diagnostic ended with error", {
        error: formatErrorMessage(error),
      });
    },
  });
  const throwIfTurnStartAcceptedAfterAbort = () => {
    if (!runAbortController.signal.aborted) {
      return;
    }
    const reason = runAbortController.signal.reason;
    if (reason instanceof Error) {
      throw reason;
    }
    const error = new Error(
      typeof reason === "string" && reason.length > 0
        ? reason
        : "codex app-server turn start aborted before acceptance",
    );
    error.name = "AbortError";
    throw error;
  };
  const startCodexTurn = async (): Promise<CodexTurnStartResponse> => {
    const activeTurnRoute = (await ensureCurrentThreadRoute()) as {
      armTurn(): void;
      cancelTurn(): Promise<void>;
    };
    const turnAppServer = withCodexAppServerFastModeServiceTier(
      connection.mutable.pluginAppServer,
      runtimeParams,
    );
    connection.mutable.pluginAppServer = turnAppServer;
    const turnStartParams = buildTurnStartParams(runtimeParams, {
      threadId: resourceState.thread.threadId,
      cwd: resourceState.codexExecutionCwd,
      appServer: turnAppServer,
      promptText: turnState.codexTurnPromptText,
      sandboxPolicy: resourceState.codexSandboxPolicy,
      environmentSelection: resourceState.codexEnvironmentSelection,
      ...(usesSupervisionConnection
        ? {}
        : { model: resourceState.thread.model, modelProvider: resourceState.thread.modelProvider }),
      turnScopedDeveloperInstructions: workspaceBootstrapContext.turnScopedDeveloperInstructions,
      skillsCollaborationInstructions: context.skillsCollaborationInstructions,
      memoryCollaborationInstructions: workspaceBootstrapContext.memoryCollaborationInstructions,
      heartbeatCollaborationInstructions:
        workspaceBootstrapContext.heartbeatCollaborationInstructions,
      preserveNativeTurnSettings: usesSupervisionConnection,
    });
    codexModelCallDiagnostics.setRequestPayloadBytes(utf8JsonByteLength(turnStartParams));
    state.latestStartupErrorNotification = undefined;
    state.rateLimitsRevisionBeforeLastTurnStart = readCodexRateLimitsRevision(resourceState.client);
    activeTurnRoute.armTurn();
    void emitCodexAppServerEvent(params, {
      stream: "codex_app_server.lifecycle",
      data: {
        phase: "turn_starting",
        threadId: resourceState.thread.threadId,
        model: turnStartParams.model,
        effort: turnStartParams.effort,
        collaborationEffort: turnStartParams.collaborationMode?.settings.reasoning_effort,
      },
    });
    let acceptedTurnId: string | undefined;
    try {
      const startedTurn = assertCodexTurnStartResponse(
        await resourceState.client.request("turn/start", turnStartParams, {
          timeoutMs: params.timeoutMs,
          signal: runAbortController.signal,
        }),
      );
      acceptedTurnId = startedTurn.turn.id;
      throwIfTurnStartAcceptedAfterAbort();
      return startedTurn;
    } catch (error) {
      if (acceptedTurnId) {
        interruptCodexTurnBestEffort(resourceState.client, {
          threadId: resourceState.thread.threadId,
          turnId: acceptedTurnId,
          timeoutMs: CODEX_APP_SERVER_INTERRUPT_TIMEOUT_MS,
        });
        releaseCurrentRoute();
      } else {
        await activeTurnRoute.cancelTurn();
      }
      throw error;
    }
  };
  if (
    resourceState.thread.lifecycle.action === "resumed" &&
    (resourceState.thread.lifecycle.activeTurnIds?.length ?? 0) > 0
  ) {
    embeddedAgentLog.info(
      "codex app-server resumed thread has active native turn; waiting before turn/start",
      { threadId: resourceState.thread.threadId },
    );
    void emitCodexAppServerEvent(params, {
      stream: "codex_app_server.lifecycle",
      data: {
        phase: "turn_start_waiting_for_native_turn",
        threadId: resourceState.thread.threadId,
      },
    });
    const nativeTurnCompleted = await waitForActiveNativeTurnCompletion();
    if (nativeTurnCompleted) {
      await resourceState.turnRoute?.drain();
    } else if (!runAbortController.signal.aborted) {
      embeddedAgentLog.warn(
        "codex app-server active native turn did not complete before turn/start wait timed out",
        { threadId: resourceState.thread.threadId },
      );
    }
  }
  const buildLlmInputEvent = () => ({
    runId: params.runId,
    sessionId: params.sessionId,
    provider: usesSupervisionConnection
      ? (resourceState.thread.modelProvider ?? effectiveRuntimeProviderId)
      : params.provider,
    model: usesSupervisionConnection
      ? (resourceState.thread.model ?? effectiveRuntimeModelId)
      : params.modelId,
    systemPrompt: buildRenderedCodexDeveloperInstructions(),
    prompt: turnState.codexTurnPromptText,
    historyMessages: prompt.codexModelInputHistoryMessages,
    imagesCount: params.images?.length ?? 0,
    tools,
  });
  return { codexModelCallDiagnostics, startCodexTurn, buildLlmInputEvent };
}
