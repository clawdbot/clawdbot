// Whatsapp plugin module implements outbound media contract behavior.
import path from "node:path";
import { sanitizeForPlainText } from "openclaw/plugin-sdk/channel-outbound";
import { mediaKindFromMime, normalizeMimeType } from "openclaw/plugin-sdk/media-mime";
import {
  MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS,
  transcodeAudioBufferToOpus,
} from "openclaw/plugin-sdk/media-runtime";
import { resolveOutboundMediaUrls } from "openclaw/plugin-sdk/reply-payload";
import { normalizeUniqueStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveWhatsAppDocumentFileName } from "./document-filename.js";
import {
  sanitizeAssistantVisibleText,
  sanitizeAssistantVisibleTextWithProfile,
  stripToolCallXmlTags,
} from "./text-runtime.js";

type WhatsAppOutboundPayloadLike = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: readonly string[];
};

type WhatsAppLoadedMediaLike = {
  buffer: Buffer;
  contentType?: string;
  kind?: string;
  fileName?: string;
};

type NormalizedWhatsAppOutboundPayload<T extends WhatsAppOutboundPayloadLike> = Omit<
  T,
  "text" | "mediaUrl" | "mediaUrls"
> & {
  text: string;
  mediaUrl?: string;
  mediaUrls?: string[];
};

export type DeliverableWhatsAppOutboundPayload<T extends WhatsAppOutboundPayloadLike> = Omit<
  NormalizedWhatsAppOutboundPayload<T>,
  "text"
> & {
  text?: string;
};

type CanonicalWhatsAppLoadedMedia = {
  buffer: Buffer;
  kind: "image" | "audio" | "video" | "document";
  mimetype: string;
  fileName?: string;
};

const WHATSAPP_VOICE_FILE_NAME = "voice.ogg";
const WHATSAPP_VOICE_SAMPLE_RATE_HZ = 48_000;
const WHATSAPP_VOICE_BITRATE = "64k";
const WHATSAPP_VOICE_MIMETYPE = "audio/ogg; codecs=opus";

function stripWhatsAppPluralToolXml(text: string): string {
  return stripToolCallXmlTags(text, { stripFunctionCallsXmlPayloads: true });
}

function finalizeWhatsAppVisibleText(text: string): string {
  return sanitizeForPlainText(stripWhatsAppPluralToolXml(text));
}

export function normalizeWhatsAppPayloadText(text: string | undefined): string {
  return finalizeWhatsAppVisibleText(sanitizeAssistantVisibleText(text ?? "")).trimStart();
}

function stripLeadingBlankLines(text: string): string {
  return text.replace(/^(?:[ \t]*\r?\n)+/, "");
}

export function normalizeWhatsAppPayloadTextPreservingIndentation(
  text: string | undefined,
): string {
  const sanitized = sanitizeAssistantVisibleTextWithProfile(
    stripLeadingBlankLines(text ?? ""),
    "history",
  );
  const normalized = stripLeadingBlankLines(finalizeWhatsAppVisibleText(sanitized));
  return normalized.trim() ? normalized : "";
}

// The direct API accepts both fields as additive candidates, with mediaUrl first.
// Keep that contract separate from channel ReplyPayload mediaUrls precedence.
export function resolveAdditiveWhatsAppMediaUrls(
  payload: Pick<WhatsAppOutboundPayloadLike, "mediaUrl" | "mediaUrls">,
): string[] {
  return normalizeUniqueStringEntries([
    ...(payload.mediaUrl ? [payload.mediaUrl] : []),
    ...(payload.mediaUrls ?? []),
  ]);
}

// Keep new WhatsApp outbound-media behavior in this helper so payload, gateway, and auto-reply paths stay aligned.
export function normalizeWhatsAppOutboundPayload<T extends WhatsAppOutboundPayloadLike>(
  payload: T,
  options?: {
    normalizeText?: (text: string | undefined) => string;
  },
): NormalizedWhatsAppOutboundPayload<T> {
  const preferredMediaUrls = normalizeUniqueStringEntries(payload.mediaUrls);
  const mediaUrls = normalizeUniqueStringEntries(
    resolveOutboundMediaUrls({ mediaUrl: payload.mediaUrl, mediaUrls: preferredMediaUrls }),
  );
  const normalizeText = options?.normalizeText ?? normalizeWhatsAppPayloadText;
  return {
    ...payload,
    text: normalizeText(payload.text),
    mediaUrl: mediaUrls[0],
    mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
  };
}

