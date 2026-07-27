import type { SourceReplyDeliveryMode } from "../get-reply-options.types.js";
import { markReplyPayloadForSourceSuppressionDelivery } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { shouldWarnAboutPrivateMessageToolFinal } from "./private-message-tool-final.js";
import type { FollowupRun } from "./queue/types.js";

const STRANDED_REPLY_RETRY_MARKER = "stranded-reply-retry";
const STRANDED_REPLY_DELIVERY_FAILURE_TEXT =
  "I generated a reply but could not deliver it to this chat. Please try again.";

export function buildStrandedReplyDeliveryFailurePayload(): ReplyPayload {
  return markReplyPayloadForSourceSuppressionDelivery({
    text: STRANDED_REPLY_DELIVERY_FAILURE_TEXT,
    isError: true,
    isStatusNotice: true,
  });
}

type StrandedReplyRecovery =
  | { kind: "none" }
  | { kind: "retry"; run: FollowupRun }
  | { kind: "diagnostic"; payload: ReplyPayload; warn: boolean };

/** Resolve the one allowed recovery action for a final that missed source delivery. */
export function resolveStrandedReplyRecovery(params: {
  base: FollowupRun;
  finalText: string;
  sourceReplyDeliveryMode: SourceReplyDeliveryMode | undefined;
  sendPolicyDenied: boolean;
  successfulSourceReplyDelivery: boolean;
  isHeartbeat: boolean;
  isRoomEvent: boolean;
}): StrandedReplyRecovery {
  if (
    params.isHeartbeat ||
    params.isRoomEvent ||
    params.sourceReplyDeliveryMode !== "message_tool_only" ||
    params.sendPolicyDenied ||
    params.successfulSourceReplyDelivery
  ) {
    return { kind: "none" };
  }
  const shouldWarn = shouldWarnAboutPrivateMessageToolFinal({
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    sendPolicyDenied: params.sendPolicyDenied,
    successfulSourceReplyDelivery: params.successfulSourceReplyDelivery,
    finalText: params.finalText,
  });
  if (params.base.strandedReplyRetry === true) {
    return {
      kind: "diagnostic",
      payload: buildStrandedReplyDeliveryFailurePayload(),
      warn: shouldWarn,
    };
  }
  if (!shouldWarn) {
    return { kind: "none" };
  }
  return {
    kind: "retry",
    run: buildStrandedReplyRetryFollowupRun(params.base, {
      finalText: params.finalText,
      sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    }),
  };
}

function buildStrandedReplyRetryPrompt(finalText: string): string {
  return (
    `[System] Your previous reply was not delivered to the conversation because ` +
    `you did not call message(action=send). Your reply text was:\n\n` +
    `"${finalText}"\n\n` +
    `Please deliver this reply now by calling message(action=send). ` +
    `Do not add any extra commentary; just deliver the original reply.`
  );
}

/** Build the one-shot recovery followup that re-prompts message(action=send). */
export function buildStrandedReplyRetryFollowupRun(
  base: FollowupRun,
  params: {
    finalText: string;
    sourceReplyDeliveryMode: SourceReplyDeliveryMode | undefined;
  },
): FollowupRun {
  return {
    ...base,
    prompt: buildStrandedReplyRetryPrompt(params.finalText),
    summaryLine: STRANDED_REPLY_RETRY_MARKER,
    strandedReplyRetry: true,
    disableCollectBatching: true,
    transcriptPrompt: undefined,
    userTurnTranscriptRecorder: undefined,
    currentInboundContext: undefined,
    // Internally generated system turn: the client turn's lifecycle (gateway cancel
    // identity) completes with the parent run. turnAdoptionLifecycle is one-shot
    // WeakSet-tracked, so a shared object would be double-owned and free cancel
    // while the retry still runs.
    turnAdoptionLifecycle: undefined,
    run: {
      ...base.run,
      sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
      suppressNextUserMessagePersistence: true,
    },
  };
}
