// Line plugin module implements outbound media behavior.
import type { messagingApi } from "@line/bot-sdk";
import { resolvePinnedHostnameWithPolicy, type SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { LineChannelData } from "./types.js";

type LineOutboundMediaKind = "image" | "video" | "audio";

type LineOutboundMediaResolved = {
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
    throw new Error("LINE outbound media URL must be a valid URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("LINE outbound media URL must use HTTPS");
  }
  if (url.length > 2000) {
    throw new Error(`LINE outbound media URL must be 2000 chars or less (got ${url.length})`);
  }
  await resolvePinnedHostnameWithPolicy(parsed.hostname, {
    policy: LINE_OUTBOUND_MEDIA_SSRF_POLICY,
  });
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

  let parsed: URL | undefined;
  try {
    parsed = new URL(trimmedUrl);
  } catch {
    // Local paths reach the generic public-HTTPS error below.
  }
  if (parsed) {
    throw new Error("LINE outbound media URL must use HTTPS");
  }
  throw new Error("LINE outbound media currently requires a public HTTPS URL");
}

function isLineUserTarget(target: string): boolean {
  const normalized = target
    .trim()
    .replace(/^line:(group|room|user):/i, "")
    .replace(/^line:/i, "");
  return /^U/i.test(normalized);
}

export function hasLineSpecificMediaOptions(lineData: LineChannelData): boolean {
  return (
    lineData.mediaKind !== undefined ||
    Boolean(lineData.previewImageUrl?.trim()) ||
    typeof lineData.durationMs === "number" ||
    Boolean(lineData.trackingId?.trim())
  );
}

function buildLineMediaMessageObject(
  resolved: LineOutboundMediaResolved,
  opts?: { allowTrackingId?: boolean },
): messagingApi.Message {
  switch (resolved.mediaKind) {
    case "video": {
      const previewImageUrl = resolved.previewImageUrl?.trim();
      if (!previewImageUrl) {
        throw new Error("LINE video messages require previewImageUrl to reference an image URL");
      }
      return {
        type: "video",
        originalContentUrl: resolved.mediaUrl,
        previewImageUrl,
        ...(opts?.allowTrackingId && resolved.trackingId
          ? { trackingId: resolved.trackingId }
          : {}),
      };
    }
    case "audio":
      return {
        type: "audio",
        originalContentUrl: resolved.mediaUrl,
        duration: resolved.durationMs ?? 60000,
      };
    default:
      return {
        type: "image",
        originalContentUrl: resolved.mediaUrl,
        previewImageUrl: resolved.previewImageUrl ?? resolved.mediaUrl,
      };
  }
}

// Resolve and build through one leaf so reply-token and inline push delivery
// cannot drift on media kind, preview, duration, or tracking-id policy.
export async function buildLineMediaMessage(
  mediaUrl: string,
  opts: ResolveLineOutboundMediaOpts,
  target: string,
): Promise<messagingApi.Message> {
  const resolved = await resolveLineOutboundMedia(mediaUrl, opts);
  return buildLineMediaMessageObject(resolved, {
    allowTrackingId: isLineUserTarget(target),
  });
}
