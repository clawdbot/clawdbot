import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
/** Records attempt replay safety and terminal side-effect evidence. */
import {
  hasAcceptedSessionSpawn,
  hasCompletionMessageSessionSpawn,
} from "../../accepted-session-spawn.js";
import { hasMessagingToolDeliveryEvidence } from "../delivery-evidence.js";
import type { RunEmbeddedAgentParams } from "./params.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

/** Reads this attempt's response without reviving an older transcript turn. */
export function resolveCurrentAttemptAssistant(
  attempt: Pick<
    EmbeddedRunAttemptResult,
    "currentAttemptAssistant" | "currentAttemptCompletedAssistant"
  >,
) {
  // The completed event survives transcript projection and is cleared before a
  // compaction retry. Historical lastAssistant is not evidence of a new response.
  return attempt.currentAttemptAssistant ?? attempt.currentAttemptCompletedAssistant;
}

type ReplayMetadataAttempt = Pick<
  EmbeddedRunAttemptResult,
  | "toolMetas"
  | "didSendViaMessagingTool"
  | "messagingToolSentTexts"
  | "messagingToolSentMediaUrls"
  | "successfulCronAdds"
> &
  Partial<Pick<EmbeddedRunAttemptResult, "messagingToolSentTargets" | "acceptedSessionSpawns">>;

/** Uses current-attempt evidence when available and otherwise preserves fail-closed legacy state. */
export function isCurrentAttemptReplaySafe(
  attempt: Pick<EmbeddedRunAttemptResult, "replayMetadata" | "currentAttemptReplayMetadata">,
): boolean {
  const replayMetadata = attempt.currentAttemptReplayMetadata ?? attempt.replayMetadata;
  return replayMetadata.replaySafe && !replayMetadata.hadPotentialSideEffects;
}

/**
 * Marks whether retrying the attempt can safely replay the prompt. Concrete
 * tool-instance policy, async work, committed delivery, spawned sessions, and
 * cron writes all contribute side-effect evidence.
 */
export function buildAttemptReplayMetadata(
  params: ReplayMetadataAttempt,
): EmbeddedRunAttemptResult["replayMetadata"] {
  const hadUnsafeTools = params.toolMetas.some((entry) => entry.replaySafe !== true);
  const hadAsyncStartedTool = params.toolMetas.some((t) => t.asyncStarted === true);
  const hadPotentialSideEffects =
    hadUnsafeTools ||
    hadAsyncStartedTool ||
    hasMessagingToolDeliveryEvidence(params) ||
    hasAcceptedSessionSpawn(params.acceptedSessionSpawns) ||
    (params.successfulCronAdds ?? 0) > 0;
  return {
    hadPotentialSideEffects,
    replaySafe: !hadPotentialSideEffects,
  };
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
      | "didSendViaMessagingTool"
      | "messagingToolSentTexts"
      | "messagingToolSentMediaUrls"
      | "messagingToolSentTargets"
    >
  > & {
    toolMetas?: readonly { asyncStarted?: boolean }[];
  };

export function hasAttemptTerminalState(attempt: TerminalAttemptState): boolean {
  return Boolean(
    attempt.lastToolError ||
    attempt.clientToolCalls ||
    attempt.yieldDetected ||
    attempt.didSendDeterministicApprovalPrompt ||
    attempt.heartbeatToolResponse ||
    attempt.toolMediaUrls?.some((url) => url.trim().length > 0) ||
    attempt.toolAudioAsVoice ||
    attempt.toolTrustedLocalMedia ||
    attempt.hasToolMediaBlockReply ||
    attempt.didDeliverSourceReplyViaMessageTool ||
    attempt.messagingToolSourceReplyPayloads?.length ||
    hasMessagingToolDeliveryEvidence({
      didSendViaMessagingTool: attempt.didSendViaMessagingTool,
      messagingToolSentTexts: attempt.messagingToolSentTexts ?? [],
      messagingToolSentMediaUrls: attempt.messagingToolSentMediaUrls ?? [],
      messagingToolSentTargets: attempt.messagingToolSentTargets ?? [],
    }) ||
    hasAcceptedSessionSpawn(attempt.acceptedSessionSpawns) ||
    hasAsyncActivity(attempt.toolMetas) ||
    (attempt.successfulCronAdds ?? 0) > 0,
  );
}

export function hasAsyncActivity(toolMetas?: readonly { asyncStarted?: boolean }[]): boolean {
  return (toolMetas ?? []).some((entry) => entry.asyncStarted === true);
}

type AcceptedSessionSpawnContinuationAttempt = Pick<
  EmbeddedRunAttemptResult,
  | "acceptedSessionSpawns"
  | "assistantTexts"
  | "clientToolCalls"
  | "didDeliverSourceReplyViaMessageTool"
  | "didSendDeterministicApprovalPrompt"
  | "didSendViaMessagingTool"
  | "heartbeatToolResponse"
  | "lastToolError"
  | "messagingToolSentMediaUrls"
  | "messagingToolSentTargets"
  | "messagingToolSentTexts"
  | "messagingToolSourceReplyPayloads"
  | "successfulCronAdds"
  | "terminal"
  | "toolAudioAsVoice"
  | "toolMediaUrls"
  | "toolTrustedLocalMedia"
  | "yieldDetected"
>;

type AcceptedSessionSpawnContinuationRun = Pick<
  RunEmbeddedAgentParams,
  "currentInboundEventKind" | "inputProvenance" | "replyOperation" | "silentExpected"
>;

/**
 * A visible parent that delegates its entire response must remain alive for
 * completion delivery. Existing output, explicit silence, and non-user turns
 * keep their established terminal ownership instead.
 */
export function shouldContinueInteractiveAcceptedSessionSpawns(params: {
  attempt: AcceptedSessionSpawnContinuationAttempt;
  run: AcceptedSessionSpawnContinuationRun;
}): boolean {
  const { attempt, run } = params;
  if (
    !hasCompletionMessageSessionSpawn(attempt.acceptedSessionSpawns) ||
    attempt.terminal.kind !== "ok" ||
    attempt.yieldDetected === true ||
    run.replyOperation?.turnKind !== "visible" ||
    run.currentInboundEventKind === "room_event" ||
    run.silentExpected === true ||
    (run.inputProvenance?.kind !== undefined && run.inputProvenance.kind !== "external_user")
  ) {
    return false;
  }
  if (
    attempt.assistantTexts.some(
      (text) => text.trim().length > 0 && !isSilentReplyText(text, SILENT_REPLY_TOKEN),
    )
  ) {
    return false;
  }
  return !hasAttemptTerminalState({
    ...attempt,
    acceptedSessionSpawns: [],
  });
}
