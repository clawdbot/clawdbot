// Line plugin module implements outbound behavior.
import {
  defineChannelMessageAdapter,
  type ChannelMessageSendResult,
  type MessageReceiptPartKind,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  createAttachedChannelResultAdapter,
  createEmptyChannelResult,
} from "openclaw/plugin-sdk/channel-send-result";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { resolveOutboundMediaUrls } from "openclaw/plugin-sdk/reply-payload";
import { sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-chunking";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { ChannelPlugin, ResolvedLineAccount } from "./channel-api.js";
import { resolveLineOutboundMedia, type LineOutboundMediaResolved } from "./outbound-media.js";
import { buildLineQuickReplyFallbackText } from "./quick-reply-fallback.js";
import { getLineRuntime } from "./runtime.js";
import { createLineSendReceipt } from "./send-receipt.js";
import type { LineChannelData, LineSendResult } from "./types.js";

const loadLineOutboundRuntime = createLazyRuntimeModule(() => import("./outbound.runtime.js"));

type LineChannelDataWithMedia = LineChannelData & {
  mediaKind?: "image" | "video" | "audio";
  previewImageUrl?: string;
  durationMs?: number;
  trackingId?: string;
};

function isLineUserTarget(target: string): boolean {
  const normalized = target
    .trim()
    .replace(/^line:(group|room|user):/i, "")
    .replace(/^line:/i, "");
  return /^U/i.test(normalized);
}

function hasLineSpecificMediaOptions(lineData: LineChannelDataWithMedia): boolean {
  return Boolean(
    lineData.mediaKind ??
    lineData.previewImageUrl?.trim() ??
    (typeof lineData.durationMs === "number" ? lineData.durationMs : undefined) ??
    lineData.trackingId?.trim(),
  );
}

function buildLineMediaMessageObject(
  resolved: LineOutboundMediaResolved,
  opts?: { allowTrackingId?: boolean },
): Record<string, unknown> {
  switch (resolved.mediaKind) {
    case "video": {
      const previewImageUrl = resolved.previewImageUrl?.trim();
      if (!previewImageUrl) {
        throw new Error("LINE video messages require previewImageUrl to reference an image URL");
      }
      return {
        type: "video",
        originalContentUrl: resolved.mediaUrl,
        previewImageUrl,
        ...(opts?.allowTrackingId && resolved.trackingId
          ? { trackingId: resolved.trackingId }
          : {}),
      };
    }
    case "audio":
      return {
        type: "audio",
        originalContentUrl: resolved.mediaUrl,
        duration: resolved.durationMs ?? 60000,
      };
    default:
      return {
        type: "image",
        originalContentUrl: resolved.mediaUrl,
        previewImageUrl: resolved.previewImageUrl ?? resolved.mediaUrl,
      };
  }
}

export const lineOutboundAdapter: NonNullable<ChannelPlugin<ResolvedLineAccount>["outbound"]> = {
  deliveryMode: "direct",
  chunker: (text, limit) => getLineRuntime().channel.text.chunkMarkdownText(text, limit),
  textChunkLimit: 5000,
  sanitizeText: ({ text }) => sanitizeAssistantVisibleText(text),
  sendPayload: async ({ to, payload, accountId, cfg, onDeliveryResult }) => {
    const runtime = getLineRuntime();
    const outboundRuntime = await loadLineOutboundRuntime();
    const lineData = (payload.channelData?.line as LineChannelDataWithMedia | undefined) ?? {};
    const lineRuntime = runtime.channel.line;
    const sendText = lineRuntime?.pushMessageLine ?? outboundRuntime.pushMessageLine;
    const sendBatch = lineRuntime?.pushMessagesLine ?? outboundRuntime.pushMessagesLine;
    const sendFlex = lineRuntime?.pushFlexMessage ?? outboundRuntime.pushFlexMessage;
    const sendTemplate = lineRuntime?.pushTemplateMessage ?? outboundRuntime.pushTemplateMessage;
    const sendLocation = lineRuntime?.pushLocationMessage ?? outboundRuntime.pushLocationMessage;
    const sendQuickReplies =
      lineRuntime?.pushTextMessageWithQuickReplies ??
      outboundRuntime.pushTextMessageWithQuickReplies;
    const buildTemplate =
      lineRuntime?.buildTemplateMessageFromPayload ??
      outboundRuntime.buildTemplateMessageFromPayload;

    let lastResult: LineSendResult | null = null;
    const recordResult = async (
      resultPromise: Promise<LineSendResult>,
    ): Promise<LineSendResult> => {
      const result = await resultPromise;
      lastResult = result;
      await onDeliveryResult?.(createEmptyChannelResult("line", { ...result }));
      return result;
    };
    const quickReplies = lineData.quickReplies ?? [];
    const hasQuickReplies = quickReplies.length > 0;
    const quickReply = hasQuickReplies
      ? (lineRuntime?.createQuickReplyItems ?? outboundRuntime.createQuickReplyItems)(quickReplies)
      : undefined;

    // LINE SDK expects Message[] but we build dynamically.
    const sendMessageBatch = async (messages: Array<Record<string, unknown>>) => {
      if (messages.length === 0) {
        return;
      }
      for (let i = 0; i < messages.length; i += 5) {
        const batch = messages.slice(i, i + 5) as unknown as Parameters<typeof sendBatch>[1];
        await recordResult(
          sendBatch(to, batch, {
            verbose: false,
            cfg,
            accountId: accountId ?? undefined,
          }),
        );
      }
    };

    const processed = payload.text
      ? outboundRuntime.processLineMessage(payload.text)
      : { text: "", flexMessages: [] };

    const chunkLimit =
      runtime.channel.text.resolveTextChunkLimit?.(cfg, "line", accountId ?? undefined, {
        fallbackLimit: 5000,
      }) ?? 5000;

    const chunks = processed.text
      ? runtime.channel.text.chunkMarkdownText(processed.text, chunkLimit)
      : [];
    const mediaUrls = resolveOutboundMediaUrls(payload);
    const useLineSpecificMedia = hasLineSpecificMediaOptions(lineData);
    const shouldSendQuickRepliesInline = chunks.length === 0 && hasQuickReplies;
    const sendMediaMessages = async () => {
      for (const url of mediaUrls) {
        const trimmed = url?.trim();
        if (!trimmed) {
          continue;
        }
        if (!useLineSpecificMedia) {
          await recordResult(
            (lineRuntime?.sendMessageLine ?? outboundRuntime.sendMessageLine)(to, "", {
              verbose: false,
              mediaUrl: trimmed,
              cfg,
              accountId: accountId ?? undefined,
            }),
          );
          continue;
        }
        const resolved = await resolveLineOutboundMedia(trimmed, {
          mediaKind: lineData.mediaKind,
          previewImageUrl: lineData.previewImageUrl,
          durationMs: lineData.durationMs,
          trackingId: lineData.trackingId,
        });
        await recordResult(
          (lineRuntime?.sendMessageLine ?? outboundRuntime.sendMessageLine)(to, "", {
            verbose: false,
            mediaUrl: resolved.mediaUrl,
            mediaKind: resolved.mediaKind,
            previewImageUrl: resolved.previewImageUrl,
            durationMs: resolved.durationMs,
            trackingId: resolved.trackingId,
            cfg,
            accountId: accountId ?? undefined,
          }),
        );
      }
    };

    if (!shouldSendQuickRepliesInline) {
      if (lineData.flexMessage) {
        const flexContents = lineData.flexMessage.contents as Parameters<typeof sendFlex>[2];
        await recordResult(
          sendFlex(to, lineData.flexMessage.altText, flexContents, {
            verbose: false,
            cfg,
            accountId: accountId ?? undefined,
          }),
        );
      }

      if (lineData.templateMessage) {
        const template = buildTemplate(lineData.templateMessage);
        if (template) {
          await recordResult(
            sendTemplate(to, template, {
              verbose: false,
              cfg,
              accountId: accountId ?? undefined,
            }),
          );
        }
      }

      if (lineData.location) {
        await recordResult(
          sendLocation(to, lineData.location, {
            verbose: false,
            cfg,
            accountId: accountId ?? undefined,
          }),
        );
      }

      for (const flexMsg of processed.flexMessages) {
        const flexContents = flexMsg.contents;
        await recordResult(
          sendFlex(to, flexMsg.altText, flexContents, {
            verbose: false,
            cfg,
            accountId: accountId ?? undefined,
          }),
        );
      }
    }

    const sendMediaAfterText = !(hasQuickReplies && chunks.length > 0);
    if (mediaUrls.length > 0 && !shouldSendQuickRepliesInline && !sendMediaAfterText) {
      await sendMediaMessages();
    }

    if (chunks.length > 0) {
      for (const [i, chunk] of chunks.entries()) {
        const isLast = i === chunks.length - 1;
        if (isLast && hasQuickReplies) {
          await recordResult(
            sendQuickReplies(to, chunk, quickReplies, {
              verbose: false,
              cfg,
              accountId: accountId ?? undefined,
            }),
          );
        } else {
          await recordResult(
            sendText(to, chunk, {
              verbose: false,
              cfg,
              accountId: accountId ?? undefined,
            }),
          );
        }
      }
    } else if (shouldSendQuickRepliesInline) {
      const quickReplyMessages: Array<Record<string, unknown>> = [];
      if (lineData.flexMessage) {
        quickReplyMessages.push({
          type: "flex",
          altText: truncateUtf16Safe(lineData.flexMessage.altText, 400),
          contents: lineData.flexMessage.contents,
        });
      }
      if (lineData.templateMessage) {
        const template = buildTemplate(lineData.templateMessage);
        if (template) {
          quickReplyMessages.push(template);
        }
      }
      if (lineData.location) {
        quickReplyMessages.push({
          type: "location",
          title: truncateUtf16Safe(lineData.location.title, 100),
          address: truncateUtf16Safe(lineData.location.address, 100),
          latitude: lineData.location.latitude,
          longitude: lineData.location.longitude,
        });
      }
      for (const flexMsg of processed.flexMessages) {
        quickReplyMessages.push({
          type: "flex",
          altText: truncateUtf16Safe(flexMsg.altText, 400),
          contents: flexMsg.contents,
        });
      }
      for (const url of mediaUrls) {
        const trimmed = url?.trim();
        if (!trimmed) {
          continue;
        }
        if (!useLineSpecificMedia) {
          quickReplyMessages.push({
            type: "image",
            originalContentUrl: trimmed,
            previewImageUrl: trimmed,
          });
          continue;
        }
        const resolved = await resolveLineOutboundMedia(trimmed, {
          mediaKind: lineData.mediaKind,
          previewImageUrl: lineData.previewImageUrl,
          durationMs: lineData.durationMs,
          trackingId: lineData.trackingId,
        });
        quickReplyMessages.push(
          buildLineMediaMessageObject(resolved, { allowTrackingId: isLineUserTarget(to) }),
        );
      }
      if (quickReplyMessages.length > 0 && quickReply) {
        const lastIndex = quickReplyMessages.length - 1;
        quickReplyMessages[lastIndex] = {
          ...quickReplyMessages[lastIndex],
          quickReply,
        };
        await sendMessageBatch(quickReplyMessages);
      } else if (quickReply) {
        await recordResult(
          sendQuickReplies(to, buildLineQuickReplyFallbackText(quickReplies), quickReplies, {
            verbose: false,
            cfg,
            accountId: accountId ?? undefined,
          }),
        );
      }
    }

    if (mediaUrls.length > 0 && !shouldSendQuickRepliesInline && sendMediaAfterText) {
      await sendMediaMessages();
    }

    const completedResult = lastResult as LineSendResult | null;
    if (completedResult) {
      return createEmptyChannelResult("line", { ...completedResult });
    }
    return createEmptyChannelResult("line", { messageId: "empty", chatId: to });
  },
  ...createAttachedChannelResultAdapter({
    channel: "line",
    sendText: async ({ cfg, to, text, accountId }) => {
      const outboundRuntime = await loadLineOutboundRuntime();
      const sendText = outboundRuntime.pushMessageLine;
      const sendFlex = outboundRuntime.pushFlexMessage;
      const processed = outboundRuntime.processLineMessage(text);
      let result: LineSendResult;
      if (processed.text.trim()) {
        result = await sendText(to, processed.text, {
          verbose: false,
          cfg,
          accountId: accountId ?? undefined,
        });
      } else {
        result = {
          messageId: "processed",
          chatId: to,
          receipt: createLineSendReceipt({ messageId: "processed", chatId: to, kind: "card" }),
        };
      }
      for (const flexMsg of processed.flexMessages) {
        const flexContents = flexMsg.contents;
        await sendFlex(to, flexMsg.altText, flexContents, {
          verbose: false,
          cfg,
          accountId: accountId ?? undefined,
        });
      }
      return result;
    },
    sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) =>
      await (
        await loadLineOutboundRuntime()
      ).sendMessageLine(to, text, {
        verbose: false,
        mediaUrl,
        cfg,
        accountId: accountId ?? undefined,
      }),
  }),
};

