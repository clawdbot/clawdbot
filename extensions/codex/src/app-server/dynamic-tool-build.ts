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
import { resolveCodexNativeExecutionPolicy } from "./native-execution-policy.js";
import type { CodexSandboxPolicy, CodexTurnEnvironmentParams } from "./protocol.js";
import type { CodexSandboxExecEnvironment } from "./sandbox-exec-server.js";
import { filterToolsForVisionInputs } from "./vision-tools.js";

type OpenClawCodingToolsOptions = NonNullable<
  Parameters<(typeof import("openclaw/plugin-sdk/agent-harness"))["createOpenClawCodingTools"]>[0]
>;
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

export type DynamicToolBuildParams = {
  params: EmbeddedRunAttemptParams;
  resolvedWorkspace: string;
  effectiveWorkspace: string;
  effectiveCwd?: string;
  sandboxSessionKey: string;
  sandbox: OpenClawSandboxContext;
  nativeToolSurfaceEnabled?: boolean;
  runAbortController: AbortController;
  sessionAgentId: string;
  pluginConfig: CodexPluginConfig;
  profilerEnabled?: boolean;
  forceHeartbeatTool?: boolean;
  ignoreRuntimePlan?: boolean;
  onYieldDetected: () => void;
  onCodexAppServerEvent?: (event: CodexDynamicToolBuildEvent) => void;
};

let openClawCodingToolsFactoryForTests: OpenClawCodingToolsFactory | undefined;

export function setOpenClawCodingToolsFactoryForTests(factory: OpenClawCodingToolsFactory): void {
  openClawCodingToolsFactoryForTests = factory;
}

export function resetOpenClawCodingToolsFactoryForTests(): void {
  openClawCodingToolsFactoryForTests = undefined;
}

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

export function shouldWarnCodexDynamicToolBuildStageSummary(
  summary: CodexDynamicToolBuildStageSummary,
): boolean {
  return (
    summary.totalMs >= CODEX_DYNAMIC_TOOL_BUILD_WARN_TOTAL_MS ||
    summary.stages.some((stage) => stage.durationMs >= CODEX_DYNAMIC_TOOL_BUILD_WARN_STAGE_MS)
  );
}

export function formatCodexDynamicToolBuildStageSummary(
  summary: CodexDynamicToolBuildStageSummary,
): string {
  return summary.stages.length > 0
    ? summary.stages
        .map((stage) => `${stage.name}:${stage.durationMs}ms@${stage.elapsedMs}ms`)
        .join(",")
    : "none";
}

