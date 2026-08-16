import { randomBytes } from "node:crypto";
import { isCompactionReplayCheckpoint } from "@openclaw/ai/transports";
import { SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import { freezeDiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import type { AssistantMessage } from "../../../llm/types.js";
import type { ProviderRouteOverridePresence } from "../../../plugin-sdk/provider-model-types.js";
import { projectAgentRunAttemptTerminal } from "../../agent-run-terminal-outcome.js";
import type { AuthProfileFailureReason, AuthProfileStore } from "../../auth-profiles.js";
import type { AgentExecutionAuthBinding } from "../../execution-auth-binding.js";
import type { ResolvedProviderAuth } from "../../model-auth.js";
import { log } from "../logger.js";
import type { EmbeddedRunReplayState } from "../replay-state.js";
import type {
  EmbeddedAgentMeta,
  EmbeddedAgentRunResult,
  EmbeddedRunFailureSignal,
  TraceAttempt,
} from "../types.js";
import { hasAttemptTerminalState } from "./attempt-terminal-evidence.js";
import {
  markEmbeddedRunAuthProfileSuccess,
  reportEmbeddedRunSuccessfulAuthBinding,
} from "./auth-profile-success.js";
import type { EmbeddedRunContextRecoveryState } from "./context-recovery-state.js";
import { resolveFinalAssistantVisibleText } from "./helpers.js";
import {
  resolveEmptyResponseRetryInstruction,
  resolveReasoningOnlyRetryInstruction,
  resolveSettledToolTerminalContinuationInstruction,
  shouldTreatEmptyAssistantReplyAsSilent,
} from "./incomplete-turn-recovery.js";
import {
  hasYieldContinuationEvidence,
  resolveIncompleteTurnPayloadText,
  resolveRunLivenessState,
  resolveSilentToolResultReplyPayload,
  shouldRetryMissingAssistantTurn,
  TRUNCATED_REPLY_NOTICE_TEXT,
  YIELD_DIAGNOSTIC_TEXT,
} from "./incomplete-turn-resolution.js";
import type { RunEmbeddedAgentParams } from "./params.js";
import {
  isEmbeddedRunTerminalAbort,
  isEmbeddedRunTerminalInterrupted,
  isEmbeddedRunTerminalTimeout,
  type EmbeddedRunTerminalState,
} from "./terminal-outcome.js";
import {
  MAX_BEFORE_AGENT_FINALIZE_REVISIONS,
  type EmbeddedRunTerminalRetryState,
} from "./terminal-retry-state.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

const MAX_MISSING_ASSISTANT_RETRIES = 1;
const COMPACTION_CONTINUATION_RETRY_INSTRUCTION =
  "The previous attempt compacted the conversation context before producing a final user-visible answer. Continue from the compacted transcript and produce the final answer now. Do not restart from scratch, do not repeat completed work, and do not rerun tools unless the transcript clearly lacks required evidence.";
const BEFORE_AGENT_FINALIZE_RETRY_PROMPT_PREFIX =
  "Before accepting the previous final answer, apply this revision request and produce the revised final answer. Do not repeat completed work or rerun tools unless the request explicitly requires it.";

type TerminalPresentationObservation = {
  terminalPresentation?: string;
  toolCallOrdinal?: number;
};

export function createTerminalToolPresentationTracker() {
  let latestOrdinal = -1;
  let nextOrdinal = 0;
  let value: string | undefined;
  return {
    allocateOrdinal: () => nextOrdinal++,
    observe: (observation: TerminalPresentationObservation): void => {
      const ordinal = observation.toolCallOrdinal ?? latestOrdinal + 1;
      if (ordinal >= latestOrdinal) {
        latestOrdinal = ordinal;
        value = observation.terminalPresentation;
      }
    },
    read: () => value,
  };
}

type TerminalRunParams = RunEmbeddedAgentParams & {
  authProfileStateMode?: "read-write" | "read-only";
  onSuccessfulAuthBinding?: (binding: AgentExecutionAuthBinding) => void;
};

type TerminalResolution =
  | { action: "retry" }
  | { action: "complete"; result: EmbeddedAgentRunResult };

function requiresVisibleTerminalReply(runParams: TerminalRunParams): boolean {
  return (
    runParams.terminalReplyExpectation === "required" ||
    (runParams.terminalReplyExpectation == null &&
      (runParams.trigger == null || runParams.trigger === "user" || runParams.trigger === "manual"))
  );
}

export function resolveSettledTurnFinalizationRequest(input: {
  runParams: TerminalRunParams;
  attempt: EmbeddedRunAttemptResult;
  activeErrorContext: { provider: string; model: string };
  modelApi: Parameters<typeof resolveReasoningOnlyRetryInstruction>[0]["modelApi"];
  executionContract: Parameters<
    typeof resolveReasoningOnlyRetryInstruction
  >[0]["executionContract"];
  payloadsWithToolMedia: EmbeddedAgentRunResult["payloads"];
  recoveredFinalAssistantPayloadsAfterPromptTimeout?: EmbeddedAgentRunResult["payloads"];
  hasTerminalToolPresentation: boolean;
  terminalState: EmbeddedRunTerminalState;
  settledTurnFinalizationAvailable: boolean;
}): string | null {
  if (!input.settledTurnFinalizationAvailable) {
    return null;
  }
  const terminalAborted = isEmbeddedRunTerminalAbort(input.terminalState.outcome);
  const terminalTimedOut = isEmbeddedRunTerminalTimeout(input.terminalState.outcome);
  const silentToolResultReplyPayload = resolveSilentToolResultReplyPayload({
    isCronTrigger: input.runParams.trigger === "cron",
    payloadCount: input.payloadsWithToolMedia?.length ?? 0,
    aborted: terminalAborted,
    timedOut: terminalTimedOut,
    attempt: input.attempt,
  });
  const terminalAssistant = input.attempt.currentAttemptAssistant ?? input.attempt.lastAssistant;
  // Payload preparation renders an undelivered tool-error fallback before the
  // model gets its final answer. It must not masquerade as an assistant reply;
  // exact failed-call settlement is independently proven by the finalizer owner.
  const hasOnlySyntheticToolErrorPayload = Boolean(
    terminalAssistant?.stopReason === "toolUse" &&
    input.attempt.lastToolError &&
    input.attempt.assistantTexts.every((text) => text.trim().length === 0) &&
    (input.payloadsWithToolMedia?.length ?? 0) > 0 &&
    input.payloadsWithToolMedia?.every(
      (payload) =>
        payload.isError === true &&
        Object.keys(payload).every((key) => key === "text" || key === "isError"),
    ),
  );
  const payloadCount = input.recoveredFinalAssistantPayloadsAfterPromptTimeout
    ? input.recoveredFinalAssistantPayloadsAfterPromptTimeout.length
    : hasOnlySyntheticToolErrorPayload
      ? 0
      : input.payloadsWithToolMedia?.length
        ? input.payloadsWithToolMedia.length
        : silentToolResultReplyPayload
          ? 1
          : 0;
  const emptyAssistantReplyIsSilent = shouldTreatEmptyAssistantReplyAsSilent({
    allowEmptyAssistantReplyAsSilent: input.runParams.allowEmptyAssistantReplyAsSilent,
    terminalReplyExpectation: input.runParams.terminalReplyExpectation,
    onlyExplicitSilentReply: false,
    payloadCount,
    aborted: terminalAborted,
    timedOut: terminalTimedOut,
    attempt: input.attempt,
  });
  if (emptyAssistantReplyIsSilent) {
    return null;
  }
  return resolveSettledToolTerminalContinuationInstruction({
    provider: input.activeErrorContext.provider,
    modelId: input.activeErrorContext.model,
    modelApi: input.modelApi,
    executionContract: input.executionContract,
    allowEmptyStopContinuation: requiresVisibleTerminalReply(input.runParams),
    payloadCount,
    hasTerminalToolPresentation: input.hasTerminalToolPresentation,
    aborted: terminalAborted,
    timedOut: terminalTimedOut,
    attempt: input.attempt,
  });
}

export async function resolveEmbeddedRunTerminal(input: {
  runParams: TerminalRunParams;
  retryState: EmbeddedRunTerminalRetryState;
  attempt: EmbeddedRunAttemptResult;
  attemptAssistant?: AssistantMessage;
  activeErrorContext: { provider: string; model: string };
  modelApi: Parameters<typeof resolveReasoningOnlyRetryInstruction>[0]["modelApi"];
  executionContract: Parameters<
    typeof resolveReasoningOnlyRetryInstruction
  >[0]["executionContract"];
  terminalState: EmbeddedRunTerminalState;
  payloadsWithToolMedia: EmbeddedAgentRunResult["payloads"];
  recoveredFinalAssistantPayloadsAfterPromptTimeout?: EmbeddedAgentRunResult["payloads"];
  finalAssistantVisibleText?: string;
  finalAssistantRawText?: string;
  agentMeta: EmbeddedAgentMeta;
  attemptToolSummary: EmbeddedAgentRunResult["meta"]["toolSummary"];
  failureSignal?: EmbeddedRunFailureSignal;
  maxReasoningOnlyRetryAttempts: number;
  maxEmptyResponseRetryAttempts: number;
  attemptCompactionCount: number;
  replayState: EmbeddedRunReplayState;
  activePromptPersisted: boolean;
  activateInternalPrompt: (prompt: string) => void;
  setSuppressNextUserMessagePersistence: (value: boolean) => void;
  armPostCompactionGuard: () => void;
  readTerminalToolPresentation: () => string | undefined;
  resolveReplayInvalid: (incompleteTurnText?: string | null) => boolean;
  setTerminalLifecycleMeta: NonNullable<EmbeddedRunAttemptResult["setTerminalLifecycleMeta"]>;
  maybeMarkAuthProfileFailure: (failure: {
    profileId?: string;
    reason?: AuthProfileFailureReason | null;
    modelId?: string;
  }) => Promise<void>;
  assistantProfileFailureReason?: AuthProfileFailureReason | null;
  startedAtMs: number;
  provider: string;
  modelId: string;
  modelTransportId: string;
  modelTransportApi: string;
  modelTransportBaseUrl?: string;
  requestTransportOverrides?: ProviderRouteOverridePresence;
  authProfileId?: string;
  profileFailureStore: AuthProfileStore;
  attemptAuthProfileStore: AuthProfileStore;
  apiKeyInfo: ResolvedProviderAuth | null;
  agentHarnessId: string;
  settledTurnFinalizationOutcome: "not-attempted" | "answered" | "completed-empty" | "failed";
  pluginHarnessOwnsTransport: boolean;
  pluginHarnessOwnsAuthBootstrap: boolean;
  reportedModelRef: { provider: string; model: string };
  traceAttempts: TraceAttempt[];
  traceAttemptUsesFallback: (attempt: TraceAttempt) => boolean;
  thinkLevel?: string;
  contextRecoveryState: EmbeddedRunContextRecoveryState;
}): Promise<TerminalResolution> {
  const { runParams, attempt, retryState } = input;
  const { externalAbort, promptError } = projectAgentRunAttemptTerminal(attempt.terminal);
  const terminalAborted = isEmbeddedRunTerminalAbort(input.terminalState.outcome);
  const terminalTimedOut = isEmbeddedRunTerminalTimeout(input.terminalState.outcome);
  const terminalInterrupted = isEmbeddedRunTerminalInterrupted(input.terminalState.outcome);
  const { signalOwnedInterruption } = input.terminalState;
  const silentToolResultReplyPayload = resolveSilentToolResultReplyPayload({
    isCronTrigger: runParams.trigger === "cron",
    payloadCount: input.payloadsWithToolMedia?.length ?? 0,
    aborted: terminalAborted,
    timedOut: terminalTimedOut,
    attempt,
  });
  const payloadsForTerminalPath = input.recoveredFinalAssistantPayloadsAfterPromptTimeout
    ? input.recoveredFinalAssistantPayloadsAfterPromptTimeout
    : input.payloadsWithToolMedia?.length
      ? input.payloadsWithToolMedia
      : silentToolResultReplyPayload
        ? [silentToolResultReplyPayload]
        : input.payloadsWithToolMedia;
  const payloadCount = payloadsForTerminalPath?.length ?? 0;
  // A failed isolated finalization is terminal for this user turn. Do not let
  // its settled side effects cascade into any ordinary retry family.
  const settledTurnFinalizationAttempted = input.settledTurnFinalizationOutcome !== "not-attempted";
  const emptyAssistantReplyIsSilent = shouldTreatEmptyAssistantReplyAsSilent({
    allowEmptyAssistantReplyAsSilent: runParams.allowEmptyAssistantReplyAsSilent,
    terminalReplyExpectation: runParams.terminalReplyExpectation,
    onlyExplicitSilentReply: settledTurnFinalizationAttempted,
    payloadCount,
    aborted: terminalAborted,
    timedOut: terminalTimedOut,
    attempt,
  });
  const nextReasoningOnlyRetryInstruction =
    emptyAssistantReplyIsSilent || settledTurnFinalizationAttempted
      ? null
      : resolveReasoningOnlyRetryInstruction({
          provider: input.activeErrorContext.provider,
          modelId: input.activeErrorContext.model,
          modelApi: input.modelApi,
          executionContract: input.executionContract,
          aborted: terminalAborted,
          timedOut: terminalTimedOut,
          attempt,
        });
  const nextEmptyResponseRetryInstruction =
    emptyAssistantReplyIsSilent || settledTurnFinalizationAttempted
      ? null
      : resolveEmptyResponseRetryInstruction({
          provider: input.activeErrorContext.provider,
          modelId: input.activeErrorContext.model,
          modelApi: input.modelApi,
          executionContract: input.executionContract,
          payloadCount,
          aborted: terminalAborted,
          timedOut: terminalTimedOut,
          attempt,
        });
  if (
    nextReasoningOnlyRetryInstruction &&
    retryState.reasoningOnlyAttempts < input.maxReasoningOnlyRetryAttempts
  ) {
    retryState.reasoningOnlyAttempts += 1;
    input.activateInternalPrompt(nextReasoningOnlyRetryInstruction);
    log.warn(
      `reasoning-only assistant turn detected: runId=${runParams.runId} sessionId=${runParams.sessionId} ` +
        `provider=${input.activeErrorContext.provider}/${input.activeErrorContext.model} — retrying ${retryState.reasoningOnlyAttempts}/${input.maxReasoningOnlyRetryAttempts} ` +
        `with visible-answer continuation`,
    );
    return { action: "retry" };
  }
  const reasoningOnlyRetriesExhausted =
    nextReasoningOnlyRetryInstruction &&
    retryState.reasoningOnlyAttempts >= input.maxReasoningOnlyRetryAttempts;
  if (
    !emptyAssistantReplyIsSilent &&
    !settledTurnFinalizationAttempted &&
    shouldRetryMissingAssistantTurn({
      payloadCount,
      aborted: terminalAborted,
      promptError,
      timedOut: terminalTimedOut,
      attempt,
    }) &&
    retryState.missingAssistantAttempts < MAX_MISSING_ASSISTANT_RETRIES
  ) {
    retryState.missingAssistantAttempts += 1;
    input.setSuppressNextUserMessagePersistence(input.activePromptPersisted);
    log.warn(
      `missing assistant terminal message detected: runId=${runParams.runId} sessionId=${runParams.sessionId} ` +
        `provider=${input.activeErrorContext.provider}/${input.activeErrorContext.model} — retrying ${retryState.missingAssistantAttempts}/${MAX_MISSING_ASSISTANT_RETRIES} with same prompt`,
    );
    return { action: "retry" };
  }
  const availableTerminalToolPresentation = input.readTerminalToolPresentation();
  if (
    !nextReasoningOnlyRetryInstruction &&
    nextEmptyResponseRetryInstruction &&
    retryState.emptyResponseAttempts < input.maxEmptyResponseRetryAttempts
  ) {
    retryState.emptyResponseAttempts += 1;
    input.activateInternalPrompt(nextEmptyResponseRetryInstruction);
    log.warn(
      `empty response detected: runId=${runParams.runId} sessionId=${runParams.sessionId} ` +
        `provider=${input.activeErrorContext.provider}/${input.activeErrorContext.model} — retrying ${retryState.emptyResponseAttempts}/${input.maxEmptyResponseRetryAttempts} ` +
        `with visible-answer continuation`,
    );
    return { action: "retry" };
  }
  const completedEmptyFinalization = input.settledTurnFinalizationOutcome === "completed-empty";
  const incompleteTurnText =
    emptyAssistantReplyIsSilent ||
    (completedEmptyFinalization && !requiresVisibleTerminalReply(runParams))
      ? null
      : resolveIncompleteTurnPayloadText({
          payloadCount,
          aborted: terminalAborted,
          externalAbort: externalAbort || signalOwnedInterruption,
          timedOut: terminalTimedOut,
          hadPotentialSideEffects: input.replayState.hadPotentialSideEffects,
          attempt,
        });
  const incompleteTurnFallbackSafe = Boolean(
    incompleteTurnText &&
    !terminalInterrupted &&
    !promptError &&
    !attempt.lastToolError &&
    !hasAttemptTerminalState(attempt) &&
    !input.replayState.hadPotentialSideEffects,
  );
  const terminalToolPresentation = incompleteTurnFallbackSafe
    ? availableTerminalToolPresentation
    : undefined;
  if (
    !emptyAssistantReplyIsSilent &&
    !settledTurnFinalizationAttempted &&
    (input.attemptCompactionCount > 0 ||
      isCompactionReplayCheckpoint(attempt.currentAttemptAssistant?.providerReplay)) &&
    payloadCount === 0 &&
    !terminalInterrupted &&
    !promptError &&
    !attempt.clientToolCalls &&
    !attempt.yieldDetected &&
    !attempt.didSendDeterministicApprovalPrompt &&
    !attempt.lastToolError &&
    !input.replayState.hadPotentialSideEffects &&
    retryState.compactionContinuationAttempts < 1
  ) {
    retryState.compactionContinuationAttempts += 1;
    retryState.compactionContinuationInstruction = COMPACTION_CONTINUATION_RETRY_INSTRUCTION;
    log.warn(
      `compaction interrupted visible final answer: runId=${runParams.runId} sessionId=${runParams.sessionId} ` +
        `compactions=${input.attemptCompactionCount} — retrying ${retryState.compactionContinuationAttempts}/1 with compacted-transcript continuation`,
    );
    input.armPostCompactionGuard();
    return { action: "retry" };
  }
  retryState.compactionContinuationInstruction = null;

  if (reasoningOnlyRetriesExhausted && !input.finalAssistantVisibleText) {
    const incompletePayloadText = "⚠️ Agent couldn't generate a response. Please try again.";
    log.warn(
      `reasoning-only retries exhausted: runId=${runParams.runId} sessionId=${runParams.sessionId} ` +
        `provider=${input.activeErrorContext.provider}/${input.activeErrorContext.model} attempts=${retryState.reasoningOnlyAttempts}/${input.maxReasoningOnlyRetryAttempts} — surfacing incomplete-turn error`,
    );
    return surfaceIncompleteTurn({
      ...input,
      text: incompletePayloadText,
      payloadCount: 0,
      incompleteTurnFallbackSafe,
      terminalToolPresentation,
    });
  }
  if (
    !nextReasoningOnlyRetryInstruction &&
    nextEmptyResponseRetryInstruction &&
    retryState.emptyResponseAttempts >= input.maxEmptyResponseRetryAttempts
  ) {
    log.warn(
      `empty response retries exhausted: runId=${runParams.runId} sessionId=${runParams.sessionId} ` +
        `provider=${input.activeErrorContext.provider}/${input.activeErrorContext.model} attempts=${retryState.emptyResponseAttempts}/${input.maxEmptyResponseRetryAttempts} — surfacing incomplete-turn error`,
    );
  }
  if (incompleteTurnText) {
    const incompleteStopReason =
      attempt.currentAttemptAssistant?.stopReason ?? attempt.lastAssistant?.stopReason;
    log.warn(
      `incomplete turn detected: runId=${runParams.runId} sessionId=${runParams.sessionId} ` +
        `provider=${input.activeErrorContext.provider}/${input.activeErrorContext.model} ` +
        `stopReason=${incompleteStopReason ?? "missing"} hasLastAssistant=${attempt.lastAssistant ? "yes" : "no"} ` +
        `hasCurrentAttemptAssistant=${attempt.currentAttemptAssistant ? "yes" : "no"} payloads=${payloadCount} ` +
        `tools=${attempt.toolMetas?.length ?? 0} replaySafe=${attempt.replayMetadata.replaySafe ? "yes" : "no"} ` +
        `compactions=${input.attemptCompactionCount} reasoningRetries=${retryState.reasoningOnlyAttempts}/${input.maxReasoningOnlyRetryAttempts} ` +
        `emptyRetries=${retryState.emptyResponseAttempts}/${input.maxEmptyResponseRetryAttempts} ` +
        `missingAssistantRetries=${retryState.missingAssistantAttempts}/${MAX_MISSING_ASSISTANT_RETRIES} — ` +
        (terminalToolPresentation
          ? "surfacing tool-authored terminal presentation"
          : "surfacing error to user"),
    );
    return surfaceIncompleteTurn({
      ...input,
      text: incompleteTurnText,
      payloadCount,
      incompleteTurnFallbackSafe,
      terminalToolPresentation,
    });
  }

  const beforeFinalizeRevisionReason = attempt.beforeAgentFinalizeRevisionReason;
  if (
    beforeFinalizeRevisionReason &&
    !settledTurnFinalizationAttempted &&
    !terminalInterrupted &&
    !promptError &&
    !attempt.clientToolCalls &&
    !attempt.yieldDetected &&
    !emptyAssistantReplyIsSilent
  ) {
    retryState.beforeFinalizeRevisionAttempts += 1;
    input.activateInternalPrompt(
      `${BEFORE_AGENT_FINALIZE_RETRY_PROMPT_PREFIX}\n\n${beforeFinalizeRevisionReason}`,
    );
    retryState.compactionContinuationInstruction = null;
    log.warn(
      `before_agent_finalize requested one more pass: ` +
        `runId=${runParams.runId} sessionId=${runParams.sessionId} ` +
        `attempt=${retryState.beforeFinalizeRevisionAttempts}/${MAX_BEFORE_AGENT_FINALIZE_REVISIONS}`,
    );
    return { action: "retry" };
  }

  return completeEmbeddedRun({
    ...input,
    payloadCount,
    payloadsForTerminalPath,
    emptyAssistantReplyIsSilent,
  });
}

async function surfaceIncompleteTurn(
  input: Parameters<typeof resolveEmbeddedRunTerminal>[0] & {
    text: string;
    payloadCount: number;
    incompleteTurnFallbackSafe: boolean;
    terminalToolPresentation?: string;
  },
): Promise<TerminalResolution> {
  const terminalAborted = isEmbeddedRunTerminalAbort(input.terminalState.outcome);
  const terminalTimedOut = isEmbeddedRunTerminalTimeout(input.terminalState.outcome);
  const replayInvalid = input.resolveReplayInvalid(input.text);
  const livenessState = resolveRunLivenessState({
    payloadCount: input.payloadCount,
    aborted: terminalAborted,
    timedOut: terminalTimedOut,
    attempt: input.attempt,
    incompleteTurnText: input.text,
  });
  input.setTerminalLifecycleMeta({ replayInvalid, livenessState });
  if (input.authProfileId) {
    await input.maybeMarkAuthProfileFailure({
      profileId: input.authProfileId,
      reason: input.assistantProfileFailureReason,
      modelId: input.modelId,
    });
  }
  return {
    action: "complete",
    result: {
      payloads: [
        {
          text: input.terminalToolPresentation
            ? input.terminalToolPresentation.concat("\n\n", input.text)
            : input.text,
          isError: true,
        },
      ],
      meta: {
        durationMs: Date.now() - input.startedAtMs,
        agentMeta: input.agentMeta,
        aborted: terminalAborted,
        systemPromptReport: input.attempt.systemPromptReport,
        finalPromptText: input.attempt.finalPromptText,
        finalAssistantVisibleText: input.finalAssistantVisibleText,
        finalAssistantRawText: input.finalAssistantRawText,
        replayInvalid,
        livenessState,
        error: {
          kind: "incomplete_turn",
          message: "Agent couldn't generate a response.",
          fallbackSafe: input.incompleteTurnFallbackSafe,
          terminalPresentation: input.terminalToolPresentation !== undefined,
        },
        toolSummary: input.attemptToolSummary,
        ...(input.failureSignal ? { failureSignal: input.failureSignal } : {}),
        agentHarnessResultClassification: input.attempt.agentHarnessResultClassification,
      },
      ...copyAttemptDeliveryState(input.attempt),
    },
  };
}

function completeEmbeddedRun(
  input: Parameters<typeof resolveEmbeddedRunTerminal>[0] & {
    payloadCount: number;
    payloadsForTerminalPath: EmbeddedAgentRunResult["payloads"];
    emptyAssistantReplyIsSilent: boolean;
  },
): TerminalResolution {
  const terminalAborted = isEmbeddedRunTerminalAbort(input.terminalState.outcome);
  const terminalTimedOut = isEmbeddedRunTerminalTimeout(input.terminalState.outcome);
  log.debug(
    `embedded run done: runId=${input.runParams.runId} sessionId=${input.runParams.sessionId} durationMs=${Date.now() - input.startedAtMs} aborted=${terminalAborted}`,
  );
  markEmbeddedRunAuthProfileSuccess({
    authProfileStateMode: input.runParams.authProfileStateMode,
    profileId: input.authProfileId,
    profileStore: input.profileFailureStore,
    provider: input.provider,
    agentDir: input.runParams.agentDir,
    runId: input.runParams.runId,
    sessionId: input.runParams.sessionId,
  });
  reportEmbeddedRunSuccessfulAuthBinding({
    profileId: input.authProfileId,
    profileStore: input.attemptAuthProfileStore,
    apiKeyInfo: input.apiKeyInfo,
    attempt: input.attempt,
    provider: input.provider,
    agentDir: input.runParams.agentDir,
    modelId: input.modelTransportId,
    modelApi: input.modelTransportApi,
    ...(input.modelTransportBaseUrl ? { modelBaseUrl: input.modelTransportBaseUrl } : {}),
    requestTransportOverrides: input.requestTransportOverrides ?? "none",
    config: input.runParams.config,
    agentHarnessId: input.agentHarnessId,
    pluginHarnessOwnsTransport: input.pluginHarnessOwnsTransport,
    pluginHarnessOwnsAuthBootstrap: input.pluginHarnessOwnsAuthBootstrap,
    onSuccessfulAuthBinding: input.runParams.onSuccessfulAuthBinding,
  });
  const replayInvalid = input.resolveReplayInvalid(null);
  const yieldHasContinuation =
    input.attempt.yieldDetected && hasYieldContinuationEvidence(input.attempt);
  const livenessState = input.attempt.yieldDetected
    ? "paused"
    : resolveRunLivenessState({
        payloadCount: input.payloadCount,
        aborted: terminalAborted,
        timedOut: terminalTimedOut,
        attempt: input.attempt,
        incompleteTurnText: null,
      });
  const stopReason = input.attempt.clientToolCalls
    ? "tool_calls"
    : input.attempt.yieldDetected
      ? "end_turn"
      : (input.attemptAssistant?.stopReason as string | undefined);
  // The truncation notice belongs to exactly the turns this fix newly delivers:
  // a length stop whose only output is partial assistant text. A length stop that
  // also produced terminal output (tool media, a committed source reply) was
  // already complete before this fix and must not gain a misleading extra reply.
  // Nonblank assistant text is also required: a cron turn whose only payload is
  // the synthesized silent result of a successful tool has no partial prose to
  // label, and appending a notice there would turn intentional silence into a
  // visible message.
  const hasPartialAssistantText =
    input.attempt.assistantTexts.some((text) => text.trim().length > 0) ||
    resolveFinalAssistantVisibleText(input.attemptAssistant) !== undefined;
  const isTruncatedPartialReply =
    stopReason === "length" && !hasAttemptTerminalState(input.attempt) && hasPartialAssistantText;
  // Existing visible payloads already avoid the silent-park symptom. The diagnostic
  // fills only an otherwise empty yielded turn and must not duplicate visible output.
  // A length stop delivers partial text, so it is labeled instead of dropped. (#76477)
  const terminalPayloads = input.emptyAssistantReplyIsSilent
    ? [{ text: SILENT_REPLY_TOKEN }]
    : input.payloadsForTerminalPath?.length
      ? isTruncatedPartialReply
        ? [...input.payloadsForTerminalPath, { text: TRUNCATED_REPLY_NOTICE_TEXT }]
        : input.payloadsForTerminalPath
      : input.attempt.yieldDetected && !yieldHasContinuation
        ? [{ text: YIELD_DIAGNOSTIC_TEXT }]
        : input.payloadsForTerminalPath;
  input.setTerminalLifecycleMeta({
    replayInvalid,
    livenessState,
    stopReason,
    yielded: input.attempt.yieldDetected === true,
  });
  return {
    action: "complete",
    result: {
      payloads: terminalPayloads?.length ? terminalPayloads : undefined,
      ...(input.attempt.diagnosticTrace
        ? { diagnosticTrace: freezeDiagnosticTraceContext(input.attempt.diagnosticTrace) }
        : {}),
      meta: {
        durationMs: Date.now() - input.startedAtMs,
        agentMeta: input.agentMeta,
        aborted: terminalAborted,
        systemPromptReport: input.attempt.systemPromptReport,
        finalPromptText: input.attempt.finalPromptText,
        finalAssistantVisibleText: input.finalAssistantVisibleText,
        finalAssistantRawText: input.finalAssistantRawText,
        replayInvalid,
        livenessState,
        agentHarnessResultClassification: input.attempt.agentHarnessResultClassification,
        ...(input.attempt.yieldDetected ? { yielded: true } : {}),
        ...(input.emptyAssistantReplyIsSilent
          ? { terminalReplyKind: "silent-empty" as const }
          : {}),
        stopReason,
        pendingToolCalls: input.attempt.clientToolCalls?.map((call) => ({
          id: randomBytes(5).toString("hex").slice(0, 9),
          name: call.name,
          arguments: JSON.stringify(call.params),
        })),
        executionTrace: {
          winnerProvider: input.reportedModelRef.provider,
          winnerModel: input.reportedModelRef.model,
          attempts:
            input.traceAttempts.length > 0 ||
            input.attemptAssistant?.provider ||
            input.attemptAssistant?.model
              ? [
                  ...input.traceAttempts,
                  {
                    provider: input.reportedModelRef.provider,
                    model: input.reportedModelRef.model,
                    result: "success",
                    stage: "assistant",
                  },
                ]
              : undefined,
          fallbackUsed: input.traceAttempts.some(input.traceAttemptUsesFallback),
          runner: "embedded",
        },
        requestShaping: {
          ...(input.authProfileId ? { authMode: "auth-profile" } : {}),
          ...(input.thinkLevel ? { thinking: input.thinkLevel } : {}),
          ...(input.runParams.reasoningLevel ? { reasoning: input.runParams.reasoningLevel } : {}),
          ...(input.runParams.verboseLevel ? { verbose: input.runParams.verboseLevel } : {}),
          ...(input.runParams.blockReplyBreak
            ? { blockStreaming: input.runParams.blockReplyBreak }
            : {}),
        },
        toolSummary: input.attemptToolSummary,
        ...(input.failureSignal ? { failureSignal: input.failureSignal } : {}),
        completion: {
          ...(stopReason ? { stopReason } : {}),
          ...(stopReason ? { finishReason: stopReason } : {}),
          ...(stopReason?.toLowerCase().includes("refusal") ? { refusal: true } : {}),
        },
        contextManagement:
          input.contextRecoveryState.autoCompactionCount > 0
            ? { lastTurnCompactions: input.contextRecoveryState.autoCompactionCount }
            : undefined,
      },
      ...copyAttemptDeliveryState(input.attempt),
    },
  };
}

export function copyAttemptDeliveryState(attempt: EmbeddedRunAttemptResult) {
  return {
    latestMcpAppChannelView: attempt.latestMcpAppChannelView,
    latestMcpConnectAction: attempt.latestMcpConnectAction,
    didSendViaMessagingTool: attempt.didSendViaMessagingTool,
    didDeliverSourceReplyViaMessageTool: attempt.didDeliverSourceReplyViaMessageTool === true,
    didSendDeterministicApprovalPrompt: attempt.didSendDeterministicApprovalPrompt,
    messagingToolSentTexts: attempt.messagingToolSentTexts,
    messagingToolSentMediaUrls: attempt.messagingToolSentMediaUrls,
    messagingToolSentTargets: attempt.messagingToolSentTargets,
    messagingToolSourceReplyPayloads: attempt.messagingToolSourceReplyPayloads,
    heartbeatToolResponse: attempt.heartbeatToolResponse,
    successfulCronAdds: attempt.successfulCronAdds,
    acceptedSessionSpawns: attempt.acceptedSessionSpawns,
  };
}
