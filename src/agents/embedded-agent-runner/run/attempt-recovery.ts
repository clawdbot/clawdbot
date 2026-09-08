import { isProviderRefusalAssistantError } from "@openclaw/llm-core/diagnostics";
import { emitAgentEvent } from "../../../infra/agent-events.js";
import { formatErrorMessage, toErrorObject } from "../../../infra/errors.js";
import { isRetryableAssistantError } from "../../../llm/utils/retry.js";
import { projectAgentRunAttemptTerminal } from "../../agent-run-terminal-outcome.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../defaults.js";
import type { FailoverReason } from "../../embedded-agent-helpers.js";
import { buildAssistantFailoverSignal } from "../../embedded-agent-helpers/assistant-message-failures.js";
import { findCliTerminalStopError, resolveFailoverReasonFromError } from "../../failover-error.js";
import { classifyFailoverSignal } from "../../failover/classify.js";
import { resolveRetryAfterMs } from "../../failover/retry-evidence.js";
import { LiveSessionModelSwitchError } from "../../live-model-switch-error.js";
import { shouldSwitchToLiveModel, clearLiveModelSwitchPending } from "../../live-model-switch.js";
import type { normalizeUsage } from "../../usage.js";
import { log } from "../logger.js";
import { getEmbeddedSessionPromptState } from "../session-prompt-state.js";
import type { EmbeddedAgentRunResult, TraceAttempt } from "../types.js";
import type { createUsageAccumulator } from "../usage-accumulator.js";
import type { normalizeEmbeddedRunAttempt } from "./attempt-normalization.js";
import { hasAsyncActivity, isCurrentAttemptReplaySafe } from "./attempt-terminal-evidence.js";
import { buildEmbeddedRunBlockedResult } from "./blocked-run-result.js";
import { resolveCodexAppServerRecoveryRetry } from "./codex-app-server-recovery.js";
import { resolveCompactionLiveModelSelection } from "./compaction-live-model-selection.js";
import type { createEmbeddedRunCompactionRuntime } from "./compaction-runtime.js";
import type { createEmbeddedRunContextRecoveryState } from "./context-recovery-state.js";
import type { PreparedEmbeddedRunInput } from "./execution-context.js";
import type { createEmbeddedRunFailoverRetryController } from "./failover-retry-controller.js";
import { buildErrorAgentMeta } from "./helpers.js";
import { resolveSettledToolBatchEvidence } from "./incomplete-turn-recovery.js";
import { recoverEmbeddedRunOverflow } from "./overflow-context-recovery.js";
import { handleEmbeddedPromptFailure } from "./prompt-failure.js";
import type { prepareAndDispatchEmbeddedRunAttempt } from "./run-attempt-dispatch.js";
import type { prepareEmbeddedRunRuntime } from "./runtime-preparation.js";
import type { createEmbeddedRunSessionPromptState } from "./session-prompt-state.js";
import { isEmbeddedRunTerminalInterrupted, isEmbeddedRunTimeoutFinal } from "./terminal-outcome.js";
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
      thinkLevel: ReturnType<PreparedRuntime["snapshot"]>["thinkLevel"];
    }
  | { action: "proceed" }
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
    sessionIdUsed,
    attemptAssistant,
    currentAttemptAssistant,
    currentAttemptCompletedAssistant,
    terminalState,
    setTerminalLifecycleMeta,
    attemptCompactionCount,
    activeErrorContext,
    resolveReplayInvalidForAttempt,
    assistantErrorText,
    canRestartForLiveSwitch,
  } = normalizedAttempt;
  const {
    aborted,
    externalAbort,
    promptError,
    promptErrorSource,
    timedOut,
    timedOutDuringCompaction,
    timedOutDuringToolExecution,
    timedOutByRunBudget,
    idleTimedOut,
  } = projectAgentRunAttemptTerminal(attempt.terminal);
  const terminalInterrupted = isEmbeddedRunTerminalInterrupted(terminalState.outcome);
  const currentAttemptReplaySafe = isCurrentAttemptReplaySafe(attempt);
  // Mid-turn overflow continues from the persisted tool results and never
  // replays the assistant call. Generic tools must still be fully settled; only
  // a batch whose exec result parked a Code Mode run (producer-recorded) may
  // continue with lifecycle items active — the nested call stays owned by the
  // code-mode run registry and resumes through `wait`, exactly as across turns.
  const settledEvidence = resolveSettledToolBatchEvidence(attempt);
  const midTurnBatchSettled =
    settledEvidence.allToolsProvenSettled || settledEvidence.parkedCodeModeRun;
  const canContinueSettledMidTurnOverflow =
    promptErrorSource === "precheck" &&
    attempt.preflightRecovery?.source === "mid-turn" &&
    midTurnBatchSettled &&
    !hasAsyncActivity(attempt.toolMetas);
  const { signalOwnedInterruption } = terminalState;
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
  const buildAttemptErrorMeta = () =>
    buildErrorAgentMeta({
      sessionId: sessionIdUsed,
      sessionFile: sessionPromptState.sessionFile,
      provider: preparedRuntime.provider,
      model: preparedRuntime.model.id,
      credentialSource: attempt.modelAttempt?.credentialSource,
      ...runtime.outerContextTokenMeta,
      usageAccumulator: input.usageAccumulator,
      lastRunPromptUsage: input.lastRunPromptUsage,
      currentAttemptAssistant,
    });

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
        agentMeta: buildAttemptErrorMeta(),
        attempt,
        replayInvalid,
      }),
    };
  }
  const requestedSelection = shouldSwitchToLiveModel({
    cfg: params.config,
    sessionPersistence: params.sessionPersistence,
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
  if (
    currentAttemptReplaySafe &&
    !signalOwnedInterruption &&
    requestedSelection &&
    canRestartForLiveSwitch
  ) {
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
  const assistantSignal =
    attemptAssistant?.stopReason === "error"
      ? buildAssistantFailoverSignal(attemptAssistant)
      : undefined;
  const assistantFailure = assistantSignal
    ? classifyFailoverSignal(assistantSignal, {
        providerPlugin: runtime.providerRuntimeHandle?.plugin,
      })
    : null;
  const assistantOverflowClassification =
    assistantOverflowCandidate === attemptAssistant
      ? assistantFailure
      : assistantOverflowCandidate?.stopReason === "error"
        ? classifyFailoverSignal(buildAssistantFailoverSignal(assistantOverflowCandidate), {
            providerPlugin: runtime.providerRuntimeHandle?.plugin,
          })
        : null;
  const failureReason = promptError
    ? resolveFailoverReasonFromError(promptError, preparedRuntime.provider)
    : assistantFailure?.kind === "reason"
      ? assistantFailure.reason
      : idleTimedOut ||
          (attemptAssistant &&
            isRetryableAssistantError(attemptAssistant) &&
            attemptAssistant.diagnostics?.some(
              (diagnostic) => diagnostic.type === "provider_transport_failure",
            ))
        ? "timeout"
        : null;
  const compactionSelection = resolveCompactionLiveModelSelection({
    current: {
      provider: preparedRuntime.provider,
      model: preparedRuntime.modelId,
      authProfileId: runtime.lastProfileId,
      authProfileIdSource:
        runtime.lastProfileId && runtime.lastProfileId === preparedRuntime.lockedProfileId
          ? "user"
          : "auto",
    },
    requested: currentAttemptReplaySafe ? requestedSelection : undefined,
  });
  const commonRecoveryInput = {
    runParams: params,
    state: input.contextRecoveryState,
    contextEngine: input.contextEngine,
    contextTokenBudget: runtime.contextTokenBudget,
    genericCompactionRecoveryAllowed: preparedRuntime.genericCompactionRecoveryAllowed,
    attempt,
    toolResultPromptProjectionState: getEmbeddedSessionPromptState(params.sessionId).toolResults,
    runtimeAuthPlan: runtimePlan.auth,
    resolvedSessionKey: runInput.resolvedSessionKey,
    sessionAgentId: input.sessionAgentId,
    contextEngineAgentId: runInput.contextEngineAgentId,
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
    prepareCompactedTranscriptRetry: sessionPromptState.prepareCompactedTranscriptRetry,
    armPostCompactionGuard: input.armPostCompactionGuard,
    usageAccumulator: input.usageAccumulator,
  };
  if (
    (currentAttemptReplaySafe || canContinueSettledMidTurnOverflow) &&
    (await recoverEmbeddedRunTimeout({
      ...commonRecoveryInput,
      timedOut,
      signalOwnedInterruption,
      timedOutDuringCompaction,
      timedOutDuringToolExecution,
      timedOutByRunBudget,
      lastRunPromptUsage: input.lastRunPromptUsage,
    }))
  ) {
    return retry();
  }
  // The finished attempt has released its tools. Continue its transcript, including
  // partial output and uncertain effects; never resubmit the original user request.
  if (
    !externalAbort &&
    !terminalState.signalOwnedInterruption &&
    !timedOutByRunBudget &&
    !timedOutDuringCompaction &&
    !timedOutDuringToolExecution &&
    (!terminalInterrupted || (currentAttemptReplaySafe && !runtime.pluginHarnessOwnsTransport)) &&
    !attempt.yieldDetected &&
    !attempt.clientToolCalls &&
    !attempt.codexAppServerFailure &&
    !findCliTerminalStopError(promptError) &&
    (!promptError || promptErrorSource === "prompt") &&
    !isProviderRefusalAssistantError(attemptAssistant) &&
    failureReason &&
    (await failoverRetryController.maybeRetryTransient({
      reason: failureReason,
      message: promptError ? formatErrorMessage(promptError) : assistantSignal?.message,
      retryAfterMs: promptError
        ? resolveRetryAfterMs(formatErrorMessage(promptError), Date.now(), promptError)
        : assistantSignal?.retryAfterMs,
      onRetry: async ({ attempt: retryAttempt, maxRetries, delayMs, reason }) => {
        const event = {
          stream: "run_status",
          data: {
            phase: "retrying",
            message:
              reason === "rate_limit"
                ? `Retrying… ${retryAttempt + 1}/${maxRetries + 1}`
                : `Provider temporarily unavailable. Retrying in ${Math.ceil(delayMs / 1_000)}s (${retryAttempt}/${maxRetries}).`,
            retryAttempt,
            maxRetries,
            delayMs,
            attempt: retryAttempt + 1,
            maxAttempts: maxRetries + 1,
            reason,
          },
        };
        emitAgentEvent({ runId: params.runId, sessionKey: params.sessionKey, ...event });
        await params.onAgentEvent?.(event);
      },
    }))
  ) {
    runInput.laneController.throwIfAborted();
    sessionPromptState.markOwnedTranscriptRetry();
    sessionPromptState.continueFromCurrentTranscript({
      includeToolFailureInstruction: Boolean(attempt.lastToolError),
    });
    return retry({ lastRetryFailoverReason: failureReason });
  }
  if (!currentAttemptReplaySafe && !canContinueSettledMidTurnOverflow) {
    return { action: "proceed" };
  }

  const overflowRecovery = await recoverEmbeddedRunOverflow({
    ...commonRecoveryInput,
    aborted,
    signalOwnedInterruption,
    promptError,
    assistantErrorText:
      currentAttemptCompletedAssistant !== undefined
        ? assistantOverflowCandidate?.errorMessage
        : assistantErrorText,
    assistantOverflowCandidate: assistantOverflowCandidate
      ? { message: assistantOverflowCandidate, classification: assistantOverflowClassification }
      : undefined,
    attemptCompactionCount,
    prepareCurrentTranscriptRetry: sessionPromptState.continueFromCurrentTranscript,
    markOwnedTranscriptRetry: sessionPromptState.markOwnedTranscriptRetry,
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
        agentMeta: buildAttemptErrorMeta(),
        attempt,
        replayInvalid,
        finalPromptText: attempt.finalPromptText,
      }),
    };
  }
  // Profile rotation and original-prompt replay still require replay-safe evidence.
  if (!currentAttemptReplaySafe) {
    return { action: "proceed" };
  }
  const hasCodexAppServerTimeoutOutcome = Boolean(
    attempt.codexAppServerFailure &&
    (attempt.promptTimeoutOutcome || isEmbeddedRunTimeoutFinal(attempt)),
  );
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
    if (!hasCodexAppServerTimeoutOutcome) {
      throw toErrorObject(promptError, "Prompt failed");
    }
  }
  if (
    promptError &&
    !terminalInterrupted &&
    promptErrorSource !== "compaction" &&
    !hasCodexAppServerTimeoutOutcome
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
      buildErrorAgentMeta: buildAttemptErrorMeta,
      startedAtMs: runInput.startedAtMs,
      fallbackConfigured: runInput.fallbackConfigured,
      aborted,
      externalAbort,
      pluginHarnessOwnsTransport: runtime.pluginHarnessOwnsTransport,
      timedOutByRunBudget,
      failover: failoverRetryController,
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
  return { action: "proceed" };
}
