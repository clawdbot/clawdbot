import type { ChannelOutboundAdapter } from "../channels/plugins/outbound.types.js";
import { readStringValue } from "../shared/string-coerce.js";

export type { MediaPayload, MediaPayloadInput } from "../channels/plugins/media-payload.js";
export { buildMediaPayload } from "../channels/plugins/media-payload.js";
export type { ReplyPayload } from "../auto-reply/reply-payload.js";

export type OutboundReplyPayload = {
  text?: string;
  mediaUrls?: string[];
  mediaUrl?: string;
  replyToId?: string;
};

export type SendableOutboundReplyParts = {
  text: string;
  trimmedText: string;
  mediaUrls: string[];
  mediaCount: number;
  hasText: boolean;
  hasMedia: boolean;
  hasContent: boolean;
};

type SendPayloadContext = Parameters<NonNullable<ChannelOutboundAdapter["sendPayload"]>>[0];
type SendPayloadResult = Awaited<ReturnType<NonNullable<ChannelOutboundAdapter["sendPayload"]>>>;
type SendPayloadAdapter = Pick<
  ChannelOutboundAdapter,
  "sendMedia" | "sendText" | "chunker" | "textChunkLimit"
>;

/** Extract the supported outbound reply fields from loose tool or agent payload objects. */
export function normalizeOutboundReplyPayload(
  payload: Record<string, unknown>,
): OutboundReplyPayload {
  const text = readStringValue(payload.text);
  const mediaUrls = Array.isArray(payload.mediaUrls)
    ? payload.mediaUrls.filter(
        (entry): entry is string => typeof entry === "string" && entry.length > 0,
      )
    : undefined;
  const mediaUrl = readStringValue(payload.mediaUrl);
  const replyToId = readStringValue(payload.replyToId);
  return {
    text,
    mediaUrls,
    mediaUrl,
    replyToId,
  };
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

/** Check whether an outbound payload includes any sendable text or media. */
export function hasOutboundReplyContent(
  payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string },
  options?: { trimText?: boolean },
): boolean {
  return hasOutboundText(payload, { trim: options?.trimText }) || hasOutboundMedia(payload);
}

/** Normalize reply payload text/media into a trimmed, sendable shape for delivery paths. */
export function resolveSendableOutboundReplyParts(
  payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string },
  options?: { text?: string },
): SendableOutboundReplyParts {
  const text = options?.text ?? payload.text ?? "";
  const trimmedText = text.trim();
  const mediaUrls = resolveOutboundMediaUrls(payload)
    .map((entry) => entry.trim())
    .filter(Boolean);
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
  ctx: TContext;
  textChunkLimit?: number;
  chunker?: ((text: string, limit: number) => string[]) | null;
  sendText: (ctx: TContext & { text: string }) => Promise<TResult>;
  sendMedia: (ctx: TContext & { text: string; mediaUrl: string }) => Promise<TResult>;
  emptyResult: TResult;
}): Promise<TResult> {
  const payload = params.ctx.payload as { text?: string; mediaUrls?: string[]; mediaUrl?: string };
  const text = payload.text ?? "";
  const urls = resolveOutboundMediaUrls(payload);
  if (!text && urls.length === 0) {
    return params.emptyResult;
  }
  if (urls.length > 0) {
    let lastResult = await params.sendMedia({
      ...params.ctx,
      text,
      mediaUrl: urls[0],
    });
    for (let i = 1; i < urls.length; i++) {
      lastResult = await params.sendMedia({
        ...params.ctx,
        text: "",
        mediaUrl: urls[i],
      });
    }
    return lastResult;
  }
  const limit = params.textChunkLimit;
  const chunks = limit && params.chunker ? params.chunker(text, limit) : [text];
  let lastResult: TResult;
  for (const chunk of chunks) {
    lastResult = await params.sendText({ ...params.ctx, text: chunk });
  }
  return lastResult!;
}

export async function sendPayloadMediaSequence<TResult>(params: {
  text: string;
  mediaUrls: readonly string[];
  send: (input: {
    text: string;
    mediaUrl: string;
    index: number;
    isFirst: boolean;
  }) => Promise<TResult>;
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
  }
  return lastResult;
}

export async function sendPayloadMediaSequenceOrFallback<TResult>(params: {
  text: string;
  mediaUrls: readonly string[];
  send: (input: {
    text: string;
    mediaUrl: string;
    index: number;
    isFirst: boolean;
  }) => Promise<TResult>;
  fallbackResult: TResult;
  sendNoMedia?: () => Promise<TResult>;
}): Promise<TResult> {
  if (params.mediaUrls.length === 0) {
    return params.sendNoMedia ? await params.sendNoMedia() : params.fallbackResult;
  }
  return (await sendPayloadMediaSequence(params)) ?? params.fallbackResult;
}

export async function sendPayloadMediaSequenceAndFinalize<TMediaResult, TResult>(params: {
  text: string;
  mediaUrls: readonly string[];
  send: (input: {
    text: string;
    mediaUrl: string;
    index: number;
    isFirst: boolean;
  }) => Promise<TMediaResult>;
  finalize: () => Promise<TResult>;
}): Promise<TResult> {
  if (params.mediaUrls.length > 0) {
    await sendPayloadMediaSequence(params);
  }
  return await params.finalize();
}

export async function sendTextMediaPayload(params: {
  channel: string;
  ctx: SendPayloadContext;
  adapter: SendPayloadAdapter;
}): Promise<SendPayloadResult> {
  const text = params.ctx.payload.text ?? "";
  const urls = resolvePayloadMediaUrls(params.ctx.payload);
  if (!text && urls.length === 0) {
    return { channel: params.channel, messageId: "" };
  }
  if (urls.length > 0) {
    const lastResult = await sendPayloadMediaSequence({
      text,
      mediaUrls: urls,
      send: async ({ text, mediaUrl }) =>
        await params.adapter.sendMedia!({
          ...params.ctx,
          text,
          mediaUrl,
        }),
    });
    return lastResult ?? { channel: params.channel, messageId: "" };
  }
  const limit = params.adapter.textChunkLimit;
  const chunks = limit && params.adapter.chunker ? params.adapter.chunker(text, limit) : [text];
  let lastResult: Awaited<ReturnType<NonNullable<typeof params.adapter.sendText>>>;
  for (const chunk of chunks) {
    lastResult = await params.adapter.sendText!({ ...params.ctx, text: chunk });
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
