import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { STREAM_ERROR_FALLBACK_TEXT } from "../agents/stream-message-shared.js";
import {
  getHeartbeatToolNotificationText,
  type HeartbeatToolResponse,
} from "../auto-reply/heartbeat-tool-response.js";
import { stripHeartbeatToken } from "../auto-reply/heartbeat.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import { escapeRegExp } from "../utils.js";

export type NormalizedHeartbeatDelivery = {
  shouldSkip: boolean;
  text: string;
  hasMedia: boolean;
  isInternalPlaceholderOnly: boolean;
  silent?: boolean;
};

function stripLeadingHeartbeatResponsePrefix(
  text: string,
  responsePrefix: string | undefined,
): string {
  const normalizedPrefix = responsePrefix?.trim();
  if (!normalizedPrefix) {
    return text;
  }
  const prefixPattern = new RegExp(
    `^${escapeRegExp(normalizedPrefix)}(?=$|\\s|[\\p{P}\\p{S}])\\s*`,
    "iu",
  );
  return text.replace(prefixPattern, "");
}

function isStreamErrorFallbackPlaceholderOnly(text: string): boolean {
  let remaining = text.trim();
  if (!remaining) {
    return false;
  }
  while (remaining.startsWith(STREAM_ERROR_FALLBACK_TEXT)) {
    remaining = remaining.slice(STREAM_ERROR_FALLBACK_TEXT.length).trimStart();
  }
  return remaining.length === 0;
}

const TRAILING_HEARTBEAT_NOTIFY_FALSE_RE = /(?:^|[\r\n])[ \t]*notify=false[ \t]*(?:\r?\n[ \t]*)*$/i;

export function stripTrailingHeartbeatNotifyFalse(text: string): {
  text: string;
  silent: boolean;
} {
  const match = TRAILING_HEARTBEAT_NOTIFY_FALSE_RE.exec(text);
  return match
    ? { text: text.slice(0, match.index).trimEnd(), silent: true }
    : { text, silent: false };
}

export function normalizeHeartbeatReply(
  payload: ReplyPayload,
  responsePrefix: string | undefined,
  ackMaxChars: number,
): NormalizedHeartbeatDelivery {
  const rawText = typeof payload.text === "string" ? payload.text : "";
  const textForStrip = stripLeadingHeartbeatResponsePrefix(rawText, responsePrefix);
  const stripped = stripHeartbeatToken(textForStrip, {
    mode: "heartbeat",
    maxAckChars: ackMaxChars,
  });
  const hasMedia = resolveSendableOutboundReplyParts(payload).hasMedia;
  const notifyFalse = stripTrailingHeartbeatNotifyFalse(stripped.text);
  const isInternalPlaceholderOnly = isStreamErrorFallbackPlaceholderOnly(notifyFalse.text);
  if ((stripped.shouldSkip || isInternalPlaceholderOnly) && !hasMedia) {
    return {
      shouldSkip: true,
      text: "",
      hasMedia,
      isInternalPlaceholderOnly,
      ...(notifyFalse.silent ? { silent: true } : {}),
    };
  }
  let finalText = isInternalPlaceholderOnly ? "" : notifyFalse.text;
  if (responsePrefix && finalText && !finalText.startsWith(responsePrefix)) {
    finalText = `${responsePrefix} ${finalText}`;
  }
  return {
    shouldSkip: !hasMedia && finalText.trim().length === 0,
    text: finalText,
    hasMedia,
    isInternalPlaceholderOnly,
    ...(notifyFalse.silent ? { silent: true } : {}),
  };
}

export function normalizeHeartbeatToolNotification(
  response: HeartbeatToolResponse,
  responsePrefix: string | undefined,
): NormalizedHeartbeatDelivery {
  let finalText = getHeartbeatToolNotificationText(response);
  if (responsePrefix && finalText && !finalText.startsWith(responsePrefix)) {
    finalText = `${responsePrefix} ${finalText}`;
  }
  return {
    shouldSkip: finalText.trim().length === 0,
    text: finalText,
    hasMedia: false,
    isInternalPlaceholderOnly: false,
    ...(response.notify ? {} : { silent: true }),
  };
}
