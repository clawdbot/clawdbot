// Reply payload helpers normalize plugin reply targets, text, media, and approval metadata.
import { normalizeLowercaseStringOrEmpty } from "../../packages/normalization-core/src/string-coerce.js";
import { normalizeStringEntries } from "../../packages/normalization-core/src/string-normalization.js";
import type { ReplyPayload as InternalReplyPayload } from "../auto-reply/reply-payload.js";
import type { ChannelOutboundAdapter } from "../channels/plugins/outbound.types.js";
import { normalizeOutboundReplyPayload as normalizeCoreOutboundReplyPayload } from "../infra/outbound/reply-payload-normalize.js";
import { createReplyToFanout } from "../infra/outbound/reply-policy.js";
import { hasReplyPayloadContent } from "../interactive/payload.js";

export type { MediaPayload, MediaPayloadInput } from "../channels/plugins/media-payload.js";
export { buildMediaPayload } from "../channels/plugins/media-payload.js";
/** Plugin-facing reply payload without core-only trusted local media internals. */
export type ReplyPayload = Omit<InternalReplyPayload, "trustedLocalMedia">;
export type { ReplyPayloadTtsSupplement } from "../auto-reply/reply-payload.js";
export {
  buildTtsSupplementMediaPayload,
  FAST_MODE_AUTO_PROGRESS_KIND,
  getReplyPayloadTtsSupplement,
  isFastModeAutoProgressPayload,
  isReplyPayloadNonTerminalToolErrorWarning,
  isReplyPayloadTtsSupplement,
  markReplyPayloadAsTtsSupplement,
} from "../auto-reply/reply-payload.js";

/** Normalized outbound reply payload accepted by channel send helpers. */
export type OutboundReplyPayload = {
  /** Plain text reply body. */
  text?: string;
  /** Ordered media attachments for channels that can send multiple media items. */
  mediaUrls?: string[];
  /** Legacy single media attachment. */
  mediaUrl?: string;
  /** Rich presentation payload for channels that support structured replies. */
  presentation?: InternalReplyPayload["presentation"];
  /**
   * @deprecated Use presentation. Runtime support remains for legacy producers.
   */
  interactive?: InternalReplyPayload["interactive"];
  /** Channel-specific opaque data forwarded to outbound adapters. */
  channelData?: InternalReplyPayload["channelData"];
  /** Marks media as sensitive for channel-specific spoiler/safety handling. */
  sensitiveMedia?: boolean;
  /** Platform message id that the outbound reply should target when supported. */
  replyToId?: string;
};

/** Minimal payload shape used to identify reasoning/thinking replies. */
export type ReasoningReplyPayload = {
  /** Reply text that may carry hidden reasoning markers. */
  text?: string;
  /** Explicit reasoning flag from upstream payload producers. */
  isReasoning?: boolean;
  /** Marks pre-tool commentary (💬) — a display lane, suppressed unless the channel opts in. */
  isCommentary?: boolean;
};

/** Derived sendability facts for text/media outbound payload delivery. */
export type SendableOutboundReplyParts = {
  /** Raw text selected for delivery before trimming. */
  text: string;
  /** Text after trimming whitespace for sendability checks. */
  trimmedText: string;
  /** Normalized non-empty media URLs. */
  mediaUrls: string[];
  /** Number of normalized media URLs. */
  mediaCount: number;
  /** Whether trimmed text is sendable. */
  hasText: boolean;
  /** Whether at least one media URL is sendable. */
  hasMedia: boolean;
  /** Whether the payload has any sendable text or media. */
  hasContent: boolean;
};

type SendPayloadContext = Parameters<NonNullable<ChannelOutboundAdapter["sendPayload"]>>[0];
type SendPayloadResult = Awaited<ReturnType<NonNullable<ChannelOutboundAdapter["sendPayload"]>>>;
type SendPayloadAdapter = Pick<
  ChannelOutboundAdapter,
  "sendMedia" | "sendText" | "chunker" | "textChunkLimit"
>;

