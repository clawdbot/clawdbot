import { isMessagingToolDuplicate } from "../../agents/pi-embedded-helpers.js";
import type { ReplyPayload } from "../types.js";
import { extractReplyToTag } from "./reply-tags.js";

export type ReplyToModeFilter = (payload: ReplyPayload) => ReplyPayload;

export function applyReplyTagsToPayload(
  payload: ReplyPayload,
  currentMessageId?: string,
): ReplyPayload {
  if (typeof payload.text !== "string") return payload;
  const { cleaned, replyToId } = extractReplyToTag(
    payload.text,
    currentMessageId,
  );
  return {
    ...payload,
    text: cleaned ? cleaned : undefined,
    replyToId: replyToId ?? payload.replyToId,
  };
}

export function isRenderablePayload(payload: ReplyPayload): boolean {
  return Boolean(
    payload.text ||
      payload.mediaUrl ||
      (payload.mediaUrls && payload.mediaUrls.length > 0),
  );
}

export function applyReplyThreading(params: {
  payloads: ReplyPayload[];
  applyReplyToMode: ReplyToModeFilter;
  currentMessageId?: string;
}): ReplyPayload[] {
  const { payloads, applyReplyToMode, currentMessageId } = params;
  return payloads
    .map((payload) => applyReplyTagsToPayload(payload, currentMessageId))
    .filter(isRenderablePayload)
    .map(applyReplyToMode);
}

export function filterMessagingToolDuplicates(params: {
  payloads: ReplyPayload[];
  sentTexts: string[];
}): ReplyPayload[] {
  const { payloads, sentTexts } = params;
  if (sentTexts.length === 0) return payloads;
  return payloads.filter(
    (payload) => !isMessagingToolDuplicate(payload.text ?? "", sentTexts),
  );
}
