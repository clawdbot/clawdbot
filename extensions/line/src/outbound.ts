import type { messagingApi } from "@line/bot-sdk";
import {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
// Line plugin module implements outbound behavior.
import {
  createChannelMessageAdapterFromOutbound,
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter,
  listMessageReceiptPlatformIds,
  type ChannelMessageUnknownSendContext,
  type ChannelMessageUnknownSendReconciliationResult,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  createAttachedChannelResultAdapter,
  createEmptyChannelResult,
  type OutboundDeliveryResult,
} from "openclaw/plugin-sdk/channel-send-result";
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import {
  formatErrorMessage,
  PlatformMessageNotDispatchedError,
} from "openclaw/plugin-sdk/error-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { resolveOutboundMediaUrls } from "openclaw/plugin-sdk/reply-payload";
import { sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-chunking";
import {
  clearLineDurableSendPlans,
  createLineDurablePushRecorder,
  LineDurableSendPlanError,
  loadLineDurableSendPlans,
} from "./durable-send-plan.js";
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
import { LINE_RETRY_KEY_TTL_MS, resolveLineNonDispatchRetryable } from "./send-retry.js";
import type { LineChannelData, LineSendResult, ResolvedLineAccount } from "./types.js";

const loadLineOutboundRuntime = createLazyRuntimeModule(() => import("./outbound.runtime.js"));

/** One payload crosses the platform boundary once, however many pushes it fans out into. */
function createDispatchOnce(onPlatformSendDispatch?: () => Promise<void>): () => Promise<void> {
  let dispatched = false;
  return async () => {
    if (dispatched) {
      return;
    }
    await onPlatformSendDispatch?.();
    dispatched = true;
  };
}

export const lineOutboundAdapter: NonNullable<ChannelPlugin<ResolvedLineAccount>["outbound"]> = {
  deliveryMode: "direct",
  chunker: (text, limit) => getLineRuntime().channel.text.chunkMarkdownText(text, limit),
  textChunkLimit: 5000,
  sanitizeText: ({ text }) => sanitizeAssistantVisibleText(text),
  presentationCapabilities: LINE_PRESENTATION_CAPABILITIES,
  renderPresentation: ({ payload, presentation }) => renderLinePresentation(payload, presentation),
  sendPayload: async ({
    to,
    payload,
    accountId,
    cfg,
    deliveryQueueId,
    deliveryPartIndex,
    deliveryPartCount,
    onPlatformSendDispatch,
    onDeliveryResult,
  }) => {
    const runtime = getLineRuntime();
    // Each platform send inside one durable delivery keeps a stable retry key, so a
    // recovery replay is deduplicated by LINE push for push instead of resending.
    // Core owns the part index; this payload owns the pushes it fans out into.
    let durablePushIndex = 0;
    const dispatchOnce = onPlatformSendDispatch
      ? createDispatchOnce(onPlatformSendDispatch)
      : undefined;
    const recorder = deliveryQueueId
      ? createLineDurablePushRecorder({
          queueId: deliveryQueueId,
          partIndex: deliveryPartIndex ?? 0,
          partCount: deliveryPartCount ?? 1,
          to,
          ...(accountId ? { accountId } : {}),
          payload,
        })
      : undefined;
    const nextDurableSend = () => ({
      ...(dispatchOnce ? { onPlatformSendDispatch: dispatchOnce } : {}),
      ...(recorder ? { onDurablePush: recorder.recordPush } : {}),
      ...(deliveryQueueId
        ? {
            durableSend: {
              deliveryQueueId,
              partIndex: deliveryPartIndex ?? 0,
              pushIndex: durablePushIndex++,
            },
          }
        : {}),
    });
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
    const sendOptions = { verbose: false, cfg, accountId: accountId ?? undefined };

    let lastResult: LineSendResult | null = null;
    const recordResult = async (
      resultPromise: Promise<LineSendResult>,
    ): Promise<LineSendResult> => {
      let result: LineSendResult;
      try {
        result = await resultPromise;
      } catch (error) {
        const retryable = isChannelPartialDeliveryError(error)
          ? undefined
          : resolveLineNonDispatchRetryable(error);
        // Nothing has been accepted yet for this payload, so a LINE client error
        // proves the whole delivery was rejected rather than left ambiguous.
        // Once a send has landed the failure is partial and keeps its own shape.
        throw lastResult === null && retryable !== undefined
          ? new PlatformMessageNotDispatchedError(
              error instanceof Error ? error.message : "LINE rejected the message",
              { cause: error, retryable },
            )
          : error;
      }
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
        await recordResult(sendBatch(to, batch, { ...sendOptions, ...nextDurableSend() }));
      }
    };

    const sendTextWithQuickReply = async (text: string) => {
      if (quickReplyItems.length > 0 && quickReply) {
        await sendMessageBatch([{ type: "text", text, quickReply }]);
        return;
      }
      await recordResult(
        sendQuickReplies(to, text, quickReplies, { ...sendOptions, ...nextDurableSend() }),
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
              ...sendOptions,
              ...nextDurableSend(),
              mediaUrl: trimmed,
            }),
          );
          continue;
        }
        const resolved = await resolveLineOutboundMedia(trimmed, mediaOptions);
        await recordResult(
          (lineRuntime?.sendMessageLine ?? outboundRuntime.sendMessageLine)(to, "", {
            ...sendOptions,
            ...nextDurableSend(),
            mediaUrl: resolved.mediaUrl,
            mediaKind: resolved.mediaKind,
            previewImageUrl: resolved.previewImageUrl,
            durationMs: resolved.durationMs,
            trackingId: resolved.trackingId,
          }),
        );
      }
    };

    if (!shouldSendQuickRepliesInline) {
      if (lineData.flexMessage) {
        const flexContents = lineData.flexMessage.contents as Parameters<typeof sendFlex>[2];
        await recordResult(
          sendFlex(to, lineData.flexMessage.altText, flexContents, {
            ...sendOptions,
            ...nextDurableSend(),
          }),
        );
      }

      if (lineData.templateMessage) {
        const template = buildTemplate(lineData.templateMessage);
        if (template) {
          await recordResult(sendTemplate(to, template, { ...sendOptions, ...nextDurableSend() }));
        }
      }

      if (location) {
        await recordResult(sendLocation(to, location, { ...sendOptions, ...nextDurableSend() }));
      }

      if (!orderedMessages) {
        for (const flexMsg of processed.flexMessages) {
          await recordResult(
            sendFlex(to, flexMsg.altText, flexMsg.contents, {
              ...sendOptions,
              ...nextDurableSend(),
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
                ...sendOptions,
                ...nextDurableSend(),
              }),
            );
          }
        } else if (isLast && hasQuickReplies) {
          await sendTextWithQuickReply(message.text);
        } else {
          await recordResult(sendText(to, message.text, { ...sendOptions, ...nextDurableSend() }));
        }
      }
    } else if (chunks.length > 0) {
      for (const [i, chunk] of chunks.entries()) {
        const isLast = i === chunks.length - 1;
        if (isLast && hasQuickReplies) {
          await sendTextWithQuickReply(chunk);
        } else {
          await recordResult(sendText(to, chunk, { ...sendOptions, ...nextDurableSend() }));
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

    // Checked before the emptiness guard so a replay that rendered fewer pushes
    // than it recorded reports that, rather than an unrelated empty-payload error.
    await recorder?.assertRecordFullyReplayed();
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
    // Media rides the same payload owner as text: it is the only path that records
    // every push of the fan-out, and splitting it would let the two routes drift.
    sendMedia: async (ctx) =>
      await lineOutboundAdapter.sendPayload!({
        ...ctx,
        payload: { text: ctx.text, mediaUrl: ctx.mediaUrl },
      }),
  }),
};

