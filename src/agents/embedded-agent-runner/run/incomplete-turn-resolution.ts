/** Resolves incomplete-turn payloads, continuation evidence, and run liveness. */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import { hasAcceptedSessionSpawn } from "../../accepted-session-spawn.js";
import { projectAgentRunAttemptTerminal } from "../../agent-run-terminal-outcome.js";
import type { AuthProfileFailureReason } from "../../auth-profiles.js";
import { collectTextContentBlocks } from "../../content-blocks.js";
import type { MessagingToolSend } from "../../embedded-agent-messaging.types.js";
import { renderAuthProfileFailoverCopy } from "../../failover/user-copy.js";
import { buildProviderAuthRecoveryHint } from "../../provider-auth-recovery-hint.js";
import { hasOnlyAssistantReasoningContent } from "../../replay-turn-classification.js";
import type { AgentMessage } from "../../runtime/index.js";
import { hasCommittedMessagingToolDeliveryEvidence } from "../delivery-evidence.js";
import type { EmbeddedRunLivenessState } from "../types.js";
import { hasAsyncActivity, hasAttemptTerminalState } from "./attempt-terminal-evidence.js";
import {
  classifyAssistantTurn,
  hasOnlySilentAssistantReply,
  isEmptyResponseAssistantTurn,
  isIncompleteTerminalAssistantTurn,
  isReasoningOnlyAssistantTurn,
  joinAssistantTexts,
  type IncompleteTurnAttempt,
} from "./incomplete-turn-classification.js";
import {
  isBlockedRuntimeResumeSilentReply,
  RUNTIME_RESUME_SILENT_REPLY_BLOCKED_TEXT,
} from "./runtime-resume-contract.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

type SilentToolResultAttempt = Pick<
  EmbeddedRunAttemptResult,
  | "clientToolCalls"
  | "yieldDetected"
  | "didSendDeterministicApprovalPrompt"
  | "lastToolError"
  | "messagesSnapshot"
  | "toolMetas"
>;

type RunLivenessAttempt = Pick<
  EmbeddedRunAttemptResult,
  "lastAssistant" | "replayMetadata" | "terminal"
>;

type TerminalAuthFailureContext = {
  assistantProfileFailureReason?: AuthProfileFailureReason | null;
  provider: string;
  runParams: Pick<Parameters<typeof buildProviderAuthRecoveryHint>[0], "config" | "workspaceDir">;
};

/**
 * Builds the user-visible incomplete-turn warning when a terminal attempt did
 * not produce a safe final assistant response and no committed delivery/progress
 * already completed the task.
 */
export function resolveIncompleteTurnPayloadText(params: {
  payloadCount: number;
  aborted: boolean;
  externalAbort: boolean;
  timedOut: boolean;
  hadPotentialSideEffects?: boolean;
  hasIntentionalTerminalCompletion?: boolean;
  blockRuntimeResumeSilentReply?: boolean;
  terminalAuthFailure?: TerminalAuthFailureContext;
  attempt: IncompleteTurnAttempt;
}): string | null {
  // Prefer the current attempt's terminal message. The session fallback can
  // still point at the pre-tool turn after a post-tool answer completes. (#80918)
  const assistantState = classifyAssistantTurn(params);
  const assistant = assistantState.assistant;
  const hasTerminalOutput = hasAttemptTerminalState(params.attempt);
  // Tool-use expects a post-tool continuation, so partial visible text completes
  // nothing. A length stop that did produce visible text is a partial answer and
  // is delivered with a truncation notice instead. (#76477)
  const incompleteTerminalAssistant = isIncompleteTerminalAssistantTurn({
    hasAssistantVisibleText: params.payloadCount > 0,
    hasTerminalOutput,
    lastAssistant: assistant,
  });
  // Thinking payloads can count toward payloadCount but carry no user-visible
  // content; bypass the visible-text guard when thinking was the only output
  // so that incomplete-turn stall detection fires below. (#89787, #91953)
  const thinkingOnlyTerminal =
    params.payloadCount !== 0 &&
    !assistantState.visibleText.length &&
    !hasTerminalOutput &&
    Boolean(assistant && hasOnlyAssistantReasoningContent(assistant));

  if (
    (params.payloadCount !== 0 && !incompleteTerminalAssistant && !thinkingOnlyTerminal) ||
    (params.aborted && params.externalAbort) ||
    params.timedOut ||
    params.attempt.clientToolCalls ||
    params.attempt.yieldDetected ||
    params.attempt.didSendDeterministicApprovalPrompt ||
    params.attempt.lastToolError ||
    params.hasIntentionalTerminalCompletion
  ) {
    return null;
  }

  if (
    isBlockedRuntimeResumeSilentReply({
      blockRuntimeResumeSilentReply:
        params.blockRuntimeResumeSilentReply === true ||
        params.attempt.blockRuntimeResumeSilentReply === true,
      assistantTexts: params.attempt.assistantTexts,
    })
  ) {
    return RUNTIME_RESUME_SILENT_REPLY_BLOCKED_TEXT;
  }

  if (hasOnlySilentAssistantReply(params.attempt.assistantTexts)) {
    return null;
  }

  if (hasCommittedMessagingToolDeliveryEvidence(params.attempt)) {
    return null;
  }

  if (hasAcceptedSessionSpawn(params.attempt.acceptedSessionSpawns)) {
    return null;
  }

  if (hasAsyncActivity(params.attempt.toolMetas)) {
    return null;
  }

  const stopReason = assistant?.stopReason;
  const reasoningOnlyAssistant = isReasoningOnlyAssistantTurn(assistant);
  const emptyResponseAssistant = isEmptyResponseAssistantTurn({
    payloadCount: params.payloadCount,
    attempt: params.attempt,
  });
  if (
    !incompleteTerminalAssistant &&
    !reasoningOnlyAssistant &&
    !thinkingOnlyTerminal &&
    !emptyResponseAssistant &&
    stopReason !== "error"
  ) {
    return null;
  }

  if (params.hadPotentialSideEffects || params.attempt.replayMetadata.hadPotentialSideEffects) {
    return "⚠️ Agent couldn't generate a response. Note: some tool actions may have already been executed — please verify before retrying.";
  }
  const authFailure = params.terminalAuthFailure;
  const reason = authFailure?.assistantProfileFailureReason;
  if (authFailure && (reason === "auth" || reason === "auth_permanent")) {
    return renderAuthProfileFailoverCopy({
      reason,
      provider: authFailure.provider,
      allInCooldown: false,
      recoveryHint: buildProviderAuthRecoveryHint({
        provider: authFailure.provider,
        config: authFailure.runParams.config,
        workspaceDir: authFailure.runParams.workspaceDir,
        env: process.env,
      }),
    });
  }
  return "⚠️ Agent couldn't generate a response. Please try again.";
}

