import fs from "node:fs/promises";
import {
  buildEmbeddedAttemptToolRunContext,
  clearActiveEmbeddedRun,
  createOpenClawCodingTools,
  embeddedAgentLog,
  isSubagentSessionKey,
  normalizeProviderToolSchemas,
  resolveAttemptSpawnWorkspaceDir,
  resolveModelAuthMode,
  resolveOpenClawAgentDir,
  resolveSandboxContext,
  resolveSessionAgentIds,
  resolveUserPath,
  setActiveEmbeddedRun,
  supportsModelTools,
  type EmbeddedRunAttemptParams,
  type EmbeddedRunAttemptResult,
} from "openclaw/plugin-sdk/agent-harness";
import { handleCodexAppServerApprovalRequest } from "./approval-bridge.js";
import { isCodexAppServerApprovalRequest, type CodexAppServerClient } from "./client.js";
import { resolveCodexAppServerRuntimeOptions, type CodexAppServerStartOptions } from "./config.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
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
import { clearSharedCodexAppServerClient, getSharedCodexAppServerClient } from "./shared-client.js";
import { buildTurnStartParams, startOrResumeThread } from "./thread-lifecycle.js";
import { mirrorCodexAppServerTranscript } from "./transcript-mirror.js";

type CodexAppServerClientFactory = (
  startOptions?: CodexAppServerStartOptions,
  authProfileId?: string,
) => Promise<CodexAppServerClient>;

let clientFactory: CodexAppServerClientFactory = (startOptions, authProfileId) =>
  getSharedCodexAppServerClient({ startOptions, authProfileId });

export async function runCodexAppServerAttempt(
  params: EmbeddedRunAttemptParams,
  options: { pluginConfig?: unknown } = {},
): Promise<EmbeddedRunAttemptResult> {
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
  });
  let client: CodexAppServerClient;
  let thread: CodexAppServerThreadBinding;
  try {
    ({ client, thread } = await withCodexStartupTimeout({
      timeoutMs: params.timeoutMs,
      signal: runAbortController.signal,
      operation: async () => {
        const startupClient = await clientFactory(appServer.start, startupAuthProfileId);
        const startupThread = await startOrResumeThread({
          client: startupClient,
          params,
          cwd: effectiveWorkspace,
          dynamicTools: toolBridge.specs,
          appServer,
        });
        return { client: startupClient, thread: startupThread };
      },
    }));
  } catch (error) {
    clearSharedCodexAppServerClient();
    params.abortSignal?.removeEventListener("abort", abortFromUpstream);
    throw error;
  }

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
    await projector.handleNotification(notification);
    if (
      notification.method === "turn/completed" &&
      isTurnNotification(notification.params, turnId)
    ) {
      completed = true;
      resolveCompletion?.();
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
    return toolBridge.handleToolCall(call) as Promise<JsonValue>;
  });

  let turn: CodexTurnStartResponse;
  try {
    turn = await client.request<CodexTurnStartResponse>(
      "turn/start",
      buildTurnStartParams(params, {
        threadId: thread.threadId,
        cwd: effectiveWorkspace,
        appServer,
      }),
      { timeoutMs: params.timeoutMs, signal: runAbortController.signal },
    );
  } catch (error) {
    notificationCleanup();
    requestCleanup();
    params.abortSignal?.removeEventListener("abort", abortFromUpstream);
    throw error;
  }
  turnId = turn.turn.id;
  projector = new CodexAppServerEventProjector(params, thread.threadId, turnId);
  for (const notification of pendingNotifications.splice(0)) {
    await enqueueNotification(notification);
  }
  const activeTurnId = turnId;
  const activeProjector = projector;

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
    await mirrorTranscriptBestEffort({
      params,
      result,
      threadId: thread.threadId,
      turnId: activeTurnId,
    });
    return {
      ...result,
      timedOut,
      aborted: result.aborted || runAbortController.signal.aborted,
      promptError: timedOut ? "codex app-server attempt timed out" : result.promptError,
      promptErrorSource: timedOut ? "prompt" : result.promptErrorSource,
    };
  } finally {
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
  const filteredTools =
    params.toolsAllow && params.toolsAllow.length > 0
      ? allTools.filter((tool) => params.toolsAllow?.includes(tool.name))
      : allTools;
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

async function withCodexStartupTimeout<T>(params: {
  timeoutMs: number;
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
        const timeoutMs = Math.max(100, params.timeoutMs);
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

function isTurnNotification(value: JsonValue | undefined, turnId: string): boolean {
  if (!isJsonObject(value)) {
    return false;
  }
  const directTurnId = readString(value, "turnId");
  if (directTurnId === turnId) {
    return true;
  }
  const turn = isJsonObject(value.turn) ? value.turn : undefined;
  return readString(turn ?? {}, "id") === turnId;
}

function readString(record: JsonObject, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

async function mirrorTranscriptBestEffort(params: {
  params: EmbeddedRunAttemptParams;
  result: EmbeddedRunAttemptResult;
  threadId: string;
  turnId: string;
}): Promise<void> {
  try {
    await mirrorCodexAppServerTranscript({
      sessionFile: params.params.sessionFile,
      sessionKey: params.params.sessionKey,
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
  setCodexAppServerClientFactoryForTests(factory: CodexAppServerClientFactory): void {
    clientFactory = factory;
  },
  resetCodexAppServerClientFactoryForTests(): void {
    clientFactory = (startOptions, authProfileId) =>
      getSharedCodexAppServerClient({ startOptions, authProfileId });
  },
} as const;
