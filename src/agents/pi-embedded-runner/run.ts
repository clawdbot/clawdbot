import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import { ensureContextEnginesInitialized } from "../../context-engine/init.js";
import { resolveContextEngine } from "../../context-engine/registry.js";
import { emitAgentPlanEvent } from "../../infra/agent-events.js";
import { sleepWithAbort } from "../../infra/backoff.js";
import { freezeDiagnosticTraceContext } from "../../infra/diagnostic-trace-context.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { resolveProviderAuthProfileId } from "../../plugins/provider-runtime.js";
import { enqueueCommandInLane } from "../../process/command-queue.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { sanitizeForLog } from "../../terminal/ansi.js";
import { resolveUserPath } from "../../utils.js";
import { isMarkdownCapableMessageChannel } from "../../utils/message-channel.js";
import { resolveOpenClawAgentDir } from "../agent-paths.js";
import {
  hasConfiguredModelFallbacks,
  resolveAgentExecutionContract,
  resolveSessionAgentIds,
  resolveAgentWorkspaceDir,
} from "../agent-scope.js";
import {
  type AuthProfileFailureReason,
  type AuthProfileStore,
  markAuthProfileFailure,
  resolveAuthProfileEligibility,
  markAuthProfileGood,
  markAuthProfileUsed,
} from "../auth-profiles.js";
import {
  resolveSessionKeyForRequest,
  resolveStoredSessionKeyForSessionId,
} from "../command/session.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import { isStrictAgenticExecutionContractActive } from "../execution-contract.js";
import {
  coerceToFailoverError,
  describeFailoverError,
  FailoverError,
  resolveFailoverStatus,
} from "../failover-error.js";
import { selectAgentHarness } from "../harness/selection.js";
import { LiveSessionModelSwitchError } from "../live-model-switch-error.js";
import { shouldSwitchToLiveModel, clearLiveModelSwitchPending } from "../live-model-switch.js";
import {
  applyAuthHeaderOverride,
  applyLocalNoAuthHeaderOverride,
  ensureAuthProfileStore,
  type ResolvedProviderAuth,
  resolveAuthProfileOrder,
  shouldPreferExplicitConfigApiKeyAuth,
} from "../model-auth.js";
import { ensureOpenClawModelsJson } from "../models-config.js";
import {
  retireSessionMcpRuntime,
  retireSessionMcpRuntimeForSessionKey,
} from "../pi-bundle-mcp-tools.js";
import {
  classifyFailoverReason,
  extractObservedOverflowTokenCount,
  type FailoverReason,
  formatAssistantErrorText,
  isAuthAssistantError,
  isBillingAssistantError,
  isCompactionFailureError,
  isFailoverAssistantError,
  isFailoverErrorMessage,
  isLikelyContextOverflowError,
  isRateLimitAssistantError,
  parseImageDimensionError,
  parseImageSizeError,
  pickFallbackThinkingLevel,
} from "../pi-embedded-helpers.js";
import { resolveProviderIdForAuth } from "../provider-auth-aliases.js";
import { ensureRuntimePluginsLoaded } from "../runtime-plugins.js";
import { derivePromptTokens, normalizeUsage, type UsageLike } from "../usage.js";
import { redactRunIdentifier, resolveRunWorkspaceDir } from "../workspace-run.js";
import { runPostCompactionSideEffects } from "./compaction-hooks.js";
import { buildEmbeddedCompactionRuntimeContext } from "./compaction-runtime-context.js";
import { runContextEngineMaintenance } from "./context-engine-maintenance.js";
import { resolveGlobalLane, resolveSessionLane } from "./lanes.js";
import { log } from "./logger.js";
import { resolveModelAsync } from "./model.js";
import { createEmbeddedRunReplayState, observeReplayMetadata } from "./replay-state.js";
import { handleAssistantFailover } from "./run/assistant-failover.js";
import { createEmbeddedRunAuthController } from "./run/auth-controller.js";
import { runEmbeddedAttemptWithBackend } from "./run/backend.js";
import { createFailoverDecisionLogger } from "./run/failover-observation.js";
import { mergeRetryFailoverReason, resolveRunFailoverDecision } from "./run/failover-policy.js";
import {
  buildErrorAgentMeta,
  buildUsageAgentMetaFields,
  createCompactionDiagId,
  resolveActiveErrorContext,
  resolveFinalAssistantRawText,
  resolveFinalAssistantVisibleText,
  resolveMaxRunRetryIterations,
  resolveOverloadFailoverBackoffMs,
  resolveOverloadProfileRotationLimit,
  resolveRateLimitProfileRotationLimit,
  type RuntimeAuthState,
  scrubAnthropicRefusalMagic,
} from "./run/helpers.js";
import {
  DEFAULT_EMPTY_RESPONSE_RETRY_LIMIT,
  DEFAULT_REASONING_ONLY_RETRY_LIMIT,
  resolveAckExecutionFastPathInstruction,
  extractPlanningOnlyPlanDetails,
  resolveEmptyResponseRetryInstruction,
  resolveIncompleteTurnPayloadText,
  resolvePlanningOnlyRetryLimit,
  resolvePlanningOnlyRetryInstruction,
  resolveReasoningOnlyRetryInstruction,
  STRICT_AGENTIC_BLOCKED_TEXT,
  resolveReplayInvalidFlag,
  resolveRunLivenessState,
} from "./run/incomplete-turn.js";
import type { RunEmbeddedPiAgentParams } from "./run/params.js";
import { buildEmbeddedRunPayloads } from "./run/payloads.js";
import { handleRetryLimitExhaustion } from "./run/retry-limit.js";
import {
  buildBeforeModelResolveAttachments,
  resolveEffectiveRuntimeModel,
  resolveHookModelSelection,
} from "./run/setup.js";
import { mergeAttemptToolMediaPayloads } from "./run/tool-media-payloads.js";
import {
  resolveLiveToolResultMaxChars,
  sessionLikelyHasOversizedToolResults,
  truncateOversizedToolResultsInSession,
} from "./tool-result-truncation.js";
import type {
  EmbeddedPiAgentMeta,
  EmbeddedPiRunResult,
  TraceAttempt,
  ToolSummaryTrace,
  EmbeddedRunLivenessState,
} from "./types.js";
import { createUsageAccumulator, mergeUsageIntoAccumulator } from "./usage-accumulator.js";

type ApiKeyInfo = ResolvedProviderAuth;

const MAX_SAME_MODEL_IDLE_TIMEOUT_RETRIES = 1;

function createEmptyAuthProfileStore(): AuthProfileStore {
  return {
    version: 1,
    profiles: {},
  };
}

