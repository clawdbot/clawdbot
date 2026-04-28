/**
 * Outbound delivery helpers — core/ version.
 *
 * Uses the unified `sender.ts` business function layer for all text and
 * image sending. Media sends (photo/voice/video/file) are injected via
 * `DeliverDeps.mediaSender`.
 */

import type { GatewayAccount } from "../types.js";
import { formatErrorMessage } from "../utils/format.js";
import { getImageSize, formatQQBotMarkdownImage, hasQQBotImageSize } from "../utils/image-size.js";
import { normalizeMediaTags } from "../utils/media-tags.js";
import { isLocalPath as isLocalFilePath } from "../utils/platform.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../utils/string-normalize.js";
import { filterInternalMarkers } from "../utils/text-parsing.js";
import { decodeMediaPath } from "./decode-media-path.js";
import {
  sendText as senderSendText,
  sendMedia as senderSendMedia,
  withTokenRetry,
  buildDeliveryTarget,
  accountToCreds,
} from "./sender.js";

// ---- Injected dependency interfaces ----

/** Media target context — describes where to send media. */
export interface MediaTargetContext {
  targetType: "c2c" | "group" | "channel" | "dm";
  targetId: string;
  account: GatewayAccount;
  replyToId?: string;
}

/** Media send result. */
export interface MediaSendResult {
  channel?: string;
  error?: string;
  messageId?: string;
}

/** Media sender interface — implemented by the upper-layer outbound.ts module. */
export interface MediaSender {
  sendPhoto(target: MediaTargetContext, imageUrl: string): Promise<MediaSendResult>;
  sendVoice(
    target: MediaTargetContext,
    voicePath: string,
    uploadFormats?: string[],
    transcodeEnabled?: boolean,
  ): Promise<MediaSendResult>;
  sendVideoMsg(target: MediaTargetContext, videoPath: string): Promise<MediaSendResult>;
  sendDocument(target: MediaTargetContext, filePath: string): Promise<MediaSendResult>;
  sendMedia(opts: {
    to: string;
    text: string;
    mediaUrl: string;
    accountId: string;
    replyToId: string;
    account: GatewayAccount;
  }): Promise<MediaSendResult>;
}

/** Delivery dependencies — injected when calling parseAndSendMediaTags / sendPlainReply. */
export interface DeliverDeps {
  mediaSender: MediaSender;
  /** Text chunker — delegates to `runtime.channel.text.chunkMarkdownText`. */
  chunkText: (text: string, limit: number) => string[];
}

// ---- Exported types ----

/** Maximum text length for a single QQ Bot message. */
export const TEXT_CHUNK_LIMIT = 5000;

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
  account: GatewayAccount;
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

// ---- Internal helpers ----

function resolveMediaTargetContext(
  event: DeliverEventContext,
  account: GatewayAccount,
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
  };
}

