/**
 * Orchestrates one embedded-agent attempt from prompt setup through stream result.
 */
import fs from "node:fs/promises";
import os from "node:os";
import { ensureSystemPromptCacheBoundary } from "@openclaw/ai/internal/shared";
import { MAX_IMAGE_BYTES } from "@openclaw/media-core/constants";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isAcpRuntimeSpawnAvailable } from "../../../acp/runtime/availability.js";
import { buildHierarchyReinforcementMessage } from "../../../auto-reply/handoff-summarizer.js";
import { filterHeartbeatTranscriptArtifacts } from "../../../auto-reply/heartbeat-filter.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { resolveStorePath } from "../../../config/sessions/paths.js";
import {
  listSessionEntries,
  loadSessionEntry,
  updateSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { resolveQuotaSuspensionEntryMaintenance } from "../../../config/sessions/store-maintenance.js";
import {
  bindOwnedSessionTranscriptWrites,
  type OwnedSessionTranscriptCacheSnapshot,
  type OwnedSessionTranscriptWriteOptions,
  withOwnedSessionTranscriptWrites,
} from "../../../config/sessions/transcript-write-context.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import {
  assertContextEngineHostSupport,
  OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
} from "../../../context-engine/host-compat.js";
import { resolveContextEngineOwnerPluginId } from "../../../context-engine/registry.js";
import { buildContextEngineRuntimeSettings } from "../../../context-engine/runtime-settings.js";
import type { AssembleResult } from "../../../context-engine/types.js";
import {
  diagnosticErrorCategory,
  diagnosticErrorMessage,
} from "../../../infra/diagnostic-error-metadata.js";
import {
  emitTrustedDiagnosticEvent,
  emitTrustedDiagnosticEventWithPrivateData,
} from "../../../infra/diagnostic-events.js";
import { resolveDiagnosticModelContentCapturePolicy } from "../../../infra/diagnostic-llm-content.js";
import {
  createChildDiagnosticTraceContext,
  createDiagnosticTraceContext,
  getActiveDiagnosticTraceContext,
  freezeDiagnosticTraceContext,
} from "../../../infra/diagnostic-trace-context.js";
import { isEmbeddedMode } from "../../../infra/embedded-mode.js";
import { formatErrorMessage, toErrorObject } from "../../../infra/errors.js";
import { resolveHeartbeatSummaryForAgent } from "../../../infra/heartbeat-summary.js";
import { getMachineDisplayName } from "../../../infra/machine-name.js";
import { resolveRuntimeOsLabel } from "../../../infra/os-summary.js";
import { createCodexNativeWebSearchWrapper } from "../../../llm/providers/stream-wrappers/openai.js";
import type { AssistantMessage } from "../../../llm/types.js";
import { listRegisteredPluginAgentPromptGuidance } from "../../../plugins/command-registry-state.js";
import { getCurrentPluginMetadataSnapshot } from "../../../plugins/current-plugin-metadata-snapshot.js";
import {
  buildAgentHookContextChannelFields,
  buildAgentHookContextIdentityFields,
} from "../../../plugins/hook-agent-context.js";
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
import { isTranscriptOnlyOpenClawAssistantMessage } from "../../../shared/transcript-only-openclaw-assistant.js";
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
  toToolDefinitions,
} from "../../agent-tool-definition-adapter.js";
import { recordStructuredReplayTrustForToolCall } from "../../agent-tools.before-tool-call.js";
import {
  createOpenClawCodingTools,
  resolveProcessToolScopeKey,
  resolveToolLoopDetectionConfig,
} from "../../agent-tools.js";
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
  makeBootstrapWarn,
  resolveBootstrapFilesForRun,
  resolveContextInjectionMode,
} from "../../bootstrap-files.js";
import { isHeartbeatLifecycleRunKind } from "../../bootstrap-mode.js";
import {
  isPrimaryBootstrapRun,
  resolveWorkspaceBootstrapRouting,
} from "../../bootstrap-routing.js";
import { createCacheTrace } from "../../cache-trace.js";
import {
  getChannelAgentToolMeta,
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
import {
  resolveConversationCapabilityProfile,
  type ResolvedConversationCapabilityProfile,
} from "../../conversation-capability-profile.js";
import { resolveUserTimezone } from "../../date-time.js";
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
import { isSignalTimeoutReason } from "../../failover-error.js";
import { runAgentEndSideEffects } from "../../harness/agent-end-side-effects.js";
import { runAgentHarnessBeforeAgentFinalizeHook } from "../../harness/lifecycle-hook-helpers.js";
import { resolveHeartbeatPromptForSystemPrompt } from "../../heartbeat-system-prompt.js";
import { resolveImageSanitizationLimits } from "../../image-sanitization.js";
import { relocateCurrentRuntimeContextCarrierToTail } from "../../internal-runtime-context.js";
import {
  applyLocalModelLeanToolSearchDefaults,
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
import {
  AGENT_RUN_RESTART_ABORT_STOP_REASON,
  createAgentRunRestartAbortError,
  isAgentRunRestartAbortReason,
} from "../../run-termination.js";
import { collectRuntimeChannelCapabilities } from "../../runtime-capabilities.js";
import {
  logAgentRuntimeToolDiagnostics,
  normalizeAgentRuntimeTools,
} from "../../runtime-plan/tools.js";
import type { AgentMessage } from "../../runtime/index.js";
import { resolveSandboxContext } from "../../sandbox.js";
import { resolveSandboxRuntimeStatus } from "../../sandbox/runtime-status.js";
import {
  invalidateSessionFileRepairCache,
  repairSessionFileIfNeeded,
} from "../../session-file-repair.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import { sanitizeToolUseResultPairing } from "../../session-transcript-repair.js";
import { acquireSessionWriteLock } from "../../session-write-lock.js";
import { createAgentSession, SessionManager } from "../../sessions/index.js";
import { wrapToolDefinition } from "../../sessions/tools/tool-definition-wrapper.js";
import { detectRuntimeShell } from "../../shell-utils.js";
import { buildActiveSubagentSystemPromptAddition } from "../../subagent-active-context.js";
import {
  ackPendingAgentSteeringItems,
  leasePendingAgentSteeringItems,
  prependAgentSteeringPrompt,
  releasePendingAgentSteeringItems,
} from "../../subagent-registry.js";
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
import { collectReplaySafeToolNames, isAgentToolReplaySafe } from "../../tool-replay-safety.js";
import { filterRuntimeCompatibleTools } from "../../tool-schema-projection.js";
import { logRuntimeToolSchemaQuarantine } from "../../tool-schema-quarantine.js";
import {
  addClientToolsToToolSearchCatalog,
  applyToolSchemaDirectoryCatalog,
  applyToolSearchCatalog,
  buildToolSchemaDirectoryPrompt,
  clearToolSearchCatalog,
  createToolSearchCatalogRef,
  estimateToolSchemaDirectoryToolNames,
  projectToolSearchTargetTranscriptMessages,
  resolveToolSearchCatalogTool,
  resolveToolSearchConfig,
  TOOL_CALL_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_SEARCH_RAW_TOOL_NAME,
  type ToolSearchCatalogRef,
  type ToolSearchCatalogToolExecutor,
  type ToolSearchTargetTranscriptProjection,
} from "../../tool-search.js";
import {
  replaceWithEffectiveCronCreatorToolAllowlist,
  type CronCreatorToolAllowlistEntry,
} from "../../tools/cron-tool.js";
import { shouldAllowProviderOwnedThinkingReplay } from "../../transcript-policy.js";
import { normalizeUsage, type NormalizedUsage } from "../../usage.js";
import {
  DEFAULT_BOOTSTRAP_FILENAME,
  isWorkspaceBootstrapPending,
  type WorkspaceBootstrapFile,
} from "../../workspace.js";
import { isRunnerAbortError } from "../abort.js";
import { isCacheTtlEligibleProvider, readLastCacheTtlTimestamp } from "../cache-ttl.js";
import { resolveCompactionTimeoutMs } from "../compaction-safety-timeout.js";
import {
  rotateTranscriptAfterCompaction,
  shouldRotateCompactionTranscript,
} from "../compaction-successor-transcript.js";
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
import {
  mapSandboxSkillEntriesForPrompt,
  mapSandboxSkillUsagePaths,
  resolveSandboxSkillRuntimeInputs,
} from "../sandbox-skills.js";
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
import { repairRejectedThinkingReplayInSessionManager } from "../thinking-replay-repair.js";
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
  resolveLiveToolResultAggregateMaxChars,
  createToolResultPromptProjectionState,
  truncateOversizedToolResultsInMessages,
  type ToolResultPromptProjectionState,
  truncateOversizedToolResultsInSessionManager,
} from "../tool-result-truncation.js";
import { splitSdkTools } from "../tool-split.js";
import { mapThinkingLevel } from "../utils.js";
import { flushPendingToolResultsAfterIdle } from "../wait-for-idle-before-flush.js";
import { abortable as abortableWithSignal } from "./abortable.js";
import { releaseEmbeddedAttemptSessionLockForAbort } from "./attempt-abort.js";
import { configureEmbeddedAttemptHttpRuntime } from "./attempt-http-runtime.js";
import { createEmbeddedAgentSessionWithResourceLoader } from "./attempt-session.js";
import {
  createEmbeddedRunStageTracker,
  formatEmbeddedRunStageSummary,
  shouldWarnEmbeddedRunStageSummary,
} from "./attempt-stage-timing.js";
import { buildAttemptSystemPrompt } from "./attempt-system-prompt.js";
import {
  applyEmbeddedAttemptToolsAllow,
  mergeForcedEmbeddedAttemptToolsAllow,
  resolveEmbeddedAttemptToolConstructionPlan,
  shouldCreateBundleLspRuntimeForAttempt,
  shouldCreateBundleMcpRuntimeForAttempt,
} from "./attempt-tool-construction-plan.js";
import { flushEmbeddedAttemptTrajectoryRecorder } from "./attempt-trajectory-flush-cleanup.js";
import {
  resolveAttemptTrajectoryTerminal,
  resolveTerminalAssistantTexts,
} from "./attempt-trajectory-status.js";
import {
  requiresCompletionRequiredAsyncTaskWait,
  shouldWaitForCompletionRequiredAsyncTasks,
  waitForCompletionRequiredAsyncTasks,
  type AsyncStartedToolMeta,
  type CompletionRequiredAsyncTaskWaitResult,
} from "./attempt.async-tasks.js";
import { remapInjectedContextFilesToWorkspace } from "./attempt.bootstrap-context.js";
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
  normalizeCurrentPromptTextForLlmBoundary,
  normalizeMessagesForCurrentPromptBoundary,
  normalizeMessagesForLlmBoundary,
} from "./attempt.llm-boundary.js";
import { wrapStreamFnWithDiagnosticModelCallEvents } from "./attempt.model-diagnostic-events.js";
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
import {
  hasActiveCompactionRetryWork,
  waitForCompactionRetryWithAggregateTimeout,
} from "./compaction-retry-aggregate-timeout.js";
import {
  canContinueFromMessage,
  resolveRunTimeoutDuringCompaction,
  selectCompactionTimeoutSnapshot,
  shouldFlagCompactionTimeout,
  trimToContinuableTail,
} from "./compaction-timeout.js";
import {
  resolveFinalAssistantRawText,
  resolveFinalAssistantVisibleText,
  resolveReportedModelRef,
} from "./helpers.js";
import {
  installHistoryImagePruneContextTransform,
  pruneProcessedHistoryImages,
} from "./history-image-prune.js";
import { detectAndLoadPromptImages } from "./images.js";
import {
  buildAttemptReplayMetadata,
  hasAttemptTerminalState,
  resolveSilentToolResultReplyPayload,
  shouldTreatEmptyAssistantReplyAsSilent,
} from "./incomplete-turn.js";
import {
  resolveLlmFirstEventTimeoutMs,
  resolveLlmIdleTimeoutMs,
  streamWithIdleTimeout,
} from "./llm-idle-timeout.js";
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
  estimateLlmBoundaryTokenPressure,
  estimateRenderedLlmBoundaryTokenPressure,
  formatPrePromptPrecheckLog,
  shouldPreemptivelyCompactBeforePrompt,
} from "./preemptive-compaction.js";
import {
  buildCurrentInboundPrompt,
  buildRuntimeContextCustomMessage,
  resolveRuntimeContextPromptParts,
} from "./runtime-context-prompt.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./types.js";

