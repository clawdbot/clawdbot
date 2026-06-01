import fs from "node:fs/promises";
import os from "node:os";
import { MAX_IMAGE_BYTES } from "@openclaw/media-core/constants";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isAcpRuntimeSpawnAvailable } from "../../../acp/runtime/availability.js";
import { buildHierarchyReinforcementMessage } from "../../../auto-reply/handoff-summarizer.js";
import { filterHeartbeatTranscriptArtifacts } from "../../../auto-reply/heartbeat-filter.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { resolveStorePath } from "../../../config/sessions/paths.js";
import {
  loadSessionStore,
  runQuotaSuspensionMaintenance,
  updateSessionStoreEntry,
} from "../../../config/sessions/store.js";
import {
  bindOwnedSessionTranscriptWrites,
  withOwnedSessionTranscriptWrites,
} from "../../../config/sessions/transcript-write-context.js";
import {
  assertContextEngineHostSupport,
  OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
} from "../../../context-engine/host-compat.js";
import { resolveContextEngineOwnerPluginId } from "../../../context-engine/registry.js";
import type { AssembleResult } from "../../../context-engine/types.js";
import { emitTrustedDiagnosticEvent } from "../../../infra/diagnostic-events.js";
import { resolveDiagnosticModelContentCapturePolicy } from "../../../infra/diagnostic-llm-content.js";
import {
  createChildDiagnosticTraceContext,
  createDiagnosticTraceContextFromActiveScope,
  freezeDiagnosticTraceContext,
} from "../../../infra/diagnostic-trace-context.js";
import { isEmbeddedMode } from "../../../infra/embedded-mode.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { resolveHeartbeatSummaryForAgent } from "../../../infra/heartbeat-summary.js";
import { getMachineDisplayName } from "../../../infra/machine-name.js";
import { createCodexNativeWebSearchWrapper } from "../../../llm/providers/stream-wrappers/openai.js";
import type { AssistantMessage } from "../../../llm/types.js";
import { listRegisteredPluginAgentPromptGuidance } from "../../../plugins/command-registry-state.js";
import { getCurrentPluginMetadataSnapshot } from "../../../plugins/current-plugin-metadata-snapshot.js";
import { buildAgentHookContextChannelFields } from "../../../plugins/hook-agent-context.js";
import { resolveBlockMessage } from "../../../plugins/hook-decision-types.js";
import { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import type { PluginMetadataSnapshot } from "../../../plugins/plugin-metadata-snapshot.types.js";
import {
  resolveProviderRuntimePluginHandle,
  type ProviderRuntimePluginHandle,
} from "../../../plugins/provider-hook-runtime.js";
import {
  extractModelCompat,
  resolveToolCallArgumentsEncoding,
} from "../../../plugins/provider-model-compat.js";
import {
  resolveProviderSystemPromptContribution,
  resolveProviderTextTransforms,
  transformProviderSystemPrompt,
} from "../../../plugins/provider-runtime.js";
import { getPluginToolMeta } from "../../../plugins/tools.js";
import { isSubagentSessionKey } from "../../../routing/session-key.js";
import { annotateInterSessionPromptText } from "../../../sessions/input-provenance.js";
import { resolveSkillsPromptForRun } from "../../../skills/loading/workspace.js";
import { resolveEmbeddedRunSkillEntries } from "../../../skills/runtime/embedded-run-entries.js";
import {
  applySkillEnvOverrides,
  applySkillEnvOverridesFromSnapshot,
} from "../../../skills/runtime/env-overrides.js";
import {
  buildTrajectoryArtifacts,
  buildTrajectoryRunMetadata,
} from "../../../trajectory/metadata.js";
import {
  createTrajectoryRuntimeRecorder,
  toTrajectoryToolDefinitions,
} from "../../../trajectory/runtime.js";
import { resolveUserPath } from "../../../utils.js";
import { normalizeMessageChannel } from "../../../utils/message-channel.js";
import { isReasoningTagProvider } from "../../../utils/provider-utils.js";
import { createBundleLspToolRuntime } from "../../agent-bundle-lsp-runtime.js";
import {
  getOrCreateSessionMcpRuntime,
  materializeBundleMcpToolsForRun,
} from "../../agent-bundle-mcp-tools.js";
import { createPreparedEmbeddedAgentSettingsManager } from "../../agent-project-settings.js";
import { resolveAgentDir, resolveSessionAgentIds } from "../../agent-scope.js";
import {
  applyAgentAutoCompactionGuard,
  applyAgentCompactionSettingsFromConfig,
  isSilentOverflowProneModel,
  resolveEffectiveCompactionMode,
} from "../../agent-settings.js";
import {
  createClientToolNameConflictError,
  findClientToolNameConflicts,
  toClientToolDefinitions,
} from "../../agent-tool-definition-adapter.js";
import {
  createOpenClawCodingTools,
  resolveProcessToolScopeKey,
  resolveToolLoopDetectionConfig,
} from "../../agent-tools.js";
import {
  resolveEffectiveToolPolicy,
  resolveGroupToolPolicy,
  resolveInheritedToolPolicyForSession,
  resolveSubagentToolPolicyForSession,
} from "../../agent-tools.policy.js";
import { createAnthropicPayloadLogger } from "../../anthropic-payload-log.js";
import { listActiveProcessSessionReferences } from "../../bash-process-references.js";
import {
  analyzeBootstrapBudget,
  buildBootstrapPromptWarning,
  buildBootstrapPromptWarningNotice,
  buildBootstrapTruncationReportMeta,
  buildBootstrapInjectionStats,
} from "../../bootstrap-budget.js";
import {
  FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE,
  buildBootstrapContextForFiles,
  hasCompletedBootstrapTurn,
  isWorkspaceBootstrapPending,
  makeBootstrapWarn,
  resolveBootstrapFilesForRun,
  resolveContextInjectionMode,
} from "../../bootstrap-files.js";
import { createCacheTrace } from "../../cache-trace.js";
import {
  listChannelSupportedActions,
  resolveChannelMessageToolHints,
  resolveChannelReactionGuidance,
} from "../../channel-tools.js";
import {
  addClientToolsToCodeModeCatalog,
  applyCodeModeCatalog,
  CODE_MODE_EXEC_TOOL_NAME,
  CODE_MODE_WAIT_TOOL_NAME,
  createCodeModeTools,
  resolveCodeModeConfig,
} from "../../code-mode.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../defaults.js";
import { resolveOpenClawReferencePaths } from "../../docs-path.js";
import {
  isCloudCodeAssistFormatError,
  resolveBootstrapMaxChars,
  resolveBootstrapPromptTruncationWarningMode,
  resolveBootstrapTotalMaxChars,
} from "../../embedded-agent-helpers.js";
import { countActiveToolExecutions } from "../../embedded-agent-subscribe.handlers.tools.js";
import { subscribeEmbeddedAgentSession } from "../../embedded-agent-subscribe.js";
import { isTimeoutError } from "../../failover-error.js";
import { runAgentEndSideEffects } from "../../harness/agent-end-side-effects.js";
import { resolveHeartbeatPromptForSystemPrompt } from "../../heartbeat-system-prompt.js";
import { resolveImageSanitizationLimits } from "../../image-sanitization.js";
import {
  filterLocalModelLeanTools,
  isLocalModelLeanEnabled,
  resolveLocalModelLeanPreserveToolNames,
} from "../../local-model-lean.js";
import { resolveModelAuthMode } from "../../model-auth.js";
import { resolveDefaultModelForAgent } from "../../model-selection.js";
import { supportsModelTools } from "../../model-tool-support.js";
import { wrapStreamFnTextTransforms } from "../../plugin-text-transforms.js";
import { resolveAgentPromptSurfaceForSessionKey } from "../../prompt-surface.js";
import { describeProviderRequestRoutingSummary } from "../../provider-attribution.js";
import { registerProviderStreamForModel } from "../../provider-stream.js";
import { collectRuntimeChannelCapabilities } from "../../runtime-capabilities.js";
import {
  logAgentRuntimeToolDiagnostics,
  normalizeAgentRuntimeTools,
} from "../../runtime-plan/tools.js";
import type { AgentMessage } from "../../runtime/index.js";
import { resolveSandboxContext } from "../../sandbox.js";
import { resolveSandboxRuntimeStatus } from "../../sandbox/runtime-status.js";
import { repairSessionFileIfNeeded } from "../../session-file-repair.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import { sanitizeToolUseResultPairing } from "../../session-transcript-repair.js";
import { acquireSessionWriteLock } from "../../session-write-lock.js";
import { createAgentSession, SessionManager } from "../../sessions/index.js";
import { detectRuntimeShell } from "../../shell-utils.js";
import { buildActiveSubagentSystemPromptAddition } from "../../subagent-active-context.js";
import {
  isSubagentEnvelopeSession,
  resolveSubagentCapabilityStore,
} from "../../subagent-capabilities.js";
import {
  ackPendingAgentSteeringItems,
  leasePendingAgentSteeringItems,
  prependAgentSteeringPrompt,
  releasePendingAgentSteeringItems,
} from "../../subagent-registry.js";
import { ensureSystemPromptCacheBoundary } from "../../system-prompt-cache-boundary.js";
import { buildSystemPromptParams } from "../../system-prompt-params.js";
import { buildSystemPromptReport } from "../../system-prompt-report.js";
import {
  appendModelIdentitySystemPrompt,
  buildModelIdentityPromptLine,
} from "../../system-prompt.js";
import { resolveAgentTimeoutMs } from "../../timeout.js";
import {
  buildEmptyExplicitToolAllowlistError,
  collectExplicitToolAllowlistSources,
} from "../../tool-allowlist-guard.js";
import { filterRuntimeCompatibleTools } from "../../tool-schema-projection.js";
import { logRuntimeToolSchemaQuarantine } from "../../tool-schema-quarantine.js";
import {
  addClientToolsToToolSearchCatalog,
  applyToolSearchCatalog,
  clearToolSearchCatalog,
  createToolSearchCatalogRef,
  projectToolSearchTargetTranscriptMessages,
  resolveToolSearchConfig,
  type ToolSearchCatalogRef,
  type ToolSearchCatalogToolExecutor,
  type ToolSearchTargetTranscriptProjection,
} from "../../tool-search.js";
import { shouldAllowProviderOwnedThinkingReplay } from "../../transcript-policy.js";
import { normalizeUsage, type NormalizedUsage } from "../../usage.js";
import { DEFAULT_BOOTSTRAP_FILENAME, type WorkspaceBootstrapFile } from "../../workspace.js";
import { isRunnerAbortError } from "../abort.js";
import { isCacheTtlEligibleProvider, readLastCacheTtlTimestamp } from "../cache-ttl.js";
import { resolveCompactionTimeoutMs } from "../compaction-safety-timeout.js";
import { runContextEngineMaintenance } from "../context-engine-maintenance.js";
import { applyFinalEffectiveToolPolicy } from "../effective-tool-policy.js";
import { buildEmbeddedExtensionFactories } from "../extensions.js";
import {
  applyExtraParamsToAgent,
  resolveAgentTransportOverride,
  resolveExplicitSettingsTransport,
  resolveExtraParams,
  resolvePreparedExtraParams,
} from "../extra-params.js";
import { prepareGooglePromptCacheStreamFn } from "../google-prompt-cache.js";
import { getHistoryLimitFromSessionKey, limitHistoryTurns } from "../history.js";
import { log } from "../logger.js";
import { buildEmbeddedMessageActionDiscoveryInput } from "../message-action-discovery-input.js";
import {
  collectPromptCacheToolNames,
  beginPromptCacheObservation,
  completePromptCacheObservation,
  type PromptCacheBreak,
  type PromptCacheChange,
} from "../prompt-cache-observability.js";
import { resolveCacheRetention } from "../prompt-cache-retention.js";
import {
  normalizeAssistantReplayContent,
  sanitizeSessionHistory,
  validateReplayTurns,
} from "../replay-history.js";
import { observeReplayMetadata, replayMetadataFromState } from "../replay-state.js";
import { createEmbeddedAgentResourceLoader } from "../resource-loader.js";
import {
  clearActiveEmbeddedRun,
  type EmbeddedAgentQueueHandle,
  markActiveEmbeddedRunAbandoned,
  setActiveEmbeddedRun,
  updateActiveEmbeddedRunSessionFile,
  updateActiveEmbeddedRunSnapshot,
} from "../runs.js";
import { buildEmbeddedSandboxInfo, resolveEmbeddedSandboxInfoExecPolicy } from "../sandbox-info.js";
import { prewarmSessionFile, trackSessionManagerAccess } from "../session-manager-cache.js";
import { prepareSessionManagerForRun } from "../session-manager-init.js";
import {
  describeEmbeddedAgentStreamStrategy,
  resetEmbeddedAgentBaseStreamFnCacheForTest,
  resolveEmbeddedAgentApiKey,
  resolveEmbeddedAgentBaseStreamFn,
  resolveEmbeddedAgentStreamFn,
} from "../stream-resolution.js";
import { applySystemPromptToSession } from "../system-prompt.js";
import {
  dropReasoningFromHistory,
  dropThinkingBlocks,
  wrapAnthropicStreamWithRecovery,
} from "../thinking.js";
import {
  collectCoreBuiltinToolNames,
  collectRegisteredToolNames,
  AGENT_RESERVED_TOOL_NAMES,
  toSessionToolAllowlist,
} from "../tool-name-allowlist.js";
import {
  installContextEngineLoopHook,
  installToolResultContextGuard,
} from "../tool-result-context-guard.js";
import {
  resolveLiveToolResultMaxChars,
  truncateOversizedToolResultsInMessages,
  truncateOversizedToolResultsInSessionManager,
} from "../tool-result-truncation.js";
import { splitSdkTools } from "../tool-split.js";
import { mapThinkingLevel } from "../utils.js";
import { flushPendingToolResultsAfterIdle } from "../wait-for-idle-before-flush.js";
import { abortable as abortableWithSignal } from "./abortable.js";
import { createEmbeddedAgentSessionWithResourceLoader } from "./attempt-session.js";
import {
  applyEmbeddedAttemptToolsAllow,
  mergeForcedEmbeddedAttemptToolsAllow,
  resolveEmbeddedAttemptToolConstructionPlan,
  shouldCreateBundleLspRuntimeForAttempt,
  shouldCreateBundleMcpRuntimeForAttempt,
} from "./attempt-tool-construction-plan.js";
import {
  resolveAttemptTrajectoryTerminal,
  resolveTerminalAssistantTexts,
} from "./attempt-trajectory-status.js";
import {
  requiresCompletionRequiredAsyncTaskWait,
  waitForCompletionRequiredAsyncTasks,
  type AsyncStartedToolMeta,
  type CompletionRequiredAsyncTaskWaitResult,
} from "./attempt.async-tasks.js";
import {
  isPrimaryBootstrapRun,
  remapInjectedContextFilesToWorkspace,
} from "./attempt.bootstrap-context.js";
export { buildContextEnginePromptCacheInfo } from "./attempt.context-engine-helpers.js";
import {
  rotateTranscriptAfterCompaction,
  shouldRotateCompactionTranscript,
} from "../compaction-successor-transcript.js";
import { releaseEmbeddedAttemptSessionLockForAbort } from "./attempt-abort.js";
import { resolveAttemptWorkspaceBootstrapRouting } from "./attempt-bootstrap-routing.js";
import { configureEmbeddedAttemptHttpRuntime } from "./attempt-http-runtime.js";
import {
  createEmbeddedRunStageTracker,
  formatEmbeddedRunStageSummary,
  shouldWarnEmbeddedRunStageSummary,
} from "./attempt-stage-timing.js";
import { buildAttemptSystemPrompt } from "./attempt-system-prompt.js";
import { flushEmbeddedAttemptTrajectoryRecorder } from "./attempt-trajectory-flush-cleanup.js";
import {
  assembleAttemptContextEngine,
  buildLoopPromptCacheInfo,
  buildContextEnginePromptCacheInfo,
  findCurrentAttemptAssistantMessage,
  finalizeAttemptContextEngineTurn,
  resolvePromptCacheTouchTimestamp,
  resolveAttemptBootstrapContext,
  runAttemptContextEngineBootstrap,
} from "./attempt.context-engine-helpers.js";
import {
  installModelPromptTransform,
  installRuntimeContextMessageForPrompt,
  normalizeMessagesForCurrentPromptBoundary,
  normalizeMessagesForLlmBoundary,
} from "./attempt.llm-boundary.js";
import {
  diagnosticErrorCategory,
  wrapStreamFnWithDiagnosticModelCallEvents,
} from "./attempt.model-diagnostic-events.js";
import {
  buildAfterTurnRuntimeContext,
  buildAfterTurnRuntimeContextFromUsage,
  prependSystemPromptAddition,
  resolveAttemptFsWorkspaceOnly,
  resolveAttemptMediaTaskSystemPromptAddition,
  resolvePromptBuildHookResult,
  resolvePromptModeForSession,
  resolvePromptSubmissionSkipReason,
  shouldWarnOnOrphanedUserRepair,
  shouldInjectHeartbeatPrompt,
} from "./attempt.prompt-helpers.js";
import { steerActiveSessionWithOptionalDeliveryWait } from "./attempt.queue-message.js";
import {
  resolveAttemptStreamAuthProfileId,
  resolveAttemptToolPolicyMessageProvider,
  resolveEmbeddedAttemptSessionWriteLockOptions,
  resolveUnknownToolGuardThreshold,
  shouldRunLlmOutputHooksForAttempt,
} from "./attempt.run-decisions.js";
import {
  acquireEmbeddedAttemptSessionFileOwner,
  EmbeddedAttemptSessionTakeoverError,
  type EmbeddedAttemptSessionFileOwner,
  createEmbeddedAttemptSessionLockController,
  installPromptSubmissionLockRelease,
} from "./attempt.session-lock.js";
import {
  createYieldAbortedResponse,
  persistSessionsYieldContextMessage,
  queueSessionsYieldInterruptMessage,
  stripSessionsYieldArtifacts,
  waitForSessionsYieldAbortSettle,
} from "./attempt.sessions-yield.js";
import { wrapStreamFnHandleSensitiveStopReason } from "./attempt.stop-reason-recovery.js";
import {
  buildEmbeddedSubscriptionParams,
  cleanupEmbeddedAttemptResources,
} from "./attempt.subscription-cleanup.js";
import {
  appendAttemptCacheTtlIfNeeded,
  composeSystemPromptWithHookContext,
  resolveAttemptSpawnWorkspaceDir,
  shouldPersistCompletedBootstrapTurn,
} from "./attempt.thread-helpers.js";
import {
  shouldRepairMalformedToolCallArguments,
  wrapStreamFnDecodeXaiToolCallArguments,
  wrapStreamFnRepairMalformedToolCallArguments,
} from "./attempt.tool-call-argument-repair.js";
import {
  sanitizeOpenAIResponsesReplayForStream,
  sanitizeReplayToolCallIdsForStream,
  shouldApplyReplayToolCallIdSanitizer,
  wrapStreamFnPromoteStandaloneTextToolCalls,
  wrapStreamFnSanitizeMalformedToolCalls,
  wrapStreamFnTrimToolCallNames,
} from "./attempt.tool-call-normalization.js";
import { buildEmbeddedAttemptToolRunContext } from "./attempt.tool-run-context.js";
import {
  buildToolSearchRunPlan,
  TOOL_SEARCH_CONTROL_ALLOWLIST_NAMES,
} from "./attempt.tool-search-run-plan.js";
import { resolveAttemptTranscriptPolicy } from "./attempt.transcript-policy.js";
import { waitForCompactionRetryWithAggregateTimeout } from "./compaction-retry-aggregate-timeout.js";
import {
  resolveRunTimeoutDuringCompaction,
  selectCompactionTimeoutSnapshot,
  shouldFlagCompactionTimeout,
} from "./compaction-timeout.js";
import { resolveFinalAssistantVisibleText } from "./helpers.js";
import {
  installHistoryImagePruneContextTransform,
  pruneProcessedHistoryImages,
} from "./history-image-prune.js";
import { detectAndLoadPromptImages } from "./images.js";
import {
  buildAttemptReplayMetadata,
  resolveSilentToolResultReplyPayload,
  shouldTreatEmptyAssistantReplyAsSilent,
} from "./incomplete-turn.js";
import { resolveLlmIdleTimeoutMs, streamWithIdleTimeout } from "./llm-idle-timeout.js";
import { resolveMessageMergeStrategy } from "./message-merge-strategy.js";
import { installMessageToolOnlyTerminalHook } from "./message-tool-terminal.js";
import { wrapStreamFnWithMessageTransform } from "./message-transform-stream-wrapper.js";
import {
  MID_TURN_PRECHECK_ERROR_MESSAGE,
  isMidTurnPrecheckSignal,
  type MidTurnPrecheckRequest,
} from "./midturn-precheck.js";
import {
  PREEMPTIVE_OVERFLOW_ERROR_TEXT,
  buildPrePromptContextBudgetStatus,
  formatPrePromptPrecheckLog,
  shouldPreemptivelyCompactBeforePrompt,
} from "./preemptive-compaction.js";
import {
  buildCurrentInboundPrompt,
  buildRuntimeContextCustomMessage,
  resolveRuntimeContextPromptParts,
} from "./runtime-context-prompt.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./types.js";

export {
  appendAttemptCacheTtlIfNeeded,
  composeSystemPromptWithHookContext,
  resolveAttemptSpawnWorkspaceDir,
} from "./attempt.thread-helpers.js";
export {
  buildAfterTurnRuntimeContext,
  buildAfterTurnRuntimeContextFromUsage,
  mergeOrphanedTrailingUserPrompt,
  prependSystemPromptAddition,
  resolveAttemptFsWorkspaceOnly,
  resolveAttemptMediaTaskSystemPromptAddition,
  resolvePromptBuildHookResult,
  resolvePromptModeForSession,
  shouldWarnOnOrphanedUserRepair,
  shouldInjectHeartbeatPrompt,
} from "./attempt.prompt-helpers.js";
export {
  persistSessionsYieldContextMessage,
  queueSessionsYieldInterruptMessage,
  stripSessionsYieldArtifacts,
} from "./attempt.sessions-yield.js";
export {
  decodeHtmlEntitiesInObject,
  wrapStreamFnRepairMalformedToolCallArguments,
} from "./attempt.tool-call-argument-repair.js";
export {
  wrapStreamFnPromoteStandaloneTextToolCalls,
  wrapStreamFnSanitizeMalformedToolCalls,
  wrapStreamFnTrimToolCallNames,
} from "./attempt.tool-call-normalization.js";
export {
  resetEmbeddedAgentBaseStreamFnCacheForTest,
  resolveEmbeddedAgentBaseStreamFn,
  resolveEmbeddedAgentStreamFn,
};

const MAX_BTW_SNAPSHOT_MESSAGES = 100;
const PROMPT_TOOL_RESULT_AGGREGATE_CAP_MULTIPLIER = 4;

function pluginMetadataSnapshotCoversProvider(
  snapshot: PluginMetadataSnapshot | undefined,
  provider: string,
): snapshot is PluginMetadataSnapshot {
  const normalizedProvider = normalizeProviderId(provider);
  if (!snapshot || !normalizedProvider) {
    return false;
  }
  return snapshot.manifestRegistry.plugins.some((plugin) => {
    const ownsProvider = plugin.providers.some(
      (providerId) => normalizeProviderId(providerId) === normalizedProvider,
    );
    if (ownsProvider) {
      return true;
    }
    const modelCatalogProviderIds = [
      ...Object.keys(plugin.modelCatalog?.providers ?? {}),
      ...Object.keys(plugin.modelCatalog?.aliases ?? {}),
    ];
    return modelCatalogProviderIds.some(
      (providerId) => normalizeProviderId(providerId) === normalizedProvider,
    );
  });
}

function summarizeMessagePayload(msg: AgentMessage): { textChars: number; imageBlocks: number } {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") {
    return { textChars: content.length, imageBlocks: 0 };
  }
  if (!Array.isArray(content)) {
    return { textChars: 0, imageBlocks: 0 };
  }

  let textChars = 0;
  let imageBlocks = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as { type?: unknown; text?: unknown };
    if (typedBlock.type === "image") {
      imageBlocks++;
      continue;
    }
    if (typeof typedBlock.text === "string") {
      textChars += typedBlock.text.length;
    }
  }

  return { textChars, imageBlocks };
}

function summarizeSessionContext(messages: AgentMessage[]): {
  roleCounts: string;
  totalTextChars: number;
  totalImageBlocks: number;
  maxMessageTextChars: number;
} {
  const roleCounts = new Map<string, number>();
  let totalTextChars = 0;
  let totalImageBlocks = 0;
  let maxMessageTextChars = 0;

  for (const msg of messages) {
    const role = typeof msg.role === "string" ? msg.role : "unknown";
    roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);

    const payload = summarizeMessagePayload(msg);
    totalTextChars += payload.textChars;
    totalImageBlocks += payload.imageBlocks;
    if (payload.textChars > maxMessageTextChars) {
      maxMessageTextChars = payload.textChars;
    }
  }

  return {
    roleCounts:
      [...roleCounts.entries()]
        .toSorted((a, b) => a[0].localeCompare(b[0]))
        .map(([role, count]) => `${role}:${count}`)
        .join(",") || "none",
    totalTextChars,
    totalImageBlocks,
    maxMessageTextChars,
  };
}

function cloneHookMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message) => structuredClone(message));
}

function sessionMessagesContainIdempotencyKey(
  messages: AgentMessage[],
  idempotencyKey: string,
): boolean {
  return messages.some(
    (message) =>
      typeof (message as { idempotencyKey?: unknown }).idempotencyKey === "string" &&
      (message as { idempotencyKey?: unknown }).idempotencyKey === idempotencyKey,
  );
}

function flushSessionManagerFile(sessionManager: ReturnType<typeof guardSessionManager>): void {
  (sessionManager as unknown as { rewriteFile?: () => void }).rewriteFile?.();
}

function shouldPreservePromptErrorAfterCleanupError(params: {
  promptError: unknown;
  cleanupError: unknown;
}): boolean {
  return (
    Boolean(params.promptError) &&
    params.cleanupError instanceof EmbeddedAttemptSessionTakeoverError
  );
}

class EmbeddedAttemptPromptErrorWithCleanupTakeoverError extends Error {
  readonly promptError: unknown;
  readonly cleanupError: EmbeddedAttemptSessionTakeoverError;

  constructor(params: { promptError: unknown; cleanupError: EmbeddedAttemptSessionTakeoverError }) {
    super(formatErrorMessage(params.promptError), { cause: params.cleanupError });
    this.name = "EmbeddedAttemptSessionTakeoverError";
    this.promptError = params.promptError;
    this.cleanupError = params.cleanupError;
  }
}

function hasVisiblePendingToolMediaReply(
  reply: { mediaUrls?: string[]; audioAsVoice?: boolean } | null | undefined,
): boolean {
  return Boolean(
    reply &&
    ((reply.mediaUrls ?? []).some((url) => url.trim().length > 0) || reply.audioAsVoice === true),
  );
}

function isMidTurnPrecheckAssistantError(message: AgentMessage | undefined): boolean {
  if (!message || message.role !== "assistant") {
    return false;
  }
  const record = message as unknown as { stopReason?: unknown; errorMessage?: unknown };
  return record.stopReason === "error" && record.errorMessage === MID_TURN_PRECHECK_ERROR_MESSAGE;
}

function removeTrailingMidTurnPrecheckAssistantError(params: {
  activeSession: { agent: { state: { messages: AgentMessage[] } } };
  sessionManager: ReturnType<typeof guardSessionManager>;
}): void {
  const messages = params.activeSession.agent.state.messages;
  if (isMidTurnPrecheckAssistantError(messages.at(-1))) {
    params.activeSession.agent.state.messages = messages.slice(0, -1);
  }

  const mutableSessionManager = params.sessionManager as unknown as {
    fileEntries?: Array<{
      type?: string;
      id?: string;
      parentId?: string | null;
      message?: AgentMessage;
    }>;
    byId?: Map<string, unknown>;
    leafId?: string | null;
    rewriteFile?: () => void;
  };
  const lastEntry = mutableSessionManager.fileEntries?.at(-1);
  if (lastEntry?.type !== "message" || !isMidTurnPrecheckAssistantError(lastEntry.message)) {
    if (isMidTurnPrecheckAssistantError(params.activeSession.agent.state.messages.at(-1))) {
      log.warn(
        "[context-overflow-midturn-precheck] removed synthetic assistant error from active session but could not locate matching persisted SessionManager entry",
      );
    }
    return;
  }
  if (typeof mutableSessionManager.rewriteFile !== "function") {
    log.warn(
      "[context-overflow-midturn-precheck] removed synthetic assistant error from active session but SessionManager rewrite hook is unavailable",
    );
    return;
  }
  mutableSessionManager.fileEntries?.pop();
  if (lastEntry.id) {
    mutableSessionManager.byId?.delete(lastEntry.id);
  }
  mutableSessionManager.leafId = lastEntry.parentId ?? null;
  mutableSessionManager.rewriteFile();
}

function collectAttemptExplicitToolAllowlistSources(params: {
  config?: EmbeddedRunAttemptParams["config"];
  sessionKey?: string;
  sandboxSessionKey?: string;
  agentId?: string;
  modelProvider?: string;
  modelId?: string;
  messageProvider?: string;
  agentAccountId?: string | null;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  spawnedBy?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
  sandboxToolPolicy?: { allow?: string[]; deny?: string[] };
  toolsAllow?: string[];
}) {
  const { agentId, globalPolicy, globalProviderPolicy, agentPolicy, agentProviderPolicy } =
    resolveEffectiveToolPolicy({
      config: params.config,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      modelProvider: params.modelProvider,
      modelId: params.modelId,
    });
  const groupPolicy = resolveGroupToolPolicy({
    config: params.config,
    sessionKey: params.sessionKey,
    spawnedBy: params.spawnedBy,
    messageProvider: params.messageProvider,
    groupId: params.groupId,
    groupChannel: params.groupChannel,
    groupSpace: params.groupSpace,
    accountId: params.agentAccountId,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
  });
  const subagentStore = resolveSubagentCapabilityStore(params.sandboxSessionKey, {
    cfg: params.config,
  });
  const subagentPolicy =
    params.sandboxSessionKey &&
    isSubagentEnvelopeSession(params.sandboxSessionKey, {
      cfg: params.config,
      store: subagentStore,
    })
      ? resolveSubagentToolPolicyForSession(params.config, params.sandboxSessionKey, {
          store: subagentStore,
        })
      : undefined;
  const inheritedToolPolicy = resolveInheritedToolPolicyForSession(
    params.config,
    params.sandboxSessionKey,
    {
      store: subagentStore,
    },
  );
  return collectExplicitToolAllowlistSources([
    { label: "tools.allow", allow: globalPolicy?.allow },
    { label: "tools.byProvider.allow", allow: globalProviderPolicy?.allow },
    {
      label: agentId ? `agents.${agentId}.tools.allow` : "agent tools.allow",
      allow: agentPolicy?.allow,
    },
    {
      label: agentId ? `agents.${agentId}.tools.byProvider.allow` : "agent tools.byProvider.allow",
      allow: agentProviderPolicy?.allow,
    },
    { label: "group tools.allow", allow: groupPolicy?.allow },
    { label: "sandbox tools.allow", allow: params.sandboxToolPolicy?.allow },
    { label: "subagent tools.allow", allow: subagentPolicy?.allow },
    { label: "inherited tools.allow", allow: inheritedToolPolicy?.allow },
    { label: "runtime toolsAllow", allow: params.toolsAllow, enforceWhenToolsDisabled: true },
  ]);
}

