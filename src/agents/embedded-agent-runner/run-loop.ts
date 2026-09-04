/** Prepared embedded-agent loop. */
import { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } from "../../context-engine/host-compat.js";
import { resolveContextEngineOwnerPluginId } from "../../context-engine/registry.js";
import { buildContextEngineRuntimeSettings } from "../../context-engine/runtime-settings.js";
import {
  getAdmittedRunDelegatedAuthority,
  resolveAdmittedRunActiveAssertion,
} from "../admitted-run-context.js";
import { resolveSessionAgentIds } from "../agent-scope.js";
import type { ToolOutcomeObservation } from "../agent-tools.before-tool-call.js";
import { isHeartbeatLifecycleRunKind } from "../bootstrap-mode.js";
import type { FailoverReason } from "../embedded-agent-helpers.js";
import { isStrictAgenticExecutionContractActive } from "../execution-contract.js";
import {
  createContextEngineLogicalTurnLease,
  selectContextEngineForTranscriptHost,
} from "../harness/context-engine-logical-turn.js";
import { drainPendingContextEngineTurnsBeforeRun } from "../harness/context-engine-turn-attempt.js";
import { resolveToolLoopDetectionConfig } from "../tool-loop-detection-config.js";
import { normalizeUsage } from "../usage.js";
import { log } from "./logger.js";
import {
  createPostCompactionLoopGuard,
  PostCompactionLoopPersistedError,
} from "./post-compaction-loop-guard.js";
import { createEmbeddedRunReplayState } from "./replay-state.js";
import { handleEmbeddedAssistantFailure } from "./run/assistant-failure.js";
import { prepareAndDispatchEmbeddedRunAttempt } from "./run/attempt-dispatch-preparation.js";
import { normalizeEmbeddedRunAttempt } from "./run/attempt-normalization.js";
import { recoverEmbeddedRunAttempt } from "./run/attempt-recovery.js";
import { createAttemptCarryover } from "./run/attempt-result.js";
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
} from "./run/incomplete-turn-recovery.js";
import { createEmbeddedRunPermissionChanges } from "./run/permission-change.js";
import { measureEmbeddedAgentPreparation } from "./run/preparation-timing.js";
import {
  beginRunAttempt,
  createRunRetryBudget,
  isRunRetryBudgetExhausted,
  recordRunRetry,
} from "./run/retry-budget.js";
import { handleRetryLimitExhaustion } from "./run/retry-limit.js";
import { settleEmbeddedRun } from "./run/run-settlement.js";
import { prepareEmbeddedRunRuntime } from "./run/runtime-preparation.js";
import { createEmbeddedRunSessionPromptState } from "./run/session-prompt-state.js";
import { prepareTerminalWithSettledTurnFinalization } from "./run/settled-turn-finalization.js";
import {
  createTerminalToolPresentationTracker,
  resolveEmbeddedRunTerminal,
} from "./run/terminal-resolution.js";
import { createEmbeddedRunTerminalRetryState } from "./run/terminal-retry-state.js";
import { resolveEmbeddedRunTerminalTimeout } from "./run/terminal-timeout.js";
import { createAgentTurnTaintState } from "./run/turn-taint-state.js";
import type { EmbeddedAgentRunResult, TraceAttempt } from "./types.js";
import { createUsageAccumulator } from "./usage-accumulator.js";

