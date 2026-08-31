import {
  markReplyPayloadForSourceSuppressionDelivery,
  setReplyPayloadMetadata,
  type ReplyPayloadMetadata,
} from "../../../auto-reply/reply-payload.js";
import {
  SessionTranscriptWriterClaimReboundError,
  type SessionTranscriptWriterFence,
} from "../../../config/sessions/transcript-write-context.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { appendAssistantMirrorMessageByIdentity } from "../../../plugin-sdk/session-transcript-runtime.js";
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
import {
  resolveRuntimeModelAttempt,
  runEmbeddedSettledTurnFinalizationWithBackend,
} from "./backend.js";
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
const MAX_EMPTY_SETTLED_FINALIZATION_ATTEMPTS = 2;
const SETTLED_TOOL_FINALIZATION_FALLBACK_TEXT =
  "The tool run finished, but no final summary was produced. I did not repeat any completed actions.";
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
    sessionTarget?: EmbeddedRunAttemptParams["sessionTarget"];
    sessionWriterFence?: SessionTranscriptWriterFence;
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
  const settledTerminalToolFailure = prepared.terminalToolFailure;
  const committedSessionTarget = resolveCommittedSessionTarget({
    preparedAttempt: input.finalization.preparedAttempt,
    sessionTarget: input.finalization.sessionTarget,
    sessionWriterFence: input.finalization.sessionWriterFence,
  });
  const sessionWriterDeliveryAuthority = resolveSessionWriterDeliveryAuthority({
    attempt: input.finalization.preparedAttempt,
    sessionId: committedSessionTarget?.sessionId ?? initial.sessionIdUsed,
    sessionTarget: committedSessionTarget,
  });

  const runParams = input.terminalBase.runParams;
  const errorContext = input.terminalBase.activeErrorContext;
  // Silent helper runs may consume a real finalizer answer internally, but a
  // host fallback would turn their semantic failure into synthetic success.
  const terminalFallbackAllowed = input.finalization.preparedAttempt.silentExpected !== true;
  log.warn(
    `settled post-tool turn lacked a final answer: runId=${runParams.runId} sessionId=${runParams.sessionId} ` +
      `provider=${errorContext.provider}/${errorContext.model} — running isolated finalization`,
  );
  let finalizationOutcome: "answered" | "empty" | "failed" = "failed";
  try {
    let finalization: Awaited<ReturnType<typeof runPreparedSettledTurnFinalization>>;
    let finalizationAttempt = 0;
    do {
      finalizationAttempt += 1;
      finalization = await runPreparedSettledTurnFinalization({
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
      if (
        finalization.outcome === "empty" &&
        finalizationAttempt < MAX_EMPTY_SETTLED_FINALIZATION_ATTEMPTS
      ) {
        log.warn(
          `settled-turn finalization completed without a visible answer: runId=${runParams.runId} sessionId=${runParams.sessionId} ` +
            `provider=${errorContext.provider}/${errorContext.model} — retrying ${finalizationAttempt}/${MAX_EMPTY_SETTLED_FINALIZATION_ATTEMPTS - 1} with tools disabled`,
        );
      }
    } while (
      finalization.outcome === "empty" &&
      finalizationAttempt < MAX_EMPTY_SETTLED_FINALIZATION_ATTEMPTS
    );
    finalizationOutcome = finalization.outcome;
    if (finalization.outcome === "empty") {
      log.warn(
        `settled-turn finalization completed without a visible answer: runId=${runParams.runId} sessionId=${runParams.sessionId} ` +
          `provider=${errorContext.provider}/${errorContext.model} attempts=${finalizationAttempt}/${MAX_EMPTY_SETTLED_FINALIZATION_ATTEMPTS} — ${terminalFallbackAllowed ? "using terminal fallback reply" : "preserving silent helper failure"}`,
      );
    }
  } catch (error) {
    if (input.finalization.preparedAttempt.abortSignal?.aborted) {
      log.warn(
        `settled-turn finalization was cancelled: runId=${runParams.runId} sessionId=${runParams.sessionId} ` +
          `provider=${errorContext.provider}/${errorContext.model} error=${formatErrorMessage(error)} — preserving cancellation`,
      );
      return {
        ...initial,
        prepared,
        lastRunPromptUsage,
        finalizationOutcome: "failed" as const,
      };
    }
    log.warn(
      `settled-turn finalization failed: runId=${runParams.runId} sessionId=${runParams.sessionId} ` +
        `provider=${errorContext.provider}/${errorContext.model} error=${formatErrorMessage(error)} — ${terminalFallbackAllowed ? "using terminal fallback reply" : "preserving silent helper failure"}`,
    );
  }
  if (finalizationOutcome !== "answered" && terminalFallbackAllowed) {
    if (input.finalization.preparedAttempt.abortSignal?.aborted) {
      log.warn(
        `settled-turn fallback was cancelled before transcript persistence: runId=${runParams.runId} sessionId=${runParams.sessionId} ` +
          `provider=${errorContext.provider}/${errorContext.model} — preserving cancellation`,
      );
      return {
        ...initial,
        prepared,
        lastRunPromptUsage,
        finalizationOutcome: "failed" as const,
      };
    }
    const transcriptIdempotencyKey = await persistSettledToolFallbackTranscript({
      attempt: input.finalization.preparedAttempt,
      sessionId: committedSessionTarget?.sessionId ?? initial.sessionIdUsed,
      sessionTarget: committedSessionTarget,
    });
    if (input.finalization.preparedAttempt.abortSignal?.aborted) {
      log.warn(
        `settled-turn fallback was cancelled during transcript persistence: runId=${runParams.runId} sessionId=${runParams.sessionId} ` +
          `provider=${errorContext.provider}/${errorContext.model} — preserving cancellation`,
      );
      return {
        ...initial,
        prepared,
        lastRunPromptUsage,
        finalizationOutcome: "failed" as const,
      };
    }
    attempt = buildSettledToolFallbackAttemptResult({
      settledAttempt: initial.attempt,
      sourceAttempt: attempt,
      prompt,
      agentHarnessId: input.finalization.preparedAttempt.agentHarnessId,
      runtimePlan: input.finalization.preparedAttempt.runtimePlan,
      transcriptIdempotencyKey,
    });
  }
  // Isolated finalization owns a fresh terminal, never the original abort signal.
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
  finalizedPrepared.payloadsWithToolMedia?.forEach((payload) => {
    markReplyPayloadForSourceSuppressionDelivery(payload);
    if (sessionWriterDeliveryAuthority) {
      setReplyPayloadMetadata(payload, { sessionWriterDeliveryAuthority });
    }
  });
  // A failure-honest final answer cannot turn a settled cron denial into success.
  prepared = {
    ...finalizedPrepared,
    failureSignal: settledFailureSignal,
    terminalToolFailure: settledTerminalToolFailure,
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
    finalizationOutcome:
      finalizationOutcome === "empty" ? ("completed-empty" as const) : finalizationOutcome,
  };
}

function resolveSessionWriterDeliveryAuthority(input: {
  attempt: EmbeddedRunAttemptParams;
  sessionId: string;
  sessionTarget?: EmbeddedRunAttemptParams["sessionTarget"];
}): ReplyPayloadMetadata["sessionWriterDeliveryAuthority"] {
  const target = input.sessionTarget ?? input.attempt.sessionTarget;
  const sessionKey = target?.sessionKey ?? input.attempt.sessionKey;
  const expectedLifecycleRevision = target?.expectedLifecycleRevision;
  const expectedWriterRunId = target?.expectedWriterRunId;
  if (
    !sessionKey ||
    (expectedLifecycleRevision === undefined && expectedWriterRunId === undefined)
  ) {
    return undefined;
  }
  return {
    ...(target?.agentId || input.attempt.agentId
      ? { agentId: target?.agentId ?? input.attempt.agentId }
      : {}),
    expectedSessionId: input.sessionId,
    ...(expectedLifecycleRevision !== undefined ? { expectedLifecycleRevision } : {}),
    ...(expectedWriterRunId !== undefined ? { expectedWriterRunId } : {}),
    sessionKey,
    ...(target?.storePath ? { storePath: target.storePath } : {}),
  };
}

function resolveCommittedSessionTarget(input: {
  preparedAttempt: EmbeddedRunAttemptParams;
  sessionTarget?: EmbeddedRunAttemptParams["sessionTarget"];
  sessionWriterFence?: SessionTranscriptWriterFence;
}): EmbeddedRunAttemptParams["sessionTarget"] {
  const preparedTarget = input.preparedAttempt.sessionTarget;
  if (!preparedTarget && !input.sessionTarget && !input.sessionWriterFence) {
    return undefined;
  }
  return {
    ...preparedTarget,
    ...input.sessionTarget,
    ...input.sessionWriterFence,
  };
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
        runtimePlan: input.attempt.runtimePlan,
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
  runtimePlan?: EmbeddedRunAttemptParams["runtimePlan"];
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
    modelAttempt: resolveRuntimeModelAttempt(input.runtimePlan),
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

function buildSettledToolFallbackAttemptResult(input: {
  settledAttempt: EmbeddedRunAttemptWithReceiptEvidence;
  sourceAttempt: EmbeddedRunAttemptWithReceiptEvidence;
  prompt: string;
  agentHarnessId?: string;
  runtimePlan?: EmbeddedRunAttemptParams["runtimePlan"];
  transcriptIdempotencyKey?: string;
}): EmbeddedRunAttemptWithReceiptEvidence {
  const sourceAssistant =
    input.sourceAttempt.currentAttemptAssistant ??
    input.sourceAttempt.lastAssistant ??
    input.settledAttempt.currentAttemptAssistant ??
    input.settledAttempt.lastAssistant;
  if (!sourceAssistant) {
    throw new Error("Settled-turn fallback has no assistant identity");
  }
  const assistant = {
    ...sourceAssistant,
    content: [{ type: "text" as const, text: SETTLED_TOOL_FINALIZATION_FALLBACK_TEXT }],
    openclawDelivery: undefined,
    stopReason: "stop" as const,
    errorMessage: undefined,
    errorCode: undefined,
    errorType: undefined,
    errorBody: undefined,
    timestamp: Date.now(),
  };
  return buildSettledTurnFinalizationAttemptResult({
    outcome: "answered",
    result: {
      assistant,
      usage: input.sourceAttempt.attemptUsage,
      diagnosticTrace: input.sourceAttempt.diagnosticTrace,
      ...(input.transcriptIdempotencyKey
        ? {
            assistantTranscriptOwned: true,
            assistantTranscriptIdempotencyKey: input.transcriptIdempotencyKey,
          }
        : {}),
    },
    settledAttempt: input.settledAttempt,
    prompt: input.prompt,
    agentHarnessId: input.agentHarnessId,
    runtimePlan: input.runtimePlan,
  });
}

async function persistSettledToolFallbackTranscript(input: {
  attempt: EmbeddedRunAttemptParams;
  sessionId: string;
  sessionTarget?: EmbeddedRunAttemptParams["sessionTarget"];
}): Promise<string | undefined> {
  const target = input.sessionTarget ?? input.attempt.sessionTarget;
  const sessionKey = target?.sessionKey ?? input.attempt.sessionKey;
  const hasWriterFence =
    target?.expectedLifecycleRevision !== undefined || target?.expectedWriterRunId !== undefined;
  if (!sessionKey) {
    if (hasWriterFence) {
      throw new SessionTranscriptWriterClaimReboundError();
    }
    return undefined;
  }
  const idempotencyKey = `${input.attempt.runId}:settled-finalization-fallback`;
  try {
    const result = await appendAssistantMirrorMessageByIdentity({
      ...(target?.agentId || input.attempt.agentId
        ? { agentId: target?.agentId ?? input.attempt.agentId }
        : {}),
      sessionId: input.sessionId,
      sessionKey,
      ...(target?.storePath ? { storePath: target.storePath } : {}),
      ...(target?.expectedLifecycleRevision !== undefined
        ? { expectedLifecycleRevision: target.expectedLifecycleRevision }
        : {}),
      ...(target?.expectedWriterRunId !== undefined
        ? { expectedWriterRunId: target.expectedWriterRunId }
        : {}),
      config: input.attempt.config,
      idempotencyKey,
      signal: input.attempt.abortSignal,
      text: SETTLED_TOOL_FINALIZATION_FALLBACK_TEXT,
    });
    if (!result.ok) {
      if (hasWriterFence || result.code === "session-rebound") {
        throw new SessionTranscriptWriterClaimReboundError();
      }
      log.warn(
        `settled-turn fallback transcript append skipped: runId=${input.attempt.runId} sessionId=${input.sessionId} reason=${result.reason}`,
      );
      return undefined;
    }
    return idempotencyKey;
  } catch (error) {
    if (error instanceof SessionTranscriptWriterClaimReboundError) {
      throw error;
    }
    log.warn(
      `settled-turn fallback transcript append failed: runId=${input.attempt.runId} sessionId=${input.sessionId} error=${formatErrorMessage(error)}`,
    );
    return undefined;
  }
}
