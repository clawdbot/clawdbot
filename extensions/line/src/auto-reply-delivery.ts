// Line plugin module implements auto reply delivery behavior.
import { HTTPFetchError, type messagingApi } from "@line/bot-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-chunking";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { FlexContainer } from "./flex-templates.js";
import type { ProcessedLineMessage } from "./markdown-to-line.js";
import { hasLineSpecificMediaOptions } from "./outbound-media.js";
import { buildLineQuickReplyFallbackText } from "./quick-reply-fallback.js";
import type { LineChannelData, LineTemplateMessagePayload } from "./types.js";

type LineAutoReplyDeps = {
  buildTemplateMessageFromPayload: (
    payload: LineTemplateMessagePayload,
  ) => messagingApi.TemplateMessage | null;
  processLineMessage: (text: string) => ProcessedLineMessage;
  chunkMarkdownText: (text: string, limit: number) => string[];
  createQuickReplyItems: (labels: string[]) => messagingApi.QuickReply;
  pushMessagesLine: (
    to: string,
    messages: messagingApi.Message[],
    opts: { cfg: OpenClawConfig; accountId?: string },
  ) => Promise<unknown>;
  createFlexMessage: (altText: string, contents: FlexContainer) => messagingApi.FlexMessage;
  buildMediaMessage: (
    mediaUrl: string,
    opts: Pick<LineChannelData, "mediaKind" | "previewImageUrl" | "durationMs" | "trackingId">,
    target: string,
  ) => Promise<messagingApi.Message>;
  createLocationMessage: (location: {
    title: string;
    address: string;
    latitude: number;
    longitude: number;
  }) => messagingApi.LocationMessage;
  replyMessageLine: (
    replyToken: string,
    messages: messagingApi.Message[],
    opts: { cfg: OpenClawConfig; accountId?: string },
  ) => Promise<unknown>;
  onReplyError?: (err: unknown) => void;
};

type LineAutoReplyDeliveryResult =
  | { status: "delivered"; replyTokenUsed: boolean; visibleReplySent: boolean }
  | { status: "partial"; replyTokenUsed: boolean; visibleReplySent: true; error: Error };

function toLineDeliveryError(error: unknown): Error {
  return error instanceof Error ? error : new Error("LINE message send failed", { cause: error });
}

function getLineHttpError(error: unknown): HTTPFetchError | undefined {
  if (error instanceof HTTPFetchError) {
    return error;
  }
  return error instanceof Error && error.cause instanceof HTTPFetchError ? error.cause : undefined;
}

function markLineVisibleDeliveryError(error: unknown): Error {
  const deliveryError = toLineDeliveryError(error);
  if (Object.isExtensible(deliveryError)) {
    Object.assign(deliveryError, { sentBeforeError: true, visibleReplySent: true });
    return deliveryError;
  }
  const visibleError = new Error("LINE message send failed", {
    cause: deliveryError,
  });
  Object.assign(visibleError, { sentBeforeError: true, visibleReplySent: true });
  return visibleError;
}

