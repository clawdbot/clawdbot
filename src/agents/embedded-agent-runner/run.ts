/**
 * Top-level embedded-agent run orchestration entrypoint.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import {
  addTimerTimeoutGraceMs,
  MAX_TIMER_TIMEOUT_MS,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
import { resetContinueDelegateTurnBudget } from "../../auto-reply/continuation/delegate-turn-admission.js";
import { FAST_MODE_AUTO_PROGRESS_KIND, type ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import { getRuntimeConfigSnapshot } from "../../config/config.js";
import { resolveStorePath } from "../../config/sessions.js";
import { loadSessionEntry, updateSessionEntry } from "../../config/sessions/session-accessor.js";
import { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } from "../../context-engine/host-compat.js";
import { ensureContextEnginesInitialized } from "../../context-engine/init.js";
import {
  resolveContextEngine,
  resolveContextEngineOwnerPluginId,
} from "../../context-engine/registry.js";
import { buildContextEngineRuntimeSettings } from "../../context-engine/runtime-settings.js";
import { resolveCompactionSuccessorTranscript } from "../../context-engine/types.js";
import {
  assertAgentRunLifecycleGenerationCurrent,
  captureAgentRunLifecycleGeneration,
  claimAgentRunContext,
  emitAgentItemEvent,
  getAgentEventLifecycleGeneration,
  getAgentRunContext,
  registerAgentRunContext,
  withAgentRunLifecycleGeneration,
} from "../../infra/agent-events.js";
import { sleepWithAbort } from "../../infra/backoff.js";
import { freezeDiagnosticTraceContext } from "../../infra/diagnostic-trace-context.js";
import { formatErrorMessage, toErrorObject } from "../../infra/errors.js";
import { requireSessionKeyOrSkip } from "../../infra/session-keys.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { redactIdentifier } from "../../logging/redact-identifier.js";
import { buildAgentHookContextChannelFields } from "../../plugins/hook-agent-context.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { resolveProviderAuthProfileId } from "../../plugins/provider-runtime.js";
import { enqueueCommandInLane, getCommandLaneSnapshot } from "../../process/command-queue.js";
import type { CommandQueueEnqueueOptions } from "../../process/command-queue.types.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { createAgentHarnessTaskRuntimeScope } from "../../tasks/agent-harness-task-runtime-scope.js";
import { resolveUserPath } from "../../utils.js";
import { isMarkdownCapableMessageChannel } from "../../utils/message-channel.js";
import {
  retireSessionMcpRuntime,
  retireSessionMcpRuntimeForSessionKey,
} from "../agent-bundle-mcp-tools.js";
import {
  resolveAgentDir,
  resolveSessionAgentIds,
  resolveAgentWorkspaceDir,
} from "../agent-scope.js";
import type { ToolOutcomeObservation } from "../agent-tools.before-tool-call.js";
import { resolveProcessToolScopeKey } from "../agent-tools.js";
import {
  type AuthProfileFailureReason,
  type AuthProfileStore,
  isProfileInCooldown,
  markAuthProfileFailure,
  markAuthProfileSuccess,
  resolveAuthProfileEligibility,
} from "../auth-profiles.js";
import { resolveExternalCliAuthOverlayScopeFromSelection } from "../auth-profiles/external-cli-auth-selection.js";
import { listActiveProcessSessionReferences } from "../bash-process-references.js";
import {
  resolveSessionKeyForRequest,
  resolveStoredSessionKeyForSessionId,
} from "../command/session.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import {
  classifyAssistantFailoverReason,
  classifyFailoverReason,
  extractObservedOverflowTokenCount,
  type FailoverReason,
  formatAssistantErrorText,
  isAuthAssistantError,
  isBillingAssistantError,
  isCompactionFailureError,
  isFailoverAssistantError,
  isFailoverErrorMessage,
  isGenericUnknownStreamErrorMessage,
  isLikelyContextOverflowError,
  isRateLimitAssistantError,
  parseImageDimensionError,
  parseImageSizeError,
  pickFallbackThinkingLevel,
} from "../embedded-agent-helpers.js";
import { isStrictAgenticExecutionContractActive } from "../execution-contract.js";
import {
  coerceToFailoverError,
  describeFailoverError,
  FailoverError,
  resolveFailoverStatus,
} from "../failover-error.js";
import {
  DEFAULT_FAST_MODE_AUTO_ON_SECONDS,
  type FastModeAutoProgressState,
  formatFastModeAutoProgressText,
  resolveFastModeForElapsed,
} from "../fast-mode.js";
import { ensureSelectedAgentHarnessPlugin } from "../harness/runtime-plugin.js";
import { agentHarnessBuildsOpenClawTools, selectAgentHarness } from "../harness/selection.js";
import { LiveSessionModelSwitchError } from "../live-model-switch-error.js";
import { shouldSwitchToLiveModel, clearLiveModelSwitchPending } from "../live-model-switch.js";
import {
  applyAuthHeaderOverride,
  applyLocalNoAuthHeaderOverride,
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
  type ResolvedProviderAuth,
  resolveAuthProfileOrder,
  shouldPreferExplicitConfigApiKeyAuth,
} from "../model-auth.js";
import {
  buildModelAliasIndex,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
} from "../model-selection.js";
import { resolveThinkingDefault } from "../model-thinking-default.js";
import { ensureOpenClawModelsJson } from "../models-config.js";
import {
  OPENAI_PROVIDER_ID,
  listOpenAIAuthProfileProvidersForAgentRuntime,
  resolveContextConfigProviderForRuntime,
  resolveSelectedOpenAIRuntimeProvider,
} from "../openai-routing.js";
import { resolveProviderIdForAuth } from "../provider-auth-aliases.js";
import { hasOnlyAssistantReasoningContent } from "../replay-turn-classification.js";
import { runAgentCleanupStep } from "../run-cleanup-timeout.js";
import {
  applyAgentRunSessionTargetIdentity,
  resolveAgentRunSessionTarget,
} from "../run-session-target.js";
import { createAgentRunDirectAbortError } from "../run-termination.js";
import { buildAgentRuntimeAuthPlan } from "../runtime-plan/auth.js";
import { buildAgentRuntimePlan } from "../runtime-plan/build.js";
import { ensureRuntimePluginsLoaded } from "../runtime-plugins.js";
import {
  resolveSessionSuspensionReason,
  resolveSessionSuspensionTarget,
  suspendSession,
  type SessionSuspensionParams,
} from "../session-suspension.js";
import { resolveCandidateThinkingLevel } from "../thinking-runtime.js";
import { DEFAULT_AGENT_TIMEOUT_MS } from "../timeout.js";
import { resolveToolLoopDetectionConfig } from "../tool-loop-detection-config.js";
import { deriveContextPromptTokens, normalizeUsage, type UsageLike } from "../usage.js";
import { redactRunIdentifier, resolveRunWorkspaceDir } from "../workspace-run.js";
import { runPostCompactionSideEffects } from "./compaction-hooks.js";
import { buildEmbeddedCompactionRuntimeContext } from "./compaction-runtime-context.js";
import {
  compactContextEngineWithSafetyTimeout,
  resolveCompactionTimeoutMs,
} from "./compaction-safety-timeout.js";
import { resolveContextEngineCapabilities } from "./context-engine-capabilities.js";
import {
  runContextEngineMaintenance,
  waitForDeferredTurnMaintenanceForSession,
} from "./context-engine-maintenance.js";
import {
  hasMessagingToolDeliveryEvidence,
  hasOutboundDeliveryEvidence,
} from "./delivery-evidence.js";
import { resolveEmbeddedRunFailureSignal } from "./failure-signal.js";
import { resolveGlobalLane, resolveSessionLane } from "./lanes.js";
import { log } from "./logger.js";
import { createEmptyAgentDiscoveryStores, resolveModelAsync } from "./model.js";
import {
  createPostCompactionLoopGuard,
  PostCompactionLoopPersistedError,
} from "./post-compaction-loop-guard.js";
import { createEmbeddedRunReplayState, observeReplayMetadata } from "./replay-state.js";
import {
  handleAssistantFailover,
  isShortWindowRateLimitMessage,
} from "./run/assistant-failover.js";
import {
  createEmbeddedRunStageTracker,
  EMBEDDED_RUN_ATTEMPT_DISPATCH_STAGE,
  formatEmbeddedRunStageSummary,
  shouldWarnEmbeddedRunStageSummary,
} from "./run/attempt-stage-timing.js";
import { forgetPromptBuildDrainCacheForRun } from "./run/attempt.prompt-helpers.js";
import { createEmbeddedRunAuthController } from "./run/auth-controller.js";
import { resolveAuthProfileFailureReason } from "./run/auth-profile-failure-policy.js";
import { runEmbeddedAttemptWithBackend } from "./run/backend.js";
import {
  hasCodexAppServerRecoveryRetryBudget,
  resolveCodexAppServerRecoveryRetry,
} from "./run/codex-app-server-recovery.js";
import { createFailoverDecisionLogger } from "./run/failover-observation.js";
import { mergeRetryFailoverReason, resolveRunFailoverDecision } from "./run/failover-policy.js";
import { hasEmbeddedRunConfiguredModelFallbacks } from "./run/fallbacks.js";
import {
  buildErrorAgentMeta,
  buildUsageAgentMetaFields,
  createCompactionDiagId,
  isAssistantForModelRef,
  resolveActiveErrorContext,
  resolveFinalAssistantRawText,
  resolveFinalAssistantVisibleText,
  resolveLatestCallUsage,
  resolveMaxRunRetryIterations,
  resolveReportedModelRef,
  MAX_SAME_MODEL_RATE_LIMIT_RETRIES,
  resolveOverloadFailoverBackoffMs,
  resolveOverloadProfileRotationLimit,
  resolveRateLimitProfileRotationLimit,
  resolveEmbeddedAttemptBasePrompt,
  resolveNextSameModelRateLimitRetryCount,
  resolveSameModelRateLimitRetryDelayMs,
  type RuntimeAuthState,
} from "./run/helpers.js";
import {
  MAX_CONSECUTIVE_IDLE_TIMEOUTS_BEFORE_OUTPUT,
  createIdleTimeoutBreakerState,
  stepIdleTimeoutBreaker,
} from "./run/idle-timeout-breaker.js";
import {
  DEFAULT_EMPTY_RESPONSE_RETRY_LIMIT,
  DEFAULT_REASONING_ONLY_RETRY_LIMIT,
  hasAttemptTerminalState,
  resolveAttemptReplayMetadata,
  resolveEmptyResponseRetryInstruction,
  resolveIncompleteTurnPayloadText,
  resolveReasoningOnlyRetryInstruction,
  resolveSilentToolResultReplyPayload,
  resolveReplayInvalidFlag,
  resolveRunLivenessState,
  shouldRetryMissingAssistantTurn,
  shouldRetrySilentErrorAssistantTurn,
  shouldTreatEmptyAssistantReplyAsSilent,
} from "./run/incomplete-turn.js";
import type { RunEmbeddedAgentParams } from "./run/params.js";
import { buildEmbeddedRunPayloads } from "./run/payloads.js";
import { handleRetryLimitExhaustion } from "./run/retry-limit.js";
import {
  buildBeforeModelResolveAttachments,
  createNativeModelOwnedRuntimeModel,
  resolveEmbeddedRuntimeModelPolicy,
  resolveAgentHarnessRunAdmissionError,
  resolveHookModelSelection,
  resolveNativeModelOwnedHarnessId,
} from "./run/setup.js";
import { mergeAttemptToolMediaPayloads } from "./run/tool-media-payloads.js";
import type { EmbeddedRunFastModeParam } from "./run/types.js";
import {
  resolveLiveToolResultMaxChars,
  sessionLikelyHasOversizedToolResults,
  truncateOversizedToolResultsInSession,
} from "./tool-result-truncation.js";
import type {
  EmbeddedAgentMeta,
  EmbeddedAgentRunResult,
  TraceAttempt,
  ToolSummaryTrace,
} from "./types.js";
import { createUsageAccumulator, mergeUsageIntoAccumulator } from "./usage-accumulator.js";
import { mapThinkingLevelForProvider } from "./utils.js";

type ApiKeyInfo = ResolvedProviderAuth;

const MAX_SAME_MODEL_IDLE_TIMEOUT_RETRIES = 1;
const EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS = 30_000;
const EMBEDDED_RUN_LANE_HEARTBEAT_MS = EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS / 2;
const MID_TURN_PRECHECK_CONTINUATION_PROMPT =
  "Continue from the current transcript after the latest tool result. Do not repeat the original user request, and do not rerun completed tools unless the transcript shows they are still needed.";
const COMPACTION_CONTINUATION_RETRY_INSTRUCTION =
  "The previous attempt compacted the conversation context before producing a final user-visible answer. Continue from the compacted transcript and produce the final answer now. Do not restart from scratch, do not repeat completed work, and do not rerun tools unless the transcript clearly lacks required evidence.";
const NO_REAL_CONVERSATION_MESSAGES_REASON = "no real conversation messages";
const BEFORE_AGENT_FINALIZE_RETRY_PROMPT_PREFIX =
  "Before accepting the previous final answer, apply this revision request and produce the revised final answer. Do not repeat completed work or rerun tools unless the request explicitly requires it.";
const MAX_BEFORE_AGENT_FINALIZE_REVISIONS = 3;
type EmbeddedRunAttemptForRunner = Awaited<ReturnType<typeof runEmbeddedAttemptWithBackend>>;
type RunEmbeddedAgentParamsWithSessionFile = RunEmbeddedAgentParams & { sessionFile: string };

function isNoRealConversationCompactionNoop(params: {
  ok?: boolean;
  compacted?: boolean;
  reason?: string;
}): boolean {
  return (
    params.ok === true &&
    params.compacted === false &&
    params.reason === NO_REAL_CONVERSATION_MESSAGES_REASON
  );
}

function resolveInitialThinkLevel(params: {
  requested?: ThinkLevel;
  config?: RunEmbeddedAgentParams["config"];
  provider: string;
  modelId: string;
  model: { reasoning?: boolean };
}): ThinkLevel {
  if (params.requested) {
    return params.requested;
  }
  return resolveThinkingDefault({
    cfg: params.config ?? {},
    provider: params.provider,
    model: params.modelId,
    catalog: [
      {
        provider: params.provider,
        id: params.modelId,
        name: params.modelId,
        reasoning: params.model.reasoning,
      },
    ],
  });
}

async function resetNoRealConversationTokenSnapshot(params: {
  config?: RunEmbeddedAgentParams["config"];
  sessionKey?: string;
  agentId?: string;
}): Promise<void> {
  if (!params.sessionKey) {
    return;
  }
  const storePath = resolveStorePath(params.config?.session?.store, { agentId: params.agentId });
  try {
    await updateSessionEntry(
      {
        storePath,
        sessionKey: params.sessionKey,
      },
      async () => ({
        totalTokens: 0,
        totalTokensFresh: true,
        inputTokens: undefined,
        outputTokens: undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
        contextBudgetStatus: undefined,
        updatedAt: Date.now(),
      }),
      {
        skipMaintenance: true,
        takeCacheOwnership: true,
      },
    );
  } catch (err) {
    log.warn(
      `[context-overflow-precheck] failed to reset stale context snapshot for ` +
        `${params.sessionKey}: ${String(err)}`,
    );
  }
}

function resolveAttemptDispatchApiKey(params: {
  apiKeyInfo: ApiKeyInfo | null;
  runtimeAuthState: RuntimeAuthState | null;
}): string | undefined {
  if (params.runtimeAuthState) {
    return undefined;
  }
  return params.apiKeyInfo?.apiKey;
}

function buildBeforeAgentFinalizeRetryPrompt(reason: string): string {
  return `${BEFORE_AGENT_FINALIZE_RETRY_PROMPT_PREFIX}\n\n${reason}`;
}

function resolveEmbeddedRunLaneTimeoutMs(timeoutMs: number): number {
  const defaultLaneTimeoutMs = DEFAULT_AGENT_TIMEOUT_MS + EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS;
  // "No timeout" resolves to the timer-safe MAX_TIMER sentinel upstream.
  // Lane ownership still caps at the default agent deadline in that case.
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs >= MAX_TIMER_TIMEOUT_MS) {
    return defaultLaneTimeoutMs;
  }
  return (
    addTimerTimeoutGraceMs(Math.floor(timeoutMs), EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS) ??
    defaultLaneTimeoutMs
  );
}

function withEmbeddedRunLaneTimeout(
  opts: CommandQueueEnqueueOptions | undefined,
  laneTaskTimeoutMs: number,
): CommandQueueEnqueueOptions | undefined {
  if (opts?.taskTimeoutMs !== undefined) {
    return opts;
  }
  return { ...opts, taskTimeoutMs: laneTaskTimeoutMs };
}

function resolveEmbeddedRunSessionQueuePriority(
  trigger: RunEmbeddedAgentParams["trigger"],
): CommandQueueEnqueueOptions["priority"] {
  switch (trigger) {
    case "user":
    case "manual":
      return "foreground";
    case "cron":
    case "heartbeat":
    case "memory":
    case "overflow":
      return "background";
    default:
      return "normal";
  }
}

function normalizeEmbeddedRunAttemptResult(
  attempt: EmbeddedRunAttemptForRunner,
): EmbeddedRunAttemptForRunner {
  const raw = attempt as EmbeddedRunAttemptForRunner & {
    assistantTexts?: EmbeddedRunAttemptForRunner["assistantTexts"] | null;
    toolMetas?: EmbeddedRunAttemptForRunner["toolMetas"] | null;
    acceptedSessionSpawns?: EmbeddedRunAttemptForRunner["acceptedSessionSpawns"] | null;
    messagesSnapshot?: EmbeddedRunAttemptForRunner["messagesSnapshot"] | null;
    messagingToolSentTexts?: EmbeddedRunAttemptForRunner["messagingToolSentTexts"] | null;
    messagingToolSentMediaUrls?: EmbeddedRunAttemptForRunner["messagingToolSentMediaUrls"] | null;
    messagingToolSentTargets?: EmbeddedRunAttemptForRunner["messagingToolSentTargets"] | null;
    messagingToolSourceReplyPayloads?:
      | EmbeddedRunAttemptForRunner["messagingToolSourceReplyPayloads"]
      | null;
    didDeliverSourceReplyViaMessageTool?: boolean | null;
    itemLifecycle?: EmbeddedRunAttemptForRunner["itemLifecycle"] | null;
    currentAttemptReplayMetadata?:
      | EmbeddedRunAttemptForRunner["currentAttemptReplayMetadata"]
      | null;
  };
  return {
    ...attempt,
    assistantTexts: raw.assistantTexts ?? [],
    toolMetas: raw.toolMetas ?? [],
    acceptedSessionSpawns: raw.acceptedSessionSpawns ?? [],
    messagesSnapshot: raw.messagesSnapshot ?? [],
    messagingToolSentTexts: raw.messagingToolSentTexts ?? [],
    messagingToolSentMediaUrls: raw.messagingToolSentMediaUrls ?? [],
    messagingToolSentTargets: raw.messagingToolSentTargets ?? [],
    messagingToolSourceReplyPayloads: raw.messagingToolSourceReplyPayloads ?? [],
    didDeliverSourceReplyViaMessageTool: raw.didDeliverSourceReplyViaMessageTool === true,
    itemLifecycle: raw.itemLifecycle ?? {
      startedCount: 0,
      completedCount: 0,
      activeCount: 0,
    },
    replayMetadata: resolveAttemptReplayMetadata(raw),
    currentAttemptReplayMetadata: raw.currentAttemptReplayMetadata ?? undefined,
  };
}

function hasCompletedModelProgressForIdleBreaker(attempt: EmbeddedRunAttemptForRunner): boolean {
  return (
    attempt.assistantTexts.some((text) => text.trim().length > 0) ||
    attempt.toolMetas.length > 0 ||
    (attempt.clientToolCalls?.length ?? 0) > 0 ||
    hasOutboundDeliveryEvidence(attempt) ||
    attempt.itemLifecycle.completedCount > 0
  );
}

function createEmptyAuthProfileStore(): AuthProfileStore {
  return {
    version: 1,
    profiles: {},
  };
}

function createScopedAuthProfileStore(
  store: AuthProfileStore,
  profileIds: string | undefined | string[],
): AuthProfileStore {
  const profiles = store.profiles ?? {};
  const normalizedProfileIds = (Array.isArray(profileIds) ? profileIds : [profileIds])
    .map((profileId) => profileId?.trim())
    .filter((profileId): profileId is string => Boolean(profileId));
  const scopedProfiles = Object.fromEntries(
    normalizedProfileIds.flatMap((profileId) => {
      const credential = profiles[profileId];
      return credential ? [[profileId, credential] as const] : [];
    }),
  );
  const scopedRuntimeExternalProfileIds = (store.runtimeExternalProfileIds ?? []).filter(
    (profileId) => scopedProfiles[profileId],
  );
  const scopedRuntimePersistedProfileIds = (store.runtimePersistedProfileIds ?? []).filter(
    (profileId) => scopedProfiles[profileId],
  );
  return Object.keys(scopedProfiles).length > 0
    ? {
        version: store.version,
        profiles: scopedProfiles,
        ...(scopedRuntimePersistedProfileIds.length > 0
          ? { runtimePersistedProfileIds: scopedRuntimePersistedProfileIds }
          : {}),
        ...(scopedRuntimeExternalProfileIds.length > 0 ||
        store.runtimeExternalProfileIdsAuthoritative === true
          ? { runtimeExternalProfileIds: scopedRuntimeExternalProfileIds }
          : {}),
        ...(store.runtimeExternalProfileIdsAuthoritative === true
          ? { runtimeExternalProfileIdsAuthoritative: true }
          : {}),
      }
    : createEmptyAuthProfileStore();
}

function buildTraceToolSummary(params: {
  toolMetas?: EmbeddedRunAttemptForRunner["toolMetas"];
  fallbackHadFailure: boolean;
}): ToolSummaryTrace | undefined {
  if (!params.toolMetas?.length) {
    return undefined;
  }
  const tools: string[] = [];
  const seen = new Set<string>();
  for (const entry of params.toolMetas) {
    const toolName = normalizeOptionalString(entry.toolName);
    if (!toolName || seen.has(toolName)) {
      continue;
    }
    seen.add(toolName);
    tools.push(toolName);
  }
  const failedToolCalls = params.toolMetas.filter((entry) => entry.isError === true).length;
  return {
    calls: params.toolMetas?.length ?? 0,
    tools,
    // Per-call error metadata is additive to the shipped harness result contract.
    // Keep the prior any-failure signal for external harnesses that do not emit it yet.
    failures: failedToolCalls || Number(params.fallbackHadFailure),
  };
}

/**
 * Best-effort backfill of sessionKey from sessionId when not explicitly provided.
 * The return value is normalized: whitespace-only inputs collapse to undefined, and
 * successful resolution returns a trimmed session key. This is a read-only lookup
 * with no side effects.
 * See: https://github.com/openclaw/openclaw/issues/60552
 */
