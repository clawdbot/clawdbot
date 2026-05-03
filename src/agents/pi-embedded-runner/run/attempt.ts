import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { isAcpRuntimeSpawnAvailable } from "../../../acp/runtime/availability.js";
import { filterHeartbeatPairs } from "../../../auto-reply/heartbeat-filter.js";
import { getRuntimeConfig } from "../../../config/config.js";
import type { AssembleResult } from "../../../context-engine/types.js";
import { emitTrustedDiagnosticEvent } from "../../../infra/diagnostic-events.js";
import {
  createChildDiagnosticTraceContext,
  createDiagnosticTraceContextFromActiveScope,
  freezeDiagnosticTraceContext,
} from "../../../infra/diagnostic-trace-context.js";
import { isEmbeddedMode } from "../../../infra/embedded-mode.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { resolveHeartbeatSummaryForAgent } from "../../../infra/heartbeat-summary.js";
import { getMachineDisplayName } from "../../../infra/machine-name.js";
import { MAX_IMAGE_BYTES } from "../../../media/constants.js";
import { listRegisteredPluginAgentPromptGuidance } from "../../../plugins/command-registry-state.js";
import { buildAgentHookContextChannelFields } from "../../../plugins/hook-agent-context.js";
import { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
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
import { isAcpSessionKey, isSubagentSessionKey } from "../../../routing/session-key.js";
import { annotateInterSessionPromptText } from "../../../sessions/input-provenance.js";
import { normalizeOptionalString } from "../../../shared/string-coerce.js";
import {
  buildTrajectoryArtifacts,
  buildTrajectoryRunMetadata,
} from "../../../trajectory/metadata.js";
import {
  createTrajectoryRuntimeRecorder,
  toTrajectoryToolDefinitions,
} from "../../../trajectory/runtime.js";
import { buildTtsSystemPromptHint } from "../../../tts/tts.js";
import { resolveUserPath } from "../../../utils.js";
import { normalizeMessageChannel } from "../../../utils/message-channel.js";
import { isReasoningTagProvider } from "../../../utils/provider-utils.js";
import { resolveOpenClawAgentDir } from "../../agent-paths.js";
import { resolveSessionAgentIds } from "../../agent-scope.js";
import { createAnthropicPayloadLogger } from "../../anthropic-payload-log.js";
import {
  analyzeBootstrapBudget,
  buildBootstrapPromptWarning,
  buildBootstrapTruncationReportMeta,
  buildBootstrapInjectionStats,
  prependBootstrapPromptWarning,
} from "../../bootstrap-budget.js";
import {
  FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE,
  hasCompletedBootstrapTurn,
  isWorkspaceBootstrapPending,
  makeBootstrapWarn,
  resolveBootstrapContextForRun,
  resolveContextInjectionMode,
} from "../../bootstrap-files.js";
import { createCacheTrace } from "../../cache-trace.js";
import {
  listChannelSupportedActions,
  resolveChannelMessageToolHints,
  resolveChannelReactionGuidance,
} from "../../channel-tools.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../defaults.js";
import { resolveOpenClawReferencePaths } from "../../docs-path.js";
import { isTimeoutError } from "../../failover-error.js";
import { resolveHeartbeatPromptForSystemPrompt } from "../../heartbeat-system-prompt.js";
import { resolveImageSanitizationLimits } from "../../image-sanitization.js";
import { stripRuntimeContextCustomMessages } from "../../internal-runtime-context.js";
import { buildModelAliasLines } from "../../model-alias-lines.js";
import { resolveModelAuthMode } from "../../model-auth.js";
import { resolveDefaultModelForAgent } from "../../model-selection.js";
import { supportsModelTools } from "../../model-tool-support.js";
import { releaseWsSession } from "../../openai-ws-stream.js";
import { resolveOwnerDisplaySetting } from "../../owner-display.js";
import { createBundleLspToolRuntime } from "../../pi-bundle-lsp-runtime.js";
import { TOOL_NAME_SEPARATOR } from "../../pi-bundle-mcp-names.js";
import {
  getOrCreateSessionMcpRuntime,
  materializeBundleMcpToolsForRun,
} from "../../pi-bundle-mcp-tools.js";
import type { EmbeddedContextFile } from "../../pi-embedded-helpers.js";
import {
  downgradeOpenAIFunctionCallReasoningPairs,
  downgradeOpenAIReasoningBlocks,
  isCloudCodeAssistFormatError,
  resolveBootstrapMaxChars,
  resolveBootstrapPromptTruncationWarningMode,
  resolveBootstrapTotalMaxChars,
} from "../../pi-embedded-helpers.js";
import { countActiveToolExecutions } from "../../pi-embedded-subscribe.handlers.tools.js";
import { subscribeEmbeddedPiSession } from "../../pi-embedded-subscribe.js";
import { createPreparedEmbeddedPiSettingsManager } from "../../pi-project-settings.js";
import {
  applyPiAutoCompactionGuard,
  applyPiCompactionSettingsFromConfig,
  isSilentOverflowProneModel,
} from "../../pi-settings.js";
import {
  createClientToolNameConflictError,
  findClientToolNameConflicts,
  toClientToolDefinitions,
} from "../../pi-tool-definition-adapter.js";
import { createOpenClawCodingTools, resolveToolLoopDetectionConfig } from "../../pi-tools.js";
import {
  resolveEffectiveToolPolicy,
  resolveGroupToolPolicy,
  resolveSubagentToolPolicyForSession,
} from "../../pi-tools.policy.js";
import { wrapStreamFnTextTransforms } from "../../plugin-text-transforms.js";
import { describeProviderRequestRoutingSummary } from "../../provider-attribution.js";
import { registerProviderStreamForModel } from "../../provider-stream.js";
import { runAgentCleanupStep } from "../../run-cleanup-timeout.js";
import { collectRuntimeChannelCapabilities } from "../../runtime-capabilities.js";
import {
  logAgentRuntimeToolDiagnostics,
  normalizeAgentRuntimeTools,
} from "../../runtime-plan/tools.js";
import { resolveSandboxContext } from "../../sandbox.js";
import { resolveSandboxRuntimeStatus } from "../../sandbox/runtime-status.js";
import { repairSessionFileIfNeeded } from "../../session-file-repair.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import {
  sanitizeToolUseResultPairing,
  stripToolResultDetails,
} from "../../session-transcript-repair.js";
import {
  acquireSessionWriteLock,
  resolveSessionLockMaxHoldFromTimeout,
  resolveSessionWriteLockAcquireTimeoutMs,
} from "../../session-write-lock.js";
import { detectRuntimeShell } from "../../shell-utils.js";
import {
  applySkillEnvOverrides,
  applySkillEnvOverridesFromSnapshot,
  resolveSkillsPromptForRun,
} from "../../skills.js";
import {
  isSubagentEnvelopeSession,
  resolveSubagentCapabilityStore,
} from "../../subagent-capabilities.js";
import { resolveSystemPromptOverride } from "../../system-prompt-override.js";
import { buildSystemPromptParams } from "../../system-prompt-params.js";
import { buildSystemPromptReport } from "../../system-prompt-report.js";
import { resolveAgentTimeoutMs } from "../../timeout.js";
import {
  buildEmptyExplicitToolAllowlistError,
  collectExplicitToolAllowlistSources,
} from "../../tool-allowlist-guard.js";
import { UNKNOWN_TOOL_THRESHOLD } from "../../tool-loop-detection.js";
import { normalizeToolName } from "../../tool-policy.js";
import { shouldAllowProviderOwnedThinkingReplay } from "../../transcript-policy.js";
import { normalizeUsage, type NormalizedUsage } from "../../usage.js";
import { DEFAULT_BOOTSTRAP_FILENAME } from "../../workspace.js";
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
import { getDmHistoryLimitFromSessionKey, limitHistoryTurns } from "../history.js";
import { log } from "../logger.js";
import { buildEmbeddedMessageActionDiscoveryInput } from "../message-action-discovery-input.js";
import {
  collectPromptCacheToolNames,
  beginPromptCacheObservation,
  completePromptCacheObservation,
  type PromptCacheChange,
} from "../prompt-cache-observability.js";
import { resolveCacheRetention } from "../prompt-cache-retention.js";
import {
  normalizeAssistantReplayContent,
  sanitizeSessionHistory,
  validateReplayTurns,
} from "../replay-history.js";
import { observeReplayMetadata, replayMetadataFromState } from "../replay-state.js";
import {
  clearActiveEmbeddedRun,
  type EmbeddedPiQueueHandle,
  setActiveEmbeddedRun,
  updateActiveEmbeddedRunSnapshot,
} from "../runs.js";
import { buildEmbeddedSandboxInfo } from "../sandbox-info.js";
import { prewarmSessionFile, trackSessionManagerAccess } from "../session-manager-cache.js";
import { prepareSessionManagerForRun } from "../session-manager-init.js";
import { resolveEmbeddedRunSkillEntries } from "../skills-runtime.js";
import {
  describeEmbeddedAgentStreamStrategy,
  resetEmbeddedAgentBaseStreamFnCacheForTest,
  resolveEmbeddedAgentApiKey,
  resolveEmbeddedAgentBaseStreamFn,
  resolveEmbeddedAgentStreamFn,
} from "../stream-resolution.js";
import {
  applySystemPromptOverrideToSession,
  buildEmbeddedSystemPrompt,
  createSystemPromptOverride,
} from "../system-prompt.js";
import { dropReasoningFromHistory, dropThinkingBlocks } from "../thinking.js";
import {
  collectAllowedToolNames,
  collectRegisteredToolNames,
  PI_RESERVED_TOOL_NAMES,
  toSessionToolAllowlist,
} from "../tool-name-allowlist.js";
import {
  installContextEngineLoopHook,
  installToolResultContextGuard,
} from "../tool-result-context-guard.js";
import {
  resolveLiveToolResultMaxChars,
  truncateOversizedToolResultsInSessionManager,
} from "../tool-result-truncation.js";
import { splitSdkTools } from "../tool-split.js";
import { mapThinkingLevel } from "../utils.js";
import { flushPendingToolResultsAfterIdle } from "../wait-for-idle-before-flush.js";
import { abortable as abortableWithSignal } from "./abortable.js";
import { createEmbeddedAgentSessionWithResourceLoader } from "./attempt-session.js";
export { buildContextEnginePromptCacheInfo } from "./attempt.context-engine-helpers.js";
import {
  appendBootstrapFileToUserPromptPrefix,
  resolveAttemptWorkspaceBootstrapRouting,
  shouldStripBootstrapFromEmbeddedContext,
} from "./attempt-bootstrap-routing.js";
export { shouldStripBootstrapFromEmbeddedContext } from "./attempt-bootstrap-routing.js";
import {
  rotateTranscriptAfterCompaction,
  shouldRotateCompactionTranscript,
} from "../compaction-successor-transcript.js";
import { configureEmbeddedAttemptHttpRuntime } from "./attempt-http-runtime.js";
import {
  createEmbeddedRunStageTracker,
  formatEmbeddedRunStageSummary,
  shouldWarnEmbeddedRunStageSummary,
} from "./attempt-stage-timing.js";
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
  diagnosticErrorCategory,
  wrapStreamFnWithDiagnosticModelCallEvents,
} from "./attempt.model-diagnostic-events.js";
import {
  buildAfterTurnRuntimeContext,
  buildAfterTurnRuntimeContextFromUsage,
  prependSystemPromptAddition,
  resolveAttemptFsWorkspaceOnly,
  resolveAttemptPrependSystemContext,
  resolvePromptBuildHookResult,
  resolvePromptModeForSession,
  resolvePromptSubmissionSkipReason,
  shouldWarnOnOrphanedUserRepair,
  shouldInjectHeartbeatPrompt,
} from "./attempt.prompt-helpers.js";
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
  shouldUseOpenAIWebSocketTransportForAttempt,
} from "./attempt.thread-helpers.js";
import {
  shouldRepairMalformedToolCallArguments,
  wrapStreamFnDecodeXaiToolCallArguments,
  wrapStreamFnRepairMalformedToolCallArguments,
} from "./attempt.tool-call-argument-repair.js";
import {
  sanitizeReplayToolCallIdsForStream,
  wrapStreamFnSanitizeMalformedToolCalls,
  wrapStreamFnTrimToolCallNames,
} from "./attempt.tool-call-normalization.js";
import { buildEmbeddedAttemptToolRunContext } from "./attempt.tool-run-context.js";
import { resolveAttemptTranscriptPolicy } from "./attempt.transcript-policy.js";
import { waitForCompactionRetryWithAggregateTimeout } from "./compaction-retry-aggregate-timeout.js";
import {
  resolveRunTimeoutDuringCompaction,
  resolveRunTimeoutWithCompactionGraceMs,
  selectCompactionTimeoutSnapshot,
  shouldFlagCompactionTimeout,
} from "./compaction-timeout.js";
import {
  installHistoryImagePruneContextTransform,
  pruneProcessedHistoryImages,
} from "./history-image-prune.js";
import { detectAndLoadPromptImages } from "./images.js";
import { buildAttemptReplayMetadata } from "./incomplete-turn.js";
import { resolveLlmIdleTimeoutMs, streamWithIdleTimeout } from "./llm-idle-timeout.js";
import { resolveMessageMergeStrategy } from "./message-merge-strategy.js";
import {
  MID_TURN_PRECHECK_ERROR_MESSAGE,
  isMidTurnPrecheckSignal,
  type MidTurnPrecheckRequest,
} from "./midturn-precheck.js";
import {
  PREEMPTIVE_OVERFLOW_ERROR_TEXT,
  shouldPreemptivelyCompactBeforePrompt,
} from "./preemptive-compaction.js";
import {
  buildRuntimeContextSystemContext,
  queueRuntimeContextForNextTurn,
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
  resolveAttemptPrependSystemContext,
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
  wrapStreamFnSanitizeMalformedToolCalls,
  wrapStreamFnTrimToolCallNames,
} from "./attempt.tool-call-normalization.js";
export {
  resetEmbeddedAgentBaseStreamFnCacheForTest,
  resolveEmbeddedAgentBaseStreamFn,
  resolveEmbeddedAgentStreamFn,
};