const REASONING_PREFIX_RE = /^(?:reasoning:|thinking\.{0,3}(?=\s*(?:>\s*)?_))/u;

function trimLeadingMarkdownQuoteMarkers(text: string): string {
  let candidate = text.trimStart();
  while (candidate.startsWith(">")) {
    candidate = candidate.replace(/^(?:>[ \t]?)+/, "").trimStart();
  }
  return candidate;
}

/** Detect reasoning replies from explicit flags or common reasoning text prefixes. */
export function isReasoningReplyPayload(payload: ReasoningReplyPayload): boolean {
  if (payload.isReasoning === true) {
    return true;
  }
  const text = payload.text;
  if (typeof text !== "string") {
    return false;
  }
  const normalized = normalizeLowercaseStringOrEmpty(text.trimStart());
  if (REASONING_PREFIX_RE.test(normalized)) {
    return true;
  }
  const unquoted = normalizeLowercaseStringOrEmpty(trimLeadingMarkdownQuoteMarkers(text));
  return REASONING_PREFIX_RE.test(unquoted);
}

/** Extract the supported outbound reply fields from loose tool or agent payload objects. */
export function normalizeOutboundReplyPayload(
  payload: Record<string, unknown>,
): OutboundReplyPayload {
  return normalizeCoreOutboundReplyPayload(payload);
}

/** Wrap a deliverer so callers can hand it arbitrary payloads while channels receive normalized data. */
export function createNormalizedOutboundDeliverer(
  handler: (payload: OutboundReplyPayload) => Promise<void>,
): (payload: unknown) => Promise<void> {
  return async (payload: unknown) => {
    const normalized =
      payload && typeof payload === "object"
        ? normalizeOutboundReplyPayload(payload as Record<string, unknown>)
        : {};
    await handler(normalized);
  };
}

/** Prefer multi-attachment payloads, then fall back to the legacy single-media field. */
export function resolveOutboundMediaUrls(payload: {
  mediaUrls?: string[];
  mediaUrl?: string;
}): string[] {
  if (payload.mediaUrls?.length) {
    return payload.mediaUrls;
  }
  if (payload.mediaUrl) {
    return [payload.mediaUrl];
  }
  return [];
}

/** Resolve media URLs from a channel sendPayload context after legacy fallback normalization. */
export function resolvePayloadMediaUrls(payload: SendPayloadContext["payload"]): string[] {
  return resolveOutboundMediaUrls(payload);
}

/** Count outbound media items after legacy single-media fallback normalization. */
export function countOutboundMedia(payload: { mediaUrls?: string[]; mediaUrl?: string }): number {
  return resolveOutboundMediaUrls(payload).length;
}

/** Check whether an outbound payload includes any media after normalization. */
export function hasOutboundMedia(payload: { mediaUrls?: string[]; mediaUrl?: string }): boolean {
  return countOutboundMedia(payload) > 0;
}

/** Check whether an outbound payload includes text, optionally trimming whitespace first. */
export function hasOutboundText(payload: { text?: string }, options?: { trim?: boolean }): boolean {
  const text = options?.trim ? payload.text?.trim() : payload.text;
  return Boolean(text);
}

/** Check whether an outbound payload includes any sendable text, media, or rich reply content. */
export function hasOutboundReplyContent(
  payload: {
    text?: string;
    mediaUrls?: string[];
    mediaUrl?: string;
    presentation?: unknown;
    interactive?: unknown;
    channelData?: unknown;
  },
  options?: { trimText?: boolean },
): boolean {
  return hasReplyPayloadContent(payload, { trimText: options?.trimText });
}

/** Normalize reply payload text/media into a trimmed, sendable shape for delivery paths. */
export function resolveSendableOutboundReplyParts(
  payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string },
  options?: { text?: string },
): SendableOutboundReplyParts {
  const text = options?.text ?? payload.text ?? "";
  const trimmedText = text.trim();
  const mediaUrls = normalizeStringEntries(resolveOutboundMediaUrls(payload));
  const mediaCount = mediaUrls.length;
  const hasText = Boolean(trimmedText);
  const hasMedia = mediaCount > 0;
  return {
    text,
    trimmedText,
    mediaUrls,
    mediaCount,
    hasText,
    hasMedia,
    hasContent: hasText || hasMedia,
  };
}

