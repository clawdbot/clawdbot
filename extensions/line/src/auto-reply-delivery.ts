// Line plugin module implements auto reply delivery behavior.
import type { messagingApi } from "@line/bot-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-chunking";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { FlexContainer } from "./flex-templates.js";
import type { ProcessedLineMessage } from "./markdown-to-line.js";
import { hasLineSpecificMediaOptions } from "./outbound-media.js";
import { buildLineQuickReplyFallbackText } from "./quick-reply-fallback.js";
import type { SendLineReplyChunksParams } from "./reply-chunks.js";
import type { LineChannelData, LineTemplateMessagePayload } from "./types.js";

type LineAutoReplyDeps = {
  buildTemplateMessageFromPayload: (
    payload: LineTemplateMessagePayload,
  ) => messagingApi.TemplateMessage | null;
  processLineMessage: (text: string) => ProcessedLineMessage;
  chunkMarkdownText: (text: string, limit: number) => string[];
  sendLineReplyChunks: (params: SendLineReplyChunksParams) => Promise<{ replyTokenUsed: boolean }>;
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
} & Pick<
  SendLineReplyChunksParams,
  | "replyMessageLine"
  | "pushMessageLine"
  | "pushTextMessageWithQuickReplies"
  | "createTextMessageWithQuickReplies"
  | "onReplyError"
>;

type LineAutoReplyDeliveryResult =
  | { status: "delivered"; replyTokenUsed: boolean; visibleReplySent: boolean }
  | { status: "partial"; replyTokenUsed: boolean; visibleReplySent: true; error: Error };

function toLineDeliveryError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("LINE rich or media message send failed", { cause: error });
}

function markLineVisibleDeliveryError(error: unknown): Error {
  const deliveryError = toLineDeliveryError(error);
  if (Object.isExtensible(deliveryError)) {
    Object.assign(deliveryError, { sentBeforeError: true, visibleReplySent: true });
    return deliveryError;
  }
  const visibleError = new Error("LINE rich or media message send failed", {
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
  const pushTextVisible: LineAutoReplyDeps["pushMessageLine"] = (...args) =>
    sendVisible(() => deps.pushMessageLine(...args));
  const pushQuickRepliesVisible: LineAutoReplyDeps["pushTextMessageWithQuickReplies"] = (...args) =>
    sendVisible(() => deps.pushTextMessageWithQuickReplies(...args));

  const pushLineMessages = async (messages: messagingApi.Message[]): Promise<void> => {
    if (messages.length === 0) {
      return;
    }
    for (let i = 0; i < messages.length; i += 5) {
      await sendVisible(() =>
        deps.pushMessagesLine(to, messages.slice(i, i + 5), {
          cfg: params.cfg,
          accountId,
        }),
      );
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
        await pushLineMessages(replyBatch);
      }
      replyTokenUsed = true;
      remaining = remaining.slice(replyBatch.length);
    }

    if (remaining.length > 0) {
      await pushLineMessages(remaining);
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
  let richMediaError: unknown;
  for (const rawUrl of mediaUrls) {
    const url = rawUrl?.trim();
    if (!url) {
      continue;
    }
    try {
      mediaMessages.push(await deps.buildMediaMessage(url, mediaOpts, to));
    } catch (err) {
      richMediaError ??= err;
    }
  }

  if (chunks.length > 0) {
    const hasRichOrMedia = richMessages.length > 0 || mediaMessages.length > 0;
    // Quick replies attach to the trailing message, so when both are present the
    // rich/media bubbles must go out before the quick-reply text. Capture a
    // failure instead of swallowing it: the text still sends below, but a lost
    // rich/media bubble must surface as a partial delivery, not silent success.
    const sendRichBeforeText = hasQuickReplies && hasRichOrMedia;
    if (sendRichBeforeText) {
      try {
        await sendLineMessages([...richMessages, ...mediaMessages], false);
      } catch (err) {
        richMediaError ??= err;
      }
    }
    const { replyTokenUsed: nextReplyTokenUsed } = await deps.sendLineReplyChunks({
      to,
      chunks,
      quickReplies: lineData.quickReplies,
      replyToken,
      replyTokenUsed,
      cfg: params.cfg,
      accountId,
      replyMessageLine: replyVisible,
      pushMessageLine: pushTextVisible,
      pushTextMessageWithQuickReplies: pushQuickRepliesVisible,
      createTextMessageWithQuickReplies: deps.createTextMessageWithQuickReplies,
      onReplyError: deps.onReplyError,
    });
    replyTokenUsed = nextReplyTokenUsed;
    if (!sendRichBeforeText) {
      try {
        await sendLineMessages(richMessages, false);
        if (mediaMessages.length > 0) {
          await sendLineMessages(mediaMessages, false);
        }
      } catch (err) {
        richMediaError ??= err;
      }
    }
  } else {
    const combined = [...richMessages, ...mediaMessages];
    if (hasQuickReplies && combined.length === 0) {
      const { replyTokenUsed: nextReplyTokenUsed } = await deps.sendLineReplyChunks({
        to,
        chunks: [buildLineQuickReplyFallbackText(lineData.quickReplies)],
        quickReplies: lineData.quickReplies,
        replyToken,
        replyTokenUsed,
        cfg: params.cfg,
        accountId,
        replyMessageLine: replyVisible,
        pushMessageLine: pushTextVisible,
        pushTextMessageWithQuickReplies: pushQuickRepliesVisible,
        createTextMessageWithQuickReplies: deps.createTextMessageWithQuickReplies,
        onReplyError: deps.onReplyError,
      });
      replyTokenUsed = nextReplyTokenUsed;
    } else {
      if (hasQuickReplies && combined.length > 0) {
        const quickReply = deps.createQuickReplyItems(lineData.quickReplies!);
        const targetIndex =
          replyToken && !replyTokenUsed ? Math.min(4, combined.length - 1) : combined.length - 1;
        const target = combined[targetIndex] as messagingApi.Message & {
          quickReply?: messagingApi.QuickReply;
        };
        combined[targetIndex] = { ...target, quickReply };
      }
      await sendLineMessages(combined, true);
    }
  }

  if (richMediaError !== undefined) {
    if (!visibleReplySent) {
      // No user-visible content landed, so this is a full delivery failure.
      // Throwing lets the caller surface or replace it instead of recording a
      // successful empty reply.
      throw toLineDeliveryError(richMediaError);
    }
    // Other visible content landed; preserve that evidence so downstream
    // recovery does not replay text the user already saw.
    return {
      status: "partial",
      replyTokenUsed,
      visibleReplySent: true,
      error: markLineVisibleDeliveryError(richMediaError),
    };
  }

  return { status: "delivered", replyTokenUsed, visibleReplySent };
}
