import path from "node:path";
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
    kind === "audio" && media.contentType === "audio/ogg"
      ? "audio/ogg; codecs=opus"
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
