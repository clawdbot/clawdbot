import { formatErrorMessage, toErrorObject } from "../../../infra/errors.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../defaults.js";
import type { FailoverReason } from "../../embedded-agent-helpers.js";
import { LiveSessionModelSwitchError } from "../../live-model-switch-error.js";
import { shouldSwitchToLiveModel, clearLiveModelSwitchPending } from "../../live-model-switch.js";
import type { normalizeUsage } from "../../usage.js";
import { log } from "../logger.js";
import type { EmbeddedAgentRunResult, TraceAttempt } from "../types.js";
import type { createUsageAccumulator } from "../usage-accumulator.js";
import type { prepareAndDispatchEmbeddedRunAttempt } from "./attempt-dispatch-preparation.js";
import type { normalizeEmbeddedRunAttempt } from "./attempt-normalization.js";
import { buildEmbeddedRunBlockedResult } from "./blocked-run-result.js";
import { resolveCodexAppServerRecoveryRetry } from "./codex-app-server-recovery.js";
import { resolveCompactionLiveModelSelection } from "./compaction-live-model-selection.js";
import type { createEmbeddedRunCompactionRuntime } from "./compaction-runtime.js";
import type { createEmbeddedRunContextRecoveryState } from "./context-recovery-state.js";
import type { PreparedEmbeddedRunInput } from "./execution-context.js";
import type { createEmbeddedRunFailoverRetryController } from "./failover-retry-controller.js";
import { buildErrorAgentMeta } from "./helpers.js";
import { recoverEmbeddedRunOverflow } from "./overflow-context-recovery.js";
import { handleEmbeddedPromptFailure } from "./prompt-failure.js";
import type { prepareEmbeddedRunRuntime } from "./runtime-preparation.js";
import type { createEmbeddedRunSessionPromptState } from "./session-prompt-state.js";
import { recoverEmbeddedRunTimeout } from "./timeout-context-recovery.js";

type PreparedRuntime = Awaited<ReturnType<typeof prepareEmbeddedRunRuntime>>;
type NormalizedAttempt = Extract<
  Awaited<ReturnType<typeof normalizeEmbeddedRunAttempt>>,
  { action: "proceed" }
>;
type Dispatch = Awaited<ReturnType<typeof prepareAndDispatchEmbeddedRunAttempt>>;
type SessionPromptState = ReturnType<typeof createEmbeddedRunSessionPromptState>;
type FailoverRetryController = ReturnType<typeof createEmbeddedRunFailoverRetryController>;
type CompactionRuntime = ReturnType<typeof createEmbeddedRunCompactionRuntime>;

export async function recoverEmbeddedRunAttempt(input: {
  runInput: PreparedEmbeddedRunInput;
  preparedRuntime: PreparedRuntime;
  normalizedAttempt: NormalizedAttempt;
  runtimePlan: Dispatch["runtimePlan"];
  sessionPromptState: SessionPromptState;
  failoverRetryController: FailoverRetryController;
  compactionRuntime: CompactionRuntime;
  contextEngine: Parameters<typeof recoverEmbeddedRunTimeout>[0]["contextEngine"];
  contextRecoveryState: ReturnType<typeof createEmbeddedRunContextRecoveryState>;
  resolveContextEnginePluginId: Parameters<
    typeof recoverEmbeddedRunTimeout
  >[0]["resolveContextEnginePluginId"];
  buildRuntimeSettings: Parameters<typeof recoverEmbeddedRunTimeout>[0]["buildRuntimeSettings"];
  armPostCompactionGuard: () => void;
  usageAccumulator: ReturnType<typeof createUsageAccumulator>;
  lastRunPromptUsage: ReturnType<typeof normalizeUsage> | undefined;
  lastTurnTotal: number | undefined;
  runtimeAuthRetry: boolean;
  codexAppServerRecoveryRetryAvailable: boolean;
  codexAppServerRecoveryRetries: number;
  lastRetryFailoverReason: FailoverReason | null;
  traceAttempts: TraceAttempt[];
  sessionAgentId: string;
}): Promise<
  | { action: "complete"; result: EmbeddedAgentRunResult }
  | {
      action: "retry";
      authRetryPending: boolean;
      codexAppServerRecoveryRetries: number;
      lastRetryFailoverReason: FailoverReason | null;
      thinkLevel: PreparedRuntime["snapshot"] extends () => infer Snapshot
        ? Snapshot extends { thinkLevel: infer ThinkLevel }
          ? ThinkLevel
          : never
        : never;
    }
  | { action: "proceed"; shouldSurfaceCodexCompletionTimeout: boolean }
