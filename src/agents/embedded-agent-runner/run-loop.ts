/** Prepared embedded-agent loop and cleanup. */
import { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } from "../../context-engine/host-compat.js";
import { ensureContextEnginesInitialized } from "../../context-engine/init.js";
import {
  resolveContextEngine,
  resolveContextEngineOwnerPluginId,
} from "../../context-engine/registry.js";
import { buildContextEngineRuntimeSettings } from "../../context-engine/runtime-settings.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  retireSessionMcpRuntime,
  retireSessionMcpRuntimeForSessionKey,
} from "../agent-bundle-mcp-tools.js";
import { resolveSessionAgentIds } from "../agent-scope.js";
import type { ToolOutcomeObservation } from "../agent-tools.before-tool-call.js";
import type { FailoverReason } from "../embedded-agent-helpers.js";
import { isStrictAgenticExecutionContractActive } from "../execution-contract.js";
import type { McpAppChannelView } from "../mcp-ui-resource.js";
import { runAgentCleanupStep } from "../run-cleanup-timeout.js";
import { resolveToolLoopDetectionConfig } from "../tool-loop-detection-config.js";
import { normalizeUsage } from "../usage.js";
import { log } from "./logger.js";
import {
  createPostCompactionLoopGuard,
  PostCompactionLoopPersistedError,
} from "./post-compaction-loop-guard.js";
import { clearProviderPromptState } from "./provider-prompt-state.js";
import { createEmbeddedRunReplayState } from "./replay-state.js";
import { handleEmbeddedAssistantFailure } from "./run/assistant-failure.js";
import { prepareAndDispatchEmbeddedRunAttempt } from "./run/attempt-dispatch-preparation.js";
import { normalizeEmbeddedRunAttempt } from "./run/attempt-normalization.js";
import { recoverEmbeddedRunAttempt } from "./run/attempt-recovery.js";
import { forgetPromptBuildDrainCacheForRun } from "./run/attempt.prompt-helpers.js";
import { hasCodexAppServerRecoveryRetryBudget } from "./run/codex-app-server-recovery.js";
import { createEmbeddedRunCompactionRuntime } from "./run/compaction-runtime.js";
import { createEmbeddedRunContextRecoveryState } from "./run/context-recovery-state.js";
import type { PreparedEmbeddedRunInput } from "./run/execution-context.js";
import { resolveRunFailoverDecision } from "./run/failover-policy.js";
import { createEmbeddedRunFailoverRetryController } from "./run/failover-retry-controller.js";
import { buildErrorAgentMeta, resolveMaxRunRetryIterations } from "./run/helpers.js";
import { createIdleTimeoutBreakerState } from "./run/idle-timeout-breaker.js";
import {
  DEFAULT_EMPTY_RESPONSE_RETRY_LIMIT,
  DEFAULT_REASONING_ONLY_RETRY_LIMIT,
} from "./run/incomplete-turn.js";
import { handleRetryLimitExhaustion } from "./run/retry-limit.js";
import { prepareEmbeddedRunRuntime } from "./run/runtime-preparation.js";
import { createEmbeddedRunSessionPromptState } from "./run/session-prompt-state.js";
import { prepareEmbeddedRunTerminal } from "./run/terminal-preparation.js";
import { resolveEmbeddedRunTerminal } from "./run/terminal-resolution.js";
import { createEmbeddedRunTerminalRetryState } from "./run/terminal-retry-state.js";
import { resolveEmbeddedRunTerminalTimeout } from "./run/terminal-timeout.js";
import type { EmbeddedAgentRunResult, TraceAttempt } from "./types.js";
import { createUsageAccumulator } from "./usage-accumulator.js";

