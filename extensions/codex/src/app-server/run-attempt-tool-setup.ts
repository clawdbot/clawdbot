import {
  embeddedAgentLog,
  isHostScopedAgentToolActive,
  materializeRequesterScopedMcpToolsForHarnessRun,
  resolveAgentDir,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  captureFinalCodexCronCreatorToolAllowlist,
  formatMcpCodexApprovalRemedy,
  materializeStaticMcpToolsForHarnessRun,
} from "openclaw/plugin-sdk/codex-mcp-projection";
import { resolveCodexPluginsPolicy, shouldAutoApproveCodexAppServerApprovals } from "./config.js";
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
import {
  createCodexDynamicToolBridge,
  projectCodexExecutableDynamicTools,
} from "./dynamic-tools.js";
import { hasCodexNativeToolCatalog, loadCodexNativeToolCatalog } from "./native-tool-catalog.js";
import { CodexCompactionPlanState } from "./plan-compaction-state.js";
import {
  requestPluginApprovalOutcome,
  type ExecApprovalDecision,
} from "./plugin-approval-roundtrip.js";
import type { CodexDynamicToolSpec } from "./protocol.js";
import { emitCodexAppServerEvent } from "./run-attempt-lifecycle.js";
import type { CodexAttemptRuntime } from "./run-attempt-runtime.js";
import { resolveCodexDynamicToolDirectNames } from "./run-attempt-tools.js";
import {
  buildScheduledCodexAppServerConnectionIdentity,
  captureScheduledCodexAppAuthority,
  resolveScheduledCodexAppCreatorCaptureDecision,
} from "./scheduled-app-authority.js";
import { releaseLeasedSharedCodexAppServerClient } from "./shared-client.js";

function isAuthorityResolutionOperationAbort(error: unknown, signal: AbortSignal | undefined) {
  return signal?.aborted === true && error === signal.reason;
}

