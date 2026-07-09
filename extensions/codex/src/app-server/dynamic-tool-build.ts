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
  isSubagentSessionKey,
  normalizeAgentRuntimeTools,
  resolveAttemptSpawnWorkspaceDir,
  resolveModelAuthMode,
  resolveSandboxContext,
  supportsModelTools,
  type EmbeddedRunAttemptParams,
  type RuntimeToolSchemaDiagnostic,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import { isToolAllowed } from "openclaw/plugin-sdk/sandbox";
import { readCodexPluginConfig, type CodexPluginConfig } from "./config.js";
import {
  filterCodexDynamicTools,
  isForcedPrivateQaCodexRuntime,
  normalizeCodexDynamicToolName,
} from "./dynamic-tool-profile.js";
import {
  resolveCodexNativeExecutionPolicy,
  type CodexNativeExecutionPolicy,
} from "./native-execution-policy.js";
import type { CodexSandboxPolicy, CodexTurnEnvironmentParams } from "./protocol.js";
import type { CodexSandboxExecEnvironment } from "./sandbox-exec-server.js";
import { filterToolsForVisionInputs } from "./vision-tools.js";
import { resolveCodexWebSearchPlan, type CodexNativeWebSearchSupport } from "./web-search.js";

type OpenClawCodingToolsOptions = NonNullable<
  Parameters<(typeof import("openclaw/plugin-sdk/agent-harness"))["createOpenClawCodingTools"]>[0]
>;
type OpenClawExecOptions = NonNullable<OpenClawCodingToolsOptions["exec"]>;

/** Factory seam for constructing OpenClaw runtime tools without eagerly loading agent-harness. */
export type OpenClawCodingToolsFactory =
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
const CODEX_NODE_EXEC_DYNAMIC_TOOL_NAME = "node_exec";
const CODEX_NODE_PROCESS_DYNAMIC_TOOL_NAME = "node_process";
const CODEX_NODE_EXEC_HIDDEN_PARAMETER_NAMES = new Set(["host", "security", "ask", "node"]);

/** Runtime inputs needed to derive the exact Codex dynamic tool surface for a turn. */
export type DynamicToolBuildParams = {
  params: EmbeddedRunAttemptParams;
  resolvedWorkspace: string;
  effectiveWorkspace: string;
  effectiveCwd?: string;
  sandboxSessionKey: string;
  sandbox: OpenClawSandboxContext;
  nativeToolSurfaceEnabled?: boolean;
  nativeProviderWebSearchSupport?: CodexNativeWebSearchSupport;
  runAbortController: AbortController;
  sessionAgentId: string;
  pluginConfig: CodexPluginConfig;
  profilerEnabled?: boolean;
  forceHeartbeatTool?: boolean;
  ignoreDisableMessageTool?: boolean;
  ignoreRuntimePlan?: boolean;
  onYieldDetected: () => void;
  onCodexAppServerEvent?: (event: CodexDynamicToolBuildEvent) => void;
  onPersistentWebSearchPolicyResolved?: (allowed: boolean) => void;
  onWebSearchPolicyResolved?: (allowed: boolean) => void;
};

let openClawCodingToolsFactoryForTests: OpenClawCodingToolsFactory | undefined;

/** Overrides the runtime tool factory for tests that need deterministic tool catalogs. */
export function setOpenClawCodingToolsFactoryForTests(factory: OpenClawCodingToolsFactory): void {
  openClawCodingToolsFactoryForTests = factory;
}

/** Clears the test-only runtime tool factory override. */
export function resetOpenClawCodingToolsFactoryForTests(): void {
  openClawCodingToolsFactoryForTests = undefined;
}

