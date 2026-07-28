import {
  embeddedAgentLog,
  isHostScopedAgentToolActive,
  materializeRequesterScopedMcpToolsForHarnessRun,
  resolveAgentDir,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  buildDynamicTools,
  formatCodexDynamicToolBuildStageSummary,
  resolveCodexMessageToolProvider,
  shouldWarnCodexDynamicToolBuildStageSummary,
} from "./dynamic-tool-build.js";
import {
  filterCodexDynamicTools,
  resolveCodexDynamicToolsLoadingForRuntime,
} from "./dynamic-tool-profile.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import { emitCodexAppServerEvent } from "./run-attempt-lifecycle.js";
import type { CodexAttemptRuntime } from "./run-attempt-runtime.js";
import { resolveCodexDynamicToolDirectNames } from "./run-attempt-tools.js";

export async function prepareCodexAttemptTools(runtime: CodexAttemptRuntime) {
  const {
    connection,
    bundleMcpThreadConfig,
    runtimeParams,
    effectiveRuntimeModelId,
    nativeToolSurfaceEnabled,
    nativeProviderWebSearchSupport,
    hookChannelId,
  } = runtime;
  const {
    params,
    preDynamicStartupStages,
    mutable,
    startupAuthProfileId,
    resolvedWorkspace,
    effectiveWorkspace,
    effectiveCwd,
    sandboxSessionKey,
    sandbox,
    runAbortController,
    sessionAgentId,
    pluginConfig,
    profilerEnabled,
    agentDir,
  } = connection;
  const preDynamicSummary = preDynamicStartupStages.snapshot();
  if (shouldWarnCodexDynamicToolBuildStageSummary(preDynamicSummary)) {
    embeddedAgentLog.warn(
      `codex app-server pre-dynamic startup timings runId=${params.runId} sessionId=${params.sessionId} totalMs=${preDynamicSummary.totalMs} stages=${formatCodexDynamicToolBuildStageSummary(preDynamicSummary)}`,
      {
        runId: params.runId,
        sessionId: params.sessionId,
        totalMs: preDynamicSummary.totalMs,
        stages: preDynamicSummary.stages,
        hasStartupBinding: Boolean(mutable.startupBinding?.threadId),
        startupAuthProfileId: startupAuthProfileId ?? null,
        bundleMcpDiagnosticCount: bundleMcpThreadConfig.diagnostics.length,
        nativeToolSurfaceEnabled,
      },
    );
  }
  const toolState = {
    yieldDetected: false,
    persistentWebSearchAllowed: undefined as boolean | undefined,
    webSearchAllowed: false,
  };
  const toolOutcomeOrdinals = new Map<string, number>();
  const suppressedDynamicToolOutcomeOrdinals = new Set<number>();
  const onCodexToolOutcome = params.onToolOutcome
    ? (observation: Parameters<NonNullable<typeof params.onToolOutcome>>[0]) => {
        if (
          observation.toolCallOrdinal !== undefined &&
          suppressedDynamicToolOutcomeOrdinals.has(observation.toolCallOrdinal)
        ) {
          return;
        }
        params.onToolOutcome?.(observation);
      }
    : undefined;
  const baseAllocateToolOutcomeOrdinal = params.allocateToolOutcomeOrdinal;
  const allocateCodexToolOutcomeOrdinal = baseAllocateToolOutcomeOrdinal
    ? (toolCallId?: string): number => {
        const reservedOrdinal = toolCallId ? toolOutcomeOrdinals.get(toolCallId) : undefined;
        if (reservedOrdinal !== undefined) {
          return reservedOrdinal;
        }
        const ordinal = baseAllocateToolOutcomeOrdinal(toolCallId);
        if (toolCallId) {
          toolOutcomeOrdinals.set(toolCallId, ordinal);
        }
        return ordinal;
      }
    : undefined;
  const dynamicToolParams =
    allocateCodexToolOutcomeOrdinal || onCodexToolOutcome
      ? {
          ...runtimeParams,
          ...(allocateCodexToolOutcomeOrdinal
            ? { allocateToolOutcomeOrdinal: allocateCodexToolOutcomeOrdinal }
            : {}),
          ...(onCodexToolOutcome ? { onToolOutcome: onCodexToolOutcome } : {}),
        }
      : runtimeParams;
  const computerContextEpoch: {
    value: number;
    frameToolCallId?: string;
    frameImageIdentity?: string;
  } = { value: 0 };
  const commonToolParams = {
    params: dynamicToolParams,
    resolvedWorkspace,
    effectiveWorkspace,
    effectiveCwd,
    sandboxSessionKey,
    sandbox,
    nativeToolSurfaceEnabled,
    nativeProviderWebSearchSupport,
    runAbortController,
    sessionAgentId,
    pluginConfig,
    profilerEnabled,
    onYieldDetected: () => {
      toolState.yieldDetected = true;
    },
    onCodexAppServerEvent: (event: Parameters<typeof emitCodexAppServerEvent>[1]) => {
      void emitCodexAppServerEvent(params, event);
    },
    computerContextEpoch,
  };
  const tools = await buildDynamicTools({
    ...commonToolParams,
    onPersistentWebSearchPolicyResolved: (allowed) => {
      toolState.persistentWebSearchAllowed = allowed;
    },
    onWebSearchPolicyResolved: (allowed) => {
      toolState.webSearchAllowed = allowed;
    },
  });
  const registeredTools = await buildDynamicTools({
    ...commonToolParams,
    forceHeartbeatTool: true,
    ignoreDisableMessageTool: true,
    ignoreRuntimePlan: true,
  });
  // Requester-scoped MCP: dynamic tools on a shared thread (never harness-native MCP).
  // Specs come from the session advertised-catalog cache so fingerprints stay stable.
  const scopedMcpTools = await materializeRequesterScopedMcpToolsForHarnessRun({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    workspaceDir: effectiveWorkspace,
    agentDir: agentDir ?? resolveAgentDir(params.config ?? {}, sessionAgentId),
    cfg: params.config,
    requesterSenderId: params.senderId,
    agentAccountId: params.agentAccountId,
    messageChannel: params.messageChannel ?? params.messageProvider,
    reservedToolNames: [
      ...tools.map((tool) => tool.name),
      ...registeredTools.map((tool) => tool.name),
    ],
    toolsAllow: params.toolsAllow,
    policyContext: {
      config: params.config,
      sessionKey: sandboxSessionKey,
      runSessionKey:
        params.sessionKey && params.sessionKey !== sandboxSessionKey
          ? params.sessionKey
          : undefined,
      sessionId: params.sessionId,
      runId: params.runId,
      agentId: sessionAgentId,
      agentDir: agentDir ?? resolveAgentDir(params.config ?? {}, sessionAgentId),
      agentAccountId: params.agentAccountId,
      messageProvider: params.messageProvider ?? params.messageChannel,
      messageChannel: params.messageChannel,
      chatType: params.chatType,
      messageTo: params.messageTo,
      messageThreadId: params.messageThreadId,
      currentChannelId: params.currentChannelId,
      currentMessagingTarget: params.currentMessagingTarget,
      currentThreadTs: params.currentThreadTs,
      currentMessageId: params.currentMessageId,
      groupId: params.groupId,
      groupChannel: params.groupChannel,
      groupSpace: params.groupSpace,
      memberRoleIds: params.memberRoleIds,
      spawnedBy: params.spawnedBy,
      senderId: params.senderId,
      senderName: params.senderName,
      senderUsername: params.senderUsername,
      senderE164: params.senderE164,
      senderIsOwner: params.senderIsOwner,
      modelProvider: params.provider,
      modelId: params.modelId,
      modelApi: params.model.api,
      modelContextWindowTokens: params.model.contextWindow,
      modelHasVision: params.model.input?.includes("image") ?? false,
      workspaceDir: effectiveWorkspace,
      cwd: effectiveCwd ?? effectiveWorkspace,
      sandboxToolPolicy: sandbox?.tools,
    },
    warn: (message) => embeddedAgentLog.warn(message),
  });
  // Restricted dynamic-tool profiles (private QA, exclusion lists) gate scoped
  // MCP tools exactly like every other dynamic tool. Filter both lists with the
  // same rule so execution and advertised specs stay name-aligned.
  const scopedExecutable = scopedMcpTools
    ? filterCodexDynamicTools(scopedMcpTools.tools, pluginConfig)
    : [];
  const scopedAdvertised = scopedMcpTools
    ? filterCodexDynamicTools(scopedMcpTools.advertisedTools, pluginConfig)
    : [];
  const toolsWithScopedMcp = scopedExecutable.length > 0 ? [...tools, ...scopedExecutable] : tools;
  const registeredWithScopedMcp =
    scopedAdvertised.length > 0 ? [...registeredTools, ...scopedAdvertised] : registeredTools;
  const toolBridge = createCodexDynamicToolBridge({
    tools: toolsWithScopedMcp,
    registeredTools: registeredWithScopedMcp,
    signal: runAbortController.signal,
    computerContextEpoch,
    loading: resolveCodexDynamicToolsLoadingForRuntime(pluginConfig, effectiveRuntimeModelId, {
      connectionClass: connection.appServer.connectionClass,
    }),
    directToolNames: resolveCodexDynamicToolDirectNames(
      params,
      isHostScopedAgentToolActive("openclaw"),
    ),
    hookContext: {
      agentId: sessionAgentId,
      config: params.config,
      contextWindowTokens: params.contextTokenBudget ?? params.model.contextWindow,
      workspaceDir: effectiveWorkspace,
      sessionId: params.sessionId,
      sessionKey: sandboxSessionKey,
      runId: params.runId,
      channelId: hookChannelId,
      currentChannelProvider: resolveCodexMessageToolProvider(params),
      currentChannelId: params.currentChannelId,
      currentMessagingTarget: params.currentMessagingTarget,
      currentMessageId: params.currentMessageId,
      currentThreadId: params.currentThreadTs,
      replyToMode: params.replyToMode,
      hasRepliedRef: params.hasRepliedRef,
      sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
      onToolOutcome: onCodexToolOutcome,
      allocateToolOutcomeOrdinal: allocateCodexToolOutcomeOrdinal,
    },
  });
  return {
    tools: toolsWithScopedMcp,
    registeredTools: registeredWithScopedMcp,
    scopedMcpTools,
    dynamicToolParams,
    computerContextEpoch,
    toolBridge,
    toolState,
    toolOutcomeOrdinals,
    suppressedDynamicToolOutcomeOrdinals,
    onCodexToolOutcome,
    allocateCodexToolOutcomeOrdinal,
  };
}

export type CodexAttemptTools = Awaited<ReturnType<typeof prepareCodexAttemptTools>>;