type PreflightRecoveryBudgetSnapshot = Pick<
  MidTurnPrecheckRequest,
  "estimatedPromptTokens" | "promptBudgetBeforeReserve" | "overflowTokens"
>;

// Carries the measured prompt budget into the outer recovery loop. The synthetic
// precheck error is only a routing signal, so compaction engines need these
// fields to compact against the prompt OpenClaw actually rendered.
function buildPreflightRecoveryBudgetSnapshot(snapshot: PreflightRecoveryBudgetSnapshot) {
  return {
    estimatedPromptTokens: snapshot.estimatedPromptTokens,
    promptBudgetBeforeReserve: snapshot.promptBudgetBeforeReserve,
    overflowTokens: snapshot.overflowTokens,
  };
}

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
} from "./attempt.prompt-helpers.js";
export {
  resetEmbeddedAgentBaseStreamFnCacheForTest,
  resolveEmbeddedAgentBaseStreamFn,
  resolveEmbeddedAgentStreamFn,
};

const MAX_BTW_SNAPSHOT_MESSAGES = 100;
const aggregateToolResultPressureWarnings = new Set<string>();

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

function repairAttemptToolUseResultPairing(
  messages: AgentMessage[],
  isOpenAIResponsesApi: boolean,
): AgentMessage[] {
  return sanitizeToolUseResultPairing(messages, {
    erroredAssistantResultPolicy: "drop",
    ...(isOpenAIResponsesApi ? { missingToolResultText: "aborted" } : {}),
  });
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
  const removedActiveError = isMidTurnPrecheckAssistantError(messages.at(-1));
  if (removedActiveError) {
    params.activeSession.agent.state.messages = messages.slice(0, -1);
  }

  const removedPersistedError =
    params.sessionManager.removeTrailingEntries(
      (entry) => entry.type === "message" && isMidTurnPrecheckAssistantError(entry.message),
      {
        preserveTrailing: (entry) =>
          entry.type === "custom" ||
          entry.type === "label" ||
          entry.type === "session_info" ||
          (entry.type === "message" && isTranscriptOnlyOpenClawAssistantMessage(entry.message)),
      },
    ) > 0;
  if (removedActiveError && !removedPersistedError) {
    log.warn(
      "[context-overflow-midturn-precheck] removed synthetic assistant error from active session but could not locate matching persisted SessionManager entry",
    );
  }
}

function normalizeCompactionRecoveryTranscriptTail(params: {
  activeSession: { agent: { state: { messages: AgentMessage[] } } };
  sessionManager: ReturnType<typeof guardSessionManager>;
}): number {
  const messages = params.activeSession.agent.state.messages;
  const continuableMessages = trimToContinuableTail(messages) ?? [];

  // This is the single recovery owner for compaction exits that hand control
  // back to a continuation. AgentCore rejects assistant tails before providers run.
  const removedEntries = params.sessionManager.removeTrailingEntries(
    (entry) => entry.type === "message" && !canContinueFromMessage(entry.message),
    {
      preserveTrailing: (entry) =>
        entry.type === "custom" ||
        entry.type === "label" ||
        entry.type === "session_info" ||
        (entry.type === "message" && isTranscriptOnlyOpenClawAssistantMessage(entry.message)),
    },
  );
  params.activeSession.agent.state.messages =
    removedEntries > 0
      ? params.sessionManager.buildSessionContext().messages
      : continuableMessages.length === messages.length
        ? messages
        : continuableMessages;
  return removedEntries;
}

function collectAttemptExplicitToolAllowlistSources(params: {
  // The attempt's single resolved profile: keeps these allowlist *sources*
  // in lockstep with the policy that actually constructed and filtered the
  // run's tools, instead of re-resolving with divergent session inputs.
  capabilityProfile: ResolvedConversationCapabilityProfile;
  toolsAllow?: string[];
}) {
  const {
    agentId,
    globalPolicy,
    globalProviderPolicy,
    agentPolicy,
    agentProviderPolicy,
    groupPolicy,
    sandboxPolicy,
    subagentPolicy,
    inheritedToolPolicy,
  } = params.capabilityProfile.policy;
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
    { label: "sandbox tools.allow", allow: sandboxPolicy?.allow },
    { label: "subagent tools.allow", allow: subagentPolicy?.allow },
    { label: "inherited tools.allow", allow: inheritedToolPolicy?.allow },
    { label: "runtime toolsAllow", allow: params.toolsAllow, enforceWhenToolsDisabled: true },
  ]);
}

