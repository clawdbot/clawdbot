import type { SourceReplyDeliveryMode } from "../get-reply-options.types.js";
import { markReplyPayloadForSourceSuppressionDelivery } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import type { FollowupRun } from "./queue/types.js";

export const STRANDED_REPLY_RETRY_MARKER = "stranded-reply-retry";
export const STRANDED_REPLY_DELIVERY_FAILURE_TEXT =
  "I generated a reply but could not deliver it to this chat. Please try again.";

export function buildStrandedReplyDeliveryFailurePayload(): ReplyPayload {
  return markReplyPayloadForSourceSuppressionDelivery({
    text: STRANDED_REPLY_DELIVERY_FAILURE_TEXT,
    isError: true,
    isStatusNotice: true,
  });
}

export function buildStrandedReplyRetryPrompt(finalText: string): string {
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
    // identity) completes with the parent run. queuedLifecycle is one-shot WeakSet-tracked,
    // so a shared object would be double-owned and free cancel while the retry still runs.
    queuedLifecycle: undefined,
    run: {
      ...base.run,
      sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
      suppressNextUserMessagePersistence: true,
    },
  };
}
