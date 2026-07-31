import { formatErrorMessage } from "../../../infra/errors.js";
import { resolveSettledTurnFinalizationText } from "../../harness/settled-turn-finalization-result.js";
import type {
  AgentHarness,
  AgentHarnessSettledTurnFinalizationResult,
} from "../../harness/types.js";
import { log } from "../logger.js";
import {
  mergeAttemptRunStatsIntoAccumulator,
  mergeUsageIntoAccumulator,
} from "../usage-accumulator.js";
import { runEmbeddedSettledTurnFinalizationWithBackend } from "./backend.js";
import {
  resolveCodeModeContinuationInstruction,
  resolveCodeModeMutationVerificationState,
  resolveCodeModeContinuationToolPolicy,
  resolveCodeModeTargetlessSideEffectEvidence,
  shouldLatchCodeModeReadOnlyForRun,
} from "./incomplete-turn.js";
import { withEmbeddedRunLaneProgressHeartbeat } from "./lane-runtime.js";
import {
  resolveEmbeddedRunAttemptTerminalOutcome,
  type EmbeddedRunTerminalState,
} from "./terminal-outcome.js";
import { prepareEmbeddedRunTerminal } from "./terminal-preparation.js";
import {
  type EmbeddedRunToolCapableContinuation,
  resolveSettledTurnFinalizationRequest,
} from "./terminal-resolution.js";
import type { EmbeddedRunTerminalRetryState } from "./terminal-retry-state.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./types.js";

type TerminalPreparationInput = Parameters<typeof prepareEmbeddedRunTerminal>[0];
type TerminalPreparationBase = Omit<
  TerminalPreparationInput,
  | "attempt"
  | "currentAttemptCompletedAssistant"
  | "sessionIdUsed"
  | "sessionFileUsed"
  | "lastRunPromptUsage"
  | "lastTurnTotal"
  | "terminalState"
>;

