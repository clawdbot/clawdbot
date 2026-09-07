import {
  markReplyPayloadForSourceSuppressionDelivery,
  setReplyPayloadMetadata,
  type ReplyPayloadMetadata,
} from "../../../auto-reply/reply-payload.js";
import {
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWrites,
  type SessionTranscriptWriterFence,
} from "../../../config/sessions/transcript-write-context.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { appendAssistantMirrorMessageByIdentity } from "../../../plugin-sdk/session-transcript-runtime.js";
import { resolveAdmittedRunActiveAssertion } from "../../admitted-run-context.js";
import { resolveSettledTurnFinalizationText } from "../../harness/settled-turn-finalization-result.js";
import type {
  AgentHarness,
  AgentHarnessSettledTurnFinalizationResult,
} from "../../harness/types.js";
import { resolveAgentRunSessionTarget } from "../../run-session-target.js";
import { resolveAgentTimeoutMs } from "../../timeout.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../tools/gateway-caller-context.js";
import { log } from "../logger.js";
import {
  mergeAttemptRunStatsIntoAccumulator,
  mergeUsageIntoAccumulator,
} from "../usage-accumulator.js";
import { copyAttemptDeliveryState } from "./attempt-delivery-state.js";
import type { EmbeddedRunAttemptWithReceiptEvidence } from "./attempt-result.js";
import {
  resolveRuntimeModelAttempt,
  runEmbeddedSettledTurnFinalizationWithBackend,
} from "./backend.js";
import { resolveSettledToolBatchEvidence } from "./incomplete-turn-recovery.js";
import type { createEmbeddedRunLaneController } from "./lane-controller.js";
import {
  resolveEmbeddedRunAttemptTerminalOutcome,
  type EmbeddedRunTerminalState,
} from "./terminal-outcome.js";
import { prepareEmbeddedRunTerminal } from "./terminal-preparation.js";
import { resolveSettledTurnFinalizationRequest } from "./terminal-resolution.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type TerminalPreparationInput = Parameters<typeof prepareEmbeddedRunTerminal>[0];
type CreateAttemptControls = ReturnType<
  typeof createEmbeddedRunLaneController
