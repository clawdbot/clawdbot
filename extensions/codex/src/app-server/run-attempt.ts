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
  FAST_MODE_AUTO_PROGRESS_KIND,
  formatFastModeAutoProgressText,
  formatErrorMessage,
  getAgentHarnessHookRunner,
  getBeforeToolCallPolicyDiagnosticState,
  isActiveHarnessContextEngine,
  loadCodexBundleMcpThreadConfig,
  resolveAgentHarnessBeforePromptBuildResult,
  resolveAgentRunAbortLifecycleFields,
  resolveContextEngineOwnerPluginId,
  resolveSandboxContext,
  resolveSessionAgentIds,
  resolveUserPath,
  awaitAgentEndSideEffects,
  runAgentEndSideEffects,
  runAgentHarnessLlmInputHook,
  runAgentHarnessLlmOutputHook,
  runHarnessContextEngineMaintenance,
  resolveFastModeForElapsed,
  setActiveEmbeddedRun,
  supportsModelTools,
  runAgentCleanupStep,
  type FastModeAutoProgressState,
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
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  resolveCodexAppServerForModelProvider,
  resolveCodexAppServerForOpenClawToolPolicy,
} from "./app-server-policy.js";
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
  resolveCodexDeliveryHintPreservedInputRange,
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
  describeNotificationActivity,
  isAssistantCompletionReleaseNotification,
  isRawFunctionToolOutputCompletionNotification,
  isTerminalTurnStatus,
  readCodexNotificationItem,
  readRawResponseToolCallId,
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
  resolveCodexAppServerAuthAccountCacheKey,
  resolveCodexAppServerFallbackApiKeyCacheKey,
  resolveCodexAppServerHomeDir,
  resolveCodexAppServerAuthProfileId,
  resolveCodexAppServerAuthProfileIdForAgent,
} from "./auth-bridge.js";
import { resolveCodexBindingAppServerConnection } from "./binding-connection.js";
import {
  CodexAppServerRpcError,
  isCodexAppServerApprovalRequest,
  type CodexAppServerClient,
} from "./client.js";
import {
  isCodexAppServerApprovalPolicyAllowedByRequirements,
  isCodexSandboxExecServerEnabled,
  readCodexPluginConfig,
  resolveCodexComputerUseConfig,
  resolveCodexModelBackedReviewerPolicyContext,
  resolveOpenClawExecPolicyForCodexAppServer,
  shouldAutoApproveCodexAppServerApprovals,
  type CodexAppServerRuntimeOptions,
} from "./config.js";
import {
  type CodexProjectedContextRange,
  fitCodexProjectedContextForTurnStart,
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
  resolveCodexAppServerHookChannelId,
  resolveCodexMessageToolProvider,
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
  resolveCodexToolAbortTerminalReason,
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
  resolveCodexDynamicToolsLoadingForRuntime,
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
  emitCodexNativePreToolUseFailureDiagnostic,
  flushPendingCodexNativeHookRelayUnregistersForTests,
  resolveCodexNativeHookRelayEvents,
  resolveCodexNativeHookRelayTtlMs,
  resolveCodexNativeHookRelayUnregisterGraceMs,
  scheduleCodexNativeHookRelayUnregister,
  type CodexNativePreToolUseFailure,
} from "./native-hook-relay.js";
import { registerCodexNativeSubagentMonitor } from "./native-subagent-monitor.js";
import { isCodexAppServerProfilerEnabled } from "./profiler-flag.js";
import {
  assertCodexTurnStartResponse,
  readCodexDynamicToolCallParams,
} from "./protocol-validators.js";
import {
  flattenCodexDynamicToolFunctions,
  isJsonObject,
  type CodexSandboxPolicy,
  type CodexTurnEnvironmentParams,
  type CodexServerNotification,
  type CodexDynamicToolCallParams,
  type CodexDynamicToolCallResponse,
  type CodexTurnStartResponse,
  type JsonObject,
  type JsonValue,
} from "./protocol.js";
import { resolveCodexProviderWebSearchSupport } from "./provider-capabilities.js";
import { readCodexRateLimitsRevision, readRecentCodexRateLimits } from "./rate-limit-cache.js";
import { releaseCodexSandboxExecServerEnvironment } from "./sandbox-exec-server.js";
import {
  isCodexAppServerNativeAuthProfile,
  reclaimCurrentCodexSessionGeneration,
  sessionBindingIdentity,
  type CodexAppServerBindingIdentity,
  type CodexAppServerBindingStore,
  type CodexAppServerThreadBinding,
} from "./session-binding.js";
import {
  getLeasedSharedCodexAppServerClient,
  retireSharedCodexAppServerClientIfCurrent,
  type CodexAppServerClientFactory,
} from "./shared-client.js";
import { rotateOversizedCodexAppServerStartupBinding } from "./startup-binding.js";
import {
  buildDeveloperInstructions,
  buildContextEngineBinding,
  buildTurnCollaborationMode,
  buildTurnStartParams,
  codexDynamicToolsFingerprint,
  resolveCodexAppServerThreadModelSelection,
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
  CODEX_APP_SERVER_NATIVE_TURN_WAIT_TIMEOUT_MS,
  type CodexAppServerServerRequest,
  type CodexAppServerTurnRouter,
  type CodexThreadRouteReservation,
  type CodexThreadRouteScope,
} from "./turn-router.js";
import {
  formatCodexTurnStartUsageLimitError,
  markCodexAuthProfileBlockedFromRateLimits,
  refreshCodexUsageLimitPromptError,
} from "./usage-limit-error.js";
import { createCodexUserInputBridge } from "./user-input-bridge.js";
import { resolveCodexWebSearchPlan } from "./web-search.js";

const CODEX_NATIVE_HOOK_RELAY_RENEW_INTERVAL_MS = 60_000;
const CODEX_APP_SERVER_PROJECTED_CHARS_PER_TOKEN = 4;

function shouldKeepCodexSharedAbortOpen(params: {
  trigger: EmbeddedRunAttemptParams["trigger"];
  result: EmbeddedRunAttemptResult;
  attemptSucceeded: boolean;
  explicitCancellationObserved: boolean;
}): boolean {
  if (params.explicitCancellationObserved || params.result.aborted || params.result.externalAbort) {
    return false;
  }
  // Memory attempts are preparatory. Failed attempts can still enter runner
  // retries or model fallback. The reply orchestrator owns the shared terminal
  // freeze after those paths settle.
  return params.trigger === "memory" || !params.attemptSucceeded;
}

const ensuredCodexWorkspaceDirs = new Set<string>();

function withCodexAppServerFastModeServiceTier(
  appServer: CodexAppServerRuntimeOptions,
  params: EmbeddedRunAttemptParams,
): CodexAppServerRuntimeOptions {
  const fastMode = typeof params.fastMode === "function" ? params.fastMode() : params.fastMode;
  const serviceTier =
    fastMode === undefined ? appServer.serviceTier : fastMode ? "priority" : undefined;
  if (serviceTier === appServer.serviceTier) {
    return appServer;
  }
  if (serviceTier) {
    return { ...appServer, serviceTier };
  }
  return { ...appServer, serviceTier: null };
}

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

async function emitCodexAppServerEvent(
  params: EmbeddedRunAttemptParams,
  event: Parameters<NonNullable<EmbeddedRunAttemptParams["onAgentEvent"]>>[0],
): Promise<void> {
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
    await params.onAgentEvent?.(event);
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
  const label = rawType ? truncateUtf16Safe(rawType, 80) : "unknown";
  const suffix = rawType.length > 80 ? "..." : "";
  return `[Unsupported Codex dynamic tool output: ${label}${suffix}]`;
}

type CodexAgentEndHookParams = Parameters<typeof runAgentEndSideEffects>[0];

type CodexDynamicToolExecutionIdentity = Pick<
  CodexDynamicToolCallParams,
  "threadId" | "turnId" | "callId"
>;

function createCodexDynamicToolExecutionRegistry() {
  const executions = new Map<string, Promise<CodexDynamicToolCallResponse>>();
  const keyFor = (call: CodexDynamicToolExecutionIdentity) =>
    JSON.stringify([call.threadId, call.turnId, call.callId]);

  return {
    get(call: CodexDynamicToolExecutionIdentity) {
      return executions.get(keyFor(call));
    },
    claim(
      call: CodexDynamicToolExecutionIdentity,
      start: () => Promise<CodexDynamicToolCallResponse>,
    ) {
      const existing = executions.get(keyFor(call));
      if (existing) {
        return { execution: existing, replayed: true } as const;
      }
      const execution = start();
      executions.set(keyFor(call), execution);
      return { execution, replayed: false } as const;
    },
  };
}

function shouldAwaitCodexAgentEndHook(params: EmbeddedRunAttemptParams): boolean {
  return !params.messageChannel && !params.messageProvider;
}

async function runCodexAgentEndHook(
  params: EmbeddedRunAttemptParams,
  hookParams: CodexAgentEndHookParams,
): Promise<void> {
  const sideEffectParams = {
    ...hookParams,
    ctx: { ...hookParams.ctx, config: params.config },
  };
  if (shouldAwaitCodexAgentEndHook(params)) {
    await awaitAgentEndSideEffects(sideEffectParams);
    return;
  }
  runAgentEndSideEffects(sideEffectParams);
}

