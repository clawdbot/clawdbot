import fs from "node:fs";
import path from "node:path";
import {
  attachChannelToResult,
  createAttachedChannelResultAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import {
  interactiveReplyToPresentation,
  normalizeInteractiveReply,
  normalizeMessagePresentation,
  renderMessagePresentationFallbackText,
  resolveInteractiveTextFallback,
  type MessagePresentationBlock,
  type MessagePresentationButton,
} from "openclaw/plugin-sdk/interactive-runtime";
import {
  resolvePayloadMediaUrls,
  sendPayloadMediaSequenceAndFinalize,
  sendTextMediaPayload,
} from "openclaw/plugin-sdk/reply-payload";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuCardInteractionEnvelope } from "./card-interaction.js";
import { createFeishuClient } from "./client.js";
import { cleanupAmbientCommentTypingReaction } from "./comment-reaction.js";
import { parseFeishuCommentTarget } from "./comment-target.js";
import { deliverCommentThreadText } from "./drive.js";
import { sendMediaFeishu, shouldSuppressFeishuTextForVoiceMedia } from "./media.js";
import { chunkTextForOutbound, type ChannelOutboundAdapter } from "./outbound-runtime-api.js";
import {
  resolveFeishuCardTemplate,
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
  if (!fs.existsSync(raw)) {
    return null;
  }

  // Fix race condition: wrap statSync in try-catch to handle file deletion
  // between existsSync and statSync
  try {
    if (!fs.statSync(raw).isFile()) {
      return null;
    }
  } catch {
    // File may have been deleted or became inaccessible between checks
    return null;
  }

  return raw;
}

function shouldUseCard(text: string): boolean {
  return /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function escapeFeishuCardMarkdownText(text: string): string {
  return text.replace(/[&<>]/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      default:
        return char;
    }
  });
}