export async function runPreparedEmbeddedLoop(
  input: PreparedEmbeddedRunInput,
): Promise<EmbeddedAgentRunResult> {
  const params = input.runParams;
  let { provider, modelId } = input;
  const {
    agentDir,
    workspaceDir: resolvedWorkspace,
    globalLane,
    hookRunner,
    hookContext: hookCtx,
    fallbackConfigured,
    isProbeSession,
    resolvedSessionKey,
    resolvedToolResultFormat,
    startedAtMs: started,
    startupStages,
    lifecycleGeneration,
    suspendForFailure,
  } = input;
  const { maybeEmitFastModeAutoResetBestEffort, notifyExecutionPhase } = input.progressController;
  const { laneTaskAbortController } = input.laneController;
  let startupStagesEmitted = false;
  const preparedRuntime = await prepareEmbeddedRunRuntime({
    runParams: params,
    provider,
    modelId,
    agentDir,
    workspaceDir: resolvedWorkspace,
    globalLane,
    hookRunner,
    hookContext: hookCtx,
    markStartupStage: (stage) => startupStages.mark(stage),
    notifyExecutionPhase,
    fallbackConfigured,
    preparedModelRuntime: input.preparedModelRuntime,
  });
  provider = preparedRuntime.provider;
  modelId = preparedRuntime.modelId;
  const {
    requestedModelId,
    model,
    attemptAuthProfileStore,
    profileCandidates,
    profileFailureStore,
    pluginHarnessOwnsAuthBootstrap,
    attemptedThinking,
    advanceAttemptAuthProfile,
    maybeRefreshRuntimeAuthForAuthError,
    stopRuntimeAuthRefreshTimer,
    getApiKeyInfo,
  } = preparedRuntime;
  let {
    agentHarness,
    pluginHarnessOwnsTransport,
    effectiveModel,
    outerContextTokenMeta,
    thinkLevel,
    lastProfileId,
  } = preparedRuntime.snapshot();
  const refreshPreparedRuntimeSnapshot = () => {
    ({
      agentHarness,
      pluginHarnessOwnsTransport,
      effectiveModel,
      outerContextTokenMeta,
      thinkLevel,
      lastProfileId,
    } = preparedRuntime.snapshot());
  };
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
      contextEngineSelectionSource: contextEngine.info.id === "legacy" ? "default" : "configured",
      promptTokenBudget: settingsParams.tokenBudget,
      maxOutputTokens: settingsParams.maxOutputTokens,
      fallbackReason,
      degradedReason: settingsParams.degradedReason,
    });
  };
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

  const MAX_RUN_LOOP_ITERATIONS = resolveMaxRunRetryIterations(profileCandidates.length);
  const contextRecoveryState = createEmbeddedRunContextRecoveryState();
  let bootstrapPromptWarningSignaturesSeen =
    params.bootstrapPromptWarningSignaturesSeen ??
    (params.bootstrapPromptWarningSignature ? [params.bootstrapPromptWarningSignature] : []);
  const usageAccumulator = createUsageAccumulator();
  let lastRunPromptUsage: ReturnType<typeof normalizeUsage> | undefined;
  let runLoopIterations = 0;
  let overloadProfileRotations = 0;
  const terminalRetryState = createEmbeddedRunTerminalRetryState();
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
  const postCompactionGuard = createPostCompactionLoopGuard({
    enabled: resolvedLoopDetectionConfig?.enabled !== false,
  });
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
  let codexAppServerRecoveryRetries = 0;
  // Silent-error retry: non-strict-agentic models (e.g. ollama/glm-5.1) can
  // end a turn with stopReason="error" + zero output tokens, producing no
  // user-visible text. This is an orthogonal, model-agnostic resubmission
  // for errored turns; stopReason="stop" empty zero-token turns use the
  // visible-answer retry instruction instead.
  let emptyErrorRetries = 0;
  const sessionPromptState = createEmbeddedRunSessionPromptState({
    runParams: params,
    sessionAgentId,
    resolvedSessionKey,
    lifecycleGeneration,
  });
  const failoverRetryController = createEmbeddedRunFailoverRetryController({
    runParams: params,
    provider,
    modelId,
    globalLane,
    agentDir,
    fallbackConfigured,
    profileFailureStore,
    getLastProfileId: () => preparedRuntime.snapshot().lastProfileId,
    getSessionId: () => sessionPromptState.sessionId,
    harnessOwnsTransport: () => preparedRuntime.snapshot().pluginHarnessOwnsTransport,
  });
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
    const compactionRuntime = createEmbeddedRunCompactionRuntime({
      runParams: params,
      contextEngine,
      hookRunner,
      hookContext: hookCtx,
      sessionPromptState,
    });
    let authRetryPending = false;
    let accumulatedReplayState = createEmbeddedRunReplayState();
    let latestMcpAppChannelView: McpAppChannelView | undefined;
    // Hoisted so the retry-limit error path can use the most recent API total.
    let lastTurnTotal: number | undefined;
    while (true) {
      refreshPreparedRuntimeSnapshot();
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
            sessionId: sessionPromptState.sessionId,
            sessionFile: sessionPromptState.sessionFile,
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
      const runtimeAuthRetry: boolean = authRetryPending;
      authRetryPending = false;
      attemptedThinking.add(thinkLevel);
      const codexAppServerRecoveryRetryAvailable = hasCodexAppServerRecoveryRetryBudget({
        alreadyRetried: codexAppServerRecoveryRetries > 0,
        runLoopIterations,
        maxRunLoopIterations: MAX_RUN_LOOP_ITERATIONS,
      });
      const dispatch = await prepareAndDispatchEmbeddedRunAttempt({
        runInput: input,
        preparedRuntime,
        contextEngine,
        sessionPromptState,
        terminalRetryState,
        replayState: accumulatedReplayState,
        provider,
        modelId,
        startupStagesEmitted,
        bootstrapPromptWarningSignaturesSeen,
        resolveRuntimeFallbackReason,
        observeToolOutcome,
        allocateToolOutcomeOrdinal,
        getPostCompactionAbortError: () => postCompactionAbortError,
        setPostCompactionAbortController: (controller) => {
          postCompactionAbortController = controller;
        },
        clearPostCompactionAbortController: (controller) => {
          if (postCompactionAbortController === controller) {
            postCompactionAbortController = undefined;
          }
        },
      });
      startupStagesEmitted = dispatch.startupStagesEmitted;
      const { dispatchedAttempt, runtimePlan } = dispatch;
      const normalizedAttempt = await normalizeEmbeddedRunAttempt({
        runInput: input,
        preparedRuntime,
        dispatchedAttempt,
        sessionPromptState,
        provider,
        modelId,
        bootstrapPromptWarningSignaturesSeen,
        usageAccumulator,
        lastRunPromptUsage,
        lastTurnTotal,
        idleTimeoutBreakerState,
        contextRecoveryState,
        replayState: accumulatedReplayState,
        lastRetryFailoverReason,
      });
      if (normalizedAttempt.action === "complete") {
        return normalizedAttempt.result;
      }
      if (normalizedAttempt.action === "retry") {
        bootstrapPromptWarningSignaturesSeen =
          normalizedAttempt.bootstrapPromptWarningSignaturesSeen;
        lastRunPromptUsage = normalizedAttempt.lastRunPromptUsage;
        lastTurnTotal = normalizedAttempt.lastTurnTotal;
        accumulatedReplayState = normalizedAttempt.replayState;
        continue;
      }
      bootstrapPromptWarningSignaturesSeen = normalizedAttempt.bootstrapPromptWarningSignaturesSeen;
      lastRunPromptUsage = normalizedAttempt.lastRunPromptUsage;
      lastTurnTotal = normalizedAttempt.lastTurnTotal;
      accumulatedReplayState = normalizedAttempt.replayState;
      const {
        attempt,
        aborted,
        externalAbort,
        promptError,
        timedOut,
        idleTimedOut,
        timedOutDuringCompaction,
        timedOutDuringToolExecution,
        timedOutByRunBudget,
        sessionIdUsed,
        sessionFileUsed,
        currentAttemptAssistant,
        currentAttemptCompletedAssistant,
        attemptAssistant,
        terminalOutcome,
        terminalAborted,
        terminalTimedOut,
        terminalInterrupted,
        signalOwnedInterruption,
        setTerminalLifecycleMeta,
        attemptCompactionCount,
        activeErrorContext,
        resolveReplayInvalidForAttempt,
        canRestartForLiveSwitch,
      } = normalizedAttempt;
      // Continuation retries remain one user turn, so keep the newest launch target.
      latestMcpAppChannelView = attempt.latestMcpAppChannelView ?? latestMcpAppChannelView;
      attempt.latestMcpAppChannelView = latestMcpAppChannelView;
      const recovery = await recoverEmbeddedRunAttempt({
        runInput: input,
        preparedRuntime,
        normalizedAttempt,
        runtimePlan,
        sessionPromptState,
        failoverRetryController,
        compactionRuntime,
        contextEngine,
        contextRecoveryState,
        resolveContextEnginePluginId,
        buildRuntimeSettings: buildEmbeddedContextEngineRuntimeSettings,
        armPostCompactionGuard: () => postCompactionGuard.armPostCompaction(),
        usageAccumulator,
        lastRunPromptUsage,
        lastTurnTotal,
        runtimeAuthRetry,
        codexAppServerRecoveryRetryAvailable,
        codexAppServerRecoveryRetries,
        lastRetryFailoverReason,
        traceAttempts,
        sessionAgentId,
      });
      if (recovery.action === "complete") {
        return recovery.result;
      }
      if (recovery.action === "retry") {
        thinkLevel = recovery.thinkLevel;
        authRetryPending = recovery.authRetryPending;
        codexAppServerRecoveryRetries = recovery.codexAppServerRecoveryRetries;
        lastRetryFailoverReason = recovery.lastRetryFailoverReason;
        continue;
      }
      const { shouldSurfaceCodexCompletionTimeout } = recovery;

      const assistantFailureOutcome = await handleEmbeddedAssistantFailure({
        runParams: params,
        attempt,
        attemptAssistant,
        currentAttemptAssistant,
        terminalProviderStarted: terminalOutcome.providerStarted === true,
        terminalInterrupted,
        promptError,
        activeErrorContext,
        provider,
        modelId,
        model: model.id,
        thinkLevel,
        getThinkLevel: () => preparedRuntime.snapshot().thinkLevel,
        attemptedThinking,
        timedOut,
        idleTimedOut,
        timedOutDuringCompaction,
        timedOutDuringToolExecution,
        timedOutByRunBudget,
        signalOwnedInterruption,
        externalAbort,
        aborted,
        fallbackConfigured,
        pluginHarnessOwnsTransport,
        canRestartForLiveSwitch,
        authProfileId: lastProfileId,
        authProfileStore: attemptAuthProfileStore,
        runtimeAuthRetry,
        maybeRefreshRuntimeAuthForAuthError,
        resolveAuthProfileFailureReason: failoverRetryController.resolveAuthProfileFailureReason,
        emptyErrorRetries,
        overloadProfileRotations,
        overloadProfileRotationLimit: failoverRetryController.overloadProfileRotationLimit,
        rateLimitProfileRotations: failoverRetryController.rateLimitProfileRotations,
        rateLimitProfileRotationLimit: failoverRetryController.rateLimitProfileRotationLimit,
        sameModelIdleTimeoutRetries,
        previousRetryFailoverReason: lastRetryFailoverReason,
        maybeMarkAuthProfileFailure: failoverRetryController.maybeMarkAuthProfileFailure,
        maybeEscalateRateLimitProfileFallback:
          failoverRetryController.maybeEscalateRateLimitProfileFallback,
        maybeRetrySameModelRateLimit: failoverRetryController.maybeRetrySameModelRateLimit,
        maybeBackoffBeforeOverloadFailover:
          failoverRetryController.maybeBackoffBeforeOverloadFailover,
        advanceAttemptAuthProfile,
        traceAttempts,
        suspendForFailure,
        suspensionSessionId: sessionPromptState.sessionId ?? params.sessionId,
        agentDir,
        isProbeSession,
      });
      thinkLevel = assistantFailureOutcome.thinkLevel;
      preparedRuntime.setThinkLevel(thinkLevel);
      authRetryPending = assistantFailureOutcome.authRetryPending;
      emptyErrorRetries = assistantFailureOutcome.emptyErrorRetries;
      overloadProfileRotations = assistantFailureOutcome.overloadProfileRotations;
      sameModelIdleTimeoutRetries = assistantFailureOutcome.sameModelIdleTimeoutRetries;
      lastRetryFailoverReason = assistantFailureOutcome.lastRetryFailoverReason;
      if (!assistantFailureOutcome.preserveSameModelRateLimitRetryCount) {
        failoverRetryController.resetSameModelRateLimitRetries();
      }
      if (assistantFailureOutcome.action === "retry") {
        continue;
      }
      const assistantProfileFailureReason = assistantFailureOutcome.assistantProfileFailureReason;
      const {
        agentMeta,
        reportedModelRef,
        finalAssistantVisibleText,
        finalAssistantRawText,
        payloads,
        payloadsWithToolMedia,
        timedOutDuringPrompt,
        recoveredFinalAssistantPayloadsAfterPromptTimeout,
        hasSuccessfulFinalAssistantAfterPromptTimeout,
        hasPartialAssistantTextAfterPromptTimeout,
        attemptToolSummary,
        failureSignal,
      } = prepareEmbeddedRunTerminal({
        runParams: params,
        attempt,
        currentAttemptCompletedAssistant,
        provider,
        model: model.id,
        activeErrorContext,
        authProfileStore: attemptAuthProfileStore,
        authProfileId: lastProfileId,
        sessionIdUsed,
        sessionFileUsed,
        outerContextTokenMeta,
        usageAccumulator,
        lastRunPromptUsage,
        lastTurnTotal,
        contextRecoveryState,
        resolvedToolResultFormat,
        terminalInterrupted,
        terminalTimedOut,
        timedOutDuringCompaction,
        timedOutDuringToolExecution,
      });

      const terminalTimeoutResult = resolveEmbeddedRunTerminalTimeout({
        timedOutDuringPrompt,
        hasSuccessfulFinalAssistantAfterPromptTimeout,
        shouldSurfaceCodexCompletionTimeout,
        idleTimedOut,
        attempt,
        hasPartialAssistantTextAfterPromptTimeout,
        payloads,
        payloadsWithToolMedia,
        terminalAborted,
        terminalTimedOut,
        terminalOutcome,
        resolveReplayInvalid: resolveReplayInvalidForAttempt,
        setTerminalLifecycleMeta,
        startedAtMs: started,
        agentMeta,
        finalAssistantVisibleText,
        finalAssistantRawText,
        attemptToolSummary,
        failureSignal,
      });
      if (terminalTimeoutResult) {
        return terminalTimeoutResult;
      }

      const terminalResolution = await resolveEmbeddedRunTerminal({
        runParams: params,
        retryState: terminalRetryState,
        attempt,
        attemptAssistant,
        activeErrorContext,
        modelApi: effectiveModel.api,
        executionContract,
        terminalAborted,
        terminalTimedOut,
        terminalInterrupted,
        externalAbort,
        signalOwnedInterruption,
        promptError,
        payloadsWithToolMedia,
        recoveredFinalAssistantPayloadsAfterPromptTimeout,
        finalAssistantVisibleText,
        finalAssistantRawText,
        agentMeta,
        attemptToolSummary,
        failureSignal,
        maxReasoningOnlyRetryAttempts,
        maxEmptyResponseRetryAttempts,
        attemptCompactionCount,
        replayState: accumulatedReplayState,
        activePromptPersisted: sessionPromptState.activePrompt.persisted,
        activateInternalPrompt: sessionPromptState.activateInternalPrompt,
        setSuppressNextUserMessagePersistence: (value) => {
          sessionPromptState.suppressNextUserMessagePersistence = value;
        },
        armPostCompactionGuard: () => postCompactionGuard.armPostCompaction(),
        readTerminalToolPresentation: readAttemptTerminalToolPresentation,
        resolveReplayInvalid: resolveReplayInvalidForAttempt,
        setTerminalLifecycleMeta,
        maybeMarkAuthProfileFailure: failoverRetryController.maybeMarkAuthProfileFailure,
        assistantProfileFailureReason,
        startedAtMs: started,
        provider,
        modelId,
        authProfileId: lastProfileId,
        profileFailureStore,
        attemptAuthProfileStore,
        apiKeyInfo: getApiKeyInfo(),
        agentHarnessId: agentHarness.id,
        pluginHarnessOwnsTransport,
        pluginHarnessOwnsAuthBootstrap,
        reportedModelRef,
        traceAttempts,
        traceAttemptUsesFallback,
        thinkLevel,
        contextRecoveryState,
      });
      if (terminalResolution.action === "retry") {
        continue;
      }
      return terminalResolution.result;
    }
  } finally {
    if (params.isFinalFallbackAttempt !== false) {
      await maybeEmitFastModeAutoResetBestEffort();
    }
    forgetPromptBuildDrainCacheForRun(params.runId);
    clearProviderPromptState(params.runId);
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
            // MCP App views hold bounded leases so their bridge can remain
            // usable after a one-shot gateway run returns.
            preserveActiveLeases: true,
            onError,
          });
          if (!retiredBySessionKey) {
            await retireSessionMcpRuntime({
              sessionId: params.sessionId,
              reason: "embedded-run-end",
              preserveActiveLeases: true,
              onError,
            });
          }
        },
      });
    }
  }
}
