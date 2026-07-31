/**
 * Classifies incomplete terminal assistant turns and retry instructions.
 */
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  isSilentReplyPayloadText,
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
} from "../../../auto-reply/tokens.js";
import { hasAcceptedSessionSpawn } from "../../accepted-session-spawn.js";
import { projectAgentRunAttemptTerminal } from "../../agent-run-terminal-outcome.js";
import { collectTextContentBlocks } from "../../content-blocks.js";
import type { MessagingToolSend } from "../../embedded-agent-messaging.types.js";
import {
  isStrictAgenticSupportedProviderModel,
  stripProviderPrefix,
} from "../../execution-contract.js";
import { hasOnlyAssistantReasoningContent } from "../../replay-turn-classification.js";
import type { AgentMessage } from "../../runtime/index.js";
import { type FileTarget, isSameFileTarget } from "../../tool-mutation.js";
import {
  hasCommittedMessagingToolDeliveryEvidence,
  hasMessagingToolDeliveryEvidence,
} from "../delivery-evidence.js";
import { isZeroUsageEmptyStopAssistantTurn } from "../empty-assistant-turn.js";
import { assessLastAssistantMessage } from "../thinking.js";
import type { EmbeddedRunLivenessState } from "../types.js";
import type { CodeModeMutationVerificationState } from "./terminal-retry-state.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

type ReplayMetadataAttempt = Pick<
  EmbeddedRunAttemptResult,
  | "toolMetas"
  | "didSendViaMessagingTool"
  | "messagingToolSentTexts"
  | "messagingToolSentMediaUrls"
  | "successfulCronAdds"
> &
  Partial<Pick<EmbeddedRunAttemptResult, "messagingToolSentTargets" | "acceptedSessionSpawns">>;

type IncompleteTurnAttempt = Pick<
  EmbeddedRunAttemptResult,
  | "assistantTexts"
  | "clientToolCalls"
  | "codeModeEngaged"
  | "currentAttemptAssistant"
  | "yieldDetected"
  | "didSendDeterministicApprovalPrompt"
  | "heartbeatToolResponse"
  | "toolMediaUrls"
  | "toolAudioAsVoice"
  | "toolTrustedLocalMedia"
  | "hasToolMediaBlockReply"
  | "didDeliverSourceReplyViaMessageTool"
  | "messagingToolSourceReplyPayloads"
  | "didSendViaMessagingTool"
  | "messagingToolSentTexts"
  | "messagingToolSentMediaUrls"
  | "messagingToolSentTargets"
  | "lastToolError"
  | "lastAssistant"
  | "itemLifecycle"
  | "messagesSnapshot"
  | "replayMetadata"
  | "terminal"
  | "toolMetas"
> &
  Partial<Pick<EmbeddedRunAttemptResult, "acceptedSessionSpawns">>;

function hasPositiveOutputTokenUsage(message: AgentMessage | null): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const usage = (message as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") {
    return false;
  }
  const output = asFiniteNumber((usage as { output?: unknown }).output);
  return output !== undefined && output > 0;
}

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

const REPLAY_UNSAFE_FALLBACK_METADATA: EmbeddedRunAttemptResult["replayMetadata"] = {
  hadPotentialSideEffects: true,
  replaySafe: false,
};

export function isIncompleteTerminalAssistantTurn(params: {
  hasAssistantVisibleText: boolean;
  hasTerminalOutput?: boolean;
  lastAssistant?: { stopReason?: string } | null;
}): boolean {
  const stopReason = params.lastAssistant?.stopReason;
  // Tool-use expects a post-tool continuation; length means the output budget
  // ended before a complete final answer. Partial visible text completes neither.
  return stopReason === "toolUse" || (stopReason === "length" && !params.hasTerminalOutput);
}

const GEMINI_INCOMPLETE_TURN_PROVIDER_IDS = new Set([
  "google",
  "google-vertex",
  "google-antigravity",
  "google-gemini-cli",
]);
const GEMINI_INCOMPLETE_TURN_MODEL_ID_PATTERN = /^gemini(?:[.-]|$)/;
// Ollama native `/api/chat` can finish with only thinking/internal blocks when constrained.
const OLLAMA_INCOMPLETE_TURN_PROVIDER_ID_PATTERN = /^ollama(?:-|$)/;
// Model APIs eligible for the non-visible turn retry guard.  OpenAI Responses
// family can produce reasoning-only turns where usage.output > 0 but no visible
// text is emitted; without the guard these pass through as successful. (#85364)
const RETRY_GUARD_MODEL_APIS = new Set([
  "openai-completions",
  "anthropic-messages",
  "bedrock-converse-stream",
  "openai-responses",
  "openai-chatgpt-responses",
  "azure-openai-responses",
  "openclaw-openai-responses-transport",
  "openclaw-openai-chatgpt-responses-transport",
  "openclaw-azure-openai-responses-transport",
]);
// Allow one immediate continuation plus one follow-up continuation before
// surfacing the existing incomplete-turn error path.
export const DEFAULT_REASONING_ONLY_RETRY_LIMIT = 2;
export const DEFAULT_EMPTY_RESPONSE_RETRY_LIMIT = 1;
const REASONING_ONLY_RETRY_INSTRUCTION =
  "The previous assistant turn recorded reasoning but did not produce a user-visible answer. Continue from that partial turn and produce the visible answer now. Do not restate the reasoning or restart from scratch.";
