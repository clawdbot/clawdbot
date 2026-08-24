// Whatsapp plugin module implements deliver reply behavior.
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import {
  createMessageReceiptFromOutboundResults,
  type MessageReceipt,
  type MessageReceiptSourceResult,
} from "openclaw/plugin-sdk/channel-outbound";
import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
import type { ChunkMode, ReplyPayload } from "openclaw/plugin-sdk/reply-chunking";
import {
  isReasoningReplyPayload,
  sendMediaWithLeadingCaption,
} from "openclaw/plugin-sdk/reply-payload";
import { logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { requireWhatsAppInboundAdmission } from "../inbound/admission.js";
import {
  listWhatsAppSendResultMessageIds,
  mergeWhatsAppAcceptedSendError,
  rememberWhatsAppAcceptedSend,
  rememberWhatsAppPartialSend,
  withWhatsAppLogicalDeliveryActivity,
  type WhatsAppSendKind,
  type WhatsAppSendResult,
} from "../inbound/send-result.js";
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
import { elide } from "./util.js";

export type WhatsAppReplyDeliveryResult = {
  results: WhatsAppSendResult[];
  receipt: MessageReceipt;
  providerAccepted: boolean;
};

export type WhatsAppReplyTransportContext = {
  accountId: string;
  conversationId: string;
  conversationKind: "direct" | "group";
  chatJid: string;
  senderJid?: string;
  recipientJid: string;
  correlationId?: string;
  reply: AdmittedWebInboundMessage["platform"]["reply"];
  sendMedia: AdmittedWebInboundMessage["platform"]["sendMedia"];
};

export function createWhatsAppReplyTransportContext(
  msg: AdmittedWebInboundMessage,
): WhatsAppReplyTransportContext {
  const admission = requireWhatsAppInboundAdmission(msg);
  return {
    accountId: admission.accountId,
    conversationId: admission.conversation.id,
    conversationKind: admission.conversation.kind,
    chatJid: msg.platform.chatJid,
    senderJid: msg.platform.senderJid,
    recipientJid: msg.platform.recipientJid,
    correlationId: msg.event.id,
    reply: msg.platform.reply,
    sendMedia: msg.platform.sendMedia,
  };
}

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

type WhatsAppReplyDeliveryParams = {
  replyResult: ReplyPayload;
  normalizedReplyResult?: DeliverableWhatsAppOutboundPayload<ReplyPayload>;
  transport: WhatsAppReplyTransportContext;
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
};

export async function deliverWebReply(
  params: WhatsAppReplyDeliveryParams,
): Promise<WhatsAppReplyDeliveryResult> {
  return await withWhatsAppLogicalDeliveryActivity(() => deliverWebReplyInActivityScope(params));
}

async function deliverWebReplyInActivityScope(
  params: WhatsAppReplyDeliveryParams,
): Promise<WhatsAppReplyDeliveryResult> {
  const { replyResult, transport, maxMediaBytes, textLimit, replyLogger, connectionId, skipLog } =
    params;
  const conversationId = transport.conversationId;
  const isGroupConversation = transport.conversationKind === "group";
  const replyStarted = Date.now();
  const sendResults: WhatsAppSendResult[] = [];
  const finishDelivery = (): WhatsAppReplyDeliveryResult => {
    const receipt = createWhatsAppReplyDeliveryReceipt(sendResults);
    return {
      results: sendResults,
      receipt,
      providerAccepted: sendResults.some((result) => result.providerAccepted),
    };
  };
  const preserveAcceptedDeliveryError = (error: unknown, kind?: WhatsAppSendKind) => {
    const sendKind = kind ?? sendResults[0]?.kind ?? "text";
    if (isChannelPartialDeliveryError(error)) {
      rememberWhatsAppPartialSend({
        error,
        kind: sendKind,
        results: sendResults,
      });
    }
    return mergeWhatsAppAcceptedSendError({
      error,
      kind: sendKind,
      results: sendResults,
    });
  };
  const rememberSendResult = (result: WhatsAppSendResult | undefined) => {
    if (!result) {
      return;
    }
    try {
      rememberWhatsAppAcceptedSend({
        accountId: transport.accountId,
        result,
        results: sendResults,
      });
    } catch (error: unknown) {
      if (sendResults.some((accepted) => accepted.providerAccepted)) {
        throw preserveAcceptedDeliveryError(error, result.kind);
      }
      throw error;
    }
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
      transport.accountId,
      transport.chatJid,
      replyResult.replyToId,
    );
    return buildQuotedMessageOptions({
      messageId: replyResult.replyToId,
      remoteJid: transport.chatJid,
      fromMe: cached?.fromMe ?? false,
      participant: cached?.participant ?? (isGroupConversation ? transport.senderJid : undefined),
      messageText: cached?.body ?? "",
      media: cached?.media,
    });
  };

  const sendWithRetry = async <T>(fn: () => Promise<T>, label: string, kind: WhatsAppSendKind) => {
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
      if (
        isChannelPartialDeliveryError(error) ||
        sendResults.some((result) => result.providerAccepted)
      ) {
        throw preserveAcceptedDeliveryError(error, kind);
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
      rememberSendResult(await sendWithRetry(() => transport.reply(chunk, quote), "text", "text"));
      if (!skipLog) {
        const durationMs = Date.now() - chunkStarted;
        whatsappOutboundLog.debug(
          `Sent chunk ${index + 1}/${totalChunks} to ${conversationId} (${durationMs.toFixed(0)}ms)`,
        );
      }
    }
    const delivery = finishDelivery();
    const logPayload = {
      correlationId: transport.correlationId ?? newConnectionId(),
      connectionId: connectionId ?? null,
      to: conversationId,
      from: transport.recipientJid,
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
  let acceptedIdsBeforeCurrentMedia = new Set<string>();
  await sendMediaWithLeadingCaption({
    mediaUrls: mediaList,
    caption: leadingCaption,
    send: async ({ mediaUrl, caption }) => {
      acceptedIdsBeforeCurrentMedia = new Set(
        sendResults.flatMap(listWhatsAppSendResultMessageIds),
      );
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
              transport.sendMedia(
                {
                  image: media.buffer,
                  caption,
                  mimetype: media.mimetype,
                },
                quote,
              ),
            "media:image",
            "media",
          ),
        );
      } else if (media.kind === "audio") {
        const quote = getQuote();
        rememberSendResult(
          await sendWithRetry(
            () =>
              transport.sendMedia(
                {
                  audio: media.buffer,
                  ptt: true,
                  mimetype: media.mimetype,
                },
                quote,
              ),
            "media:audio",
            "media",
          ),
        );
        if (caption) {
          rememberSendResult(
            await sendWithRetry(() => transport.reply(caption, quote), "media:audio-text", "text"),
          );
        }
      } else if (media.kind === "video") {
        const quote = getQuote();
        rememberSendResult(
          await sendWithRetry(
            () =>
              transport.sendMedia(
                {
                  video: media.buffer,
                  caption,
                  mimetype: media.mimetype,
                },
                quote,
              ),
            "media:video",
            "media",
          ),
        );
      } else {
        const quote = getQuote();
        rememberSendResult(
          await sendWithRetry(
            () =>
              transport.sendMedia(
                {
                  document: media.buffer,
                  fileName: media.fileName,
                  caption,
                  mimetype: media.mimetype,
                },
                quote,
              ),
            "media:document",
            "media",
          ),
        );
      }
      whatsappOutboundLog.info(
        `Sent media reply to ${conversationId} (${(media.buffer.length / (1024 * 1024)).toFixed(2)}MB)`,
      );
      replyLogger.info(
        {
          correlationId: transport.correlationId ?? newConnectionId(),
          connectionId: connectionId ?? null,
          to: conversationId,
          from: transport.recipientJid,
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
      const currentMediaWasAccepted = sendResults.some((result) =>
        listWhatsAppSendResultMessageIds(result).some(
          (messageId) => !acceptedIdsBeforeCurrentMedia.has(messageId),
        ),
      );
      if (currentMediaWasAccepted) {
        // Earlier accepted uploads do not make a genuinely rejected trailing upload successful.
        throw preserveAcceptedDeliveryError(error);
      }
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
            () => transport.reply("⚠️ Media unavailable.", getQuote()),
            "media:fallback-unavailable",
            "text",
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
          () => transport.reply(fallbackText, getQuote()),
          "media:fallback-text",
          "text",
        ),
      );
    },
  });

  // Remaining text chunks after media
  for (const chunk of remainingText) {
    rememberSendResult(
      await sendWithRetry(() => transport.reply(chunk, getQuote()), "media:text", "text"),
    );
  }
  return finishDelivery();
}
