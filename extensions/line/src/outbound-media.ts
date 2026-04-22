import { resolvePinnedHostnameWithPolicy, type SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";

export type LineOutboundMediaKind = "image" | "video" | "audio";

export type LineOutboundMediaResolved = {
  mediaUrl: string;
  mediaKind: LineOutboundMediaKind;
  previewImageUrl?: string;
  durationMs?: number;
  trackingId?: string;
};

type ResolveLineOutboundMediaOpts = {
  mediaKind?: LineOutboundMediaKind;
  previewImageUrl?: string;
  durationMs?: number;
  trackingId?: string;
};

const LINE_OUTBOUND_MEDIA_SSRF_POLICY: SsrFPolicy = {
  allowPrivateNetwork: false,
};

export async function validateLineMediaUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`LINE outbound media URL must be a valid URL: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`LINE outbound media URL must use HTTPS: ${url}`);
  }
  if (url.length > 2000) {
    throw new Error(`LINE outbound media URL must be 2000 chars or less (got ${url.length})`);
  }
  await resolvePinnedHostnameWithPolicy(parsed.hostname, {
    policy: LINE_OUTBOUND_MEDIA_SSRF_POLICY,
  });
}

export function detectLineMediaKind(mimeType: string): LineOutboundMediaKind {
  const normalized = normalizeLowercaseStringOrEmpty(mimeType);
  if (normalized.startsWith("image/")) {
    return "image";
  }
  if (normalized.startsWith("video/")) {
    return "video";
  }
  if (normalized.startsWith("audio/")) {
    return "audio";
  }
  return "image";
}

function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

function detectLineMediaKindFromUrl(url: string): LineOutboundMediaKind | undefined {
  try {
    const pathname = normalizeLowercaseStringOrEmpty(new URL(url).pathname);
    if (/\.(png|jpe?g|gif|webp|bmp|heic|heif|avif)$/i.test(pathname)) {
      return "image";
    }
    if (/\.(mp4|mov|m4v|webm)$/i.test(pathname)) {
      return "video";
    }
    if (/\.(mp3|m4a|aac|wav|ogg|oga)$/i.test(pathname)) {
      return "audio";
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export async function resolveLineOutboundMedia(
  mediaUrl: string,
  opts: ResolveLineOutboundMediaOpts = {},
): Promise<LineOutboundMediaResolved> {
  const trimmedUrl = mediaUrl.trim();
  if (isHttpsUrl(trimmedUrl)) {
    await validateLineMediaUrl(trimmedUrl);
    const previewImageUrl = opts.previewImageUrl?.trim();
    if (previewImageUrl) {
      await validateLineMediaUrl(previewImageUrl);
    }
    const mediaKind =
      opts.mediaKind ??
      (typeof opts.durationMs === "number" ? "audio" : undefined) ??
      (opts.trackingId?.trim() ? "video" : undefined) ??
      detectLineMediaKindFromUrl(trimmedUrl) ??
      "image";
    return {
      mediaUrl: trimmedUrl,
      mediaKind,
      ...(previewImageUrl ? { previewImageUrl } : {}),
      ...(typeof opts.durationMs === "number" ? { durationMs: opts.durationMs } : {}),
      ...(opts.trackingId ? { trackingId: opts.trackingId } : {}),
    };
  }

  try {
    const parsed = new URL(trimmedUrl);
    if (parsed.protocol !== "https:") {
      throw new Error(`LINE outbound media URL must use HTTPS: ${trimmedUrl}`);
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("LINE outbound")) {
      throw e;
    }
  }
  throw new Error("LINE outbound media currently requires a public HTTPS URL");
}
