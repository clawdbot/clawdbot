// Feishu plugin module implements outbound behavior.
import path from "node:path";
import {
  attachChannelToResult,
  createAttachedChannelResultAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import type { MessagePresentationBlock } from "openclaw/plugin-sdk/interactive-runtime";
import {
  interactiveReplyToPresentation,
  normalizeInteractiveReply,
  normalizeMessagePresentation,
  renderMessagePresentationFallbackText,
  resolveInteractiveTextFallback,
} from "openclaw/plugin-sdk/interactive-runtime";
import {
  resolvePayloadMediaUrls,
  sendPayloadMediaSequenceAndFinalize,
  sendTextMediaPayload,
} from "openclaw/plugin-sdk/reply-payload";
import { statRegularFileSync } from "openclaw/plugin-sdk/security-runtime";
import {
  isRecord,
  normalizeLowercaseStringOrEmpty,
  normalizeStringEntries,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { cleanupAmbientCommentTypingReaction } from "./comment-reaction.js";
import { parseFeishuCommentTarget } from "./comment-target.js";
import { deliverCommentThreadText } from "./drive.js";
import { resolveFeishuIdentityHeaderTitle } from "./identity-header.js";
import {
  sendMediaFeishu,
  shouldSuppressFeishuTextForVoiceMedia,
  type SendMediaResult,
} from "./media.js";
import {
  readNativeFeishuCardJson,
  resolveFeishuCardTemplate,
  sanitizeNativeFeishuCard,
} from "./native-card.js";
import { chunkTextForOutbound, type ChannelOutboundAdapter } from "./outbound-runtime-api.js";
import { buildFeishuPresentationCardElements } from "./presentation-card.js";
import {
  sendCardFeishu,
  sendMarkdownCardFeishu,
  sendMessageFeishu,
  sendStructuredCardFeishu,
} from "./send.js";

const RENDERED_FEISHU_CARD = Symbol("openclaw.renderedFeishuCard");

function normalizePossibleLocalImagePath(text: string | undefined): string | null {
  const raw = text?.trim();
  if (!raw) {
    return null;
  }

  // Only auto-convert when the message is a pure path-like payload.
  // Avoid converting regular sentences that merely contain a path.
  const hasWhitespace = /\s/.test(raw);
  if (hasWhitespace) {
    return null;
  }

  // Ignore links/data URLs; those should stay in normal mediaUrl/text paths.
  if (/^(https?:\/\/|data:|file:\/\/)/i.test(raw)) {
    return null;
  }

  const ext = normalizeLowercaseStringOrEmpty(path.extname(raw));
  const isImageExt = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".ico", ".tiff"].includes(
    ext,
  );
  if (!isImageExt) {
    return null;
  }

  if (!path.isAbsolute(raw)) {
    return null;
  }
  try {
    const stat = statRegularFileSync(raw);
    if (stat.missing) {
      return null;
    }
  } catch {
    return null;
  }

  return raw;
}

function shouldUseCard(text: string): boolean {
  return /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text);
}

function markRenderedFeishuCard(card: Record<string, unknown>): Record<string, unknown> {
  Object.defineProperty(card, RENDERED_FEISHU_CARD, {
    value: true,
    enumerable: false,
  });
  return card;
}

function readNativeFeishuCard(payload: { channelData?: Record<string, unknown> }) {
  const feishuData = payload.channelData?.feishu;
  if (!isRecord(feishuData)) {
    return undefined;
  }
  const card = feishuData.card ?? feishuData.interactiveCard;
  if (!isRecord(card)) {
    return undefined;
  }
  if ((card as { [RENDERED_FEISHU_CARD]?: true })[RENDERED_FEISHU_CARD] === true) {
    return card;
  }
  const sanitizedCard = sanitizeNativeFeishuCard(card);
  return sanitizedCard ? markRenderedFeishuCard(sanitizedCard) : undefined;
}

