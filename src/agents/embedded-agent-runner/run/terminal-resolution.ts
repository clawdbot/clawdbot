import { randomBytes } from "node:crypto";
import { SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import { freezeDiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import type { AssistantMessage } from "../../../llm/types.js";
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
import {
  markEmbeddedRunAuthProfileSuccess,
  reportEmbeddedRunSuccessfulAuthBinding,
} from "./auth-profile-success.js";
import type { EmbeddedRunContextRecoveryState } from "./context-recovery-state.js";
import {
  hasAttemptTerminalState,
  resolveAttemptReplayMetadata,
  resolveEmptyResponseRetryInstruction,
  resolveIncompleteTurnPayloadText,
  resolveReasoningOnlyRetryInstruction,
  resolveRunLivenessState,
  resolveSilentToolResultReplyPayload,
  resolveToolUseTerminalContinuationInstruction,
  shouldRetryMissingAssistantTurn,
  shouldTreatEmptyAssistantReplyAsSilent,
} from "./incomplete-turn.js";
import type { RunEmbeddedAgentParams } from "./params.js";
import {
  MAX_BEFORE_AGENT_FINALIZE_REVISIONS,
  type EmbeddedRunTerminalRetryState,
} from "./terminal-retry-state.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

const MAX_MISSING_ASSISTANT_RETRIES = 1;
const MAX_TOOL_USE_TERMINAL_CONTINUATIONS = 1;
const COMPACTION_CONTINUATION_RETRY_INSTRUCTION =
  "The previous attempt compacted the conversation context before producing a final user-visible answer. Continue from the compacted transcript and produce the final answer now. Do not restart from scratch, do not repeat completed work, and do not rerun tools unless the transcript clearly lacks required evidence.";
const BEFORE_AGENT_FINALIZE_RETRY_PROMPT_PREFIX =
  "Before accepting the previous final answer, apply this revision request and produce the revised final answer. Do not repeat completed work or rerun tools unless the request explicitly requires it.";

type TerminalRunParams = RunEmbeddedAgentParams & {
  authProfileStateMode?: "read-write" | "read-only";
  onSuccessfulAuthBinding?: (binding: AgentExecutionAuthBinding) => void;
};

type TerminalResolution =
  | { action: "retry" }
  | { action: "complete"; result: EmbeddedAgentRunResult };

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
  terminalAborted: boolean;
  terminalTimedOut: boolean;
  terminalInterrupted: boolean;
  externalAbort: boolean;
  signalOwnedInterruption: boolean;
  promptError: unknown;
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
  activateInternalPrompt: (prompt: string, persisted: boolean) => void;
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
  authProfileId?: string;
  profileFailureStore: AuthProfileStore;
  attemptAuthProfileStore: AuthProfileStore;
  apiKeyInfo: ResolvedProviderAuth | null;
  agentHarnessId: string;
  pluginHarnessOwnsTransport: boolean;
  pluginHarnessOwnsAuthBootstrap: boolean;
  reportedModelRef: { provider: string; model: string };
  traceAttempts: TraceAttempt[];
  traceAttemptUsesFallback: (attempt: TraceAttempt) => boolean;
  thinkLevel?: string;
  contextRecoveryState: EmbeddedRunContextRecoveryState;
}): Promise<TerminalResolution> {
  const { runParams, attempt, retryState } = input;
  const silentToolResultReplyPayload = resolveSilentToolResultReplyPayload({
    isCronTrigger: runParams.trigger === "cron",
    payloadCount: input.payloadsWithToolMedia?.length ?? 0,
    aborted: input.terminalAborted,
    timedOut: input.terminalTimedOut,
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
  const emptyAssistantReplyIsSilent = shouldTreatEmptyAssistantReplyAsSilent({
    allowEmptyAssistantReplyAsSilent: runParams.allowEmptyAssistantReplyAsSilent,
    payloadCount,
    aborted: input.terminalAborted,
    timedOut: input.terminalTimedOut,
    attempt,
  });
  const nextReasoningOnlyRetryInstruction = emptyAssistantReplyIsSilent
    ? null
    : resolveReasoningOnlyRetryInstruction({
        provider: input.activeErrorContext.provider,
        modelId: input.activeErrorContext.model,
        modelApi: input.modelApi,
        executionContract: input.executionContract,
        aborted: input.terminalAborted,
        timedOut: input.terminalTimedOut,
        attempt,
      });
  const nextEmptyResponseRetryInstruction = emptyAssistantReplyIsSilent
    ? null
    : resolveEmptyResponseRetryInstruction({
        provider: input.activeErrorContext.provider,
        modelId: input.activeErrorContext.model,
        modelApi: input.modelApi,
        executionContract: input.executionContract,
        payloadCount,
        aborted: input.terminalAborted,
        timedOut: input.terminalTimedOut,
        attempt,
      });
  if (
    nextReasoningOnlyRetryInstruction &&
    retryState.reasoningOnlyAttempts < input.maxReasoningOnlyRetryAttempts
  ) {
    retryState.reasoningOnlyAttempts += 1;
    input.activateInternalPrompt(nextReasoningOnlyRetryInstruction, false);
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
    shouldRetryMissingAssistantTurn({
      payloadCount,
      aborted: input.terminalAborted,
      promptError: input.promptError,
      timedOut: input.terminalTimedOut,
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
  if (
    !nextReasoningOnlyRetryInstruction &&
    nextEmptyResponseRetryInstruction &&
    retryState.emptyResponseAttempts < input.maxEmptyResponseRetryAttempts
  ) {
    retryState.emptyResponseAttempts += 1;
    input.activateInternalPrompt(nextEmptyResponseRetryInstruction, false);
    log.warn(
      `empty response detected: runId=${runParams.runId} sessionId=${runParams.sessionId} ` +
        `provider=${input.activeErrorContext.provider}/${input.activeErrorContext.model} — retrying ${retryState.emptyResponseAttempts}/${input.maxEmptyResponseRetryAttempts} ` +
        `with visible-answer continuation`,
    );
    return { action: "retry" };
  }
  const availableTerminalToolPresentation = input.readTerminalToolPresentation();
  const nextToolUseTerminalContinuationInstruction = emptyAssistantReplyIsSilent
    ? null
    : resolveToolUseTerminalContinuationInstruction({
        provider: input.activeErrorContext.provider,
        modelId: input.activeErrorContext.model,
        modelApi: input.modelApi,
        executionContract: input.executionContract,
        payloadCount,
        hasTerminalToolPresentation: Boolean(availableTerminalToolPresentation),
        aborted: input.terminalAborted,
        promptError: input.promptError,
        timedOut: input.terminalTimedOut,
        attempt,
      });
  if (
    nextToolUseTerminalContinuationInstruction &&
    retryState.toolUseContinuationAttempts < MAX_TOOL_USE_TERMINAL_CONTINUATIONS
  ) {
    retryState.toolUseContinuationAttempts += 1;
    // This starts a new persisted native-thread turn after settled tool results; it does not
    // replay the failed prompt or completed tools. Therefore replaySafe does not apply.
    input.activateInternalPrompt(nextToolUseTerminalContinuationInstruction, false);
    log.warn(
      `tool-use terminal turn lacked a final answer: runId=${runParams.runId} sessionId=${runParams.sessionId} ` +
        `provider=${input.activeErrorContext.provider}/${input.activeErrorContext.model} — continuing ${retryState.toolUseContinuationAttempts}/${MAX_TOOL_USE_TERMINAL_CONTINUATIONS} ` +
        `from settled tool results`,
    );
    return { action: "retry" };
  }
  const incompleteTurnText = emptyAssistantReplyIsSilent
    ? null
    : resolveIncompleteTurnPayloadText({
        payloadCount,
        aborted: input.terminalAborted,
        externalAbort: input.externalAbort || input.signalOwnedInterruption,
        timedOut: input.terminalTimedOut,
        attempt,
      });
  const incompleteTurnFallbackSafe = Boolean(
    incompleteTurnText &&
    !input.terminalInterrupted &&
    !input.promptError &&
    !attempt.lastToolError &&
    !hasAttemptTerminalState(attempt) &&
    !input.replayState.hadPotentialSideEffects,
  );
  const terminalToolPresentation = incompleteTurnFallbackSafe
    ? availableTerminalToolPresentation
    : undefined;
  if (
    !emptyAssistantReplyIsSilent &&
    input.attemptCompactionCount > 0 &&
    payloadCount === 0 &&
    !input.terminalInterrupted &&
    !input.promptError &&
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
    const replayMetadata = resolveAttemptReplayMetadata(attempt);
    const incompleteStopReason =
      attempt.currentAttemptAssistant?.stopReason ?? attempt.lastAssistant?.stopReason;
    log.warn(
      `incomplete turn detected: runId=${runParams.runId} sessionId=${runParams.sessionId} ` +
        `provider=${input.activeErrorContext.provider}/${input.activeErrorContext.model} ` +
        `stopReason=${incompleteStopReason ?? "missing"} hasLastAssistant=${attempt.lastAssistant ? "yes" : "no"} ` +
        `hasCurrentAttemptAssistant=${attempt.currentAttemptAssistant ? "yes" : "no"} payloads=${payloadCount} ` +
        `tools=${attempt.toolMetas?.length ?? 0} replaySafe=${replayMetadata.replaySafe ? "yes" : "no"} ` +
        `compactions=${input.attemptCompactionCount} reasoningRetries=${retryState.reasoningOnlyAttempts}/${input.maxReasoningOnlyRetryAttempts} ` +
        `emptyRetries=${retryState.emptyResponseAttempts}/${input.maxEmptyResponseRetryAttempts} ` +
        `missingAssistantRetries=${retryState.missingAssistantAttempts}/${MAX_MISSING_ASSISTANT_RETRIES} ` +
        `toolUseContinuations=${retryState.toolUseContinuationAttempts}/${MAX_TOOL_USE_TERMINAL_CONTINUATIONS} — ` +
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
    !input.terminalInterrupted &&
    !input.promptError &&
    !attempt.clientToolCalls &&
    !attempt.yieldDetected &&
    !emptyAssistantReplyIsSilent
  ) {
    retryState.beforeFinalizeRevisionAttempts += 1;
    input.activateInternalPrompt(
      `${BEFORE_AGENT_FINALIZE_RETRY_PROMPT_PREFIX}\n\n${beforeFinalizeRevisionReason}`,
      true,
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
  const replayInvalid = input.resolveReplayInvalid(input.text);
  const livenessState = resolveRunLivenessState({
    payloadCount: input.payloadCount,
    aborted: input.terminalAborted,
    timedOut: input.terminalTimedOut,
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
        aborted: input.terminalAborted,
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
  log.debug(
    `embedded run done: runId=${input.runParams.runId} sessionId=${input.runParams.sessionId} durationMs=${Date.now() - input.startedAtMs} aborted=${input.terminalAborted}`,
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
    agentHarnessId: input.agentHarnessId,
    pluginHarnessOwnsTransport: input.pluginHarnessOwnsTransport,
    pluginHarnessOwnsAuthBootstrap: input.pluginHarnessOwnsAuthBootstrap,
    onSuccessfulAuthBinding: input.runParams.onSuccessfulAuthBinding,
  });
  const replayInvalid = input.resolveReplayInvalid(null);
  const livenessState = input.attempt.yieldDetected
    ? "paused"
    : resolveRunLivenessState({
        payloadCount: input.payloadCount,
        aborted: input.terminalAborted,
        timedOut: input.terminalTimedOut,
        attempt: input.attempt,
        incompleteTurnText: null,
      });
  const stopReason = input.attempt.clientToolCalls
    ? "tool_calls"
    : input.attempt.yieldDetected
      ? "end_turn"
      : (input.attemptAssistant?.stopReason as string | undefined);
  const terminalPayloads = input.emptyAssistantReplyIsSilent
    ? [{ text: SILENT_REPLY_TOKEN }]
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
        aborted: input.terminalAborted,
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