/**
 * LINE has no read-only "was this accepted?" endpoint, so reconciliation reissues
 * the requests the interrupted send recorded, under the very keys it used: a push
 * LINE already accepted answers 409 with its original receipt, and one that never
 * landed is delivered now. Nothing is re-derived, because the live send and this
 * replay would not enumerate the same pushes from the payload alone.
 */
async function reconcileLineUnknownSend(
  ctx: ChannelMessageUnknownSendContext,
): Promise<ChannelMessageUnknownSendReconciliationResult> {
  const sendStartedAt = ctx.platformSendStartedAt ?? ctx.enqueuedAt;
  if (Date.now() - sendStartedAt >= LINE_RETRY_KEY_TTL_MS) {
    // LINE forgets a retry key after 24 hours, so a replay would deliver a second copy.
    return {
      status: "unresolved",
      error: "LINE retry key expired before the queued send could be reconciled",
      retryable: false,
    };
  }
  let plans: Awaited<ReturnType<typeof loadLineDurableSendPlans>>;
  try {
    plans = await loadLineDurableSendPlans(ctx.queueId);
  } catch (error) {
    // Incomplete evidence is fail-closed on purpose: replaying part of a record
    // would either duplicate an accepted push or drop one LINE never received.
    return {
      status: "unresolved",
      error: formatErrorMessage(error),
      retryable: !(error instanceof LineDurableSendPlanError),
    };
  }
  if (plans.length === 0) {
    // No push was recorded, so none reached LINE and the queued delivery can be
    // replayed from the start without duplicating anything.
    return { status: "not_sent" };
  }
  // One payload can fan out into several platform sends, and the settled queue
  // entry must carry the identity of every one of them. Collecting per push is
  // what the live path does through this same observer; the payload's return
  // value only carries its final send.
  const results: OutboundDeliveryResult[] = [];
  for (const plan of plans) {
    try {
      await lineOutboundAdapter.sendPayload!({
        cfg: ctx.cfg,
        to: plan.to,
        text: plan.payload.text ?? "",
        payload: plan.payload,
        ...(plan.accountId === undefined ? {} : { accountId: plan.accountId }),
        deliveryQueueId: ctx.queueId,
        deliveryPartIndex: plan.partIndex,
        deliveryPartCount: plan.partCount,
        onDeliveryResult: (result) => {
          results.push(result);
        },
      });
    } catch (error) {
      // Reuses the send owner's classification rather than re-reading the status
      // here: it is the one place that knows a 429 stays retryable, a 408 stays
      // ambiguous, and a retry-key 409 is an accepted delivery, not a refusal.
      const nonDispatchRetryable = resolveLineNonDispatchRetryable(error);
      if (results.length === 0 && nonDispatchRetryable === false) {
        // LINE refused this exact request outright, so the first push could not
        // have been accepted on the interrupted attempt either.
        return { status: "not_sent" };
      }
      return {
        status: "unresolved",
        error: formatErrorMessage(error),
        // An ambiguous failure stays retryable: the derived retry key makes a
        // replay safe for 24 hours even if the interrupted attempt did land.
        retryable: !(error instanceof LineDurableSendPlanError) && (nonDispatchRetryable ?? true),
      };
    }
  }
  const receipt = createMessageReceiptFromOutboundResults({
    results,
    ...(ctx.threadId == null ? {} : { threadId: String(ctx.threadId) }),
    ...(ctx.effectiveReplyToId ? { replyToId: ctx.effectiveReplyToId } : {}),
  });
  return {
    status: "sent",
    ...(receipt.primaryPlatformMessageId ? { messageId: receipt.primaryPlatformMessageId } : {}),
    receipt,
  };
}

