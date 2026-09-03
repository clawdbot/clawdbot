// Whatsapp plugin module implements send behavior.
import type { ChannelOutboundContext } from "openclaw/plugin-sdk/channel-contract";
import {
  createMessageReceiptFromOutboundResults,
  createReplyToFanout,
  type MessageReceipt,
} from "openclaw/plugin-sdk/channel-outbound";
import { formatCliCommand } from "openclaw/plugin-sdk/cli-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { generateSecureUuid } from "openclaw/plugin-sdk/core";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { redactIdentifier } from "openclaw/plugin-sdk/logging-core";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { loadOutboundMediaFromUrl } from "openclaw/plugin-sdk/outbound-media";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import { normalizePollInput, type PollInput } from "openclaw/plugin-sdk/poll-runtime";
import { resolveChunkMode, resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-chunking";
import { createSubsystemLogger, getChildLogger } from "openclaw/plugin-sdk/runtime-env";
import {
  resolveDefaultWhatsAppAccountId,
  resolveWhatsAppAccount,
  resolveWhatsAppMediaMaxBytes,
} from "./accounts.js";
import { getWhatsAppConnectionController } from "./connection-controller-runtime-context.js";
import { resolveWhatsAppDocumentFileName } from "./document-filename.js";
import {
  mergeWhatsAppAcceptedSendError,
  requireWhatsAppAcceptedSendResult,
  withWhatsAppLogicalDeliveryActivity,
  type WhatsAppSendResult,
} from "./inbound/send-result.js";
import type { ActiveWebListener, ActiveWebSendOptions } from "./inbound/types.js";
import { isWhatsAppNewsletterJid } from "./normalize.js";
import {
  normalizeWhatsAppPayloadText,
  prepareWhatsAppOutboundMedia,
  resolveAdditiveWhatsAppMediaUrls,
} from "./outbound-media-contract.js";
import type { WhatsAppQuotedMessageKey } from "./quoted-message.js";
import { markdownToWhatsAppChunks, toWhatsappJid } from "./text-runtime.js";

const outboundLog = createSubsystemLogger("gateway/channels/whatsapp").child("outbound");

type PreparedWhatsAppOutboundMedia = Awaited<ReturnType<typeof prepareWhatsAppOutboundMedia>>;

function supportsForcedDocumentDelivery(kind: PreparedWhatsAppOutboundMedia["kind"]): boolean {
  return kind === "image" || kind === "video";
}

type WhatsAppMediaSendState = {
  mediaBuffer: Buffer;
  mediaType: string;
  text: string;
  forceDocumentDelivery: boolean;
  documentFileName?: string;
  visibleTextAfterVoice?: string;
};

function buildWhatsAppMediaSendState(params: {
  media: PreparedWhatsAppOutboundMedia;
  caption?: string;
  forceDocument?: boolean;
}): WhatsAppMediaSendState {
  const { media, caption } = params;
  const forceDocumentDelivery =
    Boolean(params.forceDocument && supportsForcedDocumentDelivery(media.kind)) ||
    (media.kind === "document" &&
      (media.mimetype.startsWith("image/") || media.mimetype.startsWith("video/")));
  let text = caption ?? "";
  let documentFileName = media.kind === "document" ? media.fileName : undefined;
  let visibleTextAfterVoice: string | undefined;
  if (media.kind === "audio" && caption) {
    visibleTextAfterVoice = caption;
    text = "";
  }
  if (forceDocumentDelivery) {
    documentFileName ??= resolveWhatsAppDocumentFileName({
      fileName: media.fileName,
      mimetype: media.mimetype,
    });
  }
  return {
    mediaBuffer: media.buffer,
    mediaType: media.mimetype,
    text,
    forceDocumentDelivery,
    ...(documentFileName ? { documentFileName } : {}),
    ...(visibleTextAfterVoice ? { visibleTextAfterVoice } : {}),
  };
}

function resolveOutboundWhatsAppAccountId(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): string | undefined {
  const explicitAccountId = params.accountId?.trim();
  if (explicitAccountId) {
    return explicitAccountId;
  }
  return resolveDefaultWhatsAppAccountId(params.cfg);
}

function requireOutboundActiveWebListener(params: { cfg: OpenClawConfig; accountId?: string }): {
  accountId: string;
  listener: ActiveWebListener;
} {
  const accountId = resolveOutboundWhatsAppAccountId(params);
  const resolvedAccountId = accountId ?? resolveDefaultWhatsAppAccountId(params.cfg);
  const listener = getWhatsAppConnectionController(resolvedAccountId)?.getActiveListener() ?? null;
  if (!listener) {
    const cause = new Error(
      `No active WhatsApp Web listener (account: ${resolvedAccountId}). Start the gateway, then link WhatsApp with: ${formatCliCommand(`openclaw channels login --channel whatsapp --account ${resolvedAccountId}`)}.`,
    );
    throw new PlatformMessageNotDispatchedError(cause.message, { cause });
  }
  return { accountId: resolvedAccountId, listener };
}

function resolveActualSentRemoteJid(result: unknown, fallbackJid: string): string {
  if (!result || typeof result !== "object") {
    return fallbackJid;
  }
  const rawKeys = (result as { keys?: unknown }).keys;
  const keys: Array<{ remoteJid?: unknown }> = Array.isArray(rawKeys) ? rawKeys : [];
  for (const key of keys) {
    if (typeof key?.remoteJid === "string" && key.remoteJid.trim()) {
      return key.remoteJid.trim();
    }
  }
  return fallbackJid;
}

export async function sendMessageWhatsApp(
  to: string,
  body: string,
  options: {
    verbose: boolean;
    cfg: OpenClawConfig;
    mediaUrl?: string;
    mediaUrls?: readonly string[];
    mediaAccess?: {
      localRoots?: readonly string[];
      readFile?: (filePath: string) => Promise<Buffer>;
    };
    mediaLocalRoots?: readonly string[];
    mediaReadFile?: (filePath: string) => Promise<Buffer>;
    mediaPayload?: {
      buffer: Buffer;
      contentType?: string;
      kind?: PreparedWhatsAppOutboundMedia["kind"];
      fileName?: string;
    };
    gifPlayback?: boolean;
    audioAsVoice?: boolean;
    forceDocument?: boolean;
    accountId?: string;
    quotedMessageKey?: WhatsAppQuotedMessageKey;
    preserveLeadingWhitespace?: boolean;
    /** Report each accepted internal platform send before the next fallible send. */
    onDeliveryResult?: (result: {
      messageId: string;
      toJid: string;
      receipt?: MessageReceipt;
    }) => Promise<void> | void;
  } & Pick<
    ChannelOutboundContext,
    "replyToIdSource" | "replyToMode" | "formatting" | "onPlatformSendDispatch"
  >,
): Promise<{ messageId: string; toJid: string }> {
  return await sendWhatsAppUploadFile(to, body, options);
}

export async function sendWhatsAppUploadFile(
  to: string,
  body: string,
  options: Parameters<typeof sendMessageWhatsApp>[2] & { fileName?: string; contentType?: string },
): Promise<{ messageId: string; toJid: string }> {
  return await withWhatsAppLogicalDeliveryActivity(() =>
    sendMessageWhatsAppInActivityScope(to, body, options),
  );
}

async function sendMessageWhatsAppInActivityScope(
  to: string,
  body: string,
  options: Parameters<typeof sendMessageWhatsApp>[2] & { fileName?: string; contentType?: string },
): Promise<{ messageId: string; toJid: string }> {
  let text = options.preserveLeadingWhitespace ? body : normalizeWhatsAppPayloadText(body);
  const jid = toWhatsappJid(to);
  const mediaUrls = resolveAdditiveWhatsAppMediaUrls(options);
  const mediaPayload = options.mediaPayload;
  const primaryMediaUrl = mediaUrls[0] ?? mediaPayload?.fileName;
  const hasMedia = Boolean(mediaPayload || primaryMediaUrl);
  if (!text && !hasMedia) {
    return { messageId: "", toJid: jid };
  }
  const correlationId = generateSecureUuid();
  const startedAt = Date.now();
  const cfg = requireRuntimeConfig(options.cfg, "WhatsApp send");
  const { listener: active, accountId: resolvedAccountId } = requireOutboundActiveWebListener({
    cfg,
    accountId: options.accountId,
  });
  const account = resolveWhatsAppAccount({
    cfg,
    accountId: resolvedAccountId ?? options.accountId,
  });
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "whatsapp",
    accountId: resolvedAccountId ?? options.accountId,
  });
  const accountIdForFormatting = resolvedAccountId ?? options.accountId;
  const requestedLimit = options.formatting?.textLimit ?? Infinity;
  const textLimit = Math.min(
    requestedLimit > 0 ? requestedLimit : Infinity,
    resolveTextChunkLimit(cfg, "whatsapp", accountIdForFormatting, { fallbackLimit: 4_000 }),
    4_096,
  );
  const textChunks = markdownToWhatsAppChunks(
    text,
    textLimit,
    tableMode,
    options.formatting?.chunkMode ?? resolveChunkMode(cfg, "whatsapp", accountIdForFormatting),
  );
  text = textChunks.shift() ?? text;
  if (!text && !hasMedia) {
    return { messageId: "", toJid: jid };
  }
  const redactedTo = redactIdentifier(to);
  const logger = getChildLogger({
    module: "web-outbound",
    correlationId,
    to: redactedTo,
  });
  const acceptedResults: WhatsAppSendResult[] = [];
  try {
    const redactedJid = redactIdentifier(jid);
    let mediaBuffer: Buffer | undefined;
    let mediaType: string | undefined;
    let documentFileName: string | undefined;
    let visibleTextAfterVoice: string | undefined;
    let forceDocumentDelivery = false;
    let media: PreparedWhatsAppOutboundMedia | undefined;
    if (mediaPayload) {
      media = await prepareWhatsAppOutboundMedia(mediaPayload, primaryMediaUrl);
    } else if (primaryMediaUrl) {
      // Injected readers must carry an explicit local-root boundary. The shared loader enforces
      // that contract; never restore the former implicit `localRoots: "any"` widening here.
      const loadedMedia = await loadOutboundMediaFromUrl(primaryMediaUrl, {
        maxBytes: resolveWhatsAppMediaMaxBytes(account),
        optimizeImages: options.forceDocument ? false : undefined,
        mediaAccess: options.mediaAccess,
        mediaLocalRoots: options.mediaLocalRoots,
        mediaReadFile: options.mediaReadFile,
      });
      // An explicit upload MIME supersedes the loader's inferred kind; preserving a stale
      // document guess would incorrectly send native images and videos as documents.
      const mediaWithRequestedType = options.contentType
        ? { ...loadedMedia, contentType: options.contentType, kind: undefined }
        : loadedMedia;
      media = await prepareWhatsAppOutboundMedia(
        options.fileName
          ? { ...mediaWithRequestedType, fileName: options.fileName }
          : mediaWithRequestedType,
        primaryMediaUrl,
      );
    }
    if (media) {
      const mediaSendState = buildWhatsAppMediaSendState({
        media,
        caption: text || undefined,
        forceDocument: options.forceDocument,
      });
      mediaBuffer = mediaSendState.mediaBuffer;
      mediaType = mediaSendState.mediaType;
      documentFileName = mediaSendState.documentFileName;
      visibleTextAfterVoice = mediaSendState.visibleTextAfterVoice;
      forceDocumentDelivery = mediaSendState.forceDocumentDelivery;
      text = mediaSendState.text;
    }
    outboundLog.info(`Sending message -> ${redactedJid}${hasMedia ? " (media)" : ""}`);
    logger.info({ jid: redactedJid, hasMedia }, "sending message");
    if (!isWhatsAppNewsletterJid(jid)) {
      await active.assertSendReady?.(to);
      try {
        await active.sendComposingTo(to);
      } catch (err) {
        // Typing is optional; a failed chatstate update must not block the actual message.
        logger.warn(
          { err: String(err), jid: redactedJid },
          "failed to send composing presence; continuing message delivery",
        );
      }
    }
    const hasExplicitAccountId = Boolean(options.accountId?.trim());
    const accountId = hasExplicitAccountId ? resolvedAccountId : undefined;
    const trailingTextChunks = [visibleTextAfterVoice, ...textChunks].filter(
      (chunk): chunk is string => Boolean(chunk),
    );
    const reportProgress = trailingTextChunks.length > 0 ? options.onDeliveryResult : undefined;
    const sendOptions: ActiveWebSendOptions | undefined =
      options.gifPlayback || forceDocumentDelivery || accountId || documentFileName
        ? {
            ...(options.gifPlayback ? { gifPlayback: true } : {}),
            ...(forceDocumentDelivery ? { asDocument: true } : {}),
            ...(documentFileName ? { fileName: documentFileName } : {}),
            accountId,
          }
        : undefined;
    const quotedSendOptions = options.quotedMessageKey
      ? { ...sendOptions, quotedMessageKey: options.quotedMessageKey }
      : sendOptions;
    const nextReplyToId = createReplyToFanout({
      replyToId: options.quotedMessageKey?.id,
      replyToIdSource: options.replyToIdSource,
      replyToMode: options.replyToMode,
    });
    const sendPart = async (part: string, buffer?: Buffer, mime?: string) => {
      // This owner chunks rendered Markdown; keep each native send behind the
      // durable dispatch fence and record its actual quote before reporting progress.
      await options.onPlatformSendDispatch?.();
      const replyToId = nextReplyToId();
      const partOptions = replyToId ? quotedSendOptions : sendOptions;
      const accepted = requireWhatsAppAcceptedSendResult(
        partOptions
          ? await active.sendMessage(to, part, buffer, mime, partOptions)
          : await active.sendMessage(to, part, buffer, mime),
      );
      acceptedResults.push(accepted);
      const result = {
        messageId: accepted.messageId,
        toJid: resolveActualSentRemoteJid(accepted, jid),
      };
      return {
        ...result,
        ...(reportProgress
          ? {
              receipt: createMessageReceiptFromOutboundResults({
                results: [{ channel: "whatsapp", ...result }],
                kind: buffer ? "media" : "text",
                replyToId,
              }),
            }
          : {}),
      };
    };
    const result = await sendPart(text, mediaBuffer, mediaType);
    const { messageId, toJid: sentRemoteJid } = result;
    if (trailingTextChunks.length > 0) {
      // Persist each accepted part before the next fallible send so recovery
      // cannot replay already-delivered media or text chunks.
      await reportProgress?.(result);
      for (const trailingText of trailingTextChunks) {
        const trailingResult = await sendPart(trailingText);
        await reportProgress?.(trailingResult);
      }
    }
    const durationMs = Date.now() - startedAt;
    outboundLog.info(
      `Sent message ${messageId} -> ${redactedJid}${hasMedia ? " (media)" : ""} (${durationMs}ms)`,
    );
    logger.info({ jid: redactedJid, messageId }, "sent message");
    return { messageId, toJid: sentRemoteJid };
  } catch (err) {
    logger.error({ err: String(err), to: redactedTo, hasMedia }, "failed to send via web session");
    const firstAccepted = acceptedResults[0];
    throw mergeWhatsAppAcceptedSendError({
      error: err,
      kind: firstAccepted?.kind ?? (hasMedia ? "media" : "text"),
      results: acceptedResults,
    });
  }
}