/** Splits sandbox and run session keys so tool calls can bind to both scopes when needed. */
export function resolveOpenClawCodingToolsSessionKeys(
  params: EmbeddedRunAttemptParams,
  sandboxSessionKey: string,
): Pick<OpenClawCodingToolsOptions, "sessionKey" | "runSessionKey"> {
  return {
    sessionKey: sandboxSessionKey,
    runSessionKey:
      params.sessionKey && params.sessionKey !== sandboxSessionKey ? params.sessionKey : undefined,
  };
}

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
  const agentHarness = await import("openclaw/plugin-sdk/agent-harness");
  const createOpenClawCodingTools =
    openClawCodingToolsFactoryForTests ?? agentHarness.createOpenClawCodingTools;
  toolBuildStages.mark("load-agent-harness-tools");
  const sessionKeys = resolveOpenClawCodingToolsSessionKeys(params, input.sandboxSessionKey);
  const nativeExecutionPolicy = resolveCodexNativeExecutionPolicyForDynamicTools(input);
  const allTools = createOpenClawCodingTools({
    agentId: input.sessionAgentId,
    ...(params.crestodianTool ? { crestodianTool: params.crestodianTool } : {}),
    ...buildEmbeddedAttemptToolRunContext(params),
    exec: {
      ...params.execOverrides,
      ...resolveNodeExecToolOverrides(nativeExecutionPolicy),
      config: params.config,
      elevated: params.bashElevated,
    },
    sandbox: input.sandbox,
    messageProvider: resolveCodexMessageToolProvider(params),
    toolPolicyMessageProvider: params.messageProvider ?? params.messageChannel,
    // Capability-gated tools (requiredClientCaps) need the originating client's
    // declared caps in this sibling harness too, not only the embedded runner.
    clientCaps: params.clientCaps,
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
    allowGatewaySubagentBinding:
      params.allowGatewaySubagentBinding || isForcedPrivateQaCodexRuntime(),
    ...sessionKeys,
    sessionId: params.sessionId,
    runId: params.runId,
    approvalReviewerDeviceId: params.approvalReviewerDeviceId,
    agentDir,
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
    modelAuthMode: resolveModelAuthMode(
      params.model.provider,
      params.config,
      params.toolAuthProfileStore ?? params.authProfileStore,
      {
        workspaceDir: input.effectiveWorkspace,
      },
    ),
    suppressManagedWebSearch: false,
    currentChannelId: params.currentChannelId,
    currentMessagingTarget: params.currentMessagingTarget,
    hookChannelId: resolveCodexAppServerHookChannelId(params, input.sandboxSessionKey),
    currentThreadTs: params.currentThreadTs,
    currentMessageId: params.currentMessageId,
    replyToMode: params.replyToMode,
    hasRepliedRef: params.hasRepliedRef,
    modelHasVision,
    requireExplicitMessageTarget:
      params.requireExplicitMessageTarget ?? isSubagentSessionKey(params.sessionKey),
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    disableMessageTool: input.ignoreDisableMessageTool ? false : params.disableMessageTool,
    forceMessageTool: shouldForceMessageTool(messagePolicyParams),
    enableHeartbeatTool: params.trigger === "heartbeat" || input.forceHeartbeatTool === true,
    forceHeartbeatTool: params.trigger === "heartbeat" || input.forceHeartbeatTool === true,
    onYield: (message) => {
      input.onYieldDetected();
      input.onCodexAppServerEvent?.({
        stream: "codex_app_server.tool",
        data: { name: "sessions_yield", message },
      });
    },
    recordToolPrepStage: (name) => {
      toolBuildStages.mark(name);
    },
    onToolOutcome: params.onToolOutcome,
    allocateToolOutcomeOrdinal: params.allocateToolOutcomeOrdinal,
  });
  toolBuildStages.mark("create-openclaw-coding-tools");
  const preNormalizationDiagnostics: RuntimeToolSchemaDiagnostic[] = [];
  const readableAllToolProjection = filterProviderNormalizableTools(allTools);
  preNormalizationDiagnostics.push(...readableAllToolProjection.diagnostics);
  const webSearchPlan = resolveCodexWebSearchPlan({
    config: params.config,
    disableTools: params.disableTools,
    nativeToolSurfaceEnabled: input.nativeToolSurfaceEnabled,
    nativeProviderWebSearchSupport: input.nativeProviderWebSearchSupport,
  });
  const readableAllTools = [...readableAllToolProjection.tools];
  const codexFilteredTools = addNodeShellDynamicToolsIfNeeded(
    addSandboxShellDynamicToolsIfAvailable(
      isCodexMemoryFlushRun(params)
        ? filterCodexMemoryFlushDynamicTools(readableAllTools)
        : filterCodexDynamicTools(readableAllTools, input.pluginConfig),
      readableAllTools,
      input,
    ),
    readableAllTools,
    input,
    nativeExecutionPolicy,
  );
  toolBuildStages.mark("codex-filtering");
  const visionFilteredTools = filterToolsForVisionInputs(codexFilteredTools, {
    modelHasVision,
    hasInboundImages: (params.images?.length ?? 0) > 0,
  });
  toolBuildStages.mark("vision-filtering");
  const webSearchPresent = visionFilteredTools.some((tool) => tool.name === "web_search");
  const webSearchPolicy = agentHarness.resolveWebSearchToolPolicy({
    config: params.config,
    modelProvider: params.model.provider,
    modelId: params.modelId,
    agentId: input.sessionAgentId,
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
  });
  const senderScopedWebSearchRestriction =
    !webSearchPolicy.allowed && webSearchPolicy.persistentAllowed;
  const transientWebSearchRestriction =
    senderScopedWebSearchRestriction || isCodexMemoryFlushRun(params);
  const persistentCodexWebSearchSurface =
    params.config?.tools?.web?.search?.enabled !== false &&
    !(input.pluginConfig.codexDynamicToolsExclude ?? []).some(
      (name) => normalizeCodexDynamicToolName(name) === "web_search",
    );
  input.onPersistentWebSearchPolicyResolved?.(
    webSearchPresent ||
      (persistentCodexWebSearchSurface &&
        transientWebSearchRestriction &&
        webSearchPolicy.persistentAllowed),
  );
  const toolsAllow = includeForcedCodexDynamicToolAllow(params.toolsAllow, messagePolicyParams);
  const filteredTools = filterCodexDynamicToolsForAllowlist(visionFilteredTools, toolsAllow);
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
    onPreNormalizationSchemaDiagnostics: (diagnostics) =>
      preNormalizationDiagnostics.push(...diagnostics),
  });
  toolBuildStages.mark("runtime-normalization");
  // Resolve policy before hiding the managed tool. Hosted search follows the
  // same effective policy, while only one search implementation is exposed.
  input.onWebSearchPolicyResolved?.(normalizedTools.some((tool) => tool.name === "web_search"));
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

