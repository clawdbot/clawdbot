import { parseSqliteSessionFileMarker } from "../../../config/sessions/sqlite-marker.js";
import { formatAssistantErrorText } from "../../embedded-agent-helpers.js";
import { createAgentRunDirectAbortError } from "../../run-termination.js";
import { normalizeUsage, type UsageLike } from "../../usage.js";
import { hasOutboundDeliveryEvidence } from "../delivery-evidence.js";
import { log } from "../logger.js";
import { createEmbeddedRunReplayState, observeReplayMetadata } from "../replay-state.js";
import type { EmbeddedAgentRunResult } from "../types.js";
import type { createUsageAccumulator } from "../usage-accumulator.js";
import { mergeUsageIntoAccumulator } from "../usage-accumulator.js";
import type { createEmbeddedRunContextRecoveryState } from "./context-recovery-state.js";
import type { PreparedEmbeddedRunInput } from "./execution-context.js";
import { resolveRunFailoverDecision } from "./failover-policy.js";
import {
  buildErrorAgentMeta,
  isAssistantForModelRef,
  resolveActiveErrorContext,
  resolveLatestCallUsage,
} from "./helpers.js";
import {
  MAX_CONSECUTIVE_IDLE_TIMEOUTS_BEFORE_OUTPUT,
  stepIdleTimeoutBreaker,
  type createIdleTimeoutBreakerState,
} from "./idle-timeout-breaker.js";
import { resolveReplayInvalidFlag } from "./incomplete-turn.js";
import { handleRetryLimitExhaustion } from "./retry-limit.js";
import type { dispatchEmbeddedRunAttempt } from "./run-attempt-dispatch.js";
import {
  hasCompletedModelProgressForIdleBreaker,
  normalizeEmbeddedRunAttemptResult,
} from "./run-attempt-result.js";
import type { prepareEmbeddedRunRuntime } from "./runtime-preparation.js";
import type { createEmbeddedRunSessionPromptState } from "./session-prompt-state.js";
import {
  isEmbeddedRunTerminalAbort,
  isEmbeddedRunTerminalInterrupted,
  isEmbeddedRunTerminalTimeout,
  resolveEmbeddedRunAttemptTerminalOutcome,
} from "./terminal-outcome.js";

type PreparedRuntime = Awaited<ReturnType<typeof prepareEmbeddedRunRuntime>>;
type SessionPromptState = ReturnType<typeof createEmbeddedRunSessionPromptState>;
type ReplayState = ReturnType<typeof createEmbeddedRunReplayState>;

