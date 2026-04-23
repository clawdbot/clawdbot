import fs from "node:fs/promises";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import {
  buildEmbeddedAttemptToolRunContext,
  clearActiveEmbeddedRun,
  embeddedAgentLog,
  formatErrorMessage,
  isSubagentSessionKey,
  normalizeProviderToolSchemas,
  resolveAttemptSpawnWorkspaceDir,
  resolveModelAuthMode,
  resolveOpenClawAgentDir,
  resolveSandboxContext,
  resolveSessionAgentIds,
  resolveUserPath,
  resolveAgentHarnessBeforePromptBuildResult,
  runAgentHarnessAgentEndHook,
  runAgentHarnessLlmInputHook,
  runAgentHarnessLlmOutputHook,
  setActiveEmbeddedRun,
  supportsModelTools,
  type EmbeddedRunAttemptParams,
  type EmbeddedRunAttemptResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { handleCodexAppServerApprovalRequest } from "./approval-bridge.js";
import {
  createCodexAppServerClientFactoryTestHooks,
  defaultCodexAppServerClientFactory,
} from "./client-factory.js";
import { isCodexAppServerApprovalRequest, type CodexAppServerClient } from "./client.js";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import { handleCodexAppServerElicitationRequest } from "./elicitation-bridge.js";
import { CodexAppServerEventProjector } from "./event-projector.js";
import {
  isJsonObject,
  type CodexServerNotification,
  type CodexDynamicToolCallParams,
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

let clientFactory = defaultCodexAppServerClientFactory;

export async function runCodexAppServerAttempt(
  params: EmbeddedRunAttemptParams,
  options: { pluginConfig?: unknown; startupTimeoutFloorMs?: number } = {},
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
  let yieldDetected = false;
  const startupBinding = await readCodexAppServerBinding(params.sessionFile);
  const startupAuthProfileId = params.authProfileId ?? startupBinding?.authProfileId;
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
  const historyMessages = readMirroredSessionHistoryMessages(params.sessionFile);
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
  const promptBuild = await resolveAgentHarnessBeforePromptBuildResult({
    prompt: params.prompt,
    developerInstructions: buildDeveloperInstructions(params),
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
  try {
    ({ client, thread } = await withCodexStartupTimeout({
      timeoutMs: params.timeoutMs,
      timeoutFloorMs: options.startupTimeoutFloorMs,
      signal: runAbortController.signal,
      operation: async () => {
        const startupClient = await clientFactory(appServer.start, startupAuthProfileId);
        const startupThread = await startOrResumeThread({
          client: startupClient,
          params,
          cwd: effectiveWorkspace,
          dynamicTools: toolBridge.specs,
          appServer,
          developerInstructions: promptBuild.developerInstructions,
        });
        return { client: startupClient, thread: startupThread };
      },
    }));
  } catch (error) {
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
  let completed = false;
  let timedOut = false;
  let resolveCompletion: (() => void) | undefined;
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });
  let notificationQueue: Promise<void> = Promise.resolve();

  const handleNotification = async (notification: CodexServerNotification) => {
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
        completed = true;
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
    if (!turnId) {
      return undefined;
    }
    if (request.method === "mcpServer/elicitation/request") {
      return handleCodexAppServerElicitationRequest({
        requestParams: request.params,
        paramsForRun: params,
        threadId: thread.threadId,
        turnId,
        signal: runAbortController.signal,
      });
    }
    if (request.method !== "item/tool/call") {
      if (isCodexAppServerApprovalRequest(request.method)) {
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
    trajectoryRecorder?.recordEvent("tool.call", {
      threadId: call.threadId,
      turnId: call.turnId,
      toolCallId: call.callId,
      name: call.tool,
      arguments: call.arguments,
    });
    const response = await toolBridge.handleToolCall(call);
    trajectoryRecorder?.recordEvent("tool.result", {
      threadId: call.threadId,
      turnId: call.turnId,
      toolCallId: call.callId,
      name: call.tool,
      success: response.success,
      contentItems: response.contentItems,
    });
    return response as JsonValue;
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
    turn = await client.request<CodexTurnStartResponse>(
      "turn/start",
      buildTurnStartParams(params, {
        threadId: thread.threadId,
        cwd: effectiveWorkspace,
        appServer,
        promptText: promptBuild.prompt,
      }),
      { timeoutMs: params.timeoutMs, signal: runAbortController.signal },
    );
  } catch (error) {
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
    await trajectoryRecorder?.flush();
    params.abortSignal?.removeEventListener("abort", abortFromUpstream);
    throw error;
  }
  turnId = turn.turn.id;
  trajectoryRecorder?.recordEvent("prompt.submitted", {
    threadId: thread.threadId,
    turnId,
    prompt: promptBuild.prompt,
    imagesCount: params.images?.length ?? 0,
  });
  projector = new CodexAppServerEventProjector(params, thread.threadId, turnId);
  const activeTurnId = turnId;
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

  const handle = {
    kind: "embedded" as const,
    queueMessage: async (text: string) => {
      await client.request("turn/steer", {
        threadId: thread.threadId,
        expectedTurnId: activeTurnId,
        input: [{ type: "text", text }],
      });
    },
    isStreaming: () => !completed,
    isCompacting: () => projector?.isCompacting() ?? false,
    cancel: () => runAbortController.abort("cancelled"),
    abort: () => runAbortController.abort("aborted"),
  };
  setActiveEmbeddedRun(params.sessionId, handle, params.sessionKey);

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
    const finalPromptError = timedOut ? "codex app-server attempt timed out" : result.promptError;
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
    runAgentHarnessLlmOutputHook({
      event: {
        runId: params.runId,
        sessionId: params.sessionId,
        provider: params.provider,
        model: params.modelId,
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
    if (trajectoryRecorder && !trajectoryEndRecorded) {
      trajectoryRecorder.recordEvent("session.ended", {
        status: timedOut || runAbortController.signal.aborted ? "interrupted" : "cleanup",
        threadId: thread.threadId,
        turnId: activeTurnId,
        timedOut,
        aborted: runAbortController.signal.aborted,
      });
    }
    await trajectoryRecorder?.flush();
    clearTimeout(timeout);
    notificationCleanup();
    requestCleanup();
    runAbortController.signal.removeEventListener("abort", abortListener);
    params.abortSignal?.removeEventListener("abort", abortFromUpstream);
    clearActiveEmbeddedRun(params.sessionId, handle, params.sessionKey);
  }
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
    modelCompat: params.model.compat,
    modelApi: params.model.api,
    modelContextWindowTokens: params.model.contextWindow,
    modelAuthMode: resolveModelAuthMode(params.model.provider, params.config),
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
      params.onAgentEvent?.({
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
  return normalizeProviderToolSchemas({
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

function filterToolsForVisionInputs<T extends { name?: string }>(
  tools: T[],
  params: {
    modelHasVision: boolean;
    hasInboundImages: boolean;
  },
): T[] {
  if (!params.modelHasVision || !params.hasInboundImages) {
    return tools;
  }
  return tools.filter((tool) => tool.name !== "image");
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

function readDynamicToolCallParams(
  value: JsonValue | undefined,
): CodexDynamicToolCallParams | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const threadId = readString(value, "threadId");
  const turnId = readString(value, "turnId");
  const callId = readString(value, "callId");
  const tool = readString(value, "tool");
  if (!threadId || !turnId || !callId || !tool) {
    return undefined;
  }
  return {
    threadId,
    turnId,
    callId,
    tool,
    arguments: value.arguments,
  };
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

function readMirroredSessionHistoryMessages(sessionFile: string): unknown[] {
  try {
    return SessionManager.open(sessionFile).buildSessionContext().messages;
  } catch (error) {
    embeddedAgentLog.warn("failed to read mirrored session history for codex harness hooks", {
      error,
      sessionFile,
    });
    return [];
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
  filterToolsForVisionInputs,
  ...createCodexAppServerClientFactoryTestHooks((factory) => {
    clientFactory = factory;
  }),
} as const;
