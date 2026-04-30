import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import {
  assembleHarnessContextEngine,
  bootstrapHarnessContextEngine,
  buildHarnessContextEngineRuntimeContext,
  buildHarnessContextEngineRuntimeContextFromUsage,
  buildEmbeddedAttemptToolRunContext,
  clearActiveEmbeddedRun,
  embeddedAgentLog,
  emitAgentEvent as emitGlobalAgentEvent,
  finalizeHarnessContextEngineTurn,
  formatErrorMessage,
  isActiveHarnessContextEngine,
  isSubagentSessionKey,
  normalizeAgentRuntimeTools,
  resolveAttemptSpawnWorkspaceDir,
  resolveAgentHarnessBeforePromptBuildResult,
  resolveModelAuthMode,
  resolveOpenClawAgentDir,
  resolveSandboxContext,
  resolveSessionAgentIds,
  resolveUserPath,
  runAgentHarnessAgentEndHook,
  runAgentHarnessLlmInputHook,
  runAgentHarnessLlmOutputHook,
  runHarnessContextEngineMaintenance,
  registerNativeHookRelay,
  setActiveEmbeddedRun,
  supportsModelTools,
  runAgentCleanupStep,
  type AgentMessage,
  type EmbeddedRunAttemptParams,
  type EmbeddedRunAttemptResult,
  type NativeHookRelayEvent,
  type NativeHookRelayRegistrationHandle,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { handleCodexAppServerApprovalRequest } from "./approval-bridge.js";
import { refreshCodexAppServerAuthTokens } from "./auth-bridge.js";
import {
  createCodexAppServerClientFactoryTestHooks,
  defaultCodexAppServerClientFactory,
} from "./client-factory.js";
import { isCodexAppServerApprovalRequest, type CodexAppServerClient } from "./client.js";
import { ensureCodexComputerUse } from "./computer-use.js";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import { projectContextEngineAssemblyForCodex } from "./context-engine-projection.js";
import { createCodexDynamicToolBridge, type CodexDynamicToolBridge } from "./dynamic-tools.js";
import { handleCodexAppServerElicitationRequest } from "./elicitation-bridge.js";
import { CodexAppServerEventProjector } from "./event-projector.js";
import {
  buildCodexNativeHookRelayDisabledConfig,
  buildCodexNativeHookRelayConfig,
  CODEX_NATIVE_HOOK_RELAY_EVENTS,
} from "./native-hook-relay.js";
import {
  assertCodexTurnStartResponse,
  readCodexDynamicToolCallParams,
} from "./protocol-validators.js";
import {
  type CodexUserInput,
  isJsonObject,
  type CodexServerNotification,
  type CodexDynamicToolCallParams,
  type CodexDynamicToolCallResponse,
  type CodexTurnStartResponse,
  type JsonObject,
  type JsonValue,
} from "./protocol.js";
import { readCodexAppServerBinding, type CodexAppServerThreadBinding } from "./session-binding.js";
import { clearSharedCodexAppServerClient } from "./shared-client.js";
import {
  buildDeveloperInstructions,
  buildTurnStartParams,
  startOrResumeThread,
} from "./thread-lifecycle.js";
import {
  createCodexTrajectoryRecorder,
  normalizeCodexTrajectoryError,
  recordCodexTrajectoryCompletion,
  recordCodexTrajectoryContext,
} from "./trajectory.js";
import { mirrorCodexAppServerTranscript } from "./transcript-mirror.js";
import { createCodexUserInputBridge } from "./user-input-bridge.js";
import { filterToolsForVisionInputs } from "./vision-tools.js";

const CODEX_DYNAMIC_TOOL_TIMEOUT_MS = 30_000;
const CODEX_TURN_COMPLETION_IDLE_TIMEOUT_MS = 60_000;
const CODEX_STEER_ALL_DEBOUNCE_MS = 500;

type OpenClawCodingToolsOptions = NonNullable<
  Parameters<(typeof import("openclaw/plugin-sdk/agent-harness"))["createOpenClawCodingTools"]>[0]
>;

let clientFactory = defaultCodexAppServerClientFactory;

function emitCodexAppServerEvent(
  params: EmbeddedRunAttemptParams,
  event: Parameters<NonNullable<EmbeddedRunAttemptParams["onAgentEvent"]>>[0],
): void {
  try {
    emitGlobalAgentEvent({
      runId: params.runId,
      stream: event.stream,
      data: event.data,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    });
  } catch (error) {
    embeddedAgentLog.debug("codex app-server global agent event emit failed", { error });
  }
  try {
    const maybePromise = params.onAgentEvent?.(event);
    void Promise.resolve(maybePromise).catch((error: unknown) => {
      embeddedAgentLog.debug("codex app-server agent event handler rejected", { error });
    });
  } catch (error) {
    // Event consumers are observational; they must not abort or strand the
    // canonical app-server turn lifecycle.
    embeddedAgentLog.debug("codex app-server agent event handler threw", { error });
  }
}

function collectTerminalAssistantText(result: EmbeddedRunAttemptResult): string {
  return result.assistantTexts.join("\n\n").trim();
}

type CodexSteeringQueueOptions = {
  steeringMode?: "all" | "one-at-a-time";
  debounceMs?: number;
};

function createCodexSteeringQueue(params: {
  client: CodexAppServerClient;
  threadId: string;
  turnId: string;
  answerPendingUserInput: (text: string) => boolean;
  signal: AbortSignal;
}) {
  let batchedTexts: string[] = [];
  let batchTimer: NodeJS.Timeout | undefined;
  let sendChain: Promise<void> = Promise.resolve();

  const clearBatchTimer = () => {
    if (batchTimer) {
      clearTimeout(batchTimer);
      batchTimer = undefined;
    }
  };

  const sendTexts = async (texts: string[]) => {
    if (texts.length === 0 || params.signal.aborted) {
      return;
    }
    await params.client.request("turn/steer", {
      threadId: params.threadId,
      expectedTurnId: params.turnId,
      input: texts.map(toCodexTextInput),
    });
  };

  const enqueueSend = (texts: string[]) => {
    sendChain = sendChain
      .then(() => sendTexts(texts))
      .catch((error: unknown) => {
        embeddedAgentLog.debug("codex app-server queued steer failed", { error });
      });
    return sendChain;
  };

  const flushBatch = () => {
    clearBatchTimer();
    const texts = batchedTexts;
    batchedTexts = [];
    return enqueueSend(texts);
  };

  return {
    async queue(text: string, options?: CodexSteeringQueueOptions) {
      if (params.answerPendingUserInput(text)) {
        return;
      }
      if (options?.steeringMode === "one-at-a-time") {
        await flushBatch();
        await enqueueSend([text]);
        return;
      }
      batchedTexts.push(text);
      clearBatchTimer();
      const debounceMs = normalizeCodexSteerDebounceMs(options?.debounceMs);
      batchTimer = setTimeout(() => {
        batchTimer = undefined;
        void flushBatch();
      }, debounceMs);
    },
    async flushPending() {
      await flushBatch();
    },
    cancel() {
      clearBatchTimer();
      batchedTexts = [];
    },
  };
}

function normalizeCodexSteerDebounceMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : CODEX_STEER_ALL_DEBOUNCE_MS;
}