const EMPTY_RESPONSE_RETRY_INSTRUCTION =
  "The previous attempt did not produce a user-visible answer. Continue from the current state and produce the visible answer now. Do not restart from scratch.";
const REPLAY_SAFE_CODE_MODE_ERROR_RETRY_INSTRUCTION =
  "The prior Code Mode exec failed without side effects. Inspect the prior error and tool output, then retry with changed code using injected global tools only. If text parsing failed, inspect raw `.content` instead of assuming JSON or quoted values. Do not use import, require, process, fs, or absolute workspace paths.";
const SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION =
  "The previous assistant turn completed its tool calls but did not produce a user-visible answer. Continue from the current transcript and produce the final user-visible answer now. Do not repeat completed tool calls or restart from scratch.";
export const RESTART_SAFE_CODE_MODE_CONTINUATION_INSTRUCTION =
  "The previous Code Mode step completed mutations but stopped before verification. Continue from the transcript using only the available read-only tools. Do not repeat completed mutations. Verify the result, then follow the user's exact requested output format with no extra label or markdown.";
const VERIFY_CODE_MODE_MUTATION_CONTINUATION_INSTRUCTION =
  "The previous Code Mode step completed file mutations but stopped before verification. Continue from the transcript using only the available read-only tools. Do not repeat completed mutations. Verify the changed files. If the user's requested work is incomplete, stop after verification so the next continuation can restore normal tools. Otherwise, follow the user's exact requested output format with no extra label or markdown.";
const VERIFIED_CODE_MODE_MUTATION_CONTINUATION_INSTRUCTION =
  "The previous Code Mode step completed and verified file mutations but stopped before the task was complete. Continue from the transcript with tools. Do not repeat completed mutations. Finish only the remaining work, verify any new mutations, and follow the user's exact requested output format with no extra label or markdown.";
const NORMAL_CODE_MODE_CONTINUATION_INSTRUCTION =
  "The previous Code Mode step was read-only and stopped before the task was complete. Continue from the transcript with tools, use the actual prior output shape, and finish the remaining steps. Follow the user's exact requested output format with no extra label or markdown.";

/**
 * Marks whether retrying the attempt can safely replay the prompt. Concrete
 * tool-instance policy, async work, committed delivery, spawned sessions, and
 * cron writes all contribute side-effect evidence.
 */
export function buildAttemptReplayMetadata(
  params: ReplayMetadataAttempt,
): EmbeddedRunAttemptResult["replayMetadata"] {
  const hadUnsafeTools = params.toolMetas.some((entry) => entry.replaySafe !== true);
  const hadKnownSideEffects = params.toolMetas.some((entry) => entry.sideEffectFree === false);
  const hadAsyncStartedTool = params.toolMetas.some((t) => t.asyncStarted === true);
  const hadPotentialSideEffects =
    hadUnsafeTools ||
    hadKnownSideEffects ||
    hadAsyncStartedTool ||
    hasMessagingToolDeliveryEvidence(params) ||
    hasAcceptedSessionSpawn(params.acceptedSessionSpawns) ||
    (params.successfulCronAdds ?? 0) > 0;
  return {
    hadPotentialSideEffects,
    replaySafe: !hadPotentialSideEffects,
  };
}

/** Falls back to replay-unsafe metadata when older attempt records lack replay details. */
export function resolveAttemptReplayMetadata(attempt: {
  replayMetadata?: EmbeddedRunAttemptResult["replayMetadata"] | null;
}): EmbeddedRunAttemptResult["replayMetadata"] {
  return attempt.replayMetadata ?? REPLAY_UNSAFE_FALLBACK_METADATA;
}

type CodeModeContinuationToolPolicy = "normal" | "read-only";

/** Selects the bounded tool policy for an unfinished settled Code Mode turn. */
export function resolveCodeModeContinuationToolPolicy(attempt: {
  codeModeEngaged?: boolean;
  replayMetadata?: EmbeddedRunAttemptResult["replayMetadata"] | null;
}): CodeModeContinuationToolPolicy | null {
  if (attempt.codeModeEngaged !== true) {
    return null;
  }
  return resolveAttemptReplayMetadata(attempt).hadPotentialSideEffects ? "read-only" : "normal";
}

/** Reports whether current Code Mode telemetry proves targetless side effects were absent or seen. */
export function resolveCodeModeTargetlessSideEffectEvidence(attempt: {
  codeModeEngaged?: boolean;
  toolMetas?: ReadonlyArray<{
    toolName?: string;
    replaySafe?: boolean;
    mutatingAction?: boolean;
    fileTarget?: FileTarget;
    fileTargets?: FileTarget[];
    fileMutationExecutionStarted?: true;
    sideEffectFree?: boolean;
    asyncStarted?: boolean;
    codeModeHadTargetlessSideEffects?: boolean;
  }>;
}): boolean | null {
  if (attempt.codeModeEngaged !== true) {
    return null;
  }
  let coveredPotentialSideEffect = false;
  for (const tool of attempt.toolMetas ?? []) {
    if (tool.codeModeHadTargetlessSideEffects === true) {
      return true;
    }
    const potentiallySideEffecting =
      tool.replaySafe !== true || tool.sideEffectFree === false || tool.asyncStarted === true;
    if (!potentiallySideEffecting) {
      continue;
    }
    const trackedNativeFileMutation =
      tool.fileMutationExecutionStarted === true &&
      tool.mutatingAction === true &&
      (tool.toolName === "write" || tool.toolName === "edit" || tool.toolName === "apply_patch") &&
      (tool.fileTarget !== undefined || (tool.fileTargets?.length ?? 0) > 0);
    if (trackedNativeFileMutation) {
      // This flag is emitted only for started core-owned workspace mutations.
      // Their tracked targets prove the call did not mutate an unrelated surface.
      coveredPotentialSideEffect = true;
      continue;
    }
    if (tool.codeModeHadTargetlessSideEffects !== false) {
      return null;
    }
    coveredPotentialSideEffect = true;
  }
  return coveredPotentialSideEffect ? false : null;
}

