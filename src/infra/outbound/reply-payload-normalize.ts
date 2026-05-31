import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import type { ReplyPayload as InternalReplyPayload } from "../../auto-reply/reply-payload.js";

export type OutboundReplyPayload = {
  text?: string;
  mediaUrls?: string[];
  mediaUrl?: string;
  presentation?: InternalReplyPayload["presentation"];
  /**
   * @deprecated Use presentation. Runtime support remains for legacy producers.
   */
  interactive?: InternalReplyPayload["interactive"];
  channelData?: InternalReplyPayload["channelData"];
  sensitiveMedia?: boolean;
  replyToId?: string;
};

function readObjectValue(value: unknown): object | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

/** Extract the supported outbound reply fields from loose tool or agent payload objects. */
export function normalizeOutboundReplyPayload(
  payload: Record<string, unknown>,
): OutboundReplyPayload {
  const text = readStringValue(payload.text);
  const mediaUrls = Array.isArray(payload.mediaUrls)
    ? payload.mediaUrls.filter(
        (entry): entry is string => typeof entry === "string" && entry.length > 0,
      )
    : undefined;
  const mediaUrl = readStringValue(payload.mediaUrl);
  const presentation = readObjectValue(
    payload.presentation,
  ) as OutboundReplyPayload["presentation"];
  const interactive = readObjectValue(payload.interactive) as OutboundReplyPayload["interactive"];
  const channelData = readObjectValue(payload.channelData) as OutboundReplyPayload["channelData"];
  const sensitiveMedia = payload.sensitiveMedia === true ? true : undefined;
  const replyToId = readStringValue(payload.replyToId);
  return {
    text,
    mediaUrls,
    mediaUrl,
    presentation,
    interactive,
    channelData,
    sensitiveMedia,
    replyToId,
  };
}