function toCodexTextInput(text: string): CodexUserInput {
  return { type: "text", text, text_elements: [] };
}

export async function runCodexAppServerAttempt(
  params: EmbeddedRunAttemptParams,
  options: {
    pluginConfig?: unknown;
    startupTimeoutFloorMs?: number;
    nativeHookRelay?: {
      enabled?: boolean;
      events?: readonly NativeHookRelayEvent[];
      ttlMs?: number;
      gatewayTimeoutMs?: number;
      hookTimeoutSec?: number;
    };
    turnCompletionIdleTimeoutMs?: number;
  } = {},
): Promise<EmbeddedRunAttemptResult> {
  const attemptStartedAt = Date.now();
  const appServer = resolveCodexAppServerRuntimeOptions({ pluginConfig: options.pluginConfig });
  const resolvedWorkspace = resolveUserPath(params.workspaceDir);
  await fs.mkdir(resolvedWorkspace, { recursive: true });
  const sandboxSessionKey = params.sessionKey?.trim() || params.sessionId;
  const sandbox = await resolveSandboxContext({
    config: params.config,
    sessionKey: sandboxSessionKey,
    workspaceDir: resolvedWorkspace,
  });
  const effectiveWorkspace = sandbox?.enabled
    ? sandbox.workspaceAccess === "rw"
      ? resolvedWorkspace
      : sandbox.workspaceDir
    : resolvedWorkspace;
  await fs.mkdir(effectiveWorkspace, { recursive: true });

  const runAbortController = new AbortController();
  const abortFromUpstream = () => {
    runAbortController.abort(params.abortSignal?.reason ?? "upstream_abort");
  };
  if (params.abortSignal?.aborted) {
    abortFromUpstream();
  } else {
    params.abortSignal?.addEventListener("abort", abortFromUpstream, { once: true });
  }

  const { sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
    agentId: params.agentId,
  });
  const agentDir = params.agentDir ?? resolveOpenClawAgentDir();
  const runtimeParams = { ...params, sessionKey: sandboxSessionKey };
  const activeContextEngine = isActiveHarnessContextEngine(params.contextEngine)
    ? params.contextEngine
    : undefined;
  let yieldDetected = false;
  const startupBinding = await readCodexAppServerBinding(params.sessionFile);
  const startupAuthProfileId =
    params.runtimePlan?.auth.forwardedAuthProfileId ??
    params.authProfileId ??
    startupBinding?.authProfileId;
  const tools = await buildDynamicTools({
    params,
    resolvedWorkspace,
    effectiveWorkspace,
    sandboxSessionKey,
    sandbox,
    runAbortController,
    sessionAgentId,
    onYieldDetected: () => {
      yieldDetected = true;
    },
  });
  const toolBridge = createCodexDynamicToolBridge({
    tools,
    signal: runAbortController.signal,
    hookContext: {
      agentId: sessionAgentId,
      sessionId: params.sessionId,
      sessionKey: sandboxSessionKey,
      runId: params.runId,
    },
  });
  const hadSessionFile = await fileExists(params.sessionFile);
  const sessionManager = SessionManager.open(params.sessionFile);
  let historyMessages =
    readMirroredSessionHistoryMessages(params.sessionFile, sessionManager) ?? [];
  const hookContext = {
    runId: params.runId,
    agentId: sessionAgentId,
    sessionKey: sandboxSessionKey,
    sessionId: params.sessionId,
    workspaceDir: params.workspaceDir,
    messageProvider: params.messageProvider ?? undefined,
    trigger: params.trigger,
    channelId: params.messageChannel ?? params.messageProvider ?? undefined,
  };
  if (activeContextEngine) {
    await bootstrapHarnessContextEngine({
      hadSessionFile,
      contextEngine: activeContextEngine,
      sessionId: params.sessionId,
      sessionKey: sandboxSessionKey,
      sessionFile: params.sessionFile,
      sessionManager,
      runtimeContext: buildHarnessContextEngineRuntimeContext({
        attempt: runtimeParams,
        workspaceDir: effectiveWorkspace,
        agentDir,
        tokenBudget: params.contextTokenBudget,
      }),
      runMaintenance: runHarnessContextEngineMaintenance,
      warn: (message) => embeddedAgentLog.warn(message),
    });
    historyMessages = readMirroredSessionHistoryMessages(params.sessionFile) ?? historyMessages;
  }
  const baseDeveloperInstructions = buildDeveloperInstructions(params);
  let promptText = params.prompt;
  let developerInstructions = baseDeveloperInstructions;
  let prePromptMessageCount = historyMessages.length;
  if (activeContextEngine) {
    try {
      const assembled = await assembleHarnessContextEngine({
        contextEngine: activeContextEngine,
        sessionId: params.sessionId,
        sessionKey: sandboxSessionKey,
        messages: historyMessages,
        tokenBudget: params.contextTokenBudget,
        availableTools: new Set(toolBridge.specs.map((tool) => tool.name).filter(isNonEmptyString)),
        citationsMode: params.config?.memory?.citations,
        modelId: params.modelId,
        prompt: params.prompt,
      });
      if (!assembled) {
        throw new Error("context engine assemble returned no result");
      }
      const projection = projectContextEngineAssemblyForCodex({
        assembledMessages: assembled.messages,
        originalHistoryMessages: historyMessages,
        prompt: params.prompt,
        systemPromptAddition: assembled.systemPromptAddition,
      });
      promptText = projection.promptText;
      developerInstructions = joinPresentSections(
        baseDeveloperInstructions,
        projection.developerInstructionAddition,
      );
      prePromptMessageCount = projection.prePromptMessageCount;
    } catch (assembleErr) {
      embeddedAgentLog.warn("context engine assemble failed; using Codex baseline prompt", {
        error: formatErrorMessage(assembleErr),
      });
    }
  }
  const promptBuild = await resolveAgentHarnessBeforePromptBuildResult({
    prompt: promptText,
    developerInstructions,
    messages: historyMessages,
    ctx: hookContext,
  });
  const trajectoryRecorder = createCodexTrajectoryRecorder({
    attempt: params,
    cwd: effectiveWorkspace,
    developerInstructions: promptBuild.developerInstructions,
    prompt: promptBuild.prompt,
    tools: toolBridge.specs,
  });
  let client: CodexAppServerClient;
  let thread: CodexAppServerThreadBinding;
  let trajectoryEndRecorded = false;
  let nativeHookRelay: NativeHookRelayRegistrationHandle | undefined;
  try {
    emitCodexAppServerEvent(params, {
      stream: "codex_app_server.lifecycle",
      data: { phase: "startup" },
    });
    nativeHookRelay = createCodexNativeHookRelay({
      options: options.nativeHookRelay,
      agentId: sessionAgentId,
      sessionId: params.sessionId,
      sessionKey: sandboxSessionKey,
      runId: params.runId,
      signal: runAbortController.signal,
    });
    const nativeHookRelayConfig = nativeHookRelay
      ? buildCodexNativeHookRelayConfig({
          relay: nativeHookRelay,
          events: options.nativeHookRelay?.events,
          hookTimeoutSec: options.nativeHookRelay?.hookTimeoutSec,
        })
      : options.nativeHookRelay?.enabled === false
        ? buildCodexNativeHookRelayDisabledConfig()
        : undefined;
    ({ client, thread } = await withCodexStartupTimeout({
      timeoutMs: params.timeoutMs,
      timeoutFloorMs: options.startupTimeoutFloorMs,
      signal: runAbortController.signal,
      operation: async () => {
        const startupClient = await clientFactory(appServer.start, startupAuthProfileId, agentDir);
        await ensureCodexComputerUse({
          client: startupClient,
          pluginConfig: options.pluginConfig,
          timeoutMs: appServer.requestTimeoutMs,
          signal: runAbortController.signal,
        });
        const startupThread = await startOrResumeThread({
          client: startupClient,
          params,
          cwd: effectiveWorkspace,
          dynamicTools: toolBridge.specs,
          appServer,
          developerInstructions: promptBuild.developerInstructions,
          config: nativeHookRelayConfig,
        });
        return { client: startupClient, thread: startupThread };
      },
    }));
    emitCodexAppServerEvent(params, {
      stream: "codex_app_server.lifecycle",
      data: { phase: "thread_ready", threadId: thread.threadId },
    });
  } catch (error) {
    nativeHookRelay?.unregister();
    clearSharedCodexAppServerClient();
    params.abortSignal?.removeEventListener("abort", abortFromUpstream);
    throw error;
  }
  trajectoryRecorder?.recordEvent("session.started", {
    sessionFile: params.sessionFile,
    threadId: thread.threadId,
    authProfileId: startupAuthProfileId,
    workspaceDir: effectiveWorkspace,
    toolCount: toolBridge.specs.length,
  });
  recordCodexTrajectoryContext(trajectoryRecorder, {
    attempt: params,
    cwd: effectiveWorkspace,
    developerInstructions: promptBuild.developerInstructions,
    prompt: promptBuild.prompt,
    tools: toolBridge.specs,
  });

  let projector: CodexAppServerEventProjector | undefined;
  let turnId: string | undefined;
  const pendingNotifications: CodexServerNotification[] = [];
  let userInputBridge: ReturnType<typeof createCodexUserInputBridge> | undefined;
  let steeringQueue: ReturnType<typeof createCodexSteeringQueue> | undefined;
  let completed = false;
  let timedOut = false;
  let turnCompletionIdleTimedOut = false;
  let turnCompletionIdleTimeoutMessage: string | undefined;
  let lifecycleStarted = false;
  let lifecycleTerminalEmitted = false;
  let resolveCompletion: (() => void) | undefined;
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });
  let notificationQueue: Promise<void> = Promise.resolve();
  const turnCompletionIdleTimeoutMs = resolveCodexTurnCompletionIdleTimeoutMs(
    options.turnCompletionIdleTimeoutMs,
  );
  let turnCompletionIdleTimer: ReturnType<typeof setTimeout> | undefined;
  let turnCompletionIdleWatchArmed = false;
  let turnCompletionLastActivityAt = Date.now();
  let turnCompletionLastActivityReason = "startup";
  let activeAppServerTurnRequests = 0;

  const clearTurnCompletionIdleTimer = () => {
    if (turnCompletionIdleTimer) {
      clearTimeout(turnCompletionIdleTimer);
      turnCompletionIdleTimer = undefined;
    }
  };

  const fireTurnCompletionIdleTimeout = () => {
    if (
      completed ||
      runAbortController.signal.aborted ||
      !turnCompletionIdleWatchArmed ||
      activeAppServerTurnRequests > 0
    ) {
      return;
    }
    const idleMs = Math.max(0, Date.now() - turnCompletionLastActivityAt);
    if (idleMs < turnCompletionIdleTimeoutMs) {
      scheduleTurnCompletionIdleWatch();
      return;
    }
    timedOut = true;
    turnCompletionIdleTimedOut = true;
    turnCompletionIdleTimeoutMessage =
      "codex app-server turn idle timed out waiting for turn/completed";
    projector?.markTimedOut();
    trajectoryRecorder?.recordEvent("turn.completion_idle_timeout", {
      threadId: thread.threadId,
      turnId,
      idleMs,
      timeoutMs: turnCompletionIdleTimeoutMs,
      lastActivityReason: turnCompletionLastActivityReason,
    });
    embeddedAgentLog.warn("codex app-server turn idle timed out waiting for completion", {
      threadId: thread.threadId,
      turnId,
      idleMs,
      timeoutMs: turnCompletionIdleTimeoutMs,
      lastActivityReason: turnCompletionLastActivityReason,
    });
    runAbortController.abort("turn_completion_idle_timeout");
  };

  function scheduleTurnCompletionIdleWatch() {
    clearTurnCompletionIdleTimer();
    if (
      completed ||
      runAbortController.signal.aborted ||
      !turnCompletionIdleWatchArmed ||
      activeAppServerTurnRequests > 0
    ) {
      return;
    }
    const elapsedMs = Math.max(0, Date.now() - turnCompletionLastActivityAt);
    const delayMs = Math.max(1, turnCompletionIdleTimeoutMs - elapsedMs);
    turnCompletionIdleTimer = setTimeout(fireTurnCompletionIdleTimeout, delayMs);
    turnCompletionIdleTimer.unref?.();
  }

  const touchTurnCompletionActivity = (reason: string, options?: { arm?: boolean }) => {
    turnCompletionLastActivityAt = Date.now();
    turnCompletionLastActivityReason = reason;
    if (options?.arm) {
      turnCompletionIdleWatchArmed = true;
    }
    scheduleTurnCompletionIdleWatch();
  };

  const emitLifecycleStart = () => {
    emitCodexAppServerEvent(params, {
      stream: "lifecycle",
      data: { phase: "start", startedAt: attemptStartedAt },
    });
    lifecycleStarted = true;
  };

  const emitLifecycleTerminal = (data: Record<string, unknown> & { phase: "end" | "error" }) => {
    if (!lifecycleStarted || lifecycleTerminalEmitted) {
      return;
    }
    emitCodexAppServerEvent(params, {
      stream: "lifecycle",
      data: {
        startedAt: attemptStartedAt,
        endedAt: Date.now(),
        ...data,
      },
    });
    lifecycleTerminalEmitted = true;
  };

  const handleNotification = async (notification: CodexServerNotification) => {
    touchTurnCompletionActivity(`notification:${notification.method}`);
    userInputBridge?.handleNotification(notification);
    if (!projector || !turnId) {
      pendingNotifications.push(notification);
      return;
    }
    // Determine terminal-turn status before invoking the projector so a throw
    // inside projector.handleNotification still releases the session lane.
    // See openclaw/openclaw#67996.
    const isTurnCompletion =
      notification.method === "turn/completed" &&
      isTurnNotification(notification.params, thread.threadId, turnId);
    try {
      await projector.handleNotification(notification);
    } catch (error) {
      embeddedAgentLog.debug("codex app-server projector notification threw", {
        method: notification.method,
        error,
      });
    } finally {
      if (isTurnCompletion) {
        if (!timedOut && !runAbortController.signal.aborted) {
          await steeringQueue?.flushPending();
        }
        completed = true;
        clearTurnCompletionIdleTimer();
        resolveCompletion?.();
      }
    }
  };
  const enqueueNotification = (notification: CodexServerNotification): Promise<void> => {
    notificationQueue = notificationQueue.then(
      () => handleNotification(notification),
      () => handleNotification(notification),
    );
    return notificationQueue;
  };

  const notificationCleanup = client.addNotificationHandler(enqueueNotification);
  const requestCleanup = client.addRequestHandler(async (request) => {
    activeAppServerTurnRequests += 1;
    clearTurnCompletionIdleTimer();
    touchTurnCompletionActivity(`request:${request.method}`);
    let armCompletionWatchOnResponse = false;
    try {
      if (request.method === "account/chatgptAuthTokens/refresh") {
        return refreshCodexAppServerAuthTokens({
          agentDir,
          authProfileId: startupAuthProfileId,
        });
      }
      if (!turnId) {
        return undefined;
      }
      if (request.method === "mcpServer/elicitation/request") {
        armCompletionWatchOnResponse = true;
        return handleCodexAppServerElicitationRequest({
          requestParams: request.params,
          paramsForRun: params,
          threadId: thread.threadId,
          turnId,
          signal: runAbortController.signal,
        });
      }
      if (request.method === "item/tool/requestUserInput") {
        armCompletionWatchOnResponse = true;
        return userInputBridge?.handleRequest({
          id: request.id,
          params: request.params,
        });
      }
      if (request.method !== "item/tool/call") {
        if (isCodexAppServerApprovalRequest(request.method)) {
          armCompletionWatchOnResponse = true;
          return handleApprovalRequest({
            method: request.method,
            params: request.params,
            paramsForRun: params,
            threadId: thread.threadId,
            turnId,
            signal: runAbortController.signal,
          });
        }
        return undefined;
      }
      const call = readDynamicToolCallParams(request.params);
      if (!call || call.threadId !== thread.threadId || call.turnId !== turnId) {
        return undefined;
      }
      armCompletionWatchOnResponse = true;
      trajectoryRecorder?.recordEvent("tool.call", {
        threadId: call.threadId,
        turnId: call.turnId,
        toolCallId: call.callId,
        name: call.tool,
        arguments: call.arguments,
      });
      const response = await handleDynamicToolCallWithTimeout({
        call,
        toolBridge,
        signal: runAbortController.signal,
        timeoutMs: CODEX_DYNAMIC_TOOL_TIMEOUT_MS,
        onTimeout: () => {
          trajectoryRecorder?.recordEvent("tool.timeout", {
            threadId: call.threadId,
            turnId: call.turnId,
            toolCallId: call.callId,
            name: call.tool,
            timeoutMs: CODEX_DYNAMIC_TOOL_TIMEOUT_MS,
          });
        },
      });
      trajectoryRecorder?.recordEvent("tool.result", {
        threadId: call.threadId,
        turnId: call.turnId,
        toolCallId: call.callId,
        name: call.tool,
        success: response.success,
        contentItems: response.contentItems,
      });
      return response as JsonValue;
    } finally {
      activeAppServerTurnRequests = Math.max(0, activeAppServerTurnRequests - 1);
      touchTurnCompletionActivity(`request:${request.method}:response`, {
        arm: armCompletionWatchOnResponse,
      });
    }
  });

  const llmInputEvent = {
    runId: params.runId,
    sessionId: params.sessionId,
    provider: params.provider,
    model: params.modelId,
    systemPrompt: promptBuild.developerInstructions,
    prompt: promptBuild.prompt,
    historyMessages,
    imagesCount: params.images?.length ?? 0,
  };
  const turnStartFailureMessages = [
    ...historyMessages,
    {
      role: "user",
      content: [{ type: "text", text: promptBuild.prompt }],
    },
  ];

  let turn: CodexTurnStartResponse;
  try {
    runAgentHarnessLlmInputHook({
      event: llmInputEvent,
      ctx: hookContext,
    });
    emitCodexAppServerEvent(params, {
      stream: "codex_app_server.lifecycle",
      data: { phase: "turn_starting", threadId: thread.threadId },
    });
    turn = assertCodexTurnStartResponse(
      await client.request(
        "turn/start",
        buildTurnStartParams(params, {
          threadId: thread.threadId,
          cwd: effectiveWorkspace,
          appServer,
          promptText: promptBuild.prompt,
        }),
        { timeoutMs: params.timeoutMs, signal: runAbortController.signal },
      ),
    );
  } catch (error) {
    emitCodexAppServerEvent(params, {
      stream: "codex_app_server.lifecycle",
      data: { phase: "turn_start_failed", error: formatErrorMessage(error) },
    });
    trajectoryRecorder?.recordEvent("session.ended", {
      status: "error",
      threadId: thread.threadId,
      timedOut,
      aborted: runAbortController.signal.aborted,
      promptError: normalizeCodexTrajectoryError(error),
    });
    trajectoryEndRecorded = true;
    runAgentHarnessLlmOutputHook({
      event: {
        runId: params.runId,
        sessionId: params.sessionId,
        provider: params.provider,
        model: params.modelId,
        resolvedRef:
          params.runtimePlan?.observability.resolvedRef ?? `${params.provider}/${params.modelId}`,
        ...(params.runtimePlan?.observability.harnessId
          ? { harnessId: params.runtimePlan.observability.harnessId }
          : {}),
        assistantTexts: [],
      },
      ctx: hookContext,
    });
    runAgentHarnessAgentEndHook({
      event: {
        messages: turnStartFailureMessages,
        success: false,
        error: formatErrorMessage(error),
        durationMs: Date.now() - attemptStartedAt,
      },
      ctx: hookContext,
    });
    notificationCleanup();
    requestCleanup();
    nativeHookRelay?.unregister();
    await runAgentCleanupStep({
      runId: params.runId,
      sessionId: params.sessionId,
      step: "codex-trajectory-flush-startup-failure",
      log: embeddedAgentLog,
      cleanup: async () => {
        await trajectoryRecorder?.flush();
      },
    });
    params.abortSignal?.removeEventListener("abort", abortFromUpstream);
    throw error;
  }
  turnId = turn.turn.id;
  const activeTurnId = turn.turn.id;
  userInputBridge = createCodexUserInputBridge({
    paramsForRun: params,
    threadId: thread.threadId,
    turnId: activeTurnId,
    signal: runAbortController.signal,
  });
  trajectoryRecorder?.recordEvent("prompt.submitted", {
    threadId: thread.threadId,
    turnId: activeTurnId,
    prompt: promptBuild.prompt,
    imagesCount: params.images?.length ?? 0,
  });
  projector = new CodexAppServerEventProjector(params, thread.threadId, activeTurnId);
  emitLifecycleStart();
  const activeProjector = projector;
  for (const notification of pendingNotifications.splice(0)) {
    await enqueueNotification(notification);
  }
  if (!completed && isTerminalTurnStatus(turn.turn.status)) {
    await enqueueNotification({
      method: "turn/completed",
      params: {
        threadId: thread.threadId,
        turnId: activeTurnId,
        turn: turn.turn as unknown as JsonObject,
      },
    });
  }

  const activeSteeringQueue = createCodexSteeringQueue({
    client,
    threadId: thread.threadId,
    turnId: activeTurnId,
    answerPendingUserInput: (text) => userInputBridge?.handleQueuedMessage(text) ?? false,
    signal: runAbortController.signal,
  });
  steeringQueue = activeSteeringQueue;
  const handle = {
    kind: "embedded" as const,
    queueMessage: async (text: string, options?: CodexSteeringQueueOptions) =>
      activeSteeringQueue.queue(text, options),
    isStreaming: () => !completed,
    isCompacting: () => projector?.isCompacting() ?? false,
    cancel: () => runAbortController.abort("cancelled"),
    abort: () => runAbortController.abort("aborted"),
  };
  setActiveEmbeddedRun(params.sessionId, handle, params.sessionKey);
  touchTurnCompletionActivity("turn:start");

  const timeout = setTimeout(
    () => {
      timedOut = true;
      projector?.markTimedOut();
      runAbortController.abort("timeout");
    },
    Math.max(100, params.timeoutMs),
  );

  const abortListener = () => {
    interruptCodexTurnBestEffort(client, {
      threadId: thread.threadId,
      turnId: activeTurnId,
    });
    resolveCompletion?.();
  };
  runAbortController.signal.addEventListener("abort", abortListener, { once: true });
  if (runAbortController.signal.aborted) {
    abortListener();
  }

  try {
    await completion;
    const result = activeProjector.buildResult(toolBridge.telemetry, { yieldDetected });
    const finalAborted = result.aborted || runAbortController.signal.aborted;
    const finalPromptError = turnCompletionIdleTimedOut
      ? turnCompletionIdleTimeoutMessage
      : timedOut
        ? "codex app-server attempt timed out"
        : result.promptError;
    const finalPromptErrorSource = timedOut ? "prompt" : result.promptErrorSource;
    recordCodexTrajectoryCompletion(trajectoryRecorder, {
      attempt: params,
      result,
      threadId: thread.threadId,
      turnId: activeTurnId,
      timedOut,
      yieldDetected,
    });
    trajectoryRecorder?.recordEvent("session.ended", {
      status: finalPromptError ? "error" : finalAborted || timedOut ? "interrupted" : "success",
      threadId: thread.threadId,
      turnId: activeTurnId,
      timedOut,
      yieldDetected,
      promptError: normalizeCodexTrajectoryError(finalPromptError),
    });
    trajectoryEndRecorded = true;
    await mirrorTranscriptBestEffort({
      params,
      agentId: sessionAgentId,
      result,
      sessionKey: sandboxSessionKey,
      threadId: thread.threadId,
      turnId: activeTurnId,
    });
    const terminalAssistantText = collectTerminalAssistantText(result);
    if (terminalAssistantText && !finalAborted && !finalPromptError) {
      emitCodexAppServerEvent(params, {
        stream: "assistant",
        data: { text: terminalAssistantText },
      });
    }
    if (finalPromptError) {
      emitLifecycleTerminal({
        phase: "error",
        error: formatErrorMessage(finalPromptError),
      });
    } else {
      emitLifecycleTerminal({
        phase: "end",
        ...(finalAborted ? { aborted: true } : {}),
      });
    }
    if (activeContextEngine) {
      const finalMessages =
        readMirroredSessionHistoryMessages(params.sessionFile) ??
        historyMessages.concat(result.messagesSnapshot);
      await finalizeHarnessContextEngineTurn({
        contextEngine: activeContextEngine,
        promptError: Boolean(finalPromptError),
        aborted: finalAborted,
        yieldAborted: Boolean(result.yieldDetected),
        sessionIdUsed: params.sessionId,
        sessionKey: sandboxSessionKey,
        sessionFile: params.sessionFile,
        messagesSnapshot: finalMessages,
        prePromptMessageCount,
        tokenBudget: params.contextTokenBudget,
        runtimeContext: buildHarnessContextEngineRuntimeContextFromUsage({
          attempt: runtimeParams,
          workspaceDir: effectiveWorkspace,
          agentDir,
          tokenBudget: params.contextTokenBudget,
          lastCallUsage: result.attemptUsage,
          promptCache: result.promptCache,
        }),
        runMaintenance: runHarnessContextEngineMaintenance,
        sessionManager,
        warn: (message) => embeddedAgentLog.warn(message),
      });
    }
    runAgentHarnessLlmOutputHook({
      event: {
        runId: params.runId,
        sessionId: params.sessionId,
        provider: params.provider,
        model: params.modelId,
        resolvedRef:
          params.runtimePlan?.observability.resolvedRef ?? `${params.provider}/${params.modelId}`,
        ...(params.runtimePlan?.observability.harnessId
          ? { harnessId: params.runtimePlan.observability.harnessId }
          : {}),
        assistantTexts: result.assistantTexts,
        ...(result.lastAssistant ? { lastAssistant: result.lastAssistant } : {}),
        ...(result.attemptUsage ? { usage: result.attemptUsage } : {}),
      },
      ctx: hookContext,
    });
    runAgentHarnessAgentEndHook({
      event: {
        messages: result.messagesSnapshot,
        success: !finalAborted && !finalPromptError,
        ...(finalPromptError ? { error: formatErrorMessage(finalPromptError) } : {}),
        durationMs: Date.now() - attemptStartedAt,
      },
      ctx: hookContext,
    });
    return {
      ...result,
      timedOut,
      aborted: finalAborted,
      promptError: finalPromptError,
      promptErrorSource: finalPromptErrorSource,
    };
  } finally {
    emitLifecycleTerminal({
      phase: "error",
      error: "codex app-server run completed without lifecycle terminal event",
    });
    if (trajectoryRecorder && !trajectoryEndRecorded) {
      trajectoryRecorder.recordEvent("session.ended", {
        status: timedOut || runAbortController.signal.aborted ? "interrupted" : "cleanup",
        threadId: thread.threadId,
        turnId: activeTurnId,
        timedOut,
        aborted: runAbortController.signal.aborted,
      });
    }
    await runAgentCleanupStep({
      runId: params.runId,
      sessionId: params.sessionId,
      step: "codex-trajectory-flush",
      log: embeddedAgentLog,
      cleanup: async () => {
        await trajectoryRecorder?.flush();
      },
    });
    if (!timedOut && !runAbortController.signal.aborted) {
      await steeringQueue?.flushPending();
    }
    userInputBridge?.cancelPending();
    clearTimeout(timeout);
    clearTurnCompletionIdleTimer();
    notificationCleanup();
    requestCleanup();
    nativeHookRelay?.unregister();
    runAbortController.signal.removeEventListener("abort", abortListener);
    params.abortSignal?.removeEventListener("abort", abortFromUpstream);
    steeringQueue?.cancel();
    clearActiveEmbeddedRun(params.sessionId, handle, params.sessionKey);
  }
}

