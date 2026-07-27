// Whatsapp plugin module implements deliver reply behavior.
import {
  createMessageReceiptFromOutboundResults,
  type MessageReceipt,
  type MessageReceiptSourceResult,
} from "openclaw/plugin-sdk/channel-outbound";
import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
import type { ChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-chunking";
import {
  isReasoningReplyPayload,
  sendMediaWithLeadingCaption,
} from "openclaw/plugin-sdk/reply-payload";
import { logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { requireWhatsAppInboundAdmission } from "../inbound/admission.js";
import type { WhatsAppSendResult } from "../inbound/send-result.js";
import { listWhatsAppSendResultMessageIds } from "../inbound/send-result.js";
import type { AdmittedWebInboundMessage } from "../inbound/types.js";
import { loadWebMedia } from "../media.js";
import {
  type DeliverableWhatsAppOutboundPayload,
  normalizeWhatsAppOutboundPayload,
  normalizeWhatsAppPayloadTextPreservingIndentation,
  prepareWhatsAppOutboundMedia,
} from "../outbound-media-contract.js";
import { sendWhatsAppOutboundWithRetry } from "../outbound-retry.js";
import { buildQuotedMessageOptions, lookupInboundMessageMeta } from "../quoted-message.js";
import { newConnectionId } from "../reconnect.js";
import { formatError } from "../session.js";
import { markdownToWhatsAppChunks } from "../text-runtime.js";
import { whatsappOutboundLog } from "./loggers.js";
import { elide, markWhatsAppVisibleDeliveryError } from "./util.js";

export type WhatsAppReplyDeliveryResult = {
  results: WhatsAppSendResult[];
  receipt: MessageReceipt;
  providerAccepted: boolean;
};

function resolveWhatsAppReceiptKind(
  results: readonly WhatsAppSendResult[],
): Parameters<typeof createMessageReceiptFromOutboundResults>[0]["kind"] {
  if (results.length > 0 && results.every((result) => result.kind === "text")) {
    return "text";
  }
  if (results.length > 0 && results.every((result) => result.kind === "media")) {
    return "media";
  }
  return "unknown";
}

function createWhatsAppReplyDeliveryReceipt(
  results: readonly WhatsAppSendResult[],
): MessageReceipt {
  const receiptResultsById = new Map<string, MessageReceiptSourceResult>();
  for (const result of results) {
    if (result.receipt?.parts.length) {
      for (const part of result.receipt.parts) {
        receiptResultsById.set(part.platformMessageId, {
          ...(part.raw ?? { channel: "whatsapp", messageId: part.platformMessageId }),
          meta: {
            ...part.raw?.meta,
            kind: result.kind,
            providerAccepted: result.providerAccepted,
          },
        });
      }
      continue;
    }
    for (const messageId of listWhatsAppSendResultMessageIds(result)) {
      receiptResultsById.set(messageId, {
        channel: "whatsapp",
        messageId,
        meta: {
          kind: result.kind,
          providerAccepted: result.providerAccepted,
        },
      });
    }
  }
  return createMessageReceiptFromOutboundResults({
    results: [...receiptResultsById.values()],
    kind: resolveWhatsAppReceiptKind(results),
  });
}

export async function deliverWebReply(params: {
  replyResult: ReplyPayload;
  normalizedReplyResult?: DeliverableWhatsAppOutboundPayload<ReplyPayload>;
  msg: AdmittedWebInboundMessage;
  mediaLocalRoots?: readonly string[];
  maxMediaBytes: number;
  textLimit: number;
  chunkMode?: ChunkMode;
  replyLogger: {
    info: (obj: unknown, msg: string) => void;
    warn: (obj: unknown, msg: string) => void;
  };
  connectionId?: string;
  skipLog?: boolean;
  tableMode?: MarkdownTableMode;
}): Promise<WhatsAppReplyDeliveryResult> {
  const { replyResult, msg, maxMediaBytes, textLimit, replyLogger, connectionId, skipLog } = params;
  const admission = requireWhatsAppInboundAdmission(msg);
  const conversationId = admission.conversation.id;
  const isGroupConversation = admission.conversation.kind === "group";
  const replyStarted = Date.now();
  const sendResults: WhatsAppSendResult[] = [];
  const rememberSendResult = (result: WhatsAppSendResult | undefined) => {
    if (result) {
      sendResults.push(result);
    }
  };
  const finishDelivery = (): WhatsAppReplyDeliveryResult => {
    const receipt = createWhatsAppReplyDeliveryReceipt(sendResults);
    return {
      results: sendResults,
      receipt,
      providerAccepted: sendResults.some((result) => result.providerAccepted),
    };
  };
  if (isReasoningReplyPayload(replyResult)) {
    whatsappOutboundLog.debug(`Suppressed reasoning payload to ${conversationId}`);
    return finishDelivery();
  }
  const tableMode = params.tableMode ?? "code";
  const chunkMode = params.chunkMode ?? "length";
  const normalizedReply =
    params.normalizedReplyResult ??
    normalizeWhatsAppOutboundPayload(replyResult, {
      normalizeText: normalizeWhatsAppPayloadTextPreservingIndentation,
    });
  const textChunks = markdownToWhatsAppChunks(
    normalizedReply.text ?? "",
    textLimit,
    tableMode,
    chunkMode,
  );
  const mediaList = normalizedReply.mediaUrls ?? [];

  const getQuote = () => {
    if (!replyResult.replyToId) {
      return undefined;
    }
    // Use replyToId (not msg.event.id) so batched payloads quote the correct
    // per-message target.  Look up cached metadata for the specific
    // message being quoted — msg.payload.body may be a combined batch body.
    const cached = lookupInboundMessageMeta(
      admission.accountId,
      msg.platform.chatJid,
      replyResult.replyToId,
    );
    return buildQuotedMessageOptions({
      messageId: replyResult.replyToId,
      remoteJid: msg.platform.chatJid,
      fromMe: cached?.fromMe ?? false,
      participant:
        cached?.participant ?? (isGroupConversation ? msg.platform.senderJid : undefined),
      messageText: cached?.body ?? "",
      media: cached?.media,
    });
  };

  const sendWithRetry = async <T>(fn: () => Promise<T>, label: string) => {
    try {
      return await sendWhatsAppOutboundWithRetry({
        send: fn,
        onRetry: ({ attempt, maxAttempts: retryMaxAttempts, backoffMs, errorText }) => {
          logVerbose(
            `Retrying ${label} to ${conversationId} after failure (${attempt}/${retryMaxAttempts - 1}) in ${backoffMs}ms: ${errorText}`,
          );
        },
      });
    } catch (error: unknown) {
      if (sendResults.some((result) => result.providerAccepted)) {
        throw markWhatsAppVisibleDeliveryError(error);
      }
      throw error;
    }
  };

  // Text-only replies
  if (mediaList.length === 0 && textChunks.length) {
    const totalChunks = textChunks.length;
    for (const [index, chunk] of textChunks.entries()) {
      const chunkStarted = Date.now();
      const quote = getQuote();
      rememberSendResult(await sendWithRetry(() => msg.platform.reply(chunk, quote), "text"));
      if (!skipLog) {
        const durationMs = Date.now() - chunkStarted;
        whatsappOutboundLog.debug(
          `Sent chunk ${index + 1}/${totalChunks} to ${conversationId} (${durationMs.toFixed(0)}ms)`,
        );
      }
    }
    const delivery = finishDelivery();
    const logPayload = {
      correlationId: msg.event.id ?? newConnectionId(),
      connectionId: connectionId ?? null,
      to: conversationId,
      from: msg.platform.recipientJid,
      text: elide(replyResult.text, 240),
      mediaUrl: null,
      mediaSizeBytes: null,
      mediaKind: null,
      durationMs: Date.now() - replyStarted,
    };
    if (delivery.providerAccepted) {
      replyLogger.info(logPayload, "auto-reply sent (text)");
    } else {
      replyLogger.warn(logPayload, "auto-reply text was not accepted by WhatsApp provider");
    }
    return delivery;
  }

  const remainingText = [...textChunks];

  // Media (with optional caption on first item)
  const leadingCaption = remainingText.shift() || "";
  await sendMediaWithLeadingCaption({
    mediaUrls: mediaList,
    caption: leadingCaption,
    send: async ({ mediaUrl, caption }) => {
      const media = await prepareWhatsAppOutboundMedia(
        await loadWebMedia(mediaUrl, {
          maxBytes: maxMediaBytes,
          localRoots: params.mediaLocalRoots,
        }),
        mediaUrl,
      );
      if (shouldLogVerbose()) {
        logVerbose(
          `Web auto-reply media size: ${(media.buffer.length / (1024 * 1024)).toFixed(2)}MB`,
        );
        logVerbose(`Web auto-reply media source: ${mediaUrl} (kind ${media.kind})`);
      }
      if (media.kind === "image") {
        const quote = getQuote();
        rememberSendResult(
          await sendWithRetry(
            () =>
              msg.platform.sendMedia(
                {
                  image: media.buffer,
                  caption,
                  mimetype: media.mimetype,
                },
                quote,
              ),
            "media:image",
          ),
        );
      } else if (media.kind === "audio") {
        const quote = getQuote();
        rememberSendResult(
          await sendWithRetry(
            () =>
              msg.platform.sendMedia(
                {
                  audio: media.buffer,
                  ptt: true,
                  mimetype: media.mimetype,
                },
                quote,
              ),
            "media:audio",
          ),
        );
        if (caption) {
          rememberSendResult(
            await sendWithRetry(() => msg.platform.reply(caption, quote), "media:audio-text"),
          );
        }
      } else if (media.kind === "video") {
        const quote = getQuote();
        rememberSendResult(
          await sendWithRetry(
            () =>
              msg.platform.sendMedia(
                {
                  video: media.buffer,
                  caption,
                  mimetype: media.mimetype,
                },
                quote,
              ),
            "media:video",
          ),
        );
      } else {
        const quote = getQuote();
        rememberSendResult(
          await sendWithRetry(
            () =>
              msg.platform.sendMedia(
                {
                  document: media.buffer,
                  fileName: media.fileName,
                  caption,
                  mimetype: media.mimetype,
                },
                quote,
              ),
            "media:document",
          ),
        );
      }
      whatsappOutboundLog.info(
        `Sent media reply to ${conversationId} (${(media.buffer.length / (1024 * 1024)).toFixed(2)}MB)`,
      );
      replyLogger.info(
        {
          correlationId: msg.event.id ?? newConnectionId(),
          connectionId: connectionId ?? null,
          to: conversationId,
          from: msg.platform.recipientJid,
          text: caption ?? null,
          mediaUrl,
          mediaSizeBytes: media.buffer.length,
          mediaKind: media.kind,
          durationMs: Date.now() - replyStarted,
        },
        "auto-reply sent (media)",
      );
    },
    onError: async ({ error, mediaUrl, caption, isFirst }) => {
      whatsappOutboundLog.error(
        `Failed sending web media to ${conversationId}: ${formatError(error)}`,
      );
      replyLogger.warn({ err: error, mediaUrl }, "failed to send web media reply");
      if (!isFirst) {
        // Non-first media failures were silently dropped before. Notify the user
        // so they know a trailing attachment did not arrive.
        whatsappOutboundLog.warn(`Trailing media failed; sent warning to ${conversationId}`);
        rememberSendResult(
          await sendWithRetry(
            () => msg.platform.reply("⚠️ Media unavailable.", getQuote()),
            "media:fallback-unavailable",
          ),
        );
        return;
      }
      const warning = "⚠️ Media failed.";
      const fallbackTextParts = [caption ?? "", warning].filter(Boolean);
      const fallbackText = fallbackTextParts.join("\n");
      if (!fallbackText) {
        return;
      }
      whatsappOutboundLog.warn(`Media skipped; sent text-only to ${conversationId}`);
      rememberSendResult(
        await sendWithRetry(
          () => msg.platform.reply(fallbackText, getQuote()),
          "media:fallback-text",
        ),
      );
    },
  });

  // Remaining text chunks after media
  for (const chunk of remainingText) {
    rememberSendResult(
      await sendWithRetry(() => msg.platform.reply(chunk, getQuote()), "media:text"),
    );
  }
  return finishDelivery();
}