function toLineMessageSendResult(
  result: Awaited<ReturnType<NonNullable<typeof lineOutboundAdapter.sendPayload>>>,
  kind: MessageReceiptPartKind,
): ChannelMessageSendResult {
  const source = result as typeof result & { chatId?: string };
  const receipt =
    result.receipt ??
    (result.messageId
      ? createLineSendReceipt({
          messageId: result.messageId,
          chatId: source.chatId ?? "",
          kind,
        })
      : undefined);
  if (!receipt) {
    throw new Error("LINE message adapter send did not return a receipt");
  }
  return {
    messageId: result.messageId || receipt.primaryPlatformMessageId,
    receipt,
  };
}

export const lineMessageAdapter = defineChannelMessageAdapter({
  id: "line",
  durableFinal: {
    capabilities: {
      text: true,
      media: true,
      messageSendingHooks: true,
    },
  },
  send: {
    text: async ({ cfg, to, text, accountId, onDeliveryResult }) => {
      const result = await lineOutboundAdapter.sendPayload!({
        cfg,
        to,
        text,
        accountId,
        payload: { text },
        onDeliveryResult: async (deliveryResult) => {
          await onDeliveryResult?.(toLineMessageSendResult(deliveryResult, "text"));
        },
      });
      return toLineMessageSendResult(result, "text");
    },
    media: async ({ cfg, to, text, mediaUrl, accountId, onDeliveryResult }) => {
      const result = await lineOutboundAdapter.sendPayload!({
        cfg,
        to,
        text,
        mediaUrl,
        accountId,
        payload: { text, mediaUrl },
        onDeliveryResult: async (deliveryResult) => {
          await onDeliveryResult?.(toLineMessageSendResult(deliveryResult, "media"));
        },
      });
      return toLineMessageSendResult(result, "media");
    },
  },
  receive: {
    defaultAckPolicy: "after_receive_record",
    supportedAckPolicies: ["after_receive_record"],
  },
});