function resolveSafeFeishuButtonUrl(url: string | undefined): string | undefined {
  const trimmed = url?.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

function markRenderedFeishuCard(card: Record<string, unknown>): Record<string, unknown> {
  Object.defineProperty(card, RENDERED_FEISHU_CARD, {
    value: true,
    enumerable: false,
  });
  return card;
}

function sanitizeNativeFeishuCardButton(button: unknown): Record<string, unknown> | undefined {
  if (!isRecord(button)) {
    return undefined;
  }
  const text =
    isRecord(button.text) && typeof button.text.content === "string"
      ? button.text.content
      : undefined;
  if (!text?.trim()) {
    return undefined;
  }
  const style =
    button.type === "danger" ? "danger" : button.type === "primary" ? "primary" : undefined;
  const rendered: Record<string, unknown> = {
    tag: "button",
    text: { tag: "plain_text", content: text },
    type: mapFeishuButtonType(style),
  };
  const safeUrl = resolveSafeFeishuButtonUrl(
    typeof button.url === "string" ? button.url : undefined,
  );
  if (safeUrl) {
    rendered.url = safeUrl;
  }
  if (isRecord(button.value) && button.value.oc === "ocf1") {
    rendered.value = button.value;
  }
  return rendered.url || rendered.value ? rendered : undefined;
}

function sanitizeNativeFeishuCardElement(element: unknown): Record<string, unknown> | undefined {
  if (!isRecord(element) || typeof element.tag !== "string") {
    return undefined;
  }
  if (element.tag === "hr") {
    return { tag: "hr" };
  }
  if (element.tag === "markdown" && typeof element.content === "string") {
    return { tag: "markdown", content: escapeFeishuCardMarkdownText(element.content) };
  }
  if (element.tag === "action" && Array.isArray(element.actions)) {
    const actions = element.actions
      .map((action) => sanitizeNativeFeishuCardButton(action))
      .filter((action): action is Record<string, unknown> => Boolean(action));
    return actions.length > 0 ? { tag: "action", actions } : undefined;
  }
  return undefined;
}

function sanitizeNativeFeishuCard(
  card: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const body = isRecord(card.body) ? card.body : undefined;
  const rawElements = Array.isArray(body?.elements) ? body.elements : [];
  const elements = rawElements
    .map((element) => sanitizeNativeFeishuCardElement(element))
    .filter((element): element is Record<string, unknown> => Boolean(element));
  if (elements.length === 0) {
    return undefined;
  }

  const header = isRecord(card.header) ? card.header : undefined;
  const title =
    isRecord(header?.title) && typeof header.title.content === "string"
      ? header.title.content
      : undefined;
  return markRenderedFeishuCard({
    schema: "2.0",
    config: { width_mode: "fill" },
    ...(title?.trim()
      ? {
          header: {
            title: { tag: "plain_text", content: title },
            template:
              resolveFeishuCardTemplate(
                typeof header?.template === "string" ? header.template : undefined,
              ) ?? "blue",
          },
        }
      : {}),
    body: { elements },
  });
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
  return sanitizeNativeFeishuCard(card);
}

function mapFeishuButtonType(style: MessagePresentationButton["style"]) {
  if (style === "primary" || style === "success") {
    return "primary";
  }
  if (style === "danger") {
    return "danger";
  }
  return "default";
}

function buildFeishuPayloadButton(
  button: MessagePresentationButton,
): Record<string, unknown> | undefined {
  const rendered: Record<string, unknown> = {
    tag: "button",
    text: {
      tag: "plain_text",
      content: button.label,
    },
    type: mapFeishuButtonType(button.style),
  };
  if (button.url) {
    const safeUrl = resolveSafeFeishuButtonUrl(button.url);
    if (safeUrl) {
      rendered.url = safeUrl;
    }
  }
  if (button.value) {
    rendered.value = createFeishuCardInteractionEnvelope({
      k: "quick",
      a: "feishu.payload.button",
      q: button.value,
    });
  }
  return rendered.url || rendered.value ? rendered : undefined;
}

function buildFeishuCardElementForBlock(
  block: MessagePresentationBlock,
): Record<string, unknown> | undefined {
  if (block.type === "text") {
    return { tag: "markdown", content: escapeFeishuCardMarkdownText(block.text) };
  }
  if (block.type === "context") {
    return {
      tag: "markdown",
      content: `<font color='grey'>${escapeFeishuCardMarkdownText(block.text)}</font>`,
    };
  }
  if (block.type === "divider") {
    return { tag: "hr" };
  }
  if (block.type === "buttons") {
    const actions = block.buttons
      .map((button) => buildFeishuPayloadButton(button))
      .filter((button): button is Record<string, unknown> => Boolean(button));
    if (actions.length === 0) {
      return undefined;
    }
    return {
      tag: "action",
      actions,
    };
  }
  const labels = block.options.map((option) => `- ${option.label}`).join("\n");
  return {
    tag: "markdown",
    content: `${escapeFeishuCardMarkdownText(
      block.placeholder?.trim() || "Options",
    )}:\n${escapeFeishuCardMarkdownText(labels)}`,
  };
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

  const interactive = normalizeInteractiveReply(params.payload.interactive);
  const presentation =
    normalizeMessagePresentation(params.payload.presentation) ??
    (interactive ? interactiveReplyToPresentation(interactive) : undefined);
  if (!presentation && !interactive) {
    return undefined;
  }

  const text = resolveInteractiveTextFallback({
    text: params.text ?? params.payload.text,
    interactive,
  });
  const elements: Record<string, unknown>[] = [];
  if (text?.trim()) {
    elements.push({ tag: "markdown", content: escapeFeishuCardMarkdownText(text) });
  }
  for (const block of presentation?.blocks ?? []) {
    const element = buildFeishuCardElementForBlock(block);
    if (element) {
      elements.push(element);
    }
  }
  if (elements.length === 0) {
    elements.push({
      tag: "markdown",
      content: renderMessagePresentationFallbackText({ text, presentation }),
    });
  }

  const identityTitle = params.identity
    ? params.identity.emoji
      ? `${params.identity.emoji} ${params.identity.name ?? ""}`.trim()
      : (params.identity.name ?? "")
    : "";
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
  return {
    ...payload,
    text: renderMessagePresentationFallbackText({ text: payload.text, presentation }),
    channelData: {
      ...payload.channelData,
      feishu: {
        ...existingFeishuData,
        card,
      },
    },
  };
}

function resolveReplyToMessageId(params: {
  replyToId?: string | null;
  threadId?: string | number | null;
}): string | undefined {
  const replyToId = params.replyToId?.trim();
  if (replyToId) {
    return replyToId;
  }
  if (params.threadId == null) {
    return undefined;
  }
  const trimmed = String(params.threadId).trim();
  return trimmed || undefined;
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
  accountId?: string;
}) {
  const { cfg, to, text, accountId, replyToMessageId } = params;
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
    return sendMarkdownCardFeishu({ cfg, to, text, accountId, replyToMessageId });
  }

  return sendMessageFeishu({ cfg, to, text, accountId, replyToMessageId });
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

    const replyToMessageId = resolveReplyToMessageId({
      replyToId: ctx.replyToId,
      threadId: ctx.threadId,
    });
    const commentTarget = parseFeishuCommentTarget(ctx.to);
    if (commentTarget) {
      return await sendTextMediaPayload({
        channel: "feishu",
        ctx: {
          ...ctx,
          payload: {
            ...ctx.payload,
            text: renderMessagePresentationFallbackText({
              text: ctx.payload.text,
              presentation:
                normalizeMessagePresentation(ctx.payload.presentation) ??
                (() => {
                  const interactive = normalizeInteractiveReply(ctx.payload.interactive);
                  return interactive ? interactiveReplyToPresentation(interactive) : undefined;
                })(),
            }),
            interactive: undefined,
            presentation: undefined,
            channelData: undefined,
          },
        },
        adapter: feishuOutbound,
      });
    }

    const mediaUrls = resolvePayloadMediaUrls(ctx.payload)
      .map((entry) => entry.trim())
      .filter(Boolean);
    return attachChannelToResult(
      "feishu",
      await sendPayloadMediaSequenceAndFinalize({
        text: ctx.payload.text ?? "",
        mediaUrls,
        send: async ({ mediaUrl }) =>
          await sendMediaFeishu({
            cfg: ctx.cfg,
            to: ctx.to,
            mediaUrl,
            accountId: ctx.accountId ?? undefined,
            mediaLocalRoots: ctx.mediaLocalRoots,
            replyToMessageId,
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
            replyInThread: ctx.threadId != null && !ctx.replyToId,
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
      const replyToMessageId = resolveReplyToMessageId({ replyToId, threadId });
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
        });
      }

      const account = resolveFeishuAccount({ cfg, accountId: accountId ?? undefined });
      const renderMode = account.config?.renderMode ?? "auto";
      const useCard = renderMode === "card" || (renderMode === "auto" && shouldUseCard(text));
      if (useCard) {
        const header = identity
          ? {
              title: identity.emoji
                ? `${identity.emoji} ${identity.name ?? ""}`.trim()
                : (identity.name ?? ""),
              template: "blue" as const,
            }
          : undefined;
        return await sendStructuredCardFeishu({
          cfg,
          to,
          text,
          replyToMessageId,
          replyInThread: threadId != null && !replyToId,
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
    }) => {
      const replyToMessageId = resolveReplyToMessageId({ replyToId, threadId });
      const commentTarget = parseFeishuCommentTarget(to);
      if (commentTarget) {
        const commentText = [text?.trim(), mediaUrl?.trim()].filter(Boolean).join("\n\n");
        return await sendOutboundText({
          cfg,
          to,
          text: commentText || mediaUrl || text || "",
          accountId: accountId ?? undefined,
          replyToMessageId,
        });
      }

      const suppressTextForVoiceMedia =
        mediaUrl !== undefined &&
        shouldSuppressFeishuTextForVoiceMedia({
          mediaUrl,
          audioAsVoice,
        });

      // Send text first if provided, except for Feishu native voice bubbles.
      if (text?.trim() && !suppressTextForVoiceMedia) {
        await sendOutboundText({
          cfg,
          to,
          text,
          accountId: accountId ?? undefined,
          replyToMessageId,
        });
      }

      // Upload and send media if URL or local path provided
      if (mediaUrl) {
        try {
          return await sendMediaFeishu({
            cfg,
            to,
            mediaUrl,
            accountId: accountId ?? undefined,
            mediaLocalRoots,
            replyToMessageId,
            ...(audioAsVoice === true ? { audioAsVoice: true } : {}),
          });
        } catch (err) {
          // Log the error for debugging
          console.error(`[feishu] sendMediaFeishu failed:`, err);
          // Fallback to URL link if upload fails
          const fallbackText = [text?.trim(), `📎 ${mediaUrl}`].filter(Boolean).join("\n\n");
          return await sendOutboundText({
            cfg,
            to,
            text: fallbackText,
            accountId: accountId ?? undefined,
            replyToMessageId,
          });
        }
      }

      // No media URL, just return text result
      return await sendOutboundText({
        cfg,
        to,
        text: text ?? "",
        accountId: accountId ?? undefined,
        replyToMessageId,
      });
    },
  }),
};