/** Keeps confirmed or unresolved targetless effects read-only for the rest of the run. */
export function shouldLatchCodeModeReadOnlyForRun(params: {
  mutationVerificationRequired: boolean;
  targetlessSideEffectEvidence: boolean | null;
}): boolean {
  return (
    params.targetlessSideEffectEvidence === true ||
    (params.mutationVerificationRequired && params.targetlessSideEffectEvidence === null)
  );
}

/** Selects continuation wording without losing whether the prior attempt mutated files. */
export function resolveCodeModeContinuationInstruction(params: {
  mutationVerificationRequired: boolean;
  targetlessSideEffectEvidence: boolean | null;
  toolPolicy: CodeModeContinuationToolPolicy;
}): string {
  if (params.mutationVerificationRequired) {
    return VERIFY_CODE_MODE_MUTATION_CONTINUATION_INSTRUCTION;
  }
  if (params.targetlessSideEffectEvidence === false) {
    return VERIFIED_CODE_MODE_MUTATION_CONTINUATION_INSTRUCTION;
  }
  return params.toolPolicy === "read-only"
    ? RESTART_SAFE_CODE_MODE_CONTINUATION_INSTRUCTION
    : NORMAL_CODE_MODE_CONTINUATION_INSTRUCTION;
}

/**
 * Detects a completed Code Mode mutation that ended without a later
 * side-effect-free observation. Failed follow-up execs do not erase the need
 * for verification, and the continuation is host-restricted to read-only tools.
 */
export function resolveCodeModeMutationVerificationState(
  attempt: {
    codeModeEngaged?: boolean;
    toolMetas?: ReadonlyArray<{
      toolName?: string;
      isError?: boolean;
      mutatingAction?: boolean;
      fileTarget?: FileTarget;
      fileTargets?: FileTarget[];
      fileMutationExecutionStarted?: true;
      fileTargetVerified?: true;
      fileTargetAbsent?: true;
      sideEffectFree?: boolean;
      codeModeLastCallSideEffectFree?: boolean;
      codeModeHadTargetlessSideEffects?: boolean;
      codeModeSuccessfulObservationFileTargets?: FileTarget[];
      codeModeSuccessfulAbsenceObservationFileTargets?: FileTarget[];
      codeModeUnverifiedMutationFileTargets?: FileTarget[];
    }>;
  },
  initial: CodeModeMutationVerificationState = {
    pendingTargets: [],
  },
  cwd?: string,
): CodeModeMutationVerificationState {
  let pendingTargets = [...initial.pendingTargets];
  const codeModeEngaged = attempt.codeModeEngaged === true;
  const sameFileTarget = (a: FileTarget, b: FileTarget) =>
    isSameFileTarget(a, b, process.platform, cwd);
  const addPendingTarget = (target: FileTarget) => {
    const existingIndex = pendingTargets.findIndex((candidate) =>
      sameFileTarget(candidate, target),
    );
    if (existingIndex >= 0) {
      pendingTargets[existingIndex] = target;
    } else {
      pendingTargets.push(target);
    }
  };
  const addMutationEvidence = (
    targets: readonly FileTarget[] | undefined,
    fallbackTarget?: FileTarget,
    uncertain = false,
  ) => {
    if (targets !== undefined) {
      for (const target of targets) {
        addPendingTarget(uncertain ? { ...target, expected: "unknown" } : target);
      }
      return;
    }
    if (fallbackTarget) {
      addPendingTarget(uncertain ? { ...fallbackTarget, expected: "unknown" } : fallbackTarget);
    }
  };
  const applySuccessfulMutationEvidence = (
    targets: readonly FileTarget[] | undefined,
    fallbackTarget?: FileTarget,
  ) => {
    if (targets === undefined) {
      if (fallbackTarget) {
        addPendingTarget(fallbackTarget);
      }
      return;
    }
    for (const target of targets) {
      if (target.expected === "absent") {
        // A successful patch deletion is authoritative final-state evidence.
        // Clear stale present/unknown expectations instead of requiring a read.
        pendingTargets = pendingTargets.filter((candidate) => !sameFileTarget(candidate, target));
      } else {
        addPendingTarget(target);
      }
    }
  };
  const clearVerifiedTarget = (target: FileTarget | undefined, expected: "present" | "absent") => {
    if (!target) {
      return;
    }
    pendingTargets = pendingTargets.filter((candidate) => {
      const targetExpectation = candidate.expected ?? "present";
      return !(
        sameFileTarget(candidate, target) &&
        (targetExpectation === expected || targetExpectation === "unknown")
      );
    });
  };
  for (const tool of attempt.toolMetas ?? []) {
    const toolName = normalizeLowercaseStringOrEmpty(tool.toolName);
    if (toolName === "read" && tool.mutatingAction !== true) {
      if (tool.isError !== true && tool.fileTargetVerified === true) {
        clearVerifiedTarget(tool.fileTarget, "present");
        continue;
      }
      if (tool.isError === true && tool.fileTargetAbsent === true) {
        clearVerifiedTarget(tool.fileTarget, "absent");
        continue;
      }
    }
    if ((toolName === "exec" || toolName === "wait") && codeModeEngaged && tool.isError !== true) {
      for (const target of tool.codeModeSuccessfulObservationFileTargets ?? []) {
        clearVerifiedTarget(target, "present");
      }
      for (const target of tool.codeModeSuccessfulAbsenceObservationFileTargets ?? []) {
        clearVerifiedTarget(target, "absent");
      }
    }
    if (tool.isError === true) {
      if (!codeModeEngaged) {
        continue;
      }
      if (
        (toolName === "write" || toolName === "edit" || toolName === "apply_patch") &&
        tool.mutatingAction === true &&
        tool.fileMutationExecutionStarted === true
      ) {
        addMutationEvidence(tool.fileTargets, tool.fileTarget, true);
      } else if ((toolName === "exec" || toolName === "wait") && tool.sideEffectFree !== true) {
        addMutationEvidence(tool.codeModeUnverifiedMutationFileTargets, undefined, true);
      }
      continue;
    }
    if (!codeModeEngaged) {
      continue;
    }
    if (
      (toolName === "write" || toolName === "edit" || toolName === "apply_patch") &&
      tool.mutatingAction === true &&
      tool.fileMutationExecutionStarted === true
    ) {
      applySuccessfulMutationEvidence(tool.fileTargets, tool.fileTarget);
      continue;
    }
    if ((toolName === "exec" || toolName === "wait") && tool.sideEffectFree === false) {
      // The bridge snapshot is the final state for the whole cell. Add it
      // after historical observations so an observation-before-write cannot
      // incorrectly verify the later mutation.
      addMutationEvidence(tool.codeModeUnverifiedMutationFileTargets);
    }
  }
  return { pendingTargets };
}