function buildFeishuPayloadCard(params: {
  payload: Parameters<NonNullable<ChannelOutboundAdapter["sendPayload"]>>[0]["payload"];
  text?: string;
  identity?: Parameters<NonNullable<ChannelOutboundAdapter["sendPayload"]>>[0]["identity"];
}): Record<string, unknown> | undefined {
  const nativeCard = readNativeFeishuCard(params.payload);
  if (nativeCard) {
    return nativeCard;
  }

  const rawText = params.text ?? params.payload.text;
  const textCard = readNativeFeishuCardJson(rawText);
  const interactive = normalizeInteractiveReply(params.payload.interactive);
  const presentation =
    normalizeMessagePresentation(params.payload.presentation) ??
    (interactive ? interactiveReplyToPresentation(interactive) : undefined);
  if (!presentation && !interactive) {
    return textCard ? markRenderedFeishuCard(textCard) : undefined;
  }

  const text = textCard
    ? undefined
    : resolveInteractiveTextFallback({
        text: rawText,
        interactive,
      });
  const elements = presentation
    ? buildFeishuPresentationCardElements({ presentation, fallbackText: text })
    : [
        {
          tag: "markdown",
          content: renderMessagePresentationFallbackText({ text, presentation }),
        },
      ];

  const identityTitle = resolveFeishuIdentityHeaderTitle(params.identity);
  const title = presentation?.title ?? identityTitle;
  const template = resolveFeishuCardTemplate(
    presentation?.tone === "danger"
      ? "red"
      : presentation?.tone === "warning"
        ? "orange"
        : presentation?.tone === "success"
          ? "green"
          : "blue",
  );

  return markRenderedFeishuCard({
    schema: "2.0",
    config: { width_mode: "fill" },
    ...(title
      ? {
          header: {
            title: { tag: "plain_text", content: title },
            template: template ?? "blue",
          },
        }
      : {}),
    body: { elements },
  });
}

// Keep this aligned with the shared fallback renderer: guidance is valid only
// when the fallback text exposes a command the user can copy.
function hasVisibleFallbackCommand(
  blocks: readonly MessagePresentationBlock[] | undefined,
): boolean {
  return (
    blocks?.some(
      (block) =>
        block.type === "buttons" &&
        block.buttons.some(
          (button) =>
            !button.disabled &&
            button.action?.type === "command" &&
            !button.url &&
            !button.webApp?.url &&
            !button.web_app?.url,
        ),
    ) ?? false
  );
}

function renderFeishuPresentationPayload({
  payload,
  presentation,
  ctx,
}: Parameters<NonNullable<ChannelOutboundAdapter["renderPresentation"]>>[0]) {
  const card = buildFeishuPayloadCard({
    payload,
    text: payload.text,
    identity: ctx.identity,
  });
  if (!card) {
    return null;
  }
  const existingFeishuData = isRecord(payload.channelData?.feishu)
    ? payload.channelData.feishu
    : undefined;
  // Core consumes presentation before sendPayload; carry the fallback fact.
  const fallbackHasCommand = hasVisibleFallbackCommand(presentation?.blocks);
  return {
    ...payload,
    text: renderMessagePresentationFallbackText({ text: payload.text, presentation }),
    channelData: {
      ...payload.channelData,
      feishu: {
        ...existingFeishuData,
        card,
        ...(fallbackHasCommand ? { fallbackHasCommand: true } : {}),
      },
    },
  };
}

type FeishuReplyMode =
  | { replyToMessageId: string; replyInThread: false }
  | { replyToMessageId: string; replyInThread: true }
  | { replyToMessageId: undefined; replyInThread: false };

// Target selection and thread mode are one decision; all payload parts reuse this result.
function resolveFeishuReplyMode(params: {
  replyToId?: string | null;
  threadId?: string | number | null;
}): FeishuReplyMode {
  const replyToMessageId = params.replyToId?.trim();
  if (replyToMessageId) {
    return { replyToMessageId, replyInThread: false };
  }

  const threadId = params.threadId == null ? undefined : String(params.threadId).trim();
  return threadId
    ? { replyToMessageId: threadId, replyInThread: true }
    : { replyToMessageId: undefined, replyInThread: false };
}