export async function deliverLineAutoReply(params: {
  payload: ReplyPayload;
  lineData: LineChannelData;
  to: string;
  replyToken?: string | null;
  replyTokenUsed: boolean;
  accountId?: string;
  cfg: OpenClawConfig;
  textLimit: number;
  deps: LineAutoReplyDeps;
}): Promise<LineAutoReplyDeliveryResult> {
  const { payload, lineData, replyToken, accountId, to, textLimit, deps } = params;
  let replyTokenUsed = params.replyTokenUsed;
  let visibleReplySent = false;

  const sendVisible = async <T>(send: () => Promise<T>): Promise<T> => {
    try {
      const result = await send();
      visibleReplySent = true;
      return result;
    } catch (error) {
      if (visibleReplySent) {
        throw markLineVisibleDeliveryError(error);
      }
      throw error;
    }
  };
  const replyVisible: LineAutoReplyDeps["replyMessageLine"] = (...args) =>
    sendVisible(() => deps.replyMessageLine(...args));
  const failedPushSegments = new WeakMap<
    object,
    {
      allowFailedBatchTextRecovery: boolean;
      failedBatch: messagingApi.Message[];
      unattemptedTail: messagingApi.Message[];
    }
  >();
  const pushLineMessages = async (
    messages: messagingApi.Message[],
    allowFailedBatchTextRecovery: boolean,
    externalTail: messagingApi.Message[] = [],
  ): Promise<void> => {
    if (messages.length === 0) {
      return;
    }
    for (let i = 0; i < messages.length; i += 5) {
      const batch = messages.slice(i, i + 5);
      try {
        await sendVisible(() =>
          deps.pushMessagesLine(to, batch, {
            cfg: params.cfg,
            accountId,
          }),
        );
      } catch (error) {
        if (typeof error === "object" && error !== null) {
          failedPushSegments.set(error, {
            allowFailedBatchTextRecovery,
            failedBatch: batch,
            unattemptedTail: [...messages.slice(i + batch.length), ...externalTail],
          });
        }
        throw error;
      }
    }
  };

  const sendLineMessages = async (
    messages: messagingApi.Message[],
    allowReplyToken: boolean,
  ): Promise<void> => {
    if (messages.length === 0) {
      return;
    }

    let remaining = messages;
    if (allowReplyToken && replyToken && !replyTokenUsed) {
      const replyBatch = remaining.slice(0, 5);
      try {
        await replyVisible(replyToken, replyBatch, {
          cfg: params.cfg,
          accountId,
        });
      } catch (err) {
        deps.onReplyError?.(err);
        // A transport-failed reply may have landed; only a definitive LINE 400
        // makes text recovery after a rejected push fallback safe.
        await pushLineMessages(
          replyBatch,
          getLineHttpError(err)?.status === 400,
          remaining.slice(replyBatch.length),
        );
      } finally {
        // A reply attempt consumes the slot even when its push fallback fails.
        replyTokenUsed = true;
      }
      remaining = remaining.slice(replyBatch.length);
    }

    if (remaining.length > 0) {
      await pushLineMessages(remaining, true);
    }
  };

  const richMessages: messagingApi.Message[] = [];
  const hasQuickReplies = Boolean(lineData.quickReplies?.length);

  if (lineData.flexMessage) {
    richMessages.push(
      deps.createFlexMessage(
        truncateUtf16Safe(lineData.flexMessage.altText, 400),
        lineData.flexMessage.contents as FlexContainer,
      ),
    );
  }

  if (lineData.templateMessage) {
    const templateMsg = deps.buildTemplateMessageFromPayload(lineData.templateMessage);
    if (templateMsg) {
      richMessages.push(templateMsg);
    }
  }

  if (lineData.location) {
    richMessages.push(deps.createLocationMessage(lineData.location));
  }

  // Inbound auto-replies bypass the channel outbound adapter, so enforce the
  // same assistant-visible boundary here before Markdown can create LINE UI.
  const visibleText = payload.text ? sanitizeAssistantVisibleText(payload.text) : "";
  const processed = visibleText
    ? deps.processLineMessage(visibleText)
    : { text: "", flexMessages: [] };

  for (const flexMsg of processed.flexMessages) {
    richMessages.push(
      deps.createFlexMessage(truncateUtf16Safe(flexMsg.altText, 400), flexMsg.contents),
    );
  }

  const chunks = processed.text ? deps.chunkMarkdownText(processed.text, textLimit) : [];

  // Match the push path (outbound.ts): honor channelData.line.mediaKind and the
  // other LINE media options so a reply-token video/audio is not silently
  // downgraded to an image. Generic media stays image-only but still goes
  // through the same validation boundary. A media build failure is partial only
  // after another visible part lands; media-only failures remain full failures.
  const mediaUrls = resolveSendableOutboundReplyParts(payload).mediaUrls;
  const useLineSpecificMedia = hasLineSpecificMediaOptions(lineData);
  const mediaOpts: Parameters<LineAutoReplyDeps["buildMediaMessage"]>[1] = {
    mediaKind: useLineSpecificMedia ? lineData.mediaKind : "image",
    previewImageUrl: lineData.previewImageUrl,
    durationMs: lineData.durationMs,
    trackingId: lineData.trackingId,
  };
  const mediaMessages: messagingApi.Message[] = [];
  let deliveryError: unknown;
  for (const rawUrl of mediaUrls) {
    const url = rawUrl?.trim();
    if (!url) {
      continue;
    }
    try {
      mediaMessages.push(await deps.buildMediaMessage(url, mediaOpts, to));
    } catch (err) {
      deliveryError ??= err;
    }
  }

  const textMessages: messagingApi.Message[] = chunks.map((text) => ({ type: "text", text }));
  const richMediaMessages = [...richMessages, ...mediaMessages];
  if (hasQuickReplies && textMessages.length === 0 && richMediaMessages.length === 0) {
    textMessages.push({
      type: "text",
      text: buildLineQuickReplyFallbackText(lineData.quickReplies),
    });
  }
  if (hasQuickReplies) {
    const targetMessages = textMessages.length > 0 ? textMessages : richMediaMessages;
    const lastIndex = targetMessages.length - 1;
    const target = expectDefined(targetMessages[lastIndex], "last LINE auto-reply message");
    targetMessages[lastIndex] = {
      ...target,
      quickReply: deps.createQuickReplyItems(lineData.quickReplies!),
    };
  }

  // Quick replies disappear when a newer message arrives, so rich/media parts
  // lead and the action-bearing text remains final across reply/push batches.
  const messages = hasQuickReplies
    ? [...richMediaMessages, ...textMessages]
    : [...textMessages, ...richMediaMessages];
  try {
    // A reply token carries five messages without consuming push quota. The
    // canonical batcher owns overflow and reply failure fallback for every payload.
    await sendLineMessages(messages, true);
  } catch (err) {
    deliveryError ??= err;
    const failedSegment =
      typeof err === "object" && err !== null ? failedPushSegments.get(err) : undefined;
    const httpError = getLineHttpError(err);
    const retryCandidates = failedSegment
      ? [
          ...(failedSegment.allowFailedBatchTextRecovery ? failedSegment.failedBatch : []),
          ...failedSegment.unattemptedTail,
        ]
      : [];
    const retryTextMessages = retryCandidates.filter((message) => message.type === "text");
    const quickRepliesNeedCarrier =
      hasQuickReplies && retryCandidates.some((message) => "quickReply" in message);
    const retryMessages =
      retryTextMessages.length > 0
        ? retryTextMessages
        : quickRepliesNeedCarrier
          ? [
              {
                type: "text" as const,
                text: buildLineQuickReplyFallbackText(lineData.quickReplies),
                quickReply: deps.createQuickReplyItems(lineData.quickReplies!),
              },
            ]
          : [];
    const canRetryTextOnly =
      retryMessages.length > 0 &&
      failedSegment?.failedBatch.some((message) => message.type !== "text") &&
      httpError?.status === 400;
    if (canRetryTextOnly) {
      // HTTPFetchError 400 is an actual LINE response: that request was rejected
      // atomically. Retry its text/actions plus the tail that was never attempted.
      try {
        await sendLineMessages(retryMessages, false);
      } catch {
        // Preserve the original rejection as the partial/full delivery cause.
      }
    }
  }

  if (deliveryError !== undefined) {
    if (!visibleReplySent) {
      // No user-visible content landed, so this is a full delivery failure.
      // Throwing lets the caller surface or replace it instead of recording a
      // successful empty reply.
      throw toLineDeliveryError(deliveryError);
    }
    // Other visible content landed; preserve that evidence so downstream
    // recovery does not replay text the user already saw.
    return {
      status: "partial",
      replyTokenUsed,
      visibleReplySent: true,
      error: markLineVisibleDeliveryError(deliveryError),
    };
  }

  return { status: "delivered", replyTokenUsed, visibleReplySent };
}