function backfillSessionKey(params: {
  config: RunEmbeddedAgentParams["config"];
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
}): string | undefined {
  const trimmed = normalizeOptionalString(params.sessionKey);
  if (trimmed) {
    return trimmed;
  }
  if (!params.config || !params.sessionId) {
    return undefined;
  }
  try {
    const resolved = normalizeOptionalString(params.agentId)
      ? resolveStoredSessionKeyForSessionId({
          cfg: params.config,
          sessionId: params.sessionId,
          agentId: params.agentId,
        })
      : resolveSessionKeyForRequest({
          cfg: params.config,
          sessionId: params.sessionId,
          clone: false,
        });
    return normalizeOptionalString(resolved.sessionKey);
  } catch (err) {
    log.warn(
      `[backfillSessionKey] Failed to resolve sessionKey for sessionId=${redactRunIdentifier(sanitizeForLog(params.sessionId))}: ${formatErrorMessage(err)}`,
    );
    return undefined;
  }
}

function assertAgentHarnessRunAdmission(params: RunEmbeddedAgentParams): void {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!sessionKey) {
    return;
  }
  const admissionAgentId = params.agentId ?? resolveAgentIdFromSessionKey(sessionKey);
  const storePath =
    normalizeOptionalString(params.sessionTarget?.storePath) ??
    resolveStorePath(params.config?.session?.store, { agentId: admissionAgentId });
  const durableEntry = loadSessionEntry({
    ...(admissionAgentId ? { agentId: admissionAgentId } : {}),
    readConsistency: "latest",
    sessionKey,
    storePath,
  });
  const admissionError = resolveAgentHarnessRunAdmissionError({
    agentHarnessId: params.agentHarnessId,
    entry: durableEntry,
    modelSelectionLocked: params.modelSelectionLocked,
    sessionId: params.sessionId,
    sessionKey,
  });
  if (admissionError) {
    throw new Error(admissionError);
  }
}

function buildHandledReplyPayloads(reply?: ReplyPayload) {
  const normalized = reply ?? { text: SILENT_REPLY_TOKEN };
  return [
    {
      text: normalized.text,
      mediaUrl: normalized.mediaUrl,
      mediaUrls: normalized.mediaUrls,
      replyToId: normalized.replyToId,
      audioAsVoice: normalized.audioAsVoice,
      isError: normalized.isError,
      isReasoning: normalized.isReasoning,
    },
  ];
}

function resolveInitialEmbeddedRunModel(params: {
  config: RunEmbeddedAgentParams["config"];
  agentId?: string;
  provider?: string;
  model?: string;
}): { provider: string; modelId: string } {
  const cfg = params.config ?? {};
  const configuredDefault = resolveDefaultModelForAgent({
    cfg,
    agentId: params.agentId,
  });
  const explicitProvider = normalizeOptionalString(params.provider);
  const explicitModel = normalizeOptionalString(params.model);
  const defaultProvider = configuredDefault.provider || DEFAULT_PROVIDER;

  if (explicitProvider && explicitModel) {
    return { provider: explicitProvider, modelId: explicitModel };
  }

  if (explicitModel) {
    const provider = explicitProvider ?? defaultProvider;
    const aliasIndex = buildModelAliasIndex({
      cfg,
      defaultProvider: provider,
    });
    const resolved = resolveModelRefFromString({
      cfg,
      raw: explicitModel,
      defaultProvider: provider,
      aliasIndex,
    });
    return {
      provider: explicitProvider ?? resolved?.ref.provider ?? provider,
      modelId: resolved?.ref.model ?? explicitModel,
    };
  }

  return {
    provider: explicitProvider ?? defaultProvider,
    modelId: configuredDefault.model || DEFAULT_MODEL,
  };
}

const POST_RUN_AUTH_PROFILE_SUCCESS_SLOW_MS = 1_000;

export function runEmbeddedAgent(
  paramsInput: RunEmbeddedAgentParams,
): Promise<EmbeddedAgentRunResult> {
  const requestedProvider = normalizeOptionalString(paramsInput.provider);
  const requestedModel = normalizeOptionalString(paramsInput.model);
  const needsConfiguredDefault = !paramsInput.config && !requestedProvider && !requestedModel;
  const config =
    paramsInput.config ??
    (needsConfiguredDefault ? (getRuntimeConfigSnapshot() ?? undefined) : undefined);
  const lifecycleGeneration =
    paramsInput.lifecycleGeneration ?? captureAgentRunLifecycleGeneration(paramsInput.runId);
  return withAgentRunLifecycleGeneration(lifecycleGeneration, () =>
    runEmbeddedAgentInternal({
      ...paramsInput,
      config,
      lifecycleGeneration,
    }),
  );
}