export async function runEmbeddedAttempt(
  params: EmbeddedRunAttemptParams,
): Promise<EmbeddedRunAttemptResult> {
  const resolvedWorkspace = resolveUserPath(params.workspaceDir);
  const runAbortController = new AbortController();
  configureEmbeddedAttemptHttpRuntime({ timeoutMs: params.timeoutMs });

  log.debug(
    `embedded run start: runId=${params.runId} sessionId=${params.sessionId} provider=${params.provider} model=${params.modelId} thinking=${params.thinkLevel} messageChannel=${params.messageChannel ?? params.messageProvider ?? "unknown"}`,
  );
  const prepStages = createEmbeddedRunStageTracker();
  const emitPrepStageSummary = (phase: string) => {
    const summary = prepStages.snapshot();
    const shouldWarn = shouldWarnEmbeddedRunStageSummary(summary);
    if (!shouldWarn && !log.isEnabled("trace")) {
      return;
    }
    const message = formatEmbeddedRunStageSummary(
      `[trace:embedded-run] prep stages: runId=${params.runId} sessionId=${params.sessionId} phase=${phase}`,
      summary,
    );
    if (shouldWarn) {
      log.warn(message);
    } else {
      log.trace(message);
    }
  };
  const emitCorePluginToolStageSummary = (
    phase: string,
    summary: ReturnType<typeof prepStages.snapshot>,
  ) => {
    if (summary.stages.length === 0) {
      return;
    }
    const shouldWarn = shouldWarnEmbeddedRunStageSummary(summary, {
      totalThresholdMs: 5_000,
      stageThresholdMs: 2_000,
    });
    if (!shouldWarn && !log.isEnabled("trace")) {
      return;
    }
    const message = formatEmbeddedRunStageSummary(
      `[trace:embedded-run] core-plugin-tool stages: runId=${params.runId} sessionId=${params.sessionId} phase=${phase}`,
      summary,
    );
    if (shouldWarn) {
      log.warn(message);
    } else {
      log.trace(message);
    }
  };

  await fs.mkdir(resolvedWorkspace, { recursive: true });

  const sandboxSessionKey =
    params.sandboxSessionKey?.trim() || params.sessionKey?.trim() || params.sessionId;
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
  const requestedCwd = params.cwd ? resolveUserPath(params.cwd) : undefined;
  if (sandbox?.enabled && requestedCwd && requestedCwd !== resolvedWorkspace) {
    throw new Error(
      "cwd override is not supported for sandboxed embedded agent runs; omit cwd or use the agent workspace as cwd",
    );
  }
  const effectiveCwd = sandbox?.enabled ? effectiveWorkspace : (requestedCwd ?? effectiveWorkspace);
  await fs.mkdir(effectiveWorkspace, { recursive: true });
  let currentPluginMetadataSnapshotResolved = false;
  let currentPluginMetadataSnapshot: PluginMetadataSnapshot | undefined;
  const getCurrentAttemptPluginMetadataSnapshot = () => {
    if (!currentPluginMetadataSnapshotResolved) {
      currentPluginMetadataSnapshot = getCurrentPluginMetadataSnapshot({
        allowScopedSnapshot: true,
        config: params.config,
        env: process.env,
        workspaceDir: effectiveWorkspace,
      });
      currentPluginMetadataSnapshotResolved = true;
    }
    return currentPluginMetadataSnapshot;
  };
  let providerRuntimeHandle: ProviderRuntimePluginHandle | undefined;
  const getProviderRuntimeHandle = () => {
    if (providerRuntimeHandle?.plugin) {
      return providerRuntimeHandle;
    }
    const pluginMetadataSnapshot = getCurrentAttemptPluginMetadataSnapshot();
    const resolvedHandle = resolveProviderRuntimePluginHandle({
      provider: params.provider,
      modelId: params.modelId,
      config: params.config,
      workspaceDir: effectiveWorkspace,
      env: process.env,
      ...(pluginMetadataSnapshotCoversProvider(pluginMetadataSnapshot, params.provider)
        ? { pluginMetadataSnapshot }
        : {}),
    });
    if (resolvedHandle.plugin) {
      providerRuntimeHandle = resolvedHandle;
    }
    return resolvedHandle;
  };
  const { sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
    agentId: params.agentId,
  });
  const effectiveFsWorkspaceOnly = resolveAttemptFsWorkspaceOnly({
    config: params.config,
    sessionAgentId,
  });
  prepStages.mark("workspace-sandbox");

  let restoreSkillEnv: (() => void) | undefined;
  let aborted = Boolean(params.abortSignal?.aborted);
  let externalAbort = false;
  let timedOut = false;
  let idleTimedOut = false;
  let timedOutDuringCompaction = false;
  let timedOutDuringToolExecution = false;
  let promptError: unknown = null;
  let emitDiagnosticRunCompleted:
    | ((
        outcome: "completed" | "aborted" | "blocked" | "error",
        err?: unknown,
        extra?: { blockedBy?: string },
      ) => void)
    | undefined;
  let beforeAgentRunBlocked = false;
  let beforeAgentRunBlockedBy: string | undefined;
  // Releases the eager session lock if post-prompt code exits before cleanup.
  let releaseRetainedSessionLock: (() => Promise<void>) | undefined;
  let retainedSessionFileOwner: EmbeddedAttemptSessionFileOwner | undefined;
  let bundleMcpRuntime: Awaited<ReturnType<typeof materializeBundleMcpToolsForRun>> | undefined;
  let bundleLspRuntime: Awaited<ReturnType<typeof createBundleLspToolRuntime>> | undefined;
  let toolSearchCatalogRef: ToolSearchCatalogRef | undefined;
  let toolSearchCatalogApplied = false;
  const sessionCleanupOwnsEmbeddedResources = false;
  let abortActiveSessionForExternalSignal: (() => Promise<void>) | undefined;
  let abortRunForExternalSignal: ((isTimeout?: boolean, reason?: unknown) => void) | undefined;
  let isCompactionPendingForExternalSignal: (() => boolean) | undefined;
  let isCompactionInFlightForExternalSignal: (() => boolean) | undefined;
  let removeExternalAbortSignalListener: (() => void) | undefined;
  const createAttemptAbortError = (signal: AbortSignal): Error => {
    if (signal.reason instanceof Error) {
      return signal.reason;
    }
    const err = new Error("request aborted", { cause: signal.reason });
    err.name = "AbortError";
    return err;
  };
  const getAbortReason = (signal: AbortSignal): unknown =>
    "reason" in signal ? (signal as { reason?: unknown }).reason : undefined;
  const makeTimeoutAbortReason = (): Error => {
    const err = new Error("request timed out");
    err.name = "TimeoutError";
    return err;
  };
  const cleanupEmbeddedPrepResourcesAfterEarlyExit = async () => {
    if (toolSearchCatalogApplied) {
      clearToolSearchCatalog({
        sessionId: params.sessionId,
        sessionKey: sandboxSessionKey,
        agentId: sessionAgentId,
        runId: params.runId,
        catalogRef: toolSearchCatalogRef,
      });
      toolSearchCatalogApplied = false;
    }
    try {
      await bundleMcpRuntime?.dispose();
    } catch {
      /* best-effort */
    } finally {
      bundleMcpRuntime = undefined;
    }
    try {
      await bundleLspRuntime?.dispose();
    } catch {
      /* best-effort */
    } finally {
      bundleLspRuntime = undefined;
    }
  };
  const onExternalAbortSignal = () => {
    const signal = params.abortSignal;
    if (!signal) {
      return;
    }
    externalAbort = true;
    const reason = getAbortReason(signal);
    const timeout = reason ? isTimeoutError(reason) : false;
    if (
      shouldFlagCompactionTimeout({
        isTimeout: timeout,
        isCompactionPendingOrRetrying: isCompactionPendingForExternalSignal?.() ?? false,
        isCompactionInFlight: isCompactionInFlightForExternalSignal?.() ?? false,
      })
    ) {
      timedOutDuringCompaction = true;
    }
    if (abortRunForExternalSignal) {
      abortRunForExternalSignal(timeout, reason);
      return;
    }
    aborted = true;
    if (timeout) {
      timedOut = true;
      if (!timedOutDuringCompaction && countActiveToolExecutions(params.runId) > 0) {
        timedOutDuringToolExecution = true;
      }
    }
    promptError = createAttemptAbortError(signal);
    if (!runAbortController.signal.aborted) {
      runAbortController.abort(timeout ? (reason ?? makeTimeoutAbortReason()) : reason);
    }
    void abortActiveSessionForExternalSignal?.();
  };
  const armExternalAbortSignal = () => {
    const signal = params.abortSignal;
    if (!signal || removeExternalAbortSignalListener) {
      return;
    }
    if (signal.aborted) {
      onExternalAbortSignal();
      return;
    }
    signal.addEventListener("abort", onExternalAbortSignal, { once: true });
    removeExternalAbortSignalListener = () => {
      signal.removeEventListener("abort", onExternalAbortSignal);
      removeExternalAbortSignalListener = undefined;
    };
  };
  const throwIfAttemptAbortSignalFiredAfterPrepCleanup = async () => {
    if (params.abortSignal?.aborted === true) {
      const abortError = createAttemptAbortError(params.abortSignal);
      aborted = true;
      externalAbort = true;
      promptError = abortError;
      await cleanupEmbeddedPrepResourcesAfterEarlyExit();
      throw abortError;
    }
  };
  try {
    const skillsSnapshotForRun =
      sandbox?.enabled && sandbox.workspaceAccess !== "rw" ? undefined : params.skillsSnapshot;
    const { shouldLoadSkillEntries, skillEntries } = resolveEmbeddedRunSkillEntries({
      workspaceDir: effectiveWorkspace,
      config: params.config,
      agentId: sessionAgentId,
      skillsSnapshot: skillsSnapshotForRun,
    });
    restoreSkillEnv = skillsSnapshotForRun
      ? applySkillEnvOverridesFromSnapshot({
          snapshot: skillsSnapshotForRun,
          config: params.config,
        })
      : applySkillEnvOverrides({
          skills: skillEntries ?? [],
          config: params.config,
        });

    const skillsPrompt = resolveSkillsPromptForRun({
      skillsSnapshot: skillsSnapshotForRun,
      entries: shouldLoadSkillEntries ? skillEntries : undefined,
      config: params.config,
      workspaceDir: effectiveWorkspace,
      agentId: sessionAgentId,
    });
    prepStages.mark("skills");

    const sessionLabel = params.sessionKey ?? params.sessionId;
    const contextInjectionMode = resolveContextInjectionMode(params.config, sessionAgentId);
    const isRawModelRun = params.modelRun === true || params.promptMode === "none";
    if (isRawModelRun && log.isEnabled("debug")) {
      log.debug(
        `raw model run enabled: modelRun=${params.modelRun === true} promptMode=${params.promptMode ?? "unset"}`,
      );
    }
    const activeContextEngine = isRawModelRun ? undefined : params.contextEngine;
    if (activeContextEngine && activeContextEngine.info.id !== "legacy") {
      assertContextEngineHostSupport({
        contextEngine: activeContextEngine,
        operation: "agent-run",
        host: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
      });
    }
    const resolveActiveContextEnginePluginId = () =>
      resolveContextEngineOwnerPluginId(activeContextEngine);
    const agentDir = params.agentDir ?? resolveAgentDir(params.config ?? {}, sessionAgentId);
    const diagnosticTrace = freezeDiagnosticTraceContext(
      createDiagnosticTraceContextFromActiveScope(),
    );
    const runTrace = freezeDiagnosticTraceContext(
      createChildDiagnosticTraceContext(diagnosticTrace),
    );
    const diagnosticRunBase = {
      runId: params.runId,
      ...(params.sessionKey && { sessionKey: params.sessionKey }),
      ...(params.sessionId && { sessionId: params.sessionId }),
      provider: params.provider,
      model: params.modelId,
      trigger: params.trigger,
      ...((params.messageChannel ?? params.messageProvider)
        ? { channel: params.messageChannel ?? params.messageProvider }
        : {}),
      trace: runTrace,
    };
    emitTrustedDiagnosticEvent({
      type: "run.started",
      ...diagnosticRunBase,
    });
    const diagnosticRunStartedAt = Date.now();
    let diagnosticRunCompleted = false;
    emitDiagnosticRunCompleted = (outcome, err, extra) => {
      if (diagnosticRunCompleted) {
        return;
      }
      diagnosticRunCompleted = true;
      emitTrustedDiagnosticEvent({
        type: "run.completed",
        ...diagnosticRunBase,
        durationMs: Date.now() - diagnosticRunStartedAt,
        outcome,
        ...(extra?.blockedBy ? { blockedBy: extra.blockedBy } : {}),
        ...(err && outcome !== "blocked" ? { errorCategory: diagnosticErrorCategory(err) } : {}),
      });
    };
    const corePluginToolStages = createEmbeddedRunStageTracker();
    const toolsAllowWithForcedRuntimeTools = mergeForcedEmbeddedAttemptToolsAllow(
      params.toolsAllow,
      {
        forceMessageTool:
          params.forceMessageTool === true ||
          params.sourceReplyDeliveryMode === "message_tool_only",
      },
    );
    const toolConstructionPlan = resolveEmbeddedAttemptToolConstructionPlan({
      disableTools: params.disableTools,
      isRawModelRun,
      toolsAllow: toolsAllowWithForcedRuntimeTools,
    });
    const toolsEnabled = supportsModelTools(params.model);
    const codeModeConfig = resolveCodeModeConfig(params.config, sessionAgentId);
    const codeModeControlsEnabledForRun =
      toolsEnabled &&
      params.disableTools !== true &&
      !isRawModelRun &&
      params.toolsAllow?.length !== 0 &&
      codeModeConfig.enabled;
    const toolSearchControlsEnabledForRun =
      toolsEnabled &&
      params.disableTools !== true &&
      !isRawModelRun &&
      params.toolsAllow?.length !== 0 &&
      !codeModeControlsEnabledForRun &&
      resolveToolSearchConfig(params.config).enabled;
    const effectiveToolsAllow =
      toolSearchControlsEnabledForRun && toolsAllowWithForcedRuntimeTools
        ? [
            ...new Set([
              ...toolsAllowWithForcedRuntimeTools,
              ...TOOL_SEARCH_CONTROL_ALLOWLIST_NAMES,
            ]),
          ]
        : toolsAllowWithForcedRuntimeTools;
    const localModelLeanPreserveToolNames = resolveLocalModelLeanPreserveToolNames({
      toolNames: effectiveToolsAllow,
      forceMessageTool: params.forceMessageTool,
      sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    });
    const shouldConstructTools =
      toolConstructionPlan.constructTools ||
      toolSearchControlsEnabledForRun ||
      codeModeControlsEnabledForRun;
    let toolSearchCatalogExecutor: ToolSearchCatalogToolExecutor | undefined;
    toolSearchCatalogRef =
      toolSearchControlsEnabledForRun || codeModeControlsEnabledForRun
        ? createToolSearchCatalogRef()
        : undefined;
    const toolSearchTargetTranscriptProjections: ToolSearchTargetTranscriptProjection[] = [];
    const toolsRaw = !shouldConstructTools
      ? []
      : (() => {
          const allTools = createOpenClawCodingTools({
            agentId: sessionAgentId,
            ...buildEmbeddedAttemptToolRunContext({ ...params, trace: runTrace }),
            exec: {
              ...params.execOverrides,
              config: params.config,
              elevated: params.bashElevated,
            },
            sandbox,
            messageProvider: resolveAttemptToolPolicyMessageProvider(params),
            agentAccountId: params.agentAccountId,
            messageTo: params.messageTo,
            messageThreadId: params.messageThreadId,
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
            allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
            sessionKey: sandboxSessionKey,
            // When sandboxSessionKey differs from the real run session key (e.g. Telegram
            // direct peer key vs agent:main:main), pass the live key so session_status
            // "current" resolves to the active run session, not the stale sandbox key.
            runSessionKey:
              params.sessionKey && params.sessionKey !== sandboxSessionKey
                ? params.sessionKey
                : undefined,
            sessionId: params.sessionId,
            runId: params.runId,
            toolSearchCatalogRef,
            agentDir,
            cwd: effectiveCwd,
            workspaceDir: effectiveWorkspace,
            // Runtime cwd can point at a task repo while bootstrap/persona files stay in the
            // agent workspace. Spawned subagents inherit the real agent workspace, not task cwd.
            spawnWorkspaceDir:
              effectiveCwd !== effectiveWorkspace
                ? resolvedWorkspace
                : resolveAttemptSpawnWorkspaceDir({
                    sandbox,
                    resolvedWorkspace,
                  }),
            config: params.config,
            abortSignal: runAbortController.signal,
            modelProvider: params.provider,
            modelId: params.modelId,
            modelCompat: extractModelCompat(params.model),
            modelApi: params.model.api,
            modelContextWindowTokens: params.model.contextWindow,
            modelAuthMode: resolveModelAuthMode(params.model.provider, params.config, undefined, {
              workspaceDir: effectiveWorkspace,
            }),
            currentChannelId: params.currentChannelId,
            currentThreadTs: params.currentThreadTs,
            currentMessageId: params.currentMessageId,
            includeCoreTools: toolConstructionPlan.includeCoreTools,
            includeToolSearchControls: toolSearchControlsEnabledForRun,
            toolSearchCatalogExecutor: (toolParams) => {
              if (!toolSearchCatalogExecutor) {
                throw new Error("Tool Search catalog executor is unavailable for this run.");
              }
              return toolSearchCatalogExecutor(toolParams);
            },
            toolConstructionPlan: toolConstructionPlan.codingToolConstructionPlan,
            replyToMode: params.replyToMode,
            hasRepliedRef: params.hasRepliedRef,
            modelHasVision: params.model.input?.includes("image") ?? false,
            requireExplicitMessageTarget:
              params.requireExplicitMessageTarget ?? isSubagentSessionKey(params.sessionKey),
            sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
            inboundEventKind: params.currentInboundEventKind,
            disableMessageTool: params.disableMessageTool,
            forceMessageTool: params.forceMessageTool,
            enableHeartbeatTool: params.enableHeartbeatTool,
            forceHeartbeatTool: params.forceHeartbeatTool,
            runtimeToolAllowlist: effectiveToolsAllow,
            authProfileStore: params.authProfileStore,
            recordToolPrepStage: (name) => corePluginToolStages.mark(name),
            onToolOutcome: params.onToolOutcome,
            skillsSnapshot: skillsSnapshotForRun,
            onYield: (message) => {
              yieldDetected = true;
              yieldMessage = message;
              queueYieldInterruptForSession?.();
              runAbortController.abort("sessions_yield");
              abortSessionForYield?.();
            },
          });
          corePluginToolStages.mark("attempt:create-openclaw-coding-tools");
          const filteredTools = applyEmbeddedAttemptToolsAllow(allTools, effectiveToolsAllow, {
            toolMeta: (tool) => getPluginToolMeta(tool),
          });
          corePluginToolStages.mark("attempt:tools-allow");
          return filteredTools;
        })();
    prepStages.mark("core-plugin-tools");
    emitCorePluginToolStageSummary("core-plugin-tools", corePluginToolStages.snapshot());
    const bootstrapHasFileAccess = toolsEnabled && toolsRaw.some((tool) => tool.name === "read");
    const bootstrapWarn = makeBootstrapWarn({
      sessionLabel,
      workspaceDir: resolvedWorkspace,
      warn: (message) => log.warn(message),
    });
    let completedBootstrapTurn: boolean | undefined;
    const hasCompletedBootstrapTurnForAttempt = async (sessionFile: string) => {
      completedBootstrapTurn ??= await hasCompletedBootstrapTurn(sessionFile);
      return completedBootstrapTurn;
    };
    const resolveBootstrapRouting = (bootstrapFiles?: readonly WorkspaceBootstrapFile[]) =>
      resolveAttemptWorkspaceBootstrapRouting({
        isWorkspaceBootstrapPending,
        bootstrapFiles,
        bootstrapContextRunKind: params.bootstrapContextRunKind,
        trigger: params.trigger,
        sessionKey: params.sessionKey,
        isPrimaryRun: isPrimaryBootstrapRun(params.sessionKey),
        isCanonicalWorkspace: params.isCanonicalWorkspace,
        effectiveWorkspace,
        resolvedWorkspace,
        hasBootstrapFileAccess: bootstrapHasFileAccess,
      });
    const shouldProbeContinuationSkip =
      !isRawModelRun &&
      contextInjectionMode === "continuation-skip" &&
      (params.bootstrapContextRunKind ?? "default") !== "heartbeat" &&
      (await hasCompletedBootstrapTurnForAttempt(params.sessionFile));
    let preloadedBootstrapFiles: WorkspaceBootstrapFile[] | undefined;
    let bootstrapRouting =
      shouldProbeContinuationSkip || isRawModelRun || contextInjectionMode === "never"
        ? await resolveBootstrapRouting()
        : undefined;
    if (
      !isRawModelRun &&
      contextInjectionMode !== "never" &&
      (bootstrapRouting === undefined || bootstrapRouting.bootstrapMode === "full")
    ) {
      preloadedBootstrapFiles = await resolveBootstrapFilesForRun({
        workspaceDir: resolvedWorkspace,
        config: params.config,
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        agentId: sessionAgentId,
        warn: bootstrapWarn,
        contextMode: params.bootstrapContextMode,
        runKind: params.bootstrapContextRunKind,
      });
      bootstrapRouting = await resolveBootstrapRouting(preloadedBootstrapFiles);
    }
    bootstrapRouting ??= await resolveBootstrapRouting(preloadedBootstrapFiles);
    const bootstrapMode = bootstrapRouting.bootstrapMode;
    const {
      bootstrapFiles: hookAdjustedBootstrapFiles,
      contextFiles: resolvedContextFiles,
      shouldRecordCompletedBootstrapTurn,
    } = await resolveAttemptBootstrapContext({
      // modelRun is a provider probe, not an agent turn. Keep AGENTS/BOOTSTRAP
      // context out even when the gateway is exercising the embedded runtime.
      contextInjectionMode: isRawModelRun ? "never" : contextInjectionMode,
      bootstrapContextMode: params.bootstrapContextMode,
      bootstrapContextRunKind: params.bootstrapContextRunKind ?? "default",
      bootstrapMode,
      sessionFile: params.sessionFile,
      hasCompletedBootstrapTurn: hasCompletedBootstrapTurnForAttempt,
      resolveBootstrapContextForRun: async () => {
        const bootstrapFiles =
          preloadedBootstrapFiles ??
          (await resolveBootstrapFilesForRun({
            workspaceDir: resolvedWorkspace,
            config: params.config,
            sessionKey: params.sessionKey,
            sessionId: params.sessionId,
            agentId: sessionAgentId,
            warn: bootstrapWarn,
            contextMode: params.bootstrapContextMode,
            runKind: params.bootstrapContextRunKind,
          }));
        return {
          bootstrapFiles,
          contextFiles: buildBootstrapContextForFiles(bootstrapFiles, {
            config: params.config,
            agentId: sessionAgentId,
            warn: bootstrapWarn,
          }),
        };
      },
    });
    prepStages.mark("bootstrap-context");
    const remappedContextFiles = remapInjectedContextFilesToWorkspace({
      files: resolvedContextFiles,
      sourceWorkspaceDir: resolvedWorkspace,
      targetWorkspaceDir: effectiveWorkspace,
    });
    const contextFiles = bootstrapRouting.includeBootstrapInSystemContext
      ? remappedContextFiles
      : remappedContextFiles.filter((file) => !/(^|[\\/])BOOTSTRAP\.md$/iu.test(file.path.trim()));
    const bootstrapFilesForInjectionStats = bootstrapRouting.includeBootstrapInSystemContext
      ? hookAdjustedBootstrapFiles
      : hookAdjustedBootstrapFiles.filter((file) => file.name !== DEFAULT_BOOTSTRAP_FILENAME);
    const bootstrapMaxChars = resolveBootstrapMaxChars(params.config, sessionAgentId);
    const bootstrapTotalMaxChars = resolveBootstrapTotalMaxChars(params.config, sessionAgentId);
    const bootstrapAnalysis = analyzeBootstrapBudget({
      files: buildBootstrapInjectionStats({
        bootstrapFiles: bootstrapFilesForInjectionStats,
        injectedFiles: contextFiles,
      }),
      bootstrapMaxChars,
      bootstrapTotalMaxChars,
    });
    const bootstrapPromptWarningMode = resolveBootstrapPromptTruncationWarningMode(params.config);
    const bootstrapPromptWarning = buildBootstrapPromptWarning({
      analysis: bootstrapAnalysis,
      mode: bootstrapPromptWarningMode,
      seenSignatures: params.bootstrapPromptWarningSignaturesSeen,
      previousSignature: params.bootstrapPromptWarningSignature,
    });
    const workspaceNotes: string[] = [];
    if (
      hookAdjustedBootstrapFiles.some(
        (file) => file.name === DEFAULT_BOOTSTRAP_FILENAME && !file.missing,
      )
    ) {
      workspaceNotes.push("Reminder: commit your changes in this workspace after edits.");
    }
    if (isEmbeddedMode()) {
      workspaceNotes.push(
        "Running in local embedded mode (no gateway). Most tools work locally. Gateway-dependent tools (canvas, nodes, cron, message, sessions_send, sessions_spawn, gateway) are unavailable. Subagent kill/steer require a gateway. Do not attempt to read gateway-specific files such as sessions.json, gateway.log, or gateway.pid.",
      );
    }

    const { defaultAgentId } = resolveSessionAgentIds({
      sessionKey: params.sessionKey,
      config: params.config,
      agentId: params.agentId,
    });
    // Track sessions_yield tool invocation (callback pattern, like clientToolCallDetected)
    let yieldDetected = false;
    let yieldMessage: string | null = null;
    // Late-binding reference so onYield can abort the session (declared after tool creation)
    let abortSessionForYield: (() => void) | null = null;
    let queueYieldInterruptForSession: (() => void) | null = null;
    let yieldAbortSettled: Promise<void> | null = null;
    const runtimePlanModelContext = {
      workspaceDir: effectiveWorkspace,
      modelApi: params.model.api,
      model: params.model,
    };
    const tools = normalizeAgentRuntimeTools({
      runtimePlan: params.runtimePlan,
      tools: toolsEnabled ? toolsRaw : [],
      provider: params.provider,
      config: params.config,
      workspaceDir: effectiveWorkspace,
      env: process.env,
      modelId: params.modelId,
      modelApi: params.model.api,
      model: params.model,
      runtimeHandle: getProviderRuntimeHandle(),
      onPreNormalizationSchemaDiagnostics: (diagnostics, sourceTools) =>
        logRuntimeToolSchemaQuarantine({
          diagnostics,
          tools: sourceTools,
          runId: params.runId,
          sessionKey: params.sessionKey,
          sessionId: params.sessionId,
        }),
    });
    const clientTools = toolsEnabled && !isRawModelRun ? params.clientTools : undefined;
    const bundleMcpEnabled = shouldCreateBundleMcpRuntimeForAttempt({
      toolsEnabled,
      disableTools: params.disableTools || isRawModelRun,
      toolsAllow: params.toolsAllow,
    });
    const bundleMcpSessionRuntime = bundleMcpEnabled
      ? await getOrCreateSessionMcpRuntime({
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          workspaceDir: effectiveWorkspace,
          cfg: params.config,
        })
      : undefined;
    bundleMcpRuntime = bundleMcpSessionRuntime
      ? await materializeBundleMcpToolsForRun({
          runtime: bundleMcpSessionRuntime,
          reservedToolNames: [
            ...tools.map((tool) => tool.name),
            ...(clientTools?.map((tool) => tool.function.name) ?? []),
          ],
        })
      : undefined;
    const bundleLspEnabled = shouldCreateBundleLspRuntimeForAttempt({
      toolsEnabled,
      disableTools: params.disableTools || isRawModelRun,
      toolsAllow: params.toolsAllow,
    });
    bundleLspRuntime = bundleLspEnabled
      ? await createBundleLspToolRuntime({
          workspaceDir: effectiveWorkspace,
          cfg: params.config,
          reservedToolNames: [
            ...tools.map((tool) => tool.name),
            ...(clientTools?.map((tool) => tool.function.name) ?? []),
            ...(bundleMcpRuntime?.tools.map((tool) => tool.name) ?? []),
          ],
        })
      : undefined;
    const allowedBundleMcpTools = applyEmbeddedAttemptToolsAllow(
      bundleMcpRuntime?.tools ?? [],
      effectiveToolsAllow,
      {
        toolMeta: (tool) => getPluginToolMeta(tool),
      },
    );
    const allowedBundleLspTools = applyEmbeddedAttemptToolsAllow(
      bundleLspRuntime?.tools ?? [],
      effectiveToolsAllow,
      {
        toolMeta: (tool) => getPluginToolMeta(tool),
      },
    );
    const allowedBundledTools = [...allowedBundleMcpTools, ...allowedBundleLspTools];
    const filteredBundledTools = applyFinalEffectiveToolPolicy({
      bundledTools: allowedBundledTools,
      config: params.config,
      sandboxToolPolicy: sandbox?.tools,
      sessionKey: sandboxSessionKey,
      agentId: sessionAgentId,
      modelProvider: params.provider,
      modelId: params.modelId,
      messageProvider: resolveAttemptToolPolicyMessageProvider(params),
      agentAccountId: params.agentAccountId,
      groupId: params.groupId,
      groupChannel: params.groupChannel,
      groupSpace: params.groupSpace,
      spawnedBy: params.spawnedBy,
      senderId: params.senderId,
      senderName: params.senderName,
      senderUsername: params.senderUsername,
      senderE164: params.senderE164,
      warn: (message) => log.warn(message),
    });
    const normalizedBundledTools =
      filteredBundledTools.length > 0
        ? normalizeAgentRuntimeTools({
            runtimePlan: params.runtimePlan,
            tools: filteredBundledTools,
            provider: params.provider,
            config: params.config,
            workspaceDir: effectiveWorkspace,
            env: process.env,
            modelId: params.modelId,
            modelApi: params.model.api,
            model: params.model,
            runtimeHandle: getProviderRuntimeHandle(),
            onPreNormalizationSchemaDiagnostics: (diagnostics, sourceTools) =>
              logRuntimeToolSchemaQuarantine({
                diagnostics,
                tools: sourceTools,
                runId: params.runId,
                sessionKey: params.sessionKey,
                sessionId: params.sessionId,
              }),
          })
        : filteredBundledTools;
    const projectedUncompactedEffectiveTools = filterLocalModelLeanTools({
      tools: [...tools, ...normalizedBundledTools],
      config: params.config,
      agentId: sessionAgentId,
      preserveToolNames: localModelLeanPreserveToolNames,
    });
    const uncompactedToolSchemaProjection = filterRuntimeCompatibleTools(
      projectedUncompactedEffectiveTools,
    );
    logRuntimeToolSchemaQuarantine({
      diagnostics: uncompactedToolSchemaProjection.diagnostics,
      tools: projectedUncompactedEffectiveTools,
      runId: params.runId,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
    });
    const uncompactedEffectiveTools = [...uncompactedToolSchemaProjection.tools];
    let effectiveTools = uncompactedEffectiveTools;
    const catalogToolHookContext = {
      agentId: sessionAgentId,
      config: params.config,
      cwd: effectiveCwd,
      sessionKey: sandboxSessionKey,
      sessionId: params.sessionId,
      runId: params.runId,
      channelId: params.currentChannelId,
      trace: runTrace,
      loopDetection: resolveToolLoopDetectionConfig({
        cfg: params.config,
        agentId: sessionAgentId,
      }),
      onToolOutcome: params.onToolOutcome,
    };
    const codeModeTools = codeModeControlsEnabledForRun
      ? createCodeModeTools({
          config: params.config,
          runtimeConfig: params.config,
          agentId: sessionAgentId,
          sessionKey: sandboxSessionKey,
          sessionId: params.sessionId,
          runId: params.runId,
          catalogRef: toolSearchCatalogRef,
          abortSignal: runAbortController.signal,
          executeTool: (toolParams) => {
            if (!toolSearchCatalogExecutor) {
              throw new Error("Code Mode catalog executor is unavailable for this run.");
            }
            return toolSearchCatalogExecutor(toolParams);
          },
        })
      : [];
    const toolSearch = codeModeControlsEnabledForRun
      ? applyCodeModeCatalog({
          tools: [...codeModeTools, ...effectiveTools],
          config: params.config,
          sessionId: params.sessionId,
          sessionKey: sandboxSessionKey,
          agentId: sessionAgentId,
          runId: params.runId,
          catalogRef: toolSearchCatalogRef,
          toolHookContext: catalogToolHookContext,
        })
      : applyToolSearchCatalog({
          tools: effectiveTools,
          config: params.config,
          sessionId: params.sessionId,
          sessionKey: sandboxSessionKey,
          agentId: sessionAgentId,
          runId: params.runId,
          catalogRef: toolSearchCatalogRef,
          toolHookContext: catalogToolHookContext,
        });
    const projectedToolSearchTools = filterLocalModelLeanTools({
      tools: toolSearch.tools,
      config: params.config,
      agentId: sessionAgentId,
      preserveToolNames: localModelLeanPreserveToolNames,
    });
    const toolSearchSchemaProjection = filterRuntimeCompatibleTools(projectedToolSearchTools);
    logRuntimeToolSchemaQuarantine({
      diagnostics: toolSearchSchemaProjection.diagnostics,
      tools: projectedToolSearchTools,
      runId: params.runId,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
    });
    effectiveTools = [...toolSearchSchemaProjection.tools];
    if (toolSearch.compacted && !toolSearch.catalogReused) {
      prepStages.mark(codeModeControlsEnabledForRun ? "code-mode" : "tool-search");
      log.info(
        codeModeControlsEnabledForRun
          ? `code-mode: cataloged ${toolSearch.catalogToolCount} tools behind exec/wait`
          : `tool-search: cataloged ${toolSearch.catalogToolCount} tools behind compact prompt surface`,
      );
    }
    prepStages.mark("bundle-tools");
    const explicitToolAllowlistSources = collectAttemptExplicitToolAllowlistSources({
      config: params.config,
      sessionKey: params.sessionKey,
      sandboxSessionKey,
      agentId: sessionAgentId,
      modelProvider: params.provider,
      modelId: params.modelId,
      messageProvider: resolveAttemptToolPolicyMessageProvider(params),
      agentAccountId: params.agentAccountId,
      groupId: params.groupId,
      groupChannel: params.groupChannel,
      groupSpace: params.groupSpace,
      spawnedBy: params.spawnedBy,
      senderId: params.senderId,
      senderName: params.senderName,
      senderUsername: params.senderUsername,
      senderE164: params.senderE164,
      sandboxToolPolicy: sandbox?.tools,
      toolsAllow: params.toolsAllow,
    });
    const toolSearchRunPlan = buildToolSearchRunPlan({
      visibleTools: effectiveTools,
      uncompactedTools: uncompactedEffectiveTools,
      clientTools,
      catalogRegistered: toolSearch.catalogRegistered,
      catalogToolCount: toolSearch.catalogToolCount,
      controlsEnabled: toolSearchControlsEnabledForRun || codeModeControlsEnabledForRun,
      controlNames: codeModeControlsEnabledForRun
        ? [CODE_MODE_EXEC_TOOL_NAME, CODE_MODE_WAIT_TOOL_NAME]
        : undefined,
      explicitAllowlistSources: explicitToolAllowlistSources,
    });
    const allowedToolNames = toolSearchRunPlan.visibleAllowedToolNames;
    const replayAllowedToolNames = toolSearchRunPlan.replayAllowedToolNames;
    const emptyExplicitToolAllowlistError = buildEmptyExplicitToolAllowlistError({
      sources: explicitToolAllowlistSources,
      callableToolNames: toolSearchRunPlan.emptyAllowlistCallableNames,
      toolsEnabled,
      disableTools: params.disableTools,
    });
    logAgentRuntimeToolDiagnostics({
      runtimePlan: params.runtimePlan,
      tools: effectiveTools,
      provider: params.provider,
      config: params.config,
      workspaceDir: effectiveWorkspace,
      env: process.env,
      modelId: params.modelId,
      modelApi: params.model.api,
      model: params.model,
      runtimeHandle: getProviderRuntimeHandle(),
    });

    const machineName = await getMachineDisplayName();
    const runtimeChannel = normalizeMessageChannel(params.messageChannel ?? params.messageProvider);
    const runtimeCapabilities = collectRuntimeChannelCapabilities({
      cfg: params.config,
      channel: runtimeChannel,
      accountId: params.agentAccountId,
    });
    const reactionGuidance =
      runtimeChannel && params.config
        ? resolveChannelReactionGuidance({
            cfg: params.config,
            channel: runtimeChannel,
            accountId: params.agentAccountId,
          })
        : undefined;
    const sandboxInfoExecPolicy = resolveEmbeddedSandboxInfoExecPolicy({
      config: params.config,
      agentId: sessionAgentId,
      sessionKey: params.sessionKey,
      sandboxAvailable: sandbox?.enabled === true,
      execOverrides: params.execOverrides,
    });
    const sandboxInfo = buildEmbeddedSandboxInfo(
      sandbox,
      params.bashElevated,
      sandboxInfoExecPolicy,
    );
    const reasoningTagHint = isReasoningTagProvider(params.provider, {
      config: params.config,
      workspaceDir: effectiveWorkspace,
      env: process.env,
      modelId: params.modelId,
      modelApi: params.model.api,
      model: params.model,
      runtimeHandle: getProviderRuntimeHandle(),
    });
    // Resolve channel-specific message actions for system prompt
    const channelActions = runtimeChannel
      ? listChannelSupportedActions(
          buildEmbeddedMessageActionDiscoveryInput({
            cfg: params.config,
            channel: runtimeChannel,
            currentChannelId: params.currentChannelId,
            currentThreadTs: params.currentThreadTs,
            currentMessageId: params.currentMessageId,
            accountId: params.agentAccountId,
            sessionKey: params.sessionKey,
            sessionId: params.sessionId,
            agentId: sessionAgentId,
            senderId: params.senderId,
            senderIsOwner: params.senderIsOwner,
          }),
        )
      : undefined;
    const messageToolHints = runtimeChannel
      ? resolveChannelMessageToolHints({
          cfg: params.config,
          channel: runtimeChannel,
          accountId: params.agentAccountId,
        })
      : undefined;

    const defaultModelRef = resolveDefaultModelForAgent({
      cfg: params.config ?? {},
      agentId: sessionAgentId,
    });
    const defaultModelLabel = `${defaultModelRef.provider}/${defaultModelRef.model}`;
    const activeProcessSessions = listActiveProcessSessionReferences({
      scopeKey: resolveProcessToolScopeKey({
        sessionKey: sandboxSessionKey,
        agentId: sessionAgentId,
      }),
    });
    const { runtimeInfo, userTimezone, userTime, userTimeFormat } = buildSystemPromptParams({
      config: params.config,
      agentId: sessionAgentId,
      workspaceDir: effectiveWorkspace,
      cwd: effectiveCwd,
      runtime: {
        host: machineName,
        os: `${os.type()} ${os.release()}`,
        arch: os.arch(),
        node: process.version,
        model: `${params.provider}/${params.modelId}`,
        defaultModel: defaultModelLabel,
        shell: detectRuntimeShell(),
        channel: runtimeChannel,
        capabilities: runtimeCapabilities,
        channelActions,
        activeProcessSessions,
      },
    });
    const isDefaultAgent = sessionAgentId === defaultAgentId;
    const promptMode =
      params.promptMode ??
      (isRawModelRun ? "none" : resolvePromptModeForSession(params.sessionKey));
    const promptSurface = resolveAgentPromptSurfaceForSessionKey(params.sessionKey);

    // When toolsAllow is set, use minimal prompt and strip skills catalog
    const effectivePromptMode = params.toolsAllow?.length ? ("minimal" as const) : promptMode;
    const effectiveSkillsPrompt = params.toolsAllow?.length ? undefined : skillsPrompt;
    const openClawReferences = await resolveOpenClawReferencePaths({
      workspaceDir: effectiveWorkspace,
      argv1: process.argv[1],
      cwd: effectiveCwd,
      moduleUrl: import.meta.url,
    });
    const heartbeatPrompt = shouldInjectHeartbeatPrompt({
      config: params.config,
      agentId: sessionAgentId,
      defaultAgentId,
      isDefaultAgent,
      trigger: params.trigger,
    })
      ? resolveHeartbeatPromptForSystemPrompt({
          config: params.config,
          agentId: sessionAgentId,
          defaultAgentId,
        })
      : undefined;
    const promptContributionContext = {
      config: params.config,
      agentDir: params.agentDir,
      workspaceDir: effectiveWorkspace,
      provider: params.provider,
      modelId: params.modelId,
      promptMode: effectivePromptMode,
      runtimeChannel,
      runtimeCapabilities,
      agentId: sessionAgentId,
      trigger: params.trigger,
    };
    const promptContribution =
      params.runtimePlan?.prompt.resolveSystemPromptContribution(promptContributionContext) ??
      resolveProviderSystemPromptContribution({
        provider: params.provider,
        config: params.config,
        workspaceDir: effectiveWorkspace,
        runtimeHandle: getProviderRuntimeHandle(),
        context: promptContributionContext,
      });

    const bootstrapTruncationNotice = buildBootstrapPromptWarningNotice(
      bootstrapPromptWarning.lines,
    );
    const attemptSystemPrompt = buildAttemptSystemPrompt({
      isRawModelRun,
      transformProviderSystemPrompt: (transformParams) =>
        transformProviderSystemPrompt({
          ...transformParams,
          runtimeHandle: getProviderRuntimeHandle(),
        }),
      embeddedSystemPrompt: {
        config: params.config,
        agentId: sessionAgentId,
        workspaceDir: effectiveWorkspace,
        defaultThinkLevel: params.thinkLevel,
        reasoningLevel: params.reasoningLevel ?? "off",
        extraSystemPrompt: params.extraSystemPrompt,
        ownerNumbers: params.ownerNumbers,
        reasoningTagHint,
        heartbeatPrompt,
        skillsPrompt: effectiveSkillsPrompt,
        docsPath: openClawReferences.docsPath ?? undefined,
        sourcePath: openClawReferences.sourcePath ?? undefined,
        workspaceNotes: workspaceNotes?.length ? workspaceNotes : undefined,
        reactionGuidance,
        promptMode: effectivePromptMode,
        sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
        silentReplyPromptMode: params.silentReplyPromptMode,
        acpEnabled: isAcpRuntimeSpawnAvailable({
          config: params.config,
          sandboxed: sandboxInfo?.enabled === true,
        }),
        promptSurface,
        nativeCommandGuidanceLines: listRegisteredPluginAgentPromptGuidance({
          surface: promptSurface,
        }),
        runtimeInfo,
        messageToolHints,
        sandboxInfo,
        tools: effectiveTools,
        userTimezone,
        userTime,
        userTimeFormat,
        contextFiles,
        bootstrapMode,
        bootstrapTruncationNotice,
        includeMemorySection: !activeContextEngine || activeContextEngine.info.id === "legacy",
        promptContribution,
      },
      providerTransform: {
        provider: params.provider,
        config: params.config,
        workspaceDir: effectiveWorkspace,
        context: {
          config: params.config,
          agentDir: params.agentDir,
          workspaceDir: effectiveWorkspace,
          provider: params.provider,
          modelId: params.modelId,
          promptMode: effectivePromptMode,
          runtimeChannel,
          runtimeCapabilities,
          agentId: sessionAgentId,
        },
      },
    });
    const appendPrompt = attemptSystemPrompt.systemPrompt;
    const systemPromptReport = buildSystemPromptReport({
      source: "run",
      generatedAt: Date.now(),
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      provider: params.provider,
      model: params.modelId,
      workspaceDir: effectiveWorkspace,
      bootstrapMaxChars,
      bootstrapTotalMaxChars,
      bootstrapTruncation: buildBootstrapTruncationReportMeta({
        analysis: bootstrapAnalysis,
        warningMode: bootstrapPromptWarningMode,
        warning: bootstrapPromptWarning,
      }),
      sandbox: (() => {
        const runtime = resolveSandboxRuntimeStatus({
          cfg: params.config,
          sessionKey: sandboxSessionKey,
        });
        return { mode: runtime.mode, sandboxed: runtime.sandboxed };
      })(),
      systemPrompt: appendPrompt,
      bootstrapFiles: hookAdjustedBootstrapFiles,
      injectedFiles: contextFiles,
      skillsPrompt,
      tools: effectiveTools,
    });
    let systemPromptText = attemptSystemPrompt.systemPrompt;
    prepStages.mark("system-prompt");

    const compactionTimeoutMs = resolveCompactionTimeoutMs(params.config);
    const sessionWriteLockOptions = resolveEmbeddedAttemptSessionWriteLockOptions({
      config: params.config,
      compactionTimeoutMs,
    });
    await throwIfAttemptAbortSignalFiredAfterPrepCleanup();
    retainedSessionFileOwner = await acquireEmbeddedAttemptSessionFileOwner({
      sessionFile: params.sessionFile,
      timeoutMs: sessionWriteLockOptions.maxHoldMs,
      signal: params.abortSignal,
    });
    const sessionLockController = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      lockOptions: {
        sessionFile: params.sessionFile,
        ...sessionWriteLockOptions,
      },
    });
    releaseRetainedSessionLock = () => sessionLockController.dispose();
    armExternalAbortSignal();

    let sessionManager: ReturnType<typeof guardSessionManager> | undefined;
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    let removeToolResultContextGuard: (() => void) | undefined;
    let trajectoryRecorder: ReturnType<typeof createTrajectoryRuntimeRecorder> | null = null;
    let trajectoryEndRecorded = false;
    let buildAbortSettlePromise: () => Promise<void> | null = () => null;
    let cleanupYieldAborted = false;
    try {
      await repairSessionFileIfNeeded({
        sessionFile: params.sessionFile,
        debug: (message) => log.debug(message),
        warn: (message) => log.warn(message),
      });
      const hadSessionFile = await fs
        .stat(params.sessionFile)
        .then(() => true)
        .catch(() => false);

      const transcriptPolicy = resolveAttemptTranscriptPolicy({
        runtimePlan: params.runtimePlan,
        runtimePlanModelContext,
        provider: params.provider,
        modelId: params.modelId,
        config: params.config,
        env: process.env,
      });

      await prewarmSessionFile(params.sessionFile);
      const preparedUserTurnMessage = await params.userTurnTranscriptRecorder?.resolveMessage();
      sessionManager = guardSessionManager(SessionManager.open(params.sessionFile), {
        agentId: sessionAgentId,
        sessionKey: params.sessionKey,
        config: params.config,
        contextWindowTokens: params.contextTokenBudget,
        inputProvenance: params.inputProvenance,
        preparedUserTurnMessage,
        allowSyntheticToolResults: transcriptPolicy.allowSyntheticToolResults,
        missingToolResultText:
          params.model.api === "openai-responses" ||
          params.model.api === "azure-openai-responses" ||
          params.model.api === "openai-chatgpt-responses"
            ? "aborted"
            : undefined,
        allowedToolNames: replayAllowedToolNames,
        suppressNextUserMessagePersistence: params.suppressNextUserMessagePersistence,
        suppressTranscriptOnlyAssistantPersistence:
          params.suppressTranscriptOnlyAssistantPersistence,
        suppressAssistantErrorPersistence: params.suppressAssistantErrorPersistence,
        onMessagePersisted: () => {
          sessionLockController.refreshAfterOwnedSessionWrite();
        },
        onUserMessagePersisted: (message) => {
          params.onUserMessagePersisted?.(message);
        },
        onAssistantErrorMessagePersisted: (message) => {
          params.onAssistantErrorMessagePersisted?.(message);
        },
      });
      trackSessionManagerAccess(params.sessionFile);

      await runAttemptContextEngineBootstrap({
        hadSessionFile,
        contextEngine: activeContextEngine,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        sessionFile: params.sessionFile,
        sessionManager,
        runtimeContext: buildAfterTurnRuntimeContext({
          attempt: params,
          workspaceDir: effectiveWorkspace,
          cwd: effectiveCwd,
          agentDir,
          tokenBudget: params.contextTokenBudget,
          activeAgentId: sessionAgentId,
          contextEnginePluginId: resolveActiveContextEnginePluginId(),
        }),
        runMaintenance: async (contextParams) =>
          await runContextEngineMaintenance({
            contextEngine: contextParams.contextEngine as never,
            sessionId: contextParams.sessionId,
            sessionKey: contextParams.sessionKey,
            sessionFile: contextParams.sessionFile,
            reason: contextParams.reason,
            sessionManager: contextParams.sessionManager as never,
            runtimeContext: contextParams.runtimeContext,
            config: params.config,
            agentId: sessionAgentId,
          }),
        warn: (message) => log.warn(message),
      });

      await prepareSessionManagerForRun({
        sessionManager,
        sessionFile: params.sessionFile,
        hadSessionFile,
        sessionId: params.sessionId,
        cwd: effectiveCwd,
      });

      const settingsManager = createPreparedEmbeddedAgentSettingsManager({
        cwd: effectiveCwd,
        agentDir,
        cfg: params.config,
        pluginMetadataSnapshot: getCurrentAttemptPluginMetadataSnapshot(),
        contextTokenBudget: params.contextTokenBudget,
      });
      const autoCompactionGuardArgs = {
        settingsManager,
        contextEngineInfo: activeContextEngine?.info,
        compactionMode: resolveEffectiveCompactionMode(params.config),
        silentOverflowProneProvider: isSilentOverflowProneModel({
          provider: params.provider,
          modelId: params.modelId,
          baseUrl: params.model.baseUrl ?? undefined,
        }),
      };
      applyAgentAutoCompactionGuard(autoCompactionGuardArgs);

      // Sets compaction/pruning runtime state and returns extension factories
      // that must be passed to the resource loader for the safeguard to be active.
      const extensionFactories = buildEmbeddedExtensionFactories({
        cfg: params.config,
        sessionManager,
        provider: params.provider,
        modelId: params.modelId,
        model: params.model,
      });
      const resourceLoader = createEmbeddedAgentResourceLoader({
        cwd: effectiveCwd,
        agentDir,
        settingsManager,
        extensionFactories,
      });
      await resourceLoader.reload();
      // DefaultResourceLoader.reload() rehydrates settings from disk and can drop OpenClaw
      // compaction overrides applied in createPreparedEmbeddedAgentSettingsManager — same
      // rehydration also restores OpenClaw runtime's auto-compaction (openclaw#75799), so re-apply
      // both guards.
      applyAgentCompactionSettingsFromConfig({
        settingsManager,
        cfg: params.config,
        contextTokenBudget: params.contextTokenBudget,
      });
      applyAgentAutoCompactionGuard(autoCompactionGuardArgs);
      prepStages.mark("session-resource-loader");

      // Get hook runner early so it's available when creating tools
      const hookRunner = getGlobalHookRunner();

      const { customTools } = splitSdkTools({
        tools: effectiveTools,
        sandboxEnabled: Boolean(sandbox?.enabled),
        toolHookContext: catalogToolHookContext,
      });

      // Add client tools (OpenResponses hosted tools) to customTools.
      // Reserve slots synchronously at tool execution entry, before async
      // before_tool_call hooks run, so parallel client-tool batches preserve
      // assistant source order even when later hooks finish first.
      const clientToolCallSlots: Array<{
        toolCallId: string;
        name: string;
        params?: Record<string, unknown>;
        completed: boolean;
      }> = [];
      const clientToolCallSlotIndexes = new Map<string, number>();
      const reserveClientToolCallSlot = (toolCallId: string, toolName: string) => {
        if (clientToolCallSlotIndexes.has(toolCallId)) {
          return;
        }
        clientToolCallSlotIndexes.set(toolCallId, clientToolCallSlots.length);
        clientToolCallSlots.push({
          toolCallId,
          name: toolName,
          completed: false,
        });
      };
      const clientToolLoopDetection = resolveToolLoopDetectionConfig({
        cfg: params.config,
        agentId: sessionAgentId,
      });
      // Exact raw names of every tool registered for this run, including
      // bundled/plugin tools. Used as the raw-name set for the trusted local
      // media passthrough gate: a normalized alias is not sufficient — the
      // emitted tool name must match an exact registration of this run.
      const builtinToolNames = new Set(
        uncompactedEffectiveTools.flatMap((tool) => {
          const name = (tool.name ?? "").trim();
          return name ? [name] : [];
        }),
      );
      // Admission-time conflict check only against non-plugin core tools, to
      // preserve prior behavior where client tools may coexist with unrelated
      // plugin tool names. MEDIA passthrough is still gated by the raw-name
      // set above, so a client tool that normalize-collides with a plugin
      // tool cannot inherit the plugin's local-media trust.
      const coreBuiltinToolNames = collectCoreBuiltinToolNames(uncompactedEffectiveTools, {
        isPluginTool: (tool) =>
          Boolean(getPluginToolMeta(tool as Parameters<typeof getPluginToolMeta>[0])),
      });
      const clientToolNameConflicts = findClientToolNameConflicts({
        tools: clientTools ?? [],
        existingToolNames: [...coreBuiltinToolNames, ...AGENT_RESERVED_TOOL_NAMES],
      });
      if (clientToolNameConflicts.length > 0) {
        throw createClientToolNameConflictError(clientToolNameConflicts);
      }
      let clientToolDefs = clientTools
        ? toClientToolDefinitions(
            clientTools,
            {
              reserve: reserveClientToolCallSlot,
              complete: (toolCallId, toolName, toolParams) => {
                reserveClientToolCallSlot(toolCallId, toolName);
                const slotIndex = clientToolCallSlotIndexes.get(toolCallId);
                if (slotIndex === undefined) {
                  return;
                }
                const slot = clientToolCallSlots[slotIndex];
                if (!slot) {
                  return;
                }
                slot.name = toolName;
                slot.params = toolParams;
                slot.completed = true;
              },
              discard: (toolCallId) => {
                const slotIndex = clientToolCallSlotIndexes.get(toolCallId);
                if (slotIndex === undefined) {
                  return;
                }
                const slot = clientToolCallSlots[slotIndex];
                if (slot) {
                  slot.completed = false;
                  slot.params = undefined;
                }
              },
            },
            {
              agentId: sessionAgentId,
              sessionKey: sandboxSessionKey,
              config: params.config,
              sessionId: params.sessionId,
              runId: params.runId,
              loopDetection: clientToolLoopDetection,
              onToolOutcome: params.onToolOutcome,
            },
          )
        : [];
      const clientToolSearch = codeModeControlsEnabledForRun
        ? addClientToolsToCodeModeCatalog({
            tools: clientToolDefs,
            config: params.config,
            sessionId: params.sessionId,
            sessionKey: sandboxSessionKey,
            agentId: sessionAgentId,
            runId: params.runId,
            catalogRef: toolSearchCatalogRef,
          })
        : addClientToolsToToolSearchCatalog({
            tools: clientToolDefs,
            config: params.config,
            sessionId: params.sessionId,
            sessionKey: sandboxSessionKey,
            agentId: sessionAgentId,
            runId: params.runId,
            catalogRef: toolSearchCatalogRef,
          });
      clientToolDefs = clientToolSearch.tools;
      if (clientToolSearch.compacted) {
        log.info(
          codeModeControlsEnabledForRun
            ? `code-mode: cataloged ${clientToolSearch.catalogToolCount} client tools behind exec/wait`
            : `tool-search: cataloged ${clientToolSearch.catalogToolCount} client tools behind compact prompt surface`,
        );
      }

      const allCustomTools = [...customTools, ...clientToolDefs];
      // The session runtime treats `tools` as a name allowlist during session creation. Pass the
      // exact OpenClaw-managed registrations so custom tools survive startup and
      // client-provided names do not broaden the prompt/runtime boundary.
      const sessionToolAllowlist = toSessionToolAllowlist(
        collectRegisteredToolNames(allCustomTools),
      );

      const createdSession = await createEmbeddedAgentSessionWithResourceLoader<
        Awaited<ReturnType<typeof createAgentSession>>
      >({
        createAgentSession: async (options) =>
          await createAgentSession(options as unknown as Parameters<typeof createAgentSession>[0]),
        options: {
          cwd: effectiveCwd,
          agentDir,
          authStorage: params.authStorage,
          modelRegistry: params.modelRegistry,
          model: params.model,
          thinkingLevel: mapThinkingLevel(params.thinkLevel),
          tools: sessionToolAllowlist,
          customTools: allCustomTools,
          sessionManager,
          settingsManager,
          resourceLoader,
          withSessionWriteLock: (operation) =>
            sessionLockController.withSessionWriteLock(operation),
        },
      });
      session = createdSession.session;
      if (!session) {
        throw new Error("Embedded agent session missing");
      }
      session.setActiveToolsByName(sessionToolAllowlist);
      const activeSession = session;
      const setActiveSessionSystemPrompt = (nextSystemPrompt: string) => {
        systemPromptText = nextSystemPrompt;
        applySystemPromptToSession(activeSession, nextSystemPrompt);
      };
      setActiveSessionSystemPrompt(systemPromptText);
      installMessageToolOnlyTerminalHook({
        agent: activeSession.agent,
        sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
      });
      prepStages.mark("agent-session");
      if (isRawModelRun) {
        // Raw model probes should measure exactly the requested prompt against
        // the selected provider/model. Reset clears restored transcript state
        // and queues; the empty system prompt prevents the runtime from rebuilding the
        // normal OpenClaw agent/tool prompt when `session.prompt()` starts.
        activeSession.agent.reset();
        setActiveSessionSystemPrompt("");
      }
      if (typeof activeSession.agent.convertToLlm === "function") {
        const baseConvertToLlm = activeSession.agent.convertToLlm.bind(activeSession.agent);
        activeSession.agent.convertToLlm = async (messages) =>
          await baseConvertToLlm(normalizeMessagesForLlmBoundary(messages));
      }
      let prePromptMessageCount = activeSession.messages.length;
      let contextEngineAfterTurnCheckpoint: number | null = null;
      let unwindowedContextEngineMessagesForPrecheck: AgentMessage[] | undefined;
      let contextEnginePromptAuthority: NonNullable<AssembleResult["promptAuthority"]> =
        "assembled";
      const inFlightPromptSettlePromises = new Set<Promise<void>>();
      const inFlightAbortSettlePromises = new Set<Promise<void>>();
      const trackSettlePromise = (
        promises: Set<Promise<void>>,
        promise: Promise<void>,
      ): Promise<void> => {
        promises.add(promise);
        void promise.then(
          () => {
            promises.delete(promise);
          },
          () => {
            promises.delete(promise);
          },
        );
        return promise;
      };
      const trackPromptSettlePromise = (promise: Promise<void>): Promise<void> =>
        trackSettlePromise(inFlightPromptSettlePromises, promise);
      const trackAbortSettlePromise = (promise: Promise<void>): Promise<void> =>
        trackSettlePromise(inFlightAbortSettlePromises, promise);
      const abortActiveSession = (): Promise<void> =>
        trackAbortSettlePromise(Promise.resolve(activeSession.abort()));
      abortActiveSessionForExternalSignal = abortActiveSession;
      buildAbortSettlePromise = (): Promise<void> | null => {
        const promises = [...inFlightPromptSettlePromises, ...inFlightAbortSettlePromises];
        if (promises.length === 0) {
          return null;
        }
        return Promise.allSettled(promises).then(() => undefined);
      };
      abortSessionForYield = () => {
        yieldAbortSettled = abortActiveSession();
      };
      queueYieldInterruptForSession = () => {
        queueSessionsYieldInterruptMessage(activeSession);
      };
      const contextTokenBudgetForGuard = Math.max(
        1,
        Math.floor(
          params.contextTokenBudget ??
            params.model.contextWindow ??
            params.model.maxTokens ??
            DEFAULT_CONTEXT_TOKENS,
        ),
      );
      const toolResultMaxCharsForGuard = resolveLiveToolResultMaxChars({
        contextWindowTokens: contextTokenBudgetForGuard,
        cfg: params.config,
        agentId: sessionAgentId,
      });
      const midTurnPrecheckEnabled =
        params.config?.agents?.defaults?.compaction?.midTurnPrecheck?.enabled === true;
      let pendingMidTurnPrecheckRequest: MidTurnPrecheckRequest | null = null;
      const onMidTurnPrecheck = (request: MidTurnPrecheckRequest) => {
        pendingMidTurnPrecheckRequest = request;
      };
      const midTurnPrecheckOptions = midTurnPrecheckEnabled
        ? {
            midTurnPrecheck: {
              enabled: true,
              contextTokenBudget: contextTokenBudgetForGuard,
              reserveTokens: () => settingsManager.getCompactionReserveTokens(),
              toolResultMaxChars: toolResultMaxCharsForGuard,
              getSystemPrompt: () => systemPromptText,
              getPrePromptMessageCount: () => prePromptMessageCount,
              onMidTurnPrecheck,
            },
          }
        : {};
      if (activeContextEngine?.info.ownsCompaction === true) {
        const removeContextEngineLoopHook = installContextEngineLoopHook({
          agent: activeSession.agent,
          contextEngine: activeContextEngine,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          sessionFile: params.sessionFile,
          tokenBudget: params.contextTokenBudget,
          modelId: params.modelId,
          getPrePromptMessageCount: () => prePromptMessageCount,
          onAfterTurnCheckpoint: (messageCount) => {
            contextEngineAfterTurnCheckpoint = messageCount;
          },
          getRuntimeContext: ({ messages, prePromptMessageCount: loopPrePromptMessageCount }) =>
            buildAfterTurnRuntimeContext({
              attempt: params,
              workspaceDir: effectiveWorkspace,
              cwd: effectiveCwd,
              agentDir,
              tokenBudget: params.contextTokenBudget,
              promptCache:
                promptCache ??
                buildLoopPromptCacheInfo({
                  messagesSnapshot: messages,
                  prePromptMessageCount: loopPrePromptMessageCount,
                  retention: effectivePromptCacheRetention,
                  fallbackLastCacheTouchAt: readLastCacheTtlTimestamp(sessionManager, {
                    provider: params.provider,
                    modelId: params.modelId,
                  }),
                }),
            }),
        });
        const removeGuard = installToolResultContextGuard({
          agent: activeSession.agent,
          contextWindowTokens: contextTokenBudgetForGuard,
          ...midTurnPrecheckOptions,
        });
        removeToolResultContextGuard = () => {
          removeGuard();
          removeContextEngineLoopHook();
        };
      } else {
        removeToolResultContextGuard = installToolResultContextGuard({
          agent: activeSession.agent,
          contextWindowTokens: contextTokenBudgetForGuard,
          ...midTurnPrecheckOptions,
        });
      }
      const removeLoopContextGuard = removeToolResultContextGuard;
      const removeHistoryImagePruneContextTransform = installHistoryImagePruneContextTransform(
        activeSession.agent,
      );
      removeToolResultContextGuard = () => {
        removeHistoryImagePruneContextTransform();
        removeLoopContextGuard?.();
      };
      const cacheTrace = createCacheTrace({
        cfg: params.config,
        env: process.env,
        runId: params.runId,
        sessionId: activeSession.sessionId,
        sessionKey: params.sessionKey,
        provider: params.provider,
        modelId: params.modelId,
        modelApi: params.model.api,
        workspaceDir: params.workspaceDir,
      });
      const anthropicPayloadLogger = createAnthropicPayloadLogger({
        env: process.env,
        runId: params.runId,
        sessionId: activeSession.sessionId,
        sessionKey: params.sessionKey,
        provider: params.provider,
        modelId: params.modelId,
        modelApi: params.model.api,
        workspaceDir: params.workspaceDir,
      });
      trajectoryRecorder = createTrajectoryRuntimeRecorder({
        cfg: params.config,
        env: process.env,
        runId: params.runId,
        sessionId: activeSession.sessionId,
        sessionKey: params.sessionKey,
        sessionFile: params.sessionFile,
        provider: params.provider,
        modelId: params.modelId,
        modelApi: params.model.api,
        workspaceDir: params.workspaceDir,
      });
      trajectoryRecorder?.recordEvent("session.started", {
        trigger: params.trigger,
        sessionFile: params.sessionFile,
        workspaceDir: effectiveWorkspace,
        agentId: sessionAgentId,
        messageProvider: params.messageProvider,
        messageChannel: params.messageChannel,
        localModelLean: isLocalModelLeanEnabled({
          config: params.config,
          agentId: sessionAgentId,
        }),
        toolCount: effectiveTools.length,
        clientToolCount: clientToolDefs.length,
      });
      trajectoryRecorder?.recordEvent(
        "trace.metadata",
        buildTrajectoryRunMetadata({
          env: process.env,
          config: params.config,
          workspaceDir: effectiveWorkspace,
          sessionFile: params.sessionFile,
          sessionKey: params.sessionKey,
          agentId: sessionAgentId,
          trigger: params.trigger,
          messageProvider: params.messageProvider,
          messageChannel: params.messageChannel,
          provider: params.provider,
          modelId: params.modelId,
          modelApi: params.model.api,
          timeoutMs: params.timeoutMs,
          fastMode: params.fastMode,
          thinkLevel: params.thinkLevel,
          reasoningLevel: params.reasoningLevel,
          toolResultFormat: params.toolResultFormat,
          disableTools: params.disableTools,
          toolsAllow: params.toolsAllow,
          skillsSnapshot: params.skillsSnapshot,
          systemPromptReport,
        }),
      );

      // Rebuild each turn from the session's original stream base so prior-turn
      // wrappers do not pin us to stale provider/API transport behavior.
      const defaultSessionStreamFn = resolveEmbeddedAgentBaseStreamFn({
        session: activeSession,
      });
      const resolvedTransport = resolveExplicitSettingsTransport({
        settingsManager,
        sessionTransport: activeSession.agent.transport,
      });
      const streamExtraParamsOverride = {
        ...params.streamParams,
        fastMode: params.fastMode,
      };
      const preparedRuntimeExtraParams = params.runtimePlan?.transport.resolveExtraParams({
        extraParamsOverride: streamExtraParamsOverride,
        thinkingLevel: params.thinkLevel,
        agentId: sessionAgentId,
        workspaceDir: effectiveWorkspace,
        model: params.model,
        resolvedTransport,
      });
      const resolvedExtraParams = resolveExtraParams({
        cfg: params.config,
        provider: params.provider,
        modelId: params.modelId,
        agentId: sessionAgentId,
      });
      const effectiveExtraParams =
        preparedRuntimeExtraParams ??
        resolvePreparedExtraParams({
          cfg: params.config,
          provider: params.provider,
          modelId: params.modelId,
          extraParamsOverride: streamExtraParamsOverride,
          thinkingLevel: params.thinkLevel,
          agentId: sessionAgentId,
          agentDir,
          workspaceDir: effectiveWorkspace,
          resolvedExtraParams,
          model: params.model,
          resolvedTransport,
        });
      const providerStreamFn = registerProviderStreamForModel({
        model: params.model,
        cfg: params.config,
        agentDir,
        workspaceDir: effectiveWorkspace,
      });
      const streamStrategy = describeEmbeddedAgentStreamStrategy({
        currentStreamFn: defaultSessionStreamFn,
        providerStreamFn,
        model: params.model,
        resolvedApiKey: params.resolvedApiKey,
      });
      activeSession.agent.streamFn = resolveEmbeddedAgentStreamFn({
        currentStreamFn: defaultSessionStreamFn,
        providerStreamFn,
        sessionId: params.sessionId,
        promptCacheKey: params.promptCacheKey,
        signal: runAbortController.signal,
        model: params.model,
        resolvedApiKey: params.resolvedApiKey,
        authProfileId: resolveAttemptStreamAuthProfileId(params),
        authStorage: params.authStorage,
      });
      const providerTextTransforms = resolveProviderTextTransforms({
        provider: params.provider,
        config: params.config,
        workspaceDir: effectiveWorkspace,
        runtimeHandle: getProviderRuntimeHandle(),
      });
      if (providerTextTransforms) {
        activeSession.agent.streamFn = wrapStreamFnTextTransforms({
          streamFn: activeSession.agent.streamFn,
          input: providerTextTransforms.input,
          output: providerTextTransforms.output,
          transformSystemPrompt: false,
        });
      }

      applyExtraParamsToAgent(
        activeSession.agent,
        params.config,
        params.provider,
        params.modelId,
        streamExtraParamsOverride,
        params.thinkLevel,
        sessionAgentId,
        effectiveWorkspace,
        params.model,
        agentDir,
        resolvedTransport,
        { preparedExtraParams: effectiveExtraParams },
      );
      if (codeModeControlsEnabledForRun) {
        activeSession.agent.streamFn = createCodexNativeWebSearchWrapper(
          activeSession.agent.streamFn,
          {
            config: params.config,
            agentDir,
            codeModeToolSurfaceEnabled: true,
          },
        );
      }
      const effectivePromptCacheRetention = resolveCacheRetention(
        effectiveExtraParams,
        params.provider,
        params.model.api,
        params.modelId,
      );
      const agentTransportOverride = resolveAgentTransportOverride({
        settingsManager,
        effectiveExtraParams,
      });
      const effectiveAgentTransport = agentTransportOverride ?? activeSession.agent.transport;
      if (agentTransportOverride && activeSession.agent.transport !== agentTransportOverride) {
        const previousTransport = activeSession.agent.transport;
        log.debug(
          `embedded agent transport override: ${previousTransport} -> ${agentTransportOverride} ` +
            `(${params.provider}/${params.modelId})`,
        );
      }
      prepStages.mark("stream-setup");
      emitPrepStageSummary("stream-ready");

      const cacheObservabilityEnabled = Boolean(cacheTrace) || log.isEnabled("debug");
      const promptCacheToolNames = collectPromptCacheToolNames(
        allCustomTools as Array<{ name?: string }>,
      );
      let promptCacheChangesForTurn: PromptCacheChange[] | null = null;

      if (cacheTrace) {
        cacheTrace.recordStage("session:loaded", {
          messages: activeSession.messages,
          system: systemPromptText,
          note: "after session create",
        });
        activeSession.agent.streamFn = cacheTrace.wrapStreamFn(activeSession.agent.streamFn);
      }

      // Anthropic Claude endpoints can reject replayed `thinking` blocks on
      // any follow-up provider call, including tool continuations. Sanitize
      // outbound messages where policy allows rewriting; otherwise preserve
      // latest thinking and let the recovery wrapper retry once without it.
      if (transcriptPolicy.dropThinkingBlocks || transcriptPolicy.dropReasoningFromHistory) {
        activeSession.agent.streamFn = wrapStreamFnWithMessageTransform(
          activeSession.agent.streamFn,
          (messages) => {
            const reasoningSanitized = transcriptPolicy.dropReasoningFromHistory
              ? dropReasoningFromHistory(messages)
              : messages;
            return transcriptPolicy.dropThinkingBlocks
              ? dropThinkingBlocks(reasoningSanitized)
              : reasoningSanitized;
          },
        );
      }
      if (
        transcriptPolicy.preserveSignatures ||
        transcriptPolicy.dropThinkingBlocks ||
        transcriptPolicy.dropReasoningFromHistory
      ) {
        activeSession.agent.streamFn = wrapAnthropicStreamWithRecovery(
          activeSession.agent.streamFn,
          {
            id: activeSession.sessionId,
          },
        );
      }

      // Mistral (and other strict providers) reject tool call IDs that don't match their
      // format requirements (e.g. [a-zA-Z0-9]{9}). sanitizeSessionHistory only processes
      // historical messages at attempt start, but the agent loop's internal tool call →
      // tool result cycles bypass that path. Wrap streamFn so every outbound request
      // sees sanitized tool call IDs.
      const isOpenAIResponsesApi =
        params.model.api === "openai-responses" ||
        params.model.api === "azure-openai-responses" ||
        params.model.api === "openai-chatgpt-responses";

      const replayToolCallIdSanitizerDecision = {
        sanitizeToolCallIds: transcriptPolicy.sanitizeToolCallIds,
        toolCallIdMode: transcriptPolicy.toolCallIdMode,
        isOpenAIResponsesApi,
      };
      if (shouldApplyReplayToolCallIdSanitizer(replayToolCallIdSanitizerDecision)) {
        const mode = replayToolCallIdSanitizerDecision.toolCallIdMode;
        activeSession.agent.streamFn = wrapStreamFnWithMessageTransform(
          activeSession.agent.streamFn,
          (messages, model) =>
            sanitizeReplayToolCallIdsForStream({
              messages,
              mode,
              allowedToolNames: replayAllowedToolNames,
              preserveNativeAnthropicToolUseIds: transcriptPolicy.preserveNativeAnthropicToolUseIds,
              preserveReplaySafeThinkingToolCallIds: shouldAllowProviderOwnedThinkingReplay({
                modelApi: (model as { api?: unknown })?.api as string | null | undefined,
                provider: params.provider,
                policy: transcriptPolicy,
              }),
              repairToolUseResultPairing: transcriptPolicy.repairToolUseResultPairing,
            }),
        );
      }

      if (isOpenAIResponsesApi) {
        activeSession.agent.streamFn = wrapStreamFnWithMessageTransform(
          activeSession.agent.streamFn,
          (messages) => sanitizeOpenAIResponsesReplayForStream(messages),
        );
      }

      const innerStreamFn = activeSession.agent.streamFn;
      activeSession.agent.streamFn = (model, context, options) => {
        const signal = runAbortController.signal as AbortSignal & { reason?: unknown };
        if (yieldDetected && signal.aborted && signal.reason === "sessions_yield") {
          return createYieldAbortedResponse(model) as unknown as Awaited<
            ReturnType<typeof innerStreamFn>
          >;
        }
        return innerStreamFn(model, context, options);
      };

      // Some models emit tool names with surrounding whitespace (e.g. " read ").
      // agent runtime dispatches tool calls with exact string matching, so normalize
      // names on the live response stream before tool execution.
      activeSession.agent.streamFn = wrapStreamFnSanitizeMalformedToolCalls(
        activeSession.agent.streamFn,
        allowedToolNames,
        transcriptPolicy,
        params.provider,
      );
      activeSession.agent.streamFn = wrapStreamFnPromoteStandaloneTextToolCalls(
        activeSession.agent.streamFn,
        allowedToolNames,
      );
      activeSession.agent.streamFn = wrapStreamFnTrimToolCallNames(
        activeSession.agent.streamFn,
        allowedToolNames,
        {
          unknownToolThreshold: resolveUnknownToolGuardThreshold(clientToolLoopDetection),
        },
      );

      if (
        shouldRepairMalformedToolCallArguments({
          provider: params.provider,
          modelApi: params.model.api,
        })
      ) {
        activeSession.agent.streamFn = wrapStreamFnRepairMalformedToolCallArguments(
          activeSession.agent.streamFn,
        );
      }

      if (resolveToolCallArgumentsEncoding(params.model) === "html-entities") {
        activeSession.agent.streamFn = wrapStreamFnDecodeXaiToolCallArguments(
          activeSession.agent.streamFn,
        );
      }

      if (anthropicPayloadLogger) {
        activeSession.agent.streamFn = anthropicPayloadLogger.wrapStreamFn(
          activeSession.agent.streamFn,
        );
      }
      // Anthropic-compatible providers can add new stop reasons before shared model runtime maps them.
      // Recover the known "sensitive" stop reason here so a model refusal does not
      // bubble out as an uncaught runner error and stall channel polling.
      activeSession.agent.streamFn = wrapStreamFnHandleSensitiveStopReason(
        activeSession.agent.streamFn,
      );

      // Wrap stream with idle timeout detection.
      //
      // Prefer the caller's explicit `runTimeoutOverrideMs` when provided —
      // it carries the "this run was launched with a deliberate per-run
      // timeout" signal without losing it when the value numerically equals
      // `agents.defaults.timeoutSeconds`. Fall back to the value-equality
      // heuristic for callers that haven't been migrated to plumb the flag.
      const configuredRunTimeoutMs = resolveAgentTimeoutMs({
        cfg: params.config,
      });
      const resolvedRunTimeoutMs =
        params.runTimeoutOverrideMs ??
        (params.timeoutMs !== configuredRunTimeoutMs ? params.timeoutMs : undefined);
      const idleTimeoutMs = resolveLlmIdleTimeoutMs({
        cfg: params.config,
        trigger: params.trigger,
        runTimeoutMs: resolvedRunTimeoutMs,
        modelRequestTimeoutMs: (params.model as { requestTimeoutMs?: number }).requestTimeoutMs,
        model: params.model as { baseUrl?: string },
      });
      if (idleTimeoutMs > 0) {
        activeSession.agent.streamFn = streamWithIdleTimeout(
          activeSession.agent.streamFn,
          idleTimeoutMs,
          (error) => idleTimeoutTrigger?.(error),
        );
      }
      let diagnosticModelCallSeq = 0;
      activeSession.agent.streamFn = wrapStreamFnWithDiagnosticModelCallEvents(
        activeSession.agent.streamFn,
        {
          runId: params.runId,
          ...(params.sessionKey && { sessionKey: params.sessionKey }),
          ...(params.sessionId && { sessionId: params.sessionId }),
          provider: params.provider,
          model: params.modelId,
          api: params.model.api,
          transport: effectiveAgentTransport,
          ...(params.contextWindowInfo?.tokens
            ? { contextTokenBudget: params.contextWindowInfo.tokens }
            : {}),
          ...(params.contextWindowInfo?.source
            ? { contextWindowSource: params.contextWindowInfo.source }
            : {}),
          ...(params.contextWindowInfo?.referenceTokens
            ? { contextWindowReferenceTokens: params.contextWindowInfo.referenceTokens }
            : {}),
          trace: runTrace,
          contentCapture: resolveDiagnosticModelContentCapturePolicy(params.config),
          nextCallId: () => `${params.runId}:model:${(diagnosticModelCallSeq += 1)}`,
          onStarted: () => {
            params.onExecutionPhase?.({
              phase: "model_call_started",
              provider: params.provider,
              model: params.modelId,
              firstModelCallStarted: true,
            });
          },
        },
      );

      try {
        if (isRawModelRun) {
          activeSession.agent.reset();
          setActiveSessionSystemPrompt("");
          cacheTrace?.recordStage("session:raw-model-run", {
            messages: activeSession.messages,
            system: systemPromptText,
          });
        } else {
          const prior = await sanitizeSessionHistory({
            messages: activeSession.messages,
            modelApi: params.model.api,
            modelId: params.modelId,
            provider: params.provider,
            allowedToolNames: replayAllowedToolNames,
            config: params.config,
            workspaceDir: effectiveWorkspace,
            env: process.env,
            model: params.model,
            sessionManager,
            sessionId: params.sessionId,
            policy: transcriptPolicy,
          });
          cacheTrace?.recordStage("session:sanitized", { messages: prior });
          const validated = await validateReplayTurns({
            messages: prior,
            modelApi: params.model.api,
            modelId: params.modelId,
            provider: params.provider,
            config: params.config,
            workspaceDir: effectiveWorkspace,
            env: process.env,
            model: params.model,
            sessionId: params.sessionId,
            policy: transcriptPolicy,
          });

          if (params.sessionKey && !isRawModelRun) {
            const storePath = resolveStorePath(params.config?.session?.store, {
              agentId: sessionAgentId,
            });
            await runQuotaSuspensionMaintenance({ storePath });
            const store = loadSessionStore(storePath, { skipCache: true });
            const sessionEntry = store[params.sessionKey];
            const suspension = sessionEntry?.quotaSuspension;
            if (suspension?.state === "resuming") {
              const subagents = Object.values(store)
                .filter((s) => s.spawnedBy === sessionEntry.sessionId)
                .map((s) => ({
                  sessionId: s.sessionId,
                  role: s.subagentRole,
                  lastStatus: s.status,
                }));
              const handoffMsg = buildHierarchyReinforcementMessage({
                summary: suspension.summary ?? "No recovery briefing was captured.",
                activeSubagents: subagents,
              });
              validated.push(handoffMsg);
              await updateSessionStoreEntry({
                storePath,
                sessionKey: params.sessionKey,
                skipMaintenance: true,
                takeCacheOwnership: true,
                update: async (entry) => {
                  if (entry.quotaSuspension?.state !== "resuming") {
                    return null;
                  }
                  return {
                    quotaSuspension: { ...entry.quotaSuspension, state: "active" },
                  };
                },
              });
            }
          }

          if (params.sessionKey && params.config && !isRawModelRun) {
            const activeSubagentPromptAddition = buildActiveSubagentSystemPromptAddition({
              cfg: params.config,
              controllerSessionKey: params.sessionKey,
              hasSessionsYield: effectiveTools.some((tool) => tool.name === "sessions_yield"),
            });
            if (activeSubagentPromptAddition) {
              setActiveSessionSystemPrompt(
                prependSystemPromptAddition({
                  systemPrompt: systemPromptText,
                  systemPromptAddition: activeSubagentPromptAddition,
                }),
              );
            }
          }

          const heartbeatSummary =
            params.config && sessionAgentId
              ? resolveHeartbeatSummaryForAgent(params.config, sessionAgentId)
              : undefined;
          const heartbeatFiltered = filterHeartbeatTranscriptArtifacts(
            validated,
            heartbeatSummary?.ackMaxChars,
            heartbeatSummary?.prompt,
          );
          const truncated = limitHistoryTurns(
            heartbeatFiltered,
            getHistoryLimitFromSessionKey(params.sessionKey, params.config),
          );
          // Re-run tool_use/tool_result pairing repair after truncation, since
          // limitHistoryTurns can orphan tool_result blocks by removing the
          // assistant message that contained the matching tool_use.
          const limited = transcriptPolicy.repairToolUseResultPairing
            ? sanitizeToolUseResultPairing(truncated, {
                erroredAssistantResultPolicy: "drop",
                ...(isOpenAIResponsesApi ? { missingToolResultText: "aborted" } : {}),
              })
            : truncated;
          cacheTrace?.recordStage("session:limited", { messages: limited });
          if (limited.length > 0 || prior.length > 0) {
            activeSession.agent.state.messages = limited;
          }
        }

        if (activeContextEngine) {
          try {
            // Snapshot before assemble: the assemble contract does not require
            // the input array to be treated immutably, so an engine that windows
            // history in place would otherwise leave the precheck reading
            // already-windowed messages instead of the true pre-assembly state.
            const preassemblyContextEngineMessagesForPrecheck = activeSession.messages.slice();
            const assembled = await assembleAttemptContextEngine({
              contextEngine: activeContextEngine,
              sessionId: params.sessionId,
              sessionKey: params.sessionKey,
              messages: activeSession.messages,
              tokenBudget: params.contextTokenBudget,
              availableTools: new Set(effectiveTools.map((tool) => tool.name)),
              citationsMode: params.config?.memory?.citations,
              modelId: params.modelId,
              ...(params.prompt !== undefined ? { prompt: params.prompt } : {}),
            });
            if (!assembled) {
              throw new Error("context engine assemble returned no result");
            }
            if (assembled.messages !== activeSession.messages) {
              activeSession.agent.state.messages = assembled.messages;
            }
            contextEnginePromptAuthority = assembled.promptAuthority ?? "assembled";
            if (contextEnginePromptAuthority === "preassembly_may_overflow") {
              unwindowedContextEngineMessagesForPrecheck =
                preassemblyContextEngineMessagesForPrecheck;
            }
            if (assembled.systemPromptAddition) {
              setActiveSessionSystemPrompt(
                prependSystemPromptAddition({
                  systemPrompt: systemPromptText,
                  systemPromptAddition: assembled.systemPromptAddition,
                }),
              );
              log.debug(
                `context engine: prepended system prompt addition (${assembled.systemPromptAddition.length} chars)`,
              );
            }
          } catch (assembleErr) {
            log.warn(
              `context engine assemble failed, using pipeline messages: ${String(assembleErr)}`,
            );
          }
        }
      } catch (err) {
        await flushPendingToolResultsAfterIdle({
          agent: activeSession?.agent,
          sessionManager,
          // PERF: If the run was aborted during the setup,
          // skip the idle wait and flush pending results synchronously so we can
          // immediately dispose the session without orphaning tool calls.
          ...(params.abortSignal?.aborted ? { timeoutMs: 0 } : {}),
        });
        activeSession.dispose();
        throw err;
      }

      let yieldAborted = false;
      const abortCompaction = () => {
        if (!activeSession.isCompacting) {
          return;
        }
        try {
          activeSession.abortCompaction();
        } catch (err) {
          if (!isProbeSession) {
            log.warn(
              `embedded run abortCompaction failed: runId=${params.runId} sessionId=${params.sessionId} err=${String(err)}`,
            );
          }
        }
      };
      const abortRun = (isTimeout = false, reason?: unknown) => {
        aborted = true;
        if (isTimeout) {
          timedOut = true;
          if (!timedOutDuringCompaction && countActiveToolExecutions(params.runId) > 0) {
            timedOutDuringToolExecution = true;
          }
        }
        if (isTimeout) {
          runAbortController.abort(reason ?? makeTimeoutAbortReason());
        } else {
          runAbortController.abort(reason);
        }
        abortCompaction();
        void abortActiveSession();
        if (isTimeout && queueHandleForAbandonment) {
          markActiveEmbeddedRunAbandoned({
            sessionId: params.sessionId,
            handle: queueHandleForAbandonment,
            sessionKey: params.sessionKey,
            sessionFile: params.sessionFile,
            reason: "timeout",
          });
        }
        releaseEmbeddedAttemptSessionLockForAbort({
          sessionLockController,
          log,
          runId: params.runId,
          abortKind: isTimeout ? "timeout abort" : "abort",
        });
      };
      abortRunForExternalSignal = abortRun;
      const idleTimeoutTrigger: ((error: Error) => void) | undefined = (error) => {
        idleTimedOut = true;
        abortRun(true, error);
      };
      const abortable = <T>(promise: Promise<T>): Promise<T> =>
        abortableWithSignal(runAbortController.signal, promise);
      const ownedTranscriptWriteContext = {
        sessionFile: params.sessionFile,
        sessionKey: params.sessionKey,
        withSessionWriteLock: <T>(
          operation: () => Promise<T> | T,
          options?: { publishOwnedWrite?: boolean },
        ) => sessionLockController.withSessionWriteLock(operation, options),
      };
      const promptActiveSession = (
        prompt: string,
        options?: Parameters<typeof activeSession.prompt>[1],
      ): Promise<void> =>
        withOwnedSessionTranscriptWrites(ownedTranscriptWriteContext, async () =>
          abortable(trackPromptSettlePromise(activeSession.prompt(prompt, options))),
        );
      const onBlockReply = params.onBlockReply
        ? bindOwnedSessionTranscriptWrites(ownedTranscriptWriteContext, params.onBlockReply)
        : undefined;
      const onBlockReplyFlush = params.onBlockReplyFlush
        ? bindOwnedSessionTranscriptWrites(ownedTranscriptWriteContext, params.onBlockReplyFlush)
        : undefined;

      let toolMetasForTerminal: readonly AsyncStartedToolMeta[] = [];
      const subscription = subscribeEmbeddedAgentSession(
        buildEmbeddedSubscriptionParams({
          session: activeSession,
          runId: params.runId,
          messageChannel: runtimeChannel,
          initialReplayState: params.initialReplayState,
          hookRunner: getGlobalHookRunner() ?? undefined,
          verboseLevel: params.verboseLevel,
          reasoningMode: params.reasoningLevel ?? "off",
          thinkingLevel: params.thinkLevel,
          toolResultFormat: params.toolResultFormat,
          shouldEmitToolResult: params.shouldEmitToolResult,
          shouldEmitToolOutput: params.shouldEmitToolOutput,
          sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
          onToolResult: params.onToolResult,
          onReasoningStream: params.onReasoningStream,
          onReasoningEnd: params.onReasoningEnd,
          onBlockReply,
          onBlockReplyFlush,
          blockReplyBreak: params.blockReplyBreak,
          blockReplyChunking: params.blockReplyChunking,
          onPartialReply: params.onPartialReply,
          onAssistantMessageStart: params.onAssistantMessageStart,
          onExecutionPhase: params.onExecutionPhase,
          onAgentEvent: params.onAgentEvent,
          terminalLifecyclePhase: params.deferTerminalLifecycleEnd ? "finishing" : "end",
          onBeforeLifecycleTerminal: () => {
            if (
              requiresCompletionRequiredAsyncTaskWait({
                sessionKey: params.sessionKey,
                toolMetas: toolMetasForTerminal,
              })
            ) {
              return;
            }
            // Clear embedded-run activity before emitting terminal lifecycle events so
            // post-completion cleanup does not observe a logically finished run as active.
            clearActiveEmbeddedRun(
              params.sessionId,
              queueHandle,
              params.sessionKey,
              params.sessionFile,
            );
          },
          enforceFinalTag: params.enforceFinalTag,
          silentExpected: params.silentExpected,
          config: params.config,
          sessionKey: sandboxSessionKey,
          sessionId: params.sessionId,
          agentId: sessionAgentId,
          builtinToolNames,
          internalEvents: params.internalEvents,
        }),
      );

      const {
        assistantTexts,
        toolMetas,
        getAcceptedSessionSpawns,
        runToolLifecycle,
        unsubscribe,
        waitForCompactionRetry,
        isCompactionInFlight,
        getItemLifecycle,
        getMessagingToolSentTexts,
        getMessagingToolSentMediaUrls,
        getMessagingToolSentTargets,
        getMessagingToolSourceReplyPayloads,
        getHeartbeatToolResponse,
        getPendingToolMediaReply,
        getVisibleBlockReplyCount,
        getSuccessfulCronAdds,
        getReplayState,
        didSendViaMessagingTool,
        didSendDeterministicApprovalPrompt,
        getLastToolError,
        setTerminalLifecycleMeta,
        getUsageTotals,
        getCompactionCount,
        getLastCompactionTokensAfter,
      } = subscription;
      toolMetasForTerminal = toolMetas;
      isCompactionPendingForExternalSignal = subscription.isCompacting;
      isCompactionInFlightForExternalSignal = () => activeSession.isCompacting;
      toolSearchCatalogExecutor = async (toolParams) => {
        try {
          const result = await runToolLifecycle({
            toolName: toolParams.toolName,
            toolCallId: toolParams.toolCallId,
            args: toolParams.input,
            execute: async () =>
              await toolParams.tool.execute(
                toolParams.toolCallId,
                toolParams.input,
                toolParams.signal ?? runAbortController.signal,
                toolParams.onUpdate,
                undefined as never,
              ),
          });
          toolSearchTargetTranscriptProjections.push({
            parentToolCallId: toolParams.parentToolCallId,
            toolCallId: toolParams.toolCallId,
            toolName: toolParams.toolName,
            input: toolParams.input,
            result,
            timestamp: Date.now(),
          });
          return result;
        } catch (error) {
          const message = formatErrorMessage(error);
          toolSearchTargetTranscriptProjections.push({
            parentToolCallId: toolParams.parentToolCallId,
            toolCallId: toolParams.toolCallId,
            toolName: toolParams.toolName,
            input: toolParams.input,
            result: {
              content: [{ type: "text", text: message }],
              details: { status: "error", error: message },
            },
            isError: true,
            timestamp: Date.now(),
          });
          throw error;
        }
      };

      const abortActiveRunExternally = () => {
        externalAbort = true;
        abortRun();
      };
      const queueHandle: EmbeddedAgentQueueHandle & {
        kind: "embedded";
        cancel: (reason?: "user_abort" | "restart" | "superseded") => void;
      } = {
        kind: "embedded",
        queueMessage: async (text: string, options) => {
          if (options?.steeringMode) {
            activeSession.agent.steeringMode = options.steeringMode;
          }
          await steerActiveSessionWithOptionalDeliveryWait(activeSession, text, options);
        },
        isStreaming: () => activeSession.isStreaming,
        isCompacting: () => subscription.isCompacting(),
        supportsTranscriptCommitWait: true,
        sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
        cancel: abortActiveRunExternally,
        abort: abortActiveRunExternally,
      };
      let lastAssistant: AssistantMessage | undefined;
      let currentAttemptAssistant: EmbeddedRunAttemptResult["currentAttemptAssistant"];
      let attemptUsage: NormalizedUsage | undefined;
      let cacheBreak: PromptCacheBreak | null = null;
      let promptCache: EmbeddedRunAttemptResult["promptCache"];
      let lastCallUsage: NormalizedUsage | undefined;
      let contextBudgetStatus: EmbeddedRunAttemptResult["contextBudgetStatus"];
      let compactionOccurredThisAttempt = false;
      let finalPromptText: string | undefined;
      if (params.replyOperation) {
        params.replyOperation.attachBackend(queueHandle);
      }
      const queueHandleForAbandonment: EmbeddedAgentQueueHandle | undefined = queueHandle;
      setActiveEmbeddedRun(params.sessionId, queueHandle, params.sessionKey, params.sessionFile);

      let abortWarnTimer: NodeJS.Timeout | undefined;
      const isProbeSession = params.sessionId?.startsWith("probe-") ?? false;
      let abortTimer: NodeJS.Timeout | undefined;
      let runAbortDeadlineAtMs = Date.now() + params.timeoutMs;
      let compactionGraceUsed = false;
      const scheduleAbortTimer = (delayMs: number, reason: "initial" | "compaction-grace") => {
        runAbortDeadlineAtMs = Date.now() + Math.max(1, delayMs);
        abortTimer = setTimeout(
          () => {
            const timeoutAction = resolveRunTimeoutDuringCompaction({
              isCompactionPendingOrRetrying: subscription.isCompacting(),
              isCompactionInFlight: activeSession.isCompacting,
              graceAlreadyUsed: compactionGraceUsed,
            });
            if (timeoutAction === "extend") {
              compactionGraceUsed = true;
              if (!isProbeSession) {
                log.warn(
                  `embedded run timeout reached during compaction; extending deadline: ` +
                    `runId=${params.runId} sessionId=${params.sessionId} extraMs=${compactionTimeoutMs}`,
                );
              }
              scheduleAbortTimer(compactionTimeoutMs, "compaction-grace");
              return;
            }

            if (!isProbeSession) {
              log.warn(
                reason === "compaction-grace"
                  ? `embedded run timeout after compaction grace: runId=${params.runId} sessionId=${params.sessionId} timeoutMs=${params.timeoutMs} compactionGraceMs=${compactionTimeoutMs}`
                  : `embedded run timeout: runId=${params.runId} sessionId=${params.sessionId} timeoutMs=${params.timeoutMs}`,
              );
            }
            if (
              shouldFlagCompactionTimeout({
                isTimeout: true,
                isCompactionPendingOrRetrying: subscription.isCompacting(),
                isCompactionInFlight: activeSession.isCompacting,
              })
            ) {
              timedOutDuringCompaction = true;
            }
            abortRun(true);
            if (!abortWarnTimer) {
              abortWarnTimer = setTimeout(() => {
                if (!activeSession.isStreaming) {
                  return;
                }
                if (!isProbeSession) {
                  log.warn(
                    `embedded run abort still streaming: runId=${params.runId} sessionId=${params.sessionId}`,
                  );
                }
              }, 10_000);
            }
          },
          Math.max(1, delayMs),
        );
      };
      scheduleAbortTimer(params.timeoutMs, "initial");

      let messagesSnapshot: AgentMessage[] = [];
      let sessionIdUsed = activeSession.sessionId;
      let sessionFileUsed: string | undefined = params.sessionFile;
      const onAbort = () => {
        externalAbort = true;
        const reason = params.abortSignal ? getAbortReason(params.abortSignal) : undefined;
        const timeout = reason ? isTimeoutError(reason) : false;
        if (
          shouldFlagCompactionTimeout({
            isTimeout: timeout,
            isCompactionPendingOrRetrying: subscription.isCompacting(),
            isCompactionInFlight: activeSession.isCompacting,
          })
        ) {
          timedOutDuringCompaction = true;
        }
        abortRun(timeout, reason);
      };
      if (params.abortSignal) {
        if (params.abortSignal.aborted) {
          onAbort();
        } else {
          params.abortSignal.addEventListener("abort", onAbort, {
            once: true,
          });
        }
      }

      // Hook runner was already obtained earlier before tool creation
      const hookAgentId = sessionAgentId;

      const activeSessionManager = sessionManager;
      let preflightRecovery: EmbeddedRunAttemptResult["preflightRecovery"];
      let promptErrorSource: EmbeddedRunAttemptResult["promptErrorSource"] = null;
      const handleMidTurnPrecheckRequest = (request: MidTurnPrecheckRequest) => {
        const logMidTurnPrecheck = (route: string, extra?: string) => {
          log.warn(
            `[context-overflow-midturn-precheck] sessionKey=${params.sessionKey ?? params.sessionId} ` +
              `provider=${params.provider}/${params.modelId} route=${route} ` +
              `estimatedPromptTokens=${request.estimatedPromptTokens} ` +
              `promptBudgetBeforeReserve=${request.promptBudgetBeforeReserve} ` +
              `overflowTokens=${request.overflowTokens} ` +
              `toolResultReducibleChars=${request.toolResultReducibleChars} ` +
              `effectiveReserveTokens=${request.effectiveReserveTokens} ` +
              `prePromptMessageCount=${prePromptMessageCount} ` +
              (extra ? `${extra} ` : "") +
              `sessionFile=${params.sessionFile}`,
          );
        };
        if (request.route === "truncate_tool_results_only") {
          const contextTokenBudget = params.contextTokenBudget ?? DEFAULT_CONTEXT_TOKENS;
          const toolResultMaxChars = resolveLiveToolResultMaxChars({
            contextWindowTokens: contextTokenBudget,
            cfg: params.config,
            agentId: sessionAgentId,
          });
          const truncationResult = truncateOversizedToolResultsInSessionManager({
            sessionManager: activeSessionManager,
            contextWindowTokens: contextTokenBudget,
            maxCharsOverride: toolResultMaxChars,
            sessionFile: params.sessionFile,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            agentId: sessionAgentId,
          });
          if (truncationResult.truncated) {
            preflightRecovery = {
              route: "truncate_tool_results_only",
              source: "mid-turn",
              handled: true,
              truncatedCount: truncationResult.truncatedCount,
            };
            const sessionContext = activeSessionManager.buildSessionContext();
            activeSession.agent.state.messages = sessionContext.messages;
            logMidTurnPrecheck(
              request.route,
              `handled=true truncatedCount=${truncationResult.truncatedCount}`,
            );
          } else {
            preflightRecovery = { route: "compact_only", source: "mid-turn" };
            promptError = new Error(PREEMPTIVE_OVERFLOW_ERROR_TEXT);
            promptErrorSource = "precheck";
            logMidTurnPrecheck(
              "compact_only",
              `truncateFallbackReason=${truncationResult.reason ?? "unknown"}`,
            );
          }
        } else {
          preflightRecovery = { route: request.route, source: "mid-turn" };
          promptError = new Error(PREEMPTIVE_OVERFLOW_ERROR_TEXT);
          promptErrorSource = "precheck";
          logMidTurnPrecheck(request.route);
        }
      };
      let skipPromptSubmission = false;
      let leasedSteering:
        | {
            leaseId: string;
            runIds: readonly string[];
          }
        | undefined;
      const releaseLeasedSteering = (error?: unknown) => {
        if (!leasedSteering) {
          return;
        }
        releasePendingAgentSteeringItems({
          runIds: leasedSteering.runIds,
          leaseId: leasedSteering.leaseId,
          error: error ? formatErrorMessage(error) : undefined,
        });
        leasedSteering = undefined;
      };
      try {
        const promptStartedAt = Date.now();
        if (emptyExplicitToolAllowlistError) {
          promptError = emptyExplicitToolAllowlistError;
          promptErrorSource = "precheck";
          skipPromptSubmission = true;
          log.warn(`[tools] ${emptyExplicitToolAllowlistError.message}`);
        }

        // Run before_prompt_build hooks to allow plugins to inject prompt context.
        // Legacy compatibility: before_agent_start is also checked for context fields.
        let effectivePrompt = params.prompt;
        const hookCtx = {
          runId: params.runId,
          trace: freezeDiagnosticTraceContext(diagnosticTrace),
          agentId: hookAgentId,
          sessionKey: params.sessionKey,
          sessionId: params.sessionId,
          workspaceDir: params.workspaceDir,
          modelProviderId: params.model.provider,
          modelId: params.model.id,
          trigger: params.trigger,
          ...buildAgentHookContextChannelFields(params),
        };
        const promptBuildMessages =
          pruneProcessedHistoryImages(activeSession.messages) ?? activeSession.messages;
        const hookResult = isRawModelRun
          ? undefined
          : await resolvePromptBuildHookResult({
              config: params.config ?? getRuntimeConfig(),
              prompt: params.prompt,
              messages: promptBuildMessages,
              hookCtx,
              hookRunner,
              beforeAgentStartResult: params.beforeAgentStartResult,
            });
        const promptBeforePromptBuildHooks = effectivePrompt;
        const promptBuildPrependContext = hookResult?.prependContext;
        const promptBuildAppendContext = hookResult?.appendContext;
        const hasPromptBuildContext =
          Boolean(promptBuildPrependContext?.trim()) || Boolean(promptBuildAppendContext?.trim());
        {
          if (hookResult?.prependContext) {
            effectivePrompt = `${hookResult.prependContext}\n\n${effectivePrompt}`;
            log.debug(
              `hooks: prepended context to prompt (${hookResult.prependContext.length} chars)`,
            );
          }
          if (hookResult?.appendContext) {
            effectivePrompt = `${effectivePrompt}\n\n${hookResult.appendContext}`;
            log.debug(
              `hooks: appended context to prompt (${hookResult.appendContext.length} chars)`,
            );
          }
          const legacySystemPrompt = normalizeOptionalString(hookResult?.systemPrompt) ?? "";
          if (legacySystemPrompt) {
            setActiveSessionSystemPrompt(legacySystemPrompt);
            log.debug(`hooks: applied systemPrompt (${legacySystemPrompt.length} chars)`);
          }
          const prependedOrAppendedSystemPrompt = composeSystemPromptWithHookContext({
            baseSystemPrompt: systemPromptText,
            prependSystemContext: hookResult?.prependSystemContext,
            appendSystemContext: hookResult?.appendSystemContext,
          });
          if (prependedOrAppendedSystemPrompt) {
            const prependSystemLen = hookResult?.prependSystemContext?.trim().length ?? 0;
            const appendSystemLen = hookResult?.appendSystemContext?.trim().length ?? 0;
            setActiveSessionSystemPrompt(prependedOrAppendedSystemPrompt);
            log.debug(
              `hooks: applied prependSystemContext/appendSystemContext (${prependSystemLen}+${appendSystemLen} chars)`,
            );
          }
          const mediaTaskSystemPromptAddition = resolveAttemptMediaTaskSystemPromptAddition({
            sessionKey: params.sessionKey,
            trigger: params.trigger,
          });
          if (mediaTaskSystemPromptAddition) {
            setActiveSessionSystemPrompt(
              prependSystemPromptAddition({
                systemPrompt: ensureSystemPromptCacheBoundary(systemPromptText),
                systemPromptAddition: mediaTaskSystemPromptAddition,
              }),
            );
          }
        }
        // The model identity line is appended below; for a marker-free hook systemPrompt
        // override ensure the cache boundary first so the identity lands in the dynamic
        // suffix, not the cached prefix — otherwise an idle turn's prefix (O + identity)
        // diverges from an active media turn's prefix (O) and breaks prompt caching. Skip
        // empty prompts (raw/gateway runs) and turns with no identity line, which need none.
        const modelAwareSystemPrompt = appendModelIdentitySystemPrompt({
          systemPrompt:
            buildModelIdentityPromptLine(runtimeInfo.model) && systemPromptText.trim().length > 0
              ? ensureSystemPromptCacheBoundary(systemPromptText)
              : systemPromptText,
          model: runtimeInfo.model,
        });
        if (modelAwareSystemPrompt !== systemPromptText) {
          setActiveSessionSystemPrompt(modelAwareSystemPrompt);
        }

        if (cacheObservabilityEnabled) {
          const cacheObservation = beginPromptCacheObservation({
            sessionId: params.sessionId,
            promptCacheKey: params.promptCacheKey,
            sessionKey: params.sessionKey,
            provider: params.provider,
            modelId: params.modelId,
            modelApi: params.model.api,
            cacheRetention: effectivePromptCacheRetention,
            streamStrategy,
            transport: effectiveAgentTransport,
            systemPrompt: systemPromptText,
            toolNames: promptCacheToolNames,
          });
          promptCacheChangesForTurn = cacheObservation.changes;
          cacheTrace?.recordStage("cache:state", {
            options: {
              snapshot: cacheObservation.snapshot,
              previousCacheRead: cacheObservation.previousCacheRead ?? undefined,
              changes:
                cacheObservation.changes?.map((change) => ({
                  code: change.code,
                  detail: change.detail,
                })) ?? undefined,
            },
          });
        }

        const routingSummary = describeProviderRequestRoutingSummary({
          provider: params.provider,
          api: params.model.api,
          baseUrl: params.model.baseUrl,
          capability: "llm",
          transport: "stream",
        });
        log.debug(
          `embedded run prompt start: runId=${params.runId} sessionId=${params.sessionId} ` +
            routingSummary,
        );
        const effectiveTranscriptPrompt =
          params.transcriptPrompt === undefined ? undefined : params.transcriptPrompt;
        let transcriptPromptForRuntimeSplit = effectiveTranscriptPrompt;
        let promptForRuntimeContextSplit = promptBeforePromptBuildHooks;
        // Repair orphaned trailing user messages so new prompts don't violate role ordering.
        const leafEntry = isRawModelRun ? null : sessionManager.getLeafEntry();
        if (leafEntry?.type === "message" && leafEntry.message.role === "user") {
          const messageMergeStrategy = resolveMessageMergeStrategy();
          const orphanPromptMerge = messageMergeStrategy.mergeOrphanedTrailingUserPrompt({
            prompt: effectivePrompt,
            trigger: params.trigger,
            leafMessage: leafEntry.message,
          });
          const runtimePromptMerge = messageMergeStrategy.mergeOrphanedTrailingUserPrompt({
            prompt: promptForRuntimeContextSplit,
            trigger: params.trigger,
            leafMessage: leafEntry.message,
          });
          const transcriptPromptMerge =
            effectiveTranscriptPrompt === undefined
              ? undefined
              : messageMergeStrategy.mergeOrphanedTrailingUserPrompt({
                  prompt: effectiveTranscriptPrompt,
                  trigger: params.trigger,
                  leafMessage: leafEntry.message,
                });
          effectivePrompt = orphanPromptMerge.prompt;
          promptForRuntimeContextSplit = runtimePromptMerge.prompt;
          if (transcriptPromptMerge) {
            transcriptPromptForRuntimeSplit = transcriptPromptMerge.prompt;
          }
          if (orphanPromptMerge.removeLeaf) {
            if (leafEntry.parentId) {
              sessionManager.branch(leafEntry.parentId);
            } else {
              sessionManager.resetLeaf();
            }
            const sessionContext = sessionManager.buildSessionContext();
            activeSession.agent.state.messages = sessionContext.messages;
          }
          const orphanRepairMessage =
            `${
              orphanPromptMerge.removeLeaf
                ? orphanPromptMerge.merged
                  ? "Merged and removed"
                  : "Removed already-queued"
                : "Preserved"
            } orphaned user message` +
            (orphanPromptMerge.removeLeaf
              ? " to prevent consecutive user turns. "
              : " without removing the active session leaf. ") +
            `runId=${params.runId} sessionId=${params.sessionId} trigger=${params.trigger}`;
          if (shouldWarnOnOrphanedUserRepair(params.trigger)) {
            log.warn(orphanRepairMessage);
          } else {
            log.debug(orphanRepairMessage);
          }
        }
        if (params.sessionKey && !isRawModelRun) {
          const leaseId = `${params.runId}:agent-steering`;
          const leased = leasePendingAgentSteeringItems({
            requesterSessionKey: params.sessionKey,
            leaseId,
          });
          if (leased) {
            leasedSteering = {
              leaseId,
              runIds: leased.runIds,
            };
            effectivePrompt = prependAgentSteeringPrompt({
              steeringPrompt: leased.prompt,
              prompt: effectivePrompt,
            });
            promptForRuntimeContextSplit = prependAgentSteeringPrompt({
              steeringPrompt: leased.prompt,
              prompt: promptForRuntimeContextSplit,
            });
            if (transcriptPromptForRuntimeSplit !== undefined) {
              transcriptPromptForRuntimeSplit = prependAgentSteeringPrompt({
                steeringPrompt: leased.prompt,
                prompt: transcriptPromptForRuntimeSplit,
              });
            }
            log.debug(
              `agent steering: injected ${leased.runIds.length} queued item(s) into parent turn ` +
                `runId=${params.runId} sessionKey=${params.sessionKey}`,
            );
          }
        }
        const promptForModelBeforeRuntimeContextSplit = effectivePrompt;
        if (!isRawModelRun) {
          promptForRuntimeContextSplit = annotateInterSessionPromptText(
            promptForRuntimeContextSplit,
            params.inputProvenance,
          );
        }
        const transcriptLeafId =
          (sessionManager.getLeafEntry() as { id?: string } | null | undefined)?.id ?? null;
        const heartbeatSummary =
          params.config && sessionAgentId
            ? resolveHeartbeatSummaryForAgent(params.config, sessionAgentId)
            : undefined;

        try {
          const filteredMessages = filterHeartbeatTranscriptArtifacts(
            activeSession.messages,
            heartbeatSummary?.ackMaxChars,
            heartbeatSummary?.prompt,
          );
          if (filteredMessages.length < activeSession.messages.length) {
            activeSession.agent.state.messages = filteredMessages;
          }
          prePromptMessageCount = activeSession.messages.length;
          const contextTokenBudget = params.contextTokenBudget ?? DEFAULT_CONTEXT_TOKENS;
          const promptToolResultMaxChars = resolveLiveToolResultMaxChars({
            contextWindowTokens: contextTokenBudget,
            cfg: params.config,
            agentId: sessionAgentId,
          });
          let promptHistoryMessages = activeSession.messages;
          const promptToolResultTruncation = truncateOversizedToolResultsInMessages(
            activeSession.messages,
            contextTokenBudget,
            promptToolResultMaxChars,
            promptToolResultMaxChars * PROMPT_TOOL_RESULT_AGGREGATE_CAP_MULTIPLIER,
          );
          if (promptToolResultTruncation.truncatedCount > 0) {
            promptHistoryMessages = promptToolResultTruncation.messages;
            log.info(
              `[tool-result-truncation] Truncated ${promptToolResultTruncation.truncatedCount} ` +
                `tool result(s) for prompt history ` +
                `(maxChars=${promptToolResultMaxChars} ` +
                `aggregateBudgetChars=${
                  promptToolResultMaxChars * PROMPT_TOOL_RESULT_AGGREGATE_CAP_MULTIPLIER
                }) ` +
                `sessionKey=${params.sessionKey ?? params.sessionId ?? "unknown"}`,
            );
          }

          const promptSubmission = resolveRuntimeContextPromptParts({
            effectivePrompt: promptForRuntimeContextSplit,
            transcriptPrompt: transcriptPromptForRuntimeSplit,
            modelPrompt: hasPromptBuildContext
              ? promptForModelBeforeRuntimeContextSplit
              : undefined,
            emptyTranscriptMode: params.suppressNextUserMessagePersistence
              ? "model-prompt"
              : "runtime-event",
          });
          const promptForSession = buildCurrentInboundPrompt({
            context: params.currentInboundContext,
            prompt: promptSubmission.prompt,
          });
          const promptForModel = buildCurrentInboundPrompt({
            context: params.currentInboundContext,
            prompt: promptSubmission.modelPrompt ?? promptSubmission.prompt,
          });
          const runtimeSystemContext = promptSubmission.runtimeSystemContext?.trim();
          if (promptSubmission.runtimeOnly && runtimeSystemContext) {
            const runtimeSystemPrompt = composeSystemPromptWithHookContext({
              baseSystemPrompt: systemPromptText,
              appendSystemContext: runtimeSystemContext,
            });
            if (runtimeSystemPrompt) {
              setActiveSessionSystemPrompt(runtimeSystemPrompt);
            }
          }
          const runtimeContextForHook = promptSubmission.runtimeOnly
            ? undefined
            : promptSubmission.runtimeContext?.trim();
          const runtimeContextMessageForCurrentTurn =
            buildRuntimeContextCustomMessage(runtimeContextForHook);
          const messagesForCurrentPrompt = runtimeContextMessageForCurrentTurn
            ? [...promptHistoryMessages, runtimeContextMessageForCurrentTurn]
            : promptHistoryMessages;
          const hookMessagesForCurrentPrompt = normalizeMessagesForCurrentPromptBoundary({
            messages: messagesForCurrentPrompt,
            prompt: promptForModel,
          });
          if (systemPromptReport) {
            systemPromptReport.currentTurn = {
              ...(params.currentInboundEventKind ? { kind: params.currentInboundEventKind } : {}),
              promptChars: promptForModel.length,
              runtimeContextChars: promptSubmission.runtimeOnly
                ? (runtimeSystemContext?.length ?? 0)
                : (runtimeContextForHook?.length ?? 0),
            };
          }
          const systemPromptForHook = systemPromptText;

          const persistBlockedBeforeAgentRun = async (block: {
            message: string;
            pluginId: string;
          }): Promise<boolean> => {
            const idempotencyKey = `hook-block:before_agent_run:user:${params.runId}`;
            if (sessionMessagesContainIdempotencyKey(activeSession.messages, idempotencyKey)) {
              return true;
            }
            const nowMs = Date.now();
            const redactedUserMessage = {
              role: "user" as const,
              content: [{ type: "text" as const, text: block.message }],
              timestamp: nowMs,
              idempotencyKey,
              __openclaw: {
                beforeAgentRunBlocked: {
                  blockedBy: block.pluginId,
                  blockedAt: nowMs,
                },
              },
            };
            try {
              activeSessionManager.appendMessage(
                redactedUserMessage as Parameters<typeof activeSessionManager.appendMessage>[0],
              );
              flushSessionManagerFile(activeSessionManager);
              activeSession.agent.state.messages =
                activeSessionManager.buildSessionContext().messages;
              return true;
            } catch (err) {
              log.warn(
                `before_agent_run block: failed to persist redacted user message: ${
                  (err as Error)?.message ?? String(err)
                }`,
              );
              return false;
            }
          };

          if (hookRunner?.hasHooks("before_agent_run")) {
            const beforeRunMessages = cloneHookMessages(hookMessagesForCurrentPrompt);
            let beforeRunResult:
              | Awaited<ReturnType<NonNullable<typeof hookRunner>["runBeforeAgentRun"]>>
              | undefined;
            try {
              beforeRunResult = await hookRunner.runBeforeAgentRun(
                {
                  prompt: promptForModel,
                  systemPrompt: systemPromptForHook,
                  messages: beforeRunMessages,
                  channelId: hookCtx.channelId,
                  accountId: params.agentAccountId ?? undefined,
                  senderId: params.senderId ?? undefined,
                  senderIsOwner: params.senderIsOwner ?? undefined,
                },
                hookCtx,
              );
            } catch {
              log.warn("before_agent_run hook failed; blocking request");
              beforeAgentRunBlocked = true;
              beforeAgentRunBlockedBy = "before_agent_run";
              await persistBlockedBeforeAgentRun({
                message: resolveBlockMessage(
                  { outcome: "block", reason: "before_agent_run hook failed" },
                  { blockedBy: "before_agent_run" },
                ),
                pluginId: "before_agent_run",
              });
              promptError = new Error(
                resolveBlockMessage(
                  { outcome: "block", reason: "before_agent_run hook failed" },
                  { blockedBy: "before_agent_run" },
                ),
              );
              promptErrorSource = "hook:before_agent_run";
              skipPromptSubmission = true;
            }
            const beforeRunDecision = beforeRunResult?.decision;
            const beforeRunPluginId = beforeRunResult?.pluginId ?? "unknown";
            if (beforeRunDecision?.outcome === "block") {
              beforeAgentRunBlocked = true;
              beforeAgentRunBlockedBy = beforeRunPluginId;
              const blockReplacementMsg = resolveBlockMessage(beforeRunDecision, {
                blockedBy: beforeRunPluginId,
              });
              log.warn(`before_agent_run hook blocked by ${beforeRunPluginId}`);
              await persistBlockedBeforeAgentRun({
                message: blockReplacementMsg,
                pluginId: beforeRunPluginId,
              });
              promptError = new Error(blockReplacementMsg);
              promptErrorSource = "hook:before_agent_run";
              skipPromptSubmission = true;
            }
          }

          if (!skipPromptSubmission) {
            const googlePromptCacheStreamFn = await prepareGooglePromptCacheStreamFn({
              apiKey: await resolveEmbeddedAgentApiKey({
                provider: params.provider,
                resolvedApiKey: params.resolvedApiKey,
                authStorage: params.authStorage,
              }),
              extraParams: effectiveExtraParams,
              model: params.model,
              modelId: params.modelId,
              provider: params.provider,
              sessionManager: {
                appendCustomEntry: async (customType, data) => {
                  await sessionLockController.withSessionWriteLock(() => {
                    activeSessionManager.appendCustomEntry(customType, data);
                  });
                },
                getEntries: () => activeSessionManager.getEntries(),
              },
              signal: runAbortController.signal,
              streamFn: activeSession.agent.streamFn,
              systemPrompt: systemPromptText,
            });
            if (googlePromptCacheStreamFn) {
              activeSession.agent.streamFn = googlePromptCacheStreamFn;
            }
            installPromptSubmissionLockRelease({
              session: activeSession,
              waitForSessionEvents: (sessionToDrain) =>
                sessionLockController.waitForSessionEvents(sessionToDrain),
              releaseForPrompt: () => sessionLockController.releaseForPrompt(),
              reacquireAfterPrompt: () => sessionLockController.reacquireAfterPrompt(),
              sessionKey: params.sessionKey,
              sessionFile: params.sessionFile,
              withSessionWriteLock: (run, options) =>
                sessionLockController.withSessionWriteLock(run, options),
            });
          }

          // Detect and load images referenced in the visible prompt for vision-capable models.
          // Images are prompt-local only.
          const imageResult = skipPromptSubmission
            ? {
                images: [],
                detectedRefs: [],
                loadedCount: 0,
                skippedCount: 0,
              }
            : await detectAndLoadPromptImages({
                prompt: promptSubmission.prompt,
                workspaceDir: effectiveWorkspace,
                model: params.model,
                existingImages: params.images,
                imageOrder: params.imageOrder,
                maxBytes: MAX_IMAGE_BYTES,
                maxDimensionPx: resolveImageSanitizationLimits(params.config).maxDimensionPx,
                workspaceOnly: effectiveFsWorkspaceOnly,
                // Enforce sandbox path restrictions when sandbox is enabled
                sandbox:
                  sandbox?.enabled && sandbox?.fsBridge
                    ? { root: sandbox.workspaceDir, bridge: sandbox.fsBridge }
                    : undefined,
              });

          if (!skipPromptSubmission) {
            cacheTrace?.recordStage("prompt:before", {
              prompt: promptForModel,
              messages: activeSession.messages,
            });
            cacheTrace?.recordStage("prompt:images", {
              prompt: promptForModel,
              messages: activeSession.messages,
              note: `images: prompt=${imageResult.images.length}`,
            });
            const trajectoryProviderVisibleTools = toTrajectoryToolDefinitions(effectiveTools);
            trajectoryRecorder?.recordEvent("context.compiled", {
              systemPrompt: systemPromptForHook,
              prompt: promptForModel,
              messages: activeSession.messages,
              tools: toTrajectoryToolDefinitions(
                toolSearch.compacted ? uncompactedEffectiveTools : effectiveTools,
              ),
              ...(toolSearch.compacted
                ? { providerVisibleTools: trajectoryProviderVisibleTools }
                : {}),
              imagesCount: imageResult.images.length,
              streamStrategy,
              transport: effectiveAgentTransport,
              transcriptLeafId,
            });
          }

          const promptSkipReason = skipPromptSubmission
            ? null
            : resolvePromptSubmissionSkipReason({
                prompt: promptForModel,
                messages: activeSession.messages,
                runtimeOnly: promptSubmission.runtimeOnly,
                imageCount: imageResult.images.length,
              });
          if (promptSkipReason) {
            skipPromptSubmission = true;
            const skipContext =
              `runId=${params.runId} sessionId=${params.sessionId} trigger=${params.trigger} ` +
              `provider=${params.provider}/${params.modelId}`;
            if (promptSkipReason === "blank_user_prompt") {
              log.warn(`embedded run prompt skipped: blank user prompt ${skipContext}`);
            } else {
              log.info(`embedded run prompt skipped: empty prompt/history/images ${skipContext}`);
            }
            trajectoryRecorder?.recordEvent("prompt.skipped", {
              reason: promptSkipReason,
              prompt: promptForModel,
              messages: activeSession.messages,
              imagesCount: imageResult.images.length,
            });
          }

          const msgCount = activeSession.messages.length;
          const systemLen = systemPromptText?.length ?? 0;
          const promptLen = effectivePrompt.length;
          const sessionSummary = summarizeSessionContext(activeSession.messages);
          const reserveTokens = settingsManager.getCompactionReserveTokens();
          emitTrustedDiagnosticEvent({
            type: "context.assembled",
            runId: params.runId,
            ...(params.sessionKey && { sessionKey: params.sessionKey }),
            ...(params.sessionId && { sessionId: params.sessionId }),
            provider: params.provider,
            model: params.modelId,
            ...((params.messageChannel ?? params.messageProvider)
              ? { channel: params.messageChannel ?? params.messageProvider }
              : {}),
            trigger: params.trigger,
            messageCount: msgCount,
            historyTextChars: sessionSummary.totalTextChars,
            historyImageBlocks: sessionSummary.totalImageBlocks,
            maxMessageTextChars: sessionSummary.maxMessageTextChars,
            systemPromptChars: systemLen,
            promptChars: promptLen,
            promptImages: imageResult.images.length,
            contextTokenBudget,
            reserveTokens,
            trace: freezeDiagnosticTraceContext(createChildDiagnosticTraceContext(runTrace)),
          });
          params.onExecutionPhase?.({
            phase: "context_assembled",
            provider: params.provider,
            model: params.modelId,
          });

          // Diagnostic: log context sizes before prompt to help debug early overflow errors.
          if (log.isEnabled("debug")) {
            log.debug(
              `[context-diag] pre-prompt: sessionKey=${params.sessionKey ?? params.sessionId} ` +
                `messages=${msgCount} roleCounts=${sessionSummary.roleCounts} ` +
                `historyTextChars=${sessionSummary.totalTextChars} ` +
                `maxMessageTextChars=${sessionSummary.maxMessageTextChars} ` +
                `historyImageBlocks=${sessionSummary.totalImageBlocks} ` +
                `systemPromptChars=${systemLen} promptChars=${promptLen} ` +
                `promptImages=${imageResult.images.length} ` +
                `provider=${params.provider}/${params.modelId} sessionFile=${params.sessionFile}`,
            );
          }

          if (!skipPromptSubmission && !isRawModelRun && hookRunner?.hasHooks("llm_input")) {
            hookRunner
              .runLlmInput(
                {
                  runId: params.runId,
                  sessionId: params.sessionId,
                  provider: params.provider,
                  model: params.modelId,
                  systemPrompt: systemPromptForHook,
                  prompt: promptForModel,
                  historyMessages: cloneHookMessages(hookMessagesForCurrentPrompt),
                  imagesCount: imageResult.images.length,
                  tools,
                },
                {
                  runId: params.runId,
                  trace: freezeDiagnosticTraceContext(diagnosticTrace),
                  agentId: hookAgentId,
                  sessionKey: params.sessionKey,
                  sessionId: params.sessionId,
                  workspaceDir: params.workspaceDir,
                  trigger: params.trigger,
                  ...buildAgentHookContextChannelFields(params),
                },
              )
              .catch((err: unknown) => {
                log.warn(`llm_input hook failed: ${String(err)}`);
              });
          }

          const preemptiveCompaction = skipPromptSubmission
            ? null
            : shouldPreemptivelyCompactBeforePrompt({
                messages: messagesForCurrentPrompt,
                ...(contextEnginePromptAuthority === "preassembly_may_overflow"
                  ? { unwindowedMessages: unwindowedContextEngineMessagesForPrecheck }
                  : {}),
                systemPrompt: systemPromptForHook,
                prompt: promptForModel,
                contextTokenBudget,
                reserveTokens,
                toolResultMaxChars: promptToolResultMaxChars,
              });
          if (preemptiveCompaction) {
            contextBudgetStatus = buildPrePromptContextBudgetStatus({
              result: preemptiveCompaction,
              provider: params.provider,
              modelId: params.modelId,
              messageCount: activeSession.messages.length,
              contextTokenBudget,
              reserveTokens,
              ...(params.sessionId ? { sessionId: params.sessionId } : {}),
              ...(contextEnginePromptAuthority === "preassembly_may_overflow" &&
              unwindowedContextEngineMessagesForPrecheck
                ? { unwindowedMessageCount: unwindowedContextEngineMessagesForPrecheck.length }
                : {}),
            });
            log.debug(
              formatPrePromptPrecheckLog({
                result: preemptiveCompaction,
                provider: params.provider,
                modelId: params.modelId,
                messageCount: activeSession.messages.length,
                contextTokenBudget,
                reserveTokens,
                ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
                ...(params.sessionId ? { sessionId: params.sessionId } : {}),
                ...(contextEnginePromptAuthority === "preassembly_may_overflow" &&
                unwindowedContextEngineMessagesForPrecheck
                  ? { unwindowedMessageCount: unwindowedContextEngineMessagesForPrecheck.length }
                  : {}),
                ...(params.sessionFile ? { sessionFile: params.sessionFile } : {}),
              }),
            );
          }
          if (preemptiveCompaction?.route === "truncate_tool_results_only") {
            const toolResultMaxChars = resolveLiveToolResultMaxChars({
              contextWindowTokens: contextTokenBudget,
              cfg: params.config,
              agentId: sessionAgentId,
            });
            const truncationResult = truncateOversizedToolResultsInSessionManager({
              sessionManager,
              contextWindowTokens: contextTokenBudget,
              maxCharsOverride: toolResultMaxChars,
              sessionFile: params.sessionFile,
              sessionId: params.sessionId,
              sessionKey: params.sessionKey,
              agentId: sessionAgentId,
            });
            if (truncationResult.truncated) {
              preflightRecovery = {
                route: "truncate_tool_results_only",
                handled: true,
                truncatedCount: truncationResult.truncatedCount,
              };
              log.info(
                `[context-overflow-precheck] early tool-result truncation succeeded for ` +
                  `${params.provider}/${params.modelId} route=${preemptiveCompaction.route} ` +
                  `truncatedCount=${truncationResult.truncatedCount} ` +
                  `estimatedPromptTokens=${preemptiveCompaction.estimatedPromptTokens} ` +
                  `promptBudgetBeforeReserve=${preemptiveCompaction.promptBudgetBeforeReserve} ` +
                  `overflowTokens=${preemptiveCompaction.overflowTokens} ` +
                  `toolResultReducibleChars=${preemptiveCompaction.toolResultReducibleChars} ` +
                  `effectiveReserveTokens=${preemptiveCompaction.effectiveReserveTokens} ` +
                  `sessionFile=${params.sessionFile}`,
              );
              skipPromptSubmission = true;
            }
            if (!skipPromptSubmission) {
              log.warn(
                `[context-overflow-precheck] early tool-result truncation did not help for ` +
                  `${params.provider}/${params.modelId}; falling back to compaction ` +
                  `reason=${truncationResult.reason ?? "unknown"} sessionFile=${params.sessionFile}`,
              );
              preflightRecovery = { route: "compact_only" };
              promptError = new Error(PREEMPTIVE_OVERFLOW_ERROR_TEXT);
              promptErrorSource = "precheck";
              skipPromptSubmission = true;
            }
          }
          if (preemptiveCompaction?.shouldCompact) {
            preflightRecovery =
              preemptiveCompaction.route === "compact_then_truncate"
                ? { route: "compact_then_truncate" }
                : { route: "compact_only" };
            promptError = new Error(PREEMPTIVE_OVERFLOW_ERROR_TEXT);
            promptErrorSource = "precheck";
            log.warn(
              `[context-overflow-precheck] sessionKey=${params.sessionKey ?? params.sessionId} ` +
                `provider=${params.provider}/${params.modelId} ` +
                `route=${preemptiveCompaction.route} ` +
                `estimatedPromptTokens=${preemptiveCompaction.estimatedPromptTokens} ` +
                `promptBudgetBeforeReserve=${preemptiveCompaction.promptBudgetBeforeReserve} ` +
                `overflowTokens=${preemptiveCompaction.overflowTokens} ` +
                `toolResultReducibleChars=${preemptiveCompaction.toolResultReducibleChars} ` +
                `reserveTokens=${reserveTokens} ` +
                `effectiveReserveTokens=${preemptiveCompaction.effectiveReserveTokens} ` +
                `sessionFile=${params.sessionFile}`,
            );
            skipPromptSubmission = true;
          }

          if (!skipPromptSubmission) {
            const normalizedReplayMessages = normalizeAssistantReplayContent(
              activeSession.messages,
            );
            if (normalizedReplayMessages !== activeSession.messages) {
              activeSession.agent.state.messages = normalizedReplayMessages;
            }
            const installProviderPromptHistoryTransform = (): (() => void) => {
              const baseStreamFn = activeSession.agent.streamFn;
              const providerPromptStreamFn = wrapStreamFnWithMessageTransform(
                baseStreamFn,
                (messages) => {
                  const providerPromptHistoryTruncation = truncateOversizedToolResultsInMessages(
                    messages,
                    contextTokenBudget,
                    promptToolResultMaxChars,
                    promptToolResultMaxChars * PROMPT_TOOL_RESULT_AGGREGATE_CAP_MULTIPLIER,
                  );
                  return providerPromptHistoryTruncation.truncatedCount > 0
                    ? providerPromptHistoryTruncation.messages
                    : messages;
                },
              );
              activeSession.agent.streamFn = providerPromptStreamFn;
              return () => {
                if (activeSession.agent.streamFn === providerPromptStreamFn) {
                  activeSession.agent.streamFn = baseStreamFn;
                }
              };
            };
            finalPromptText = promptForSession;
            trajectoryRecorder?.recordEvent("prompt.submitted", {
              prompt: promptForModel,
              systemPrompt: systemPromptForHook,
              messages: activeSession.messages,
              imagesCount: imageResult.images.length,
            });
            const btwSnapshotMessages = normalizedReplayMessages.slice(-MAX_BTW_SNAPSHOT_MESSAGES);
            updateActiveEmbeddedRunSnapshot(params.sessionId, {
              transcriptLeafId,
              messages: btwSnapshotMessages,
              inFlightPrompt: promptForSession,
            });
            let captureCurrentPromptForModel = false;
            const cleanupModelPromptTransform = installModelPromptTransform({
              session: activeSession,
              transcriptPrompt: promptForSession,
              modelPrompt: promptForModel,
              prependContext: promptBuildPrependContext,
              appendContext: promptBuildAppendContext,
              shouldCapturePrompt: () => captureCurrentPromptForModel,
            });
            const armModelPromptTransform = (submitted: boolean) => {
              if (submitted) {
                captureCurrentPromptForModel = true;
              }
            };
            const cleanupProviderPromptHistoryTransform = installProviderPromptHistoryTransform();
            try {
              if (promptSubmission.runtimeOnly) {
                await promptActiveSession(promptForSession, {
                  preflightResult: armModelPromptTransform,
                });
              } else {
                const cleanupRuntimeContextMessage = installRuntimeContextMessageForPrompt({
                  session: activeSession,
                  message: runtimeContextMessageForCurrentTurn,
                });
                try {
                  // Only pass images option if there are actually images to pass
                  // This avoids potential issues with models that don't expect the images parameter
                  if (imageResult.images.length > 0) {
                    await promptActiveSession(promptForSession, {
                      images: imageResult.images,
                      preflightResult: armModelPromptTransform,
                    });
                  } else {
                    await promptActiveSession(promptForSession, {
                      preflightResult: armModelPromptTransform,
                    });
                  }
                } finally {
                  cleanupRuntimeContextMessage();
                }
              }
              if (leasedSteering) {
                ackPendingAgentSteeringItems({
                  runIds: leasedSteering.runIds,
                  leaseId: leasedSteering.leaseId,
                });
                leasedSteering = undefined;
              }
            } finally {
              cleanupProviderPromptHistoryTransform();
              cleanupModelPromptTransform();
            }
          } else {
            releaseLeasedSteering(promptError ?? "prompt submission skipped");
          }
        } catch (err) {
          releaseLeasedSteering(err);
          yieldAborted =
            yieldDetected &&
            isRunnerAbortError(err) &&
            err instanceof Error &&
            err.cause === "sessions_yield";
          cleanupYieldAborted = yieldAborted;
          if (yieldAborted) {
            aborted = false;
            await waitForSessionsYieldAbortSettle({
              settlePromise: yieldAbortSettled,
              runId: params.runId,
              sessionId: params.sessionId,
            });
            await sessionLockController.releaseHeldLockForAbort();
            await sessionLockController.waitForSessionEvents(activeSession);
            await sessionLockController.withSessionWriteLock(async () => {
              stripSessionsYieldArtifacts(activeSession);
              if (yieldMessage) {
                await persistSessionsYieldContextMessage(activeSession, yieldMessage);
              }
            });
          } else if (isMidTurnPrecheckSignal(err)) {
            await sessionLockController.waitForSessionEvents(activeSession);
            await sessionLockController.withSessionWriteLock(() => {
              handleMidTurnPrecheckRequest(err.request);
            });
          } else {
            promptError = err;
            promptErrorSource = "prompt";
          }
        } finally {
          log.debug(
            `embedded run prompt end: runId=${params.runId} sessionId=${params.sessionId} durationMs=${Date.now() - promptStartedAt}`,
          );
        }

        if (pendingMidTurnPrecheckRequest) {
          const request = pendingMidTurnPrecheckRequest;
          pendingMidTurnPrecheckRequest = null;
          await sessionLockController.waitForSessionEvents(activeSession);
          await sessionLockController.withSessionWriteLock(() => {
            removeTrailingMidTurnPrecheckAssistantError({
              activeSession,
              sessionManager: activeSessionManager,
            });
            if (!preflightRecovery && promptErrorSource !== "precheck") {
              promptError = null;
              promptErrorSource = null;
              handleMidTurnPrecheckRequest(request);
            }
          });
        }

        await sessionLockController.waitForSessionEvents(activeSession);
        await sessionLockController.releaseForPrompt();

        if (
          requiresCompletionRequiredAsyncTaskWait({
            sessionKey: params.sessionKey,
            toolMetas,
          })
        ) {
          const getAsyncStartedToolMetas = () =>
            toolMetas
              .filter(
                (
                  entry,
                ): entry is {
                  toolName: string;
                  asyncStarted?: boolean;
                  asyncTaskRunId?: string;
                  asyncTaskId?: string;
                } => typeof entry.toolName === "string" && entry.toolName.trim().length > 0,
              )
              .map((entry) => ({
                toolName: entry.toolName,
                asyncStarted: entry.asyncStarted,
                asyncTaskRunId: entry.asyncTaskRunId,
                asyncTaskId: entry.asyncTaskId,
              }));
          const completionRequiredAsyncDeadlineAtMs = Math.max(
            Date.now(),
            runAbortDeadlineAtMs - 500,
          );
          let asyncTaskWait: CompletionRequiredAsyncTaskWaitResult;
          try {
            asyncTaskWait = await waitForCompletionRequiredAsyncTasks({
              getToolMetas: getAsyncStartedToolMetas,
              sessionKey: params.sessionKey,
              deadlineAtMs: completionRequiredAsyncDeadlineAtMs,
              abortSignal: runAbortController.signal,
            });
          } catch (err) {
            if (!timedOut || !isRunnerAbortError(err)) {
              throw err;
            }
            asyncTaskWait = await waitForCompletionRequiredAsyncTasks({
              getToolMetas: getAsyncStartedToolMetas,
              sessionKey: params.sessionKey,
              deadlineAtMs: Date.now(),
            });
          }
          if (asyncTaskWait.timedOutRunIds.length > 0) {
            promptError = new Error(
              `Timed out waiting for async task completion: ${asyncTaskWait.timedOutRunIds.join(", ")}`,
            );
            promptErrorSource = "prompt";
          } else if (asyncTaskWait.waitedRunIds.length > 0) {
            await sessionLockController.waitForSessionEvents(activeSession);
          }
        }

        // Capture snapshot before compaction wait so we have complete messages if timeout occurs
        // Check compaction state before and after to avoid race condition where compaction starts during capture
        // Use session state (not subscription) for snapshot decisions - need instantaneous compaction status
        const wasCompactingBefore = activeSession.isCompacting;
        const snapshot = activeSession.messages.slice();
        const wasCompactingAfter = activeSession.isCompacting;
        // Only trust snapshot if compaction wasn't running before or after capture
        const preCompactionSnapshot = wasCompactingBefore || wasCompactingAfter ? null : snapshot;
        const preCompactionSessionId = activeSession.sessionId;
        const COMPACTION_RETRY_AGGREGATE_TIMEOUT_MS = 60_000;

        try {
          // Flush buffered block replies before waiting for compaction so the
          // user receives the assistant response immediately.  Without this,
          // coalesced/buffered blocks stay in the pipeline until compaction
          // finishes — which can take minutes on large contexts (#35074).
          if (onBlockReplyFlush) {
            await onBlockReplyFlush();
          }

          // Skip compaction wait when yield aborted the run — the signal is
          // already tripped and abortable() would immediately reject.
          const compactionRetryWait = yieldAborted
            ? { timedOut: false }
            : await waitForCompactionRetryWithAggregateTimeout({
                waitForCompactionRetry,
                abortable,
                aggregateTimeoutMs: COMPACTION_RETRY_AGGREGATE_TIMEOUT_MS,
                isCompactionStillInFlight: isCompactionInFlight,
              });
          if (compactionRetryWait.timedOut) {
            timedOutDuringCompaction = true;
            if (!isProbeSession) {
              log.warn(
                `compaction retry aggregate timeout (${COMPACTION_RETRY_AGGREGATE_TIMEOUT_MS}ms): ` +
                  `proceeding with pre-compaction state runId=${params.runId} sessionId=${params.sessionId}`,
              );
            }
          }
        } catch (err) {
          if (isRunnerAbortError(err)) {
            if (!promptError) {
              promptError = err;
              promptErrorSource = "compaction";
            }
            if (!isProbeSession) {
              log.debug(
                `compaction wait aborted: runId=${params.runId} sessionId=${params.sessionId}`,
              );
            }
          } else {
            throw err;
          }
        }

        await sessionLockController.waitForSessionEvents(activeSession);
        await sessionLockController.withSessionWriteLock(async () => {
          // Check if ANY compaction occurred during the entire attempt (prompt + retry).
          // Using a cumulative count (> 0) instead of a delta check avoids missing
          // compactions that complete during activeSession.prompt() before the delta
          // baseline is sampled.
          compactionOccurredThisAttempt = getCompactionCount() > 0;
          // Append cache-TTL timestamp AFTER prompt + compaction retry completes.
          // Previously this was before the prompt, which caused a custom entry to be
          // inserted between compaction and the next prompt — breaking the
          // prepareCompaction() guard that checks the last entry type, leading to
          // double-compaction. See: https://github.com/openclaw/openclaw/issues/9282
          // Skip when timed out during compaction — session state may be inconsistent.
          // Also skip when compaction ran this attempt — appending a custom entry
          // after compaction would break the guard again. See: #28491
          appendAttemptCacheTtlIfNeeded({
            sessionManager: activeSessionManager,
            timedOutDuringCompaction,
            compactionOccurredThisAttempt,
            config: params.config,
            provider: params.provider,
            modelId: params.modelId,
            modelApi: params.model.api,
            isCacheTtlEligibleProvider,
          });

          // If timeout occurred during compaction, use pre-compaction snapshot when available
          // (compaction restructures messages but does not add user/assistant turns).
          const snapshotSelection = selectCompactionTimeoutSnapshot({
            timedOutDuringCompaction,
            preCompactionSnapshot,
            preCompactionSessionId,
            currentSnapshot: activeSession.messages.slice(),
            currentSessionId: activeSession.sessionId,
          });
          if (timedOutDuringCompaction) {
            if (!isProbeSession) {
              log.warn(
                `using ${snapshotSelection.source} snapshot: timed out during compaction runId=${params.runId} sessionId=${params.sessionId}`,
              );
            }
          }
          messagesSnapshot = projectToolSearchTargetTranscriptMessages(
            snapshotSelection.messagesSnapshot,
            toolSearchTargetTranscriptProjections,
          );
          sessionIdUsed = snapshotSelection.sessionIdUsed;

          lastAssistant = messagesSnapshot
            .slice()
            .toReversed()
            .find((message): message is AssistantMessage => message.role === "assistant");
          currentAttemptAssistant = findCurrentAttemptAssistantMessage({
            messagesSnapshot,
            prePromptMessageCount,
          });
          attemptUsage = getUsageTotals();
          cacheBreak = cacheObservabilityEnabled
            ? completePromptCacheObservation({
                sessionId: params.sessionId,
                promptCacheKey: params.promptCacheKey,
                sessionKey: params.sessionKey,
                usage: attemptUsage,
              })
            : null;
          lastCallUsage = normalizeUsage(currentAttemptAssistant?.usage);
          const promptCacheObservation =
            cacheObservabilityEnabled &&
            (cacheBreak || promptCacheChangesForTurn || typeof attemptUsage?.cacheRead === "number")
              ? {
                  broke: Boolean(cacheBreak),
                  ...(typeof cacheBreak?.previousCacheRead === "number"
                    ? { previousCacheRead: cacheBreak.previousCacheRead }
                    : {}),
                  ...(typeof cacheBreak?.cacheRead === "number"
                    ? { cacheRead: cacheBreak.cacheRead }
                    : typeof attemptUsage?.cacheRead === "number"
                      ? { cacheRead: attemptUsage.cacheRead }
                      : {}),
                  changes: cacheBreak?.changes ?? promptCacheChangesForTurn,
                }
              : undefined;
          const fallbackLastCacheTouchAt = readLastCacheTtlTimestamp(activeSessionManager, {
            provider: params.provider,
            modelId: params.modelId,
          });
          promptCache = buildContextEnginePromptCacheInfo({
            retention: effectivePromptCacheRetention,
            lastCallUsage,
            observation: promptCacheObservation,
            lastCacheTouchAt: resolvePromptCacheTouchTimestamp({
              lastCallUsage,
              assistantTimestamp: currentAttemptAssistant?.timestamp,
              fallbackLastCacheTouchAt,
            }),
          });

          if (promptError && promptErrorSource === "prompt" && !compactionOccurredThisAttempt) {
            try {
              activeSessionManager.appendCustomEntry("openclaw:prompt-error", {
                timestamp: Date.now(),
                runId: params.runId,
                sessionId: params.sessionId,
                provider: params.provider,
                model: params.modelId,
                api: params.model.api,
                error: formatErrorMessage(promptError),
              });
            } catch (entryErr) {
              log.warn(`failed to persist prompt error entry: ${String(entryErr)}`);
            }
          }
        });

        // Let the active context engine run its post-turn lifecycle. These hooks
        // may call runtime LLM capabilities, so only their transcript rewrite
        // helper reacquires the session write lock.
        if (activeContextEngine) {
          const afterTurnRuntimeContext = buildAfterTurnRuntimeContextFromUsage({
            attempt: params,
            workspaceDir: effectiveWorkspace,
            agentDir,
            tokenBudget: params.contextTokenBudget,
            lastCallUsage,
            promptCache,
            activeAgentId: sessionAgentId,
            contextEnginePluginId: resolveActiveContextEnginePluginId(),
          });
          await finalizeAttemptContextEngineTurn({
            contextEngine: activeContextEngine,
            promptError: Boolean(promptError),
            aborted,
            yieldAborted,
            sessionIdUsed,
            sessionKey: params.sessionKey,
            sessionFile: params.sessionFile,
            messagesSnapshot,
            prePromptMessageCount: contextEngineAfterTurnCheckpoint ?? prePromptMessageCount,
            tokenBudget: params.contextTokenBudget,
            runtimeContext: afterTurnRuntimeContext,
            runMaintenance: async (contextParams) =>
              await runContextEngineMaintenance({
                contextEngine: contextParams.contextEngine as never,
                sessionId: contextParams.sessionId,
                sessionKey: contextParams.sessionKey,
                sessionFile: contextParams.sessionFile,
                reason: contextParams.reason,
                sessionManager: contextParams.sessionManager as never,
                withSessionManagerRewriteLock: async (operation) =>
                  await sessionLockController.withSessionWriteLock(operation),
                runtimeContext: contextParams.runtimeContext,
                config: params.config,
                agentId: sessionAgentId,
              }),
            sessionManager: activeSessionManager,
            config: params.config,
            warn: (message) => log.warn(message),
          });
        }

        await sessionLockController.waitForSessionEvents(activeSession);
        await sessionLockController.withSessionWriteLock(async () => {
          if (
            shouldPersistCompletedBootstrapTurn({
              shouldRecordCompletedBootstrapTurn,
              promptError,
              aborted,
              timedOutDuringCompaction,
              compactionOccurredThisAttempt,
            })
          ) {
            try {
              activeSessionManager.appendCustomEntry(FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE, {
                timestamp: Date.now(),
                runId: params.runId,
                sessionId: params.sessionId,
              });
            } catch (entryErr) {
              log.warn(`failed to persist bootstrap completion entry: ${String(entryErr)}`);
            }
          }

          if (
            compactionOccurredThisAttempt &&
            !promptError &&
            !aborted &&
            !timedOut &&
            !idleTimedOut &&
            !timedOutDuringCompaction &&
            shouldRotateCompactionTranscript(params.config)
          ) {
            try {
              const rotation = await rotateTranscriptAfterCompaction({
                sessionManager: activeSessionManager,
                sessionFile: params.sessionFile,
              });
              if (rotation.rotated) {
                sessionIdUsed = rotation.sessionId ?? sessionIdUsed;
                sessionFileUsed = rotation.sessionFile ?? sessionFileUsed;
                updateActiveEmbeddedRunSessionFile(params.sessionId, sessionFileUsed);
                log.info(
                  `[compaction] rotated active transcript after automatic compaction ` +
                    `(sessionKey=${params.sessionKey ?? params.sessionId})`,
                );
              }
            } catch (err) {
              log.warn("[compaction] automatic transcript rotation failed", {
                errorMessage: formatErrorMessage(err),
              });
            }
          }
        });

        cacheTrace?.recordStage("session:after", {
          messages: messagesSnapshot,
          note: timedOutDuringCompaction
            ? "compaction timeout"
            : promptError
              ? "prompt error"
              : undefined,
        });
        anthropicPayloadLogger?.recordUsage(messagesSnapshot, promptError);

        runAgentEndSideEffects({
          event: {
            messages: messagesSnapshot,
            success: !aborted && !promptError,
            error: promptError ? formatErrorMessage(promptError) : undefined,
            durationMs: Date.now() - promptStartedAt,
          },
          ctx: {
            runId: params.runId,
            trace: freezeDiagnosticTraceContext(diagnosticTrace),
            agentId: hookAgentId,
            sessionKey: params.sessionKey,
            sessionId: params.sessionId,
            workspaceDir: params.workspaceDir,
            trigger: params.trigger,
            ...(params.config ? { config: params.config } : {}),
            ...buildAgentHookContextChannelFields(params),
          },
          hookRunner,
        });
      } finally {
        clearTimeout(abortTimer);
        if (abortWarnTimer) {
          clearTimeout(abortWarnTimer);
        }
        if (!isProbeSession && (aborted || timedOut) && !timedOutDuringCompaction) {
          log.debug(
            `run cleanup: runId=${params.runId} sessionId=${params.sessionId} aborted=${aborted} timedOut=${timedOut}`,
          );
        }
        try {
          unsubscribe();
        } catch (err) {
          // unsubscribe() should never throw; if it does, it indicates a serious bug.
          // Log at error level to ensure visibility, but don't rethrow in finally block
          // as it would mask any exception from the try block above.
          log.error(
            `CRITICAL: unsubscribe failed, possible resource leak: runId=${params.runId} ${String(err)}`,
          );
        }
        if (params.replyOperation) {
          params.replyOperation.detachBackend(queueHandle);
        }
        clearActiveEmbeddedRun(
          params.sessionId,
          queueHandle,
          params.sessionKey,
          params.sessionFile,
        );
        params.abortSignal?.removeEventListener?.("abort", onAbort);
      }

      const toolMetasNormalized = toolMetas
        .filter(
          (
            entry,
          ): entry is {
            toolName: string;
            meta?: string;
            asyncStarted?: boolean;
            asyncTaskRunId?: string;
            asyncTaskId?: string;
          } => typeof entry.toolName === "string" && entry.toolName.trim().length > 0,
        )
        .map((entry) => {
          const normalized: {
            toolName: string;
            meta?: string;
            asyncStarted?: true;
            asyncTaskRunId?: string;
            asyncTaskId?: string;
          } = {
            toolName: entry.toolName,
            meta: entry.meta,
          };
          if (entry.asyncStarted === true) {
            normalized.asyncStarted = true;
          }
          if (entry.asyncTaskRunId) {
            normalized.asyncTaskRunId = entry.asyncTaskRunId;
          }
          if (entry.asyncTaskId) {
            normalized.asyncTaskId = entry.asyncTaskId;
          }
          return normalized;
        });
      if (cacheObservabilityEnabled) {
        const cacheBreakForLog = cacheBreak as PromptCacheBreak | null;
        if (cacheBreakForLog) {
          const changeSummary =
            cacheBreakForLog.changes
              ?.map((change) => `${change.code}(${change.detail})`)
              .join(", ") ?? "no tracked cache input change";
          log.warn(
            `[prompt-cache] cache read dropped ${cacheBreakForLog.previousCacheRead} -> ${cacheBreakForLog.cacheRead} ` +
              `for ${params.provider}/${params.modelId} via ${streamStrategy}; ${changeSummary}`,
          );
          cacheTrace?.recordStage("cache:result", {
            options: {
              previousCacheRead: cacheBreakForLog.previousCacheRead,
              cacheRead: cacheBreakForLog.cacheRead,
              changes:
                cacheBreakForLog.changes?.map((change) => ({
                  code: change.code,
                  detail: change.detail,
                })) ?? undefined,
            },
          });
        } else if (cacheTrace && promptCacheChangesForTurn) {
          cacheTrace.recordStage("cache:result", {
            note: "state changed without a cache-read break",
            options: {
              cacheRead: attemptUsage?.cacheRead ?? 0,
              changes: promptCacheChangesForTurn.map((change) => ({
                code: change.code,
                detail: change.detail,
              })),
            },
          });
        } else if (cacheTrace) {
          cacheTrace.recordStage("cache:result", {
            note: "stable cache inputs",
            options: {
              cacheRead: attemptUsage?.cacheRead ?? 0,
            },
          });
        }
      }

      if (
        hookRunner?.hasHooks("llm_output") &&
        shouldRunLlmOutputHooksForAttempt({ promptErrorSource })
      ) {
        hookRunner
          .runLlmOutput(
            {
              runId: params.runId,
              sessionId: params.sessionId,
              provider: params.provider,
              model: params.modelId,
              ...(params.contextWindowInfo?.tokens
                ? { contextTokenBudget: params.contextWindowInfo.tokens }
                : {}),
              ...(params.contextWindowInfo?.source
                ? { contextWindowSource: params.contextWindowInfo.source }
                : {}),
              ...(params.contextWindowInfo?.referenceTokens
                ? { contextWindowReferenceTokens: params.contextWindowInfo.referenceTokens }
                : {}),
              resolvedRef:
                params.runtimePlan?.observability.resolvedRef ??
                `${params.provider}/${params.modelId}`,
              ...(params.runtimePlan?.observability.harnessId
                ? { harnessId: params.runtimePlan.observability.harnessId }
                : {}),
              assistantTexts,
              lastAssistant,
              usage: attemptUsage,
            },
            {
              runId: params.runId,
              trace: freezeDiagnosticTraceContext(diagnosticTrace),
              agentId: hookAgentId,
              sessionKey: params.sessionKey,
              sessionId: params.sessionId,
              workspaceDir: params.workspaceDir,
              trigger: params.trigger,
              ...(params.contextWindowInfo?.tokens
                ? { contextTokenBudget: params.contextWindowInfo.tokens }
                : {}),
              ...(params.contextWindowInfo?.source
                ? { contextWindowSource: params.contextWindowInfo.source }
                : {}),
              ...(params.contextWindowInfo?.referenceTokens
                ? { contextWindowReferenceTokens: params.contextWindowInfo.referenceTokens }
                : {}),
              ...buildAgentHookContextChannelFields(params),
            },
          )
          .catch((err: unknown) => {
            log.warn(`llm_output hook failed: ${String(err)}`);
          });
      }

      const acceptedSessionSpawns = getAcceptedSessionSpawns();
      const observedReplayMetadata = buildAttemptReplayMetadata({
        toolMetas: toolMetasNormalized,
        didSendViaMessagingTool: didSendViaMessagingTool(),
        messagingToolSentTexts: getMessagingToolSentTexts(),
        messagingToolSentMediaUrls: getMessagingToolSentMediaUrls(),
        acceptedSessionSpawns,
        successfulCronAdds: getSuccessfulCronAdds(),
      });
      const pendingToolMediaReply = getPendingToolMediaReply();
      const replayMetadata = replayMetadataFromState(
        observeReplayMetadata(getReplayState(), observedReplayMetadata),
      );
      const completedClientToolCalls = clientToolCallSlots.flatMap((slot) =>
        slot.completed && slot.params
          ? [
              {
                name: slot.name,
                params: slot.params,
              },
            ]
          : [],
      );
      const completedClientToolCallsForAttempt =
        completedClientToolCalls.length > 0 ? completedClientToolCalls : undefined;
      const didSendDeterministicApprovalPromptNow = didSendDeterministicApprovalPrompt();
      const lastToolError = getLastToolError?.();
      const heartbeatToolResponse = getHeartbeatToolResponse();
      const messagingToolSourceReplyPayloads = getMessagingToolSourceReplyPayloads();
      const pendingToolMediaPayloadCount = hasVisiblePendingToolMediaReply(pendingToolMediaReply)
        ? 1
        : 0;
      const visibleBlockReplyCount = getVisibleBlockReplyCount();
      const silentToolResultReplyPayload = resolveSilentToolResultReplyPayload({
        isCronTrigger: params.trigger === "cron",
        payloadCount: pendingToolMediaPayloadCount,
        aborted,
        timedOut,
        attempt: {
          clientToolCalls: completedClientToolCallsForAttempt,
          yieldDetected,
          didSendDeterministicApprovalPrompt: didSendDeterministicApprovalPromptNow,
          lastToolError,
          messagesSnapshot,
          toolMetas: toolMetasNormalized,
        },
      });
      const synthesizedPayloadCount =
        visibleBlockReplyCount +
        pendingToolMediaPayloadCount +
        messagingToolSourceReplyPayloads.length +
        (silentToolResultReplyPayload ? 1 : 0);
      const emptyAssistantReplyIsSilent = shouldTreatEmptyAssistantReplyAsSilent({
        allowEmptyAssistantReplyAsSilent: params.allowEmptyAssistantReplyAsSilent,
        payloadCount: 0,
        aborted,
        timedOut,
        attempt: {
          assistantTexts,
          clientToolCalls: completedClientToolCallsForAttempt,
          currentAttemptAssistant,
          yieldDetected,
          didSendDeterministicApprovalPrompt: didSendDeterministicApprovalPromptNow,
          didSendViaMessagingTool: didSendViaMessagingTool(),
          messagingToolSentTexts: getMessagingToolSentTexts(),
          messagingToolSentMediaUrls: getMessagingToolSentMediaUrls(),
          messagingToolSentTargets: getMessagingToolSentTargets(),
          acceptedSessionSpawns,
          lastToolError,
          lastAssistant,
          itemLifecycle: getItemLifecycle(),
          toolMetas: toolMetasNormalized,
          replayMetadata,
          promptErrorSource,
          timedOutDuringCompaction,
        },
      });
      const terminalAssistantTexts = resolveTerminalAssistantTexts({
        assistantTexts,
        lastAssistantStopReason: lastAssistant?.stopReason,
        lastAssistantVisibleText: resolveFinalAssistantVisibleText(lastAssistant),
      });
      const attemptTrajectoryTerminal = resolveAttemptTrajectoryTerminal({
        promptError,
        aborted,
        externalAbort,
        timedOut,
        assistantTexts: terminalAssistantTexts,
        toolMetas: toolMetasNormalized,
        didSendViaMessagingTool: didSendViaMessagingTool(),
        didSendDeterministicApprovalPrompt: didSendDeterministicApprovalPromptNow,
        messagingToolSentTexts: getMessagingToolSentTexts(),
        messagingToolSentMediaUrls: getMessagingToolSentMediaUrls(),
        messagingToolSentTargets: getMessagingToolSentTargets(),
        successfulCronAdds: getSuccessfulCronAdds(),
        synthesizedPayloadCount,
        acceptedSessionSpawns,
        heartbeatToolResponse,
        clientToolCalls: completedClientToolCalls,
        yieldDetected,
        lastToolError,
        silentExpected: params.silentExpected,
        emptyAssistantReplyIsSilent,
        lastAssistantStopReason: lastAssistant?.stopReason,
      });
      trajectoryRecorder?.recordEvent("model.completed", {
        aborted,
        externalAbort,
        timedOut,
        idleTimedOut,
        timedOutDuringCompaction,
        timedOutDuringToolExecution,
        promptError: promptError ? formatErrorMessage(promptError) : undefined,
        promptErrorSource,
        terminalError: attemptTrajectoryTerminal.terminalError,
        usage: attemptUsage,
        promptCache,
        compactionCount: getCompactionCount(),
        assistantTexts,
        finalPromptText,
        messagesSnapshot,
      });
      trajectoryRecorder?.recordEvent(
        "trace.artifacts",
        buildTrajectoryArtifacts({
          status: attemptTrajectoryTerminal.status,
          aborted,
          externalAbort,
          timedOut,
          idleTimedOut,
          timedOutDuringCompaction,
          timedOutDuringToolExecution,
          promptError: promptError ? formatErrorMessage(promptError) : undefined,
          promptErrorSource,
          terminalError: attemptTrajectoryTerminal.terminalError,
          usage: attemptUsage,
          promptCache,
          compactionCount: getCompactionCount(),
          assistantTexts,
          finalPromptText,
          itemLifecycle: getItemLifecycle(),
          toolMetas: toolMetasNormalized,
          didSendViaMessagingTool: didSendViaMessagingTool(),
          successfulCronAdds: getSuccessfulCronAdds(),
          messagingToolSentTexts: getMessagingToolSentTexts(),
          messagingToolSentMediaUrls: getMessagingToolSentMediaUrls(),
          messagingToolSentTargets: getMessagingToolSentTargets(),
          lastToolError,
        }),
      );
      trajectoryRecorder?.recordEvent("session.ended", {
        status: attemptTrajectoryTerminal.status,
        aborted,
        externalAbort,
        timedOut,
        idleTimedOut,
        timedOutDuringCompaction,
        timedOutDuringToolExecution,
        promptError: promptError ? formatErrorMessage(promptError) : undefined,
        terminalError: attemptTrajectoryTerminal.terminalError,
      });
      trajectoryEndRecorded = true;

      return {
        replayMetadata,
        itemLifecycle: getItemLifecycle(),
        setTerminalLifecycleMeta,
        aborted,
        externalAbort,
        timedOut,
        idleTimedOut,
        timedOutDuringCompaction,
        timedOutDuringToolExecution,
        promptError,
        promptErrorSource,
        preflightRecovery,
        sessionIdUsed,
        sessionFileUsed,
        diagnosticTrace,
        bootstrapPromptWarningSignaturesSeen: bootstrapPromptWarning.warningSignaturesSeen,
        bootstrapPromptWarningSignature: bootstrapPromptWarning.signature,
        systemPromptReport,
        finalPromptText,
        messagesSnapshot,
        assistantTexts,
        toolMetas: toolMetasNormalized,
        acceptedSessionSpawns,
        lastAssistant,
        currentAttemptAssistant,
        lastToolError,
        didSendViaMessagingTool: didSendViaMessagingTool(),
        didSendDeterministicApprovalPrompt: didSendDeterministicApprovalPromptNow,
        messagingToolSentTexts: getMessagingToolSentTexts(),
        messagingToolSentMediaUrls: getMessagingToolSentMediaUrls(),
        messagingToolSentTargets: getMessagingToolSentTargets(),
        messagingToolSourceReplyPayloads,
        heartbeatToolResponse,
        toolMediaUrls: pendingToolMediaReply?.mediaUrls,
        toolAudioAsVoice: pendingToolMediaReply?.audioAsVoice,
        toolTrustedLocalMedia: pendingToolMediaReply?.trustedLocalMedia,
        successfulCronAdds: getSuccessfulCronAdds(),
        cloudCodeAssistFormatError: Boolean(
          lastAssistant?.errorMessage && isCloudCodeAssistFormatError(lastAssistant.errorMessage),
        ),
        attemptUsage,
        promptCache,
        contextBudgetStatus,
        compactionCount: getCompactionCount(),
        compactionTokensAfter: getLastCompactionTokensAfter(),
        // Client tool calls detected (OpenResponses hosted tools).
        // Stay `undefined` (not `[]`) when none were detected so downstream
        // truthiness predicates keep working without a `.length` check.
        clientToolCalls: completedClientToolCalls.length > 0 ? completedClientToolCalls : undefined,
        yieldDetected: yieldDetected || undefined,
      };
    } finally {
      if (trajectoryRecorder && !trajectoryEndRecorded) {
        trajectoryRecorder.recordEvent("session.ended", {
          status: promptError ? "error" : aborted || timedOut ? "interrupted" : "cleanup",
          aborted,
          externalAbort,
          timedOut,
          idleTimedOut,
          timedOutDuringCompaction,
          timedOutDuringToolExecution,
          promptError: promptError ? formatErrorMessage(promptError) : undefined,
        });
      }
      await flushEmbeddedAttemptTrajectoryRecorder({
        runId: params.runId,
        sessionId: params.sessionId,
        log,
        trajectoryRecorder,
      });
      // Always tear down the session (and release the lock) before we leave this attempt.
      //
      // BUGFIX: Wait for the agent to be truly idle before flushing pending tool results.
      // agent runtime's auto-retry resolves waitForRetry() on assistant message receipt,
      // *before* tool execution completes in the retried agent loop. Without this wait,
      // flushPendingToolResults() fires while tools are still executing, inserting
      // synthetic "missing tool result" errors and causing silent agent failures.
      // See: https://github.com/openclaw/openclaw/issues/8643
      let cleanupError: unknown;
      try {
        clearToolSearchCatalog({
          sessionId: params.sessionId,
          sessionKey: sandboxSessionKey,
          agentId: sessionAgentId,
          runId: params.runId,
          catalogRef: toolSearchCatalogRef,
        });
        const cleanupAborted =
          Boolean(params.abortSignal?.aborted) ||
          aborted ||
          timedOut ||
          idleTimedOut ||
          timedOutDuringCompaction;
        const cleanupAbortLike = cleanupAborted || cleanupYieldAborted;
        const cleanupSessionLock = await sessionLockController.acquireForCleanup({ session });
        await cleanupEmbeddedAttemptResources({
          removeToolResultContextGuard,
          flushPendingToolResultsAfterIdle,
          session,
          sessionManager,
          bundleMcpRuntime,
          bundleLspRuntime,
          sessionLock: cleanupSessionLock,
          // PERF: If the run was aborted (user stop, timeout, sessions_yield, etc.),
          // skip the idle wait and flush pending results synchronously so we can
          // release the session lock ASAP.
          aborted: cleanupAbortLike,
          abortSettlePromise: cleanupAborted ? buildAbortSettlePromise() : null,
          skipSessionFlush: sessionLockController.hasSessionTakeover(),
          runId: params.runId,
          sessionId: params.sessionId,
        });
      } catch (err) {
        cleanupError = err;
      }
      const synthesizedCleanupTakeoverError =
        !cleanupError && promptError && sessionLockController.hasSessionTakeover()
          ? new EmbeddedAttemptSessionTakeoverError(params.sessionFile)
          : undefined;
      const cleanupFailure = cleanupError ?? synthesizedCleanupTakeoverError;
      const shouldPreservePromptError = shouldPreservePromptErrorAfterCleanupError({
        promptError,
        cleanupError: cleanupFailure,
      });
      emitDiagnosticRunCompleted?.(
        cleanupFailure
          ? "error"
          : beforeAgentRunBlocked
            ? "blocked"
            : promptError
              ? "error"
              : aborted || timedOut || idleTimedOut || timedOutDuringCompaction
                ? "aborted"
                : "completed",
        shouldPreservePromptError ? promptError : (cleanupFailure ?? promptError),
        beforeAgentRunBlocked
          ? { blockedBy: beforeAgentRunBlockedBy ?? "before_agent_run" }
          : undefined,
      );
      if (cleanupFailure) {
        if (shouldPreservePromptError) {
          log.warn(
            `embedded attempt cleanup detected session takeover after prompt failure; preserving prompt error: ` +
              `runId=${params.runId} sessionId=${params.sessionId} ` +
              `promptError=${formatErrorMessage(promptError)} cleanupError=${formatErrorMessage(cleanupFailure)}`,
          );
          await Promise.reject(
            new EmbeddedAttemptPromptErrorWithCleanupTakeoverError({
              promptError,
              cleanupError: cleanupFailure as EmbeddedAttemptSessionTakeoverError,
            }),
          );
        } else {
          await Promise.reject(toLintErrorObject(cleanupFailure, "Non-Error rejection"));
        }
      }
    }
  } finally {
    removeExternalAbortSignalListener?.();
    if (!sessionCleanupOwnsEmbeddedResources) {
      try {
        await cleanupEmbeddedPrepResourcesAfterEarlyExit();
      } catch (cleanupErr) {
        log.warn(
          `failed to clean up embedded prep resources after early attempt exit: runId=${params.runId} ${String(cleanupErr)}`,
        );
      }
    }
    try {
      await releaseRetainedSessionLock?.();
    } catch (releaseErr) {
      log.error(
        `failed to release retained session lock on attempt teardown: runId=${params.runId} ${String(releaseErr)}`,
      );
    }
    retainedSessionFileOwner?.release();
    emitDiagnosticRunCompleted?.(
      aborted ? "aborted" : "error",
      promptError ?? new Error("run exited before diagnostic completion"),
    );
    restoreSkillEnv?.();
  }
}

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