async function handleDynamicToolCallWithTimeout(params: {
  call: CodexDynamicToolCallParams;
  toolBridge: Pick<CodexDynamicToolBridge, "handleToolCall">;
  signal: AbortSignal;
  timeoutMs: number;
  onTimeout?: () => void;
}): Promise<CodexDynamicToolCallResponse> {
  if (params.signal.aborted) {
    return failedDynamicToolResponse("OpenClaw dynamic tool call aborted before execution.");
  }

  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let resolveAbort: ((response: CodexDynamicToolCallResponse) => void) | undefined;
  const abortFromRun = () => {
    const message = "OpenClaw dynamic tool call aborted.";
    controller.abort(params.signal.reason ?? new Error(message));
    resolveAbort?.(failedDynamicToolResponse(message));
  };
  const abortPromise = new Promise<CodexDynamicToolCallResponse>((resolve) => {
    resolveAbort = resolve;
  });
  const timeoutPromise = new Promise<CodexDynamicToolCallResponse>((resolve) => {
    const timeoutMs = Math.max(1, Math.min(CODEX_DYNAMIC_TOOL_TIMEOUT_MS, params.timeoutMs));
    timeout = setTimeout(() => {
      timedOut = true;
      const message = `OpenClaw dynamic tool call timed out after ${timeoutMs}ms.`;
      controller.abort(new Error(message));
      params.onTimeout?.();
      embeddedAgentLog.warn("codex dynamic tool call timed out", {
        tool: params.call.tool,
        toolCallId: params.call.callId,
        threadId: params.call.threadId,
        turnId: params.call.turnId,
        timeoutMs,
      });
      resolve(failedDynamicToolResponse(message));
    }, timeoutMs);
    timeout.unref?.();
  });

  try {
    params.signal.addEventListener("abort", abortFromRun, { once: true });
    if (params.signal.aborted) {
      abortFromRun();
    }
    return await Promise.race([
      params.toolBridge.handleToolCall(params.call, { signal: controller.signal }),
      abortPromise,
      timeoutPromise,
    ]);
  } catch (error) {
    return failedDynamicToolResponse(error instanceof Error ? error.message : String(error));
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    params.signal.removeEventListener("abort", abortFromRun);
    resolveAbort = undefined;
    if (!timedOut && !controller.signal.aborted) {
      controller.abort(new Error("OpenClaw dynamic tool call finished."));
    }
  }
}

