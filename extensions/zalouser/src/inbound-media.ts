import type { ZaloInboundMedia } from "./types.js";

/**
 * Detect whether an inbound zca-js message carries a photo attachment, and
 * extract its CDN URL + thumbnail if so. zca-js delivers photos as
 * `TAttachmentContent` objects with `{type:"photo", href, thumb, ...}` -
 * see src/models/Message.ts in the zca-js repo. The `href` field is a
 * public Zalo CDN URL that does not require auth to GET.
 *
 * Returns null for plain-text or non-photo content (links, files, stickers
 * etc.) - those flow through `normalizeMessageContent` as text. Photo
 * detection is intentionally inclusive: explicit `type === "photo"` wins,
 * but a missing type with a recognisable image extension in the href OR a
 * non-empty `thumb` field (only photos carry thumbs in zca-js) also matches.
 * Defensive about the inclusive path because some clients send photos with
 * type omitted; better to surface a photo as media than as JSON-stringified
 * text.
 */
export function extractInboundMedia(content: unknown): ZaloInboundMedia | null {
  if (!content || typeof content !== "object") {
    return null;
  }
  const record = content as Record<string, unknown>;
  const href = typeof record.href === "string" ? record.href.trim() : "";
  if (!href) {
    return null;
  }
  const type = typeof record.type === "string" ? record.type : "";
  const thumbUrl = typeof record.thumb === "string" ? record.thumb.trim() : "";
  const looksLikeImage =
    type === "photo" || /\.(jpe?g|png|gif|webp|bmp)(\?|$)/i.test(href) || thumbUrl.length > 0;
  if (!looksLikeImage) {
    return null;
  }
  return {
    kind: "image",
    url: href,
    thumbUrl: thumbUrl || undefined,
  };
}

/**
 * Resolve a real `image/*` MIME for an inbound Zalo photo even when the CDN
 * returns `application/octet-stream`. Picks from the URL extension first,
 * falls back to `image/jpeg` (most common Zalo photo format).
 */
export function resolveInboundImageContentType(detected: string | undefined, url: string): string {
  if (detected && detected.startsWith("image/")) {
    return detected;
  }
  const match = url.match(/\.([a-z]+)(?:\?|$)/i);
  const ext = (match?.[1] ?? "jpg").toLowerCase();
  const extMap: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
  };
  return extMap[ext] ?? "image/jpeg";
}