export async function normalizeEmbeddedRunAttempt(input: {
  runInput: PreparedEmbeddedRunInput;
  preparedRuntime: PreparedRuntime;
  dispatchedAttempt: Awaited<ReturnType<typeof dispatchEmbeddedRunAttempt>>;
  sessionPromptState: SessionPromptState;
  provider: string;
  modelId: string;
  bootstrapPromptWarningSignaturesSeen: string[];
  usageAccumulator: ReturnType<typeof createUsageAccumulator>;
  lastRunPromptUsage: ReturnType<typeof normalizeUsage> | undefined;
  lastTurnTotal: number | undefined;
  idleTimeoutBreakerState: ReturnType<typeof createIdleTimeoutBreakerState>;
  contextRecoveryState: ReturnType<typeof createEmbeddedRunContextRecoveryState>;
  replayState: ReplayState;
  lastRetryFailoverReason: Parameters<typeof resolveRunFailoverDecision>[0]["failoverReason"];
}): Promise<
  | { action: "complete"; result: EmbeddedAgentRunResult }
  | {
      action: "retry";
      bootstrapPromptWarningSignaturesSeen: string[];
      lastRunPromptUsage: ReturnType<typeof normalizeUsage> | undefined;
      lastTurnTotal: number | undefined;
      replayState: ReplayState;
    }
  | {
      action: "proceed";
      bootstrapPromptWarningSignaturesSeen: string[];
      lastRunPromptUsage: ReturnType<typeof normalizeUsage> | undefined;
      lastTurnTotal: number | undefined;
      replayState: ReplayState;
      attempt: ReturnType<typeof normalizeEmbeddedRunAttemptResult>;
      aborted: boolean;
      externalAbort: boolean;
      promptError: unknown;
      promptErrorSource: ReturnType<typeof normalizeEmbeddedRunAttemptResult>["promptErrorSource"];
      timedOut: boolean;
      idleTimedOut: boolean;
      timedOutDuringCompaction: boolean;
      timedOutDuringToolExecution: boolean;
      timedOutByRunBudget: boolean;
      sessionIdUsed: string;
      sessionFileUsed: string | undefined;
      currentAttemptAssistant: ReturnType<
        typeof normalizeEmbeddedRunAttemptResult
      >["currentAttemptAssistant"];
      currentAttemptCompletedAssistant: ReturnType<
        typeof normalizeEmbeddedRunAttemptResult
      >["currentAttemptCompletedAssistant"];
      attemptAssistant: ReturnType<
        typeof normalizeEmbeddedRunAttemptResult
      >["currentAttemptAssistant"];
      terminalOutcome: ReturnType<typeof resolveEmbeddedRunAttemptTerminalOutcome>;
      terminalAborted: boolean;
      terminalTimedOut: boolean;
      terminalInterrupted: boolean;
      signalOwnedInterruption: boolean;
      setTerminalLifecycleMeta: NonNullable<
        ReturnType<typeof normalizeEmbeddedRunAttemptResult>["setTerminalLifecycleMeta"]
      >;
      attemptCompactionCount: number;
      activeErrorContext: ReturnType<typeof resolveActiveErrorContext>;
      resolveReplayInvalidForAttempt: (incompleteTurnText?: string | null) => boolean;
      assistantErrorText: string | undefined;
      canRestartForLiveSwitch: boolean;
    }
