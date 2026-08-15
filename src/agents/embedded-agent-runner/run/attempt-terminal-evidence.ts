/** Records attempt replay safety and terminal side-effect evidence. */
import { hasAcceptedSessionSpawn } from "../../accepted-session-spawn.js";
import {
  hasCommittedMessagingToolDeliveryEvidence,
  hasMessagingToolDeliveryEvidence,
} from "../delivery-evidence.js";
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
    hasAsyncActivity(attempt.toolMetas) ||
    (attempt.successfulCronAdds ?? 0) > 0,
  );
}

export function hasAsyncActivity(toolMetas?: readonly { asyncStarted?: boolean }[]): boolean {
  return (toolMetas ?? []).some((entry) => entry.asyncStarted === true);
}
