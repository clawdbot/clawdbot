/**
 * Outbound delivery helpers.
 *
 * The gateway deliver callback uses two pipelines:
 * 1. `parseAndSendMediaTags` handles `<qqimg/qqvoice/qqvideo/qqfile/qqmedia>` tags in order.
 * 2. `sendPlainReply` handles plain replies, including markdown images and mixed text/media.
 */

import {
  sendC2CMessage,
  sendDmMessage,
  sendGroupMessage,
  sendChannelMessage,
  sendC2CImageMessage,
  sendGroupImageMessage,
} from "./api.js";
import {
  sendPhoto,
  sendVoice,
  sendVideoMsg,
  sendDocument,
  sendMedia as sendMediaAuto,
  type MediaTargetContext,
} from "./outbound.js";
import { getQQBotRuntime } from "./runtime.js";
import { chunkText, TEXT_CHUNK_LIMIT } from "./text-utils.js";
import type { ResolvedQQBotAccount } from "./types.js";
import { getImageSize, formatQQBotMarkdownImage, hasQQBotImageSize } from "./utils/image-size.js";
import { normalizeMediaTags } from "./utils/media-tags.js";
import { normalizePath, isLocalPath as isLocalFilePath } from "./utils/platform.js";
import { filterInternalMarkers } from "./utils/text-parsing.js";

// Type definitions.

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeLowercaseStringOrEmpty(value: unknown): string {
  return normalizeOptionalString(value)?.toLowerCase() ?? "";
}

export interface DeliverEventContext {
  type: "c2c" | "guild" | "dm" | "group";
  senderId: string;
  messageId: string;
  channelId?: string;
  guildId?: string;
  groupOpenid?: string;
  msgIdx?: string;
}

export interface DeliverAccountContext {
  account: ResolvedQQBotAccount;
  qualifiedTarget: string;
  log?: {
    info: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
  };
}

/** Wrapper that retries when the access token expires. */
export type SendWithRetryFn = <T>(sendFn: (token: string) => Promise<T>) => Promise<T>;

/** Consume a quote ref exactly once. */
export type ConsumeQuoteRefFn = () => string | undefined;

function resolveQQBotMediaTargetContext(
  event: DeliverEventContext,
  account: ResolvedQQBotAccount,
  prefix: string,
): MediaTargetContext {
  return {
    targetType:
      event.type === "c2c"
        ? "c2c"
        : event.type === "group"
          ? "group"
          : event.type === "dm"
            ? "dm"
            : "channel",
    targetId:
      event.type === "c2c"
        ? event.senderId
        : event.type === "group"
          ? event.groupOpenid!
          : event.type === "dm"
            ? event.guildId!
            : event.channelId!,
    account,
    replyToId: event.messageId,
    logPrefix: prefix,
  };
}

async function sendQQBotAutoMediaBatch(params: {
  qualifiedTarget: string;
  account: ResolvedQQBotAccount;
  replyToId: string;
  mediaUrls: string[];
  log?: DeliverAccountContext["log"];
  onResultError: (mediaUrl: string, error: string) => string;
  onThrownError: (mediaUrl: string, error: string) => string;
  onSuccess?: (mediaUrl: string) => string | undefined;
}): Promise<void> {
  for (const mediaUrl of params.mediaUrls) {
    try {
      const result = await sendMediaAuto({
        to: params.qualifiedTarget,
        text: "",
        mediaUrl,
        accountId: params.account.accountId,
        replyToId: params.replyToId,
        account: params.account,
      });
      if (result.error) {
        params.log?.error(params.onResultError(mediaUrl, result.error));
        continue;
      }
      const successMessage = params.onSuccess?.(mediaUrl);
      if (successMessage) {
        params.log?.info(successMessage);
      }
    } catch (err) {
      params.log?.error(params.onThrownError(mediaUrl, String(err)));
    }
  }
}

// Media-tag parsing and delivery.

/**
 * Parse media tags from the reply text and send them in order.
 *
 * @returns `true` when media tags were found and handled; `false` when the caller
 * should continue through the plain-text pipeline.
 */
