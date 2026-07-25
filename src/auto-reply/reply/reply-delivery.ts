/** Normalizes reply directives and delivers block replies through streaming or direct paths. */
import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import { logVerbose } from "../../globals.js";
import { copyReplyPayloadMetadata, isReplyPayloadStatusNotice } from "../reply-payload.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { BlockReplyContext, ReplyPayload, ReplyThreadingPolicy } from "../types.js";
import type { BlockReplyPipeline } from "./block-reply-pipeline.js";
import { createBlockReplyContentKey } from "./block-reply-pipeline.js";
import { mergeReactionDirectiveChannelData, parseReplyDirectives } from "./reply-directives.js";
import { applyReplyTagsToPayload, isRenderablePayload } from "./reply-payloads.js";
import type { TypingSignaler } from "./typing-mode.js";

type ReplyDirectiveParseMode = "always" | "auto" | "never";

/** Parses inline reply directives into payload fields and silent-reply state. */
export function normalizeReplyPayloadDirectives(params: {
  payload: ReplyPayload;
  currentMessageId?: string;
  silentToken?: string;
  trimLeadingWhitespace?: boolean;
  parseMode?: ReplyDirectiveParseMode;
  extractMarkdownImages?: boolean;
  extractMediaDirectives?: boolean;
}): { payload: ReplyPayload; isSilent: boolean } {
  const parseMode = params.parseMode ?? "always";
  const silentToken = params.silentToken ?? SILENT_REPLY_TOKEN;
  const sourceText = params.payload.text ?? "";

  const shouldParse =
    parseMode === "always" ||
    (parseMode === "auto" &&
      (sourceText.includes("[[") ||
        (params.extractMediaDirectives !== false && /media:/i.test(sourceText)) ||
        (params.extractMarkdownImages === true && /!\[[^\]]*]\(/.test(sourceText)) ||
        sourceText.includes(silentToken)));

  const parsed = shouldParse
    ? parseReplyDirectives(sourceText, {
        currentMessageId: params.currentMessageId,
        silentToken,
        extractMarkdownImages: params.extractMarkdownImages,
        extractMediaDirectives: params.extractMediaDirectives,
      })
    : undefined;

  let text = parsed ? parsed.text || undefined : params.payload.text || undefined;
  if (params.trimLeadingWhitespace && text) {
    text = text.trimStart() || undefined;
  }

  const mediaUrls = params.payload.mediaUrls ?? parsed?.mediaUrls;
  const mediaUrl = params.payload.mediaUrl ?? parsed?.mediaUrls?.[0] ?? mediaUrls?.[0];

  const channelData = mergeReactionDirectiveChannelData(
    params.payload.channelData,
    parsed?.reaction,
  );
  return {
    payload: copyReplyPayloadMetadata(params.payload, {
      ...params.payload,
      text,
      mediaUrls,
      mediaUrl,
      replyToId: params.payload.replyToId ?? parsed?.replyToId,
      replyToTag: params.payload.replyToTag || parsed?.replyToTag,
      replyToCurrent: params.payload.replyToCurrent || parsed?.replyToCurrent,
      audioAsVoice: Boolean(params.payload.audioAsVoice || parsed?.audioAsVoice),
      ...(channelData ? { channelData } : {}),
    }),
    isSilent: parsed?.isSilent ?? false,
  };
}

async function sendDirectBlockReply(params: {
  onBlockReply: (payload: ReplyPayload, context?: BlockReplyContext) => Promise<void> | void;
  directlySentBlockKeys: Set<string>;
  directlySentBlockPayloads: Array<ReplyPayload | undefined>;
  trackingPayload: ReplyPayload;
  payload: ReplyPayload;
}) {
  const deliveryIndex = params.directlySentBlockPayloads.length;
  params.directlySentBlockPayloads.push(undefined);
  await params.onBlockReply(params.payload);
  params.directlySentBlockKeys.add(createBlockReplyContentKey(params.trackingPayload));
  if (!isReplyPayloadStatusNotice(params.trackingPayload)) {
    params.directlySentBlockPayloads[deliveryIndex] = params.trackingPayload;
  }
}

