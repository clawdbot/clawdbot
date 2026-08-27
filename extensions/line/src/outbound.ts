import type { messagingApi } from "@line/bot-sdk";
import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
// Line plugin module implements outbound behavior.
import {
  defineChannelMessageAdapter,
  listMessageReceiptPlatformIds,
  type ChannelMessageSendResult,
  type MessageReceiptPartKind,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  createAttachedChannelResultAdapter,
  createEmptyChannelResult,
} from "openclaw/plugin-sdk/channel-send-result";
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { resolveOutboundMediaUrls } from "openclaw/plugin-sdk/reply-payload";
import { sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-chunking";
import {
  buildLineMediaMessage,
  hasLineSpecificMediaOptions,
  resolveLineOutboundMedia,
} from "./outbound-media.js";
import { buildLineQuickReplyFallbackText } from "./quick-reply-fallback.js";
import {
  createLineQuickReply,
  LINE_PRESENTATION_CAPABILITIES,
  renderLineCard,
  renderLinePresentation,
} from "./rich-messages.js";
import { getLineRuntime } from "./runtime.js";
import { createLineSendReceipt } from "./send-receipt.js";
import type { LineChannelData, LineSendResult, ResolvedLineAccount } from "./types.js";

const loadLineOutboundRuntime = createLazyRuntimeModule(() => import("./outbound.runtime.js"));

export const lineOutboundAdapter: NonNullable<ChannelPlugin<ResolvedLineAccount>["outbound"]> = {
  deliveryMode: "direct",
  chunker: (text, limit) => getLineRuntime().channel.text.chunkMarkdownText(text, limit),
  textChunkLimit: 5000,
  sanitizeText: ({ text }) => sanitizeAssistantVisibleText(text),
  presentationCapabilities: LINE_PRESENTATION_CAPABILITIES,
  renderPresentation: ({ payload, presentation }) => renderLinePresentation(payload, presentation),
  sendPayload: async ({ to, payload, accountId, cfg, onDeliveryResult }) => {
    const runtime = getLineRuntime();
    const outboundRuntime = await loadLineOutboundRuntime();
    const rawLineData = (payload.channelData?.line as LineChannelData | undefined) ?? {};
    const lineData =
      rawLineData.card && !rawLineData.flexMessage
        ? { ...rawLineData, flexMessage: renderLineCard(rawLineData.card) }
        : rawLineData;
    const lineRuntime = runtime.channel.line;
    const location = lineData.location;
    const locationMessage = location ? outboundRuntime.createLocationMessage(location) : null;
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
      try {
        await onDeliveryResult?.(createEmptyChannelResult("line", { ...result }));
      } catch (error) {
        // Observers run after provider acceptance; losing this receipt invites duplicate delivery.
        throw createChannelPartialDeliveryError(error, {
          messageIds: listMessageReceiptPlatformIds(result.receipt),
          receipt: result.receipt,
          visibleReplySent: true,
        });
      }
      return result;
    };
    const quickReplies = lineData.quickReplies ?? [];
    const quickReplyItems = lineData.quickReplyItems ?? [];
    const hasQuickReplies = quickReplies.length > 0 || quickReplyItems.length > 0;
    const quickReply = quickReplyItems.length
      ? createLineQuickReply(quickReplyItems)
      : quickReplies.length
        ? (lineRuntime?.createQuickReplyItems ?? outboundRuntime.createQuickReplyItems)(
            quickReplies,
          )
        : undefined;
    const quickReplyLabels = quickReplyItems.length
      ? quickReplyItems.map((item) => item.label)
      : quickReplies;

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

    const sendTextWithQuickReply = async (text: string) => {
      if (quickReplyItems.length > 0 && quickReply) {
        await sendMessageBatch([{ type: "text", text, quickReply }]);
        return;
      }
      await recordResult(
        sendQuickReplies(to, text, quickReplies, {
          verbose: false,
          cfg,
          accountId: accountId ?? undefined,
        }),
      );
    };

    const processed = payload.text
      ? outboundRuntime.processLineMessage(payload.text)
      : { text: "", flexMessages: [] };

    const chunkLimit =
      runtime.channel.text.resolveTextChunkLimit?.(cfg, "line", accountId ?? undefined, {
        fallbackLimit: 5000,
      }) ?? 5000;

    const orderedMessages = processed.segments?.flatMap<
      messagingApi.FlexMessage | messagingApi.TextMessage
    >((segment) =>
      segment.type === "flex"
        ? [segment.message]
        : runtime.channel.text
            .chunkMarkdownText(segment.text, chunkLimit)
            .map((text) => ({ type: "text" as const, text })),
    );
    const chunks = orderedMessages
      ? orderedMessages.flatMap((message) => (message.type === "text" ? [message.text] : []))
      : processed.text
        ? runtime.channel.text.chunkMarkdownText(processed.text, chunkLimit)
        : [];
    const mediaUrls = resolveOutboundMediaUrls(payload);
    const useLineSpecificMedia = hasLineSpecificMediaOptions(lineData);
    const mediaOptions = {
      mediaKind: useLineSpecificMedia ? lineData.mediaKind : ("image" as const),
      previewImageUrl: lineData.previewImageUrl,
      durationMs: lineData.durationMs,
      trackingId: lineData.trackingId,
    };
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
        const resolved = await resolveLineOutboundMedia(trimmed, mediaOptions);
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

      if (location) {
        await recordResult(
          sendLocation(to, location, {
            verbose: false,
            cfg,
            accountId: accountId ?? undefined,
          }),
        );
      }

      if (!orderedMessages) {
        for (const flexMsg of processed.flexMessages) {
          await recordResult(
            sendFlex(to, flexMsg.altText, flexMsg.contents, {
              verbose: false,
              cfg,
              accountId: accountId ?? undefined,
            }),
          );
        }
      }
    }

    const sendMediaAfterText = !(hasQuickReplies && chunks.length > 0);
    if (mediaUrls.length > 0 && !shouldSendQuickRepliesInline && !sendMediaAfterText) {
      await sendMediaMessages();
    }

    if (orderedMessages && !shouldSendQuickRepliesInline) {
      for (const [index, message] of orderedMessages.entries()) {
        const isLast = index === orderedMessages.length - 1;
        if (message.type === "flex") {
          if (isLast && quickReply) {
            await sendMessageBatch([{ ...message, quickReply }]);
          } else {
            await recordResult(
              sendFlex(to, message.altText, message.contents, {
                verbose: false,
                cfg,
                accountId: accountId ?? undefined,
              }),
            );
          }
        } else if (isLast && hasQuickReplies) {
          await sendTextWithQuickReply(message.text);
        } else {
          await recordResult(
            sendText(to, message.text, {
              verbose: false,
              cfg,
              accountId: accountId ?? undefined,
            }),
          );
        }
      }
    } else if (chunks.length > 0) {
      for (const [i, chunk] of chunks.entries()) {
        const isLast = i === chunks.length - 1;
        if (isLast && hasQuickReplies) {
          await sendTextWithQuickReply(chunk);
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
        quickReplyMessages.push(
          outboundRuntime.createFlexMessage(
            lineData.flexMessage.altText,
            lineData.flexMessage.contents as Parameters<
              typeof outboundRuntime.createFlexMessage
            >[1],
          ),
        );
      }
      if (lineData.templateMessage) {
        const template = buildTemplate(lineData.templateMessage);
        if (template) {
          quickReplyMessages.push(template);
        }
      }
      if (locationMessage) {
        quickReplyMessages.push(locationMessage);
      }
      for (const flexMsg of processed.flexMessages) {
        quickReplyMessages.push(
          outboundRuntime.createFlexMessage(flexMsg.altText, flexMsg.contents),
        );
      }
      for (const url of mediaUrls) {
        const trimmed = url?.trim();
        if (!trimmed) {
          continue;
        }
        quickReplyMessages.push(await buildLineMediaMessage(trimmed, mediaOptions, to));
      }
      if (quickReplyMessages.length > 0 && quickReply) {
        const lastIndex = quickReplyMessages.length - 1;
        quickReplyMessages[lastIndex] = {
          ...quickReplyMessages[lastIndex],
          quickReply,
        };
        await sendMessageBatch(quickReplyMessages);
      } else if (quickReply) {
        await sendTextWithQuickReply(buildLineQuickReplyFallbackText(quickReplyLabels));
      }
    }

    if (mediaUrls.length > 0 && !shouldSendQuickRepliesInline && sendMediaAfterText) {
      await sendMediaMessages();
    }

    const completedResult = lastResult as LineSendResult | null;
    if (!completedResult) {
      throw new Error("Message must be non-empty for LINE sends");
    }
    return createEmptyChannelResult("line", { ...completedResult });
  },
  ...createAttachedChannelResultAdapter({
    channel: "line",
    // The payload owner records each physical send before the next fallible step;
    // bypassing it fabricates Flex-only ids and loses partial-delivery evidence.
    sendText: async (ctx) =>
      await lineOutboundAdapter.sendPayload!({
        ...ctx,
        payload: { text: ctx.text },
      }),
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
