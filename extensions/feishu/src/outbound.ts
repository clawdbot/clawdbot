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
import { sendMediaFeishu, shouldSuppressFeishuTextForVoiceMedia } from "./media.js";
import { chunkTextForOutbound, type ChannelOutboundAdapter } from "./outbound-runtime-api.js";
import { buildFeishuPresentationCardElements } from "./presentation-card.js";
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

function resolveSafeFeishuButtonUrl(url: unknown): string | undefined {
  const trimmed = typeof url === "string" ? url.trim() : "";
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

function sanitizeNativeFeishuButtonBehavior(
  behavior: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(behavior)) {
    return undefined;
  }
  if (behavior.type === "open_url") {
    const safeUrl =
      resolveSafeFeishuButtonUrl(behavior.default_url) ?? resolveSafeFeishuButtonUrl(behavior.url);
    return safeUrl ? { type: "open_url", default_url: safeUrl } : undefined;
  }
  if (behavior.type === "callback" && isRecord(behavior.value) && behavior.value.oc === "ocf1") {
    return { type: "callback", value: behavior.value };
  }
  return undefined;
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
    button.type === "danger"
      ? "danger"
      : button.type === "primary" || button.type === "success"
        ? "primary"
        : undefined;
  const behaviors = Array.isArray(button.behaviors)
    ? button.behaviors
        .map((behavior) => sanitizeNativeFeishuButtonBehavior(behavior))
        .filter((behavior): behavior is Record<string, unknown> => Boolean(behavior))
    : [];
  const rootSafeUrl = resolveSafeFeishuButtonUrl(button.url);
  if (rootSafeUrl) {
    behaviors.push({ type: "open_url", default_url: rootSafeUrl });
  }
  if (isRecord(button.value) && button.value.oc === "ocf1") {
    behaviors.push({ type: "callback", value: button.value });
  }
  if (behaviors.length === 0) {
    return undefined;
  }
  const rendered: Record<string, unknown> = {
    tag: "button",
    text: { tag: "plain_text", content: text },
    type:
      style === "danger"
        ? "danger"
        : style === "primary" || style === "success"
          ? "primary"
          : "default",
    behaviors,
  };
  return rendered;
}

function sanitizeNativeFeishuCardElements(element: unknown): Record<string, unknown>[] {
  if (!isRecord(element) || typeof element.tag !== "string") {
    return [];
  }
  if (element.tag === "hr") {
    return [{ tag: "hr" }];
  }
  if (element.tag === "markdown" && typeof element.content === "string") {
    return [
      {
        tag: "markdown",
        content: escapeFeishuCardMarkdownText(element.content),
      },
    ];
  }
  if (element.tag === "button") {
    const button = sanitizeNativeFeishuCardButton(element);
    return button ? [button] : [];
  }
  if (element.tag === "action" && Array.isArray(element.actions)) {
    return element.actions
      .map((action) => sanitizeNativeFeishuCardButton(action))
      .filter((action): action is Record<string, unknown> => Boolean(action));
  }
  return [];
}

function sanitizeNativeFeishuCard(
  card: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const body = isRecord(card.body) ? card.body : undefined;
  const rawElements = Array.isArray(body?.elements) ? body.elements : [];
  const elements = rawElements
    .flatMap((element) => sanitizeNativeFeishuCardElements(element))
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
  const elements = presentation
    ? buildFeishuPresentationCardElements({ presentation, fallbackText: text })
    : [
        {
          tag: "markdown",
          content: renderMessagePresentationFallbackText({ text, presentation }),
        },
      ];

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

type FeishuMediaReplyMode = {
  replyToMessageId: string | undefined;
  replyInThread: boolean;
};

function resolveFeishuMediaReplyMode(params: {
  replyToId?: string | null;
  threadId?: string | number | null;
}): FeishuMediaReplyMode {
  const trimmedReplyToId = params.replyToId?.trim() || undefined;
  const replyToMessageId = resolveReplyToMessageId(params);
  const replyInThread = params.threadId != null && !trimmedReplyToId;
  return { replyToMessageId, replyInThread };
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

    const mediaUrls = normalizeStringEntries(resolvePayloadMediaUrls(ctx.payload));
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
      const { replyToMessageId, replyInThread } = resolveFeishuMediaReplyMode({
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
    }) => {
      const { replyToMessageId, replyInThread } = resolveFeishuMediaReplyMode({
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

      // Send text first if provided, except for Feishu native voice bubbles.
      if (text?.trim() && !suppressTextForVoiceMedia) {
        await sendOutboundText({
          cfg,
          to,
          text,
          accountId: accountId ?? undefined,
          replyToMessageId,
          replyInThread,
        });
      }

      // Upload and send media if URL or local path provided
      if (mediaUrl) {
        try {
          const result = await sendMediaFeishu({
            cfg,
            to,
            mediaUrl,
            accountId: accountId ?? undefined,
            mediaLocalRoots,
            replyToMessageId,
            replyInThread,
            ...(audioAsVoice === true ? { audioAsVoice: true } : {}),
          });
          if (result.voiceIntentDegradedToFile && text?.trim()) {
            await sendOutboundText({
              cfg,
              to,
              text,
              accountId: accountId ?? undefined,
              replyToMessageId,
              replyInThread,
            });
          }
          return result;
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
            replyInThread,
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
        replyInThread,
      });
    },
  }),
};