type TerminalAttemptState = Pick<
  EmbeddedRunAttemptResult,
  | "clientToolCalls"
  | "yieldDetected"
  | "didSendDeterministicApprovalPrompt"
  | "heartbeatToolResponse"
  | "lastToolError"
  | "toolMediaUrls"
  | "toolAudioAsVoice"
  | "toolTrustedLocalMedia"
  | "hasToolMediaBlockReply"
  | "didDeliverSourceReplyViaMessageTool"
  | "messagingToolSourceReplyPayloads"
  | "successfulCronAdds"
> &
  Partial<
    Pick<
      EmbeddedRunAttemptResult,
      | "acceptedSessionSpawns"
      | "messagingToolSentTexts"
      | "messagingToolSentMediaUrls"
      | "messagingToolSentTargets"
    >
  > & {
    toolMetas?: readonly { asyncStarted?: boolean }[];
  };

export function hasAttemptTerminalState(attempt: TerminalAttemptState): boolean {
  return Boolean(
    attempt.clientToolCalls ||
    attempt.yieldDetected ||
    attempt.didSendDeterministicApprovalPrompt ||
    attempt.heartbeatToolResponse ||
    attempt.lastToolError ||
    attempt.toolMediaUrls?.some((url) => url.trim().length > 0) ||
    attempt.toolAudioAsVoice ||
    attempt.toolTrustedLocalMedia ||
    attempt.hasToolMediaBlockReply ||
    attempt.didDeliverSourceReplyViaMessageTool ||
    attempt.messagingToolSourceReplyPayloads?.length ||
    hasCommittedMessagingToolDeliveryEvidence({
      messagingToolSentTexts: attempt.messagingToolSentTexts ?? [],
      messagingToolSentMediaUrls: attempt.messagingToolSentMediaUrls ?? [],
      messagingToolSentTargets: attempt.messagingToolSentTargets ?? [],
    }) ||
    hasAcceptedSessionSpawn(attempt.acceptedSessionSpawns) ||
    hasAsyncStartedToolActivity(attempt.toolMetas) ||
    (attempt.successfulCronAdds ?? 0) > 0,
  );
}

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
  attempt: IncompleteTurnAttempt;
}): string | null {
  // Prefer the current attempt's terminal message. The session fallback can
  // still point at the pre-tool turn after a post-tool answer completes. (#80918)
  const assistant = params.attempt.currentAttemptAssistant ?? params.attempt.lastAssistant;
  const hasTerminalOutput = hasAttemptTerminalState(params.attempt);
  // Tool-use expects a post-tool continuation, while length means the output
  // budget ended. Partial visible text completes neither. (#76477)
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
    !joinAssistantTexts(params.attempt.assistantTexts).length &&
    !hasTerminalOutput &&
    Boolean(assistant && hasOnlyAssistantReasoningContent(assistant));

  if (
    (params.payloadCount !== 0 && !incompleteTerminalAssistant && !thinkingOnlyTerminal) ||
    (params.aborted && params.externalAbort) ||
    params.timedOut ||
    params.attempt.clientToolCalls ||
    params.attempt.yieldDetected ||
    params.attempt.didSendDeterministicApprovalPrompt ||
    params.attempt.lastToolError
  ) {
    return null;
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

  if (hasAsyncStartedToolActivity(params.attempt.toolMetas)) {
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

  return params.hadPotentialSideEffects ||
    resolveAttemptReplayMetadata(params.attempt).hadPotentialSideEffects
    ? "⚠️ Agent couldn't generate a response. Note: some tool actions may have already been executed — please verify before retrying."
    : "⚠️ Agent couldn't generate a response. Please try again.";
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

  if (hasAsyncStartedToolActivity(params.attempt.toolMetas)) {
    return false;
  }

  if (
    (params.attempt.itemLifecycle?.startedCount ?? 0) > 0 ||
    (params.attempt.itemLifecycle?.activeCount ?? 0) > 0
  ) {
    return false;
  }

  return !resolveAttemptReplayMetadata(params.attempt).hadPotentialSideEffects;
}

function joinAssistantTexts(assistantTexts?: readonly string[]): string {
  return (assistantTexts ?? []).join("\n\n").trim();
}

function hasOnlySilentAssistantReply(assistantTexts?: readonly string[]): boolean {
  const nonEmptyTexts = (assistantTexts ?? []).filter((text) => text.trim().length > 0);
  return (
    nonEmptyTexts.length > 0 &&
    nonEmptyTexts.every((text) => isSilentReplyPayloadText(text, SILENT_REPLY_TOKEN))
  );
}

function hasAsyncStartedToolActivity(toolMetas?: readonly { asyncStarted?: boolean }[]): boolean {
  return (toolMetas ?? []).some((entry) => entry.asyncStarted === true);
}

/** Fields needed to determine whether a yielded turn already delivered or can continue. */
interface YieldContinuationAttempt {
  clientToolCalls?: readonly unknown[];
  didSendDeterministicApprovalPrompt?: boolean;
  successfulCronAdds?: number;
  acceptedSessionSpawns?: readonly { runId: string; childSessionKey: string }[];
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
    hasAsyncStartedToolActivity(attempt.toolMetas) ||
    (attempt.successfulCronAdds ?? 0) > 0
  );
}

export const YIELD_DIAGNOSTIC_TEXT =
  "⚠️ Turn yielded without a continuation source. Send a message to resume.";

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
    !resolveAttemptReplayMetadata(params.attempt).replaySafe ||
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

function isReasoningOnlyAssistantTurn(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  return assessLastAssistantMessage(message as AgentMessage) === "incomplete-text";
}

// Unsigned thinking blocks have no cryptographic signature; assessLastAssistantMessage
// returns "incomplete-thinking" for them. Empty content also returns "incomplete-thinking",
// so the content.length > 0 guard is required to distinguish the two cases.
function isUnsignedThinkingOnlyAssistantTurn(message: unknown): boolean {
  if (message == null || typeof message !== "object") {
    return false;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) {
    return false;
  }
  return assessLastAssistantMessage(message as AgentMessage) === "incomplete-thinking";
}

export function shouldRetrySilentErrorAssistantTurn(params: {
  attempt: Pick<
    EmbeddedRunAttemptResult,
    | "assistantTexts"
    | "clientToolCalls"
    | "yieldDetected"
    | "didSendDeterministicApprovalPrompt"
    | "heartbeatToolResponse"
    | "lastToolError"
    | "toolMediaUrls"
    | "toolAudioAsVoice"
    | "toolTrustedLocalMedia"
    | "didDeliverSourceReplyViaMessageTool"
    | "messagingToolSourceReplyPayloads"
    | "replayMetadata"
    | "currentAttemptReplayMetadata"
  >;
  assistant: EmbeddedRunAttemptResult["lastAssistant"] | null | undefined;
}): boolean {
  if (joinAssistantTexts(params.attempt.assistantTexts).length > 0) {
    return false;
  }
  if (hasAttemptTerminalState(params.attempt)) {
    return false;
  }
  // Current-attempt evidence avoids blocking on prior committed effects; older
  // harnesses retain the cumulative, fail-closed behavior.
  const retryReplayMetadata = resolveAttemptReplayMetadata({
    replayMetadata: params.attempt.currentAttemptReplayMetadata ?? params.attempt.replayMetadata,
  });
  if (retryReplayMetadata.hadPotentialSideEffects) {
    return false;
  }

  const assistant = params.assistant;
  if (!assistant || assistant.stopReason !== "error") {
    return false;
  }

  const content = (assistant as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return false;
  }
  if (content.length === 0) {
    return !hasPositiveOutputTokenUsage(assistant);
  }

  return hasOnlyAssistantReasoningContent(assistant);
}

function isEmptyResponseAssistantTurn(params: {
  payloadCount: number;
  attempt: Pick<
    IncompleteTurnAttempt,
    "assistantTexts" | "currentAttemptAssistant" | "lastAssistant"
  >;
}): boolean {
  if (params.payloadCount !== 0) {
    return false;
  }
  if (joinAssistantTexts(params.attempt.assistantTexts).length > 0) {
    return false;
  }
  const assistant = params.attempt.currentAttemptAssistant ?? params.attempt.lastAssistant;
  if (!assistant) {
    return true;
  }
  if (assistant.stopReason === "error") {
    return false;
  }
  if (
    isIncompleteTerminalAssistantTurn({
      hasAssistantVisibleText: false,
      lastAssistant: assistant,
    }) ||
    isReasoningOnlyAssistantTurn(assistant)
  ) {
    return false;
  }
  return true;
}

function isNonVisibleAssistantTurnEligibleForSilentReply(params: {
  payloadCount: number;
  attempt: Pick<
    IncompleteTurnAttempt,
    "assistantTexts" | "currentAttemptAssistant" | "lastAssistant"
  >;
}): boolean {
  if (isEmptyResponseAssistantTurn(params)) {
    return true;
  }
  if (params.payloadCount !== 0) {
    return false;
  }
  if (joinAssistantTexts(params.attempt.assistantTexts).length > 0) {
    return false;
  }
  const assistant = params.attempt.currentAttemptAssistant ?? params.attempt.lastAssistant;
  if (!assistant || assistant.stopReason === "error") {
    return false;
  }
  if (
    isIncompleteTerminalAssistantTurn({
      hasAssistantVisibleText: false,
      lastAssistant: assistant,
    })
  ) {
    return false;
  }
  return isReasoningOnlyAssistantTurn(assistant);
}

function shouldSkipNonVisibleTurnRetry(params: {
  aborted: boolean;
  timedOut: boolean;
  attempt: IncompleteTurnAttempt;
  /** Reply-optional silent classification tolerates committed side effects; retries never can. */
  tolerateSideEffects?: boolean;
}): boolean {
  return Boolean(
    params.aborted ||
    params.timedOut ||
    params.attempt.clientToolCalls ||
    params.attempt.yieldDetected ||
    params.attempt.didSendDeterministicApprovalPrompt ||
    params.attempt.lastToolError ||
    hasAcceptedSessionSpawn(params.attempt.acceptedSessionSpawns) ||
    (params.tolerateSideEffects !== true &&
      resolveAttemptReplayMetadata(params.attempt).hadPotentialSideEffects),
  );
}

/** Allows configured silent handling for replay-safe empty, reasoning-only, or explicit silent turns. */
export function shouldTreatEmptyAssistantReplyAsSilent(params: {
  allowEmptyAssistantReplyAsSilent?: boolean;
  onlyExplicitSilentReply?: boolean;
  terminalReplyExpectation?: "required" | "optional";
  payloadCount: number;
  aborted: boolean;
  timedOut: boolean;
  attempt: IncompleteTurnAttempt;
}): boolean {
  // "optional" is the run consumer's declaration that no user-facing reply is
  // owed (e.g. cron without a delivery route). Silence after side-effecting
  // tools is intentional there; retry is replay-unsafe, so erroring would mark
  // successful tool-only runs as failures.
  const terminalReplyOptional = params.terminalReplyExpectation === "optional";
  if (
    !params.allowEmptyAssistantReplyAsSilent ||
    shouldSkipNonVisibleTurnRetry({ ...params, tolerateSideEffects: terminalReplyOptional })
  ) {
    return false;
  }
  if (hasCommittedMessagingToolDeliveryEvidence(params.attempt)) {
    return false;
  }
  const assistant = params.attempt.currentAttemptAssistant ?? params.attempt.lastAssistant;
  if (
    params.payloadCount === 0 &&
    assistant?.stopReason !== "error" &&
    hasOnlySilentAssistantReply(params.attempt.assistantTexts)
  ) {
    return true;
  }
  if (params.onlyExplicitSilentReply) {
    return false;
  }
  // Post-tool empty stops are ambiguous provider failures when a reply is still
  // expected; reply-optional runs settle their work in the tools themselves.
  if (
    !terminalReplyOptional &&
    params.attempt.toolMetas.length > 0 &&
    isEmptyResponseAssistantTurn({
      payloadCount: params.payloadCount,
      attempt: params.attempt,
    })
  ) {
    return false;
  }
  return isNonVisibleAssistantTurnEligibleForSilentReply({
    payloadCount: params.payloadCount,
    attempt: params.attempt,
  });
}

/**
 * Builds the retry instruction for reasoning-only turns that consumed provider
 * output budget but produced no visible assistant text.
 */
export function resolveReasoningOnlyRetryInstruction(params: {
  provider?: string;
  modelId?: string;
  modelApi?: string;
  executionContract?: string;
  aborted: boolean;
  timedOut: boolean;
  attempt: IncompleteTurnAttempt;
}): string | null {
  if (shouldSkipNonVisibleTurnRetry(params)) {
    return null;
  }

  if (
    !shouldApplyNonVisibleTurnRetryGuard({
      provider: params.provider,
      modelId: params.modelId,
      modelApi: params.modelApi,
      executionContract: params.executionContract,
    })
  ) {
    return null;
  }

  const assistant = params.attempt.currentAttemptAssistant ?? params.attempt.lastAssistant;
  if (joinAssistantTexts(params.attempt.assistantTexts).length > 0) {
    return null;
  }
  if (assistant?.stopReason === "error") {
    return null;
  }
  if (!isReasoningOnlyAssistantTurn(assistant) && !isUnsignedThinkingOnlyAssistantTurn(assistant)) {
    return null;
  }

  return REASONING_ONLY_RETRY_INSTRUCTION;
}

/** Builds one fresh continuation after settled tools ended without a visible final answer. */
export function resolveSettledToolTerminalContinuationInstruction(params: {
  provider?: string;
  modelId?: string;
  modelApi?: string;
  executionContract?: string;
  allowEmptyStopContinuation?: boolean;
  allowCodeModeContinuation?: boolean;
  requireCodeModeMutationVerification?: boolean;
  payloadCount: number;
  hasTerminalToolPresentation?: boolean;
  aborted: boolean;
  promptError?: unknown;
  timedOut: boolean;
  attempt: IncompleteTurnAttempt;
}): string | null {
  const assistant = params.attempt.currentAttemptAssistant ?? params.attempt.lastAssistant;
  const currentAttemptAssistant = params.attempt.currentAttemptAssistant;
  if (params.requireCodeModeMutationVerification === true) {
    if (
      params.hasTerminalToolPresentation ||
      params.aborted ||
      params.promptError != null ||
      params.timedOut ||
      params.attempt.itemLifecycle.activeCount > 0 ||
      params.attempt.clientToolCalls ||
      params.attempt.yieldDetected ||
      params.attempt.didSendDeterministicApprovalPrompt ||
      hasMessagingToolDeliveryEvidence(params.attempt) ||
      hasAcceptedSessionSpawn(params.attempt.acceptedSessionSpawns) ||
      hasAsyncStartedToolActivity(params.attempt.toolMetas)
    ) {
      return null;
    }
    return SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION;
  }
  const emptyStopAfterSettledTools = Boolean(
    params.allowEmptyStopContinuation &&
    currentAttemptAssistant?.stopReason === "stop" &&
    params.attempt.toolMetas.length > 0 &&
    params.attempt.toolMetas.every((tool) => tool.isError !== true && tool.asyncStarted !== true) &&
    params.attempt.itemLifecycle.startedCount > 0 &&
    params.attempt.itemLifecycle.completedCount === params.attempt.itemLifecycle.startedCount &&
    params.attempt.itemLifecycle.activeCount === 0 &&
    !hasAcceptedSessionSpawn(params.attempt.acceptedSessionSpawns) &&
    isEmptyResponseAssistantTurn({
      payloadCount: params.payloadCount,
      attempt: params.attempt,
    }),
  );
  // Idle is not proof of completion: a toolUse terminal whose requested tools never
  // (or only partially) dispatched must keep the incomplete-turn error, or the model
  // could claim skipped side effects succeeded. Lifecycle counts are attempt-cumulative
  // and alias across batches, so completion is proven per tool-call id: every toolCall
  // in the terminal assistant needs a non-error toolResult in the message snapshot.
  const requestedToolCallIds = Array.isArray(assistant?.content)
    ? assistant.content.flatMap((item) => {
        const block = item as { type?: unknown; id?: unknown } | null;
        return block?.type === "toolCall" ? [typeof block.id === "string" ? block.id : null] : [];
      })
    : [];
  // Scan only results AFTER the terminal assistant: the snapshot spans the whole
  // session, and a prior turn's toolResult with a model-reused id would otherwise
  // prove "completion" for a batch that never dispatched. Assistant not found in
  // the snapshot fails closed to the existing incomplete-turn error.
  const snapshot = params.attempt.messagesSnapshot ?? [];
  const assistantIndex = assistant ? snapshot.indexOf(assistant) : -1;
  const completedToolCallIds = new Set(
    (assistantIndex >= 0 ? snapshot.slice(assistantIndex + 1) : []).flatMap((message) => {
      const result = message as { role?: unknown; toolCallId?: unknown; isError?: unknown };
      return result.role === "toolResult" &&
        result.isError !== true &&
        typeof result.toolCallId === "string"
        ? [result.toolCallId]
        : [];
    }),
  );
  const allToolsProvenComplete =
    params.attempt.itemLifecycle?.activeCount === 0 &&
    requestedToolCallIds.length > 0 &&
    requestedToolCallIds.every((id) => id !== null && completedToolCallIds.has(id));
  if (
    params.payloadCount !== 0 ||
    params.hasTerminalToolPresentation ||
    params.aborted ||
    params.promptError != null ||
    params.timedOut ||
    (assistant?.stopReason === "toolUse" ? !allToolsProvenComplete : !emptyStopAfterSettledTools) ||
    params.attempt.lastToolError ||
    params.attempt.clientToolCalls ||
    params.attempt.yieldDetected ||
    params.attempt.didSendDeterministicApprovalPrompt
  ) {
    return null;
  }
  if (hasMessagingToolDeliveryEvidence(params.attempt)) {
    return null;
  }
  if (
    params.allowCodeModeContinuation !== true &&
    !shouldApplyNonVisibleTurnRetryGuard({
      provider: params.provider,
      modelId: params.modelId,
      modelApi: params.modelApi,
      executionContract: params.executionContract,
    })
  ) {
    return null;
  }
  return SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION;
}

/**
 * Builds the retry instruction for empty assistant turns when the provider/model
 * is eligible for non-visible turn recovery.
 */
export function resolveEmptyResponseRetryInstruction(params: {
  provider?: string;
  modelId?: string;
  modelApi?: string;
  executionContract?: string;
  payloadCount: number;
  aborted: boolean;
  timedOut: boolean;
  attempt: IncompleteTurnAttempt;
}): string | null {
  const codeModeErrorInstruction = resolveReplaySafeCodeModeErrorRetryInstruction(params);
  if (codeModeErrorInstruction) {
    return codeModeErrorInstruction;
  }
  if (shouldSkipNonVisibleTurnRetry(params)) {
    return null;
  }

  if (
    !isEmptyResponseAssistantTurn({
      payloadCount: params.payloadCount,
      attempt: params.attempt,
    })
  ) {
    return null;
  }

  const assistant = params.attempt.currentAttemptAssistant ?? params.attempt.lastAssistant ?? null;
  if (
    assistant?.stopReason === "stop" &&
    OLLAMA_INCOMPLETE_TURN_PROVIDER_ID_PATTERN.test(
      normalizeLowercaseStringOrEmpty(params.provider ?? ""),
    ) &&
    !hasPositiveOutputTokenUsage(assistant)
  ) {
    return null;
  }

  if (
    shouldApplyNonVisibleTurnRetryGuard({
      provider: params.provider,
      modelId: params.modelId,
      modelApi: params.modelApi,
      executionContract: params.executionContract,
    }) ||
    // Keep the generic zero-usage stop retry for providers that expose a
    // provider-neutral "nothing was generated" signal, even outside the
    // provider allowlist above.
    isZeroUsageEmptyStopAssistantTurn(assistant)
  ) {
    return EMPTY_RESPONSE_RETRY_INSTRUCTION;
  }

  return null;
}

/** Builds one correction turn after an exact side-effect-free Code Mode failure. */
export function resolveReplaySafeCodeModeErrorRetryInstruction(params: {
  payloadCount: number;
  aborted: boolean;
  timedOut: boolean;
  attempt: IncompleteTurnAttempt;
}): string | null {
  if (!isReplaySafeCodeModeToolError(params)) {
    return null;
  }
  if (joinAssistantTexts(params.attempt.assistantTexts).length > 0) {
    return REPLAY_SAFE_CODE_MODE_ERROR_RETRY_INSTRUCTION;
  }
  const assistant = params.attempt.currentAttemptAssistant ?? params.attempt.lastAssistant;
  if (assistant?.stopReason === "toolUse") {
    const lifecycle = params.attempt.itemLifecycle;
    return lifecycle.activeCount === 0 &&
      lifecycle.startedCount > 0 &&
      lifecycle.completedCount === lifecycle.startedCount
      ? REPLAY_SAFE_CODE_MODE_ERROR_RETRY_INSTRUCTION
      : null;
  }
  if (
    !isEmptyResponseAssistantTurn({
      // A safe Code Mode failure can synthesize an "Exec failed" payload even
      // when the model emitted no answer. Retry the model turn, not that wrapper text.
      payloadCount: 0,
      attempt: params.attempt,
    })
  ) {
    return null;
  }
  return REPLAY_SAFE_CODE_MODE_ERROR_RETRY_INSTRUCTION;
}

function isReplaySafeCodeModeToolError(params: {
  aborted: boolean;
  timedOut: boolean;
  attempt: IncompleteTurnAttempt;
}): boolean {
  const replayMetadata = resolveAttemptReplayMetadata(params.attempt);
  if (
    params.aborted ||
    params.timedOut ||
    params.attempt.codeModeEngaged !== true ||
    !params.attempt.lastToolError ||
    params.attempt.clientToolCalls ||
    params.attempt.yieldDetected ||
    params.attempt.didSendDeterministicApprovalPrompt ||
    hasAcceptedSessionSpawn(params.attempt.acceptedSessionSpawns) ||
    replayMetadata.hadPotentialSideEffects ||
    !replayMetadata.replaySafe
  ) {
    return false;
  }
  const toolName = normalizeLowercaseStringOrEmpty(params.attempt.lastToolError.toolName);
  if (toolName !== "exec" && toolName !== "wait") {
    return false;
  }
  const latestMatchingFailure = params.attempt.toolMetas.findLast(
    (entry) =>
      normalizeLowercaseStringOrEmpty(entry.toolName) === toolName && entry.isError === true,
  );
  return Boolean(
    latestMatchingFailure &&
    latestMatchingFailure.replaySafe === true &&
    latestMatchingFailure.sideEffectFree === true &&
    latestMatchingFailure.codeModeRepairAllowed === true &&
    latestMatchingFailure.asyncStarted !== true,
  );
}

function shouldApplyNonVisibleTurnRetryGuard(params: {
  provider?: string;
  modelId?: string;
  modelApi?: string;
  executionContract?: string;
}): boolean {
  if (
    params.executionContract === "strict-agentic" ||
    isIncompleteTurnRecoverySupportedProviderModel({
      provider: params.provider,
      modelId: params.modelId,
    })
  ) {
    return true;
  }
  if (RETRY_GUARD_MODEL_APIS.has(normalizeLowercaseStringOrEmpty(params.modelApi ?? ""))) {
    return true;
  }
  // This path uses provider output structure only: no user or assistant prose classification.
  return OLLAMA_INCOMPLETE_TURN_PROVIDER_ID_PATTERN.test(
    normalizeLowercaseStringOrEmpty(params.provider ?? ""),
  );
}

function isIncompleteTurnRecoverySupportedProviderModel(params: {
  provider?: string;
  modelId?: string;
}): boolean {
  if (
    isStrictAgenticSupportedProviderModel({
      provider: params.provider,
      modelId: params.modelId,
    })
  ) {
    return true;
  }
  const provider = normalizeLowercaseStringOrEmpty(params.provider ?? "");
  if (!GEMINI_INCOMPLETE_TURN_PROVIDER_IDS.has(provider)) {
    return false;
  }
  const modelId = typeof params.modelId === "string" ? params.modelId : "";
  return GEMINI_INCOMPLETE_TURN_MODEL_ID_PATTERN.test(stripProviderPrefix(modelId));
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