export async function sendTypingWhatsApp(
  to: string,
  options: {
    cfg: OpenClawConfig;
    accountId?: string;
  },
): Promise<void> {
  const cfg = requireRuntimeConfig(options.cfg, "WhatsApp typing send");
  const { listener: active } = requireOutboundActiveWebListener({
    cfg,
    accountId: options.accountId,
  });
  if (!isWhatsAppNewsletterJid(toWhatsappJid(to))) {
    await active.assertSendReady?.(to);
    await active.sendComposingTo(to);
  }
}

export async function sendReactionWhatsApp(
  chatJid: string,
  messageId: string,
  emoji: string,
  options: {
    verbose: boolean;
    fromMe?: boolean;
    participant?: string;
    accountId?: string;
    cfg: OpenClawConfig;
  },
): Promise<void> {
  const correlationId = generateSecureUuid();
  const cfg = requireRuntimeConfig(options.cfg, "WhatsApp reaction");
  const { listener: active } = requireOutboundActiveWebListener({
    cfg,
    accountId: options.accountId,
  });
  const redactedChatJid = redactIdentifier(chatJid);
  const logger = getChildLogger({
    module: "web-outbound",
    correlationId,
    chatJid: redactedChatJid,
    messageId,
  });
  try {
    const jid = toWhatsappJid(chatJid);
    const redactedJid = redactIdentifier(jid);
    outboundLog.info(`Sending reaction "${emoji}" -> message ${messageId}`);
    logger.info({ chatJid: redactedJid, messageId, emoji }, "sending reaction");
    await active.sendReaction(
      chatJid,
      messageId,
      emoji,
      options.fromMe ?? false,
      options.participant,
    );
    outboundLog.info(`Sent reaction "${emoji}" -> message ${messageId}`);
    logger.info({ chatJid: redactedJid, messageId, emoji }, "sent reaction");
  } catch (err) {
    logger.error(
      { err: String(err), chatJid: redactedChatJid, messageId, emoji },
      "failed to send reaction via web session",
    );
    throw err;
  }
}