/**
 * Allows one retry when the provider returned no assistant turn at all and the
 * attempt has no side effects, active lifecycle items, delivery, or terminal
 * assistant/tool state.
 */
export function shouldRetryMissingAssistantTurn(params: {
  payloadCount: number;
  aborted: boolean;
  promptError?: unknown;
  timedOut: boolean;
  attempt: IncompleteTurnAttempt;
}): boolean {
  if (
    params.payloadCount !== 0 ||
    params.aborted ||
    Boolean(params.promptError) ||
    params.timedOut ||
    params.attempt.clientToolCalls ||
    params.attempt.currentAttemptAssistant ||
    params.attempt.lastAssistant ||
    params.attempt.yieldDetected ||
    params.attempt.didSendDeterministicApprovalPrompt ||
    params.attempt.lastToolError
  ) {
    return false;
  }

  if (hasOnlySilentAssistantReply(params.attempt.assistantTexts)) {
    return false;
  }

  if (joinAssistantTexts(params.attempt.assistantTexts).length > 0) {
    return false;
  }

  if (hasCommittedMessagingToolDeliveryEvidence(params.attempt)) {
    return false;
  }

  if (hasAcceptedSessionSpawn(params.attempt.acceptedSessionSpawns)) {
    return false;
  }

  if (hasAsyncActivity(params.attempt.toolMetas)) {
    return false;
  }

  if (
    (params.attempt.itemLifecycle?.startedCount ?? 0) > 0 ||
    (params.attempt.itemLifecycle?.activeCount ?? 0) > 0
  ) {
    return false;
  }

  return !params.attempt.replayMetadata.hadPotentialSideEffects;
}

/** Fields needed to determine whether a yielded turn already delivered or can continue. */
interface YieldContinuationAttempt {
  clientToolCalls?: readonly unknown[];
  didSendDeterministicApprovalPrompt?: boolean;
  successfulCronAdds?: number;
  acceptedSessionSpawns?: readonly { runId: string; childSessionKey: string }[];
  runtimeContinuationStarted?: boolean;
  messagingToolSentTexts?: readonly string[];
  messagingToolSentMediaUrls?: readonly string[];
  messagingToolSentTargets?: readonly MessagingToolSend[];
  toolMetas?: readonly { asyncStarted?: boolean }[];
}