async function autoMediaBatch(params: {
  qualifiedTarget: string;
  account: GatewayAccount;
  replyToId: string;
  mediaUrls: string[];
  mediaSender: MediaSender;
  log?: DeliverAccountContext["log"];
  onResultError: (mediaUrl: string, error: string) => string;
  onThrownError: (mediaUrl: string, error: string) => string;
  onSuccess?: (mediaUrl: string) => string | undefined;
}): Promise<void> {
  for (const mediaUrl of params.mediaUrls) {
    try {
      const result = await params.mediaSender.sendMedia({
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
      params.log?.error(params.onThrownError(mediaUrl, formatErrorMessage(err)));
    }
  }
}

// ---- Text chunk sending ----

async function sendTextChunkToTarget(params: {
  account: GatewayAccount;
  event: DeliverEventContext;
  token: string;
  text: string;
  consumeQuoteRef: ConsumeQuoteRefFn;
  allowDm: boolean;
}): Promise<unknown> {
  const { account, event, text, consumeQuoteRef, allowDm } = params;
  const ref = consumeQuoteRef();
  const target = buildDeliveryTarget(event);
  if (target.type === "dm" && !allowDm) {
    return undefined;
  }
  const creds = accountToCreds(account);
  return await senderSendText(target, text, creds, {
    msgId: event.messageId,
    messageReference: ref,
  });
}

async function sendTextChunks(
  text: string,
  event: DeliverEventContext,
  actx: DeliverAccountContext,
  sendWithRetry: SendWithRetryFn,
  consumeQuoteRef: ConsumeQuoteRefFn,
  deps: DeliverDeps,
): Promise<void> {
  const { account, log } = actx;
  const chunks = deps.chunkText(text, TEXT_CHUNK_LIMIT);
  await sendTextChunksWithRetry({
    account,
    event,
    chunks,
    sendWithRetry,
    consumeQuoteRef,
    allowDm: true,
    log,
    onSuccess: (chunk) =>
      `Sent text chunk (${chunk.length}/${text.length} chars): ${chunk.slice(0, 50)}...`,
    onError: (err) => `Failed to send text chunk: ${formatErrorMessage(err)}`,
  });
}

async function sendTextChunksWithRetry(params: {
  account: GatewayAccount;
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
        sendTextChunkToTarget({
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

// ---- Result logging helpers ----

async function sendWithResultLogging(params: {
  run: () => Promise<MediaSendResult>;
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
    params.log?.error(params.onError(formatErrorMessage(err)));
  }
}

async function sendPhotoWithLogging(params: {
  target: MediaTargetContext;
  imageUrl: string;
  mediaSender: MediaSender;
  log?: DeliverAccountContext["log"];
  onSuccess?: (imageUrl: string) => string | undefined;
  onError: (error: string) => string;
}): Promise<void> {
  await sendWithResultLogging({
    run: async () => await params.mediaSender.sendPhoto(params.target, params.imageUrl),
    log: params.log,
    onSuccess: params.onSuccess ? () => params.onSuccess?.(params.imageUrl) : undefined,
    onError: params.onError,
  });
}

/** Send voice with a 45s timeout guard. */
async function sendVoiceWithTimeout(
  target: MediaTargetContext,
  voicePath: string,
  account: GatewayAccount,
  mediaSender: MediaSender,
  log: DeliverAccountContext["log"],
): Promise<void> {
  const uploadFormats =
    account.config?.audioFormatPolicy?.uploadDirectFormats ??
    account.config?.voiceDirectUploadFormats;
  const transcodeEnabled = account.config?.audioFormatPolicy?.transcodeEnabled !== false;
  const voiceTimeout = 45_000;
  const ac = new AbortController();
  try {
    const result = await Promise.race([
      mediaSender.sendVoice(target, voicePath, uploadFormats, transcodeEnabled).then((r) => {
        if (ac.signal.aborted) {
          log?.debug?.(`sendVoice completed after timeout, suppressing late delivery`);
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
      log?.error(`sendVoice error: ${result.error}`);
    }
  } catch (err) {
    log?.error(`sendVoice unexpected error: ${formatErrorMessage(err)}`);
  }
}

// ============ Public API ============

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
  deps: DeliverDeps,
): Promise<{ handled: boolean; normalizedText: string }> {
  const { account, log } = actx;

  const text = normalizeMediaTags(replyText);

  const mediaTagRegex =
    /<(qqimg|qqvoice|qqvideo|qqfile|qqmedia)>([^<>]+)<\/(?:qqimg|qqvoice|qqvideo|qqfile|qqmedia|img)>/gi;
  const mediaTagMatches = [...text.matchAll(mediaTagRegex)];

  if (mediaTagMatches.length === 0) {
    return { handled: false, normalizedText: text };
  }

  const tagCounts = mediaTagMatches.reduce<Record<string, number>>((acc, m) => {
    const t = normalizeLowercaseStringOrEmpty(m[1]);
    acc[t] = (acc[t] ?? 0) + 1;
    return acc;
  }, {});
  log?.debug?.(
    `Detected media tags: ${Object.entries(tagCounts)
      .map(([k, v]) => `${v} <${k}>`)
      .join(", ")}`,
  );

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
    const mediaPath = decodeMediaPath(normalizeOptionalString(match[2]) ?? "", log);

    if (mediaPath) {
      const typeMap: Record<string, QueueItem["type"]> = {
        qqmedia: "media",
        qqvoice: "voice",
        qqvideo: "video",
        qqfile: "file",
      };
      const itemType = typeMap[tagName] ?? "image";
      sendQueue.push({ type: itemType, content: mediaPath });
      log?.debug?.(`Found ${itemType} in <${tagName}>: ${mediaPath}`);
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

  log?.debug?.(`Send queue: ${sendQueue.map((item) => item.type).join(" -> ")}`);

  const mediaTarget = resolveMediaTargetContext(event, account);

  for (const item of sendQueue) {
    if (item.type === "text") {
      await sendTextChunks(item.content, event, actx, sendWithRetry, consumeQuoteRef, deps);
    } else if (item.type === "image") {
      await sendPhotoWithLogging({
        target: mediaTarget,
        imageUrl: item.content,
        mediaSender: deps.mediaSender,
        log,
        onError: (error) => `sendPhoto error: ${error}`,
      });
    } else if (item.type === "voice") {
      await sendVoiceWithTimeout(mediaTarget, item.content, account, deps.mediaSender, log);
    } else if (item.type === "video") {
      await sendWithResultLogging({
        run: async () => await deps.mediaSender.sendVideoMsg(mediaTarget, item.content),
        log,
        onError: (error) => `sendVideoMsg error: ${error}`,
      });
    } else if (item.type === "file") {
      await sendWithResultLogging({
        run: async () => await deps.mediaSender.sendDocument(mediaTarget, item.content),
        log,
        onError: (error) => `sendDocument error: ${error}`,
      });
    } else if (item.type === "media") {
      await sendWithResultLogging({
        run: async () =>
          await deps.mediaSender.sendMedia({
            to: actx.qualifiedTarget,
            text: "",
            mediaUrl: item.content,
            accountId: account.accountId,
            replyToId: event.messageId,
            account,
          }),
        log,
        onError: (error) => `sendMedia(auto) error: ${error}`,
      });
    }
  }

  return { handled: true, normalizedText: text };
}

// ---- Plain reply ----

export interface PlainReplyPayload {
  text?: string;
  mediaUrls?: string[];
  mediaUrl?: string;
  audioAsVoice?: boolean;
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
  deps: DeliverDeps,
): Promise<void> {
  const { account, qualifiedTarget, log } = actx;

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
        log?.debug?.(
          `Collected ${isDataUrl ? "Base64" : "media URL"}: ${isDataUrl ? `(length: ${url.length})` : url.slice(0, 80) + "..."}`,
        );
      }
      return true;
    }
    if (isLocalFilePath(url)) {
      if (!localMediaToSend.includes(url)) {
        localMediaToSend.push(url);
        log?.debug?.(`Collected local media for auto-routing: ${url}`);
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
        log?.debug?.(`Extracted HTTP image from markdown: ${url.slice(0, 80)}...`);
      } else if (isLocalFilePath(url)) {
        if (!localMediaToSend.includes(url)) {
          localMediaToSend.push(url);
          log?.debug?.(`Collected local media from markdown for auto-routing: ${url}`);
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
      log?.debug?.(`Extracted bare image URL: ${url.slice(0, 80)}...`);
    }
  }

  const useMarkdown = account.markdownSupport;
  log?.debug?.(`Markdown mode: ${useMarkdown}, images: ${collectedImageUrls.length}`);

  let textWithoutImages = filterInternalMarkers(replyText);

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
      deps,
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
      deps,
    );
  }

  // Send local media collected from payload.mediaUrl or markdown local paths.
  if (localMediaToSend.length > 0) {
    log?.debug?.(`Sending ${localMediaToSend.length} local media via sendMedia auto-routing`);
    await autoMediaBatch({
      qualifiedTarget,
      account,
      replyToId: event.messageId,
      mediaUrls: localMediaToSend,
      mediaSender: deps.mediaSender,
      log,
      onSuccess: (mediaPath) => `Sent local media: ${mediaPath}`,
      onResultError: (mediaPath, error) => `sendMedia(auto) error for ${mediaPath}: ${error}`,
      onThrownError: (mediaPath, error) => `sendMedia(auto) failed for ${mediaPath}: ${error}`,
    });
  }

  // Forward media gathered during the tool phase.
  if (toolMediaUrls.length > 0) {
    log?.debug?.(
      `Forwarding ${toolMediaUrls.length} tool-collected media URL(s) after block deliver`,
    );
    await autoMediaBatch({
      qualifiedTarget,
      account,
      replyToId: event.messageId,
      mediaUrls: toolMediaUrls,
      mediaSender: deps.mediaSender,
      log,
      onSuccess: (mediaUrl) => `Forwarded tool media: ${mediaUrl.slice(0, 80)}...`,
      onResultError: (_mediaUrl, error) => `Tool media forward error: ${error}`,
      onThrownError: (_mediaUrl, error) => `Tool media forward failed: ${error}`,
    });
    toolMediaUrls.length = 0;
  }
}

// ---- Markdown reply ----

async function sendMarkdownReply(
  textWithoutImages: string,
  imageUrls: string[],
  mdMatches: RegExpMatchArray[],
  bareUrlMatches: RegExpMatchArray[],
  event: DeliverEventContext,
  actx: DeliverAccountContext,
  sendWithRetry: SendWithRetryFn,
  consumeQuoteRef: ConsumeQuoteRefFn,
  deps: DeliverDeps,
): Promise<void> {
  const { account, log } = actx;

  const httpImageUrls: string[] = [];
  const base64ImageUrls: string[] = [];
  for (const url of imageUrls) {
    if (url.startsWith("data:image/")) {
      base64ImageUrls.push(url);
    } else if (url.startsWith("http://") || url.startsWith("https://")) {
      httpImageUrls.push(url);
    }
  }
  log?.debug?.(
    `Image classification: httpUrls=${httpImageUrls.length}, base64=${base64ImageUrls.length}`,
  );

  // Send Base64 images via Rich Media API.
  if (base64ImageUrls.length > 0) {
    log?.debug?.(`Sending ${base64ImageUrls.length} image(s) via Rich Media API...`);
    for (const imageUrl of base64ImageUrls) {
      try {
        const target = buildDeliveryTarget(event);
        const creds = accountToCreds(account);
        if (target.type === "c2c" || target.type === "group") {
          await withTokenRetry(creds, async () => {
            await senderSendMedia({
              target,
              creds,
              kind: "image",
              source: { url: imageUrl },
              msgId: event.messageId,
            });
          });
        } else {
          log?.debug?.(`${target.type} does not support rich media, skipping Base64 image`);
        }
        log?.debug?.(`Sent Base64 image via Rich Media API (size: ${imageUrl.length} chars)`);
      } catch (imgErr) {
        log?.error(`Failed to send Base64 image via Rich Media API: ${String(imgErr)}`);
      }
    }
  }

  // Handle public image URLs — format as markdown images with dimensions.
  const existingMdUrls = new Set(mdMatches.map((m) => m[2]));
  const imagesToAppend: string[] = [];

  for (const url of httpImageUrls) {
    if (!existingMdUrls.has(url)) {
      try {
        const size = await getImageSize(url);
        imagesToAppend.push(formatQQBotMarkdownImage(url, size));
        log?.debug?.(
          `Formatted HTTP image: ${size ? `${size.width}x${size.height}` : "default size"} - ${url.slice(0, 60)}...`,
        );
      } catch (err) {
        log?.debug?.(`Failed to get image size, using default: ${formatErrorMessage(err)}`);
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
        log?.debug?.(
          `Updated image with size: ${size ? `${size.width}x${size.height}` : "default"} - ${imgUrl.slice(0, 60)}...`,
        );
      } catch (err) {
        log?.debug?.(
          `Failed to get image size for existing md, using default: ${formatErrorMessage(err)}`,
        );
        result = result.replace(fullMatch, formatQQBotMarkdownImage(imgUrl, null));
      }
    }
  }

  // Remove bare image URLs from text body.
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
    const mdChunks = deps.chunkText(result, TEXT_CHUNK_LIMIT);
    await sendTextChunksWithRetry({
      account,
      event,
      chunks: mdChunks,
      sendWithRetry,
      consumeQuoteRef,
      allowDm: true,
      log,
      onSuccess: (chunk) =>
        `Sent markdown chunk (${chunk.length}/${result.length} chars) with ${httpImageUrls.length} HTTP images (${event.type})`,
      onError: (err) => `Failed to send markdown message chunk: ${formatErrorMessage(err)}`,
    });
  }
}

// ---- Plain-text reply ----

async function sendPlainTextReply(
  textWithoutImages: string,
  imageUrls: string[],
  mdMatches: RegExpMatchArray[],
  bareUrlMatches: RegExpMatchArray[],
  event: DeliverEventContext,
  actx: DeliverAccountContext,
  sendWithRetry: SendWithRetryFn,
  consumeQuoteRef: ConsumeQuoteRefFn,
  deps: DeliverDeps,
): Promise<void> {
  const { account, log } = actx;

  const imgMediaTarget = resolveMediaTargetContext(event, account);

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
      await sendPhotoWithLogging({
        target: imgMediaTarget,
        imageUrl,
        mediaSender: deps.mediaSender,
        log,
        onSuccess: (nextImageUrl) => `Sent image via sendPhoto: ${nextImageUrl.slice(0, 80)}...`,
        onError: (error) => `Failed to send image: ${error}`,
      });
    }

    if (result.trim()) {
      const plainChunks = deps.chunkText(result, TEXT_CHUNK_LIMIT);
      await sendTextChunksWithRetry({
        account,
        event,
        chunks: plainChunks,
        sendWithRetry,
        consumeQuoteRef,
        allowDm: false,
        log,
        onSuccess: (chunk) =>
          `Sent text chunk (${chunk.length}/${result.length} chars) (${event.type})`,
        onError: (err) => `Send failed: ${formatErrorMessage(err)}`,
      });
    }
  } catch (err) {
    log?.error(`Send failed: ${formatErrorMessage(err)}`);
  }
}
