import {
  copyReplyPayloadMetadata,
  isReplyPayloadStatusNotice,
  type ReplyPayload,
} from "../auto-reply/reply-payload.js";
import { resolveChannelTtsVoiceDelivery } from "../channels/plugins/tts-capabilities.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { TtsAutoMode } from "../config/types.tts.js";
import { createTtsDirectiveTextStreamCleaner } from "./directives.js";
import { resolveStatusTtsSnapshot } from "./status-config.js";
import { resolveConfiguredTtsMode } from "./tts-config.js";

export function shouldDeferFinalTtsText(params: {
  cfg: OpenClawConfig;
  ttsAuto?: TtsAutoMode;
  agentId?: string;
  channelId?: string;
  accountId?: string;
  inboundAudio: boolean;
}): boolean {
  if (!resolveChannelTtsVoiceDelivery(params.channelId)?.captionedFinalText) {
    return false;
  }
  if (
    resolveConfiguredTtsMode(params.cfg, {
      agentId: params.agentId,
      channelId: params.channelId,
      accountId: params.accountId,
    }) !== "final"
  ) {
    return false;
  }
  const status = resolveStatusTtsSnapshot({
    cfg: params.cfg,
    sessionAuto: params.ttsAuto,
    agentId: params.agentId,
    channelId: params.channelId,
    accountId: params.accountId,
  });
  return (
    status != null &&
    status.autoMode !== "off" &&
    status.autoMode !== "tagged" &&
    (status.autoMode !== "inbound" || params.inboundAudio)
  );
}

export function mergeDeferredFinalText(streamedText: string, finalText?: string): string {
  const streamed = streamedText.trim();
  const final = finalText?.trim() ?? "";
  if (!streamed) {
    return final;
  }
  if (!final || streamed === final || streamed.startsWith(final)) {
    return streamed;
  }
  if (final.startsWith(streamed)) {
    return final;
  }
  return `${streamed}\n${final}`;
}

export function isCaptionedFinalTextPayload(payload: ReplyPayload): boolean {
  return (
    payload.isReasoning !== true &&
    payload.isCommentary !== true &&
    !isReplyPayloadStatusNotice(payload)
  );
}

export function cleanDeferredFinalText(text: string | undefined): string {
  if (!text) {
    return "";
  }
  const cleaner = createTtsDirectiveTextStreamCleaner();
  return `${cleaner.push(text)}${cleaner.flush()}`.replace(/[ \t]+\n/gu, "\n");
}

export function buildCaptionedFinalTextFallback(payload: ReplyPayload): ReplyPayload {
  return copyReplyPayloadMetadata(payload, {
    text: payload.text,
    delivery: payload.delivery,
    replyToId: payload.replyToId,
    replyToTag: payload.replyToTag,
    replyToCurrent: payload.replyToCurrent,
  });
}
