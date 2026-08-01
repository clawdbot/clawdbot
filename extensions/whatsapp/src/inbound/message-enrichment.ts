// Whatsapp plugin module prepares inbound text, context, and downloaded media.
import type { proto, WAMessage, WASocket } from "baileys";
import {
  formatInboundMediaUnavailableText,
  formatLocationText,
  type MediaPlaceholderTextFact,
} from "openclaw/plugin-sdk/channel-inbound";
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