function failedDynamicToolResponse(message: string): CodexDynamicToolCallResponse {
  return {
    success: false,
    contentItems: [{ type: "inputText", text: message }],
  };
}

function createCodexNativeHookRelay(params: {
  options:
    | {
        enabled?: boolean;
        events?: readonly NativeHookRelayEvent[];
        ttlMs?: number;
        gatewayTimeoutMs?: number;
      }
    | undefined;
  agentId: string | undefined;
  sessionId: string;
  sessionKey: string | undefined;
  runId: string;
  signal: AbortSignal;
}): NativeHookRelayRegistrationHandle | undefined {
  if (params.options?.enabled === false) {
    return undefined;
  }
  return registerNativeHookRelay({
    provider: "codex",
    relayId: buildCodexNativeHookRelayId({
      agentId: params.agentId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
    }),
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionId: params.sessionId,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    runId: params.runId,
    allowedEvents: params.options?.events ?? CODEX_NATIVE_HOOK_RELAY_EVENTS,
    ttlMs: params.options?.ttlMs,
    signal: params.signal,
    command: {
      timeoutMs: params.options?.gatewayTimeoutMs,
    },
  });
}

function buildCodexNativeHookRelayId(params: {
  agentId: string | undefined;
  sessionId: string;
  sessionKey: string | undefined;
}): string {
  const hash = createHash("sha256");
  hash.update("openclaw:codex:native-hook-relay:v1");
  hash.update("\0");
  hash.update(params.agentId?.trim() || "");
  hash.update("\0");
  hash.update(params.sessionKey?.trim() || params.sessionId);
  return `codex-${hash.digest("hex").slice(0, 40)}`;
}