/** Preserve caller-provided chunking, but fall back to the full text when chunkers return nothing. */
export function resolveTextChunksWithFallback(text: string, chunks: readonly string[]): string[] {
  if (chunks.length > 0) {
    return [...chunks];
  }
  if (!text) {
    return [];
  }
  return [text];
}

/** Send media-first payloads intact, or chunk text-only payloads through the caller's transport hooks. */
export async function sendPayloadWithChunkedTextAndMedia<
  TContext extends { payload: object },
  TResult,
>(params: {
  /** Caller context containing the loose outbound payload. */
  ctx: TContext;
  /** Text length limit passed to the chunker for text-only payloads. */
  textChunkLimit?: number;
  /** Optional text chunker used only when no media URLs are present. */
  chunker?: ((text: string, limit: number) => string[]) | null;
  /** Transport hook for text-only chunks. */
  sendText: (ctx: TContext & { text: string }) => Promise<TResult>;
  /** Transport hook for media sends; first media receives the caption text. */
  sendMedia: (ctx: TContext & { text: string; mediaUrl: string }) => Promise<TResult>;
  /** Result returned when payload has neither text nor media. */
  emptyResult: TResult;
  /** Host callback that persists each completed sub-send before the next one starts. */
  onResult?: (result: TResult) => Promise<void> | void;
}): Promise<TResult> {
  const payload = params.ctx.payload as { text?: string; mediaUrls?: string[]; mediaUrl?: string };
  const text = payload.text ?? "";
  const urls = resolveOutboundMediaUrls(payload);
  if (!text && urls.length === 0) {
    return params.emptyResult;
  }
  const [firstUrl, ...remainingUrls] = urls;
  if (firstUrl !== undefined) {
    // Caption-limited transports get text only on the first media item; the
    // final result still represents the last platform send.
    let lastResult = await params.sendMedia({
      ...params.ctx,
      text,
      mediaUrl: firstUrl,
    });
    await params.onResult?.(lastResult);
    for (const mediaUrl of remainingUrls) {
      lastResult = await params.sendMedia({
        ...params.ctx,
        text: "",
        mediaUrl,
      });
      await params.onResult?.(lastResult);
    }
    return lastResult;
  }
  const limit = params.textChunkLimit;
  const chunks = limit && params.chunker ? params.chunker(text, limit) : [text];
  const [firstChunk, ...remainingChunks] = chunks;
  if (firstChunk === undefined) {
    return params.emptyResult;
  }
  let lastResult = await params.sendText({ ...params.ctx, text: firstChunk });
  await params.onResult?.(lastResult);
  for (const chunk of remainingChunks) {
    lastResult = await params.sendText({ ...params.ctx, text: chunk });
    await params.onResult?.(lastResult);
  }
  return lastResult;
}

/** Sends a media sequence with caption text on the first item and returns the last send result. */
export async function sendPayloadMediaSequence<TResult>(params: {
  /** Caption text attached to the first non-empty media URL only. */
  text: string;
  /** Ordered media URLs to send, with empty entries skipped. */
  mediaUrls: readonly string[];
  send: (input: {
    /** Caption text for the first media send, otherwise empty. */
    text: string;
    /** Media URL for this send. */
    mediaUrl: string;
    /** Original index in `mediaUrls`. */
    index: number;
    /** Whether this is the first media entry in the original sequence. */
    isFirst: boolean;
  }) => Promise<TResult>;
  /** Called after each successful media send and before the next send starts. */
  onResult?: (result: TResult) => Promise<void> | void;
}): Promise<TResult | undefined> {
  let lastResult: TResult | undefined;
  for (let i = 0; i < params.mediaUrls.length; i += 1) {
    const mediaUrl = params.mediaUrls[i];
    if (!mediaUrl) {
      continue;
    }
    lastResult = await params.send({
      text: i === 0 ? params.text : "",
      mediaUrl,
      index: i,
      isFirst: i === 0,
    });
    await params.onResult?.(lastResult);
  }
  return lastResult;
}