export async function runCodexAppServerAttempt(
  params: EmbeddedRunAttemptParams,
  options: {
    bindingStore: CodexAppServerBindingStore;
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
  },
): Promise<EmbeddedRunAttemptResult> {
  const attemptStartedAt = Date.now();
  const profilerEnabled = isCodexAppServerProfilerEnabled(params.config);
  const codexModelCallTrace = freezeDiagnosticTraceContext(
    createDiagnosticTraceContextFromActiveScope(),
  );
  const codexModelContentCapture = resolveDiagnosticModelContentCapturePolicy(params.config);
  const codexModelCallId = `${params.runId}:codex-model:1`;
  const fastModeAutoStartedAtMs =
    typeof params.fastModeStartedAtMs === "number" && Number.isFinite(params.fastModeStartedAtMs)
      ? params.fastModeStartedAtMs
      : undefined;
  const fastModeAutoProgressState: FastModeAutoProgressState = params.fastModeAutoProgressState ?? {
    offAnnounced: false,
    resetAnnounced: false,
  };
  // Startup phase timings are profiler-gated because this function runs before
  // every Codex turn; normal production should not do timing bookkeeping here.
  const preDynamicStartupStages = createCodexDynamicToolBuildStageTracker({
    enabled: profilerEnabled,
  });
  const attemptClientFactory = options.clientFactory ?? getLeasedSharedCodexAppServerClient;
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
  const agentDir = params.agentDir ?? resolveAgentDir(params.config ?? {}, sessionAgentId);
  const bindingIdentity: CodexAppServerBindingIdentity = sessionBindingIdentity({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    config: params.config,
  });
  const bindingStore = options.bindingStore;
  preDynamicStartupStages.mark("session-agent");
  let activeContextEngine = isActiveHarnessContextEngine(params.contextEngine)
    ? params.contextEngine
    : undefined;
  const isInactiveThreadBootstrapBinding = (binding: CodexAppServerThreadBinding | undefined) =>
    !activeContextEngine && binding?.contextEngine?.projection?.mode === "thread_bootstrap";
  let startupBinding = await bindingStore.read(bindingIdentity);
  if (!startupBinding && bindingIdentity.kind === "session" && bindingIdentity.sessionKey) {
    const reclaimed = await reclaimCurrentCodexSessionGeneration({
      bindingStore,
      identity: bindingIdentity,
      config: params.config,
    });
    if (!reclaimed) {
      throw new Error(
        `Codex session generation is no longer current: ${bindingIdentity.sessionId}`,
      );
    }
    startupBinding = await bindingStore.read(bindingIdentity);
  }
  preDynamicStartupStages.mark("read-binding");
  // Only the private binding store may authorize the native user-home runtime.
  // Public session metadata and preserveNativeModel are intentionally insufficient.
  const usesSupervisionConnection = startupBinding?.connectionScope === "supervision";
  if (usesSupervisionConnection) {
    activeContextEngine = undefined;
  }
  if (usesSupervisionConnection && pluginConfig.supervision?.enabled !== true) {
    throw new Error(
      "Codex supervision is disabled; refusing to open a native user-home supervised session",
    );
  }
  const resolveRuntimeOptionsForBinding = (paramsLocal: {
    modelProvider?: string;
    model?: string;
  }) =>
    resolveCodexBindingAppServerConnection({
      binding: startupBinding,
      pluginConfig,
      execPolicy,
      modelProvider: paramsLocal.modelProvider,
      model: paramsLocal.model,
      config: params.config,
      agentDir,
      openClawSandboxActive: sandbox?.enabled === true,
    }).appServer;
  const startupBindingAuthProfileId = startupBinding?.authProfileId;
  const initialStartupBindingHadInactiveThreadBootstrap =
    isInactiveThreadBootstrapBinding(startupBinding);
  const startupAuthProfileCandidate = usesSupervisionConnection
    ? undefined
    : (params.runtimePlan?.auth.forwardedAuthProfileId ??
      params.authProfileId ??
      startupBinding?.authProfileId ??
      startupBindingAuthProfileId);
  const startupAuthProfileId = usesSupervisionConnection
    ? undefined
    : params.authProfileStore
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
  const startupClientAuthProfileId = usesSupervisionConnection ? null : startupAuthProfileId;
  const nativeAuthProfile =
    isCodexAppServerNativeAuthProfile({
      authProfileId: startupClientAuthProfileId ?? undefined,
      authProfileStore: params.authProfileStore,
      agentDir,
      config: params.config,
    }) || usesSupervisionConnection;
  const resolveReviewerPolicyContext = (binding: CodexAppServerThreadBinding | undefined) => {
    const nativeModelOwned = binding?.preserveNativeModel === true;
    // A supervised Codex branch owns its model. The outer OpenClaw default may
    // be Anthropic (or anything else) and must not select this thread's reviewer.
    return resolveCodexModelBackedReviewerPolicyContext({
      provider: nativeModelOwned ? "codex" : params.provider,
      model: nativeModelOwned ? binding.model : params.modelId,
      bindingModelProvider: binding?.modelProvider,
      bindingModel: binding?.model,
      nativeAuthProfile,
    });
  };
  let reviewerPolicyContext = resolveReviewerPolicyContext(startupBinding);
  preDynamicStartupStages.mark("auth-profile");
  let configuredAppServer = resolveRuntimeOptionsForBinding({
    modelProvider: reviewerPolicyContext.modelProvider,
    model: reviewerPolicyContext.model,
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
  let policyAppServer = resolveCodexAppServerForOpenClawToolPolicy({
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
  let appServer = resolveCodexAppServerForModelProvider({
    appServer: policyAppServer,
    provider: reviewerPolicyContext.modelProvider,
    model: reviewerPolicyContext.model,
    config: params.config,
    env: process.env,
    agentDir,
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
  let nativeHookRelayEvents = resolveCodexNativeHookRelayEvents({
    configuredEvents: options.nativeHookRelay?.events,
    appServer,
  });
  preDynamicStartupStages.mark("native-hook-relay");

  const runAbortController = new AbortController();
  // AbortController preserves its first reason, so retain explicit cancellation
  // that can arrive after the timeout abort while cleanup is still draining.
  let explicitCancellationObserved = false;
  let explicitCancellationReason: unknown;
  let terminalOutcomeFrozen = false;
  let sharedAbortAllowedAfterTerminalOutcome = false;
  let attemptAbortNotified = false;
  const notifyAttemptAbort = () => {
    if (attemptAbortNotified) {
      return;
    }
    attemptAbortNotified = true;
    params.onAttemptAbort?.();
  };
  const abortExplicitly = (reason: unknown) => {
    if (terminalOutcomeFrozen) {
      if (sharedAbortAllowedAfterTerminalOutcome) {
        notifyAttemptAbort();
      }
      return;
    }
    notifyAttemptAbort();
    explicitCancellationObserved = true;
    explicitCancellationReason ??= reason;
    runAbortController.abort(reason);
  };
  const abortFromUpstream = () => {
    abortExplicitly(params.abortSignal?.reason ?? "upstream_abort");
  };
  if (params.abortSignal?.aborted) {
    abortFromUpstream();
  } else {
    params.abortSignal?.addEventListener("abort", abortFromUpstream, { once: true });
  }

  startupBinding = await rotateOversizedCodexAppServerStartupBinding({
    binding: startupBinding,
    bindingStore,
    identity: bindingIdentity,
    sessionFile: params.sessionFile,
    agentDir,
    codexHome: appServer.start.env?.CODEX_HOME,
    config: params.config,
    contextEngineActive: Boolean(activeContextEngine),
  });
  const initialInactiveThreadBootstrapBindingForcedFreshStart =
    initialStartupBindingHadInactiveThreadBootstrap && !startupBinding?.threadId;
  preDynamicStartupStages.mark("rotate-binding");
  reviewerPolicyContext = resolveReviewerPolicyContext(startupBinding);
  configuredAppServer = resolveRuntimeOptionsForBinding({
    modelProvider: reviewerPolicyContext.modelProvider,
    model: reviewerPolicyContext.model,
  });
  policyAppServer = resolveCodexAppServerForOpenClawToolPolicy({
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
  appServer = resolveCodexAppServerForModelProvider({
    appServer: policyAppServer,
    provider: reviewerPolicyContext.modelProvider,
    model: reviewerPolicyContext.model,
    config: params.config,
    env: process.env,
    agentDir,
  });
  pluginAppServer = appServer;
  nativeHookRelayEvents = resolveCodexNativeHookRelayEvents({
    configuredEvents: options.nativeHookRelay?.events,
    appServer,
  });
  const effectiveContextWindowInfo = usesSupervisionConnection
    ? undefined
    : params.contextWindowInfo;
  const effectiveContextTokenBudget = usesSupervisionConnection
    ? undefined
    : params.contextTokenBudget;
  const effectiveRuntimeProviderId = usesSupervisionConnection
    ? (startupBinding?.modelProvider ?? "codex")
    : params.provider;
  // Pending branches learn the authoritative model only inside App Server.
  // This placeholder prevents outer-model metadata from shaping pre-start context policy.
  const effectiveRuntimeModelId = usesSupervisionConnection
    ? (startupBinding?.model ?? "codex-native")
    : params.modelId;
  const {
    authProfileId: _outerAuthProfileId,
    contextWindowInfo: _outerContextWindowInfo,
    contextTokenBudget: _outerContextTokenBudget,
    model: _outerModel,
    modelId: _outerModelId,
    provider: _outerProvider,
    runtimePlan: _outerRuntimePlan,
    requestedModelId: _outerRequestedModelId,
    fallbackReason: _outerFallbackReason,
    degradedReason: _outerDegradedReason,
    thinkLevel: _outerThinkLevel,
    fastMode: _outerFastMode,
    ...paramsWithoutOuterNativeOwnership
  } = params;
  const supervisedRuntimeModel = {
    id: effectiveRuntimeModelId,
    name: effectiveRuntimeModelId,
    provider: effectiveRuntimeProviderId,
    api: "openai-chatgpt-responses",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: undefined,
    maxTokens: undefined,
  } as unknown as EmbeddedRunAttemptParams["model"];
  const runtimeParams: EmbeddedRunAttemptParams = usesSupervisionConnection
    ? {
        ...paramsWithoutOuterNativeOwnership,
        provider: "codex",
        modelId: effectiveRuntimeModelId,
        model: supervisedRuntimeModel,
        thinkLevel: _outerThinkLevel,
        sessionKey: contextSessionKey,
      }
    : {
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
  const startupAuthAccountCacheKey = usesSupervisionConnection
    ? undefined
    : await resolveCodexAppServerAuthAccountCacheKey({
        authProfileId: startupAuthProfileId,
        authProfileStore: params.authProfileStore,
        agentDir,
        config: params.config,
      });
  const startupEnvApiKeyCacheKey = usesSupervisionConnection
    ? undefined
    : startupAuthProfileId
      ? undefined
      : resolveCodexAppServerFallbackApiKeyCacheKey({
          startOptions: appServer.start,
        });
  preDynamicStartupStages.mark("auth-cache");
  const bundleMcpThreadConfig = await loadCodexBundleMcpThreadConfig({
    workspaceDir: effectiveWorkspace,
    cfg: params.config,
    toolsEnabled: usesSupervisionConnection || supportsModelTools(params.model),
    disableTools: params.disableTools,
    toolsAllow: params.toolsAllow,
  });
  preDynamicStartupStages.mark("bundle-mcp");
  const sandboxExecServerEnabled = isCodexSandboxExecServerEnabled(pluginConfig);
  const nativeToolSurfaceEnabled = shouldEnableCodexAppServerNativeToolSurface(
    runtimeParams,
    sandbox,
    {
      agentId: sessionAgentId,
      runtimeSessionKey: sandboxSessionKey,
      sandboxExecServerEnabled,
    },
  );
  preDynamicStartupStages.mark("native-tool-surface");
  const nativeProviderWebSearchSupport =
    resolveCodexWebSearchPlan({
      config: params.config,
      disableTools: params.disableTools,
      nativeToolSurfaceEnabled,
    }).kind === "native-hosted"
      ? await resolveCodexProviderWebSearchSupport({
          clientFactory: attemptClientFactory,
          appServer,
          authProfileId: startupClientAuthProfileId,
          agentDir,
          config: params.config,
          modelProviderOverride: usesSupervisionConnection
            ? startupBinding?.modelProvider
            : resolveCodexAppServerThreadModelSelection({
                provider: params.provider,
                model: params.modelId,
                binding: startupBinding,
                authProfileId: startupAuthProfileId,
                authProfileStore: params.authProfileStore,
                agentDir,
                config: params.config,
              }).modelProvider,
          signal: runAbortController.signal,
        })
      : "unsupported";
  preDynamicStartupStages.mark("provider-capabilities");
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
  let persistentWebSearchAllowed: boolean | undefined;
  let webSearchAllowed = false;
  // Codex can compact a thread while keeping the same dynamic-tool bridge.
  // Bind screenshot coordinates to the context generation the pixels reached.
  const computerContextEpoch: {
    value: number;
    frameToolCallId?: string;
    frameImageIdentity?: string;
  } = { value: 0 };
  const tools = await buildDynamicTools({
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
      yieldDetected = true;
    },
    onCodexAppServerEvent: (event) => {
      void emitCodexAppServerEvent(params, event);
    },
    onPersistentWebSearchPolicyResolved: (allowed) => {
      persistentWebSearchAllowed = allowed;
    },
    onWebSearchPolicyResolved: (allowed) => {
      webSearchAllowed = allowed;
    },
    computerContextEpoch,
  });
  const registeredTools = await buildDynamicTools({
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
    forceHeartbeatTool: true,
    ignoreDisableMessageTool: true,
    ignoreRuntimePlan: true,
    onYieldDetected: () => {
      yieldDetected = true;
    },
    onCodexAppServerEvent: (event) => {
      void emitCodexAppServerEvent(params, event);
    },
    computerContextEpoch,
  });
  const toolBridge = createCodexDynamicToolBridge({
    tools,
    registeredTools,
    signal: runAbortController.signal,
    computerContextEpoch,
    loading: resolveCodexDynamicToolsLoadingForRuntime(pluginConfig, effectiveRuntimeModelId, {
      connectionClass: appServer.connectionClass,
    }),
    directToolNames: resolveCodexDynamicToolDirectNames(params),
    hookContext: {
      agentId: sessionAgentId,
      config: params.config,
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
  const hadSessionFile = await pathExists(activeSessionFile);
  const activeTranscriptTarget = {
    agentId: sessionAgentId,
    sessionFile: activeSessionFile,
    sessionId: activeSessionId,
    sessionKey: contextSessionKey,
  };
  let historyMessages =
    !activeContextEngine && initialStartupBindingHadInactiveThreadBootstrap
      ? []
      : ((await readMirroredSessionHistoryMessages(activeTranscriptTarget)) ?? []);
  const hookContextWindowFields = {
    ...(effectiveContextWindowInfo?.tokens
      ? { contextTokenBudget: effectiveContextWindowInfo.tokens }
      : effectiveContextTokenBudget
        ? { contextTokenBudget: effectiveContextTokenBudget }
        : {}),
    ...(effectiveContextWindowInfo?.source
      ? { contextWindowSource: effectiveContextWindowInfo.source }
      : {}),
    ...(effectiveContextWindowInfo?.referenceTokens
      ? { contextWindowReferenceTokens: effectiveContextWindowInfo.referenceTokens }
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
      tokenBudget: effectiveContextTokenBudget,
    });
  if (activeContextEngine) {
    await bootstrapHarnessContextEngine({
      hadSessionFile,
      contextEngine: activeContextEngine,
      sessionId: activeSessionId,
      sessionKey: contextSessionKey,
      sessionFile: activeSessionFile,
      runtimeContext: buildActiveContextEngineRuntimeContext(),
      contextEngineHostSupport: CODEX_APP_SERVER_CONTEXT_ENGINE_HOST,
      providerId: effectiveRuntimeProviderId,
      requestedModelId: usesSupervisionConnection ? undefined : params.requestedModelId,
      modelId: effectiveRuntimeModelId,
      fallbackReason: usesSupervisionConnection ? undefined : params.fallbackReason,
      degradedReason: usesSupervisionConnection ? undefined : params.degradedReason,
      runMaintenance: runHarnessContextEngineMaintenance,
      config: params.config,
      warn: (message) => embeddedAgentLog.warn(message),
    });
    historyMessages =
      (await readMirroredSessionHistoryMessages(activeTranscriptTarget)) ?? historyMessages;
  }
  const memoryToolNames = getCodexWorkspaceMemoryToolNames(toolBridge.availableSpecs);
  const workspaceBootstrapContext = await buildCodexWorkspaceBootstrapContext({
    params: runtimeParams,
    resolvedWorkspace,
    effectiveWorkspace,
    sessionKey: contextSessionKey,
    sessionAgentId,
    memoryToolNames,
  });
  const baseDeveloperInstructions = joinPresentSections(
    buildDeveloperInstructions(runtimeParams, {
      dynamicTools: toolBridge.availableSpecs,
    }),
    workspaceBootstrapContext.developerInstructions,
  );
  const openClawPromptContext = buildCodexOpenClawPromptContext({
    params: runtimeParams,
    workspacePromptContext: workspaceBootstrapContext.promptContext,
  });
  const skillsCollaborationInstructions = renderCodexSkillsCollaborationInstructions({
    attempt: runtimeParams,
    skillsPrompt: params.skillsSnapshot?.prompt,
  });
  let promptText = params.prompt;
  let promptContextRange: CodexProjectedContextRange | undefined;
  let developerInstructions = baseDeveloperInstructions;
  let prePromptMessageCount = historyMessages.length;
  const codexContextProjectionMaxChars = resolveCodexContextEngineProjectionMaxChars({
    contextTokenBudget: effectiveContextTokenBudget,
    reserveTokens: resolveCodexContextEngineProjectionReserveTokens({
      config: params.config,
    }),
  });
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
      maxRenderedContextChars: codexContextProjectionMaxChars,
    });
    promptText = projection.promptText;
    promptContextRange = projection.promptContextRange;
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
      tokenBudget: effectiveContextTokenBudget,
      availableTools: new Set(
        flattenCodexDynamicToolFunctions(toolBridge.availableSpecs)
          .map((tool) => tool.name)
          .filter(isNonEmptyString),
      ),
      citationsMode: params.config?.memory?.citations,
      modelId: effectiveRuntimeModelId,
      contextEngineHostSupport: CODEX_APP_SERVER_CONTEXT_ENGINE_HOST,
      providerId: effectiveRuntimeProviderId,
      requestedModelId: usesSupervisionConnection ? undefined : params.requestedModelId,
      fallbackReason: usesSupervisionConnection ? undefined : params.fallbackReason,
      degradedReason: usesSupervisionConnection ? undefined : params.degradedReason,
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
      maxRenderedContextChars: codexContextProjectionMaxChars,
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
    promptContextRange = projectionDecision.project ? projection.promptContextRange : undefined;
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
      bootstrapContextRunKind: params.bootstrapContextRunKind,
      ...("beforeAgentStartResult" in params
        ? { beforeAgentStartResult: params.beforeAgentStartResult }
        : {}),
    });
  const resolveShiftedPromptInputRange = (
    prompt: string,
    promptInputRange: { start: number; end: number } | undefined,
    turnPromptText: string,
  ): CodexProjectedContextRange | undefined => {
    if (
      !promptInputRange ||
      promptInputRange.start < 0 ||
      promptInputRange.end < promptInputRange.start ||
      promptInputRange.end > prompt.length ||
      !turnPromptText.endsWith(prompt)
    ) {
      return undefined;
    }
    const turnPromptOffset = turnPromptText.length - prompt.length;
    return {
      start: turnPromptOffset + promptInputRange.start,
      end: turnPromptOffset + promptInputRange.end,
    };
  };
  const resolveShiftedPromptContextRange = (
    prompt: string,
    promptInputRange: { start: number; end: number } | undefined,
    turnPromptText: string,
  ):
    | {
        contextRange: CodexProjectedContextRange;
        requestRange: CodexProjectedContextRange;
      }
    | undefined => {
    // promptInputRange ends before hook appendContext. Measure from the
    // immutable projected prompt instead of the hook-expanded prompt so that
    // the suffix remains available for bounded fitting as newer context.
    const promptTextInputOffset = promptInputRange
      ? promptInputRange.end - promptText.length
      : undefined;
    if (
      !promptContextRange ||
      !promptInputRange ||
      promptTextInputOffset === undefined ||
      promptInputRange.start < 0 ||
      promptInputRange.end < promptInputRange.start ||
      promptInputRange.end > prompt.length ||
      promptTextInputOffset < promptInputRange.start ||
      prompt.slice(promptTextInputOffset, promptInputRange.end) !== promptText ||
      !turnPromptText.endsWith(prompt)
    ) {
      return undefined;
    }
    // A hook can append the full projected prompt as newer transient context.
    // Fit that suffix so truncation retains its latest context rather than the
    // earlier input span. The exact input range still covers prepend-only hooks.
    const promptTextOffset = prompt.endsWith(promptText)
      ? prompt.length - promptText.length
      : promptTextInputOffset;
    if (promptTextOffset < 0) {
      return undefined;
    }
    const turnPromptOffset = turnPromptText.length - prompt.length + promptTextOffset;
    const contextRange = {
      start: turnPromptOffset + promptContextRange.start,
      end: turnPromptOffset + promptContextRange.end,
    };
    return {
      contextRange,
      requestRange: {
        start: contextRange.end,
        end: turnPromptOffset + promptText.length,
      },
    };
  };
  let promptBuild = await buildPromptFromCurrentInputs();
  const decorateCodexTurnPromptText = (promptBuildResult: {
    prompt: string;
    promptInputRange?: { start: number; end: number };
  }) => {
    const turnPromptText = prependCodexOpenClawPromptContext(
      promptBuildResult.prompt,
      openClawPromptContext,
      {
        preservePromptWithoutContext:
          params.bootstrapContextMode === "lightweight" &&
          params.bootstrapContextRunKind === "cron",
      },
    );
    const projectedRanges = resolveShiftedPromptContextRange(
      promptBuildResult.prompt,
      promptBuildResult.promptInputRange,
      turnPromptText,
    );
    const preservedRange =
      resolveShiftedPromptInputRange(
        promptBuildResult.prompt,
        promptBuildResult.promptInputRange,
        turnPromptText,
      ) ??
      resolveCodexDeliveryHintPreservedInputRange({
        prompt: promptBuildResult.prompt,
        promptInputRange: promptBuildResult.promptInputRange,
        decoratedPrompt: turnPromptText,
      });
    return fitCodexProjectedContextForTurnStart({
      promptText: turnPromptText,
      contextRange: projectedRanges?.contextRange,
      requestRange: projectedRanges?.requestRange,
      preservedRange,
    });
  };
  let codexTurnPromptText = decorateCodexTurnPromptText(promptBuild);
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
    codexTurnPromptText = decorateCodexTurnPromptText(promptBuild);
  };
  const rebuildCodexTurnPromptTextFromCurrentProjection = async () => {
    const nextPromptBuild = await buildPromptFromCurrentInputs();
    // Native Codex thread instructions are fixed once thread/start or
    // thread/resume completes; recovery continuity after that is turn input.
    promptBuild = {
      ...promptBuild,
      prompt: nextPromptBuild.prompt,
      promptInputRange: nextPromptBuild.promptInputRange,
    };
    codexTurnPromptText = decorateCodexTurnPromptText(nextPromptBuild);
  };
  const selectNewerVisibleHistoryAfterBinding = (binding: CodexAppServerThreadBinding) => {
    const historyCoveredThrough = Date.parse(binding.historyCoveredThrough ?? "");
    const cutoff = Number.isFinite(historyCoveredThrough) ? historyCoveredThrough : 0;
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
      const mirrorOrigin =
        meta && typeof meta === "object" && !Array.isArray(meta)
          ? (meta as Record<string, unknown>).mirrorOrigin
          : undefined;
      if (mirrorOrigin === "codex-app-server") {
        return false;
      }
      if (typeof mirrorIdentity === "string" && mirrorIdentity.startsWith("codex-app-server:")) {
        return false;
      }
      const timestamp =
        typeof message.timestamp === "number"
          ? message.timestamp
          : typeof message.timestamp === "string"
            ? Date.parse(message.timestamp)
            : Number.NaN;
      return Number.isFinite(timestamp) && timestamp > cutoff;
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
      maxRenderedContextChars: codexContextProjectionMaxChars,
    });
    promptText = projection.promptText;
    promptContextRange = projection.promptContextRange;
    prePromptMessageCount = projection.prePromptMessageCount;
    return true;
  };
  const precomputeNoContextEngineStaleBindingProjection = (
    binding: CodexAppServerThreadBinding | undefined,
  ) => {
    precomputedStaleBindingContinuityProjectionApplied = false;
    staleBindingContinuityForcedFreshStart = false;
    if (activeContextEngine || !binding?.threadId || binding.pendingSupervisionBranch) {
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
    action: "started" | "resumed" | "forked",
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
      bindingStore,
      identity: bindingIdentity,
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
    if (staleBindingContinuityForcedFreshStart) {
      // Once the native thread id is discarded, Codex no longer owns the
      // pre-binding history; rebuild from the mirrored transcript.
      applyFreshThreadContinuityProjection();
    }
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
  let turnRouter: CodexAppServerTurnRouter;
  let turnRoute: CodexThreadRouteReservation | undefined;
  let routeActivated = false;
  let detachRouteAbort: () => void = () => undefined;
  let trajectoryEndRecorded = false;
  const markTrajectoryEndRecorded = () => {
    trajectoryEndRecorded = true;
  };
  let nativeHookRelay: NativeHookRelayRegistrationHandle | undefined;
  const nativeSubagentMonitorRef: {
    current?: ReturnType<typeof registerCodexNativeSubagentMonitor>;
  } = {};
  const pendingNativePreToolUseFailures: CodexNativePreToolUseFailure[] = [];
  const projectorRef: { current?: CodexAppServerEventProjector } = {};
  let nativePreToolUseFailureFallbackActive = false;
  let nativePreToolUseFailureFallbackTerminalReason:
    | CodexNativePreToolUseFailure["disposition"]
    | undefined;
  const emitNativePreToolUseFailure = (failure: CodexNativePreToolUseFailure) => {
    emitCodexNativePreToolUseFailureDiagnostic({
      agentId: sessionAgentId,
      sessionId: params.sessionId,
      sessionKey: sandboxSessionKey,
      runId: params.runId,
      signal: runAbortController.signal,
      failure,
      ...(nativePreToolUseFailureFallbackActive
        ? {
            terminalReason: nativePreToolUseFailureFallbackTerminalReason ?? failure.disposition,
          }
        : {}),
    });
  };
  const flushPendingNativePreToolUseFailures = () => {
    for (const failure of pendingNativePreToolUseFailures.splice(0)) {
      emitNativePreToolUseFailure(failure);
    }
  };
  const activateNativePreToolUseFailureFallback = () => {
    if (!nativePreToolUseFailureFallbackActive) {
      nativePreToolUseFailureFallbackTerminalReason = runAbortController.signal.aborted
        ? resolveCodexToolAbortTerminalReason(runAbortController.signal)
        : undefined;
      nativePreToolUseFailureFallbackActive = true;
    }
    flushPendingNativePreToolUseFailures();
  };
  let releaseSharedClientLease: (() => void) | undefined;
  let sharedCodexClientRetiredForOneShotCleanup = false;
  const releaseSharedClientLeaseOnce = () => {
    const release = releaseSharedClientLease;
    if (!release) {
      return;
    }
    releaseSharedClientLease = undefined;
    release();
  };
  const retireSharedCodexClientForOneShotCleanup = async () => {
    if (params.cleanupBundleMcpOnRunEnd !== true) {
      return;
    }
    if (sharedCodexClientRetiredForOneShotCleanup) {
      return;
    }
    sharedCodexClientRetiredForOneShotCleanup = true;
    const retired = retireSharedCodexAppServerClientIfCurrent(client);
    embeddedAgentLog.info("codex app-server one-shot cleanup retired shared client", {
      runId: params.runId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      activeLeases: retired?.activeLeases ?? null,
      closed: retired?.closed ?? false,
      matchedSharedClient: Boolean(retired),
    });
    if (retired?.closed) {
      await client.closeAndWait({ exitTimeoutMs: 2_000, forceKillDelayMs: 250 });
    }
  };
  const releaseSharedClientLeaseAndRetireOneShotClient = async () => {
    releaseSharedClientLeaseOnce();
    await retireSharedCodexClientForOneShotCleanup();
  };
  let sandboxExecEnvironmentAcquired = false;
  const releaseSandboxExecEnvironment = async () => {
    if (sandboxExecEnvironmentAcquired) {
      sandboxExecEnvironmentAcquired = false;
      await releaseCodexSandboxExecServerEnvironment(sandbox);
    }
  };
  const releaseCurrentRoute = () => {
    detachRouteAbort();
    detachRouteAbort = () => undefined;
    turnRoute?.release();
    turnRoute = undefined;
    routeActivated = false;
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
      onPreToolUseFailure: (failure) => {
        const projector = projectorRef.current;
        if (projector) {
          projector.recordNativeToolPreToolUseFailure(failure);
        } else if (nativePreToolUseFailureFallbackActive) {
          emitNativePreToolUseFailure(failure);
        } else {
          pendingNativePreToolUseFailures.push(failure);
        }
      },
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
    void emitCodexAppServerEvent(params, {
      stream: "codex_app_server.lifecycle",
      data: { phase: "startup" },
    });
    const attemptAppServer = withCodexAppServerFastModeServiceTier(appServer, runtimeParams);
    pluginAppServer = attemptAppServer;
    const startupResult = await startCodexAttemptThread({
      attemptClientFactory,
      bindingStore,
      appServer: attemptAppServer,
      pluginConfig,
      computerUseConfig,
      startupAuthProfileId: startupClientAuthProfileId,
      startupAuthAccountCacheKey,
      startupEnvApiKeyCacheKey,
      agentDir,
      config: params.config,
      buildAttemptParams: buildActiveRunAttemptParams,
      sessionAgentId,
      effectiveWorkspace,
      effectiveCwd,
      dynamicTools: toolBridge.specs,
      persistentWebSearchAllowed,
      webSearchAllowed,
      developerInstructions: promptBuild.developerInstructions,
      buildFinalConfigPatch: buildNativeHookRelayFinalConfigPatch,
      bundleMcpThreadConfig,
      nativeToolSurfaceEnabled,
      nativeProviderWebSearchSupport,
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
    turnRouter = startupResult.turnRouter;
    turnRoute = startupResult.turnRoute;
    pluginAppServer = startupResult.pluginAppServer;
    if (
      usesSupervisionConnection &&
      (thread.connectionScope !== "supervision" ||
        thread.supervisionSourceThreadId !== startupBinding?.supervisionSourceThreadId)
    ) {
      throw new Error("Codex supervised thread lost its private connection ownership");
    }
    if (thread.lifecycle.action === "started" || thread.lifecycle.action === "forked") {
      const activeThreadReviewerPolicyContext = resolveReviewerPolicyContext(thread);
      const activeThreadConfiguredAppServer = resolveRuntimeOptionsForBinding({
        modelProvider: activeThreadReviewerPolicyContext.modelProvider,
        model: activeThreadReviewerPolicyContext.model,
      });
      const activeThreadAppServer = resolveCodexAppServerForModelProvider({
        appServer: activeThreadConfiguredAppServer,
        provider: activeThreadReviewerPolicyContext.modelProvider,
        model: activeThreadReviewerPolicyContext.model,
        config: params.config,
        env: process.env,
        agentDir,
      });
      const previousApprovalsReviewer = pluginAppServer.approvalsReviewer;
      pluginAppServer = {
        ...pluginAppServer,
        approvalsReviewer: activeThreadAppServer.approvalsReviewer,
      };
      if (pluginAppServer.approvalsReviewer !== previousApprovalsReviewer) {
        embeddedAgentLog.info(
          "codex app-server approval reviewer updated from active thread model provider",
          {
            from: previousApprovalsReviewer,
            to: pluginAppServer.approvalsReviewer,
            modelProvider: activeThreadReviewerPolicyContext.modelProvider,
          },
        );
      }
    }
    sandboxExecEnvironmentAcquired = Boolean(startupResult.sandboxEnvironment);
    codexEnvironmentSelection = startupResult.environmentSelection;
    codexExecutionCwd = startupResult.executionCwd;
    codexSandboxPolicy = startupResult.sandboxPolicy;
    releaseSharedClientLease = startupResult.releaseSharedClientLease;
    restartContextEngineCodexThread = startupResult.restartContextEngineCodexThread;
    void emitCodexAppServerEvent(params, {
      stream: "codex_app_server.lifecycle",
      data: { phase: "thread_ready", threadId: thread.threadId },
    });
  } catch (error) {
    activateNativePreToolUseFailureFallback();
    releaseCurrentRoute();
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
    toolCount: flattenCodexDynamicToolFunctions(toolBridge.specs).length,
  });
  recordCodexTrajectoryContext(trajectoryRecorder, {
    attempt: params,
    cwd: effectiveCwd,
    developerInstructions: buildRenderedCodexDeveloperInstructions(),
    prompt: codexTurnPromptText,
    tools: toolBridge.availableSpecs,
  });
  let latestStartupErrorNotification: CodexServerNotification | undefined;
  let rateLimitsRevisionBeforeLastTurnStart: number | undefined;
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
    params.runTimeoutOverrideMs,
  );
  const turnAttemptIdleTimeoutMs = Math.max(100, Math.floor(params.timeoutMs));
  let nativeHookRelayLastRenewedAt = 0;
  let activeAppServerTurnRequests = 0;
  const pendingOpenClawDynamicToolCompletionIds = new Set<string>();
  // Codex can redeliver one pending server request while this attempt remains
  // active. Keep one execution promise so duplicate delivery never repeats a
  // non-idempotent action such as computer input.
  const openClawDynamicToolExecutions = createCodexDynamicToolExecutionRegistry();
  const activeTurnItemIds = new Set<string>();
  const activeCompletionBlockerItemIds = new Set<string>();
  const activeFinalizationHookRunIds = new Set<string>();
  const finalizationHookBatchStatuses = new Map<string, string | undefined>();
  let unsettledFinalizationHookCount = 0;
  let rejectedFinalizationHookAssistant: { itemId?: string } | undefined;
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
    getActiveCompletionBlockerItemCount: () => activeCompletionBlockerItemIds.size,
    getActiveFinalizationHookCount: () => unsettledFinalizationHookCount,
    canReleaseAssistantCompletionIdle: () =>
      projectorRef.current?.hasLatestTerminalAssistantCandidateText() === true,
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
    void emitCodexAppServerEvent(params, {
      stream: "lifecycle",
      data: { phase: "start", startedAt: attemptStartedAt },
    });
    lifecycleStarted = true;
  };

  const emitLifecycleTerminal = (data: Record<string, unknown> & { phase: "end" | "error" }) => {
    if (!lifecycleStarted || lifecycleTerminalEmitted) {
      return;
    }
    void emitCodexAppServerEvent(params, {
      stream: "lifecycle",
      data: {
        startedAt: attemptStartedAt,
        endedAt: Date.now(),
        ...data,
        ...((params.deferTerminalLifecycle ?? params.deferTerminalLifecycleEnd)
          ? { phase: "finishing" }
          : {}),
      },
    });
    lifecycleTerminalEmitted = true;
  };
  const buildLifecycleTerminalMeta = (input: { aborted: boolean; timedOut: boolean }) => {
    const abortFields = input.aborted
      ? resolveAgentRunAbortLifecycleFields(runAbortController.signal)
      : undefined;
    if (input.timedOut || abortFields?.stopReason === "timeout") {
      return {
        aborted: true,
        status: "timed_out",
        stopReason: "timeout",
        timeoutPhase: "provider",
        providerStarted: true,
      } as const;
    }
    return input.aborted
      ? ({ aborted: true, status: "cancelled", stopReason: "stop" } as const)
      : undefined;
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
  const emitFastModeAutoProgress = async (payload: {
    enabled: boolean;
    elapsedSeconds: number;
    fastAutoOnSeconds?: number;
  }): Promise<void> => {
    const summary = formatFastModeAutoProgressText(payload);
    await emitCodexAppServerEvent(params, {
      stream: "item",
      data: {
        kind: "status",
        title: "Fast",
        phase: "update",
        summary,
      },
    });
    try {
      await params.onToolResult?.({
        text: summary,
        channelData: { openclawProgressKind: FAST_MODE_AUTO_PROGRESS_KIND },
      });
    } catch (error) {
      embeddedAgentLog.debug("codex app-server fast mode auto progress delivery failed", {
        error,
      });
    }
  };
  const maybeAnnounceFastModeAutoOff = async (): Promise<void> => {
    if (
      params.fastModeAuto !== true ||
      fastModeAutoStartedAtMs === undefined ||
      fastModeAutoProgressState.offAnnounced
    ) {
      return;
    }
    const next = resolveFastModeForElapsed({
      mode: "auto",
      startedAtMs: fastModeAutoStartedAtMs,
      fastAutoOnSeconds: params.fastModeAutoOnSeconds,
    });
    if (next.enabled) {
      return;
    }
    fastModeAutoProgressState.offAnnounced = true;
    await emitFastModeAutoProgress(next);
  };
  const maybeEmitFastModeAutoReset = async (): Promise<void> => {
    if (
      params.fastModeAuto !== true ||
      !fastModeAutoProgressState.offAnnounced ||
      fastModeAutoProgressState.resetAnnounced
    ) {
      return;
    }
    fastModeAutoProgressState.resetAnnounced = true;
    await emitFastModeAutoProgress({
      enabled: true,
      elapsedSeconds: 0,
      fastAutoOnSeconds: params.fastModeAutoOnSeconds,
    });
  };
  const maybeEmitFastModeAutoResetBestEffort = async (): Promise<void> => {
    try {
      await maybeEmitFastModeAutoReset();
    } catch (error) {
      embeddedAgentLog.warn(
        `codex app-server fast mode auto reset progress failed: ${formatErrorMessage(error)}`,
      );
    }
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
      // Pre-turn traffic on an open route is a resumed native turn. Keep the
      // last error so a failed turn/start can still explain usage limits.
      if (notification.method === "error") {
        latestStartupErrorNotification = notification;
      }
      return;
    }
    const notificationState = applyCodexTurnNotificationState({
      notification,
      threadId: thread.threadId,
      turnId,
      currentPromptTexts: [codexTurnPromptText],
      turnWatches,
      activeTurnItemIds,
      activeCompletionBlockerItemIds,
      activeAppServerTurnRequests,
      pendingOpenClawDynamicToolCompletionIds,
      turnCrossedToolHandoff,
      postToolRawAssistantCompletionIdleTimeoutMs,
      onScheduleTerminalDynamicToolReleaseCheck: scheduleTerminalDynamicToolReleaseCheck,
      onReportExecutionNotification: reportExecutionNotification,
    });
    turnCrossedToolHandoff = notificationState.turnCrossedToolHandoff;
    const finalizationHookNotification = readCodexFinalizationHookNotification(
      notification,
      thread.threadId,
      turnId,
    );
    if (finalizationHookNotification?.phase === "started") {
      // Codex emits every start in one Stop/SubagentStop batch before it runs
      // any handler, then emits completions. An empty active set starts a batch.
      if (activeFinalizationHookRunIds.size === 0) {
        finalizationHookBatchStatuses.clear();
      }
      activeFinalizationHookRunIds.add(finalizationHookNotification.runId);
      // The receive-time disarm may precede an earlier queued assistant
      // completion. Repeat it in notification order after that completion.
      turnWatches.disarmAssistantCompletionIdleWatch();
    }
    // Determine terminal-turn status before invoking the projector so a throw
    // inside projector.handleNotification still releases the session lane.
    // See openclaw/openclaw#67996.
    if (notificationState.isTurnTerminal) {
      terminalTurnNotificationQueued = true;
    }
    try {
      await waitForCodexNotificationDispatchTurn();
      await projector.handleNotification(notification);
      const projectedAssistantCompletionCanRelease =
        isAssistantCompletionReleaseNotification(notification, turnCrossedToolHandoff) ||
        (notificationState.isCurrentTurnNotification &&
          turnCrossedToolHandoff &&
          notification.method === "rawResponseItem/completed" &&
          projector.canReleaseLatestTerminalAssistantAfterToolHandoff());
      if (notificationState.isCurrentTurnNotification && projectedAssistantCompletionCanRelease) {
        const completedAssistantItemId = projector.getLatestTerminalAssistantCandidate()?.itemId;
        if (
          rejectedFinalizationHookAssistant !== undefined &&
          completedAssistantItemId !== undefined &&
          completedAssistantItemId !== rejectedFinalizationHookAssistant.itemId
        ) {
          rejectedFinalizationHookAssistant = undefined;
        } else if (rejectedFinalizationHookAssistant !== undefined) {
          // A delayed raw echo still belongs to the rejected assistant.
          turnWatches.disarmAssistantCompletionIdleWatch();
        } else {
          const canArmProjectedAssistantCompletion =
            activeFinalizationHookRunIds.size === 0 &&
            !terminalTurnNotificationQueued &&
            activeAppServerTurnRequests === 0 &&
            activeTurnItemIds.size === 0 &&
            activeCompletionBlockerItemIds.size === 0 &&
            pendingOpenClawDynamicToolCompletionIds.size === 0 &&
            projector.hasLatestTerminalAssistantCandidateText();
          if (canArmProjectedAssistantCompletion) {
            // Receive-time arming can expire while an earlier queued projection
            // is still running. Restart the idle window from committed output.
            turnWatches.armAssistantCompletionIdleWatch(describeNotificationActivity(notification));
          }
        }
      }
      if (
        notificationState.isCurrentTurnNotification &&
        activeTurnItemIds.size === 0 &&
        isRawFunctionToolOutputCompletionNotification(notification)
      ) {
        await maybeAnnounceFastModeAutoOff();
      }
    } catch (error) {
      embeddedAgentLog.debug("codex app-server projector notification threw", {
        method: notification.method,
        error,
      });
    } finally {
      if (finalizationHookNotification?.phase === "completed") {
        unsettledFinalizationHookCount = Math.max(0, unsettledFinalizationHookCount - 1);
        activeFinalizationHookRunIds.delete(finalizationHookNotification.runId);
        finalizationHookBatchStatuses.set(
          finalizationHookNotification.runId,
          finalizationHookNotification.status,
        );
        if (activeFinalizationHookRunIds.size === 0) {
          const statuses = new Set(finalizationHookBatchStatuses.values());
          const aggregateBlocked = statuses.has("blocked") && !statuses.has("stopped");
          if (aggregateBlocked) {
            const itemId = projector.getLatestTerminalAssistantCandidate()?.itemId;
            rejectedFinalizationHookAssistant = itemId ? { itemId } : {};
            turnWatches.disarmAssistantCompletionIdleWatch();
          } else {
            rejectedFinalizationHookAssistant = undefined;
          }
        }
        const canRearmAssistantCompletionWatch =
          activeFinalizationHookRunIds.size === 0 &&
          rejectedFinalizationHookAssistant === undefined &&
          !terminalTurnNotificationQueued &&
          activeAppServerTurnRequests === 0 &&
          activeTurnItemIds.size === 0 &&
          activeCompletionBlockerItemIds.size === 0 &&
          pendingOpenClawDynamicToolCompletionIds.size === 0 &&
          projector.hasLatestTerminalAssistantCandidateText();
        if (canRearmAssistantCompletionWatch) {
          turnWatches.armAssistantCompletionIdleWatch({
            lastNotificationMethod: notification.method,
            hookRunId: finalizationHookNotification.runId,
            hookStatus: finalizationHookNotification.status,
          });
        }
      }
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
  const waitForActiveNativeTurnCompletion = async (): Promise<boolean> => {
    const route = turnRoute;
    if (!route) {
      return false;
    }
    return await route.waitForTurnCompletion({
      timeoutMs: Math.min(appServer.requestTimeoutMs, CODEX_APP_SERVER_NATIVE_TURN_WAIT_TIMEOUT_MS),
      signal: runAbortController.signal,
    });
  };
  const noteNotificationReceived = (
    notification: CodexServerNotification,
    scope: CodexThreadRouteScope,
    receivedAtMs: number,
  ) => {
    const projector = projectorRef.current;
    const turnId = turnIdRef.current;
    if (!projector || !turnId) {
      return;
    }
    if (isTerminalTurnNotificationForTurn(notification, turnId)) {
      terminalTurnNotificationQueued = true;
    }
    if (scope.turnId === turnId) {
      const modelToolCallId = readRawResponseToolCallId(notification);
      if (modelToolCallId) {
        // Raw response items arrive in model order before Codex schedules tool
        // futures, so later lifecycle races reuse this authoritative position.
        allocateCodexToolOutcomeOrdinal?.(modelToolCallId);
      }
      const nativeItem = readCodexNotificationItem(notification.params);
      if (nativeItem?.type === "webSearch") {
        // Upstream omits the raw web-search id. Its lifecycle still follows the
        // model stream, so reserve synchronously before queued projection.
        projector.recordNativeToolOutcome(nativeItem);
      }
    }
    const finalizationHookNotification = readCodexFinalizationHookNotification(
      notification,
      thread.threadId,
      turnId,
    );
    if (finalizationHookNotification?.phase === "started") {
      unsettledFinalizationHookCount += 1;
      // Codex runs finalization hooks after completing the assistant item.
      // Suspend recovery until those hooks accept or replace that answer.
      turnWatches.disarmAssistantCompletionIdleWatch();
    }
    // Touch idle-watch timestamps at receive time, not just after queued
    // projection. A queued terminal event should suppress short false-idle
    // guards, while the full attempt watchdog still releases a wedged queue.
    turnWatches.noteNotificationReceived(notification.method, { receivedAtMs });
  };
  const enqueueNotification = async (
    notification: CodexServerNotification,
    scope: CodexThreadRouteScope,
  ): Promise<void> => {
    embeddedAgentLog.trace("codex app-server raw notification received", {
      method: notification.method,
      ...scope,
    });
    await handleNotification(notification);
  };
  const drainNotificationQueue = async (): Promise<void> => {
    await turnRoute?.drain();
  };

  const nativeSubagentCodexHome =
    appServer.start.transport === "stdio"
      ? (appServer.start.env?.CODEX_HOME ?? resolveCodexAppServerHomeDir(agentDir))
      : undefined;
  nativeSubagentMonitorRef.current = registerCodexNativeSubagentMonitor({
    client,
    parentThreadId: thread.threadId,
    requesterSessionKey: params.sessionKey,
    taskRuntimeScope: params.agentHarnessTaskRuntimeScope,
    agentId: params.agentId,
    codexHome: nativeSubagentCodexHome,
  });
  const handleServerRequest = async (
    request: CodexAppServerServerRequest,
    scope: CodexThreadRouteScope,
  ) => {
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
      if (!turnId) {
        return undefined;
      }
      if (request.method === "mcpServer/elicitation/request") {
        if (!scope.turnId || scope.turnId === turnId) {
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
        if (scope.turnId === turnId) {
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
          if (scope.turnId === turnId) {
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
            onNativeToolFailureDisposition: (itemId, disposition) =>
              projector?.recordNativeToolApprovalFailure(itemId, disposition),
          });
        }
        return undefined;
      }
      const call = readDynamicToolCallParams(request.params);
      if (!call || call.threadId !== thread.threadId || call.turnId !== turnId) {
        return undefined;
      }
      const replayedExecution = openClawDynamicToolExecutions.get(call);
      if (replayedExecution) {
        armCompletionWatchOnResponse = true;
        markCurrentTurnRequestProgress();
        turnCrossedToolHandoff = true;
        return toCodexDynamicToolProtocolResponse(await replayedExecution) as JsonValue;
      }
      const toolCallOrdinal = allocateCodexToolOutcomeOrdinal?.(call.callId);
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
        agentId: sessionAgentId,
        runId: params.runId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
      });
      const toolProgressDetailMode = resolveCodexToolProgressDetailMode(params.toolProgressDetail);
      const toolMeta = inferCodexDynamicToolMeta(call, toolProgressDetailMode);
      const toolArgs = sanitizeCodexToolArguments(call.arguments);
      const shouldEmitDynamicToolProgress = shouldEmitTranscriptToolProgress(call.tool, toolArgs);
      if (shouldEmitDynamicToolProgress) {
        void emitCodexAppServerEvent(params, {
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
        const { execution } = openClawDynamicToolExecutions.claim(call, () =>
          handleDynamicToolCallWithTimeout({
            call,
            toolBridge,
            signal: runAbortController.signal,
            timeoutMs: dynamicToolTimeoutMs,
            toolCallOrdinal,
            onAgentToolResult: params.onAgentToolResult,
            onFallbackSelected: () => {
              if (toolCallOrdinal !== undefined) {
                suppressedDynamicToolOutcomeOrdinals.add(toolCallOrdinal);
              }
            },
            onTimeout: () => {
              trajectoryRecorder?.recordEvent("tool.timeout", {
                threadId: call.threadId,
                turnId: call.turnId,
                toolCallId: call.callId,
                name: call.tool,
                timeoutMs: dynamicToolTimeoutMs,
              });
            },
          }),
        );
        const response = await execution;
        const protocolResponse = toCodexDynamicToolProtocolResponse(response);
        if (!protocolResponse.success && toolCallOrdinal !== undefined) {
          // The underlying tool may ignore cancellation and finish after the
          // timeout response. Its late presentation must not replace this failure.
          suppressedDynamicToolOutcomeOrdinals.add(toolCallOrdinal);
          params.onToolOutcome?.({
            toolName: call.tool,
            argsHash: "",
            resultHash: "",
            toolCallOrdinal,
            terminalPresentation: undefined,
            presentationOnly: true,
          });
        }
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
          void emitCodexAppServerEvent(params, {
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
            agentId: sessionAgentId,
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
            agentId: sessionAgentId,
            runId: params.runId,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            durationMs: Math.max(0, Date.now() - toolStartedAt),
          });
        }
        throw error;
      } finally {
        toolOutcomeOrdinals.delete(call.callId);
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
  };

  const attachRouteAbort = (route: CodexThreadRouteReservation) => {
    const onAbort = () => {
      if (completed || terminalTurnNotificationQueued || runAbortController.signal.aborted) {
        return;
      }
      const reasonText = formatErrorMessage(route.signal.reason);
      const closedClient = reasonText.includes("turn router closed");
      clientClosedPromptError = closedClient
        ? "codex app-server client closed before turn completed"
        : `codex app-server turn route closed before turn completed: ${reasonText}`;
      clientClosedAbort = closedClient;
      const activeTurnId = turnIdRef.current;
      if (activeTurnId) {
        trajectoryRecorder?.recordEvent("turn.client_closed", {
          threadId: thread.threadId,
          turnId: activeTurnId,
        });
      }
      embeddedAgentLog.warn(clientClosedPromptError, {
        threadId: thread.threadId,
        turnId: activeTurnId,
      });
      runAbortController.abort(closedClient ? "client_closed" : "turn_route_closed");
      completed = true;
      turnWatches.clearAllTimers();
      resolveCompletion?.();
    };
    route.signal.addEventListener("abort", onAbort, { once: true });
    if (route.signal.aborted) {
      onAbort();
    }
    return () => route.signal.removeEventListener("abort", onAbort);
  };
  const ensureCurrentThreadRoute = async (): Promise<CodexThreadRouteReservation> => {
    if (turnRoute?.threadId !== thread.threadId) {
      releaseCurrentRoute();
      turnRoute = turnRouter.reserveThread({
        threadId: thread.threadId,
        releaseOn: runAbortController.signal,
      });
    }
    if (!turnRoute) {
      throw new Error("codex app-server turn route was not reserved");
    }
    if (!routeActivated) {
      detachRouteAbort = attachRouteAbort(turnRoute);
      await turnRoute.activate({
        onNotificationReceived: noteNotificationReceived,
        onNotification: enqueueNotification,
        onRequest: handleServerRequest,
      });
      routeActivated = true;
    }
    return turnRoute;
  };
  try {
    await ensureCurrentThreadRoute();
  } catch (error) {
    activateNativePreToolUseFailureFallback();
    releaseCurrentRoute();
    nativeHookRelay?.unregister();
    await releaseSandboxExecEnvironment();
    releaseSharedClientLeaseOnce();
    params.abortSignal?.removeEventListener("abort", abortFromUpstream);
    throw error;
  }

  const buildLlmInputEvent = () => ({
    runId: params.runId,
    sessionId: params.sessionId,
    provider: usesSupervisionConnection
      ? (thread.modelProvider ?? effectiveRuntimeProviderId)
      : params.provider,
    model: usesSupervisionConnection ? (thread.model ?? effectiveRuntimeModelId) : params.modelId,
    systemPrompt: buildRenderedCodexDeveloperInstructions(),
    prompt: codexTurnPromptText,
    historyMessages: codexModelInputHistoryMessages,
    imagesCount: params.images?.length ?? 0,
    tools,
  });
  const buildCodexModelInputMessages = () => [
    ...codexModelInputHistoryMessages,
    buildCodexUserPromptMessage({ ...runtimeParams, prompt: codexTurnPromptText }),
  ];
  const codexModelCallBaseFields = {
    runId: params.runId,
    callId: codexModelCallId,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    sessionId: params.sessionId,
    provider: usesSupervisionConnection
      ? (thread.modelProvider ?? effectiveRuntimeProviderId)
      : params.provider,
    model: usesSupervisionConnection ? (thread.model ?? effectiveRuntimeModelId) : params.modelId,
    api: usesSupervisionConnection ? runtimeParams.model.api : params.model.api,
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
    const activeTurnRoute = await ensureCurrentThreadRoute();
    const turnAppServer = withCodexAppServerFastModeServiceTier(pluginAppServer, runtimeParams);
    pluginAppServer = turnAppServer;
    const turnStartParams = buildTurnStartParams(runtimeParams, {
      threadId: thread.threadId,
      cwd: codexExecutionCwd,
      appServer: turnAppServer,
      promptText: codexTurnPromptText,
      sandboxPolicy: codexSandboxPolicy,
      environmentSelection: codexEnvironmentSelection,
      ...(usesSupervisionConnection
        ? {}
        : { model: thread.model, modelProvider: thread.modelProvider }),
      turnScopedDeveloperInstructions: workspaceBootstrapContext.turnScopedDeveloperInstructions,
      skillsCollaborationInstructions,
      memoryCollaborationInstructions: workspaceBootstrapContext.memoryCollaborationInstructions,
      heartbeatCollaborationInstructions:
        workspaceBootstrapContext.heartbeatCollaborationInstructions,
      preserveNativeTurnSettings: usesSupervisionConnection,
    });
    codexModelCallDiagnostics.setRequestPayloadBytes(utf8JsonByteLength(turnStartParams));
    // Keep turn/start diagnostics scoped to this attempt: resumed native work
    // can emit unrelated errors, and only a primary rate-limit update observed
    // after this point may be trusted for the attempt's auth profile.
    latestStartupErrorNotification = undefined;
    rateLimitsRevisionBeforeLastTurnStart = readCodexRateLimitsRevision(client);
    activeTurnRoute.armTurn();
    void emitCodexAppServerEvent(params, {
      stream: "codex_app_server.lifecycle",
      data: {
        phase: "turn_starting",
        threadId: thread.threadId,
        model: turnStartParams.model,
        effort: turnStartParams.effort,
        collaborationEffort: turnStartParams.collaborationMode?.settings.reasoning_effort,
      },
    });
    let acceptedTurnId: string | undefined;
    try {
      const startedTurn = assertCodexTurnStartResponse(
        await client.request("turn/start", turnStartParams, {
          timeoutMs: params.timeoutMs,
          signal: runAbortController.signal,
        }),
      );
      acceptedTurnId = startedTurn.turn.id;
      throwIfTurnStartAcceptedAfterAbort();
      return startedTurn;
    } catch (error) {
      if (acceptedTurnId) {
        // The turn was accepted but this run is failing. Interrupt it before
        // dropping the route, so an accepted turn can never keep feeding a
        // released route or wedge the shared client mid-flight.
        interruptCodexTurnBestEffort(client, {
          threadId: thread.threadId,
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
  const resumedWithActiveNativeTurn =
    thread.lifecycle.action === "resumed" && (thread.lifecycle.activeTurnIds?.length ?? 0) > 0;
  if (resumedWithActiveNativeTurn) {
    // A resumed Codex thread can already be running a native compact/review turn.
    // Starting an OpenClaw turn before that native turn completes can wedge the
    // accepted turn behind a completion event we intentionally ignore.
    embeddedAgentLog.info(
      "codex app-server resumed thread has active native turn; waiting before turn/start",
      { threadId: thread.threadId },
    );
    void emitCodexAppServerEvent(params, {
      stream: "codex_app_server.lifecycle",
      data: {
        phase: "turn_start_waiting_for_native_turn",
        threadId: thread.threadId,
      },
    });
    const nativeTurnCompleted = await waitForActiveNativeTurnCompletion();
    if (nativeTurnCompleted) {
      await turnRoute?.drain();
    }
    if (!nativeTurnCompleted && !runAbortController.signal.aborted) {
      embeddedAgentLog.warn(
        "codex app-server active native turn did not complete before turn/start wait timed out",
        { threadId: thread.threadId },
      );
    }
  }
  try {
    codexModelCallDiagnostics.emitStarted();
    runAgentHarnessLlmInputHook({
      event: buildLlmInputEvent(),
      ctx: hookContext,
      hookRunner,
    });
    turn = await startCodexTurn();
  } catch (error) {
    let turnStartError = error;
    if (isCodexActiveCompactTurnError(turnStartError)) {
      // Codex native compaction returns before its compact turn finishes. If
      // the next OpenClaw turn collides with that compact turn, wait for the
      // terminal notification and retry once instead of surfacing drift.
      embeddedAgentLog.info(
        "codex app-server turn/start blocked by active compact turn; waiting to retry",
        { threadId: thread.threadId },
      );
      const compactTurnCompleted = await waitForActiveNativeTurnCompletion();
      if (compactTurnCompleted && !runAbortController.signal.aborted) {
        void emitCodexAppServerEvent(params, {
          stream: "codex_app_server.lifecycle",
          data: { phase: "turn_start_retry_after_compact", threadId: thread.threadId },
        });
        try {
          turn = await startCodexTurn();
        } catch (retryError) {
          turnStartError = retryError;
        }
      }
    }
    if (
      turn === undefined &&
      thread.connectionScope !== "supervision" &&
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
        const clearedBinding = await bindingStore.mutate(bindingIdentity, {
          kind: "clear",
          threadId: thread.threadId,
        });
        if (!clearedBinding) {
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
            const retryBinding = await bindingStore.read(bindingIdentity);
            if (
              retryBinding &&
              retryBinding.threadId === thread.threadId &&
              retryBinding.contextEngine?.projection
            ) {
              await bindingStore.mutate(bindingIdentity, {
                kind: "patch",
                threadId: retryBinding.threadId,
                patch: {
                  contextEngine: retryBinding.contextEngine
                    ? { ...retryBinding.contextEngine, projection: undefined }
                    : undefined,
                },
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
          void emitCodexAppServerEvent(params, {
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
        errorNotification: latestStartupErrorNotification,
        rateLimitsRevisionBeforeTurnStart: rateLimitsRevisionBeforeLastTurnStart,
        timeoutMs: appServer.requestTimeoutMs,
        signal: runAbortController.signal,
      });
      const turnStartErrorMessage = usageLimitError?.message ?? formatErrorMessage(turnStartError);
      if (isInvalidCodexImagePayloadError(turnStartErrorMessage)) {
        await clearCodexBindingAfterInvalidImagePayload(bindingStore, bindingIdentity, {
          phase: "turn_start",
          threadId: thread.threadId,
          error: turnStartErrorMessage,
        });
      }
      void emitCodexAppServerEvent(params, {
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
          provider: usesSupervisionConnection
            ? (thread.modelProvider ?? effectiveRuntimeProviderId)
            : params.provider,
          model: usesSupervisionConnection
            ? (thread.model ?? effectiveRuntimeModelId)
            : params.modelId,
          ...hookContextWindowFields,
          resolvedRef: usesSupervisionConnection
            ? `${thread.modelProvider ?? effectiveRuntimeProviderId}/${thread.model ?? effectiveRuntimeModelId}`
            : (params.runtimePlan?.observability.resolvedRef ??
              `${params.provider}/${params.modelId}`),
          ...(!usesSupervisionConnection && params.runtimePlan?.observability.harnessId
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
        buildCodexUserPromptMessage({ ...runtimeParams, prompt: codexTurnPromptText }),
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
      releaseCurrentRoute();
      activateNativePreToolUseFailureFallback();
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
      await releaseSharedClientLeaseAndRetireOneShotClient();
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
    activateNativePreToolUseFailureFallback();
    await releaseSharedClientLeaseAndRetireOneShotClient();
    throw new Error("codex app-server turn/start failed without an error");
  }
  turnIdRef.current = turn.turn.id;
  const activeTurnId = turn.turn.id;
  let assistantStreamEventEmitted = false;
  let assistantStreamNeedsTerminalSnapshot = false;
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
  projectorRef.current = new CodexAppServerEventProjector(
    {
      ...dynamicToolParams,
      onAgentEvent: (event) => {
        if (event.stream === "assistant" && typeof event.data.delta === "string") {
          assistantStreamEventEmitted = true;
          assistantStreamNeedsTerminalSnapshot ||= event.data.replaceable === true;
        }
        return dynamicToolParams.onAgentEvent?.(event);
      },
    },
    thread.threadId,
    activeTurnId,
    {
      nativePostToolUseRelayEnabled:
        nativeHookRelay?.allowedEvents.includes("post_tool_use") === true &&
        nativeHookRelay.shouldRelayEvent("post_tool_use"),
      readRecentRateLimits: () => readRecentCodexRateLimits(client),
      runAbortSignal: runAbortController.signal,
      trajectoryRecorder,
      onNativeToolResultRecorded: maybeAnnounceFastModeAutoOff,
      onContextCompacted: () => {
        computerContextEpoch.value += 1;
        delete computerContextEpoch.frameToolCallId;
        delete computerContextEpoch.frameImageIdentity;
      },
    },
  );
  if (isTerminalTurnStatus(turn.turn.status)) {
    terminalTurnNotificationQueued = true;
  }
  emitLifecycleStart();
  const activeProjector = projectorRef.current;
  if (!activeProjector) {
    throw new Error("codex app-server projector was not initialized");
  }
  turnWatches.armTerminalIdleWatch();
  turnWatches.touchActivity("turn:start", { arm: true });
  turnWatches.armAttemptIdleWatch();
  turnWatches.touchActivity("turn:start", { attemptProgress: true });
  for (const failure of pendingNativePreToolUseFailures.splice(0)) {
    activeProjector.recordNativeToolPreToolUseFailure(failure);
  }
  // Codex can emit notifications and requests before turn/start returns. The
  // route buffered them while armed; publish the full turn context first, then
  // release them in wire order.
  if (turnRoute) {
    try {
      await turnRoute.bindTurn(activeTurnId);
    } catch (error) {
      if (!terminalTurnNotificationQueued) {
        throw error;
      }
      await turnRoute.drain();
      if (!completed) {
        turnWatches.clearAllTimers();
        throw error;
      }
    }
  }
  if (!completed && isTerminalTurnStatus(turn.turn.status)) {
    await enqueueNotification(
      {
        method: "turn/completed",
        params: {
          threadId: thread.threadId,
          turnId: activeTurnId,
          turn: turn.turn as unknown as JsonObject,
        },
      },
      { threadId: thread.threadId, turnId: activeTurnId },
    );
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
    runId: params.runId,
    queueMessage: async (text: string, optionsLocal?: CodexSteeringQueueOptions) =>
      activeSteeringQueue.queue(text, optionsLocal),
    isStreaming: () => !completed && !runAbortController.signal.aborted,
    isStopped: () => completed || timedOut || runAbortController.signal.aborted,
    isAbortable: () => !terminalOutcomeFrozen || sharedAbortAllowedAfterTerminalOutcome,
    isCompacting: () => projectorRef.current?.isCompacting() ?? false,
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    cancel: () => abortExplicitly("cancelled"),
    abort: () => abortExplicitly("aborted"),
  };
  params.replyOperation?.attachBackend(handle);
  setActiveEmbeddedRun(params.sessionId, handle, params.sessionKey, params.sessionFile);
  const freezeRunTerminalOutcome = () => {
    if (terminalOutcomeFrozen) {
      return;
    }
    terminalOutcomeFrozen = true;
    params.abortSignal?.removeEventListener("abort", abortFromUpstream);
  };
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
        // Supervised sessions stay native even after a suspect turn. Clearing
        // their private scope would make the next attempt silently agent-home.
        if (thread.connectionScope !== "supervision") {
          await bindingStore.mutate(bindingIdentity, {
            kind: "clear",
            threadId: thread.threadId,
          });
        }
        await retireCodexAppServerClientAfterTimedOutTurn(client, {
          threadId: thread.threadId,
          turnId: activeTurnId,
          reason: String(runAbortController.signal.reason ?? "timeout"),
          suspectPhysicalClient: turnWatchTimeoutKind === "terminal",
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
    await drainNotificationQueue();
    const hasQuiescentCompletedAssistant =
      activeProjector.hasCompletedTerminalAssistantText() &&
      activeAppServerTurnRequests === 0 &&
      activeTurnItemIds.size === 0 &&
      activeCompletionBlockerItemIds.size === 0 &&
      pendingOpenClawDynamicToolCompletionIds.size === 0 &&
      activeFinalizationHookRunIds.size === 0 &&
      unsettledFinalizationHookCount === 0 &&
      rejectedFinalizationHookAssistant === undefined;
    const hasRecoverableCompletedAssistant =
      !turnWatches.isCompletionIdleWatchPinnedByTerminalError() &&
      turnWatches.isAssistantCompletionIdleWatchArmed() &&
      hasQuiescentCompletedAssistant;
    const recoveredTurnWatchTimeout =
      turnCompletionIdleTimedOut &&
      !explicitCancellationObserved &&
      !terminalTurnNotificationQueued &&
      hasRecoverableCompletedAssistant &&
      activeProjector.recoverCompletedTerminalAssistantAfterTurnWatchTimeout();
    if (recoveredTurnWatchTimeout) {
      embeddedAgentLog.warn(
        "codex app-server recovered completed assistant output after missing turn completion",
        {
          threadId: thread.threadId,
          turnId: activeTurnId,
          timeoutKind: turnWatchTimeoutKind,
          idleMs: turnWatchTimeoutIdleMs,
          timeoutMs: turnWatchTimeoutMs,
        },
      );
      trajectoryRecorder?.recordEvent("turn.watch_timeout_recovered", {
        threadId: thread.threadId,
        turnId: activeTurnId,
        timeoutKind: turnWatchTimeoutKind,
        idleMs: turnWatchTimeoutIdleMs,
        timeoutMs: turnWatchTimeoutMs,
      });
    }
    const result = activeProjector.buildResult(toolBridge.telemetry, { yieldDetected });
    const effectiveTimedOut = timedOut && !recoveredTurnWatchTimeout;
    const effectiveTurnCompletionIdleTimedOut =
      turnCompletionIdleTimedOut && !recoveredTurnWatchTimeout;
    const isFinalAborted = () =>
      result.aborted ||
      explicitCancellationObserved ||
      (runAbortController.signal.aborted && !clientClosedAbort && !recoveredTurnWatchTimeout);
    const clientClosedPromptErrorForFinal =
      clientClosedPromptError && hasRecoverableCompletedAssistant
        ? undefined
        : clientClosedPromptError;
    let finalPromptError =
      clientClosedPromptErrorForFinal ??
      (effectiveTurnCompletionIdleTimedOut
        ? turnCompletionIdleTimeoutMessage
        : effectiveTimedOut
          ? "codex app-server attempt timed out"
          : result.promptError);
    const finalPromptErrorMessage =
      typeof finalPromptError === "string"
        ? finalPromptError
        : finalPromptError
          ? formatErrorMessage(finalPromptError)
          : undefined;
    if (isInvalidCodexImagePayloadError(finalPromptErrorMessage)) {
      await clearCodexBindingAfterInvalidImagePayload(bindingStore, bindingIdentity, {
        phase: "turn_completed",
        threadId: thread.threadId,
        turnId: activeTurnId,
        error: finalPromptErrorMessage,
      });
    }
    if (
      thread.connectionScope !== "supervision" &&
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
      await bindingStore.mutate(bindingIdentity, { kind: "clear", threadId: thread.threadId });
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
      effectiveTimedOut || clientClosedPromptErrorForFinal ? "prompt" : result.promptErrorSource;
    const codexAppServerFailureKind = clientClosedPromptErrorForFinal
      ? "client_closed_before_turn_completed"
      : effectiveTurnCompletionIdleTimedOut
        ? "turn_completion_idle_timeout"
        : undefined;
    const codexAppServerReplayBlockedReason = codexAppServerFailureKind
      ? resolveCodexAppServerReplayBlockedReason(result)
      : undefined;
    const promptTimeoutOutcome = buildCodexAppServerPromptTimeoutOutcome({
      result,
      turnCompletionIdleTimedOut: effectiveTurnCompletionIdleTimedOut,
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
    const codexAppServerFailure = codexAppServerFailureKind
      ? ({
          kind: codexAppServerFailureKind,
          ...(codexAppServerFailureKind === "turn_completion_idle_timeout" && turnWatchTimeoutKind
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
        } satisfies NonNullable<EmbeddedRunAttemptResult["codexAppServerFailure"]>)
      : undefined;
    const finalAborted = isFinalAborted();
    const completedTurnStatus = activeProjector.getCompletedTurnStatus();
    const completedWithoutTerminalNotification =
      completed &&
      !terminalTurnNotificationQueued &&
      !timedOut &&
      clientClosedPromptErrorForFinal === undefined;
    const attemptSucceeded =
      !finalAborted &&
      !effectiveTimedOut &&
      (finalPromptError === null || finalPromptError === undefined) &&
      result.agentHarnessResultClassification === undefined &&
      (completedTurnStatus === "completed" ||
        recoveredTurnWatchTimeout ||
        completedWithoutTerminalNotification);
    sharedAbortAllowedAfterTerminalOutcome = shouldKeepCodexSharedAbortOpen({
      trigger: params.trigger,
      result,
      attemptSucceeded,
      explicitCancellationObserved,
    });
    // Terminal diagnostics, transcript mirroring, hooks, and lifecycle events
    // must all observe one immutable attempt outcome. Failed attempts still
    // allow the shared reply operation to cancel retries or model fallback.
    freezeRunTerminalOutcome();
    const modelCallFailureKind =
      classifyCodexModelCallFailureKind({
        error: finalPromptError,
        timedOut: effectiveTimedOut,
        turnCompletionIdleTimedOut: effectiveTurnCompletionIdleTimedOut,
        runAborted: finalAborted,
        abortReason: explicitCancellationReason ?? runAbortController.signal.reason,
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
    const assistantTranscriptOwned = await mirrorTranscriptBestEffort({
      params,
      agentId: sessionAgentId,
      notifyUserMessagePersisted,
      result,
      sessionKey: contextSessionKey,
      cwd: effectiveCwd,
      threadId: thread.threadId,
      turnId: activeTurnId,
    });
    if (activeContextEngine) {
      const activeContextEnginePluginIdLocal =
        resolveContextEngineOwnerPluginId(activeContextEngine);
      // Gateway command runs use a generic `user` trigger, so the bootstrap run
      // kind is the canonical heartbeat lifecycle signal at this boundary.
      const isHeartbeatLifecycleRun =
        params.bootstrapContextRunKind === "heartbeat" ||
        params.bootstrapContextRunKind === "commitment-only";
      const finalMessages =
        (await readMirroredSessionHistoryMessages(activeTranscriptTarget)) ??
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
        tokenBudget: effectiveContextTokenBudget,
        runtimeContext: buildHarnessContextEngineRuntimeContextFromUsage({
          attempt: buildActiveRunAttemptParams(),
          workspaceDir: effectiveWorkspace,
          cwd: effectiveCwd,
          agentDir,
          activeAgentId: sessionAgentId,
          contextEnginePluginId: activeContextEnginePluginIdLocal,
          tokenBudget: effectiveContextTokenBudget,
          lastCallUsage: result.attemptUsage,
          promptCache: result.promptCache,
        }),
        contextEngineHostSupport: CODEX_APP_SERVER_CONTEXT_ENGINE_HOST,
        providerId: usesSupervisionConnection
          ? (thread.modelProvider ?? effectiveRuntimeProviderId)
          : params.provider,
        requestedModelId: usesSupervisionConnection ? undefined : params.requestedModelId,
        modelId: usesSupervisionConnection
          ? (thread.model ?? effectiveRuntimeModelId)
          : params.modelId,
        fallbackReason: usesSupervisionConnection ? undefined : params.fallbackReason,
        degradedReason: usesSupervisionConnection ? undefined : params.degradedReason,
        runMaintenance: runHarnessContextEngineMaintenance,
        config: params.config,
        warn: (message) => embeddedAgentLog.warn(message),
        isHeartbeat: isHeartbeatLifecycleRun,
      });
    }
    runAgentHarnessLlmOutputHook({
      event: {
        runId: params.runId,
        sessionId: params.sessionId,
        provider: usesSupervisionConnection
          ? (thread.modelProvider ?? effectiveRuntimeProviderId)
          : params.provider,
        model: usesSupervisionConnection
          ? (thread.model ?? effectiveRuntimeModelId)
          : params.modelId,
        ...hookContextWindowFields,
        resolvedRef: usesSupervisionConnection
          ? `${thread.modelProvider ?? effectiveRuntimeProviderId}/${thread.model ?? effectiveRuntimeModelId}`
          : (params.runtimePlan?.observability.resolvedRef ??
            `${params.provider}/${params.modelId}`),
        ...(!usesSupervisionConnection && params.runtimePlan?.observability.harnessId
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
    shouldDelayNativeHookRelayUnregister =
      completedTurnStatus === "completed" &&
      !effectiveTimedOut &&
      !runAbortController.signal.aborted &&
      !finalAborted &&
      !finalPromptError;
    if (shouldDelayNativeHookRelayUnregister) {
      try {
        await markCodexAppServerBindingCoveredThroughTurn({
          bindingStore,
          identity: bindingIdentity,
          threadId: thread.threadId,
        });
      } catch (error) {
        if (thread.connectionScope === "supervision") {
          throw error;
        }
        const clearedStaleBinding = await bindingStore.mutate(bindingIdentity, {
          kind: "clear",
          threadId: thread.threadId,
        });
        if (!clearedStaleBinding) {
          throw error;
        }
        embeddedAgentLog.warn(
          "codex app-server binding coverage update failed after completed turn; cleared stale binding",
          {
            threadId: thread.threadId,
            turnId: activeTurnId,
            error,
          },
        );
      }
    }
    recordCodexTrajectoryCompletion(trajectoryRecorder, {
      attempt: params,
      result,
      threadId: thread.threadId,
      turnId: activeTurnId,
      timedOut: effectiveTimedOut,
      yieldDetected,
    });
    trajectoryRecorder?.recordEvent("session.ended", {
      status: finalPromptError
        ? "error"
        : finalAborted || effectiveTimedOut
          ? "interrupted"
          : "success",
      threadId: thread.threadId,
      turnId: activeTurnId,
      timedOut: effectiveTimedOut,
      yieldDetected,
      promptError: normalizeCodexTrajectoryError(finalPromptError),
    });
    markTrajectoryEndRecorded();
    const terminalAssistantText = collectTerminalAssistantText(result);
    if (
      terminalAssistantText &&
      (!assistantStreamEventEmitted || assistantStreamNeedsTerminalSnapshot) &&
      !finalAborted &&
      !finalPromptError
    ) {
      void emitCodexAppServerEvent(params, {
        stream: "assistant",
        data: { text: terminalAssistantText },
      });
    }
    if (finalPromptError) {
      emitLifecycleTerminal({
        phase: "error",
        error: formatErrorMessage(finalPromptError),
        ...buildLifecycleTerminalMeta({ aborted: finalAborted, timedOut: effectiveTimedOut }),
      });
    } else {
      emitLifecycleTerminal({
        phase: "end",
        ...buildLifecycleTerminalMeta({ aborted: finalAborted, timedOut: effectiveTimedOut }),
      });
    }
    return {
      ...result,
      timedOut: effectiveTimedOut,
      aborted: finalAborted,
      promptError: finalPromptError,
      promptErrorSource: finalPromptErrorSource,
      ...(codexAppServerFailure ? { codexAppServerFailure } : {}),
      ...(promptTimeoutOutcome ? { promptTimeoutOutcome } : {}),
      ...(assistantTranscriptOwned ? { assistantTranscriptOwned: true } : {}),
      systemPromptReport,
    };
  } finally {
    if (params.isFinalFallbackAttempt !== false) {
      await maybeEmitFastModeAutoResetBestEffort();
    }
    codexModelCallDiagnostics.emitError(
      "codex app-server run completed without model-call terminal event",
    );
    emitLifecycleTerminal({
      phase: "error",
      error: "codex app-server run completed without lifecycle terminal event",
      ...buildLifecycleTerminalMeta({
        aborted: runAbortController.signal.aborted && !clientClosedAbort,
        timedOut,
      }),
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
    const yieldedOneShotCleanupDeferred =
      !timedOut &&
      params.cleanupBundleMcpOnRunEnd === true &&
      yieldDetected &&
      nativeSubagentMonitorRef.current?.deferUntilParentSettles(thread.threadId, async () => {
        // Keep the parent subscription alive until native child delivery;
        // unsubscribing first drops the completion signal that settles cleanup.
        await unsubscribeCodexThreadBestEffort(client, {
          threadId: thread.threadId,
          timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
        });
        await releaseSharedClientLeaseAndRetireOneShotClient();
      });
    if (!timedOut && !yieldedOneShotCleanupDeferred) {
      await unsubscribeCodexThreadBestEffort(client, {
        threadId: thread.threadId,
        timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
      });
    }
    userInputBridgeRef.current?.cancelPending();
    turnWatches.clearAllTimers();
    releaseCurrentRoute();
    if (!yieldedOneShotCleanupDeferred) {
      await releaseSharedClientLeaseAndRetireOneShotClient();
    }
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
    steeringQueueRef.current?.cancel();
    freezeRunTerminalOutcome();
    params.replyOperation?.detachBackend(handle);
    clearActiveEmbeddedRun(params.sessionId, handle, params.sessionKey, params.sessionFile);
  }
}

function readDynamicToolCallParams(
  value: JsonValue | undefined,
): CodexDynamicToolCallParams | undefined {
  return readCodexDynamicToolCallParams(value);
}

async function clearCodexBindingAfterInvalidImagePayload(
  bindingStore: CodexAppServerBindingStore,
  identity: CodexAppServerBindingIdentity,
  fields: { phase: string; threadId?: string; turnId?: string; error?: string },
): Promise<void> {
  const currentBinding = await bindingStore.read(identity);
  const expectedThreadId = fields.threadId ?? currentBinding?.threadId;
  if (!expectedThreadId) {
    return;
  }
  if (currentBinding && currentBinding.threadId !== expectedThreadId) {
    embeddedAgentLog.warn(
      "codex app-server image payload error detected for unbound thread; preserving thread binding",
      { ...fields, boundThreadId: currentBinding.threadId },
    );
    return;
  }
  if (currentBinding?.connectionScope === "supervision") {
    embeddedAgentLog.warn(
      "codex app-server image payload error detected for supervised thread; preserving native binding",
      fields,
    );
    return;
  }
  embeddedAgentLog.warn(
    "codex app-server image payload error detected; clearing thread binding",
    fields,
  );
  await bindingStore.mutate(identity, { kind: "clear", threadId: expectedThreadId });
}

async function markCodexAppServerBindingCoveredThroughTurn(params: {
  bindingStore: CodexAppServerBindingStore;
  identity: CodexAppServerBindingIdentity;
  threadId: string;
}): Promise<void> {
  await params.bindingStore.mutate(params.identity, {
    kind: "patch",
    threadId: params.threadId,
    patch: { historyCoveredThrough: new Date().toISOString() },
  });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
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

function isCodexActiveCompactTurnError(error: unknown): boolean {
  if (!(error instanceof CodexAppServerRpcError)) {
    return false;
  }
  const data = isJsonObject(error.data) ? error.data : undefined;
  const codexErrorInfo = isJsonObject(data?.codexErrorInfo) ? data.codexErrorInfo : undefined;
  const activeTurn = isJsonObject(codexErrorInfo?.activeTurnNotSteerable)
    ? codexErrorInfo.activeTurnNotSteerable
    : undefined;
  return activeTurn?.turnKind === "compact";
}

function readCodexFinalizationHookNotification(
  notification: CodexServerNotification,
  threadId: string,
  turnId: string,
):
  | { phase: "started"; runId: string }
  | { phase: "completed"; runId: string; status: string | undefined }
  | undefined {
  if (notification.method !== "hook/started" && notification.method !== "hook/completed") {
    return undefined;
  }
  const params = isJsonObject(notification.params) ? notification.params : undefined;
  const run = params && isJsonObject(params.run) ? params.run : undefined;
  // Codex selects exactly one of Stop or SubagentStop from the turn's session
  // source, so these event names share aggregation state but cannot coexist.
  if (
    params?.threadId !== threadId ||
    params.turnId !== turnId ||
    (run?.eventName !== "stop" && run?.eventName !== "subagentStop") ||
    typeof run.id !== "string" ||
    !run.id
  ) {
    return undefined;
  }
  if (notification.method === "hook/started") {
    return { phase: "started", runId: run.id };
  }
  return {
    phase: "completed",
    runId: run.id,
    status: typeof run.status === "string" ? run.status : undefined,
  };
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
  onNativeToolFailureDisposition?: Parameters<
    typeof handleCodexAppServerApprovalRequest
  >[0]["onNativeToolFailureDisposition"];
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
    onNativeToolFailureDisposition: params.onNativeToolFailureDisposition,
  });
}

function resolveCodexDynamicToolDirectNames(params: EmbeddedRunAttemptParams): string[] {
  // Tools with catalogMode=direct-only use the model-only namespace. This list
  // remains for control tools that intentionally live at the dynamic-tool root.
  const names: string[] = [];
  // The ring-zero crestodian tool is the run's entire tool surface; register it
  // directly instead of deferring it behind Codex tool_search discovery. This is
  // structural: per-run configs cannot flip codexDynamicToolsLoading because the
  // harness resolves plugin config from the live global config, not params.config.
  if (params.crestodianTool) {
    names.push("crestodian");
  }
  if (params.sourceReplyDeliveryMode === "message_tool_only") {
    names.push("message");
  }
  return names;
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
  resolveCodexDynamicToolDirectNames,
  createCodexDynamicToolExecutionRegistry,
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