export async function buildDynamicTools(input: DynamicToolBuildParams) {
  const { params } = input;
  if (params.disableTools || !supportsModelTools(params.model)) {
    return [];
  }
  // Dynamic tool construction is on the reply hot path, so per-stage
  // Date.now/span bookkeeping runs only when the Codex profiler flag is set.
  const toolBuildStages = createCodexDynamicToolBuildStageTracker({
    enabled: input.profilerEnabled,
  });
  const modelHasVision = params.model.input?.includes("image") ?? false;
  const agentDir = params.agentDir ?? resolveAgentDir(params.config ?? {}, input.sessionAgentId);
  const createOpenClawCodingTools =
    openClawCodingToolsFactoryForTests ??
    (await import("openclaw/plugin-sdk/agent-harness")).createOpenClawCodingTools;
  toolBuildStages.mark("load-agent-harness-tools");
  const sessionKeys = resolveOpenClawCodingToolsSessionKeys(params, input.sandboxSessionKey);
  const allTools = createOpenClawCodingTools({
    agentId: input.sessionAgentId,
    ...buildEmbeddedAttemptToolRunContext(params),
    exec: {
      ...params.execOverrides,
      config: params.config,
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
    allowGatewaySubagentBinding:
      params.allowGatewaySubagentBinding || isForcedPrivateQaCodexRuntime(),
    ...sessionKeys,
    sessionId: params.sessionId,
    runId: params.runId,
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
    hookChannelId: resolveCodexAppServerHookChannelId(params, input.sandboxSessionKey),
    currentThreadTs: params.currentThreadTs,
    currentMessageId: params.currentMessageId,
    replyToMode: params.replyToMode,
    hasRepliedRef: params.hasRepliedRef,
    modelHasVision,
    requireExplicitMessageTarget:
      params.requireExplicitMessageTarget ?? isSubagentSessionKey(params.sessionKey),
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    disableMessageTool: params.disableMessageTool,
    forceMessageTool: shouldForceMessageTool(params),
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
  });
  toolBuildStages.mark("create-openclaw-coding-tools");
  const preNormalizationDiagnostics: RuntimeToolSchemaDiagnostic[] = [];
  const readableAllToolProjection = filterProviderNormalizableTools(allTools);
  preNormalizationDiagnostics.push(...readableAllToolProjection.diagnostics);
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
  );
  toolBuildStages.mark("codex-filtering");
  const visionFilteredTools = filterToolsForVisionInputs(codexFilteredTools, {
    modelHasVision,
    hasInboundImages: (params.images?.length ?? 0) > 0,
  });
  toolBuildStages.mark("vision-filtering");
  const toolsAllow = includeForcedCodexDynamicToolAllow(params.toolsAllow, params);
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
        normalizedToolCount: normalizedTools.length,
        forceHeartbeatTool: input.forceHeartbeatTool === true,
        ignoreRuntimePlan: input.ignoreRuntimePlan === true,
        nativeToolSurfaceEnabled: input.nativeToolSurfaceEnabled === true,
      },
    );
  }
  return normalizedTools;
}

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
  if (
    isCodexNativeExecutionBlockedByNodeExecHost(params, {
      agentId: options.agentId,
      runtimeSessionKey: options.runtimeSessionKey,
      sandbox,
    })
  ) {
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

export function shouldRequireCodexSandboxExecServerEnvironment(params: {
  sandbox?: OpenClawSandboxContext;
  nativeToolSurfaceEnabled: boolean;
  sandboxExecServerEnabled: boolean;
}): boolean {
  return Boolean(
    params.sandbox?.enabled && params.nativeToolSurfaceEnabled && params.sandboxExecServerEnabled,
  );
}

export function resolveCodexSandboxEnvironmentSelection(
  environment: CodexSandboxExecEnvironment | undefined,
  nativeToolSurfaceEnabled: boolean,
): CodexTurnEnvironmentParams[] | undefined {
  return environment && nativeToolSurfaceEnabled ? [environment] : undefined;
}

export function resolveCodexAppServerExecutionCwd(params: {
  effectiveCwd: string;
  environment?: CodexSandboxExecEnvironment;
  nativeToolSurfaceEnabled: boolean;
}): string {
  return params.environment && params.nativeToolSurfaceEnabled
    ? params.environment.cwd
    : params.effectiveCwd;
}

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
): OpenClawDynamicTool[] {
  if (
    isCodexMemoryFlushRun(input.params) ||
    !isCodexNativeExecutionBlockedByNodeExecHost(input.params, {
      agentId: input.sessionAgentId,
      runtimeSessionKey: input.sandboxSessionKey,
      sandbox: input.sandbox,
    })
  ) {
    return filteredTools;
  }
  let next = filteredTools;
  for (const toolName of ["exec", "process"]) {
    if (isCodexDynamicToolExcluded(input.pluginConfig, [toolName])) {
      continue;
    }
    if (next.some((tool) => normalizeCodexDynamicToolName(tool.name) === toolName)) {
      continue;
    }
    const tool = allTools.find(
      (candidate) => normalizeCodexDynamicToolName(candidate.name) === toolName,
    );
    if (!tool) {
      continue;
    }
    if (next === filteredTools) {
      next = [...filteredTools];
    }
    next.push(tool);
  }
  return next;
}

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
      (normalized === "sandbox_process" && (allowSet.has("exec") || allowSet.has("process")))
    );
  });
}

export function hasWildcardCodexToolsAllow(toolsAllow: string[]): boolean {
  return toolsAllow.some((name) => normalizeCodexDynamicToolName(name) === "*");
}

export function shouldForceMessageTool(params: EmbeddedRunAttemptParams): boolean {
  return (
    params.disableMessageTool !== true && params.sourceReplyDeliveryMode === "message_tool_only"
  );
}
