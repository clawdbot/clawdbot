import fs from "node:fs/promises";
import path from "node:path";
import { MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS, runFfmpeg } from "openclaw/plugin-sdk/media-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { formatError } from "./session-errors.js";
import { sleep } from "./text-runtime.js";

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

export type CanonicalWhatsAppLoadedMedia = {
  buffer: Buffer;
  kind: "image" | "audio" | "video" | "document";
  mimetype: string;
  fileName?: string;
};

const WHATSAPP_VOICE_FILE_NAME = "voice.ogg";
const WHATSAPP_VOICE_SAMPLE_RATE_HZ = 48_000;
const WHATSAPP_VOICE_BITRATE = "64k";
const WHATSAPP_VOICE_MIMETYPE = "audio/ogg; codecs=opus";

export function normalizeWhatsAppPayloadText(text: string | undefined): string {
  return text?.trimStart() ?? "";
}

export function normalizeWhatsAppPayloadTextPreservingIndentation(
  text: string | undefined,
): string {
  return (text ?? "").replace(/^(?:[ \t]*\r?\n)+/, "");
}

export function resolveWhatsAppOutboundMediaUrls(
  payload: Pick<WhatsAppOutboundPayloadLike, "mediaUrl" | "mediaUrls">,
): string[] {
  const primaryMediaUrl = payload.mediaUrl?.trim();
  const mediaUrls = (payload.mediaUrls ? [...payload.mediaUrls] : [])
    .map((entry) => entry.trim())
    .filter((entry): entry is string => Boolean(entry));
  const orderedMediaUrls = [primaryMediaUrl, ...mediaUrls].filter((entry): entry is string =>
    Boolean(entry),
  );
  return Array.from(new Set(orderedMediaUrls));
}

// Keep new WhatsApp outbound-media behavior in this helper so payload, gateway, and auto-reply paths stay aligned.
export function normalizeWhatsAppOutboundPayload<T extends WhatsAppOutboundPayloadLike>(
  payload: T,
  options?: {
    normalizeText?: (text: string | undefined) => string;
  },
): Omit<T, "text" | "mediaUrl" | "mediaUrls"> & {
  text: string;
  mediaUrl?: string;
  mediaUrls?: string[];
} {
  const mediaUrls = resolveWhatsAppOutboundMediaUrls(payload);
  const normalizeText = options?.normalizeText ?? normalizeWhatsAppPayloadText;
  return {
    ...payload,
    text: normalizeText(payload.text),
    mediaUrl: mediaUrls[0],
    mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
  };
}

export function normalizeWhatsAppLoadedMedia(
  media: WhatsAppLoadedMediaLike,
  mediaUrl?: string,
): CanonicalWhatsAppLoadedMedia {
  const kind =
    media.kind === "image" || media.kind === "audio" || media.kind === "video"
      ? media.kind
      : "document";
  const mimetype =
    kind === "audio" && isWhatsAppNativeVoiceAudio({ contentType: media.contentType, mediaUrl })
      ? WHATSAPP_VOICE_MIMETYPE
      : (media.contentType ?? "application/octet-stream");
  const fileName =
    kind === "document"
      ? (media.fileName ?? deriveWhatsAppDocumentFileName(mediaUrl) ?? "file")
      : undefined;
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

function normalizeContentType(value: string | undefined): string {
  return value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function isWhatsAppNativeVoiceAudio(params: {
  contentType?: string;
  fileName?: string;
  mediaUrl?: string;
}): boolean {
  const contentType = normalizeContentType(params.contentType);
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
  const tempRoot = resolvePreferredOpenClawTmpDir();
  await fs.mkdir(tempRoot, { recursive: true, mode: 0o700 });
  const tempDir = await fs.mkdtemp(path.join(tempRoot, "whatsapp-voice-"));
  try {
    const ext = path.extname(params.fileName).toLowerCase();
    const inputExt = ext && ext.length <= 12 ? ext : ".audio";
    const inputPath = path.join(tempDir, `input${inputExt}`);
    const outputPath = path.join(tempDir, WHATSAPP_VOICE_FILE_NAME);
    await fs.writeFile(inputPath, params.buffer, { mode: 0o600 });
    await runFfmpeg([
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      inputPath,
      "-vn",
      "-sn",
      "-dn",
      "-t",
      String(MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS),
      "-ar",
      String(WHATSAPP_VOICE_SAMPLE_RATE_HZ),
      "-ac",
      "1",
      "-c:a",
      "libopus",
      "-b:a",
      WHATSAPP_VOICE_BITRATE,
      outputPath,
    ]);
    return await fs.readFile(outputPath);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
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

export function isRetryableWhatsAppOutboundError(error: unknown): boolean {
  return /closed|reset|timed\s*out|disconnect/i.test(formatError(error));
}

export async function sendWhatsAppOutboundWithRetry<T>(params: {
  send: () => Promise<T>;
  onRetry?: (params: {
    attempt: number;
    maxAttempts: number;
    backoffMs: number;
    error: unknown;
    errorText: string;
  }) => Promise<void> | void;
  maxAttempts?: number;
}): Promise<T> {
  const maxAttempts = params.maxAttempts ?? 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await params.send();
    } catch (error) {
      lastError = error;
      const errorText = formatError(error);
      const isLastAttempt = attempt === maxAttempts;
      if (!isRetryableWhatsAppOutboundError(error) || isLastAttempt) {
        throw error;
      }
      const backoffMs = 500 * attempt;
      await params.onRetry?.({
        attempt,
        maxAttempts,
        backoffMs,
        error,
        errorText,
      });
      await sleep(backoffMs);
    }
  }
  throw lastError;
}