export async function sendPollWhatsApp(
  to: string,
  poll: PollInput,
  options: { verbose: boolean; accountId?: string; cfg: OpenClawConfig },
): Promise<{ messageId: string; toJid: string }> {
  const correlationId = generateSecureUuid();
  const startedAt = Date.now();
  const cfg = requireRuntimeConfig(options.cfg, "WhatsApp poll");
  const { listener: active } = requireOutboundActiveWebListener({
    cfg,
    accountId: options.accountId,
  });
  const redactedTo = redactIdentifier(to);
  const logger = getChildLogger({
    module: "web-outbound",
    correlationId,
    to: redactedTo,
  });
  try {
    const jid = toWhatsappJid(to);
    const redactedJid = redactIdentifier(jid);
    const normalized = normalizePollInput(poll, { maxOptions: 12 });
    outboundLog.info(`Sending poll -> ${redactedJid}`);
    logger.info(
      {
        jid: redactedJid,
        optionCount: normalized.options.length,
        maxSelections: normalized.maxSelections,
      },
      "sending poll",
    );
    if (!isWhatsAppNewsletterJid(jid)) {
      await active.assertSendReady?.(to);
    }
    const result = requireWhatsAppAcceptedSendResult(await active.sendPoll(to, normalized));
    const messageId = result.messageId;
    const durationMs = Date.now() - startedAt;
    outboundLog.info(`Sent poll ${messageId} -> ${redactedJid} (${durationMs}ms)`);
    logger.info({ jid: redactedJid, messageId }, "sent poll");
    return { messageId, toJid: resolveActualSentRemoteJid(result, jid) };
  } catch (err) {
    logger.error({ err: String(err), to: redactedTo }, "failed to send poll via web session");
    throw err;
  }
}
