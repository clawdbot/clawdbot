import { formatErrorMessage } from "../../../infra/errors.js";
import { resolveSettledTurnFinalizationText } from "../../harness/settled-turn-finalization-result.js";
import type {
  AgentHarness,
  AgentHarnessSettledTurnFinalizationResult,
} from "../../harness/types.js";
import { log } from "../logger.js";
import { mergeUsageIntoAccumulator } from "../usage-accumulator.js";
import { runEmbeddedSettledTurnFinalizationWithBackend } from "./backend.js";
import { EMBEDDED_RUN_LANE_HEARTBEAT_MS } from "./lane-runtime.js";
import { prepareEmbeddedRunTerminal } from "./terminal-preparation.js";
import { resolveSettledTurnFinalizationRequest } from "./terminal-resolution.js";
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
  | "terminalInterrupted"
  | "terminalTimedOut"
  | "timedOutDuringCompaction"
  | "timedOutDuringToolExecution"
>;

export async function prepareTerminalWithSettledTurnFinalization(input: {
  initial: {
    attempt: EmbeddedRunAttemptResult;
    attemptAssistant: EmbeddedRunAttemptResult["lastAssistant"];
    currentAttemptCompletedAssistant: EmbeddedRunAttemptResult["currentAttemptCompletedAssistant"];
    sessionIdUsed: string;
    sessionFileUsed?: string;
    terminalAborted: boolean;
    terminalTimedOut: boolean;
    terminalInterrupted: boolean;
    externalAbort: boolean;
    signalOwnedInterruption: boolean;
    promptError: unknown;
    attemptCompactionCount: number;
    timedOutDuringCompaction: boolean;
    timedOutDuringToolExecution: boolean;
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
    terminalInterrupted: initial.terminalInterrupted,
    terminalTimedOut: initial.terminalTimedOut,
    timedOutDuringCompaction: initial.timedOutDuringCompaction,
    timedOutDuringToolExecution: initial.timedOutDuringToolExecution,
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
    terminalAborted: initial.terminalAborted,
    terminalTimedOut: initial.terminalTimedOut,
    promptError: initial.promptError,
    settledTurnFinalizationAvailable:
      typeof input.finalization.harness.finalizeSettledTurn === "function",
  });
  if (!prompt) {
    return {
      ...initial,
      prepared,
      lastRunPromptUsage,
      lastTurnTotal,
      finalizationAttempted: false,
      finalizationSucceeded: false,
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
    lastRunPromptUsage = attempt.attemptUsage ?? lastRunPromptUsage;
    lastTurnTotal = attempt.attemptUsage?.total ?? lastTurnTotal;
    prepared = prepareEmbeddedRunTerminal({
      ...input.terminalBase,
      attempt,
      currentAttemptCompletedAssistant: attempt.currentAttemptCompletedAssistant,
      sessionIdUsed: attempt.sessionIdUsed,
      sessionFileUsed: attempt.sessionFileUsed,
      lastRunPromptUsage,
      lastTurnTotal,
      terminalInterrupted: false,
      terminalTimedOut: false,
      timedOutDuringCompaction: false,
      timedOutDuringToolExecution: false,
    });
    return {
      attempt,
      attemptAssistant: attempt.currentAttemptAssistant,
      currentAttemptCompletedAssistant: attempt.currentAttemptCompletedAssistant,
      terminalAborted: false,
      terminalTimedOut: false,
      terminalInterrupted: false,
      externalAbort: false,
      signalOwnedInterruption: false,
      promptError: null,
      attemptCompactionCount: 0,
      timedOutDuringCompaction: false,
      timedOutDuringToolExecution: false,
      sessionIdUsed: attempt.sessionIdUsed,
      sessionFileUsed: attempt.sessionFileUsed,
      prepared,
      lastRunPromptUsage,
      lastTurnTotal,
      finalizationAttempted: true,
      finalizationSucceeded: true,
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
  input.noteLaneTaskProgress();
  const progressInterval = setInterval(input.noteLaneTaskProgress, EMBEDDED_RUN_LANE_HEARTBEAT_MS);
  progressInterval.unref?.();
  try {
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
  } finally {
    clearInterval(progressInterval);
    input.noteLaneTaskProgress();
  }
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
    aborted: false,
    externalAbort: false,
    timedOut: false,
    idleTimedOut: false,
    timedOutDuringCompaction: false,
    timedOutDuringToolExecution: false,
    timedOutByRunBudget: false,
    promptError: null,
    promptErrorSource: null,
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
