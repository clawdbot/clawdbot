/**
 * Compiles current-turn prompt text, hidden runtime context, and hook messages.
 */
import { filterHeartbeatTranscriptArtifacts } from "../../../auto-reply/heartbeat-filter.js";
import type { SessionSystemPromptReport } from "../../../config/sessions/types.js";
import type { HeartbeatSummary } from "../../../infra/heartbeat-summary.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../defaults.js";
import type { AgentMessage } from "../../runtime/index.js";
import { log } from "../logger.js";
import {
  cloneToolResultPromptProjectionState,
  type ToolResultPromptProjectionState,
} from "../session-prompt-state.js";
import {
  resolveLiveToolResultAggregateMaxChars,
  resolveLiveToolResultMaxChars,
  toolResultWarningDedupe,
  truncateOversizedToolResultsInMessages,
} from "../tool-result-truncation.js";
import {
  normalizeCurrentPromptTextForLlmBoundary,
  normalizeMessagesForCurrentPromptBoundary,
} from "./attempt.llm-boundary.js";
import { composeSystemPromptWithHookContext } from "./attempt.thread-helpers.js";
import {
  buildCurrentInboundPrompt,
  buildRuntimeContextCustomMessage,
  resolveRuntimeContextPromptParts,
  type RuntimeContextCustomMessage,
} from "./runtime-context-prompt.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type PromptContextAttempt = Pick<
  EmbeddedRunAttemptParams,
  | "config"
  | "contextTokenBudget"
  | "currentInboundContext"
  | "currentInboundEventKind"
  | "sessionId"
  | "sessionKey"
  | "suppressNextUserMessagePersistence"
>;

type PromptAssemblyContext = {
  effectivePrompt: string;
  promptBeforePromptBuildHooks: string;
  promptBuildPrependContext?: string;
  promptBuildAppendContext?: string;
  hasPromptBuildContext: boolean;
  effectiveTranscriptPrompt?: string;
  transcriptPromptForRuntimeSplit?: string;
  promptForRuntimeContextSplit: string;
  promptForModelBeforeRuntimeContextSplit: string;
  promptForRuntimeContextBeforeAnnotation: string;
  heartbeatSummary?: Pick<HeartbeatSummary, "ackMaxChars" | "prompt">;
};

type CurrentUserTimestampOverride = {
  timestamp: number;
  text: string;
  alternateText?: string;
};

type EmbeddedAttemptPromptContext = {
  aggregatePressureEngaged: boolean;
  contextTokenBudget: number;
  currentUserTimestampOverride?: CurrentUserTimestampOverride;
  effectivePrompt: string;
  hookMessagesForCurrentPrompt: AgentMessage[];
  llmBoundaryPromptForPrecheck: string;
  prePromptMessageCount: number;
  promptForModel: string;
  promptForSession: string;
  promptSubmission: ReturnType<typeof resolveRuntimeContextPromptParts>;
  promptToolResultAggregateMaxChars: number;
  promptToolResultMaxChars: number;
  runtimeContextMessageForCurrentTurn?: RuntimeContextCustomMessage;
  systemPromptForHook: string;
};