async function sendCommentThreadReply(params: {
  cfg: Parameters<typeof sendMessageFeishu>[0]["cfg"];
  to: string;
  text: string;
  replyId?: string;
  accountId?: string;
}) {
  const target = parseFeishuCommentTarget(params.to);
  if (!target) {
    return null;
  }
  const account = resolveFeishuAccount({ cfg: params.cfg, accountId: params.accountId });
  const client = createFeishuClient(account);
  const replyId = params.replyId?.trim();
  try {
    const result = await deliverCommentThreadText(client, {
      file_token: target.fileToken,
      file_type: target.fileType,
      comment_id: target.commentId,
      content: params.text,
    });
    return {
      messageId:
        (typeof result.reply_id === "string" && result.reply_id) ||
        (typeof result.comment_id === "string" && result.comment_id) ||
        "",
      chatId: target.commentId,
      result,
    };
  } finally {
    if (replyId) {
      void cleanupAmbientCommentTypingReaction({
        client,
        deliveryContext: {
          channel: "feishu",
          to: params.to,
          threadId: replyId,
        },
      });
    }
  }
}

async function sendOutboundText(params: {
  cfg: Parameters<typeof sendMessageFeishu>[0]["cfg"];
  to: string;
  text: string;
  replyToMessageId?: string;
  replyInThread?: boolean;
  accountId?: string;
}) {
  const { cfg, to, text, accountId, replyToMessageId, replyInThread } = params;
  const commentResult = await sendCommentThreadReply({
    cfg,
    to,
    text,
    replyId: replyToMessageId,
    accountId,
  });
  if (commentResult) {
    return commentResult;
  }

  const account = resolveFeishuAccount({ cfg, accountId });
  const renderMode = account.config?.renderMode ?? "auto";

  if (renderMode === "card" || (renderMode === "auto" && shouldUseCard(text))) {
    return sendMarkdownCardFeishu({
      cfg,
      to,
      text,
      accountId,
      replyToMessageId,
      replyInThread,
    });
  }

  return sendMessageFeishu({ cfg, to, text, accountId, replyToMessageId, replyInThread });
}