export async function parseAndSendMediaTags(
  replyText: string,
  event: DeliverEventContext,
  actx: DeliverAccountContext,
  sendWithRetry: SendWithRetryFn,
  consumeQuoteRef: ConsumeQuoteRefFn,
): Promise<{ handled: boolean; normalizedText: string }> {
  const { account, log } = actx;
  const prefix = `[qqbot:${account.accountId}]`;

  // Normalize common malformed tags produced by smaller models.
  const text = normalizeMediaTags(replyText);

  const mediaTagRegex =
    /<(qqimg|qqvoice|qqvideo|qqfile|qqmedia)>([^<>]+)<\/(?:qqimg|qqvoice|qqvideo|qqfile|qqmedia|img)>/gi;
  const mediaTagMatches = [...text.matchAll(mediaTagRegex)];

  if (mediaTagMatches.length === 0) {
    return { handled: false, normalizedText: text };
  }

  const tagCounts = mediaTagMatches.reduce(
    (acc, m) => {
      const t = normalizeLowercaseStringOrEmpty(m[1]);
      acc[t] = (acc[t] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );
  log?.info(
    `${prefix} Detected media tags: ${Object.entries(tagCounts)
      .map(([k, v]) => `${v} <${k}>`)
      .join(", ")}`,
  );

  // Build a sequential send queue.
  type QueueItem = {
    type: "text" | "image" | "voice" | "video" | "file" | "media";
    content: string;
  };
  const sendQueue: QueueItem[] = [];

  let lastIndex = 0;
  const regex2 =
    /<(qqimg|qqvoice|qqvideo|qqfile|qqmedia)>([^<>]+)<\/(?:qqimg|qqvoice|qqvideo|qqfile|qqmedia|img)>/gi;
  let match;

  while ((match = regex2.exec(text)) !== null) {
    const textBefore = text
      .slice(lastIndex, match.index)
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (textBefore) {
      sendQueue.push({ type: "text", content: filterInternalMarkers(textBefore) });
    }

    const tagName = normalizeLowercaseStringOrEmpty(match[1]);
    let mediaPath = decodeMediaPath(normalizeOptionalString(match[2]) ?? "", log, prefix);

    if (mediaPath) {
      const typeMap: Record<string, QueueItem["type"]> = {
        qqmedia: "media",
        qqvoice: "voice",
        qqvideo: "video",
        qqfile: "file",
      };
      const itemType = typeMap[tagName] ?? "image";
      sendQueue.push({ type: itemType, content: mediaPath });
      log?.info(`${prefix} Found ${itemType} in <${tagName}>: ${mediaPath}`);
    }

    lastIndex = match.index + match[0].length;
  }

  const textAfter = text
    .slice(lastIndex)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (textAfter) {
    sendQueue.push({ type: "text", content: filterInternalMarkers(textAfter) });
  }

  log?.info(`${prefix} Send queue: ${sendQueue.map((item) => item.type).join(" -> ")}`);

  // Send queue items in order.
  const mediaTarget = resolveQQBotMediaTargetContext(event, account, prefix);

  for (const item of sendQueue) {
    if (item.type === "text") {
      await sendTextChunks(item.content, event, actx, sendWithRetry, consumeQuoteRef);
    } else if (item.type === "image") {
      await sendQQBotPhotoWithLogging({
        target: mediaTarget,
        imageUrl: item.content,
        log,
        onError: (error) => `${prefix} sendPhoto error: ${error}`,
      });
    } else if (item.type === "voice") {
      await sendVoiceWithTimeout(mediaTarget, item.content, account, log, prefix);
    } else if (item.type === "video") {
      await sendQQBotResultWithLogging({
        run: async () => await sendVideoMsg(mediaTarget, item.content),
        log,
        onError: (error) => `${prefix} sendVideoMsg error: ${error}`,
      });
    } else if (item.type === "file") {
      await sendQQBotResultWithLogging({
        run: async () => await sendDocument(mediaTarget, item.content),
        log,
        onError: (error) => `${prefix} sendDocument error: ${error}`,
      });
    } else if (item.type === "media") {
      await sendQQBotResultWithLogging({
        run: async () =>
          await sendMediaAuto({
            to: actx.qualifiedTarget,
            text: "",
            mediaUrl: item.content,
            accountId: account.accountId,
            replyToId: event.messageId,
            account,
          }),
        log,
        onError: (error) => `${prefix} sendMedia(auto) error: ${error}`,
      });
    }
  }

  return { handled: true, normalizedText: text };
}

// Unstructured reply delivery for plain text and images.

export interface PlainReplyPayload {
  text?: string;
  mediaUrls?: string[];
  mediaUrl?: string;
}

/**
 * Send a reply that does not contain structured media tags.
 * Handles markdown image embeds, Base64 media, plain-text chunking, and local media routing.
 */
export async function sendPlainReply(
  payload: PlainReplyPayload,
  replyText: string,
  event: DeliverEventContext,
  actx: DeliverAccountContext,
  sendWithRetry: SendWithRetryFn,
  consumeQuoteRef: ConsumeQuoteRefFn,
  toolMediaUrls: string[],
): Promise<void> {
  const { account, qualifiedTarget, log } = actx;
  const prefix = `[qqbot:${account.accountId}]`;

  const collectedImageUrls: string[] = [];
  const localMediaToSend: string[] = [];

  const collectImageUrl = (url: string | undefined | null): boolean => {
    if (!url) {
      return false;
    }
    const isHttpUrl = url.startsWith("http://") || url.startsWith("https://");
    const isDataUrl = url.startsWith("data:image/");
    if (isHttpUrl || isDataUrl) {
      if (!collectedImageUrls.includes(url)) {
        collectedImageUrls.push(url);
        log?.info(
          `${prefix} Collected ${isDataUrl ? "Base64" : "media URL"}: ${isDataUrl ? `(length: ${url.length})` : url.slice(0, 80) + "..."}`,
        );
      }
      return true;
    }
    if (isLocalFilePath(url)) {
      if (!localMediaToSend.includes(url)) {
        localMediaToSend.push(url);
        log?.info(`${prefix} Collected local media for auto-routing: ${url}`);
      }
      return true;
    }
    return false;
  };

  if (payload.mediaUrls?.length) {
    for (const url of payload.mediaUrls) {
      collectImageUrl(url);
    }
  }
  if (payload.mediaUrl) {
    collectImageUrl(payload.mediaUrl);
  }

  // Extract markdown images.
  const mdImageRegex = /!\[([^\]]*)\]\(([^)]+)\)/gi;
  const mdMatches = [...replyText.matchAll(mdImageRegex)];
  for (const m of mdMatches) {
    const url = m[2]?.trim();
    if (url && !collectedImageUrls.includes(url)) {
      if (url.startsWith("http://") || url.startsWith("https://")) {
        collectedImageUrls.push(url);
        log?.info(`${prefix} Extracted HTTP image from markdown: ${url.slice(0, 80)}...`);
      } else if (isLocalFilePath(url)) {
        if (!localMediaToSend.includes(url)) {
          localMediaToSend.push(url);
          log?.info(`${prefix} Collected local media from markdown for auto-routing: ${url}`);
        }
      }
    }
  }

  // Extract bare image URLs.
  const bareUrlRegex =
    /(?<![(["'])(https?:\/\/[^\s)"'<>]+\.(?:png|jpg|jpeg|gif|webp)(?:\?[^\s"'<>]*)?)/gi;
  const bareUrlMatches = [...replyText.matchAll(bareUrlRegex)];
  for (const m of bareUrlMatches) {
    const url = m[1];
    if (url && !collectedImageUrls.includes(url)) {
      collectedImageUrls.push(url);
      log?.info(`${prefix} Extracted bare image URL: ${url.slice(0, 80)}...`);
    }
  }

  const useMarkdown = account.markdownSupport;
  log?.info(`${prefix} Markdown mode: ${useMarkdown}, images: ${collectedImageUrls.length}`);

  let textWithoutImages = filterInternalMarkers(replyText);

  // Strip markdown image tags that are neither HTTP URLs nor collected local paths
  // to prevent leaking unresolvable paths (e.g. relative paths) to the user.
  for (const m of mdMatches) {
    const url = m[2]?.trim();
    if (url && !url.startsWith("http://") && !url.startsWith("https://") && !isLocalFilePath(url)) {
      textWithoutImages = textWithoutImages.replace(m[0], "").trim();
    }
  }

  if (useMarkdown) {
    await sendMarkdownReply(
      textWithoutImages,
      collectedImageUrls,
      mdMatches,
      bareUrlMatches,
      event,
      actx,
      sendWithRetry,
      consumeQuoteRef,
    );
  } else {
    await sendPlainTextReply(
      textWithoutImages,
      collectedImageUrls,
      mdMatches,
      bareUrlMatches,
      event,
      actx,
      sendWithRetry,
      consumeQuoteRef,
    );
  }

  // Send local media collected from payload.mediaUrl or markdown local paths.
  if (localMediaToSend.length > 0) {
    log?.info(
      `${prefix} Sending ${localMediaToSend.length} local media via sendMedia auto-routing`,
    );
    await sendQQBotAutoMediaBatch({
      qualifiedTarget,
      account,
      replyToId: event.messageId,
      mediaUrls: localMediaToSend,
      log,
      onSuccess: (mediaPath) => `${prefix} Sent local media: ${mediaPath}`,
      onResultError: (mediaPath, error) =>
        `${prefix} sendMedia(auto) error for ${mediaPath}: ${error}`,
      onThrownError: (mediaPath, error) =>
        `${prefix} sendMedia(auto) failed for ${mediaPath}: ${error}`,
    });
  }

  // Forward media gathered during the tool phase.
  if (toolMediaUrls.length > 0) {
    log?.info(
      `${prefix} Forwarding ${toolMediaUrls.length} tool-collected media URL(s) after block deliver`,
    );
    await sendQQBotAutoMediaBatch({
      qualifiedTarget,
      account,
      replyToId: event.messageId,
      mediaUrls: toolMediaUrls,
      log,
      onSuccess: (mediaUrl) => `${prefix} Forwarded tool media: ${mediaUrl.slice(0, 80)}...`,
      onResultError: (_mediaUrl, error) => `${prefix} Tool media forward error: ${error}`,
      onThrownError: (_mediaUrl, error) => `${prefix} Tool media forward failed: ${error}`,
    });
    toolMediaUrls.length = 0;
  }
}

// Internal helpers.

/** Decode a media path by stripping `MEDIA:`, expanding `~`, and unescaping. */
function decodeMediaPath(raw: string, log: DeliverAccountContext["log"], prefix: string): string {
  let mediaPath = raw;
  if (mediaPath.startsWith("MEDIA:")) {
    mediaPath = mediaPath.slice("MEDIA:".length);
  }
  mediaPath = normalizePath(mediaPath);
  mediaPath = mediaPath.replace(/\\\\/g, "\\");

  // Skip octal escape decoding for Windows local paths (e.g. C:\Users\1\file.txt)
  // where backslash-digit sequences like \1, \2 ... \7 are directory separators,
  // not octal escape sequences.
  const isWinLocal = /^[a-zA-Z]:[\\/]/.test(mediaPath) || mediaPath.startsWith("\\\\");
  try {
    const hasOctal = /\\[0-7]{1,3}/.test(mediaPath);
    const hasNonASCII = /[\u0080-\u00FF]/.test(mediaPath);

    if (!isWinLocal && (hasOctal || hasNonASCII)) {
      log?.debug?.(`${prefix} Decoding path with mixed encoding: ${mediaPath}`);
      let decoded = mediaPath.replace(/\\([0-7]{1,3})/g, (_: string, octal: string) => {
        return String.fromCharCode(parseInt(octal, 8));
      });
      const bytes: number[] = [];
      for (let i = 0; i < decoded.length; i++) {
        const code = decoded.charCodeAt(i);
        if (code <= 0xff) {
          bytes.push(code);
        } else {
          const charBytes = Buffer.from(decoded[i], "utf8");
          bytes.push(...charBytes);
        }
      }
      const buffer = Buffer.from(bytes);
      const utf8Decoded = buffer.toString("utf8");
      if (!utf8Decoded.includes("\uFFFD") || utf8Decoded.length < decoded.length) {
        mediaPath = utf8Decoded;
        log?.debug?.(`${prefix} Successfully decoded path: ${mediaPath}`);
      }
    }
  } catch (decodeErr) {
    log?.error(`${prefix} Path decode error: ${String(decodeErr)}`);
  }

  return mediaPath;
}

/** Shared helper for sending chunked text replies. */
async function sendQQBotTextChunk(params: {
  account: ResolvedQQBotAccount;
  event: DeliverEventContext;
  token: string;
  text: string;
  consumeQuoteRef: ConsumeQuoteRefFn;
  allowDm: boolean;
}): Promise<unknown> {
  const { account, event, token, text, consumeQuoteRef, allowDm } = params;
  const ref = consumeQuoteRef();
  if (event.type === "c2c") {
    return await sendC2CMessage(account.appId, token, event.senderId, text, event.messageId, ref);
  }
  if (event.type === "group" && event.groupOpenid) {
    return await sendGroupMessage(account.appId, token, event.groupOpenid, text, event.messageId);
  }
  if (allowDm && event.type === "dm" && event.guildId) {
    return await sendDmMessage(token, event.guildId, text, event.messageId);
  }
  if (event.channelId) {
    return await sendChannelMessage(token, event.channelId, text, event.messageId);
  }
  return undefined;
}

async function sendTextChunks(
  text: string,
  event: DeliverEventContext,
  actx: DeliverAccountContext,
  sendWithRetry: SendWithRetryFn,
  consumeQuoteRef: ConsumeQuoteRefFn,
): Promise<void> {
  const { account, log } = actx;
  const prefix = `[qqbot:${account.accountId}]`;
  const chunks = getQQBotRuntime().channel.text.chunkMarkdownText(text, TEXT_CHUNK_LIMIT);
  await sendQQBotTextChunksWithRetry({
    account,
    event,
    chunks,
    sendWithRetry,
    consumeQuoteRef,
    allowDm: true,
    log,
    onSuccess: (chunk) =>
      `${prefix} Sent text chunk (${chunk.length}/${text.length} chars): ${chunk.slice(0, 50)}...`,
    onError: (err) => `${prefix} Failed to send text chunk: ${String(err)}`,
  });
}

async function sendQQBotTextChunksWithRetry(params: {
  account: ResolvedQQBotAccount;
  event: DeliverEventContext;
  chunks: string[];
  sendWithRetry: SendWithRetryFn;
  consumeQuoteRef: ConsumeQuoteRefFn;
  allowDm: boolean;
  log?: DeliverAccountContext["log"];
  onSuccess: (chunk: string) => string;
  onError: (err: unknown) => string;
}): Promise<void> {
  const { account, event, chunks, sendWithRetry, consumeQuoteRef, allowDm, log } = params;
  for (const chunk of chunks) {
    try {
      await sendWithRetry((token) =>
        sendQQBotTextChunk({
          account,
          event,
          token,
          text: chunk,
          consumeQuoteRef,
          allowDm,
        }),
      );
      log?.info(params.onSuccess(chunk));
    } catch (err) {
      log?.error(params.onError(err));
    }
  }
}

async function sendQQBotResultWithLogging(params: {
  run: () => Promise<{ error?: string }>;
  log?: DeliverAccountContext["log"];
  onSuccess?: () => string | undefined;
  onError: (error: string) => string;
}): Promise<void> {
  try {
    const result = await params.run();
    if (result.error) {
      params.log?.error(params.onError(result.error));
      return;
    }
    const successMessage = params.onSuccess?.();
    if (successMessage) {
      params.log?.info(successMessage);
    }
  } catch (err) {
    params.log?.error(params.onError(String(err)));
  }
}

async function sendQQBotPhotoWithLogging(params: {
  target: MediaTargetContext;
  imageUrl: string;
  log?: DeliverAccountContext["log"];
  onSuccess?: (imageUrl: string) => string | undefined;
  onError: (error: string) => string;
}): Promise<void> {
  await sendQQBotResultWithLogging({
    run: async () => await sendPhoto(params.target, params.imageUrl),
    log: params.log,
    onSuccess: params.onSuccess ? () => params.onSuccess?.(params.imageUrl) : undefined,
    onError: params.onError,
  });
}

/** Send voice with a 45s timeout guard. */
async function sendVoiceWithTimeout(
  target: MediaTargetContext,
  voicePath: string,
  account: ResolvedQQBotAccount,
  log: DeliverAccountContext["log"],
  prefix: string,
): Promise<void> {
  const uploadFormats =
    account.config?.audioFormatPolicy?.uploadDirectFormats ??
    account.config?.voiceDirectUploadFormats;
  const transcodeEnabled = account.config?.audioFormatPolicy?.transcodeEnabled !== false;
  const voiceTimeout = 45000;
  const ac = new AbortController();
  try {
    const result = await Promise.race([
      sendVoice(target, voicePath, uploadFormats, transcodeEnabled).then((r) => {
        if (ac.signal.aborted) {
          log?.info(`${prefix} sendVoice completed after timeout, suppressing late delivery`);
          return {
            channel: "qqbot",
            error: "Voice send completed after timeout (suppressed)",
          } as typeof r;
        }
        return r;
      }),
      new Promise<{ channel: string; error: string }>((resolve) =>
        setTimeout(() => {
          ac.abort();
          resolve({ channel: "qqbot", error: "Voice send timed out and was skipped" });
        }, voiceTimeout),
      ),
    ]);
    if (result.error) {
      log?.error(`${prefix} sendVoice error: ${result.error}`);
    }
  } catch (err) {
    log?.error(`${prefix} sendVoice unexpected error: ${String(err)}`);
  }
}

/** Send in markdown mode. */
async function sendMarkdownReply(
  textWithoutImages: string,
  imageUrls: string[],
  mdMatches: RegExpMatchArray[],
  bareUrlMatches: RegExpMatchArray[],
  event: DeliverEventContext,
  actx: DeliverAccountContext,
  sendWithRetry: SendWithRetryFn,
  consumeQuoteRef: ConsumeQuoteRefFn,
): Promise<void> {
  const { account, log } = actx;
  const prefix = `[qqbot:${account.accountId}]`;

  // Split images into public URLs vs. Base64 payloads.
  const httpImageUrls: string[] = [];
  const base64ImageUrls: string[] = [];
  for (const url of imageUrls) {
    if (url.startsWith("data:image/")) {
      base64ImageUrls.push(url);
    } else if (url.startsWith("http://") || url.startsWith("https://")) {
      httpImageUrls.push(url);
    }
  }
  log?.info(
    `${prefix} Image classification: httpUrls=${httpImageUrls.length}, base64=${base64ImageUrls.length}`,
  );

  // Send Base64 images.
  if (base64ImageUrls.length > 0) {
    log?.info(`${prefix} Sending ${base64ImageUrls.length} image(s) via Rich Media API...`);
    for (const imageUrl of base64ImageUrls) {
      try {
        await sendWithRetry(async (token) => {
          if (event.type === "c2c") {
            await sendC2CImageMessage(
              account.appId,
              token,
              event.senderId,
              imageUrl,
              event.messageId,
            );
          } else if (event.type === "group" && event.groupOpenid) {
            await sendGroupImageMessage(
              account.appId,
              token,
              event.groupOpenid,
              imageUrl,
              event.messageId,
            );
          } else if (event.type === "dm" && event.guildId) {
            log?.info(`${prefix} DM does not support rich media image, skipping Base64 image`);
          } else if (event.channelId) {
            log?.info(`${prefix} Channel does not support rich media, skipping Base64 image`);
          }
        });
        log?.info(
          `${prefix} Sent Base64 image via Rich Media API (size: ${imageUrl.length} chars)`,
        );
      } catch (imgErr) {
        log?.error(`${prefix} Failed to send Base64 image via Rich Media API: ${String(imgErr)}`);
      }
    }
  }

  // Handle public image URLs.
  const existingMdUrls = new Set(mdMatches.map((m) => m[2]));
  const imagesToAppend: string[] = [];

  for (const url of httpImageUrls) {
    if (!existingMdUrls.has(url)) {
      try {
        const size = await getImageSize(url);
        imagesToAppend.push(formatQQBotMarkdownImage(url, size));
        log?.info(
          `${prefix} Formatted HTTP image: ${size ? `${size.width}x${size.height}` : "default size"} - ${url.slice(0, 60)}...`,
        );
      } catch (err) {
        log?.info(`${prefix} Failed to get image size, using default: ${String(err)}`);
        imagesToAppend.push(formatQQBotMarkdownImage(url, null));
      }
    }
  }

  // Backfill dimensions for existing markdown images.
  let result = textWithoutImages;
  for (const m of mdMatches) {
    const fullMatch = m[0];
    const imgUrl = m[2];
    const isHttpUrl = imgUrl.startsWith("http://") || imgUrl.startsWith("https://");
    if (isHttpUrl && !hasQQBotImageSize(fullMatch)) {
      try {
        const size = await getImageSize(imgUrl);
        result = result.replace(fullMatch, formatQQBotMarkdownImage(imgUrl, size));
        log?.info(
          `${prefix} Updated image with size: ${size ? `${size.width}x${size.height}` : "default"} - ${imgUrl.slice(0, 60)}...`,
        );
      } catch (err) {
        log?.info(
          `${prefix} Failed to get image size for existing md, using default: ${String(err)}`,
        );
        result = result.replace(fullMatch, formatQQBotMarkdownImage(imgUrl, null));
      }
    }
  }

  // Remove bare image URLs from the text body.
  for (const m of bareUrlMatches) {
    result = result.replace(m[0], "").trim();
  }

  // Append markdown images.
  if (imagesToAppend.length > 0) {
    result = result.trim();
    result = result ? result + "\n\n" + imagesToAppend.join("\n") : imagesToAppend.join("\n");
  }

  // Send markdown text.
  if (result.trim()) {
    const mdChunks = chunkText(result, TEXT_CHUNK_LIMIT);
    await sendQQBotTextChunksWithRetry({
      account,
      event,
      chunks: mdChunks,
      sendWithRetry,
      consumeQuoteRef,
      allowDm: true,
      log,
      onSuccess: (chunk) =>
        `${prefix} Sent markdown chunk (${chunk.length}/${result.length} chars) with ${httpImageUrls.length} HTTP images (${event.type})`,
      onError: (err) => `${prefix} Failed to send markdown message chunk: ${String(err)}`,
    });
  }
}

/** Send in plain-text mode. */
async function sendPlainTextReply(
  textWithoutImages: string,
  imageUrls: string[],
  mdMatches: RegExpMatchArray[],
  bareUrlMatches: RegExpMatchArray[],
  event: DeliverEventContext,
  actx: DeliverAccountContext,
  sendWithRetry: SendWithRetryFn,
  consumeQuoteRef: ConsumeQuoteRefFn,
): Promise<void> {
  const { account, log } = actx;
  const prefix = `[qqbot:${account.accountId}]`;

  const imgMediaTarget = resolveQQBotMediaTargetContext(event, account, prefix);

  let result = textWithoutImages;
  for (const m of mdMatches) {
    result = result.replace(m[0], "").trim();
  }
  for (const m of bareUrlMatches) {
    result = result.replace(m[0], "").trim();
  }

  // QQ group messages reject some dotted bare URLs, so filter them first.
  if (result && event.type !== "c2c") {
    result = result.replace(/([a-zA-Z0-9])\.([a-zA-Z0-9])/g, "$1_$2");
  }

  try {
    for (const imageUrl of imageUrls) {
      await sendQQBotPhotoWithLogging({
        target: imgMediaTarget,
        imageUrl,
        log,
        onSuccess: (nextImageUrl) =>
          `${prefix} Sent image via sendPhoto: ${nextImageUrl.slice(0, 80)}...`,
        onError: (error) => `${prefix} Failed to send image: ${error}`,
      });
    }

    if (result.trim()) {
      const plainChunks = chunkText(result, TEXT_CHUNK_LIMIT);
      await sendQQBotTextChunksWithRetry({
        account,
        event,
        chunks: plainChunks,
        sendWithRetry,
        consumeQuoteRef,
        allowDm: false,
        log,
        onSuccess: (chunk) =>
          `${prefix} Sent text chunk (${chunk.length}/${result.length} chars) (${event.type})`,
        onError: (err) => `${prefix} Send failed: ${String(err)}`,
      });
    }
  } catch (err) {
    log?.error(`${prefix} Send failed: ${String(err)}`);
  }
}