/** Preserves delivery-critical tools when a narrow allowlist would otherwise hide them. */
export function includeForcedCodexDynamicToolAllow(
  toolsAllow: string[] | undefined,
  params: EmbeddedRunAttemptParams,
): string[] | undefined {
  if (toolsAllow === undefined || hasWildcardCodexToolsAllow(toolsAllow)) {
    return toolsAllow;
  }
  const forcedToolNames = shouldForceMessageTool(params) ? ["message"] : [];
  if (forcedToolNames.length === 0) {
    return toolsAllow;
  }
  if (toolsAllow.length === 0) {
    return forcedToolNames;
  }
  const normalized = new Set(toolsAllow.map((name) => normalizeCodexDynamicToolName(name)));
  const missingToolNames = forcedToolNames.filter(
    (toolName) => !normalized.has(normalizeCodexDynamicToolName(toolName)),
  );
  return missingToolNames.length === 0 ? toolsAllow : [...toolsAllow, ...missingToolNames];
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
  if (isCodexMemoryFlushRun(params)) {
    return false;
  }
  const toolsAllow = includeForcedCodexDynamicToolAllow(params.toolsAllow, params);
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

/** Returns true when OpenClaw policy requires the Node-owned exec/process tools instead. */
export function isCodexNativeExecutionBlockedByNodeExecHost(
  params: EmbeddedRunAttemptParams,
  options: {
    agentId?: string;
    runtimeSessionKey?: string;
    sandbox?: OpenClawSandboxContext;
  } = {},
): boolean {
  return !resolveCodexNativeExecutionPolicy({
    config: params.config,
    sessionKey: resolveCodexRuntimePolicySessionKey(params, options.runtimeSessionKey),
    sessionId: params.sessionId,
    agentId: options.agentId,
    execOverrides: params.execOverrides,
    sandboxAvailable: options.sandbox?.enabled,
    readRuntimeSessionEntry: true,
  }).nativeToolSurfaceAllowed;
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
    sandbox.backend &&
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
    params.sandbox?.enabled && params.nativeToolSurfaceEnabled && params.sandboxExecServerEnabled,
  );
}

