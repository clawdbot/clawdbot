import type { FollowupRun } from "./queue/types.js";

const EMPTY_REPLY_RETRY_MARKER = "empty-reply-retry";

const EMPTY_REPLY_RETRY_PROMPT =
  "[System] Your previous turn finished without producing a visible reply. " +
  "Answer the user's last message now with a visible text reply. " +
  "Only call tools if strictly necessary to answer; otherwise reply directly.";

export type EmptyReplyRecovery =
  | { kind: "none" }
  | { kind: "retry"; run: FollowupRun }
  | { kind: "banner" };

/**
 * Resolve the one-shot auto-recovery for an interactive run that finished
 * without producing a visible reply. The guard mirrors
 * buildEmptyInteractiveReplyPayload: when the no-visible-reply banner would be
 * shown and this run has not already been retried, schedule a nudge retry
 * instead. A second empty run falls through to the banner.
 */
export function resolveEmptyReplyRecovery(params: {
  base: FollowupRun;
  isInteractive: boolean;
  isHeartbeat?: boolean;
  silentExpected?: boolean;
  allowEmptyAssistantReplyAsSilent?: boolean;
  isMessageToolOnly: boolean;
  hasPendingContinuation: boolean;
  hasExplicitSilentReply: boolean;
  hasCommittedDelivery: boolean;
}): EmptyReplyRecovery {
  if (
    !params.isInteractive ||
    params.isHeartbeat === true ||
    params.silentExpected === true ||
    params.allowEmptyAssistantReplyAsSilent === true ||
    params.isMessageToolOnly ||
    params.hasPendingContinuation ||
    params.hasExplicitSilentReply ||
    params.hasCommittedDelivery
  ) {
    return { kind: "none" };
  }
  // The one-shot recovery has already been spent (by this mechanism or the
  // stranded-reply mechanism): never stack a second retry on top of a retry.
  if (params.base.emptyReplyRetry === true || params.base.strandedReplyRetry === true) {
    return { kind: "banner" };
  }
  return { kind: "retry", run: buildEmptyReplyRetryFollowupRun(params.base) };
}

function buildEmptyReplyRetryFollowupRun(base: FollowupRun): FollowupRun {
  return {
    ...base,
    prompt: EMPTY_REPLY_RETRY_PROMPT,
    summaryLine: EMPTY_REPLY_RETRY_MARKER,
    emptyReplyRetry: true,
    disableCollectBatching: true,
    transcriptPrompt: undefined,
    userTurnTranscriptRecorder: undefined,
    currentInboundContext: undefined,
    turnAdoptionLifecycle: undefined,
    run: {
      ...base.run,
      suppressNextUserMessagePersistence: true,
    },
  };
}