function interruptCodexTurnBestEffort(
  client: CodexAppServerClient,
  params: {
    threadId: string;
    turnId: string;
  },
): void {
  void Promise.resolve()
    .then(() => client.request("turn/interrupt", params))
    .catch((error: unknown) => {
      embeddedAgentLog.debug("codex app-server turn interrupt failed during abort", { error });
    });
}

type DynamicToolBuildParams = {
  params: EmbeddedRunAttemptParams;
  resolvedWorkspace: string;
  effectiveWorkspace: string;
  sandboxSessionKey: string;
  sandbox: Awaited<ReturnType<typeof resolveSandboxContext>>;
  runAbortController: AbortController;
  sessionAgentId: string | undefined;
  onYieldDetected: () => void;
};

async function buildDynamicTools(input: DynamicToolBuildParams) {
  const { params } = input;
  if (params.disableTools || !supportsModelTools(params.model)) {
    return [];
  }
  const modelHasVision = params.model.input?.includes("image") ?? false;
  const agentDir = params.agentDir ?? resolveOpenClawAgentDir();
  const { createOpenClawCodingTools } = await import("openclaw/plugin-sdk/agent-harness");
  const allTools = createOpenClawCodingTools({
    agentId: input.sessionAgentId,
    ...buildEmbeddedAttemptToolRunContext(params),
    exec: {
      ...params.execOverrides,
      elevated: params.bashElevated,
    },
    sandbox: input.sandbox,
    messageProvider: params.messageChannel ?? params.messageProvider,
    agentAccountId: params.agentAccountId,
    messageTo: params.messageTo,
    messageThreadId: params.messageThreadId,
    groupId: params.groupId,
    groupChannel: params.groupChannel,
    groupSpace: params.groupSpace,
    spawnedBy: params.spawnedBy,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
    senderIsOwner: params.senderIsOwner,
    allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
    sessionKey: input.sandboxSessionKey,
    sessionId: params.sessionId,
    runId: params.runId,
    agentDir,
    workspaceDir: input.effectiveWorkspace,
    spawnWorkspaceDir: resolveAttemptSpawnWorkspaceDir({
      sandbox: input.sandbox,
      resolvedWorkspace: input.resolvedWorkspace,
    }),
    config: params.config,
    abortSignal: input.runAbortController.signal,
    modelProvider: params.model.provider,
    modelId: params.modelId,
    modelCompat:
      params.model.compat && typeof params.model.compat === "object"
        ? (params.model.compat as OpenClawCodingToolsOptions["modelCompat"])
        : undefined,
    modelApi: params.model.api,
    modelContextWindowTokens: params.model.contextWindow,
    modelAuthMode: resolveModelAuthMode(params.model.provider, params.config, undefined, {
      workspaceDir: input.effectiveWorkspace,
    }),
    currentChannelId: params.currentChannelId,
    currentThreadTs: params.currentThreadTs,
    currentMessageId: params.currentMessageId,
    replyToMode: params.replyToMode,
    hasRepliedRef: params.hasRepliedRef,
    modelHasVision,
    requireExplicitMessageTarget:
      params.requireExplicitMessageTarget ?? isSubagentSessionKey(params.sessionKey),
    disableMessageTool: params.disableMessageTool,
    onYield: (message) => {
      input.onYieldDetected();
      emitCodexAppServerEvent(params, {
        stream: "codex_app_server.tool",
        data: { name: "sessions_yield", message },
      });
      input.runAbortController.abort("sessions_yield");
    },
  });
  const visionFilteredTools = filterToolsForVisionInputs(allTools, {
    modelHasVision,
    hasInboundImages: (params.images?.length ?? 0) > 0,
  });
  const filteredTools =
    params.toolsAllow && params.toolsAllow.length > 0
      ? visionFilteredTools.filter((tool) => params.toolsAllow?.includes(tool.name))
      : visionFilteredTools;
  return normalizeAgentRuntimeTools({
    runtimePlan: params.runtimePlan,
    tools: filteredTools,
    provider: params.provider,
    config: params.config,
    workspaceDir: input.effectiveWorkspace,
    env: process.env,
    modelId: params.modelId,
    modelApi: params.model.api,
    model: params.model,
  });
}