export async function runPreparedEmbeddedLoop(
  input: PreparedEmbeddedRunInput,
): Promise<EmbeddedAgentRunResult> {
  let { runParams: params, provider, modelId } = input;
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
  const { notifyExecutionPhase } = input.progressController;
  let startupStagesEmitted = false;
  const preparedRuntime = await measureEmbeddedAgentPreparation(
    "runtime",
    () =>
      prepareEmbeddedRunRuntime({
        runParams: params,
        sessionAdmission: input.sessionAdmission,
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
      }),
    { config: params.config },
  );
  params = { ...params, admittedRunContext: preparedRuntime.admittedRunContext };
  const abortSignal = params.abortSignal;
  const accountingAuthority = getAdmittedRunDelegatedAuthority(preparedRuntime.admittedRunContext);
  const assertAdmittedActive = resolveAdmittedRunActiveAssertion(
    preparedRuntime.admittedRunContext,
    abortSignal,
  );
  // Admission is resolved once before the retry loop. Carry that exact object through every
  // attempt/recovery owner so downstream dispatch cannot lose the admitted context.
  const admittedRunInput: PreparedEmbeddedRunInput = { ...input, runParams: params };
  ({ provider, modelId } = preparedRuntime);
  const {
    model,
    attemptAuthProfileStore,
    profileCandidates,
    profileFailureStore,
    pluginHarnessOwnsAuthBootstrap,
    attemptedThinking,
    maybeRefreshRuntimeAuthForAuthError,
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
    return buildContextEngineRuntimeSettings({
      contextEngineHost: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
      provider,
      requestedModel: preparedRuntime.requestedModelId,
      resolvedModel: modelId,
      selectedContextEngineId: contextEngine.info.id,
      contextEngineSelectionSource: contextEngine.info.id === "legacy" ? "default" : "configured",
      promptTokenBudget: settingsParams.tokenBudget,
      maxOutputTokens: settingsParams.maxOutputTokens,
      fallbackReason: resolveRuntimeFallbackReason(),
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

  const runRetryBudget = createRunRetryBudget(
    resolveMaxRunRetryIterations(profileCandidates.length),
  );
  const contextRecoveryState = createEmbeddedRunContextRecoveryState();
  let bootstrapPromptWarningSignaturesSeen =
    params.bootstrapPromptWarningSignaturesSeen ??
    (params.bootstrapPromptWarningSignature ? [params.bootstrapPromptWarningSignature] : []);
  const usageAccumulator = createUsageAccumulator();
  let lastRunPromptUsage: ReturnType<typeof normalizeUsage> | undefined;
  let overloadProfileRotations = 0;
  const terminalRetryState = createEmbeddedRunTerminalRetryState();
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
  // Presentation survives retry attempts, but a newer tool result must clear stale text.
  const terminalToolPresentation = createTerminalToolPresentationTracker();
  const turnTaintState = createAgentTurnTaintState(params.initialTurnTainted === true);
  const observeToolOutcome = (observation: ToolOutcomeObservation): void => {
    terminalToolPresentation.observe(observation);
    turnTaintState.observe(observation);
    if (observation.presentationOnly) {
      return;
    }
    const verdict = postCompactionGuard.observe(observation);
    if (verdict.shouldAbort) {
      postCompactionAbortError ??= PostCompactionLoopPersistedError.fromVerdict(verdict);
      input.laneController.laneTaskAbortController.abort(postCompactionAbortError);
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
  const originalCompactionTarget = { ...sessionPromptState.sessionTarget };
  const durableCompactionAccounting =
    params.sessionPersistence !== "detached" &&
    !(params.sessionManager && !params.sessionManager.getSessionTarget());
  const permissionChanges = createEmbeddedRunPermissionChanges(params);
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
    getRuntimeAuthOwnerId: () => preparedRuntime.snapshot().agentHarness.id,
    getApiKeyInfo,
    advanceAuthProfile: preparedRuntime.advanceAttemptAuthProfile,
  });
  const ownsContextEngineLogicalTurnLease = params.contextEngineLogicalTurnLease === undefined;
  const contextEngineLogicalTurnLease =
    params.contextEngineLogicalTurnLease ??
    (await measureEmbeddedAgentPreparation(
      "context-engine",
      () =>
        createContextEngineLogicalTurnLease({
          config: params.config,
          agentDir,
          workspaceDir: resolvedWorkspace,
        }),
      { config: params.config },
    ));
  const ownedContextEngineLease = ownsContextEngineLogicalTurnLease
    ? contextEngineLogicalTurnLease
    : undefined;
  selectContextEngineForTranscriptHost({
    lease: contextEngineLogicalTurnLease,
    host: {
      id: `agent-harness:${agentHarness.id}`,
      label: `agent harness "${agentHarness.id}"`,
      capabilities: agentHarness.contextEngineHostCapabilities ?? [],
    },
    operation: "agent-run",
    recorder: params.userTurnTranscriptRecorder,
  });
  await drainPendingContextEngineTurnsBeforeRun({
    admission: params.userTurnTranscriptRecorder?.getAdmissionReceipt(),
    isHeartbeat: isHeartbeatLifecycleRunKind(params.bootstrapContextRunKind),
    lease: contextEngineLogicalTurnLease,
    recorder: params.userTurnTranscriptRecorder,
    sessionTarget: params.sessionTarget,
  });
  const contextEngine = contextEngineLogicalTurnLease.begin().engine;
  const resolveContextEnginePluginId = () =>
    contextEngineLogicalTurnLease.effectiveEnginePluginId ??
    resolveContextEngineOwnerPluginId(contextEngine);
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
    const attemptCarryover = createAttemptCarryover();
    while (true) {
      // Every retry keeps its exact admission; only transcript mutation requires a writer claim.
      abortSignal?.throwIfAborted();
      if (!assertAdmittedActive) {
        throw new Error("embedded run requires an active admitted run");
      }
      assertAdmittedActive();
      refreshPreparedRuntimeSnapshot();
      if (isRunRetryBudgetExhausted(runRetryBudget)) {
        const message =
          `Exceeded retry limit after ${runRetryBudget.attemptsDispatched} attempts ` +
          `(counted attempts=${runRetryBudget.attemptsCounted}, max=${runRetryBudget.maxAttempts}).`;
        log.error(
          `[run-retry-limit] sessionKey=${params.sessionKey ?? params.sessionId} ` +
            `provider=${provider}/${modelId} attempts=${runRetryBudget.attemptsDispatched} ` +
            `countedAttempts=${runRetryBudget.attemptsCounted} maxAttempts=${runRetryBudget.maxAttempts}`,
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
            ...(attemptCarryover.modelAttempt ?? { provider, model: model.id }),
            ...outerContextTokenMeta,
            usageAccumulator,
            lastRunPromptUsage,
          }),
          replayInvalid: accumulatedReplayState.replayInvalid ? true : undefined,
          livenessState: "blocked",
        });
      }
      beginRunAttempt(runRetryBudget);
      const runtimeAuthRetry: boolean = authRetryPending;
      authRetryPending = false;
      attemptedThinking.add(thinkLevel);
      const codexAppServerRecoveryRetryAvailable = hasCodexAppServerRecoveryRetryBudget({
        alreadyRetried: codexAppServerRecoveryRetries > 0,
        runLoopIterations: runRetryBudget.attemptsCounted,
        maxRunLoopIterations: runRetryBudget.maxAttempts,
      });
      let recordedCompactionCount = 0;
      const attemptRunInput: PreparedEmbeddedRunInput = {
        ...admittedRunInput,
        runParams: {
          ...params,
          onContextAccountingEvent: (event) => {
            if (event.kind === "compaction") {
              recordedCompactionCount += 1;
            }
            contextRecoveryState.observeContextAccounting(event);
          },
        },
      };
      let dispatch: Awaited<ReturnType<typeof prepareAndDispatchEmbeddedRunAttempt>>;
      try {
        dispatch = await sessionPromptState.withSessionWriterContext(() =>
          prepareAndDispatchEmbeddedRunAttempt({
            permissionChange: permissionChanges.forAttempt(),
            runInput: attemptRunInput,
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
            isTurnTainted: turnTaintState.isTainted,
            allocateToolOutcomeOrdinal: terminalToolPresentation.allocateOrdinal,
            getPostCompactionAbortError: () => postCompactionAbortError,
            setPostCompactionAbortController: (controller) => {
              postCompactionAbortController = controller;
            },
            clearPostCompactionAbortController: (controller) => {
              if (postCompactionAbortController === controller) {
                postCompactionAbortController = undefined;
              }
            },
          }),
        );
      } catch (error) {
        const retryTrace = await failoverRetryController.recoverThrownHarnessAuthFailure(error);
        if (!retryTrace) {
          throw error;
        }
        traceAttempts.push(retryTrace);
        lastRetryFailoverReason = retryTrace.reason;
        continue;
      }
      startupStagesEmitted = dispatch.startupStagesEmitted;
      const { dispatchedAttempt, runtimePlan } = dispatch;
      failoverRetryController.setTransientRetryBudget(
        dispatchedAttempt.rawAttempt.providerRetryMaxRetries,
      );
      attemptCarryover.apply(dispatchedAttempt.rawAttempt);
      const normalizedAttempt = await normalizeEmbeddedRunAttempt({
        runInput: admittedRunInput,
        preparedRuntime,
        dispatchedAttempt,
        recordedCompactionCount,
        sessionPromptState,
        provider,
        modelId,
        bootstrapPromptWarningSignaturesSeen,
        usageAccumulator,
        lastRunPromptUsage,
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
        accumulatedReplayState = normalizedAttempt.replayState;
        recordRunRetry(runRetryBudget, normalizedAttempt.retryKind);
        continue;
      }
      bootstrapPromptWarningSignaturesSeen = normalizedAttempt.bootstrapPromptWarningSignaturesSeen;
      lastRunPromptUsage = normalizedAttempt.lastRunPromptUsage;
      accumulatedReplayState = normalizedAttempt.replayState;
      if (permissionChanges.prepareRestart()) {
        input.laneController.throwIfAborted();
        sessionPromptState.continueFromCurrentTranscript();
        // Operator-directed continuation is not a failed-model retry. The old
        // attempt's usage and tool evidence were normalized above, not replayed.
        recordRunRetry(runRetryBudget, "progress_continuation");
        continue;
      }
      const {
        attempt,
        sessionIdUsed,
        sessionFileUsed,
        currentAttemptAssistant,
        currentAttemptCompletedAssistant,
        attemptAssistant,
        terminalState,
        setTerminalLifecycleMeta,
        attemptCompactionCount,
        activeErrorContext,
        resolveReplayInvalidForAttempt,
      } = normalizedAttempt;
      const recovery = await recoverEmbeddedRunAttempt({
        runInput: admittedRunInput,
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
      const assistantFailureOutcome = await handleEmbeddedAssistantFailure({
        runParams: params,
        attempt,
        attemptAssistant,
        currentAttemptAssistant,
        terminalState,
        activeErrorContext,
        provider,
        providerOwner: preparedRuntime.snapshot().providerRuntimeHandle.plugin,
        modelId,
        model: model.id,
        thinkLevel,
        getThinkLevel: () => preparedRuntime.snapshot().thinkLevel,
        attemptedThinking,
        fallbackConfigured,
        pluginHarnessOwnsTransport,
        authProfileId: lastProfileId,
        authProfileStore: attemptAuthProfileStore,
        runtimeAuthRetry,
        maybeRefreshRuntimeAuthForAuthError,
        resolveAuthProfileFailureReason: failoverRetryController.resolveAuthProfileFailureReason,
        emptyErrorRetries,
        overloadProfileRotations,
        overloadProfileRotationLimit: failoverRetryController.overloadProfileRotationLimit,
        previousRetryFailoverReason: lastRetryFailoverReason,
        maybeMarkAuthProfileFailure: failoverRetryController.maybeMarkAuthProfileFailure,
        maybeRetryTransient: failoverRetryController.maybeRetryTransient,
        getTransientRetryCount: () => failoverRetryController.transientRetryCount,
        advanceAuthProfile: failoverRetryController.advanceAuthProfile,
        advanceRateLimitAuthProfile: failoverRetryController.advanceRateLimitAuthProfile,
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
      lastRetryFailoverReason = assistantFailureOutcome.lastRetryFailoverReason;
      if (assistantFailureOutcome.action === "retry") {
        continue;
      }
      let assistantProfileFailureReason = assistantFailureOutcome.assistantProfileFailureReason;
      const terminalToolPresentationText = terminalToolPresentation.read();
      const finalizedTerminal = await prepareTerminalWithSettledTurnFinalization({
        initial: {
          attempt,
          attemptAssistant,
          currentAttemptCompletedAssistant,
          sessionIdUsed,
          sessionFileUsed,
          terminalState,
          attemptCompactionCount,
        },
        terminalBase: {
          runParams: params,
          provider,
          providerOwner: preparedRuntime.snapshot().providerRuntimeHandle.plugin,
          model: model.id,
          activeErrorContext,
          authProfileStore: attemptAuthProfileStore,
          authProfileId: lastProfileId,
          outerContextTokenMeta,
          usageAccumulator,
          contextRecoveryState,
          resolvedToolResultFormat,
        },
        lastRunPromptUsage,
        finalization: {
          preparedAttempt: dispatchedAttempt.preparedAttempt,
          sessionTarget: sessionPromptState.sessionTarget,
          sessionWriterFence: sessionPromptState.sessionWriterFence,
          harness: agentHarness,
          modelApi: effectiveModel.api,
          executionContract,
          hasTerminalToolPresentation: Boolean(terminalToolPresentationText),
          createAttemptControls: input.laneController.createAttemptControls,
          abortSignal: input.laneController.abortSignal,
        },
      });
      const {
        attempt: terminalAttempt,
        attemptAssistant: terminalAttemptAssistant,
        terminalState: resolvedTerminalState,
        attemptCompactionCount: terminalAttemptCompactionCount,
        prepared: terminalPrepared,
        finalizationOutcome: settledTurnFinalizationOutcome,
      } = finalizedTerminal;
      lastRunPromptUsage = finalizedTerminal.lastRunPromptUsage;
      if (
        settledTurnFinalizationOutcome === "answered" ||
        settledTurnFinalizationOutcome === "completed-empty"
      ) {
        assistantProfileFailureReason = null;
      }

      const {
        agentMeta,
        reportedModelRef,
        finalAssistantVisibleText,
        finalAssistantRawText,
        payloadsWithToolMedia,
        recoveredFinalAssistantPayloadsAfterPromptTimeout,
        attemptToolSummary,
        failureSignal,
        terminalToolFailure,
      } = terminalPrepared;

      const terminalTimeoutResult = resolveEmbeddedRunTerminalTimeout({
        terminalPrepared,
        attempt: terminalAttempt,
        terminalState: resolvedTerminalState,
        resolveReplayInvalid: resolveReplayInvalidForAttempt,
        setTerminalLifecycleMeta,
        startedAtMs: started,
      });
      if (terminalTimeoutResult) {
        return terminalTimeoutResult;
      }

      const terminalAuthPlan = preparedRuntime.snapshot().activePreparedAuthPlan;
      const requestTransportOverrides =
        terminalAuthPlan.modelRoute?.requestTransportOverrides ??
        terminalAuthPlan.deferredRouteSupport?.requestTransportOverrides ??
        "none";
      const terminalResolution = await resolveEmbeddedRunTerminal({
        runParams: params,
        retryState: terminalRetryState,
        attempt: terminalAttempt,
        attemptAssistant: terminalAttemptAssistant,
        activeErrorContext,
        modelApi: effectiveModel.api,
        executionContract,
        terminalState: resolvedTerminalState,
        payloadsWithToolMedia,
        recoveredFinalAssistantPayloadsAfterPromptTimeout,
        finalAssistantVisibleText,
        finalAssistantRawText,
        agentMeta,
        attemptToolSummary,
        failureSignal,
        terminalToolFailure,
        maxReasoningOnlyRetryAttempts: DEFAULT_REASONING_ONLY_RETRY_LIMIT,
        maxEmptyResponseRetryAttempts: DEFAULT_EMPTY_RESPONSE_RETRY_LIMIT,
        attemptCompactionCount: terminalAttemptCompactionCount,
        replayState: accumulatedReplayState,
        activePromptPersisted: sessionPromptState.activePrompt.persisted,
        activateInternalPrompt: sessionPromptState.activateInternalPrompt,
        setSuppressNextUserMessagePersistence: (value) => {
          sessionPromptState.suppressNextUserMessagePersistence = value;
        },
        armPostCompactionGuard: () => postCompactionGuard.armPostCompaction(),
        readTerminalToolPresentation: () => terminalToolPresentationText,
        resolveReplayInvalid: resolveReplayInvalidForAttempt,
        setTerminalLifecycleMeta,
        maybeMarkAuthProfileFailure: failoverRetryController.maybeMarkAuthProfileFailure,
        assistantProfileFailureReason,
        startedAtMs: started,
        provider,
        modelId,
        modelTransportId: effectiveModel.id ?? modelId,
        modelTransportApi: effectiveModel.api ?? model.api,
        ...(effectiveModel.baseUrl ? { modelTransportBaseUrl: effectiveModel.baseUrl } : {}),
        requestTransportOverrides,
        authProfileId: lastProfileId,
        profileFailureStore,
        attemptAuthProfileStore,
        apiKeyInfo: getApiKeyInfo(),
        agentHarnessId: agentHarness.id,
        settledTurnFinalizationOutcome,
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
    // Successful registration already cleared the marker; every earlier exit
    // must restore terminal suppression before asynchronous settlement begins.
    contextRecoveryState.restoreTimeoutRecoveryAbandonment();
    permissionChanges.close();
    await settleEmbeddedRun({
      runInput: admittedRunInput,
      runtime: preparedRuntime,
      compaction: {
        state: contextRecoveryState,
        session: sessionPromptState,
        originalTarget: originalCompactionTarget,
        durable: durableCompactionAccounting,
        authority: accountingAuthority,
      },
      ownedContextEngineLease,
    });
  }
}
