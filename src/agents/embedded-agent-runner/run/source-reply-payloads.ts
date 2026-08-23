import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SourceReplyDeliveryMode } from "../../../auto-reply/get-reply-options.types.js";
import type { ReplyPayload } from "../../../auto-reply/reply-payload.js";
import type {
  MessagingToolSend,
  MessagingToolSourceReplyPayload,
} from "../../embedded-agent-messaging.types.js";
import { resolveExplicitFinalSourceReplyDeliveryEvidence } from "../delivery-evidence.js";

type EmbeddedRunReplyItem = {
  text: string;
  media?: string[];
  mediaUrl?: string;
  isError?: boolean;
  isReasoning?: boolean;
  /** Marks pre-tool commentary (💬) — a display lane, suppressed unless the channel opts in. */
  isCommentary?: boolean;
  audioAsVoice?: boolean;
  replyToId?: string;
  replyToTag?: boolean;
  replyToCurrent?: boolean;
  presentation?: ReplyPayload["presentation"];
  interactive?: ReplyPayload["interactive"];
  channelData?: Record<string, unknown>;
  nonTerminalToolErrorWarning?: boolean;
  sourceReplyMirror?: { idempotencyKey?: string };
};

/** Builds transcript mirrors and completion evidence for message-tool source replies. */
export function buildSourceReplyPayloadState(params: {
  payloads?: MessagingToolSourceReplyPayload[];
  sentTargets?: MessagingToolSend[];
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  didDeliverSourceReplyViaMessageTool?: boolean;
  runId?: string;
}): {
  replyItems: EmbeddedRunReplyItem[];
  hasSourceReplyPayload: boolean;
  deliveredSourceReplyViaMessageTool: boolean;
  explicitFinalSourceReply: boolean | undefined;
  completedSourceReplyViaMessageTool: boolean;
} {
  const sourceReplyPayloads = params.payloads ?? [];
  const replyItems = sourceReplyPayloads.flatMap((payload, index): EmbeddedRunReplyItem[] => {
    const text = normalizeOptionalString(payload.text) ?? "";
    const media = Array.from(
      new Set([...(payload.mediaUrl ? [payload.mediaUrl] : []), ...(payload.mediaUrls ?? [])]),
    ).filter((value) => value.trim().length > 0);
    if (
      !text &&
      media.length === 0 &&
      !payload.presentation &&
      !payload.interactive &&
      !payload.channelData
    ) {
      return [];
    }
    // These replies were already sent by the tool. Mirror them into the
    // transcript while marking channel delivery to suppress a duplicate send.
    return [
      {
        text,
        ...(payload.mediaUrl ? { mediaUrl: payload.mediaUrl } : {}),
        ...(media.length ? { media } : {}),
        ...(payload.audioAsVoice ? { audioAsVoice: true } : {}),
        ...(payload.presentation ? { presentation: payload.presentation } : {}),
        ...(payload.interactive ? { interactive: payload.interactive } : {}),
        ...(payload.channelData ? { channelData: payload.channelData } : {}),
        sourceReplyMirror: {
          idempotencyKey:
            payload.idempotencyKey ??
            (params.runId ? `${params.runId}:internal-source-reply:${index}` : undefined),
        },
      },
    ];
  });
  const hasSourceReplyPayload = replyItems.length > 0;
  const deliveredSourceReplyViaMessageTool =
    params.sourceReplyDeliveryMode === "message_tool_only" &&
    params.didDeliverSourceReplyViaMessageTool === true;
  const explicitFinalSourceReply = resolveExplicitFinalSourceReplyDeliveryEvidence({
    messagingToolSentTargets: params.sentTargets,
    messagingToolSourceReplyPayloads: sourceReplyPayloads,
  });
  return {
    replyItems,
    hasSourceReplyPayload,
    deliveredSourceReplyViaMessageTool,
    explicitFinalSourceReply,
    completedSourceReplyViaMessageTool:
      explicitFinalSourceReply ?? (hasSourceReplyPayload || deliveredSourceReplyViaMessageTool),
  };
}