async function withCodexStartupTimeout<T>(params: {
  timeoutMs: number;
  timeoutFloorMs?: number;
  signal: AbortSignal;
  operation: () => Promise<T>;
}): Promise<T> {
  if (params.signal.aborted) {
    throw new Error("codex app-server startup aborted");
  }
  let timeout: NodeJS.Timeout | undefined;
  let abortCleanup: (() => void) | undefined;
  try {
    return await Promise.race([
      params.operation(),
      new Promise<never>((_, reject) => {
        const rejectOnce = (error: Error) => {
          if (timeout) {
            clearTimeout(timeout);
            timeout = undefined;
          }
          reject(error);
        };
        const timeoutMs = Math.max(params.timeoutFloorMs ?? 100, params.timeoutMs);
        timeout = setTimeout(() => {
          rejectOnce(new Error("codex app-server startup timed out"));
        }, timeoutMs);
        const abortListener = () => rejectOnce(new Error("codex app-server startup aborted"));
        params.signal.addEventListener("abort", abortListener, { once: true });
        abortCleanup = () => params.signal.removeEventListener("abort", abortListener);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    abortCleanup?.();
  }
}

function resolveCodexTurnCompletionIdleTimeoutMs(value: number | undefined): number {
  if (value === undefined) {
    return CODEX_TURN_COMPLETION_IDLE_TIMEOUT_MS;
  }
  if (!Number.isFinite(value)) {
    return CODEX_TURN_COMPLETION_IDLE_TIMEOUT_MS;
  }
  return Math.max(1, Math.floor(value));
}

function readDynamicToolCallParams(
  value: JsonValue | undefined,
): CodexDynamicToolCallParams | undefined {
  return readCodexDynamicToolCallParams(value);
}

function isTurnNotification(
  value: JsonValue | undefined,
  threadId: string,
  turnId: string,
): boolean {
  if (!isJsonObject(value)) {
    return false;
  }
  return readString(value, "threadId") === threadId && readNotificationTurnId(value) === turnId;
}

function isTerminalTurnStatus(status: string | undefined): boolean {
  return status === "completed" || status === "interrupted" || status === "failed";
}

function readNotificationTurnId(record: JsonObject): string | undefined {
  return readString(record, "turnId") ?? readNestedTurnId(record);
}

function readNestedTurnId(record: JsonObject): string | undefined {
  const turn = record.turn;
  return isJsonObject(turn) ? readString(turn, "id") : undefined;
}

function readString(record: JsonObject, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readMirroredSessionHistoryMessages(
  sessionFile: string,
  sessionManager?: SessionManager,
): AgentMessage[] | undefined {
  try {
    return (sessionManager ?? SessionManager.open(sessionFile)).buildSessionContext().messages;
  } catch (error) {
    embeddedAgentLog.warn("failed to read mirrored session history for codex harness hooks", {
      error,
      sessionFile,
    });
    return undefined;
  }
}

async function mirrorTranscriptBestEffort(params: {
  params: EmbeddedRunAttemptParams;
  agentId?: string;
  result: EmbeddedRunAttemptResult;
  sessionKey?: string;
  threadId: string;
  turnId: string;
}): Promise<void> {
  try {
    await mirrorCodexAppServerTranscript({
      sessionFile: params.params.sessionFile,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      messages: params.result.messagesSnapshot,
      idempotencyScope: `codex-app-server:${params.threadId}:${params.turnId}`,
    });
  } catch (error) {
    embeddedAgentLog.warn("failed to mirror codex app-server transcript", { error });
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function joinPresentSections(...sections: Array<string | undefined>): string {
  return sections.filter((section): section is string => Boolean(section?.trim())).join("\n\n");
}

function handleApprovalRequest(params: {
  method: string;
  params: JsonValue | undefined;
  paramsForRun: EmbeddedRunAttemptParams;
  threadId: string;
  turnId: string;
  signal?: AbortSignal;
}): Promise<JsonValue | undefined> {
  return handleCodexAppServerApprovalRequest({
    method: params.method,
    requestParams: params.params,
    paramsForRun: params.paramsForRun,
    threadId: params.threadId,
    turnId: params.turnId,
    signal: params.signal,
  });
}

export const __testing = {
  CODEX_DYNAMIC_TOOL_TIMEOUT_MS,
  CODEX_TURN_COMPLETION_IDLE_TIMEOUT_MS,
  buildCodexNativeHookRelayId,
  filterToolsForVisionInputs,
  handleDynamicToolCallWithTimeout,
  ...createCodexAppServerClientFactoryTestHooks((factory) => {
    clientFactory = factory;
  }),
} as const;