async function runEmbeddedAgentInternal(
  paramsInput: RunEmbeddedAgentParams,
): Promise<EmbeddedAgentRunResult> {
  const paramsBase = applyAgentRunSessionTargetIdentity(paramsInput);
  let lifecycleGeneration = paramsBase.lifecycleGeneration!;
  const queuedLifecycleGeneration = getAgentEventLifecycleGeneration();
  // Resolve sessionKey early so all downstream consumers (hooks, LCM, compaction)
  // receive a non-null key even when callers omit it. See #60552.
  const effectiveSessionKey = backfillSessionKey({
    config: paramsBase.config,
    sessionId: paramsBase.sessionId,
    sessionKey: paramsBase.sessionKey,
    agentId: paramsBase.agentId,
  });
  assertAgentHarnessRunAdmission({ ...paramsBase, sessionKey: effectiveSessionKey });
  const runSessionTarget = await resolveAgentRunSessionTarget({
    ...paramsBase,
    sessionKey: effectiveSessionKey,
  });
  let params: RunEmbeddedAgentParamsWithSessionFile = {
    ...paramsBase,
    agentId: paramsBase.agentId ?? runSessionTarget.agentId,
    sessionId: runSessionTarget.sessionId,
    sessionKey: normalizeOptionalString(effectiveSessionKey ?? runSessionTarget.sessionKey),
    sessionFile: runSessionTarget.sessionFile,
  };
  const sessionLane = resolveSessionLane(params.sessionKey?.trim() || params.sessionId);
  const globalLane = resolveGlobalLane(params.lane);
  // Outer fallback attempts defer session suspension only while another
  // candidate remains. Direct and final-candidate runs suspend normally.
  const failureSuspension = resolveSessionSuspensionTarget();
  const suspendForFailure = (suspensionParams: Omit<SessionSuspensionParams, "laneId">) => {
    const suspension = { ...suspensionParams, laneId: globalLane };
    if (failureSuspension.mode === "defer") {
      failureSuspension.defer(suspension);
      return;
    }
    void suspendSession(suspension);
  };
  const sessionQueuePriority = resolveEmbeddedRunSessionQueuePriority(params.trigger);
  const laneTaskTimeoutMs = resolveEmbeddedRunLaneTimeoutMs(params.timeoutMs);
  const laneTaskAbortController = new AbortController();
  const laneTaskReleaseController = new AbortController();
  let laneTaskProgressAtMs = Date.now();
  const noteLaneTaskProgress = () => {
    laneTaskProgressAtMs = Date.now();
  };
  const throwIfAborted = () => {
    if (!params.abortSignal?.aborted) {
      return;
    }
    const reason = params.abortSignal.reason;
    if (reason instanceof Error) {
      throw reason;
    }
    const abortErr =
      reason !== undefined
        ? new Error("Operation aborted", { cause: reason })
        : new Error("Operation aborted");
    abortErr.name = "AbortError";
    throw abortErr;
  };
  const withLaneTimeout = (opts?: CommandQueueEnqueueOptions) =>
    withEmbeddedRunLaneTimeout(
      {
        ...opts,
        taskTimeoutProgressAtMs: () => laneTaskProgressAtMs,
        taskTimeoutAbortSignal: laneTaskAbortController.signal,
        taskTimeoutAbortGraceMs: EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS,
        taskTimeoutReleaseSignal: laneTaskReleaseController.signal,
      },
      laneTaskTimeoutMs,
    );
  const withRunLaneWait = (opts?: CommandQueueEnqueueOptions) => {
    if (!opts?.onWait && !params.onLaneWait) {
      return opts;
    }
    return {
      ...opts,
      onWait: (waitMs, queuedAhead) => {
        opts?.onWait?.(waitMs, queuedAhead);
        params.onLaneWait?.({ waitMs, queuedAhead, waiting: true });
      },
    } satisfies CommandQueueEnqueueOptions;
  };
  const noteLaneWaitIfBusy = (lane: string) => {
    if (!params.onLaneWait) {
      return;
    }
    const snapshot = getCommandLaneSnapshot(lane);
    if (snapshot.queuedCount > 0 || snapshot.activeCount >= snapshot.maxConcurrent) {
      params.onLaneWait({
        waitMs: 0,
        queuedAhead: snapshot.queuedCount + snapshot.activeCount,
        waiting: true,
      });
    }
  };
  const enqueueGlobal = <T>(task: () => Promise<T>, opts?: CommandQueueEnqueueOptions) => {
    const globalOpts: CommandQueueEnqueueOptions = {
      ...opts,
      priority: sessionQueuePriority,
    };
    const taskWithCurrentLifecycle = () => {
      params.onLaneWait?.({ waitMs: 0, queuedAhead: 0, waiting: false });
      throwIfAborted();
      const currentLifecycleGeneration = getAgentEventLifecycleGeneration();
      const existingContext = getAgentRunContext(params.runId);
      if (lifecycleGeneration !== currentLifecycleGeneration) {
        const wasQueuedBeforeRotation = queuedLifecycleGeneration === lifecycleGeneration;
        const canResumeAcrossRotation = sessionQueuePriority === "foreground";
        const newerSameIdExecutionOwnsContext =
          existingContext?.lifecycleGeneration === currentLifecycleGeneration;
        if (
          !wasQueuedBeforeRotation ||
          !canResumeAcrossRotation ||
          newerSameIdExecutionOwnsContext
        ) {
          assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
        }
        lifecycleGeneration = currentLifecycleGeneration;
        params = { ...params, lifecycleGeneration };
      }
      // Queue waits can outlive the durable harness binding that admitted a run.
      // Recheck only after lifecycle admission, before any run context or hook can execute.
      assertAgentHarnessRunAdmission(params);
      claimAgentRunContext(params.runId, {
        ...existingContext,
        sessionKey: params.sessionKey ?? existingContext?.sessionKey,
        sessionId: params.sessionId ?? existingContext?.sessionId,
        lifecycleGeneration,
      });
      return withAgentRunLifecycleGeneration(lifecycleGeneration, task);
    };
    if (params.enqueue) {
      return params.enqueue(taskWithCurrentLifecycle, withLaneTimeout(withRunLaneWait(globalOpts)));
    }
    // #1057: a subagent continuation is routed onto its own session lane, so the
    // global lane resolves to that same session lane. Re-enqueuing it through the
    // global path here (already inside the enqueueSession wrapper for that lane)
    // would self-deadlock; run it directly instead.
    if (globalLane === sessionLane) {
      return taskWithCurrentLifecycle();
    }
    noteLaneWaitIfBusy(globalLane);
    return enqueueCommandInLane(
      globalLane,
      taskWithCurrentLifecycle,
      withLaneTimeout(withRunLaneWait(globalOpts)),
    );
  };
  const enqueueSession = <T>(task: () => Promise<T>, opts?: CommandQueueEnqueueOptions) => {
    const sessionOpts: CommandQueueEnqueueOptions = { ...opts, priority: sessionQueuePriority };
    const taskWithLaneAdmission = () => {
      params.onLaneWait?.({ waitMs: 0, queuedAhead: 0, waiting: false });
      return task();
    };
    if (params.enqueue) {
      return params.enqueue(taskWithLaneAdmission, withRunLaneWait(sessionOpts));
    }
    noteLaneWaitIfBusy(sessionLane);
    return enqueueCommandInLane(sessionLane, taskWithLaneAdmission, withRunLaneWait(sessionOpts));
  };
  const channelHint = params.messageChannel ?? params.messageProvider;
  const resolvedToolResultFormat =
    params.toolResultFormat ??
    (channelHint
      ? isMarkdownCapableMessageChannel(channelHint)
        ? "markdown"
        : "plain"
      : "markdown");
  const isProbeSession = params.sessionId?.startsWith("probe-") ?? false;

  throwIfAborted();

  return enqueueSession(async () => {
    throwIfAborted();
    if (params.sessionKey) {
      resetContinueDelegateTurnBudget(params.sessionKey);
    }
    // Same-session reads below must see any prior deferred transcript rewrite.
    // Checkpoint before the global lane so unrelated sessions can still start
    // while this session waits on its own maintenance lane.
    await waitForDeferredTurnMaintenanceForSession(params.sessionKey);
    throwIfAborted();
    return enqueueGlobal(async () => {
      throwIfAborted();
      const started = Date.now();
      const fastModeStarted = params.fastModeStartedAtMs ?? started;
      const fastModeAutoOnSeconds =
        params.fastModeAutoOnSeconds ?? DEFAULT_FAST_MODE_AUTO_ON_SECONDS;
      const fastModeAutoProgressState: FastModeAutoProgressState =
        params.fastModeAutoProgressState ?? {
          offAnnounced: false,
          resetAnnounced: false,
        };
      const startupStages = createEmbeddedRunStageTracker();
      let startupStagesEmitted = false;
      const notifyExecutionPhase = (
        phase: Parameters<NonNullable<RunEmbeddedAgentParams["onExecutionPhase"]>>[0]["phase"],
        extra?: Omit<
          Parameters<NonNullable<RunEmbeddedAgentParams["onExecutionPhase"]>>[0],
          "phase"
        >,
      ) => {
        noteLaneTaskProgress();
        params.onExecutionPhase?.({ phase, ...extra });
      };
      const notifyRunProgress = (
        info: Parameters<NonNullable<RunEmbeddedAgentParams["onRunProgress"]>>[0],
      ) => {
        noteLaneTaskProgress();
        params.onRunProgress?.(info);
      };
      const emitFastModeAutoProgress = async (payload: {
        enabled: boolean;
        elapsedSeconds: number;
        fastAutoOnSeconds?: number;
      }) => {
        const summary = formatFastModeAutoProgressText(payload);
        try {
          emitAgentItemEvent({
            runId: params.runId,
            ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
            data: {
              itemId: `fast-mode-auto:${payload.enabled ? "on" : "off"}`,
              kind: "status",
              title: "Fast",
              phase: "update",
              status: "running",
              summary,
            },
          });
        } catch (error) {
          log.debug(
            `embedded run fast mode auto global event failed: ${formatErrorMessage(error)}`,
          );
        }
        try {
          await params.onAgentEvent?.({
            stream: "item",
            data: {
              kind: "status",
              title: "Fast",
              phase: "update",
              summary,
            },
            ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
          });
        } catch (error) {
          log.debug(`embedded run fast mode auto event failed: ${formatErrorMessage(error)}`);
        }
        try {
          await params.onToolResult?.({
            text: summary,
            channelData: { openclawProgressKind: FAST_MODE_AUTO_PROGRESS_KIND },
          });
        } catch (error) {
          log.debug(`embedded run fast mode auto progress failed: ${formatErrorMessage(error)}`);
        }
      };
      const maybeAnnounceFastModeAutoOff = async () => {
        if (params.fastMode !== "auto" || fastModeAutoProgressState.offAnnounced) {
          return;
        }
        const next = resolveFastModeForElapsed({
          mode: "auto",
          startedAtMs: fastModeStarted,
          fastAutoOnSeconds: fastModeAutoOnSeconds,
        });
        if (next.enabled) {
          return;
        }
        fastModeAutoProgressState.offAnnounced = true;
        await emitFastModeAutoProgress(next);
      };
      const notifyToolResult = async (payload: ReplyPayload) => {
        await params.onToolResult?.(payload);
      };
      const notifyAgentEvent = async (
        event: Parameters<NonNullable<RunEmbeddedAgentParams["onAgentEvent"]>>[0],
      ) => {
        await params.onAgentEvent?.(event);
      };
      const resolveAttemptFastMode = (): boolean | undefined => {
        const resolved = resolveFastModeForElapsed({
          mode: params.fastMode,
          startedAtMs: fastModeStarted,
          fastAutoOnSeconds: fastModeAutoOnSeconds,
        });
        return resolved.mode === undefined ? undefined : resolved.enabled;
      };
      const resolveAttemptFastModeParam = (): EmbeddedRunFastModeParam | undefined => {
        if (params.fastMode === "auto") {
          return resolveAttemptFastMode;
        }
        return resolveAttemptFastMode();
      };
      const maybeEmitFastModeAutoReset = async () => {
        if (
          params.fastMode !== "auto" ||
          !fastModeAutoProgressState.offAnnounced ||
          fastModeAutoProgressState.resetAnnounced
        ) {
          return;
        }
        fastModeAutoProgressState.resetAnnounced = true;
        await emitFastModeAutoProgress({
          enabled: true,
          elapsedSeconds: 0,
          fastAutoOnSeconds: fastModeAutoOnSeconds,
        });
      };
      const maybeEmitFastModeAutoResetBestEffort = async () => {
        try {
          await maybeEmitFastModeAutoReset();
        } catch (error) {
          log.warn(
            `embedded run fast mode auto reset progress failed: ${formatErrorMessage(error)}`,
          );
        }
      };
      const emitStartupStageSummary = (phase: string) => {
        const summary = startupStages.snapshot();
        const shouldWarn = shouldWarnEmbeddedRunStageSummary(summary);
        if (!shouldWarn && !log.isEnabled("trace")) {
          return;
        }
        const message = formatEmbeddedRunStageSummary(
          `[trace:embedded-run] startup stages: runId=${params.runId} sessionId=${params.sessionId} phase=${phase}`,
          summary,
        );
        if (shouldWarn) {
          log.warn(message);
        } else {
          log.trace(message);
        }
      };
      params.onExecutionStarted?.({ lifecycleGeneration });
      notifyExecutionPhase("runner_entered");
      const workspaceResolution = resolveRunWorkspaceDir({
        workspaceDir: params.workspaceDir,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        config: params.config,
      });
      const resolvedWorkspace = workspaceResolution.workspaceDir;
      const canonicalWorkspace = resolveUserPath(
        resolveAgentWorkspaceDir(params.config ?? {}, workspaceResolution.agentId),
      );
      const isCanonicalWorkspace = canonicalWorkspace === resolvedWorkspace;
      const redactedSessionId = redactRunIdentifier(params.sessionId);
      const redactedSessionKey = redactRunIdentifier(params.sessionKey);
      const redactedWorkspace = redactRunIdentifier(resolvedWorkspace);
      if (workspaceResolution.usedFallback) {
        log.warn(
          `[workspace-fallback] caller=runEmbeddedAgent reason=${workspaceResolution.fallbackReason} run=${params.runId} session=${redactedSessionId} sessionKey=${redactedSessionKey} agent=${workspaceResolution.agentId} workspace=${redactedWorkspace}`,
        );
      }
      startupStages.mark("workspace");
      notifyExecutionPhase("workspace");
      ensureRuntimePluginsLoaded({
        config: params.config,
        workspaceDir: resolvedWorkspace,
        allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
      });
      startupStages.mark("runtime-plugins");
      notifyExecutionPhase("runtime_plugins");

      let { provider, modelId } = resolveInitialEmbeddedRunModel({
        config: params.config,
        agentId: workspaceResolution.agentId,
        provider: params.provider,
        model: params.model,
      });
      const agentDir =
        params.agentDir ?? resolveAgentDir(params.config ?? {}, workspaceResolution.agentId);
      const normalizedSessionKey = params.sessionKey?.trim();
      const fallbackConfigured = hasEmbeddedRunConfiguredModelFallbacks({
        cfg: params.config,
        agentId: params.agentId,
        sessionKey: normalizedSessionKey,
        modelFallbacksOverride: params.modelFallbacksOverride,
      });
      const resolvedSessionKey = normalizedSessionKey;
      const hookRunner = getGlobalHookRunner();
      const hookCtx = {
        runId: params.runId,
        jobId: params.jobId,
        agentId: workspaceResolution.agentId,
        sessionKey: resolvedSessionKey,
        sessionId: params.sessionId,
        workspaceDir: resolvedWorkspace,
        modelProviderId: provider,
        modelId,
        trigger: params.trigger,
        ...buildAgentHookContextChannelFields(params),
      };
      if (params.trigger === "cron" && hookRunner?.hasHooks("before_agent_reply")) {
        notifyExecutionPhase("before_agent_reply", { provider, model: modelId });
        const hookResult = await hookRunner.runBeforeAgentReply(
          { cleanedBody: params.prompt },
          hookCtx,
        );
        if (hookResult?.handled) {
          return {
            payloads: buildHandledReplyPayloads(hookResult.reply),
            meta: {
              durationMs: Date.now() - started,
              agentMeta: {
                sessionId: params.sessionId,
                provider,
                model: modelId,
              },
              finalAssistantVisibleText: hookResult.reply?.text ?? SILENT_REPLY_TOKEN,
              finalAssistantRawText: hookResult.reply?.text ?? SILENT_REPLY_TOKEN,
            },
          };
        }
        notifyExecutionPhase("runtime_plugins", { provider, model: modelId });
      }

      const hookSelection = await resolveHookModelSelection({
        prompt: params.prompt,
        attachments: buildBeforeModelResolveAttachments(params.images),
        provider,
        modelId,
        hookRunner,
        hookContext: hookCtx,
      });
      const modelSelectionChangedByHook =
        hookSelection.provider !== provider || hookSelection.modelId !== modelId;
      provider = hookSelection.provider;
      modelId = hookSelection.modelId;
      const requestedModelId = modelId;
      const beforeAgentStartResult = hookSelection.beforeAgentStartResult;
      startupStages.mark("hooks");
      await ensureSelectedAgentHarnessPlugin({
        provider,
        modelId,
        config: params.config,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        agentHarnessId: params.agentHarnessId,
        agentHarnessRuntimeOverride: params.agentHarnessRuntimeOverride,
        workspaceDir: resolvedWorkspace,
      });
      const agentHarness = selectAgentHarness({
        provider,
        modelId,
        config: params.config,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        agentHarnessId: params.agentHarnessId,
        agentHarnessRuntimeOverride: params.agentHarnessRuntimeOverride,
      });
      const pluginHarnessOwnsTransport = agentHarness.id !== "openclaw";
      const nativeModelOwnedHarnessId = resolveNativeModelOwnedHarnessId({
        agentHarnessId: params.agentHarnessId,
        modelSelectionLocked: params.modelSelectionLocked,
        selectedHarnessId: agentHarness.id,
      });
      const nativeModelOwned = nativeModelOwnedHarnessId !== undefined;
      const modelConfigProvider = provider;
      let resolvedModelProvider = provider;
      let firstModelResolution: Awaited<ReturnType<typeof resolveModelAsync>> | undefined;
      let modelResolution: Awaited<ReturnType<typeof resolveModelAsync>> | undefined;
      if (nativeModelOwned) {
        modelResolution = {
          model: createNativeModelOwnedRuntimeModel({ provider, modelId }),
          ...createEmptyAgentDiscoveryStores(),
        };
      } else {
        const selectedRuntimeProvider = resolveSelectedOpenAIRuntimeProvider({
          provider,
          harnessRuntime: agentHarness.id,
          agentHarnessId: agentHarness.id,
          authProfileProvider: params.authProfileId?.split(":", 1)[0],
          authProfileId: params.authProfileId,
          config: params.config,
          workspaceDir: resolvedWorkspace,
        });
        const modelResolutionProviders =
          selectedRuntimeProvider !== provider ? [selectedRuntimeProvider, provider] : [provider];
        for (const candidateProvider of modelResolutionProviders) {
          const candidateResolution = await resolveModelAsync(
            candidateProvider,
            modelId,
            agentDir,
            params.config,
            {
              // Plugin dynamic model hooks can resolve explicit model refs without
              // first generating OpenClaw models.json. This keeps one-shot model runs from
              // blocking on unrelated provider discovery.
              skipAgentDiscovery: true,
              allowBundledStaticCatalogFallback: pluginHarnessOwnsTransport,
              preferBundledStaticCatalogTransport: pluginHarnessOwnsTransport,
              workspaceDir: resolvedWorkspace,
              authProfileId: params.authProfileId,
            },
          );
          firstModelResolution ??= candidateResolution;
          if (candidateResolution.model) {
            resolvedModelProvider = candidateProvider;
            modelResolution = candidateResolution;
            break;
          }
        }
        if (!modelResolution && pluginHarnessOwnsTransport) {
          modelResolution ??= firstModelResolution;
        }
        if (!modelResolution) {
          await ensureOpenClawModelsJson(params.config, agentDir, {
            workspaceDir: resolvedWorkspace,
          });
          for (const candidateProvider of modelResolutionProviders) {
            const candidateResolution = await resolveModelAsync(
              candidateProvider,
              modelId,
              agentDir,
              params.config,
              {
                workspaceDir: resolvedWorkspace,
                authProfileId: params.authProfileId,
                // Enable bundled static catalog fallback so plugin-provided
                // models that are not discoverable via agent model discovery
                // can still be resolved from the static catalog.
                allowBundledStaticCatalogFallback: true,
              },
            );
            firstModelResolution ??= candidateResolution;
            if (candidateResolution.model) {
              resolvedModelProvider = candidateProvider;
              modelResolution = candidateResolution;
              break;
            }
          }
        }
        modelResolution ??= firstModelResolution;
      }
      if (!modelResolution) {
        throw new FailoverError(`Unknown model: ${provider}/${modelId}`, {
          reason: "model_not_found",
          provider,
          model: modelId,
          sessionId: params.sessionId,
          lane: globalLane,
        });
      }
      provider = resolvedModelProvider;
      const { model, error, authStorage, modelRegistry } = modelResolution;
      if (!model) {
        throw new FailoverError(error ?? `Unknown model: ${provider}/${modelId}`, {
          reason: "model_not_found",
          provider,
          model: modelId,
          sessionId: params.sessionId,
          lane: globalLane,
        });
      }
      let runtimeModel = model;

      const resolvedRuntimeModel = resolveEmbeddedRuntimeModelPolicy({
        cfg: params.config,
        provider,
        contextConfigProvider: resolveContextConfigProviderForRuntime({
          provider: modelConfigProvider,
          runtimeId: agentHarness.id,
          config: params.config,
        }),
        modelId,
        runtimeModel,
        nativeModelOwned,
      });
      const contextTokenBudget = resolvedRuntimeModel.contextTokenBudget;
      const contextWindowInfo = resolvedRuntimeModel.contextWindowInfo;
      const outerContextTokenMeta =
        contextTokenBudget === undefined ? {} : { contextTokens: contextTokenBudget };
      let effectiveModel = resolvedRuntimeModel.effectiveModel;
      startupStages.mark("model-resolution");
      notifyExecutionPhase("model_resolution", { provider, model: modelId });

      const pluginHarnessOwnsAuthBootstrap =
        pluginHarnessOwnsTransport && agentHarness.authBootstrap === "harness";
      const pluginHarnessNeedsOpenClawAuthBootstrap =
        pluginHarnessOwnsTransport &&
        !pluginHarnessOwnsAuthBootstrap &&
        provider === OPENAI_PROVIDER_ID &&
        effectiveModel.api === "openai-chatgpt-responses";
      const openClawNativeCodexResponsesNeedsAuthBootstrap =
        !pluginHarnessOwnsTransport &&
        provider === OPENAI_PROVIDER_ID &&
        effectiveModel.api === "openai-chatgpt-responses";
      let piExternalCliAuthScope = pluginHarnessOwnsTransport
        ? { ignoreAutoPreferredProfile: false }
        : openClawNativeCodexResponsesNeedsAuthBootstrap
          ? {
              providerIds: [OPENAI_PROVIDER_ID],
              ignoreAutoPreferredProfile: false,
            }
          : resolveExternalCliAuthOverlayScopeFromSelection({
              provider,
              cfg: params.config,
              agentId: params.agentId,
              modelId,
              workspaceDir: resolvedWorkspace,
              userLockedAuthProfileId:
                params.authProfileIdSource === "user" ? params.authProfileId : undefined,
            });
      let noExternalAuthStore: AuthProfileStore | undefined;
      if (
        !pluginHarnessOwnsTransport &&
        !pluginHarnessNeedsOpenClawAuthBootstrap &&
        !piExternalCliAuthScope.providerIds
      ) {
        noExternalAuthStore = ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
          allowKeychainPrompt: false,
        });
        piExternalCliAuthScope = resolveExternalCliAuthOverlayScopeFromSelection({
          provider,
          cfg: params.config,
          agentId: params.agentId,
          modelId,
          workspaceDir: resolvedWorkspace,
          store: noExternalAuthStore,
          userLockedAuthProfileId:
            params.authProfileIdSource === "user" ? params.authProfileId : undefined,
        });
      }
      const authStore =
        pluginHarnessOwnsTransport && !pluginHarnessNeedsOpenClawAuthBootstrap
          ? createEmptyAuthProfileStore()
          : pluginHarnessNeedsOpenClawAuthBootstrap
            ? ensureAuthProfileStore(agentDir, {
                externalCliProviderIds: [OPENAI_PROVIDER_ID],
                allowKeychainPrompt: false,
              })
            : piExternalCliAuthScope.providerIds
              ? ensureAuthProfileStore(agentDir, {
                  externalCliProviderIds: piExternalCliAuthScope.providerIds,
                  allowKeychainPrompt: false,
                })
              : (noExternalAuthStore ??
                ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
                  allowKeychainPrompt: false,
                }));
      const attemptAuthProfileStore =
        pluginHarnessOwnsTransport && !pluginHarnessNeedsOpenClawAuthBootstrap
          ? ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
              allowKeychainPrompt: false,
            })
          : authStore;
      const requestedProfileId = params.authProfileId?.trim();
      const requestedProfileIsUserLocked = params.authProfileIdSource === "user";
      const isForwardablePluginHarnessAuthProfile = (
        profileId: string | undefined,
      ): profileId is string => {
        if (!pluginHarnessOwnsTransport || !profileId) {
          return false;
        }
        const credential = attemptAuthProfileStore.profiles?.[profileId];
        const runtimeAuthPlan = buildAgentRuntimeAuthPlan({
          provider,
          authProfileProvider: credential?.provider ?? profileId.split(":", 1)[0],
          authProfileMode: credential?.type,
          sessionAuthProfileId: profileId,
          config: params.config,
          workspaceDir: resolvedWorkspace,
          harnessId: agentHarness.id,
          harnessRuntime: agentHarness.id,
          allowHarnessAuthProfileForwarding: true,
        });
        return runtimeAuthPlan.forwardedAuthProfileId === profileId;
      };
      const resolvePluginHarnessProfileOrder = (): string[] => {
        if (requestedProfileId && requestedProfileIsUserLocked) {
          return isForwardablePluginHarnessAuthProfile(requestedProfileId)
            ? [requestedProfileId]
            : [];
        }
        if (!pluginHarnessOwnsTransport) {
          return [];
        }
        const runtimeAuthPlan = buildAgentRuntimeAuthPlan({
          provider,
          config: params.config,
          workspaceDir: resolvedWorkspace,
          harnessId: agentHarness.id,
          harnessRuntime: agentHarness.id,
          allowHarnessAuthProfileForwarding: true,
        });
        const harnessAuthProvider = runtimeAuthPlan.harnessAuthProvider;
        if (!harnessAuthProvider) {
          return [];
        }
        const resolvedOrder = resolveAuthProfileOrder({
          cfg: params.config,
          store: attemptAuthProfileStore,
          provider: harnessAuthProvider,
        }).filter(isForwardablePluginHarnessAuthProfile);
        if (resolvedOrder.length > 0) {
          return resolvedOrder;
        }
        if (requestedProfileId && isForwardablePluginHarnessAuthProfile(requestedProfileId)) {
          return [requestedProfileId];
        }
        return [];
      };
      const pluginHarnessProfileOrder = pluginHarnessOwnsTransport
        ? resolvePluginHarnessProfileOrder()
        : [];
      const resolvePluginHarnessPreferredProfileId = (): string | undefined =>
        pluginHarnessProfileOrder[0];
      const preferredProfileId = pluginHarnessOwnsTransport
        ? resolvePluginHarnessPreferredProfileId()
        : piExternalCliAuthScope.ignoreAutoPreferredProfile && !requestedProfileIsUserLocked
          ? undefined
          : requestedProfileId;
      let lockedProfileId = requestedProfileIsUserLocked ? preferredProfileId : undefined;
      if (lockedProfileId) {
        if (pluginHarnessOwnsTransport) {
          if (!isForwardablePluginHarnessAuthProfile(lockedProfileId)) {
            lockedProfileId = undefined;
          }
        } else {
          const lockedProfile = authStore.profiles[lockedProfileId];
          const lockedProfileProvider = lockedProfile
            ? resolveProviderIdForAuth(lockedProfile.provider, {
                config: params.config,
                workspaceDir: resolvedWorkspace,
              })
            : undefined;
          const runProvider = resolveProviderIdForAuth(provider, {
            config: params.config,
            workspaceDir: resolvedWorkspace,
          });
          if (!lockedProfile || !lockedProfileProvider || lockedProfileProvider !== runProvider) {
            lockedProfileId = undefined;
          }
        }
      }
      const forwardedPluginHarnessProfileId =
        pluginHarnessOwnsTransport &&
        !lockedProfileId &&
        isForwardablePluginHarnessAuthProfile(preferredProfileId)
          ? preferredProfileId
          : undefined;
      if (lockedProfileId && !pluginHarnessOwnsTransport) {
        const eligibility = resolveAuthProfileEligibility({
          cfg: params.config,
          store: authStore,
          provider,
          profileId: lockedProfileId,
        });
        if (!eligibility.eligible) {
          throw new Error(`Auth profile "${lockedProfileId}" is not configured for ${provider}.`);
        }
      }
      const profileOrder = shouldPreferExplicitConfigApiKeyAuth(params.config, provider)
        ? []
        : [
            ...new Set(
              listOpenAIAuthProfileProvidersForAgentRuntime({
                provider,
                harnessRuntime: agentHarness.id,
                agentHarnessId: agentHarness.id,
                config: params.config,
              }).flatMap((authProvider) =>
                resolveAuthProfileOrder({
                  cfg: params.config,
                  store: authStore,
                  provider: authProvider,
                  preferredProfile: preferredProfileId,
                }),
              ),
            ),
          ];
      const providerPreferredProfileId = lockedProfileId
        ? undefined
        : resolveProviderAuthProfileId({
            provider,
            config: params.config,
            workspaceDir: resolvedWorkspace,
            context: {
              config: params.config,
              agentDir,
              workspaceDir: resolvedWorkspace,
              provider,
              modelId,
              preferredProfileId,
              lockedProfileId,
              profileOrder,
              authStore,
            },
          });
      const providerOrderedProfiles =
        providerPreferredProfileId && profileOrder.includes(providerPreferredProfileId)
          ? [
              providerPreferredProfileId,
              ...profileOrder.filter((profileId) => profileId !== providerPreferredProfileId),
            ]
          : profileOrder;
      const profileCandidates = pluginHarnessOwnsTransport
        ? lockedProfileId
          ? [lockedProfileId]
          : pluginHarnessProfileOrder.length > 0
            ? pluginHarnessProfileOrder
            : [undefined]
        : lockedProfileId
          ? [lockedProfileId]
          : providerOrderedProfiles.length > 0
            ? providerOrderedProfiles
            : [undefined];
      const pluginHarnessForwardedProfileCandidates = pluginHarnessOwnsTransport
        ? profileCandidates.filter(isForwardablePluginHarnessAuthProfile)
        : [];
      const profileFailureStore = pluginHarnessOwnsTransport ? attemptAuthProfileStore : authStore;
      let profileIndex = 0;
      const traceAttempts: TraceAttempt[] = [];
      const traceAttemptUsesFallback = (attempt: TraceAttempt): boolean =>
        attempt.result === "rotate_profile" || attempt.result === "fallback_model";
      const resolveRuntimeFallbackReason = (): string | null => {
        const fallbackAttempt = traceAttempts.findLast(
          (attempt) => attempt.result === "fallback_model" && typeof attempt.reason === "string",
        );
        return fallbackAttempt?.reason ?? lastRetryFailoverReason ?? null;
      };
      const buildEmbeddedContextEngineRuntimeSettings = (settingsParams: {
        tokenBudget?: number | null;
        maxOutputTokens?: number | null;
        degradedReason?: string | null;
      }) => {
        const fallbackReason = resolveRuntimeFallbackReason();
        return buildContextEngineRuntimeSettings({
          contextEngineHost: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
          provider,
          requestedModel: requestedModelId,
          resolvedModel: modelId,
          selectedContextEngineId: contextEngine.info.id,
          contextEngineSelectionSource:
            contextEngine.info.id === "legacy" ? "default" : "configured",
          promptTokenBudget: settingsParams.tokenBudget,
          maxOutputTokens: settingsParams.maxOutputTokens,
          fallbackReason,
          degradedReason: settingsParams.degradedReason,
        });
      };

      const requestedThinkLevel = resolveInitialThinkLevel({
        requested: params.thinkLevel,
        config: params.config,
        provider,
        modelId,
        model: effectiveModel,
      });
      // Hooks can replace the model after outer selection. Revalidate here so the
      // final model/runtime never receives an unsupported thinking level.
      const initialThinkLevel = modelSelectionChangedByHook
        ? (resolveCandidateThinkingLevel({
            cfg: params.config,
            provider,
            modelId,
            level: requestedThinkLevel,
            catalog: [
              {
                provider,
                id: modelId,
                api: effectiveModel.api,
                reasoning: effectiveModel.reasoning,
                params: effectiveModel.params,
                compat: effectiveModel.compat,
              },
            ],
            agentId: params.agentId,
            sessionKey: params.sessionKey,
            agentRuntime: agentHarness.id,
          }) ?? requestedThinkLevel)
        : requestedThinkLevel;
      let thinkLevel = initialThinkLevel;
      const attemptedThinking = new Set<ThinkLevel>();
      let apiKeyInfo: ApiKeyInfo | null = null;
      let lastProfileId: string | undefined;
      let runtimeAuthState: RuntimeAuthState | null = null;
      let runtimeAuthRefreshCancelled = false;
      const {
        advanceAuthProfile,
        initializeAuthProfile,
        maybeRefreshRuntimeAuthForAuthError,
        stopRuntimeAuthRefreshTimer,
      } = createEmbeddedRunAuthController({
        config: params.config,
        agentDir,
        workspaceDir: resolvedWorkspace,
        authStore,
        authStorage,
        profileCandidates,
        lockedProfileId,
        initialThinkLevel,
        attemptedThinking,
        fallbackConfigured,
        allowTransientCooldownProbe: params.allowTransientCooldownProbe === true,
        getProvider: () => provider,
        getModelId: () => modelId,
        getRuntimeModel: () => runtimeModel,
        setRuntimeModel: (next) => {
          runtimeModel = next;
        },
        getEffectiveModel: () => effectiveModel,
        setEffectiveModel: (next) => {
          effectiveModel = next;
        },
        getApiKeyInfo: () => apiKeyInfo,
        setApiKeyInfo: (next) => {
          apiKeyInfo = next;
        },
        getLastProfileId: () => lastProfileId,
        setLastProfileId: (next) => {
          lastProfileId = next;
        },
        getRuntimeAuthState: () => runtimeAuthState,
        setRuntimeAuthState: (next) => {
          runtimeAuthState = next;
        },
        getRuntimeAuthRefreshCancelled: () => runtimeAuthRefreshCancelled,
        setRuntimeAuthRefreshCancelled: (next) => {
          runtimeAuthRefreshCancelled = next;
        },
        getProfileIndex: () => profileIndex,
        setProfileIndex: (next) => {
          profileIndex = next;
        },
        setThinkLevel: (next) => {
          thinkLevel = next;
        },
        log,
      });
      const advancePluginHarnessAuthProfile = async (): Promise<boolean> => {
        if (!pluginHarnessOwnsTransport || lockedProfileId) {
          return false;
        }
        let nextIndex = profileIndex + 1;
        while (nextIndex < profileCandidates.length) {
          const candidate = profileCandidates[nextIndex];
          if (!candidate || !isForwardablePluginHarnessAuthProfile(candidate)) {
            nextIndex += 1;
            continue;
          }
          if (isProfileInCooldown(attemptAuthProfileStore, candidate, undefined, modelId)) {
            nextIndex += 1;
            continue;
          }
          profileIndex = nextIndex;
          lastProfileId = candidate;
          thinkLevel = initialThinkLevel;
          attemptedThinking.clear();
          return true;
        }
        return false;
      };
      const advanceAttemptAuthProfile =
        pluginHarnessOwnsTransport && !pluginHarnessNeedsOpenClawAuthBootstrap
          ? advancePluginHarnessAuthProfile
          : advanceAuthProfile;

      // Plugin harnesses own their model transport/auth. Running OpenClaw's generic
      // auth bootstrap here can turn synthetic provider markers into real
      // vendor-token refresh attempts before the plugin gets control.
      if (!pluginHarnessOwnsTransport || pluginHarnessNeedsOpenClawAuthBootstrap) {
        await initializeAuthProfile();
      } else if (lockedProfileId) {
        lastProfileId = lockedProfileId;
      } else if (forwardedPluginHarnessProfileId) {
        lastProfileId = forwardedPluginHarnessProfileId;
      }
      startupStages.mark("auth");
      notifyExecutionPhase("auth", { provider, model: modelId });
      const runAttemptAuthProfileStore = pluginHarnessOwnsTransport
        ? createScopedAuthProfileStore(
            attemptAuthProfileStore,
            pluginHarnessForwardedProfileCandidates.length > 0
              ? pluginHarnessForwardedProfileCandidates
              : lastProfileId,
          )
        : attemptAuthProfileStore;
      const harnessBuildsOpenClawTools = agentHarnessBuildsOpenClawTools(agentHarness.id);
      const { sessionAgentId } = resolveSessionAgentIds({
        sessionKey: params.sessionKey,
        config: params.config,
        agentId: params.agentId,
      });
      const strictAgenticActive = isStrictAgenticExecutionContractActive({
        config: params.config,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        provider,
        modelId,
      });
      const executionContract = strictAgenticActive ? "strict-agentic" : "default";
      const maxReasoningOnlyRetryAttempts = DEFAULT_REASONING_ONLY_RETRY_LIMIT;
      const maxEmptyResponseRetryAttempts = DEFAULT_EMPTY_RESPONSE_RETRY_LIMIT;

      const MAX_TIMEOUT_COMPACTION_ATTEMPTS = 2;
      const MAX_OVERFLOW_COMPACTION_ATTEMPTS = 3;
      const MAX_RUN_LOOP_ITERATIONS = resolveMaxRunRetryIterations(
        profileCandidates.length,
        params.config,
        sessionAgentId,
      );
      let overflowCompactionAttempts = 0;
      let toolResultTruncationAttempted = false;
      let bootstrapPromptWarningSignaturesSeen =
        params.bootstrapPromptWarningSignaturesSeen ??
        (params.bootstrapPromptWarningSignature ? [params.bootstrapPromptWarningSignature] : []);
      const usageAccumulator = createUsageAccumulator();
      let lastRunPromptUsage: ReturnType<typeof normalizeUsage> | undefined;
      let autoCompactionCount = 0;
      let lastCompactionTokensAfter: number | undefined;
      let lastContextBudgetStatus: EmbeddedAgentMeta["contextBudgetStatus"];
      let runLoopIterations = 0;
      let overloadProfileRotations = 0;
      let consecutiveSameModelRateLimitRetries = 0;
      let reasoningOnlyRetryAttempts = 0;
      let emptyResponseRetryAttempts = 0;
      let compactionContinuationRetryAttempts = 0;
      let beforeAgentFinalizeRevisionAttempts = 0;
      let sameModelIdleTimeoutRetries = 0;
      // Cost-runaway breaker for #76293. State lives at the run-loop level
      // on purpose so it survives across attempt boundaries and across
      // profile/auth retries within this embedded run (a wrapper-local
      // counter would reset on every iteration). The helper is pure and
      // unit-tested in run/idle-timeout-breaker.test.ts; the run loop just
      // feeds it the outcome of each attempt.
      const idleTimeoutBreakerState = createIdleTimeoutBreakerState();
      // Post-compaction loop guard for #77474. Armed at each compaction-success
      // site below; observed from the live tool-outcome path so it can abort
      // while the post-compaction prompt is still running.
      const resolvedLoopDetectionConfig = resolveToolLoopDetectionConfig({
        cfg: params.config,
        agentId: sessionAgentId,
      });
      const postCompactionGuard = createPostCompactionLoopGuard(
        resolvedLoopDetectionConfig?.postCompactionGuard,
        { enabled: resolvedLoopDetectionConfig?.enabled !== false },
      );
      let postCompactionAbortController: AbortController | undefined;
      let postCompactionAbortError: PostCompactionLoopPersistedError | undefined;
      const attemptTerminalToolPresentation = {
        ordinal: -1,
        value: undefined as string | undefined,
      };
      let nextToolOutcomeOrdinal = 0;
      const allocateToolOutcomeOrdinal = (): number => nextToolOutcomeOrdinal++;
      const readAttemptTerminalToolPresentation = (): string | undefined =>
        attemptTerminalToolPresentation.value;
      const observeToolOutcome = (observation: ToolOutcomeObservation): void => {
        const observationOrdinal =
          observation.toolCallOrdinal ?? attemptTerminalToolPresentation.ordinal + 1;
        if (observationOrdinal >= attemptTerminalToolPresentation.ordinal) {
          attemptTerminalToolPresentation.ordinal = observationOrdinal;
          attemptTerminalToolPresentation.value = observation.terminalPresentation;
        }
        if (observation.presentationOnly) {
          return;
        }
        const verdict = postCompactionGuard.observe(observation);
        if (verdict.shouldAbort) {
          postCompactionAbortError ??= PostCompactionLoopPersistedError.fromVerdict(verdict);
          laneTaskAbortController.abort(postCompactionAbortError);
          postCompactionAbortController?.abort(postCompactionAbortError);
        }
      };
      let lastRetryFailoverReason: FailoverReason | null = null;
      let reasoningOnlyRetryInstruction: string | null = null;
      let emptyResponseRetryInstruction: string | null = null;
      let compactionContinuationRetryInstruction: string | null = null;
      let nextAttemptPromptOverride: string | null = null;
      let rateLimitProfileRotations = 0;
      let timeoutCompactionAttempts = 0;
      let codexAppServerRecoveryRetries = 0;
      // Silent-error retry: non-strict-agentic models (e.g. ollama/glm-5.1) can
      // end a turn with stopReason="error" + zero output tokens, producing no
      // user-visible text. This is an orthogonal, model-agnostic resubmission
      // for errored turns; stopReason="stop" empty zero-token turns use the
      // visible-answer retry instruction instead.
      const MAX_EMPTY_ERROR_RETRIES = 3;
      let emptyErrorRetries = 0;
      const MAX_MISSING_ASSISTANT_RETRIES = 1;
      let missingAssistantRetryAttempts = 0;
      const overloadFailoverBackoffMs = resolveOverloadFailoverBackoffMs(params.config);
      const overloadProfileRotationLimit = resolveOverloadProfileRotationLimit(params.config);
      const rateLimitProfileRotationLimit = resolveRateLimitProfileRotationLimit(params.config);
      let activeSessionId = params.sessionId;
      let activeSessionFile = params.sessionFile;
      const adoptActiveSessionId = (nextSessionId: string | undefined) => {
        if (!nextSessionId || nextSessionId === activeSessionId) {
          return;
        }
        activeSessionId = nextSessionId;
        // Keep every active-run owner on the rotated identity. Restart recovery
        // uses the reply registry while lifecycle persistence uses run context.
        params.replyOperation?.updateSessionId(activeSessionId);
        params.onSessionIdChanged?.(activeSessionId);
        registerAgentRunContext(params.runId, {
          sessionId: activeSessionId,
          lifecycleGeneration,
        });
      };
      let suppressNextUserMessagePersistence = params.suppressNextUserMessagePersistence ?? false;
      // The embedded agent owns JSONL persistence; this marker lets the outer retry avoid
      // replaying the same inbound channel message after overflow compaction.
      let lastPersistedCurrentMessageId: string | number | undefined;
      const onUserMessagePersisted: RunEmbeddedAgentParams["onUserMessagePersisted"] = (
        message,
      ) => {
        if (params.currentMessageId !== undefined) {
          lastPersistedCurrentMessageId = params.currentMessageId;
        }
        params.userTurnTranscriptRecorder?.markRuntimePersisted(message);
        params.onUserMessagePersisted?.(message);
      };
      const continueFromCurrentTranscript = () => {
        nextAttemptPromptOverride = MID_TURN_PRECHECK_CONTINUATION_PROMPT;
        suppressNextUserMessagePersistence = true;
      };
      const maybeEscalateRateLimitProfileFallback = (paramsLocal: {
        failoverProvider: string;
        failoverModel: string;
        logFallbackDecision: (decision: "fallback_model", extra?: { status?: number }) => void;
      }) => {
        rateLimitProfileRotations += 1;
        if (rateLimitProfileRotations <= rateLimitProfileRotationLimit || !fallbackConfigured) {
          return;
        }
        const status = resolveFailoverStatus("rate_limit");
        log.warn(
          `rate-limit profile rotation cap reached for ${sanitizeForLog(provider)}/${sanitizeForLog(modelId)} after ${rateLimitProfileRotations} rotations; escalating to model fallback`,
        );
        paramsLocal.logFallbackDecision("fallback_model", { status });
        throw new FailoverError(
          "The AI service is temporarily rate-limited. Please try again in a moment.",
          {
            reason: "rate_limit",
            provider: paramsLocal.failoverProvider,
            model: paramsLocal.failoverModel,
            profileId: lastProfileId,
            sessionId: activeSessionId,
            lane: globalLane,
            status,
          },
        );
      };
      const maybeMarkAuthProfileFailure = async (failure: {
        profileId?: string;
        reason?: AuthProfileFailureReason | null;
        config?: RunEmbeddedAgentParams["config"];
        agentDir?: RunEmbeddedAgentParams["agentDir"];
        modelId?: string;
      }) => {
        const { profileId, reason } = failure;
        if (!profileId || !reason) {
          return;
        }
        if (pluginHarnessOwnsTransport && reason === "timeout") {
          // Harness-owned transport timeouts are lifecycle failures, not
          // credential evidence. Do not poison OpenClaw auth cooldowns.
          return;
        }
        await markAuthProfileFailure({
          store: profileFailureStore,
          profileId,
          reason,
          cfg: params.config,
          agentDir,
          runId: params.runId,
          modelId: failure.modelId,
        });
      };
      const markAuthProfileSuccessAfterRun = () => {
        if (!lastProfileId) {
          return;
        }
        const successProfileId = lastProfileId;
        const safeSuccessProfileId = redactIdentifier(successProfileId, { len: 12 });
        const successProvider = resolveAuthProfileStateProvider(
          profileFailureStore,
          successProfileId,
          provider,
        );
        const successStarted = Date.now();
        void markAuthProfileSuccess({
          store: profileFailureStore,
          provider: successProvider,
          profileId: successProfileId,
          agentDir: params.agentDir,
        })
          .then(() => {
            const durationMs = Date.now() - successStarted;
            if (durationMs >= POST_RUN_AUTH_PROFILE_SUCCESS_SLOW_MS) {
              log.warn(
                `post-run auth-profile success bookkeeping completed after ${durationMs}ms: ` +
                  `runId=${params.runId} sessionId=${params.sessionId} ` +
                  `provider=${sanitizeForLog(successProvider)} profileId=${safeSuccessProfileId}`,
              );
            } else if (log.isEnabled("trace")) {
              log.trace(
                `post-run auth-profile success bookkeeping completed: ` +
                  `runId=${params.runId} sessionId=${params.sessionId} durationMs=${durationMs}`,
              );
            }
          })
          .catch((err: unknown) => {
            log.warn(
              `post-run auth-profile success bookkeeping failed: ` +
                `runId=${params.runId} sessionId=${params.sessionId} ` +
                `provider=${sanitizeForLog(successProvider)} profileId=${safeSuccessProfileId} ` +
                `error=${formatErrorMessage(err)}`,
            );
          });
      };
      const resolveRunAuthProfileFailureReason = (
        failoverReason: FailoverReason | null,
        opts?: { providerStarted?: boolean; transientRateLimit?: boolean },
      ) =>
        resolveAuthProfileFailureReason({
          failoverReason,
          providerStarted: opts?.providerStarted,
          transientRateLimit: opts?.transientRateLimit,
          policy: params.authProfileFailurePolicy,
        });
      const maybeBackoffBeforeOverloadFailover = async (reason: FailoverReason | null) => {
        if (reason !== "overloaded" || overloadFailoverBackoffMs <= 0) {
          return;
        }
        log.warn(
          `overload backoff before failover for ${provider}/${modelId}: delayMs=${overloadFailoverBackoffMs}`,
        );
        try {
          await sleepWithAbort(overloadFailoverBackoffMs, params.abortSignal);
        } catch (err) {
          if (params.abortSignal?.aborted) {
            const abortErr = new Error("Operation aborted", { cause: err });
            abortErr.name = "AbortError";
            throw abortErr;
          }
          throw err;
        }
      };
      const maybeRetrySameModelRateLimit = async (retry?: {
        retryAfterSeconds?: number;
      }): Promise<boolean> => {
        if (consecutiveSameModelRateLimitRetries >= MAX_SAME_MODEL_RATE_LIMIT_RETRIES) {
          return false;
        }
        const delayMs = resolveSameModelRateLimitRetryDelayMs({
          retriesSoFar: consecutiveSameModelRateLimitRetries,
          retryAfterSeconds: retry?.retryAfterSeconds,
        });
        log.warn(
          `rate-limit same-model retry ${consecutiveSameModelRateLimitRetries + 1}/${MAX_SAME_MODEL_RATE_LIMIT_RETRIES} for ${sanitizeForLog(provider)}/${sanitizeForLog(modelId)}: delayMs=${delayMs}`,
        );
        try {
          await sleepWithAbort(delayMs, params.abortSignal);
        } catch (err) {
          if (params.abortSignal?.aborted) {
            const abortErr = new Error("Operation aborted", { cause: err });
            abortErr.name = "AbortError";
            throw abortErr;
          }
          throw err;
        }
        consecutiveSameModelRateLimitRetries = resolveNextSameModelRateLimitRetryCount({
          retriesSoFar: consecutiveSameModelRateLimitRetries,
          retriedSameModelRateLimit: true,
        });
        return true;
      };
      // Resolve the context engine once and reuse across retries to avoid
      // repeated initialization/connection overhead per attempt.
      ensureContextEnginesInitialized();
      const contextEngine = await resolveContextEngine(params.config, {
        agentDir,
        workspaceDir: resolvedWorkspace,
      });
      const resolveContextEnginePluginId = () => resolveContextEngineOwnerPluginId(contextEngine);
      startupStages.mark("context-engine");
      notifyExecutionPhase("context_engine", { provider, model: modelId });
      try {
        const resolveActiveHookContext = () => ({
          ...hookCtx,
          sessionId: activeSessionId,
        });
        const adoptCompactionTranscript = (
          compactResult: Awaited<ReturnType<typeof contextEngine.compact>>,
        ): string | undefined => {
          const previousSessionId = activeSessionId;
          const successor = resolveCompactionSuccessorTranscript(compactResult);
          adoptActiveSessionId(successor.sessionId);
          if (successor.sessionFile && successor.sessionFile !== activeSessionFile) {
            activeSessionFile = successor.sessionFile;
          }
          return successor.sessionId && successor.sessionId !== previousSessionId
            ? previousSessionId
            : undefined;
        };
        const onCompactionHookMessages = async (payload: {
          phase: "before" | "after";
          messages: string[];
        }) => {
          const messages = payload.messages.filter((message) => message.trim().length > 0);
          if (messages.length === 0) {
            return;
          }
          await params.onAgentEvent?.({
            stream: "compaction",
            data: {
              phase: payload.phase === "before" ? "start" : "end",
              ...(payload.phase === "after" ? { completed: true } : {}),
              messages,
            },
            ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
          });
        };
        // When the engine owns compaction, compactEmbeddedAgentSessionDirect is
        // bypassed. Fire lifecycle hooks here so recovery paths still notify
        // subscribers like memory extensions and usage trackers.
        const runOwnsCompactionBeforeHook = async (reason: string) => {
          if (
            contextEngine.info.ownsCompaction !== true ||
            !hookRunner?.hasHooks("before_compaction")
          ) {
            return;
          }
          try {
            await hookRunner.runBeforeCompaction(
              { messageCount: -1, sessionFile: activeSessionFile },
              resolveActiveHookContext(),
            );
          } catch (hookErr) {
            log.warn(`before_compaction hook failed during ${reason}: ${String(hookErr)}`);
          }
        };
        const runOwnsCompactionAfterHook = async (
          reason: string,
          compactResult: Awaited<ReturnType<typeof contextEngine.compact>>,
          previousSessionId?: string,
        ) => {
          if (
            contextEngine.info.ownsCompaction !== true ||
            !compactResult.ok ||
            !compactResult.compacted ||
            !hookRunner?.hasHooks("after_compaction")
          ) {
            return;
          }
          try {
            await hookRunner.runAfterCompaction(
              {
                messageCount: -1,
                compactedCount: -1,
                tokenCount: compactResult.result?.tokensAfter,
                sessionFile:
                  resolveCompactionSuccessorTranscript(compactResult).sessionFile ??
                  activeSessionFile,
                ...(previousSessionId ? { previousSessionId } : {}),
              },
              resolveActiveHookContext(),
            );
          } catch (hookErr) {
            log.warn(`after_compaction hook failed during ${reason}: ${String(hookErr)}`);
          }
        };
        let authRetryPending = false;
        let accumulatedReplayState = createEmbeddedRunReplayState();
        // Hoisted so the retry-limit error path can use the most recent API total.
        let lastTurnTotal: number | undefined;
        while (true) {
          if (runLoopIterations >= MAX_RUN_LOOP_ITERATIONS) {
            const message =
              `Exceeded retry limit after ${runLoopIterations} attempts ` +
              `(max=${MAX_RUN_LOOP_ITERATIONS}).`;
            log.error(
              `[run-retry-limit] sessionKey=${params.sessionKey ?? params.sessionId} ` +
                `provider=${provider}/${modelId} attempts=${runLoopIterations} ` +
                `maxAttempts=${MAX_RUN_LOOP_ITERATIONS}`,
            );
            const retryLimitDecision = resolveRunFailoverDecision({
              stage: "retry_limit",
              fallbackConfigured,
              failoverReason: lastRetryFailoverReason,
            });
            return handleRetryLimitExhaustion({
              message,
              decision: retryLimitDecision,
              provider,
              model: modelId,
              profileId: lastProfileId,
              durationMs: Date.now() - started,
              agentMeta: buildErrorAgentMeta({
                sessionId: activeSessionId,
                sessionFile: activeSessionFile,
                provider,
                model: model.id,
                ...outerContextTokenMeta,
                usageAccumulator,
                lastRunPromptUsage,
                lastTurnTotal,
              }),
              replayInvalid: accumulatedReplayState.replayInvalid ? true : undefined,
              livenessState: "blocked",
            });
          }
          runLoopIterations += 1;
          const runtimeAuthRetry = authRetryPending;
          authRetryPending = false;
          attemptedThinking.add(thinkLevel);
          await fs.mkdir(resolvedWorkspace, { recursive: true });
          if (!startupStagesEmitted) {
            startupStages.mark(EMBEDDED_RUN_ATTEMPT_DISPATCH_STAGE.workspace);
          }

          const basePrompt =
            nextAttemptPromptOverride ??
            resolveEmbeddedAttemptBasePrompt({
              nativeModelOwned,
              provider,
              prompt: params.prompt,
            });
          nextAttemptPromptOverride = null;
          const promptAdditions = [
            reasoningOnlyRetryInstruction,
            emptyResponseRetryInstruction,
            compactionContinuationRetryInstruction,
          ].filter(
            (value): value is string => typeof value === "string" && value.trim().length > 0,
          );
          const prompt =
            promptAdditions.length > 0
              ? `${basePrompt}\n\n${promptAdditions.join("\n\n")}`
              : basePrompt;
          const resolvedStreamApiKey = resolveAttemptDispatchApiKey({
            apiKeyInfo,
            runtimeAuthState,
          });
          const attemptFastMode = resolveAttemptFastModeParam();
          if (!startupStagesEmitted) {
            startupStages.mark(EMBEDDED_RUN_ATTEMPT_DISPATCH_STAGE.prompt);
          }
          const runtimePlan = buildAgentRuntimePlan({
            provider,
            modelId,
            model: effectiveModel,
            modelApi: effectiveModel.api,
            harnessId: agentHarness.id,
            harnessRuntime: agentHarness.id,
            allowHarnessAuthProfileForwarding: pluginHarnessOwnsTransport,
            authProfileProvider:
              (lastProfileId
                ? attemptAuthProfileStore.profiles?.[lastProfileId]?.provider
                : undefined) ?? lastProfileId?.split(":", 1)[0],
            authProfileMode: lastProfileId
              ? attemptAuthProfileStore.profiles?.[lastProfileId]?.type
              : undefined,
            sessionAuthProfileId: lastProfileId,
            sessionAuthProfileCandidateIds: pluginHarnessOwnsTransport
              ? pluginHarnessForwardedProfileCandidates
              : undefined,
            config: params.config,
            workspaceDir: resolvedWorkspace,
            agentDir,
            agentId: workspaceResolution.agentId,
            thinkingLevel: mapThinkingLevelForProvider(thinkLevel),
            extraParamsOverride: {
              ...params.streamParams,
              fastMode: attemptFastMode,
            },
          });
          if (!startupStagesEmitted) {
            startupStages.mark(EMBEDDED_RUN_ATTEMPT_DISPATCH_STAGE.runtimePlan);
            startupStages.mark(EMBEDDED_RUN_ATTEMPT_DISPATCH_STAGE.dispatch);
            notifyExecutionPhase("attempt_dispatch", { provider, model: modelId });
            emitStartupStageSummary(EMBEDDED_RUN_ATTEMPT_DISPATCH_STAGE.dispatch);
            startupStagesEmitted = true;
          }

          const attemptAbortController = new AbortController();
          postCompactionAbortController = attemptAbortController;
          const parentAbortSignal = params.abortSignal;
          const relayParentAbort = (): void => {
            laneTaskAbortController.abort(parentAbortSignal?.reason);
            attemptAbortController.abort(parentAbortSignal?.reason);
          };
          if (parentAbortSignal?.aborted) {
            relayParentAbort();
          } else {
            parentAbortSignal?.addEventListener("abort", relayParentAbort, { once: true });
          }
          // Native attempts start the heartbeat only after their own timeout
          // watchdog is armed, keeping preflight inside the requested deadline.
          let progressInterval: ReturnType<typeof setInterval> | undefined;
          const stopLaneProgressHeartbeat = () => {
            if (progressInterval) {
              clearInterval(progressInterval);
              progressInterval = undefined;
            }
            attemptAbortController.signal.removeEventListener("abort", stopLaneProgressHeartbeat);
          };
          const startLaneProgressHeartbeat = () => {
            if (progressInterval || attemptAbortController.signal.aborted) {
              return;
            }
            progressInterval = setInterval(
              () => noteLaneTaskProgress(),
              EMBEDDED_RUN_LANE_HEARTBEAT_MS,
            );
            progressInterval.unref?.();
            attemptAbortController.signal.addEventListener("abort", stopLaneProgressHeartbeat, {
              once: true,
            });
          };
          // Timeout recovery can continue after an attempt returns, but a native
          // transport that ignores its timeout releases the lane after one grace.
          let timeoutReleaseTimer: ReturnType<typeof setTimeout> | undefined;
          const clearAttemptTimeoutRelease = () => {
            if (timeoutReleaseTimer) {
              clearTimeout(timeoutReleaseTimer);
              timeoutReleaseTimer = undefined;
            }
          };
          const armAttemptTimeoutRelease = (reason: Error) => {
            if (timeoutReleaseTimer) {
              return;
            }
            timeoutReleaseTimer = setTimeout(
              () => laneTaskReleaseController.abort(reason),
              EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS,
            );
            timeoutReleaseTimer.unref?.();
          };
          let attemptCancellationRequested = false;
          const codexAppServerRecoveryRetryAvailable = hasCodexAppServerRecoveryRetryBudget({
            alreadyRetried: codexAppServerRecoveryRetries > 0,
            runLoopIterations,
            maxRunLoopIterations: MAX_RUN_LOOP_ITERATIONS,
          });
          const rawAttempt = await runEmbeddedAttemptWithBackend({
            sessionId: activeSessionId,
            sessionKey: resolvedSessionKey,
            // Forward continuation-tool callbacks so the main-session LLM
            // tool-schema includes continue_work + request_compaction. Without this,
            // createOpenClawTools fires the continuation-misconfig-warn guard at
            // openclaw-tools.ts:624 and only continue_delegate registers, leaving
            // continue_work + request_compaction absent from the LLM-callable
            // function-tool-list. Empirically confirmed by schema-inventory
            // introspection at two deployed agent-host seats; see #868. The opts
            // are constructed upstream at
            // auto-reply/reply/agent-runner-execution.ts:2472 + :2504 and arrive
            // here on the RunEmbeddedAgent params, but were not threaded through
            // to the attempt layer.
            continueWorkOpts: params.continueWorkOpts,
            requestCompactionOpts: params.requestCompactionOpts,
            promptCacheKey: params.promptCacheKey,
            sandboxSessionKey: params.sandboxSessionKey,
            trigger: params.trigger,
            memoryFlushWritePath: params.memoryFlushWritePath,
            messageChannel: params.messageChannel,
            messageProvider: params.messageProvider,
            clientCaps: params.clientCaps,
            chatType: params.chatType,
            agentAccountId: params.agentAccountId,
            messageTo: params.messageTo,
            messageThreadId: params.messageThreadId,
            messageActionTurnCapability: params.messageActionTurnCapability,
            groupId: params.groupId,
            groupChannel: params.groupChannel,
            groupSpace: params.groupSpace,
            memberRoleIds: params.memberRoleIds,
            spawnedBy: params.spawnedBy,
            isCanonicalWorkspace,
            senderId: params.senderId,
            senderName: params.senderName,
            senderUsername: params.senderUsername,
            senderE164: params.senderE164,
            senderIsOwner: params.senderIsOwner,
            approvalReviewerDeviceId: params.approvalReviewerDeviceId,
            currentChannelId: params.currentChannelId,
            chatId: params.chatId,
            channelContext: params.channelContext,
            currentMessagingTarget: params.currentMessagingTarget,
            currentThreadTs: params.currentThreadTs,
            currentMessageId: params.currentMessageId,
            currentInboundAudio: params.currentInboundAudio,
            replyToMode: params.replyToMode,
            hasRepliedRef: params.hasRepliedRef,
            sessionFile: activeSessionFile,
            workspaceDir: resolvedWorkspace,
            cwd: params.cwd,
            agentDir,
            config: params.config,
            allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
            ...(nativeModelOwned
              ? {}
              : {
                  contextEngine,
                  contextTokenBudget,
                  contextWindowInfo,
                }),
            skillsSnapshot: params.skillsSnapshot,
            prompt,
            transcriptPrompt: params.transcriptPrompt,
            userTurnTranscriptRecorder: params.userTurnTranscriptRecorder,
            currentInboundEventKind: params.currentInboundEventKind,
            currentInboundContext: params.currentInboundContext,
            images: params.images,
            imageOrder: params.imageOrder,
            clientTools: params.clientTools,
            disableTools: params.disableTools,
            provider,
            modelId,
            requestedModelId,
            fallbackActive: modelId !== requestedModelId || Boolean(resolveRuntimeFallbackReason()),
            fallbackReason: resolveRuntimeFallbackReason(),
            isFinalFallbackAttempt: params.isFinalFallbackAttempt,
            // Use the harness selected before model/auth setup for the actual
            // attempt too. Otherwise plugin-owned transports can skip OpenClaw auth
            // bootstrap but drift back to OpenClaw when the attempt is created.
            agentHarnessId: agentHarness.id,
            agentHarnessRuntimeOverride: agentHarness.id,
            modelSelectionLocked: params.modelSelectionLocked,
            ...(params.sessionKey
              ? {
                  agentHarnessTaskRuntimeScope: createAgentHarnessTaskRuntimeScope({
                    requesterSessionKey: params.sessionKey,
                  }),
                }
              : {}),
            runtimePlan,
            model: applyAuthHeaderOverride(
              applyLocalNoAuthHeaderOverride(effectiveModel, apiKeyInfo),
              // When runtime auth exchange produced a different credential
              // (runtimeAuthState is set), the exchanged token lives in
              // authStorage and the SDK will pick it up automatically.
              // Skip header injection to avoid leaking the pre-exchange key.
              runtimeAuthState ? null : apiKeyInfo,
              params.config,
            ),
            resolvedApiKey: resolvedStreamApiKey,
            authProfileId: lastProfileId,
            authProfileIdSource: lockedProfileId ? "user" : "auto",
            initialReplayState: accumulatedReplayState,
            authStorage,
            authProfileStore: runAttemptAuthProfileStore,
            // These harnesses build OpenClaw tools internally. Keep transport auth
            // scoped while letting tool construction see plugin/provider creds.
            toolAuthProfileStore: harnessBuildsOpenClawTools ? attemptAuthProfileStore : undefined,
            modelRegistry,
            agentId: workspaceResolution.agentId,
            beforeAgentStartResult,
            thinkLevel,
            onToolOutcome: observeToolOutcome,
            allocateToolOutcomeOrdinal,
            onToolStreamBoundary: maybeAnnounceFastModeAutoOff,
            onRunProgress: notifyRunProgress,
            fastMode: attemptFastMode,
            fastModeAuto: params.fastMode === "auto",
            ...(params.fastMode === "auto"
              ? {
                  fastModeStartedAtMs: fastModeStarted,
                  fastModeAutoOnSeconds,
                  fastModeAutoProgressState,
                }
              : {}),
            verboseLevel: params.verboseLevel,
            reasoningLevel: params.reasoningLevel,
            toolResultFormat: resolvedToolResultFormat,
            toolProgressDetail: params.toolProgressDetail,
            execOverrides: params.execOverrides,
            bashElevated: params.bashElevated,
            timeoutMs: params.timeoutMs,
            runTimeoutOverrideMs: params.runTimeoutOverrideMs,
            runId: params.runId,
            lifecycleGeneration,
            abortSignal: attemptAbortController.signal,
            onAttemptTimeoutArmed: pluginHarnessOwnsTransport
              ? undefined
              : startLaneProgressHeartbeat,
            onAttemptTimeout: pluginHarnessOwnsTransport ? undefined : armAttemptTimeoutRelease,
            onAttemptAbort: () => {
              attemptCancellationRequested = true;
              if (!params.abortSignal?.aborted) {
                params.replyOperation?.abortByUser();
              }
              if (!pluginHarnessOwnsTransport) {
                stopLaneProgressHeartbeat();
                laneTaskAbortController.abort();
              }
            },
            replyOperation: params.replyOperation,
            shouldEmitToolResult: params.shouldEmitToolResult,
            shouldEmitToolOutput: params.shouldEmitToolOutput,
            onPartialReply: params.onPartialReply,
            onAssistantMessageStart: params.onAssistantMessageStart,
            onBlockReply: params.onBlockReply,
            onBlockReplyFlush: params.onBlockReplyFlush,
            blockReplyBreak: params.blockReplyBreak,
            blockReplyChunking: params.blockReplyChunking,
            onReasoningStream: params.onReasoningStream,
            streamReasoningInNonStreamModes: params.streamReasoningInNonStreamModes,
            onReasoningEnd: params.onReasoningEnd,
            onToolResult: notifyToolResult,
            onAgentToolResult: params.onAgentToolResult,
            onAgentEvent: notifyAgentEvent,
            deferTerminalLifecycle:
              params.deferTerminalLifecycle ?? params.deferTerminalLifecycleEnd,
            deferTerminalLifecycleEnd:
              params.deferTerminalLifecycle ?? params.deferTerminalLifecycleEnd,
            onExecutionPhase: params.onExecutionPhase,
            extraSystemPrompt: params.extraSystemPrompt,
            sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
            taskSuggestionDeliveryMode: params.taskSuggestionDeliveryMode,
            inputProvenance: params.inputProvenance,
            streamParams: params.streamParams,
            modelRun: params.modelRun,
            promptMode: params.promptMode,
            ownerNumbers: params.ownerNumbers,
            enforceFinalTag: params.enforceFinalTag,
            silentExpected: params.silentExpected,
            suppressLiveStreamOutput: params.suppressLiveStreamOutput,
            bootstrapContextMode: params.bootstrapContextMode,
            bootstrapContextRunKind: params.bootstrapContextRunKind,
            jobId: params.jobId,
            toolsAllow: params.toolsAllow,
            crestodianTool: params.crestodianTool,
            cleanupBundleMcpOnRunEnd: params.cleanupBundleMcpOnRunEnd,
            disableMessageTool: params.disableMessageTool,
            forceMessageTool: params.forceMessageTool,
            enableHeartbeatTool: params.enableHeartbeatTool,
            forceHeartbeatTool: params.forceHeartbeatTool,
            requireExplicitMessageTarget: params.requireExplicitMessageTarget,
            internalEvents: params.internalEvents,
            bootstrapPromptWarningSignaturesSeen,
            bootstrapPromptWarningSignature:
              bootstrapPromptWarningSignaturesSeen[bootstrapPromptWarningSignaturesSeen.length - 1],
            suppressNextUserMessagePersistence,
            beforeAgentFinalizeRevisionAttempts,
            maxBeforeAgentFinalizeRevisions: MAX_BEFORE_AGENT_FINALIZE_REVISIONS,
            suppressTranscriptOnlyAssistantPersistence:
              params.suppressTranscriptOnlyAssistantPersistence,
            suppressAssistantErrorPersistence: params.suppressAssistantErrorPersistence,
            onUserMessagePersisted,
            onAssistantErrorMessagePersisted: params.onAssistantErrorMessagePersisted,
          })
            .catch((err: unknown): never => {
              throw postCompactionAbortError ?? err;
            })
            .finally(() => {
              clearAttemptTimeoutRelease();
              stopLaneProgressHeartbeat();
              parentAbortSignal?.removeEventListener?.("abort", relayParentAbort);
              if (postCompactionAbortController === attemptAbortController) {
                postCompactionAbortController = undefined;
              }
            });
          if (postCompactionAbortError) {
            throw postCompactionAbortError;
          }
          const attempt = normalizeEmbeddedRunAttemptResult(rawAttempt);
          if (attemptCancellationRequested) {
            throwIfAborted();
            throw createAgentRunDirectAbortError();
          }

          const {
            aborted,
            externalAbort,
            promptError,
            promptErrorSource,
            preflightRecovery,
            timedOut,
            idleTimedOut,
            timedOutDuringCompaction,
            sessionIdUsed,
            sessionFileUsed,
            lastAssistant: sessionLastAssistant,
            currentAttemptAssistant,
          } = attempt;
          const setTerminalLifecycleMeta: NonNullable<typeof attempt.setTerminalLifecycleMeta> = (
            meta,
          ) => {
            attempt.setTerminalLifecycleMeta?.({ ...meta, aborted });
          };
          const timedOutDuringToolExecution = attempt.timedOutDuringToolExecution ?? false;
          const timedOutByRunBudget = attempt.timedOutByRunBudget ?? false;
          adoptActiveSessionId(sessionIdUsed);
          if (sessionFileUsed && sessionFileUsed !== activeSessionFile) {
            activeSessionFile = sessionFileUsed;
          }
          bootstrapPromptWarningSignaturesSeen =
            attempt.bootstrapPromptWarningSignaturesSeen ??
            (attempt.bootstrapPromptWarningSignature
              ? Array.from(
                  new Set([
                    ...bootstrapPromptWarningSignaturesSeen,
                    attempt.bootstrapPromptWarningSignature,
                  ]),
                )
              : bootstrapPromptWarningSignaturesSeen);
          const lastAssistantUsage = normalizeUsage(sessionLastAssistant?.usage as UsageLike);
          const currentAttemptAssistantUsage = normalizeUsage(
            currentAttemptAssistant?.usage as UsageLike,
          );
          const promptCacheLastCallUsage = normalizeUsage(
            attempt.promptCache?.lastCallUsage as UsageLike,
          );
          const callUsage = resolveLatestCallUsage({
            currentAttemptCandidates: [currentAttemptAssistantUsage, promptCacheLastCallUsage],
            carriedCandidates: [lastRunPromptUsage, lastAssistantUsage],
          });
          const attemptUsage = attempt.attemptUsage ?? callUsage.currentAttempt;
          mergeUsageIntoAccumulator(usageAccumulator, attemptUsage);
          // Keep prompt size from the latest model call so session totalTokens
          // reflects current context usage, not accumulated tool-loop usage.
          lastRunPromptUsage = callUsage.latest;
          lastTurnTotal = callUsage.latest?.total;
          // Idle-timeout cost-runaway breaker (#76293). Logic lives in the
          // pure helper below so it stays unit-testable; the run loop just
          // feeds it the latest attempt outcome and bails through the
          // existing retry-limit exhaustion path when the cap is hit.
          const breakerStep = stepIdleTimeoutBreaker(idleTimeoutBreakerState, {
            idleTimedOut,
            completedModelProgress: hasCompletedModelProgressForIdleBreaker(attempt),
            outputTokens: attemptUsage?.output,
          });
          if (breakerStep.tripped) {
            const breakerMessage =
              `Idle-timeout cost-runaway breaker tripped: ` +
              `${breakerStep.consecutive} consecutive idle timeouts ` +
              `without completed model progress ` +
              `(cap=${MAX_CONSECUTIVE_IDLE_TIMEOUTS_BEFORE_OUTPUT}). ` +
              `Halting further attempts to bound paid model calls. ` +
              `See issue #76293.`;
            log.error(
              `[idle-timeout-circuit-breaker-tripped] ` +
                `sessionKey=${params.sessionKey ?? params.sessionId} ` +
                `provider=${provider}/${modelId} ` +
                `consecutive=${breakerStep.consecutive} ` +
                `cap=${MAX_CONSECUTIVE_IDLE_TIMEOUTS_BEFORE_OUTPUT}`,
            );
            const breakerDecision = resolveRunFailoverDecision({
              stage: "retry_limit",
              fallbackConfigured,
              failoverReason: lastRetryFailoverReason,
            });
            return handleRetryLimitExhaustion({
              message: breakerMessage,
              decision: breakerDecision,
              provider,
              model: modelId,
              profileId: lastProfileId,
              durationMs: Date.now() - started,
              agentMeta: buildErrorAgentMeta({
                sessionId: activeSessionId,
                sessionFile: activeSessionFile,
                provider,
                model: model.id,
                ...outerContextTokenMeta,
                usageAccumulator,
                lastRunPromptUsage,
                lastTurnTotal,
              }),
              replayInvalid: accumulatedReplayState.replayInvalid ? true : undefined,
              livenessState: "blocked",
            });
          }
          const attemptCompactionCount = Math.max(0, attempt.compactionCount ?? 0);
          autoCompactionCount += attemptCompactionCount;
          if (
            typeof attempt.compactionTokensAfter === "number" &&
            Number.isFinite(attempt.compactionTokensAfter) &&
            attempt.compactionTokensAfter >= 0
          ) {
            lastCompactionTokensAfter = Math.floor(attempt.compactionTokensAfter);
          }
          if (attempt.contextBudgetStatus) {
            lastContextBudgetStatus = attempt.contextBudgetStatus;
          }
          // Transcript fallback can outlive a provider or alias transition.
          // Reuse it only when it reports the effective model for this attempt.
          const sessionAssistantForCandidate =
            !currentAttemptAssistant &&
            !isAssistantForModelRef(sessionLastAssistant, {
              provider: effectiveModel.provider,
              model: effectiveModel.id,
            })
              ? undefined
              : sessionLastAssistant;
          const attemptAssistant = currentAttemptAssistant ?? sessionAssistantForCandidate;
          const activeErrorContext = resolveActiveErrorContext({
            provider,
            model: modelId,
            assistant: attemptAssistant,
          });
          const resolveReplayInvalidForAttempt = (incompleteTurnText?: string | null) =>
            accumulatedReplayState.replayInvalid ||
            resolveReplayInvalidFlag({
              attempt,
              incompleteTurnText,
            });
          if (resolveReplayInvalidForAttempt(null)) {
            accumulatedReplayState.replayInvalid = true;
          }
          accumulatedReplayState = observeReplayMetadata(
            accumulatedReplayState,
            attempt.replayMetadata,
          );
          const formattedAssistantErrorText = sessionAssistantForCandidate
            ? formatAssistantErrorText(sessionAssistantForCandidate, {
                cfg: params.config,
                sessionKey: resolvedSessionKey ?? params.sessionId,
                provider: activeErrorContext.provider,
                model: activeErrorContext.model,
                authMode: lastProfileId
                  ? attemptAuthProfileStore.profiles?.[lastProfileId]?.type
                  : undefined,
              })
            : undefined;
          const assistantErrorText =
            sessionAssistantForCandidate?.stopReason === "error"
              ? sessionAssistantForCandidate.errorMessage?.trim() || formattedAssistantErrorText
              : undefined;
          const canRestartForLiveSwitch =
            !hasOutboundDeliveryEvidence(attempt) &&
            !attempt.didSendDeterministicApprovalPrompt &&
            !attempt.lastToolError &&
            (attempt.toolMetas?.length ?? 0) === 0 &&
            (attempt.assistantTexts?.length ?? 0) === 0;
          if (!nativeModelOwned && preflightRecovery?.handled) {
            const retryingFromTranscript = preflightRecovery.source === "mid-turn";
            log.info(
              `[context-overflow-precheck] early recovery route=${preflightRecovery.route} ` +
                `completed for ${provider}/${modelId}; ` +
                (retryingFromTranscript ? "retrying from current transcript" : "retrying prompt"),
            );
            if (retryingFromTranscript) {
              continueFromCurrentTranscript();
            }
            continue;
          }
          const requestedSelection = shouldSwitchToLiveModel({
            cfg: params.config,
            sessionKey: resolvedSessionKey,
            agentId: params.agentId,
            defaultProvider: DEFAULT_PROVIDER,
            defaultModel: DEFAULT_MODEL,
            currentProvider: provider,
            currentModel: modelId,
            currentAgentRuntimeOverride: params.agentHarnessRuntimeOverride,
            currentAuthProfileId: preferredProfileId,
            currentAuthProfileIdSource: params.authProfileIdSource,
          });
          if (requestedSelection && canRestartForLiveSwitch) {
            await clearLiveModelSwitchPending({
              cfg: params.config,
              sessionKey: resolvedSessionKey,
              agentId: params.agentId,
            });
            log.info(
              `live session model switch requested during active attempt for ${params.sessionId}: ${provider}/${modelId} -> ${requestedSelection.provider}/${requestedSelection.model}`,
            );
            throw new LiveSessionModelSwitchError(requestedSelection);
          }
          if (
            !nativeModelOwned &&
            contextTokenBudget !== undefined &&
            timedOut &&
            !timedOutDuringCompaction &&
            !timedOutDuringToolExecution &&
            !timedOutByRunBudget
          ) {
            // Only consider prompt-side tokens here. API totals include output
            // tokens, which can make a long generation look like high context
            // pressure even when the prompt itself was small.
            const lastTurnPromptTokens = deriveContextPromptTokens({
              lastCallUsage: lastRunPromptUsage,
            });
            const tokenUsedRatio =
              lastTurnPromptTokens != null && contextTokenBudget > 0
                ? lastTurnPromptTokens / contextTokenBudget
                : 0;
            if (timeoutCompactionAttempts >= MAX_TIMEOUT_COMPACTION_ATTEMPTS) {
              log.warn(
                `[timeout-compaction] already attempted timeout compaction ${timeoutCompactionAttempts} time(s); falling through to failover rotation`,
              );
            } else if (tokenUsedRatio > 0.65) {
              const timeoutDiagId = createCompactionDiagId();
              timeoutCompactionAttempts++;
              log.warn(
                `[timeout-compaction] LLM timed out with high prompt token usage (${Math.round(tokenUsedRatio * 100)}%); ` +
                  `attempting compaction before retry (attempt ${timeoutCompactionAttempts}/${MAX_TIMEOUT_COMPACTION_ATTEMPTS}) diagId=${timeoutDiagId}`,
              );
              log.warn(
                `[context-pressure:fire] mid-turn trigger=timeout ratio=${Math.round(tokenUsedRatio * 100)}% ` +
                  `tokens=${Math.round((lastTurnPromptTokens ?? 0) / 1000)}k/${Math.round(contextTokenBudget / 1000)}k ` +
                  `sessionKey=${params.sessionKey ?? params.sessionId}`,
              );
              const timeoutSessionKey = requireSessionKeyOrSkip(
                params,
                log,
                "pi-runner.timeout-compaction",
              );
              if (timeoutSessionKey) {
                enqueueSystemEvent(
                  `[system:context-pressure] Mid-turn compaction triggered at ${Math.round(tokenUsedRatio * 100)}% ` +
                    `context (${Math.round((lastTurnPromptTokens ?? 0) / 1000)}k/${Math.round(contextTokenBudget / 1000)}k tokens). ` +
                    `Your last reply hit the provider timeout ceiling. Consider evacuating working state earlier via ` +
                    `continue_delegate(post-compaction) or memory files so the next turn starts with room to grow.`,
                  { sessionKey: timeoutSessionKey },
                );
              }
              let timeoutCompactResult: Awaited<ReturnType<typeof contextEngine.compact>>;
              await runOwnsCompactionBeforeHook("timeout recovery");
              try {
                const timeoutCompactionRuntimeContext = {
                  ...buildEmbeddedCompactionRuntimeContext({
                    sessionKey: params.sessionKey,
                    messageChannel: params.messageChannel,
                    messageProvider: params.messageProvider,
                    clientCaps: params.clientCaps,
                    chatType: params.chatType,
                    agentAccountId: params.agentAccountId,
                    currentChannelId: params.currentChannelId,
                    currentThreadTs: params.currentThreadTs,
                    currentMessageId: params.currentMessageId,
                    authProfileId: lastProfileId,
                    workspaceDir: resolvedWorkspace,
                    agentDir,
                    config: params.config,
                    skillsSnapshot: params.skillsSnapshot,
                    senderId: params.senderId,
                    provider,
                    modelId,
                    harnessRuntime: agentHarness.id,
                    modelSelectionLocked: params.modelSelectionLocked,
                    modelFallbacksOverride: params.modelFallbacksOverride,
                    thinkLevel,
                    reasoningLevel: params.reasoningLevel,
                    bashElevated: params.bashElevated,
                    extraSystemPrompt: params.extraSystemPrompt,
                    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
                    ownerNumbers: params.ownerNumbers,
                    activeProcessSessions: listActiveProcessSessionReferences({
                      scopeKey: resolveProcessToolScopeKey({
                        sessionKey: params.sandboxSessionKey?.trim() || params.sessionKey,
                        sessionId: activeSessionId,
                        agentId: sessionAgentId,
                      }),
                    }),
                  }),
                  ...resolveContextEngineCapabilities({
                    config: params.config,
                    sessionKey: params.sessionKey,
                    agentId: sessionAgentId,
                    contextEnginePluginId: resolveContextEnginePluginId(),
                    purpose: "context-engine.timeout-compaction",
                  }),
                  onCompactionHookMessages,
                  ...(attempt.promptCache ? { promptCache: attempt.promptCache } : {}),
                  runId: params.runId,
                  trigger: "timeout_recovery",
                  diagId: timeoutDiagId,
                  attempt: timeoutCompactionAttempts,
                  maxAttempts: MAX_TIMEOUT_COMPACTION_ATTEMPTS,
                };
                // Bound plugin-owned compaction with the same finite safety
                // timeout that protects native compaction, and thread the
                // run-level abort signal through, so a hung plugin compact()
                // cannot stall timeout recovery indefinitely. A timeout/abort
                // surfaces as a thrown error handled by the catch below.
                timeoutCompactResult = await compactContextEngineWithSafetyTimeout(
                  contextEngine,
                  {
                    sessionId: activeSessionId,
                    sessionKey: params.sessionKey,
                    sessionFile: activeSessionFile,
                    tokenBudget: contextTokenBudget,
                    force: true,
                    compactionTarget: "budget",
                    runtimeContext: timeoutCompactionRuntimeContext,
                    runtimeSettings: buildEmbeddedContextEngineRuntimeSettings({
                      tokenBudget: contextTokenBudget,
                    }),
                  },
                  resolveCompactionTimeoutMs(params.config),
                  params.abortSignal,
                );
              } catch (compactErr) {
                log.warn(
                  `[timeout-compaction] contextEngine.compact() threw during timeout recovery for ${provider}/${modelId}: ${String(compactErr)}`,
                );
                timeoutCompactResult = {
                  ok: false,
                  compacted: false,
                  reason: String(compactErr),
                };
              }
              const previousSessionId = timeoutCompactResult.compacted
                ? adoptCompactionTranscript(timeoutCompactResult)
                : undefined;
              await runOwnsCompactionAfterHook(
                "timeout recovery",
                timeoutCompactResult,
                previousSessionId,
              );
              if (timeoutCompactResult.compacted) {
                autoCompactionCount += 1;
                if (
                  typeof timeoutCompactResult.result?.tokensAfter === "number" &&
                  Number.isFinite(timeoutCompactResult.result.tokensAfter) &&
                  timeoutCompactResult.result.tokensAfter >= 0
                ) {
                  lastCompactionTokensAfter = Math.floor(timeoutCompactResult.result.tokensAfter);
                }
                if (contextEngine.info.ownsCompaction === true) {
                  await runPostCompactionSideEffects({
                    config: params.config,
                    sessionKey: params.sessionKey,
                    agentId: sessionAgentId,
                    sessionFile: activeSessionFile,
                  });
                }
                log.info(
                  `[timeout-compaction] compaction succeeded for ${provider}/${modelId}; retrying prompt`,
                );
                postCompactionGuard.armPostCompaction();
                continue;
              } else {
                log.warn(
                  `[timeout-compaction] compaction did not reduce context for ${provider}/${modelId}; falling through to normal handling`,
                );
              }
            }
          }

          const contextOverflowError = !aborted
            ? (() => {
                if (promptError) {
                  const errorText = formatErrorMessage(promptError);
                  if (isLikelyContextOverflowError(errorText)) {
                    return { text: errorText, source: "promptError" as const };
                  }
                  // Prompt submission failed with a non-overflow error. Do not
                  // inspect prior assistant errors from history for this attempt.
                  return null;
                }
                if (assistantErrorText && isLikelyContextOverflowError(assistantErrorText)) {
                  return {
                    text: assistantErrorText,
                    source: "assistantError" as const,
                  };
                }
                return null;
              })()
            : null;

          if (contextOverflowError && !nativeModelOwned && contextTokenBudget !== undefined) {
            const overflowDiagId = createCompactionDiagId();
            const errorText = contextOverflowError.text;
            const msgCount = attempt.messagesSnapshot?.length ?? 0;
            const observedOverflowTokens = extractObservedOverflowTokenCount(errorText);
            const preflightEstimatedPromptTokens =
              typeof preflightRecovery?.estimatedPromptTokens === "number" &&
              Number.isFinite(preflightRecovery.estimatedPromptTokens) &&
              preflightRecovery.estimatedPromptTokens > 0
                ? Math.ceil(preflightRecovery.estimatedPromptTokens)
                : undefined;
            const overflowTokenCountForCompaction =
              observedOverflowTokens ??
              preflightEstimatedPromptTokens ??
              (contextTokenBudget > 0
                ? // Confirmed overflow with an unparseable provider message still carries a
                  // minimally over-budget count for compaction engines and diagnostics.
                  contextTokenBudget + 1
                : undefined);
            log.warn(
              `[context-overflow-diag] sessionKey=${params.sessionKey ?? params.sessionId} ` +
                `provider=${provider}/${modelId} source=${contextOverflowError.source} ` +
                `messages=${msgCount} sessionFile=${activeSessionFile} ` +
                `diagId=${overflowDiagId} compactionAttempts=${overflowCompactionAttempts} ` +
                `observedTokens=${observedOverflowTokens ?? "unknown"} ` +
                `preflightEstimatedTokens=${preflightEstimatedPromptTokens ?? "unknown"} ` +
                `compactionTokens=${overflowTokenCountForCompaction ?? "unknown"} ` +
                `error=${truncateUtf16Safe(errorText, 200)}`,
            );
            const isCompactionFailure = isCompactionFailureError(errorText);
            const hadAttemptLevelCompaction = attemptCompactionCount > 0;
            // If this attempt already compacted (SDK auto-compaction), avoid immediately
            // running another explicit compaction for the same overflow trigger.
            if (
              !isCompactionFailure &&
              hadAttemptLevelCompaction &&
              overflowCompactionAttempts < MAX_OVERFLOW_COMPACTION_ATTEMPTS
            ) {
              overflowCompactionAttempts++;
              log.warn(
                `context overflow persisted after in-attempt compaction (attempt ${overflowCompactionAttempts}/${MAX_OVERFLOW_COMPACTION_ATTEMPTS}); retrying prompt without additional compaction for ${provider}/${modelId}`,
              );
              if (preflightRecovery?.source === "mid-turn") {
                continueFromCurrentTranscript();
              }
              continue;
            }
            // Attempt explicit overflow compaction only when this attempt did not
            // already auto-compact.
            if (
              !isCompactionFailure &&
              !hadAttemptLevelCompaction &&
              overflowCompactionAttempts < MAX_OVERFLOW_COMPACTION_ATTEMPTS
            ) {
              if (log.isEnabled("debug")) {
                log.debug(
                  `[compaction-diag] decision diagId=${overflowDiagId} branch=compact ` +
                    `isCompactionFailure=${isCompactionFailure} hasOversizedToolResults=unknown ` +
                    `attempt=${overflowCompactionAttempts + 1} maxAttempts=${MAX_OVERFLOW_COMPACTION_ATTEMPTS}`,
                );
              }
              overflowCompactionAttempts++;
              log.warn(
                `context overflow detected (attempt ${overflowCompactionAttempts}/${MAX_OVERFLOW_COMPACTION_ATTEMPTS}); attempting auto-compaction for ${provider}/${modelId}`,
              );
              log.warn(
                `[context-pressure:fire] mid-turn trigger=overflow attempt=${overflowCompactionAttempts}/${MAX_OVERFLOW_COMPACTION_ATTEMPTS} ` +
                  `tokens=${observedOverflowTokens !== undefined ? Math.round(observedOverflowTokens / 1000) : "?"}k/${Math.round(contextTokenBudget / 1000)}k ` +
                  `sessionKey=${params.sessionKey ?? params.sessionId}`,
              );
              const overflowSessionKey = requireSessionKeyOrSkip(
                params,
                log,
                "pi-runner.overflow-compaction",
              );
              if (overflowSessionKey) {
                enqueueSystemEvent(
                  `[system:context-pressure] Context-overflow compaction triggered mid-turn ` +
                    `(attempt ${overflowCompactionAttempts}/${MAX_OVERFLOW_COMPACTION_ATTEMPTS}). ` +
                    `Your last reply grew the context past the model's window. Consider evacuating ` +
                    `large tool results or delegated work with continue_delegate(post-compaction).`,
                  { sessionKey: overflowSessionKey },
                );
              }
              let compactResult: Awaited<ReturnType<typeof contextEngine.compact>>;
              let previousSessionId: string | undefined;
              await runOwnsCompactionBeforeHook("overflow recovery");
              try {
                const overflowCompactionRuntimeContext = {
                  ...buildEmbeddedCompactionRuntimeContext({
                    sessionKey: params.sessionKey,
                    messageChannel: params.messageChannel,
                    messageProvider: params.messageProvider,
                    clientCaps: params.clientCaps,
                    chatType: params.chatType,
                    agentAccountId: params.agentAccountId,
                    currentChannelId: params.currentChannelId,
                    currentThreadTs: params.currentThreadTs,
                    currentMessageId: params.currentMessageId,
                    authProfileId: lastProfileId,
                    workspaceDir: resolvedWorkspace,
                    agentDir,
                    config: params.config,
                    skillsSnapshot: params.skillsSnapshot,
                    senderId: params.senderId,
                    provider,
                    modelId,
                    harnessRuntime: agentHarness.id,
                    modelSelectionLocked: params.modelSelectionLocked,
                    thinkLevel,
                    reasoningLevel: params.reasoningLevel,
                    bashElevated: params.bashElevated,
                    extraSystemPrompt: params.extraSystemPrompt,
                    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
                    ownerNumbers: params.ownerNumbers,
                    activeProcessSessions: listActiveProcessSessionReferences({
                      scopeKey: resolveProcessToolScopeKey({
                        sessionKey: params.sandboxSessionKey?.trim() || params.sessionKey,
                        sessionId: activeSessionId,
                        agentId: sessionAgentId,
                      }),
                    }),
                  }),
                  ...resolveContextEngineCapabilities({
                    config: params.config,
                    sessionKey: params.sessionKey,
                    agentId: sessionAgentId,
                    contextEnginePluginId: resolveContextEnginePluginId(),
                    purpose: "context-engine.overflow-compaction",
                  }),
                  onCompactionHookMessages,
                  ...(attempt.promptCache ? { promptCache: attempt.promptCache } : {}),
                  runId: params.runId,
                  trigger: "overflow",
                  ...(overflowTokenCountForCompaction !== undefined
                    ? { currentTokenCount: overflowTokenCountForCompaction }
                    : {}),
                  diagId: overflowDiagId,
                  attempt: overflowCompactionAttempts,
                  maxAttempts: MAX_OVERFLOW_COMPACTION_ATTEMPTS,
                };
                // Bound plugin-owned compaction with the same finite safety
                // timeout that protects native compaction, and thread the
                // run-level abort signal through, so a hung plugin compact()
                // cannot stall overflow recovery indefinitely. A timeout/abort
                // surfaces as a thrown error handled by the catch below.
                const overflowCompactionRuntimeSettings = buildEmbeddedContextEngineRuntimeSettings(
                  {
                    tokenBudget: contextTokenBudget,
                    degradedReason: "context_overflow",
                  },
                );
                compactResult = await compactContextEngineWithSafetyTimeout(
                  contextEngine,
                  {
                    sessionId: activeSessionId,
                    sessionKey: params.sessionKey,
                    sessionFile: activeSessionFile,
                    tokenBudget: contextTokenBudget,
                    ...(overflowTokenCountForCompaction !== undefined
                      ? { currentTokenCount: overflowTokenCountForCompaction }
                      : {}),
                    force: true,
                    compactionTarget: "budget",
                    runtimeContext: overflowCompactionRuntimeContext,
                    runtimeSettings: overflowCompactionRuntimeSettings,
                  },
                  resolveCompactionTimeoutMs(params.config),
                  params.abortSignal,
                );
                if (compactResult.ok && compactResult.compacted) {
                  previousSessionId = adoptCompactionTranscript(compactResult);
                  await runContextEngineMaintenance({
                    contextEngine,
                    sessionId: activeSessionId,
                    sessionKey: params.sessionKey,
                    sessionFile: activeSessionFile,
                    reason: "compaction",
                    runtimeContext: overflowCompactionRuntimeContext,
                    runtimeSettings: overflowCompactionRuntimeSettings,
                    config: params.config,
                    agentId: sessionAgentId,
                  });
                }
              } catch (compactErr) {
                log.warn(
                  `contextEngine.compact() threw during overflow recovery for ${provider}/${modelId}: ${String(compactErr)}`,
                );
                compactResult = {
                  ok: false,
                  compacted: false,
                  reason: String(compactErr),
                };
              }
              await runOwnsCompactionAfterHook(
                "overflow recovery",
                compactResult,
                previousSessionId,
              );
              if (preflightRecovery && isNoRealConversationCompactionNoop(compactResult)) {
                lastCompactionTokensAfter = undefined;
                lastContextBudgetStatus = undefined;
                await resetNoRealConversationTokenSnapshot({
                  config: params.config,
                  sessionKey: params.sessionKey,
                  agentId: sessionAgentId,
                });
                log.info(
                  `[context-overflow-precheck] stale token state had no real conversation messages for ` +
                    `${provider}/${modelId}; resetting the context snapshot and retrying prompt`,
                );
                if (preflightRecovery.source === "mid-turn") {
                  continueFromCurrentTranscript();
                }
                continue;
              }
              if (compactResult.compacted) {
                adoptCompactionTranscript(compactResult);
                if (
                  typeof compactResult.result?.tokensAfter === "number" &&
                  Number.isFinite(compactResult.result.tokensAfter) &&
                  compactResult.result.tokensAfter >= 0
                ) {
                  lastCompactionTokensAfter = Math.floor(compactResult.result.tokensAfter);
                }
                if (preflightRecovery?.route === "compact_then_truncate") {
                  const truncResult = await truncateOversizedToolResultsInSession({
                    sessionFile: activeSessionFile,
                    contextWindowTokens: contextTokenBudget,
                    maxCharsOverride: resolveLiveToolResultMaxChars({
                      contextWindowTokens: contextTokenBudget,
                      cfg: params.config,
                      agentId: sessionAgentId,
                    }),
                    sessionId: activeSessionId,
                    sessionKey: params.sessionKey,
                    agentId: sessionAgentId,
                    config: params.config,
                    protectTrailingToolResults: true,
                  });
                  if (truncResult.truncated) {
                    log.info(
                      `[context-overflow-precheck] post-compaction tool-result truncation succeeded for ` +
                        `${provider}/${modelId}; truncated ${truncResult.truncatedCount} tool result(s)`,
                    );
                  } else {
                    log.warn(
                      `[context-overflow-precheck] post-compaction tool-result truncation did not help for ` +
                        `${provider}/${modelId}: ${truncResult.reason ?? "unknown"}`,
                    );
                  }
                }
                autoCompactionCount += 1;
                log.info(`auto-compaction succeeded for ${provider}/${modelId}; retrying prompt`);
                postCompactionGuard.armPostCompaction();
                if (preflightRecovery?.source === "mid-turn") {
                  continueFromCurrentTranscript();
                } else if (
                  params.currentMessageId !== undefined &&
                  params.currentMessageId === lastPersistedCurrentMessageId
                ) {
                  // The first attempt reached the embedded agent far enough to persist this user turn.
                  // Retrying the original prompt would replay it, so resume from the
                  // compacted transcript and suppress the next user append.
                  nextAttemptPromptOverride = MID_TURN_PRECHECK_CONTINUATION_PROMPT;
                  suppressNextUserMessagePersistence = true;
                }
                continue;
              }
              log.warn(
                `auto-compaction failed for ${provider}/${modelId}: ${compactResult.reason ?? "nothing to compact"}`,
              );
            }
            if (!toolResultTruncationAttempted) {
              const contextWindowTokens = contextTokenBudget;
              const toolResultMaxChars = resolveLiveToolResultMaxChars({
                contextWindowTokens,
                cfg: params.config,
                agentId: sessionAgentId,
              });
              const hasOversized = attempt.messagesSnapshot
                ? sessionLikelyHasOversizedToolResults({
                    messages: attempt.messagesSnapshot,
                    contextWindowTokens,
                    maxCharsOverride: toolResultMaxChars,
                  })
                : false;

              if (hasOversized) {
                toolResultTruncationAttempted = true;
                log.warn(
                  `[context-overflow-recovery] Attempting tool result truncation for ${provider}/${modelId} ` +
                    `(contextWindow=${contextWindowTokens} tokens)`,
                );
                const truncResult = await truncateOversizedToolResultsInSession({
                  sessionFile: activeSessionFile,
                  contextWindowTokens,
                  maxCharsOverride: toolResultMaxChars,
                  sessionId: activeSessionId,
                  sessionKey: params.sessionKey,
                  agentId: sessionAgentId,
                  config: params.config,
                  protectTrailingToolResults: preflightRecovery?.route === "compact_then_truncate",
                });
                if (truncResult.truncated) {
                  log.info(
                    `[context-overflow-recovery] Truncated ${truncResult.truncatedCount} tool result(s); retrying prompt`,
                  );
                  if (preflightRecovery?.source === "mid-turn") {
                    continueFromCurrentTranscript();
                  }
                  continue;
                }
                log.warn(
                  `[context-overflow-recovery] Tool result truncation did not help: ${truncResult.reason ?? "unknown"}`,
                );
              }
            }
            if (
              (isCompactionFailure ||
                overflowCompactionAttempts >= MAX_OVERFLOW_COMPACTION_ATTEMPTS) &&
              log.isEnabled("debug")
            ) {
              log.debug(
                `[compaction-diag] decision diagId=${overflowDiagId} branch=give_up ` +
                  `isCompactionFailure=${isCompactionFailure} hasOversizedToolResults=unknown ` +
                  `attempt=${overflowCompactionAttempts} maxAttempts=${MAX_OVERFLOW_COMPACTION_ATTEMPTS}`,
              );
            }
            const kind = isCompactionFailure ? "compaction_failure" : "context_overflow";
            const overflowRecoveryText =
              "Context overflow: prompt too large for the model. " +
              "Try /reset (or /new) to start a fresh session, or use a larger-context model.";
            log.warn(
              `[context-overflow-recovery] exhausted provider overflow recovery for ${provider}/${modelId}; ` +
                `livenessState=blocked suggestedAction=reset_or_new kind=${kind}`,
            );
            setTerminalLifecycleMeta({
              replayInvalid: resolveReplayInvalidForAttempt(),
              livenessState: "blocked",
            });
            return {
              payloads: [
                {
                  text: overflowRecoveryText,
                  isError: true,
                },
              ],
              meta: {
                durationMs: Date.now() - started,
                agentMeta: buildErrorAgentMeta({
                  sessionId: sessionIdUsed,
                  sessionFile: activeSessionFile,
                  provider,
                  model: model.id,
                  ...outerContextTokenMeta,
                  usageAccumulator,
                  lastRunPromptUsage,
                  lastAssistant: attemptAssistant,
                  lastTurnTotal,
                }),
                systemPromptReport: attempt.systemPromptReport,
                finalAssistantVisibleText: overflowRecoveryText,
                finalAssistantRawText: overflowRecoveryText,
                finalPromptText: attempt.finalPromptText,
                replayInvalid: resolveReplayInvalidForAttempt(),
                livenessState: "blocked",
                error: { kind, message: errorText },
              },
            };
          }

          if (promptErrorSource === "hook:before_agent_run" && !aborted) {
            const errorText = formatErrorMessage(promptError);
            const replayInvalid = resolveReplayInvalidForAttempt();
            setTerminalLifecycleMeta({
              replayInvalid,
              livenessState: "blocked",
            });
            return {
              payloads: [{ text: errorText, isError: true }],
              meta: {
                durationMs: Date.now() - started,
                agentMeta: buildErrorAgentMeta({
                  sessionId: sessionIdUsed,
                  sessionFile: activeSessionFile,
                  provider,
                  model: model.id,
                  ...outerContextTokenMeta,
                  usageAccumulator,
                  lastRunPromptUsage,
                  lastAssistant: attemptAssistant,
                  lastTurnTotal,
                }),
                systemPromptReport: attempt.systemPromptReport,
                finalAssistantVisibleText: errorText,
                finalAssistantRawText: errorText,
                finalPromptText: undefined,
                replayInvalid,
                livenessState: "blocked",
                error: { kind: "hook_block", message: errorText },
              },
            };
          }

          const hasRecoverableCodexAppServerTimeoutOutcome = Boolean(
            attempt.codexAppServerFailure && attempt.promptTimeoutOutcome,
          );
          let shouldSurfaceCodexCompletionTimeout = false;
          if (promptError && promptErrorSource !== "compaction" && attempt.codexAppServerFailure) {
            // Retry replay-safe Codex app-server failures.
            const codexAppServerRecoveryRetry = resolveCodexAppServerRecoveryRetry({
              attempt,
              retryAvailable: codexAppServerRecoveryRetryAvailable,
            });
            if (codexAppServerRecoveryRetry.retry) {
              throwIfAborted();
              codexAppServerRecoveryRetries += 1;
              suppressNextUserMessagePersistence = true;
              log.warn(
                `codex app-server replay-safe failure; retrying once ` +
                  `failureKind=${attempt.codexAppServerFailure?.kind} ` +
                  `runId=${params.runId} sessionId=${params.sessionId}`,
              );
              continue;
            }
            // Completion-idle timeouts are timeout outcomes even when the
            // app-server transport is not retryable, or the retry was exhausted.
            shouldSurfaceCodexCompletionTimeout =
              attempt.codexAppServerFailure?.kind === "turn_completion_idle_timeout" &&
              attempt.timedOut;
            if (
              attempt.codexAppServerFailure &&
              !hasRecoverableCodexAppServerTimeoutOutcome &&
              !shouldSurfaceCodexCompletionTimeout
            ) {
              throw toErrorObject(promptError, "Prompt failed");
            }
          }

          if (
            promptError &&
            !aborted &&
            promptErrorSource !== "compaction" &&
            !hasRecoverableCodexAppServerTimeoutOutcome &&
            !shouldSurfaceCodexCompletionTimeout
          ) {
            // Normalize wrapped errors (e.g. abort-wrapped RESOURCE_EXHAUSTED) into
            // FailoverError so rate-limit classification works even for nested shapes.
            //
            // promptErrorSource === "compaction" means the model call already completed and the
            // abort happened only while waiting for compaction/retry cleanup. Retrying from here
            // would replay that completed tool turn as a fresh prompt attempt.
            const promptAuthMode = lastProfileId
              ? attemptAuthProfileStore.profiles?.[lastProfileId]?.type
              : undefined;
            const normalizedPromptFailover = coerceToFailoverError(promptError, {
              provider: activeErrorContext.provider,
              model: activeErrorContext.model,
              profileId: lastProfileId,
              authMode: promptAuthMode,
              sessionId: sessionIdUsed,
              lane: globalLane,
            });
            const promptErrorDetails = normalizedPromptFailover
              ? describeFailoverError(normalizedPromptFailover)
              : describeFailoverError(promptError);
            if (normalizedPromptFailover?.suspend) {
              suspendForFailure({
                cfg: params.config,
                agentDir,
                sessionId: activeSessionId ?? params.sessionId,
                reason: resolveSessionSuspensionReason(normalizedPromptFailover.reason),
                failedProvider: normalizedPromptFailover.provider ?? provider,
                failedModel: normalizedPromptFailover.model ?? modelId,
              });
            }
            const errorText = promptErrorDetails.message || formatErrorMessage(promptError);
            if (await maybeRefreshRuntimeAuthForAuthError(errorText, runtimeAuthRetry)) {
              authRetryPending = true;
              continue;
            }
            // Handle role ordering errors with a user-friendly message
            if (/incorrect role information|roles must alternate/i.test(errorText)) {
              setTerminalLifecycleMeta({
                replayInvalid: resolveReplayInvalidForAttempt(),
                livenessState: "blocked",
              });
              return {
                payloads: [
                  {
                    text:
                      "Message ordering conflict - please try again. " +
                      "If this persists, use /new to start a fresh session.",
                    isError: true,
                  },
                ],
                meta: {
                  durationMs: Date.now() - started,
                  agentMeta: buildErrorAgentMeta({
                    sessionId: sessionIdUsed,
                    sessionFile: activeSessionFile,
                    provider,
                    model: model.id,
                    ...outerContextTokenMeta,
                    usageAccumulator,
                    lastRunPromptUsage,
                    lastAssistant: attemptAssistant,
                    lastTurnTotal,
                  }),
                  systemPromptReport: attempt.systemPromptReport,
                  finalPromptText: attempt.finalPromptText,
                  replayInvalid: resolveReplayInvalidForAttempt(),
                  livenessState: "blocked",
                  error: { kind: "role_ordering", message: errorText },
                },
              };
            }
            // Handle image size errors with a user-friendly message (no retry needed)
            const imageSizeError = parseImageSizeError(errorText);
            if (imageSizeError) {
              const maxMb = imageSizeError.maxMb;
              const maxMbLabel =
                typeof maxMb === "number" && Number.isFinite(maxMb) ? `${maxMb}` : null;
              const maxBytesHint = maxMbLabel ? ` (max ${maxMbLabel}MB)` : "";
              setTerminalLifecycleMeta({
                replayInvalid: resolveReplayInvalidForAttempt(),
                livenessState: "blocked",
              });
              return {
                payloads: [
                  {
                    text:
                      `Image too large for the model${maxBytesHint}. ` +
                      "Please compress or resize the image and try again.",
                    isError: true,
                  },
                ],
                meta: {
                  durationMs: Date.now() - started,
                  agentMeta: buildErrorAgentMeta({
                    sessionId: sessionIdUsed,
                    sessionFile: activeSessionFile,
                    provider,
                    model: model.id,
                    ...outerContextTokenMeta,
                    usageAccumulator,
                    lastRunPromptUsage,
                    lastAssistant: attemptAssistant,
                    lastTurnTotal,
                  }),
                  systemPromptReport: attempt.systemPromptReport,
                  finalPromptText: attempt.finalPromptText,
                  replayInvalid: resolveReplayInvalidForAttempt(),
                  livenessState: "blocked",
                  error: { kind: "image_size", message: errorText },
                },
              };
            }
            const promptFailoverReason =
              promptErrorDetails.reason ?? classifyFailoverReason(errorText, { provider });
            const promptProfileFailureReason = resolveRunAuthProfileFailureReason(
              promptFailoverReason,
              {
                providerStarted: promptErrorSource === "prompt",
                transientRateLimit:
                  promptFailoverReason === "rate_limit" && isShortWindowRateLimitMessage(errorText),
              },
            );
            const promptFailoverFailure =
              promptFailoverReason !== null || isFailoverErrorMessage(errorText, { provider });
            const promptTimeoutFallbackSafe =
              promptErrorSource === "prompt" &&
              promptFailoverReason === "timeout" &&
              !attempt.codexAppServerFailure &&
              attempt.promptTimeoutOutcome?.replayInvalid !== true &&
              attempt.replayMetadata.replaySafe;
            // Capture the failing profile before auth-profile rotation mutates `lastProfileId`.
            const failedPromptProfileId = lastProfileId;
            const logPromptFailoverDecision = createFailoverDecisionLogger({
              stage: "prompt",
              runId: params.runId,
              rawError: errorText,
              failoverReason: promptFailoverReason,
              profileFailureReason: promptProfileFailureReason,
              provider,
              model: modelId,
              sourceProvider: provider,
              sourceModel: modelId,
              profileId: failedPromptProfileId,
              fallbackConfigured,
              aborted,
            });
            if (promptFailoverReason === "rate_limit") {
              maybeEscalateRateLimitProfileFallback({
                failoverProvider: provider,
                failoverModel: modelId,
                logFallbackDecision: logPromptFailoverDecision,
              });
            }
            let promptFailoverDecision = resolveRunFailoverDecision({
              stage: "prompt",
              aborted,
              externalAbort,
              fallbackConfigured,
              failoverFailure: promptFailoverFailure,
              failoverReason: promptFailoverReason,
              harnessOwnsTransport: pluginHarnessOwnsTransport,
              promptTimeoutFallbackSafe,
              timedOutByRunBudget,
              profileRotated: false,
            });
            if (
              promptFailoverDecision.action === "rotate_profile" &&
              (await advanceAttemptAuthProfile())
            ) {
              if (failedPromptProfileId && promptProfileFailureReason) {
                void maybeMarkAuthProfileFailure({
                  profileId: failedPromptProfileId,
                  reason: promptProfileFailureReason,
                  modelId,
                }).catch((err: unknown) => {
                  log.warn(`prompt profile failure mark failed: ${String(err)}`);
                });
              }
              traceAttempts.push({
                provider,
                model: modelId,
                result: promptFailoverReason === "timeout" ? "timeout" : "rotate_profile",
                ...(promptFailoverReason ? { reason: promptFailoverReason } : {}),
                stage: "prompt",
              });
              lastRetryFailoverReason = mergeRetryFailoverReason({
                previous: lastRetryFailoverReason,
                failoverReason: promptFailoverReason,
              });
              logPromptFailoverDecision("rotate_profile");
              await maybeBackoffBeforeOverloadFailover(promptFailoverReason);
              continue;
            }
            if (promptFailoverDecision.action === "rotate_profile") {
              promptFailoverDecision = resolveRunFailoverDecision({
                stage: "prompt",
                aborted,
                externalAbort,
                fallbackConfigured,
                failoverFailure: promptFailoverFailure,
                failoverReason: promptFailoverReason,
                harnessOwnsTransport: pluginHarnessOwnsTransport,
                promptTimeoutFallbackSafe,
                timedOutByRunBudget,
                profileRotated: true,
              });
            }
            if (failedPromptProfileId && promptProfileFailureReason) {
              try {
                await maybeMarkAuthProfileFailure({
                  profileId: failedPromptProfileId,
                  reason: promptProfileFailureReason,
                  modelId,
                });
              } catch (err) {
                log.warn(`prompt profile failure mark failed: ${String(err)}`);
              }
            }
            const fallbackThinking = pickFallbackThinkingLevel({
              message: errorText,
              attempted: attemptedThinking,
            });
            if (fallbackThinking) {
              log.warn(
                `unsupported thinking level for ${provider}/${modelId}; retrying with ${fallbackThinking}`,
              );
              thinkLevel = fallbackThinking;
              continue;
            }
            // Throw FailoverError for prompt-side failover reasons when fallbacks
            // are configured so outer model fallback can continue on overload,
            // rate-limit, auth, or billing failures.
            if (promptFailoverDecision.action === "fallback_model") {
              const fallbackReason = promptFailoverDecision.reason ?? "unknown";
              const status = resolveFailoverStatus(fallbackReason);
              traceAttempts.push({
                provider,
                model: modelId,
                result: promptFailoverReason === "timeout" ? "timeout" : "fallback_model",
                reason: fallbackReason,
                stage: "prompt",
                ...(typeof status === "number" ? { status } : {}),
              });
              logPromptFailoverDecision("fallback_model", { status });
              await maybeBackoffBeforeOverloadFailover(promptFailoverReason);
              throw (
                normalizedPromptFailover ??
                new FailoverError(errorText, {
                  reason: fallbackReason,
                  provider,
                  model: modelId,
                  profileId: lastProfileId,
                  authMode: promptAuthMode,
                  sessionId: sessionIdUsed,
                  lane: globalLane,
                  status,
                })
              );
            }
            if (promptFailoverDecision.action === "surface_error") {
              traceAttempts.push({
                provider,
                model: modelId,
                result: promptFailoverReason === "timeout" ? "timeout" : "surface_error",
                ...(promptFailoverReason ? { reason: promptFailoverReason } : {}),
                stage: "prompt",
              });
              logPromptFailoverDecision("surface_error");
            }
            throw toErrorObject(promptError, "Prompt failed");
          }

          const fallbackThinking = pickFallbackThinkingLevel({
            message: attemptAssistant?.errorMessage,
            attempted: attemptedThinking,
          });
          if (fallbackThinking && !aborted) {
            log.warn(
              `unsupported thinking level for ${provider}/${modelId}; retrying with ${fallbackThinking}`,
            );
            thinkLevel = fallbackThinking;
            continue;
          }

          const authFailure = isAuthAssistantError(attemptAssistant);
          const rateLimitFailure = isRateLimitAssistantError(attemptAssistant);
          const billingFailure = isBillingAssistantError(attemptAssistant);
          const failoverFailure = isFailoverAssistantError(attemptAssistant);
          const assistantFailoverReason = classifyAssistantFailoverReason(attemptAssistant);
          const assistantProviderStarted =
            Boolean(currentAttemptAssistant?.provider) ||
            idleTimedOut ||
            (timedOut && !timedOutDuringCompaction && !timedOutDuringToolExecution);
          const assistantProfileFailoverReason =
            assistantFailoverReason ??
            (assistantProviderStarted && (timedOut || idleTimedOut) ? "timeout" : null);
          const assistantProfileFailureReason = resolveRunAuthProfileFailureReason(
            assistantProfileFailoverReason,
            {
              providerStarted: assistantProviderStarted,
              transientRateLimit:
                assistantProfileFailoverReason === "rate_limit" &&
                isShortWindowRateLimitMessage(attemptAssistant?.errorMessage),
            },
          );
          const cloudCodeAssistFormatError = attempt.cloudCodeAssistFormatError;
          const imageDimensionError = parseImageDimensionError(
            attemptAssistant?.errorMessage ?? "",
          );
          // The shared runtime wraps interrupted streams as a timeout. Retry that
          // wrapper only for reasoning-only output so ordinary timeouts keep failover.
          const genericUnknownReasoningError =
            assistantFailoverReason === "timeout" &&
            isGenericUnknownStreamErrorMessage(attemptAssistant?.errorMessage ?? "") &&
            Boolean(attemptAssistant && hasOnlyAssistantReasoningContent(attemptAssistant));
          const silentErrorRetryReason =
            assistantFailoverReason === null ||
            genericUnknownReasoningError ||
            assistantFailoverReason === "no_error_details" ||
            assistantFailoverReason === "unclassified" ||
            assistantFailoverReason === "unknown" ||
            assistantFailoverReason === "server_error";
          // Retry replay-safe non-visible provider errors before assistant
          // failover surfaces them as terminal provider failures.
          if (
            !authFailure &&
            !rateLimitFailure &&
            !billingFailure &&
            !cloudCodeAssistFormatError &&
            !imageDimensionError &&
            !aborted &&
            !promptError &&
            !timedOut &&
            silentErrorRetryReason &&
            shouldRetrySilentErrorAssistantTurn({ attempt, assistant: attemptAssistant }) &&
            emptyErrorRetries < MAX_EMPTY_ERROR_RETRIES
          ) {
            emptyErrorRetries += 1;
            log.warn(
              `[empty-error-retry] stopReason=error non-visible-output; resubmitting ` +
                `attempt=${emptyErrorRetries}/${MAX_EMPTY_ERROR_RETRIES} ` +
                `provider=${attemptAssistant?.provider ?? provider} ` +
                `model=${attemptAssistant?.model ?? model.id} ` +
                `sessionKey=${params.sessionKey ?? params.sessionId}`,
            );
            continue;
          }
          // Capture the failing profile before auth-profile rotation mutates `lastProfileId`.
          const failedAssistantProfileId = lastProfileId;
          const logAssistantFailoverDecision = createFailoverDecisionLogger({
            stage: "assistant",
            runId: params.runId,
            rawError: attemptAssistant?.errorMessage?.trim(),
            failoverReason: assistantFailoverReason,
            profileFailureReason: assistantProfileFailureReason,
            provider: activeErrorContext.provider,
            model: activeErrorContext.model,
            sourceProvider: attemptAssistant?.provider ?? provider,
            sourceModel: attemptAssistant?.model ?? modelId,
            profileId: failedAssistantProfileId,
            fallbackConfigured,
            timedOut,
            aborted,
          });

          if (
            authFailure &&
            (await maybeRefreshRuntimeAuthForAuthError(
              attemptAssistant?.errorMessage ?? "",
              runtimeAuthRetry,
            ))
          ) {
            authRetryPending = true;
            continue;
          }
          if (imageDimensionError && lastProfileId) {
            const details = [
              imageDimensionError.messageIndex !== undefined
                ? `message=${imageDimensionError.messageIndex}`
                : null,
              imageDimensionError.contentIndex !== undefined
                ? `content=${imageDimensionError.contentIndex}`
                : null,
              imageDimensionError.maxDimensionPx !== undefined
                ? `limit=${imageDimensionError.maxDimensionPx}px`
                : null,
            ]
              .filter(Boolean)
              .join(" ");
            log.warn(
              `Profile ${lastProfileId} rejected image payload${details ? ` (${details})` : ""}.`,
            );
          }

          const assistantFailoverDecision = resolveRunFailoverDecision({
            stage: "assistant",
            allowFormatRetry: cloudCodeAssistFormatError,
            aborted,
            externalAbort,
            fallbackConfigured,
            failoverFailure,
            failoverReason: assistantFailoverReason,
            timedOut,
            idleTimedOut,
            timedOutDuringCompaction,
            timedOutDuringToolExecution,
            harnessOwnsTransport: pluginHarnessOwnsTransport,
            timedOutByRunBudget,
            profileRotated: false,
          });
          const assistantFailoverOutcome = await handleAssistantFailover({
            initialDecision: assistantFailoverDecision,
            aborted,
            externalAbort,
            fallbackConfigured,
            failoverFailure,
            failoverReason: assistantFailoverReason,
            timedOut,
            idleTimedOut,
            timedOutDuringCompaction,
            timedOutDuringToolExecution,
            timedOutByRunBudget,
            allowSameModelIdleTimeoutRetry:
              timedOut &&
              idleTimedOut &&
              !timedOutDuringCompaction &&
              !fallbackConfigured &&
              canRestartForLiveSwitch &&
              sameModelIdleTimeoutRetries < MAX_SAME_MODEL_IDLE_TIMEOUT_RETRIES,
            allowSameModelRateLimitRetry: rateLimitProfileRotations < rateLimitProfileRotationLimit,
            assistantProfileFailureReason,
            lastProfileId,
            modelId,
            provider,
            activeErrorContext,
            lastAssistant: attemptAssistant,
            config: params.config,
            sessionKey: params.sessionKey ?? params.sessionId,
            authFailure,
            rateLimitFailure,
            billingFailure,
            authMode: lastProfileId
              ? attemptAuthProfileStore.profiles?.[lastProfileId]?.type
              : undefined,
            cloudCodeAssistFormatError,
            isProbeSession,
            overloadProfileRotations,
            overloadProfileRotationLimit,
            previousRetryFailoverReason: lastRetryFailoverReason,
            logAssistantFailoverDecision,
            warn: (message) => log.warn(message),
            maybeMarkAuthProfileFailure,
            maybeEscalateRateLimitProfileFallback,
            maybeRetrySameModelRateLimit,
            maybeBackoffBeforeOverloadFailover,
            advanceAuthProfile: advanceAttemptAuthProfile,
          });
          overloadProfileRotations = assistantFailoverOutcome.overloadProfileRotations;
          if (assistantFailoverOutcome.action === "retry") {
            const retryTraceResult =
              assistantFailoverOutcome.retryKind === "same_model_rate_limit"
                ? "same_model_rate_limit"
                : assistantFailoverOutcome.retryKind === "same_model_idle_timeout" ||
                    assistantFailoverReason === "timeout"
                  ? "timeout"
                  : "rotate_profile";
            traceAttempts.push({
              provider: activeErrorContext.provider,
              model: activeErrorContext.model,
              result: retryTraceResult,
              ...(assistantFailoverReason ? { reason: assistantFailoverReason } : {}),
              stage: "assistant",
            });
            if (assistantFailoverOutcome.retryKind === "same_model_idle_timeout") {
              sameModelIdleTimeoutRetries += 1;
            }
            if (assistantFailoverOutcome.retryKind !== "same_model_rate_limit") {
              consecutiveSameModelRateLimitRetries = resolveNextSameModelRateLimitRetryCount({
                retriesSoFar: consecutiveSameModelRateLimitRetries,
                retriedSameModelRateLimit: false,
              });
            }
            lastRetryFailoverReason = assistantFailoverOutcome.lastRetryFailoverReason;
            continue;
          }
          consecutiveSameModelRateLimitRetries = resolveNextSameModelRateLimitRetryCount({
            retriesSoFar: consecutiveSameModelRateLimitRetries,
            retriedSameModelRateLimit: false,
          });
          if (assistantFailoverOutcome.action === "throw") {
            traceAttempts.push({
              provider: activeErrorContext.provider,
              model: activeErrorContext.model,
              result:
                assistantFailoverReason === "timeout"
                  ? "timeout"
                  : assistantFailoverDecision.action === "fallback_model"
                    ? "fallback_model"
                    : "error",
              ...(assistantFailoverReason ? { reason: assistantFailoverReason } : {}),
              stage: "assistant",
              ...(typeof assistantFailoverOutcome.error.status === "number"
                ? { status: assistantFailoverOutcome.error.status }
                : {}),
            });
            if (assistantFailoverOutcome.error.suspend) {
              suspendForFailure({
                cfg: params.config,
                agentDir,
                sessionId: activeSessionId ?? params.sessionId,
                reason: resolveSessionSuspensionReason(assistantFailoverOutcome.error.reason),
                failedProvider: assistantFailoverOutcome.error.provider ?? provider,
                failedModel: assistantFailoverOutcome.error.model ?? modelId,
              });
            }
            throw assistantFailoverOutcome.error;
          }
          const usageMeta = buildUsageAgentMetaFields({
            usageAccumulator,
            lastAssistantUsage: attemptAssistant?.usage as UsageLike | undefined,
            lastRunPromptUsage,
            lastTurnTotal,
          });
          const reportedModelRef = resolveReportedModelRef({
            provider,
            model: model.id,
            assistant: attemptAssistant,
          });
          const agentMeta: EmbeddedAgentMeta = {
            sessionId: sessionIdUsed,
            sessionFile: sessionFileUsed,
            provider: reportedModelRef.provider,
            model: reportedModelRef.model,
            ...outerContextTokenMeta,
            agentHarnessId: attempt.agentHarnessId,
            usage: usageMeta.usage,
            lastCallUsage: usageMeta.lastCallUsage,
            promptTokens: usageMeta.promptTokens,
            ...(lastContextBudgetStatus ? { contextBudgetStatus: lastContextBudgetStatus } : {}),
            compactionCount: autoCompactionCount > 0 ? autoCompactionCount : undefined,
            compactionTokensAfter: lastCompactionTokensAfter,
          };
          const finalAssistantVisibleText = resolveFinalAssistantVisibleText(attemptAssistant);
          const finalAssistantRawText = resolveFinalAssistantRawText(attemptAssistant);

          const payloads = buildEmbeddedRunPayloads({
            assistantTexts: attempt.assistantTexts,
            assistantMessageIndex: attempt.lastAssistantTextMessageIndex,
            assistantTranscriptOwned: attempt.assistantTranscriptOwned,
            toolMetas: attempt.toolMetas,
            lastAssistant: attempt.lastAssistant,
            currentAssistant: currentAttemptAssistant ?? null,
            lastToolError: attempt.lastToolError,
            config: params.config,
            isCronTrigger: params.trigger === "cron",
            isHeartbeatTrigger: params.trigger === "heartbeat",
            sessionKey: params.sessionKey ?? params.sessionId,
            provider: activeErrorContext.provider,
            model: activeErrorContext.model,
            authMode: lastProfileId
              ? attemptAuthProfileStore.profiles?.[lastProfileId]?.type
              : undefined,
            verboseLevel: params.verboseLevel,
            reasoningLevel: params.reasoningLevel,
            thinkingLevel: params.thinkLevel,
            toolResultFormat: resolvedToolResultFormat,
            suppressToolErrorWarnings: params.suppressToolErrorWarnings,
            inlineToolResultsAllowed: false,
            didSendViaMessagingTool: attempt.didSendViaMessagingTool,
            didDeliverSourceReplyViaMessageTool:
              attempt.didDeliverSourceReplyViaMessageTool === true,
            messagingToolSourceReplyPayloads: attempt.messagingToolSourceReplyPayloads,
            sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
            agentId: params.agentId,
            runId: params.runId,
            runAborted: aborted,
            didSendDeterministicApprovalPrompt: attempt.didSendDeterministicApprovalPrompt,
            heartbeatToolResponse: attempt.heartbeatToolResponse,
          });
          const payloadsWithToolMedia = mergeAttemptToolMediaPayloads({
            payloads,
            toolMediaUrls: attempt.toolMediaUrls,
            toolAudioAsVoice: attempt.toolAudioAsVoice,
            toolTrustedLocalMedia: attempt.toolTrustedLocalMedia,
            sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
          });
          const timedOutDuringPrompt =
            timedOut && !timedOutDuringCompaction && !timedOutDuringToolExecution;
          const finalAssistantStopReason = (attemptAssistant?.stopReason ?? "")
            .trim()
            .toLowerCase();
          const recoveredFinalAssistantTextAfterPromptTimeout =
            timedOutDuringPrompt &&
            ["completed", "end_turn", "stop"].includes(finalAssistantStopReason)
              ? (finalAssistantVisibleText ?? finalAssistantRawText)?.trim()
              : undefined;
          const payloadAlreadyContainsRecoveredFinalAssistant =
            recoveredFinalAssistantTextAfterPromptTimeout
              ? (payloadsWithToolMedia ?? []).some(
                  (payload) =>
                    payload?.isError !== true &&
                    payload?.isReasoning !== true &&
                    typeof payload.text === "string" &&
                    payload.text.trim() === recoveredFinalAssistantTextAfterPromptTimeout,
                )
              : false;
          const recoveredFinalAssistantPayloadsAfterPromptTimeout =
            recoveredFinalAssistantTextAfterPromptTimeout &&
            !payloadAlreadyContainsRecoveredFinalAssistant
              ? [{ text: recoveredFinalAssistantTextAfterPromptTimeout }]
              : undefined;
          const hasSuccessfulFinalAssistantAfterPromptTimeout =
            timedOutDuringPrompt &&
            Boolean(
              payloadAlreadyContainsRecoveredFinalAssistant ||
              recoveredFinalAssistantPayloadsAfterPromptTimeout?.length,
            );
          const hasPartialAssistantTextAfterPromptTimeout =
            timedOutDuringPrompt &&
            (attempt.assistantTexts ?? []).some((text) => text.trim().length > 0) &&
            !attempt.clientToolCalls &&
            !attempt.yieldDetected &&
            !attempt.didSendViaMessagingTool &&
            !attempt.didSendDeterministicApprovalPrompt &&
            !attempt.lastToolError &&
            (attempt.toolMetas?.length ?? 0) === 0;
          const attemptToolSummary = buildTraceToolSummary({
            toolMetas: attempt.toolMetas,
            fallbackHadFailure: Boolean(attempt.lastToolError),
          });
          const failureSignal = resolveEmbeddedRunFailureSignal({
            trigger: params.trigger,
            lastToolError: attempt.lastToolError,
          });

          // Timeout aborts can leave the run without payloads or with only a
          // partial assistant fragment. Emit an explicit timeout error instead,
          // preserving any tool payloads that succeeded before the timeout.
          if (
            timedOutDuringPrompt &&
            !hasSuccessfulFinalAssistantAfterPromptTimeout &&
            (shouldSurfaceCodexCompletionTimeout || !hasMessagingToolDeliveryEvidence(attempt))
          ) {
            const defaultTimeoutText = idleTimedOut
              ? "The model did not produce a response before the model idle timeout. " +
                "Please try again, or increase `models.providers.<id>.timeoutSeconds` for slow local or self-hosted providers. " +
                "If `agents.defaults.timeoutSeconds` or a run-specific timeout is lower, raise that ceiling too; provider timeouts cannot extend the whole agent run."
              : "Request timed out before a response was generated. " +
                "Please try again, or increase `agents.defaults.timeoutSeconds` in your config.";
            const promptTimeoutMessage = attempt.promptTimeoutOutcome?.message?.trim();
            const timeoutText = promptTimeoutMessage || defaultTimeoutText;
            const replayInvalid =
              attempt.promptTimeoutOutcome?.replayInvalid ?? resolveReplayInvalidForAttempt(null);
            const livenessState =
              attempt.promptTimeoutOutcome?.livenessState ??
              resolveRunLivenessState({
                payloadCount: hasPartialAssistantTextAfterPromptTimeout ? 0 : payloads.length,
                aborted,
                timedOut,
                attempt,
                incompleteTurnText: null,
              });
            const timeoutPhase = attempt.promptTimeoutOutcome?.timeoutPhase ?? "provider";
            const providerStarted = attempt.promptTimeoutOutcome?.providerStarted ?? true;
            setTerminalLifecycleMeta({
              replayInvalid,
              livenessState,
              timeoutPhase,
              providerStarted,
            });
            return {
              payloads: [
                ...(hasPartialAssistantTextAfterPromptTimeout ? [] : payloadsWithToolMedia || []),
                {
                  text: timeoutText,
                  isError: true,
                },
              ],
              meta: {
                durationMs: Date.now() - started,
                agentMeta,
                aborted,
                systemPromptReport: attempt.systemPromptReport,
                finalPromptText: attempt.finalPromptText,
                finalAssistantVisibleText,
                finalAssistantRawText,
                replayInvalid,
                livenessState,
                timeoutPhase,
                providerStarted,
                // Completion-idle recovery is exhausted here. Keep this terminal so
                // model fallback cannot replay a potentially still-active Codex turn.
                ...(shouldSurfaceCodexCompletionTimeout
                  ? {
                      error: {
                        kind: "incomplete_turn" as const,
                        message: timeoutText,
                        fallbackSafe: false,
                      },
                    }
                  : {}),
                toolSummary: attemptToolSummary,
                ...(failureSignal ? { failureSignal } : {}),
                agentHarnessResultClassification: attempt.agentHarnessResultClassification,
              },
              didSendViaMessagingTool: attempt.didSendViaMessagingTool,
              didDeliverSourceReplyViaMessageTool:
                attempt.didDeliverSourceReplyViaMessageTool === true,
              didSendDeterministicApprovalPrompt: attempt.didSendDeterministicApprovalPrompt,
              messagingToolSentTexts: attempt.messagingToolSentTexts,
              messagingToolSentMediaUrls: attempt.messagingToolSentMediaUrls,
              messagingToolSentTargets: attempt.messagingToolSentTargets,
              messagingToolSourceReplyPayloads: attempt.messagingToolSourceReplyPayloads,
              heartbeatToolResponse: attempt.heartbeatToolResponse,
              successfulCronAdds: attempt.successfulCronAdds,
              acceptedSessionSpawns: attempt.acceptedSessionSpawns,
            };
          }

          const silentToolResultReplyPayload = resolveSilentToolResultReplyPayload({
            isCronTrigger: params.trigger === "cron",
            payloadCount: payloadsWithToolMedia?.length ?? 0,
            aborted,
            timedOut,
            attempt,
          });
          const payloadsForTerminalPath = recoveredFinalAssistantPayloadsAfterPromptTimeout
            ? recoveredFinalAssistantPayloadsAfterPromptTimeout
            : payloadsWithToolMedia?.length
              ? payloadsWithToolMedia
              : silentToolResultReplyPayload
                ? [silentToolResultReplyPayload]
                : payloadsWithToolMedia;
          const payloadCount = payloadsForTerminalPath?.length ?? 0;
          const emptyAssistantReplyIsSilent = shouldTreatEmptyAssistantReplyAsSilent({
            allowEmptyAssistantReplyAsSilent: params.allowEmptyAssistantReplyAsSilent,
            payloadCount,
            aborted,
            timedOut,
            attempt,
          });
          const nextReasoningOnlyRetryInstruction = emptyAssistantReplyIsSilent
            ? null
            : resolveReasoningOnlyRetryInstruction({
                provider: activeErrorContext.provider,
                modelId: activeErrorContext.model,
                modelApi: effectiveModel.api,
                executionContract,
                aborted,
                timedOut,
                attempt,
              });
          const nextEmptyResponseRetryInstruction = emptyAssistantReplyIsSilent
            ? null
            : resolveEmptyResponseRetryInstruction({
                provider: activeErrorContext.provider,
                modelId: activeErrorContext.model,
                modelApi: effectiveModel.api,
                executionContract,
                payloadCount,
                aborted,
                timedOut,
                attempt,
              });
          if (
            nextReasoningOnlyRetryInstruction &&
            reasoningOnlyRetryAttempts < maxReasoningOnlyRetryAttempts
          ) {
            reasoningOnlyRetryAttempts += 1;
            reasoningOnlyRetryInstruction = nextReasoningOnlyRetryInstruction;
            log.warn(
              `reasoning-only assistant turn detected: runId=${params.runId} sessionId=${params.sessionId} ` +
                `provider=${activeErrorContext.provider}/${activeErrorContext.model} — retrying ${reasoningOnlyRetryAttempts}/${maxReasoningOnlyRetryAttempts} ` +
                `with visible-answer continuation`,
            );
            continue;
          }
          const reasoningOnlyRetriesExhausted =
            nextReasoningOnlyRetryInstruction &&
            reasoningOnlyRetryAttempts >= maxReasoningOnlyRetryAttempts;
          if (
            !emptyAssistantReplyIsSilent &&
            shouldRetryMissingAssistantTurn({
              payloadCount,
              aborted,
              promptError,
              timedOut,
              attempt,
            }) &&
            missingAssistantRetryAttempts < MAX_MISSING_ASSISTANT_RETRIES
          ) {
            missingAssistantRetryAttempts += 1;
            log.warn(
              `missing assistant terminal message detected: runId=${params.runId} sessionId=${params.sessionId} ` +
                `provider=${activeErrorContext.provider}/${activeErrorContext.model} — retrying ${missingAssistantRetryAttempts}/${MAX_MISSING_ASSISTANT_RETRIES} with same prompt`,
            );
            continue;
          }
          if (
            !nextReasoningOnlyRetryInstruction &&
            nextEmptyResponseRetryInstruction &&
            emptyResponseRetryAttempts < maxEmptyResponseRetryAttempts
          ) {
            emptyResponseRetryAttempts += 1;
            emptyResponseRetryInstruction = nextEmptyResponseRetryInstruction;
            log.warn(
              `empty response detected: runId=${params.runId} sessionId=${params.sessionId} ` +
                `provider=${activeErrorContext.provider}/${activeErrorContext.model} — retrying ${emptyResponseRetryAttempts}/${maxEmptyResponseRetryAttempts} ` +
                `with visible-answer continuation`,
            );
            continue;
          }
          const incompleteTurnText = emptyAssistantReplyIsSilent
            ? null
            : resolveIncompleteTurnPayloadText({
                payloadCount,
                aborted,
                externalAbort,
                timedOut,
                attempt,
              });
          const incompleteTurnFallbackSafe = Boolean(
            incompleteTurnText &&
            !aborted &&
            !timedOut &&
            !promptError &&
            !attempt.lastToolError &&
            !hasAttemptTerminalState(attempt) &&
            !accumulatedReplayState.hadPotentialSideEffects,
          );
          const terminalToolPresentation = incompleteTurnFallbackSafe
            ? readAttemptTerminalToolPresentation()
            : undefined;
          if (
            !emptyAssistantReplyIsSilent &&
            attemptCompactionCount > 0 &&
            payloadCount === 0 &&
            !aborted &&
            !promptError &&
            !timedOut &&
            !attempt.clientToolCalls &&
            !attempt.yieldDetected &&
            !attempt.didSendDeterministicApprovalPrompt &&
            !attempt.lastToolError &&
            !accumulatedReplayState.hadPotentialSideEffects &&
            compactionContinuationRetryAttempts < 1
          ) {
            compactionContinuationRetryAttempts += 1;
            compactionContinuationRetryInstruction = COMPACTION_CONTINUATION_RETRY_INSTRUCTION;
            log.warn(
              `compaction interrupted visible final answer: runId=${params.runId} sessionId=${params.sessionId} ` +
                `compactions=${attemptCompactionCount} — retrying ${compactionContinuationRetryAttempts}/1 with compacted-transcript continuation`,
            );
            postCompactionGuard.armPostCompaction();
            continue;
          }
          compactionContinuationRetryInstruction = null;
          if (reasoningOnlyRetriesExhausted && !finalAssistantVisibleText) {
            log.warn(
              `reasoning-only retries exhausted: runId=${params.runId} sessionId=${params.sessionId} ` +
                `provider=${activeErrorContext.provider}/${activeErrorContext.model} attempts=${reasoningOnlyRetryAttempts}/${maxReasoningOnlyRetryAttempts} — surfacing incomplete-turn error`,
            );
          }
          if (reasoningOnlyRetriesExhausted && !finalAssistantVisibleText) {
            const incompletePayloadText = terminalToolPresentation
              ? terminalToolPresentation.concat(
                  "\n\n",
                  "⚠️ Agent couldn't generate a response. Please try again.",
                )
              : "⚠️ Agent couldn't generate a response. Please try again.";
            const replayInvalid = resolveReplayInvalidForAttempt(incompletePayloadText);
            const livenessState = resolveRunLivenessState({
              payloadCount: 0,
              aborted,
              timedOut,
              attempt,
              incompleteTurnText: incompletePayloadText,
            });
            setTerminalLifecycleMeta({
              replayInvalid,
              livenessState,
            });
            if (lastProfileId) {
              await maybeMarkAuthProfileFailure({
                profileId: lastProfileId,
                reason: assistantProfileFailureReason,
                modelId,
              });
            }
            return {
              payloads: [
                {
                  text: incompletePayloadText,
                  isError: true,
                },
              ],
              meta: {
                durationMs: Date.now() - started,
                agentMeta,
                aborted,
                systemPromptReport: attempt.systemPromptReport,
                finalPromptText: attempt.finalPromptText,
                finalAssistantVisibleText,
                finalAssistantRawText,
                replayInvalid,
                livenessState,
                error: {
                  kind: "incomplete_turn",
                  message: "Agent couldn't generate a response.",
                  fallbackSafe: incompleteTurnFallbackSafe,
                  terminalPresentation: terminalToolPresentation !== undefined,
                },
                toolSummary: attemptToolSummary,
                ...(failureSignal ? { failureSignal } : {}),
                agentHarnessResultClassification: attempt.agentHarnessResultClassification,
              },
              didSendViaMessagingTool: attempt.didSendViaMessagingTool,
              didDeliverSourceReplyViaMessageTool:
                attempt.didDeliverSourceReplyViaMessageTool === true,
              didSendDeterministicApprovalPrompt: attempt.didSendDeterministicApprovalPrompt,
              messagingToolSentTexts: attempt.messagingToolSentTexts,
              messagingToolSentMediaUrls: attempt.messagingToolSentMediaUrls,
              messagingToolSentTargets: attempt.messagingToolSentTargets,
              messagingToolSourceReplyPayloads: attempt.messagingToolSourceReplyPayloads,
              heartbeatToolResponse: attempt.heartbeatToolResponse,
              successfulCronAdds: attempt.successfulCronAdds,
              acceptedSessionSpawns: attempt.acceptedSessionSpawns,
            };
          }
          if (
            !nextReasoningOnlyRetryInstruction &&
            nextEmptyResponseRetryInstruction &&
            emptyResponseRetryAttempts >= maxEmptyResponseRetryAttempts
          ) {
            log.warn(
              `empty response retries exhausted: runId=${params.runId} sessionId=${params.sessionId} ` +
                `provider=${activeErrorContext.provider}/${activeErrorContext.model} attempts=${emptyResponseRetryAttempts}/${maxEmptyResponseRetryAttempts} — surfacing incomplete-turn error`,
            );
          }
          if (incompleteTurnText) {
            const replayInvalid = resolveReplayInvalidForAttempt(incompleteTurnText);
            const livenessState = resolveRunLivenessState({
              payloadCount,
              aborted,
              timedOut,
              attempt,
              incompleteTurnText,
            });
            setTerminalLifecycleMeta({
              replayInvalid,
              livenessState,
            });
            const incompleteStopReason =
              attempt.currentAttemptAssistant?.stopReason ?? attempt.lastAssistant?.stopReason;
            const replayMetadata = resolveAttemptReplayMetadata(attempt);
            log.warn(
              `incomplete turn detected: runId=${params.runId} sessionId=${params.sessionId} ` +
                `provider=${activeErrorContext.provider}/${activeErrorContext.model} ` +
                `stopReason=${incompleteStopReason ?? "missing"} hasLastAssistant=${attempt.lastAssistant ? "yes" : "no"} ` +
                `hasCurrentAttemptAssistant=${attempt.currentAttemptAssistant ? "yes" : "no"} payloads=${payloadCount} ` +
                `tools=${attempt.toolMetas?.length ?? 0} replaySafe=${replayMetadata.replaySafe ? "yes" : "no"} ` +
                `compactions=${attemptCompactionCount} reasoningRetries=${reasoningOnlyRetryAttempts}/${maxReasoningOnlyRetryAttempts} ` +
                `emptyRetries=${emptyResponseRetryAttempts}/${maxEmptyResponseRetryAttempts} ` +
                `missingAssistantRetries=${missingAssistantRetryAttempts}/${MAX_MISSING_ASSISTANT_RETRIES} — ` +
                (terminalToolPresentation
                  ? "surfacing tool-authored terminal presentation"
                  : "surfacing error to user"),
            );

            // Mark the failing profile for cooldown so multi-profile setups
            // rotate away from the exhausted credential on the next turn.
            if (lastProfileId) {
              await maybeMarkAuthProfileFailure({
                profileId: lastProfileId,
                reason: assistantProfileFailureReason,
                modelId,
              });
            }

            return {
              payloads: [
                {
                  text: terminalToolPresentation
                    ? terminalToolPresentation.concat("\n\n", incompleteTurnText)
                    : incompleteTurnText,
                  isError: true,
                },
              ],
              meta: {
                durationMs: Date.now() - started,
                agentMeta,
                aborted,
                systemPromptReport: attempt.systemPromptReport,
                finalPromptText: attempt.finalPromptText,
                finalAssistantVisibleText,
                finalAssistantRawText,
                replayInvalid,
                livenessState,
                error: {
                  kind: "incomplete_turn",
                  message: "Agent couldn't generate a response.",
                  fallbackSafe: incompleteTurnFallbackSafe,
                  terminalPresentation: terminalToolPresentation !== undefined,
                },
                toolSummary: attemptToolSummary,
                ...(failureSignal ? { failureSignal } : {}),
                agentHarnessResultClassification: attempt.agentHarnessResultClassification,
              },
              didSendViaMessagingTool: attempt.didSendViaMessagingTool,
              didDeliverSourceReplyViaMessageTool:
                attempt.didDeliverSourceReplyViaMessageTool === true,
              didSendDeterministicApprovalPrompt: attempt.didSendDeterministicApprovalPrompt,
              messagingToolSentTexts: attempt.messagingToolSentTexts,
              messagingToolSentMediaUrls: attempt.messagingToolSentMediaUrls,
              messagingToolSentTargets: attempt.messagingToolSentTargets,
              messagingToolSourceReplyPayloads: attempt.messagingToolSourceReplyPayloads,
              heartbeatToolResponse: attempt.heartbeatToolResponse,
              successfulCronAdds: attempt.successfulCronAdds,
              acceptedSessionSpawns: attempt.acceptedSessionSpawns,
            };
          }

          const beforeAgentFinalizeRevisionReason = attempt.beforeAgentFinalizeRevisionReason;
          const shouldHonorBeforeAgentFinalizeRevision =
            !aborted &&
            !promptError &&
            !timedOut &&
            !attempt.clientToolCalls &&
            !attempt.yieldDetected &&
            !emptyAssistantReplyIsSilent;
          if (beforeAgentFinalizeRevisionReason && shouldHonorBeforeAgentFinalizeRevision) {
            beforeAgentFinalizeRevisionAttempts += 1;
            nextAttemptPromptOverride = buildBeforeAgentFinalizeRetryPrompt(
              beforeAgentFinalizeRevisionReason,
            );
            suppressNextUserMessagePersistence = true;
            reasoningOnlyRetryInstruction = null;
            emptyResponseRetryInstruction = null;
            compactionContinuationRetryInstruction = null;
            log.warn(
              `before_agent_finalize requested one more pass: ` +
                `runId=${params.runId} sessionId=${params.sessionId} ` +
                `attempt=${beforeAgentFinalizeRevisionAttempts}/${MAX_BEFORE_AGENT_FINALIZE_REVISIONS}`,
            );
            continue;
          }

          log.debug(
            `embedded run done: runId=${params.runId} sessionId=${params.sessionId} durationMs=${Date.now() - started} aborted=${aborted}`,
          );
          markAuthProfileSuccessAfterRun();
          const replayInvalid = resolveReplayInvalidForAttempt(null);
          const livenessState = attempt.yieldDetected
            ? "paused"
            : resolveRunLivenessState({
                payloadCount,
                aborted,
                timedOut,
                attempt,
                incompleteTurnText: null,
              });
          const stopReason = attempt.clientToolCalls
            ? "tool_calls"
            : attempt.yieldDetected
              ? "end_turn"
              : (attemptAssistant?.stopReason as string | undefined);
          const terminalPayloads = emptyAssistantReplyIsSilent
            ? [{ text: SILENT_REPLY_TOKEN }]
            : payloadsForTerminalPath;
          setTerminalLifecycleMeta({
            replayInvalid,
            livenessState,
            stopReason,
            yielded: attempt.yieldDetected === true,
          });
          return {
            payloads: terminalPayloads?.length ? terminalPayloads : undefined,
            ...(attempt.diagnosticTrace
              ? { diagnosticTrace: freezeDiagnosticTraceContext(attempt.diagnosticTrace) }
              : {}),
            meta: {
              durationMs: Date.now() - started,
              agentMeta,
              aborted,
              systemPromptReport: attempt.systemPromptReport,
              finalPromptText: attempt.finalPromptText,
              finalAssistantVisibleText,
              finalAssistantRawText,
              replayInvalid,
              livenessState,
              agentHarnessResultClassification: attempt.agentHarnessResultClassification,
              ...(attempt.yieldDetected ? { yielded: true } : {}),
              ...(emptyAssistantReplyIsSilent
                ? { terminalReplyKind: "silent-empty" as const }
                : {}),
              // Handle client tool calls (OpenResponses hosted tools)
              // Propagate the LLM stop reason so callers (lifecycle events,
              // ACP bridge) can distinguish end_turn from max_tokens.
              stopReason,
              pendingToolCalls: attempt.clientToolCalls?.map((call) => ({
                id: randomBytes(5).toString("hex").slice(0, 9),
                name: call.name,
                arguments: JSON.stringify(call.params),
              })),
              executionTrace: {
                winnerProvider: reportedModelRef.provider,
                winnerModel: reportedModelRef.model,
                attempts:
                  traceAttempts.length > 0 || attemptAssistant?.provider || attemptAssistant?.model
                    ? [
                        ...traceAttempts,
                        {
                          provider: reportedModelRef.provider,
                          model: reportedModelRef.model,
                          result: "success",
                          stage: "assistant",
                        },
                      ]
                    : undefined,
                fallbackUsed: traceAttempts.some(traceAttemptUsesFallback),
                runner: "embedded",
              },
              requestShaping: {
                ...(lastProfileId ? { authMode: "auth-profile" } : {}),
                ...(thinkLevel ? { thinking: thinkLevel } : {}),
                ...(params.reasoningLevel ? { reasoning: params.reasoningLevel } : {}),
                ...(params.verboseLevel ? { verbose: params.verboseLevel } : {}),
                ...(params.blockReplyBreak ? { blockStreaming: params.blockReplyBreak } : {}),
              },
              toolSummary: attemptToolSummary,
              ...(failureSignal ? { failureSignal } : {}),
              completion: {
                ...(stopReason ? { stopReason } : {}),
                ...(stopReason ? { finishReason: stopReason } : {}),
                ...(stopReason?.toLowerCase().includes("refusal") ? { refusal: true } : {}),
              },
              contextManagement:
                autoCompactionCount > 0 ? { lastTurnCompactions: autoCompactionCount } : undefined,
            },
            didSendViaMessagingTool: attempt.didSendViaMessagingTool,
            didDeliverSourceReplyViaMessageTool:
              attempt.didDeliverSourceReplyViaMessageTool === true,
            didSendDeterministicApprovalPrompt: attempt.didSendDeterministicApprovalPrompt,
            messagingToolSentTexts: attempt.messagingToolSentTexts,
            messagingToolSentMediaUrls: attempt.messagingToolSentMediaUrls,
            messagingToolSentTargets: attempt.messagingToolSentTargets,
            messagingToolSourceReplyPayloads: attempt.messagingToolSourceReplyPayloads,
            heartbeatToolResponse: attempt.heartbeatToolResponse,
            successfulCronAdds: attempt.successfulCronAdds,
            acceptedSessionSpawns: attempt.acceptedSessionSpawns,
          };
        }
      } finally {
        if (params.isFinalFallbackAttempt !== false) {
          await maybeEmitFastModeAutoResetBestEffort();
        }
        forgetPromptBuildDrainCacheForRun(params.runId);
        stopRuntimeAuthRefreshTimer();
        await runAgentCleanupStep({
          runId: params.runId,
          sessionId: params.sessionId,
          step: "context-engine-dispose",
          log,
          cleanup: async () => {
            await contextEngine.dispose?.();
          },
        });
        if (params.cleanupBundleMcpOnRunEnd === true) {
          await runAgentCleanupStep({
            runId: params.runId,
            sessionId: params.sessionId,
            step: "bundle-mcp-retire",
            log,
            cleanup: async () => {
              const onError = (errorLocal: unknown, sessionId: string) => {
                log.warn(
                  `bundle-mcp cleanup failed after run for ${sessionId}: ${formatErrorMessage(errorLocal)}`,
                );
              };
              const retiredBySessionKey = await retireSessionMcpRuntimeForSessionKey({
                sessionKey: params.sessionKey,
                reason: "embedded-run-end",
                onError,
              });
              if (!retiredBySessionKey) {
                await retireSessionMcpRuntime({
                  sessionId: params.sessionId,
                  reason: "embedded-run-end",
                  onError,
                });
              }
            },
          });
        }
      }
    });
  });
}

function resolveAuthProfileStateProvider(
  store: AuthProfileStore,
  profileId: string,
  fallbackProvider: string,
): string {
  const profileProvider = store.profiles?.[profileId]?.provider?.trim();
  if (profileProvider) {
    return profileProvider;
  }
  const idProvider = profileId.split(":", 1)[0]?.trim();
  return idProvider || fallbackProvider;
}

export const testing = {
  EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS,
  resolveEmbeddedRunLaneTimeoutMs,
};
export { testing as __testing };