/** Selects the sandbox exec-server environment passed through the Codex app-server protocol. */
export function resolveCodexSandboxEnvironmentSelection(
  environment: CodexSandboxExecEnvironment | undefined,
  nativeToolSurfaceEnabled: boolean,
): CodexTurnEnvironmentParams[] | undefined {
  return environment && nativeToolSurfaceEnabled ? [environment] : undefined;
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

/** Projects a local OpenClaw workspace cwd into the remote Codex app-server workspace root. */
export function mapCodexAppServerRemoteWorkspacePath(params: {
  value: string;
  localWorkspaceRoot: string;
  remoteWorkspaceRoot?: string;
}): string {
  if (!params.remoteWorkspaceRoot) {
    return params.value;
  }
  const localRoot = normalizeRemoteWorkspaceMatchPath(params.localWorkspaceRoot);
  const remoteRoot = normalizeRemoteWorkspaceMatchPath(params.remoteWorkspaceRoot);
  const normalizedValue = normalizeRemoteWorkspaceMatchPath(params.value);
  if (!localRoot || !remoteRoot) {
    throw new Error("Codex remoteWorkspaceRoot requires non-empty workspace roots.");
  }
  if (normalizedValue === localRoot) {
    return remoteRoot;
  }
  const prefix = `${localRoot}/`;
  if (!normalizedValue.startsWith(prefix)) {
    throw new Error(
      `Codex remoteWorkspaceRoot is configured but cwd ${params.value} is outside OpenClaw workspace root ${params.localWorkspaceRoot}; refusing to send a gateway-local cwd to the remote Codex app-server.`,
    );
  }
  return joinRemoteWorkspacePath(remoteRoot, normalizedValue.slice(prefix.length));
}

function normalizeRemoteWorkspaceMatchPath(value: string): string {
  return trimTrailingPathSeparator(value.replace(/\\/gu, "/"));
}

function trimTrailingPathSeparator(value: string): string {
  return value.length > 1 ? value.replace(/[\\/]+$/u, "") : value;
}

function joinRemoteWorkspacePath(remoteRoot: string, suffix: string): string {
  return remoteRoot === "/" ? `/${suffix}` : `${remoteRoot}/${suffix}`;
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

function codexNetworkAccessForOpenClawSandbox(
  sandbox: OpenClawSandboxContext | undefined,
): boolean {
  if (sandbox?.backendId !== "docker") {
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
export function addSandboxShellDynamicToolsIfAvailable(
  filteredTools: OpenClawDynamicTool[],
  allTools: OpenClawDynamicTool[],
  input: DynamicToolBuildParams,
): OpenClawDynamicTool[] {
  if (
    !shouldExposeSandboxExecDynamicTool(input) ||
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
      "Manage sandbox_exec sessions that were started through OpenClaw's configured sandbox backend for this session: list, poll, log, write, send-keys, submit, paste, kill, clear, or remove. Use only for sandbox_exec follow-up; use Codex's native shell session handling only when no OpenClaw sandbox is active and native Code Mode is available.",
  };
  return [...filteredTools, sandboxExecTool, sandboxProcessTool];
}

function shouldExposeSandboxExecDynamicTool(input: DynamicToolBuildParams): boolean {
  if (isCodexMemoryFlushRun(input.params)) {
    return false;
  }
  if (
    isCodexNativeExecutionBlockedByNodeExecHost(input.params, {
      agentId: input.sessionAgentId,
      runtimeSessionKey: input.sandboxSessionKey,
      sandbox: input.sandbox,
    })
  ) {
    return false;
  }
  const backendId = input.sandbox?.enabled ? input.sandbox.backendId.trim().toLowerCase() : "";
  return Boolean(backendId && input.nativeToolSurfaceEnabled === false);
}

function isCodexDynamicToolExcluded(config: CodexPluginConfig, names: string[]): boolean {
  const normalizedNames = new Set(names.map((name) => normalizeCodexDynamicToolName(name)));
  return (config.codexDynamicToolsExclude ?? []).some((name) => {
    const normalized = normalizeCodexDynamicToolName(name);
    return normalizedNames.has(normalized);
  });
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
  if (nodePolicy.effectiveExecHost !== "node") {
    return filteredTools;
  }
  const execTool = allTools.find((tool) => normalizeCodexDynamicToolName(tool.name) === "exec");
  const processTool = allTools.find(
    (tool) => normalizeCodexDynamicToolName(tool.name) === "process",
  );
  if (!execTool || !processTool) {
    return filteredTools;
  }
  const toolsToAppend: OpenClawDynamicTool[] = [];
  if (
    !isCodexDynamicToolExcluded(input.pluginConfig, ["exec", CODEX_NODE_EXEC_DYNAMIC_TOOL_NAME]) &&
    !filteredTools.some(
      (tool) => normalizeCodexDynamicToolName(tool.name) === CODEX_NODE_EXEC_DYNAMIC_TOOL_NAME,
    )
  ) {
    toolsToAppend.push(createNodeExecDynamicTool(execTool, nodePolicy.node));
  }
  if (
    !isCodexDynamicToolExcluded(input.pluginConfig, [
      "process",
      CODEX_NODE_PROCESS_DYNAMIC_TOOL_NAME,
    ]) &&
    !filteredTools.some(
      (tool) => normalizeCodexDynamicToolName(tool.name) === CODEX_NODE_PROCESS_DYNAMIC_TOOL_NAME,
    )
  ) {
    toolsToAppend.push(createNodeProcessDynamicTool(processTool));
  }
  return toolsToAppend.length > 0 ? [...filteredTools, ...toolsToAppend] : filteredTools;
}

function createNodeExecDynamicTool(
  execTool: OpenClawDynamicTool,
  configuredNode: string | undefined,
): OpenClawDynamicTool {
  return {
    ...execTool,
    name: CODEX_NODE_EXEC_DYNAMIC_TOOL_NAME,
    description:
      "Run a shell command on the OpenClaw configured remote node for this session. This tool always uses OpenClaw host=node internally and follows the existing node exec approval and allowlist policy. Use node_process for follow-up on backgrounded node_exec sessions. Use Codex's native shell for local app-server work.",
    parameters: hideNodeExecDynamicToolParameters(execTool.parameters),
    execute: async (toolCallId, args, signal, onUpdate) => {
      const result = await execTool.execute(
        toolCallId,
        pinNodeExecDynamicToolArgs(args, configuredNode),
        signal,
        onUpdate,
      );
      return {
        ...result,
        content: result.content.map((item) =>
          item.type === "text"
            ? Object.assign({}, item, {
                text: item.text.replace(
                  "Use process (list/poll/log/write/send-keys/submit/paste/kill/clear/remove) for follow-up.",
                  "Use node_process (list/poll/log/write/send-keys/submit/paste/kill/clear/remove) for follow-up.",
                ),
              })
            : item,
        ),
      };
    },
  };
}

function createNodeProcessDynamicTool(processTool: OpenClawDynamicTool): OpenClawDynamicTool {
  return {
    ...processTool,
    name: CODEX_NODE_PROCESS_DYNAMIC_TOOL_NAME,
    description:
      "Manage node_exec sessions that were started on the OpenClaw configured remote node for this session: list, poll, log, write, send-keys, submit, paste, kill, clear, or remove. Use only for node_exec follow-up; use Codex's native shell session handling for local app-server work.",
  };
}

function pinNodeExecDynamicToolArgs(args: unknown, configuredNode: string | undefined): unknown {
  const source =
    args && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};
  const { host: _host, security: _security, ask: _ask, node: _node, ...rest } = source;
  const node = configuredNode?.trim();
  return {
    ...rest,
    host: "node",
    ...(node ? { node } : {}),
  };
}

function hideNodeExecDynamicToolParameters(parameters: OpenClawDynamicTool["parameters"]) {
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    return parameters;
  }
  const schema = parameters as Record<string, unknown>;
  const rawProperties = schema.properties;
  if (!rawProperties || typeof rawProperties !== "object" || Array.isArray(rawProperties)) {
    return parameters;
  }
  const nextProperties = Object.fromEntries(
    Object.entries(rawProperties).filter(
      ([name]) => !CODEX_NODE_EXEC_HIDDEN_PARAMETER_NAMES.has(normalizeCodexDynamicToolName(name)),
    ),
  );
  const rawRequired = schema.required;
  const nextRequired = Array.isArray(rawRequired)
    ? rawRequired.filter(
        (name) =>
          typeof name !== "string" ||
          !CODEX_NODE_EXEC_HIDDEN_PARAMETER_NAMES.has(normalizeCodexDynamicToolName(name)),
      )
    : rawRequired;
  return {
    ...schema,
    properties: nextProperties,
    ...(Array.isArray(rawRequired) ? { required: nextRequired } : {}),
  };
}

function resolveCodexNativeExecutionPolicyForDynamicTools(
  input: DynamicToolBuildParams,
): CodexNativeExecutionPolicy {
  return resolveCodexNativeExecutionPolicy({
    config: input.params.config,
    sessionKey: resolveCodexRuntimePolicySessionKey(input.params, input.sandboxSessionKey),
    sessionId: input.params.sessionId,
    agentId: input.sessionAgentId,
    execOverrides: input.params.execOverrides,
    sandboxAvailable: input.sandbox?.enabled,
    readRuntimeSessionEntry: true,
  });
}

function resolveNodeExecToolOverrides(
  policy: CodexNativeExecutionPolicy,
): Pick<OpenClawExecOptions, "host" | "node"> | undefined {
  if (policy.effectiveExecHost !== "node") {
    return undefined;
  }
  const node = policy.node?.trim();
  return {
    host: "node",
    ...(node ? { node } : {}),
  };
}

/** Applies a normalized tool allowlist while preserving shell aliases for exec/process. */
export function filterCodexDynamicToolsForAllowlist<T extends { name: string }>(
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
      (normalized === CODEX_NODE_EXEC_DYNAMIC_TOOL_NAME && allowSet.has("exec")) ||
      (normalized === CODEX_NODE_PROCESS_DYNAMIC_TOOL_NAME &&
        (allowSet.has("exec") || allowSet.has("process")))
    );
  });
}

/** Detects the wildcard allowlist marker after Codex tool-name normalization. */
export function hasWildcardCodexToolsAllow(toolsAllow: string[]): boolean {
  return toolsAllow.some((name) => normalizeCodexDynamicToolName(name) === "*");
}

/** Forces message delivery through the message tool when the source channel requires it. */
export function shouldForceMessageTool(params: EmbeddedRunAttemptParams): boolean {
  return (
    params.disableMessageTool !== true && params.sourceReplyDeliveryMode === "message_tool_only"
  );
}