>["createAttemptControls"];
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
    createAttemptControls: CreateAttemptControls;
    abortSignal: AbortSignal;
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
  const assertFinalizationActive = resolveAdmittedRunActiveAssertion(
    input.finalization.preparedAttempt.admittedRunContext,
    input.finalization.abortSignal,
  );
  if (!assertFinalizationActive) {
    throw new Error("admitted run authority is no longer active");
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
  // A host summary cannot replace a tool failure. Keep its original warning
  // when recovery produces no answer, including for silent helper runs.
  const terminalFallbackAllowed =
    input.finalization.preparedAttempt.silentExpected !== true && !initial.attempt.lastToolError;
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
      assertFinalizationActive();
      finalization = await runPreparedSettledTurnFinalization({
        attempt: {
          ...input.finalization.preparedAttempt,
          // The first transcript append may have committed the writer after
          // dispatch preparation. The summary must retain that original fence.
          ...(committedSessionTarget ? { sessionTarget: committedSessionTarget } : {}),
          sessionId: committedSessionTarget?.sessionId ?? initial.sessionIdUsed,
          sessionFile: initial.sessionFileUsed ?? input.finalization.preparedAttempt.sessionFile,
        },
        settledAttempt: initial.attempt,
        harness: input.finalization.harness,
        prompt,
        createAttemptControls: input.finalization.createAttemptControls,
        abortSignal: input.finalization.abortSignal,
      });
      assertFinalizationActive();
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
          `provider=${errorContext.provider}/${errorContext.model} attempts=${finalizationAttempt}/${MAX_EMPTY_SETTLED_FINALIZATION_ATTEMPTS} — ${terminalFallbackAllowed ? "using terminal fallback reply" : "preserving original failure"}`,
      );
    }
  } catch (error) {
    if (input.finalization.abortSignal.aborted) {
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
        `provider=${errorContext.provider}/${errorContext.model} error=${formatErrorMessage(error)} — ${terminalFallbackAllowed ? "using terminal fallback reply" : "preserving original failure"}`,
    );
  }
  if (finalizationOutcome !== "answered" && input.finalization.abortSignal.aborted) {
    log.warn(
      `settled-turn finalization was cancelled before terminal delivery: runId=${runParams.runId} sessionId=${runParams.sessionId} ` +
        `provider=${errorContext.provider}/${errorContext.model} — preserving cancellation`,
    );
    return {
      ...initial,
      prepared,
      lastRunPromptUsage,
      finalizationOutcome: "failed" as const,
    };
  }
  if (finalizationOutcome !== "answered" && terminalFallbackAllowed) {
    const transcriptIdempotencyKey = await persistSettledToolFallbackTranscript({
      attempt: input.finalization.preparedAttempt,
      abortSignal: input.finalization.abortSignal,
      assertActive: assertFinalizationActive,
      sessionId: committedSessionTarget?.sessionId ?? initial.sessionIdUsed,
      sessionTarget: committedSessionTarget,
    });
    if (input.finalization.abortSignal.aborted) {
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
  // Only an actual recovery replaces a failed tool turn's terminal ownership.
  const completion =
    finalizationOutcome !== "answered" && initial.attempt.lastToolError
      ? initial
      : {
          attempt,
          attemptAssistant: attempt.currentAttemptAssistant,
          currentAttemptCompletedAssistant: attempt.currentAttemptCompletedAssistant,
          terminalState: {
            outcome: resolveEmbeddedRunAttemptTerminalOutcome({
              attempt,
              assistant: attempt.currentAttemptAssistant,
            }),
            signalOwnedInterruption: false,
          },
          attemptCompactionCount: 0,
          sessionIdUsed: attempt.sessionIdUsed,
          sessionFileUsed: attempt.sessionFileUsed,
        };
  const finalizedPrepared = prepareEmbeddedRunTerminal({
    ...input.terminalBase,
    ...completion,
    lastRunPromptUsage,
  });
  // Only a real finalizer answer may cross source-reply suppression. The
  // synthetic fallback remains a private diagnostic on message-tool-only runs.
  finalizedPrepared.payloadsWithToolMedia?.forEach((payload) => {
    if (finalizationOutcome === "answered") {
      markReplyPayloadForSourceSuppressionDelivery(payload);
    }
    if (sessionWriterDeliveryAuthority) {
      setReplyPayloadMetadata(payload, { sessionWriterDeliveryAuthority });
    }
  });
  // A failure-honest final answer cannot turn a settled cron denial into success.
  prepared = {
    ...finalizedPrepared,
    // Do not offer the private diagnostic to stranded-reply recovery as an
    // undelivered model answer. Automatic-delivery callers retain their fallback.
    ...(finalizationOutcome !== "answered" &&
    runParams.sourceReplyDeliveryMode === "message_tool_only"
      ? { finalAssistantVisibleText: "", finalAssistantRawText: "" }
      : {}),
    failureSignal: settledFailureSignal,
    terminalToolFailure: settledTerminalToolFailure,
  };
  return {
    ...completion,
    prepared,
    lastRunPromptUsage,
    finalizationOutcome:
      completion === initial
        ? ("failed" as const)
        : finalizationOutcome === "empty"
          ? ("completed-empty" as const)
          : finalizationOutcome,
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
  createAttemptControls: CreateAttemptControls;
  abortSignal: AbortSignal;
}): Promise<{ outcome: "answered" | "empty"; attempt: EmbeddedRunAttemptWithReceiptEvidence }> {
  // The original attempt is closed. Each tool-free retry owns its own deadline
  // and Stop callbacks, while queue cancellation remains authoritative throughout.
  const controls = input.createAttemptControls({
    admittedRunContext: input.attempt.admittedRunContext,
    abortSignal: input.abortSignal,
    initialTimeoutMs: resolveAgentTimeoutMs({
      cfg: input.attempt.config,
      overrideMs: input.attempt.timeoutMs,
    }),
  });
  try {
    // The original attempt scope has closed. Rebind this same admitted child,
    // rather than retaining the launching parent's expired tool registration.
    const callerIdentity = createAdmittedGatewayToolCallerIdentity({
      admittedRunContext: input.attempt.admittedRunContext,
      agentId: input.attempt.agentId,
      sessionKey: input.attempt.sessionKey,
    });
    const finalization = await withGatewayToolCallerIdentity(callerIdentity, () =>
      runEmbeddedSettledTurnFinalizationWithBackend(
        {
          ...input.attempt,
          abortSignal: controls.abortSignal,
          onAttemptDeadlineChanged: controls.onAttemptDeadlineChanged,
          onAttemptTimeout: controls.onAttemptTimeout,
          onAttemptAbort: controls.onAttemptAbort,
          onAttemptTimeoutArmed: undefined,
          operation: "settled-tool-finalization",
          prompt: input.prompt,
          disableTools: true,
          skipPreparedUserTurnMessage: true,
          suppressNextUserMessagePersistence: true,
          initialReplayState: { replayInvalid: false, hadPotentialSideEffects: false },
        },
        input.settledAttempt,
        input.harness,
      ),
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
  } finally {
    controls.close();
  }
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
  // Its response model does not replace the original runtime-owned selection.
  // Replay, abort, and lifecycle state remain finalizer-local.
  return {
    terminal: { kind: "ok" },
    sessionIdUsed: settledAttempt.sessionIdUsed,
    sessionFileUsed: settledAttempt.sessionFileUsed,
    ...(input.agentHarnessId ? { agentHarnessId: input.agentHarnessId } : {}),
    modelAttempt: resolveRuntimeModelAttempt(input.runtimePlan),
    ...(settledAttempt.runtimeModelSelection
      ? { runtimeModelSelection: settledAttempt.runtimeModelSelection }
      : {}),
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
  // Command-only harnesses retain assistant identity in the settled tool batch,
  // even when neither visible-assistant field exists.
  const sourceAssistant =
    input.sourceAttempt.currentAttemptAssistant ??
    input.sourceAttempt.lastAssistant ??
    input.settledAttempt.currentAttemptAssistant ??
    input.settledAttempt.lastAssistant ??
    resolveSettledToolBatchEvidence(input.settledAttempt).assistant;
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
  abortSignal: AbortSignal;
  assertActive: () => void;
  sessionId: string;
  sessionTarget?: EmbeddedRunAttemptParams["sessionTarget"];
}): Promise<string | undefined> {
  input.assertActive();
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
    const resolvedTarget = await resolveAgentRunSessionTarget({
      agentId: target?.agentId ?? input.attempt.agentId,
      config: input.attempt.config,
      missingSessionKey: "resolve-existing",
      sessionId: input.sessionId,
      sessionKey,
      sessionTarget: target,
    });
    if (input.abortSignal.aborted) {
      return undefined;
    }
    input.assertActive();
    const fencedTarget = {
      ...resolvedTarget,
      sessionId: input.sessionId,
      expectedLifecycleRevision: target?.expectedLifecycleRevision,
      expectedWriterRunId: target?.expectedWriterRunId,
    };
    // A completed parent is irrelevant, but this child must still own the
    // fallback at the synchronous commit edge, including after queued writes.
    const result = await withOwnedSessionTranscriptWrites(
      {
        sessionTarget: fencedTarget,
        assertCommitAllowed: input.assertActive,
        withTranscriptWrite: async (write) => await write(),
      },
      () =>
        appendAssistantMirrorMessageByIdentity({
          ...fencedTarget,
          config: input.attempt.config,
          idempotencyKey,
          signal: input.abortSignal,
          text: SETTLED_TOOL_FINALIZATION_FALLBACK_TEXT,
        }),
    );
    if (input.abortSignal.aborted) {
      return undefined;
    }
    input.assertActive();
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
    // The caller preserves queue cancellation instead of synthesizing a reply.
    if (input.abortSignal.aborted) {
      return undefined;
    }
    input.assertActive();
    if (error instanceof SessionTranscriptWriterClaimReboundError) {
      throw error;
    }
    log.warn(
      `settled-turn fallback transcript append failed: runId=${input.attempt.runId} sessionId=${input.sessionId} error=${formatErrorMessage(error)}`,
    );
    return undefined;
  }
}
