import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type {
  MessageActionNormalization,
  MessageActionResult,
} from "./message-action-contracts.js";

export type SendPayloadParts = {
  message: string;
  payload: ReplyPayload;
  mediaUrl?: string;
  mediaUrls?: string[];
  asVoice: boolean;
  gifPlayback: boolean;
  forceDocument: boolean;
  bestEffort?: boolean;
  silent?: boolean;
  normalization?: MessageActionNormalization;
};

const LEGACY_SEND_MEDIA_SOURCE_KEYS = ["path", "filePath", "fileUrl", "image"] as const;

export function updateSendPayloadPartsFromReplyPayload(
  parts: SendPayloadParts,
  payload: ReplyPayload,
): SendPayloadParts {
  const sendable = resolveSendableOutboundReplyParts(payload);
  const mediaUrls = sendable.mediaUrls.length > 0 ? sendable.mediaUrls : undefined;
  return {
    ...parts,
    message: payload.text ?? "",
    payload,
    mediaUrl: mediaUrls?.[0],
    mediaUrls,
    asVoice: payload.audioAsVoice === true,
  };
}

export function applySendLocationToActionParams(
  actionParams: Record<string, unknown>,
  location: ReplyPayload["location"],
) {
  if (location) {
    actionParams.location = location;
  } else {
    delete actionParams.location;
  }
}

export function applySendPayloadPartsToActionParams(
  actionParams: Record<string, unknown>,
  parts: SendPayloadParts,
) {
  if (parts.message || !parts.payload.presentation) {
    actionParams.message = parts.message;
  } else {
    // Presentation-only gateway handlers distinguish an omitted body from an
    // explicit empty body when deciding whether to render semantic fallback.
    delete actionParams.message;
  }
  actionParams.media = parts.mediaUrl;
  actionParams.mediaUrl = parts.mediaUrl;
  actionParams.mediaUrls = parts.mediaUrls;
  actionParams.attachments = parts.payload.attachments?.map((attachment) => ({ ...attachment }));
  for (const key of LEGACY_SEND_MEDIA_SOURCE_KEYS) {
    delete actionParams[key];
  }
  actionParams.asVoice = parts.asVoice || undefined;
  actionParams.audioAsVoice = parts.asVoice || undefined;
  actionParams.asVideoNote = parts.payload.videoAsNote || undefined;
  applySendLocationToActionParams(actionParams, parts.payload.location);
}

export function withSendNormalization(
  result: MessageActionResult,
  normalization?: MessageActionNormalization,
): MessageActionResult {
  return normalization && result.kind === "send" ? { ...result, normalization } : result;
}
