// Feishu plugin module implements outbound behavior.
import path from "node:path";
import { createReplyToFanout } from "openclaw/plugin-sdk/channel-outbound";
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
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { resolveChunkMode, resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-chunking";
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
import { convertMarkdownTables } from "openclaw/plugin-sdk/text-chunking";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { cleanupAmbientCommentTypingReaction } from "./comment-reaction.js";
import { parseFeishuCommentTarget } from "./comment-target.js";
import { deliverCommentThreadText } from "./drive.js";
import { resolveFeishuIdentityHeaderTitle } from "./identity-header.js";
import {
  chunkFeishuMarkdown,
  chunkFeishuPostMarkdown,
  materializeFeishuPostMarkdownSoftBreaks,
} from "./markdown.js";
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
import type { ChannelOutboundAdapter } from "./outbound-runtime-api.js";
import {
  assertFeishuCardWithinEnvelope,
  buildFeishuPresentationCardElements,
  isFeishuCardWithinEnvelope,
} from "./presentation-card.js";
import {
  sendCardFeishu,
  sendMarkdownCardFeishu,
  sendMessageFeishu,
  sendStructuredCardFeishu,
} from "./send.js";

const RENDERED_FEISHU_CARD = Symbol("openclaw.renderedFeishuCard");
const FEISHU_PRESENTATION_FALLBACK_MARKER = "__openclawPresentationFallback";
const FEISHU_TEXT_CHUNK_LIMIT = 4000;

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

type FeishuOutboundPayload = Parameters<
  NonNullable<ChannelOutboundAdapter["sendPayload"]>
>[0]["payload"];
type FeishuSendPayloadContext = Parameters<NonNullable<ChannelOutboundAdapter["sendPayload"]>>[0];

function consumeFeishuPresentationFallbackMarker(payload: FeishuOutboundPayload): {
  payload: FeishuOutboundPayload;
  presentationFallback: boolean;
} {
  const feishuData = isRecord(payload.channelData?.feishu) ? payload.channelData.feishu : undefined;
  if (feishuData?.[FEISHU_PRESENTATION_FALLBACK_MARKER] !== true) {
    return { payload, presentationFallback: false };
  }
  const nextFeishuData = { ...feishuData };
  delete nextFeishuData[FEISHU_PRESENTATION_FALLBACK_MARKER];
  const nextChannelData = { ...payload.channelData };
  if (Object.keys(nextFeishuData).length > 0) {
    nextChannelData.feishu = nextFeishuData;
  } else {
    delete nextChannelData.feishu;
  }
  return {
    payload: {
      ...payload,
      channelData: Object.keys(nextChannelData).length > 0 ? nextChannelData : undefined,
    },
    presentationFallback: true,
  };
}

function buildFeishuPayloadCard(params: {
  payload: Parameters<NonNullable<ChannelOutboundAdapter["sendPayload"]>>[0]["payload"];
  text?: string;
  identity?: Parameters<NonNullable<ChannelOutboundAdapter["sendPayload"]>>[0]["identity"];
}): Record<string, unknown> | undefined {
  const nativeCard = readNativeFeishuCard(params.payload);
  if (nativeCard) {
    assertFeishuCardWithinEnvelope(nativeCard, "Feishu native card");
    return nativeCard;
  }

  const rawText = params.text ?? params.payload.text;
  const textCard = readNativeFeishuCardJson(rawText);
  const interactive = normalizeInteractiveReply(params.payload.interactive);
  const presentation =
    normalizeMessagePresentation(params.payload.presentation) ??
    (interactive ? interactiveReplyToPresentation(interactive) : undefined);
  if (!presentation && !interactive) {
    if (!textCard) {
      return undefined;
    }
    assertFeishuCardWithinEnvelope(textCard, "Feishu native card");
    return markRenderedFeishuCard(textCard);
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

  const card = markRenderedFeishuCard({
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
  return isFeishuCardWithinEnvelope(card) ? card : undefined;
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
  const textCard = readNativeFeishuCardJson(payload.text);
  const fallbackText = renderMessagePresentationFallbackText({
    text: textCard ? undefined : payload.text,
    presentation,
  });
  const card = buildFeishuPayloadCard({
    payload,
    text: payload.text,
    identity: ctx.identity,
  });
  const existingFeishuData = isRecord(payload.channelData?.feishu)
    ? payload.channelData.feishu
    : undefined;
  const fallbackHasCommand = hasVisibleFallbackCommand(presentation?.blocks);
  if (!card) {
    // The marker keeps core on sendPayload after it strips presentation; that path
    // consumes it and fans out text instead of using the whole fallback as a caption.
    return {
      ...payload,
      text: fallbackText,
      channelData: {
        ...payload.channelData,
        feishu: {
          ...existingFeishuData,
          [FEISHU_PRESENTATION_FALLBACK_MARKER]: true,
          ...(fallbackHasCommand ? { fallbackHasCommand: true } : {}),
        },
      },
    };
  }
  // Core consumes presentation before sendPayload; carry the fallback fact.
  return {
    ...payload,
    text: fallbackText,
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
  | { normalizedReplyToId: string; replyToMessageId: string; replyInThread: false }
  | { normalizedReplyToId: undefined; replyToMessageId: string; replyInThread: true }
  | { normalizedReplyToId: undefined; replyToMessageId: undefined; replyInThread: false };

// Target selection and thread mode are one decision; all payload parts reuse this result.
function resolveFeishuReplyMode(params: {
  replyToId?: string | null;
  threadId?: string | number | null;
}): FeishuReplyMode {
  const replyToMessageId = params.replyToId?.trim();
  if (replyToMessageId) {
    return { normalizedReplyToId: replyToMessageId, replyToMessageId, replyInThread: false };
  }

  const threadId = params.threadId == null ? undefined : String(params.threadId).trim();
  return threadId
    ? { normalizedReplyToId: undefined, replyToMessageId: threadId, replyInThread: true }
    : {
        normalizedReplyToId: undefined,
        replyToMessageId: undefined,
        replyInThread: false,
      };
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

  // Decide card routing on the original text so card content is never
  // modified by post-md newline normalization. Only the post path below
  // materializes CommonMark soft breaks for Feishu rendering.
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

  // Tables need contiguous source rows, so convert them before the parser
  // materializes prose soft breaks for Feishu post rendering.
  const tableMode = resolveMarkdownTableMode({ cfg, channel: "feishu" });
  const tableConvertedText = convertMarkdownTables(text, tableMode);
  const normalizedText = materializeFeishuPostMarkdownSoftBreaks(tableConvertedText);

  // Core chunks raw text before channel rendering. Re-chunk after expansion
  // and keep each fenced-code chunk independently valid Markdown.
  const postLimit = resolveTextChunkLimit(cfg, "feishu", accountId, {
    fallbackLimit: FEISHU_TEXT_CHUNK_LIMIT,
  });
  const subChunks = chunkFeishuPostMarkdown({
    text: normalizedText,
    limit: postLimit,
    mode: resolveChunkMode(cfg, "feishu", accountId),
  });
  if (subChunks.length <= 1) {
    return sendMessageFeishu({
      cfg,
      to,
      text: subChunks[0] ?? normalizedText,
      accountId,
      replyToMessageId,
      replyInThread,
    });
  }

  let lastResult: Awaited<ReturnType<typeof sendMessageFeishu>> | undefined;
  const preserveThread = replyInThread === true;
  for (const [i, chunk] of subChunks.entries()) {
    // Thread roots must accompany every chunk. Ordinary quoted replies remain
    // first-chunk-only so implicit reply ids are consumed once per fanout.
    lastResult = await sendMessageFeishu({
      cfg,
      to,
      text: chunk,
      accountId,
      replyToMessageId: preserveThread || i === 0 ? replyToMessageId : undefined,
      replyInThread: preserveThread ? true : i === 0 ? replyInThread : undefined,
    });
  }
  return lastResult!;
}

async function sendFeishuFallbackPayload(params: {
  ctx: FeishuSendPayloadContext;
  payload: FeishuOutboundPayload;
  separateMediaAndText?: boolean;
}) {
  const ctx = { ...params.ctx, payload: params.payload };
  const mediaUrls = normalizeStringEntries(resolvePayloadMediaUrls(params.payload));
  const text = params.payload.text ?? "";
  const textChunks = text ? chunkFeishuMarkdown(text, FEISHU_TEXT_CHUNK_LIMIT) : [];
  const shouldSeparate =
    mediaUrls.length > 0 && (params.separateMediaAndText === true || textChunks.length > 1);
  if (!shouldSeparate) {
    return await sendTextMediaPayload({
      channel: "feishu",
      ctx,
      adapter: feishuOutbound,
    });
  }

  const { normalizedReplyToId } = resolveFeishuReplyMode({
    replyToId: ctx.replyToId,
    threadId: ctx.threadId,
  });
  const nextReplyToId = createReplyToFanout({
    replyToId: normalizedReplyToId,
    replyToIdSource: ctx.replyToIdSource,
    replyToMode: ctx.replyToMode,
  });
  const sendMedia = feishuOutbound.sendMedia;
  const sendText = feishuOutbound.sendText;
  if (!sendMedia || !sendText) {
    throw new Error("Feishu fallback delivery is not available.");
  }

  // Card fallbacks can exceed media-caption limits. Deliver attachments first,
  // then preserve the complete fallback through the normal 4k text fanout.
  let lastResult: Awaited<ReturnType<typeof sendText>> | undefined;
  for (const mediaUrl of mediaUrls) {
    lastResult = await sendMedia({
      ...ctx,
      text: "",
      mediaUrl,
      replyToId: nextReplyToId(),
      audioAsVoice: params.payload.audioAsVoice ?? ctx.audioAsVoice,
      onDeliveryResult: undefined,
    });
    await ctx.onDeliveryResult?.(lastResult);
  }
  for (const chunk of textChunks) {
    lastResult = await sendText({
      ...ctx,
      text: chunk,
      replyToId: nextReplyToId(),
      onDeliveryResult: undefined,
    });
    await ctx.onDeliveryResult?.(lastResult);
  }
  return lastResult!;
}

export const feishuOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: chunkFeishuMarkdown,
  chunkerMode: "markdown",
  textChunkLimit: FEISHU_TEXT_CHUNK_LIMIT,
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
        maxLength: FEISHU_TEXT_CHUNK_LIMIT,
        encoding: "characters",
        markdownDialect: "markdown",
      },
    },
  },
  renderPresentation: renderFeishuPresentationPayload,
  sendPayload: async (ctx) => {
    const { payload, presentationFallback } = consumeFeishuPresentationFallbackMarker(ctx.payload);
    if (parseFeishuCommentTarget(ctx.to)) {
      const interactive = normalizeInteractiveReply(payload.interactive);
      const normalizedPresentation =
        normalizeMessagePresentation(payload.presentation) ??
        (interactive ? interactiveReplyToPresentation(interactive) : undefined);
      // Document comments cannot render cards. Resolve the text path before
      // validating card limits so unused native card data cannot block delivery.
      const textCard = readNativeFeishuCardJson(payload.text);
      const fallbackSourceText = textCard ? undefined : payload.text;
      const presentationFallbackText = renderMessagePresentationFallbackText({
        text: fallbackSourceText,
        presentation: normalizedPresentation,
      });
      const hasFallbackMedia = normalizeStringEntries(resolvePayloadMediaUrls(payload)).length > 0;
      if (
        !presentationFallbackText.trim() &&
        !hasFallbackMedia &&
        (textCard || readNativeFeishuCard(payload))
      ) {
        throw new Error(
          "Feishu native cards cannot be sent to document comments without a text or media fallback.",
        );
      }
      // Direct delivery retains blocks; core-rendered delivery carries the fact.
      const fallbackHasCommand =
        hasVisibleFallbackCommand(normalizedPresentation?.blocks) ||
        (isRecord(payload.channelData?.feishu) &&
          payload.channelData.feishu.fallbackHasCommand === true);
      const text = fallbackHasCommand
        ? `${presentationFallbackText}\n\n> Interactive buttons are unavailable in Feishu document comments. You can type the command shown above manually.`
        : presentationFallbackText;
      const fallbackPayload = {
        ...payload,
        text,
        interactive: undefined,
        presentation: undefined,
        channelData: undefined,
      };
      return await sendFeishuFallbackPayload({
        ctx,
        payload: fallbackPayload,
        separateMediaAndText: true,
      });
    }

    const card = buildFeishuPayloadCard({
      payload,
      text: ctx.text,
      identity: ctx.identity,
    });
    if (!card) {
      const interactive = normalizeInteractiveReply(payload.interactive);
      const presentation =
        normalizeMessagePresentation(payload.presentation) ??
        (interactive ? interactiveReplyToPresentation(interactive) : undefined);
      const fallbackPayload = presentation
        ? {
            ...payload,
            text: renderMessagePresentationFallbackText({
              text: readNativeFeishuCardJson(payload.text) ? undefined : payload.text,
              presentation,
            }),
            presentation: undefined,
            interactive: undefined,
          }
        : payload;
      return await sendFeishuFallbackPayload({
        ctx,
        payload: fallbackPayload,
        separateMediaAndText: presentationFallback || presentation !== undefined,
      });
    }

    const { normalizedReplyToId } = resolveFeishuReplyMode({
      replyToId: ctx.replyToId,
      threadId: ctx.threadId,
    });
    // Media and the final card are separate payloads: consume an implicit
    // first-reply id once, while an explicit thread remains sticky for both.
    const nextReplyToId = createReplyToFanout({
      replyToId: normalizedReplyToId,
      replyToIdSource: ctx.replyToIdSource,
      replyToMode: ctx.replyToMode,
    });
    const nextReplyMode = () =>
      resolveFeishuReplyMode({
        replyToId: nextReplyToId(),
        threadId: ctx.threadId,
      });
    const mediaUrls = normalizeStringEntries(resolvePayloadMediaUrls(payload));
    return attachChannelToResult(
      "feishu",
      await sendPayloadMediaSequenceAndFinalize<
        SendMediaResult,
        Awaited<ReturnType<typeof sendCardFeishu>>
      >({
        text: payload.text ?? "",
        mediaUrls,
        onResult: async (deliveryResult) => {
          await ctx.onDeliveryResult?.(attachChannelToResult("feishu", deliveryResult));
        },
        send: async ({ mediaUrl }) => {
          const { replyToMessageId, replyInThread } = nextReplyMode();
          return await sendMediaFeishu({
            cfg: ctx.cfg,
            to: ctx.to,
            mediaUrl,
            accountId: ctx.accountId ?? undefined,
            mediaLocalRoots: ctx.mediaLocalRoots,
            replyToMessageId,
            replyInThread,
            ...(payload.audioAsVoice === true || ctx.audioAsVoice === true
              ? { audioAsVoice: true }
              : {}),
          });
        },
        finalize: async () => {
          const { replyToMessageId, replyInThread } = nextReplyMode();
          return await sendCardFeishu({
            cfg: ctx.cfg,
            to: ctx.to,
            card,
            replyToMessageId,
            replyInThread,
            accountId: ctx.accountId ?? undefined,
          });
        },
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
        assertFeishuCardWithinEnvelope(card, "Feishu native card");
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