> {
  const {
    runInput,
    preparedRuntime,
    normalizedAttempt,
    runtimePlan,
    sessionPromptState,
    failoverRetryController,
    compactionRuntime,
  } = input;
  const params = runInput.runParams;
  const runtime = preparedRuntime.snapshot();
  const {
    attempt,
    aborted,
    externalAbort,
    promptError,
    promptErrorSource,
    timedOut,
    timedOutDuringCompaction,
    timedOutDuringToolExecution,
    timedOutByRunBudget,
    sessionIdUsed,
    attemptAssistant,
    currentAttemptCompletedAssistant,
    terminalInterrupted,
    signalOwnedInterruption,
    setTerminalLifecycleMeta,
    attemptCompactionCount,
    activeErrorContext,
    resolveReplayInvalidForAttempt,
    assistantErrorText,
    canRestartForLiveSwitch,
  } = normalizedAttempt;
  const assistantOverflowCandidate =
    currentAttemptCompletedAssistant !== undefined
      ? currentAttemptCompletedAssistant.stopReason === "error" ||
        currentAttemptCompletedAssistant.stopReason === "length"
        ? currentAttemptCompletedAssistant
        : undefined
      : attemptAssistant?.stopReason === "error" || attemptAssistant?.stopReason === "length"
        ? attemptAssistant
        : undefined;
  const retry = (updates?: {
    authRetryPending?: boolean;
    codexAppServerRecoveryRetries?: number;
    lastRetryFailoverReason?: FailoverReason | null;
    thinkLevel?: typeof runtime.thinkLevel;
  }) => ({
    action: "retry" as const,
    authRetryPending: updates?.authRetryPending ?? false,
    codexAppServerRecoveryRetries:
      updates?.codexAppServerRecoveryRetries ?? input.codexAppServerRecoveryRetries,
    lastRetryFailoverReason:
      updates?.lastRetryFailoverReason === undefined
        ? input.lastRetryFailoverReason
        : updates.lastRetryFailoverReason,
    thinkLevel: updates?.thinkLevel ?? runtime.thinkLevel,
  });

  const requestedSelection = shouldSwitchToLiveModel({
    cfg: params.config,
    sessionKey: runInput.resolvedSessionKey,
    agentId: params.agentId,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
    currentProvider: preparedRuntime.provider,
    currentModel: preparedRuntime.modelId,
    currentAgentRuntimeOverride: params.agentHarnessRuntimeOverride,
    currentAuthProfileId: preparedRuntime.preferredProfileId,
    currentAuthProfileIdSource: params.authProfileIdSource,
  });
  if (!signalOwnedInterruption && requestedSelection && canRestartForLiveSwitch) {
    await clearLiveModelSwitchPending({
      cfg: params.config,
      sessionKey: runInput.resolvedSessionKey,
      agentId: params.agentId,
    });
    log.info(
      `live session model switch requested during active attempt for ${params.sessionId}: ` +
        `${preparedRuntime.provider}/${preparedRuntime.modelId} -> ${requestedSelection.provider}/${requestedSelection.model}`,
    );
    throw new LiveSessionModelSwitchError(requestedSelection);
  }
  const compactionSelection = resolveCompactionLiveModelSelection({
    current: {
      provider: preparedRuntime.provider,
      model: preparedRuntime.modelId,
      authProfileId: runtime.lastProfileId,
      authProfileIdSource: preparedRuntime.lockedProfileId ? "user" : "auto",
    },
    requested: requestedSelection,
  });
  const commonRecoveryInput = {
    runParams: params,
    state: input.contextRecoveryState,
    contextEngine: input.contextEngine,
    contextTokenBudget: runtime.contextTokenBudget,
    genericCompactionRecoveryAllowed: preparedRuntime.genericCompactionRecoveryAllowed,
    attempt,
    runtimeAuthPlan: runtimePlan.auth,
    resolvedSessionKey: runInput.resolvedSessionKey,
    sessionAgentId: input.sessionAgentId,
    agentDir: runInput.agentDir,
    workspaceDir: runInput.workspaceDir,
    provider: compactionSelection.provider,
    modelId: compactionSelection.model,
    harnessRuntime: runtime.agentHarness.id,
    thinkLevel: runtime.thinkLevel,
    authProfileId: compactionSelection.authProfileId,
    authProfileIdSource: compactionSelection.authProfileIdSource,
    resolveContextEnginePluginId: input.resolveContextEnginePluginId,
    buildRuntimeSettings: input.buildRuntimeSettings,
    ...compactionRuntime,
    getActiveSession: () => ({
      id: sessionPromptState.sessionId,
      file: sessionPromptState.sessionFile,
      target: sessionPromptState.sessionTarget,
    }),
    armPostCompactionGuard: input.armPostCompactionGuard,
  };
  if (
    await recoverEmbeddedRunTimeout({
      ...commonRecoveryInput,
      timedOut,
      signalOwnedInterruption,
      timedOutDuringCompaction,
      timedOutDuringToolExecution,
      timedOutByRunBudget,
      lastRunPromptUsage: input.lastRunPromptUsage,
    })
  ) {
    return retry();
  }
  const overflowRecovery = await recoverEmbeddedRunOverflow({
    ...commonRecoveryInput,
    aborted,
    signalOwnedInterruption,
    promptError,
    assistantErrorText,
    assistantOverflowCandidate,
    attemptCompactionCount,
    prepareCurrentTranscriptRetry: sessionPromptState.continueFromCurrentTranscript,
    prepareCompactedTranscriptRetry: sessionPromptState.prepareCompactedTranscriptRetry,
  });
  if (overflowRecovery.action === "retry") {
    return retry();
  }
  if (overflowRecovery.action === "surface") {
    const replayInvalid = resolveReplayInvalidForAttempt();
    setTerminalLifecycleMeta({ replayInvalid, livenessState: "blocked" });
    return {
      action: "complete",
      result: buildEmbeddedRunBlockedResult({
        text: overflowRecovery.userText,
        errorKind: overflowRecovery.kind,
        errorMessage: overflowRecovery.errorText,
        durationMs: Date.now() - runInput.startedAtMs,
        agentMeta: buildErrorAgentMeta({
          sessionId: sessionIdUsed,
          sessionFile: sessionPromptState.sessionFile,
          provider: preparedRuntime.provider,
          model: preparedRuntime.model.id,
          ...runtime.outerContextTokenMeta,
          usageAccumulator: input.usageAccumulator,
          lastRunPromptUsage: input.lastRunPromptUsage,
          lastAssistant: attemptAssistant,
          lastTurnTotal: input.lastTurnTotal,
        }),
        attempt,
        replayInvalid,
        finalPromptText: attempt.finalPromptText,
      }),
    };
  }
  if (promptErrorSource === "hook:before_agent_run" && !terminalInterrupted) {
    const errorText = formatErrorMessage(promptError);
    const replayInvalid = resolveReplayInvalidForAttempt();
    setTerminalLifecycleMeta({ replayInvalid, livenessState: "blocked" });
    return {
      action: "complete",
      result: buildEmbeddedRunBlockedResult({
        text: errorText,
        errorKind: "hook_block",
        errorMessage: errorText,
        durationMs: Date.now() - runInput.startedAtMs,
        agentMeta: buildErrorAgentMeta({
          sessionId: sessionIdUsed,
          sessionFile: sessionPromptState.sessionFile,
          provider: preparedRuntime.provider,
          model: preparedRuntime.model.id,
          ...runtime.outerContextTokenMeta,
          usageAccumulator: input.usageAccumulator,
          lastRunPromptUsage: input.lastRunPromptUsage,
          lastAssistant: attemptAssistant,
          lastTurnTotal: input.lastTurnTotal,
        }),
        attempt,
        replayInvalid,
      }),
    };
  }
  const hasRecoverableCodexAppServerTimeoutOutcome = Boolean(
    attempt.codexAppServerFailure && attempt.promptTimeoutOutcome,
  );
  let shouldSurfaceCodexCompletionTimeout = false;
  if (promptError && promptErrorSource !== "compaction" && attempt.codexAppServerFailure) {
    const recoveryRetry = resolveCodexAppServerRecoveryRetry({
      attempt,
      retryAvailable: input.codexAppServerRecoveryRetryAvailable,
    });
    if (recoveryRetry.retry) {
      runInput.laneController.throwIfAborted();
      sessionPromptState.suppressNextUserMessagePersistence = true;
      log.warn(
        `codex app-server replay-safe failure; retrying once failureKind=${attempt.codexAppServerFailure?.kind} ` +
          `runId=${params.runId} sessionId=${params.sessionId}`,
      );
      return retry({ codexAppServerRecoveryRetries: input.codexAppServerRecoveryRetries + 1 });
    }
    shouldSurfaceCodexCompletionTimeout =
      attempt.codexAppServerFailure?.kind === "turn_completion_idle_timeout" && attempt.timedOut;
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
    !terminalInterrupted &&
    promptErrorSource !== "compaction" &&
    !hasRecoverableCodexAppServerTimeoutOutcome &&
    !shouldSurfaceCodexCompletionTimeout
  ) {
    const promptFailureOutcome = await handleEmbeddedPromptFailure({
      runParams: params,
      attempt,
      promptError,
      promptErrorSource,
      activeErrorContext,
      provider: preparedRuntime.provider,
      modelId: preparedRuntime.modelId,
      authProfileId: runtime.lastProfileId,
      authProfileStore: preparedRuntime.attemptAuthProfileStore,
      sessionIdUsed,
      lane: runInput.globalLane,
      agentDir: runInput.agentDir,
      suspensionSessionId: sessionPromptState.sessionId ?? params.sessionId,
      runtimeAuthRetry: input.runtimeAuthRetry,
      maybeRefreshRuntimeAuthForAuthError: preparedRuntime.maybeRefreshRuntimeAuthForAuthError,
      suspendForFailure: runInput.suspendForFailure,
      resolveReplayInvalid: resolveReplayInvalidForAttempt,
      setTerminalLifecycleMeta,
      buildErrorAgentMeta: () =>
        buildErrorAgentMeta({
          sessionId: sessionIdUsed,
          sessionFile: sessionPromptState.sessionFile,
          provider: preparedRuntime.provider,
          model: preparedRuntime.model.id,
          ...runtime.outerContextTokenMeta,
          usageAccumulator: input.usageAccumulator,
          lastRunPromptUsage: input.lastRunPromptUsage,
          lastAssistant: attemptAssistant,
          lastTurnTotal: input.lastTurnTotal,
        }),
      startedAtMs: runInput.startedAtMs,
      fallbackConfigured: runInput.fallbackConfigured,
      aborted,
      externalAbort,
      pluginHarnessOwnsTransport: runtime.pluginHarnessOwnsTransport,
      timedOutByRunBudget,
      resolveAuthProfileFailureReason: failoverRetryController.resolveAuthProfileFailureReason,
      maybeEscalateRateLimitProfileFallback:
        failoverRetryController.maybeEscalateRateLimitProfileFallback,
      advanceAttemptAuthProfile: preparedRuntime.advanceAttemptAuthProfile,
      maybeMarkAuthProfileFailure: failoverRetryController.maybeMarkAuthProfileFailure,
      maybeBackoffBeforeOverloadFailover:
        failoverRetryController.maybeBackoffBeforeOverloadFailover,
      attemptedThinking: preparedRuntime.attemptedThinking,
      thinkLevel: runtime.thinkLevel,
      getThinkLevel: () => preparedRuntime.snapshot().thinkLevel,
      traceAttempts: input.traceAttempts,
      previousRetryFailoverReason: input.lastRetryFailoverReason,
    });
    if (promptFailureOutcome.action === "complete") {
      return { action: "complete", result: promptFailureOutcome.result };
    }
    preparedRuntime.setThinkLevel(promptFailureOutcome.thinkLevel);
    return retry({
      authRetryPending: promptFailureOutcome.authRetryPending,
      lastRetryFailoverReason: promptFailureOutcome.lastRetryFailoverReason,
      thinkLevel: promptFailureOutcome.thinkLevel,
    });
  }
  return { action: "proceed", shouldSurfaceCodexCompletionTimeout };
}