/** Sends a media sequence or returns a fallback when no media send produces a result. */
export async function sendPayloadMediaSequenceOrFallback<TResult>(params: {
  /** Caption text attached to the first non-empty media URL only. */
  text: string;
  /** Ordered media URLs to send, with empty entries skipped. */
  mediaUrls: readonly string[];
  send: (input: {
    text: string;
    mediaUrl: string;
    index: number;
    isFirst: boolean;
  }) => Promise<TResult>;
  onResult?: (result: TResult) => Promise<void> | void;
  /** Result returned when no media result is available. */
  fallbackResult: TResult;
  /** Optional callback used instead of `fallbackResult` when there are no media URLs. */
  sendNoMedia?: () => Promise<TResult>;
}): Promise<TResult> {
  if (params.mediaUrls.length === 0) {
    return params.sendNoMedia ? await params.sendNoMedia() : params.fallbackResult;
  }
  return (await sendPayloadMediaSequence(params)) ?? params.fallbackResult;
}

/** Sends media when present, then always runs finalization and returns its result. */
export async function sendPayloadMediaSequenceAndFinalize<TMediaResult, TResult>(params: {
  /** Caption text attached to the first non-empty media URL only. */
  text: string;
  /** Ordered media URLs to send before finalization. */
  mediaUrls: readonly string[];
  send: (input: {
    text: string;
    mediaUrl: string;
    index: number;
    isFirst: boolean;
  }) => Promise<TMediaResult>;
  onResult?: (result: TMediaResult) => Promise<void> | void;
  /** Final callback whose result is returned after optional media sends. */
  finalize: () => Promise<TResult>;
}): Promise<TResult> {
  if (params.mediaUrls.length > 0) {
    await sendPayloadMediaSequence(params);
  }
  return await params.finalize();
}

/** Sends normalized text/media payloads through a channel outbound adapter. */
export async function sendTextMediaPayload(params: {
  /** Channel id used in the empty fallback result. */
  channel: string;
  /** Channel send payload context. */
  ctx: SendPayloadContext;
  /** Adapter transport hooks for text, media, and optional chunking. */
  adapter: SendPayloadAdapter;
}): Promise<SendPayloadResult> {
  const text = params.ctx.payload.text ?? "";
  const urls = resolvePayloadMediaUrls(params.ctx.payload);
  if (!text && urls.length === 0) {
    return { channel: params.channel, messageId: "" };
  }
  // Reply fanout may be single-use for implicit replies, so resolve it exactly
  // once per platform send rather than copying the initial id into every part.
  const nextReplyToId = createReplyToFanout(params.ctx);
  if (urls.length > 0) {
    const audioAsVoice = params.ctx.payload.audioAsVoice ?? params.ctx.audioAsVoice;
    const lastResult = await sendPayloadMediaSequence({
      text,
      mediaUrls: urls,
      send: async ({ text: textLocal, mediaUrl }) => {
        let childReported = false;
        const result = await params.adapter.sendMedia!({
          ...params.ctx,
          text: textLocal,
          mediaUrl,
          ...(audioAsVoice === undefined ? {} : { audioAsVoice }),
          replyToId: nextReplyToId(),
          onDeliveryResult: async (deliveryResult) => {
            childReported = true;
            await params.ctx.onDeliveryResult?.(deliveryResult);
          },
        });
        if (!childReported) {
          await params.ctx.onDeliveryResult?.(result);
        }
        return result;
      },
    });
    return lastResult ?? { channel: params.channel, messageId: "" };
  }
  const limit = params.adapter.textChunkLimit;
  const chunks =
    limit && params.adapter.chunker
      ? params.adapter.chunker(text, limit, { formatting: params.ctx.formatting })
      : [text];
  let lastResult: Awaited<ReturnType<NonNullable<typeof params.adapter.sendText>>>;
  for (const chunk of chunks) {
    let childReported = false;
    lastResult = await params.adapter.sendText!({
      ...params.ctx,
      text: chunk,
      replyToId: nextReplyToId(),
      onDeliveryResult: async (deliveryResult) => {
        childReported = true;
        await params.ctx.onDeliveryResult?.(deliveryResult);
      },
    });
    if (!childReported) {
      await params.ctx.onDeliveryResult?.(lastResult);
    }
  }
  return lastResult!;
}