function buildTraceToolSummary(params: {
  toolMetas: Array<{ toolName: string; meta?: string }>;
  hadFailure: boolean;
}): ToolSummaryTrace | undefined {
  if (params.toolMetas.length === 0) {
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
  return {
    calls: params.toolMetas.length,
    tools,
    failures: params.hadFailure ? 1 : 0,
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
  config: RunEmbeddedPiAgentParams["config"];
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
        });
    return normalizeOptionalString(resolved.sessionKey);
  } catch (err) {
    log.warn(
      `[backfillSessionKey] Failed to resolve sessionKey for sessionId=${redactRunIdentifier(sanitizeForLog(params.sessionId))}: ${formatErrorMessage(err)}`,
    );
    return undefined;
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

export async function runEmbeddedPiAgent(
  params: RunEmbeddedPiAgentParams,
): Promise<EmbeddedPiRunResult> {
  // Resolve sessionKey early so all downstream consumers (hooks, LCM, compaction)
  // receive a non-null key even when callers omit it. See #60552.
  const effectiveSessionKey = backfillSessionKey({
    config: params.config,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
  });
  if (effectiveSessionKey !== params.sessionKey) {
    params = { ...params, sessionKey: effectiveSessionKey };
  }
  const sessionLane = resolveSessionLane(params.sessionKey?.trim() || params.sessionId);
  const globalLane = resolveGlobalLane(params.lane);
  const enqueueGlobal =
    params.enqueue ?? ((task, opts) => enqueueCommandInLane(globalLane, task, opts));
  const enqueueSession =
    params.enqueue ?? ((task, opts) => enqueueCommandInLane(sessionLane, task, opts));
  const channelHint = params.messageChannel ?? params.messageProvider;
  const resolvedToolResultFormat =
    params.toolResultFormat ??
    (channelHint
      ? isMarkdownCapableMessageChannel(channelHint)
        ? "markdown"
        : "plain"
      : "markdown");
  const isProbeSession = params.sessionId?.startsWith("probe-") ?? false;

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

  throwIfAborted();

  return enqueueSession(() => {
    throwIfAborted();
    return enqueueGlobal(async () => {
      throwIfAborted();
      const started = Date.now();
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
          `[workspace-fallback] caller=runEmbeddedPiAgent reason=${workspaceResolution.fallbackReason} run=${params.runId} session=${redactedSessionId} sessionKey=${redactedSessionKey} agent=${workspaceResolution.agentId} workspace=${redactedWorkspace}`,
        );
      }
      ensureRuntimePluginsLoaded({
        config: params.config,
        workspaceDir: resolvedWorkspace,
        allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
      });

      let provider = (params.provider ?? DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER;
      let modelId = (params.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
      const agentDir = params.agentDir ?? resolveOpenClawAgentDir();
      const normalizedSessionKey = params.sessionKey?.trim();
      const fallbackConfigured = hasConfiguredModelFallbacks({
        cfg: params.config,
        agentId: params.agentId,
        sessionKey: normalizedSessionKey,
      });
      const resolvedSessionKey = normalizedSessionKey;
      const hookRunner = getGlobalHookRunner();
      const hookCtx = {
        runId: params.runId,
        agentId: workspaceResolution.agentId,
        sessionKey: resolvedSessionKey,
        sessionId: params.sessionId,
        workspaceDir: resolvedWorkspace,
        modelProviderId: provider,
        modelId,
        messageProvider: params.messageProvider ?? undefined,
        trigger: params.trigger,
        channelId: params.messageChannel ?? params.messageProvider ?? undefined,
      };
      if (params.trigger === "cron" && hookRunner?.hasHooks("before_agent_reply")) {
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
      }

      const hookSelection = await resolveHookModelSelection({
        prompt: params.prompt,
        attachments: buildBeforeModelResolveAttachments(params.images),
        provider,
        modelId,
        hookRunner,
        hookContext: hookCtx,
      });
      provider = hookSelection.provider;
      modelId = hookSelection.modelId;
      const legacyBeforeAgentStartResult = hookSelection.legacyBeforeAgentStartResult;
      const agentHarness = selectAgentHarness({
        provider,
        modelId,
        config: params.config,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        agentHarnessId: params.agentHarnessId,
      });
      const pluginHarnessOwnsTransport = agentHarness.id !== "pi";
      if (!pluginHarnessOwnsTransport) {
        await ensureOpenClawModelsJson(params.config, agentDir);
      }

      const { model, error, authStorage, modelRegistry } = await resolveModelAsync(
        provider,
        modelId,
        agentDir,
        params.config,
        // Plugin harnesses may expose synthetic providers that PI cannot
        // discover safely; resolve their model metadata without touching PI
        // auth/model stores.
        { skipPiDiscovery: pluginHarnessOwnsTransport },
      );
      if (!model) {
        throw new FailoverError(error ?? `Unknown model: ${provider}/${modelId}`, {
          reason: "model_not_found",
          provider,
          model: modelId,
        });
      }
      let runtimeModel = model;

      const resolvedRuntimeModel = resolveEffectiveRuntimeModel({
        cfg: params.config,
        provider,
        modelId,
        runtimeModel,
      });
      const ctxInfo = resolvedRuntimeModel.ctxInfo;
      let effectiveModel = resolvedRuntimeModel.effectiveModel;

      const authStore = pluginHarnessOwnsTransport
        ? createEmptyAuthProfileStore()
        : ensureAuthProfileStore(agentDir, {
            allowKeychainPrompt: false,
          });
      const preferredProfileId = params.authProfileId?.trim();
      let lockedProfileId = params.authProfileIdSource === "user" ? preferredProfileId : undefined;
      if (lockedProfileId) {
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
      if (lockedProfileId) {
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
        : resolveAuthProfileOrder({
            cfg: params.config,
            store: authStore,
            provider,
            preferredProfile: preferredProfileId,
          });
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
      const profileCandidates = lockedProfileId
        ? [lockedProfileId]
        : providerOrderedProfiles.length > 0
          ? providerOrderedProfiles
          : [undefined];
      let profileIndex = 0;
      const traceAttempts: TraceAttempt[] = [];

      const initialThinkLevel = params.thinkLevel ?? "off";
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

      // Plugin harnesses own their model transport/auth. Running PI's generic
      // auth bootstrap here can turn synthetic provider markers into real
      // vendor-token refresh attempts before the plugin gets control.
      if (!pluginHarnessOwnsTransport) {
        await initializeAuthProfile();
      }
      const { sessionAgentId } = resolveSessionAgentIds({
        sessionKey: params.sessionKey,
        config: params.config,
        agentId: params.agentId,
      });
      const configuredExecutionContract =
        resolveAgentExecutionContract(params.config, sessionAgentId) ?? "default";
      const strictAgenticActive = isStrictAgenticExecutionContractActive({
        config: params.config,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        provider,
        modelId,
      });
      const executionContract = strictAgenticActive ? "strict-agentic" : "default";
      const maxPlanningOnlyRetryAttempts = resolvePlanningOnlyRetryLimit(executionContract);
      const maxReasoningOnlyRetryAttempts = DEFAULT_REASONING_ONLY_RETRY_LIMIT;
      const maxEmptyResponseRetryAttempts = DEFAULT_EMPTY_RESPONSE_RETRY_LIMIT;

      const MAX_TIMEOUT_COMPACTION_ATTEMPTS = 2;
      const MAX_OVERFLOW_COMPACTION_ATTEMPTS = 3;
      const MAX_RUN_LOOP_ITERATIONS = resolveMaxRunRetryIterations(profileCandidates.length);
      let overflowCompactionAttempts = 0;
      let toolResultTruncationAttempted = false;
      let bootstrapPromptWarningSignaturesSeen =
        params.bootstrapPromptWarningSignaturesSeen ??
        (params.bootstrapPromptWarningSignature ? [params.bootstrapPromptWarningSignature] : []);
      const usageAccumulator = createUsageAccumulator();
      let lastRunPromptUsage: ReturnType<typeof normalizeUsage> | undefined;
      let autoCompactionCount = 0;
      let runLoopIterations = 0;
      let overloadProfileRotations = 0;
      let planningOnlyRetryAttempts = 0;
      let reasoningOnlyRetryAttempts = 0;
      let emptyResponseRetryAttempts = 0;
      let sameModelIdleTimeoutRetries = 0;
      let lastRetryFailoverReason: FailoverReason | null = null;
      let planningOnlyRetryInstruction: string | null = null;
      let reasoningOnlyRetryInstruction: string | null = null;
      let emptyResponseRetryInstruction: string | null = null;
      const ackExecutionFastPathInstruction = resolveAckExecutionFastPathInstruction({
        provider,
        modelId,
        prompt: params.prompt,
      });
      let rateLimitProfileRotations = 0;
      let timeoutCompactionAttempts = 0;
      // Silent-error retry: non-strict-agentic models (e.g. ollama/glm-5.1) can
      // end a turn with stopReason="error" + zero output tokens, producing no
      // user-visible text. The existing empty-response retry is gated on
      // isStrictAgenticSupportedProviderModel (gpt-5 only). This is an
      // orthogonal, model-agnostic resubmission.
      const MAX_EMPTY_ERROR_RETRIES = 3;
      let emptyErrorRetries = 0;
      const overloadFailoverBackoffMs = resolveOverloadFailoverBackoffMs(params.config);
      const overloadProfileRotationLimit = resolveOverloadProfileRotationLimit(params.config);
      const rateLimitProfileRotationLimit = resolveRateLimitProfileRotationLimit(params.config);
      const maybeEscalateRateLimitProfileFallback = (params: {
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
        params.logFallbackDecision("fallback_model", { status });
        throw new FailoverError(
          "The AI service is temporarily rate-limited. Please try again in a moment.",
          {
            reason: "rate_limit",
            provider: params.failoverProvider,
            model: params.failoverModel,
            profileId: lastProfileId,
            status,
          },
        );
      };
      const maybeMarkAuthProfileFailure = async (failure: {
        profileId?: string;
        reason?: AuthProfileFailureReason | null;
        config?: RunEmbeddedPiAgentParams["config"];
        agentDir?: RunEmbeddedPiAgentParams["agentDir"];
        modelId?: string;
      }) => {
        const { profileId, reason } = failure;
        if (!profileId || !reason || reason === "timeout") {
          return;
        }
        await markAuthProfileFailure({
          store: authStore,
          profileId,
          reason,
          cfg: params.config,
          agentDir,
          runId: params.runId,
          modelId: failure.modelId,
        });
      };
      const resolveAuthProfileFailureReason = (
        failoverReason: FailoverReason | null,
      ): AuthProfileFailureReason | null => {
        // Timeouts are transport/model-path failures, not auth health signals,
        // so they should not persist auth-profile failure state.
        if (!failoverReason || failoverReason === "timeout") {
          return null;
        }
        return failoverReason;
      };
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
      // Resolve the context engine once and reuse across retries to avoid
      // repeated initialization/connection overhead per attempt.
      ensureContextEnginesInitialized();
      const contextEngine = await resolveContextEngine(params.config);
      try {
        // When the engine owns compaction, compactEmbeddedPiSessionDirect is
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
              { messageCount: -1, sessionFile: params.sessionFile },
              hookCtx,
            );
          } catch (hookErr) {
            log.warn(`before_compaction hook failed during ${reason}: ${String(hookErr)}`);
          }
        };
        const runOwnsCompactionAfterHook = async (
          reason: string,
          compactResult: Awaited<ReturnType<typeof contextEngine.compact>>,
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
                sessionFile: params.sessionFile,
              },
              hookCtx,
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
                sessionId: params.sessionId,
                provider,
                model: model.id,
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

          const basePrompt =
            provider === "anthropic" ? scrubAnthropicRefusalMagic(params.prompt) : params.prompt;
          const promptAdditions = [
            ackExecutionFastPathInstruction,
            planningOnlyRetryInstruction,
            reasoningOnlyRetryInstruction,
            emptyResponseRetryInstruction,
          ].filter(
            (value): value is string => typeof value === "string" && value.trim().length > 0,
          );
          const prompt =
            promptAdditions.length > 0
              ? `${basePrompt}\n\n${promptAdditions.join("\n\n")}`
              : basePrompt;
          let resolvedStreamApiKey: string | undefined;
          if (!runtimeAuthState && apiKeyInfo) {
            resolvedStreamApiKey = (apiKeyInfo as ApiKeyInfo).apiKey;
          }

          const attempt = await runEmbeddedAttemptWithBackend({
            sessionId: params.sessionId,
            sessionKey: resolvedSessionKey,
            sandboxSessionKey: params.sandboxSessionKey,
            trigger: params.trigger,
            memoryFlushWritePath: params.memoryFlushWritePath,
            messageChannel: params.messageChannel,
            messageProvider: params.messageProvider,
            agentAccountId: params.agentAccountId,
            messageTo: params.messageTo,
            messageThreadId: params.messageThreadId,
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
            currentChannelId: params.currentChannelId,
            currentThreadTs: params.currentThreadTs,
            currentMessageId: params.currentMessageId,
            replyToMode: params.replyToMode,
            hasRepliedRef: params.hasRepliedRef,
            sessionFile: params.sessionFile,
            workspaceDir: resolvedWorkspace,
            agentDir,
            config: params.config,
            allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
            contextEngine,
            contextTokenBudget: ctxInfo.tokens,
            skillsSnapshot: params.skillsSnapshot,
            prompt,
            images: params.images,
            imageOrder: params.imageOrder,
            clientTools: params.clientTools,
            disableTools: params.disableTools,
            provider,
            modelId,
            // Use the harness selected before model/auth setup for the actual
            // attempt too. Otherwise plugin-owned transports can skip PI auth
            // bootstrap but drift back to PI when the attempt is created.
            agentHarnessId: agentHarness.id,
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
            modelRegistry,
            agentId: workspaceResolution.agentId,
            legacyBeforeAgentStartResult,
            thinkLevel,
            fastMode: params.fastMode,
            verboseLevel: params.verboseLevel,
            reasoningLevel: params.reasoningLevel,
            toolResultFormat: resolvedToolResultFormat,
            execOverrides: params.execOverrides,
            bashElevated: params.bashElevated,
            timeoutMs: params.timeoutMs,
            runId: params.runId,
            abortSignal: params.abortSignal,
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
            onReasoningEnd: params.onReasoningEnd,
            onToolResult: params.onToolResult,
            onAgentEvent: params.onAgentEvent,
            extraSystemPrompt: params.extraSystemPrompt,
            inputProvenance: params.inputProvenance,
            streamParams: params.streamParams,
            ownerNumbers: params.ownerNumbers,
            enforceFinalTag: params.enforceFinalTag,
            silentExpected: params.silentExpected,
            bootstrapContextMode: params.bootstrapContextMode,
            bootstrapContextRunKind: params.bootstrapContextRunKind,
            toolsAllow: params.toolsAllow,
            disableMessageTool: params.disableMessageTool,
            forceMessageTool: params.forceMessageTool,
            requireExplicitMessageTarget: params.requireExplicitMessageTarget,
            internalEvents: params.internalEvents,
            bootstrapPromptWarningSignaturesSeen,
            bootstrapPromptWarningSignature:
              bootstrapPromptWarningSignaturesSeen[bootstrapPromptWarningSignaturesSeen.length - 1],
          });

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
            lastAssistant: sessionLastAssistant,
            currentAttemptAssistant,
          } = attempt;
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
          const attemptUsage = attempt.attemptUsage ?? lastAssistantUsage;
          mergeUsageIntoAccumulator(usageAccumulator, attemptUsage);
          // Keep prompt size from the latest model call so session totalTokens
          // reflects current context usage, not accumulated tool-loop usage.
          lastRunPromptUsage = lastAssistantUsage ?? attemptUsage;
          lastTurnTotal = lastAssistantUsage?.total ?? attemptUsage?.total;
          const attemptCompactionCount = Math.max(0, attempt.compactionCount ?? 0);
          autoCompactionCount += attemptCompactionCount;
          const activeErrorContext = resolveActiveErrorContext({
            provider,
            model: modelId,
            assistant: currentAttemptAssistant ?? sessionLastAssistant,
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
          const formattedAssistantErrorText = sessionLastAssistant
            ? formatAssistantErrorText(sessionLastAssistant, {
                cfg: params.config,
                sessionKey: resolvedSessionKey ?? params.sessionId,
                provider: activeErrorContext.provider,
                model: activeErrorContext.model,
              })
            : undefined;
          const assistantErrorText =
            sessionLastAssistant?.stopReason === "error"
              ? sessionLastAssistant.errorMessage?.trim() || formattedAssistantErrorText
              : undefined;
          const canRestartForLiveSwitch =
            !attempt.didSendViaMessagingTool &&
            !attempt.didSendDeterministicApprovalPrompt &&
            !attempt.lastToolError &&
            attempt.toolMetas.length === 0 &&
            attempt.assistantTexts.length === 0;
          if (preflightRecovery?.handled) {
            log.info(
              `[context-overflow-precheck] early recovery route=${preflightRecovery.route} ` +
                `completed for ${provider}/${modelId}; retrying prompt`,
            );
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
          // ── Timeout-triggered compaction ──────────────────────────────────
          // When the LLM times out with high context usage, compact before
          // retrying to break the death spiral of repeated timeouts.
          if (timedOut && !timedOutDuringCompaction) {
            // Only consider prompt-side tokens here. API totals include output
            // tokens, which can make a long generation look like high context
            // pressure even when the prompt itself was small.
            const lastTurnPromptTokens = derivePromptTokens(lastRunPromptUsage);
            const tokenUsedRatio =
              lastTurnPromptTokens != null && ctxInfo.tokens > 0
                ? lastTurnPromptTokens / ctxInfo.tokens
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
              let timeoutCompactResult: Awaited<ReturnType<typeof contextEngine.compact>>;
              await runOwnsCompactionBeforeHook("timeout recovery");
              try {
                const timeoutCompactionRuntimeContext = {
                  ...buildEmbeddedCompactionRuntimeContext({
                    sessionKey: params.sessionKey,
                    messageChannel: params.messageChannel,
                    messageProvider: params.messageProvider,
                    agentAccountId: params.agentAccountId,
                    currentChannelId: params.currentChannelId,
                    currentThreadTs: params.currentThreadTs,
                    currentMessageId: params.currentMessageId,
                    authProfileId: lastProfileId,
                    workspaceDir: resolvedWorkspace,
                    agentDir,
                    config: params.config,
                    skillsSnapshot: params.skillsSnapshot,
                    senderIsOwner: params.senderIsOwner,
                    senderId: params.senderId,
                    provider,
                    modelId,
                    thinkLevel,
                    reasoningLevel: params.reasoningLevel,
                    bashElevated: params.bashElevated,
                    extraSystemPrompt: params.extraSystemPrompt,
                    ownerNumbers: params.ownerNumbers,
                  }),
                  ...(attempt.promptCache ? { promptCache: attempt.promptCache } : {}),
                  runId: params.runId,
                  trigger: "timeout_recovery",
                  diagId: timeoutDiagId,
                  attempt: timeoutCompactionAttempts,
                  maxAttempts: MAX_TIMEOUT_COMPACTION_ATTEMPTS,
                };
                timeoutCompactResult = await contextEngine.compact({
                  sessionId: params.sessionId,
                  sessionKey: params.sessionKey,
                  sessionFile: params.sessionFile,
                  tokenBudget: ctxInfo.tokens,
                  force: true,
                  compactionTarget: "budget",
                  runtimeContext: timeoutCompactionRuntimeContext,
                });
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
              await runOwnsCompactionAfterHook("timeout recovery", timeoutCompactResult);
              if (timeoutCompactResult.compacted) {
                autoCompactionCount += 1;
                if (contextEngine.info.ownsCompaction === true) {
                  await runPostCompactionSideEffects({
                    config: params.config,
                    sessionKey: params.sessionKey,
                    sessionFile: params.sessionFile,
                  });
                }
                log.info(
                  `[timeout-compaction] compaction succeeded for ${provider}/${modelId}; retrying prompt`,
                );
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

          if (contextOverflowError) {
            const overflowDiagId = createCompactionDiagId();
            const errorText = contextOverflowError.text;
            const msgCount = attempt.messagesSnapshot?.length ?? 0;
            const observedOverflowTokens = extractObservedOverflowTokenCount(errorText);
            log.warn(
              `[context-overflow-diag] sessionKey=${params.sessionKey ?? params.sessionId} ` +
                `provider=${provider}/${modelId} source=${contextOverflowError.source} ` +
                `messages=${msgCount} sessionFile=${params.sessionFile} ` +
                `diagId=${overflowDiagId} compactionAttempts=${overflowCompactionAttempts} ` +
                `observedTokens=${observedOverflowTokens ?? "unknown"} ` +
                `error=${errorText.slice(0, 200)}`,
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
              let compactResult: Awaited<ReturnType<typeof contextEngine.compact>>;
              await runOwnsCompactionBeforeHook("overflow recovery");
              try {
                const overflowCompactionRuntimeContext = {
                  ...buildEmbeddedCompactionRuntimeContext({
                    sessionKey: params.sessionKey,
                    messageChannel: params.messageChannel,
                    messageProvider: params.messageProvider,
                    agentAccountId: params.agentAccountId,
                    currentChannelId: params.currentChannelId,
                    currentThreadTs: params.currentThreadTs,
                    currentMessageId: params.currentMessageId,
                    authProfileId: lastProfileId,
                    workspaceDir: resolvedWorkspace,
                    agentDir,
                    config: params.config,
                    skillsSnapshot: params.skillsSnapshot,
                    senderIsOwner: params.senderIsOwner,
                    senderId: params.senderId,
                    provider,
                    modelId,
                    thinkLevel,
                    reasoningLevel: params.reasoningLevel,
                    bashElevated: params.bashElevated,
                    extraSystemPrompt: params.extraSystemPrompt,
                    ownerNumbers: params.ownerNumbers,
                  }),
                  ...(attempt.promptCache ? { promptCache: attempt.promptCache } : {}),
                  runId: params.runId,
                  trigger: "overflow",
                  ...(observedOverflowTokens !== undefined
                    ? { currentTokenCount: observedOverflowTokens }
                    : {}),
                  diagId: overflowDiagId,
                  attempt: overflowCompactionAttempts,
                  maxAttempts: MAX_OVERFLOW_COMPACTION_ATTEMPTS,
                };
                compactResult = await contextEngine.compact({
                  sessionId: params.sessionId,
                  sessionKey: params.sessionKey,
                  sessionFile: params.sessionFile,
                  tokenBudget: ctxInfo.tokens,
                  ...(observedOverflowTokens !== undefined
                    ? { currentTokenCount: observedOverflowTokens }
                    : {}),
                  force: true,
                  compactionTarget: "budget",
                  runtimeContext: overflowCompactionRuntimeContext,
                });
                if (compactResult.ok && compactResult.compacted) {
                  await runContextEngineMaintenance({
                    contextEngine,
                    sessionId: params.sessionId,
                    sessionKey: params.sessionKey,
                    sessionFile: params.sessionFile,
                    reason: "compaction",
                    runtimeContext: overflowCompactionRuntimeContext,
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
              await runOwnsCompactionAfterHook("overflow recovery", compactResult);
              if (compactResult.compacted) {
                if (preflightRecovery?.route === "compact_then_truncate") {
                  const truncResult = await truncateOversizedToolResultsInSession({
                    sessionFile: params.sessionFile,
                    contextWindowTokens: ctxInfo.tokens,
                    maxCharsOverride: resolveLiveToolResultMaxChars({
                      contextWindowTokens: ctxInfo.tokens,
                      cfg: params.config,
                      agentId: sessionAgentId,
                    }),
                    sessionId: params.sessionId,
                    sessionKey: params.sessionKey,
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
                continue;
              }
              log.warn(
                `auto-compaction failed for ${provider}/${modelId}: ${compactResult.reason ?? "nothing to compact"}`,
              );
            }
            if (!toolResultTruncationAttempted) {
              const contextWindowTokens = ctxInfo.tokens;
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
                  sessionFile: params.sessionFile,
                  contextWindowTokens,
                  maxCharsOverride: toolResultMaxChars,
                  sessionId: params.sessionId,
                  sessionKey: params.sessionKey,
                });
                if (truncResult.truncated) {
                  log.info(
                    `[context-overflow-recovery] Truncated ${truncResult.truncatedCount} tool result(s); retrying prompt`,
                  );
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
            attempt.setTerminalLifecycleMeta?.({
              replayInvalid: resolveReplayInvalidForAttempt(),
              livenessState: "blocked",
            });
            return {
              payloads: [
                {
                  text:
                    "Context overflow: prompt too large for the model. " +
                    "Try /reset (or /new) to start a fresh session, or use a larger-context model.",
                  isError: true,
                },
              ],
              meta: {
                durationMs: Date.now() - started,
                agentMeta: buildErrorAgentMeta({
                  sessionId: sessionIdUsed,
                  provider,
                  model: model.id,
                  usageAccumulator,
                  lastRunPromptUsage,
                  lastAssistant: sessionLastAssistant,
                  lastTurnTotal,
                }),
                systemPromptReport: attempt.systemPromptReport,
                finalPromptText: attempt.finalPromptText,
                replayInvalid: resolveReplayInvalidForAttempt(),
                livenessState: "blocked",
                error: { kind, message: errorText },
              },
            };
          }

          if (promptError && !aborted && promptErrorSource !== "compaction") {
            // Normalize wrapped errors (e.g. abort-wrapped RESOURCE_EXHAUSTED) into
            // FailoverError so rate-limit classification works even for nested shapes.
            //
            // promptErrorSource === "compaction" means the model call already completed and the
            // abort happened only while waiting for compaction/retry cleanup. Retrying from here
            // would replay that completed tool turn as a fresh prompt attempt.
            const normalizedPromptFailover = coerceToFailoverError(promptError, {
              provider: activeErrorContext.provider,
              model: activeErrorContext.model,
              profileId: lastProfileId,
            });
            const promptErrorDetails = normalizedPromptFailover
              ? describeFailoverError(normalizedPromptFailover)
              : describeFailoverError(promptError);
            const errorText = promptErrorDetails.message || formatErrorMessage(promptError);
            if (await maybeRefreshRuntimeAuthForAuthError(errorText, runtimeAuthRetry)) {
              authRetryPending = true;
              continue;
            }
            // Handle role ordering errors with a user-friendly message
            if (/incorrect role information|roles must alternate/i.test(errorText)) {
              attempt.setTerminalLifecycleMeta?.({
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
                    provider,
                    model: model.id,
                    usageAccumulator,
                    lastRunPromptUsage,
                    lastAssistant: sessionLastAssistant,
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
              attempt.setTerminalLifecycleMeta?.({
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
                    provider,
                    model: model.id,
                    usageAccumulator,
                    lastRunPromptUsage,
                    lastAssistant: sessionLastAssistant,
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
            const promptProfileFailureReason =
              resolveAuthProfileFailureReason(promptFailoverReason);
            await maybeMarkAuthProfileFailure({
              profileId: lastProfileId,
              reason: promptProfileFailureReason,
              modelId,
            });
            const promptFailoverFailure =
              promptFailoverReason !== null || isFailoverErrorMessage(errorText, { provider });
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
              profileRotated: false,
            });
            if (
              promptFailoverDecision.action === "rotate_profile" &&
              (await advanceAuthProfile())
            ) {
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
                profileRotated: true,
              });
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
            throw promptError;
          }

          const assistantForFailover = currentAttemptAssistant ?? sessionLastAssistant;
          const fallbackThinking = pickFallbackThinkingLevel({
            message: assistantForFailover?.errorMessage,
            attempted: attemptedThinking,
          });
          if (fallbackThinking && !aborted) {
            log.warn(
              `unsupported thinking level for ${provider}/${modelId}; retrying with ${fallbackThinking}`,
            );
            thinkLevel = fallbackThinking;
            continue;
          }

          const authFailure = isAuthAssistantError(assistantForFailover);
          const rateLimitFailure = isRateLimitAssistantError(assistantForFailover);
          const billingFailure = isBillingAssistantError(assistantForFailover);
          const failoverFailure = isFailoverAssistantError(assistantForFailover);
          const assistantFailoverReason = classifyFailoverReason(
            assistantForFailover?.errorMessage ?? "",
            {
              provider: assistantForFailover?.provider,
            },
          );
          const assistantProfileFailureReason =
            resolveAuthProfileFailureReason(assistantFailoverReason);
          const cloudCodeAssistFormatError = attempt.cloudCodeAssistFormatError;
          const imageDimensionError = parseImageDimensionError(
            assistantForFailover?.errorMessage ?? "",
          );
          // Capture the failing profile before auth-profile rotation mutates `lastProfileId`.
          const failedAssistantProfileId = lastProfileId;
          const logAssistantFailoverDecision = createFailoverDecisionLogger({
            stage: "assistant",
            runId: params.runId,
            rawError: assistantForFailover?.errorMessage?.trim(),
            failoverReason: assistantFailoverReason,
            profileFailureReason: assistantProfileFailureReason,
            provider: activeErrorContext.provider,
            model: activeErrorContext.model,
            sourceProvider: assistantForFailover?.provider ?? provider,
            sourceModel: assistantForFailover?.model ?? modelId,
            profileId: failedAssistantProfileId,
            fallbackConfigured,
            timedOut,
            aborted,
          });

          if (
            authFailure &&
            (await maybeRefreshRuntimeAuthForAuthError(
              assistantForFailover?.errorMessage ?? "",
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
            aborted,
            externalAbort,
            fallbackConfigured,
            failoverFailure,
            failoverReason: assistantFailoverReason,
            timedOut,
            timedOutDuringCompaction,
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
            allowSameModelIdleTimeoutRetry:
              timedOut &&
              idleTimedOut &&
              !timedOutDuringCompaction &&
              !fallbackConfigured &&
              canRestartForLiveSwitch &&
              sameModelIdleTimeoutRetries < MAX_SAME_MODEL_IDLE_TIMEOUT_RETRIES,
            assistantProfileFailureReason,
            lastProfileId,
            modelId,
            provider,
            activeErrorContext,
            lastAssistant: assistantForFailover,
            config: params.config,
            sessionKey: params.sessionKey ?? params.sessionId,
            authFailure,
            rateLimitFailure,
            billingFailure,
            cloudCodeAssistFormatError,
            isProbeSession,
            overloadProfileRotations,
            overloadProfileRotationLimit,
            previousRetryFailoverReason: lastRetryFailoverReason,
            logAssistantFailoverDecision,
            warn: (message) => log.warn(message),
            maybeMarkAuthProfileFailure,
            maybeEscalateRateLimitProfileFallback,
            maybeBackoffBeforeOverloadFailover,
            advanceAuthProfile,
          });
          overloadProfileRotations = assistantFailoverOutcome.overloadProfileRotations;
          if (assistantFailoverOutcome.action === "retry") {
            traceAttempts.push({
              provider: activeErrorContext.provider,
              model: activeErrorContext.model,
              result:
                assistantFailoverOutcome.retryKind === "same_model_idle_timeout" ||
                assistantFailoverReason === "timeout"
                  ? "timeout"
                  : "rotate_profile",
              ...(assistantFailoverReason ? { reason: assistantFailoverReason } : {}),
              stage: "assistant",
            });
            if (assistantFailoverOutcome.retryKind === "same_model_idle_timeout") {
              sameModelIdleTimeoutRetries += 1;
            }
            lastRetryFailoverReason = assistantFailoverOutcome.lastRetryFailoverReason;
            continue;
          }
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
            throw assistantFailoverOutcome.error;
          }
          const usageMeta = buildUsageAgentMetaFields({
            usageAccumulator,
            lastAssistantUsage: sessionLastAssistant?.usage as UsageLike | undefined,
            lastRunPromptUsage,
            lastTurnTotal,
          });
          const agentMeta: EmbeddedPiAgentMeta = {
            sessionId: sessionIdUsed,
            provider: sessionLastAssistant?.provider ?? provider,
            model: sessionLastAssistant?.model ?? model.id,
            agentHarnessId: attempt.agentHarnessId,
            usage: usageMeta.usage,
            lastCallUsage: usageMeta.lastCallUsage,
            promptTokens: usageMeta.promptTokens,
            compactionCount: autoCompactionCount > 0 ? autoCompactionCount : undefined,
          };
          const finalAssistantVisibleText = resolveFinalAssistantVisibleText(sessionLastAssistant);
          const finalAssistantRawText = resolveFinalAssistantRawText(sessionLastAssistant);

          const payloads = buildEmbeddedRunPayloads({
            assistantTexts: attempt.assistantTexts,
            toolMetas: attempt.toolMetas,
            lastAssistant: attempt.lastAssistant,
            lastToolError: attempt.lastToolError,
            config: params.config,
            isCronTrigger: params.trigger === "cron",
            sessionKey: params.sessionKey ?? params.sessionId,
            provider: activeErrorContext.provider,
            model: activeErrorContext.model,
            verboseLevel: params.verboseLevel,
            reasoningLevel: params.reasoningLevel,
            toolResultFormat: resolvedToolResultFormat,
            suppressToolErrorWarnings: params.suppressToolErrorWarnings,
            inlineToolResultsAllowed: false,
            didSendViaMessagingTool: attempt.didSendViaMessagingTool,
            didSendDeterministicApprovalPrompt: attempt.didSendDeterministicApprovalPrompt,
          });
          const payloadsWithToolMedia = mergeAttemptToolMediaPayloads({
            payloads,
            toolMediaUrls: attempt.toolMediaUrls,
            toolAudioAsVoice: attempt.toolAudioAsVoice,
          });
          const attemptToolSummary = buildTraceToolSummary({
            toolMetas: attempt.toolMetas,
            hadFailure: Boolean(attempt.lastToolError),
          });

          // Timeout aborts can leave the run without any assistant payloads.
          // Emit an explicit timeout error instead of silently completing, so
          // callers do not lose the turn as an orphaned user message.
          if (timedOut && !timedOutDuringCompaction && !payloadsWithToolMedia?.length) {
            const timeoutText = idleTimedOut
              ? "The model did not produce a response before the LLM idle timeout. " +
                "Please try again, or increase `agents.defaults.llm.idleTimeoutSeconds` in your config (set to 0 to disable)."
              : "Request timed out before a response was generated. " +
                "Please try again, or increase `agents.defaults.timeoutSeconds` in your config.";
            const replayInvalid = resolveReplayInvalidForAttempt(null);
            const livenessState = resolveRunLivenessState({
              payloadCount: payloads.length,
              aborted,
              timedOut,
              attempt,
              incompleteTurnText: null,
            });
            attempt.setTerminalLifecycleMeta?.({
              replayInvalid,
              livenessState,
            });
            return {
              payloads: [
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
                toolSummary: attemptToolSummary,
                agentHarnessResultClassification: attempt.agentHarnessResultClassification,
              },
              didSendViaMessagingTool: attempt.didSendViaMessagingTool,
              didSendDeterministicApprovalPrompt: attempt.didSendDeterministicApprovalPrompt,
              messagingToolSentTexts: attempt.messagingToolSentTexts,
              messagingToolSentMediaUrls: attempt.messagingToolSentMediaUrls,
              messagingToolSentTargets: attempt.messagingToolSentTargets,
              successfulCronAdds: attempt.successfulCronAdds,
            };
          }

          const payloadCount = payloadsWithToolMedia?.length ?? 0;
          const nextPlanningOnlyRetryInstruction = resolvePlanningOnlyRetryInstruction({
            provider,
            modelId,
            executionContract,
            prompt: params.prompt,
            aborted,
            timedOut,
            attempt,
          });
          const nextReasoningOnlyRetryInstruction = resolveReasoningOnlyRetryInstruction({
            provider: activeErrorContext.provider,
            modelId: activeErrorContext.model,
            executionContract,
            aborted,
            timedOut,
            attempt,
          });
          const nextEmptyResponseRetryInstruction = resolveEmptyResponseRetryInstruction({
            provider: activeErrorContext.provider,
            modelId: activeErrorContext.model,
            executionContract,
            payloadCount,
            aborted,
            timedOut,
            attempt,
          });
          if (
            nextPlanningOnlyRetryInstruction &&
            planningOnlyRetryAttempts < maxPlanningOnlyRetryAttempts
          ) {
            const planningOnlyText = attempt.assistantTexts.join("\n\n").trim();
            const planDetails = extractPlanningOnlyPlanDetails(planningOnlyText);
            if (planDetails) {
              emitAgentPlanEvent({
                runId: params.runId,
                ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
                data: {
                  phase: "update",
                  title: "Assistant proposed a plan",
                  explanation: planDetails.explanation,
                  steps: planDetails.steps,
                  source: "planning_only_retry",
                },
              });
              params.onAgentEvent?.({
                stream: "plan",
                data: {
                  phase: "update",
                  title: "Assistant proposed a plan",
                  explanation: planDetails.explanation,
                  steps: planDetails.steps,
                  source: "planning_only_retry",
                },
              });
            }
            planningOnlyRetryAttempts += 1;
            planningOnlyRetryInstruction = nextPlanningOnlyRetryInstruction;
            log.warn(
              `planning-only turn detected: runId=${params.runId} sessionId=${params.sessionId} ` +
                `provider=${provider}/${modelId} contract=${executionContract} configured=${configuredExecutionContract} — retrying ` +
                `${planningOnlyRetryAttempts}/${maxPlanningOnlyRetryAttempts} with act-now steer`,
            );
            continue;
          }
          if (
            !nextPlanningOnlyRetryInstruction &&
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
            !nextPlanningOnlyRetryInstruction &&
            nextReasoningOnlyRetryInstruction &&
            reasoningOnlyRetryAttempts >= maxReasoningOnlyRetryAttempts;
          if (
            !nextPlanningOnlyRetryInstruction &&
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
          const incompleteTurnText = resolveIncompleteTurnPayloadText({
            payloadCount,
            aborted,
            timedOut,
            attempt,
          });
          if (reasoningOnlyRetriesExhausted && !finalAssistantVisibleText) {
            log.warn(
              `reasoning-only retries exhausted: runId=${params.runId} sessionId=${params.sessionId} ` +
                `provider=${activeErrorContext.provider}/${activeErrorContext.model} attempts=${reasoningOnlyRetryAttempts}/${maxReasoningOnlyRetryAttempts} — surfacing incomplete-turn error`,
            );
          }
          if (!incompleteTurnText && nextPlanningOnlyRetryInstruction && strictAgenticActive) {
            log.warn(
              `strict-agentic run exhausted planning-only retries: runId=${params.runId} sessionId=${params.sessionId} ` +
                `provider=${provider}/${modelId} configured=${configuredExecutionContract} — surfacing blocked state`,
            );
            // Criterion 4 of the GPT-5.4 parity gate requires every terminal
            // exit path to emit an explicit livenessState + replayInvalid so
            // downstream observers never see "silent disappearance". Every
            // other hard-error terminal branch in this file uses "blocked"
            // for its livenessState (role ordering, image size, schema
            // error, compaction timeout, aborted-with-no-payloads). Match
            // that convention here so lifecycle consumers treat an
            // isError:true strict-agentic-blocked payload the same way they
            // treat any other error-terminal payload. Replay validity is
            // delegated to the shared resolver because the plan-only
            // transcript itself is replay-safe even though the run is
            // terminal.
            const replayInvalid = resolveReplayInvalidForAttempt(null);
            const livenessState: EmbeddedRunLivenessState = "blocked";
            attempt.setTerminalLifecycleMeta?.({
              replayInvalid,
              livenessState,
            });
            return {
              payloads: [
                {
                  text: STRICT_AGENTIC_BLOCKED_TEXT,
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
                toolSummary: attemptToolSummary,
                agentHarnessResultClassification: attempt.agentHarnessResultClassification,
              },
              didSendViaMessagingTool: attempt.didSendViaMessagingTool,
              didSendDeterministicApprovalPrompt: attempt.didSendDeterministicApprovalPrompt,
              messagingToolSentTexts: attempt.messagingToolSentTexts,
              messagingToolSentMediaUrls: attempt.messagingToolSentMediaUrls,
              messagingToolSentTargets: attempt.messagingToolSentTargets,
              successfulCronAdds: attempt.successfulCronAdds,
            };
          }
          if (reasoningOnlyRetriesExhausted && !finalAssistantVisibleText) {
            const replayInvalid = resolveReplayInvalidForAttempt(
              "⚠️ Agent couldn't generate a response. Please try again.",
            );
            const livenessState = resolveRunLivenessState({
              payloadCount: 0,
              aborted,
              timedOut,
              attempt,
              incompleteTurnText: "⚠️ Agent couldn't generate a response. Please try again.",
            });
            attempt.setTerminalLifecycleMeta?.({
              replayInvalid,
              livenessState,
            });
            if (lastProfileId) {
              await maybeMarkAuthProfileFailure({
                profileId: lastProfileId,
                reason: resolveAuthProfileFailureReason(assistantFailoverReason),
              });
            }
            return {
              payloads: [
                {
                  text: "⚠️ Agent couldn't generate a response. Please try again.",
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
                toolSummary: attemptToolSummary,
                agentHarnessResultClassification: attempt.agentHarnessResultClassification,
              },
              didSendViaMessagingTool: attempt.didSendViaMessagingTool,
              didSendDeterministicApprovalPrompt: attempt.didSendDeterministicApprovalPrompt,
              messagingToolSentTexts: attempt.messagingToolSentTexts,
              messagingToolSentMediaUrls: attempt.messagingToolSentMediaUrls,
              messagingToolSentTargets: attempt.messagingToolSentTargets,
              successfulCronAdds: attempt.successfulCronAdds,
            };
          }
          if (
            !nextPlanningOnlyRetryInstruction &&
            !nextReasoningOnlyRetryInstruction &&
            nextEmptyResponseRetryInstruction &&
            emptyResponseRetryAttempts >= maxEmptyResponseRetryAttempts
          ) {
            log.warn(
              `empty response retries exhausted: runId=${params.runId} sessionId=${params.sessionId} ` +
                `provider=${activeErrorContext.provider}/${activeErrorContext.model} attempts=${emptyResponseRetryAttempts}/${maxEmptyResponseRetryAttempts} — surfacing incomplete-turn error`,
            );
          }
          // ── silent-error retry ────────────────────────────────────────────
          // Observed with ollama/glm-5.1: a turn can end with stopReason="error"
          // and zero output tokens AND empty content after a successful
          // tool-call sequence, producing no user-visible text at all. The
          // existing empty-response retry path (resolveEmptyResponseRetryInstruction)
          // is gated on the strict-agentic contract (gpt-5 only), so non-frontier
          // models fall through to "incomplete turn detected" → silent gap
          // until the user nudges. This is a narrower, model-agnostic
          // resubmission: same prompt, same session transcript (tool results
          // already captured), no instruction injection. Placed before the
          // incompleteTurnText return so it actually gets a chance to fire.
          //
          // Content-empty guard: a reasoning-only error (content has thinking
          // blocks) is a distinct failure mode handled elsewhere; only retry
          // when the assistant truly produced nothing.
          //
          // Side-effect guard: if the failed attempt already recorded potential
          // side effects (messaging tool sent, cron add, mutating tool
          // call that wasn't round-tripped as replay-safe), resubmission can
          // duplicate those actions. Mirror the gate the other retry resolvers
          // use (resolveEmptyResponseRetryInstruction, reasoning-only, planning-
          // only), which short-circuit on attempt.replayMetadata.hadPotentialSideEffects.
          const silentErrorContent = sessionLastAssistant?.content as Array<unknown> | undefined;
          if (
            incompleteTurnText &&
            !aborted &&
            !promptError &&
            !timedOut &&
            sessionLastAssistant?.stopReason === "error" &&
            ((sessionLastAssistant?.usage as { output?: number } | undefined)?.output ?? 0) === 0 &&
            (silentErrorContent?.length ?? 0) === 0 &&
            !attempt.replayMetadata.hadPotentialSideEffects &&
            emptyErrorRetries < MAX_EMPTY_ERROR_RETRIES
          ) {
            emptyErrorRetries += 1;
            log.warn(
              `[empty-error-retry] stopReason=error output=0; resubmitting ` +
                `attempt=${emptyErrorRetries}/${MAX_EMPTY_ERROR_RETRIES} ` +
                `provider=${sessionLastAssistant?.provider ?? provider} ` +
                `model=${sessionLastAssistant?.model ?? model.id} ` +
                `sessionKey=${params.sessionKey ?? params.sessionId}`,
            );
            continue;
          }
          if (incompleteTurnText) {
            const replayInvalid = resolveReplayInvalidForAttempt(incompleteTurnText);
            const livenessState = resolveRunLivenessState({
              payloadCount: payloads.length,
              aborted,
              timedOut,
              attempt,
              incompleteTurnText,
            });
            attempt.setTerminalLifecycleMeta?.({
              replayInvalid,
              livenessState,
            });
            const incompleteStopReason = attempt.lastAssistant?.stopReason;
            log.warn(
              `incomplete turn detected: runId=${params.runId} sessionId=${params.sessionId} ` +
                `stopReason=${incompleteStopReason} payloads=0 — surfacing error to user`,
            );

            // Mark the failing profile for cooldown so multi-profile setups
            // rotate away from the exhausted credential on the next turn.
            if (lastProfileId) {
              await maybeMarkAuthProfileFailure({
                profileId: lastProfileId,
                reason: resolveAuthProfileFailureReason(assistantFailoverReason),
              });
            }

            return {
              payloads: [
                {
                  text: incompleteTurnText,
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
                toolSummary: attemptToolSummary,
                agentHarnessResultClassification: attempt.agentHarnessResultClassification,
              },
              didSendViaMessagingTool: attempt.didSendViaMessagingTool,
              didSendDeterministicApprovalPrompt: attempt.didSendDeterministicApprovalPrompt,
              messagingToolSentTexts: attempt.messagingToolSentTexts,
              messagingToolSentMediaUrls: attempt.messagingToolSentMediaUrls,
              messagingToolSentTargets: attempt.messagingToolSentTargets,
              successfulCronAdds: attempt.successfulCronAdds,
            };
          }

          log.debug(
            `embedded run done: runId=${params.runId} sessionId=${params.sessionId} durationMs=${Date.now() - started} aborted=${aborted}`,
          );
          if (lastProfileId) {
            await markAuthProfileGood({
              store: authStore,
              provider,
              profileId: lastProfileId,
              agentDir: params.agentDir,
            });
            await markAuthProfileUsed({
              store: authStore,
              profileId: lastProfileId,
              agentDir: params.agentDir,
            });
          }
          const replayInvalid = resolveReplayInvalidForAttempt(null);
          const livenessState = resolveRunLivenessState({
            payloadCount: payloads.length,
            aborted,
            timedOut,
            attempt,
            incompleteTurnText: null,
          });
          const stopReason = attempt.clientToolCall
            ? "tool_calls"
            : attempt.yieldDetected
              ? "end_turn"
              : (sessionLastAssistant?.stopReason as string | undefined);
          attempt.setTerminalLifecycleMeta?.({
            replayInvalid,
            livenessState,
          });
          return {
            payloads: payloadsWithToolMedia?.length ? payloadsWithToolMedia : undefined,
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
              // Handle client tool calls (OpenResponses hosted tools)
              // Propagate the LLM stop reason so callers (lifecycle events,
              // ACP bridge) can distinguish end_turn from max_tokens.
              stopReason,
              pendingToolCalls: attempt.clientToolCall
                ? [
                    {
                      id: randomBytes(5).toString("hex").slice(0, 9),
                      name: attempt.clientToolCall.name,
                      arguments: JSON.stringify(attempt.clientToolCall.params),
                    },
                  ]
                : undefined,
              executionTrace: {
                winnerProvider: sessionLastAssistant?.provider ?? provider,
                winnerModel: sessionLastAssistant?.model ?? model.id,
                attempts:
                  traceAttempts.length > 0 ||
                  sessionLastAssistant?.provider ||
                  sessionLastAssistant?.model
                    ? [
                        ...traceAttempts,
                        {
                          provider: sessionLastAssistant?.provider ?? provider,
                          model: sessionLastAssistant?.model ?? model.id,
                          result: "success",
                          stage: "assistant",
                        },
                      ]
                    : undefined,
                fallbackUsed: traceAttempts.length > 0,
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
              completion: {
                ...(stopReason ? { stopReason } : {}),
                ...(stopReason ? { finishReason: stopReason } : {}),
                ...(stopReason?.toLowerCase().includes("refusal") ? { refusal: true } : {}),
              },
              contextManagement:
                autoCompactionCount > 0 ? { lastTurnCompactions: autoCompactionCount } : undefined,
            },
            didSendViaMessagingTool: attempt.didSendViaMessagingTool,
            didSendDeterministicApprovalPrompt: attempt.didSendDeterministicApprovalPrompt,
            messagingToolSentTexts: attempt.messagingToolSentTexts,
            messagingToolSentMediaUrls: attempt.messagingToolSentMediaUrls,
            messagingToolSentTargets: attempt.messagingToolSentTargets,
            successfulCronAdds: attempt.successfulCronAdds,
          };
        }
      } finally {
        await contextEngine.dispose?.();
        stopRuntimeAuthRefreshTimer();
        if (params.cleanupBundleMcpOnRunEnd === true) {
          const onError = (error: unknown, sessionId: string) => {
            log.warn(
              `bundle-mcp cleanup failed after run for ${sessionId}: ${formatErrorMessage(error)}`,
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
        }
      }
    });
  });
}
