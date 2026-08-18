import { markReplyPayloadForSourceSuppressionDelivery } from "../../../auto-reply/reply-payload.js";
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
import type { EmbeddedRunAttemptWithReceiptEvidence } from "./attempt-result.js";
import { runEmbeddedSettledTurnFinalizationWithBackend } from "./backend.js";
import { withEmbeddedRunLaneProgressHeartbeat } from "./lane-runtime.js";
import {
  resolveEmbeddedRunAttemptTerminalOutcome,
  type EmbeddedRunTerminalState,
} from "./terminal-outcome.js";
import { prepareEmbeddedRunTerminal } from "./terminal-preparation.js";
import {
  copyAttemptDeliveryState,
  resolveSettledTurnFinalizationRequest,
} from "./terminal-resolution.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type TerminalPreparationInput = Parameters<typeof prepareEmbeddedRunTerminal>[0];
type TerminalPreparationBase = Omit<
  TerminalPreparationInput,
  | "attempt"
  | "currentAttemptCompletedAssistant"
  | "sessionIdUsed"
  | "sessionFileUsed"
  | "lastRunPromptUsage"
  | "terminalState"
>;

export async function prepareTerminalWithSettledTurnFinalization(input: {
  initial: {
    attempt: EmbeddedRunAttemptWithReceiptEvidence;
    attemptAssistant: EmbeddedRunAttemptWithReceiptEvidence["lastAssistant"];
    currentAttemptCompletedAssistant: EmbeddedRunAttemptWithReceiptEvidence["currentAttemptCompletedAssistant"];
    sessionIdUsed: string;
    sessionFileUsed?: string;
    terminalState: EmbeddedRunTerminalState;
    attemptCompactionCount: number;
  };
  terminalBase: TerminalPreparationBase;
  lastRunPromptUsage: TerminalPreparationInput["lastRunPromptUsage"];
  finalization: {
    preparedAttempt: EmbeddedRunAttemptParams;
    harness: AgentHarness;
    modelApi: Parameters<typeof resolveSettledTurnFinalizationRequest>[0]["modelApi"];
    executionContract: Parameters<
      typeof resolveSettledTurnFinalizationRequest
    >[0]["executionContract"];
    hasTerminalToolPresentation: boolean;
    noteLaneTaskProgress: () => void;
  };
}) {
  const initial = input.initial;
  let attempt = initial.attempt;
  let lastRunPromptUsage = input.lastRunPromptUsage;
  let prepared = prepareEmbeddedRunTerminal({
    ...input.terminalBase,
    attempt,
    currentAttemptCompletedAssistant: initial.currentAttemptCompletedAssistant,
    sessionIdUsed: initial.sessionIdUsed,
    sessionFileUsed: initial.sessionFileUsed,
    lastRunPromptUsage,
    terminalState: initial.terminalState,
  });
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
    settledTurnFinalizationAvailable:
      typeof input.finalization.harness.finalizeSettledTurn === "function",
  });
  if (!prompt) {
    return {
      ...initial,
      prepared,
      lastRunPromptUsage,
      finalizationOutcome: "not-attempted" as const,
    };
  }
  const settledFailureSignal = prepared.failureSignal;

  const runParams = input.terminalBase.runParams;
  const errorContext = input.terminalBase.activeErrorContext;
  log.warn(
    `settled post-tool turn lacked a final answer: runId=${runParams.runId} sessionId=${runParams.sessionId} ` +
      `provider=${errorContext.provider}/${errorContext.model} — running isolated finalization`,
  );
  try {
    const finalization = await runPreparedSettledTurnFinalization({
      attempt: input.finalization.preparedAttempt,
      settledAttempt: initial.attempt,
      harness: input.finalization.harness,
      prompt,
      noteLaneTaskProgress: input.finalization.noteLaneTaskProgress,
    });
    attempt = finalization.attempt;
    mergeUsageIntoAccumulator(input.terminalBase.usageAccumulator, attempt.attemptUsage);
    mergeAttemptRunStatsIntoAccumulator(input.terminalBase.usageAccumulator, attempt);
    lastRunPromptUsage = attempt.attemptUsage ?? lastRunPromptUsage;
    if (finalization.outcome === "empty") {
      log.warn(
        `settled-turn finalization completed without a visible answer: runId=${runParams.runId} sessionId=${runParams.sessionId} ` +
          `provider=${errorContext.provider}/${errorContext.model} — recording completed-empty outcome`,
      );
    }
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
      terminalState,
    });
    // The isolated finalizer cannot call a message tool. Its answer is
    // host-owned recovery output and must cross that source-reply suppression.
    finalizedPrepared.payloadsWithToolMedia?.forEach(markReplyPayloadForSourceSuppressionDelivery);
    // A failure-honest final answer cannot turn a settled cron denial into success.
    prepared = { ...finalizedPrepared, failureSignal: settledFailureSignal };
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
      finalizationOutcome:
        finalization.outcome === "empty" ? ("completed-empty" as const) : ("answered" as const),
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
      finalizationOutcome: "failed" as const,
    };
  }
}