// The bridge forwards the send context verbatim. Rebuilding it by hand drops the
// durable send seam core installed there, and an adapter that never reports its
// platform dispatch cannot be reconciled after a crash.
const lineMessageAdapterBase = createChannelMessageAdapterFromOutbound({
  id: "line",
  outbound: lineOutboundAdapter,
  capabilities: {
    text: true,
    media: true,
    payload: true,
    messageSendingHooks: true,
    reconcileUnknownSend: true,
  },
  receive: {
    defaultAckPolicy: "after_receive_record",
    supportedAckPolicies: ["after_receive_record"],
  },
});

export const lineMessageAdapter = defineChannelMessageAdapter({
  ...lineMessageAdapterBase,
  durableFinal: {
    ...lineMessageAdapterBase.durableFinal,
    capabilities: { ...lineMessageAdapterBase.durableFinal?.capabilities, afterCommit: true },
    // Every platform send inside one payload carries its own durable key, so a
    // replay resolves each push independently instead of resending the batch.
    reconcileUnknownSendKinds: { text: true, media: true, payload: true },
    reconcileUnknownSend: reconcileLineUnknownSend,
    afterUnknownSendTerminal: async (ctx) => await clearLineDurableSendPlans(ctx.queueId),
  },
  send: {
    ...lineMessageAdapterBase.send,
    lifecycle: {
      // Recorded requests exist only to answer a replay. Once the delivery is
      // committed no replay can need them, so the content does not linger.
      afterCommit: async (ctx) => {
        if (ctx.deliveryQueueId) {
          await clearLineDurableSendPlans(ctx.deliveryQueueId);
        }
      },
    },
  },
});
