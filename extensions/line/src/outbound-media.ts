import type { messagingApi } from "@line/bot-sdk";
import { getFileExtension, mimeTypeFromFilePath } from "openclaw/plugin-sdk/media-mime";
import { resolvePinnedHostnameWithPolicy, type SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import { isHttpsUrl } from "./media-url.js";
import type { LineOutboundMediaKind } from "./types.js";

// LINE accepts a tracking id on a video sent to a user, but the SDK type omits it.
type LineVideoMessage = messagingApi.VideoMessage & { trackingId?: string };

type LineOutboundMediaResolved = {
  mediaUrl: string;
  /** "unsupported" names a known format LINE cannot carry as native media. */
  mediaKind: LineOutboundMediaKind | "unsupported";
  kindSource: "declared" | "metadata" | "url" | "fallback";
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

async function validateLineMediaUrl(url: string): Promise<void> {
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

const LINE_MEDIA_KIND_BY_MIME: Readonly<Record<string, LineOutboundMediaKind | undefined>> = {
  "image/jpeg": "image",
  "image/png": "image",
  "video/mp4": "video",
  "audio/mpeg": "audio",
  "audio/x-m4a": "audio",
};

// LINE's native message families accept narrower formats than the shared MIME
// families. A known but unsupported suffix must remain visible as text instead
// of becoming a native bubble the provider accepts but the client cannot render.
function detectLineMediaKindFromUrl(
  url: string,
): LineOutboundMediaKind | "unsupported" | undefined {
  const mimeType = mimeTypeFromFilePath(url);
  if (mimeType === undefined) {
    return getFileExtension(url) === undefined ? undefined : "unsupported";
  }
  return LINE_MEDIA_KIND_BY_MIME[mimeType] ?? "unsupported";
}

function resolveLineMediaKind(
  url: string,
  opts: ResolveLineOutboundMediaOpts,
): Pick<LineOutboundMediaResolved, "mediaKind" | "kindSource"> {
  if (opts.mediaKind !== undefined) {
    return { mediaKind: opts.mediaKind, kindSource: "declared" };
  }
  if (typeof opts.durationMs === "number") {
    return { mediaKind: "audio", kindSource: "metadata" };
  }
  if (opts.trackingId?.trim()) {
    return { mediaKind: "video", kindSource: "metadata" };
  }
  const detected = detectLineMediaKindFromUrl(url);
  return detected === undefined
    ? { mediaKind: "image", kindSource: "fallback" }
    : { mediaKind: detected, kindSource: "url" };
}

async function resolveLineOutboundMedia(
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
    return {
      mediaUrl: trimmedUrl,
      ...resolveLineMediaKind(trimmedUrl, opts),
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

export function createImageMessage(
  originalContentUrl: string,
  previewImageUrl?: string,
): messagingApi.ImageMessage {
  return {
    type: "image",
    originalContentUrl,
    previewImageUrl: previewImageUrl ?? originalContentUrl,
  };
}

export function createVideoMessage(
  originalContentUrl: string,
  previewImageUrl: string,
  trackingId?: string,
): LineVideoMessage {
  return {
    type: "video",
    originalContentUrl,
    previewImageUrl,
    ...(trackingId ? { trackingId } : {}),
  };
}

export function createAudioMessage(
  originalContentUrl: string,
  durationMs: number,
): messagingApi.AudioMessage {
  return {
    type: "audio",
    originalContentUrl,
    duration: durationMs,
  };
}

// An image bubble LINE cannot fill renders as blank space the sender never sees,
// so media the platform will not carry degrades to the URL it was made of — the
// same shape createLocationMessage uses for a pin LINE will not draw.
function lineMediaUrlFallback(mediaUrl: string): messagingApi.TextMessage {
  return { type: "text", text: mediaUrl };
}

function buildLineMediaMessageObject(
  resolved: LineOutboundMediaResolved,
  opts?: { allowTrackingId?: boolean },
): messagingApi.Message {
  switch (resolved.mediaKind) {
    case "unsupported":
      return lineMediaUrlFallback(resolved.mediaUrl);
    case "video": {
      const previewImageUrl = resolved.previewImageUrl?.trim();
      if (previewImageUrl) {
        return createVideoMessage(
          resolved.mediaUrl,
          previewImageUrl,
          opts?.allowTrackingId ? resolved.trackingId : undefined,
        );
      }
      // LINE always needs a poster for a video. Explicit kind or video-only
      // metadata keeps the missing field visible; only URL inference degrades.
      if (resolved.kindSource !== "url") {
        throw new Error("LINE video messages require previewImageUrl to reference an image URL");
      }
      return lineMediaUrlFallback(resolved.mediaUrl);
    }
    case "audio":
      return createAudioMessage(resolved.mediaUrl, resolved.durationMs ?? 60000);
    default:
      return createImageMessage(resolved.mediaUrl, resolved.previewImageUrl);
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
