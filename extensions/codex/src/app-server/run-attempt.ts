// Codex plugin module implements run attempt behavior.
import fs from "node:fs/promises";
import path from "node:path";
import {
  assembleHarnessContextEngine,
  assertContextEngineHostSupport,
  bootstrapHarnessContextEngine,
  buildHarnessContextEngineRuntimeContext,
  buildHarnessContextEngineRuntimeContextFromUsage,
  CODEX_APP_SERVER_CONTEXT_ENGINE_HOST,
  clearActiveEmbeddedRun,
  embeddedAgentLog,
  emitAgentEvent as emitGlobalAgentEvent,
  finalizeHarnessContextEngineTurn,
  formatErrorMessage,
  getAgentHarnessHookRunner,
  getBeforeToolCallPolicyDiagnosticState,
  isActiveHarnessContextEngine,
  loadCodexBundleMcpThreadConfig,
  resolveAgentHarnessBeforePromptBuildResult,
  resolveContextEngineOwnerPluginId,
  resolveSandboxContext,
  resolveSessionAgentIds,
  resolveUserPath,
  awaitAgentHarnessAgentEndHook,
  runAgentHarnessAgentEndHook,
  runAgentHarnessLlmInputHook,
  runAgentHarnessLlmOutputHook,
  runHarnessContextEngineMaintenance,
  setActiveEmbeddedRun,
  supportsModelTools,
  runAgentCleanupStep,
  type EmbeddedRunAttemptParams,
  type EmbeddedRunAttemptResult,
  type NativeHookRelayEvent,
  type NativeHookRelayRegistrationHandle,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import {
  createDiagnosticTraceContextFromActiveScope,
  emitTrustedDiagnosticEvent,
  freezeDiagnosticTraceContext,
  onInternalDiagnosticEvent,
  resolveDiagnosticModelContentCapturePolicy,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { loadExecApprovals } from "openclaw/plugin-sdk/exec-approvals-runtime";
import { pathExists } from "openclaw/plugin-sdk/security-runtime";
import { resolveCodexAppServerForOpenClawToolPolicy } from "./app-server-policy.js";
import { handleCodexAppServerApprovalRequest } from "./approval-bridge.js";
import {
  CODEX_APP_SERVER_INTERRUPT_TIMEOUT_MS,
  CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
  interruptCodexTurnBestEffort,
  retireCodexAppServerClientAfterTimedOutTurn,
  unsubscribeCodexThreadBestEffort,
} from "./attempt-client-cleanup.js";
import {
  buildCodexOpenClawPromptContext,
  buildCodexSystemPromptReport,
  buildCodexWorkspaceBootstrapContext,
  getCodexWorkspaceMemoryToolNames,
  prependCodexOpenClawPromptContext,
  readContextEngineThreadBootstrapProjection,
  readMirroredSessionHistoryMessages,
  renderCodexSkillsCollaborationInstructions,
  resolveContextEngineBootstrapProjectionDecision,
} from "./attempt-context.js";
import {
  classifyCodexModelCallFailureKind,
  createCodexModelCallDiagnosticEmitter,
  utf8JsonByteLength,
} from "./attempt-diagnostics.js";
import {
  applyCodexTurnNotificationState,
  isTerminalCodexTurnNotificationForTurn,
  reportCodexExecutionNotification,
} from "./attempt-notification-state.js";
import {
  isCodexNotificationOutsideActiveRun,
  isCurrentApprovalTurnRequestParams,
  isCurrentThreadOptionalTurnRequestParams,
  isCurrentThreadTurnRequestParams,
  isNativeResponseStreamDeltaNotification,
  isTerminalTurnStatus,
} from "./attempt-notifications.js";
import {
  buildCodexAppServerPromptTimeoutOutcome,
  buildCodexTurnStartFailureResult,
  collectTerminalAssistantText,
  isInvalidCodexImagePayloadError,
  resolveCodexAppServerReplayBlockedReason,
} from "./attempt-results.js";
import { startCodexAttemptThread } from "./attempt-startup.js";
import { createCodexSteeringQueue, type CodexSteeringQueueOptions } from "./attempt-steering.js";
import {
  resolveCodexPostToolRawAssistantCompletionIdleTimeoutMs,
  resolveCodexStartupTimeoutMs,
  resolveCodexTurnAssistantCompletionIdleTimeoutMs,
  resolveCodexTurnCompletionIdleTimeoutMs,
  resolveCodexTurnTerminalIdleTimeoutMs,
  withCodexStartupTimeout,
} from "./attempt-timeouts.js";
import {
  createCodexAttemptTurnWatchController,
  type CodexAttemptTurnWatchTimeoutKind,
} from "./attempt-turn-watches.js";
import {
  refreshCodexAppServerAuthTokens,
  resolveCodexAppServerAuthAccountCacheKey,
  resolveCodexAppServerFallbackApiKeyCacheKey,
  resolveCodexAppServerHomeDir,
  resolveCodexAppServerAuthProfileId,
  resolveCodexAppServerAuthProfileIdForAgent,
} from "./auth-bridge.js";
import {
  defaultLeasedCodexAppServerClientFactory,
  type CodexAppServerClientFactory,
} from "./client-factory.js";
import { isCodexAppServerApprovalRequest, type CodexAppServerClient } from "./client.js";
import {
  isCodexAppServerApprovalPolicyAllowedByRequirements,
  isCodexSandboxExecServerEnabled,
  readCodexPluginConfig,
  resolveCodexComputerUseConfig,
  resolveCodexAppServerRuntimeOptions,
  resolveOpenClawExecPolicyForCodexAppServer,
  shouldAutoApproveCodexAppServerApprovals,
  type CodexAppServerRuntimeOptions,
} from "./config.js";
import {
  projectContextEngineAssemblyForCodex,
  resolveCodexContextEngineProjectionMaxChars,
  resolveCodexContextEngineProjectionReserveTokens,
} from "./context-engine-projection.js";
import {
  buildDynamicTools,
  createCodexDynamicToolBuildStageTracker,
  filterCodexDynamicToolsForAllowlist,
  formatCodexDynamicToolBuildStageSummary,
  includeForcedCodexDynamicToolAllow,
  isCodexNativeExecutionBlockedByNodeExecHost,
  resolveCodexAppServerHookChannelId,
  resolveOpenClawCodingToolsSessionKeys,
  resetOpenClawCodingToolsFactoryForTests,
  setOpenClawCodingToolsFactoryForTests,
  shouldEnableCodexAppServerNativeToolSurface,
  shouldForceMessageTool,
  shouldWarnCodexDynamicToolBuildStageSummary,
} from "./dynamic-tool-build.js";
import {
  emitDynamicToolErrorDiagnostic,
  emitDynamicToolStartedDiagnostic,
  emitDynamicToolTerminalDiagnostic,
} from "./dynamic-tool-diagnostics.js";
import {
  handleDynamicToolCallWithTimeout,
  hasPendingDynamicToolTerminalDiagnostic,
  isDynamicToolTerminalDiagnosticEvent,
  isMatchingDynamicToolTerminalDiagnostic,
  resolveDynamicToolCallTimeoutMs,
  resolveTerminalDynamicToolBatchAction,
  shouldBlockTerminalReleaseForNonTerminalDynamicToolResult,
  shouldReleaseTurnAfterTerminalDynamicTool,
  toCodexDynamicToolProgressResponse,
  toCodexDynamicToolProtocolResponse,
} from "./dynamic-tool-execution.js";
import {
  filterCodexDynamicTools,
  resolveCodexDynamicToolsLoadingForModel,
} from "./dynamic-tool-profile.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import { handleCodexAppServerElicitationRequest } from "./elicitation-bridge.js";
import {
  CodexAppServerEventProjector,
  shouldEmitTranscriptToolProgress,
} from "./event-projector.js";
import {
  buildCodexNativeHookRelayDisabledConfig,
  buildCodexNativeHookRelayConfig,
  buildCodexNativeHookRelayId,
  clearPendingCodexNativeHookRelayUnregistersForTests,
  CODEX_NATIVE_HOOK_RELAY_TTL_GRACE_MS,
  createCodexNativeHookRelay,
  flushPendingCodexNativeHookRelayUnregistersForTests,
  resolveCodexNativeHookRelayEvents,
  resolveCodexNativeHookRelayTtlMs,
  resolveCodexNativeHookRelayUnregisterGraceMs,
  scheduleCodexNativeHookRelayUnregister,
} from "./native-hook-relay.js";
import { registerCodexNativeSubagentMonitor } from "./native-subagent-monitor.js";
import { describeCodexNotificationCorrelation } from "./notification-correlation.js";
import { isCodexAppServerProfilerEnabled } from "./profiler-flag.js";
import {
  assertCodexTurnStartResponse,
  readCodexDynamicToolCallParams,
} from "./protocol-validators.js";
import type {
  CodexSandboxPolicy,
  CodexTurnEnvironmentParams,
  CodexServerNotification,
  CodexDynamicToolCallParams,
  CodexDynamicToolCallResponse,
  CodexTurnStartResponse,
  JsonObject,
  JsonValue,
} from "./protocol.js";
import { releaseCodexSandboxExecServerEnvironment } from "./sandbox-exec-server.js";
import {
  clearCodexAppServerBinding,
  clearCodexAppServerBindingForThread,
  readCodexAppServerBinding,
  writeCodexAppServerBinding,
  type CodexAppServerThreadBinding,
} from "./session-binding.js";
import { rotateOversizedCodexAppServerStartupBinding } from "./startup-binding.js";
import {
  buildDeveloperInstructions,
  buildContextEngineBinding,
  buildTurnCollaborationMode,
  buildTurnStartParams,
  codexDynamicToolsFingerprint,
  type CodexAppServerThreadLifecycleBinding,
  type CodexContextEngineThreadBootstrapProjection,
} from "./thread-lifecycle.js";
import {
  inferCodexDynamicToolMeta,
  resolveCodexToolProgressDetailMode,
  sanitizeCodexToolArguments,
  sanitizeCodexToolResponse,
} from "./tool-progress-normalization.js";
import {
  createCodexTrajectoryRecorder,
  normalizeCodexTrajectoryError,
  recordCodexTrajectoryCompletion,
  recordCodexTrajectoryContext,
} from "./trajectory.js";
import {
  buildCodexUserPromptMessage,
  createCodexAppServerUserMessagePersistenceNotifier,
  mirrorPromptAtTurnStartBestEffort,
  mirrorTranscriptBestEffort,
} from "./transcript-mirror.js";
import {
  formatCodexTurnStartUsageLimitError,
  markCodexAuthProfileBlockedFromRateLimits,
  refreshCodexUsageLimitPromptError,
} from "./usage-limit-error.js";
import { createCodexUserInputBridge } from "./user-input-bridge.js";

const CODEX_NATIVE_HOOK_RELAY_RENEW_INTERVAL_MS = 60_000;
const CODEX_APP_SERVER_PROJECTED_CHARS_PER_TOKEN = 4;
const ensuredCodexWorkspaceDirs = new Set<string>();

function estimateCodexAppServerProjectedTurnTokens(params: {
  prompt: string;
  developerInstructions?: string;
}): number {
  const inputChars = params.prompt.length + (params.developerInstructions?.length ?? 0);
  return Math.max(1, Math.ceil(inputChars / CODEX_APP_SERVER_PROJECTED_CHARS_PER_TOKEN));
}

async function ensureCodexWorkspaceDirOnce(workspaceDir: string): Promise<void> {
  const normalized = path.resolve(workspaceDir);
  if (ensuredCodexWorkspaceDirs.has(normalized)) {
    try {
      const stat = await fs.stat(normalized);
      if (stat.isDirectory()) {
        return;
      }
    } catch (error) {
      const code =
        typeof error === "object" && error ? (error as { code?: unknown }).code : undefined;
      if (code !== "ENOENT") {
        throw error;
      }
    }
    ensuredCodexWorkspaceDirs.delete(normalized);
  }
  // Codex attempts re-enter the same workspace repeatedly; caching successful
  // mkdirs avoids repeated fs work while still recovering if cleanup prunes
  // the directory between attempts.
  await fs.mkdir(normalized, { recursive: true });
  ensuredCodexWorkspaceDirs.add(normalized);
}

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

function toTranscriptToolResult(response: CodexDynamicToolCallResponse): Record<string, unknown> {
  const sanitized = sanitizeCodexToolResponse(response);
  const contentItems = Array.isArray(sanitized.contentItems) ? sanitized.contentItems : [];
  const result: Record<string, unknown> = {
    ...sanitized,
    // Progress events are UI/transcript-facing; map only sanitized content so
    // event redaction cannot be bypassed by raw dynamic tool output.
    content: contentItems.map(toTranscriptToolResultContentItem),
  };
  delete result.contentItems;
  delete result.success;
  return result;
}

function toTranscriptToolResultContentItem(item: unknown): Record<string, unknown> {
  if (!item || typeof item !== "object") {
    return { type: "text", text: "" };
  }
  const record = item as Record<string, unknown>;
  if (record.type === "inputText") {
    return { type: "text", text: typeof record.text === "string" ? record.text : "" };
  }
  if (record.type === "inputImage") {
    return typeof record.imageUrl === "string"
      ? { type: "image", url: record.imageUrl }
      : { type: "text", text: formatUnsupportedCodexDynamicToolOutput(record.type) };
  }
  return { type: "text", text: formatUnsupportedCodexDynamicToolOutput(record.type) };
}

function formatUnsupportedCodexDynamicToolOutput(type: unknown): string {
  const rawType = typeof type === "string" ? type.replace(/\s+/g, " ").trim() : "";
  const label = rawType ? rawType.slice(0, 80) : "unknown";
  const suffix = rawType.length > 80 ? "..." : "";
  return `[Unsupported Codex dynamic tool output: ${label}${suffix}]`;
}

type CodexAgentEndHookParams = Parameters<typeof runAgentHarnessAgentEndHook>[0];

function shouldAwaitCodexAgentEndHook(params: EmbeddedRunAttemptParams): boolean {
  return !params.messageChannel && !params.messageProvider;
}

async function runCodexAgentEndHook(
  params: EmbeddedRunAttemptParams,
  hookParams: CodexAgentEndHookParams,
): Promise<void> {
  if (shouldAwaitCodexAgentEndHook(params)) {
    await awaitAgentHarnessAgentEndHook(hookParams);
    return;
  }
  runAgentHarnessAgentEndHook(hookParams);
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
    turnAssistantCompletionIdleTimeoutMs?: number;
    postToolRawAssistantCompletionIdleTimeoutMs?: number;
    turnTerminalIdleTimeoutMs?: number;
    clientFactory?: CodexAppServerClientFactory;
  } = {},
): Promise<EmbeddedRunAttemptResult> {
  const attemptStartedAt = Date.now();
  const profilerEnabled = isCodexAppServerProfilerEnabled(params.config);
  const codexModelCallTrace = freezeDiagnosticTraceContext(
    createDiagnosticTraceContextFromActiveScope(),
  );
  const codexModelContentCapture = resolveDiagnosticModelContentCapturePolicy(params.config);
  const codexModelCallId = `${params.runId}:codex-model:1`;
  // Startup phase timings are profiler-gated because this function runs before
  // every Codex turn; normal production should not do timing bookkeeping here.
  const preDynamicStartupStages = createCodexDynamicToolBuildStageTracker({
    enabled: profilerEnabled,
  });
  const attemptClientFactory = options.clientFactory ?? defaultLeasedCodexAppServerClientFactory;
  const pluginConfig = readCodexPluginConfig(options.pluginConfig);
  const computerUseConfig = resolveCodexComputerUseConfig({ pluginConfig });
  const { sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
    agentId: params.agentId,
  });
  const beforeToolCallPolicy = getBeforeToolCallPolicyDiagnosticState();
  preDynamicStartupStages.mark("config");
  const resolvedWorkspace = resolveUserPath(params.workspaceDir);
  await ensureCodexWorkspaceDirOnce(resolvedWorkspace);
  preDynamicStartupStages.mark("workspace");
  const sandboxSessionKey =
    params.sandboxSessionKey?.trim() || params.sessionKey?.trim() || params.sessionId;
  const contextSessionKey = params.sessionKey?.trim() || sandboxSessionKey;
  const sandbox = await resolveSandboxContext({
    config: params.config,
    sessionKey: sandboxSessionKey,
    workspaceDir: resolvedWorkspace,
  });
  preDynamicStartupStages.mark("sandbox");
  const execPolicy = resolveOpenClawExecPolicyForCodexAppServer({
    execOverrides: params.execOverrides,
    approvals: loadExecApprovals(),
    config: params.config,
    agentId: sessionAgentId,
  });
  const configuredAppServer = resolveCodexAppServerRuntimeOptions({
    pluginConfig,
    execPolicy,
    openClawSandboxActive: sandbox?.enabled === true,
  });
  const effectiveWorkspace = sandbox?.enabled
    ? sandbox.workspaceAccess === "rw"
      ? resolvedWorkspace
      : sandbox.workspaceDir
    : resolvedWorkspace;
  const requestedCwd = params.cwd ? resolveUserPath(params.cwd) : undefined;
  if (sandbox?.enabled && requestedCwd && requestedCwd !== resolvedWorkspace) {
    throw new Error(
      "cwd override is not supported for sandboxed Codex app-server runs; omit cwd or use the agent workspace as cwd",
    );
  }
  const effectiveCwd = sandbox?.enabled ? effectiveWorkspace : (requestedCwd ?? effectiveWorkspace);
  await ensureCodexWorkspaceDirOnce(effectiveWorkspace);
  preDynamicStartupStages.mark("effective-workspace");
  const appServer = resolveCodexAppServerForOpenClawToolPolicy({
    appServer: configuredAppServer,
    pluginConfig,
    env: process.env,
    shouldPromote:
      beforeToolCallPolicy.hasBeforeToolCallHook ||
      beforeToolCallPolicy.trustedToolPolicies.length > 0,
    execPolicy,
    canUseUntrustedApprovalPolicy:
      configuredAppServer.start.transport !== "stdio" ||
      isCodexAppServerApprovalPolicyAllowedByRequirements("untrusted"),
  });
  if (configuredAppServer.approvalPolicy === "never" && appServer.approvalPolicy === "untrusted") {
    embeddedAgentLog.info("codex app-server approval policy promoted for OpenClaw tool policy", {
      from: "never",
      to: "untrusted",
      beforeToolCallHook: beforeToolCallPolicy.hasBeforeToolCallHook,
      trustedToolPolicies: beforeToolCallPolicy.trustedToolPolicies,
    });
  }
  preDynamicStartupStages.mark("app-server-policy");
  let pluginAppServer: CodexAppServerRuntimeOptions = appServer;
  const nativeHookRelayEvents = resolveCodexNativeHookRelayEvents({
    configuredEvents: options.nativeHookRelay?.events,
    appServer,
  });
  preDynamicStartupStages.mark("native-hook-relay");

  const runAbortController = new AbortController();
  const abortFromUpstream = () => {
    runAbortController.abort(params.abortSignal?.reason ?? "upstream_abort");
  };
  if (params.abortSignal?.aborted) {
    abortFromUpstream();
  } else {
    params.abortSignal?.addEventListener("abort", abortFromUpstream, { once: true });
  }

  const agentDir = params.agentDir ?? resolveAgentDir(params.config ?? {}, sessionAgentId);
  preDynamicStartupStages.mark("session-agent");
  const activeContextEngine = isActiveHarnessContextEngine(params.contextEngine)
    ? params.contextEngine
    : undefined;
  const isInactiveThreadBootstrapBinding = (binding: CodexAppServerThreadBinding | undefined) =>
    !activeContextEngine && binding?.contextEngine?.projection?.mode === "thread_bootstrap";
  let startupBinding = await readCodexAppServerBinding(params.sessionFile);
  preDynamicStartupStages.mark("read-binding");
  const startupBindingAuthProfileId = startupBinding?.authProfileId;
  const initialStartupBindingHadInactiveThreadBootstrap =
    isInactiveThreadBootstrapBinding(startupBinding);
  startupBinding = await rotateOversizedCodexAppServerStartupBinding({
    binding: startupBinding,
    sessionFile: params.sessionFile,
    agentDir,
    codexHome: appServer.start.env?.CODEX_HOME,
    config: params.config,
    contextEngineActive: Boolean(activeContextEngine),
  });
  const initialInactiveThreadBootstrapBindingForcedFreshStart =
    initialStartupBindingHadInactiveThreadBootstrap && !startupBinding?.threadId;
  preDynamicStartupStages.mark("rotate-binding");
  const startupAuthProfileCandidate =
    params.runtimePlan?.auth.forwardedAuthProfileId ??
    params.authProfileId ??
    startupBinding?.authProfileId ??
    startupBindingAuthProfileId;
  const startupAuthProfileId = params.authProfileStore
    ? resolveCodexAppServerAuthProfileId({
        authProfileId: startupAuthProfileCandidate,
        store: params.authProfileStore,
        config: params.config,
      })
    : resolveCodexAppServerAuthProfileIdForAgent({
        authProfileId: startupAuthProfileCandidate,
        agentDir,
        config: params.config,
      });
  preDynamicStartupStages.mark("auth-profile");
  const runtimeParams = {
    ...params,
    sessionKey: contextSessionKey,
    ...(startupAuthProfileId ? { authProfileId: startupAuthProfileId } : {}),
  };
  const activeSessionId = params.sessionId;
  const activeSessionFile = params.sessionFile;
  const buildActiveRunAttemptParams = (): EmbeddedRunAttemptParams => ({
    ...runtimeParams,
    sessionId: activeSessionId,
    sessionFile: activeSessionFile,
  });
  const startupAuthAccountCacheKey = await resolveCodexAppServerAuthAccountCacheKey({
    authProfileId: startupAuthProfileId,
    authProfileStore: params.authProfileStore,
    agentDir,
    config: params.config,
  });
  const startupEnvApiKeyCacheKey = startupAuthProfileId
    ? undefined
    : resolveCodexAppServerFallbackApiKeyCacheKey({
        startOptions: appServer.start,
      });
  preDynamicStartupStages.mark("auth-cache");
  const nodeExecBlocksNativeExecution = isCodexNativeExecutionBlockedByNodeExecHost(params, {
    agentId: sessionAgentId,
    runtimeSessionKey: sandboxSessionKey,
    sandbox,
  });
  preDynamicStartupStages.mark("native-exec-policy");
  const bundleMcpThreadConfig = await loadCodexBundleMcpThreadConfig({
    workspaceDir: effectiveWorkspace,
    cfg: params.config,
    toolsEnabled: supportsModelTools(params.model),
    disableTools: params.disableTools,
    toolsAllow: nodeExecBlocksNativeExecution ? [] : params.toolsAllow,
  });
  preDynamicStartupStages.mark("bundle-mcp");
  const sandboxExecServerEnabled = isCodexSandboxExecServerEnabled(pluginConfig);
  const nativeToolSurfaceEnabled = shouldEnableCodexAppServerNativeToolSurface(params, sandbox, {
    agentId: sessionAgentId,
    runtimeSessionKey: sandboxSessionKey,
    sandboxExecServerEnabled,
  });
  preDynamicStartupStages.mark("native-tool-surface");
  for (const diagnostic of bundleMcpThreadConfig.diagnostics) {
    embeddedAgentLog.warn(`bundle-mcp: ${diagnostic.pluginId}: ${diagnostic.message}`);
  }
  if (activeContextEngine) {
    assertContextEngineHostSupport({
      contextEngine: activeContextEngine,
      operation: "agent-run",
      host: CODEX_APP_SERVER_CONTEXT_ENGINE_HOST,
    });
  }
  const hookChannelId = resolveCodexAppServerHookChannelId(params, sandboxSessionKey);
  preDynamicStartupStages.mark("context-engine-support");
  const preDynamicSummary = preDynamicStartupStages.snapshot();
  if (shouldWarnCodexDynamicToolBuildStageSummary(preDynamicSummary)) {
    embeddedAgentLog.warn(
      `codex app-server pre-dynamic startup timings runId=${params.runId} sessionId=${params.sessionId} totalMs=${preDynamicSummary.totalMs} stages=${formatCodexDynamicToolBuildStageSummary(preDynamicSummary)}`,
      {
        runId: params.runId,
        sessionId: params.sessionId,
        totalMs: preDynamicSummary.totalMs,
        stages: preDynamicSummary.stages,
        hasStartupBinding: Boolean(startupBinding?.threadId),
        startupAuthProfileId: startupAuthProfileId ?? null,
        bundleMcpDiagnosticCount: bundleMcpThreadConfig.diagnostics.length,
        nativeToolSurfaceEnabled,
      },
    );
  }
  let yieldDetected = false;
  const tools = await buildDynamicTools({
    params,
    resolvedWorkspace,
    effectiveWorkspace,
    effectiveCwd,
    sandboxSessionKey,
    sandbox,
    nativeToolSurfaceEnabled,
    runAbortController,
    sessionAgentId,
    pluginConfig,
    profilerEnabled,
    onYieldDetected: () => {
      yieldDetected = true;
    },
    onCodexAppServerEvent: (event) => emitCodexAppServerEvent(params, event),
  });
  const registeredTools = await buildDynamicTools({
    params,
    resolvedWorkspace,
    effectiveWorkspace,
    effectiveCwd,
    sandboxSessionKey,
    sandbox,
    nativeToolSurfaceEnabled,
    runAbortController,
    sessionAgentId,
    pluginConfig,
    profilerEnabled,
    forceHeartbeatTool: true,
    ignoreRuntimePlan: true,
    onYieldDetected: () => {
      yieldDetected = true;
    },
    onCodexAppServerEvent: (event) => emitCodexAppServerEvent(params, event),
  });
  const toolBridge = createCodexDynamicToolBridge({
    tools,
    registeredTools,
    signal: runAbortController.signal,
    loading: resolveCodexDynamicToolsLoadingForModel(pluginConfig, params.modelId),
    directToolNames: shouldForceMessageTool(params) ? ["message"] : [],
    hookContext: {
      agentId: sessionAgentId,
      config: params.config,
      sessionId: params.sessionId,
      sessionKey: sandboxSessionKey,
      runId: params.runId,
      channelId: hookChannelId,
    },
  });
  const hadSessionFile = await pathExists(activeSessionFile);
  let historyMessages = (await readMirroredSessionHistoryMessages(activeSessionFile)) ?? [];
  const hookContextWindowFields = {
    ...(params.contextWindowInfo?.tokens
      ? { contextTokenBudget: params.contextWindowInfo.tokens }
      : params.contextTokenBudget
        ? { contextTokenBudget: params.contextTokenBudget }
        : {}),
    ...(params.contextWindowInfo?.source
      ? { contextWindowSource: params.contextWindowInfo.source }
      : {}),
    ...(params.contextWindowInfo?.referenceTokens
      ? { contextWindowReferenceTokens: params.contextWindowInfo.referenceTokens }
      : {}),
  };
  const hookContext = {
    runId: params.runId,
    agentId: sessionAgentId,
    sessionKey: sandboxSessionKey,
    sessionId: params.sessionId,
    workspaceDir: params.workspaceDir,
    messageProvider: params.messageProvider ?? undefined,
    trigger: params.trigger,
    channelId: hookChannelId,
    ...hookContextWindowFields,
  };
  const hookRunner = getAgentHarnessHookRunner();
  const activeContextEnginePluginId = activeContextEngine
    ? resolveContextEngineOwnerPluginId(activeContextEngine)
    : undefined;
  const buildActiveContextEngineRuntimeContext = () =>
    buildHarnessContextEngineRuntimeContext({
      attempt: buildActiveRunAttemptParams(),
      workspaceDir: effectiveWorkspace,
      cwd: effectiveCwd,
      agentDir,
      activeAgentId: sessionAgentId,
      contextEnginePluginId: activeContextEnginePluginId,
      tokenBudget: params.contextTokenBudget,
    });
  if (activeContextEngine) {
    await bootstrapHarnessContextEngine({
      hadSessionFile,
      contextEngine: activeContextEngine,
      sessionId: activeSessionId,
      sessionKey: contextSessionKey,
      sessionFile: activeSessionFile,
      runtimeContext: buildActiveContextEngineRuntimeContext(),
      runMaintenance: runHarnessContextEngineMaintenance,
      config: params.config,
      warn: (message) => embeddedAgentLog.warn(message),
    });
    historyMessages =
      (await readMirroredSessionHistoryMessages(activeSessionFile)) ?? historyMessages;
  }
  const memoryToolNames = getCodexWorkspaceMemoryToolNames(toolBridge.availableSpecs);
  const workspaceBootstrapContext = await buildCodexWorkspaceBootstrapContext({
    params,
    resolvedWorkspace,
    effectiveWorkspace,
    sessionKey: contextSessionKey,
    sessionAgentId,
    memoryToolNames,
  });
  const baseDeveloperInstructions = joinPresentSections(
    buildDeveloperInstructions(params, {
      dynamicTools: toolBridge.availableSpecs,
    }),
    workspaceBootstrapContext.developerInstructions,
  );
  const openClawPromptContext = buildCodexOpenClawPromptContext({
    params,
    workspacePromptContext: workspaceBootstrapContext.promptContext,
  });
  const skillsCollaborationInstructions = renderCodexSkillsCollaborationInstructions({
    attempt: params,
    skillsPrompt: params.skillsSnapshot?.prompt,
  });
  let promptText = params.prompt;
  let developerInstructions = baseDeveloperInstructions;
  let prePromptMessageCount = historyMessages.length;
  let contextEngineProjection: CodexContextEngineThreadBootstrapProjection | undefined;
  let precomputedStaleBindingContinuityProjectionApplied = false;
  let staleBindingContinuityForcedFreshStart = false;
  let inactiveThreadBootstrapBindingForcedFreshStart =
    initialInactiveThreadBootstrapBindingForcedFreshStart;
  const applyFreshThreadContinuityProjection = () => {
    const projection = projectContextEngineAssemblyForCodex({
      assembledMessages: historyMessages,
      originalHistoryMessages: historyMessages,
      prompt: params.prompt,
    });
    promptText = projection.promptText;
    prePromptMessageCount = projection.prePromptMessageCount;
  };
  const applyActiveContextEngineProjection = async (
    decisionStartupBinding: CodexAppServerThreadBinding | undefined,
  ) => {
    if (!activeContextEngine) {
      return;
    }
    const assembled = await assembleHarnessContextEngine({
      contextEngine: activeContextEngine,
      sessionId: activeSessionId,
      sessionKey: contextSessionKey,
      messages: historyMessages,
      tokenBudget: params.contextTokenBudget,
      availableTools: new Set(
        toolBridge.availableSpecs.map((tool) => tool.name).filter(isNonEmptyString),
      ),
      citationsMode: params.config?.memory?.citations,
      modelId: params.modelId,
      prompt: params.prompt,
    });
    if (!assembled) {
      throw new Error("context engine assemble returned no result");
    }
    contextEngineProjection = readContextEngineThreadBootstrapProjection(
      assembled.contextProjection,
    );
    const projection = projectContextEngineAssemblyForCodex({
      assembledMessages: assembled.messages,
      originalHistoryMessages: historyMessages,
      prompt: params.prompt,
      systemPromptAddition: assembled.systemPromptAddition,
      maxRenderedContextChars: resolveCodexContextEngineProjectionMaxChars({
        contextTokenBudget: params.contextTokenBudget,
        reserveTokens: resolveCodexContextEngineProjectionReserveTokens({
          config: params.config,
        }),
      }),
      toolPayloadMode: contextEngineProjection ? "preserve" : "elide",
    });
    const projectionDecision = contextEngineProjection
      ? resolveContextEngineBootstrapProjectionDecision({
          startupBinding: decisionStartupBinding,
          expectedBinding: buildContextEngineBinding(
            buildActiveRunAttemptParams(),
            contextEngineProjection,
          ),
          projection: contextEngineProjection,
          dynamicToolsFingerprint: codexDynamicToolsFingerprint(toolBridge.specs),
        })
      : { project: true, reason: "per-turn-projection" };
    embeddedAgentLog.info("codex app-server context-engine projection decision", {
      sessionId: params.sessionId,
      sessionKey: contextSessionKey,
      engineId: activeContextEngine.info.id,
      mode: contextEngineProjection?.mode ?? assembled.contextProjection?.mode ?? "per_turn",
      epoch: contextEngineProjection?.epoch,
      fingerprint: contextEngineProjection?.fingerprint,
      previousThreadId: decisionStartupBinding?.threadId,
      previousEpoch: decisionStartupBinding?.contextEngine?.projection?.epoch,
      previousFingerprint: decisionStartupBinding?.contextEngine?.projection?.fingerprint,
      projected: projectionDecision.project,
      reason: projectionDecision.reason,
      assembledMessages: assembled.messages.length,
      originalHistoryMessages: historyMessages.length,
      projectedPromptChars: projection.promptText.length,
      developerInstructionAdditionChars: projection.developerInstructionAddition?.length ?? 0,
    });
    promptText = projectionDecision.project ? projection.promptText : params.prompt;
    developerInstructions = joinPresentSections(
      baseDeveloperInstructions,
      projection.developerInstructionAddition,
    );
    prePromptMessageCount = projection.prePromptMessageCount;
  };
  if (activeContextEngine) {
    try {
      await applyActiveContextEngineProjection(
        !nativeToolSurfaceEnabled ? undefined : startupBinding,
      );
    } catch (assembleErr) {
      embeddedAgentLog.warn("context engine assemble failed; using Codex baseline prompt", {
        error: formatErrorMessage(assembleErr),
      });
    }
  }
  // Codex app-server threads own conversation continuity. The mirrored
  // OpenClaw transcript is persistence/search state. Context-engine output is
  // rendered into the prompt/developer instructions, not parallel history.
  const codexModelInputHistoryMessages: typeof historyMessages = [];
  const buildPromptFromCurrentInputs = () =>
    resolveAgentHarnessBeforePromptBuildResult({
      prompt: prependCurrentInboundContext(promptText, params.currentInboundContext),
      developerInstructions,
      messages: codexModelInputHistoryMessages,
      ctx: hookContext,
    });
  let promptBuild = await buildPromptFromCurrentInputs();
  const decorateCodexTurnPromptText = (prompt: string) =>
    prependCodexOpenClawPromptContext(prompt, openClawPromptContext, {
      preservePromptWithoutContext:
        params.bootstrapContextMode === "lightweight" && params.bootstrapContextRunKind === "cron",
    });
  let codexTurnPromptText = decorateCodexTurnPromptText(promptBuild.prompt);
  const buildCodexTurnCollaborationDeveloperInstructions = () =>
    buildTurnCollaborationMode(params, {
      turnScopedDeveloperInstructions: workspaceBootstrapContext.turnScopedDeveloperInstructions,
      skillsCollaborationInstructions,
      memoryCollaborationInstructions: workspaceBootstrapContext.memoryCollaborationInstructions,
      heartbeatCollaborationInstructions:
        workspaceBootstrapContext.heartbeatCollaborationInstructions,
    }).settings.developer_instructions ?? undefined;
  const buildRenderedCodexDeveloperInstructions = () =>
    joinPresentSections(
      promptBuild.developerInstructions,
      buildCodexTurnCollaborationDeveloperInstructions(),
    );
  const rebuildCodexPromptBuildFromCurrentProjection = async () => {
    promptBuild = await buildPromptFromCurrentInputs();
    codexTurnPromptText = decorateCodexTurnPromptText(promptBuild.prompt);
  };
  const rebuildCodexTurnPromptTextFromCurrentProjection = async () => {
    const nextPromptBuild = await buildPromptFromCurrentInputs();
    // Native Codex thread instructions are fixed once thread/start or
    // thread/resume completes; recovery continuity after that is turn input.
    promptBuild = {
      ...promptBuild,
      prompt: nextPromptBuild.prompt,
    };
    codexTurnPromptText = decorateCodexTurnPromptText(nextPromptBuild.prompt);
  };
  const selectNewerVisibleHistoryAfterBinding = (binding: CodexAppServerThreadBinding) => {
    const bindingUpdatedAt = Date.parse(binding.updatedAt);
    if (!Number.isFinite(bindingUpdatedAt)) {
      return [];
    }
    return historyMessages.filter((message) => {
      if (message.role !== "user" && message.role !== "assistant") {
        return false;
      }
      const record = message as unknown as Record<string, unknown>;
      const idempotencyKey = record.idempotencyKey;
      if (typeof idempotencyKey === "string" && idempotencyKey.startsWith("codex-app-server:")) {
        return false;
      }
      const meta = record["__openclaw"];
      const mirrorIdentity =
        meta && typeof meta === "object" && !Array.isArray(meta)
          ? (meta as Record<string, unknown>).mirrorIdentity
          : undefined;
      if (typeof mirrorIdentity === "string" && mirrorIdentity.startsWith("codex-app-server:")) {
        return false;
      }
      const timestamp =
        typeof message.timestamp === "number"
          ? message.timestamp
          : typeof message.timestamp === "string"
            ? Date.parse(message.timestamp)
            : Number.NaN;
      return Number.isFinite(timestamp) && timestamp > bindingUpdatedAt;
    });
  };
  const applyResumeStaleBindingContinuityProjection = (binding: CodexAppServerThreadBinding) => {
    const newerVisibleMessages = selectNewerVisibleHistoryAfterBinding(binding);
    if (newerVisibleMessages.length === 0) {
      return false;
    }
    const projection = projectContextEngineAssemblyForCodex({
      assembledMessages: newerVisibleMessages,
      originalHistoryMessages: historyMessages,
      prompt: params.prompt,
    });
    promptText = projection.promptText;
    prePromptMessageCount = projection.prePromptMessageCount;
    return true;
  };
  const precomputeNoContextEngineStaleBindingProjection = (
    binding: CodexAppServerThreadBinding | undefined,
  ) => {
    precomputedStaleBindingContinuityProjectionApplied = false;
    staleBindingContinuityForcedFreshStart = false;
    if (activeContextEngine || !binding?.threadId) {
      return false;
    }
    if (isInactiveThreadBootstrapBinding(binding)) {
      inactiveThreadBootstrapBindingForcedFreshStart = true;
      return false;
    }
    const projected = applyResumeStaleBindingContinuityProjection(binding);
    precomputedStaleBindingContinuityProjectionApplied = projected;
    return projected;
  };
  const applyNoContextEngineContinuityProjection = (
    action: "started" | "resumed",
    binding?: CodexAppServerThreadBinding,
  ) => {
    if (activeContextEngine || !historyMessages.some((message) => message.role === "user")) {
      return false;
    }
    if (action === "resumed" && precomputedStaleBindingContinuityProjectionApplied) {
      return true;
    }
    if (action === "started" && staleBindingContinuityForcedFreshStart) {
      return true;
    }
    if (action === "started" && inactiveThreadBootstrapBindingForcedFreshStart) {
      // A retired thread-bootstrap context engine already forced Codex onto a
      // clean native thread; without that engine active, mirrored history would
      // re-inject stale bootstrap context as a new user turn.
      return false;
    }
    if (action === "resumed" && binding) {
      return applyResumeStaleBindingContinuityProjection(binding);
    }
    if (action === "started") {
      applyFreshThreadContinuityProjection();
      return true;
    }
    return false;
  };
  if (precomputeNoContextEngineStaleBindingProjection(startupBinding)) {
    await rebuildCodexPromptBuildFromCurrentProjection();
  }
  const rotateStartupBindingForProjectedTurn = async () => {
    if (!startupBinding?.threadId) {
      return;
    }
    const previousThreadId = startupBinding.threadId;
    const hadInactiveThreadBootstrapBinding = isInactiveThreadBootstrapBinding(startupBinding);
    const projectedTurnTokens = estimateCodexAppServerProjectedTurnTokens({
      prompt: codexTurnPromptText,
      developerInstructions: buildRenderedCodexDeveloperInstructions(),
    });
    startupBinding = await rotateOversizedCodexAppServerStartupBinding({
      binding: startupBinding,
      sessionFile: params.sessionFile,
      agentDir,
      codexHome: appServer.start.env?.CODEX_HOME,
      config: params.config,
      contextEngineActive: Boolean(activeContextEngine),
      projectedTurnTokens,
    });
    if (startupBinding?.threadId) {
      return;
    }
    inactiveThreadBootstrapBindingForcedFreshStart = hadInactiveThreadBootstrapBinding;
    staleBindingContinuityForcedFreshStart =
      precomputedStaleBindingContinuityProjectionApplied &&
      !inactiveThreadBootstrapBindingForcedFreshStart;
    if (activeContextEngine) {
      contextEngineProjection = undefined;
      try {
        await applyActiveContextEngineProjection(undefined);
      } catch (assembleErr) {
        embeddedAgentLog.warn("context engine assemble failed; using Codex baseline prompt", {
          error: formatErrorMessage(assembleErr),
        });
      }
    }
    await rebuildCodexPromptBuildFromCurrentProjection();
    embeddedAgentLog.info("codex app-server rebuilt turn prompt after native thread rotation", {
      sessionId: params.sessionId,
      sessionKey: contextSessionKey,
      previousThreadId,
      promptChars: codexTurnPromptText.length,
      developerInstructionChars: buildRenderedCodexDeveloperInstructions()?.length ?? 0,
    });
  };
  await rotateStartupBindingForProjectedTurn();
  const systemPromptReport = buildCodexSystemPromptReport({
    attempt: params,
    sessionKey: contextSessionKey,
    workspaceDir: effectiveWorkspace,
    developerInstructions: buildRenderedCodexDeveloperInstructions(),
    workspaceBootstrapContext,
    skillsPrompt: skillsCollaborationInstructions ? (params.skillsSnapshot?.prompt ?? "") : "",
    tools: toolBridge.availableSpecs,
  });
  const trajectoryRecorder = createCodexTrajectoryRecorder({
    attempt: params,
    cwd: effectiveCwd,
    developerInstructions: buildRenderedCodexDeveloperInstructions(),
    prompt: codexTurnPromptText,
    tools: toolBridge.availableSpecs,
  });
  let client: CodexAppServerClient;
  let thread: CodexAppServerThreadLifecycleBinding;
  let trajectoryEndRecorded = false;
  const markTrajectoryEndRecorded = () => {
    trajectoryEndRecorded = true;
  };
  let nativeHookRelay: NativeHookRelayRegistrationHandle | undefined;
  let releaseSharedClientLease: (() => void) | undefined;
  const releaseSharedClientLeaseOnce = () => {
    const release = releaseSharedClientLease;
    if (!release) {
      return;
    }
    releaseSharedClientLease = undefined;
    release();
  };
  let sandboxExecEnvironmentAcquired = false;
  const releaseSandboxExecEnvironment = async () => {
    if (sandboxExecEnvironmentAcquired) {
      sandboxExecEnvironmentAcquired = false;
      await releaseCodexSandboxExecServerEnvironment(sandbox);
    }
  };
  let codexEnvironmentSelection: CodexTurnEnvironmentParams[] | undefined;
  let codexExecutionCwd = effectiveCwd;
  let codexSandboxPolicy: CodexSandboxPolicy | undefined;
  let restartContextEngineCodexThread:
    | (() => Promise<CodexAppServerThreadLifecycleBinding>)
    | undefined;
  const startupTimeoutMs = resolveCodexStartupTimeoutMs({
    timeoutMs: params.timeoutMs,
    timeoutFloorMs: options.startupTimeoutFloorMs,
  });
  const buildNativeHookRelayFinalConfigPatch = (
    decision: { action: "resume"; binding: CodexAppServerThreadBinding } | { action: "start" },
  ) => {
    nativeHookRelay?.unregister();
    nativeHookRelay = createCodexNativeHookRelay({
      options: options.nativeHookRelay,
      generation:
        decision.action === "resume" ? decision.binding.nativeHookRelayGeneration : undefined,
      generationMismatchGraceMs:
        decision.action === "resume" && !decision.binding.nativeHookRelayGeneration
          ? CODEX_NATIVE_HOOK_RELAY_TTL_GRACE_MS
          : undefined,
      events: nativeHookRelayEvents,
      agentId: sessionAgentId,
      sessionId: params.sessionId,
      sessionKey: sandboxSessionKey,
      config: params.config,
      runId: params.runId,
      channelId: hookChannelId,
      attemptTimeoutMs: params.timeoutMs,
      startupTimeoutMs,
      turnStartTimeoutMs: params.timeoutMs,
      signal: runAbortController.signal,
    });
    return {
      configPatch: nativeHookRelay
        ? buildCodexNativeHookRelayConfig({
            relay: nativeHookRelay,
            events: nativeHookRelayEvents,
            hookTimeoutSec: options.nativeHookRelay?.hookTimeoutSec,
          })
        : options.nativeHookRelay?.enabled === false
          ? buildCodexNativeHookRelayDisabledConfig()
          : undefined,
      nativeHookRelayGeneration: nativeHookRelay?.generation,
    };
  };
  try {
    emitCodexAppServerEvent(params, {
      stream: "codex_app_server.lifecycle",
      data: { phase: "startup" },
    });
    const startupResult = await startCodexAttemptThread({
      attemptClientFactory,
      appServer,
      pluginConfig,
      computerUseConfig,
      startupAuthProfileId,
      startupAuthAccountCacheKey,
      startupEnvApiKeyCacheKey,
      agentDir,
      config: params.config,
      buildAttemptParams: buildActiveRunAttemptParams,
      sessionAgentId,
      effectiveWorkspace,
      effectiveCwd,
      dynamicTools: toolBridge.specs,
      developerInstructions: promptBuild.developerInstructions,
      buildFinalConfigPatch: buildNativeHookRelayFinalConfigPatch,
      bundleMcpThreadConfig,
      nativeToolSurfaceEnabled,
      sandboxExecServerEnabled,
      sandbox,
      contextEngineProjection,
      startupTimeoutMs,
      signal: runAbortController.signal,
      onStartupTimeout: () => {
        runAbortController.abort("codex_startup_timeout");
      },
      spawnedBy: params.spawnedBy,
    });
    client = startupResult.client;
    thread = startupResult.thread;
    pluginAppServer = startupResult.pluginAppServer;
    sandboxExecEnvironmentAcquired = Boolean(startupResult.sandboxEnvironment);
    codexEnvironmentSelection = startupResult.environmentSelection;
    codexExecutionCwd = startupResult.executionCwd;
    codexSandboxPolicy = startupResult.sandboxPolicy;
    releaseSharedClientLease = startupResult.releaseSharedClientLease;
    restartContextEngineCodexThread = startupResult.restartContextEngineCodexThread;
    emitCodexAppServerEvent(params, {
      stream: "codex_app_server.lifecycle",
      data: { phase: "thread_ready", threadId: thread.threadId },
    });
  } catch (error) {
    nativeHookRelay?.unregister();
    await releaseSandboxExecEnvironment();
    params.abortSignal?.removeEventListener("abort", abortFromUpstream);
    throw error;
  }
  if (applyNoContextEngineContinuityProjection(thread.lifecycle.action, thread)) {
    await rebuildCodexTurnPromptTextFromCurrentProjection();
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
    cwd: effectiveCwd,
    developerInstructions: buildRenderedCodexDeveloperInstructions(),
    prompt: codexTurnPromptText,
    tools: toolBridge.availableSpecs,
  });
  const pendingNotifications: CodexServerNotification[] = [];
  let completed = false;
  let terminalTurnNotificationQueued = false;
  let timedOut = false;
  let turnCompletionIdleTimedOut = false;
  let turnWatchTimeoutKind: CodexAttemptTurnWatchTimeoutKind | undefined;
  let turnWatchTimeoutIdleMs: number | undefined;
  let turnWatchTimeoutMs: number | undefined;
  let turnWatchTimeoutLastActivityReason: string | undefined;
  let turnWatchTimeoutDetails: Record<string, unknown> | undefined;
  let turnCompletionIdleTimeoutMessage: string | undefined;
  let clientClosedPromptError: string | undefined;
  let clientClosedAbort = false;
  let shouldDelayNativeHookRelayUnregister = false;
  let lifecycleStarted = false;
  let lifecycleTerminalEmitted = false;
  let resolveCompletion: (() => void) | undefined;
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });
  let notificationQueue: Promise<void> = Promise.resolve();
  const turnCompletionIdleTimeoutMs = resolveCodexTurnCompletionIdleTimeoutMs(
    options.turnCompletionIdleTimeoutMs ?? appServer.turnCompletionIdleTimeoutMs,
  );
  const turnAssistantCompletionIdleTimeoutMs = resolveCodexTurnAssistantCompletionIdleTimeoutMs(
    options.turnAssistantCompletionIdleTimeoutMs,
  );
  const postToolRawAssistantCompletionIdleTimeoutMs =
    resolveCodexPostToolRawAssistantCompletionIdleTimeoutMs(
      options.postToolRawAssistantCompletionIdleTimeoutMs ??
        appServer.postToolRawAssistantCompletionIdleTimeoutMs,
      turnAssistantCompletionIdleTimeoutMs,
    );
  const turnTerminalIdleTimeoutMs = resolveCodexTurnTerminalIdleTimeoutMs(
    options.turnTerminalIdleTimeoutMs,
  );
  const turnAttemptIdleTimeoutMs = Math.max(100, Math.floor(params.timeoutMs));
  let nativeHookRelayLastRenewedAt = 0;
  let activeAppServerTurnRequests = 0;
  const pendingOpenClawDynamicToolCompletionIds = new Set<string>();
  const activeTurnItemIds = new Set<string>();
  let turnCrossedToolHandoff = false;
  let pendingTerminalDynamicToolRelease:
    | {
        call: CodexDynamicToolCallParams;
        response: CodexDynamicToolCallResponse;
        durationMs: number;
      }
    | undefined;
  let terminalDynamicToolReleaseCheckScheduled = false;
  let currentTurnHadNonTerminalDynamicToolResult = false;
  const turnIdRef: { current?: string } = {};
  const projectorRef: { current?: CodexAppServerEventProjector } = {};
  const userInputBridgeRef: {
    current?: ReturnType<typeof createCodexUserInputBridge>;
  } = {};
  const steeringQueueRef: {
    current?: ReturnType<typeof createCodexSteeringQueue>;
  } = {};

  const renewNativeHookRelayForTurnProgress = () => {
    if (!nativeHookRelay || options.nativeHookRelay?.ttlMs !== undefined) {
      return;
    }
    const now = Date.now();
    const renewsRecently =
      now - nativeHookRelayLastRenewedAt < CODEX_NATIVE_HOOK_RELAY_RENEW_INTERVAL_MS;
    const expiresSoon = now >= nativeHookRelay.expiresAtMs - CODEX_NATIVE_HOOK_RELAY_TTL_GRACE_MS;
    if (renewsRecently && !expiresSoon) {
      return;
    }
    nativeHookRelayLastRenewedAt = now;
    nativeHookRelay.renew(
      resolveCodexNativeHookRelayTtlMs({
        explicitTtlMs: undefined,
        attemptTimeoutMs: turnAttemptIdleTimeoutMs,
        startupTimeoutMs,
        turnStartTimeoutMs: params.timeoutMs,
      }),
    );
  };

  const turnWatches = createCodexAttemptTurnWatchController({
    threadId: thread.threadId,
    signal: runAbortController.signal,
    getTurnId: () => turnIdRef.current,
    isCompleted: () => completed,
    isTerminalTurnNotificationQueued: () => terminalTurnNotificationQueued,
    getActiveAppServerTurnRequests: () => activeAppServerTurnRequests,
    getActiveTurnItemCount: () => activeTurnItemIds.size,
    turnCompletionIdleTimeoutMs,
    turnAssistantCompletionIdleTimeoutMs,
    turnAttemptIdleTimeoutMs,
    turnTerminalIdleTimeoutMs,
    interruptTimeoutMs: CODEX_APP_SERVER_INTERRUPT_TIMEOUT_MS,
    onInterruptTurn: (input) => interruptCodexTurnBestEffort(client, input),
    onTimeout: (timeout) => {
      timedOut = true;
      turnCompletionIdleTimedOut = true;
      turnWatchTimeoutKind = timeout.kind;
      turnWatchTimeoutIdleMs = timeout.idleMs;
      turnWatchTimeoutMs = timeout.timeoutMs;
      turnWatchTimeoutLastActivityReason = timeout.lastActivityReason;
      turnWatchTimeoutDetails = timeout.details;
      turnCompletionIdleTimeoutMessage =
        "codex app-server turn idle timed out waiting for turn/completed";
    },
    onMarkTimedOut: () => projectorRef.current?.markTimedOut(),
    onAbort: (reason) => runAbortController.abort(reason),
    onCompleted: () => {
      completed = true;
    },
    onResolveCompletion: () => resolveCompletion?.(),
    onRecordEvent: (name, fields) => trajectoryRecorder?.recordEvent(name, fields),
    onAttemptProgress: (reason) => {
      renewNativeHookRelayForTurnProgress();
      params.onRunProgress?.({
        reason,
        provider: params.provider,
        model: params.modelId,
        backend: "codex-app-server",
      });
    },
    onProgressDiagnostic: (reason) => {
      emitTrustedDiagnosticEvent({
        type: "run.progress",
        runId: params.runId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        reason: `codex_app_server:${reason}`,
      });
    },
  });

  const releaseTurnAfterTerminalDynamicTool = (paramsValue: {
    call: CodexDynamicToolCallParams;
    response: CodexDynamicToolCallResponse;
    durationMs: number;
  }) => {
    if (
      !shouldReleaseTurnAfterTerminalDynamicTool({
        completed,
        aborted: runAbortController.signal.aborted,
        responseSuccess: paramsValue.response.success,
        currentTurnHadNonTerminalDynamicToolResult,
        activeAppServerTurnRequests,
        activeTurnItemIdsCount: activeTurnItemIds.size,
        pendingOpenClawDynamicToolCompletionIdsCount: pendingOpenClawDynamicToolCompletionIds.size,
      })
    ) {
      return;
    }
    pendingTerminalDynamicToolRelease = undefined;
    trajectoryRecorder?.recordEvent("turn.dynamic_tool_terminal_release", {
      threadId: paramsValue.call.threadId,
      turnId: paramsValue.call.turnId,
      toolCallId: paramsValue.call.callId,
      name: paramsValue.call.tool,
      durationMs: paramsValue.durationMs,
    });
    embeddedAgentLog.info("codex app-server turn released after terminal dynamic tool result", {
      threadId: paramsValue.call.threadId,
      turnId: paramsValue.call.turnId,
      toolCallId: paramsValue.call.callId,
      tool: paramsValue.call.tool,
      durationMs: paramsValue.durationMs,
    });
    interruptCodexTurnBestEffort(client, {
      threadId: paramsValue.call.threadId,
      turnId: paramsValue.call.turnId,
      timeoutMs: CODEX_APP_SERVER_INTERRUPT_TIMEOUT_MS,
    });
    completed = true;
    turnWatches.clearCompletionIdleTimer();
    turnWatches.clearAssistantCompletionIdleTimer();
    turnWatches.clearTerminalIdleTimer();
    resolveCompletion?.();
  };

  const scheduleTerminalDynamicToolReleaseCheck = () => {
    if (
      terminalDynamicToolReleaseCheckScheduled ||
      (!pendingTerminalDynamicToolRelease && !currentTurnHadNonTerminalDynamicToolResult)
    ) {
      return;
    }
    // Let the JSON-RPC tool-call response flush before interrupting the turn.
    terminalDynamicToolReleaseCheckScheduled = true;
    const immediate = setImmediate(() => {
      terminalDynamicToolReleaseCheckScheduled = false;
      const action = resolveTerminalDynamicToolBatchAction({
        activeAppServerTurnRequests,
        activeTurnItemIdsCount: activeTurnItemIds.size,
        pendingOpenClawDynamicToolCompletionIdsCount: pendingOpenClawDynamicToolCompletionIds.size,
        currentTurnHadNonTerminalDynamicToolResult,
        hasPendingTerminalDynamicToolRelease: pendingTerminalDynamicToolRelease !== undefined,
      });
      if (action === "release-pending-terminal" && pendingTerminalDynamicToolRelease) {
        releaseTurnAfterTerminalDynamicTool(pendingTerminalDynamicToolRelease);
      } else if (action === "clear-nonterminal-batch") {
        pendingTerminalDynamicToolRelease = undefined;
        currentTurnHadNonTerminalDynamicToolResult = false;
      }
    });
    immediate.unref?.();
  };

  const scheduleTurnReleaseAfterTerminalDynamicTool = (paramsLocal: {
    call: CodexDynamicToolCallParams;
    response: CodexDynamicToolCallResponse;
    durationMs: number;
  }) => {
    pendingTerminalDynamicToolRelease = paramsLocal;
    scheduleTerminalDynamicToolReleaseCheck();
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

  const executionPhaseKeys = new Set<string>();
  const emitExecutionPhaseOnce = (
    key: string,
    info: Parameters<NonNullable<EmbeddedRunAttemptParams["onExecutionPhase"]>>[0],
  ) => {
    if (executionPhaseKeys.has(key)) {
      return;
    }
    executionPhaseKeys.add(key);
    params.onExecutionPhase?.({
      provider: params.provider,
      model: params.modelId,
      backend: "codex-app-server",
      ...info,
    });
  };
  const reportExecutionNotification = (notification: CodexServerNotification) => {
    reportCodexExecutionNotification({
      notification,
      emitExecutionPhaseOnce,
    });
  };

  const isTerminalTurnNotificationForTurn = (
    notification: CodexServerNotification,
    notificationTurnId: string,
  ): boolean =>
    isTerminalCodexTurnNotificationForTurn({
      notification,
      threadId: thread.threadId,
      turnId: notificationTurnId,
      currentPromptTexts: [codexTurnPromptText],
    });

  const handleNotification = async (notification: CodexServerNotification) => {
    const projector = projectorRef.current;
    const turnId = turnIdRef.current;
    const userInputBridge = userInputBridgeRef.current;
    const steeringQueue = steeringQueueRef.current;
    userInputBridge?.handleNotification(notification);
    if (!projector || !turnId) {
      pendingNotifications.push(notification);
      return;
    }
    const notificationState = applyCodexTurnNotificationState({
      notification,
      threadId: thread.threadId,
      turnId,
      currentPromptTexts: [codexTurnPromptText],
      turnWatches,
      activeTurnItemIds,
      activeAppServerTurnRequests,
      pendingOpenClawDynamicToolCompletionIds,
      turnCrossedToolHandoff,
      postToolRawAssistantCompletionIdleTimeoutMs,
      onScheduleTerminalDynamicToolReleaseCheck: scheduleTerminalDynamicToolReleaseCheck,
      onReportExecutionNotification: reportExecutionNotification,
    });
    turnCrossedToolHandoff = notificationState.turnCrossedToolHandoff;
    // Determine terminal-turn status before invoking the projector so a throw
    // inside projector.handleNotification still releases the session lane.
    // See openclaw/openclaw#67996.
    if (notificationState.isTurnTerminal) {
      terminalTurnNotificationQueued = true;
    }
    try {
      await waitForCodexNotificationDispatchTurn();
      await projector.handleNotification(notification);
    } catch (error) {
      embeddedAgentLog.debug("codex app-server projector notification threw", {
        method: notification.method,
        error,
      });
    } finally {
      if (notificationState.isTurnTerminal) {
        if (notificationState.isTurnAbortMarker) {
          projector.markAborted();
        }
        if (!timedOut && !runAbortController.signal.aborted) {
          await steeringQueue?.flushPending();
        }
        completed = true;
        turnWatches.clearCompletionIdleTimer();
        turnWatches.clearAssistantCompletionIdleTimer();
        turnWatches.clearTerminalIdleTimer();
        resolveCompletion?.();
      }
    }
  };
  const enqueueNotification = (notification: CodexServerNotification): Promise<void> => {
    const projector = projectorRef.current;
    const turnId = turnIdRef.current;
    const userInputBridge = userInputBridgeRef.current;
    const correlation = describeCodexNotificationCorrelation(notification, {
      threadId: thread.threadId,
      ...(turnId ? { turnId } : {}),
    });
    embeddedAgentLog.trace("codex app-server raw notification received", correlation);
    if (notification.method === "turn/completed" && correlation.matchesActiveTurn === false) {
      if (correlation.matchesActiveThread) {
        embeddedAgentLog.warn(
          "codex app-server turn/completed did not match active turn",
          correlation,
        );
      } else {
        embeddedAgentLog.debug(
          "codex app-server turn/completed ignored for other subscribed thread",
          correlation,
        );
      }
    }
    if (isCodexNotificationOutsideActiveRun(correlation)) {
      return Promise.resolve();
    }
    if (!projector || !turnId) {
      userInputBridge?.handleNotification(notification);
      pendingNotifications.push(notification);
      return Promise.resolve();
    }
    if (isTerminalTurnNotificationForTurn(notification, turnId)) {
      terminalTurnNotificationQueued = true;
    }
    // Touch idle-watch timestamps at receive time, not just after queued
    // projection.  A queued terminal event should suppress short false-idle
    // guards, while the full attempt watchdog still releases a wedged queue.
    const isNativeResponseStreamDelta = isNativeResponseStreamDeltaNotification(notification);
    const nativeResponseStreamDeltaMatchesActiveTurn =
      isNativeResponseStreamDelta &&
      (correlation.matchesActiveTurn === true ||
        (isUnscopedCodexNotification(correlation) &&
          canAttributeUnscopedNativeResponseDeltaToThisTurn(client)));
    const notificationMatchesActiveTurn =
      correlation.matchesActiveTurn === true ||
      (!isNativeResponseStreamDelta && correlation.matchesActiveTurn !== false) ||
      nativeResponseStreamDeltaMatchesActiveTurn;
    if (notificationMatchesActiveTurn) {
      // If Codex app-server exposes raw response deltas, treat them as activity
      // only when scoped to this turn or attributable to a single lease.
      turnWatches.noteNotificationReceived(
        notification.method,
        isNativeResponseStreamDelta
          ? {
              attemptProgress: true,
              ...(turnCrossedToolHandoff
                ? { attemptTimeoutMs: postToolRawAssistantCompletionIdleTimeoutMs }
                : {}),
              details: { lastNotificationMethod: notification.method },
            }
          : undefined,
      );
    }
    notificationQueue = notificationQueue.then(
      () => handleNotification(notification),
      () => handleNotification(notification),
    );
    return notificationQueue;
  };

  registerCodexNativeSubagentMonitor({
    client,
    parentThreadId: thread.threadId,
    requesterSessionKey: params.sessionKey,
    taskRuntimeScope: params.agentHarnessTaskRuntimeScope,
    agentId: params.agentId,
    codexHome: appServer.start.env?.CODEX_HOME ?? resolveCodexAppServerHomeDir(agentDir),
  });
  const notificationCleanup = client.addNotificationHandler(enqueueNotification);
  const requestCleanup = client.addRequestHandler(async (request) => {
    const turnId = turnIdRef.current;
    const userInputBridge = userInputBridgeRef.current;
    const projector = projectorRef.current;
    let armCompletionWatchOnResponse = false;
    let requestCountsAsTurnActivity = false;
    const markCurrentTurnRequestProgress = () => {
      activeAppServerTurnRequests += 1;
      turnWatches.clearCompletionIdleTimer();
      turnWatches.disarmAssistantCompletionIdleWatch();
      requestCountsAsTurnActivity = true;
      turnWatches.touchActivity(`request:${request.method}:start`, {
        attemptProgress: true,
      });
    };
    try {
      if (request.method === "account/chatgptAuthTokens/refresh") {
        return refreshCodexAppServerAuthTokens({
          agentDir,
          authProfileId: startupAuthProfileId,
          config: params.config,
        });
      }
      if (!turnId) {
        return undefined;
      }
      if (request.method === "mcpServer/elicitation/request") {
        if (isCurrentThreadOptionalTurnRequestParams(request.params, thread.threadId, turnId)) {
          armCompletionWatchOnResponse = true;
          markCurrentTurnRequestProgress();
        }
        return await handleCodexAppServerElicitationRequest({
          requestParams: request.params,
          paramsForRun: params,
          threadId: thread.threadId,
          turnId,
          pluginAppPolicyContext: thread.pluginAppPolicyContext,
          ...(computerUseConfig.enabled
            ? { computerUseMcpServerName: computerUseConfig.mcpServerName }
            : {}),
          signal: runAbortController.signal,
        });
      }
      if (request.method === "item/tool/requestUserInput") {
        if (isCurrentThreadTurnRequestParams(request.params, thread.threadId, turnId)) {
          armCompletionWatchOnResponse = true;
          markCurrentTurnRequestProgress();
        }
        return userInputBridge?.handleRequest({
          id: request.id,
          params: request.params,
        });
      }
      if (request.method !== "item/tool/call") {
        if (isCodexAppServerApprovalRequest(request.method)) {
          if (isCurrentApprovalTurnRequestParams(request.params, thread.threadId, turnId)) {
            armCompletionWatchOnResponse = true;
            markCurrentTurnRequestProgress();
          }
          return handleApprovalRequest({
            method: request.method,
            params: request.params,
            paramsForRun: params,
            threadId: thread.threadId,
            turnId,
            nativeHookRelay,
            autoApprove: shouldAutoApproveCodexAppServerApprovals(appServer),
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
      markCurrentTurnRequestProgress();
      turnCrossedToolHandoff = true;
      pendingOpenClawDynamicToolCompletionIds.add(call.callId);
      trajectoryRecorder?.recordEvent("tool.call", {
        threadId: call.threadId,
        turnId: call.turnId,
        toolCallId: call.callId,
        name: call.tool,
        arguments: call.arguments,
      });
      projector?.recordDynamicToolCall({
        callId: call.callId,
        tool: call.tool,
        arguments: call.arguments,
      });
      emitExecutionPhaseOnce(`tool:${call.callId}`, {
        phase: "tool_execution_started",
        tool: call.tool,
        toolCallId: call.callId,
      });
      emitDynamicToolStartedDiagnostic({
        call,
        runId: params.runId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
      });
      const toolProgressDetailMode = resolveCodexToolProgressDetailMode(params.toolProgressDetail);
      const toolMeta = inferCodexDynamicToolMeta(call, toolProgressDetailMode);
      const toolArgs = sanitizeCodexToolArguments(call.arguments);
      const shouldEmitDynamicToolProgress = shouldEmitTranscriptToolProgress(call.tool, toolArgs);
      if (shouldEmitDynamicToolProgress) {
        emitCodexAppServerEvent(params, {
          stream: "tool",
          data: {
            phase: "start",
            name: call.tool,
            toolCallId: call.callId,
            ...(toolMeta ? { meta: toolMeta } : {}),
            ...(toolArgs ? { args: toolArgs } : {}),
          },
        });
      }
      const dynamicToolTimeoutMs = resolveDynamicToolCallTimeoutMs({
        call,
        config: params.config,
      });
      const toolStartedAt = Date.now();
      let terminalDiagnosticObserved = false;
      const unsubscribeToolDiagnosticObserver = onInternalDiagnosticEvent((event) => {
        if (isDynamicToolTerminalDiagnosticEvent(event)) {
          if (
            isMatchingDynamicToolTerminalDiagnostic({
              event,
              call,
              runId: params.runId,
              sessionId: params.sessionId,
              sessionKey: params.sessionKey,
            })
          ) {
            terminalDiagnosticObserved = true;
          }
        }
      });
      try {
        const response = await handleDynamicToolCallWithTimeout({
          call,
          toolBridge,
          signal: runAbortController.signal,
          timeoutMs: dynamicToolTimeoutMs,
          onTimeout: () => {
            trajectoryRecorder?.recordEvent("tool.timeout", {
              threadId: call.threadId,
              turnId: call.turnId,
              toolCallId: call.callId,
              name: call.tool,
              timeoutMs: dynamicToolTimeoutMs,
            });
          },
        });
        const protocolResponse = toCodexDynamicToolProtocolResponse(response);
        const toolDurationMs = Math.max(0, Date.now() - toolStartedAt);
        trajectoryRecorder?.recordEvent("tool.result", {
          threadId: call.threadId,
          turnId: call.turnId,
          toolCallId: call.callId,
          name: call.tool,
          success: protocolResponse.success,
          contentItems: protocolResponse.contentItems,
        });
        projector?.recordDynamicToolResult({
          callId: call.callId,
          tool: call.tool,
          asyncStarted: response.asyncStarted === true,
          success: protocolResponse.success,
          terminalType:
            response.diagnosticTerminalType ?? (protocolResponse.success ? "completed" : "error"),
          sideEffectEvidence: response.sideEffectEvidence === true,
          contentItems: protocolResponse.contentItems,
        });
        if (shouldEmitDynamicToolProgress) {
          const progressResponse = toCodexDynamicToolProgressResponse(response, protocolResponse);
          emitCodexAppServerEvent(params, {
            stream: "tool",
            data: {
              phase: "result",
              name: call.tool,
              toolCallId: call.callId,
              ...(toolMeta ? { meta: toolMeta } : {}),
              isError: !protocolResponse.success,
              result: toTranscriptToolResult(progressResponse),
            },
          });
        }
        if (
          !terminalDiagnosticObserved &&
          !hasPendingDynamicToolTerminalDiagnostic({
            call,
            runId: params.runId,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
          })
        ) {
          emitDynamicToolTerminalDiagnostic({
            response,
            call,
            runId: params.runId,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            durationMs: toolDurationMs,
          });
        }
        pendingOpenClawDynamicToolCompletionIds.delete(call.callId);
        if (response.terminate === true) {
          scheduleTurnReleaseAfterTerminalDynamicTool({
            call,
            response,
            durationMs: toolDurationMs,
          });
        } else if (!shouldBlockTerminalReleaseForNonTerminalDynamicToolResult(response)) {
          scheduleTerminalDynamicToolReleaseCheck();
        } else {
          currentTurnHadNonTerminalDynamicToolResult = true;
          pendingTerminalDynamicToolRelease = undefined;
        }
        return protocolResponse as JsonValue;
      } catch (error) {
        pendingOpenClawDynamicToolCompletionIds.delete(call.callId);
        if (
          !terminalDiagnosticObserved &&
          !hasPendingDynamicToolTerminalDiagnostic({
            call,
            runId: params.runId,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
          })
        ) {
          emitDynamicToolErrorDiagnostic({
            call,
            runId: params.runId,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            durationMs: Math.max(0, Date.now() - toolStartedAt),
          });
        }
        throw error;
      } finally {
        unsubscribeToolDiagnosticObserver();
      }
    } finally {
      if (requestCountsAsTurnActivity) {
        activeAppServerTurnRequests = Math.max(0, activeAppServerTurnRequests - 1);
        const postToolContinuationTimeoutMs =
          request.method === "item/tool/call" && turnCrossedToolHandoff
            ? postToolRawAssistantCompletionIdleTimeoutMs
            : undefined;
        turnWatches.touchActivity(`request:${request.method}:response`, {
          arm: armCompletionWatchOnResponse,
          attemptProgress: true,
          ...(postToolContinuationTimeoutMs !== undefined
            ? { attemptTimeoutMs: postToolContinuationTimeoutMs }
            : {}),
        });
        if (armCompletionWatchOnResponse && postToolContinuationTimeoutMs !== undefined) {
          turnWatches.armCompletionIdleWatch({ timeoutMs: postToolContinuationTimeoutMs });
        }
        scheduleTerminalDynamicToolReleaseCheck();
      } else {
        turnWatches.scheduleProgressWatches();
      }
    }
  });

  const buildLlmInputEvent = () => ({
    runId: params.runId,
    sessionId: params.sessionId,
    provider: params.provider,
    model: params.modelId,
    systemPrompt: buildRenderedCodexDeveloperInstructions(),
    prompt: codexTurnPromptText,
    historyMessages: codexModelInputHistoryMessages,
    imagesCount: params.images?.length ?? 0,
    tools,
  });
  const buildCodexModelInputMessages = () => [
    ...codexModelInputHistoryMessages,
    buildCodexUserPromptMessage({ ...params, prompt: codexTurnPromptText }),
  ];
  const codexModelCallBaseFields = {
    runId: params.runId,
    callId: codexModelCallId,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    sessionId: params.sessionId,
    provider: params.provider,
    model: params.modelId,
    api: params.model.api,
    transport: appServer.start.transport,
    ...hookContextWindowFields,
    trace: codexModelCallTrace,
  };
  const codexModelCallDiagnostics = createCodexModelCallDiagnosticEmitter({
    baseFields: codexModelCallBaseFields,
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

  let turn: CodexTurnStartResponse | undefined;
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
    const turnStartParams = buildTurnStartParams(params, {
      threadId: thread.threadId,
      cwd: codexExecutionCwd,
      appServer: pluginAppServer,
      promptText: codexTurnPromptText,
      sandboxPolicy: codexSandboxPolicy,
      environmentSelection: codexEnvironmentSelection,
      turnScopedDeveloperInstructions: workspaceBootstrapContext.turnScopedDeveloperInstructions,
      skillsCollaborationInstructions,
      memoryCollaborationInstructions: workspaceBootstrapContext.memoryCollaborationInstructions,
      heartbeatCollaborationInstructions:
        workspaceBootstrapContext.heartbeatCollaborationInstructions,
    });
    codexModelCallDiagnostics.setRequestPayloadBytes(utf8JsonByteLength(turnStartParams));
    const startedTurn = assertCodexTurnStartResponse(
      await client.request("turn/start", turnStartParams, {
        timeoutMs: params.timeoutMs,
        signal: runAbortController.signal,
      }),
    );
    throwIfTurnStartAcceptedAfterAbort();
    return startedTurn;
  };
  try {
    codexModelCallDiagnostics.emitStarted();
    runAgentHarnessLlmInputHook({
      event: buildLlmInputEvent(),
      ctx: hookContext,
      hookRunner,
    });
    emitCodexAppServerEvent(params, {
      stream: "codex_app_server.lifecycle",
      data: { phase: "turn_starting", threadId: thread.threadId },
    });
    turn = await startCodexTurn();
  } catch (error) {
    let turnStartError = error;
    if (
      shouldUseFreshCodexThreadAfterContextEngineOverflow({
        error: turnStartError,
        contextEngineActive: Boolean(activeContextEngine),
        thread,
      }) &&
      restartContextEngineCodexThread
    ) {
      // Do not try to pre-compact or summarize through OpenClaw here. Codex owns
      // automatic compaction; OpenClaw may only discard a stale projection thread
      // and let Codex start cleanly.
      embeddedAgentLog.warn(
        "codex app-server context-engine turn overflowed on resume; retrying with fresh thread",
        {
          threadId: thread.threadId,
          error: formatErrorMessage(turnStartError),
        },
      );
      try {
        const preRetrySessionFile = activeSessionFile;
        const clearedPreRetryBinding = await clearCodexAppServerBindingForThread(
          preRetrySessionFile,
          thread.threadId,
        );
        const clearedActiveBinding =
          activeSessionFile !== preRetrySessionFile
            ? await clearCodexAppServerBindingForThread(activeSessionFile, thread.threadId)
            : false;
        if (!clearedPreRetryBinding && !clearedActiveBinding) {
          embeddedAgentLog.warn(
            "codex app-server preserved newer context-engine binding after resume overflow; skipping fresh retry",
            {
              threadId: thread.threadId,
              error: formatErrorMessage(turnStartError),
            },
          );
        } else {
          thread = await restartContextEngineCodexThread();
          // The fresh retry thread was not bootstrapped with the
          // context-engine projection. Clear the stale projection from
          // the saved binding so the next run will re-project instead
          // of assuming the old epoch is still in the thread.
          {
            const retryBinding = await readCodexAppServerBinding(activeSessionFile);
            if (
              retryBinding &&
              retryBinding.threadId === thread.threadId &&
              retryBinding.contextEngine?.projection
            ) {
              const {
                schemaVersion: _schemaVersion,
                sessionFile: _boundSessionFile,
                updatedAt: _updatedAt,
                ...bindingForWrite
              } = retryBinding;
              await writeCodexAppServerBinding(activeSessionFile, {
                ...bindingForWrite,
                contextEngine: bindingForWrite.contextEngine
                  ? { ...bindingForWrite.contextEngine, projection: undefined }
                  : undefined,
              });
              embeddedAgentLog.info(
                "codex app-server cleared stale context-engine projection after overflow retry",
                {
                  threadId: thread.threadId,
                  previousEpoch: retryBinding.contextEngine.projection.epoch,
                },
              );
            }
          }
          emitCodexAppServerEvent(params, {
            stream: "codex_app_server.lifecycle",
            data: { phase: "thread_ready_retry", threadId: thread.threadId },
          });
          try {
            turn = await startCodexTurn();
          } catch (retryError) {
            turnStartError = retryError;
          }
        }
      } catch (retrySetupError) {
        turnStartError = retrySetupError;
      }
    }
    if (turn === undefined) {
      const usageLimitError = await formatCodexTurnStartUsageLimitError({
        client,
        error: turnStartError,
        pendingNotifications,
        timeoutMs: appServer.requestTimeoutMs,
        signal: runAbortController.signal,
      });
      const turnStartErrorMessage = usageLimitError?.message ?? formatErrorMessage(turnStartError);
      if (isInvalidCodexImagePayloadError(turnStartErrorMessage)) {
        await clearCodexBindingAfterInvalidImagePayload(activeSessionFile, {
          phase: "turn_start",
          threadId: thread.threadId,
          error: turnStartErrorMessage,
        });
      }
      emitCodexAppServerEvent(params, {
        stream: "codex_app_server.lifecycle",
        data: { phase: "turn_start_failed", error: turnStartErrorMessage },
      });
      trajectoryRecorder?.recordEvent("session.ended", {
        status: "error",
        threadId: thread.threadId,
        timedOut,
        aborted: runAbortController.signal.aborted,
        promptError: turnStartErrorMessage,
      });
      markTrajectoryEndRecorded();
      runAgentHarnessLlmOutputHook({
        event: {
          runId: params.runId,
          sessionId: params.sessionId,
          provider: params.provider,
          model: params.modelId,
          ...hookContextWindowFields,
          resolvedRef:
            params.runtimePlan?.observability.resolvedRef ?? `${params.provider}/${params.modelId}`,
          ...(params.runtimePlan?.observability.harnessId
            ? { harnessId: params.runtimePlan.observability.harnessId }
            : {}),
          assistantTexts: [],
        },
        ctx: hookContext,
        hookRunner,
      });
      const turnStartFailureKind = classifyCodexModelCallFailureKind({
        error: turnStartError,
        timedOut,
        turnCompletionIdleTimedOut,
        runAborted: runAbortController.signal.aborted,
        abortReason: runAbortController.signal.reason,
        clientClosedAbort,
        formatError: formatErrorMessage,
      });
      codexModelCallDiagnostics.emitError(
        turnStartErrorMessage,
        turnStartFailureKind ? { failureKind: turnStartFailureKind } : {},
      );
      const turnStartFailureMessages = [
        ...historyMessages,
        buildCodexUserPromptMessage({ ...params, prompt: codexTurnPromptText }),
      ];
      await runCodexAgentEndHook(params, {
        event: {
          messages: turnStartFailureMessages,
          success: false,
          error: turnStartErrorMessage,
          durationMs: Date.now() - attemptStartedAt,
        },
        ctx: hookContext,
        hookRunner,
      });
      if (!timedOut) {
        await unsubscribeCodexThreadBestEffort(client, {
          threadId: thread.threadId,
          timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
        });
      }
      notificationCleanup();
      requestCleanup();
      nativeHookRelay?.unregister();
      await releaseSandboxExecEnvironment();
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
      releaseSharedClientLeaseOnce();
      if (usageLimitError) {
        await markCodexAuthProfileBlockedFromRateLimits({
          params,
          authProfileId: startupAuthProfileId,
          rateLimits: usageLimitError.rateLimitsForProfile,
        });
        return {
          ...buildCodexTurnStartFailureResult({
            params,
            message: usageLimitError.message,
            messagesSnapshot: turnStartFailureMessages,
            systemPromptReport,
          }),
        };
      }
      throw turnStartError;
    }
  }
  if (!turn) {
    releaseSharedClientLeaseOnce();
    throw new Error("codex app-server turn/start failed without an error");
  }
  turnIdRef.current = turn.turn.id;
  const activeTurnId = turn.turn.id;
  emitExecutionPhaseOnce("turn_accepted", { phase: "turn_accepted" });
  userInputBridgeRef.current = createCodexUserInputBridge({
    paramsForRun: params,
    threadId: thread.threadId,
    turnId: activeTurnId,
    signal: runAbortController.signal,
  });
  trajectoryRecorder?.recordEvent("prompt.submitted", {
    threadId: thread.threadId,
    turnId: activeTurnId,
    prompt: codexTurnPromptText,
    imagesCount: params.images?.length ?? 0,
  });
  projectorRef.current = new CodexAppServerEventProjector(params, thread.threadId, activeTurnId, {
    nativePostToolUseRelayEnabled:
      nativeHookRelay?.allowedEvents.includes("post_tool_use") === true &&
      nativeHookRelay.shouldRelayEvent("post_tool_use"),
    trajectoryRecorder,
  });
  if (
    isTerminalTurnStatus(turn.turn.status) ||
    pendingNotifications.some((notification) =>
      isTerminalTurnNotificationForTurn(notification, activeTurnId),
    )
  ) {
    terminalTurnNotificationQueued = true;
  }
  const closeCleanup: (() => void) | undefined = (
    client as {
      addCloseHandler?: (handler: (client: CodexAppServerClient) => void) => () => void;
    }
  ).addCloseHandler?.(() => {
    if (completed || terminalTurnNotificationQueued || runAbortController.signal.aborted) {
      return;
    }
    clientClosedPromptError = "codex app-server client closed before turn completed";
    trajectoryRecorder?.recordEvent("turn.client_closed", {
      threadId: thread.threadId,
      turnId: activeTurnId,
    });
    embeddedAgentLog.warn("codex app-server client closed before turn completed", {
      threadId: thread.threadId,
      turnId: activeTurnId,
    });
    clientClosedAbort = true;
    runAbortController.abort("client_closed");
    completed = true;
    turnWatches.clearAllTimers();
    resolveCompletion?.();
  });
  emitLifecycleStart();
  const activeProjector = projectorRef.current;
  if (!activeProjector) {
    throw new Error("codex app-server projector was not initialized");
  }
  turnWatches.armTerminalIdleWatch();
  turnWatches.touchActivity("turn:start", { arm: true });
  turnWatches.armAttemptIdleWatch();
  turnWatches.touchActivity("turn:start", { attemptProgress: true });
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
    answerPendingUserInput: (text) =>
      userInputBridgeRef.current?.handleQueuedMessage(text) ?? false,
    signal: runAbortController.signal,
  });
  steeringQueueRef.current = activeSteeringQueue;
  const handle = {
    kind: "embedded" as const,
    queueMessage: async (text: string, optionsLocal?: CodexSteeringQueueOptions) =>
      activeSteeringQueue.queue(text, optionsLocal),
    isStreaming: () => !completed && !runAbortController.signal.aborted,
    isCompacting: () => projectorRef.current?.isCompacting() ?? false,
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    cancel: () => runAbortController.abort("cancelled"),
    abort: () => runAbortController.abort("aborted"),
  };
  setActiveEmbeddedRun(params.sessionId, handle, params.sessionKey);
  const notifyUserMessagePersisted = createCodexAppServerUserMessagePersistenceNotifier(params);
  void mirrorPromptAtTurnStartBestEffort({
    params,
    agentId: sessionAgentId,
    notifyUserMessagePersisted,
    sessionKey: sandboxSessionKey,
    cwd: effectiveCwd,
    threadId: thread.threadId,
    turnId: activeTurnId,
  });

  const abortListener = () => {
    const shouldRetireClient = timedOut;
    if (shouldRetireClient) {
      void (async () => {
        // Timed-out native turns cannot be safely resumed on the same thread.
        await clearCodexAppServerBindingForThread(activeSessionFile, thread.threadId);
        await retireCodexAppServerClientAfterTimedOutTurn(client, {
          threadId: thread.threadId,
          turnId: activeTurnId,
          reason: String(runAbortController.signal.reason ?? "timeout"),
        });
      })().finally(() => {
        resolveCompletion?.();
      });
      return;
    }
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
    // Timeout completion can win while a received notification is still being
    // projected, for example while persisting raw image-generation media. Wait
    // for already-queued projection work so the final result includes artifacts
    // from the notification that triggered the idle watchdog.
    await notificationQueue;
    const result = activeProjector.buildResult(toolBridge.telemetry, { yieldDetected });
    const finalAborted =
      result.aborted || (runAbortController.signal.aborted && !clientClosedAbort);
    const canUseCompletedAssistantTextAfterClientClose =
      activeProjector.hasCompletedTerminalAssistantText() &&
      activeAppServerTurnRequests === 0 &&
      activeTurnItemIds.size === 0 &&
      pendingOpenClawDynamicToolCompletionIds.size === 0;
    const clientClosedPromptErrorForFinal =
      clientClosedPromptError && canUseCompletedAssistantTextAfterClientClose
        ? undefined
        : clientClosedPromptError;
    let finalPromptError =
      clientClosedPromptErrorForFinal ??
      (turnCompletionIdleTimedOut
        ? turnCompletionIdleTimeoutMessage
        : timedOut
          ? "codex app-server attempt timed out"
          : result.promptError);
    const finalPromptErrorMessage =
      typeof finalPromptError === "string"
        ? finalPromptError
        : finalPromptError
          ? formatErrorMessage(finalPromptError)
          : undefined;
    if (isInvalidCodexImagePayloadError(finalPromptErrorMessage)) {
      await clearCodexBindingAfterInvalidImagePayload(activeSessionFile, {
        phase: "turn_completed",
        threadId: thread.threadId,
        turnId: activeTurnId,
        error: finalPromptErrorMessage,
      });
    }
    if (
      shouldUseFreshCodexThreadAfterContextEngineOverflow({
        error: finalPromptError,
        contextEngineActive: Boolean(activeContextEngine),
        thread,
      })
    ) {
      embeddedAgentLog.warn(
        "codex app-server context-engine turn overflowed after resume; clearing thread binding for recovery",
        {
          threadId: thread.threadId,
          turnId: activeTurnId,
          error: finalPromptErrorMessage,
        },
      );
      const preClearSessionFile = activeSessionFile;
      await clearCodexAppServerBindingForThread(preClearSessionFile, thread.threadId);
      if (activeSessionFile !== preClearSessionFile) {
        await clearCodexAppServerBindingForThread(activeSessionFile, thread.threadId);
      }
    }
    const refreshedUsageLimitPromptError = await refreshCodexUsageLimitPromptError({
      client,
      message: finalPromptErrorMessage,
      timeoutMs: appServer.requestTimeoutMs,
      signal: runAbortController.signal,
    });
    if (refreshedUsageLimitPromptError) {
      finalPromptError = refreshedUsageLimitPromptError;
    }
    const finalPromptErrorSource =
      timedOut || clientClosedPromptErrorForFinal ? "prompt" : result.promptErrorSource;
    const codexAppServerFailureKind = clientClosedPromptErrorForFinal
      ? "client_closed_before_turn_completed"
      : turnCompletionIdleTimedOut
        ? "turn_completion_idle_timeout"
        : undefined;
    const codexAppServerReplayBlockedReason = codexAppServerFailureKind
      ? resolveCodexAppServerReplayBlockedReason(result)
      : undefined;
    const promptTimeoutOutcome = buildCodexAppServerPromptTimeoutOutcome({
      result,
      turnCompletionIdleTimedOut,
      turnWatchTimeoutKind,
    });
    const codexAppServerFailureDiagnostics =
      codexAppServerFailureKind === "turn_completion_idle_timeout" &&
      turnWatchTimeoutKind === "completion"
        ? buildCodexAppServerTimeoutDiagnostics({
            idleMs: turnWatchTimeoutIdleMs,
            timeoutMs: turnWatchTimeoutMs,
            lastActivityReason: turnWatchTimeoutLastActivityReason,
            details: turnWatchTimeoutDetails,
          })
        : undefined;
    const modelCallFailureKind =
      classifyCodexModelCallFailureKind({
        error: finalPromptError,
        timedOut,
        turnCompletionIdleTimedOut,
        runAborted: runAbortController.signal.aborted,
        abortReason: runAbortController.signal.reason,
        clientClosedAbort,
        formatError: formatErrorMessage,
      }) ?? (finalAborted ? "aborted" : undefined);
    if (modelCallFailureKind) {
      codexModelCallDiagnostics.emitError(
        finalPromptError ?? "codex app-server attempt interrupted",
        {
          failureKind: modelCallFailureKind,
        },
      );
    } else if (finalPromptError) {
      codexModelCallDiagnostics.emitError(finalPromptError);
    } else {
      codexModelCallDiagnostics.emitCompleted(result);
    }
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
    markTrajectoryEndRecorded();
    await mirrorTranscriptBestEffort({
      params,
      agentId: sessionAgentId,
      notifyUserMessagePersisted,
      result,
      sessionKey: contextSessionKey,
      cwd: effectiveCwd,
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
      const activeContextEnginePluginIdLocal =
        resolveContextEngineOwnerPluginId(activeContextEngine);
      const finalMessages =
        (await readMirroredSessionHistoryMessages(activeSessionFile)) ??
        historyMessages.concat(result.messagesSnapshot);
      await finalizeHarnessContextEngineTurn({
        contextEngine: activeContextEngine,
        promptError: Boolean(finalPromptError),
        aborted: finalAborted,
        yieldAborted: Boolean(result.yieldDetected),
        sessionIdUsed: activeSessionId,
        sessionKey: contextSessionKey,
        sessionFile: activeSessionFile,
        messagesSnapshot: finalMessages,
        prePromptMessageCount,
        tokenBudget: params.contextTokenBudget,
        runtimeContext: buildHarnessContextEngineRuntimeContextFromUsage({
          attempt: buildActiveRunAttemptParams(),
          workspaceDir: effectiveWorkspace,
          cwd: effectiveCwd,
          agentDir,
          activeAgentId: sessionAgentId,
          contextEnginePluginId: activeContextEnginePluginIdLocal,
          tokenBudget: params.contextTokenBudget,
          lastCallUsage: result.attemptUsage,
          promptCache: result.promptCache,
        }),
        runMaintenance: runHarnessContextEngineMaintenance,
        config: params.config,
        warn: (message) => embeddedAgentLog.warn(message),
        isHeartbeat: params.bootstrapContextRunKind === "heartbeat",
      });
    }
    runAgentHarnessLlmOutputHook({
      event: {
        runId: params.runId,
        sessionId: params.sessionId,
        provider: params.provider,
        model: params.modelId,
        ...hookContextWindowFields,
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
      hookRunner,
    });
    await runCodexAgentEndHook(params, {
      event: {
        messages: result.messagesSnapshot,
        success: !finalAborted && !finalPromptError,
        ...(finalPromptError ? { error: formatErrorMessage(finalPromptError) } : {}),
        durationMs: Date.now() - attemptStartedAt,
      },
      ctx: hookContext,
      hookRunner,
    });
    const completedTurnStatus = activeProjector.getCompletedTurnStatus();
    shouldDelayNativeHookRelayUnregister =
      completedTurnStatus === "completed" &&
      !timedOut &&
      !runAbortController.signal.aborted &&
      !finalAborted &&
      !finalPromptError;
    if (shouldDelayNativeHookRelayUnregister) {
      await markCodexAppServerBindingCoveredThroughTurn({
        sessionFile: params.sessionFile,
        threadId: thread.threadId,
        authProfileStore: params.authProfileStore,
        agentDir: params.agentDir,
        config: params.config,
      });
    }
    return {
      ...result,
      timedOut,
      aborted: finalAborted,
      promptError: finalPromptError,
      promptErrorSource: finalPromptErrorSource,
      ...(codexAppServerFailureKind
        ? {
            codexAppServerFailure: {
              kind: codexAppServerFailureKind,
              ...(codexAppServerFailureKind === "turn_completion_idle_timeout" &&
              turnWatchTimeoutKind
                ? { turnWatchTimeoutKind }
                : {}),
              transport: appServer.start.transport,
              threadId: thread.threadId,
              turnId: activeTurnId,
              replaySafe: codexAppServerReplayBlockedReason === undefined,
              ...(codexAppServerReplayBlockedReason
                ? { replayBlockedReason: codexAppServerReplayBlockedReason }
                : {}),
              ...(codexAppServerFailureDiagnostics
                ? { diagnostics: codexAppServerFailureDiagnostics }
                : {}),
            },
          }
        : {}),
      ...(promptTimeoutOutcome ? { promptTimeoutOutcome } : {}),
      systemPromptReport,
    };
  } finally {
    codexModelCallDiagnostics.emitError(
      "codex app-server run completed without model-call terminal event",
    );
    emitLifecycleTerminal({
      phase: "error",
      error: "codex app-server run completed without lifecycle terminal event",
    });
    if (trajectoryRecorder && !trajectoryEndRecorded) {
      trajectoryRecorder.recordEvent("session.ended", {
        status:
          timedOut || (runAbortController.signal.aborted && !clientClosedAbort)
            ? "interrupted"
            : "cleanup",
        threadId: thread.threadId,
        turnId: activeTurnId,
        timedOut,
        aborted: runAbortController.signal.aborted && !clientClosedAbort,
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
      await steeringQueueRef.current?.flushPending();
    }
    if (!timedOut) {
      await unsubscribeCodexThreadBestEffort(client, {
        threadId: thread.threadId,
        timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
      });
    }
    userInputBridgeRef.current?.cancelPending();
    turnWatches.clearAllTimers();
    notificationCleanup();
    requestCleanup();
    closeCleanup?.();
    releaseSharedClientLeaseOnce();
    if (nativeHookRelay) {
      if (shouldDelayNativeHookRelayUnregister) {
        // Codex hook subprocesses can outlive a completed app-server turn by a
        // few seconds. Keep the relay available briefly so late
        // nativeHook.invoke RPCs can still reach before_tool_call enforcement.
        scheduleCodexNativeHookRelayUnregister({
          relay: nativeHookRelay,
          hookTimeoutSec: options.nativeHookRelay?.hookTimeoutSec,
        });
      } else {
        nativeHookRelay.unregister();
      }
    }
    await releaseSandboxExecEnvironment();
    runAbortController.signal.removeEventListener("abort", abortListener);
    params.abortSignal?.removeEventListener("abort", abortFromUpstream);
    steeringQueueRef.current?.cancel();
    clearActiveEmbeddedRun(params.sessionId, handle, params.sessionKey);
  }
}

function readDynamicToolCallParams(
  value: JsonValue | undefined,
): CodexDynamicToolCallParams | undefined {
  return readCodexDynamicToolCallParams(value);
}

async function clearCodexBindingAfterInvalidImagePayload(
  sessionFile: string,
  fields: { phase: string; threadId?: string; turnId?: string; error?: string },
): Promise<void> {
  const currentBinding = await readCodexAppServerBinding(sessionFile);
  if (fields.threadId && currentBinding && currentBinding.threadId !== fields.threadId) {
    embeddedAgentLog.warn(
      "codex app-server image payload error detected for unbound thread; preserving thread binding",
      { ...fields, boundThreadId: currentBinding.threadId },
    );
    return;
  }
  embeddedAgentLog.warn(
    "codex app-server image payload error detected; clearing thread binding",
    fields,
  );
  await clearCodexAppServerBinding(sessionFile);
}

async function markCodexAppServerBindingCoveredThroughTurn(params: {
  sessionFile: string;
  threadId: string;
  authProfileStore: EmbeddedRunAttemptParams["authProfileStore"];
  agentDir?: string;
  config?: EmbeddedRunAttemptParams["config"];
}): Promise<void> {
  const currentBinding = await readCodexAppServerBinding(params.sessionFile, {
    authProfileStore: params.authProfileStore,
    agentDir: params.agentDir,
    config: params.config,
  });
  if (!currentBinding || currentBinding.threadId !== params.threadId) {
    return;
  }
  const {
    schemaVersion: _schemaVersion,
    sessionFile: _boundSessionFile,
    updatedAt: _updatedAt,
    ...bindingForWrite
  } = currentBinding;
  await writeCodexAppServerBinding(params.sessionFile, bindingForWrite, {
    authProfileStore: params.authProfileStore,
    agentDir: params.agentDir,
    config: params.config,
  });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function canAttributeUnscopedNativeResponseDeltaToThisTurn(client: CodexAppServerClient): boolean {
  const activeLeases = client.getActiveSharedLeaseCountForUnscopedNotifications?.();
  return activeLeases === undefined || activeLeases <= 1;
}

function isUnscopedCodexNotification(
  correlation: ReturnType<typeof describeCodexNotificationCorrelation>,
): boolean {
  return (
    !correlation.threadId &&
    !correlation.turnId &&
    !correlation.nestedTurnThreadId &&
    !correlation.nestedTurnId
  );
}

function shouldUseFreshCodexThreadAfterContextEngineOverflow(params: {
  error: unknown;
  contextEngineActive: boolean;
  thread: CodexAppServerThreadLifecycleBinding;
}): boolean {
  if (!params.contextEngineActive || params.thread.lifecycle.action !== "resumed") {
    return false;
  }
  return isCodexContextWindowError(params.error);
}

function isCodexContextWindowError(error: unknown): boolean {
  const message = formatErrorMessage(error);
  return (
    /ran out of room in the model'?s context window/iu.test(message) ||
    /context window/iu.test(message) ||
    /context length/iu.test(message) ||
    /maximum context/iu.test(message) ||
    /too many tokens/iu.test(message)
  );
}

function joinPresentSections(...sections: Array<string | undefined>): string {
  return sections.filter((section): section is string => Boolean(section?.trim())).join("\n\n");
}

function prependCurrentInboundContext(
  prompt: string,
  context: EmbeddedRunAttemptParams["currentInboundContext"],
): string {
  const text = context?.text.trim();
  return text ? [text, prompt].filter(Boolean).join("\n\n") : prompt;
}

function waitForCodexNotificationDispatchTurn(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function buildCodexAppServerTimeoutDiagnostics(params: {
  idleMs?: number;
  timeoutMs?: number;
  lastActivityReason?: string;
  details?: Record<string, unknown>;
}): NonNullable<EmbeddedRunAttemptResult["codexAppServerFailure"]>["diagnostics"] {
  const readString = (key: string) => {
    const value = params.details?.[key];
    return typeof value === "string" && value.trim() ? value : undefined;
  };
  const readNumber = (key: string) => {
    const value = params.details?.[key];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  };
  const readBoolean = (key: string) => {
    const value = params.details?.[key];
    return typeof value === "boolean" ? value : undefined;
  };
  return {
    ...(params.idleMs !== undefined ? { idleMs: params.idleMs } : {}),
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
    ...(params.lastActivityReason ? { lastActivityReason: params.lastActivityReason } : {}),
    ...(readString("lastNotificationMethod")
      ? { lastNotificationMethod: readString("lastNotificationMethod") }
      : {}),
    ...(readString("lastNotificationItemId")
      ? { lastNotificationItemId: readString("lastNotificationItemId") }
      : {}),
    ...(readString("lastNotificationItemType")
      ? { lastNotificationItemType: readString("lastNotificationItemType") }
      : {}),
    ...(readString("lastNotificationItemRole")
      ? { lastNotificationItemRole: readString("lastNotificationItemRole") }
      : {}),
    ...(readString("lastAssistantTextPreview")
      ? { lastAssistantTextPreview: readString("lastAssistantTextPreview") }
      : {}),
    ...(readNumber("activeAppServerTurnRequests") !== undefined
      ? { activeAppServerTurnRequests: readNumber("activeAppServerTurnRequests") }
      : {}),
    ...(readNumber("activeTurnItemCount") !== undefined
      ? { activeTurnItemCount: readNumber("activeTurnItemCount") }
      : {}),
    ...(readBoolean("terminalTurnNotificationQueued") !== undefined
      ? { terminalTurnNotificationQueued: readBoolean("terminalTurnNotificationQueued") }
      : {}),
    ...(readBoolean("completionIdleWatchArmed") !== undefined
      ? { completionIdleWatchArmed: readBoolean("completionIdleWatchArmed") }
      : {}),
    ...(readBoolean("assistantCompletionIdleWatchArmed") !== undefined
      ? { assistantCompletionIdleWatchArmed: readBoolean("assistantCompletionIdleWatchArmed") }
      : {}),
    ...(readBoolean("terminalIdleWatchArmed") !== undefined
      ? { terminalIdleWatchArmed: readBoolean("terminalIdleWatchArmed") }
      : {}),
  };
}

function handleApprovalRequest(params: {
  method: string;
  params: JsonValue | undefined;
  paramsForRun: EmbeddedRunAttemptParams;
  threadId: string;
  turnId: string;
  nativeHookRelay?: NativeHookRelayRegistrationHandle;
  autoApprove?: boolean;
  signal?: AbortSignal;
}): Promise<JsonValue | undefined> {
  return handleCodexAppServerApprovalRequest({
    method: params.method,
    requestParams: params.params,
    paramsForRun: params.paramsForRun,
    threadId: params.threadId,
    turnId: params.turnId,
    nativeHookRelay: params.nativeHookRelay,
    autoApprove: params.autoApprove,
    signal: params.signal,
  });
}

export const testing = {
  buildCodexNativeHookRelayId,
  buildDeveloperInstructions,
  filterCodexDynamicTools,
  buildDynamicTools,
  filterCodexDynamicToolsForAllowlist,
  includeForcedCodexDynamicToolAllow,
  resolveCodexDynamicToolsLoadingForModel,
  resolveCodexAppServerHookChannelId,
  buildCodexAppServerPromptTimeoutOutcome,
  resolveOpenClawCodingToolsSessionKeys,
  shouldEnableCodexAppServerNativeToolSurface,
  shouldForceMessageTool,
  hasPendingDynamicToolTerminalDiagnostic,
  toTranscriptToolResultForTests: toTranscriptToolResult,
  withCodexStartupTimeout,
  setOpenClawCodingToolsFactoryForTests,
  resetOpenClawCodingToolsFactoryForTests,
  async ensureCodexWorkspaceDirOnceForTests(workspaceDir: string): Promise<void> {
    await ensureCodexWorkspaceDirOnce(workspaceDir);
  },
  resetEnsuredCodexWorkspaceDirsForTests(): void {
    ensuredCodexWorkspaceDirs.clear();
  },
  flushPendingCodexNativeHookRelayUnregistersForTests,
  clearPendingCodexNativeHookRelayUnregistersForTests,
  resolveCodexNativeHookRelayUnregisterGraceMs,
} as const;
export { testing as __testing };