function inferWhatsAppMediaKind(
  media: WhatsAppLoadedMediaLike,
): "image" | "audio" | "video" | "document" {
  if (
    media.kind === "image" ||
    media.kind === "audio" ||
    media.kind === "video" ||
    media.kind === "document"
  ) {
    return media.kind;
  }
  return mediaKindFromMime(normalizeMimeType(media.contentType)) ?? "document";
}

function normalizeWhatsAppLoadedMedia(
  media: WhatsAppLoadedMediaLike,
  mediaUrl?: string,
): CanonicalWhatsAppLoadedMedia {
  const kind = inferWhatsAppMediaKind(media);
  const mimetype =
    kind === "audio" && isWhatsAppNativeVoiceAudio({ contentType: media.contentType, mediaUrl })
      ? WHATSAPP_VOICE_MIMETYPE
      : (media.contentType ?? "application/octet-stream");
  const fileName =
    kind === "document"
      ? resolveWhatsAppDocumentFileName({
          fileName: media.fileName ?? deriveWhatsAppDocumentFileName(mediaUrl),
          mimetype,
        })
      : media.fileName;
  return {
    buffer: media.buffer,
    kind,
    mimetype,
    ...(fileName ? { fileName } : {}),
  };
}

export async function prepareWhatsAppOutboundMedia(
  media: WhatsAppLoadedMediaLike,
  mediaUrl?: string,
): Promise<CanonicalWhatsAppLoadedMedia> {
  const normalized = normalizeWhatsAppLoadedMedia(media, mediaUrl);
  if (normalized.kind !== "audio") {
    return normalized;
  }
  if (
    isWhatsAppNativeVoiceAudio({
      contentType: media.contentType,
      fileName: media.fileName,
      mediaUrl,
    })
  ) {
    return normalized;
  }

  const buffer = await transcodeToWhatsAppVoiceOpus({
    buffer: media.buffer,
    fileName: media.fileName ?? deriveWhatsAppDocumentFileName(mediaUrl) ?? "audio",
  });
  return {
    buffer,
    kind: "audio",
    mimetype: WHATSAPP_VOICE_MIMETYPE,
  };
}

function isWhatsAppNativeVoiceAudio(params: {
  contentType?: string;
  fileName?: string;
  mediaUrl?: string;
}): boolean {
  const contentType = normalizeMimeType(params.contentType);
  if (contentType === "audio/ogg" || contentType === "audio/opus") {
    return true;
  }
  const fileName = params.fileName ?? deriveWhatsAppDocumentFileName(params.mediaUrl) ?? "";
  const ext = path.extname(fileName).toLowerCase();
  return ext === ".ogg" || ext === ".opus";
}

async function transcodeToWhatsAppVoiceOpus(params: {
  buffer: Buffer;
  fileName: string;
}): Promise<Buffer> {
  return await transcodeAudioBufferToOpus({
    audioBuffer: params.buffer,
    inputFileName: params.fileName,
    tempPrefix: "whatsapp-voice-",
    outputFileName: WHATSAPP_VOICE_FILE_NAME,
    maxDurationSeconds: MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS,
    sampleRateHz: WHATSAPP_VOICE_SAMPLE_RATE_HZ,
    channels: 1,
    bitrate: WHATSAPP_VOICE_BITRATE,
  });
}

function deriveWhatsAppDocumentFileName(mediaUrl: string | undefined): string | undefined {
  if (!mediaUrl) {
    return undefined;
  }
  try {
    const parsed = new URL(mediaUrl);
    const fileName = path.posix.basename(parsed.pathname);
    return fileName ? decodeURIComponent(fileName) : undefined;
  } catch {
    const withoutQueryOrFragment = mediaUrl.split(/[?#]/, 1)[0] ?? "";
    const fileName = withoutQueryOrFragment.split(/[\\/]/).pop();
    return fileName || undefined;
  }
}
