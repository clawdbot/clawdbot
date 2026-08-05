// Whatsapp plugin module prepares inbound text, context, and downloaded media.
import type { proto, WAMessage, WASocket } from "baileys";
import {
  formatInboundMediaUnavailableText,
  formatLocationText,
  type MediaPlaceholderTextFact,
} from "openclaw/plugin-sdk/channel-inbound";
import { createSubsystemLogger, redactToolPayloadText } from "openclaw/plugin-sdk/logging-core";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { getStatusCode } from "../session-errors.js";
import {
  describeReplyContext,
  extractContactContext,
  extractExternalAdReplyContext,
  extractLocationData,
  extractMediaKind,
  extractText,
} from "./extract.js";
import { resolveInboundMediaMimetype } from "./media-mimetype.js";
import { downloadInboundMedia, downloadQuotedInboundMedia } from "./media.js";

const inboundMediaLogger = createSubsystemLogger("gateway/channels/whatsapp").child("inbound");
const MAX_MEDIA_ERROR_MESSAGE_CHARS = 256;

function sanitizeMediaErrorMessage(error: unknown): string {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const redacted = redactToolPayloadText(rawMessage)
    .replace(/https?:\/\/\S+/giu, "[redacted-url]")
    .replace(/\b[^@\s]+@[a-z][a-z\d.-]*\b/giu, "[redacted-jid]")
    .replace(/\+?\d[\d ().-]{6,}\d/gu, "[redacted-phone]");
  return truncateUtf16Safe(
    redacted.split("\n", 1)[0]?.trim() || "unknown error",
    MAX_MEDIA_ERROR_MESSAGE_CHARS,
  );
}

function logMediaMaterializationFailure(params: {
  messageId?: string | null;
  mediaKind?: string;
  mimeType?: string;
  failureStage: "direct" | "quoted";
  error: unknown;
}): void {
  const errorClass =
    params.error instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(params.error.name)
      ? params.error.name
      : "Error";
  const statusCode = getStatusCode(params.error);
  const errorMessage = sanitizeMediaErrorMessage(params.error);
  const failureDetails = [
    `stage=${params.failureStage}`,
    ...(params.mediaKind ? [`kind=${params.mediaKind}`] : []),
    ...(typeof statusCode === "number" ? [`status=${statusCode}`] : []),
  ].join(" ");
  // One subsystem event keeps the Gateway console and structured file log in sync.
  inboundMediaLogger.warn("WhatsApp inbound media materialization failed", {
    channel: "whatsapp",
    messageId: params.messageId ?? undefined,
    mediaKind: params.mediaKind,
    mimeType: params.mimeType,
    failureStage: params.failureStage,
    errorClass,
    ...(typeof statusCode === "number" ? { statusCode } : {}),
    errorMessage,
    consoleMessage: `WhatsApp inbound media materialization failed (${failureDetails}): ${errorMessage}`,
  });
}

export type WhatsAppEnrichedInboundMessage = {
  body: string;
  commandBody: string;
  location?: ReturnType<typeof extractLocationData>;
  contactContext?: ReturnType<typeof extractContactContext>;
  externalAdReplyContext?: ReturnType<typeof extractExternalAdReplyContext>;
  replyContext?: ReturnType<typeof describeReplyContext>;
  mediaPath?: string;
  mediaType?: string;
  mediaFileName?: string;
  mediaKind?: NonNullable<ReturnType<typeof extractMediaKind>>;
  nativeMedia?: MediaPlaceholderTextFact;
};

export async function enrichWhatsAppInboundMessage(params: {
  msg: WAMessage;
  sock: WASocket;
  mediaMaxMb?: number;
  logVerbose: (message: string) => void;
}): Promise<WhatsAppEnrichedInboundMessage | null> {
  const { msg, sock } = params;
  const location = extractLocationData(msg.message ?? undefined);
  const locationText = location ? formatLocationText(location) : undefined;
  const contactContext = extractContactContext(msg.message ?? undefined);
  const externalAdReplyContext = extractExternalAdReplyContext(msg.message ?? undefined);
  let mediaKind = extractMediaKind(msg.message ?? undefined);
  let body = extractText(msg.message ?? undefined);
  if (locationText) {
    body = [body, locationText].filter(Boolean).join("\n").trim();
  }
  if (!body && !mediaKind) {
    return null;
  }
  body = body ?? "";
  const commandBody = body;
  const replyContext = describeReplyContext(msg.message as proto.IMessage | undefined);

  let mediaPath: string | undefined;
  let mediaType = mediaKind
    ? resolveInboundMediaMimetype(msg.message as proto.IMessage)
    : undefined;
  const nativeMedia = mediaKind ? { contentType: mediaType, kind: mediaKind } : undefined;
  let mediaFileName: string | undefined;
  const maxMb =
    typeof params.mediaMaxMb === "number" && params.mediaMaxMb > 0 ? params.mediaMaxMb : 50;
  const maxBytes = maxMb * 1024 * 1024;
  const saveInboundMedia = async (
    inboundMedia: Awaited<ReturnType<typeof downloadInboundMedia>>,
  ) => {
    if (!inboundMedia) {
      return;
    }
    mediaPath = inboundMedia.saved.path;
    mediaType = inboundMedia.mimetype;
    mediaFileName = inboundMedia.fileName;
  };
  try {
    await saveInboundMedia(
      await downloadInboundMedia(msg as proto.IWebMessageInfo, sock, maxBytes),
    );
  } catch (error) {
    logMediaMaterializationFailure({
      messageId: msg.key?.id,
      mediaKind,
      mimeType: mediaType,
      failureStage: "direct",
      error,
    });
    params.logVerbose(`Inbound media download failed: ${String(error)}`);
    body = formatInboundMediaUnavailableText({
      body,
      notice: "[whatsapp attachment unavailable]",
    });
  }
  if (!mediaPath && !mediaKind && replyContext?.media) {
    try {
      await saveInboundMedia(
        await downloadQuotedInboundMedia(msg as proto.IWebMessageInfo, sock, maxBytes),
      );
      mediaKind = replyContext.media.kind ?? undefined;
      mediaType = mediaType ?? replyContext.media.contentType ?? undefined;
    } catch (error) {
      logMediaMaterializationFailure({
        messageId: msg.key?.id,
        mediaKind: replyContext.media.kind ?? undefined,
        mimeType: replyContext.media.contentType ?? undefined,
        failureStage: "quoted",
        error,
      });
      params.logVerbose(`Quoted media download failed: ${String(error)}`);
      body = formatInboundMediaUnavailableText({
        body,
        notice: "[whatsapp quoted attachment unavailable]",
      });
    }
  }

  return {
    body,
    commandBody,
    location: location ?? undefined,
    contactContext,
    externalAdReplyContext,
    replyContext,
    mediaPath,
    mediaType,
    mediaFileName,
    mediaKind,
    nativeMedia,
  };
}