export async function prepareTerminalWithSettledTurnFinalization(input: {
  initial: {
    attempt: EmbeddedRunAttemptResult;
    attemptAssistant: EmbeddedRunAttemptResult["lastAssistant"];
    currentAttemptCompletedAssistant: EmbeddedRunAttemptResult["currentAttemptCompletedAssistant"];
    sessionIdUsed: string;
    sessionFileUsed?: string;
    terminalState: EmbeddedRunTerminalState;
    attemptCompactionCount: number;
  };
  terminalBase: TerminalPreparationBase;
  lastRunPromptUsage: TerminalPreparationInput["lastRunPromptUsage"];
  lastTurnTotal: TerminalPreparationInput["lastTurnTotal"];
  finalization: {
    preparedAttempt: EmbeddedRunAttemptParams;
    harness: AgentHarness;
    modelApi: Parameters<typeof resolveSettledTurnFinalizationRequest>[0]["modelApi"];
    executionContract: Parameters<
      typeof resolveSettledTurnFinalizationRequest
    >[0]["executionContract"];
    hasTerminalToolPresentation: boolean;
    noteLaneTaskProgress: () => void;
    retryState: EmbeddedRunTerminalRetryState;
  };
}) {
  const initial = input.initial;
  let attempt = initial.attempt;
  let lastRunPromptUsage = input.lastRunPromptUsage;
  let lastTurnTotal = input.lastTurnTotal;
  let prepared = prepareEmbeddedRunTerminal({
    ...input.terminalBase,
    attempt,
    currentAttemptCompletedAssistant: initial.currentAttemptCompletedAssistant,
    sessionIdUsed: initial.sessionIdUsed,
    sessionFileUsed: initial.sessionFileUsed,
    lastRunPromptUsage,
    lastTurnTotal,
    terminalState: initial.terminalState,
  });
  const settledAttemptToolSummary = prepared.attemptToolSummary;
  const codeModeMutationVerification = resolveCodeModeMutationVerificationState(
    initial.attempt,
    input.finalization.retryState.codeModeMutationVerification,
    input.terminalBase.runParams.cwd ?? input.terminalBase.runParams.workspaceDir,
  );
  input.finalization.retryState.codeModeMutationVerification = codeModeMutationVerification;
  const codeModeMutationVerificationRequired =
    codeModeMutationVerification.pendingTargets.length > 0;
  const codeModeTargetlessSideEffectEvidence = resolveCodeModeTargetlessSideEffectEvidence(
    initial.attempt,
  );
  if (
    shouldLatchCodeModeReadOnlyForRun({
      mutationVerificationRequired: codeModeMutationVerificationRequired,
      targetlessSideEffectEvidence: codeModeTargetlessSideEffectEvidence,
    })
  ) {
    input.finalization.retryState.forceReadOnlyToolsForRun = true;
  }
  if (!codeModeMutationVerificationRequired) {
    // Dispatch and failover paths cannot release this guard. Only successful
    // target reconciliation proves that mutation tools are safe to restore.
    input.finalization.retryState.forceReadOnlyToolsUntilVerification = false;
  }
  // Known targets need one read-only verification attempt at a time. Once
  // verified, later continuations may resume unfinished mutations. Targetless
  // side effects remain read-only for the rest of the run.
  const attemptContinuationToolPolicy = codeModeMutationVerificationRequired
    ? "read-only"
    : codeModeTargetlessSideEffectEvidence === false
      ? "normal"
      : resolveCodeModeContinuationToolPolicy(initial.attempt);
  const codeModeContinuationToolPolicy =
    attemptContinuationToolPolicy && input.finalization.retryState.forceReadOnlyToolsForRun
      ? "read-only"
      : attemptContinuationToolPolicy;
  const settledTurnFinalizationAvailable =
    typeof input.finalization.harness.finalizeSettledTurn === "function";
  const codeModeCompletionContinuationExhausted =
    !codeModeMutationVerificationRequired &&
    input.finalization.retryState.codeModeCompletionContinuationAttempts >= 1;
  const useIsolatedFinalization =
    codeModeCompletionContinuationExhausted && settledTurnFinalizationAvailable;
  const prompt = resolveSettledTurnFinalizationRequest({
    runParams: input.terminalBase.runParams,
    attempt,
    activeErrorContext: input.terminalBase.activeErrorContext,
    modelApi: input.finalization.modelApi,
    executionContract: input.finalization.executionContract,
    payloadsWithToolMedia: prepared.payloadsWithToolMedia,
    recoveredFinalAssistantPayloadsAfterPromptTimeout:
      prepared.recoveredFinalAssistantPayloadsAfterPromptTimeout,
    hasTerminalToolPresentation: input.finalization.hasTerminalToolPresentation,
    terminalState: initial.terminalState,
    settledTurnFinalizationAvailable,
    toolCapableContinuationAvailable:
      codeModeContinuationToolPolicy !== null && !useIsolatedFinalization,
    requireCodeModeMutationVerification: codeModeMutationVerificationRequired,
  });
  if (!prompt) {
    return {
      ...initial,
      prepared,
      lastRunPromptUsage,
      lastTurnTotal,
      finalizationAttempted: false,
      finalizationSucceeded: false,
      toolCapableContinuation: null,
    };
  }
  if (codeModeContinuationToolPolicy && !useIsolatedFinalization) {
    // Keep unfinished Code Mode work on the ordinary continuation path.
    // Mutating turns expose only host-enforced read-only tools.
    const readOnlyToolsScope: "run" | "verification" | null = input.finalization.retryState
      .forceReadOnlyToolsForRun
      ? "run"
      : codeModeMutationVerificationRequired
        ? "verification"
        : codeModeContinuationToolPolicy === "read-only"
          ? "run"
          : null;
    const toolCapableContinuation: EmbeddedRunToolCapableContinuation = {
      kind: codeModeMutationVerificationRequired ? "verification" : "completion",
      instruction: resolveCodeModeContinuationInstruction({
        mutationVerificationRequired: codeModeMutationVerificationRequired,
        targetlessSideEffectEvidence: codeModeTargetlessSideEffectEvidence,
        toolPolicy: codeModeContinuationToolPolicy,
      }),
      readOnlyToolsScope,
    };
    return {
      ...initial,
      prepared,
      lastRunPromptUsage,
      lastTurnTotal,
      finalizationAttempted: false,
      finalizationSucceeded: false,
      toolCapableContinuation,
    };
  }

  const runParams = input.terminalBase.runParams;
  const errorContext = input.terminalBase.activeErrorContext;
  log.warn(
    `settled post-tool turn lacked a final answer: runId=${runParams.runId} sessionId=${runParams.sessionId} ` +
      `provider=${errorContext.provider}/${errorContext.model} — running isolated finalization`,
  );
  try {
    attempt = await runPreparedSettledTurnFinalization({
      attempt: input.finalization.preparedAttempt,
      settledAttempt: initial.attempt,
      harness: input.finalization.harness,
      prompt,
      noteLaneTaskProgress: input.finalization.noteLaneTaskProgress,
    });
    mergeUsageIntoAccumulator(input.terminalBase.usageAccumulator, attempt.attemptUsage);
    mergeAttemptRunStatsIntoAccumulator(input.terminalBase.usageAccumulator, attempt);
    lastRunPromptUsage = attempt.attemptUsage ?? lastRunPromptUsage;
    lastTurnTotal = attempt.attemptUsage?.total ?? lastTurnTotal;
    // Successful isolated finalization owns a fresh terminal, never the original abort signal.
    const terminalState: EmbeddedRunTerminalState = {
      outcome: resolveEmbeddedRunAttemptTerminalOutcome({
        attempt,
        assistant: attempt.currentAttemptAssistant,
      }),
      signalOwnedInterruption: false,
    };
    const finalizedPrepared = prepareEmbeddedRunTerminal({
      ...input.terminalBase,
      attempt,
      currentAttemptCompletedAssistant: attempt.currentAttemptCompletedAssistant,
      sessionIdUsed: attempt.sessionIdUsed,
      sessionFileUsed: attempt.sessionFileUsed,
      lastRunPromptUsage,
      lastTurnTotal,
      terminalState,
    });
    const finalizerToolSummary = finalizedPrepared.attemptToolSummary;
    prepared = {
      ...finalizedPrepared,
      // The finalizer intentionally runs without tools, but the completed
      // outer calls still belong to the same run's execution trace.
      attemptToolSummary:
        finalizerToolSummary && finalizerToolSummary.calls > 0
          ? finalizerToolSummary
          : settledAttemptToolSummary,
    };
    return {
      attempt,
      attemptAssistant: attempt.currentAttemptAssistant,
      currentAttemptCompletedAssistant: attempt.currentAttemptCompletedAssistant,
      terminalState,
      attemptCompactionCount: 0,
      sessionIdUsed: attempt.sessionIdUsed,
      sessionFileUsed: attempt.sessionFileUsed,
      prepared,
      lastRunPromptUsage,
      lastTurnTotal,
      finalizationAttempted: true,
      finalizationSucceeded: true,
      toolCapableContinuation: null,
    };
  } catch (error) {
    log.warn(
      `settled-turn finalization failed closed: runId=${runParams.runId} sessionId=${runParams.sessionId} ` +
        `provider=${errorContext.provider}/${errorContext.model} error=${formatErrorMessage(error)}`,
    );
    return {
      ...initial,
      prepared,
      lastRunPromptUsage,
      lastTurnTotal,
      finalizationAttempted: true,
      finalizationSucceeded: false,
      toolCapableContinuation: null,
    };
  }
}