/** Detect numeric-looking target ids for channels that distinguish ids from handles. */
export function isNumericTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  return /^\d{3,}$/.test(trimmed);
}

/** Append attachment links to plain text when the channel cannot send media inline. */
export function formatTextWithAttachmentLinks(
  text: string | undefined,
  mediaUrls: string[],
): string {
  const trimmedText = text?.trim() ?? "";
  if (!trimmedText && mediaUrls.length === 0) {
    return "";
  }
  const mediaBlock = mediaUrls.length
    ? mediaUrls.map((url) => `Attachment: ${url}`).join("\n")
    : "";
  if (!trimmedText) {
    return mediaBlock;
  }
  if (!mediaBlock) {
    return trimmedText;
  }
  return `${trimmedText}\n\n${mediaBlock}`;
}

/** Send a caption with only the first media item, mirroring caption-limited channel transports. */
export async function sendMediaWithLeadingCaption(params: {
  mediaUrls: string[];
  caption: string;
  send: (payload: { mediaUrl: string; caption?: string }) => Promise<void>;
  onError?: (params: {
    error: unknown;
    mediaUrl: string;
    caption?: string;
    index: number;
    isFirst: boolean;
  }) => Promise<void> | void;
}): Promise<boolean> {
  if (params.mediaUrls.length === 0) {
    return false;
  }

  for (const [index, mediaUrl] of params.mediaUrls.entries()) {
    const isFirst = index === 0;
    const caption = isFirst ? params.caption : undefined;
    try {
      await params.send({ mediaUrl, caption });
    } catch (error) {
      if (params.onError) {
        await params.onError({
          error,
          mediaUrl,
          caption,
          index,
          isFirst,
        });
        continue;
      }
      throw error;
    }
  }
  return true;
}

/** Deliver media with leading caption when possible, otherwise fall back to chunked text. */
export async function deliverTextOrMediaReply(params: {
  payload: OutboundReplyPayload;
  text: string;
  chunkText?: (text: string) => readonly string[];
  sendText: (text: string) => Promise<void>;
  sendMedia: (payload: { mediaUrl: string; caption?: string }) => Promise<void>;
  onMediaError?: (params: {
    error: unknown;
    mediaUrl: string;
    caption?: string;
    index: number;
    isFirst: boolean;
  }) => Promise<void> | void;
}): Promise<"empty" | "text" | "media"> {
  const { mediaUrls } = resolveSendableOutboundReplyParts(params.payload, {
    text: params.text,
  });
  const sentMedia = await sendMediaWithLeadingCaption({
    mediaUrls,
    caption: params.text,
    send: params.sendMedia,
    onError: params.onMediaError,
  });
  if (sentMedia) {
    return "media";
  }
  if (!params.text) {
    return "empty";
  }
  const chunks = params.chunkText ? params.chunkText(params.text) : [params.text];
  let sentText = false;
  for (const chunk of chunks) {
    if (!chunk) {
      continue;
    }
    await params.sendText(chunk);
    sentText = true;
  }
  return sentText ? "text" : "empty";
}

/** Send text with attachment links appended for channels without native media upload. */
export async function deliverFormattedTextWithAttachments(params: {
  payload: OutboundReplyPayload;
  send: (params: { text: string; replyToId?: string }) => Promise<void>;
}): Promise<boolean> {
  const text = formatTextWithAttachmentLinks(
    params.payload.text,
    resolveOutboundMediaUrls(params.payload),
  );
  if (!text) {
    return false;
  }
  await params.send({
    text,
    replyToId: params.payload.replyToId,
  });
  return true;
}