const MAX_BTW_SNAPSHOT_MESSAGES = 100;

export function resolveUnknownToolGuardThreshold(loopDetection?: {
  enabled?: boolean;
  unknownToolThreshold?: number;
}): number {
  // The unknown-tool guard is a safety net against the model hallucinating a
  // tool name or calling a tool that has since been removed from the allowlist
  // (for example after a `skills.allowBundled` config change). After `threshold`
  // consecutive unknown-tool attempts the stream wrapper rewrites the assistant
  // message content to tell the model to stop, which breaks otherwise-infinite
  // Tool-not-found loops against the provider. Unlike the genericRepeat /
  // pingPong / pollNoProgress detectors this guard has no false-positive
  // surface because the tool is objectively not registered in this run, so it
  // stays on regardless of `tools.loopDetection.enabled`.
  const raw = loopDetection?.unknownToolThreshold;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  return UNKNOWN_TOOL_THRESHOLD;
}

export function isPrimaryBootstrapRun(sessionKey?: string): boolean {
  return !isSubagentSessionKey(sessionKey) && !isAcpSessionKey(sessionKey);
}

export function remapInjectedContextFilesToWorkspace(params: {
  files: EmbeddedContextFile[];
  sourceWorkspaceDir: string;
  targetWorkspaceDir: string;
}): EmbeddedContextFile[] {
  if (params.sourceWorkspaceDir === params.targetWorkspaceDir) {
    return params.files;
  }
  return params.files.map((file) => {
    const relative = path.relative(params.sourceWorkspaceDir, file.path);
    const canRemap = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    return canRemap
      ? {
          ...file,
          path:
            relative === ""
              ? params.targetWorkspaceDir
              : path.join(params.targetWorkspaceDir, relative),
        }
      : file;
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

export function applyEmbeddedAttemptToolsAllow<T extends { name: string }>(
  tools: T[],
  toolsAllow?: string[],
): T[] {
  if (!toolsAllow || toolsAllow.length === 0) {
    return tools;
  }
  const allowSet = new Set(toolsAllow.map((name) => normalizeToolName(name)));
  return tools.filter((tool) => allowSet.has(normalizeToolName(tool.name)));
}

const CORE_CODING_TOOL_ALLOWLIST_NAMES = new Set([
  "agents_list",
  "apply_patch",
  "bash",
  "canvas",
  "cron",
  "edit",
  "exec",
  "gateway",
  "heartbeat_response",
  "image",
  "image_generate",
  "message",
  "music_generate",
  "nodes",
  "pdf",
  "read",
  "session_status",
  "sessions_history",
  "sessions_list",
  "sessions_send",
  "sessions_spawn",
  "sessions_yield",
  "subagents",
  "tts",
  "update_plan",
  "video_generate",
  "web_fetch",
  "web_search",
  "write",
]);

function shouldBuildCoreCodingToolsForAllowlist(toolsAllow?: string[]): boolean {
  if (!toolsAllow || toolsAllow.length === 0) {
    return true;
  }
  return toolsAllow.some((toolName) => {
    const normalized = normalizeToolName(toolName);
    return (
      normalized === "*" ||
      normalized.startsWith("group:") ||
      normalized === "bundle-mcp" ||
      normalized.includes(TOOL_NAME_SEPARATOR) ||
      CORE_CODING_TOOL_ALLOWLIST_NAMES.has(normalized)
    );
  });
}

export function normalizeMessagesForLlmBoundary(messages: AgentMessage[]): AgentMessage[] {
  const normalized = stripToolResultDetails(normalizeAssistantReplayContent(messages));
  return stripRuntimeContextCustomMessages(normalized);
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
    _rewriteFile?: () => void;
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
  if (typeof mutableSessionManager._rewriteFile !== "function") {
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
  mutableSessionManager._rewriteFile();
}

export function shouldCreateBundleMcpRuntimeForAttempt(params: {
  toolsEnabled: boolean;
  disableTools?: boolean;
  toolsAllow?: string[];
}): boolean {
  if (!params.toolsEnabled || params.disableTools === true) {
    return false;
  }
  if (!params.toolsAllow || params.toolsAllow.length === 0) {
    return true;
  }
  return params.toolsAllow.some(
    (toolName) => toolName === "bundle-mcp" || toolName.includes(TOOL_NAME_SEPARATOR),
  );
}

export function resolveAttemptToolPolicyMessageProvider(params: {
  messageProvider?: string;
  messageChannel?: string;
}): string | undefined {
  return params.messageProvider ?? params.messageChannel;
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
    { label: "runtime toolsAllow", allow: params.toolsAllow },
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
  await fs.mkdir(effectiveWorkspace, { recursive: true });
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
    | ((outcome: "completed" | "aborted" | "error", err?: unknown) => void)
    | undefined;
  try {
    const { shouldLoadSkillEntries, skillEntries } = resolveEmbeddedRunSkillEntries({
      workspaceDir: effectiveWorkspace,
      config: params.config,
      agentId: sessionAgentId,
      skillsSnapshot: params.skillsSnapshot,
    });
    restoreSkillEnv = params.skillsSnapshot
      ? applySkillEnvOverridesFromSnapshot({
          snapshot: params.skillsSnapshot,
          config: params.config,
        })
      : applySkillEnvOverrides({
          skills: skillEntries ?? [],
          config: params.config,
        });

    const skillsPrompt = resolveSkillsPromptForRun({
      skillsSnapshot: params.skillsSnapshot,
      entries: shouldLoadSkillEntries ? skillEntries : undefined,
      config: params.config,
      workspaceDir: effectiveWorkspace,
      agentId: sessionAgentId,
    });
    prepStages.mark("skills");

    const sessionLabel = params.sessionKey ?? params.sessionId;
    const contextInjectionMode = resolveContextInjectionMode(params.config);
    const isRawModelRun = params.modelRun === true || params.promptMode === "none";
    if (isRawModelRun && log.isEnabled("debug")) {
      log.debug(
        `raw model run enabled: modelRun=${params.modelRun === true} promptMode=${params.promptMode ?? "unset"}`,
      );
    }
    const activeContextEngine = isRawModelRun ? undefined : params.contextEngine;
    const agentDir = params.agentDir ?? resolveOpenClawAgentDir();
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
    emitDiagnosticRunCompleted = (outcome, err) => {
      if (diagnosticRunCompleted) {
        return;
      }
      diagnosticRunCompleted = true;
      emitTrustedDiagnosticEvent({
        type: "run.completed",
        ...diagnosticRunBase,
        durationMs: Date.now() - diagnosticRunStartedAt,
        outcome,
        ...(err ? { errorCategory: diagnosticErrorCategory(err) } : {}),
      });
    };
    const corePluginToolStages = createEmbeddedRunStageTracker();
    const toolsRaw =
      params.disableTools || isRawModelRun
        ? []
        : (() => {
            const allTools = createOpenClawCodingTools({
              agentId: sessionAgentId,
              ...buildEmbeddedAttemptToolRunContext({ ...params, trace: runTrace }),
              exec: {
                ...params.execOverrides,
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
              ownerOnlyToolAllowlist: params.ownerOnlyToolAllowlist,
              allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
              sessionKey: sandboxSessionKey,
              sessionId: params.sessionId,
              runId: params.runId,
              agentDir,
              workspaceDir: effectiveWorkspace,
              // When sandboxing uses a copied workspace (`ro` or `none`), effectiveWorkspace points
              // at the sandbox copy. Spawned subagents should inherit the real workspace instead.
              spawnWorkspaceDir: resolveAttemptSpawnWorkspaceDir({
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
              includeCoreTools: shouldBuildCoreCodingToolsForAllowlist(params.toolsAllow),
              replyToMode: params.replyToMode,
              hasRepliedRef: params.hasRepliedRef,
              modelHasVision: params.model.input?.includes("image") ?? false,
              requireExplicitMessageTarget:
                params.requireExplicitMessageTarget ?? isSubagentSessionKey(params.sessionKey),
              disableMessageTool: params.disableMessageTool,
              forceMessageTool: params.forceMessageTool,
              authProfileStore: params.authProfileStore,
              recordToolPrepStage: (name) => corePluginToolStages.mark(name),
              onYield: (message) => {
                yieldDetected = true;
                yieldMessage = message;
                queueYieldInterruptForSession?.();
                runAbortController.abort("sessions_yield");
                abortSessionForYield?.();
              },
            });
            corePluginToolStages.mark("attempt:create-openclaw-coding-tools");
            const filteredTools = applyEmbeddedAttemptToolsAllow(allTools, params.toolsAllow);
            corePluginToolStages.mark("attempt:tools-allow");
            return filteredTools;
          })();
    prepStages.mark("core-plugin-tools");
    emitCorePluginToolStageSummary("core-plugin-tools", corePluginToolStages.snapshot());
    const toolsEnabled = supportsModelTools(params.model);
    const bootstrapHasFileAccess = toolsEnabled && toolsRaw.some((tool) => tool.name === "read");
    const bootstrapRouting = await resolveAttemptWorkspaceBootstrapRouting({
      isWorkspaceBootstrapPending,
      bootstrapContextRunKind: params.bootstrapContextRunKind,
      trigger: params.trigger,
      sessionKey: params.sessionKey,
      isPrimaryRun: isPrimaryBootstrapRun(params.sessionKey),
      isCanonicalWorkspace: params.isCanonicalWorkspace,
      effectiveWorkspace,
      resolvedWorkspace,
      hasBootstrapFileAccess: bootstrapHasFileAccess,
    });
    const bootstrapMode = bootstrapRouting.bootstrapMode;
    const shouldStripBootstrapFromContext = bootstrapRouting.shouldStripBootstrapFromContext;
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
      hasCompletedBootstrapTurn,
      resolveBootstrapContextForRun: async () =>
        await resolveBootstrapContextForRun({
          workspaceDir: resolvedWorkspace,
          config: params.config,
          sessionKey: params.sessionKey,
          sessionId: params.sessionId,
          warn: makeBootstrapWarn({
            sessionLabel,
            workspaceDir: resolvedWorkspace,
            warn: (message) => log.warn(message),
          }),
          contextMode: params.bootstrapContextMode,
          runKind: params.bootstrapContextRunKind,
        }),
    });
    prepStages.mark("bootstrap-context");
    const remappedContextFiles = remapInjectedContextFilesToWorkspace({
      files: resolvedContextFiles,
      sourceWorkspaceDir: resolvedWorkspace,
      targetWorkspaceDir: effectiveWorkspace,
    });
    const contextFiles = shouldStripBootstrapFromContext
      ? remappedContextFiles.filter((file) => !/(^|[\\/])BOOTSTRAP\.md$/iu.test(file.path.trim()))
      : remappedContextFiles;
    const bootstrapFilesForInjectionStats = shouldStripBootstrapFromContext
      ? hookAdjustedBootstrapFiles.filter((file) => file.name !== DEFAULT_BOOTSTRAP_FILENAME)
      : hookAdjustedBootstrapFiles;
    const bootstrapMaxChars = resolveBootstrapMaxChars(params.config);
    const bootstrapTotalMaxChars = resolveBootstrapTotalMaxChars(params.config);
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
    const bundleMcpRuntime = bundleMcpSessionRuntime
      ? await materializeBundleMcpToolsForRun({
          runtime: bundleMcpSessionRuntime,
          reservedToolNames: [
            ...tools.map((tool) => tool.name),
            ...(clientTools?.map((tool) => tool.function.name) ?? []),
          ],
        })
      : undefined;
    const bundleLspRuntime =
      toolsEnabled && !isRawModelRun
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
    const filteredBundledTools = applyFinalEffectiveToolPolicy({
      bundledTools: [...(bundleMcpRuntime?.tools ?? []), ...(bundleLspRuntime?.tools ?? [])],
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
      senderIsOwner: params.senderIsOwner,
      ownerOnlyToolAllowlist: params.ownerOnlyToolAllowlist,
      warn: (message) => log.warn(message),
    });
    const effectiveTools = [...tools, ...filteredBundledTools];
    prepStages.mark("bundle-tools");
    const allowedToolNames = collectAllowedToolNames({
      tools: effectiveTools,
      clientTools,
    });
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
    const emptyExplicitToolAllowlistError = buildEmptyExplicitToolAllowlistError({
      sources: explicitToolAllowlistSources,
      callableToolNames: effectiveTools.map((tool) => tool.name),
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
    const sandboxInfo = buildEmbeddedSandboxInfo(sandbox, params.bashElevated);
    const reasoningTagHint = isReasoningTagProvider(params.provider, {
      config: params.config,
      workspaceDir: effectiveWorkspace,
      env: process.env,
      modelId: params.modelId,
      modelApi: params.model.api,
      model: params.model,
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
    const { runtimeInfo, userTimezone, userTime, userTimeFormat } = buildSystemPromptParams({
      config: params.config,
      agentId: sessionAgentId,
      workspaceDir: effectiveWorkspace,
      cwd: effectiveWorkspace,
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
      },
    });
    const isDefaultAgent = sessionAgentId === defaultAgentId;
    const promptMode =
      params.promptMode ??
      (isRawModelRun ? "none" : resolvePromptModeForSession(params.sessionKey));

    // When toolsAllow is set, use minimal prompt and strip skills catalog
    const effectivePromptMode = params.toolsAllow?.length ? ("minimal" as const) : promptMode;
    const effectiveSkillsPrompt = params.toolsAllow?.length ? undefined : skillsPrompt;
    const openClawReferences = await resolveOpenClawReferencePaths({
      workspaceDir: effectiveWorkspace,
      argv1: process.argv[1],
      cwd: effectiveWorkspace,
      moduleUrl: import.meta.url,
    });
    const ttsHint = params.config
      ? buildTtsSystemPromptHint(params.config, sessionAgentId)
      : undefined;
    const ownerDisplay = resolveOwnerDisplaySetting(params.config);
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
    };
    const promptContribution =
      params.runtimePlan?.prompt.resolveSystemPromptContribution(promptContributionContext) ??
      resolveProviderSystemPromptContribution({
        provider: params.provider,
        config: params.config,
        workspaceDir: effectiveWorkspace,
        context: promptContributionContext,
      });

    const builtAppendPrompt =
      resolveSystemPromptOverride({
        config: params.config,
        agentId: sessionAgentId,
      }) ??
      buildEmbeddedSystemPrompt({
        workspaceDir: effectiveWorkspace,
        defaultThinkLevel: params.thinkLevel,
        reasoningLevel: params.reasoningLevel ?? "off",
        extraSystemPrompt: params.extraSystemPrompt,
        ownerNumbers: params.ownerNumbers,
        ownerDisplay: ownerDisplay.ownerDisplay,
        ownerDisplaySecret: ownerDisplay.ownerDisplaySecret,
        reasoningTagHint,
        heartbeatPrompt,
        skillsPrompt: effectiveSkillsPrompt,
        docsPath: openClawReferences.docsPath ?? undefined,
        sourcePath: openClawReferences.sourcePath ?? undefined,
        ttsHint,
        workspaceNotes: workspaceNotes?.length ? workspaceNotes : undefined,
        reactionGuidance,
        promptMode: effectivePromptMode,
        sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
        silentReplyPromptMode: params.silentReplyPromptMode,
        acpEnabled: isAcpRuntimeSpawnAvailable({
          config: params.config,
          sandboxed: sandboxInfo?.enabled === true,
        }),
        nativeCommandGuidanceLines: listRegisteredPluginAgentPromptGuidance(),
        runtimeInfo,
        messageToolHints,
        sandboxInfo,
        tools: effectiveTools,
        modelAliasLines: buildModelAliasLines(params.config),
        userTimezone,
        userTime,
        userTimeFormat,
        contextFiles,
        includeMemorySection: !activeContextEngine || activeContextEngine.info.id === "legacy",
        memoryCitationsMode: params.config?.memory?.citations,
        promptContribution,
      });
    const appendPrompt = isRawModelRun
      ? ""
      : transformProviderSystemPrompt({
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
            systemPrompt: builtAppendPrompt,
          },
        });
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
    const systemPromptOverride = createSystemPromptOverride(appendPrompt);
    let systemPromptText = systemPromptOverride();
    const userPromptPrefixText = appendBootstrapFileToUserPromptPrefix({
      prefixText: bootstrapRouting.userPromptPrefixText,
      bootstrapMode,
      contextFiles: remappedContextFiles,
    });
    prepStages.mark("system-prompt");

    // Keep the session lock scoped to transcript/session mutations. Cold plugin
    // and tool setup can be slow, and holding the lock there blocks CLI fallback
    // from taking over the same session when a gateway run stalls before model I/O.
    const sessionLock = await acquireSessionWriteLock({
      sessionFile: params.sessionFile,
      timeoutMs: resolveSessionWriteLockAcquireTimeoutMs(params.config),
      maxHoldMs: resolveSessionLockMaxHoldFromTimeout({
        timeoutMs: resolveRunTimeoutWithCompactionGraceMs({
          runTimeoutMs: params.timeoutMs,
          compactionTimeoutMs: resolveCompactionTimeoutMs(params.config),
        }),
      }),
    });

    let sessionManager: ReturnType<typeof guardSessionManager> | undefined;
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    let removeToolResultContextGuard: (() => void) | undefined;
    let trajectoryRecorder: ReturnType<typeof createTrajectoryRuntimeRecorder> | null = null;
    let trajectoryEndRecorded = false;
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
      sessionManager = guardSessionManager(SessionManager.open(params.sessionFile), {
        agentId: sessionAgentId,
        sessionKey: params.sessionKey,
        config: params.config,
        contextWindowTokens: params.contextTokenBudget,
        inputProvenance: params.inputProvenance,
        allowSyntheticToolResults: transcriptPolicy.allowSyntheticToolResults,
        missingToolResultText:
          params.model.api === "openai-responses" ||
          params.model.api === "azure-openai-responses" ||
          params.model.api === "openai-codex-responses"
            ? "aborted"
            : undefined,
        allowedToolNames,
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
          agentDir,
          tokenBudget: params.contextTokenBudget,
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
          }),
        warn: (message) => log.warn(message),
      });

      await prepareSessionManagerForRun({
        sessionManager,
        sessionFile: params.sessionFile,
        hadSessionFile,
        sessionId: params.sessionId,
        cwd: effectiveWorkspace,
      });

      const settingsManager = createPreparedEmbeddedPiSettingsManager({
        cwd: effectiveWorkspace,
        agentDir,
        cfg: params.config,
        contextTokenBudget: params.contextTokenBudget,
      });
      const piAutoCompactionGuardArgs = {
        settingsManager,
        contextEngineInfo: activeContextEngine?.info,
        silentOverflowProneProvider: isSilentOverflowProneModel({
          provider: params.provider,
          modelId: params.modelId,
          baseUrl: params.model.baseUrl ?? undefined,
        }),
      };
      applyPiAutoCompactionGuard(piAutoCompactionGuardArgs);

      // Sets compaction/pruning runtime state and returns extension factories
      // that must be passed to the resource loader for the safeguard to be active.
      const extensionFactories = buildEmbeddedExtensionFactories({
        cfg: params.config,
        sessionManager,
        provider: params.provider,
        modelId: params.modelId,
        model: params.model,
      });
      const resourceLoader = new DefaultResourceLoader({
        cwd: resolvedWorkspace,
        agentDir,
        settingsManager,
        extensionFactories,
      });
      await resourceLoader.reload();
      // DefaultResourceLoader.reload() rehydrates settings from disk and can drop OpenClaw
      // compaction overrides applied in createPreparedEmbeddedPiSettingsManager — same
      // rehydration also restores Pi's auto-compaction (openclaw#75799), so re-apply
      // both guards.
      applyPiCompactionSettingsFromConfig({
        settingsManager,
        cfg: params.config,
        contextTokenBudget: params.contextTokenBudget,
      });
      applyPiAutoCompactionGuard(piAutoCompactionGuardArgs);
      prepStages.mark("session-resource-loader");

      // Get hook runner early so it's available when creating tools
      const hookRunner = getGlobalHookRunner();

      const { customTools } = splitSdkTools({
        tools: effectiveTools,
        sandboxEnabled: !!sandbox?.enabled,
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
      // MEDIA: passthrough gate: a normalized alias is not sufficient — the
      // emitted tool name must match an exact registration of this run.
      const builtinToolNames = new Set(
        effectiveTools.flatMap((tool) => {
          const name = (tool.name ?? "").trim();
          return name ? [name] : [];
        }),
      );
      // Admission-time conflict check only against non-plugin core tools, to
      // preserve prior behavior where client tools may coexist with unrelated
      // plugin tool names. MEDIA passthrough is still gated by the raw-name
      // set above, so a client tool that normalize-collides with a plugin
      // tool cannot inherit the plugin's local-media trust.
      const coreBuiltinToolNames = new Set(
        effectiveTools.flatMap((tool) => {
          const name = (tool.name ?? "").trim();
          if (!name || getPluginToolMeta(tool)) {
            return [];
          }
          return [name];
        }),
      );
      const clientToolNameConflicts = findClientToolNameConflicts({
        tools: clientTools ?? [],
        existingToolNames: [...coreBuiltinToolNames, ...PI_RESERVED_TOOL_NAMES],
      });
      if (clientToolNameConflicts.length > 0) {
        throw createClientToolNameConflictError(clientToolNameConflicts);
      }
      const clientToolDefs = clientTools
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
              sessionId: params.sessionId,
              runId: params.runId,
              loopDetection: clientToolLoopDetection,
            },
          )
        : [];

      const allCustomTools = [...customTools, ...clientToolDefs];
      // Pi treats `tools` as a name allowlist during session creation. Pass the
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
          cwd: resolvedWorkspace,
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
        },
      });
      session = createdSession.session;
      applySystemPromptOverrideToSession(session, systemPromptText);
      if (!session) {
        throw new Error("Embedded agent session missing");
      }
      session.setActiveToolsByName(sessionToolAllowlist);
      const activeSession = session;
      prepStages.mark("agent-session");
      if (isRawModelRun) {
        // Raw model probes should measure exactly the requested prompt against
        // the selected provider/model. Reset clears restored transcript state
        // and queues; the empty system override prevents Pi from rebuilding the
        // normal OpenClaw agent/tool prompt when `session.prompt()` starts.
        activeSession.agent.reset();
        applySystemPromptOverrideToSession(activeSession, "");
        systemPromptText = "";
      }
      if (typeof activeSession.agent.convertToLlm === "function") {
        const baseConvertToLlm = activeSession.agent.convertToLlm.bind(activeSession.agent);
        activeSession.agent.convertToLlm = async (messages) =>
          await baseConvertToLlm(normalizeMessagesForLlmBoundary(messages));
      }
      let prePromptMessageCount = activeSession.messages.length;
      let unwindowedContextEngineMessagesForPrecheck: AgentMessage[] | undefined;
      let contextEnginePromptAuthority: NonNullable<AssembleResult["promptAuthority"]> =
        "assembled";
      abortSessionForYield = () => {
        yieldAbortSettled = Promise.resolve(activeSession.abort());
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
      if (!activeContextEngine || activeContextEngine.info.ownsCompaction !== true) {
        removeToolResultContextGuard = installToolResultContextGuard({
          agent: activeSession.agent,
          contextWindowTokens: contextTokenBudgetForGuard,
          ...(midTurnPrecheckEnabled
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
            : {}),
        });
      } else {
        removeToolResultContextGuard = installContextEngineLoopHook({
          agent: activeSession.agent,
          contextEngine: activeContextEngine,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          sessionFile: params.sessionFile,
          tokenBudget: params.contextTokenBudget,
          modelId: params.modelId,
          getPrePromptMessageCount: () => prePromptMessageCount,
          getRuntimeContext: ({ messages, prePromptMessageCount: loopPrePromptMessageCount }) =>
            buildAfterTurnRuntimeContext({
              attempt: params,
              workspaceDir: effectiveWorkspace,
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
          userPromptPrefixText,
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
      const shouldUseWebSocketTransport = shouldUseOpenAIWebSocketTransportForAttempt({
        provider: params.provider,
        modelApi: params.model.api,
        modelBaseUrl: params.model.baseUrl,
        streamParams: params.streamParams,
        effectiveExtraParams,
        modelParams: (params.model as { params?: Record<string, unknown> }).params,
      });
      const wsApiKey = shouldUseWebSocketTransport
        ? await resolveEmbeddedAgentApiKey({
            provider: params.provider,
            resolvedApiKey: params.resolvedApiKey,
            authStorage: params.authStorage,
          })
        : undefined;
      if (shouldUseWebSocketTransport && !wsApiKey) {
        log.warn(
          `[ws-stream] no API key for provider=${params.provider}; keeping session-managed HTTP transport`,
        );
      }
      const streamStrategy = describeEmbeddedAgentStreamStrategy({
        currentStreamFn: defaultSessionStreamFn,
        providerStreamFn,
        shouldUseWebSocketTransport,
        wsApiKey,
        model: params.model,
      });
      activeSession.agent.streamFn = resolveEmbeddedAgentStreamFn({
        currentStreamFn: defaultSessionStreamFn,
        providerStreamFn,
        shouldUseWebSocketTransport,
        wsApiKey,
        sessionId: params.sessionId,
        signal: runAbortController.signal,
        model: params.model,
        resolvedApiKey: params.resolvedApiKey,
        authStorage: params.authStorage,
      });
      const providerTextTransforms = resolveProviderTextTransforms({
        provider: params.provider,
        config: params.config,
        workspaceDir: effectiveWorkspace,
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

      // Anthropic Claude endpoints can reject replayed `thinking` blocks
      // (e.g. thinkingSignature:"reasoning_text") on any follow-up provider
      // call, including tool continuations. Wrap the stream function so every
      // outbound request sees sanitized messages.
      if (transcriptPolicy.dropThinkingBlocks || transcriptPolicy.dropReasoningFromHistory) {
        const inner = activeSession.agent.streamFn;
        activeSession.agent.streamFn = (model, context, options) => {
          const ctx = context as unknown as { messages?: unknown };
          const messages = ctx?.messages;
          if (!Array.isArray(messages)) {
            return inner(model, context, options);
          }
          const reasoningSanitized = transcriptPolicy.dropReasoningFromHistory
            ? dropReasoningFromHistory(messages as unknown as AgentMessage[])
            : (messages as unknown as AgentMessage[]);
          const sanitized = transcriptPolicy.dropThinkingBlocks
            ? (dropThinkingBlocks(reasoningSanitized) as unknown)
            : (reasoningSanitized as unknown);
          if (sanitized === messages) {
            return inner(model, context, options);
          }
          const nextContext = {
            ...(context as unknown as Record<string, unknown>),
            messages: sanitized,
          } as unknown;
          return inner(model, nextContext as typeof context, options);
        };
      }

      // Mistral (and other strict providers) reject tool call IDs that don't match their
      // format requirements (e.g. [a-zA-Z0-9]{9}). sanitizeSessionHistory only processes
      // historical messages at attempt start, but the agent loop's internal tool call →
      // tool result cycles bypass that path. Wrap streamFn so every outbound request
      // sees sanitized tool call IDs.
      const isOpenAIResponsesApi =
        params.model.api === "openai-responses" ||
        params.model.api === "azure-openai-responses" ||
        params.model.api === "openai-codex-responses";

      if (
        transcriptPolicy.sanitizeToolCallIds &&
        transcriptPolicy.toolCallIdMode &&
        !isOpenAIResponsesApi
      ) {
        const inner = activeSession.agent.streamFn;
        const mode = transcriptPolicy.toolCallIdMode;
        activeSession.agent.streamFn = (model, context, options) => {
          const ctx = context as unknown as { messages?: unknown };
          const messages = ctx?.messages;
          if (!Array.isArray(messages)) {
            return inner(model, context, options);
          }
          const nextMessages = sanitizeReplayToolCallIdsForStream({
            messages: messages as AgentMessage[],
            mode,
            allowedToolNames,
            preserveNativeAnthropicToolUseIds: transcriptPolicy.preserveNativeAnthropicToolUseIds,
            preserveReplaySafeThinkingToolCallIds: shouldAllowProviderOwnedThinkingReplay({
              modelApi: (model as { api?: unknown })?.api as string | null | undefined,
              policy: transcriptPolicy,
            }),
            repairToolUseResultPairing: transcriptPolicy.repairToolUseResultPairing,
          });
          if (nextMessages === messages) {
            return inner(model, context, options);
          }
          const nextContext = {
            ...(context as unknown as Record<string, unknown>),
            messages: nextMessages,
          } as unknown;
          return inner(model, nextContext as typeof context, options);
        };
      }

      if (isOpenAIResponsesApi) {
        const inner = activeSession.agent.streamFn;
        activeSession.agent.streamFn = (model, context, options) => {
          const ctx = context as unknown as { messages?: unknown };
          const messages = ctx?.messages;
          if (!Array.isArray(messages)) {
            return inner(model, context, options);
          }
          // Strip orphaned reasoning blocks first, then fix function-call
          // pairing — matches the call order in google.ts.
          const reasoningSanitized = downgradeOpenAIReasoningBlocks(messages as AgentMessage[]);
          const sanitized = downgradeOpenAIFunctionCallReasoningPairs(reasoningSanitized);
          if (sanitized === messages) {
            return inner(model, context, options);
          }
          const nextContext = {
            ...(context as unknown as Record<string, unknown>),
            messages: sanitized,
          } as unknown;
          return inner(model, nextContext as typeof context, options);
        };
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
      // pi-agent-core dispatches tool calls with exact string matching, so normalize
      // names on the live response stream before tool execution.
      activeSession.agent.streamFn = wrapStreamFnSanitizeMalformedToolCalls(
        activeSession.agent.streamFn,
        allowedToolNames,
        transcriptPolicy,
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
      // Anthropic-compatible providers can add new stop reasons before pi-ai maps them.
      // Recover the known "sensitive" stop reason here so a model refusal does not
      // bubble out as an uncaught runner error and stall channel polling.
      activeSession.agent.streamFn = wrapStreamFnHandleSensitiveStopReason(
        activeSession.agent.streamFn,
      );

      let idleTimeoutTrigger: ((error: Error) => void) | undefined;

      // Wrap stream with idle timeout detection
      const configuredRunTimeoutMs = resolveAgentTimeoutMs({
        cfg: params.config,
      });
      const idleTimeoutMs = resolveLlmIdleTimeoutMs({
        cfg: params.config,
        trigger: params.trigger,
        runTimeoutMs: params.timeoutMs !== configuredRunTimeoutMs ? params.timeoutMs : undefined,
        modelRequestTimeoutMs: (params.model as { requestTimeoutMs?: number }).requestTimeoutMs,
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
          trace: runTrace,
          nextCallId: () => `${params.runId}:model:${(diagnosticModelCallSeq += 1)}`,
        },
      );

      try {
        if (isRawModelRun) {
          activeSession.agent.reset();
          applySystemPromptOverrideToSession(activeSession, "");
          systemPromptText = "";
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
            allowedToolNames,
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
          const heartbeatSummary =
            params.config && sessionAgentId
              ? resolveHeartbeatSummaryForAgent(params.config, sessionAgentId)
              : undefined;
          const heartbeatFiltered = filterHeartbeatPairs(
            validated,
            heartbeatSummary?.ackMaxChars,
            heartbeatSummary?.prompt,
          );
          const truncated = limitHistoryTurns(
            heartbeatFiltered,
            getDmHistoryLimitFromSessionKey(params.sessionKey, params.config),
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
          if (limited.length > 0) {
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
              systemPromptText = prependSystemPromptAddition({
                systemPrompt: systemPromptText,
                systemPromptAddition: assembled.systemPromptAddition,
              });
              applySystemPromptOverrideToSession(activeSession, systemPromptText);
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
          clearPendingOnTimeout: true,
        });
        activeSession.dispose();
        throw err;
      }

      let yieldAborted = false;
      const getAbortReason = (signal: AbortSignal): unknown =>
        "reason" in signal ? (signal as { reason?: unknown }).reason : undefined;
      const makeTimeoutAbortReason = (): Error => {
        const err = new Error("request timed out");
        err.name = "TimeoutError";
        return err;
      };
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
        void activeSession.abort();
      };
      idleTimeoutTrigger = (error) => {
        idleTimedOut = true;
        abortRun(true, error);
      };
      const abortable = <T>(promise: Promise<T>): Promise<T> =>
        abortableWithSignal(runAbortController.signal, promise);

      const subscription = subscribeEmbeddedPiSession(
        buildEmbeddedSubscriptionParams({
          session: activeSession,
          runId: params.runId,
          initialReplayState: params.initialReplayState,
          hookRunner: getGlobalHookRunner() ?? undefined,
          verboseLevel: params.verboseLevel,
          reasoningMode: params.reasoningLevel ?? "off",
          thinkingLevel: params.thinkLevel,
          toolResultFormat: params.toolResultFormat,
          shouldEmitToolResult: params.shouldEmitToolResult,
          shouldEmitToolOutput: params.shouldEmitToolOutput,
          onToolResult: params.onToolResult,
          onReasoningStream: params.onReasoningStream,
          onReasoningEnd: params.onReasoningEnd,
          onBlockReply: params.onBlockReply,
          onBlockReplyFlush: params.onBlockReplyFlush,
          blockReplyBreak: params.blockReplyBreak,
          blockReplyChunking: params.blockReplyChunking,
          onPartialReply: params.onPartialReply,
          onAssistantMessageStart: params.onAssistantMessageStart,
          onAgentEvent: params.onAgentEvent,
          onBeforeLifecycleTerminal: () => {
            // Clear embedded-run activity before emitting terminal lifecycle events so
            // post-completion cleanup does not observe a logically finished run as active.
            clearActiveEmbeddedRun(params.sessionId, queueHandle, params.sessionKey);
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
        unsubscribe,
        waitForCompactionRetry,
        isCompactionInFlight,
        getItemLifecycle,
        getMessagingToolSentTexts,
        getMessagingToolSentMediaUrls,
        getMessagingToolSentTargets,
        getHeartbeatToolResponse,
        getPendingToolMediaReply,
        getSuccessfulCronAdds,
        getReplayState,
        didSendViaMessagingTool,
        getLastToolError,
        setTerminalLifecycleMeta,
        getUsageTotals,
        getCompactionCount,
        getLastCompactionTokensAfter,
      } = subscription;

      const queueHandle: EmbeddedPiQueueHandle & {
        kind: "embedded";
        cancel: (reason?: "user_abort" | "restart" | "superseded") => void;
      } = {
        kind: "embedded",
        queueMessage: async (text: string, options) => {
          if (options?.steeringMode) {
            activeSession.agent.steeringMode = options.steeringMode;
          }
          await activeSession.steer(text);
        },
        isStreaming: () => activeSession.isStreaming,
        isCompacting: () => subscription.isCompacting(),
        cancel: () => {
          abortRun();
        },
        abort: abortRun,
      };
      let lastAssistant: AgentMessage | undefined;
      let currentAttemptAssistant: EmbeddedRunAttemptResult["currentAttemptAssistant"];
      let attemptUsage: NormalizedUsage | undefined;
      let cacheBreak: ReturnType<typeof completePromptCacheObservation> = null;
      let promptCache: EmbeddedRunAttemptResult["promptCache"];
      let finalPromptText: string | undefined;
      if (params.replyOperation) {
        params.replyOperation.attachBackend(queueHandle);
      }
      setActiveEmbeddedRun(params.sessionId, queueHandle, params.sessionKey);

      let abortWarnTimer: NodeJS.Timeout | undefined;
      const isProbeSession = params.sessionId?.startsWith("probe-") ?? false;
      const compactionTimeoutMs = resolveCompactionTimeoutMs(params.config);
      let abortTimer: NodeJS.Timeout | undefined;
      let compactionGraceUsed = false;
      const scheduleAbortTimer = (delayMs: number, reason: "initial" | "compaction-grace") => {
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
      let promptErrorSource: "prompt" | "compaction" | "precheck" | null = null;
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
        let effectivePrompt = prependBootstrapPromptWarning(
          params.prompt,
          bootstrapPromptWarning.lines,
          {
            preserveExactPrompt: heartbeatPrompt,
          },
        );
        if (userPromptPrefixText) {
          effectivePrompt = `${userPromptPrefixText}\n\n${effectivePrompt}`;
        }
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
              legacyBeforeAgentStartResult: params.legacyBeforeAgentStartResult,
            });
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
            applySystemPromptOverrideToSession(activeSession, legacySystemPrompt);
            systemPromptText = legacySystemPrompt;
            log.debug(`hooks: applied systemPrompt override (${legacySystemPrompt.length} chars)`);
          }
          const prependedOrAppendedSystemPrompt = composeSystemPromptWithHookContext({
            baseSystemPrompt: systemPromptText,
            prependSystemContext: resolveAttemptPrependSystemContext({
              sessionKey: params.sessionKey,
              trigger: params.trigger,
              hookPrependSystemContext: hookResult?.prependSystemContext,
            }),
            appendSystemContext: hookResult?.appendSystemContext,
          });
          if (prependedOrAppendedSystemPrompt) {
            const prependSystemLen = hookResult?.prependSystemContext?.trim().length ?? 0;
            const appendSystemLen = hookResult?.appendSystemContext?.trim().length ?? 0;
            applySystemPromptOverrideToSession(activeSession, prependedOrAppendedSystemPrompt);
            systemPromptText = prependedOrAppendedSystemPrompt;
            log.debug(
              `hooks: applied prependSystemContext/appendSystemContext (${prependSystemLen}+${appendSystemLen} chars)`,
            );
          }
        }

        if (cacheObservabilityEnabled) {
          const cacheObservation = beginPromptCacheObservation({
            sessionId: params.sessionId,
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
          sessionManager,
          signal: runAbortController.signal,
          streamFn: activeSession.agent.streamFn,
          systemPrompt: systemPromptText,
        });
        if (googlePromptCacheStreamFn) {
          activeSession.agent.streamFn = googlePromptCacheStreamFn;
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
        cacheTrace?.recordStage("prompt:before", {
          prompt: effectivePrompt,
          messages: activeSession.messages,
        });

        // Repair orphaned trailing user messages so new prompts don't violate role ordering.
        const leafEntry = isRawModelRun ? null : sessionManager.getLeafEntry();
        if (leafEntry?.type === "message" && leafEntry.message.role === "user") {
          const orphanPromptMerge = resolveMessageMergeStrategy().mergeOrphanedTrailingUserPrompt({
            prompt: effectivePrompt,
            trigger: params.trigger,
            leafMessage: leafEntry.message,
          });
          effectivePrompt = orphanPromptMerge.prompt;
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
        if (!isRawModelRun) {
          effectivePrompt = annotateInterSessionPromptText(effectivePrompt, params.inputProvenance);
        }
        const effectiveTranscriptPrompt =
          params.transcriptPrompt === undefined
            ? undefined
            : isRawModelRun
              ? params.transcriptPrompt
              : annotateInterSessionPromptText(params.transcriptPrompt, params.inputProvenance);
        const transcriptLeafId =
          (sessionManager.getLeafEntry() as { id?: string } | null | undefined)?.id ?? null;
        const heartbeatSummary =
          params.config && sessionAgentId
            ? resolveHeartbeatSummaryForAgent(params.config, sessionAgentId)
            : undefined;

        try {
          const filteredMessages = filterHeartbeatPairs(
            activeSession.messages,
            heartbeatSummary?.ackMaxChars,
            heartbeatSummary?.prompt,
          );
          if (filteredMessages.length < activeSession.messages.length) {
            activeSession.agent.state.messages = filteredMessages;
          }
          prePromptMessageCount = activeSession.messages.length;

          const promptSubmission = resolveRuntimeContextPromptParts({
            effectivePrompt,
            transcriptPrompt: effectiveTranscriptPrompt,
          });
          const runtimeSystemContext = promptSubmission.runtimeSystemContext?.trim();
          if (promptSubmission.runtimeOnly && runtimeSystemContext) {
            const runtimeSystemPrompt = composeSystemPromptWithHookContext({
              baseSystemPrompt: systemPromptText,
              appendSystemContext: runtimeSystemContext,
            });
            if (runtimeSystemPrompt) {
              applySystemPromptOverrideToSession(activeSession, runtimeSystemPrompt);
              systemPromptText = runtimeSystemPrompt;
            }
          }

          // Detect and load images referenced in the visible prompt for vision-capable models.
          // Images are prompt-local only (pi-like behavior).
          const imageResult = await detectAndLoadPromptImages({
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

          cacheTrace?.recordStage("prompt:images", {
            prompt: promptSubmission.prompt,
            messages: activeSession.messages,
            note: `images: prompt=${imageResult.images.length}`,
          });
          trajectoryRecorder?.recordEvent("context.compiled", {
            systemPrompt: systemPromptText,
            prompt: promptSubmission.prompt,
            messages: activeSession.messages,
            tools: toTrajectoryToolDefinitions(effectiveTools),
            imagesCount: imageResult.images.length,
            streamStrategy,
            transport: effectiveAgentTransport,
            transcriptLeafId,
          });

          const promptSkipReason = skipPromptSubmission
            ? null
            : resolvePromptSubmissionSkipReason({
                prompt: promptSubmission.prompt,
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
              prompt: promptSubmission.prompt,
              messages: activeSession.messages,
              imagesCount: imageResult.images.length,
            });
          }

          const msgCount = activeSession.messages.length;
          const systemLen = systemPromptText?.length ?? 0;
          const promptLen = effectivePrompt.length;
          const sessionSummary = summarizeSessionContext(activeSession.messages);
          const reserveTokens = settingsManager.getCompactionReserveTokens();
          const contextTokenBudget = params.contextTokenBudget ?? DEFAULT_CONTEXT_TOKENS;
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

          if (!isRawModelRun && hookRunner?.hasHooks("llm_input")) {
            hookRunner
              .runLlmInput(
                {
                  runId: params.runId,
                  sessionId: params.sessionId,
                  provider: params.provider,
                  model: params.modelId,
                  systemPrompt: systemPromptText,
                  prompt: effectivePrompt,
                  historyMessages: activeSession.messages,
                  imagesCount: imageResult.images.length,
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
              .catch((err) => {
                log.warn(`llm_input hook failed: ${String(err)}`);
              });
          }

          const preemptiveCompaction = shouldPreemptivelyCompactBeforePrompt({
            messages: activeSession.messages,
            ...(contextEnginePromptAuthority === "preassembly_may_overflow"
              ? { unwindowedMessages: unwindowedContextEngineMessagesForPrecheck }
              : {}),
            systemPrompt: systemPromptText,
            prompt: effectivePrompt,
            contextTokenBudget,
            reserveTokens,
            toolResultMaxChars: resolveLiveToolResultMaxChars({
              contextWindowTokens: contextTokenBudget,
              cfg: params.config,
              agentId: sessionAgentId,
            }),
          });
          if (preemptiveCompaction.route === "truncate_tool_results_only") {
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
          if (preemptiveCompaction.shouldCompact) {
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
            finalPromptText = promptSubmission.prompt;
            trajectoryRecorder?.recordEvent("prompt.submitted", {
              prompt: promptSubmission.prompt,
              systemPrompt: systemPromptText,
              messages: activeSession.messages,
              imagesCount: imageResult.images.length,
            });
            const btwSnapshotMessages = normalizedReplayMessages.slice(-MAX_BTW_SNAPSHOT_MESSAGES);
            updateActiveEmbeddedRunSnapshot(params.sessionId, {
              transcriptLeafId,
              messages: btwSnapshotMessages,
              inFlightPrompt: promptSubmission.prompt,
            });
            if (promptSubmission.runtimeOnly) {
              await abortable(activeSession.prompt(promptSubmission.prompt));
            } else {
              const runtimeContext = promptSubmission.runtimeContext?.trim();
              const runtimeSystemPrompt = runtimeContext
                ? composeSystemPromptWithHookContext({
                    baseSystemPrompt: systemPromptText,
                    appendSystemContext: buildRuntimeContextSystemContext(runtimeContext),
                  })
                : undefined;
              if (runtimeSystemPrompt) {
                applySystemPromptOverrideToSession(activeSession, runtimeSystemPrompt);
              }
              try {
                await queueRuntimeContextForNextTurn({
                  session: activeSession,
                  runtimeContext,
                });

                // Only pass images option if there are actually images to pass
                // This avoids potential issues with models that don't expect the images parameter
                if (imageResult.images.length > 0) {
                  await abortable(
                    activeSession.prompt(promptSubmission.prompt, { images: imageResult.images }),
                  );
                } else {
                  await abortable(activeSession.prompt(promptSubmission.prompt));
                }
              } finally {
                if (runtimeSystemPrompt) {
                  applySystemPromptOverrideToSession(activeSession, systemPromptText);
                }
              }
            }
          }
        } catch (err) {
          yieldAborted =
            yieldDetected &&
            isRunnerAbortError(err) &&
            err instanceof Error &&
            err.cause === "sessions_yield";
          if (yieldAborted) {
            aborted = false;
            await waitForSessionsYieldAbortSettle({
              settlePromise: yieldAbortSettled,
              runId: params.runId,
              sessionId: params.sessionId,
            });
            stripSessionsYieldArtifacts(activeSession);
            if (yieldMessage) {
              await persistSessionsYieldContextMessage(activeSession, yieldMessage);
            }
          } else if (isMidTurnPrecheckSignal(err)) {
            handleMidTurnPrecheckRequest(err.request);
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
          removeTrailingMidTurnPrecheckAssistantError({
            activeSession,
            sessionManager,
          });
          if (!preflightRecovery && promptErrorSource !== "precheck") {
            promptError = null;
            promptErrorSource = null;
            handleMidTurnPrecheckRequest(request);
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
          if (params.onBlockReplyFlush) {
            await params.onBlockReplyFlush();
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

        // Check if ANY compaction occurred during the entire attempt (prompt + retry).
        // Using a cumulative count (> 0) instead of a delta check avoids missing
        // compactions that complete during activeSession.prompt() before the delta
        // baseline is sampled.
        const compactionOccurredThisAttempt = getCompactionCount() > 0;
        // Append cache-TTL timestamp AFTER prompt + compaction retry completes.
        // Previously this was before the prompt, which caused a custom entry to be
        // inserted between compaction and the next prompt — breaking the
        // prepareCompaction() guard that checks the last entry type, leading to
        // double-compaction. See: https://github.com/openclaw/openclaw/issues/9282
        // Skip when timed out during compaction — session state may be inconsistent.
        // Also skip when compaction ran this attempt — appending a custom entry
        // after compaction would break the guard again. See: #28491
        appendAttemptCacheTtlIfNeeded({
          sessionManager,
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
        messagesSnapshot = snapshotSelection.messagesSnapshot;
        sessionIdUsed = snapshotSelection.sessionIdUsed;

        lastAssistant = messagesSnapshot
          .slice()
          .toReversed()
          .find((m) => m.role === "assistant");
        currentAttemptAssistant = findCurrentAttemptAssistantMessage({
          messagesSnapshot,
          prePromptMessageCount,
        });
        attemptUsage = getUsageTotals();
        cacheBreak = cacheObservabilityEnabled
          ? completePromptCacheObservation({
              sessionId: params.sessionId,
              sessionKey: params.sessionKey,
              usage: attemptUsage,
            })
          : null;
        const lastCallUsage = normalizeUsage(currentAttemptAssistant?.usage);
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
        const fallbackLastCacheTouchAt = readLastCacheTtlTimestamp(sessionManager, {
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
            sessionManager.appendCustomEntry("openclaw:prompt-error", {
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

        // Let the active context engine run its post-turn lifecycle.
        if (activeContextEngine) {
          const afterTurnRuntimeContext = buildAfterTurnRuntimeContextFromUsage({
            attempt: params,
            workspaceDir: effectiveWorkspace,
            agentDir,
            tokenBudget: params.contextTokenBudget,
            lastCallUsage,
            promptCache,
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
            prePromptMessageCount,
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
                runtimeContext: contextParams.runtimeContext,
                config: params.config,
              }),
            sessionManager,
            config: params.config,
            warn: (message) => log.warn(message),
          });
        }

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
            sessionManager.appendCustomEntry(FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE, {
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
              sessionManager,
              sessionFile: params.sessionFile,
            });
            if (rotation.rotated) {
              sessionIdUsed = rotation.sessionId ?? sessionIdUsed;
              sessionFileUsed = rotation.sessionFile ?? sessionFileUsed;
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

        cacheTrace?.recordStage("session:after", {
          messages: messagesSnapshot,
          note: timedOutDuringCompaction
            ? "compaction timeout"
            : promptError
              ? "prompt error"
              : undefined,
        });
        anthropicPayloadLogger?.recordUsage(messagesSnapshot, promptError);

        // Run agent_end hooks to allow plugins to analyze the conversation
        // This is fire-and-forget, so we don't await
        // Run even on compaction timeout so plugins can log/cleanup
        if (hookRunner?.hasHooks("agent_end")) {
          hookRunner
            .runAgentEnd(
              {
                messages: messagesSnapshot,
                success: !aborted && !promptError,
                error: promptError ? formatErrorMessage(promptError) : undefined,
                durationMs: Date.now() - promptStartedAt,
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
            .catch((err) => {
              log.warn(`agent_end hook failed: ${err}`);
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
        clearActiveEmbeddedRun(params.sessionId, queueHandle, params.sessionKey);
        params.abortSignal?.removeEventListener?.("abort", onAbort);
      }

      const toolMetasNormalized = toolMetas
        .filter(
          (entry): entry is { toolName: string; meta?: string } =>
            typeof entry.toolName === "string" && entry.toolName.trim().length > 0,
        )
        .map((entry) => ({ toolName: entry.toolName, meta: entry.meta }));
      if (cacheObservabilityEnabled) {
        if (cacheBreak) {
          const changeSummary =
            cacheBreak.changes?.map((change) => `${change.code}(${change.detail})`).join(", ") ??
            "no tracked cache input change";
          log.warn(
            `[prompt-cache] cache read dropped ${cacheBreak.previousCacheRead} -> ${cacheBreak.cacheRead} ` +
              `for ${params.provider}/${params.modelId} via ${streamStrategy}; ${changeSummary}`,
          );
          cacheTrace?.recordStage("cache:result", {
            options: {
              previousCacheRead: cacheBreak.previousCacheRead,
              cacheRead: cacheBreak.cacheRead,
              changes:
                cacheBreak.changes?.map((change) => ({
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

      if (hookRunner?.hasHooks("llm_output")) {
        hookRunner
          .runLlmOutput(
            {
              runId: params.runId,
              sessionId: params.sessionId,
              provider: params.provider,
              model: params.modelId,
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
              ...buildAgentHookContextChannelFields(params),
            },
          )
          .catch((err) => {
            log.warn(`llm_output hook failed: ${String(err)}`);
          });
      }

      const observedReplayMetadata = buildAttemptReplayMetadata({
        toolMetas: toolMetasNormalized,
        didSendViaMessagingTool: didSendViaMessagingTool(),
        messagingToolSentTexts: getMessagingToolSentTexts(),
        messagingToolSentMediaUrls: getMessagingToolSentMediaUrls(),
        successfulCronAdds: getSuccessfulCronAdds(),
      });
      const pendingToolMediaReply = getPendingToolMediaReply();
      const replayMetadata = replayMetadataFromState(
        observeReplayMetadata(getReplayState(), observedReplayMetadata),
      );
      trajectoryRecorder?.recordEvent("model.completed", {
        aborted,
        externalAbort,
        timedOut,
        idleTimedOut,
        timedOutDuringCompaction,
        timedOutDuringToolExecution,
        promptError: promptError ? formatErrorMessage(promptError) : undefined,
        promptErrorSource,
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
          status: promptError ? "error" : aborted || timedOut ? "interrupted" : "success",
          aborted,
          externalAbort,
          timedOut,
          idleTimedOut,
          timedOutDuringCompaction,
          timedOutDuringToolExecution,
          promptError: promptError ? formatErrorMessage(promptError) : undefined,
          promptErrorSource,
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
          lastToolError: getLastToolError?.(),
        }),
      );
      trajectoryRecorder?.recordEvent("session.ended", {
        status: promptError ? "error" : aborted || timedOut ? "interrupted" : "success",
        aborted,
        externalAbort,
        timedOut,
        idleTimedOut,
        timedOutDuringCompaction,
        timedOutDuringToolExecution,
        promptError: promptError ? formatErrorMessage(promptError) : undefined,
      });
      trajectoryEndRecorded = true;

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
        lastAssistant,
        currentAttemptAssistant,
        lastToolError: getLastToolError?.(),
        didSendViaMessagingTool: didSendViaMessagingTool(),
        messagingToolSentTexts: getMessagingToolSentTexts(),
        messagingToolSentMediaUrls: getMessagingToolSentMediaUrls(),
        messagingToolSentTargets: getMessagingToolSentTargets(),
        heartbeatToolResponse: getHeartbeatToolResponse(),
        toolMediaUrls: pendingToolMediaReply?.mediaUrls,
        toolAudioAsVoice: pendingToolMediaReply?.audioAsVoice,
        successfulCronAdds: getSuccessfulCronAdds(),
        cloudCodeAssistFormatError: Boolean(
          lastAssistant?.errorMessage && isCloudCodeAssistFormatError(lastAssistant.errorMessage),
        ),
        attemptUsage,
        promptCache,
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
      await runAgentCleanupStep({
        runId: params.runId,
        sessionId: params.sessionId,
        step: "pi-trajectory-flush",
        log,
        cleanup: async () => {
          await trajectoryRecorder?.flush();
        },
      });
      // Always tear down the session (and release the lock) before we leave this attempt.
      //
      // BUGFIX: Wait for the agent to be truly idle before flushing pending tool results.
      // pi-agent-core's auto-retry resolves waitForRetry() on assistant message receipt,
      // *before* tool execution completes in the retried agent loop. Without this wait,
      // flushPendingToolResults() fires while tools are still executing, inserting
      // synthetic "missing tool result" errors and causing silent agent failures.
      // See: https://github.com/openclaw/openclaw/issues/8643
      let cleanupError: unknown;
      try {
        await cleanupEmbeddedAttemptResources({
          removeToolResultContextGuard,
          flushPendingToolResultsAfterIdle,
          session,
          sessionManager,
          releaseWsSession,
          allowWsSessionPool:
            !promptError && !aborted && !timedOut && !idleTimedOut && !timedOutDuringCompaction,
          sessionId: params.sessionId,
          bundleMcpRuntime,
          bundleLspRuntime,
          sessionLock,
        });
      } catch (err) {
        cleanupError = err;
      }
      emitDiagnosticRunCompleted?.(
        cleanupError || promptError
          ? "error"
          : aborted || timedOut || idleTimedOut || timedOutDuringCompaction
            ? "aborted"
            : "completed",
        cleanupError ?? promptError,
      );
      if (cleanupError) {
        await Promise.reject(cleanupError);
      }
    }
  } finally {
    emitDiagnosticRunCompleted?.(
      aborted ? "aborted" : "error",
      promptError ?? new Error("run exited before diagnostic completion"),
    );
    restoreSkillEnv?.();
  }
}