async function runPreparedSettledTurnFinalization(input: {
  attempt: EmbeddedRunAttemptParams;
  settledAttempt: EmbeddedRunAttemptResult;
  harness: AgentHarness;
  prompt: string;
  noteLaneTaskProgress: () => void;
}): Promise<EmbeddedRunAttemptResult> {
  return await withEmbeddedRunLaneProgressHeartbeat(input.noteLaneTaskProgress, async () => {
    const result = await runEmbeddedSettledTurnFinalizationWithBackend(
      {
        ...input.attempt,
        operation: "settled-tool-finalization",
        prompt: input.prompt,
        disableTools: true,
        skipPreparedUserTurnMessage: true,
        initialReplayState: { replayInvalid: false, hadPotentialSideEffects: false },
      },
      input.settledAttempt,
      input.harness,
    );
    return buildSettledTurnFinalizationAttemptResult({
      result,
      settledAttempt: input.settledAttempt,
      prompt: input.prompt,
      agentHarnessId: input.attempt.agentHarnessId,
    });
  });
}

function buildSettledTurnFinalizationAttemptResult(input: {
  result: AgentHarnessSettledTurnFinalizationResult;
  settledAttempt: EmbeddedRunAttemptResult;
  prompt: string;
  agentHarnessId?: string;
}): EmbeddedRunAttemptResult {
  const { result, settledAttempt } = input;
  const text = resolveSettledTurnFinalizationText(result);
  // Finalization bypasses ordinary attempt normalization. Rebuild only the
  // terminal projection so settled side effects and retry state cannot leak in.
  return {
    terminal: { kind: "ok" },
    sessionIdUsed: settledAttempt.sessionIdUsed,
    sessionFileUsed: settledAttempt.sessionFileUsed,
    ...(input.agentHarnessId ? { agentHarnessId: input.agentHarnessId } : {}),
    authBindingFingerprint: settledAttempt.authBindingFingerprint,
    runtimeArtifact: settledAttempt.runtimeArtifact,
    systemPromptReport: settledAttempt.systemPromptReport,
    finalPromptText: input.prompt,
    messagesSnapshot: [...settledAttempt.messagesSnapshot, result.assistant],
    assistantTexts: [text],
    assistantTranscriptOwned: result.assistantTranscriptOwned,
    assistantTranscriptIdempotencyKey: result.assistantTranscriptIdempotencyKey,
    lastAssistantTextMessageIndex: result.assistantMessageIndex,
    lastAssistant: result.assistant,
    currentAttemptAssistant: result.assistant,
    currentAttemptCompletedAssistant: result.assistant,
    toolMetas: [],
    acceptedSessionSpawns: [],
    didSendViaMessagingTool: false,
    didDeliverSourceReplyViaMessageTool: false,
    didSendDeterministicApprovalPrompt: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    messagingToolSourceReplyPayloads: [],
    hasToolMediaBlockReply: false,
    successfulCronAdds: 0,
    cloudCodeAssistFormatError: false,
    attemptUsage: result.usage,
    replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
    diagnosticTrace: result.diagnosticTrace,
  };
}
