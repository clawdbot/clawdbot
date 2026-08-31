// Feishu plugin module implements outbound behavior.
import path from "node:path";
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import {
  createMessageReceiptFromOutboundResults,
  createReplyToFanout,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  attachChannelToResult,
  createAttachedChannelResultAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import { resolveLegacyInteractiveTextFallback } from "openclaw/plugin-sdk/interactive-runtime";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { resolveChunkMode, resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-chunking";
import {
  getReplyPayloadTtsSupplement,
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
import type { ChannelOutboundAdapter } from "../runtime-api.js";
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
import { buildFeishuMediaFallbackText } from "./media-fallback.js";
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
import {
  assertFeishuCardWithinEnvelope,
  buildFeishuPresentationFallback,
  buildFeishuPresentationCardElements,
  isFeishuCardWithinEnvelope,
  renderFeishuPresentationFallbackText,
  resolveFeishuRichReply,
} from "./presentation-card.js";
import {
  createFeishuPartialReplyDeliveryError,
  createFeishuReplyDeliveryResult,
  type FeishuReplyDeliverySource,
} from "./reply-delivery-result.js";
import {
  chunkFeishuCardMarkdown,
  sendCardFeishu,
  sendMessageFeishu,
  sendStructuredCardFeishu,
  type CardHeaderConfig,
} from "./send.js";

const RENDERED_FEISHU_CARD = Symbol("openclaw.renderedFeishuCard");
const FEISHU_PRESENTATION_FALLBACK_MARKER = "__openclawPresentationFallback";
// Carries the direct-send upload-failure policy through the presentation
// fallback delivery path. The normal `sendMedia` branch sets
// `propagateMediaUploadFailure` directly; the presentation-fallback branch
// routes through `sendPayload` (whose shared signature cannot carry the flag),
// so the direct `send` action stamps this marker on `channelData.feishu` and
// `sendFeishuFallbackPayload` reads it before calling `sendMedia`. This keeps
// a direct-send attachment failure visible instead of degrading to a
// fallback-text `ok:true` receipt (issue #112244, ClawSweeper P1).
export const FEISHU_PROPAGATE_MEDIA_UPLOAD_FAILURE_MARKER = "__openclawPropagateMediaUploadFailure";
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
  const isImageExt = [
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".webp",
    ".bmp",
    ".ico",
    ".heic",
    ".tif",
    ".tiff",
  ].includes(ext);
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
type FeishuSendTextContext = Parameters<NonNullable<ChannelOutboundAdapter["sendText"]>>[0];

// The Feishu sendMedia implementation accepts an optional flag the shared
// ChannelOutboundAdapter contract does not: when true, a media-upload failure
// is re-thrown to the caller instead of being converted to a fallback text
// success. The direct `send` action sets this so an agent that requested an
// attachment receives a visible failure when it cannot be delivered, rather
// than an `ok:true` receipt for a text-only fallback (issue #112244).
//
// The return type mirrors the shared contract exactly — `ReturnType<...>` is
// already `Promise<OutboundDeliveryResult>`, so wrapping it in another
// `Promise` would produce `Promise<Promise<...>>` and break the `async`
// implementation's single-Promise return (ClawSweeper P1).
export type FeishuOutboundSendMedia = (
  params: Parameters<NonNullable<ChannelOutboundAdapter["sendMedia"]>>[0] & {
    propagateMediaUploadFailure?: boolean;
  },
) => ReturnType<NonNullable<ChannelOutboundAdapter["sendMedia"]>>;

function toFeishuOutboundResult<T extends { chatId: string }>(result: T) {
  const { chatId, ...delivery } = result;
  return { ...delivery, target: { kind: "chat" as const, id: chatId } };
}

async function reportFeishuOutboundDelivery<T extends { messageId: string; chatId: string }>(
  result: T,
  onDeliveryResult: FeishuSendTextContext["onDeliveryResult"],
): Promise<T> {
  await onDeliveryResult?.(attachChannelToResult("feishu", toFeishuOutboundResult(result)));
  return result;
}

function aggregateFeishuSendResult<T extends FeishuReplyDeliverySource>(
  result: T,
  results: readonly FeishuReplyDeliverySource[],
) {
  return {
    ...result,
    receipt: {
      ...createMessageReceiptFromOutboundResults({ results }),
      // Keep the established edit/reply target while retaining every physical send.
      primaryPlatformMessageId: result.messageId,
    },
  };
}

function partialFeishuSendError(error: unknown, results: readonly FeishuReplyDeliverySource[]) {
  if (results.length === 0 && error instanceof Error) {
    return error;
  }
  const accepted = isChannelPartialDeliveryError(error) ? error.deliveryResult : undefined;
  return createFeishuPartialReplyDeliveryError(error, {
    ...accepted,
    ...createFeishuReplyDeliveryResult({
      results: [...results, accepted],
      visibleReplySent: results.length > 0 || accepted !== undefined,
    }),
  });
}

function consumeFeishuPresentationFallbackMarker(payload: FeishuOutboundPayload): {
  payload: FeishuOutboundPayload;
  presentationFallback?: { hasVisibleContent: boolean };
} {
  const feishuData = isRecord(payload.channelData?.feishu) ? payload.channelData.feishu : undefined;
  const presentationFallback = feishuData?.[FEISHU_PRESENTATION_FALLBACK_MARKER];
  if (
    !isRecord(presentationFallback) ||
    typeof presentationFallback.hasVisibleContent !== "boolean"
  ) {
    return { payload };
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
    presentationFallback: { hasVisibleContent: presentationFallback.hasVisibleContent },
  };
}

// Reads (without consuming) the direct-send upload-failure policy stamped on
// the payload by the presentation-fallback branch. Unlike the presentation
// fallback marker this is not consumed: a fallback payload may fan out
// multiple `sendMedia` calls and each must honor the policy.
function readFeishuPropagateMediaUploadFailure(payload: FeishuOutboundPayload): boolean {
  const feishuData = isRecord(payload.channelData?.feishu) ? payload.channelData.feishu : undefined;
  return feishuData?.[FEISHU_PROPAGATE_MEDIA_UPLOAD_FAILURE_MARKER] === true;
}

// Builds a `channelData.feishu` that carries only the direct-send upload-failure
// policy marker. The document-comment branch strips native card / interactive
// channelData before fallback delivery (those cannot render in comments), but
// it must not drop the propagation marker the direct `send` action stamped —
// otherwise a media-upload failure on a comment target degrades to a
// fallback-text `ok:true` receipt again (issue #112244, ClawSweeper P1).
function buildFeishuPropagationOnlyChannelData(
  payload: FeishuOutboundPayload,
): { feishu: Record<string, unknown> } | undefined {
  const feishuData = isRecord(payload.channelData?.feishu) ? payload.channelData.feishu : undefined;
  if (feishuData?.[FEISHU_PROPAGATE_MEDIA_UPLOAD_FAILURE_MARKER] !== true) {
    return undefined;
  }
  return {
    feishu: { [FEISHU_PROPAGATE_MEDIA_UPLOAD_FAILURE_MARKER]: true },
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
  const { interactive, presentation } = resolveFeishuRichReply(params.payload);
  if (!presentation) {
    if (!textCard) {
      return undefined;
    }
    assertFeishuCardWithinEnvelope(textCard, "Feishu native card");
    return markRenderedFeishuCard(textCard);
  }

  const text = textCard
    ? undefined
    : resolveLegacyInteractiveTextFallback({
        text: rawText,
        interactive,
      });
  const elements = buildFeishuPresentationCardElements({ presentation, fallbackText: text });

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

function renderFeishuPresentationPayload({
  payload,
  presentation,
  ctx,
}: Parameters<NonNullable<ChannelOutboundAdapter["renderPresentation"]>>[0]) {
  const textCard = readNativeFeishuCardJson(payload.text);
  const { fallbackText, fallbackHasCommand } = buildFeishuPresentationFallback({
    text: textCard ? undefined : payload.text,
    presentation,
    textFormat: parseFeishuCommentTarget(ctx.to) ? "plain" : "markdown",
  });
  const card = buildFeishuPayloadCard({
    payload,
    text: payload.text,
    identity: ctx.identity,
  });
  const existingFeishuData = isRecord(payload.channelData?.feishu)
    ? payload.channelData.feishu
    : undefined;
  if (!card) {
    // Core strips presentation from this post-queue transport copy. Preserve its
    // own visible contribution separately from prose already delivered by streaming.
    return {
      ...payload,
      text: fallbackText,
      channelData: {
        ...payload.channelData,
        feishu: {
          ...existingFeishuData,
          [FEISHU_PRESENTATION_FALLBACK_MARKER]: {
            hasVisibleContent: Boolean(
              renderFeishuPresentationFallbackText({ presentation }).trim(),
            ),
          },
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
export function resolveFeishuReplyMode(params: {
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
        (result.delivery_mode === "reply_comment" ? result.reply_id : result.comment_id) ?? "",
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
  replyToIdSource?: FeishuSendTextContext["replyToIdSource"];
  replyToMode?: FeishuSendTextContext["replyToMode"];
  onDeliveryResult?: FeishuSendTextContext["onDeliveryResult"];
  header?: CardHeaderConfig;
}) {
  const { cfg, to, text, accountId, replyToMessageId, replyInThread, onDeliveryResult } = params;
  const commentResult = await sendCommentThreadReply({
    cfg,
    to,
    text,
    replyId: replyToMessageId,
    accountId,
  });
  if (commentResult) {
    return await reportFeishuOutboundDelivery(commentResult, onDeliveryResult);
  }

  const account = resolveFeishuAccount({ cfg, accountId });
  const renderMode = account.config?.renderMode ?? "auto";

  // Decide card routing on the original text so card content is never
  // modified by post-md newline normalization. Only the post path below
  // materializes CommonMark soft breaks for Feishu rendering.
  const useCard = renderMode === "card" || (renderMode === "auto" && shouldUseCard(text));

  // Tables need contiguous source rows, so convert them before the parser
  // materializes prose soft breaks for Feishu post rendering.
  const tableMode = resolveMarkdownTableMode({ cfg, channel: "feishu" });
  const normalizedText = useCard
    ? text
    : materializeFeishuPostMarkdownSoftBreaks(convertMarkdownTables(text, tableMode));

  // Core chunks raw text before channel rendering. Re-chunk after expansion
  // and keep each fenced-code chunk independently valid Markdown.
  const postLimit = resolveTextChunkLimit(cfg, "feishu", accountId, {
    fallbackLimit: FEISHU_TEXT_CHUNK_LIMIT,
  });
  const chunkOptions = {
    text: normalizedText,
    limit: postLimit,
    mode: resolveChunkMode(cfg, "feishu", accountId),
  };
  const subChunks = useCard
    ? chunkFeishuCardMarkdown({ ...chunkOptions, header: params.header })
    : chunkFeishuPostMarkdown(chunkOptions);
  const results: Awaited<ReturnType<typeof sendMessageFeishu>>[] = [];
  const preserveThread = replyInThread === true;
  const nextReplyToMessageId = createReplyToFanout({
    replyToId: replyToMessageId,
    replyToIdSource: params.replyToIdSource,
    replyToMode: params.replyToMode ?? "first",
  });
  for (const [i, chunk] of (subChunks.length ? subChunks : [normalizedText]).entries()) {
    // Explicit replies and native topic roots stay sticky; implicit first replies do not.
    try {
      const sendParams = {
        cfg,
        to,
        text: chunk,
        accountId,
        replyToMessageId: preserveThread ? replyToMessageId : nextReplyToMessageId(),
        replyInThread: preserveThread ? true : i === 0 ? replyInThread : undefined,
      };
      const result = useCard
        ? await sendStructuredCardFeishu({ ...sendParams, header: params.header })
        : await sendMessageFeishu({ ...sendParams, preparedPostText: true });
      // Record acceptance before a callback or later chunk can fail.
      results.push(result);
      await reportFeishuOutboundDelivery(result, onDeliveryResult);
    } catch (error) {
      throw partialFeishuSendError(error, results);
    }
  }
  return aggregateFeishuSendResult(results.at(-1)!, results);
}

async function sendFeishuFallbackPayload(params: {
  ctx: FeishuSendPayloadContext;
  payload: FeishuOutboundPayload;
  separateMediaAndText?: boolean;
}) {
  // The direct `send` action stamps this marker when it routes an attachment
  // through the presentation-fallback path; honor it so an upload failure is
  // re-thrown instead of degrading to a fallback-text `ok:true` receipt
  // (issue #112244, ClawSweeper P1). The shared `sendTextMediaPayload` helper
  // cannot carry the flag, so when propagation is requested and there is media
  // to deliver, force the explicit fan-out path that calls `sendMedia` with
  // the flag set.
  const propagateMediaUploadFailure = readFeishuPropagateMediaUploadFailure(params.payload);
  const ctx = { ...params.ctx, payload: params.payload };
  const mediaUrls = normalizeStringEntries(resolvePayloadMediaUrls(params.payload));
  const text = params.payload.text ?? "";
  const textChunks = text ? chunkFeishuMarkdown(text, FEISHU_TEXT_CHUNK_LIMIT) : [];
  const shouldSeparate =
    mediaUrls.length > 0 &&
    (propagateMediaUploadFailure || params.separateMediaAndText === true || textChunks.length > 1);
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
  // Narrow the optional shared `sendMedia` to the Feishu-specific contract so
  // the `propagateMediaUploadFailure` flag can be carried on direct-send
  // fallback delivery (the shared `ChannelOutboundAdapter["sendMedia"]`
  // signature does not declare it).
  const sendMedia: FeishuOutboundSendMedia | undefined = feishuOutbound.sendMedia;
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
      ...(propagateMediaUploadFailure ? { propagateMediaUploadFailure: true } : {}),
    });
  }
  for (const chunk of textChunks) {
    lastResult = await sendText({
      ...ctx,
      text: chunk,
      replyToId: nextReplyToId(),
    });
  }
  return lastResult!;
}

async function sendFeishuTtsSupplementPayload(params: {
  ctx: FeishuSendPayloadContext;
  payload: FeishuOutboundPayload;
  supplement: NonNullable<ReturnType<typeof getReplyPayloadTtsSupplement>>;
  hasVisiblePresentationFallback?: boolean;
  sendVisiblePayload?: (
    replyToId: string | undefined,
  ) => ReturnType<NonNullable<ChannelOutboundAdapter["sendText"]>>;
}) {
  const sendMedia = feishuOutbound.sendMedia;
  const sendText = feishuOutbound.sendText;
  if (!sendMedia || !sendText) {
    throw new Error("Feishu TTS supplement delivery is not available.");
  }

  const { normalizedReplyToId } = resolveFeishuReplyMode({
    replyToId: params.ctx.replyToId,
    threadId: params.ctx.threadId,
  });
  const nextReplyToId = createReplyToFanout({
    replyToId: normalizedReplyToId,
    replyToIdSource: params.ctx.replyToIdSource,
    replyToMode: params.ctx.replyToMode,
  });
  const ctx = { ...params.ctx, payload: params.payload };
  let lastResult: Awaited<ReturnType<typeof sendText>> | undefined;

  // Structured payloads still need their actions. Plain text follows the TTS
  // visibility marker so an existing streamed reply is not duplicated.
  if (params.sendVisiblePayload) {
    lastResult = await params.sendVisiblePayload(nextReplyToId());
    await ctx.onDeliveryResult?.(lastResult);
  } else if (
    params.hasVisiblePresentationFallback ||
    params.supplement.visibleTextAlreadyDelivered !== true
  ) {
    const text = params.payload.text?.trim() ? params.payload.text : params.supplement.spokenText;
    for (const chunk of chunkFeishuMarkdown(text, FEISHU_TEXT_CHUNK_LIMIT)) {
      lastResult = await sendText({
        ...ctx,
        text: chunk,
        replyToId: nextReplyToId(),
      });
    }
  }

  for (const mediaUrl of normalizeStringEntries(resolvePayloadMediaUrls(params.payload))) {
    lastResult = await sendMedia({
      ...ctx,
      text: "",
      mediaUrl,
      replyToId: nextReplyToId(),
      audioAsVoice: params.payload.audioAsVoice ?? ctx.audioAsVoice,
    });
  }
  return lastResult ?? { channel: "feishu", messageId: "" };
}

// `feishuOutbound` keeps the shared `ChannelOutboundAdapter` shape (whose
// `sendMedia` is optional) so the object literal — which spreads
// `createAttachedChannelResultAdapter` (returning `sendMedia?: ... | undefined`)
// — type-checks without a `sendMedia: ... | undefined` mismatch. Callers that
// need the Feishu-specific `propagateMediaUploadFailure` flag narrow the
// optional `sendMedia` to `FeishuOutboundSendMedia` at the use site
// (channel.ts direct-send branch, sendFeishuFallbackPayload) instead of
// forcing a required property here (ClawSweeper P1).
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
    const ttsSupplement = getReplyPayloadTtsSupplement(payload);
    if (parseFeishuCommentTarget(ctx.to)) {
      const { presentation } = resolveFeishuRichReply(payload);
      // Document comments cannot render cards. Resolve the text path before
      // validating card limits so unused native card data cannot block delivery.
      const textCard = readNativeFeishuCardJson(payload.text);
      const fallbackSourceText = textCard ? undefined : payload.text;
      const { commentText: text, fallbackText } = buildFeishuPresentationFallback({
        text: fallbackSourceText,
        presentation,
        fallbackHasCommand:
          isRecord(payload.channelData?.feishu) &&
          payload.channelData.feishu.fallbackHasCommand === true,
      });
      const hasFallbackMedia = normalizeStringEntries(resolvePayloadMediaUrls(payload)).length > 0;
      if (
        !fallbackText.trim() &&
        !hasFallbackMedia &&
        (textCard || readNativeFeishuCard(payload))
      ) {
        throw new Error(
          "Feishu native cards cannot be sent to document comments without a text or media fallback.",
        );
      }
      const fallbackPayload = {
        ...payload,
        text,
        interactive: undefined,
        presentation: undefined,
        // Strip native card / interactive channelData (comments cannot render
        // them) but preserve the direct-send upload-failure propagation marker
        // so a media-upload failure on a comment target stays visible instead
        // of degrading to a fallback-text `ok:true` receipt (issue #112244,
        // ClawSweeper P1).
        channelData: buildFeishuPropagationOnlyChannelData(payload),
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
      const { presentation } = resolveFeishuRichReply(payload);
      const fallbackPayload = presentation
        ? {
            ...payload,
            text: renderFeishuPresentationFallbackText(
              {
                text: readNativeFeishuCardJson(payload.text) ? undefined : payload.text,
                presentation,
              },
              "markdown",
            ),
            presentation: undefined,
            interactive: undefined,
          }
        : payload;
      if (ttsSupplement) {
        return await sendFeishuTtsSupplementPayload({
          ctx,
          payload: fallbackPayload,
          supplement: ttsSupplement,
          // Empty structural presentations must not replay already-streamed prose.
          hasVisiblePresentationFallback:
            presentationFallback?.hasVisibleContent ??
            Boolean(renderFeishuPresentationFallbackText({ presentation }).trim()),
        });
      }
      return await sendFeishuFallbackPayload({
        ctx,
        payload: fallbackPayload,
        separateMediaAndText: presentationFallback !== undefined || presentation !== undefined,
      });
    }

    if (ttsSupplement) {
      return await sendFeishuTtsSupplementPayload({
        ctx,
        payload,
        supplement: ttsSupplement,
        sendVisiblePayload: async (replyToId) => {
          const { replyToMessageId, replyInThread } = resolveFeishuReplyMode({
            replyToId,
            threadId: ctx.threadId,
          });
          return attachChannelToResult(
            "feishu",
            toFeishuOutboundResult(
              await sendCardFeishu({
                cfg: ctx.cfg,
                to: ctx.to,
                card,
                replyToMessageId,
                replyInThread,
                accountId: ctx.accountId ?? undefined,
              }),
            ),
          );
        },
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
      toFeishuOutboundResult(
        await sendPayloadMediaSequenceAndFinalize<
          SendMediaResult,
          Awaited<ReturnType<typeof sendCardFeishu>>
        >({
          text: payload.text ?? "",
          mediaUrls,
          onResult: async (deliveryResult) => {
            await ctx.onDeliveryResult?.(
              attachChannelToResult("feishu", toFeishuOutboundResult(deliveryResult)),
            );
          },
          send: async ({ mediaUrl }) => {
            const { replyToMessageId, replyInThread } = nextReplyMode();
            return await sendMediaFeishu({
              cfg: ctx.cfg,
              to: ctx.to,
              mediaUrl,
              accountId: ctx.accountId ?? undefined,
              mediaAccess: ctx.mediaAccess,
              mediaLocalRoots: ctx.mediaLocalRoots,
              mediaReadFile: ctx.mediaReadFile,
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
      ),
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
      replyToIdSource,
      replyToMode,
      threadId,
      mediaAccess,
      mediaLocalRoots,
      mediaReadFile,
      identity,
      onDeliveryResult,
    }) => {
      const { replyToMessageId, replyInThread } = resolveFeishuReplyMode({
        replyToId,
        threadId,
      });
      const deliveryOptions = { replyToIdSource, replyToMode, onDeliveryResult };
      // Scheme A compatibility shim:
      // when upstream accidentally returns a local image path as plain text,
      // auto-upload and send as Feishu image message instead of leaking path text.
      const localImagePath = normalizePossibleLocalImagePath(text);
      if (localImagePath) {
        let mediaResult: Awaited<ReturnType<typeof sendMediaFeishu>>;
        try {
          mediaResult = await sendMediaFeishu({
            cfg,
            to,
            mediaUrl: localImagePath,
            accountId: accountId ?? undefined,
            replyToMessageId,
            replyInThread,
            mediaAccess,
            mediaLocalRoots,
            mediaReadFile,
          });
        } catch (err) {
          if (isChannelPartialDeliveryError(err)) {
            // The image already reached Feishu; fallback text would duplicate a visible send.
            throw err;
          }
          console.error(`[feishu] local image path auto-send failed:`, err);
          return toFeishuOutboundResult(
            await sendOutboundText({
              cfg,
              to,
              text: await buildFeishuMediaFallbackText({}),
              accountId: accountId ?? undefined,
              replyToMessageId,
              replyInThread,
              ...deliveryOptions,
            }),
          );
        }
        return toFeishuOutboundResult(
          await reportFeishuOutboundDelivery(mediaResult, onDeliveryResult),
        );
      }

      if (parseFeishuCommentTarget(to)) {
        return toFeishuOutboundResult(
          await sendOutboundText({
            cfg,
            to,
            text,
            accountId: accountId ?? undefined,
            replyToMessageId,
            replyInThread,
            ...deliveryOptions,
          }),
        );
      }

      const card = readNativeFeishuCardJson(text);
      if (card) {
        assertFeishuCardWithinEnvelope(card, "Feishu native card");
        return toFeishuOutboundResult(
          await reportFeishuOutboundDelivery(
            await sendCardFeishu({
              cfg,
              to,
              card: markRenderedFeishuCard(card),
              accountId: accountId ?? undefined,
              replyToMessageId,
              replyInThread,
            }),
            onDeliveryResult,
          ),
        );
      }

      const title = identity ? resolveFeishuIdentityHeaderTitle(identity) : undefined;
      return toFeishuOutboundResult(
        await sendOutboundText({
          cfg,
          to,
          text,
          accountId: accountId ?? undefined,
          replyToMessageId,
          replyInThread,
          header: title ? { title, template: "blue" } : undefined,
          ...deliveryOptions,
        }),
      );
    },
    sendMedia: async ({
      cfg,
      to,
      text,
      mediaUrl,
      audioAsVoice,
      accountId,
      mediaAccess,
      mediaLocalRoots,
      mediaReadFile,
      replyToId,
      replyToIdSource,
      replyToMode,
      threadId,
      onDeliveryResult,
      propagateMediaUploadFailure = false,
    }: Parameters<NonNullable<ChannelOutboundAdapter["sendMedia"]>>[0] & {
      /** When true, a media-upload failure is re-thrown to the caller instead of
       * being converted to a fallback text success. The direct `send` action
       * sets this so an agent that requested an attachment receives a visible
       * failure when the attachment cannot be delivered, rather than an `ok:true`
       * receipt for a text-only fallback (issue #112244). */
      propagateMediaUploadFailure?: boolean;
    }) => {
      const { normalizedReplyToId } = resolveFeishuReplyMode({
        replyToId,
        threadId,
      });
      const nextReplyToId = createReplyToFanout({
        replyToId: normalizedReplyToId,
        replyToIdSource,
        replyToMode,
      });
      const nextReplyMode = () => {
        const { replyToMessageId, replyInThread } = resolveFeishuReplyMode({
          replyToId: nextReplyToId(),
          threadId,
        });
        return { replyToMessageId, replyInThread };
      };
      const deliveryOptions = { replyToIdSource, replyToMode, onDeliveryResult };
      if (parseFeishuCommentTarget(to)) {
        // Feishu document comments cannot host a media attachment; the mediaUrl
        // is rendered as a fallback text link instead. This visible-link
        // fallback is the established comment-target behavior on main and is
        // NOT the silent text-only `ok:true` drop issue #112244 removes — the
        // recipient sees the media URL as a clickable link, so the attachment
        // intent is visibly delivered even though the comment cannot render the
        // media inline. The direct-send upload-failure propagation policy
        // therefore does not apply here: it targets actual media-upload failures
        // (the `sendMediaFeishu` catch below), and a comment target never
        // reaches that upload path. Keep the fallback for both `send` and
        // thread-reply so comment targets retain their visible media-link
        // delivery (issue #112244, ClawSweeper fourteenth-review P1).
        const commentText = mediaUrl?.trim()
          ? await buildFeishuMediaFallbackText({
              text,
              mediaUrl,
              mediaLinkStyle: "plain",
            })
          : (text?.trim() ?? "");
        return toFeishuOutboundResult(
          await sendOutboundText({
            cfg,
            to,
            text: commentText,
            accountId: accountId ?? undefined,
            ...nextReplyMode(),
            ...deliveryOptions,
          }),
        );
      }

      if (!mediaUrl) {
        return toFeishuOutboundResult(
          await sendOutboundText({
            cfg,
            to,
            text: text ?? "",
            accountId: accountId ?? undefined,
            ...nextReplyMode(),
            ...deliveryOptions,
          }),
        );
      }

      const suppressTextForVoiceMedia = shouldSuppressFeishuTextForVoiceMedia({
        mediaUrl,
        audioAsVoice,
      });
      let captionResult: Awaited<ReturnType<typeof sendOutboundText>> | undefined;

      // Send text first if provided, except for Feishu native voice bubbles.
      if (text?.trim() && !suppressTextForVoiceMedia) {
        captionResult = await sendOutboundText({
          cfg,
          to,
          text,
          accountId: accountId ?? undefined,
          ...nextReplyMode(),
          ...deliveryOptions,
        });
      }

      const results: FeishuReplyDeliverySource[] = captionResult ? [captionResult] : [];
      let mediaResult: Awaited<ReturnType<typeof sendMediaFeishu>>;
      const mediaReplyMode = nextReplyMode();
      try {
        mediaResult = await sendMediaFeishu({
          cfg,
          to,
          mediaUrl,
          accountId: accountId ?? undefined,
          mediaAccess,
          mediaLocalRoots,
          mediaReadFile,
          ...mediaReplyMode,
          ...(audioAsVoice === true ? { audioAsVoice: true } : {}),
        });
      } catch (err) {
        if (isChannelPartialDeliveryError(err)) {
          // Accepted media is not an upload failure and must never trigger a second send.
          throw partialFeishuSendError(err, results);
        }
        if (propagateMediaUploadFailure) {
          // The direct `send` action requested a controlled failure when the
          // attachment cannot be delivered, so the agent receives a visible
          // error instead of an `ok:true` receipt for a text-only fallback
          // (issue #112244). When the caption was already delivered, preserve
          // its receipt as the existing partial-delivery outcome so the caller
          // knows the text is visible and does not retry it (which would
          // duplicate the caption); only a send with no delivered caption is a
          // wholly failed send.
          if (captionResult) {
            throw partialFeishuSendError(err, results);
          }
          throw new Error(
            `Feishu send could not deliver the requested media attachment: ${
              err instanceof Error ? err.message : String(err)
            }`,
            { cause: err },
          );
        }
        console.error(`[feishu] sendMediaFeishu failed:`, err);
        const fallbackText = await buildFeishuMediaFallbackText({
          text: captionResult ? undefined : text,
          mediaUrl,
        });
        try {
          const fallbackResult = await sendOutboundText({
            cfg,
            to,
            text: fallbackText,
            accountId: accountId ?? undefined,
            // A rejected upload never delivered its attempted reply target.
            ...(captionResult ? nextReplyMode() : mediaReplyMode),
            ...deliveryOptions,
          });
          return toFeishuOutboundResult(
            aggregateFeishuSendResult(fallbackResult, [...results, fallbackResult]),
          );
        } catch (error) {
          throw partialFeishuSendError(error, results);
        }
      }

      // Persist the accepted attachment before any later fallible text action.
      results.push(mediaResult);
      try {
        await reportFeishuOutboundDelivery(mediaResult, onDeliveryResult);
        if (mediaResult.voiceIntentDegradedToFile && text?.trim()) {
          results.push(
            await sendOutboundText({
              cfg,
              to,
              text,
              accountId: accountId ?? undefined,
              ...nextReplyMode(),
              ...deliveryOptions,
            }),
          );
        }
      } catch (error) {
        throw partialFeishuSendError(error, results);
      }
      return toFeishuOutboundResult(aggregateFeishuSendResult(mediaResult, results));
    },
  }),
};
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
