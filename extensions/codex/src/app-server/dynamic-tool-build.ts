/**
 * Builds the Codex app-server dynamic tool list for one turn, including
 * OpenClaw-owned tools, Codex native-tool fallback rules, sandbox shell shims,
 * and provider allowlist normalization.
 */
import {
  buildAgentHookContextChannelFields,
  buildEmbeddedAttemptToolRunContext,
  embeddedAgentLog,
  filterProviderNormalizableTools,
  isHostScopedAgentToolActive,
  isSubagentSessionKey,
  normalizeAgentRuntimeTools,
  resolveAttemptSpawnWorkspaceDir,
  resolveModelAuthMode,
  resolveSandboxContext,
  supportsModelTools,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
  type RuntimeToolSchemaDiagnostic,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import {
  resolveCodexScheduledToolProjectionFactory,
  runWithCronCreatorAuthorityCapabilityResolver,
} from "openclaw/plugin-sdk/codex-mcp-projection";
import { isToolAllowed } from "openclaw/plugin-sdk/sandbox";
import {
  isCodexRemoteExecPlacementSandbox,
  readCodexPluginConfig,
  type CodexPluginConfig,
} from "./config.js";
import { dynamicToolBuildState } from "./dynamic-tool-build-state.js";
import {
  filterCodexDynamicTools,
  filterCodexDynamicToolsForDisabledNativeSurface,
  isForcedPrivateQaCodexRuntime,
  isSystemAgentOnlyCodexDynamicToolAllowlist,
  normalizeCodexDynamicToolName,
} from "./dynamic-tool-profile.js";
import {
  resolveCodexNodeExecToolOverrides,
  resolveCodexNativeExecutionPolicy,
  type CodexNativeExecutionPolicy,
} from "./native-execution-policy.js";
import type { CodexSandboxPolicy, CodexTurnEnvironmentParams } from "./protocol.js";
import { mapCodexAppServerRemoteWorkspacePath } from "./remote-workspace-path.js";
import type { CodexSandboxExecEnvironment } from "./sandbox-exec-server.js";
import type { CodexEffectiveSessionPermissionPolicy } from "./session-permission-policy.js";
import {
  CODEX_GATEWAY_EXEC_DYNAMIC_TOOL_NAME,
  CODEX_GATEWAY_PROCESS_DYNAMIC_TOOL_NAME,
  CODEX_NODE_EXEC_DYNAMIC_TOOL_NAME,
  createGatewayExecProjection,
  createGatewayProcessProjection,
  createNodeExecAliasDynamicTool,
  isCodexDynamicToolExcluded,
} from "./shell-dynamic-tools.js";
import { filterCodexVisionTools } from "./vision-tools.js";
import { resolveCodexWebSearchPlan, type CodexNativeWebSearchSupport } from "./web-search.js";

type OpenClawCodingToolsOptions = NonNullable<
  Parameters<(typeof import("openclaw/plugin-sdk/agent-harness"))["createOpenClawCodingTools"]>[0]
>;

/** Factory seam for constructing OpenClaw runtime tools without eagerly loading agent-harness. */
type OpenClawCodingToolsFactory =
  (typeof import("openclaw/plugin-sdk/agent-harness"))["createOpenClawCodingTools"];
type OpenClawDynamicTool = ReturnType<OpenClawCodingToolsFactory>[number];
type OpenClawSandboxContext = Awaited<ReturnType<typeof resolveSandboxContext>>;
type CodexDynamicToolBuildEvent = Parameters<
  NonNullable<EmbeddedRunAttemptParams["onAgentEvent"]>
>[0];
const CODEX_NATIVE_SANDBOX_TOOL_REQUIREMENTS = [
  "exec",
  "process",
  "read",
  "write",
  "edit",
  "apply_patch",
] as const;
const CODEX_MEMORY_FLUSH_DYNAMIC_TOOL_ALLOW = new Set(["read", "write"]);

/** Keeps node filesystem and process ownership on its native exec-server. */
export function resolveCodexNodePlacementToolConstructionPlan(
  sandbox: OpenClawSandboxContext | undefined,
  nativeToolSurfaceEnabled: boolean | undefined,
): OpenClawCodingToolsOptions["toolConstructionPlan"] {
  if (
    !isCodexRemoteExecPlacementSandbox(sandbox) ||
    sandbox?.backendId !== "node" ||
    !("placementNodeId" in sandbox) ||
    typeof sandbox.placementNodeId !== "string" ||
    !sandbox.placementNodeId
  ) {
    return undefined;
  }
  if (!nativeToolSurfaceEnabled) {
    throw new Error(
      "Codex node execution requires its native exec-server tool surface; adjust the session tool policy and start a fresh attempt.",
    );
  }
  return {
    includeBaseCodingTools: false,
    includeShellTools: false,
    includeChannelTools: true,
    includeOpenClawTools: true,
    includePluginTools: true,
  };
}

function preserveRingZeroSystemAgentTool<T extends { name: string; catalogMode?: string }>(
  allTools: T[],
  filteredTools: T[],
): T[] {
  const openclaw = allTools.find(
    (tool) => tool.name === "openclaw" && tool.catalogMode === "direct-only",
  );
  if (!openclaw) {
    return filteredTools;
  }
  return [openclaw, ...filteredTools.filter((tool) => tool.name !== "openclaw")];
}
/** Runtime inputs needed to derive the exact Codex dynamic tool surface for a turn. */
type DynamicToolBuildParams = {
  params: EmbeddedRunAttemptParams;
  resolvedWorkspace: string;
  effectiveWorkspace: string;
  effectiveCwd?: string;
  sandboxSessionKey: string;
  sandbox: OpenClawSandboxContext;
  sessionPermissionPolicy?: CodexEffectiveSessionPermissionPolicy;
  nativeToolSurfaceEnabled?: boolean;
  nativeProviderWebSearchSupport?: CodexNativeWebSearchSupport;
  runAbortController: AbortController;
  sessionAgentId: string;
  policyAgentId: string;
  pluginConfig: CodexPluginConfig;
  profilerEnabled?: boolean;
  cronCreatorToolAllowlistRef?: OpenClawCodingToolsOptions["cronCreatorToolAllowlistRef"];
  cronCreatorToolAllowlistCaptureRef?: OpenClawCodingToolsOptions["cronCreatorToolAllowlistCaptureRef"];
  resolveCronCreatorToolAuthority?: Parameters<
    typeof runWithCronCreatorAuthorityCapabilityResolver
  >[0]["resolve"];
  cronCreatorAuthorityUnavailableReason?: OpenClawCodingToolsOptions["cronCreatorAuthorityUnavailableReason"];
  forceHeartbeatTool?: boolean;
  ignoreDisableMessageTool?: boolean;
  ignoreRuntimePlan?: boolean;
  /** Host fact resolver; injectable only for focused plugin contract tests. */
  isHostScopedToolActive?: (toolName: string) => boolean;
  onYieldDetected: (acknowledgment?: string) => void;
  claimYieldCompletion?: OpenClawCodingToolsOptions["claimYieldCompletion"];
  onCodexAppServerEvent?: (event: CodexDynamicToolBuildEvent) => void;
  onPersistentWebSearchPolicyResolved?: (allowed: boolean) => void;
  onWebSearchPolicyResolved?: (allowed: boolean) => void;
  computerContextEpoch?: {
    value: number;
    frameToolCallId?: string;
    frameImageIdentity?: string;
  };
  registerRunCleanup?: OpenClawCodingToolsOptions["registerRunCleanup"];
};
/** Returns the canonical channel used for Codex message routing and receipts. */
export function resolveCodexMessageToolProvider(
  params: Pick<EmbeddedRunAttemptParams, "messageChannel" | "messageProvider">,
): string | undefined {
  return params.messageChannel ?? params.messageProvider;
}
/** Resolves the channel id that hook events should target for this Codex app-server turn. */
export function resolveCodexAppServerHookChannelId(
  params: EmbeddedRunAttemptParams,
  sandboxSessionKey: string,
): string | undefined {
  return buildAgentHookContextChannelFields({
    sessionKey: sandboxSessionKey,
    messageChannel: params.messageChannel,
    messageProvider: params.messageProvider,
    currentChannelId: params.currentChannelId,
    messageTo: params.messageTo,
  }).channelId;
}
type CodexDynamicToolBuildStageTiming = {
  name: string;
  durationMs: number;
  elapsedMs: number;
};
type CodexDynamicToolBuildStageSummary = {
  totalMs: number;
  stages: CodexDynamicToolBuildStageTiming[];
};
const CODEX_DYNAMIC_TOOL_BUILD_WARN_TOTAL_MS = 1_000;
const CODEX_DYNAMIC_TOOL_BUILD_WARN_STAGE_MS = 500;
/** Creates cheap optional timing instrumentation for the dynamic-tool hot path. */
export function createCodexDynamicToolBuildStageTracker(options: { enabled?: boolean } = {}): {
  mark: (name: string) => void;
  snapshot: () => CodexDynamicToolBuildStageSummary;
} {
  if (!options.enabled) {
    return {
      mark() {},
      snapshot() {
        return { totalMs: 0, stages: [] };
      },
    };
  }
  const startedAt = Date.now();
  let previousAt = startedAt;
  const stages: CodexDynamicToolBuildStageTiming[] = [];
  const toMs = (value: number) => Math.max(0, Math.round(value));
  return {
    mark(name) {
      const currentAt = Date.now();
      stages.push({
        name,
        durationMs: toMs(currentAt - previousAt),
        elapsedMs: toMs(currentAt - startedAt),
      });
      previousAt = currentAt;
    },
    snapshot() {
      return {
        totalMs: toMs(Date.now() - startedAt),
        stages: stages.slice(),
      };
    },
  };
}
/** Returns true when dynamic-tool construction is slow enough to warrant a warning log. */
export function shouldWarnCodexDynamicToolBuildStageSummary(
  summary: CodexDynamicToolBuildStageSummary,
): boolean {
  return (
    summary.totalMs >= CODEX_DYNAMIC_TOOL_BUILD_WARN_TOTAL_MS ||
    summary.stages.some((stage) => stage.durationMs >= CODEX_DYNAMIC_TOOL_BUILD_WARN_STAGE_MS)
  );
}
/** Formats per-stage timings into the compact form used by Codex app-server logs. */
export function formatCodexDynamicToolBuildStageSummary(
  summary: CodexDynamicToolBuildStageSummary,
): string {
  return summary.stages.length > 0
    ? summary.stages
        .map((stage) => `${stage.name}:${stage.durationMs}ms@${stage.elapsedMs}ms`)
        .join(",")
    : "none";
}
/** Builds, filters, and normalizes Codex-compatible runtime tools for a single turn. */
export async function buildDynamicTools(input: DynamicToolBuildParams) {
  const { params } = input;
  const messagePolicyParams = input.ignoreDisableMessageTool
    ? { ...params, disableMessageTool: false }
    : params;
  const toolRunContext = buildEmbeddedAttemptToolRunContext({
    ...params,
    forceMessageTool: shouldForceMessageTool(messagePolicyParams),
  });
  if (params.disableTools) {
    input.onWebSearchPolicyResolved?.(false);
    return [];
  }
  if (!supportsModelTools(params.model)) {
    input.onPersistentWebSearchPolicyResolved?.(false);
    input.onWebSearchPolicyResolved?.(false);
    return [];
  }
  // Dynamic tool construction is on the reply hot path, so per-stage
  // Date.now/span bookkeeping runs only when the Codex profiler flag is set.
  const toolBuildStages = createCodexDynamicToolBuildStageTracker({
    enabled: input.profilerEnabled,
  });
  const modelHasVision = params.model.input?.includes("image") ?? false;
  const agentDir = params.agentDir ?? resolveAgentDir(params.config ?? {}, input.sessionAgentId);
  const injectedOpenClawCodingToolsFactory = dynamicToolBuildState.openClawCodingToolsFactory;
  const nativeExecutionPolicy = resolveCodexNativeExecutionPolicyForRun(params, {
    agentId: input.policyAgentId,
    runtimeSessionKey: input.sandboxSessionKey,
    sandbox: input.sandbox,
  });
  const webSearchPlan = resolveCodexWebSearchPlan({
    config: params.config,
    disableTools: params.disableTools,
    nativeToolSurfaceEnabled: input.nativeToolSurfaceEnabled,
    nativeProviderWebSearchSupport: input.nativeProviderWebSearchSupport,
  });
  const webFetchHostnameAllowlistRef: { value?: string[] } = {};
  const buildOpenClawCodingTools = () => {
    const toolConstructionPlan = resolveCodexNodePlacementToolConstructionPlan(
      input.sandbox,
      input.nativeToolSurfaceEnabled,
    );
    const options: OpenClawCodingToolsOptions = {
      agentId: input.sessionAgentId,
      policyAgentId: input.policyAgentId,
      ...toolRunContext,
      exec: {
        ...params.execOverrides,
        ...(input.sessionPermissionPolicy ? { mode: input.sessionPermissionPolicy.execMode } : {}),
        ...resolveCodexNodeExecToolOverrides(nativeExecutionPolicy),
        config: params.config,
        elevated: params.bashElevated,
      },
      sessionPermissionPolicy: input.sessionPermissionPolicy
        ? { mode: input.sessionPermissionPolicy.mode, root: input.sessionPermissionPolicy.root }
        : undefined,
      sandbox: input.sandbox,
      ...(toolConstructionPlan ? { toolConstructionPlan } : {}),
      messageProvider: resolveCodexMessageToolProvider(params),
      toolPolicyMessageProvider: params.messageProvider ?? params.messageChannel,
      // Capability-gated tools (requiredClientCaps) need the originating client's
      // declared caps in this sibling harness too, not only the embedded runner.
      clientCaps: params.clientCaps,
      chatType: params.chatType,
      agentAccountId: params.agentAccountId,
      messageTo: params.messageTo,
      messageThreadId: params.messageThreadId,
      nativeChannelId: params.chatId,
      messageActionTurnCapability: params.messageActionTurnCapability,
      groupId: params.groupId,
      groupChannel: params.groupChannel,
      groupSpace: params.groupSpace,
      spawnedBy: params.spawnedBy,
      senderId: params.senderId,
      senderName: params.senderName,
      senderUsername: params.senderUsername,
      senderE164: params.senderE164,
      senderIsOwner: params.senderIsOwner,
      inputProvenance: params.inputProvenance,
      trustedInternalHandoff: params.trustedInternalHandoff,
      scheduledToolPolicy: params.scheduledToolPolicy,
      allowGatewaySubagentBinding:
        params.allowGatewaySubagentBinding || isForcedPrivateQaCodexRuntime(),
      sessionKey: input.sandboxSessionKey,
      runSessionKey:
        params.sessionKey && params.sessionKey !== input.sandboxSessionKey
          ? params.sessionKey
          : undefined,
      sessionId: params.sessionId,
      runId: params.runId,
      approvalReviewerDeviceId: params.approvalReviewerDeviceId,
      agentDir,
      preparedModelRuntime: params.preparedModelRuntime,
      cwd: input.effectiveCwd ?? input.effectiveWorkspace,
      workspaceDir: input.effectiveWorkspace,
      spawnWorkspaceDir:
        input.effectiveCwd && input.effectiveCwd !== input.effectiveWorkspace
          ? input.resolvedWorkspace
          : resolveAttemptSpawnWorkspaceDir({
              sandbox: input.sandbox,
              resolvedWorkspace: input.resolvedWorkspace,
            }),
      config: params.config,
      githubPublicationAvailable: params.githubPublicationAvailable,
      authProfileStore: params.toolAuthProfileStore ?? params.authProfileStore,
      abortSignal: input.runAbortController.signal,
      emitBeforeToolCallDiagnostics: false,
      modelProvider: params.model.provider,
      modelId: params.modelId,
      modelCompat:
        params.model.compat && typeof params.model.compat === "object"
          ? (params.model.compat as OpenClawCodingToolsOptions["modelCompat"])
          : undefined,
      modelApi: params.model.api,
      modelContextWindowTokens: params.model.contextWindow,
      delegationCapability: params.delegationCapability,
      modelAuthMode: resolveModelAuthMode(
        params.model.provider,
        params.config,
        params.toolAuthProfileStore ?? params.authProfileStore,
        {
          workspaceDir: input.effectiveWorkspace,
        },
      ),
      suppressManagedWebSearch: false,
      webFetchHostnameAllowlistRef,
      currentChannelId: params.currentChannelId,
      currentMessagingTarget: params.currentMessagingTarget,
      hookChannelId: resolveCodexAppServerHookChannelId(params, input.sandboxSessionKey),
      currentThreadTs: params.currentThreadTs,
      currentMessageId: params.currentMessageId,
      replyToMode: params.replyToMode,
      hasRepliedRef: params.hasRepliedRef,
      modelHasVision,
      computerContextEpoch: input.computerContextEpoch,
      registerRunCleanup: input.registerRunCleanup,
      requireExplicitMessageTarget:
        params.requireExplicitMessageTarget ?? isSubagentSessionKey(params.sessionKey),
      sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
      // Same sibling-harness rule as clientCaps above: without this forward,
      // suggest_task/dismiss_task silently never exist for Codex-harness runs.
      taskSuggestionDeliveryMode: params.taskSuggestionDeliveryMode,
      disableMessageTool: input.ignoreDisableMessageTool ? false : params.disableMessageTool,
      forceMessageTool: shouldForceMessageTool(messagePolicyParams),
      enableHeartbeatTool: params.trigger === "heartbeat" || input.forceHeartbeatTool === true,
      forceHeartbeatTool: params.trigger === "heartbeat" || input.forceHeartbeatTool === true,
      onYield: (message, acknowledgment) => {
        input.onYieldDetected(acknowledgment);
        input.onCodexAppServerEvent?.({
          stream: "codex_app_server.tool",
          data: { name: "sessions_yield", message },
        });
      },
      claimYieldCompletion: input.claimYieldCompletion,
      recordToolPrepStage: (name) => {
        toolBuildStages.mark(name);
      },
      onToolOutcome: params.onToolOutcome,
      isTurnTainted: params.isTurnTainted,
      allocateToolOutcomeOrdinal: params.allocateToolOutcomeOrdinal,
      cronCreatorToolAllowlistRef: input.cronCreatorToolAllowlistRef,
      cronCreatorToolAllowlistCaptureRef: input.cronCreatorToolAllowlistCaptureRef,
      cronCreatorAuthorityUnavailableReason: input.cronCreatorAuthorityUnavailableReason,
    };
    const bindingOptions = { cwd: input.effectiveCwd ?? input.effectiveWorkspace };
    if (injectedOpenClawCodingToolsFactory) {
      return params.hostCapabilities.bindToolSurface(
        injectedOpenClawCodingToolsFactory(options),
        bindingOptions,
      );
    }
    const createToolSurface = params.hostCapabilities.createToolSurface;
    if (!createToolSurface) {
      throw new Error("Codex tool construction requires a current host capability");
    }
    return createToolSurface(options, bindingOptions);
  };
  const allTools = input.resolveCronCreatorToolAuthority
    ? runWithCronCreatorAuthorityCapabilityResolver({
        capability: params.cronCreatorAuthorityCapability,
        runId: params.runId,
        resolve: input.resolveCronCreatorToolAuthority,
        run: buildOpenClawCodingTools,
      })
    : buildOpenClawCodingTools();
  toolBuildStages.mark("create-openclaw-coding-tools");
  const preNormalizationDiagnostics: RuntimeToolSchemaDiagnostic[] = [];
  const readableAllToolProjection = filterProviderNormalizableTools(allTools);
  preNormalizationDiagnostics.push(...readableAllToolProjection.diagnostics);
  const readableAllTools = [...readableAllToolProjection.tools];
  const normallyProfiledTools =
    input.nativeToolSurfaceEnabled === false
      ? filterCodexDynamicToolsForDisabledNativeSurface(readableAllTools, input.pluginConfig, {
          preserveShell: shouldKeepOpenClawShellDynamicTools(input, nativeExecutionPolicy),
        })
      : filterCodexDynamicTools(readableAllTools, input.pluginConfig);
  const hostSystemAgentActive =
    input.isHostScopedToolActive?.("openclaw") ?? isHostScopedAgentToolActive("openclaw");
  const profileFilteredTools =
    hostSystemAgentActive && isSystemAgentOnlyCodexDynamicToolAllowlist(params.toolsAllow)
      ? preserveRingZeroSystemAgentTool(readableAllTools, normallyProfiledTools)
      : normallyProfiledTools;
  const codexFilteredTools = addNodeShellDynamicToolsIfNeeded(
    addGatewayShellDynamicToolsIfAvailable(
      addSandboxShellDynamicToolsIfAvailable(
        isCodexMemoryFlushRun(params)
          ? filterCodexMemoryFlushDynamicTools(readableAllTools)
          : profileFilteredTools,
        readableAllTools,
        input,
        nativeExecutionPolicy,
      ),
      readableAllTools,
      input,
      nativeExecutionPolicy,
    ),
    readableAllTools,
    input,
    nativeExecutionPolicy,
  );
  toolBuildStages.mark("codex-filtering");
  const visionFilteredTools = filterCodexVisionTools(codexFilteredTools, {
    modelHasVision,
    nativeImageInspectionEnabled: input.nativeToolSurfaceEnabled === true,
  });
  toolBuildStages.mark("vision-filtering");
  const webSearchPresent = visionFilteredTools.some((tool) => tool.name === "web_search");
  const persistentCodexWebSearchSurface =
    params.config?.tools?.web?.search?.enabled !== false &&
    !(input.pluginConfig.codexDynamicToolsExclude ?? []).some(
      (name) => normalizeCodexDynamicToolName(name) === "web_search",
    );
  // An authorized search tool already proves persistent availability. Only absent
  // tools need policy resolution to distinguish transient restrictions from denial.
  let persistentWebSearchAllowed = webSearchPresent;
  if (
    input.onPersistentWebSearchPolicyResolved &&
    !webSearchPresent &&
    persistentCodexWebSearchSurface
  ) {
    const webSearchPolicy = (
      await import("openclaw/plugin-sdk/agent-harness")
    ).resolveWebSearchToolPolicy({
      config: params.config,
      modelProvider: params.model.provider,
      modelId: params.modelId,
      agentId: input.policyAgentId,
      sessionKey: input.sandboxSessionKey,
      sandboxToolPolicy: input.sandbox?.tools,
      messageProvider: resolveCodexMessageToolProvider(params),
      agentAccountId: params.agentAccountId,
      groupId: params.groupId,
      groupChannel: params.groupChannel,
      groupSpace: params.groupSpace,
      spawnedBy: params.spawnedBy,
      senderId: params.senderId,
      senderName: params.senderName,
      senderUsername: params.senderUsername,
      senderE164: params.senderE164,
      inputProvenance: params.inputProvenance,
      trustedInternalHandoff: params.trustedInternalHandoff,
      scheduledToolPolicy: params.scheduledToolPolicy,
    });
    persistentWebSearchAllowed =
      webSearchPolicy.persistentAllowed &&
      (!webSearchPolicy.allowed || isCodexMemoryFlushRun(params));
  }
  input.onPersistentWebSearchPolicyResolved?.(persistentWebSearchAllowed);
  const filteredTools = filterCodexDynamicToolsForAllowlist(
    visionFilteredTools,
    toolRunContext.runtimeToolAllowlist,
  );
  toolBuildStages.mark("allowlist-filter");
  const normalizedTools = normalizeAgentRuntimeTools({
    runtimePlan: input.ignoreRuntimePlan ? undefined : params.runtimePlan,
    tools: filteredTools,
    provider: params.provider,
    config: params.config,
    workspaceDir: input.effectiveWorkspace,
    env: process.env,
    modelId: params.modelId,
    modelApi: params.model.api,
    model: params.model,
    // Durable registration projects the prepared catalog; it must not activate
    // a different provider runtime while building the thread-stable schema.
    allowProviderRuntimePluginLoad: input.ignoreRuntimePlan ? false : undefined,
    onPreNormalizationSchemaDiagnostics: (diagnostics) =>
      preNormalizationDiagnostics.push(...diagnostics),
  });
  toolBuildStages.mark("runtime-normalization");
  // Resolve policy before hiding the managed tool. Hosted search follows the
  // same effective policy, while only one search implementation is exposed.
  const webSearchAllowed = normalizedTools.some((tool) => tool.name === "web_search");
  webFetchHostnameAllowlistRef.value = webSearchAllowed
    ? webSearchPlan.webFetchHostnameAllowlist
    : undefined;
  input.onWebSearchPolicyResolved?.(webSearchAllowed);
  const exposedTools = webSearchPlan.suppressManagedWebSearch
    ? normalizedTools.filter((tool) => tool.name !== "web_search")
    : normalizedTools;
  if (preNormalizationDiagnostics.length > 0) {
    embeddedAgentLog.warn(
      `codex app-server quarantined ${preNormalizationDiagnostics.length} unsupported runtime tool schema${preNormalizationDiagnostics.length === 1 ? "" : "s"} before dynamic tool registration`,
      {
        runId: params.runId,
        sessionId: params.sessionId,
        diagnostics: preNormalizationDiagnostics.map((diagnostic) => ({
          index: diagnostic.toolIndex,
          tool: diagnostic.toolName,
          violations: diagnostic.violations.slice(0, 12),
          violationCount: diagnostic.violations.length,
        })),
      },
    );
  }
  const summary = toolBuildStages.snapshot();
  if (shouldWarnCodexDynamicToolBuildStageSummary(summary)) {
    const phase = input.forceHeartbeatTool ? "registered-tools" : "runtime-tools";
    embeddedAgentLog.warn(
      `codex app-server dynamic tool build timings runId=${params.runId} sessionId=${params.sessionId} phase=${phase} totalMs=${summary.totalMs} stages=${formatCodexDynamicToolBuildStageSummary(summary)}`,
      {
        runId: params.runId,
        sessionId: params.sessionId,
        phase,
        totalMs: summary.totalMs,
        stages: summary.stages,
        allToolCount: readableAllTools.length,
        codexFilteredToolCount: codexFilteredTools.length,
        visionFilteredToolCount: visionFilteredTools.length,
        filteredToolCount: filteredTools.length,
        normalizedToolCount: exposedTools.length,
        forceHeartbeatTool: input.forceHeartbeatTool === true,
        ignoreRuntimePlan: input.ignoreRuntimePlan === true,
        nativeToolSurfaceEnabled: input.nativeToolSurfaceEnabled === true,
      },
    );
  }
  return exposedTools;
}
/** Keeps the OpenClaw Gateway execution path available beside Codex native shell. */
function addGatewayShellDynamicToolsIfAvailable(
  filteredTools: OpenClawDynamicTool[],
  allTools: OpenClawDynamicTool[],
  input: DynamicToolBuildParams,
  executionPolicy: CodexNativeExecutionPolicy,
): OpenClawDynamicTool[] {
  if (
    isCodexMemoryFlushRun(input.params) ||
    input.nativeToolSurfaceEnabled !== true ||
    input.sandbox?.enabled === true ||
    !executionPolicy.nativeToolSurfaceAllowed ||
    executionPolicy.effectiveExecHost !== "gateway"
  ) {
    return filteredTools;
  }
  const execTool = allTools.find((tool) => normalizeCodexDynamicToolName(tool.name) === "exec");
  const processTool = allTools.find(
    (tool) => normalizeCodexDynamicToolName(tool.name) === "process",
  );
  const existingNames = new Set(
    filteredTools.map((tool) => normalizeCodexDynamicToolName(tool.name)),
  );
  const execExcluded = isCodexDynamicToolExcluded(input.pluginConfig, [
    "exec",
    CODEX_GATEWAY_EXEC_DYNAMIC_TOOL_NAME,
  ]);
  if (!execTool || execExcluded || existingNames.has(CODEX_GATEWAY_EXEC_DYNAMIC_TOOL_NAME)) {
    return filteredTools;
  }
  const processExcluded = isCodexDynamicToolExcluded(input.pluginConfig, [
    "process",
    CODEX_GATEWAY_PROCESS_DYNAMIC_TOOL_NAME,
  ]);
  const processAliasAvailable = Boolean(
    processTool && !processExcluded && !existingNames.has(CODEX_GATEWAY_PROCESS_DYNAMIC_TOOL_NAME),
  );
  const createProjection = resolveCodexScheduledToolProjectionFactory(
    input.params.hostCapabilities,
  );
  if (!createProjection) {
    return filteredTools;
  }
  const toolsToAppend = [
    createGatewayExecProjection(createProjection, execTool, {
      processAliasAvailable,
      ...(input.sessionPermissionPolicy?.mode === "guarded" ? { ask: "always" } : {}),
    }),
  ];
  if (processAliasAvailable && processTool) {
    toolsToAppend.push(createGatewayProcessProjection(createProjection, processTool));
  }
  return [...filteredTools, ...toolsToAppend];
}
/** Decides whether Codex native code mode can own shell/file tools for this turn. */
export function shouldEnableCodexAppServerNativeToolSurface(
  params: EmbeddedRunAttemptParams,
  sandbox?: OpenClawSandboxContext,
  options: {
    agentId?: string;
    runtimeSessionKey?: string;
    sandboxExecServerEnabled?: boolean;
  } = {},
): boolean {
  if (params.pluginHarnessToolPolicyRestricted === true) {
    return false;
  }
  if (isCodexMemoryFlushRun(params)) {
    return false;
  }
  if (params.disableTools) {
    return false;
  }
  if (
    !resolveCodexNativeExecutionPolicyForRun(params, {
      agentId: options.agentId,
      runtimeSessionKey: options.runtimeSessionKey,
      sandbox,
    }).nativeToolSurfaceAllowed
  ) {
    return false;
  }
  const toolsAllow = params.toolsAllow;
  if (toolsAllow === undefined) {
    return canCodexAppServerNativeToolSurfaceHonorSandbox(sandbox, options);
  }
  // Codex native code mode exposes its shell/file surface as one app-server
  // capability, so narrow OpenClaw allowlists must fail closed rather than
  // widening `message` or `web_search` into shell access.
  return (
    hasWildcardCodexToolsAllow(toolsAllow) &&
    canCodexAppServerNativeToolSurfaceHonorSandbox(sandbox, options)
  );
}
function resolveCodexNativeExecutionPolicyForRun(
  params: EmbeddedRunAttemptParams,
  options: {
    agentId?: string;
    runtimeSessionKey?: string;
    sandbox?: OpenClawSandboxContext;
  } = {},
): CodexNativeExecutionPolicy {
  return resolveCodexNativeExecutionPolicy({
    config: params.config,
    sessionKey: resolveCodexRuntimePolicySessionKey(params, options.runtimeSessionKey),
    sessionId: params.sessionId,
    agentId: options.agentId,
    execOverrides: params.execOverrides,
    // A resolved null sandbox is absence; undefined still requests runtime discovery.
    sandboxAvailable: options.sandbox === null ? false : options.sandbox?.enabled,
    readRuntimeSessionEntry: true,
  });
}
function resolveCodexRuntimePolicySessionKey(
  params: EmbeddedRunAttemptParams,
  runtimeSessionKey?: string,
): string | undefined {
  return (
    runtimeSessionKey?.trim() ||
    params.sandboxSessionKey?.trim() ||
    params.sessionKey?.trim() ||
    params.sessionId
  );
}
function canCodexAppServerNativeToolSurfaceHonorSandbox(
  sandbox: OpenClawSandboxContext | undefined,
  options: { sandboxExecServerEnabled?: boolean } = {},
): boolean {
  if (!sandbox?.enabled) {
    return true;
  }
  if (
    options.sandboxExecServerEnabled === true &&
    (sandbox.backend || isCodexRemoteExecPlacementSandbox(sandbox)) &&
    canSandboxToolPolicyExposeCodexNativeToolSurface(sandbox)
  ) {
    return true;
  }
  // Codex app-server native shell, filesystem, and user MCP execution are owned
  // by the app-server process. Without the explicit exec-server integration,
  // active OpenClaw sandboxing must disable the native surface and route shell
  // access through sandbox-backed dynamic tools instead.
  return false;
}
function canSandboxToolPolicyExposeCodexNativeToolSurface(sandbox: {
  tools: Parameters<typeof isToolAllowed>[0];
}): boolean {
  return CODEX_NATIVE_SANDBOX_TOOL_REQUIREMENTS.every((toolName) =>
    isToolAllowed(sandbox.tools, toolName),
  );
}
function isCodexMemoryFlushRun(
  params?: Pick<EmbeddedRunAttemptParams, "trigger" | "memoryFlushWritePath">,
): boolean {
  return params?.trigger === "memory" && Boolean(params.memoryFlushWritePath?.trim());
}
function filterCodexMemoryFlushDynamicTools<T extends { name: string }>(tools: T[]): T[] {
  return tools.filter((tool) =>
    CODEX_MEMORY_FLUSH_DYNAMIC_TOOL_ALLOW.has(normalizeCodexDynamicToolName(tool.name)),
  );
}
/** Requires a Codex sandbox environment only when native tools must run inside OpenClaw sandboxing. */
export function shouldRequireCodexSandboxExecServerEnvironment(params: {
  sandbox?: OpenClawSandboxContext;
  nativeToolSurfaceEnabled: boolean;
  sandboxExecServerEnabled: boolean;
}): boolean {
  return Boolean(
    isCodexRemoteExecPlacementSandbox(params.sandbox) ||
    (params.sandbox?.enabled && params.nativeToolSurfaceEnabled && params.sandboxExecServerEnabled),
  );
}
/** Selects the sandbox exec-server environment passed through the Codex app-server protocol. */
export function resolveCodexSandboxEnvironmentSelection(
  environment: CodexSandboxExecEnvironment | undefined,
  nativeToolSurfaceEnabled: boolean,
): CodexTurnEnvironmentParams[] | undefined {
  // Omitting this selection while a turn sets cwd restores Codex's local
  // environment; an explicit empty selection keeps native tools disabled.
  return nativeToolSurfaceEnabled ? (environment ? [environment] : undefined) : [];
}
/** Chooses the cwd visible to Codex native execution after sandbox exec-server setup. */
export function resolveCodexAppServerExecutionCwd(params: {
  effectiveCwd: string;
  localWorkspaceRoot: string;
  environment?: CodexSandboxExecEnvironment;
  nativeToolSurfaceEnabled: boolean;
  remoteWorkspaceRoot?: string;
}): string {
  const cwd =
    params.environment && params.nativeToolSurfaceEnabled
      ? params.environment.cwd
      : params.effectiveCwd;
  return mapCodexAppServerRemoteWorkspacePath({
    value: cwd,
    localWorkspaceRoot: params.localWorkspaceRoot,
    remoteWorkspaceRoot: params.remoteWorkspaceRoot,
  });
}
/** Converts OpenClaw sandbox networking into Codex's external-sandbox policy shape. */
export function resolveCodexExternalSandboxPolicyForOpenClawSandbox(
  sandbox: OpenClawSandboxContext | undefined,
): CodexSandboxPolicy {
  return {
    type: "externalSandbox",
    networkAccess: codexNetworkAccessForOpenClawSandbox(sandbox) ? "enabled" : "restricted",
  };
}

function usesDockerNetworkConfig(sandbox: OpenClawSandboxContext | undefined): boolean {
  const backendId = sandbox?.backendId.trim().toLowerCase();
  return backendId === "docker" || backendId === "podman";
}

function codexNetworkAccessForOpenClawSandbox(
  sandbox: OpenClawSandboxContext | undefined,
): boolean {
  if (!usesDockerNetworkConfig(sandbox)) {
    return true;
  }
  const network = sandbox?.docker?.network?.trim().toLowerCase();
  return Boolean(network && network !== "none");
}
/** Returns a Codex config copy with all app exposure disabled for restricted thread tools. */
export function disableCodexPluginThreadConfig(pluginConfig?: unknown): CodexPluginConfig {
  const config = readCodexPluginConfig(pluginConfig);
  return {
    ...config,
    codexPlugins: {
      ...config.codexPlugins,
      enabled: false,
    },
  };
}
/** Adds sandbox_exec/process aliases when native Code Mode cannot directly honor the sandbox. */
function addSandboxShellDynamicToolsIfAvailable(
  filteredTools: OpenClawDynamicTool[],
  allTools: OpenClawDynamicTool[],
  input: DynamicToolBuildParams,
  executionPolicy: CodexNativeExecutionPolicy,
): OpenClawDynamicTool[] {
  if (
    isCodexMemoryFlushRun(input.params) ||
    !executionPolicy.nativeToolSurfaceAllowed ||
    !input.sandbox?.enabled ||
    !input.sandbox.backendId.trim() ||
    input.nativeToolSurfaceEnabled !== false ||
    isSandboxShellDynamicToolExcluded(input.pluginConfig)
  ) {
    return filteredTools;
  }
  const execTool = allTools.find((tool) => normalizeCodexDynamicToolName(tool.name) === "exec");
  const processTool = allTools.find(
    (tool) => normalizeCodexDynamicToolName(tool.name) === "process",
  );
  if (!execTool || !processTool) {
    return filteredTools;
  }
  const sandboxExecTool: OpenClawDynamicTool = {
    ...execTool,
    name: "sandbox_exec",
    description:
      "Run a shell command through OpenClaw's configured sandbox backend for this session. Use when OpenClaw sandboxing is active or when a command must execute in the sandbox backend, such as an SSH-backed sandbox or Docker container-path bind layout. Use Codex's native shell only when no OpenClaw sandbox is active and native Code Mode is available.",
    execute: async (toolCallId, args, signal, onUpdate) => {
      const result = await execTool.execute(toolCallId, args, signal, onUpdate);
      return {
        ...result,
        content: result.content.map((item) =>
          item.type === "text"
            ? Object.assign({}, item, {
                text: item.text.replace(
                  "Use process (list/poll/log/write/send-keys/submit/paste/kill/clear/remove) for follow-up.",
                  "Use sandbox_process (list/poll/log/write/send-keys/submit/paste/kill/clear/remove) for follow-up.",
                ),
              })
            : item,
        ),
      };
    },
  };
  const sandboxProcessTool: OpenClawDynamicTool = {
    ...processTool,
    name: "sandbox_process",
    description:
      "Manage background shell sessions through OpenClaw's configured sandbox backend for this session: list, poll, log, write, send-keys, submit, paste, kill, clear, or remove. Use only for sandbox follow-up; use Codex's native shell session handling only when no OpenClaw sandbox is active and native Code Mode is available.",
  };
  return [...filteredTools, sandboxExecTool, sandboxProcessTool];
}
function isSandboxShellDynamicToolExcluded(config: CodexPluginConfig): boolean {
  return isCodexDynamicToolExcluded(config, ["exec", "sandbox_exec", "process", "sandbox_process"]);
}
function addNodeShellDynamicToolsIfNeeded(
  filteredTools: OpenClawDynamicTool[],
  allTools: OpenClawDynamicTool[],
  input: DynamicToolBuildParams,
  nodePolicy: CodexNativeExecutionPolicy,
): OpenClawDynamicTool[] {
  if (isCodexMemoryFlushRun(input.params)) {
    return filteredTools;
  }
  const nodeExecIsDefault = nodePolicy.effectiveExecHost === "node";
  const nodeExecAvailableFromAuto =
    nodePolicy.requestedExecHost === "auto" && nodePolicy.effectiveExecHost === "gateway";
  if (!nodeExecIsDefault && !nodeExecAvailableFromAuto) {
    return filteredTools;
  }
  const execTool = allTools.find((tool) => normalizeCodexDynamicToolName(tool.name) === "exec");
  if (!execTool) {
    return filteredTools;
  }
  if (
    !isCodexDynamicToolExcluded(input.pluginConfig, ["exec", CODEX_NODE_EXEC_DYNAMIC_TOOL_NAME]) &&
    !filteredTools.some(
      (tool) => normalizeCodexDynamicToolName(tool.name) === CODEX_NODE_EXEC_DYNAMIC_TOOL_NAME,
    )
  ) {
    return [...filteredTools, createNodeExecAliasDynamicTool(execTool, nodePolicy.node)];
  }
  return filteredTools;
}
function shouldKeepOpenClawShellDynamicTools(
  input: DynamicToolBuildParams,
  nodePolicy: CodexNativeExecutionPolicy,
): boolean {
  return (
    !isCodexMemoryFlushRun(input.params) &&
    // Disabled native Code Mode sends `environments: []`, so Codex cannot
    // advertise a shell. Preserve OpenClaw's policy-filtered direct shell.
    input.nativeToolSurfaceEnabled === false &&
    input.sandbox?.enabled !== true &&
    nodePolicy.effectiveExecHost !== "node"
  );
}
/** Applies a normalized tool allowlist while preserving shell aliases for exec/process. */
function filterCodexDynamicToolsForAllowlist<T extends { name: string }>(
  tools: T[],
  toolsAllow?: string[],
): T[] {
  if (!toolsAllow) {
    return tools;
  }
  if (toolsAllow.length === 0) {
    return [];
  }
  if (hasWildcardCodexToolsAllow(toolsAllow)) {
    return tools;
  }
  const allowSet = new Set(
    toolsAllow.map((name) => normalizeCodexDynamicToolName(name)).filter(Boolean),
  );
  return tools.filter((tool) => {
    const normalized = normalizeCodexDynamicToolName(tool.name);
    return (
      allowSet.has(normalized) ||
      (normalized === "sandbox_exec" && allowSet.has("exec")) ||
      (normalized === "sandbox_process" && (allowSet.has("exec") || allowSet.has("process"))) ||
      (normalized === CODEX_GATEWAY_EXEC_DYNAMIC_TOOL_NAME && allowSet.has("exec")) ||
      (normalized === CODEX_GATEWAY_PROCESS_DYNAMIC_TOOL_NAME &&
        (allowSet.has("exec") || allowSet.has("process"))) ||
      (normalized === CODEX_NODE_EXEC_DYNAMIC_TOOL_NAME && allowSet.has("exec"))
    );
  });
}
/** Detects the wildcard allowlist marker after Codex tool-name normalization. */
function hasWildcardCodexToolsAllow(toolsAllow: string[]): boolean {
  return toolsAllow.some((name) => normalizeCodexDynamicToolName(name) === "*");
}
/** Forces message delivery through the message tool when the source channel requires it. */
function shouldForceMessageTool(params: EmbeddedRunAttemptParams): boolean {
  return (
    params.disableMessageTool !== true && params.sourceReplyDeliveryMode === "message_tool_only"
  );
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