/** Continuation evidence for a yielded turn — sources that will produce future output. */
export function hasYieldContinuationEvidence(attempt: YieldContinuationAttempt): boolean {
  // Only same-attempt evidence is causal here. Session-wide active descendants may be
  // stale or unrelated and must not suppress the diagnostic for this yielded turn.
  return (
    (attempt.clientToolCalls?.length ?? 0) > 0 ||
    attempt.didSendDeterministicApprovalPrompt === true ||
    hasCommittedMessagingToolDeliveryEvidence({
      messagingToolSentTexts: attempt.messagingToolSentTexts ?? [],
      messagingToolSentMediaUrls: attempt.messagingToolSentMediaUrls ?? [],
      messagingToolSentTargets: attempt.messagingToolSentTargets ?? [],
    }) ||
    hasAcceptedSessionSpawn(attempt.acceptedSessionSpawns) ||
    attempt.runtimeContinuationStarted === true ||
    hasAsyncActivity(attempt.toolMetas) ||
    (attempt.successfulCronAdds ?? 0) > 0
  );
}

export const YIELD_DIAGNOSTIC_TEXT =
  "⚠️ Turn yielded without a continuation source. Send a message to resume.";

export const TRUNCATED_REPLY_NOTICE_TEXT =
  "⚠️ Reply truncated at the model's output token limit. The text above is partial — ask to continue it.";

function isToolResultRole(role: string): boolean {
  return role === "toolresult" || role === "tool_result" || role === "tool";
}

function readMessageTextContent(message: AgentMessage): string | undefined {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed || undefined;
  }
  const text = collectTextContentBlocks(content)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .join("\n");
  return text || undefined;
}

function readToolResultAggregatedText(message: AgentMessage): string | undefined {
  const aggregated = (message as { details?: { aggregated?: unknown } }).details?.aggregated;
  if (typeof aggregated !== "string") {
    return undefined;
  }
  const trimmed = aggregated.trim();
  return trimmed || undefined;
}

function hasTrailingSilentToolResult(messages: readonly AgentMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message) {
      continue;
    }
    const role = normalizeLowercaseStringOrEmpty(message?.role);
    if (isToolResultRole(role)) {
      if ((message as { isError?: boolean }).isError === true) {
        return false;
      }
      const text = readMessageTextContent(message) ?? readToolResultAggregatedText(message);
      return isSilentReplyText(text, SILENT_REPLY_TOKEN);
    }
    if (role === "assistant" && !readMessageTextContent(message)) {
      continue;
    }
    return false;
  }
  return false;
}

/** Emits the silent-reply token for cron turns whose last successful tool result is silent. */
export function resolveSilentToolResultReplyPayload(params: {
  isCronTrigger: boolean;
  payloadCount: number;
  aborted: boolean;
  timedOut: boolean;
  attempt: SilentToolResultAttempt;
}): { text: typeof SILENT_REPLY_TOKEN } | null {
  if (
    !params.isCronTrigger ||
    params.payloadCount !== 0 ||
    params.aborted ||
    params.timedOut ||
    (params.attempt.toolMetas?.length ?? 0) === 0 ||
    params.attempt.clientToolCalls ||
    params.attempt.yieldDetected ||
    params.attempt.didSendDeterministicApprovalPrompt ||
    params.attempt.lastToolError ||
    (params.attempt.messagesSnapshot?.length ?? 0) === 0
  ) {
    return null;
  }

  return hasTrailingSilentToolResult(params.attempt.messagesSnapshot)
    ? { text: SILENT_REPLY_TOKEN }
    : null;
}

/**
 * Marks replay invalid whenever the recorded attempt might not be safe to
 * replay or the current run ended in a compaction/incomplete-turn state that
 * needs a fresh prompt boundary.
 */
export function resolveReplayInvalidFlag(params: {
  attempt: RunLivenessAttempt;
  incompleteTurnText?: string | null;
}): boolean {
  const terminal = projectAgentRunAttemptTerminal(params.attempt.terminal);
  return (
    !params.attempt.replayMetadata.replaySafe ||
    terminal.promptErrorSource === "compaction" ||
    terminal.timedOutDuringCompaction ||
    Boolean(params.incompleteTurnText)
  );
}

/** Classifies the persisted run state used by session recovery and resume logic. */
export function resolveRunLivenessState(params: {
  payloadCount: number;
  aborted: boolean;
  timedOut: boolean;
  attempt: RunLivenessAttempt;
  incompleteTurnText?: string | null;
}): EmbeddedRunLivenessState {
  if (params.incompleteTurnText) {
    return "abandoned";
  }
  const terminal = projectAgentRunAttemptTerminal(params.attempt.terminal);
  if (terminal.promptErrorSource === "compaction" || terminal.timedOutDuringCompaction) {
    return "paused";
  }
  if ((params.aborted || params.timedOut) && params.payloadCount === 0) {
    return "blocked";
  }
  if (params.attempt.lastAssistant?.stopReason === "error") {
    return "blocked";
  }
  return "working";
}