export const feishuOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: chunkTextForOutbound,
  chunkerMode: "markdown",
  textChunkLimit: 4000,
  presentationCapabilities: {
    supported: true,
    buttons: true,
    selects: false,
    context: true,
    divider: true,
    limits: {
      actions: {
        maxActions: 20,
        maxActionsPerRow: 5,
        maxLabelLength: 40,
        maxValueBytes: 1024,
      },
      text: {
        maxLength: 4000,
        encoding: "characters",
        markdownDialect: "markdown",
      },
    },
  },
  renderPresentation: renderFeishuPresentationPayload,
  sendPayload: async (ctx) => {
    const card = buildFeishuPayloadCard({
      payload: ctx.payload,
      text: ctx.text,
      identity: ctx.identity,
    });
    if (!card) {
      return await sendTextMediaPayload({
        channel: "feishu",
        ctx,
        adapter: feishuOutbound,
      });
    }

    const { replyToMessageId, replyInThread } = resolveFeishuReplyMode({
      replyToId: ctx.replyToId,
      threadId: ctx.threadId,
    });
    const commentTarget = parseFeishuCommentTarget(ctx.to);
    if (commentTarget) {
      const normalizedPresentation =
        normalizeMessagePresentation(ctx.payload.presentation) ??
        (() => {
          const interactive = normalizeInteractiveReply(ctx.payload.interactive);
          return interactive ? interactiveReplyToPresentation(interactive) : undefined;
        })();
      // Structured content replaces raw card JSON; document comments should
      // render only the usable text fallback instead of exposing both forms.
      const fallbackSourceText =
        normalizedPresentation && readNativeFeishuCardJson(ctx.payload.text)
          ? undefined
          : ctx.payload.text;
      const presentationFallbackText = renderMessagePresentationFallbackText({
        text: fallbackSourceText,
        presentation: normalizedPresentation,
      });
      // Direct delivery retains blocks; core-rendered delivery carries the fact.
      const fallbackHasCommand =
        hasVisibleFallbackCommand(normalizedPresentation?.blocks) ||
        (isRecord(ctx.payload.channelData?.feishu) &&
          ctx.payload.channelData.feishu.fallbackHasCommand === true);
      const text = fallbackHasCommand
        ? `${presentationFallbackText}\n\n> Interactive buttons are unavailable in Feishu document comments. You can type the command shown above manually.`
        : presentationFallbackText;

      return await sendTextMediaPayload({
        channel: "feishu",
        ctx: {
          ...ctx,
          payload: {
            ...ctx.payload,
            text,
            interactive: undefined,
            presentation: undefined,
            channelData: undefined,
          },
        },
        adapter: feishuOutbound,
      });
    }

    const mediaUrls = normalizeStringEntries(resolvePayloadMediaUrls(ctx.payload));
    return attachChannelToResult(
      "feishu",
      await sendPayloadMediaSequenceAndFinalize<
        SendMediaResult,
        Awaited<ReturnType<typeof sendCardFeishu>>
      >({
        text: ctx.payload.text ?? "",
        mediaUrls,
        onResult: async (deliveryResult) => {
          await ctx.onDeliveryResult?.(attachChannelToResult("feishu", deliveryResult));
        },
        send: async ({ mediaUrl }) =>
          await sendMediaFeishu({
            cfg: ctx.cfg,
            to: ctx.to,
            mediaUrl,
            accountId: ctx.accountId ?? undefined,
            mediaLocalRoots: ctx.mediaLocalRoots,
            replyToMessageId,
            replyInThread,
            ...(ctx.payload.audioAsVoice === true || ctx.audioAsVoice === true
              ? { audioAsVoice: true }
              : {}),
          }),
        finalize: async () =>
          await sendCardFeishu({
            cfg: ctx.cfg,
            to: ctx.to,
            card,
            replyToMessageId,
            replyInThread,
            accountId: ctx.accountId ?? undefined,
          }),
      }),
    );
  },
  ...createAttachedChannelResultAdapter({
    channel: "feishu",
    sendText: async ({
      cfg,
      to,
      text,
      accountId,
      replyToId,
      threadId,
      mediaLocalRoots,
      identity,
    }) => {
      const { replyToMessageId, replyInThread } = resolveFeishuReplyMode({
        replyToId,
        threadId,
      });
      // Scheme A compatibility shim:
      // when upstream accidentally returns a local image path as plain text,
      // auto-upload and send as Feishu image message instead of leaking path text.
      const localImagePath = normalizePossibleLocalImagePath(text);
      if (localImagePath) {
        try {
          return await sendMediaFeishu({
            cfg,
            to,
            mediaUrl: localImagePath,
            accountId: accountId ?? undefined,
            replyToMessageId,
            replyInThread,
            mediaLocalRoots,
          });
        } catch (err) {
          console.error(`[feishu] local image path auto-send failed:`, err);
          // fall through to plain text as last resort
        }
      }

      if (parseFeishuCommentTarget(to)) {
        return await sendOutboundText({
          cfg,
          to,
          text,
          accountId: accountId ?? undefined,
          replyToMessageId,
          replyInThread,
        });
      }

      const card = readNativeFeishuCardJson(text);
      if (card) {
        return await sendCardFeishu({
          cfg,
          to,
          card: markRenderedFeishuCard(card),
          accountId: accountId ?? undefined,
          replyToMessageId,
          replyInThread,
        });
      }

      const account = resolveFeishuAccount({ cfg, accountId: accountId ?? undefined });
      const renderMode = account.config?.renderMode ?? "auto";
      const useCard = renderMode === "card" || (renderMode === "auto" && shouldUseCard(text));
      if (useCard) {
        const header = identity
          ? {
              title: resolveFeishuIdentityHeaderTitle(identity),
              template: "blue" as const,
            }
          : undefined;
        return await sendStructuredCardFeishu({
          cfg,
          to,
          text,
          replyToMessageId,
          replyInThread,
          accountId: accountId ?? undefined,
          header: header?.title ? header : undefined,
        });
      }
      return await sendOutboundText({
        cfg,
        to,
        text,
        accountId: accountId ?? undefined,
        replyToMessageId,
        replyInThread,
      });
    },
    sendMedia: async ({
      cfg,
      to,
      text,
      mediaUrl,
      audioAsVoice,
      accountId,
      mediaLocalRoots,
      replyToId,
      threadId,
      onDeliveryResult,
    }) => {
      const { replyToMessageId, replyInThread } = resolveFeishuReplyMode({
        replyToId,
        threadId,
      });
      const commentTarget = parseFeishuCommentTarget(to);
      if (commentTarget) {
        const commentText = [text?.trim(), mediaUrl?.trim()].filter(Boolean).join("\n\n");
        return await sendOutboundText({
          cfg,
          to,
          text: commentText || mediaUrl || text || "",
          accountId: accountId ?? undefined,
          replyToMessageId,
          replyInThread,
        });
      }

      const suppressTextForVoiceMedia =
        mediaUrl !== undefined &&
        shouldSuppressFeishuTextForVoiceMedia({
          mediaUrl,
          audioAsVoice,
        });
      const reportDelivery = async (result: Awaited<ReturnType<typeof sendOutboundText>>) => {
        await onDeliveryResult?.(attachChannelToResult("feishu", result));
      };
      let textSent = false;

      // Send text first if provided, except for Feishu native voice bubbles.
      if (text?.trim() && !suppressTextForVoiceMedia) {
        const textResult = await sendOutboundText({
          cfg,
          to,
          text,
          accountId: accountId ?? undefined,
          replyToMessageId,
          replyInThread,
        });
        textSent = true;
        await reportDelivery(textResult);
      }

      // Upload and send media if URL or local path provided
      if (mediaUrl) {
        let mediaResult: Awaited<ReturnType<typeof sendMediaFeishu>>;
        try {
          mediaResult = await sendMediaFeishu({
            cfg,
            to,
            mediaUrl,
            accountId: accountId ?? undefined,
            mediaLocalRoots,
            replyToMessageId,
            replyInThread,
            ...(audioAsVoice === true ? { audioAsVoice: true } : {}),
          });
        } catch (err) {
          // Log the error for debugging
          console.error(`[feishu] sendMediaFeishu failed:`, err);
          // Fallback to URL link if upload fails
          const fallbackText = [textSent ? undefined : text?.trim(), `📎 ${mediaUrl}`]
            .filter(Boolean)
            .join("\n\n");
          const fallbackResult = await sendOutboundText({
            cfg,
            to,
            text: fallbackText,
            accountId: accountId ?? undefined,
            replyToMessageId,
            replyInThread,
          });
          await reportDelivery(fallbackResult);
          return fallbackResult;
        }

        // Upload fallback applies only to the platform send. Persistence and
        // follow-up failures must not resend an attachment already accepted by Feishu.
        await onDeliveryResult?.(attachChannelToResult("feishu", mediaResult));
        if (mediaResult.voiceIntentDegradedToFile && text?.trim()) {
          const textResult = await sendOutboundText({
            cfg,
            to,
            text,
            accountId: accountId ?? undefined,
            replyToMessageId,
            replyInThread,
          });
          await reportDelivery(textResult);
        }
        return mediaResult;
      }

      // No media URL, just return text result
      return await sendOutboundText({
        cfg,
        to,
        text: text ?? "",
        accountId: accountId ?? undefined,
        replyToMessageId,
        replyInThread,
      });
    },
  }),
};
