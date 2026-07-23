// Reply-payload normalization projects loose tool/agent objects onto the
// outbound-supported reply payload fields.
import {
  normalizeOptionalString,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import type { ReplyPayload as InternalReplyPayload } from "../../auto-reply/reply-payload.js";
import { normalizeOutboundLocation } from "../../channels/location.js";

/**
 * Outbound-facing subset of reply payload fields accepted from loose producers.
 */
export type OutboundReplyPayload = {
  text?: string;
  mediaUrls?: string[];
  mediaUrl?: string;
  presentation?: InternalReplyPayload["presentation"];
  presentationTextMode?: InternalReplyPayload["presentationTextMode"];
  /**
   * @deprecated Use presentation. Runtime support remains for legacy producers.
   */
  interactive?: InternalReplyPayload["interactive"];
  channelData?: InternalReplyPayload["channelData"];
  sensitiveMedia?: boolean;
  replyToId?: string;
  location?: InternalReplyPayload["location"];
  videoAsNote?: boolean;
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
  const presentationTextMode = payload.presentationTextMode === "fallback" ? "fallback" : undefined;
  const interactive = readObjectValue(payload.interactive) as OutboundReplyPayload["interactive"];
  const channelData = readObjectValue(payload.channelData) as OutboundReplyPayload["channelData"];
  const sensitiveMedia = payload.sensitiveMedia === true ? true : undefined;
  const replyToId = readStringValue(payload.replyToId);
  const rawLocation = payload.location;
  // Some producers pad the unused optional `location` slot with a blank string;
  // treat blank as absent but keep real locations strict (mirrors message-action-runner, #112013).
  const location =
    typeof rawLocation === "string" && normalizeOptionalString(rawLocation) === undefined
      ? undefined
      : normalizeOutboundLocation(rawLocation);
  const videoAsNote = payload.videoAsNote === true ? true : undefined;
  return {
    text,
    mediaUrls,
    mediaUrl,
    presentation,
    ...(presentationTextMode ? { presentationTextMode } : {}),
    interactive,
    channelData,
    sensitiveMedia,
    replyToId,
    ...(location ? { location } : {}),
    ...(videoAsNote ? { videoAsNote: true } : {}),
  };
}