/** Creates the handler used for assistant block replies during streaming/tool phases. */
export function createBlockReplyDeliveryHandler(params: {
  onBlockReply: (payload: ReplyPayload, context?: BlockReplyContext) => Promise<void> | void;
  currentMessageId?: string;
  replyThreading?: ReplyThreadingPolicy;
  normalizeStreamingText: (payload: ReplyPayload) => { text?: string; skip: boolean };
  applyReplyToMode: (payload: ReplyPayload) => ReplyPayload;
  normalizeMediaPaths?: (payload: ReplyPayload) => Promise<ReplyPayload>;
  typingSignals: TypingSignaler;
  reasoningPayloadsEnabled?: boolean;
  commentaryPayloadsEnabled?: boolean;
  blockStreamingEnabled: boolean;
  blockReplyPipeline: BlockReplyPipeline | null;
  directlySentBlockKeys: Set<string>;
  directlySentBlockPayloads: Array<ReplyPayload | undefined>;
}): (payload: ReplyPayload) => Promise<void> {
  return async (payload) => {
    // Suppressed display lanes must not enter delivery bookkeeping: callers use
    // that evidence to decide whether an otherwise empty turn needs a fallback.
    if (
      (payload.isReasoning === true && params.reasoningPayloadsEnabled !== true) ||
      (payload.isCommentary === true && params.commentaryPayloadsEnabled !== true)
    ) {
      return;
    }
    const { text, skip } = params.normalizeStreamingText(payload);
    if (skip && !hasOutboundReplyContent({ ...payload, text: undefined })) {
      return;
    }

    const implicitCurrentMessageAllowed =
      payload.replyToCurrent === true
        ? true
        : payload.replyToCurrent === false
          ? false
          : params.replyThreading?.implicitCurrentMessage !== "deny";
    // Reply-to-current is implicit for block replies unless per-turn threading disables it.

    const taggedPayload = applyReplyTagsToPayload(
      {
        ...payload,
        text,
        mediaUrl: payload.mediaUrl ?? payload.mediaUrls?.[0],
        replyToId:
          payload.replyToId ??
          (implicitCurrentMessageAllowed ? params.currentMessageId : undefined),
      },
      params.currentMessageId,
    );

    // Let through payloads with audioAsVoice flag even if empty (need to track it).
    if (!isRenderablePayload(taggedPayload) && !payload.audioAsVoice) {
      return;
    }

    const normalized = normalizeReplyPayloadDirectives({
      payload: taggedPayload,
      currentMessageId: params.currentMessageId,
      silentToken: SILENT_REPLY_TOKEN,
      trimLeadingWhitespace: true,
      parseMode: "auto",
      extractMediaDirectives: false,
    });

    const mediaNormalizedPayload = params.normalizeMediaPaths
      ? await params.normalizeMediaPaths(normalized.payload)
      : normalized.payload;
    if (normalized.isSilent) {
      mediaNormalizedPayload.text = undefined;
    }
    const blockPayload = copyReplyPayloadMetadata(
      payload,
      params.applyReplyToMode(mediaNormalizedPayload),
    );
    const blockHasNonTextContent = hasOutboundReplyContent({ ...blockPayload, text: undefined });

    // Skip empty payloads unless they have audioAsVoice flag (need to track it).
    if (!blockPayload.text && !blockHasNonTextContent && !blockPayload.audioAsVoice) {
      return;
    }
    if (normalized.isSilent && !blockHasNonTextContent) {
      return;
    }

    if (blockPayload.text) {
      void params.typingSignals.signalTextDelta(blockPayload.text).catch((err: unknown) => {
        logVerbose(`block reply typing signal failed: ${String(err)}`);
      });
    }

    // Use pipeline if available (block streaming enabled), otherwise send directly.
    if (params.blockStreamingEnabled && params.blockReplyPipeline) {
      params.blockReplyPipeline.enqueue(blockPayload);
    } else if (params.blockStreamingEnabled) {
      // Send directly when flushing before tool execution (no pipeline but streaming enabled).
      // Track sent key to avoid duplicate in final payloads.
      await sendDirectBlockReply({
        onBlockReply: params.onBlockReply,
        directlySentBlockKeys: params.directlySentBlockKeys,
        directlySentBlockPayloads: params.directlySentBlockPayloads,
        trackingPayload: blockPayload,
        payload: blockPayload,
      });
    } else if (
      blockHasNonTextContent ||
      blockPayload.isReasoning === true ||
      blockPayload.isCommentary === true
    ) {
      // Enabled display lanes never merge into final text, so deliver them directly
      // even when block streaming is off.
      await sendDirectBlockReply({
        onBlockReply: params.onBlockReply,
        directlySentBlockKeys: params.directlySentBlockKeys,
        directlySentBlockPayloads: params.directlySentBlockPayloads,
        trackingPayload: blockPayload,
        payload: blockPayload,
      });
    }
    // When streaming is disabled entirely, text-only blocks are accumulated in final text.
  };
}