> {
  const { runInput, preparedRuntime, dispatchedAttempt, sessionPromptState, provider, modelId } =
    input;
  const params = runInput.runParams;
  const runtime = preparedRuntime.snapshot();
  const attempt = normalizeEmbeddedRunAttemptResult(dispatchedAttempt.rawAttempt);
  await sessionPromptState.waitForCurrentUserMessagePersistence();
  sessionPromptState.suppressNextUserMessagePersistence = sessionPromptState.activePrompt.persisted;
  if (dispatchedAttempt.cancellationRequested) {
    runInput.laneController.throwIfAborted();
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
    currentAttemptCompletedAssistant,
  } = attempt;
  const timedOutDuringToolExecution = attempt.timedOutDuringToolExecution ?? false;
  const timedOutByRunBudget = attempt.timedOutByRunBudget ?? false;
  const sessionAssistantForCandidate =
    !currentAttemptAssistant &&
    !isAssistantForModelRef(sessionLastAssistant, {
      provider: runtime.effectiveModel.provider,
      model: runtime.effectiveModel.id,
    })
      ? undefined
      : sessionLastAssistant;
  const attemptAssistant = currentAttemptAssistant ?? sessionAssistantForCandidate;
  const terminalOutcome = resolveEmbeddedRunAttemptTerminalOutcome({
    attempt,
    assistant: currentAttemptAssistant,
    abortSignal: params.abortSignal,
  });
  const terminalAborted = isEmbeddedRunTerminalAbort(terminalOutcome);
  const terminalTimedOut = isEmbeddedRunTerminalTimeout(terminalOutcome);
  const terminalInterrupted = isEmbeddedRunTerminalInterrupted(terminalOutcome);
  const signalOwnedInterruption = terminalInterrupted && params.abortSignal?.aborted === true;
  const setTerminalLifecycleMeta: NonNullable<typeof attempt.setTerminalLifecycleMeta> = (meta) => {
    const { stopReason, ...remainingMeta } = meta;
    const terminalStopReason = terminalInterrupted ? terminalOutcome.stopReason : stopReason;
    attempt.setTerminalLifecycleMeta?.({
      ...remainingMeta,
      ...(terminalStopReason ? { stopReason: terminalStopReason } : {}),
      aborted: terminalAborted,
    });
  };
  const previousSessionId = sessionPromptState.sessionId;
  const previousSessionFile = sessionPromptState.sessionFile;
  sessionPromptState.adoptSessionId(sessionIdUsed);
  if (sessionFileUsed && sessionFileUsed !== sessionPromptState.sessionFile) {
    sessionPromptState.sessionFile = sessionFileUsed;
  }
  if (
    (sessionIdUsed && sessionIdUsed !== previousSessionId) ||
    (sessionFileUsed && sessionFileUsed !== previousSessionFile)
  ) {
    const marker = parseSqliteSessionFileMarker(sessionPromptState.sessionFile);
    sessionPromptState.sessionTarget = marker
      ? {
          agentId: marker.agentId,
          sessionId: marker.sessionId,
          sessionKey: runInput.resolvedSessionKey,
          storePath: marker.storePath,
        }
      : undefined;
  }
  const bootstrapPromptWarningSignaturesSeen =
    attempt.bootstrapPromptWarningSignaturesSeen ??
    (attempt.bootstrapPromptWarningSignature
      ? Array.from(
          new Set([
            ...input.bootstrapPromptWarningSignaturesSeen,
            attempt.bootstrapPromptWarningSignature,
          ]),
        )
      : input.bootstrapPromptWarningSignaturesSeen);
  const lastAssistantUsage = normalizeUsage(sessionLastAssistant?.usage as UsageLike);
  const currentAttemptAssistantUsage = normalizeUsage(currentAttemptAssistant?.usage as UsageLike);
  const promptCacheLastCallUsage = normalizeUsage(attempt.promptCache?.lastCallUsage as UsageLike);
  const callUsage = resolveLatestCallUsage({
    currentAttemptCandidates: [currentAttemptAssistantUsage, promptCacheLastCallUsage],
    carriedCandidates: [input.lastRunPromptUsage, lastAssistantUsage],
  });
  const attemptUsage = attempt.attemptUsage ?? callUsage.currentAttempt;
  mergeUsageIntoAccumulator(input.usageAccumulator, attemptUsage);
  const lastRunPromptUsage = callUsage.latest;
  const lastTurnTotal = callUsage.latest?.total;
  const breakerStep = stepIdleTimeoutBreaker(input.idleTimeoutBreakerState, {
    idleTimedOut: terminalTimedOut && idleTimedOut,
    completedModelProgress: hasCompletedModelProgressForIdleBreaker(attempt),
    outputTokens: attemptUsage?.output,
  });
  if (breakerStep.tripped) {
    const message =
      `Idle-timeout cost-runaway breaker tripped: ${breakerStep.consecutive} consecutive idle timeouts ` +
      `without completed model progress (cap=${MAX_CONSECUTIVE_IDLE_TIMEOUTS_BEFORE_OUTPUT}). ` +
      "Halting further attempts to bound paid model calls. See issue #76293.";
    log.error(
      `[idle-timeout-circuit-breaker-tripped] sessionKey=${params.sessionKey ?? params.sessionId} ` +
        `provider=${provider}/${modelId} consecutive=${breakerStep.consecutive} ` +
        `cap=${MAX_CONSECUTIVE_IDLE_TIMEOUTS_BEFORE_OUTPUT}`,
    );
    return {
      action: "complete",
      result: handleRetryLimitExhaustion({
        message,
        decision: resolveRunFailoverDecision({
          stage: "retry_limit",
          fallbackConfigured: runInput.fallbackConfigured,
          failoverReason: input.lastRetryFailoverReason,
        }),
        provider,
        model: modelId,
        profileId: runtime.lastProfileId,
        durationMs: Date.now() - runInput.startedAtMs,
        agentMeta: buildErrorAgentMeta({
          sessionId: sessionPromptState.sessionId,
          sessionFile: sessionPromptState.sessionFile,
          provider,
          model: preparedRuntime.model.id,
          ...runtime.outerContextTokenMeta,
          usageAccumulator: input.usageAccumulator,
          lastRunPromptUsage,
          lastTurnTotal,
        }),
        replayInvalid: input.replayState.replayInvalid ? true : undefined,
        livenessState: "blocked",
      }),
    };
  }
  const attemptCompactionCount = Math.max(0, attempt.compactionCount ?? 0);
  input.contextRecoveryState.autoCompactionCount += attemptCompactionCount;
  if (
    typeof attempt.compactionTokensAfter === "number" &&
    Number.isFinite(attempt.compactionTokensAfter) &&
    attempt.compactionTokensAfter >= 0
  ) {
    input.contextRecoveryState.lastCompactionTokensAfter = Math.floor(
      attempt.compactionTokensAfter,
    );
  }
  if (attempt.contextBudgetStatus) {
    input.contextRecoveryState.lastContextBudgetStatus = attempt.contextBudgetStatus;
  }
  const activeErrorContext = resolveActiveErrorContext({
    provider,
    model: modelId,
    assistant: attemptAssistant,
  });
  let replayState = input.replayState;
  const resolveReplayInvalidForAttempt = (incompleteTurnText?: string | null) =>
    replayState.replayInvalid || resolveReplayInvalidFlag({ attempt, incompleteTurnText });
  if (resolveReplayInvalidForAttempt(null)) {
    replayState.replayInvalid = true;
  }
  replayState = observeReplayMetadata(replayState, attempt.replayMetadata);
  const formattedAssistantErrorText = sessionAssistantForCandidate
    ? formatAssistantErrorText(sessionAssistantForCandidate, {
        cfg: params.config,
        sessionKey: runInput.resolvedSessionKey ?? params.sessionId,
        provider: activeErrorContext.provider,
        model: activeErrorContext.model,
        authMode: runtime.lastProfileId
          ? preparedRuntime.attemptAuthProfileStore.profiles?.[runtime.lastProfileId]?.type
          : undefined,
      })
    : undefined;
  const assistantErrorText =
    sessionAssistantForCandidate?.stopReason === "error"
      ? sessionAssistantForCandidate.errorMessage?.trim() || formattedAssistantErrorText
      : undefined;
  if (!signalOwnedInterruption && !preparedRuntime.nativeModelOwned && preflightRecovery?.handled) {
    const retryingFromTranscript = preflightRecovery.source === "mid-turn";
    log.info(
      `[context-overflow-precheck] early recovery route=${preflightRecovery.route} completed for ${provider}/${modelId}; ` +
        (retryingFromTranscript ? "retrying from current transcript" : "retrying prompt"),
    );
    if (retryingFromTranscript) {
      sessionPromptState.continueFromCurrentTranscript();
    }
    return {
      action: "retry",
      bootstrapPromptWarningSignaturesSeen,
      lastRunPromptUsage,
      lastTurnTotal,
      replayState,
    };
  }
  return {
    action: "proceed",
    bootstrapPromptWarningSignaturesSeen,
    lastRunPromptUsage,
    lastTurnTotal,
    replayState,
    attempt,
    aborted,
    externalAbort,
    promptError,
    promptErrorSource,
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
    assistantErrorText,
    canRestartForLiveSwitch:
      !hasOutboundDeliveryEvidence(attempt) &&
      !attempt.didSendDeterministicApprovalPrompt &&
      !attempt.lastToolError &&
      (attempt.toolMetas?.length ?? 0) === 0 &&
      (attempt.assistantTexts?.length ?? 0) === 0,
  };
}