// Applies quota-resume TTL maintenance to only the active attempt session.
async function loadAttemptSessionEntryAfterQuotaMaintenance(params: {
  storePath: string;
  sessionKey: string;
}): Promise<SessionEntry | undefined> {
  const entry = loadSessionEntry({
    storePath: params.storePath,
    sessionKey: params.sessionKey,
  });
  if (!entry?.quotaSuspension) {
    return entry;
  }
  const now = Date.now();
  const maintenance = resolveQuotaSuspensionEntryMaintenance({ entry, now });
  if (!maintenance.patch) {
    return entry;
  }
  const updated = await updateSessionEntry(
    {
      storePath: params.storePath,
      sessionKey: params.sessionKey,
    },
    (currentEntry) =>
      resolveQuotaSuspensionEntryMaintenance({
        entry: currentEntry,
        now,
      }).patch,
    {
      skipMaintenance: true,
      takeCacheOwnership: true,
    },
  );
  return updated ?? entry;
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
  let timedOutByRunBudget = false;
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
    const timeout = reason ? isSignalTimeoutReason(reason) : false;
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
    const {
      skillsEligibility,
      skillsPromptWorkspaceDir: effectiveSkillsPromptWorkspace,
      skillsSnapshot: skillsSnapshotForRun,
      skillsWorkspaceDir: effectiveSkillsWorkspace,
      workspaceOnly: loadSkillsWorkspaceOnly,
    } = resolveSandboxSkillRuntimeInputs({
      sandbox,
      effectiveWorkspace,
      skillsSnapshot: params.skillsSnapshot,
    });
    const { shouldLoadSkillEntries, skillEntries } = resolveEmbeddedRunSkillEntries({
      workspaceDir: effectiveSkillsWorkspace,
      config: params.config,
      agentId: sessionAgentId,
      eligibility: skillsEligibility,
      skillsSnapshot: skillsSnapshotForRun,
      workspaceOnly: loadSkillsWorkspaceOnly,
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
    const promptSkillEntries = mapSandboxSkillEntriesForPrompt({
      entries: shouldLoadSkillEntries ? skillEntries : undefined,
      skillsWorkspaceDir: effectiveSkillsWorkspace,
      skillsPromptWorkspaceDir: effectiveSkillsPromptWorkspace,
    });
    const skillUsagePaths = mapSandboxSkillUsagePaths({
      paths: sandbox?.skillUsagePaths,
      skillsWorkspaceDir: effectiveSkillsWorkspace,
      skillsPromptWorkspaceDir: effectiveSkillsPromptWorkspace,
    });

    const skillsPrompt = resolveSkillsPromptForRun({
      skillsSnapshot: skillsSnapshotForRun,
      entries: promptSkillEntries,
      config: params.config,
      workspaceDir: effectiveSkillsPromptWorkspace,
      agentId: sessionAgentId,
      eligibility: skillsEligibility,
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
      getActiveDiagnosticTraceContext() ?? createDiagnosticTraceContext(),
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
      const failed = err != null && outcome !== "blocked";
      const errorMessage = failed ? diagnosticErrorMessage(err) : undefined;
      emitTrustedDiagnosticEventWithPrivateData(
        {
          type: "run.completed",
          ...diagnosticRunBase,
          durationMs: Date.now() - diagnosticRunStartedAt,
          outcome,
          ...(extra?.blockedBy ? { blockedBy: extra.blockedBy } : {}),
          ...(failed ? { errorCategory: diagnosticErrorCategory(err) } : {}),
        },
        errorMessage ? { errorMessage } : undefined,
      );
    };
    const corePluginToolStages = createEmbeddedRunStageTracker();
    const forceDirectMessageTool =
      params.forceMessageTool === true || params.sourceReplyDeliveryMode === "message_tool_only";
    const toolsAllowWithForcedRuntimeTools = mergeForcedEmbeddedAttemptToolsAllow(
      params.toolsAllow,
      {
        forceMessageTool: forceDirectMessageTool,
      },
    );
    const toolsEnabled = supportsModelTools(params.model);
    const toolConstructionPlan = resolveEmbeddedAttemptToolConstructionPlan({
      disableTools: params.disableTools,
      isRawModelRun,
      toolsEnabled,
      toolsAllow: toolsAllowWithForcedRuntimeTools,
    });
    const codeModeConfig = resolveCodeModeConfig(params.config, sessionAgentId);
    const toolSearchRuntimeConfig = forceDirectMessageTool
      ? params.config
      : applyLocalModelLeanToolSearchDefaults({
          config: params.config,
          agentId: sessionAgentId,
          sessionKey: sandboxSessionKey,
        });
    const toolSearchConfig = resolveToolSearchConfig(toolSearchRuntimeConfig);
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
      toolSearchConfig.enabled;
    const effectiveToolsAllow =
      toolSearchControlsEnabledForRun && toolsAllowWithForcedRuntimeTools
        ? [
            ...new Set([
              ...toolsAllowWithForcedRuntimeTools,
              ...TOOL_SEARCH_CONTROL_ALLOWLIST_NAMES,
            ]),
          ]
        : toolsAllowWithForcedRuntimeTools;
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
    const cronCreatorToolAllowlist: CronCreatorToolAllowlistEntry[] = [];
    const spawnWorkspaceDir =
      effectiveCwd !== effectiveWorkspace
        ? resolvedWorkspace
        : resolveAttemptSpawnWorkspaceDir({
            sandbox,
            resolvedWorkspace,
          });
    const runtimeCapabilityProfile = resolveConversationCapabilityProfile({
      config: toolSearchRuntimeConfig,
      sessionKey: sandboxSessionKey,
      runSessionKey:
        params.sessionKey && params.sessionKey !== sandboxSessionKey
          ? params.sessionKey
          : undefined,
      sessionId: params.sessionId,
      runId: params.runId,
      agentId: sessionAgentId,
      agentDir,
      agentAccountId: params.agentAccountId,
      messageProvider: resolveAttemptToolPolicyMessageProvider(params),
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
      cwd: effectiveCwd,
      spawnWorkspaceDir,
      isCanonicalWorkspace: params.isCanonicalWorkspace,
      promptMode: params.promptMode,
      skillsSnapshot: skillsSnapshotForRun,
      sandboxToolPolicy: sandbox?.tools,
      runtimeToolAllowlist: effectiveToolsAllow,
    });
    const localModelLeanPreserveToolNames = resolveLocalModelLeanPreserveToolNames({
      toolNames: runtimeCapabilityProfile.policy.explicitToolOverrideAllowlist,
      forceMessageTool: params.forceMessageTool,
      sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    });
    const toolsRaw = !shouldConstructTools
      ? []
      : (() => {
          const allTools = createOpenClawCodingTools({
            agentId: sessionAgentId,
            ...(params.crestodianTool ? { crestodianTool: params.crestodianTool } : {}),
            ...buildEmbeddedAttemptToolRunContext({ ...params, trace: runTrace }),
            messageChannel: params.messageChannel,
            chatType: params.chatType,
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
            channelContext: params.channelContext,
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
            approvalReviewerDeviceId: params.approvalReviewerDeviceId,
            oneShotCliRun: params.oneShotCliRun,
            toolSearchCatalogRef,
            agentDir,
            cwd: effectiveCwd,
            workspaceDir: effectiveWorkspace,
            // Runtime cwd can point at a task repo while bootstrap/persona files stay in the
            // agent workspace. Spawned subagents inherit the real agent workspace, not task cwd.
            spawnWorkspaceDir,
            config: toolSearchRuntimeConfig,
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
            currentMessagingTarget: params.currentMessagingTarget,
            currentThreadTs: params.currentThreadTs,
            currentMessageId: params.currentMessageId,
            currentInboundAudio: params.currentInboundAudio,
            ...(params.replyOperation
              ? {
                  hasCurrentInboundAudio: () =>
                    params.currentInboundAudio === true ||
                    params.replyOperation?.acceptedSteeredInboundAudio === true,
                }
              : {}),
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
            cronCreatorToolAllowlistRef: cronCreatorToolAllowlist,
            authProfileStore: params.authProfileStore,
            recordToolPrepStage: (name) => corePluginToolStages.mark(name),
            onToolOutcome: params.onToolOutcome,
            allocateToolOutcomeOrdinal: params.allocateToolOutcomeOrdinal,
            skillsSnapshot: skillsSnapshotForRun,
            skillUsagePaths,
            conversationCapabilityProfile: runtimeCapabilityProfile,
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
      resolveWorkspaceBootstrapRouting({
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
      !isHeartbeatLifecycleRunKind(params.bootstrapContextRunKind) &&
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
          agentId: sessionAgentId,
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
      conversationCapabilityProfile: runtimeCapabilityProfile,
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
                agentId: sessionAgentId,
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
    if (cronCreatorToolAllowlist.length > 0) {
      // Cron is constructed before bundled MCP/LSP tools are appended; refresh
      // the shared cap so scheduled turns preserve the creator's full surface.
      replaceWithEffectiveCronCreatorToolAllowlist(
        cronCreatorToolAllowlist,
        projectedUncompactedEffectiveTools,
        (tool) => getPluginToolMeta(tool),
      );
    }
    const uncompactedToolSchemaProjection = filterRuntimeCompatibleTools(
      projectedUncompactedEffectiveTools,
    );
    logRuntimeToolSchemaQuarantine({
      diagnostics: uncompactedToolSchemaProjection.diagnostics,
      tools: projectedUncompactedEffectiveTools,
      runId: params.runId,
      agentId: sessionAgentId,
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
      approvalReviewerDeviceId: params.approvalReviewerDeviceId,
      channelId: params.currentChannelId,
      trace: runTrace,
      loopDetection: resolveToolLoopDetectionConfig({
        cfg: params.config,
        agentId: sessionAgentId,
      }),
      onToolOutcome: params.onToolOutcome,
      allocateToolOutcomeOrdinal: params.allocateToolOutcomeOrdinal,
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
    const directoryRequiredToolNames =
      params.forceMessageTool === true || params.sourceReplyDeliveryMode === "message_tool_only"
        ? ["message"]
        : [];
    const directoryHydratedToolNames =
      toolSearchControlsEnabledForRun && toolSearchConfig.mode === "directory"
        ? (() => {
            try {
              return estimateToolSchemaDirectoryToolNames({
                tools: effectiveTools,
                query: params.prompt,
                maxTools: 4,
                requiredToolNames: directoryRequiredToolNames,
              });
            } catch (err) {
              log.warn(
                `tool-search: directory schema estimation failed; continuing with deferred schemas only (${String(err)})`,
              );
              return directoryRequiredToolNames;
            }
          })()
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
      : toolSearchConfig.mode === "directory"
        ? applyToolSchemaDirectoryCatalog({
            tools: effectiveTools,
            config: toolSearchRuntimeConfig,
            sessionId: params.sessionId,
            sessionKey: sandboxSessionKey,
            agentId: sessionAgentId,
            runId: params.runId,
            catalogRef: toolSearchCatalogRef,
            toolHookContext: catalogToolHookContext,
            hydrateToolNames: directoryHydratedToolNames,
          })
        : applyToolSearchCatalog({
            tools: effectiveTools,
            config: toolSearchRuntimeConfig,
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
      agentId: sessionAgentId,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
    });
    effectiveTools = [...toolSearchSchemaProjection.tools];
    if (toolSearch.compacted && !toolSearch.catalogReused) {
      prepStages.mark(codeModeControlsEnabledForRun ? "code-mode" : "tool-search");
      log.info(
        codeModeControlsEnabledForRun
          ? `code-mode: cataloged ${toolSearch.catalogToolCount} tools behind exec/wait`
          : toolSearchConfig.mode === "directory"
            ? `tool-search: cataloged ${toolSearch.catalogToolCount} tools behind compact directory surface`
            : `tool-search: cataloged ${toolSearch.catalogToolCount} tools behind compact prompt surface`,
      );
    }
    const deferredDirectoryToolsCallable =
      toolSearchControlsEnabledForRun &&
      toolSearchConfig.mode === "directory" &&
      toolSearch.catalogRegistered;
    prepStages.mark("bundle-tools");
    const explicitToolAllowlistSources = collectAttemptExplicitToolAllowlistSources({
      capabilityProfile: runtimeCapabilityProfile,
      toolsAllow: params.toolsAllow,
    });
    const toolSearchRunPlan = buildToolSearchRunPlan({
      visibleTools: effectiveTools,
      uncompactedTools: uncompactedEffectiveTools,
      clientTools,
      clientToolsCataloged:
        toolSearch.catalogRegistered &&
        (codeModeControlsEnabledForRun || toolSearchConfig.mode !== "directory"),
      catalogToolCount: toolSearch.catalogToolCount,
      controlsEnabled: toolSearchControlsEnabledForRun || codeModeControlsEnabledForRun,
      deferredToolsCallable: deferredDirectoryToolsCallable,
      controlNames: codeModeControlsEnabledForRun
        ? [CODE_MODE_EXEC_TOOL_NAME, CODE_MODE_WAIT_TOOL_NAME]
        : toolSearchConfig.mode === "directory"
          ? [TOOL_SEARCH_RAW_TOOL_NAME, TOOL_DESCRIBE_RAW_TOOL_NAME, TOOL_CALL_RAW_TOOL_NAME]
          : undefined,
      explicitAllowlistSources: explicitToolAllowlistSources,
    });
    const replayAllowedToolNames = toolSearchRunPlan.replayAllowedToolNames;
    const liveAllowedToolNames = toolSearchRunPlan.liveAllowedToolNames;
    const capabilityToolNames = toolSearchRunPlan.capabilityToolNames;
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
    const toolSchemaDirectoryPrompt = deferredDirectoryToolsCallable
      ? buildToolSchemaDirectoryPrompt({
          config: params.config,
          runtimeConfig: params.config,
          agentId: sessionAgentId,
          sessionKey: sandboxSessionKey,
          sessionId: params.sessionId,
          runId: params.runId,
          catalogRef: toolSearchCatalogRef,
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
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        host: machineName,
        os: resolveRuntimeOsLabel(),
        arch: os.arch(),
        node: process.version,
        model: `${params.provider}/${params.modelId}`,
        defaultModel: defaultModelLabel,
        shell: detectRuntimeShell(),
        channel: runtimeChannel,
        chatType: params.chatType,
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
      bootstrapContextRunKind: params.bootstrapContextRunKind,
    })
      ? resolveHeartbeatPromptForSystemPrompt({
          config: params.config,
          agentId: sessionAgentId,
          defaultAgentId,
        })
      : undefined;
    const promptContributionTrigger =
      params.bootstrapContextRunKind === "commitment-only" ? undefined : params.trigger;
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
      trigger: promptContributionTrigger,
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
        toolSchemaDirectoryPrompt,
        sandboxInfo,
        capabilityToolNames: [...capabilityToolNames].toSorted(),
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
    let sessionManager: ReturnType<typeof guardSessionManager> | undefined;
    const sessionLockController = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      initialAcquireSignal: params.abortSignal,
      lockOptions: {
        sessionFile: params.sessionFile,
        ...sessionWriteLockOptions,
      },
      mergePromptReleasedSessionEntries: (entries) => {
        if (!sessionManager) {
          throw new Error("session manager unavailable during prompt-released entry merge");
        }
        return sessionManager.mergePromptReleasedSessionEntries(entries, { persistLeaf: true });
      },
      reloadPromptReleasedSessionFile: () => {
        if (!sessionManager) {
          throw new Error("session manager unavailable during prompt-released file reload");
        }
        sessionManager.setSessionFile(params.sessionFile);
      },
    });
    releaseRetainedSessionLock = () => sessionLockController.dispose();
    const ownedTranscriptWriteContext = {
      sessionFile: params.sessionFile,
      sessionKey: params.sessionKey,
      canAdvanceSessionEntryCache: (snapshot: OwnedSessionTranscriptCacheSnapshot) =>
        sessionLockController.canAdvanceSessionEntryCache(snapshot),
      publishSessionFileSnapshot: (snapshot: OwnedSessionTranscriptCacheSnapshot) =>
        sessionLockController.publishOwnedSessionFileSnapshot(snapshot),
      withSessionWriteLock: <T>(
        operation: () => Promise<T> | T,
        options?: OwnedSessionTranscriptWriteOptions<T>,
      ) => sessionLockController.withSessionWriteLock(operation, options),
    };
    const withOwnedSessionWriteLock = <T>(operation: () => Promise<T> | T): Promise<T> =>
      withOwnedSessionTranscriptWrites(ownedTranscriptWriteContext, async () =>
        sessionLockController.withSessionWriteLock(operation),
      );
    armExternalAbortSignal();
    // The signal can fire while the eager session lock is being acquired.
    // Recheck after arming so a stopped run never reaches session creation or provider prompt.
    await throwIfAttemptAbortSignalFiredAfterPrepCleanup();

    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    let removeToolResultContextGuard: (() => void) | undefined;
    let trajectoryRecorder: ReturnType<typeof createTrajectoryRuntimeRecorder> | null = null;
    let trajectoryEndRecorded = false;
    let buildAbortSettlePromise: () => Promise<void> | null = () => null;
    let cleanupYieldAborted = false;
    let repairedRejectedThinkingReplay = false;
    try {
      const trustedSessionFileSnapshot =
        await sessionLockController.readTrustedCurrentSessionFileSnapshot();
      const repairReport = await repairSessionFileIfNeeded({
        sessionFile: params.sessionFile,
        trustedSnapshot: trustedSessionFileSnapshot,
        debug: (message) => log.debug(message),
        warn: (message) => log.warn(message),
      });
      if (
        repairReport.validatedSnapshot &&
        !sessionLockController.publishValidatedSessionFileSnapshot(repairReport.validatedSnapshot)
      ) {
        invalidateSessionFileRepairCache(params.sessionFile);
      }
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
      const isOpenAIResponsesApi =
        params.model.api === "openai-responses" ||
        params.model.api === "azure-openai-responses" ||
        params.model.api === "openai-chatgpt-responses";

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
        withCompactionPersistence: (append, validateAppend) =>
          sessionLockController.withOwnedSessionFileWrite(append, validateAppend),
        onUserMessagePersisted: (message) => {
          params.onUserMessagePersisted?.(message);
        },
        onUserMessageBlocked: () => {
          params.userTurnTranscriptRecorder?.markBlocked();
        },
        onAssistantErrorMessagePersisted: (message) => {
          params.onAssistantErrorMessagePersisted?.(message);
        },
      });
      trackSessionManagerAccess(params.sessionFile);

      await withOwnedSessionWriteLock(async () => {
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
          contextEngineHostSupport: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
          providerId: params.provider,
          requestedModelId: params.requestedModelId,
          modelId: params.modelId,
          fallbackReason: params.fallbackReason,
          degradedReason: params.degradedReason,
          runMaintenance: async (contextParams) =>
            await runContextEngineMaintenance({
              contextEngine: contextParams.contextEngine as never,
              sessionId: contextParams.sessionId,
              sessionKey: contextParams.sessionKey,
              sessionFile: contextParams.sessionFile,
              reason: contextParams.reason,
              sessionManager: contextParams.sessionManager as never,
              runtimeContext: contextParams.runtimeContext,
              runtimeSettings: contextParams.runtimeSettings,
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
        runId: params.runId,
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
      const coreBuiltinToolNames = collectCoreBuiltinToolNames(uncompactedEffectiveTools, {
        isPluginTool: (tool) =>
          Boolean(getPluginToolMeta(tool as Parameters<typeof getPluginToolMeta>[0])),
      });
      const replaySafetyOptions = {
        declaredReplaySafe: (candidate: { name?: string }) => {
          const pluginMeta = getPluginToolMeta(
            candidate as Parameters<typeof getPluginToolMeta>[0],
          );
          if (pluginMeta) {
            return pluginMeta.replaySafe === true;
          }
          return getChannelAgentToolMeta(candidate as never) ? false : undefined;
        },
      };
      const isReplaySafeTool = (tool: { name?: string }) =>
        isAgentToolReplaySafe(tool, replaySafetyOptions);
      const replaySafeTools = new Set(uncompactedEffectiveTools.filter(isReplaySafeTool));
      const replaySafeToolNames = collectReplaySafeToolNames(
        uncompactedEffectiveTools,
        replaySafetyOptions,
      );
      // Directory exact-name hydration cannot distinguish a hidden catalog tool
      // from a visible client tool that shadows it. Other modes preserve the
      // existing client/plugin coexistence behavior and use core conflicts only.
      const clientConflictToolNames = deferredDirectoryToolsCallable
        ? builtinToolNames
        : coreBuiltinToolNames;
      const clientToolNameConflicts = findClientToolNameConflicts({
        tools: clientTools ?? [],
        existingToolNames: [...clientConflictToolNames, ...AGENT_RESERVED_TOOL_NAMES],
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
              config: toolSearchRuntimeConfig,
              sessionId: params.sessionId,
              runId: params.runId,
              loopDetection: clientToolLoopDetection,
              onToolOutcome: params.onToolOutcome,
              allocateToolOutcomeOrdinal: params.allocateToolOutcomeOrdinal,
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
            config: toolSearchRuntimeConfig,
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
          resolveDeferredTool: deferredDirectoryToolsCallable
            ? ({ toolCall }) => {
                const tool = resolveToolSearchCatalogTool(
                  {
                    config: params.config,
                    runtimeConfig: params.config,
                    agentId: sessionAgentId,
                    sessionKey: sandboxSessionKey,
                    sessionId: params.sessionId,
                    runId: params.runId,
                    catalogRef: toolSearchCatalogRef,
                    abortSignal: runAbortController.signal,
                  },
                  toolCall.name,
                );
                // Catalog entries already own before_tool_call wrapping.
                const definition = tool
                  ? toToolDefinitions([tool], catalogToolHookContext)[0]
                  : undefined;
                const hydratedTool = definition ? wrapToolDefinition(definition) : undefined;
                if (hydratedTool) {
                  log.info(`tool-search: hydrated deferred directory tool ${toolCall.name}`);
                }
                return hydratedTool;
              }
            : undefined,
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
      let didDeliverSourceReplyViaMessageTool = false;
      installMessageToolOnlyTerminalHook({
        agent: activeSession.agent,
        sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
        onDeliveredSourceReply: () => {
          didDeliverSourceReplyViaMessageTool = true;
        },
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
      // Single source for the per-message timestamp prefix (issue #3658):
      // normal embedded runs stamp every user message from its own timestamp.
      // Raw model probes must keep the requested prompt text exact.
      const boundaryTimezone = isRawModelRun
        ? undefined
        : resolveUserTimezone(params.config?.agents?.defaults?.userTimezone);
      const includeBoundaryTimestamp =
        !isRawModelRun && params.config?.agents?.defaults?.envelopeTimestamp !== "off";
      let currentUserTimestampOverride:
        | { timestamp: number; text: string; alternateText?: string }
        | undefined;
      const buildBoundaryOptions = () => {
        if (isRawModelRun) {
          return undefined;
        }
        return {
          ...(boundaryTimezone ? { timezone: boundaryTimezone } : {}),
          ...(includeBoundaryTimestamp ? {} : { includeTimestamp: false }),
          ...(currentUserTimestampOverride ? { currentUserTimestampOverride } : {}),
        };
      };
      if (typeof activeSession.agent.convertToLlm === "function") {
        const baseConvertToLlm = activeSession.agent.convertToLlm.bind(activeSession.agent);
        activeSession.agent.convertToLlm = async (messages) =>
          await baseConvertToLlm(
            // Wire-only: move the current-turn runtime-context carrier to the
            // absolute tail so the request is an append-only prefix-extension
            // through the active user turn (see the function's cache rationale).
            // Applied here, not inside normalizeMessagesForLlmBoundary, because
            // normalizeMessagesForCurrentPromptBoundary slices off its appended
            // prompt by position and must not see the carrier relocated past it.
            relocateCurrentRuntimeContextCarrierToTail(
              normalizeMessagesForLlmBoundary(messages, buildBoundaryOptions()),
            ),
          );
      }
      let prePromptMessageCount = activeSession.messages.length;
      const toolResultPromptProjectionState: ToolResultPromptProjectionState =
        createToolResultPromptProjectionState();
      let contextEngineAfterTurnCheckpoint: number | null = null;
      let unwindowedContextEngineMessagesForPrecheck: AgentMessage[] | undefined;
      let contextEnginePromptAuthority: NonNullable<AssembleResult["promptAuthority"]> =
        "assembled";
      let contextEngineAssemblySucceeded = false;
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
        const selectedContextEngineId = activeContextEngine.info.id;
        const contextEngineLoopRuntimeSettings = buildContextEngineRuntimeSettings({
          contextEngineHost: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
          provider: params.provider,
          requestedModel: params.requestedModelId,
          resolvedModel: params.modelId,
          selectedContextEngineId,
          contextEngineSelectionSource:
            selectedContextEngineId === "legacy" ? "default" : "configured",
          promptTokenBudget: params.contextTokenBudget,
          fallbackReason: params.fallbackReason,
          degradedReason: params.degradedReason,
        });
        const removeContextEngineLoopHook = installContextEngineLoopHook({
          agent: activeSession.agent,
          contextEngine: activeContextEngine,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          sessionFile: params.sessionFile,
          tokenBudget: params.contextTokenBudget,
          modelId: params.modelId,
          ...(transcriptPolicy.repairToolUseResultPairing
            ? {
                repairAssembledMessages: (messages) =>
                  repairAttemptToolUseResultPairing(messages, isOpenAIResponsesApi),
              }
            : {}),
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
          runtimeSettings: contextEngineLoopRuntimeSettings,
          isHeartbeat: isHeartbeatLifecycleRunKind(params.bootstrapContextRunKind),
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
      const trajectoryFastMode = typeof params.fastMode === "boolean" ? params.fastMode : undefined;
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
          fastMode: trajectoryFastMode,
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
      if (providerTextTransforms?.input?.length) {
        activeSession.agent.streamFn = wrapStreamFnTextTransforms({
          streamFn: activeSession.agent.streamFn,
          input: providerTextTransforms.input,
          transformSystemPrompt: false,
        });
      }
      const nativeWebSearchPolicyContext = {
        sessionKey: sandboxSessionKey,
        sandboxToolPolicy: sandbox?.tools,
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
      };

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
        {
          preparedExtraParams: effectiveExtraParams,
          nativeWebSearchPolicyContext,
        },
      );
      if (codeModeControlsEnabledForRun) {
        activeSession.agent.streamFn = createCodexNativeWebSearchWrapper(
          activeSession.agent.streamFn,
          {
            config: params.config,
            agentDir,
            agentId: sessionAgentId,
            ...nativeWebSearchPolicyContext,
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
            onRecoveredAnthropicThinking: () => {
              if (!sessionManager) {
                log.warn(
                  `[session-recovery] unable to repair rejected thinking replay: session manager unavailable sessionId=${activeSession.sessionId}`,
                );
                return;
              }
              const repair = repairRejectedThinkingReplayInSessionManager({
                sessionManager,
                sessionFile: params.sessionFile,
                sessionId: params.sessionId,
                sessionKey: params.sessionKey,
                agentId: sessionAgentId,
              });
              if (repair.repaired) {
                repairedRejectedThinkingReplay = true;
                sessionLockController.refreshAfterOwnedSessionWrite();
                return;
              }
              log.warn(
                `[session-recovery] rejected thinking replay retry succeeded but transcript repair made no changes: ` +
                  `sessionId=${activeSession.sessionId} reason=${repair.reason ?? "unknown"}`,
              );
            },
          },
        );
      }

      // Mistral (and other strict providers) reject tool call IDs that don't match their
      // format requirements (e.g. [a-zA-Z0-9]{9}). sanitizeSessionHistory only processes
      // historical messages at attempt start, but the agent loop's internal tool call →
      // tool result cycles bypass that path. Wrap streamFn so every outbound request
      // sees sanitized tool call IDs.
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
              duplicateToolCallIdStyle: transcriptPolicy.duplicateToolCallIdStyle,
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
        replayAllowedToolNames,
        transcriptPolicy,
        params.provider,
      );
      activeSession.agent.streamFn = wrapStreamFnPromoteStandaloneTextToolCalls(
        activeSession.agent.streamFn,
        liveAllowedToolNames,
      );
      activeSession.agent.streamFn = wrapStreamFnTrimToolCallNames(
        activeSession.agent.streamFn,
        liveAllowedToolNames,
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

      // Tool-call repair can replace structured arguments from fragmented deltas.
      // Restore provider-masked text afterward so executable args stay canonical.
      if (providerTextTransforms?.output?.length) {
        activeSession.agent.streamFn = wrapStreamFnTextTransforms({
          streamFn: activeSession.agent.streamFn,
          output: providerTextTransforms.output,
        });
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
        model: {
          baseUrl: params.model.baseUrl,
          id: params.modelId,
          provider: params.provider,
        },
      });
      if (idleTimeoutMs > 0) {
        activeSession.agent.streamFn = streamWithIdleTimeout(
          activeSession.agent.streamFn,
          idleTimeoutMs,
          (error) => idleTimeoutTrigger?.(error),
        );
      }
      const firstEventTimeoutMs = resolveLlmFirstEventTimeoutMs({
        cfg: params.config,
        runTimeoutMs: resolvedRunTimeoutMs,
        modelRequestTimeoutMs: (params.model as { requestTimeoutMs?: number }).requestTimeoutMs,
        model: {
          baseUrl: params.model.baseUrl,
          id: params.modelId,
          provider: params.provider,
        },
      });
      if (firstEventTimeoutMs > 0) {
        const baseStreamFn = activeSession.agent.streamFn;
        activeSession.agent.streamFn = (model, context, options) => {
          type FirstEventStreamOptions = {
            firstEventTimeoutMs?: number;
            onFirstEventTimeout?: (error: Error) => void;
          };
          const optionsWithFirstEvent = options as FirstEventStreamOptions | undefined;
          return baseStreamFn(model, context, {
            ...options,
            firstEventTimeoutMs: optionsWithFirstEvent?.firstEventTimeoutMs ?? firstEventTimeoutMs,
            onFirstEventTimeout: optionsWithFirstEvent?.onFirstEventTimeout ?? idleTimeoutTrigger,
          } as typeof options);
        };
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
            const sessionEntry = await loadAttemptSessionEntryAfterQuotaMaintenance({
              storePath,
              sessionKey: params.sessionKey,
            });
            const suspension = sessionEntry?.quotaSuspension;
            if (sessionEntry && suspension?.state === "resuming") {
              const subagents = listSessionEntries({ storePath, clone: false })
                .map(({ entry }) => entry)
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
              await updateSessionEntry(
                {
                  storePath,
                  sessionKey: params.sessionKey,
                },
                async (entry) => {
                  if (entry.quotaSuspension?.state !== "resuming") {
                    return null;
                  }
                  return {
                    quotaSuspension: { ...entry.quotaSuspension, state: "active" },
                  };
                },
                {
                  skipMaintenance: true,
                  takeCacheOwnership: true,
                },
              );
            }
          }

          if (params.sessionKey && params.config && !isRawModelRun) {
            // Capability guidance must include deferred OpenClaw tools without
            // interpreting arbitrary client tool names as native capabilities.
            const activeSubagentPromptAddition = buildActiveSubagentSystemPromptAddition({
              cfg: params.config,
              controllerSessionKey: params.sessionKey,
              hasSessionsYield: capabilityToolNames.has("sessions_yield"),
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
            ? repairAttemptToolUseResultPairing(truncated, isOpenAIResponsesApi)
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
            const contextEngineAssembleReserveTokens = Math.max(
              0,
              Math.floor(settingsManager.getCompactionReserveTokens()),
            );
            const contextEngineAssembleContextTokenBudget = Math.max(
              1,
              Math.floor(
                params.contextTokenBudget ??
                  params.model.contextWindow ??
                  params.model.maxTokens ??
                  DEFAULT_CONTEXT_TOKENS,
              ),
            );
            const contextEngineAssemblePromptBudget = Math.max(
              1,
              contextEngineAssembleContextTokenBudget - contextEngineAssembleReserveTokens,
            );
            const contextEngineAssembleRenderedPromptTokens =
              estimateRenderedLlmBoundaryTokenPressure({
                systemPrompt: systemPromptText,
                prompt: params.prompt ?? "",
              });
            const contextEngineAssembleMessageBudget = Math.max(
              1,
              contextEngineAssemblePromptBudget - contextEngineAssembleRenderedPromptTokens,
            );
            const assembled = await assembleAttemptContextEngine({
              contextEngine: activeContextEngine,
              sessionId: params.sessionId,
              sessionKey: params.sessionKey,
              messages: activeSession.messages,
              tokenBudget: contextEngineAssembleMessageBudget,
              availableTools: new Set(capabilityToolNames),
              citationsMode: params.config?.memory?.citations,
              modelId: params.modelId,
              maxOutputTokens: contextEngineAssembleReserveTokens,
              contextEngineHostSupport: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
              providerId: params.provider,
              requestedModelId: params.requestedModelId,
              fallbackReason: params.fallbackReason,
              degradedReason: params.degradedReason,
              ...(params.prompt !== undefined ? { prompt: params.prompt } : {}),
            });
            if (!assembled) {
              throw new Error("context engine assemble returned no result");
            }
            const assembledMessages = transcriptPolicy.repairToolUseResultPairing
              ? repairAttemptToolUseResultPairing(assembled.messages, isOpenAIResponsesApi)
              : assembled.messages;
            if (assembledMessages !== activeSession.messages) {
              activeSession.agent.state.messages = assembledMessages;
            }
            contextEnginePromptAuthority = assembled.promptAuthority ?? "assembled";
            contextEngineAssemblySucceeded = true;
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
          const timeoutReason = reason instanceof Error ? reason : makeTimeoutAbortReason();
          params.onAttemptTimeout?.(timeoutReason);
          runAbortController.abort(timeoutReason);
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
      const promptActiveSession = (
        prompt: string,
        options?: Parameters<typeof activeSession.prompt>[1],
      ): Promise<void> =>
        withOwnedSessionTranscriptWrites(ownedTranscriptWriteContext, async () =>
          abortable(trackPromptSettlePromise(activeSession.prompt(prompt, options))),
        );
      // Hook runner was already obtained earlier before tool creation.
      const hookAgentId = sessionAgentId;
      let beforeAgentFinalizeRevisionReason: string | undefined;
      const onBlockReply = params.onBlockReply
        ? bindOwnedSessionTranscriptWrites(ownedTranscriptWriteContext, params.onBlockReply)
        : undefined;
      const onBlockReplyFlush = params.onBlockReplyFlush
        ? bindOwnedSessionTranscriptWrites(ownedTranscriptWriteContext, params.onBlockReplyFlush)
        : undefined;
      const onBeforeTerminalDelivery = hookRunner?.hasHooks("before_agent_finalize")
        ? async (event: {
            messages: AgentMessage[];
            willRetry: boolean;
            lastAssistant?: AgentMessage;
            assistantTexts: readonly string[];
            hasAssistantVisibleText: boolean;
            isError: boolean;
            incompleteTerminalAssistant: boolean;
            hadDeterministicSideEffect: boolean;
          }): Promise<void | { suppressTerminalDelivery: true }> => {
            if (
              beforeAgentFinalizeRevisionReason ||
              event.willRetry ||
              event.isError ||
              event.incompleteTerminalAssistant ||
              !event.hasAssistantVisibleText
            ) {
              return;
            }
            const lastAssistant = event.lastAssistant as AssistantMessage | undefined;
            const lastAssistantMessage =
              normalizeOptionalString(resolveFinalAssistantVisibleText(lastAssistant)) ??
              normalizeOptionalString(resolveFinalAssistantRawText(lastAssistant)) ??
              normalizeOptionalString(event.assistantTexts.join("\n\n"));
            if (!lastAssistantMessage) {
              return;
            }
            const hasCompletedClientToolCall = clientToolCallSlots.some((slot) => slot.completed);
            const silentFinalReply =
              params.silentExpected && isSilentReplyText(lastAssistantMessage, SILENT_REPLY_TOKEN);
            if (
              aborted ||
              promptError ||
              timedOut ||
              hasCompletedClientToolCall ||
              yieldDetected ||
              silentFinalReply
            ) {
              return;
            }
            const hookMessages = projectToolSearchTargetTranscriptMessages(
              activeSession.messages.slice(),
              toolSearchTargetTranscriptProjections,
            );
            const reportedModelRef = resolveReportedModelRef({
              provider: params.provider,
              model: params.modelId,
              assistant: lastAssistant,
            });
            const maxRevisionAttempts = params.maxBeforeAgentFinalizeRevisions ?? 0;
            if (
              maxRevisionAttempts > 0 &&
              (params.beforeAgentFinalizeRevisionAttempts ?? 0) >= maxRevisionAttempts
            ) {
              log.warn(
                `before_agent_finalize revision limit reached; finalizing ` +
                  `runId=${params.runId} sessionId=${params.sessionId} ` +
                  `attempts=${params.beforeAgentFinalizeRevisionAttempts ?? 0}/${maxRevisionAttempts}`,
              );
              return;
            }
            const outcome = await runAgentHarnessBeforeAgentFinalizeHook({
              event: {
                runId: params.runId,
                sessionId: params.sessionId,
                ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
                provider: reportedModelRef.provider,
                model: reportedModelRef.model,
                ...((params.cwd ?? params.workspaceDir)
                  ? { cwd: params.cwd ?? params.workspaceDir }
                  : {}),
                ...(params.sessionFile ? { transcriptPath: params.sessionFile } : {}),
                stopHookActive: false,
                lastAssistantMessage,
                messages: hookMessages,
              },
              ctx: {
                runId: params.runId,
                trace: freezeDiagnosticTraceContext(diagnosticTrace),
                agentId: hookAgentId,
                sessionKey: params.sessionKey,
                sessionId: params.sessionId,
                workspaceDir: params.workspaceDir,
                modelProviderId: reportedModelRef.provider,
                modelId: reportedModelRef.model,
                trigger: params.trigger,
                ...buildAgentHookContextChannelFields(params),
                ...buildAgentHookContextIdentityFields({
                  trigger: params.trigger,
                  senderId: params.senderId,
                  chatId: params.chatId,
                  channelContext: params.channelContext,
                }),
              },
              hookRunner,
            });
            if (outcome.action !== "revise") {
              return;
            }
            if (event.hadDeterministicSideEffect) {
              log.warn(
                `before_agent_finalize requested revision after potential side effects; finalizing ` +
                  `runId=${params.runId} sessionId=${params.sessionId}`,
              );
              return;
            }
            beforeAgentFinalizeRevisionReason = outcome.reason;
            return { suppressTerminalDelivery: true };
          }
        : undefined;

      let toolMetasForTerminal: readonly AsyncStartedToolMeta[] = [];
      const subscription = subscribeEmbeddedAgentSession(
        buildEmbeddedSubscriptionParams({
          session: activeSession,
          runId: params.runId,
          lifecycleGeneration: params.lifecycleGeneration,
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
          hasDeliveredMessageToolOnlySourceReply: () => didDeliverSourceReplyViaMessageTool,
          onAgentToolResult: params.onAgentToolResult,
          onToolResult: params.onToolResult,
          onReasoningStream: params.onReasoningStream,
          streamReasoningInNonStreamModes: params.streamReasoningInNonStreamModes,
          onReasoningEnd: params.onReasoningEnd,
          onBlockReply,
          onBlockReplyFlush,
          onBeforeTerminalDelivery,
          blockReplyBreak: params.blockReplyBreak,
          blockReplyChunking: params.blockReplyChunking,
          onPartialReply: params.onPartialReply,
          onAssistantMessageStart: params.onAssistantMessageStart,
          onExecutionPhase: params.onExecutionPhase,
          onAgentEvent: params.onAgentEvent,
          terminalLifecyclePhase:
            (params.deferTerminalLifecycle ?? params.deferTerminalLifecycleEnd)
              ? "finishing"
              : "end",
          onToolStreamBoundary: params.onToolStreamBoundary,
          isTerminalAborted: () => aborted,
          resolveTerminalStopReason: () =>
            isAgentRunRestartAbortReason(runAbortController.signal.reason)
              ? AGENT_RUN_RESTART_ABORT_STOP_REASON
              : undefined,
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
          suppressLiveStreamOutput: params.suppressLiveStreamOutput,
          config: params.config,
          sessionKey: sandboxSessionKey,
          currentChannelId: params.currentChannelId,
          currentMessagingTarget: params.currentMessagingTarget,
          currentThreadId: params.currentThreadTs,
          currentMessageId: params.currentMessageId,
          replyToMode: params.replyToMode,
          hasRepliedRef: params.hasRepliedRef,
          sessionId: params.sessionId,
          agentId: sessionAgentId,
          builtinToolNames,
          replaySafeToolNames,
          internalEvents: params.internalEvents,
        }),
      );

      const {
        assistantTexts,
        getLastAssistantTextMessageIndex,
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
        hasToolMediaBlockReply,
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
        waitForPendingEvents,
      } = subscription;
      toolMetasForTerminal = toolMetas;
      isCompactionPendingForExternalSignal = subscription.isCompacting;
      isCompactionInFlightForExternalSignal = () => activeSession.isCompacting;
      toolSearchCatalogExecutor = async (toolParams) => {
        try {
          if (toolParams.source === "openclaw" && toolParams.sourceName === "core") {
            recordStructuredReplayTrustForToolCall(
              toolParams.toolCallId,
              toolParams.tool as never,
              params.runId,
            );
          }
          const result = await runToolLifecycle({
            toolName: toolParams.toolName,
            toolCallId: toolParams.toolCallId,
            args: toolParams.input,
            replaySafe: replaySafeTools.has(toolParams.tool as never),
            hideFromChannelProgress:
              "hideFromChannelProgress" in toolParams.tool &&
              toolParams.tool.hideFromChannelProgress === true,
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

      const abortActiveRunExternally = (reason?: "user_abort" | "restart" | "superseded") => {
        externalAbort = true;
        params.onAttemptAbort?.();
        abortRun(false, reason === "restart" ? createAgentRunRestartAbortError() : undefined);
      };
      let acceptingSteerMessages = true;
      const queueHandle: EmbeddedAgentQueueHandle & {
        kind: "embedded";
        cancel: (reason?: "user_abort" | "restart" | "superseded") => void;
      } = {
        kind: "embedded",
        runId: params.runId,
        queueMessage: async (text: string, options) => {
          if (options?.steeringMode) {
            activeSession.agent.steeringMode = options.steeringMode;
          }
          await steerActiveSessionWithOptionalDeliveryWait(activeSession, text, options);
        },
        isStreaming: () => activeSession.isStreaming,
        isStopped: () => !acceptingSteerMessages || aborted || runAbortController.signal.aborted,
        isCompacting: () => subscription.isCompacting(),
        supportsTranscriptCommitWait: true,
        sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
        cancel: abortActiveRunExternally,
        abort: (reason) => abortActiveRunExternally(reason),
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
            timedOutByRunBudget = true;
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
      params.onAttemptTimeoutArmed?.();

      let messagesSnapshot: AgentMessage[] = [];
      let sessionIdUsed = activeSession.sessionId;
      let sessionFileUsed: string | undefined = params.sessionFile;
      const onAbort = () => {
        externalAbort = true;
        const reason = params.abortSignal ? getAbortReason(params.abortSignal) : undefined;
        const timeout = reason ? isSignalTimeoutReason(reason) : false;
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
              ...buildPreflightRecoveryBudgetSnapshot(request),
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
            preflightRecovery = {
              route: "compact_only",
              source: "mid-turn",
              ...buildPreflightRecoveryBudgetSnapshot(request),
            };
            promptError = new Error(PREEMPTIVE_OVERFLOW_ERROR_TEXT);
            promptErrorSource = "precheck";
            logMidTurnPrecheck(
              "compact_only",
              `truncateFallbackReason=${truncationResult.reason ?? "unknown"}`,
            );
          }
        } else {
          preflightRecovery = {
            route: request.route,
            source: "mid-turn",
            ...buildPreflightRecoveryBudgetSnapshot(request),
          };
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
          ...buildAgentHookContextIdentityFields({
            trigger: params.trigger,
            senderId: params.senderId,
            chatId: params.chatId,
            channelContext: params.channelContext,
          }),
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
              bootstrapContextRunKind: params.bootstrapContextRunKind,
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
        // Commitment fan-out must leave parent-turn steering queued for the
        // next normal turn instead of consuming it as commitment context.
        if (
          params.sessionKey &&
          !isRawModelRun &&
          params.bootstrapContextRunKind !== "commitment-only"
        ) {
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
        const promptForRuntimeContextBeforeAnnotation = promptForRuntimeContextSplit;
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
          const promptToolResultAggregateMaxChars = resolveLiveToolResultAggregateMaxChars({
            contextWindowTokens: contextTokenBudget,
            perResultMaxChars: promptToolResultMaxChars,
          });
          let promptHistoryMessages = activeSession.messages;
          const promptToolResultTruncation = truncateOversizedToolResultsInMessages(
            activeSession.messages,
            contextTokenBudget,
            promptToolResultMaxChars,
            promptToolResultAggregateMaxChars,
            toolResultPromptProjectionState,
          );
          const promptHistoryChanged =
            promptToolResultTruncation.messages !== activeSession.messages;
          const { aggregatePressureEngaged } = promptToolResultTruncation;
          if (promptHistoryChanged) {
            promptHistoryMessages = promptToolResultTruncation.messages;
          }
          if (promptHistoryChanged || aggregatePressureEngaged) {
            const sessionLogKey = params.sessionKey ?? params.sessionId ?? "unknown";
            const truncationLog =
              `[tool-result-truncation] Truncated ${promptToolResultTruncation.truncatedCount} ` +
              `tool result(s) for prompt history ` +
              `(maxChars=${promptToolResultMaxChars} ` +
              `aggregateBudgetChars=${promptToolResultAggregateMaxChars} ` +
              `aggregate=${promptToolResultTruncation.aggregateTruncatedCount}) ` +
              `sessionKey=${sessionLogKey}`;
            if (aggregatePressureEngaged) {
              if (!aggregateToolResultPressureWarnings.has(sessionLogKey)) {
                aggregateToolResultPressureWarnings.add(sessionLogKey);
                log.warn(
                  `${truncationLog}; aggregate tool-result pressure detected, compaction has been requested; consider /compact or /new if pressure persists`,
                );
              }
              // Compaction and aggregate truncation both target about half the window;
              // compact-then-truncate prevents re-hitting the same cap on the next turn.
              preflightRecovery = { route: "compact_then_truncate" };
              promptError = new Error(PREEMPTIVE_OVERFLOW_ERROR_TEXT);
              promptErrorSource = "precheck";
              skipPromptSubmission = true;
            } else {
              log.info(truncationLog);
            }
          }

          const promptSubmission = resolveRuntimeContextPromptParts({
            effectivePrompt: promptForRuntimeContextSplit,
            transcriptPrompt: transcriptPromptForRuntimeSplit,
            modelPrompt: hasPromptBuildContext
              ? promptForModelBeforeRuntimeContextSplit
              : undefined,
            modelPromptBuildContext:
              hasPromptBuildContext && effectiveTranscriptPrompt !== undefined
                ? {
                    promptBeforeHooks: promptBeforePromptBuildHooks,
                    transcriptPromptBeforeTransforms: effectiveTranscriptPrompt,
                    promptBeforeAnnotation: promptForRuntimeContextBeforeAnnotation,
                    prependContext: promptBuildPrependContext ?? "",
                    appendContext: promptBuildAppendContext ?? "",
                  }
                : undefined,
            emptyTranscriptMode: params.suppressNextUserMessagePersistence
              ? "model-prompt"
              : "runtime-event",
          });
          const isRuntimeOnlyTurn = promptSubmission.runtimeOnly === true;
          const currentInboundContextText = isRuntimeOnlyTurn
            ? undefined
            : params.currentInboundContext?.text?.trim() || undefined;
          // Normal user turns keep the user prompt BARE and route current-turn
          // inbound metadata into the runtime-context carrier (relocated after the
          // active user turn on the wire), so the persisted/replayed user message
          // is byte-identical whether active or historical — the cache-stability
          // fix. Runtime-only turns (room events, etc.) have no bare user turn to
          // protect, so their inbound context stays inline exactly as before. That
          // inline path stays byte-stable because a runtime-only turn only ever
          // carries room-event/system context, which is NOT strip-eligible: the
          // historical strip only removes the `buildInboundUserContextPrefix`
          // blocks (Conversation info / Reply target / Sender / …), and those are
          // produced only for non-room turns — which always have a non-empty body
          // and so are never runtime-only. So inline-active and inline-historical
          // serialize identically (verified in the cache-stability tests).
          const promptForSession = isRuntimeOnlyTurn
            ? buildCurrentInboundPrompt({
                context: params.currentInboundContext,
                prompt: promptSubmission.prompt,
              })
            : promptSubmission.prompt;
          const promptForModel = isRuntimeOnlyTurn
            ? buildCurrentInboundPrompt({
                context: params.currentInboundContext,
                prompt: promptSubmission.modelPrompt ?? promptSubmission.prompt,
              })
            : (promptSubmission.modelPrompt ?? promptSubmission.prompt);
          currentUserTimestampOverride =
            !isRawModelRun && typeof preparedUserTurnMessage?.timestamp === "number"
              ? {
                  timestamp: preparedUserTurnMessage.timestamp,
                  text: promptForSession,
                  ...(promptForModel !== promptForSession ? { alternateText: promptForModel } : {}),
                }
              : undefined;
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
          const runtimeContextForHook = isRuntimeOnlyTurn
            ? undefined
            : [currentInboundContextText, promptSubmission.runtimeContext?.trim()]
                .filter((value): value is string => Boolean(value))
                .join("\n\n") || undefined;
          const runtimeContextMessageForCurrentTurn =
            buildRuntimeContextCustomMessage(runtimeContextForHook);
          const messagesForCurrentPrompt = runtimeContextMessageForCurrentTurn
            ? [...promptHistoryMessages, runtimeContextMessageForCurrentTurn]
            : promptHistoryMessages;
          const hookMessagesForCurrentPrompt = normalizeMessagesForCurrentPromptBoundary({
            messages: messagesForCurrentPrompt,
            prompt: promptForModel,
            ...(boundaryTimezone ? { timezone: boundaryTimezone } : {}),
            ...(includeBoundaryTimestamp ? {} : { includeTimestamp: false }),
            ...(typeof preparedUserTurnMessage?.timestamp === "number"
              ? { currentUserTimestamp: preparedUserTurnMessage.timestamp }
              : {}),
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
              await withOwnedSessionWriteLock(() => {
                activeSessionManager.appendMessage(
                  redactedUserMessage as Parameters<typeof activeSessionManager.appendMessage>[0],
                );
                flushSessionManagerFile(activeSessionManager);
              });
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
                  await withOwnedSessionWriteLock(() => {
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
              canAdvanceSessionEntryCache: (snapshot: OwnedSessionTranscriptCacheSnapshot) =>
                sessionLockController.canAdvanceSessionEntryCache(snapshot),
              publishSessionFileSnapshot: (snapshot: OwnedSessionTranscriptCacheSnapshot) =>
                sessionLockController.publishOwnedSessionFileSnapshot(snapshot),
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

          const llmBoundaryPromptForPrecheck = normalizeCurrentPromptTextForLlmBoundary({
            prompt: promptForModel,
            ...(boundaryTimezone ? { timezone: boundaryTimezone } : {}),
            ...(includeBoundaryTimestamp ? {} : { includeTimestamp: false }),
            ...(typeof preparedUserTurnMessage?.timestamp === "number"
              ? { currentUserTimestamp: preparedUserTurnMessage.timestamp }
              : {}),
          });

          if (!skipPromptSubmission && !isRawModelRun && hookRunner?.hasHooks("llm_input")) {
            hookRunner
              .runLlmInput(
                {
                  runId: params.runId,
                  sessionId: params.sessionId,
                  provider: params.provider,
                  model: params.modelId,
                  systemPrompt: systemPromptForHook,
                  prompt: llmBoundaryPromptForPrecheck,
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
                  ...buildAgentHookContextIdentityFields({
                    trigger: params.trigger,
                    senderId: params.senderId,
                    chatId: params.chatId,
                    channelContext: params.channelContext,
                  }),
                },
              )
              .catch((err: unknown) => {
                log.warn(`llm_input hook failed: ${String(err)}`);
              });
          }

          const llmBoundaryOptionsForPrecheck =
            boundaryTimezone || !includeBoundaryTimestamp
              ? {
                  ...(boundaryTimezone ? { timezone: boundaryTimezone } : {}),
                  ...(includeBoundaryTimestamp ? {} : { includeTimestamp: false }),
                }
              : undefined;
          const unwindowedLlmBoundaryMessagesForPrecheck =
            contextEnginePromptAuthority === "preassembly_may_overflow" &&
            unwindowedContextEngineMessagesForPrecheck
              ? normalizeMessagesForLlmBoundary(
                  unwindowedContextEngineMessagesForPrecheck,
                  llmBoundaryOptionsForPrecheck,
                )
              : undefined;
          const llmBoundaryTokenPressure = estimateLlmBoundaryTokenPressure({
            messages: hookMessagesForCurrentPrompt,
            systemPrompt: systemPromptForHook,
            prompt: llmBoundaryPromptForPrecheck,
          });
          let preemptiveCompaction = null;
          const shouldSkipPrecheck =
            skipPromptSubmission ||
            (contextEngineAssemblySucceeded &&
              activeContextEngine?.info.ownsCompaction &&
              contextEnginePromptAuthority !== "preassembly_may_overflow");

          if (shouldSkipPrecheck && !skipPromptSubmission) {
            log.info(
              `[context-overflow-precheck] skipped: context engine "${activeContextEngine!.info.id}" owns compaction`,
            );
          }

          if (!shouldSkipPrecheck) {
            preemptiveCompaction = shouldPreemptivelyCompactBeforePrompt({
              messages: hookMessagesForCurrentPrompt,
              ...(unwindowedLlmBoundaryMessagesForPrecheck
                ? { unwindowedMessages: unwindowedLlmBoundaryMessagesForPrecheck }
                : {}),
              systemPrompt: systemPromptForHook,
              prompt: llmBoundaryPromptForPrecheck,
              contextTokenBudget,
              reserveTokens,
              toolResultMaxChars: promptToolResultMaxChars,
              llmBoundaryTokenPressure: {
                estimatedPromptTokens: llmBoundaryTokenPressure,
                source: "llm_boundary_normalized_prompt",
                renderedChars: llmBoundaryPromptForPrecheck.length,
              },
            });
          }
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
            const truncationResult = await withOwnedSessionWriteLock(() =>
              truncateOversizedToolResultsInSessionManager({
                sessionManager: activeSessionManager,
                contextWindowTokens: contextTokenBudget,
                maxCharsOverride: toolResultMaxChars,
                sessionFile: params.sessionFile,
                sessionId: params.sessionId,
                sessionKey: params.sessionKey,
                agentId: sessionAgentId,
              }),
            );
            if (truncationResult.truncated) {
              preflightRecovery = {
                route: "truncate_tool_results_only",
                ...buildPreflightRecoveryBudgetSnapshot(preemptiveCompaction),
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
              preflightRecovery = {
                route: "compact_only",
                ...buildPreflightRecoveryBudgetSnapshot(preemptiveCompaction),
              };
              promptError = new Error(PREEMPTIVE_OVERFLOW_ERROR_TEXT);
              promptErrorSource = "precheck";
              skipPromptSubmission = true;
            }
          }
          if (preemptiveCompaction?.shouldCompact) {
            preflightRecovery =
              preemptiveCompaction.route === "compact_then_truncate"
                ? {
                    route: "compact_then_truncate",
                    ...buildPreflightRecoveryBudgetSnapshot(preemptiveCompaction),
                  }
                : {
                    route: "compact_only",
                    ...buildPreflightRecoveryBudgetSnapshot(preemptiveCompaction),
                  };
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
                    promptToolResultAggregateMaxChars,
                    toolResultPromptProjectionState,
                  );
                  return providerPromptHistoryTruncation.messages !== messages
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
            await withOwnedSessionWriteLock(async () => {
              stripSessionsYieldArtifacts(activeSession);
              if (yieldMessage) {
                await persistSessionsYieldContextMessage(activeSession, yieldMessage);
              }
            });
          } else if (isMidTurnPrecheckSignal(err)) {
            await sessionLockController.waitForSessionEvents(activeSession);
            await withOwnedSessionWriteLock(() => {
              handleMidTurnPrecheckRequest(err.request);
            });
          } else {
            promptError = err;
            promptErrorSource = "prompt";
          }
        } finally {
          acceptingSteerMessages = false;
          log.debug(
            `embedded run prompt end: runId=${params.runId} sessionId=${params.sessionId} durationMs=${Date.now() - promptStartedAt}`,
          );
        }

        if (pendingMidTurnPrecheckRequest) {
          const request = pendingMidTurnPrecheckRequest;
          pendingMidTurnPrecheckRequest = null;
          await sessionLockController.waitForSessionEvents(activeSession);
          await withOwnedSessionWriteLock(() => {
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
        await waitForPendingEvents();
        if (repairedRejectedThinkingReplay) {
          activeSession.agent.state.messages = activeSessionManager.buildSessionContext().messages;
        }
        await sessionLockController.releaseForPrompt();

        if (
          shouldWaitForCompletionRequiredAsyncTasks({
            sessionKey: params.sessionKey,
            toolMetas,
            yieldDetected: yieldAborted,
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
          // Flush or discard buffered block replies before waiting for
          // compaction. Side-effecting consumers may deliver only a completed
          // assistant attempt; retries must not leak rejected output.
          if (onBlockReplyFlush) {
            const currentAssistant = findCurrentAttemptAssistantMessage({
              messagesSnapshot: snapshot,
              prePromptMessageCount,
            });
            const attemptAccepted =
              !promptError &&
              !aborted &&
              !timedOut &&
              !yieldAborted &&
              currentAssistant?.stopReason === "stop";
            await onBlockReplyFlush({ reason: "pre_compaction", attemptAccepted });
          }

          // Skip compaction wait when yield aborted the run — the signal is
          // already tripped and abortable() would immediately reject.
          const compactionRetryWait = yieldAborted
            ? { timedOut: false }
            : await waitForCompactionRetryWithAggregateTimeout({
                waitForCompactionRetry,
                abortable,
                aggregateTimeoutMs: COMPACTION_RETRY_AGGREGATE_TIMEOUT_MS,
                isCompactionRetryStillActive: () =>
                  hasActiveCompactionRetryWork({
                    isCompactionInFlight: isCompactionInFlight(),
                    isSessionStreaming: activeSession.isStreaming,
                  }),
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
        await withOwnedSessionWriteLock(async () => {
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

          if (timedOutDuringCompaction) {
            const removedEntries = normalizeCompactionRecoveryTranscriptTail({
              activeSession,
              sessionManager: activeSessionManager,
            });
            if (removedEntries > 0 && !isProbeSession) {
              log.warn(
                `normalized compaction timeout transcript tail: ` +
                  `removedEntries=${removedEntries} runId=${params.runId} sessionId=${params.sessionId}`,
              );
            }
          }

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

          if (activeContextEngine && !beforeAgentFinalizeRevisionReason) {
            // Context-engine afterTurn hooks may reconcile against the jsonl, so
            // materialize the active turn before finalization reads from disk.
            flushSessionManagerFile(activeSessionManager);
          }
        });

        // Let the active context engine run its post-turn lifecycle. These hooks
        // may call runtime LLM capabilities, so only their transcript rewrite
        // helper reacquires the session write lock.
        if (activeContextEngine && !beforeAgentFinalizeRevisionReason) {
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
            contextEngineHostSupport: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
            providerId: params.provider,
            requestedModelId: params.requestedModelId,
            modelId: params.modelId,
            fallbackReason: params.fallbackReason,
            degradedReason: params.degradedReason,
            runMaintenance: async (contextParams) =>
              await runContextEngineMaintenance({
                contextEngine: contextParams.contextEngine as never,
                sessionId: contextParams.sessionId,
                sessionKey: contextParams.sessionKey,
                sessionFile: contextParams.sessionFile,
                reason: contextParams.reason,
                sessionManager: contextParams.sessionManager as never,
                withSessionManagerRewriteLock: async (operation) =>
                  await withOwnedSessionWriteLock(operation),
                runtimeContext: contextParams.runtimeContext,
                runtimeSettings: contextParams.runtimeSettings,
                config: params.config,
                agentId: sessionAgentId,
              }),
            sessionManager: activeSessionManager,
            config: params.config,
            warn: (message) => log.warn(message),
            isHeartbeat: isHeartbeatLifecycleRunKind(params.bootstrapContextRunKind),
          });
        }

        if (!beforeAgentFinalizeRevisionReason) {
          await sessionLockController.waitForSessionEvents(activeSession);
          await withOwnedSessionWriteLock(async () => {
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
        }

        cacheTrace?.recordStage("session:after", {
          messages: messagesSnapshot,
          note: timedOutDuringCompaction
            ? "compaction timeout"
            : promptError
              ? "prompt error"
              : undefined,
        });
        anthropicPayloadLogger?.recordUsage(messagesSnapshot, promptError);

        if (!beforeAgentFinalizeRevisionReason) {
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
              ...buildAgentHookContextIdentityFields({
                trigger: params.trigger,
                senderId: params.senderId,
                chatId: params.chatId,
                channelContext: params.channelContext,
              }),
            },
            hookRunner,
          });
        }
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
            replaySafe?: boolean;
            asyncStarted?: boolean;
            asyncTaskRunId?: string;
            asyncTaskId?: string;
          } => typeof entry.toolName === "string" && entry.toolName.trim().length > 0,
        )
        .map((entry) => {
          const normalized: {
            toolName: string;
            meta?: string;
            replaySafe: boolean;
            asyncStarted?: true;
            asyncTaskRunId?: string;
            asyncTaskId?: string;
          } = {
            toolName: entry.toolName,
            meta: entry.meta,
            replaySafe: entry.replaySafe === true,
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
              ...buildAgentHookContextIdentityFields({
                trigger: params.trigger,
                senderId: params.senderId,
                chatId: params.chatId,
                channelContext: params.channelContext,
              }),
            },
          )
          .catch((err: unknown) => {
            log.warn(`llm_output hook failed: ${String(err)}`);
          });
      }

      const acceptedSessionSpawns = getAcceptedSessionSpawns();
      const observedReplayMetadata = buildAttemptReplayMetadata({
        // Structured start arguments already updated replayState for mutations and async work.
        // Reclassifying by tool name would incorrectly mark read-only cron actions as unsafe.
        toolMetas: [],
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
      const hasToolMediaBlockReplyNow = hasToolMediaBlockReply();
      const hasTerminalOutput = hasAttemptTerminalState({
        clientToolCalls: completedClientToolCallsForAttempt,
        yieldDetected,
        didSendDeterministicApprovalPrompt: didSendDeterministicApprovalPromptNow,
        heartbeatToolResponse,
        lastToolError,
        toolMediaUrls: pendingToolMediaReply?.mediaUrls,
        toolAudioAsVoice: pendingToolMediaReply?.audioAsVoice,
        toolTrustedLocalMedia: pendingToolMediaReply?.trustedLocalMedia,
        hasToolMediaBlockReply: hasToolMediaBlockReplyNow,
        didDeliverSourceReplyViaMessageTool,
        messagingToolSourceReplyPayloads,
        messagingToolSentTexts: getMessagingToolSentTexts(),
        messagingToolSentMediaUrls: getMessagingToolSentMediaUrls(),
        messagingToolSentTargets: getMessagingToolSentTargets(),
        acceptedSessionSpawns,
        successfulCronAdds: getSuccessfulCronAdds(),
        toolMetas: toolMetasNormalized,
      });
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
        hasTerminalOutput,
      });
      trajectoryRecorder?.recordEvent("model.completed", {
        aborted,
        externalAbort,
        timedOut,
        idleTimedOut,
        timedOutDuringCompaction,
        timedOutDuringToolExecution,
        timedOutByRunBudget,
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
          timedOutByRunBudget,
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
        timedOutByRunBudget,
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
        timedOutByRunBudget,
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
        ...(beforeAgentFinalizeRevisionReason ? { beforeAgentFinalizeRevisionReason } : {}),
        assistantTexts,
        lastAssistantTextMessageIndex: getLastAssistantTextMessageIndex(),
        toolMetas: toolMetasNormalized,
        acceptedSessionSpawns,
        lastAssistant,
        currentAttemptAssistant,
        lastToolError,
        didSendViaMessagingTool: didSendViaMessagingTool(),
        didDeliverSourceReplyViaMessageTool,
        didSendDeterministicApprovalPrompt: didSendDeterministicApprovalPromptNow,
        messagingToolSentTexts: getMessagingToolSentTexts(),
        messagingToolSentMediaUrls: getMessagingToolSentMediaUrls(),
        messagingToolSentTargets: getMessagingToolSentTargets(),
        messagingToolSourceReplyPayloads,
        heartbeatToolResponse,
        toolMediaUrls: pendingToolMediaReply?.mediaUrls,
        toolAudioAsVoice: pendingToolMediaReply?.audioAsVoice,
        toolTrustedLocalMedia: pendingToolMediaReply?.trustedLocalMedia,
        hasToolMediaBlockReply: hasToolMediaBlockReplyNow,
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
          timedOutByRunBudget,
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
          await Promise.reject(toErrorObject(cleanupFailure, "Non-Error rejection"));
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