export async function prepareCodexAttemptTools(runtime: CodexAttemptRuntime) {
  const {
    connection,
    bundleMcpThreadConfig,
    bundleManifestRegistry,
    runtimeParams,
    effectiveRuntimeModelId,
    nativeToolSurfaceEnabled,
    nativeProviderWebSearchSupport,
    hookChannelId,
    codexMcpToolOverrides,
    authenticatedScheduledMode,
    configuredMcpSurface,
    canResolveScheduledConfiguredMcpCreatorAuthority,
  } = runtime;
  const {
    params,
    preDynamicStartupStages,
    mutable,
    resolvedWorkspace,
    effectiveWorkspace,
    effectiveCwd,
    sandboxSessionKey,
    contextSessionKey,
    sandbox,
    sessionPermissionPolicy,
    runAbortController,
    sessionAgentId,
    policyAgentId,
    pluginConfig,
    profilerEnabled,
    agentDir,
  } = connection;
  const preDynamicSummary = preDynamicStartupStages.snapshot();
  if (shouldWarnCodexDynamicToolBuildStageSummary(preDynamicSummary, profilerEnabled)) {
    embeddedAgentLog.warn(
      `codex app-server pre-dynamic startup timings runId=${params.runId} sessionId=${params.sessionId} totalMs=${preDynamicSummary.totalMs} stages=${formatCodexDynamicToolBuildStageSummary(preDynamicSummary)}`,
      {
        runId: params.runId,
        sessionId: params.sessionId,
        totalMs: preDynamicSummary.totalMs,
        stages: preDynamicSummary.stages,
        hasStartupBinding: Boolean(mutable.startupBinding?.threadId),
        bundleMcpDiagnosticCount: bundleMcpThreadConfig.diagnostics.length,
        nativeToolSurfaceEnabled,
      },
    );
  }
  const toolState: {
    yieldDetected: boolean;
    yieldAcknowledgment?: string;
    persistentWebSearchAllowed?: boolean;
    webSearchAllowed: boolean;
  } = {
    yieldDetected: false,
    yieldAcknowledgment: undefined,
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
  const compactionPlanState = new CodexCompactionPlanState();
  const dynamicToolParams = {
    ...runtimeParams,
    onAgentEvent: (event: Parameters<NonNullable<EmbeddedRunAttemptParams["onAgentEvent"]>>[0]) => {
      compactionPlanState.record(event);
      return runtimeParams.onAgentEvent?.(event);
    },
    ...(allocateCodexToolOutcomeOrdinal
      ? { allocateToolOutcomeOrdinal: allocateCodexToolOutcomeOrdinal }
      : {}),
    ...(onCodexToolOutcome ? { onToolOutcome: onCodexToolOutcome } : {}),
  };
  const computerContextEpoch: {
    value: number;
    frameToolCallId?: string;
    frameImageIdentity?: string;
  } = { value: 0 };
  const runCleanups: Array<(reason: string) => Promise<void>> = [];
  const cronCreatorToolAllowlist: Array<string | { name: string; pluginId?: string }> = [];
  const cronCreatorToolAllowlistCaptureRef: {
    value?: { version: 1; source: "final-executable-surface" };
  } = {};
  const scheduledAppAuthoritySourceRef: {
    current?: Omit<Parameters<typeof captureScheduledCodexAppAuthority>[0], "auth">;
  } = {};
  const preparedChatgptAuth =
    connection.startupPreparedAuth?.kind === "profile" &&
    connection.startupPreparedAuth.snapshot?.loginParams.type === "chatgptAuthTokens" &&
    connection.startupPreparedAuth.snapshot.chatgptAccountId
      ? {
          kind: "prepared-profile" as const,
          profileId: connection.startupPreparedAuth.profileId,
          accountId: connection.startupPreparedAuth.snapshot.chatgptAccountId,
        }
      : undefined;
  const configuredAppServerAuth =
    !preparedChatgptAuth && connection.appServer.start.transport !== "stdio"
      ? {
          kind: "configured-app-server" as const,
          connectionFingerprint: buildScheduledCodexAppServerConnectionIdentity(
            connection.appServer,
          ),
        }
      : undefined;
  const scheduledCodexAppAuth = preparedChatgptAuth ?? configuredAppServerAuth;
  const appPolicy = resolveCodexPluginsPolicy(pluginConfig);
  const codexAppsMayBeVisible =
    appPolicy.enabled &&
    (appPolicy.allowAllPlugins || appPolicy.pluginPolicies.some((entry) => entry.enabled));
  const appCreatorCapture = resolveScheduledCodexAppCreatorCaptureDecision({
    appsMayBeVisible: codexAppsMayBeVisible,
    authenticatedScheduledMode,
    usesSupervisionConnection: connection.usesSupervisionConnection,
    homeScope: connection.appServer.start.homeScope,
    hasPreparedAccountIdentity: Boolean(preparedChatgptAuth),
    hasConfiguredAppServerIdentity: Boolean(configuredAppServerAuth),
  });
  const codexAppAuthorityUnavailableReason = appCreatorCapture.unavailableReason;
  const canResolveScheduledCodexAppAuthority = appCreatorCapture.supported;
  const requiresScheduledCodexAppAuthority = appCreatorCapture.required;
  const canResolveAnyScheduledCreatorAuthority =
    canResolveScheduledConfiguredMcpCreatorAuthority || requiresScheduledCodexAppAuthority;
  let creatorAuthorityPromise:
    | Promise<{
        tools: readonly (string | { name: string; pluginId?: string })[];
        provenance: { version: 1; source: "final-executable-surface" };
        runtimeAuthority?: NonNullable<EmbeddedRunAttemptParams["scheduledRuntimeAuthority"]>;
      }>
    | undefined;
  let resolveCreatorAuthorityImpl:
    | ((options?: { signal?: AbortSignal }) => Promise<{
        tools: readonly (string | { name: string; pluginId?: string })[];
        provenance: { version: 1; source: "final-executable-surface" };
        runtimeAuthority?: NonNullable<EmbeddedRunAttemptParams["scheduledRuntimeAuthority"]>;
      }>)
    | undefined;
  const runtimeYieldCompletionClaim: { current?: () => boolean } = {};
  const commonToolParams = {
    // Both catalogs describe one attempt; a later attempt discovers fresh connections.
    nodeExecAvailability: {},
    params: dynamicToolParams,
    resolvedWorkspace,
    effectiveWorkspace,
    effectiveCwd,
    sandboxSessionKey,
    sandbox,
    sessionPermissionPolicy,
    nativeToolSurfaceEnabled,
    nativeProviderWebSearchSupport,
    runAbortController,
    sessionAgentId,
    policyAgentId,
    pluginConfig,
    profilerEnabled,
    ...(params.cronCreatorAuthorityUnavailableReason === "queued-local-operator" &&
    bundleMcpThreadConfig.staticServerNames.length > 0
      ? {
          cronCreatorAuthorityUnavailableReason: "queued-local-operator-configured-mcp" as const,
        }
      : {}),
    onYieldDetected: (acknowledgment: string | undefined) => {
      toolState.yieldDetected = true;
      toolState.yieldAcknowledgment = acknowledgment;
    },
    claimYieldCompletion: () => runtimeYieldCompletionClaim.current?.() ?? false,
    onCodexAppServerEvent: (event: Parameters<typeof emitCodexAppServerEvent>[1]) => {
      void emitCodexAppServerEvent(params, event);
    },
    computerContextEpoch,
    ...(canResolveAnyScheduledCreatorAuthority
      ? {
          resolveCronCreatorToolAuthority: (options?: { signal?: AbortSignal }) => {
            if (!resolveCreatorAuthorityImpl) {
              throw new Error("configured MCP authority resolver was invoked before tool setup");
            }
            options?.signal?.throwIfAborted();
            if (creatorAuthorityPromise) {
              return creatorAuthorityPromise;
            }
            const pending = resolveCreatorAuthorityImpl(options);
            creatorAuthorityPromise = pending;
            void pending.catch((error: unknown) => {
              // A tool-call timeout does not poison later cron mutations in the
              // same live turn. Substantive discovery/auth/policy failures stay cached.
              if (
                creatorAuthorityPromise === pending &&
                isAuthorityResolutionOperationAbort(error, options?.signal)
              ) {
                creatorAuthorityPromise = undefined;
              }
            });
            return pending;
          },
        }
      : {}),
  };
  let nativeSpecs: CodexDynamicToolSpec[] | undefined;
  if (hasCodexNativeToolCatalog(mutable.startupBinding)) {
    runAbortController.signal.throwIfAborted();
    params.hostCapabilities.assertActive();
    const client = await connection.attemptClientFactory({
      startOptions: connection.appServer.start,
      authProfileId: connection.startupClientAuthProfileId,
      agentDir,
      config: params.config,
      timeoutMs: connection.appServer.requestTimeoutMs,
    });
    try {
      nativeSpecs = await loadCodexNativeToolCatalog({
        client,
        binding: mutable.startupBinding,
        appServer: connection.appServer,
        agentDir,
        assertCurrent: () => {
          runAbortController.signal.throwIfAborted();
          params.hostCapabilities.assertActive();
        },
      });
    } finally {
      releaseLeasedSharedCodexAppServerClient(client);
    }
  }
  const tools = await buildDynamicTools({
    ...commonToolParams,
    registerRunCleanup: (cleanup) => runCleanups.push(cleanup),
    cronCreatorToolAllowlistRef: cronCreatorToolAllowlist,
    cronCreatorToolAllowlistCaptureRef,
    onPersistentWebSearchPolicyResolved: (allowed) => {
      toolState.persistentWebSearchAllowed = allowed;
    },
    onWebSearchPolicyResolved: (allowed) => {
      toolState.webSearchAllowed = allowed;
    },
  });
  const registeredTools = nativeSpecs
    ? []
    : await buildDynamicTools({
        ...commonToolParams,
        forceHeartbeatTool: true,
        ignoreDisableMessageTool: true,
        ignoreRuntimePlan: true,
      });
  const policyContext = {
    config: params.config,
    sessionKey: sandboxSessionKey,
    runSessionKey:
      params.sessionKey && params.sessionKey !== sandboxSessionKey ? params.sessionKey : undefined,
    sessionId: params.sessionId,
    runId: params.runId,
    agentId: policyAgentId,
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
    conversationToolPolicy: params.conversationToolPolicy,
    inputProvenance: params.inputProvenance,
    trustedInternalHandoff: params.trustedInternalHandoff,
    scheduledToolPolicy: params.scheduledToolPolicy,
  };
  const reservedToolNames = [
    ...tools.map((tool) => tool.name),
    ...registeredTools.map((tool) => tool.name),
  ];
  const turnSourceChannel = params.messageChannel ?? params.messageProvider;
  const turnSourceTo = params.currentMessagingTarget ?? params.currentChannelId;
  const requester = {
    ...(turnSourceChannel ? { channel: turnSourceChannel } : {}),
    ...(params.agentAccountId ? { accountId: params.agentAccountId } : {}),
    ...(params.senderId ? { senderId: params.senderId } : {}),
    ...(params.senderIsOwner !== undefined ? { senderIsOwner: params.senderIsOwner } : {}),
    ...(params.memberRoleIds?.length ? { roleIds: [...params.memberRoleIds] } : {}),
  };
  const hasRequester = Object.keys(requester).length > 0;
  const configuredMcp = configuredMcpSurface
    ? await materializeStaticMcpToolsForHarnessRun({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        agentId: sessionAgentId,
        workspaceDir: effectiveWorkspace,
        agentDir: policyContext.agentDir,
        cfg: params.config,
        manifestRegistry: bundleManifestRegistry,
        reservedToolNames,
        toolsAllow: params.toolsAllow,
        toolOverrides: codexMcpToolOverrides,
        autoApproveCodexAppServerApprovals: shouldAutoApproveCodexAppServerApprovals(
          connection.appServer,
        ),
        projectedMcpServers: bundleMcpThreadConfig.configPatch?.mcp_servers,
        ...(configuredMcpSurface === "transient"
          ? {
              requestInteractiveCodexApproval: async (approval) => {
                const allowedDecisions: ExecApprovalDecision[] =
                  approval.mode === "prompt"
                    ? ["allow-once", "deny"]
                    : ["allow-once", "allow-always", "deny"];
                const outcome = await requestPluginApprovalOutcome({
                  hostCapabilities: params.hostCapabilities,
                  signal: approval.signal,
                  title: `Run MCP tool ${approval.serverName}/${approval.toolName}`,
                  description: `Codex approval mode "${approval.mode}" requires an operator decision before this MCP tool runs. ${formatMcpCodexApprovalRemedy(approval.serverName)}`,
                  allowedDecisions,
                  toolName: approval.safeToolName,
                  toolCallId: approval.toolCallId,
                  mcpTool: { server: approval.serverName, tool: approval.toolName },
                  isMcpToolApprovalActive: approval.isActive,
                });
                if (outcome !== "approved-once" && outcome !== "approved-session") {
                  throw new Error(
                    `${approval.serverName}/${approval.toolName}: interactive Codex approval (${approval.mode}) was not granted: ${outcome}`,
                  );
                }
              },
            }
          : {}),
        policyContext,
        warn: (message) => embeddedAgentLog.warn(message),
      })
    : undefined;
  // Requester-scoped MCP: dynamic tools on a shared thread (never harness-native MCP).
  // Specs come from the session advertised-catalog cache so fingerprints stay stable.
  let scopedMcpTools: Awaited<ReturnType<typeof materializeRequesterScopedMcpToolsForHarnessRun>> =
    undefined;
  try {
    scopedMcpTools = authenticatedScheduledMode
      ? undefined
      : await materializeRequesterScopedMcpToolsForHarnessRun({
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          workspaceDir: effectiveWorkspace,
          agentDir: policyContext.agentDir,
          cfg: params.config,
          manifestRegistry: bundleManifestRegistry,
          toolOverrides: codexMcpToolOverrides,
          requesterSenderId: params.senderId,
          agentAccountId: params.agentAccountId,
          messageChannel: params.messageChannel ?? params.messageProvider,
          reservedToolNames: [
            ...reservedToolNames,
            ...(configuredMcp?.tools.map((tool) => tool.name) ?? []),
          ],
          toolsAllow: params.toolsAllow,
          policyContext,
          warn: (message) => embeddedAgentLog.warn(message),
        });
    // Restricted dynamic-tool profiles (private QA, exclusion lists) gate scoped
    // MCP tools exactly like every other dynamic tool. Filter both lists with the
    // same rule so execution and advertised specs stay name-aligned.
    const scopedExecutable = filterCodexDynamicTools(
      [...(configuredMcp?.tools ?? []), ...(scopedMcpTools?.tools ?? [])],
      pluginConfig,
    );
    const scopedAdvertised = filterCodexDynamicTools(
      [...(configuredMcp?.tools ?? []), ...(scopedMcpTools?.advertisedTools ?? [])],
      pluginConfig,
    );
    const toolsWithScopedMcp =
      scopedExecutable.length > 0 ? [...tools, ...scopedExecutable] : tools;
    const registeredWithScopedMcp =
      scopedAdvertised.length > 0 ? [...registeredTools, ...scopedAdvertised] : registeredTools;
    const hookContext = {
      agentId: sessionAgentId,
      config: params.config,
      contextWindowTokens: params.contextTokenBudget ?? params.model.contextWindow,
      workspaceDir: effectiveWorkspace,
      remoteWorkspaceRoot: connection.appServer.remoteWorkspaceRoot,
      remoteWorkspaceRequestTimeoutMs: connection.appServer.requestTimeoutMs,
      sessionId: params.sessionId,
      sessionKey: contextSessionKey,
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
      trigger: params.trigger,
      approvalReviewerDeviceId: params.approvalReviewerDeviceId,
      ...(hasRequester ? { requester } : {}),
      ...(turnSourceChannel ? { turnSourceChannel } : {}),
      ...(turnSourceTo ? { turnSourceTo } : {}),
      ...(params.agentAccountId ? { turnSourceAccountId: params.agentAccountId } : {}),
      ...(params.currentThreadTs !== undefined
        ? { turnSourceThreadId: params.currentThreadTs }
        : {}),
    };
    const toolBridge = createCodexDynamicToolBridge({
      tools: toolsWithScopedMcp,
      registeredTools: registeredWithScopedMcp,
      registeredSpecs: nativeSpecs,
      signal: runAbortController.signal,
      computerContextEpoch,
      loading: resolveCodexDynamicToolsLoadingForRuntime(pluginConfig, effectiveRuntimeModelId, {
        connectionClass: connection.appServer.connectionClass,
      }),
      directToolNames: resolveCodexDynamicToolDirectNames(
        params,
        isHostScopedAgentToolActive("openclaw"),
      ),
      hookContext,
    });
    const captureCronCreatorToolAllowlist = async () => {
      await captureFinalCodexCronCreatorToolAllowlist(
        cronCreatorToolAllowlist,
        cronCreatorToolAllowlistCaptureRef,
        toolBridge.availableTools,
        { nativeToolSurfaceEnabled },
      );
      if (
        !authenticatedScheduledMode &&
        bundleMcpThreadConfig.staticServerNames.length > 0 &&
        !canResolveScheduledConfiguredMcpCreatorAuthority
      ) {
        // Native configured MCP is model-visible but absent from this dynamic-tool list.
        // Keep the names for finite intersections, but never certify a partial default cap.
        delete cronCreatorToolAllowlistCaptureRef.value;
      }
      if (requiresScheduledCodexAppAuthority) {
        // Native apps are not represented in the OpenClaw dynamic-tool list.
        // Require the exact-thread resolver before certifying a default cap.
        delete cronCreatorToolAllowlistCaptureRef.value;
      }
    };
    if (canResolveAnyScheduledCreatorAuthority) {
      resolveCreatorAuthorityImpl = async (options) => {
        options?.signal?.throwIfAborted();
        if (codexAppAuthorityUnavailableReason) {
          throw new Error(codexAppAuthorityUnavailableReason);
        }
        const appSource = scheduledAppAuthoritySourceRef.current;
        const runtimeAuthority =
          canResolveScheduledCodexAppAuthority && scheduledCodexAppAuth
            ? appSource
              ? await captureScheduledCodexAppAuthority({
                  ...appSource,
                  auth: scheduledCodexAppAuth,
                  signal: options?.signal,
                })
              : (() => {
                  throw new Error(
                    "Codex app authority is unavailable before the exact creator thread is active. Retry this automation mutation from the current owner turn.",
                  );
                })()
            : undefined;
        let materialized:
          | Awaited<ReturnType<typeof materializeStaticMcpToolsForHarnessRun>>
          | undefined;
        try {
          if (canResolveScheduledConfiguredMcpCreatorAuthority) {
            try {
              materialized = await materializeStaticMcpToolsForHarnessRun({
                sessionId: `cron-authority:${params.runId}`,
                agentId: sessionAgentId,
                workspaceDir: effectiveWorkspace,
                agentDir: policyContext.agentDir,
                cfg: params.config,
                manifestRegistry: bundleManifestRegistry,
                reservedToolNames: toolBridge.availableTools.map((tool) => tool.name),
                toolsAllow: params.toolsAllow,
                toolOverrides: codexMcpToolOverrides,
                autoApproveCodexAppServerApprovals: shouldAutoApproveCodexAppServerApprovals(
                  connection.appServer,
                ),
                projectedMcpServers: bundleMcpThreadConfig.configPatch?.mcp_servers,
                policyContext,
                warn: (message) => embeddedAgentLog.warn(message),
                retireSessionRuntimeAfterDispose: true,
              });
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error);
              throw new Error(
                `Configured MCP discovery failed while resolving inherited automation authority: ${detail}. Retry after the server is available, or provide an explicit finite toolsAllow list containing only currently visible tools; no automation changes were saved.`,
                { cause: error },
              );
            }
          }
          options?.signal?.throwIfAborted();
          if (materialized?.diagnosticNotice) {
            throw new Error(
              `${materialized.diagnosticNotice} Sign in to the affected MCP server and retry, or provide an explicit finite toolsAllow list containing only currently visible tools. No automation changes were saved.`,
            );
          }
          // App-only projections gate view callbacks, never headless scheduled capability.
          const configuredTools = materialized
            ? projectCodexExecutableDynamicTools({
                tools: filterCodexDynamicTools(materialized.tools, pluginConfig),
                hookContext,
              }).availableTools
            : [];
          const authorityTools: typeof cronCreatorToolAllowlist = [];
          const captureRef: typeof cronCreatorToolAllowlistCaptureRef = {};
          await captureFinalCodexCronCreatorToolAllowlist(
            authorityTools,
            captureRef,
            [...toolBridge.availableTools, ...configuredTools],
            { nativeToolSurfaceEnabled },
          );
          if (!captureRef.value) {
            throw new Error("cron creator authority snapshot did not produce provenance");
          }
          options?.signal?.throwIfAborted();
          return Object.freeze({
            tools: Object.freeze(authorityTools.map((entry) => Object.freeze(entry))),
            provenance: Object.freeze(captureRef.value),
            ...(runtimeAuthority ? { runtimeAuthority } : {}),
          });
        } finally {
          await materialized?.dispose();
        }
      };
    }
    return {
      tools: toolsWithScopedMcp,
      registeredTools: registeredWithScopedMcp,
      scopedMcpTools,
      configuredMcp,
      configuredMcpOwnershipVersion:
        configuredMcpSurface === "scheduled" ? (1 as const) : undefined,
      captureCronCreatorToolAllowlist,
      scheduledAppAuthoritySourceRef,
      dynamicToolParams,
      compactionPlanState,
      computerContextEpoch,
      runCleanups,
      toolBridge,
      toolState,
      toolOutcomeOrdinals,
      suppressedDynamicToolOutcomeOrdinals,
      onCodexToolOutcome,
      allocateCodexToolOutcomeOrdinal,
      runtimeYieldCompletionClaim,
    };
  } catch (error) {
    // Materialized runtimes are attempt-owned only after this function returns.
    // Dispose here when filtering, schema projection, or bridge setup fails first.
    await scopedMcpTools?.dispose();
    await configuredMcp?.dispose();
    throw error;
  }
}

export type CodexAttemptTools = Awaited<ReturnType<typeof prepareCodexAttemptTools>>;