export function prepareEmbeddedAttemptPromptContext(input: {
  attempt: PromptContextAttempt;
  boundaryTimezone?: string;
  includeBoundaryTimestamp: boolean;
  isRawModelRun: boolean;
  messages: AgentMessage[];
  preparedUserTurnMessage?: AgentMessage;
  heartbeatOutcomeContext?: string;
  prompt: PromptAssemblyContext;
  replaceSessionMessages: (messages: AgentMessage[]) => void;
  sessionAgentId: string;
  setActiveSessionSystemPrompt: (systemPrompt: string) => void;
  systemPromptReport?: SessionSystemPromptReport;
  systemPromptText: string;
  toolResultPromptProjectionState: ToolResultPromptProjectionState;
}): EmbeddedAttemptPromptContext {
  const { attempt } = input;
  const preparedUserTurnTimestamp = (
    input.preparedUserTurnMessage as { timestamp?: unknown } | undefined
  )?.timestamp;
  let sessionMessages = filterHeartbeatTranscriptArtifacts(
    input.messages,
    input.prompt.heartbeatSummary?.ackMaxChars,
    input.prompt.heartbeatSummary?.prompt,
  );
  if (sessionMessages.length < input.messages.length) {
    input.replaceSessionMessages(sessionMessages);
  }
  const prePromptMessageCount = sessionMessages.length;
  const contextTokenBudget = attempt.contextTokenBudget ?? DEFAULT_CONTEXT_TOKENS;
  const promptToolResultMaxChars = resolveLiveToolResultMaxChars({
    contextWindowTokens: contextTokenBudget,
  });
  const promptToolResultAggregateMaxChars = resolveLiveToolResultAggregateMaxChars({
    contextWindowTokens: contextTokenBudget,
    perResultMaxChars: promptToolResultMaxChars,
  });
  const promptToolResultTruncation = truncateOversizedToolResultsInMessages(
    sessionMessages,
    contextTokenBudget,
    promptToolResultMaxChars,
    promptToolResultAggregateMaxChars,
    cloneToolResultPromptProjectionState(input.toolResultPromptProjectionState),
  );
  const promptHistoryChanged = promptToolResultTruncation.messages !== sessionMessages;
  const { aggregatePressureEngaged } = promptToolResultTruncation;
  if (promptHistoryChanged) {
    sessionMessages = promptToolResultTruncation.messages;
  }
  if (promptHistoryChanged || aggregatePressureEngaged) {
    const sessionLogKey = attempt.sessionKey ?? attempt.sessionId ?? "unknown";
    const truncationLog =
      `[tool-result-truncation] Truncated ${promptToolResultTruncation.truncatedCount} ` +
      `tool result(s) for prompt history ` +
      `(maxChars=${promptToolResultMaxChars} ` +
      `aggregateBudgetChars=${promptToolResultAggregateMaxChars} ` +
      `aggregate=${promptToolResultTruncation.aggregateTruncatedCount}) ` +
      `sessionKey=${sessionLogKey}`;
    if (aggregatePressureEngaged) {
      if (!toolResultWarningDedupe.promptPressure.check(sessionLogKey)) {
        log.warn(
          `${truncationLog}; aggregate tool-result pressure detected; final provider-bound projection will determine whether recovery is needed`,
        );
      }
    } else {
      log.info(truncationLog);
    }
  }

  const hasNonEmptyTranscriptPrompt = Boolean(input.prompt.effectiveTranscriptPrompt?.trim());
  // A non-empty transcript prompt is a persistence substitution. Keep the
  // assembled model prompt authoritative even when no hook added context.
  const shouldUseExplicitModelPrompt =
    input.prompt.hasPromptBuildContext || hasNonEmptyTranscriptPrompt;
  const promptSubmission = resolveRuntimeContextPromptParts({
    effectivePrompt: input.prompt.promptForRuntimeContextSplit,
    transcriptPrompt: input.prompt.transcriptPromptForRuntimeSplit,
    modelPrompt: shouldUseExplicitModelPrompt
      ? input.prompt.promptForModelBeforeRuntimeContextSplit
      : undefined,
    modelPromptBuildContext:
      shouldUseExplicitModelPrompt && input.prompt.effectiveTranscriptPrompt !== undefined
        ? {
            promptBeforeHooks: input.prompt.promptBeforePromptBuildHooks,
            transcriptPromptBeforeTransforms: input.prompt.effectiveTranscriptPrompt,
            promptBeforeAnnotation: input.prompt.promptForRuntimeContextBeforeAnnotation,
            prependContext: input.prompt.promptBuildPrependContext ?? "",
            appendContext: input.prompt.promptBuildAppendContext ?? "",
          }
        : undefined,
    emptyTranscriptMode: attempt.suppressNextUserMessagePersistence
      ? "model-prompt"
      : "runtime-event",
  });
  const isRuntimeOnlyTurn = promptSubmission.runtimeOnly === true;
  const currentInboundContextText = isRuntimeOnlyTurn
    ? undefined
    : attempt.currentInboundContext?.text?.trim() || undefined;
  // Normal user turns persist the bare prompt and carry current inbound metadata
  // in a hidden runtime-context message. Runtime-only turns have no bare user turn,
  // so their inbound context remains inline and byte-stable across replay.
  const promptForSession = isRuntimeOnlyTurn
    ? buildCurrentInboundPrompt({
        context: attempt.currentInboundContext,
        prompt: promptSubmission.prompt,
      })
    : promptSubmission.prompt;
  const promptForModel = isRuntimeOnlyTurn
    ? buildCurrentInboundPrompt({
        context: attempt.currentInboundContext,
        prompt: promptSubmission.modelPrompt ?? promptSubmission.prompt,
      })
    : (promptSubmission.modelPrompt ?? promptSubmission.prompt);
  const currentUserTimestampOverride =
    !input.isRawModelRun && typeof preparedUserTurnTimestamp === "number"
      ? {
          timestamp: preparedUserTurnTimestamp,
          text: promptForSession,
          ...(promptForModel !== promptForSession ? { alternateText: promptForModel } : {}),
        }
      : undefined;
  const runtimeSystemContext = promptSubmission.runtimeSystemContext?.trim();
  let systemPromptForHook = input.systemPromptText;
  if (promptSubmission.runtimeOnly && runtimeSystemContext) {
    const runtimeSystemPrompt = composeSystemPromptWithHookContext({
      baseSystemPrompt: input.systemPromptText,
      appendSystemContext: runtimeSystemContext,
    });
    if (runtimeSystemPrompt) {
      systemPromptForHook = runtimeSystemPrompt;
      input.setActiveSessionSystemPrompt(runtimeSystemPrompt);
    }
  }
  const runtimeContextForHook = isRuntimeOnlyTurn
    ? undefined
    : [
        currentInboundContextText,
        promptSubmission.runtimeContext?.trim(),
        input.heartbeatOutcomeContext?.trim(),
      ]
        .filter((value): value is string => Boolean(value))
        .join("\n\n") || undefined;
  const runtimeContextMessageForCurrentTurn =
    buildRuntimeContextCustomMessage(runtimeContextForHook);
  const messagesForCurrentPrompt = runtimeContextMessageForCurrentTurn
    ? [...sessionMessages, runtimeContextMessageForCurrentTurn]
    : sessionMessages;
  const hookMessagesForCurrentPrompt = normalizeMessagesForCurrentPromptBoundary({
    messages: messagesForCurrentPrompt,
    prompt: promptForModel,
    ...(input.boundaryTimezone ? { timezone: input.boundaryTimezone } : {}),
    ...(input.includeBoundaryTimestamp ? {} : { includeTimestamp: false }),
    ...(typeof preparedUserTurnTimestamp === "number"
      ? { currentUserTimestamp: preparedUserTurnTimestamp }
      : {}),
  });
  if (input.systemPromptReport) {
    input.systemPromptReport.currentTurn = {
      ...(attempt.currentInboundEventKind ? { kind: attempt.currentInboundEventKind } : {}),
      promptChars: promptForModel.length,
      runtimeContextChars: promptSubmission.runtimeOnly
        ? (runtimeSystemContext?.length ?? 0)
        : (runtimeContextForHook?.length ?? 0),
      // Hook context reaches only the model, so count the delta beyond the
      // transcript prompt or downstream context accounting undercounts it.
      modelOnlyPromptChars: Math.max(0, promptForModel.length - promptForSession.length),
    };
  }
  const llmBoundaryPromptForPrecheck = normalizeCurrentPromptTextForLlmBoundary({
    prompt: promptForModel,
    ...(input.boundaryTimezone ? { timezone: input.boundaryTimezone } : {}),
    ...(input.includeBoundaryTimestamp ? {} : { includeTimestamp: false }),
    ...(typeof preparedUserTurnTimestamp === "number"
      ? { currentUserTimestamp: preparedUserTurnTimestamp }
      : {}),
    // Admission must count the same persisted sender block that provider
    // conversion projects after the active user turn is written.
    ...(!input.isRawModelRun && input.preparedUserTurnMessage
      ? { currentUserTranscriptMessage: input.preparedUserTurnMessage }
      : {}),
  });

  return {
    aggregatePressureEngaged,
    contextTokenBudget,
    ...(currentUserTimestampOverride ? { currentUserTimestampOverride } : {}),
    effectivePrompt: input.prompt.effectivePrompt,
    hookMessagesForCurrentPrompt,
    llmBoundaryPromptForPrecheck,
    prePromptMessageCount,
    promptForModel,
    promptForSession,
    promptSubmission,
    promptToolResultAggregateMaxChars,
    promptToolResultMaxChars,
    ...(runtimeContextMessageForCurrentTurn ? { runtimeContextMessageForCurrentTurn } : {}),
    systemPromptForHook,
  };
}