async function runPreparedSettledTurnFinalization(input: {
  attempt: EmbeddedRunAttemptParams;
  settledAttempt: EmbeddedRunAttemptWithReceiptEvidence;
  harness: AgentHarness;
  prompt: string;
  noteLaneTaskProgress: () => void;
}): Promise<{ outcome: "answered" | "empty"; attempt: EmbeddedRunAttemptWithReceiptEvidence }> {
  return await withEmbeddedRunLaneProgressHeartbeat(input.noteLaneTaskProgress, async () => {
    const finalization = await runEmbeddedSettledTurnFinalizationWithBackend(
      {
        ...input.attempt,
        operation: "settled-tool-finalization",
        prompt: input.prompt,
        disableTools: true,
        skipPreparedUserTurnMessage: true,
        suppressNextUserMessagePersistence: true,
        initialReplayState: { replayInvalid: false, hadPotentialSideEffects: false },
      },
      input.settledAttempt,
      input.harness,
    );
    return {
      outcome: finalization.outcome,
      attempt: buildSettledTurnFinalizationAttemptResult({
        outcome: finalization.outcome,
        result: finalization.result,
        settledAttempt: input.settledAttempt,
        prompt: input.prompt,
        agentHarnessId: input.attempt.agentHarnessId,
      }),
    };
  });
}

function buildSettledTurnFinalizationAttemptResult(input: {
  outcome: "answered" | "empty";
  result: AgentHarnessSettledTurnFinalizationResult;
  settledAttempt: EmbeddedRunAttemptWithReceiptEvidence;
  prompt: string;
  agentHarnessId?: string;
}): EmbeddedRunAttemptWithReceiptEvidence {
  const { result, settledAttempt } = input;
  const text = input.outcome === "empty" ? "" : resolveSettledTurnFinalizationText(result);
  // Finalization replaces terminal ownership, not host-private facts from settled tools.
  // Keep those facts while replay, abort, and lifecycle state remain finalizer-local.
  return {
    terminal: { kind: "ok" },
    sessionIdUsed: settledAttempt.sessionIdUsed,
    sessionFileUsed: settledAttempt.sessionFileUsed,
    ...(input.agentHarnessId ? { agentHarnessId: input.agentHarnessId } : {}),
    contextTokens: settledAttempt.contextTokens,
    contextTokensSource: settledAttempt.contextTokensSource,
    authBindingFingerprint: settledAttempt.authBindingFingerprint,
    runtimeArtifact: settledAttempt.runtimeArtifact,
    systemPromptReport: settledAttempt.systemPromptReport,
    finalPromptText: input.prompt,
    ...copyAttemptDeliveryState(settledAttempt),
    messagesSnapshot: [...settledAttempt.messagesSnapshot, result.assistant],
    assistantTexts: [text],
    assistantTranscriptOwned: result.assistantTranscriptOwned,
    assistantTranscriptIdempotencyKey: result.assistantTranscriptIdempotencyKey,
    lastAssistantTextMessageIndex: result.assistantMessageIndex,
    lastAssistant: result.assistant,
    currentAttemptAssistant: result.assistant,
    currentAttemptCompletedAssistant: result.assistant,
    toolMetas: settledAttempt.toolMetas,
    successfulNestedToolNames: settledAttempt.successfulNestedToolNames,
    hasToolMediaBlockReply: false,
    cloudCodeAssistFormatError: false,
    attemptUsage: result.usage,
    codeModeEngaged: settledAttempt.codeModeEngaged,
    assistantTurns: 1,
    replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
    diagnosticTrace: result.diagnosticTrace,
  };
}
